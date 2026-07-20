import { pathComparisonKey } from "../foundation/managed-path.js";
import {
  assertTimerDurationMs,
  deadlineAt,
  remainingMs,
  type Clock,
  type Deadline,
} from "../foundation/time.js";
import type {
  SupervisedChildHandle,
} from "../foundation/child-supervisor.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  type WorkbenchCompanionLaunch,
} from "./helper-addon.js";
import type { WorkbenchNetApiPort } from "./net-api-client.js";
import type {
  LifecycleEndpoint,
  VerifyEndpointOwnerResult,
  VerifyEndpointVacantResult,
  WorkbenchIdentity,
} from "./process-guard.js";

const PING_API = "EMCP_WB_Ping";
const PING_RESPONSE_CAP_BYTES = 1024 * 1024;
const MAX_PING_CALL_MS = 3_000;

export type WorkbenchReadinessErrorCode =
  | "ABORTED"
  | "CHILD_EXITED"
  | "CHILD_ERROR"
  | "ENDPOINT_UNVERIFIABLE"
  | "IDENTITY_UNVERIFIABLE"
  | "ATTESTATION_FAILED"
  | "TIMEOUT";

export class WorkbenchReadinessError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchReadinessErrorCode,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkbenchReadinessError";
  }
}

export interface WorkbenchCompanionIdentity {
  readonly addonId: string;
  readonly addonGuid: string;
  readonly addonVersion: string;
  readonly protocolVersion: string;
  readonly workbenchProtocol: string;
  readonly buildIdentity: string;
  readonly bundleDigest: string;
}

/** Structural seam implemented by the canonical ChildSupervisor handle. */
export type WorkbenchReadinessChild = Pick<
  SupervisedChildHandle,
  "terminalState" | "terminal"
>;

