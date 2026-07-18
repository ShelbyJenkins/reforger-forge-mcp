import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKBENCH_PROCESS_NAME = "ArmaReforgerWorkbenchSteamDiag.exe";
export const WORKBENCH_OWNER_ARG_PREFIX = "-reforgerForgeOwnerToken=";
export const DEFAULT_LIFECYCLE_MUTEX = "Global\\ReforgerForge.WorkbenchLifecycle.v3";

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const HELPER_TIMEOUT_MS = 20_000;
const PROCESS_CAPTURE_TIMEOUT_MS = 5_000;
const PROCESS_POLL_MS = 100;
const LIFECYCLE_VERSION = 3;

export type LifecycleFailStop = (message: string) => never;

export interface ExactProcessIdentity {
  pid: number;
  executablePath: string;
  /** Exact decimal Windows FILETIME captured from an opened process handle. */
  creationTime: string;
}

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

export type VerifyTerminateResult =
  | { kind: "terminated" | "already_exited" }
  | {
      kind: "refused";
      reason:
        | "access_denied"
        | "pid_reused"
        | "executable_mismatch"
        | "creation_time_mismatch"
        | "command_line_unverifiable"
        | "token_mismatch"
        | "timeout"
        | "helper_failure";
      message: string;
    };

export interface ProcessInspection {
  identity: ExactProcessIdentity;
  ownerArgumentMatched: boolean | null;
}

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
  | { kind: "refused"; listenerPid?: number; message: string };

export interface WorkbenchLifecycleBackend {
  readonly platform: "win32" | "test";
  withMachineMutex<T>(args: {
    name: string;
    timeoutMs: number;
    action: () => Promise<T>;
  }): Promise<T>;
  inspectCurrentProcess(pid: number): Promise<ExactProcessIdentity & { userSid: string }>;
  inspectProcess(pid: number, expectedOwnerTokenArgument?: string): Promise<ProcessInspection | null>;
  scanWorkbenchProcesses(): Promise<WorkbenchProcessScan>;
  verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    expected: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult>;
  verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult>;
  verifyAndTerminate(expected: WorkbenchIdentity, timeoutMs: number): Promise<VerifyTerminateResult>;
  replaceState(args: {
    path: string;
    expectedGeneration: string | null;
    next: WorkbenchLifecycleStateV3;
  }): Promise<void>;
  archiveState(args: { path: string; archivePath: string; expectedSha256: string }): Promise<void>;
}

export interface WorkbenchProcessGuardOptions {
  stateDir?: string;
  mutexName?: string;
  lockTimeoutMs?: number;
  backend?: WorkbenchLifecycleBackend;
  helperPath?: string;
}

export type LifecycleGuardErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "IDENTITY_UNVERIFIABLE"
  | "STATE_INVALID"
  | "GENERATION_MISMATCH"
  | "LIFECYCLE_BUSY"
  | "HELPER_FAILURE";

export class LifecycleGuardError extends Error {
  constructor(message: string, public readonly code: LifecycleGuardErrorCode) {
    super(message);
    this.name = "LifecycleGuardError";
  }
}

