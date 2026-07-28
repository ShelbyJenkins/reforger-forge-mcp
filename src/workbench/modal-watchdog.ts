import type { WorkbenchWindow, WorkbenchWindowCloseRequest } from "./process-guard.js";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CLOSE_GRACE_MS = 5_000;

export interface WorkbenchModalWatchdogPort {
  inspect(): Promise<readonly WorkbenchWindow[]>;
  close(window: WorkbenchWindowCloseRequest): Promise<boolean>;
}

export interface WorkbenchModalWatchdogOptions {
  readonly pollIntervalMs?: number;
  /** Maximum time to observe disappearance after an exact WM_CLOSE post. */
  readonly closeGraceMs?: number;
  /** Test seam; production waits can always be interrupted through signal. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface OwnedModalEvidence {
  readonly kind: "owned_modal";
  readonly window: Readonly<WorkbenchWindow>;
  readonly closeAttempted: true;
  /** The exact backend accepted the WM_CLOSE post; this alone is not dismissal proof. */
  readonly closePosted: boolean;
  /** The same dialog handle was no longer visible within closeGraceMs. */
  readonly dismissed: boolean;
  readonly closeError?: string;
}

export interface DisabledMainWindowEvidence {
  readonly kind: "disabled_main_window";
  readonly window: Readonly<WorkbenchWindow>;
  readonly closeAttempted: false;
  readonly closePosted: false;
  readonly dismissed: false;
}

/**
 * Some native Qt Workbench dialogs are standalone top-level windows rather
 * than GW_OWNER children. They are closable only when they are the sole new
 * visible top-level window and a known exact-Workbench main window became
 * disabled in the same observation.
 */
export interface StandaloneModalEvidence {
  readonly kind: "standalone_modal";
  readonly window: Readonly<WorkbenchWindow>;
  readonly disabledMainWindow: Readonly<WorkbenchWindow>;
  readonly closeAttempted: true;
  readonly closePosted: boolean;
  readonly dismissed: boolean;
  readonly closeError?: string;
}

export type WorkbenchModalEvidence =
  | OwnedModalEvidence
  | StandaloneModalEvidence
  | DisabledMainWindowEvidence;

function freezeWindow(window: WorkbenchWindow): Readonly<WorkbenchWindow> {
  return Object.freeze({ ...window });
}

function isOwnedWindow(window: WorkbenchWindow): boolean {
  return window.visible && window.ownerHandle !== "0";
}

/** Any visible owned child is treated as a native modal until proved otherwise. */
export function findOwnedNativeDialog(
  windows: readonly WorkbenchWindow[]
): Readonly<WorkbenchWindow> | undefined {
  const dialog = windows.find(isOwnedWindow);
  return dialog ? freezeWindow(dialog) : undefined;
}

function findNewOwnedNativeDialog(
  baseline: readonly WorkbenchWindow[],
  current: readonly WorkbenchWindow[]
): Readonly<WorkbenchWindow> | undefined {
  const baselineHandles = new Set(baseline.map((window) => window.handle));
  const dialog = current.find((window) => isOwnedWindow(window) && !baselineHandles.has(window.handle));
  return dialog ? freezeWindow(dialog) : undefined;
}

function findDisabledBaselineTopLevelWindow(
  baseline: readonly WorkbenchWindow[],
  current: readonly WorkbenchWindow[]
): Readonly<WorkbenchWindow> | undefined {
  const priorByHandle = new Map(baseline.map((window) => [window.handle, window]));
  const disabled = current.find((window) => {
    const prior = priorByHandle.get(window.handle);
    return prior !== undefined && prior.ownerHandle === "0" && prior.enabled && !window.enabled;
  });
  return disabled ? freezeWindow(disabled) : undefined;
}