export interface WorkbenchReadinessTiming {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTiming: WorkbenchReadinessTiming = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CompanionReadinessOptions {
  readonly endpoint: Readonly<LifecycleEndpoint>;
  readonly process: Readonly<WorkbenchIdentity>;
  readonly companion: Readonly<WorkbenchCompanionLaunch>;
  readonly netApi: WorkbenchNetApiPort;
  readonly verifyEndpointOwner: (
    endpoint: LifecycleEndpoint,
    process: WorkbenchIdentity
  ) => Promise<VerifyEndpointOwnerResult>;
  /** Full immutable staged-payload verification; invoked exactly once before polling. */
  readonly attestCompanion: () => WorkbenchCompanionLaunch | Promise<WorkbenchCompanionLaunch>;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly child?: WorkbenchReadinessChild;
  readonly signal?: AbortSignal;
  readonly timing?: WorkbenchReadinessTiming;
}

function sameCompanion(
  left: Readonly<WorkbenchCompanionLaunch>,
  right: Readonly<WorkbenchCompanionLaunch>
): boolean {
  return left.addonId === right.addonId &&
    left.addonGuid === right.addonGuid &&
    left.addonVersion === right.addonVersion &&
    left.protocolVersion === right.protocolVersion &&
    left.buildIdentity === right.buildIdentity &&
    left.bundleDigest === right.bundleDigest &&
    pathComparisonKey(left.addonDirectory) === pathComparisonKey(right.addonDirectory) &&
    pathComparisonKey(left.addonSearchRoot) === pathComparisonKey(right.addonSearchRoot) &&
    pathComparisonKey(left.workbenchProfilePath) === pathComparisonKey(right.workbenchProfilePath);
}

function exactCompanionIdentity(
  response: Record<string, unknown>,
  expected: Readonly<WorkbenchCompanionLaunch>
): WorkbenchCompanionIdentity {
  const matches = response.status === "ok" &&
    response.helperAddonId === expected.addonId &&
    response.helperAddonGuid === expected.addonGuid &&
    response.helperAddonVersion === expected.addonVersion &&
    response.helperProtocolVersion === expected.protocolVersion &&
    response.workbenchProtocol === expected.protocolVersion &&
    response.helperBuildIdentity === expected.buildIdentity &&
    response.helperAddonId === WORKBENCH_HELPER_ADDON_ID &&
    response.helperAddonGuid === WORKBENCH_HELPER_ADDON_GUID &&
    response.helperAddonVersion === WORKBENCH_HELPER_ADDON_VERSION &&
    response.helperProtocolVersion === WORKBENCH_HELPER_PROTOCOL_VERSION &&
    response.workbenchProtocol === WORKBENCH_HELPER_PROTOCOL_VERSION &&
    response.helperBuildIdentity === WORKBENCH_HELPER_BUILD_IDENTITY;
  if (!matches) {
    throw new WorkbenchReadinessError(
      "Workbench NET API responded without the exact managed companion and Workbench protocol identity.",
      "IDENTITY_UNVERIFIABLE"
    );
  }
  return Object.freeze({
    addonId: expected.addonId,
    addonGuid: expected.addonGuid,
    addonVersion: expected.addonVersion,
    protocolVersion: expected.protocolVersion,
    workbenchProtocol: expected.protocolVersion,
    buildIdentity: expected.buildIdentity,
    bundleDigest: expected.bundleDigest,
  });
}

function assertNotTerminated(
  child: WorkbenchReadinessChild | undefined,
  signal: AbortSignal | undefined,
  context: string
): void {
  if (signal?.aborted) {
    throw new WorkbenchReadinessError(`${context} was aborted.`, "ABORTED");
  }
  const terminal = child?.terminalState;
  if (!terminal) return;
  if (terminal.kind === "error") {
    throw new WorkbenchReadinessError(
      `${context} failed because the Workbench child emitted an error: ${terminal.error.message}`,
      "CHILD_ERROR",
      { cause: terminal.error }
    );
  }
  throw new WorkbenchReadinessError(
    `${context} failed because Workbench exited (code ${terminal.exit.code ?? "none"}, ` +
      `signal ${terminal.exit.signal ?? "none"}).`,
    "CHILD_EXITED"
  );
}

async function waitForNextAttempt(
  delayMs: number,
  child: WorkbenchReadinessChild | undefined,
  signal: AbortSignal | undefined,
  timing: WorkbenchReadinessTiming,
  context: string
): Promise<void> {
  assertNotTerminated(child, signal, context);
  let timer: unknown;
  let removeAbort: (() => void) | undefined;
  const delay = new Promise<"delay">((resolvePromise) => {
    timer = timing.setTimeout(() => resolvePromise("delay"), Math.max(0, delayMs));
  });
  const abort = signal
    ? new Promise<"abort">((resolvePromise) => {
        const listener = (): void => resolvePromise("abort");
        signal.addEventListener("abort", listener, { once: true });
        removeAbort = () => signal.removeEventListener("abort", listener);
      })
    : new Promise<never>(() => undefined);
  const terminal = child
    ? child.terminal.then(() => "terminal" as const)
    : new Promise<never>(() => undefined);
  try {
    await Promise.race([delay, abort, terminal]);
  } finally {
    if (timer !== undefined) timing.clearTimeout(timer);
    removeAbort?.();
  }
  assertNotTerminated(child, signal, context);
}

export async function waitForCompanionReady(
  options: CompanionReadinessOptions
): Promise<WorkbenchCompanionIdentity> {
  const timing = options.timing ?? defaultTiming;
  const clock: Clock = timing;
  const deadline = deadlineAt(options.deadlineMs);
  assertTimerDurationMs(options.pollIntervalMs, "Workbench readiness poll interval");

  assertNotTerminated(options.child, options.signal, "Workbench companion readiness");
  let attested: WorkbenchCompanionLaunch;
  try {
    attested = await options.attestCompanion();
  } catch (error) {
    throw new WorkbenchReadinessError(
      `Managed companion attestation failed before readiness polling: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      "ATTESTATION_FAILED",
      { cause: error }
    );
  }
  if (!sameCompanion(options.companion, attested)) {
    throw new WorkbenchReadinessError(
      "Managed companion attestation changed the reserved immutable descriptor.",
      "ATTESTATION_FAILED"
    );
  }

  let lastError: unknown;
  while (remainingMs(clock, deadline) > 0) {
    assertNotTerminated(options.child, options.signal, "Workbench companion readiness");
    const ownership = await options.verifyEndpointOwner(
      { ...options.endpoint },
      { ...options.process }
    );
    assertNotTerminated(options.child, options.signal, "Workbench companion readiness");
    if (ownership.kind === "owned") {
      const remaining = remainingMs(clock, deadline);
      if (remaining === 0) break;
      try {
        const response = await options.netApi.call<Record<string, unknown>>(PING_API, {}, {
          timeoutMs: Math.min(MAX_PING_CALL_MS, remaining),
          responseCapBytes: PING_RESPONSE_CAP_BYTES,
        });
        assertNotTerminated(options.child, options.signal, "Workbench companion readiness");
        return exactCompanionIdentity(response, options.companion);
      } catch (error) {
        if (error instanceof WorkbenchReadinessError &&
            error.code === "IDENTITY_UNVERIFIABLE") throw error;
        lastError = error;
      }
    } else if (ownership.reason !== "listener_not_found") {
      throw new WorkbenchReadinessError(
        `Workbench endpoint ownership could not be proven (${ownership.reason}): ${ownership.message}`,
        "ENDPOINT_UNVERIFIABLE"
      );
    }

    const remaining = remainingMs(clock, deadline);
    if (remaining === 0) break;
    await waitForNextAttempt(
      Math.min(options.pollIntervalMs, remaining),
      options.child,
      options.signal,
      timing,
      "Workbench companion readiness"
    );
  }
  assertNotTerminated(options.child, options.signal, "Workbench companion readiness");
  const detail = lastError instanceof Error ? ` Last Ping error: ${lastError.message}` : "";
  throw new WorkbenchReadinessError(
    `Workbench did not become ready before the absolute deadline.${detail}`,
    "TIMEOUT"
  );
}

export async function requireVacant(
  verify: (endpoint: LifecycleEndpoint) => Promise<VerifyEndpointVacantResult>,
  endpoint: Readonly<LifecycleEndpoint>,
  context: string
): Promise<void> {
  const vacancy = await verify({ ...endpoint });
  if (vacancy.kind === "vacant") return;
  const detail = vacancy.kind === "occupied"
    ? `listener PID ${vacancy.listenerPid}: ${vacancy.message}`
    : `${vacancy.reason}: ${vacancy.message}`;
  throw new WorkbenchReadinessError(
    `${context} requires a vacant Workbench endpoint (${detail}).`,
    "ENDPOINT_UNVERIFIABLE"
  );
}

export async function waitForVacancy(options: {
  readonly verify: (endpoint: LifecycleEndpoint) => Promise<VerifyEndpointVacantResult>;
  readonly endpoint: Readonly<LifecycleEndpoint>;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
  readonly timing?: WorkbenchReadinessTiming;
}): Promise<void> {
  const timing = options.timing ?? defaultTiming;
  const clock: Clock = timing;
  const deadline: Deadline = deadlineAt(options.deadlineMs);
  assertTimerDurationMs(options.pollIntervalMs, "Endpoint vacancy poll interval");
  let last: VerifyEndpointVacantResult | null = null;
  while (remainingMs(clock, deadline) > 0) {
    if (options.signal?.aborted) {
      throw new WorkbenchReadinessError("Endpoint vacancy wait was aborted.", "ABORTED");
    }
    last = await options.verify({ ...options.endpoint });
    if (last.kind === "vacant") return;
    if (last.kind === "unverifiable") {
      throw new WorkbenchReadinessError(
        `Workbench endpoint vacancy is unverifiable (${last.reason}): ${last.message}`,
        "ENDPOINT_UNVERIFIABLE"
      );
    }
    const remaining = remainingMs(clock, deadline);
    if (remaining === 0) break;
    await waitForNextAttempt(
      Math.min(options.pollIntervalMs, remaining),
      undefined,
      options.signal,
      timing,
      "Endpoint vacancy wait"
    );
  }
  const detail = last?.kind === "occupied"
    ? `listener PID ${last.listenerPid}: ${last.message}`
    : "no conclusive vacancy result";
  throw new WorkbenchReadinessError(
    `Workbench endpoint did not become vacant before the absolute deadline (${detail}).`,
    "TIMEOUT"
  );
}
