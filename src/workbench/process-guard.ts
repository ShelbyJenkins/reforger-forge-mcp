import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExactProcessBackend,
  ExactProcessInspection,
  ExactProcessTerminationResult,
} from "../foundation/exact-process-backend.js";
import type { ExactProcessIdentity } from "../foundation/identity.js";
import type {
  MachineMutex,
  MachineMutexLeaseLoss,
} from "../foundation/machine-mutex.js";
import { encodeDurableKey, jsonDurableRecordCodec } from "../foundation/durable-kv.js";
import {
  LmdbCasStore,
  type LmdbCasInspection,
} from "../foundation/lmdb-cas-store.js";
import { LmdbEnvironment } from "../foundation/lmdb-store.js";
import {
  deadlineAt,
  deadlineAfter,
  pollUntil,
  systemClock,
  systemSleeper,
} from "../foundation/time.js";
import type {
  RecoverableSpawnJournal,
  RecoverableSpawnRecord,
} from "../foundation/recoverable-spawn.js";
import {
  WindowsExactProcessBackend,
  parseWindowsExactProcessIdentity,
  type WindowsExactProcessBackendFailureCode,
  type WindowsHelperResponse,
} from "../platform/windows/exact-process-backend.js";

export type { ExactProcessIdentity } from "../foundation/identity.js";

export const WORKBENCH_PROCESS_NAME = "ArmaReforgerWorkbenchSteamDiag.exe";
export const WORKBENCH_OWNER_ARG_PREFIX = "-reforgerForgeOwnerToken=";
export const DEFAULT_LIFECYCLE_MUTEX = "Global\\ReforgerForge.WorkbenchLifecycle.v3";

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const PROCESS_CAPTURE_TIMEOUT_MS = 5_000;
const PROCESS_POLL_MS = 100;
const LIFECYCLE_VERSION = 3;
const MAX_LIFECYCLE_STATE_BYTES = 1024 * 1024;
const MAX_SPAWN_JOURNAL_BYTES = 256 * 1024;

export interface McpOwnerIdentity extends ExactProcessIdentity {
  instanceId: string;
  leaseId: string;
  userSid: string;
  claimedAtMs: number;
}

export interface WorkbenchIdentity extends ExactProcessIdentity {
  ownerTokenArgument: string;
  launchedAtMs: number;
}

export interface LifecycleEndpoint {
  host: string;
  port: number;
}

export interface CanonicalProjectIdentity {
  path: string;
  comparisonKey: string;
}

export type LifecyclePhase =
  | "vacant"
  | "starting"
  | "running"
  | "restarting"
  | "stopping";

export type LifecycleOperationKind =
  | "launch"
  | "restart"
  | "shutdown"
  | "recovery";

/**
 * Immutable identity of the MCP-owned companion add-on used by this
 * Workbench generation.
 */
export interface WorkbenchCompanionLifecycleState {
  addonId: string;
  addonGuid: string;
  addonDirectory: string;
  addonSearchRoot: string;
  bundleDigest: string;
  buildIdentity: string;
  profilePath: string;
}

export interface WorkbenchLifecycleStateV3 {
  version: 3;
  generation: string;
  phase: LifecyclePhase;
  endpoint: LifecycleEndpoint;
  target: CanonicalProjectIdentity | null;
  mcpOwner: McpOwnerIdentity | null;
  workbench: WorkbenchIdentity | null;
  companion: WorkbenchCompanionLifecycleState | null;
  operation: { kind: LifecycleOperationKind; operationId: string } | null;
}

export type WorkbenchPlanSpawnPurpose =
  | "mcp_editor"
  | "cli_editor"
  | "target_build";

/**
 * @deprecated Remove in Stage 6 after version-3 spawn journals and the
 * temporary public build preflight reach their compatibility boundary.
 *
 * Deprecated version-3 journal compatibility. The temporary public V3 build
 * preflight may still write `runner_companion_preflight` until its controlled
 * live-evidence gate passes; all other new launches use plan-shaped purposes.
 */
export type LegacyWorkbenchSpawnPurpose =
  | "client_launch"
  | "client_restart"
  | "runner_editor"
  | "runner_companion_preflight"
  | "runner_target_build";

export type WorkbenchSpawnPurpose = WorkbenchPlanSpawnPurpose | LegacyWorkbenchSpawnPurpose;

export interface WorkbenchSpawnMetadata {
  purpose: WorkbenchSpawnPurpose;
  lifecycleGeneration: string;
  targetKey: string;
}

export type WorkbenchSpawnRecord = RecoverableSpawnRecord<
  WorkbenchIdentity,
  WorkbenchSpawnMetadata
>;

interface WorkbenchSpawnJournalStateV3 {
  version: 3;
  generation: string;
  record: WorkbenchSpawnRecord;
}

export type WorkbenchSpawnJournalRead =
  | { kind: "missing" }
  | { kind: "valid"; generation: string; record: WorkbenchSpawnRecord }
  | { kind: "malformed"; path: string; rawSha256: string; message: string };

export type LifecycleStateDraft = Omit<WorkbenchLifecycleStateV3, "version" | "generation">;

export type LifecycleStateRead =
  | { kind: "missing" }
  | { kind: "valid"; state: WorkbenchLifecycleStateV3 }
  | { kind: "malformed"; path: string; rawSha256: string; message: string };

export interface ExpectedStateVersion {
  generation: string;
  leaseId: string | null;
}

export type LifecycleClaimResult =
  | {
      kind: "claimed";
      state: WorkbenchLifecycleStateV3;
      source: "missing" | "vacant" | "dead_owner" | "malformed";
    }
  | { kind: "owned_by_current_mcp"; state: WorkbenchLifecycleStateV3 }
  | {
      kind: "refused";
      code:
        | "OWNED_BY_OTHER_MCP"
        | "UNOWNED_WORKBENCH"
        | "ENDPOINT_CONFLICT"
        | "TARGET_CONFLICT"
        | "USER_CONFLICT"
        | "IDENTITY_UNVERIFIABLE"
        | "STATE_INVALID";
      message: string;
      state?: WorkbenchLifecycleStateV3;
    };

export type VerifyTerminateResult = ExactProcessTerminationResult;

export type ProcessInspection = ExactProcessInspection;

export interface WorkbenchProcessScan {
  processes: ExactProcessIdentity[];
  unverifiable: Array<{ pid: number; reason: string; message: string }>;
}

export type EndpointOwnershipRefusalReason =
  | "endpoint_not_loopback"
  | "listener_not_found"
  | "listener_ambiguous"
  | "listener_pid_mismatch"
  | "access_denied"
  | "executable_mismatch"
  | "creation_time_mismatch"
  | "command_line_unverifiable"
  | "token_mismatch"
  | "workbench_process_mismatch"
  | "helper_failure";

export type VerifyEndpointOwnerResult =
  | { kind: "owned"; listenerPid: number }
  | { kind: "refused"; reason: EndpointOwnershipRefusalReason; message: string };

export type VerifyEndpointVacantResult =
  | { kind: "vacant" }
  | { kind: "occupied"; listenerPid: number; message: string }
  | {
      kind: "unverifiable";
      reason:
        | "endpoint_not_loopback"
        | "listener_ambiguous"
        | "access_denied"
        | "timeout"
        | "helper_failure";
      message: string;
    };