export interface WorkbenchLifecycleSession {
  readonly mcp: McpOwnerIdentity;
  readState(): Promise<LifecycleStateRead>;
  validateAndClaim(args: {
    endpoint: LifecycleEndpoint;
    target?: CanonicalProjectIdentity | null;
    operation?: { kind: LifecycleOperationKind; operationId: string } | null;
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

interface HelperResponse {
  ok?: boolean;
  status?: string;
  reason?: string;
  message?: string;
  identity?: unknown;
  ownerArgumentMatched?: unknown;
  processes?: unknown;
  unverifiable?: unknown;
  listenerPid?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

function isPositiveFileTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return false;
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function parseExactIdentity(value: unknown): ExactProcessIdentity | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0 ||
      typeof record.executablePath !== "string" || record.executablePath.trim().length === 0 ||
      !isPositiveFileTime(record.creationTime)) return null;
  return {
    pid,
    executablePath: resolve(record.executablePath),
    creationTime: record.creationTime,
  };
}

function processMatches(left: ExactProcessIdentity, right: ExactProcessIdentity): boolean {
  return left.pid === right.pid &&
    normalizedPath(left.executablePath) === normalizedPath(right.executablePath) &&
    left.creationTime === right.creationTime;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseJsonText(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
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

function defaultStateDir(): string {
  const local = process.env.LOCALAPPDATA;
  return local && local.trim().length > 0
    ? join(local, "ReforgerForge", "Workbench", "v3")
    : join(homedir(), "AppData", "Local", "ReforgerForge", "Workbench", "v3");
}

export interface WindowsLifecycleBackendOptions {
  helperTimeoutMs?: number;
  failStop?: LifecycleFailStop;
}

export class WindowsLifecycleBackend implements WorkbenchLifecycleBackend {
  readonly platform = "win32" as const;
  private readonly helperTimeoutMs: number;
  private readonly failStop: LifecycleFailStop;

  constructor(
    private readonly helperPath: string,
    options: WindowsLifecycleBackendOptions = {}
  ) {
    this.helperTimeoutMs = options.helperTimeoutMs ?? HELPER_TIMEOUT_MS;
    if (!Number.isInteger(this.helperTimeoutMs) || this.helperTimeoutMs <= 0) {
      throw new LifecycleGuardError("Windows lifecycle helper timeout must be positive.", "STATE_INVALID");
    }
    this.failStop = options.failStop ?? ((message): never => {
      try {
        process.stderr.write(`ReforgerForge lifecycle fail-stop: ${message}\n`);
      } finally {
        process.abort();
      }
    });
  }

  private assertSupported(): void {
    if (platform() !== "win32") {
      throw new LifecycleGuardError(
        "Automated Workbench lifecycle control is supported only on Windows.",
        "UNSUPPORTED_PLATFORM"
      );
    }
    if (!existsSync(this.helperPath)) {
      throw new LifecycleGuardError(
        `Bundled Windows lifecycle helper is missing: ${this.helperPath}`,
        "HELPER_FAILURE"
      );
    }
  }

  private powershellArgs(mode: string, deadlineUnixMs: number): string[] {
    return [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.helperPath,
      "-Mode",
      mode,
      "-DeadlineUnixMs",
      String(deadlineUnixMs),
    ];
  }

  private async waitForMutexHelperExit(
    child: ChildProcessWithoutNullStreams,
    closePromise: Promise<number | null>,
    context: string,
    killImmediately: boolean
  ): Promise<void> {
    if (killImmediately) child.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      closePromise.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill();
          try {
            this.failStop(
              `${context}; the mutex helper did not exit within ${this.helperTimeoutMs}ms.`
            );
          } catch (error) {
            reject(error);
          }
        }, this.helperTimeoutMs);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async invoke(
    mode: string,
    request: unknown,
    timeoutMs = this.helperTimeoutMs,
    mutationOutcomeUncertainOnTimeout = false
  ): Promise<HelperResponse> {
    this.assertSupported();
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new LifecycleGuardError("Windows lifecycle helper timeout must be positive.", "STATE_INVALID");
    }
    const deadlineUnixMs = Date.now() + timeoutMs;
    return new Promise<HelperResponse>((resolvePromise, reject) => {
      const child = spawn("powershell.exe", this.powershellArgs(mode, deadlineUnixMs), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        const message = `Windows lifecycle helper mode ${mode} exceeded its ${timeoutMs}ms deadline.`;
        if (mutationOutcomeUncertainOnTimeout) {
          try {
            this.failStop(message);
          } catch (error) {
            reject(error);
          }
          return;
        }
        reject(new LifecycleGuardError(message, "HELPER_FAILURE"));
      }, timeoutMs);
      timer.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.on("error", () => undefined);
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new LifecycleGuardError(
          `Could not start Windows lifecycle helper: ${error.message}`,
          "HELPER_FAILURE"
        ));
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length === 0) {
          reject(new LifecycleGuardError(
            `Windows lifecycle helper mode ${mode} returned no private JSON response` +
              `${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
            "HELPER_FAILURE"
          ));
          return;
        }
        try {
          const response = parseJsonText(lines[lines.length - 1]) as HelperResponse;
          if (code !== 0 && response.ok !== false) {
            reject(new LifecycleGuardError(
              `Windows lifecycle helper mode ${mode} exited with code ${code}.`,
              "HELPER_FAILURE"
            ));
            return;
          }
          resolvePromise(response);
        } catch (error) {
          reject(new LifecycleGuardError(
            `Windows lifecycle helper mode ${mode} returned invalid JSON: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            "HELPER_FAILURE"
          ));
        }
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }

  async withMachineMutex<T>(args: {
    name: string;
    timeoutMs: number;
    action: () => Promise<T>;
  }): Promise<T> {
    this.assertSupported();
    const acquisitionBudgetMs = args.timeoutMs + this.helperTimeoutMs;
    const child = spawn(
      "powershell.exe",
      this.powershellArgs("HoldMutex", Date.now() + acquisitionBudgetMs),
      {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      }
    ) as ChildProcessWithoutNullStreams;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => undefined);
    let stderr = "";
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const closePromise = new Promise<number | null>((resolveClose) =>
      child.once("close", (code) => resolveClose(code))
    );
    const acquired = await new Promise<HelperResponse>((resolveAcquired, reject) => {
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new LifecycleGuardError(
          `Lifecycle mutex holder produced no acquisition response within ${acquisitionBudgetMs}ms.`,
          "HELPER_FAILURE"
        );
        void this.waitForMutexHelperExit(
          child,
          closePromise,
          "Lifecycle mutex acquisition timed out",
          true
        ).then(() => reject(error), reject);
      }, acquisitionBudgetMs);
      timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("close", onClose);
      };
      const onError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new LifecycleGuardError(
          `Could not start the lifecycle mutex holder: ${error.message}`,
          "HELPER_FAILURE"
        ));
      };
      const onClose = (code: number | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new LifecycleGuardError(
          `Lifecycle mutex holder exited before its acquisition response (code ${code})` +
            `${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
          "HELPER_FAILURE"
        ));
      };
      const onData = (chunk: string): void => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        settled = true;
        cleanup();
        try {
          resolveAcquired(parseJsonText(buffer.slice(0, newline).trim()) as HelperResponse);
        } catch (error) {
          const invalidResponse = new LifecycleGuardError(
            `Lifecycle mutex holder returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            "HELPER_FAILURE"
          );
          void this.waitForMutexHelperExit(
            child,
            closePromise,
            "Lifecycle mutex holder returned invalid JSON",
            true
          ).then(() => reject(invalidResponse), reject);
        }
      };
      child.once("error", onError);
      child.once("close", onClose);
      child.stdout.on("data", onData);
      child.stdin.write(`${JSON.stringify({ mutexName: args.name, timeoutMs: args.timeoutMs })}\n`);
    });
    if (acquired.ok !== true || acquired.status !== "acquired") {
      child.stdin.end();
      await this.waitForMutexHelperExit(
        child,
        closePromise,
        "Lifecycle mutex holder did not exit after refusing acquisition",
        false
      );
      throw new LifecycleGuardError(
        acquired.status === "timeout"
          ? `Timed out waiting for the machine-wide Workbench lifecycle mutex ${args.name}.`
          : `Lifecycle mutex acquisition failed: ${acquired.message ?? acquired.reason ?? stderr.trim()}`,
        acquired.status === "timeout" ? "LIFECYCLE_BUSY" : "HELPER_FAILURE"
      );
    }

    let released = false;
    const holderFailure = closePromise.then((code) => {
      if (!released) {
        // JavaScript callbacks cannot be safely cancelled after the OS mutex
        // has been abandoned. Fail-stop the MCP process so no background
        // lifecycle action can continue after another MCP acquires the mutex.
        this.failStop(`Lifecycle mutex holder exited unexpectedly with code ${code}.`);
      }
      return new Promise<never>(() => undefined);
    });
    try {
      return await Promise.race([args.action(), holderFailure]);
    } finally {
      released = true;
      child.stdin.end("release\n");
      await this.waitForMutexHelperExit(
        child,
        closePromise,
        "Lifecycle mutex holder did not release",
        false
      );
    }
  }

  async inspectCurrentProcess(pid: number): Promise<ExactProcessIdentity & { userSid: string }> {
    const response = await this.invoke("InspectCurrent", { pid });
    const identity = parseExactIdentity(response.identity);
    const userSid = response.identity && typeof response.identity === "object"
      ? (response.identity as Record<string, unknown>).userSid
      : null;
    if (response.ok !== true || response.status !== "found" || !identity || !isString(userSid)) {
      throw new LifecycleGuardError(
        `Current MCP process identity is unverifiable: ${response.message ?? response.reason ?? "invalid helper response"}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return { ...identity, userSid };
  }

  async inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<ProcessInspection | null> {
    const response = await this.invoke("InspectProcess", {
      pid,
      expectedOwnerTokenArgument: expectedOwnerTokenArgument ?? "",
    });
    if (response.ok === true && response.status === "absent") return null;
    const identity = parseExactIdentity(response.identity);
    if (response.ok !== true || response.status !== "found" || !identity) {
      throw new LifecycleGuardError(
        `Process ${pid} is unverifiable: ${response.message ?? response.reason ?? "invalid helper response"}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return {
      identity,
      ownerArgumentMatched: typeof response.ownerArgumentMatched === "boolean"
        ? response.ownerArgumentMatched
        : null,
    };
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
      return { kind: "refused", message: "Endpoint vacancy requires a numeric loopback endpoint." };
    }
    const response = await this.invoke("VerifyEndpointVacant", { endpoint: normalized });
    if (response.ok === true && response.status === "vacant") return { kind: "vacant" };
    const listenerPid = Number(response.listenerPid);
    return {
      kind: "refused",
      ...(Number.isInteger(listenerPid) && listenerPid > 0 ? { listenerPid } : {}),
      message: response.message ?? "The Workbench endpoint is not provably vacant.",
    };
  }

  async verifyAndTerminate(
    expected: WorkbenchIdentity,
    timeoutMs: number
  ): Promise<VerifyTerminateResult> {
    const response = await this.invoke(
      "VerifyTerminate",
      { expected, timeoutMs },
      timeoutMs + this.helperTimeoutMs,
      true
    );
    if (response.ok === true && (response.status === "terminated" || response.status === "already_exited")) {
      return { kind: response.status };
    }
    return {
      kind: "refused",
      reason: (response.reason ?? "helper_failure") as Extract<VerifyTerminateResult, { kind: "refused" }>["reason"],
      message: response.message ?? "The exact process helper refused termination.",
    };
  }

  async replaceState(args: {
    path: string;
    expectedGeneration: string | null;
    next: WorkbenchLifecycleStateV3;
  }): Promise<void> {
    const response = await this.invoke("ReplaceState", {
      statePath: args.path,
      expectedGeneration: args.expectedGeneration,
      nextJson: `${JSON.stringify(args.next, null, 2)}\n`,
    }, this.helperTimeoutMs, true);
    if (response.ok !== true || response.status !== "replaced") {
      throw new LifecycleGuardError(
        `Lifecycle state replacement failed: ${response.message ?? response.reason ?? "unknown helper error"}`,
        response.message?.includes("generation mismatch") ? "GENERATION_MISMATCH" : "HELPER_FAILURE"
      );
    }
  }

  async archiveState(args: {
    path: string;
    archivePath: string;
    expectedSha256: string;
  }): Promise<void> {
    const response = await this.invoke("ArchiveState", {
      statePath: args.path,
      archivePath: args.archivePath,
      expectedSha256: args.expectedSha256,
    }, this.helperTimeoutMs, true);
    if (response.ok !== true || response.status !== "archived") {
      throw new LifecycleGuardError(
        `Lifecycle state archival failed: ${response.message ?? response.reason ?? "unknown helper error"}`,
        "HELPER_FAILURE"
      );
    }
  }
}

