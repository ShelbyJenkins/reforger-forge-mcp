import type { ChildProcess } from "node:child_process";

export interface SupervisedChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type SupervisedChildTerminal =
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "exit"; readonly exit: SupervisedChildExit };

/**
 * Stable observation of one supervised child. Promises resolve with events;
 * they never reject, so callers can safely race only the signals they need.
 */
export interface SupervisedChildHandle {
  readonly child: ChildProcess;
  readonly error: Promise<Error>;
  readonly exit: Promise<SupervisedChildExit>;
  readonly terminal: Promise<SupervisedChildTerminal>;
  /** The first observed error/exit, available to listeners attached later. */
  readonly terminalState: SupervisedChildTerminal | null;
}

export interface ChildSupervisorCallbacks {
  onError?: (error: Error) => void | Promise<void>;
  onExit?: (exit: SupervisedChildExit) => void | Promise<void>;
  onCallbackError?: (error: unknown) => void;
}

export interface ChildSupervisorOptions {
  /** Total attempts for a failed terminal reconciliation, including the first. */
  reconciliationAttempts?: number;
  reconciliationRetryMs?: number;
}

export interface SupervisedChildCounts {
  /** Children whose terminal event has not yet been observed. */
  active: number;
  /** Terminal children whose durable exit callback is still reconciling. */
  reconciling: number;
  total: number;
}

interface SupervisedChild {
  child: ChildProcess;
  onError: (error: Error) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  handle: SupervisedChildHandle;
}

interface MutableChildObservation {
  readonly handle: SupervisedChildHandle;
  observeError(error: Error): void;
  observeExit(exit: SupervisedChildExit): void;
}

interface PendingReconciliation {
  readonly token: object;
  timer: NodeJS.Timeout | null;
}

function createChildObservation(child: ChildProcess): MutableChildObservation {
  let resolveError!: (error: Error) => void;
  let resolveExit!: (exit: SupervisedChildExit) => void;
  let resolveTerminal!: (terminal: SupervisedChildTerminal) => void;
  let terminalState: SupervisedChildTerminal | null = null;
  let errorObserved = false;
  let exitObserved = false;
  const error = new Promise<Error>((resolve) => { resolveError = resolve; });
  const exit = new Promise<SupervisedChildExit>((resolve) => { resolveExit = resolve; });
  const terminal = new Promise<SupervisedChildTerminal>((resolve) => {
    resolveTerminal = resolve;
  });
  const handle = Object.freeze({
    child,
    error,
    exit,
    terminal,
    get terminalState(): SupervisedChildTerminal | null {
      return terminalState;
    },
  });
  const observeTerminal = (value: SupervisedChildTerminal): void => {
    if (terminalState) return;
    terminalState = value;
    resolveTerminal(value);
  };
  return {
    handle,
    observeError(observedError): void {
      if (!errorObserved) {
        errorObserved = true;
        resolveError(observedError);
      }
      observeTerminal({ kind: "error", error: observedError });
    },
    observeExit(observedExit): void {
      if (!exitObserved) {
        exitObserved = true;
        resolveExit(observedExit);
      }
      observeTerminal({ kind: "exit", exit: observedExit });
    },
  };
}

/**
 * Keeps process listeners alive for the full child lifetime and removes every
 * terminal child from its registry before durable reconciliation runs.
 */
export class ChildSupervisor {
  private readonly children = new Map<string, SupervisedChild>();
  private readonly reconciliations = new Map<string, PendingReconciliation>();
  private readonly reconciliationAttempts: number;
  private readonly reconciliationRetryMs: number;

  constructor(options: ChildSupervisorOptions = {}) {
    this.reconciliationAttempts = options.reconciliationAttempts ?? 3;
    this.reconciliationRetryMs = options.reconciliationRetryMs ?? 100;
    if (!Number.isSafeInteger(this.reconciliationAttempts) || this.reconciliationAttempts < 1 ||
        this.reconciliationAttempts > 100) {
      throw new TypeError("Child reconciliation attempts must be an integer from 1 through 100.");
    }
    if (!Number.isSafeInteger(this.reconciliationRetryMs) || this.reconciliationRetryMs < 0 ||
        this.reconciliationRetryMs > 60_000) {
      throw new TypeError("Child reconciliation retry delay must be an integer from 0 through 60000ms.");
    }
  }