export interface WorkbenchLifecycleBackend extends ExactProcessBackend, MachineMutex {
  scanWorkbenchProcesses(): Promise<WorkbenchProcessScan>;
  verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    expected: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult>;
  verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult>;
  /**
   * Best-effort, non-identity cosmetic action: polls briefly for the process's
   * visible top-level window and minimizes it without activating. Never
   * throws for a merely absent or not-yet-created window.
   */
  minimizeWindow(pid: number, timeoutMs: number): Promise<{ minimized: boolean }>;
}

export interface WorkbenchProcessGuardOptions {
  stateDir?: string;
  mutexName?: string;
  /** A callback is evaluated at mutex acquisition for absolute-deadline callers. */
  lockTimeoutMs?: number | (() => number);
  /** Absolute cap shared by lock, helper, and spawned-identity polling phases. */
  operationDeadlineAtMs?: () => number | undefined;
  backend?: WorkbenchLifecycleBackend;
  helperPath?: string;
  /**
   * Test-only injection seam fired immediately before the lifecycle record
   * is written. Returning an Error aborts the write, propagating exactly as
   * a real durable-write failure would. Production callers must not set this.
   */
  beforeLifecycleReplace?: (args: {
    expectedGeneration: string | null;
    next: WorkbenchLifecycleStateV3;
  }) => Error | void;
  /**
   * Test-only injection seam fired immediately after the lifecycle record
   * commits, before the caller observes success. Throwing simulates a crash
   * between durable publication and its caller's continuation.
   */
  afterLifecycleReplace?: (args: {
    generation: string;
    next: WorkbenchLifecycleStateV3;
  }) => void;
  /** Test-only injection seam fired immediately before the spawn journal record is written. */
  beforeSpawnJournalReplace?: (args: {
    expectedGeneration: string | null;
    next: WorkbenchSpawnJournalStateV3;
  }) => Error | void;
  /** Test-only injection seam fired immediately after the spawn journal record commits. */
  afterSpawnJournalReplace?: (args: {
    generation: string;
    next: WorkbenchSpawnJournalStateV3;
  }) => void;
}

export type LifecycleGuardErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "IDENTITY_UNVERIFIABLE"
  | "STATE_INVALID"
  | "GENERATION_MISMATCH"
  | "LIFECYCLE_BUSY"
  | "HELPER_FAILURE"
  | "RECOVERY_REQUIRED";

export class LifecycleGuardError extends Error {
  constructor(message: string, public readonly code: LifecycleGuardErrorCode) {
    super(message);
    this.name = "LifecycleGuardError";
  }
}

export interface WorkbenchLifecycleSession {
  readonly mcp: McpOwnerIdentity;
  assertActive(): void;
  readState(): Promise<LifecycleStateRead>;
  validateAndClaim(args: {
    endpoint: LifecycleEndpoint;
    target?: CanonicalProjectIdentity | null;
  }): Promise<LifecycleClaimResult>;
  transition(
    expected: ExpectedStateVersion,
    next: LifecycleStateDraft
  ): Promise<WorkbenchLifecycleStateV3>;
  transitionToVacant(
    expected: ExpectedStateVersion,
    overrides?: Partial<Pick<LifecycleStateDraft, "endpoint" | "target" | "companion">>
  ): Promise<WorkbenchLifecycleStateV3>;
  inspectSpawnedWorkbench(args: {
    pid: number;
    executablePath: string;
    ownerTokenArgument: string;
    launchedAtMs: number;
  }): Promise<WorkbenchIdentity>;
  verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    expected: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult>;
  verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult>;
  verifyAndTerminate(expected: WorkbenchIdentity, timeoutMs: number): Promise<VerifyTerminateResult>;
  assertNoWorkbenchProcesses(): Promise<void>;
}

function normalizedPath(path: string): string {
  const absolute = resolve(path);
  return platform() === "win32" ? absolute.toLowerCase() : absolute;
}

function normalizedEndpoint(endpoint: LifecycleEndpoint): LifecycleEndpoint {
  let host = endpoint.host.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host || !Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535) {
    throw new LifecycleGuardError("Lifecycle endpoint is invalid.", "STATE_INVALID");
  }
  return { host, port: endpoint.port };
}

export function isLoopbackLifecycleHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(normalized);
  if (family === 4) return normalized.split(".")[0] === "127";
  if (family === 6) {
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  }
  return false;
}

function parseExactIdentity(value: unknown): ExactProcessIdentity | null {
  return parseWindowsExactProcessIdentity(value);
}

function processMatches(left: ExactProcessIdentity, right: ExactProcessIdentity): boolean {
  return left.pid === right.pid &&
    normalizedPath(left.executablePath) === normalizedPath(right.executablePath) &&
    left.creationTime === right.creationTime;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMcpOwner(value: unknown): value is McpOwnerIdentity {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<McpOwnerIdentity>;
  return parseExactIdentity(owner) !== null &&
    isString(owner.instanceId) && isString(owner.leaseId) && isString(owner.userSid) &&
    typeof owner.claimedAtMs === "number" && Number.isFinite(owner.claimedAtMs) && owner.claimedAtMs > 0;
}

function isWorkbenchIdentity(value: unknown): value is WorkbenchIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<WorkbenchIdentity>;
  return parseExactIdentity(identity) !== null &&
    isString(identity.ownerTokenArgument) &&
    identity.ownerTokenArgument.startsWith(WORKBENCH_OWNER_ARG_PREFIX) &&
    typeof identity.launchedAtMs === "number" && Number.isFinite(identity.launchedAtMs) &&
    identity.launchedAtMs > 0;
}

function isTarget(value: unknown): value is CanonicalProjectIdentity {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<CanonicalProjectIdentity>;
  return isString(target.path) && isString(target.comparisonKey);
}

function isCompanionState(value: unknown): value is WorkbenchCompanionLifecycleState {
  if (!value || typeof value !== "object") return false;
  const companion = value as Partial<WorkbenchCompanionLifecycleState>;
  return typeof companion.addonId === "string" &&
    /^[A-Za-z0-9._-]{1,128}$/.test(companion.addonId) &&
    typeof companion.addonGuid === "string" && /^[A-Fa-f0-9]{16}$/.test(companion.addonGuid) &&
    typeof companion.addonDirectory === "string" && isAbsolute(companion.addonDirectory) &&
    typeof companion.addonSearchRoot === "string" && isAbsolute(companion.addonSearchRoot) &&
    typeof companion.bundleDigest === "string" && /^[a-f0-9]{64}$/.test(companion.bundleDigest) &&
    typeof companion.buildIdentity === "string" && /^[a-f0-9]{64}$/.test(companion.buildIdentity) &&
    typeof companion.profilePath === "string" && isAbsolute(companion.profilePath);
}

function parseLifecycleState(value: unknown): WorkbenchLifecycleStateV3 | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<WorkbenchLifecycleStateV3>;
  if (state.version !== LIFECYCLE_VERSION || !isString(state.generation) ||
      !["vacant", "starting", "running", "restarting", "stopping"].includes(String(state.phase)) ||
      !state.endpoint || typeof state.endpoint !== "object") return null;
  let endpoint: LifecycleEndpoint;
  try {
    endpoint = normalizedEndpoint(state.endpoint as LifecycleEndpoint);
  } catch {
    return null;
  }
  if (state.target !== null && !isTarget(state.target)) return null;
  if (state.mcpOwner !== null && !isMcpOwner(state.mcpOwner)) return null;
  if (state.workbench !== null && !isWorkbenchIdentity(state.workbench)) return null;
  if (state.companion !== null && !isCompanionState(state.companion)) return null;
  if (state.operation !== null) {
    if (!state.operation || typeof state.operation !== "object" ||
        !["launch", "restart", "shutdown", "recovery"].includes(String(state.operation.kind)) ||
        !isString(state.operation.operationId)) return null;
  }
  if (state.phase === "vacant" && (state.workbench !== null || state.operation !== null)) return null;
  if (state.phase === "running" &&
      (!state.workbench || !state.target || !state.mcpOwner || !state.companion)) return null;
  return {
    version: 3,
    generation: state.generation,
    phase: state.phase as LifecyclePhase,
    endpoint,
    target: state.target,
    mcpOwner: state.mcpOwner,
    workbench: state.workbench,
    companion: state.companion,
    operation: state.operation,
  };
}