class LifecycleSession implements WorkbenchLifecycleSession {
  private active = true;

  constructor(
    private readonly guard: WorkbenchProcessGuard,
    readonly mcp: McpOwnerIdentity
  ) {}

  close(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active) {
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
    operation?: { kind: LifecycleOperationKind; operationId: string } | null;
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
    const deadline = Date.now() + PROCESS_CAPTURE_TIMEOUT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      let inspection: ProcessInspection | null = null;
      try {
        inspection = await this.guard.backend.inspectProcess(args.pid, args.ownerTokenArgument);
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
      if (inspection?.ownerArgumentMatched === true) {
        return {
          ...inspection.identity,
          ownerTokenArgument: args.ownerTokenArgument,
          launchedAtMs: args.launchedAtMs,
        };
      }
      await sleep(PROCESS_POLL_MS);
    }
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
    this.assertActive();
    const normalized = normalizedEndpoint(endpoint);
    if (!isLoopbackLifecycleHost(normalized.host)) {
      return {
        kind: "refused",
        reason: "endpoint_not_loopback",
        message: `Automated Workbench lifecycle endpoint ${normalized.host}:${normalized.port} is not loopback.`,
      };
    }
    return this.guard.backend.verifyEndpointOwner(normalized, expected);
  }

  async verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult> {
    this.assertActive();
    const normalized = normalizedEndpoint(endpoint);
    if (!isLoopbackLifecycleHost(normalized.host)) {
      return { kind: "refused", message: "Endpoint vacancy requires a numeric loopback endpoint." };
    }
    return this.guard.backend.verifyEndpointVacant(normalized);
  }