  supervise(
    key: string,
    child: ChildProcess,
    callbacks: ChildSupervisorCallbacks = {}
  ): SupervisedChildHandle {
    this.forget(key);
    const observation = createChildObservation(child);
    const report = (work: void | Promise<void>): void => {
      void Promise.resolve(work).catch((error) => callbacks.onCallbackError?.(error));
    };
    const onError = (error: Error): void => {
      observation.observeError(error);
      const current = this.children.get(key);
      if (!current || current.child !== child) return;
      if (callbacks.onError) report(callbacks.onError(error));
      // Node does not guarantee an `exit` event when process creation fails.
      // A child without a PID never crossed the process-identity boundary, so
      // retaining it would leak the registry and both listeners forever. A
      // post-spawn error with a PID remains supervised until exact exit/absence
      // is established by its owner.
      if (child.pid == null) {
        this.children.delete(key);
        child.off("error", onError);
        child.off("exit", onExit);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const exit = { code, signal };
      observation.observeExit(exit);
      const current = this.children.get(key);
      if (!current || current.child !== child) return;
      this.children.delete(key);
      child.off("error", onError);
      child.off("exit", onExit);
      if (callbacks.onExit) {
        this.beginExitReconciliation(key, callbacks, exit);
      }
    };
    this.children.set(key, { child, onError, onExit, handle: observation.handle });
    child.on("error", onError);
    child.on("exit", onExit);
    if (child.exitCode != null || child.signalCode != null) {
      const exit = { code: child.exitCode ?? null, signal: child.signalCode ?? null };
      observation.observeExit(exit);
      queueMicrotask(() => onExit(exit.code, exit.signal));
    }
    return observation.handle;
  }

  forget(key: string, expectedChild?: ChildProcess): boolean {
    const current = this.children.get(key);
    if (!current || (expectedChild && current.child !== expectedChild)) {
      if (!expectedChild) this.cancelReconciliation(key);
      return false;
    }
    this.children.delete(key);
    current.child.off("error", current.onError);
    current.child.off("exit", current.onExit);
    this.cancelReconciliation(key);
    return true;
  }

  has(key: string): boolean {
    return this.children.has(key);
  }

  get size(): number {
    return this.children.size;
  }

  get reconciliationSize(): number {
    return this.reconciliations.size;
  }

  /** Bounded count-only snapshot for diagnostics and controlled acceptance evidence. */
  counts(): SupervisedChildCounts {
    const active = this.children.size;
    const reconciling = this.reconciliations.size;
    return { active, reconciling, total: active + reconciling };
  }

  private beginExitReconciliation(
    key: string,
    callbacks: ChildSupervisorCallbacks,
    exit: SupervisedChildExit
  ): void {
    this.cancelReconciliation(key);
    const pending: PendingReconciliation = { token: {}, timer: null };
    this.reconciliations.set(key, pending);
    void this.runExitReconciliation(key, pending, callbacks, exit, 1);
  }

  private async runExitReconciliation(
    key: string,
    pending: PendingReconciliation,
    callbacks: ChildSupervisorCallbacks,
    exit: SupervisedChildExit,
    attempt: number
  ): Promise<void> {
    if (this.reconciliations.get(key)?.token !== pending.token || !callbacks.onExit) return;
    try {
      await callbacks.onExit(exit);
      if (this.reconciliations.get(key)?.token === pending.token) {
        this.reconciliations.delete(key);
      }
    } catch (error) {
      try { callbacks.onCallbackError?.(error); } catch { /* diagnostics cannot disable retry */ }
      if (this.reconciliations.get(key)?.token !== pending.token) return;
      if (attempt >= this.reconciliationAttempts) {
        this.reconciliations.delete(key);
        return;
      }
      pending.timer = setTimeout(() => {
        pending.timer = null;
        void this.runExitReconciliation(key, pending, callbacks, exit, attempt + 1);
      }, this.reconciliationRetryMs);
      pending.timer.unref?.();
    }
  }

  private cancelReconciliation(key: string): void {
    const pending = this.reconciliations.get(key);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.reconciliations.delete(key);
  }
}