function findNewStandaloneModal(
  baseline: readonly WorkbenchWindow[],
  current: readonly WorkbenchWindow[],
  disabledMain: Readonly<WorkbenchWindow>
): Readonly<WorkbenchWindow> | undefined {
  const baselineHandles = new Set(baseline.map((window) => window.handle));
  const candidates = current.filter((window) =>
    window.visible && window.enabled && window.ownerHandle === "0" &&
    window.handle !== disabledMain.handle && !baselineHandles.has(window.handle) &&
    window.className.length > 0 && window.title.length > 0
  );
  return candidates.length === 1 ? freezeWindow(candidates[0]) : undefined;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Watches the already-exact-owned Workbench only while a save is in flight.
 * A newly visible owned child may be closed with WM_CLOSE. A standalone
 * top-level dialog is closable only if it is the sole new candidate and a
 * previously enabled exact-Workbench main window became disabled; every other
 * disabled-main state is reported without guessing at a target window.
 */
export class WorkbenchModalWatchdog {
  private readonly pollIntervalMs: number;
  private readonly closeGraceMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly port: WorkbenchModalWatchdogPort,
    options: WorkbenchModalWatchdogOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error("Workbench modal watchdog pollIntervalMs must be a positive integer.");
    }
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    if (!Number.isSafeInteger(this.closeGraceMs) || this.closeGraceMs < 1) {
      throw new Error("Workbench modal watchdog closeGraceMs must be a positive integer.");
    }
    this.sleep = options.sleep ?? defaultSleep;
  }

  async snapshot(): Promise<readonly WorkbenchWindow[]> {
    const windows = await this.port.inspect();
    return Object.freeze(windows.map(freezeWindow));
  }

  async waitForNewModal(
    baseline: readonly WorkbenchWindow[],
    signal: AbortSignal
  ): Promise<WorkbenchModalEvidence | null> {
    while (!signal.aborted) {
      const current = await this.snapshot();
      const modal = findNewOwnedNativeDialog(baseline, current);
      if (modal) {
        try {
          const closePosted = await this.port.close({
            handle: modal.handle,
            ownerHandle: modal.ownerHandle,
            className: modal.className,
            title: modal.title,
            kind: "owned_child",
          });
          const dismissed = closePosted && await this.waitForDismissal(modal.handle, signal);
          return Object.freeze({
            kind: "owned_modal" as const,
            window: modal,
            closeAttempted: true as const,
            closePosted,
            dismissed,
          });
        } catch (error) {
          return Object.freeze({
            kind: "owned_modal" as const,
            window: modal,
            closeAttempted: true as const,
            closePosted: false,
            dismissed: false,
            closeError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const disabledMain = findDisabledBaselineTopLevelWindow(baseline, current);
      const standaloneModal = disabledMain
        ? findNewStandaloneModal(baseline, current, disabledMain)
        : undefined;
      if (standaloneModal && disabledMain) {
        try {
          const closePosted = await this.port.close({
            handle: standaloneModal.handle,
            ownerHandle: standaloneModal.ownerHandle,
            className: standaloneModal.className,
            title: standaloneModal.title,
            kind: "disabled_main_new_top_level",
            disabledMainHandle: disabledMain.handle,
          });
          const dismissed = closePosted && await this.waitForDismissal(standaloneModal.handle, signal);
          return Object.freeze({
            kind: "standalone_modal" as const,
            window: standaloneModal,
            disabledMainWindow: disabledMain,
            closeAttempted: true as const,
            closePosted,
            dismissed,
          });
        } catch (error) {
          return Object.freeze({
            kind: "standalone_modal" as const,
            window: standaloneModal,
            disabledMainWindow: disabledMain,
            closeAttempted: true as const,
            closePosted: false,
            dismissed: false,
            closeError: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (disabledMain) {
        return Object.freeze({
          kind: "disabled_main_window" as const,
          window: disabledMain,
          closeAttempted: false as const,
          closePosted: false as const,
          dismissed: false as const,
        });
      }
      await this.sleep(this.pollIntervalMs, signal);
    }
    return null;
  }

  private async waitForDismissal(handle: string, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.closeGraceMs;
    while (!signal.aborted) {
      const current = await this.snapshot();
      if (!current.some((window) => window.handle === handle && window.visible)) return true;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      await this.sleep(Math.min(this.pollIntervalMs, remainingMs), signal);
    }
    return false;
  }
}