  async verifyAndTerminate(
    expected: WorkbenchIdentity,
    timeoutMs: number
  ): Promise<VerifyTerminateResult> {
    this.assertActive();
    return this.guard.backend.verifyAndTerminate(expected, timeoutMs);
  }

  async assertNoWorkbenchProcesses(): Promise<void> {
    this.assertActive();
    const processes = await this.guard.scanStrict();
    if (processes.length > 0) {
      throw new LifecycleGuardError(
        `Workbench PID(s) ${processes.map((entry) => entry.pid).join(", ")} are already running; ` +
          "absence of an external owner cannot be proven.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
  }
}

export class WorkbenchProcessGuard {
  readonly stateDir: string;
  readonly statePath: string;
  readonly mcpInstanceId = randomUUID();
  readonly leaseId = randomUUID();
  readonly backend: WorkbenchLifecycleBackend;
  private readonly mutexName: string;
  private readonly lockTimeoutMs: number;
  private identityPromise: Promise<ExactProcessIdentity & { userSid: string }> | null = null;

  constructor(options: WorkbenchProcessGuardOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? defaultStateDir());
    this.statePath = join(this.stateDir, "lifecycle.json");
    this.mutexName = options.mutexName ?? DEFAULT_LIFECYCLE_MUTEX;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const helperPath = resolve(
      options.helperPath ?? join(packageRoot, "scripts", "windows", "workbench-lifecycle.ps1")
    );
    this.backend = options.backend ?? new WindowsLifecycleBackend(helperPath);
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

  async withLifecycleLock<T>(
    action: (session: WorkbenchLifecycleSession) => Promise<T>
  ): Promise<T> {
    const identity = await this.currentIdentity();
    return this.backend.withMachineMutex({
      name: this.mutexName,
      timeoutMs: this.lockTimeoutMs,
      action: async () => {
        mkdirSync(this.stateDir, { recursive: true });
        const session = new LifecycleSession(this, {
          ...identity,
          instanceId: this.mcpInstanceId,
          leaseId: this.leaseId,
          claimedAtMs: Date.now(),
        });
        try {
          return await action(session);
        } finally {
          session.close();
        }
      },
    });
  }

  async readLifecycleState(): Promise<LifecycleStateRead> {
    const activePath = existsSync(this.statePath) ? this.statePath : null;
    if (!activePath) return { kind: "missing" };
    let raw: Buffer;
    try {
      raw = readFileSync(activePath);
    } catch (error) {
      return {
        kind: "malformed",
        path: activePath,
        rawSha256: "unreadable",
        message: `Lifecycle state cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const rawSha256 = sha256(raw);
    let parsed: unknown;
    try {
      parsed = parseJsonText(raw.toString("utf8"));
    } catch (error) {
      return {
        kind: "malformed",
        path: activePath,
        rawSha256,
        message: `Lifecycle state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const state = parseLifecycleState(parsed);
    if (state) return { kind: "valid", state };
    return {
      kind: "malformed",
      path: activePath,
      rawSha256,
      message: "Lifecycle state does not satisfy the strict version-3 schema.",
    };
  }

  async listWorkbenchProcesses(): Promise<ExactProcessIdentity[]> {
    return this.scanStrict();
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
      operation?: { kind: LifecycleOperationKind; operationId: string } | null;
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
      const state = await this.createClaimedState(null, endpoint, target, session.mcp, args.operation ?? null);
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
      await this.backend.archiveState({
        path: read.path,
        archivePath,
        expectedSha256: read.rawSha256,
      });
      const state = await this.createClaimedState(null, endpoint, target, session.mcp, args.operation ?? null);
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
      if ((target && state.target?.comparisonKey !== target.comparisonKey) || args.operation !== undefined) {
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
          operation: args.operation === undefined ? state.operation : args.operation,
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
      operation: args.operation === undefined ? state.operation : args.operation,
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
    owner: McpOwnerIdentity,
    operation: { kind: LifecycleOperationKind; operationId: string } | null
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
    await this.backend.replaceState({ path: this.statePath, expectedGeneration, next });
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
    await this.backend.replaceState({
      path: this.statePath,
      expectedGeneration: current.generation,
      next,
    });
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