function isWorkbenchSpawnMetadata(value: unknown): value is WorkbenchSpawnMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<WorkbenchSpawnMetadata>;
  return [
    "mcp_editor",
    "cli_editor",
    "target_build",
    "client_launch",
    "client_restart",
    "runner_editor",
    "runner_companion_preflight",
    "runner_target_build",
  ].includes(String(metadata.purpose)) &&
    isString(metadata.lifecycleGeneration) &&
    isString(metadata.targetKey);
}

function parseWorkbenchSpawnRecord(value: unknown): WorkbenchSpawnRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<WorkbenchSpawnRecord>;
  if (!isString(record.transactionId) ||
      !["pre_spawn", "spawned_unverified", "identity_verified", "published"].includes(
        String(record.phase)
      ) ||
      typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs) ||
      typeof record.updatedAtMs !== "number" || !Number.isFinite(record.updatedAtMs) ||
      !isWorkbenchSpawnMetadata(record.metadata)) return null;
  const pid = record.pid;
  if (pid !== null && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)) {
    return null;
  }
  const identity = record.identity;
  if (identity !== null && !isWorkbenchIdentity(identity)) return null;
  if (record.phase === "pre_spawn" && (pid !== null || identity !== null)) return null;
  if (record.phase === "spawned_unverified" && (pid === null || identity !== null)) return null;
  if ((record.phase === "identity_verified" || record.phase === "published") &&
      (!identity || pid !== identity.pid)) return null;
  return {
    transactionId: record.transactionId,
    phase: record.phase,
    pid,
    identity,
    createdAtMs: record.createdAtMs!,
    updatedAtMs: record.updatedAtMs!,
    metadata: record.metadata,
  } as WorkbenchSpawnRecord;
}

function parseWorkbenchSpawnJournalState(value: unknown): WorkbenchSpawnJournalStateV3 {
  if (!value || typeof value !== "object") {
    throw new TypeError("Workbench spawn journal must be an object.");
  }
  const state = value as Partial<WorkbenchSpawnJournalStateV3>;
  const record = parseWorkbenchSpawnRecord(state.record);
  if (state.version !== LIFECYCLE_VERSION || !isString(state.generation) || !record) {
    throw new TypeError("Workbench spawn journal does not satisfy the strict version-3 schema.");
  }
  return { version: 3, generation: state.generation, record };
}

function defaultStateDir(): string {
  const local = process.env.LOCALAPPDATA;
  return local && local.trim().length > 0
    ? join(local, "ReforgerForge", "Workbench", "v3")
    : join(homedir(), "AppData", "Local", "ReforgerForge", "Workbench", "v3");
}

export interface WindowsLifecycleBackendOptions {
  helperTimeoutMs?: number | (() => number);
  operationDeadlineAtMs?: () => number | undefined;
  /**
   * Process-level fail-stop invoked if an acquired OS mutex disappears before
   * the protected action finishes. It must not return. Injection exists only
   * so a subprocess test can use a deterministic exit code.
   */
  leaseLossFailStop?: (error: LifecycleGuardError) => never;
}

export class WindowsLifecycleBackend extends WindowsExactProcessBackend
  implements WorkbenchLifecycleBackend {
  constructor(
    helperPath: string,
    options: WindowsLifecycleBackendOptions = {}
  ) {
    super(helperPath, {
      helperTimeoutMs: options.helperTimeoutMs,
      operationDeadlineAtMs: options.operationDeadlineAtMs,
      errorFactory: (message, code) => new LifecycleGuardError(
        message,
        code as WindowsExactProcessBackendFailureCode
      ) as LifecycleGuardError & { readonly code: WindowsExactProcessBackendFailureCode },
      leaseLossFailStop: options.leaseLossFailStop
        ? (error) => options.leaseLossFailStop!(error as LifecycleGuardError)
        : undefined,
    });
  }

  async scanWorkbenchProcesses(): Promise<WorkbenchProcessScan> {
    const response = await this.invoke("ListWorkbench", {});
    if (response.ok !== true || response.status !== "complete" || !Array.isArray(response.processes) ||
        !Array.isArray(response.unverifiable)) {
      throw new LifecycleGuardError(
        `Machine-wide Workbench scan failed: ${response.message ?? response.reason ?? "invalid helper response"}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    const processes: ExactProcessIdentity[] = [];
    for (const value of response.processes) {
      const identity = parseExactIdentity(value);
      if (!identity) {
        throw new LifecycleGuardError(
          "Machine-wide Workbench scan returned invalid process metadata.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      processes.push(identity);
    }
    const unverifiable = response.unverifiable.map((value) => {
      const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return {
        pid: Number(record.pid) || 0,
        reason: String(record.reason ?? "unknown"),
        message: String(record.message ?? "Process identity is unverifiable."),
      };
    });
    return { processes, unverifiable };
  }

  async minimizeWindow(pid: number, timeoutMs: number): Promise<{ minimized: boolean }> {
    const response = await this.invoke("MinimizeWindow", { pid }, timeoutMs);
    return { minimized: response.ok === true && response.status === "minimized" };
  }

  async verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    expected: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult> {
    const normalized = normalizedEndpoint(endpoint);
    if (!isLoopbackLifecycleHost(normalized.host)) {
      return {
        kind: "refused",
        reason: "endpoint_not_loopback",
        message: `Automated Workbench lifecycle endpoint ${normalized.host}:${normalized.port} is not loopback.`,
      };
    }
    const response = await this.invoke("VerifyEndpointOwner", {
      endpoint: normalized,
      expected,
    });
    const listenerPid = Number(response.listenerPid);
    if (response.ok === true && response.status === "owned" &&
        Number.isInteger(listenerPid) && listenerPid === expected.pid) {
      return { kind: "owned", listenerPid };
    }
    const allowedReasons = new Set<EndpointOwnershipRefusalReason>([
      "endpoint_not_loopback",
      "listener_not_found",
      "listener_ambiguous",
      "listener_pid_mismatch",
      "access_denied",
      "executable_mismatch",
      "creation_time_mismatch",
      "command_line_unverifiable",
      "token_mismatch",
      "workbench_process_mismatch",
      "helper_failure",
    ]);
    const reason = allowedReasons.has(response.reason as EndpointOwnershipRefusalReason)
      ? response.reason as EndpointOwnershipRefusalReason
      : "helper_failure";
    return {
      kind: "refused",
      reason,
      message: response.message ?? "The listener could not be bound to the exact owned Workbench process.",
    };
  }

  async verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult> {
    const normalized = normalizedEndpoint(endpoint);
    if (!isLoopbackLifecycleHost(normalized.host)) {
      return {
        kind: "unverifiable",
        reason: "endpoint_not_loopback",
        message: "Endpoint vacancy requires a numeric loopback endpoint.",
      };
    }
    let response: WindowsHelperResponse;
    try {
      response = await this.invoke("VerifyEndpointVacant", { endpoint: normalized });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "unverifiable",
        reason: message.startsWith(
          "Windows lifecycle helper mode VerifyEndpointVacant exceeded"
        )
          ? "timeout"
          : "helper_failure",
        message: `The native endpoint-vacancy probe failed: ${message}`,
      };
    }
    if (response.ok === true && response.status === "vacant") return { kind: "vacant" };
    const listenerPid = Number(response.listenerPid);
    if (response.reason === "listener_present" && Number.isInteger(listenerPid) && listenerPid > 0) {
      return {
        kind: "occupied",
        listenerPid,
        message: response.message ?? `The Workbench endpoint is owned by PID ${listenerPid}.`,
      };
    }
    const reason = response.reason === "endpoint_not_loopback" ||
        response.reason === "listener_ambiguous" || response.reason === "access_denied" ||
        response.reason === "timeout"
      ? response.reason
      : "helper_failure";
    return {
      kind: "unverifiable",
      reason,
      message: response.message ?? "The Workbench endpoint is not provably vacant.",
    };
  }
}

class LifecycleSession implements WorkbenchLifecycleSession {
  private active = true;
  private leaseLoss: MachineMutexLeaseLoss | null = null;

  constructor(
    private readonly guard: WorkbenchProcessGuard,
    readonly mcp: McpOwnerIdentity
  ) {}

  close(reason?: MachineMutexLeaseLoss): void {
    this.leaseLoss ??= reason ?? null;
    this.active = false;
  }

  assertActive(): void {
    if (!this.active) {
      if (this.leaseLoss) throw this.leaseLoss;
      throw new LifecycleGuardError(
        "Lifecycle session cannot be used after the machine-wide mutex is released.",
        "STATE_INVALID"
      );
    }
  }

  async readState(): Promise<LifecycleStateRead> {
    this.assertActive();
    return this.guard.readLifecycleState();
  }

  async validateAndClaim(args: {
    endpoint: LifecycleEndpoint;
    target?: CanonicalProjectIdentity | null;
  }): Promise<LifecycleClaimResult> {
    this.assertActive();
    return this.guard.validateAndClaimLocked(this, args);
  }

  async transition(
    expected: ExpectedStateVersion,
    next: LifecycleStateDraft
  ): Promise<WorkbenchLifecycleStateV3> {
    this.assertActive();
    return this.guard.transitionLocked(this, expected, next);
  }

  async transitionToVacant(
    expected: ExpectedStateVersion,
    overrides: Partial<Pick<LifecycleStateDraft, "endpoint" | "target" | "companion">> = {}
  ): Promise<WorkbenchLifecycleStateV3> {
    this.assertActive();
    const read = await this.guard.readLifecycleState();
    if (read.kind !== "valid") {
      throw new LifecycleGuardError("Cannot vacate a missing or invalid lifecycle state.", "STATE_INVALID");
    }
    return this.guard.transitionLocked(this, expected, {
      phase: "vacant",
      endpoint: overrides.endpoint ?? read.state.endpoint,
      target: overrides.target === undefined ? read.state.target : overrides.target,
      mcpOwner: read.state.mcpOwner,
      workbench: null,
      companion: overrides.companion === undefined
        ? read.state.companion
        : overrides.companion,
      operation: null,
    });
  }

  async inspectSpawnedWorkbench(args: {
    pid: number;
    executablePath: string;
    ownerTokenArgument: string;
    launchedAtMs: number;
  }): Promise<WorkbenchIdentity> {
    this.assertActive();
    return this.guard.inspectSpawnedWorkbench(args);
  }

  async verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    expected: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult> {
    this.assertActive();
    return this.guard.verifyEndpointOwner(endpoint, expected);
  }

  async verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult> {
    this.assertActive();
    return this.guard.verifyEndpointVacant(endpoint);
  }

  async verifyAndTerminate(
    expected: WorkbenchIdentity,
    timeoutMs: number
  ): Promise<VerifyTerminateResult> {
    this.assertActive();
    return this.guard.verifyAndTerminate(expected, timeoutMs);
  }

  async assertNoWorkbenchProcesses(): Promise<void> {
    this.assertActive();
    return this.guard.assertNoWorkbenchProcesses();
  }
}

export class WorkbenchProcessGuard {
  readonly stateDir: string;
  readonly mcpInstanceId = randomUUID();
  readonly leaseId = randomUUID();
  readonly backend: WorkbenchLifecycleBackend;
  private readonly mutexName: string;
  private readonly lockTimeoutMs: () => number;
  private readonly operationDeadlineAtMs: (() => number | undefined) | undefined;
  private readonly corruptDir: string;
  private readonly beforeLifecycleReplace: WorkbenchProcessGuardOptions["beforeLifecycleReplace"];
  private readonly afterLifecycleReplace: WorkbenchProcessGuardOptions["afterLifecycleReplace"];
  private readonly beforeSpawnJournalReplace: WorkbenchProcessGuardOptions["beforeSpawnJournalReplace"];
  private readonly afterSpawnJournalReplace: WorkbenchProcessGuardOptions["afterSpawnJournalReplace"];
  private identityPromise: Promise<ExactProcessIdentity & { userSid: string }> | null = null;
  private durableEnvironment: LmdbEnvironment | null = null;
  private lifecycleCasStore: LmdbCasStore<WorkbenchLifecycleStateV3> | null = null;
  private spawnCasStore: LmdbCasStore<WorkbenchSpawnJournalStateV3> | null = null;

  constructor(options: WorkbenchProcessGuardOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? defaultStateDir());
    this.corruptDir = join(this.stateDir, "corrupt");
    this.mutexName = options.mutexName ?? DEFAULT_LIFECYCLE_MUTEX;
    const lockTimeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockTimeoutMs = typeof lockTimeout === "function" ? lockTimeout : () => lockTimeout;
    this.operationDeadlineAtMs = options.operationDeadlineAtMs;
    this.beforeLifecycleReplace = options.beforeLifecycleReplace;
    this.afterLifecycleReplace = options.afterLifecycleReplace;
    this.beforeSpawnJournalReplace = options.beforeSpawnJournalReplace;
    this.afterSpawnJournalReplace = options.afterSpawnJournalReplace;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const helperPath = resolve(
      options.helperPath ?? join(packageRoot, "scripts", "windows", "workbench-lifecycle.ps1")
    );
    this.backend = options.backend ?? new WindowsLifecycleBackend(helperPath, {
      operationDeadlineAtMs: options.operationDeadlineAtMs,
    });
  }

  createOwnerToken(): string {
    return randomUUID();
  }

  ownerArgument(token: string): string {
    if (!token || token.trim().length === 0) {
      throw new LifecycleGuardError("Workbench owner token must not be empty.", "STATE_INVALID");
    }
    return `${WORKBENCH_OWNER_ARG_PREFIX}${token}`;
  }

  /** Release the single LMDB environment backing lifecycle and spawn-journal state, if opened. */
  async close(): Promise<void> {
    await this.durableEnvironment?.close();
  }

  /**
   * Exact identity of this controller process without acquiring the lifecycle
   * mutex. The backend inspection is cached after its first successful proof.
   */
  async currentMcpOwnerIdentity(): Promise<McpOwnerIdentity> {
    const identity = await this.currentIdentity();
    return Object.freeze({
      ...identity,
      instanceId: this.mcpInstanceId,
      leaseId: this.leaseId,
      claimedAtMs: Date.now(),
    });
  }

  async withLifecycleLock<T>(
    action: (session: WorkbenchLifecycleSession) => Promise<T>
  ): Promise<T> {
    const identity = await this.currentIdentity();
    let activeSession: LifecycleSession | null = null;
    return this.backend.withMachineMutex({
      name: this.mutexName,
      timeoutMs: this.currentLockTimeoutMs(),
      onLeaseLost: (error) => activeSession?.close(error),
      action: async () => {
        mkdirSync(this.stateDir, { recursive: true });
        const session = new LifecycleSession(this, {
          ...identity,
          instanceId: this.mcpInstanceId,
          leaseId: this.leaseId,
          claimedAtMs: Date.now(),
        });
        activeSession = session;
        try {
          return await action(session);
        } finally {
          session.close();
          if (activeSession === session) activeSession = null;
        }
      },
    });
  }

  async assertLifecycleAuthority(expected: WorkbenchLifecycleStateV3): Promise<void> {
    // This is a cooperative fence, not a mutation: helper-mediated phase CAS
    // already takes the machine mutex. A bounded atomic snapshot here keeps
    // spawn/inspection outside the mutex while refusing stale generations at
    // each state-machine boundary.
    const read = await this.readLifecycleState();
    const current = read.kind === "valid" ? read.state : null;
    const sameOwner = current?.mcpOwner && expected.mcpOwner &&
      processMatches(current.mcpOwner, expected.mcpOwner) &&
      current.mcpOwner.instanceId === expected.mcpOwner.instanceId &&
      current.mcpOwner.leaseId === expected.mcpOwner.leaseId &&
      current.mcpOwner.userSid === expected.mcpOwner.userSid;
    const sameWorkbench = (!current?.workbench && !expected.workbench) ||
      (current?.workbench && expected.workbench &&
        processMatches(current.workbench, expected.workbench) &&
        current.workbench.ownerTokenArgument === expected.workbench.ownerTokenArgument &&
        current.workbench.launchedAtMs === expected.workbench.launchedAtMs);
    if (!current || current.generation !== expected.generation || !sameOwner ||
        !sameWorkbench || current.target?.comparisonKey !== expected.target?.comparisonKey) {
      throw new LifecycleGuardError(
        "Workbench lifecycle generation or exact owner changed during recoverable spawn.",
        "GENERATION_MISMATCH"
      );
    }
  }

  /**
   * The single LMDB environment shared by the lifecycle and spawn-journal CAS
   * stores. One `WorkbenchProcessGuard` owns exactly one environment (plan 92),
   * opened once and closed once by {@link close}; the two CAS stores are typed
   * views over distinct namespaced keys within it.
   */
  private durableEnv(): LmdbEnvironment {
    mkdirSync(this.stateDir, { recursive: true });
    this.durableEnvironment ??= new LmdbEnvironment(this.stateDir);
    return this.durableEnvironment;
  }

  private lifecycleStore(): LmdbCasStore<WorkbenchLifecycleStateV3> {
    this.lifecycleCasStore ??= new LmdbCasStore({
      storageRoot: this.stateDir,
      environment: this.durableEnv(),
      key: encodeDurableKey("workbench", "lifecycle"),
      recordLabel: "lifecycle",
      schema: "workbench-lifecycle-v3",
      maxRecordBytes: MAX_LIFECYCLE_STATE_BYTES,
      corruptArchiveDir: this.corruptDir,
      codec: jsonDurableRecordCodec((value) => {
        const parsed = parseLifecycleState(value);
        if (!parsed) {
          throw new TypeError("Lifecycle state does not satisfy the strict version-3 schema.");
        }
        return parsed;
      }),
      generationOf: (state) => state.generation,
      beforeCompareAndSwap: this.beforeLifecycleReplace,
      afterCompareAndSwap: this.afterLifecycleReplace,
    });
    return this.lifecycleCasStore;
  }

  private spawnStore(): LmdbCasStore<WorkbenchSpawnJournalStateV3> {
    this.spawnCasStore ??= new LmdbCasStore({
      storageRoot: this.stateDir,
      environment: this.durableEnv(),
      key: encodeDurableKey("workbench", "spawn-journal"),
      recordLabel: "spawn-journal",
      schema: "workbench-spawn-journal-v3",
      maxRecordBytes: MAX_SPAWN_JOURNAL_BYTES,
      corruptArchiveDir: this.corruptDir,
      codec: jsonDurableRecordCodec(parseWorkbenchSpawnJournalState),
      generationOf: (state) => state.generation,
      beforeCompareAndSwap: this.beforeSpawnJournalReplace,
      afterCompareAndSwap: this.afterSpawnJournalReplace,
    });
    return this.spawnCasStore;
  }

  async readLifecycleState(): Promise<LifecycleStateRead> {
    let inspected: LmdbCasInspection<WorkbenchLifecycleStateV3>;
    try {
      inspected = await this.lifecycleStore().inspect();
    } catch (error) {
      return {
        kind: "malformed",
        path: join(this.corruptDir, "lifecycle.json"),
        rawSha256: "unreadable",
        message: `Lifecycle state cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (inspected.kind === "missing") return inspected;
    if (inspected.kind === "versioned") return { kind: "valid", state: inspected.value };
    return {
      kind: "malformed",
      path: inspected.path,
      rawSha256: inspected.rawSha256,
      message: inspected.message,
    };
  }

  async readSpawnJournal(): Promise<WorkbenchSpawnJournalRead> {
    let inspected: LmdbCasInspection<WorkbenchSpawnJournalStateV3>;
    try {
      inspected = await this.spawnStore().inspect();
    } catch (error) {
      return {
        kind: "malformed",
        path: join(this.corruptDir, "spawn-journal.json"),
        rawSha256: "unreadable",
        message: `Workbench spawn journal cannot be read: ${error instanceof Error
          ? error.message
          : String(error)}`,
      };
    }
    if (inspected.kind === "missing") return inspected;
    if (inspected.kind === "versioned") {
      return {
        kind: "valid",
        generation: inspected.generation,
        record: inspected.value.record,
      };
    }
    return {
      kind: "malformed",
      path: inspected.path,
      rawSha256: inspected.rawSha256,
      message: inspected.message,
    };
  }

  async assertSpawnJournalReplaceable(): Promise<void> {
    const read = await this.readSpawnJournal();
    return this.assertSpawnJournalReadReplaceable(read);
  }

  private async assertSpawnJournalReadReplaceable(
    read: WorkbenchSpawnJournalRead
  ): Promise<void> {
    if (read.kind === "missing") return;
    if (read.kind === "malformed") {
      throw new LifecycleGuardError(
        `Workbench spawn journal is malformed and requires manual recovery: ${read.message}`,
        "RECOVERY_REQUIRED"
      );
    }
    const record = read.record;
    if (record.phase === "spawned_unverified") {
      throw new LifecycleGuardError(
        `Workbench spawn transaction ${record.transactionId} durably recorded only PID ` +
          `${record.pid}; exact identity was never established. Preserve it for attended/manual recovery.`,
        "RECOVERY_REQUIRED"
      );
    }
    if (record.phase === "pre_spawn") {
      const processes = await this.scanStrict();
      if (processes.length > 0) {
        throw new LifecycleGuardError(
          `Workbench spawn transaction ${record.transactionId} stopped at pre_spawn while ` +
            `Workbench PID(s) ${processes.map((entry) => entry.pid).join(", ")} exist. ` +
            "The post-spawn publication boundary is uncertain and requires attended/manual recovery.",
          "RECOVERY_REQUIRED"
        );
      }
      return;
    }
    const identity = record.identity!;
    const status = await this.inspectOwnedWorkbench(identity);
    if (status !== "absent") {
      throw new LifecycleGuardError(
        `Workbench spawn transaction ${record.transactionId} still owns exact live PID ` +
          `${identity.pid}; recover that transaction before another spawn.`,
        "RECOVERY_REQUIRED"
      );
    }
  }

  createSpawnJournal(
    lifecycleAuthority: WorkbenchLifecycleStateV3
  ): RecoverableSpawnJournal<WorkbenchIdentity, WorkbenchSpawnMetadata> {
    let expectedGeneration: string | null | undefined;
    return {
      persist: async (previous, next) => {
        let initialGeneration: string | null | undefined;
        if (previous === null) {
          const current = await this.readSpawnJournal();
          await this.assertSpawnJournalReadReplaceable(current);
          initialGeneration = current.kind === "valid" ? current.generation : null;
        } else if (expectedGeneration === undefined) {
          throw new LifecycleGuardError(
            "Workbench spawn journal continuation has no committed prior generation.",
            "STATE_INVALID"
          );
        }
        return this.backend.withMachineMutex({
          name: this.mutexName,
          timeoutMs: this.currentLockTimeoutMs(),
          action: async () => {
            mkdirSync(this.stateDir, { recursive: true });
            const lifecycle = await this.readLifecycleState();
            const current = lifecycle.kind === "valid" ? lifecycle.state : null;
            const sameOwner = current?.mcpOwner && lifecycleAuthority.mcpOwner &&
              processMatches(current.mcpOwner, lifecycleAuthority.mcpOwner) &&
              current.mcpOwner.instanceId === lifecycleAuthority.mcpOwner.instanceId &&
              current.mcpOwner.leaseId === lifecycleAuthority.mcpOwner.leaseId &&
              current.mcpOwner.userSid === lifecycleAuthority.mcpOwner.userSid;
            const sameTarget = current?.target?.comparisonKey === next.metadata.targetKey &&
              lifecycleAuthority.target?.comparisonKey === next.metadata.targetKey;
            const publishedIdentityMatches = next.phase === "published" && current?.workbench &&
              next.identity && processMatches(current.workbench, next.identity) &&
              current.workbench.ownerTokenArgument === next.identity.ownerTokenArgument &&
              current.workbench.launchedAtMs === next.identity.launchedAtMs;
            const reservedGenerationMatches = next.phase !== "published" &&
              current?.generation === lifecycleAuthority.generation &&
              next.metadata.lifecycleGeneration === lifecycleAuthority.generation;
            if (next.metadata.lifecycleGeneration !== lifecycleAuthority.generation ||
                !sameOwner || !sameTarget ||
                (!reservedGenerationMatches && !publishedIdentityMatches)) {
              throw new LifecycleGuardError(
                "Workbench spawn journal phase lacks the exact reserved lifecycle authority.",
                "GENERATION_MISMATCH"
              );
            }
            if (previous === null) {
              const locked = await this.readSpawnJournal();
              const lockedGeneration = locked.kind === "valid" ? locked.generation
                : locked.kind === "missing" ? null
                  : undefined;
              if (lockedGeneration !== initialGeneration) {
                throw new LifecycleGuardError(
                  "Workbench spawn journal changed after recovery preflight; stale publication was refused.",
                  "GENERATION_MISMATCH"
                );
              }
              expectedGeneration = initialGeneration!;
            }
            const envelope: WorkbenchSpawnJournalStateV3 = {
              version: 3,
              generation: randomUUID(),
              record: next,
            };
            const result = await this.spawnStore().compareAndSwap(expectedGeneration!, envelope);
            if (result.kind === "conflict") {
              throw new LifecycleGuardError(
                "Workbench spawn journal generation changed; stale phase publication was refused.",
                "GENERATION_MISMATCH"
              );
            }
            expectedGeneration = result.current.generation;
            return result.current.value.record;
          },
        });
      },
      discardPreSpawn: async (record) => {
        if (record.phase !== "pre_spawn" || typeof expectedGeneration !== "string") {
          throw new LifecycleGuardError(
            "RECOVERY_REQUIRED: exact pre_spawn journal retirement lacks its committed generation.",
            "RECOVERY_REQUIRED"
          );
        }
        try {
          await this.backend.withMachineMutex({
            name: this.mutexName,
            timeoutMs: this.currentLockTimeoutMs(),
            action: async () => {
              const lifecycle = await this.readLifecycleState();
              const current = lifecycle.kind === "valid" ? lifecycle.state : null;
              const sameOwner = current?.mcpOwner && lifecycleAuthority.mcpOwner &&
                processMatches(current.mcpOwner, lifecycleAuthority.mcpOwner) &&
                current.mcpOwner.instanceId === lifecycleAuthority.mcpOwner.instanceId &&
                current.mcpOwner.leaseId === lifecycleAuthority.mcpOwner.leaseId &&
                current.mcpOwner.userSid === lifecycleAuthority.mcpOwner.userSid;
              const sameTarget =
                current?.target?.comparisonKey === record.metadata.targetKey &&
                lifecycleAuthority.target?.comparisonKey === record.metadata.targetKey;
              const sameReservation =
                current?.generation === lifecycleAuthority.generation &&
                record.metadata.lifecycleGeneration === lifecycleAuthority.generation;
              if (!sameOwner || !sameTarget || !sameReservation) {
                throw new LifecycleGuardError(
                  "RECOVERY_REQUIRED: pre_spawn journal retirement lost exact lifecycle authority.",
                  "RECOVERY_REQUIRED"
                );
              }

              const journal = await this.readSpawnJournal();
              if (journal.kind !== "valid" ||
                  journal.generation !== expectedGeneration ||
                  journal.record.phase !== "pre_spawn" ||
                  journal.record.transactionId !== record.transactionId) {
                throw new LifecycleGuardError(
                  "RECOVERY_REQUIRED: pre_spawn journal changed before exact retirement.",
                  "RECOVERY_REQUIRED"
                );
              }
              const removed = await this.spawnStore().compareAndRemove(expectedGeneration);
              if (removed.kind === "conflict") {
                throw new LifecycleGuardError(
                  "RECOVERY_REQUIRED: pre_spawn journal changed during exact retirement.",
                  "RECOVERY_REQUIRED"
                );
              }
              expectedGeneration = undefined;
            },
          });
        } catch (error) {
          if (error instanceof LifecycleGuardError &&
              error.code === "RECOVERY_REQUIRED") {
            throw error;
          }
          throw new LifecycleGuardError(
            `RECOVERY_REQUIRED: exact pre_spawn journal retirement failed ` +
              `(${error instanceof Error ? error.message : String(error)}).`,
            "RECOVERY_REQUIRED"
          );
        }
      },
    };
  }

  private currentLockTimeoutMs(): number {
    let timeoutMs = this.lockTimeoutMs();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new LifecycleGuardError("Lifecycle lock deadline expired.", "LIFECYCLE_BUSY");
    }
    const operationDeadlineAtMs = this.currentOperationDeadlineAtMs();
    if (operationDeadlineAtMs !== undefined) {
      const remainingMs = Math.floor(operationDeadlineAtMs - Date.now());
      if (remainingMs <= 0) {
        throw new LifecycleGuardError("Lifecycle lock deadline expired.", "LIFECYCLE_BUSY");
      }
      timeoutMs = Math.min(timeoutMs, remainingMs);
    }
    return timeoutMs;
  }

  private currentOperationDeadlineAtMs(): number | undefined {
    const deadlineAtMs = this.operationDeadlineAtMs?.();
    if (deadlineAtMs === undefined) return undefined;
    if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) {
      throw new LifecycleGuardError("Lifecycle absolute deadline is invalid.", "STATE_INVALID");
    }
    return deadlineAtMs;
  }

  async listWorkbenchProcesses(): Promise<ExactProcessIdentity[]> {
    return this.scanStrict();
  }

  /**
   * Capture the exact spawned identity without retaining the machine mutex.
   * Callers must first publish a durable launch reservation and CAS that
   * reservation again before committing this identity.
   */
  async inspectSpawnedWorkbench(args: {
    pid: number;
    executablePath: string;
    ownerTokenArgument: string;
    launchedAtMs: number;
  }): Promise<WorkbenchIdentity> {
    let lastError: unknown;
    const localDeadlineAtMs = Date.now() + PROCESS_CAPTURE_TIMEOUT_MS;
    const operationDeadlineAtMs = this.currentOperationDeadlineAtMs();
    const inspectionDeadline = operationDeadlineAtMs === undefined
      ? deadlineAfter(systemClock, PROCESS_CAPTURE_TIMEOUT_MS)
      : deadlineAt(Math.min(localDeadlineAtMs, operationDeadlineAtMs));
    const result = await pollUntil<WorkbenchIdentity>({
      clock: systemClock,
      sleeper: systemSleeper,
      deadline: inspectionDeadline,
      intervalMs: PROCESS_POLL_MS,
      probe: async (): Promise<WorkbenchIdentity | undefined> => {
        let inspection: ProcessInspection | null = null;
        try {
          inspection = await this.backend.inspectProcess(args.pid, args.ownerTokenArgument);
        } catch (error) {
          lastError = error;
        }
        if (inspection?.identity.pid !== undefined && inspection.identity.pid !== args.pid) {
          throw new LifecycleGuardError(
            `Process inspection for spawned PID ${args.pid} returned PID ${inspection.identity.pid}.`,
            "IDENTITY_UNVERIFIABLE"
          );
        }
        if (inspection && normalizedPath(inspection.identity.executablePath) !== normalizedPath(args.executablePath)) {
          throw new LifecycleGuardError(
            `Spawned PID ${args.pid} executable path does not match Workbench.`,
            "IDENTITY_UNVERIFIABLE"
          );
        }
        return inspection?.ownerArgumentMatched === true
          ? {
              ...inspection.identity,
              ownerTokenArgument: args.ownerTokenArgument,
              launchedAtMs: args.launchedAtMs,
            }
          : undefined;
      },
    });
    if (result.kind === "value") return result.value;
    throw new LifecycleGuardError(
      `Could not verify spawned Workbench PID ${args.pid} by exact handle identity and owner argument` +
        `${lastError instanceof Error ? `: ${lastError.message}` : "."}`,
      "IDENTITY_UNVERIFIABLE"
    );
  }

  async verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    expected: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult> {
    const normalized = normalizedEndpoint(endpoint);
    if (!isLoopbackLifecycleHost(normalized.host)) {
      return {
        kind: "refused",
        reason: "endpoint_not_loopback",
        message: `Automated Workbench lifecycle endpoint ${normalized.host}:${normalized.port} is not loopback.`,
      };
    }
    return this.backend.verifyEndpointOwner(normalized, expected);
  }

  async verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult> {
    const normalized = normalizedEndpoint(endpoint);
    if (!isLoopbackLifecycleHost(normalized.host)) {
      return {
        kind: "unverifiable",
        reason: "endpoint_not_loopback",
        message: "Endpoint vacancy requires a numeric loopback endpoint.",
      };
    }
    try {
      return await this.backend.verifyEndpointVacant(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "unverifiable",
        reason: /(?:exceeded (?:its )?\d+ms deadline|timed?\s*out|deadline expired)/i.test(message)
          ? "timeout"
          : "helper_failure",
        message: `Endpoint vacancy could not be proven: ${message}`,
      };
    }
  }

  async verifyAndTerminate(
    expected: WorkbenchIdentity,
    timeoutMs: number
  ): Promise<VerifyTerminateResult> {
    return this.backend.verifyAndTerminate(expected, timeoutMs);
  }

  async assertNoWorkbenchProcesses(): Promise<void> {
    const processes = await this.scanStrict();
    if (processes.length > 0) {
      throw new LifecycleGuardError(
        `Workbench PID(s) ${processes.map((entry) => entry.pid).join(", ")} are already running; ` +
          "absence of an external owner cannot be proven.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
  }

  async inspectOwnedWorkbench(expected: WorkbenchIdentity): Promise<"live" | "absent"> {
    const inspection = await this.backend.inspectProcess(
      expected.pid,
      expected.ownerTokenArgument
    );
    if (!inspection) return "absent";
    if (!processMatches(inspection.identity, expected) ||
        inspection.ownerArgumentMatched !== true) {
      throw new LifecycleGuardError(
        `Workbench PID ${expected.pid} no longer matches its exact executable, creation time, ` +
          `and owner-token identity.`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return "live";
  }

  async scanStrict(): Promise<ExactProcessIdentity[]> {
    const scan = await this.backend.scanWorkbenchProcesses();
    if (scan.unverifiable.length > 0) {
      throw new LifecycleGuardError(
        `Workbench process identity is unverifiable for PID(s) ` +
          `${scan.unverifiable.map((entry) => entry.pid).join(", ")}; refusing lifecycle mutation.`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return scan.processes;
  }

  async validateAndClaimLocked(
    session: LifecycleSession,
    args: {
      endpoint: LifecycleEndpoint;
      target?: CanonicalProjectIdentity | null;
    }
  ): Promise<LifecycleClaimResult> {
    const endpoint = normalizedEndpoint(args.endpoint);
    if (!isLoopbackLifecycleHost(endpoint.host)) {
      return {
        kind: "refused",
        code: "IDENTITY_UNVERIFIABLE",
        message: `Automated Workbench lifecycle endpoint ${endpoint.host}:${endpoint.port} must be a numeric loopback address.`,
      };
    }
    const target = args.target ?? null;
    const read = await this.readLifecycleState();

    if (read.kind === "missing") {
      const processes = await this.scanStrict();
      if (processes.length > 0) return this.unownedRefusal(processes);
      const state = await this.createClaimedState(null, endpoint, target, session.mcp);
      return { kind: "claimed", state, source: "missing" };
    }

    if (read.kind === "malformed") {
      const processes = await this.scanStrict();
      if (processes.length > 0) {
        return {
          kind: "refused",
          code: "STATE_INVALID",
          message: "Lifecycle state is malformed while Workbench may be live; automated recovery is refused.",
        };
      }
      const archivePath = join(
        dirname(read.path),
        `malformed-${Date.now()}-${randomUUID()}.json`
      );
      const malformed = await this.lifecycleStore().inspect();
      if (malformed.kind !== "corrupt" || malformed.rawSha256 !== read.rawSha256) {
        throw new LifecycleGuardError(
          "Lifecycle state changed before malformed-state archival.",
          "GENERATION_MISMATCH"
        );
      }
      await this.lifecycleStore().archiveCorrupt(malformed, archivePath);
      const state = await this.createClaimedState(null, endpoint, target, session.mcp);
      return { kind: "claimed", state, source: "malformed" };
    }

    const state = read.state;
    if (state.endpoint.host !== endpoint.host || state.endpoint.port !== endpoint.port) {
      return {
        kind: "refused",
        code: "ENDPOINT_CONFLICT",
        message: `Lifecycle endpoint ${state.endpoint.host}:${state.endpoint.port} does not match ` +
          `${endpoint.host}:${endpoint.port}.`,
        state,
      };
    }
    if (target && state.target && target.comparisonKey !== state.target.comparisonKey &&
        (state.phase !== "vacant" || state.workbench !== null)) {
      return {
        kind: "refused",
        code: "TARGET_CONFLICT",
        message: `Recorded canonical target ${state.target.path} conflicts with requested target ${target.path}.`,
        state,
      };
    }
    if (state.mcpOwner && state.mcpOwner.userSid !== session.mcp.userSid) {
      return {
        kind: "refused",
        code: "USER_CONFLICT",
        message: "Lifecycle state belongs to a different Windows user SID and cannot be claimed.",
        state,
      };
    }

    const isCurrent = state.mcpOwner?.instanceId === this.mcpInstanceId &&
      state.mcpOwner.leaseId === this.leaseId;
    if (isCurrent) {
      if (!processMatches(state.mcpOwner!, session.mcp)) {
        return {
          kind: "refused",
          code: "STATE_INVALID",
          message: "Current MCP lease does not match this MCP process's exact identity.",
          state,
        };
      }
      if (target && state.target?.comparisonKey !== target.comparisonKey) {
        const changed = await this.transitionLocked(session, {
          generation: state.generation,
          leaseId: state.mcpOwner!.leaseId,
        }, {
          phase: state.phase,
          endpoint,
          target: target ?? state.target,
          mcpOwner: state.mcpOwner,
          workbench: state.workbench,
          companion: state.companion,
          operation: state.operation,
        });
        return { kind: "owned_by_current_mcp", state: changed };
      }
      return { kind: "owned_by_current_mcp", state };
    }

    if (state.mcpOwner) {
      let prior: ProcessInspection | null;
      try {
        prior = await this.backend.inspectProcess(state.mcpOwner.pid);
      } catch (error) {
        return {
          kind: "refused",
          code: "IDENTITY_UNVERIFIABLE",
          message: `Prior MCP owner identity cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
          state,
        };
      }
      if (prior && processMatches(prior.identity, state.mcpOwner)) {
        return {
          kind: "refused",
          code: "OWNED_BY_OTHER_MCP",
          message: `Another live MCP process (PID ${state.mcpOwner.pid}) owns the Workbench lifecycle lease.`,
          state,
        };
      }
    } else {
      const processes = await this.scanStrict();
      if (processes.length > 0) return this.unownedRefusal(processes, state);
    }

    const claimedOwner: McpOwnerIdentity = { ...session.mcp, claimedAtMs: Date.now() };
    const claimed = await this.replaceExisting(state, {
      phase: state.phase,
      endpoint,
      target: target ?? state.target,
      mcpOwner: claimedOwner,
      workbench: state.workbench,
      companion: state.companion,
      operation: state.operation,
    });
    return {
      kind: "claimed",
      state: claimed,
      source: state.mcpOwner ? "dead_owner" : "vacant",
    };
  }

  async transitionLocked(
    session: LifecycleSession,
    expected: ExpectedStateVersion,
    next: LifecycleStateDraft
  ): Promise<WorkbenchLifecycleStateV3> {
    const read = await this.readLifecycleState();
    if (read.kind !== "valid" || read.state.generation !== expected.generation ||
        (read.state.mcpOwner?.leaseId ?? null) !== expected.leaseId) {
      throw new LifecycleGuardError(
        "Lifecycle state generation or lease changed; stale mutation was refused.",
        "GENERATION_MISMATCH"
      );
    }
    if (!next.mcpOwner || next.mcpOwner.instanceId !== session.mcp.instanceId ||
        next.mcpOwner.leaseId !== session.mcp.leaseId || !processMatches(next.mcpOwner, session.mcp)) {
      throw new LifecycleGuardError(
        "Lifecycle transition does not retain the current exact MCP lease.",
        "STATE_INVALID"
      );
    }
    return this.replaceExisting(read.state, next);
  }

  private async currentIdentity(): Promise<ExactProcessIdentity & { userSid: string }> {
    this.identityPromise ??= this.backend.inspectCurrentProcess(process.pid).then((identity) => {
      if (!parseExactIdentity(identity) || !isString(identity.userSid)) {
        throw new LifecycleGuardError(
          "Current MCP process identity or Windows user SID is unverifiable.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      return identity;
    });
    return this.identityPromise;
  }

  private async createClaimedState(
    expectedGeneration: string | null,
    endpoint: LifecycleEndpoint,
    target: CanonicalProjectIdentity | null,
    owner: McpOwnerIdentity
  ): Promise<WorkbenchLifecycleStateV3> {
    const next: WorkbenchLifecycleStateV3 = {
      version: 3,
      generation: randomUUID(),
      phase: "vacant",
      endpoint,
      target,
      mcpOwner: { ...owner, claimedAtMs: Date.now() },
      workbench: null,
      companion: null,
      operation: null,
    };
    if (!parseLifecycleState(next)) {
      throw new LifecycleGuardError("Initial lifecycle state is invalid.", "STATE_INVALID");
    }
    const replacement = await this.lifecycleStore().compareAndSwap(expectedGeneration, next);
    if (replacement.kind === "conflict") {
      throw new LifecycleGuardError(
        "Lifecycle state generation changed; stale initial claim was refused.",
        "GENERATION_MISMATCH"
      );
    }
    return next;
  }

  private async replaceExisting(
    current: WorkbenchLifecycleStateV3,
    draft: LifecycleStateDraft
  ): Promise<WorkbenchLifecycleStateV3> {
    const next: WorkbenchLifecycleStateV3 = {
      ...draft,
      // Write protected schema/CAS fields after the caller draft so a stale or
      // structurally over-wide object can never preserve its old generation.
      version: 3,
      generation: randomUUID(),
      endpoint: normalizedEndpoint(draft.endpoint),
    };
    if (!parseLifecycleState(next)) {
      throw new LifecycleGuardError("Refusing to write an invalid lifecycle state transition.", "STATE_INVALID");
    }
    const replacement = await this.lifecycleStore().compareAndSwap(current.generation, next);
    if (replacement.kind === "conflict") {
      throw new LifecycleGuardError(
        "Lifecycle state generation changed; stale mutation was refused.",
        "GENERATION_MISMATCH"
      );
    }
    return next;
  }

  private unownedRefusal(
    processes: ExactProcessIdentity[],
    state?: WorkbenchLifecycleStateV3
  ): Extract<LifecycleClaimResult, { kind: "refused" }> {
    return {
      kind: "refused",
      code: "UNOWNED_WORKBENCH",
      message: `Workbench PID(s) ${processes.map((entry) => entry.pid).join(", ")} are running ` +
        "without a claimable exact MCP lifecycle owner.",
      state,
    };
  }
}
