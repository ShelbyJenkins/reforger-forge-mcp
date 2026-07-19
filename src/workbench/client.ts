/**
 * TCP client and target-aware Workbench lifecycle coordinator.
 *
 * Every NET API call uses a fresh socket. Lifecycle mutations use short
 * reserve/CAS/commit transactions under the machine-wide mutex; readiness,
 * exact termination, and endpoint-release waits run against durable exact
 * owner evidence after that mutex is released.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Socket } from "node:net";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  WorkbenchActivityError,
  WorkbenchActivityGate,
  type CaptureActivityBinding,
  type CaptureActivityLease,
  type WorkbenchActivityGateTiming,
} from "./activity-gate.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import {
  ChildSupervisor,
  type SupervisedChildCounts,
} from "./child-supervisor.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  WorkbenchHelperStager,
  defaultWorkbenchHelperManagedRoot,
  defaultWorkbenchHelperSource,
  verifyWorkbenchHelperSource,
  type WorkbenchCompanionLaunch,
  type WorkbenchCompanionManagedStatus,
  type WorkbenchCompanionProvider,
  type WorkbenchCompanionRetentionResult,
  type WorkbenchCompanionUninstallResult,
} from "./helper-addon.js";
import {
  ProjectIdentityError,
  canonicalizeGproj,
  resolveProjectIdentity,
  revalidateProjectIdentity,
  type CanonicalProjectIdentity,
} from "./project-identity.js";
import {
  WorkbenchProcessGuard,
  LifecycleGuardError,
  type ExpectedStateVersion,
  type LifecycleClaimResult,
  type LifecycleStateRead,
  type LifecycleOperationKind,
  type LifecycleStateDraft,
  type WorkbenchCompanionLifecycleState,
  type WorkbenchIdentity,
  type WorkbenchLifecycleSession,
  type WorkbenchLifecycleStateV3,
} from "./process-guard.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;
const OWNED_PROCESS_EXIT_TIMEOUT_MS = 15_000;
const PORT_RELEASE_TIMEOUT_MS = 15_000;
const PORT_RELEASE_POLL_MS = 200;

export type WorkbenchMode = "edit" | "play" | "unknown";

export interface WorkbenchState {
  connected: boolean;
  mode: WorkbenchMode;
  lastUpdated: number;
}

export interface WorkbenchCallOptions {
  timeout?: number;
  skipAutoLaunch?: boolean;
}

export interface WorkbenchLaunchResult {
  action: "launched" | "reused";
  pid: number;
  gprojPath: string;
  generation: string;
}

export interface WorkbenchRestartResult {
  previousPid: number;
  pid: number;
  gprojPath: string;
  generation: string;
}

export interface WorkbenchShutdownResult {
  stopped: boolean;
  previousPid: number | null;
  gprojPath: string | null;
  generation: string;
}

export interface WorkbenchCompanionLaunchArguments {
  readonly addonGuid: string;
  readonly addonSearchRoot: string;
  readonly workbenchProfilePath: string;
}

/**
 * Immutable, already-running Workbench identity handed to observer adapters.
 * The private owner-token argument remains inside the lifecycle subsystem.
 */
export interface WorkbenchObserverSnapshot {
  readonly generation: string;
  readonly companion: Readonly<WorkbenchCompanionLifecycleState>;
  readonly target: {
    readonly path: string;
    readonly comparisonKey: string;
  };
  readonly endpoint: {
    readonly host: string;
    readonly port: number;
  };
  readonly process: {
    readonly pid: number;
    readonly executablePath: string;
    readonly creationTime: string;
    readonly launchedAtMs: number;
  };
}

export type WorkbenchCaptureActivityLease = CaptureActivityLease;

export interface LifecycleDiagnostic {
  state: "missing" | "valid" | "malformed";
  version: number | null;
  generation: string | null;
  phase: string | null;
  endpoint: string | null;
  target: string | null;
  lease: "current_mcp" | "other_mcp" | "vacant" | "unknown";
  operation: string | null;
  companionBuildIdentity: string | null;
  detail?: string;
}

export interface DiagnosticReport {
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  projectPath: { path: string; exists: boolean } | null;
  defaultMod: string | null;
  companionAddon: {
    addonId: string;
    addonGuid: string;
    path: string;
    buildIdentity: string;
    bundleDigest: string;
  } | null;
  netApi: "up_with_companion" | "up_no_companion" | "refused" | "timeout" | "error";
  netApiError?: string;
  lifecycle: LifecycleDiagnostic;
}

export type WorkbenchErrorCode =
  | "CONNECTION_REFUSED"
  | "TIMEOUT"
  | "PROTOCOL_ERROR"
  | "API_ERROR"
  | "LAUNCH_FAILED"
  | "TARGET_REQUIRED"
  | "AMBIGUOUS_TARGET"
  | "INVALID_TARGET"
  | "TARGET_CHANGED"
  | "TARGET_CONFLICT"
  | "OWNED_BY_OTHER_MCP"
  | "UNOWNED_WORKBENCH"
  | "ENDPOINT_CONFLICT"
  | "USER_CONFLICT"
  | "IDENTITY_UNVERIFIABLE"
  | "STATE_INVALID"
  | "RECOVERY_REQUIRED"
  | "UNSUPPORTED_PLATFORM"
  | "LIFECYCLE_BUSY"
  | "ACTIVE_CAPTURE"
  | "CAPTURE_INVALIDATED";

export class WorkbenchError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchErrorCode = "API_ERROR"
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

class ProvenPreSignalTerminationRefusal extends WorkbenchError {}

export function buildWorkbenchLaunchArgs(
  gprojPath?: string | null,
  configuredAddonDirs?: readonly string[],
  scriptAuthorizeAll = false,
  noThrow = false,
  ownerArgument?: string,
  companion?: WorkbenchCompanionLaunchArguments
): string[] {
  const args: string[] = [];
  const addonDirs: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];

  if (configuredAddonDirs !== undefined && !Array.isArray(configuredAddonDirs)) {
    throw new WorkbenchError(
      "Workbench addon directories must be configured as an array of paths.",
      "LAUNCH_FAILED"
    );
  }
  const requestedAddonDirs = [
    ...(configuredAddonDirs ?? []),
    ...(companion ? [companion.addonSearchRoot] : []),
  ];
  for (const configuredDir of requestedAddonDirs) {
    if (typeof configuredDir !== "string" || configuredDir.trim().length === 0) {
      throw new WorkbenchError(
        "Workbench addon directories must be non-empty paths.",
        "LAUNCH_FAILED"
      );
    }
    const configuredPath = configuredDir.trim();
    if (configuredPath.includes(",")) {
      throw new WorkbenchError(
        `Workbench addon directory cannot contain a comma: ${configuredPath}`,
        "LAUNCH_FAILED"
      );
    }
    const addonDir = resolve(configuredPath);
    const key = process.platform === "win32" ? addonDir.toLowerCase() : addonDir;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!statSync(addonDir).isDirectory()) invalid.push(addonDir);
      else addonDirs.push(addonDir);
    } catch {
      invalid.push(addonDir);
    }
  }
  if (invalid.length > 0) {
    const description = invalid.length === 1
      ? "Configured Workbench addon path is not a directory"
      : "Configured Workbench addon paths are not directories";
    throw new WorkbenchError(
      `${description}:\n` +
        invalid.map((path) => `  - ${path}`).join("\n"),
      "LAUNCH_FAILED"
    );
  }
  if (addonDirs.length > 0) args.push("-addonsDir", addonDirs.join(","));
  if (companion) {
    if (!/^[A-Fa-f0-9]{16}$/.test(companion.addonGuid)) {
      throw new WorkbenchError("Workbench companion add-on GUID is invalid.", "LAUNCH_FAILED");
    }
    const profilePath = resolve(companion.workbenchProfilePath);
    try {
      if (!statSync(profilePath).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new WorkbenchError(
        `Workbench companion profile path is not a directory: ${profilePath}`,
        "LAUNCH_FAILED"
      );
    }
    args.push("-addons", companion.addonGuid, "-profile", profilePath);
  }
  if (gprojPath) args.push("-gproj", gprojPath);
  if (scriptAuthorizeAll) args.push("-scriptAuthorizeAll");
  if (noThrow) args.push("-noThrow");
  if (ownerArgument) args.push(ownerArgument);
  return args;
}

interface LaunchPreflight {
  project: CanonicalProjectIdentity;
  companion: WorkbenchCompanionLaunch;
  executablePath: string;
  cwd: string;
  args: string[];
}

interface OwnedChildObservation {
  child: ChildProcess;
  identity: WorkbenchIdentity;
  generation: string;
  targetKey: string;
}

interface ManagedRunningAuthority {
  readonly state: WorkbenchLifecycleStateV3;
  readonly snapshot: WorkbenchObserverSnapshot;
}

interface ActiveLifecycleOperation {
  kind: LifecycleOperationKind;
  operationId: string;
  targetKey: string | null;
  promise: Promise<unknown>;
}

type StoredLifecycleTarget = NonNullable<WorkbenchLifecycleStateV3["target"]>;

export interface WorkbenchClientDependencies {
  companionProvider?: WorkbenchCompanionProvider;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  launchTimeoutMs?: number;
  launchPollIntervalMs?: number;
  activityGate?: WorkbenchActivityGate;
  captureRestoreTimeoutMs?: number;
  activityGateTiming?: WorkbenchActivityGateTiming;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function observerBinding(snapshot: WorkbenchObserverSnapshot): CaptureActivityBinding {
  return {
    generation: snapshot.generation,
    targetKey: snapshot.target.comparisonKey,
    process: {
      pid: snapshot.process.pid,
      executablePath: snapshot.process.executablePath,
      creationTime: snapshot.process.creationTime,
    },
  };
}

function stateExpected(state: WorkbenchLifecycleStateV3): ExpectedStateVersion {
  return { generation: state.generation, leaseId: state.mcpOwner?.leaseId ?? null };
}

function stateDraft(
  state: WorkbenchLifecycleStateV3,
  overrides: Partial<LifecycleStateDraft>
): LifecycleStateDraft {
  return {
    phase: overrides.phase ?? state.phase,
    endpoint: overrides.endpoint ?? state.endpoint,
    target: overrides.target === undefined ? state.target : overrides.target,
    mcpOwner: overrides.mcpOwner === undefined ? state.mcpOwner : overrides.mcpOwner,
    workbench: overrides.workbench === undefined ? state.workbench : overrides.workbench,
    companion: overrides.companion === undefined ? state.companion : overrides.companion,
    operation: overrides.operation === undefined ? state.operation : overrides.operation,
  };
}

function sameLifecycleOwner(
  left: WorkbenchLifecycleStateV3["mcpOwner"],
  right: WorkbenchLifecycleStateV3["mcpOwner"]
): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid &&
    pathKey(left.executablePath) === pathKey(right.executablePath) &&
    left.creationTime === right.creationTime &&
    left.userSid === right.userSid &&
    left.instanceId === right.instanceId &&
    left.leaseId === right.leaseId;
}

function sameWorkbenchIdentity(
  left: WorkbenchIdentity | null,
  right: WorkbenchIdentity | null
): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid &&
    pathKey(left.executablePath) === pathKey(right.executablePath) &&
    left.creationTime === right.creationTime &&
    left.ownerTokenArgument === right.ownerTokenArgument &&
    left.launchedAtMs === right.launchedAtMs;
}

function companionLifecycleState(
  companion: WorkbenchCompanionLaunch
): WorkbenchCompanionLifecycleState {
  return {
    addonId: companion.addonId,
    addonGuid: companion.addonGuid,
    addonDirectory: companion.addonDirectory,
    addonSearchRoot: companion.addonSearchRoot,
    bundleDigest: companion.bundleDigest,
    buildIdentity: companion.buildIdentity,
    profilePath: companion.workbenchProfilePath,
  };
}

export class WorkbenchClient {
  private activeLifecycle: ActiveLifecycleOperation | null = null;
  private ownedChild: OwnedChildObservation | null = null;
  private readonly childSupervisor = new ChildSupervisor();
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };
  private readonly spawnProcess: WorkbenchClientDependencies["spawnProcess"];
  private readonly companionProvider: WorkbenchCompanionProvider | undefined;
  private readonly launchTimeoutMs: number;
  private readonly launchPollIntervalMs: number;
  private readonly activityGate: WorkbenchActivityGate;
  private companionAttestationKey: string | null = null;

  get state(): Readonly<WorkbenchState> {
    return this._state;
  }

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly config?: Config,
    private readonly clientId: string = DEFAULT_CLIENT_ID,
    private readonly processGuard: WorkbenchProcessGuard = new WorkbenchProcessGuard(),
    dependencies: WorkbenchClientDependencies = {}
  ) {
    this.companionProvider = dependencies.companionProvider ?? (config
      ? new WorkbenchHelperStager({
          managedRoot: config.observer?.managedRoot ?? defaultWorkbenchHelperManagedRoot(),
        })
      : undefined);
    this.spawnProcess = dependencies.spawnProcess ?? ((command, args, options) =>
      spawn(command, args, options));
    this.launchTimeoutMs = dependencies.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
    this.launchPollIntervalMs = dependencies.launchPollIntervalMs ?? LAUNCH_POLL_INTERVAL_MS;
    this.activityGate = dependencies.activityGate ?? new WorkbenchActivityGate({
      restoreTimeoutMs: dependencies.captureRestoreTimeoutMs,
      timing: dependencies.activityGateTiming,
    });
  }

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    const invoke = (): Promise<T> => this.config
      ? this.callManagedAndCache<T>(apiFunc, params, options)
      : this.callAndCache<T>(apiFunc, params, options);
    try {
      return await invoke();
    } catch (error) {
      if (error instanceof WorkbenchError) {
        if (["CONNECTION_REFUSED", "TIMEOUT", "PROTOCOL_ERROR"].includes(error.code)) {
          this.resetConnectionState();
        }
        if (!options.skipAutoLaunch && this.config && error.code === "CONNECTION_REFUSED") {
          logger.info("Workbench is unavailable; requesting target-aware auto-launch.");
          await this.ensureRunning();
          return invoke();
        }
        if (!options.skipAutoLaunch && this.config && error.code === "API_ERROR" &&
            (error.message.includes("Undefined API func") ||
              error.message.includes("not existing Net API function"))) {
          logger.info("Owned Workbench handlers are unavailable; requesting a clean lifecycle restart.");
          await this.restartOwnedWorkbench();
          return invoke();
        }
      }
      throw error;
    }
  }

  async refreshState(): Promise<WorkbenchState> {
    try {
      await this.call<Record<string, unknown>>("EMCP_WB_GetState");
    } catch {
      this.resetConnectionState();
    }
    return { ...this._state };
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.rawCall<Record<string, unknown>>(
        "EMCP_WB_Ping",
        {},
        { timeout: 3000, skipAutoLaunch: true }
      );
      return response.status === "ok" &&
        response.helperAddonId === WORKBENCH_HELPER_ADDON_ID &&
        response.helperAddonGuid === WORKBENCH_HELPER_ADDON_GUID &&
        response.helperAddonVersion === WORKBENCH_HELPER_ADDON_VERSION &&
        response.helperProtocolVersion === WORKBENCH_HELPER_PROTOCOL_VERSION &&
        response.helperBuildIdentity === WORKBENCH_HELPER_BUILD_IDENTITY;
    } catch {
      return false;
    }
  }

  /**
   * Verify and snapshot an already-running exact Workbench owned by this MCP.
   * This path never launches, adopts, restarts, or mutates lifecycle state.
   */
  async getRunningObserverSnapshot(): Promise<WorkbenchObserverSnapshot> {
    try {
      const authority = await this.processGuard.withLifecycleLock((session) =>
        this.readManagedRunningAuthority(session, "observer capture", false));
      const snapshot = await this.validateManagedAuthority(authority, "observer capture");
      await this.processGuard.withLifecycleLock(async (session) => {
        const current = await this.readManagedRunningAuthority(session, "observer capture", false);
        if (!this.sameManagedAuthority(authority, current)) {
          throw new WorkbenchError(
            "RECOVERY_REQUIRED: Workbench changed during observer snapshot qualification.",
            "RECOVERY_REQUIRED"
          );
        }
      });
      return snapshot;
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  acquireCaptureActivity(snapshot: WorkbenchObserverSnapshot): WorkbenchCaptureActivityLease {
    try {
      return this.activityGate.acquireCapture(observerBinding(snapshot));
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async revalidateCaptureActivity(
    lease: WorkbenchCaptureActivityLease
  ): Promise<WorkbenchObserverSnapshot> {
    try {
      // Fail without acquiring the machine mutex if exit handling already
      // invalidated this lease.
      this.activityGate.revalidateCapture(lease, lease.binding);
      const current = await this.getRunningObserverSnapshot();
      this.activityGate.revalidateCapture(lease, observerBinding(current));
      return current;
    } catch (error) {
      try {
        this.activityGate.invalidateCapture(
          lease,
          `Workbench capture ${lease.id} failed lifecycle identity revalidation.`
        );
      } catch {
        // Preserve the authoritative validation error.
      }
      throw this.mapLifecycleError(error);
    }
  }

  releaseCaptureActivity(lease: WorkbenchCaptureActivityLease): void {
    try {
      this.activityGate.releaseCapture(lease);
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  /** Count-only lifecycle evidence; no PID, owner token, or process handle is exposed. */
  diagnosticSupervisedChildCounts(): SupervisedChildCounts {
    return this.childSupervisor.counts();
  }

  async ensureRunning(gprojPath?: string): Promise<WorkbenchLaunchResult> {
    this.requireConfig("auto-launch");
    const project = await this.resolveLifecycleProject(gprojPath);
    try {
      return await this.activityGate.runLifecycle("launch", () =>
        this.coordinateLifecycle("launch", project.comparisonKey, async (operationId) =>
          this.ensureRunningCoordinated(revalidateProjectIdentity(project), operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async restartOwnedWorkbench(): Promise<WorkbenchRestartResult> {
    this.requireConfig("restart");
    const project = await this.resolveLifecycleProject();
    try {
      return await this.activityGate.runLifecycle("restart", () =>
        this.coordinateLifecycle("restart", project.comparisonKey, async (operationId) =>
          this.restartCoordinated(revalidateProjectIdentity(project), operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async shutdownOwnedWorkbench(): Promise<WorkbenchShutdownResult> {
    this.requireConfig("shutdown");
    try {
      const read = await this.processGuard.readLifecycleState();
      const targetKey = read.kind === "valid" ? read.state.target?.comparisonKey ?? null : null;
      return await this.activityGate.runLifecycle("shutdown", () =>
        this.coordinateLifecycle("shutdown", targetKey, async (operationId) =>
          this.shutdownCoordinated(operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async diagnose(): Promise<DiagnosticReport> {
    const workbenchExePath = this.config
      ? this.findWorkbenchExe() ?? join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE)
      : null;
    const projectPath = this.config?.projectPath
      ? { path: this.config.projectPath, exists: existsSync(this.config.projectPath) }
      : null;
    let companionAddon: DiagnosticReport["companionAddon"] = null;
    try {
      const verified = verifyWorkbenchHelperSource(defaultWorkbenchHelperSource());
      companionAddon = {
        addonId: verified.manifest.addonId,
        addonGuid: verified.manifest.addonGuid,
        path: verified.sourceDirectory,
        buildIdentity: verified.manifest.buildIdentity,
        bundleDigest: verified.manifest.bundleDigest,
      };
    } catch {
      // Diagnostics are read-only and best-effort; launch reports the exact stage error.
    }
    let netApi: DiagnosticReport["netApi"] = "refused";
    let netApiError: string | undefined;
    try {
      const response = await this.rawCall<Record<string, unknown>>(
        "EMCP_WB_Ping",
        {},
        { timeout: 3000, skipAutoLaunch: true }
      );
      if (response.status === "ok" &&
          response.helperAddonId === WORKBENCH_HELPER_ADDON_ID &&
          response.helperAddonGuid === WORKBENCH_HELPER_ADDON_GUID &&
          response.helperAddonVersion === WORKBENCH_HELPER_ADDON_VERSION &&
          response.helperProtocolVersion === WORKBENCH_HELPER_PROTOCOL_VERSION &&
          response.helperBuildIdentity === WORKBENCH_HELPER_BUILD_IDENTITY) {
        netApi = "up_with_companion";
      } else {
        netApi = "up_no_companion";
        netApiError = "NET API responded without the exact managed Workbench companion identity.";
      }
    } catch (error) {
      if (error instanceof WorkbenchError) {
        netApiError = error.message;
        if (error.code === "CONNECTION_REFUSED") netApi = "refused";
        else if (error.code === "TIMEOUT") netApi = "timeout";
        else if (error.code === "API_ERROR" &&
          (error.message.includes("not existing Net API function") || error.message.includes("Undefined API func"))) {
          netApi = "up_no_companion";
        } else netApi = "error";
      } else {
        netApi = "error";
        netApiError = String(error);
      }
    }

    return {
      host: this.host,
      port: this.port,
      workbenchExe: workbenchExePath
        ? { path: workbenchExePath, exists: existsSync(workbenchExePath) }
        : null,
      projectPath,
      defaultMod: this.config?.defaultMod ?? null,
      companionAddon,
      netApi,
      netApiError,
      lifecycle: await this.lifecycleDiagnostic(),
    };
  }

  toString(): string {
    return `WorkbenchClient(${this.host}:${this.port})`;
  }

  private requireConfig(action: string): Config {
    if (!this.config) {
      throw new WorkbenchError(`No config provided — cannot ${action} Workbench.`, "LAUNCH_FAILED");
    }
    return this.config;
  }

  private async callAndCache<T>(
    apiFunc: string,
    params: Record<string, unknown>,
    options: WorkbenchCallOptions
  ): Promise<T> {
    const result = await this.rawCall<T>(apiFunc, params, options);
    this._state.connected = true;
    this._state.lastUpdated = Date.now();
    this.extractMode(result);
    return result;
  }

  managedCompanionStatus(): WorkbenchCompanionManagedStatus {
    if (!this.companionProvider?.status) {
      throw new WorkbenchError(
        "Workbench companion provider does not expose managed status.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return this.companionProvider.status();
  }

  async ensureManagedCompanion(targetProjectPath?: string): Promise<Record<string, unknown>> {
    if (!this.companionProvider?.verifyStaged || !this.companionProvider.status) {
      throw new WorkbenchError(
        "Workbench companion provider does not expose managed staging and attestation.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    try {
      return await this.activityGate.runManaged("companion setup", async () => {
        const initial = await this.processGuard.withLifecycleLock(async (session) => {
          const read = await session.readState();
          if (read.kind === "valid" && read.state.phase === "running") {
            return {
              kind: "running" as const,
              authority: await this.readManagedRunningAuthority(
                session,
                "Workbench companion setup",
                false
              ),
            };
          }
          if (read.kind === "valid" && read.state.phase !== "vacant") {
            throw new WorkbenchError(
              `Workbench companion setup requires a vacant or healthy running lifecycle; current phase is ${read.state.phase}.`,
              "LIFECYCLE_BUSY"
            );
          }
          await session.assertNoWorkbenchProcesses();
          return { kind: "vacant" as const, read };
        });

        if (initial.kind === "running") {
          const snapshot = await this.validateManagedAuthority(
            initial.authority,
            "Workbench companion setup"
          );
          await this.processGuard.withLifecycleLock(async (session) => {
            const current = await this.readManagedRunningAuthority(
              session,
              "Workbench companion setup",
              false
            );
            if (!this.sameManagedAuthority(initial.authority, current)) {
              throw new WorkbenchError(
                "RECOVERY_REQUIRED: Workbench changed while companion setup was unlocked.",
                "RECOVERY_REQUIRED"
              );
            }
          });
          return {
            action: "verified_running",
            generation: snapshot.generation,
            companion: snapshot.companion,
            status: this.companionProvider!.status!(),
          };
        }

        // Copying, hashing, retention, and status inventory can be expensive.
        // Keep them outside the machine mutex, then prove the lifecycle stayed
        // at the same vacant generation before publishing their result.
        const staged = this.companionProvider!.ensureStaged(targetProjectPath);
        const attested = this.companionProvider!.verifyStaged!(staged, targetProjectPath);
        const retention = this.companionProvider!.applyRetention?.({
          protectedDigests: [attested.bundleDigest],
        }) ?? null;
        const status = this.companionProvider!.status!();
        await this.processGuard.withLifecycleLock((session) =>
          this.assertSameVacantCompanionAuthority(
            session,
            initial.read,
            "Workbench companion setup"
          ));
        return {
          action: staged.reused ? "verified" : "staged",
          companion: {
            addonId: attested.addonId,
            addonGuid: attested.addonGuid,
            addonVersion: attested.addonVersion,
            protocolVersion: attested.protocolVersion,
            buildIdentity: attested.buildIdentity,
            bundleDigest: attested.bundleDigest,
            addonDirectory: attested.addonDirectory,
            profilePath: attested.workbenchProfilePath,
          },
          retention,
          status,
        };
      });
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  doctorManagedCompanion(): Record<string, unknown> {
    const status = this.managedCompanionStatus();
    if (!status.installed || !status.stagedDigests.includes(status.currentBundleDigest)) {
      return {
        healthy: false,
        status,
        detail: "The current packaged Workbench companion digest is not staged.",
      };
    }
    const roleRoot = status.roleRoot;
    const searchRoot = join(roleRoot, "addons", status.currentBundleDigest);
    const candidate: WorkbenchCompanionLaunch = {
      addonId: WORKBENCH_HELPER_ADDON_ID,
      addonGuid: WORKBENCH_HELPER_ADDON_GUID,
      addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
      protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
      buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
      bundleDigest: status.currentBundleDigest,
      addonDirectory: join(searchRoot, WORKBENCH_HELPER_ADDON_ID),
      addonSearchRoot: searchRoot,
      workbenchProfilePath: join(roleRoot, "profile"),
      reused: true,
    };
    if (!this.companionProvider?.verifyStaged) {
      throw new WorkbenchError(
        "Workbench companion provider cannot attest staged payload hashes.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    this.companionProvider.verifyStaged(candidate);
    return { healthy: status.warnings.length === 0, status };
  }

  async applyManagedCompanionRetention(): Promise<WorkbenchCompanionRetentionResult> {
    if (!this.companionProvider?.applyRetention) {
      throw new WorkbenchError(
        "Workbench companion provider does not expose managed retention.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    try {
      return await this.activityGate.runManaged("companion retention", async () => {
        const read = await this.processGuard.withLifecycleLock(async (session) => {
          await session.assertNoWorkbenchProcesses();
          const current = await session.readState();
          if (current.kind === "valid" && current.state.phase !== "vacant") {
            throw new WorkbenchError(
              `Workbench companion retention requires a vacant lifecycle; current phase is ${current.state.phase}.`,
              "LIFECYCLE_BUSY"
            );
          }
          return current;
        });
        const protectedDigests = read.kind === "valid" && read.state.companion
          ? [read.state.companion.bundleDigest]
          : [];
        const result = this.companionProvider!.applyRetention!({ protectedDigests });
        await this.processGuard.withLifecycleLock((session) =>
          this.assertSameVacantCompanionAuthority(
            session,
            read,
            "Workbench companion retention"
          ));
        return result;
      });
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async uninstallManagedCompanion(): Promise<WorkbenchCompanionUninstallResult> {
    if (!this.companionProvider?.uninstall) {
      throw new WorkbenchError(
        "Workbench companion provider does not expose managed uninstall.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    try {
      return await this.processGuard.withLifecycleLock(async (session) => {
        await session.assertNoWorkbenchProcesses();
        const read = await session.readState();
        if (read.kind === "valid" && read.state.phase !== "vacant") {
          throw new WorkbenchError(
            `Workbench companion uninstall requires a vacant lifecycle; current phase is ${read.state.phase}.`,
            "LIFECYCLE_BUSY"
          );
        }
        const result = this.companionProvider!.uninstall!();
        if (read.kind === "valid" && read.state.phase === "vacant" && read.state.companion) {
          await session.transitionToVacant(stateExpected(read.state), {
            target: read.state.target,
            companion: null,
          });
        }
        return result;
      });
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  private async callManagedAndCache<T>(
    apiFunc: string,
    params: Record<string, unknown>,
    options: WorkbenchCallOptions
  ): Promise<T> {
    try {
      return await this.activityGate.runManaged(`call ${apiFunc}`, async () => {
        const context = `Workbench call ${apiFunc}`;
        const authority = await this.processGuard.withLifecycleLock((session) =>
          this.readManagedRunningAuthority(session, context, true));

        // Network I/O, exact-process probing, target resolution, and immutable
        // companion hashing happen without monopolizing the machine mutex.
        const snapshot = await this.validateManagedAuthority(authority, context);
        // Treat the NET result as provisional until the exact lifecycle CAS
        // below proves that its generation and owner are still authoritative.
        const result = await this.rawCall<T>(apiFunc, params, options);

        // Reacquire only for a bounded read/revalidation. A cross-process
        // generation or owner change makes the local NET result stale.
        await this.processGuard.withLifecycleLock(async (session) => {
          const current = await this.readManagedRunningAuthority(session, context, true);
          if (!this.sameManagedAuthority(authority, current)) {
            throw new WorkbenchError(
              "RECOVERY_REQUIRED: Workbench lifecycle generation or exact owner changed during " +
                `managed call ${apiFunc}; stale state publication was refused.`,
              "RECOVERY_REQUIRED"
            );
          }
        });
        this._state.connected = true;
        this._state.lastUpdated = Date.now();
        this.extractMode(result);
        this.attestRecordedCompanion(snapshot);
        return result;
      });
    } catch (error) {
      if (error instanceof WorkbenchError && error.code === "RECOVERY_REQUIRED") {
        this.resetConnectionState();
      }
      throw this.mapLifecycleError(error);
    }
  }

  private async readManagedRunningAuthority(
    session: WorkbenchLifecycleSession,
    context: string,
    unavailableWhenVacant: boolean
  ): Promise<ManagedRunningAuthority> {
    const read = await session.readState();
    if (read.kind !== "valid") {
      if (unavailableWhenVacant && read.kind === "missing") {
        throw new WorkbenchError(
          `${context} requires an MCP-owned Workbench, but no lifecycle record exists.`,
          "CONNECTION_REFUSED"
        );
      }
      throw new WorkbenchError(
        `${context} requires a valid version-3 Workbench lifecycle record.`,
        "STATE_INVALID"
      );
    }
    const state = read.state;
    if (state.phase === "vacant" && unavailableWhenVacant) {
      throw new WorkbenchError(
        `${context} requires an MCP-owned Workbench, but the lifecycle is vacant.`,
        "CONNECTION_REFUSED"
      );
    }
    if (state.phase !== "running" || state.operation !== null) {
      throw new WorkbenchError(
        `${context} requires an idle running Workbench; lifecycle phase is ${state.phase}.`,
        "LIFECYCLE_BUSY"
      );
    }

    const owner = state.mcpOwner;
    const current = session.mcp;
    if (!owner || owner.instanceId !== current.instanceId || owner.leaseId !== current.leaseId ||
        owner.pid !== current.pid || owner.creationTime !== current.creationTime ||
        pathKey(owner.executablePath) !== pathKey(current.executablePath) ||
        owner.userSid !== current.userSid) {
      throw new WorkbenchError(
        `${context} requires the exact Workbench lifecycle lease owned by this MCP instance.`,
        owner ? "OWNED_BY_OTHER_MCP" : "UNOWNED_WORKBENCH"
      );
    }
    if (!state.target) {
      throw new WorkbenchError(
        `${context} requires a recorded canonical Workbench project target.`,
        "TARGET_REQUIRED"
      );
    }
    if (!state.workbench) {
      throw new WorkbenchError(
        `${context} requires an already-running exact owned Workbench process.`,
        "UNOWNED_WORKBENCH"
      );
    }
    if (!state.companion ||
        state.companion.addonId !== WORKBENCH_HELPER_ADDON_ID ||
        state.companion.addonGuid !== WORKBENCH_HELPER_ADDON_GUID ||
        state.companion.buildIdentity !== WORKBENCH_HELPER_BUILD_IDENTITY ||
        !/^[a-f0-9]{64}$/.test(state.companion.bundleDigest)) {
      throw new WorkbenchError(
        `${context} requires the exact MCP-managed Workbench companion identity.`,
        "IDENTITY_UNVERIFIABLE"
      );
    }

    const configuredHost = this.host.trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (state.endpoint.host !== configuredHost || state.endpoint.port !== this.port) {
      throw new WorkbenchError(
        `Recorded Workbench endpoint ${state.endpoint.host}:${state.endpoint.port} does not ` +
          `match this client endpoint ${configuredHost}:${this.port}.`,
        "ENDPOINT_CONFLICT"
      );
    }

    const snapshot = Object.freeze({
      generation: state.generation,
      companion: Object.freeze({ ...state.companion }),
      target: Object.freeze({
        path: state.target.path,
        comparisonKey: state.target.comparisonKey,
      }),
      endpoint: Object.freeze({ ...state.endpoint }),
      process: Object.freeze({
        pid: state.workbench.pid,
        executablePath: state.workbench.executablePath,
        creationTime: state.workbench.creationTime,
        launchedAtMs: state.workbench.launchedAtMs,
      }),
    }) satisfies WorkbenchObserverSnapshot;
    return { state, snapshot };
  }

  private async validateManagedAuthority(
    authority: ManagedRunningAuthority,
    context: string
  ): Promise<WorkbenchObserverSnapshot> {
    const canonicalTarget = canonicalizeGproj(authority.snapshot.target.path);
    if (canonicalTarget.comparisonKey !== authority.snapshot.target.comparisonKey) {
      throw new WorkbenchError(
        `Recorded Workbench target ${authority.snapshot.target.path} changed canonical identity.`,
        "TARGET_CHANGED"
      );
    }
    const snapshot = Object.freeze({
      ...authority.snapshot,
      target: Object.freeze({
        path: canonicalTarget.displayPath,
        comparisonKey: canonicalTarget.comparisonKey,
      }),
    }) satisfies WorkbenchObserverSnapshot;
    this.attestRecordedCompanion(snapshot);
    if (await this.inspectRecordedWorkbench(authority.state) !== "live") {
      throw new WorkbenchError(
        `Recorded exact owned Workbench exited before ${context}.`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    await this.assertEndpointOwnedByRecordedWorkbench(
      this.processGuard,
      authority.state.workbench!,
      context
    );
    if (!(await this.ping())) {
      throw new WorkbenchError(
        "The recorded Workbench endpoint did not prove the expected companion add-on identity.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    this.attestRecordedCompanion(snapshot);
    return snapshot;
  }

  private sameManagedAuthority(
    expected: ManagedRunningAuthority,
    current: ManagedRunningAuthority
  ): boolean {
    return expected.state.generation === current.state.generation &&
      sameLifecycleOwner(expected.state.mcpOwner, current.state.mcpOwner) &&
      sameWorkbenchIdentity(expected.state.workbench, current.state.workbench) &&
      expected.snapshot.target.path === current.snapshot.target.path &&
      expected.snapshot.target.comparisonKey === current.snapshot.target.comparisonKey &&
      expected.snapshot.endpoint.host === current.snapshot.endpoint.host &&
      expected.snapshot.endpoint.port === current.snapshot.endpoint.port &&
      expected.snapshot.companion.bundleDigest === current.snapshot.companion.bundleDigest &&
      expected.snapshot.companion.buildIdentity === current.snapshot.companion.buildIdentity &&
      pathKey(expected.snapshot.companion.addonDirectory) ===
        pathKey(current.snapshot.companion.addonDirectory) &&
      pathKey(expected.snapshot.companion.addonSearchRoot) ===
        pathKey(current.snapshot.companion.addonSearchRoot) &&
      pathKey(expected.snapshot.companion.profilePath) ===
        pathKey(current.snapshot.companion.profilePath);
  }

  private sameLifecycleRead(
    expected: LifecycleStateRead,
    current: LifecycleStateRead
  ): boolean {
    if (expected.kind !== current.kind) return false;
    if (expected.kind === "missing" && current.kind === "missing") return true;
    if (expected.kind === "malformed" && current.kind === "malformed") {
      return expected.path === current.path && expected.rawSha256 === current.rawSha256;
    }
    return expected.kind === "valid" && current.kind === "valid" &&
      expected.state.phase === "vacant" && current.state.phase === "vacant" &&
      expected.state.generation === current.state.generation;
  }

  private async assertSameVacantCompanionAuthority(
    session: WorkbenchLifecycleSession,
    expected: LifecycleStateRead,
    context: string
  ): Promise<void> {
    // A process can appear before its lifecycle publication, so a generation
    // comparison alone is insufficient for the final fail-closed check.
    await session.assertNoWorkbenchProcesses();
    const current = await session.readState();
    if (!this.sameLifecycleRead(expected, current)) {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: Workbench lifecycle changed while ${context.toLowerCase()} was unlocked.`,
        "RECOVERY_REQUIRED"
      );
    }
  }

  private attestRecordedCompanion(snapshot: WorkbenchObserverSnapshot): void {
    const verify = this.companionProvider?.verifyStaged;
    if (!verify) {
      throw new WorkbenchError(
        "Managed Workbench calls require a companion provider that can re-attest staged payload hashes.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    const attestationKey = JSON.stringify([
      snapshot.generation,
      snapshot.companion.bundleDigest,
      snapshot.companion.buildIdentity,
      pathKey(snapshot.companion.addonDirectory),
      pathKey(snapshot.companion.addonSearchRoot),
      pathKey(snapshot.companion.profilePath),
      snapshot.target.comparisonKey,
    ]);
    if (this.companionAttestationKey === attestationKey) return;
    const candidate: WorkbenchCompanionLaunch = {
      addonId: WORKBENCH_HELPER_ADDON_ID,
      addonGuid: WORKBENCH_HELPER_ADDON_GUID,
      addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
      protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
      buildIdentity: snapshot.companion.buildIdentity as typeof WORKBENCH_HELPER_BUILD_IDENTITY,
      bundleDigest: snapshot.companion.bundleDigest,
      addonDirectory: snapshot.companion.addonDirectory,
      addonSearchRoot: snapshot.companion.addonSearchRoot,
      workbenchProfilePath: snapshot.companion.profilePath,
      reused: true,
    };
    try {
      const attested = verify.call(this.companionProvider, candidate, snapshot.target.path);
      if (attested.bundleDigest !== candidate.bundleDigest ||
          pathKey(attested.addonDirectory) !== pathKey(candidate.addonDirectory) ||
          pathKey(attested.addonSearchRoot) !== pathKey(candidate.addonSearchRoot) ||
          pathKey(attested.workbenchProfilePath) !== pathKey(candidate.workbenchProfilePath)) {
        throw new Error("attested descriptor changed recorded companion identity");
      }
      this.companionAttestationKey = attestationKey;
    } catch (error) {
      throw new WorkbenchError(
        `Managed Workbench companion attestation failed: ${error instanceof Error ? error.message : String(error)}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
  }

  private resetConnectionState(): void {
    this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
  }

  private extractMode(result: unknown): void {
    if (!result || typeof result !== "object" || !("mode" in result)) return;
    const mode = (result as Record<string, unknown>).mode;
    if (mode === "edit") this._state.mode = "edit";
    else if (mode === "play" || mode === "game") this._state.mode = "play";
    else this._state.mode = "unknown";
  }

  private coordinateLifecycle<T>(
    kind: LifecycleOperationKind,
    targetKey: string | null,
    action: (operationId: string) => Promise<T>
  ): Promise<T> {
    const current = this.activeLifecycle;
    if (current) {
      const sameTarget = current.targetKey === targetKey;
      if (sameTarget && ((kind === "launch" && current.kind === "launch") ||
          (kind === "restart" && current.kind === "restart"))) {
        return current.promise as Promise<T>;
      }
      if (targetKey && current.targetKey && targetKey !== current.targetKey) {
        return Promise.reject(new WorkbenchError(
          `TARGET_CONFLICT: lifecycle ${current.kind} ${current.operationId} is operating on ` +
            `${current.targetKey}; requested target is ${targetKey}.`,
          "TARGET_CONFLICT"
        ));
      }
      return current.promise
        .catch(() => undefined)
        .then(() => this.coordinateLifecycle(kind, targetKey, action));
    }

    const operationId = randomUUID();
    let promise: Promise<T>;
    promise = Promise.resolve()
      .then(() => action(operationId))
      .finally(() => {
        if (this.activeLifecycle?.promise === promise) this.activeLifecycle = null;
      });
    this.activeLifecycle = { kind, operationId, targetKey, promise };
    return promise;
  }

  private async resolveLifecycleProject(gprojPath?: string): Promise<CanonicalProjectIdentity> {
    const read = await this.processGuard.readLifecycleState();
    const priorTarget = read.kind === "valid" ? read.state.target?.path ?? null : null;
    try {
      return resolveProjectIdentity({
        gprojPath,
        priorTarget,
        projectRoot: this.config?.projectPath,
        defaultMod: this.config?.defaultMod,
      });
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  private lifecycleTarget(project: CanonicalProjectIdentity): {
    path: string;
    comparisonKey: string;
  } {
    return { path: project.displayPath, comparisonKey: project.comparisonKey };
  }

  private async claimState(
    session: WorkbenchLifecycleSession,
    project: CanonicalProjectIdentity | null
  ): Promise<WorkbenchLifecycleStateV3> {
    const result = await session.validateAndClaim({
      endpoint: { host: this.host.trim().toLowerCase(), port: this.port },
      target: project ? this.lifecycleTarget(project) : null,
    });
    if (result.kind === "claimed" || result.kind === "owned_by_current_mcp") return result.state;
    throw this.claimRefusal(result);
  }

  private claimRefusal(result: Extract<LifecycleClaimResult, { kind: "refused" }>): WorkbenchError {
    const code = result.code === "STATE_INVALID" ? "STATE_INVALID" : result.code;
    return new WorkbenchError(`${code}: ${result.message}`, code);
  }

  private async inspectRecordedWorkbench(
    state: WorkbenchLifecycleStateV3
  ): Promise<"live" | "absent"> {
    const processes = await this.processGuard.listWorkbenchProcesses();
    const expected = state.workbench;
    if (!expected) {
      if (processes.length === 0) return "absent";
      throw new WorkbenchError(
        `UNOWNED_WORKBENCH: Workbench PID(s) ${processes.map((entry) => entry.pid).join(", ")} ` +
          "are running without an exact lifecycle identity.",
        "UNOWNED_WORKBENCH"
      );
    }
    const matches = processes.filter((entry) => entry.pid === expected.pid &&
      pathKey(entry.executablePath) === pathKey(expected.executablePath) &&
      entry.creationTime === expected.creationTime);
    if (matches.length === 1 && processes.length === 1) {
      try {
        return await this.processGuard.inspectOwnedWorkbench(expected);
      } catch (error) {
        throw this.mapLifecycleError(error);
      }
    }
    if (processes.length === 0) return "absent";
    throw new WorkbenchError(
      `IDENTITY_UNVERIFIABLE: recorded Workbench PID ${expected.pid} no longer matches the exact ` +
        "machine-wide process identity; no process was signalled.",
      "IDENTITY_UNVERIFIABLE"
    );
  }

  private async assertNoWorkbenchProcesses(
    probe: Pick<WorkbenchLifecycleSession, "assertNoWorkbenchProcesses">,
    action: string
  ): Promise<void> {
    try {
      await probe.assertNoWorkbenchProcesses();
    } catch (error) {
      const mapped = this.mapLifecycleError(error);
      throw new WorkbenchError(
        `${action} refused: ${mapped.message}`,
        mapped.code
      );
    }
  }

  private async assertEndpointOwnedByRecordedWorkbench(
    probe: Pick<WorkbenchLifecycleSession, "verifyEndpointOwner">,
    expected: WorkbenchIdentity,
    context: string
  ): Promise<void> {
    let result;
    try {
      result = await probe.verifyEndpointOwner(
        { host: this.host, port: this.port },
        expected
      );
    } catch (error) {
      const mapped = this.mapLifecycleError(error);
      throw new WorkbenchError(
        `IDENTITY_UNVERIFIABLE: ${context} could not prove that NET API endpoint ` +
          `${this.host}:${this.port} belongs to exact Workbench PID ${expected.pid}: ${mapped.message}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    if (result.kind === "refused") {
      throw new WorkbenchError(
        `IDENTITY_UNVERIFIABLE: ${context} refused NET API endpoint ${this.host}:${this.port} ` +
          `for exact Workbench PID ${expected.pid} (${result.reason}): ${result.message}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
  }

  private async reconcileAbsentState(
    session: WorkbenchLifecycleSession,
    state: WorkbenchLifecycleStateV3,
    target: StoredLifecycleTarget | null
  ): Promise<WorkbenchLifecycleStateV3> {
    this.resetConnectionState();
    return session.transitionToVacant(stateExpected(state), {
      target: target ?? state.target,
      companion: state.companion,
    });
  }

  private async requireReservedLifecycle(
    session: WorkbenchLifecycleSession,
    expected: WorkbenchLifecycleStateV3
  ): Promise<WorkbenchLifecycleStateV3> {
    const read = await session.readState();
    if (read.kind !== "valid" || read.state.generation !== expected.generation ||
        !sameLifecycleOwner(read.state.mcpOwner, expected.mcpOwner) ||
        !sameWorkbenchIdentity(read.state.workbench, expected.workbench)) {
      throw new WorkbenchError(
        "RECOVERY_REQUIRED: lifecycle generation or exact owner changed while the machine mutex " +
          "was released. The stale mutation was refused and durable recovery evidence was preserved.",
        "RECOVERY_REQUIRED"
      );
    }
    return read.state;
  }

  private transitionReservedLifecycle(
    expected: WorkbenchLifecycleStateV3,
    overrides: Partial<LifecycleStateDraft>
  ): Promise<WorkbenchLifecycleStateV3> {
    return this.processGuard.withLifecycleLock(async (session) => {
      const current = await this.requireReservedLifecycle(session, expected);
      return session.transition(stateExpected(current), stateDraft(current, overrides));
    });
  }

  private vacateReservedLifecycle(
    expected: WorkbenchLifecycleStateV3,
    target: StoredLifecycleTarget | null
  ): Promise<WorkbenchLifecycleStateV3> {
    return this.processGuard.withLifecycleLock(async (session) => {
      const current = await this.requireReservedLifecycle(session, expected);
      return session.transitionToVacant(stateExpected(current), {
        target: target ?? current.target,
        companion: current.companion,
      });
    });
  }

  private async reconcileForEnsure(
    state: WorkbenchLifecycleStateV3,
    project: CanonicalProjectIdentity
  ): Promise<{ state: WorkbenchLifecycleStateV3; live: boolean }> {
    const status = await this.inspectRecordedWorkbench(state);
    if (status === "absent") {
      await this.assertNoWorkbenchProcesses(this.processGuard, "Lifecycle recovery");
      return {
        state: await this.vacateReservedLifecycle(state, this.lifecycleTarget(project)),
        live: false,
      };
    }
    if (state.phase === "stopping") {
      await this.terminateExact(state.workbench!);
      await this.waitForPortRelease();
      return {
        state: await this.vacateReservedLifecycle(state, this.lifecycleTarget(project)),
        live: false,
      };
    }
    if (state.phase === "starting" || state.phase === "restarting") {
      if (await this.ping()) {
        if (!state.workbench) {
          throw new WorkbenchError(
            "Lifecycle recovery reached a live endpoint without a recorded exact Workbench identity.",
            "IDENTITY_UNVERIFIABLE"
          );
        }
        await this.assertEndpointOwnedByRecordedWorkbench(
          this.processGuard,
          state.workbench,
          `${state.phase} recovery`
        );
        const running = await this.transitionReservedLifecycle(state, {
          phase: "running",
          operation: null,
        });
        return { state: running, live: true };
      }
      await this.terminateExact(state.workbench!);
      await this.waitForPortRelease();
      return {
        state: await this.vacateReservedLifecycle(state, this.lifecycleTarget(project)),
        live: false,
      };
    }
    return { state, live: true };
  }

  private async ensureRunningCoordinated(
    project: CanonicalProjectIdentity,
    operationId: string
  ): Promise<WorkbenchLaunchResult> {
    let state = await this.processGuard.withLifecycleLock((session) =>
      this.claimState(session, project));
    const reconciled = await this.reconcileForEnsure(state, project);
    state = reconciled.state;
    if (reconciled.live) {
      if (!state.workbench || !state.target || state.target.comparisonKey !== project.comparisonKey) {
        throw new WorkbenchError("Recorded Workbench target does not match the requested project.", "TARGET_CONFLICT");
      }
      const authority = await this.processGuard.withLifecycleLock(async (session) => {
        await this.requireReservedLifecycle(session, state);
        return this.readManagedRunningAuthority(session, "running-session reuse", false);
      });
      await this.validateManagedAuthority(authority, "running-session reuse");
      await this.processGuard.withLifecycleLock(async (session) => {
        const current = await this.readManagedRunningAuthority(
          session,
          "running-session reuse",
          false
        );
        if (!this.sameManagedAuthority(authority, current)) {
          throw new WorkbenchError(
            "RECOVERY_REQUIRED: running Workbench changed while reuse qualification was unlocked.",
            "RECOVERY_REQUIRED"
          );
        }
      });
      return {
        action: "reused",
        pid: state.workbench.pid,
        gprojPath: project.displayPath,
        generation: state.generation,
      };
    }

    const preflight = this.preflightLaunch(project);
    this.companionProvider?.applyRetention?.({
      protectedDigests: [preflight.companion.bundleDigest],
    });
    state = await this.processGuard.withLifecycleLock(async (session) => {
      const current = await this.requireReservedLifecycle(session, state);
      await this.assertNoWorkbenchProcesses(session, "Launch");
      const vacancy = await session.verifyEndpointVacant({ host: this.host, port: this.port });
      if (vacancy.kind === "occupied") {
        throw new WorkbenchError(
          `UNOWNED_WORKBENCH: NET API endpoint ${this.host}:${this.port} is occupied without the exact ` +
            `recorded Workbench identity (listener PID ${vacancy.listenerPid}).`,
          "UNOWNED_WORKBENCH"
        );
      }
      if (vacancy.kind === "unverifiable") {
        throw new WorkbenchError(
          `IDENTITY_UNVERIFIABLE: NET API endpoint ${this.host}:${this.port} vacancy could not be ` +
            `proved (${vacancy.reason}): ${vacancy.message}`,
          "IDENTITY_UNVERIFIABLE"
        );
      }
      return session.transition(stateExpected(current), stateDraft(current, {
        phase: "starting",
        target: this.lifecycleTarget(preflight.project),
        workbench: null,
        companion: companionLifecycleState(preflight.companion),
        operation: { kind: "launch", operationId },
      }));
    });
    const started = await this.startReserved(state, preflight, "launch");
    return {
      action: "launched",
      pid: started.workbench!.pid,
      gprojPath: project.displayPath,
      generation: started.generation,
    };
  }

  private async restartCoordinated(
    project: CanonicalProjectIdentity,
    operationId: string
  ): Promise<WorkbenchRestartResult> {
    let state = await this.processGuard.withLifecycleLock((session) =>
      this.claimState(session, project));
    const reconciled = await this.reconcileForEnsure(state, project);
    state = reconciled.state;
    if (!reconciled.live || !state.workbench) {
      throw new WorkbenchError("Restart refused: no exact owned Workbench is running.", "LAUNCH_FAILED");
    }

    // Complete replacement preflight before changing state or stopping a healthy process.
    const preflight = this.preflightLaunch(revalidateProjectIdentity(project));
    const previous = state.workbench;
    const priorPhase = state.phase;
    state = await this.transitionReservedLifecycle(state, {
      phase: "restarting",
      operation: { kind: "restart", operationId },
    });
    try {
      await this.terminateExact(previous);
    } catch (error) {
      if (error instanceof ProvenPreSignalTerminationRefusal) {
        try {
          const rolledBack = await this.transitionReservedLifecycle(state, {
            phase: priorPhase,
            operation: null,
          });
          if (this.ownedChild && sameWorkbenchIdentity(this.ownedChild.identity, previous)) {
            this.ownedChild.generation = rolledBack.generation;
          }
        } catch (rollbackError) {
          throw new WorkbenchError(
            `RECOVERY_REQUIRED: exact termination was refused before signalling, but the restart ` +
              `reservation changed before rollback (${rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)}).`,
            "RECOVERY_REQUIRED"
          );
        }
      }
      throw error;
    }
    this.resetConnectionState();
    await this.waitForPortRelease();
    state = await this.transitionReservedLifecycle(state, {
      phase: "restarting",
      workbench: null,
      companion: companionLifecycleState(preflight.companion),
    });
    const restarted = await this.startReserved(
      state,
      preflight,
      "restart"
    );
    return {
      previousPid: previous.pid,
      pid: restarted.workbench!.pid,
      gprojPath: project.displayPath,
      generation: restarted.generation,
    };
  }

  private async shutdownCoordinated(
    operationId: string
  ): Promise<WorkbenchShutdownResult> {
    // Shutdown is identity-driven. Preserve the durable target spelling/key but
    // do not touch the .gproj: it may have been deleted or disconnected while
    // the exact recorded Workbench is still safely terminable.
    let state = await this.processGuard.withLifecycleLock((session) =>
      this.claimState(session, null));
    const target = state.target;
    const status = await this.inspectRecordedWorkbench(state);
    if (status === "absent") {
      await this.assertNoWorkbenchProcesses(this.processGuard, "Shutdown");
      state = await this.vacateReservedLifecycle(state, target);
      return {
        stopped: false,
        previousPid: null,
        gprojPath: state.target?.path ?? null,
        generation: state.generation,
      };
    }
    const expected = state.workbench!;
    state = await this.transitionReservedLifecycle(state, {
      phase: "stopping",
      operation: { kind: "shutdown", operationId },
    });
    try {
      await this.terminateExact(expected);
    } catch (error) {
      if (error instanceof ProvenPreSignalTerminationRefusal) {
        try {
          const rolledBack = await this.transitionReservedLifecycle(state, {
            phase: "running",
            operation: null,
          });
          if (this.ownedChild && sameWorkbenchIdentity(this.ownedChild.identity, expected)) {
            this.ownedChild.generation = rolledBack.generation;
          }
        } catch (rollbackError) {
          throw new WorkbenchError(
            `RECOVERY_REQUIRED: exact termination was refused before signalling, but the shutdown ` +
              `reservation changed before rollback (${rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)}).`,
            "RECOVERY_REQUIRED"
          );
        }
      }
      throw error;
    }
    await this.waitForPortRelease();
    this.resetConnectionState();
    const observedChild = this.ownedChild;
    if (observedChild && observedChild.identity.pid === expected.pid &&
        observedChild.identity.creationTime === expected.creationTime) {
      this.childSupervisor.forget("owned-workbench", observedChild.child);
      this.ownedChild = null;
    }
    const vacant = await this.vacateReservedLifecycle(state, target);
    this.companionProvider?.applyRetention?.({
      protectedDigests: state.companion ? [state.companion.bundleDigest] : [],
    });
    return {
      stopped: true,
      previousPid: expected.pid,
      gprojPath: target?.path ?? state.target?.path ?? null,
      generation: vacant.generation,
    };
  }

  private preflightLaunch(project: CanonicalProjectIdentity): LaunchPreflight {
    const currentProject = revalidateProjectIdentity(project);
    const executablePath = this.findWorkbenchExe();
    if (!executablePath) {
      const root = this.config?.workbenchPath ?? "(not configured)";
      throw new WorkbenchError(
        `Cannot find ${WORKBENCH_EXE}. Searched:\n` +
          `  - ${join(root, WORKBENCH_SUBDIR, WORKBENCH_EXE)}\n` +
          `  - ${join(root, WORKBENCH_EXE)}`,
        "LAUNCH_FAILED"
      );
    }
    try {
      if (!statSync(executablePath).isFile()) throw new Error("not a regular file");
    } catch (error) {
      throw new WorkbenchError(
        `Workbench executable is not a readable regular file: ${executablePath} ` +
          `(${error instanceof Error ? error.message : String(error)})`,
        "LAUNCH_FAILED"
      );
    }
    if (!this.companionProvider) {
      throw new WorkbenchError(
        "Workbench launch requires an MCP-managed companion add-on provider.",
        "LAUNCH_FAILED"
      );
    }
    let companion: WorkbenchCompanionLaunch;
    try {
      companion = this.companionProvider.ensureStaged(currentProject.displayPath);
      if (!this.companionProvider.verifyStaged) {
        throw new Error("companion provider cannot re-attest staged payload hashes");
      }
      companion = this.companionProvider.verifyStaged(companion, currentProject.displayPath);
    } catch (error) {
      throw new WorkbenchError(
        `Workbench companion add-on could not be staged: ${error instanceof Error ? error.message : String(error)}`,
        "LAUNCH_FAILED"
      );
    }
    for (const configuredRoot of this.config?.workbenchAddonDirs ?? []) {
      const candidate = join(resolve(configuredRoot), companion.addonId);
      if (!existsSync(candidate)) continue;
      let canonicalCandidate: string;
      try {
        canonicalCandidate = realpathSync.native(candidate);
      } catch (error) {
        throw new WorkbenchError(
          `Configured Workbench add-on root contains an unreadable companion candidate: ${candidate} ` +
            `(${error instanceof Error ? error.message : String(error)})`,
          "IDENTITY_UNVERIFIABLE"
        );
      }
      if (pathKey(canonicalCandidate) !== pathKey(companion.addonDirectory)) {
        throw new WorkbenchError(
          `Configured Workbench add-on root contains a second ${companion.addonId} at ` +
            `${canonicalCandidate}; duplicate helper identities are refused.`,
          "IDENTITY_UNVERIFIABLE"
        );
      }
    }
    // Validate every launch argument and the staged companion before a restart stops anything.
    const args = buildWorkbenchLaunchArgs(
      currentProject.displayPath,
      this.config?.workbenchAddonDirs,
      this.config?.workbenchScriptAuthorizeAll === true,
      true,
      undefined,
      companion
    );
    return {
      project: currentProject,
      companion,
      executablePath,
      cwd: this.findGameDir() ?? dirname(executablePath),
      args,
    };
  }

  private async startReserved(
    initialState: WorkbenchLifecycleStateV3,
    preflight: LaunchPreflight,
    operationKind: "launch" | "restart"
  ): Promise<WorkbenchLifecycleStateV3> {
    let state = initialState;

    const ownerToken = this.processGuard.createOwnerToken();
    const ownerArgument = this.processGuard.ownerArgument(ownerToken);
    const args = [...preflight.args, ownerArgument];
    const redactedArgs = args.map((arg) => arg === ownerArgument ? "[owner-token-redacted]" : arg);
    logger.info(
      `Launching Workbench: ${preflight.executablePath} ${redactedArgs.join(" ")} ` +
        `(cwd: ${preflight.cwd})`
    );

    let child: ChildProcess | null = null;
    let identity: WorkbenchIdentity | null = null;
    let childObservation: OwnedChildObservation | null = null;
    let spawnError: Error | null = null;
    try {
      // The reservation is durable before spawn. Reacquire the mutex only to
      // prove the exact generation/owner is still authoritative, then release
      // it before process inspection and readiness polling.
      await this.processGuard.withLifecycleLock((session) =>
        this.requireReservedLifecycle(session, state));
      revalidateProjectIdentity(preflight.project);
      if (!this.companionProvider?.verifyStaged) {
        throw new WorkbenchError(
          "Workbench companion provider cannot re-attest the launched payload.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      this.companionProvider.verifyStaged(preflight.companion, preflight.project.displayPath);
      const launchedAtMs = Date.now();
      child = this.spawnProcess!(preflight.executablePath, args, {
        detached: true,
        stdio: "ignore",
        cwd: preflight.cwd,
        // Workbench is a graphical editor. A hidden Windows process has no
        // native viewport dimensions/projection and therefore cannot support
        // editor observation. Launches happen only through explicit lifecycle
        // operations; capture itself still probes with skipAutoLaunch.
        windowsHide: false,
      });
      child.once("error", (error) => { spawnError = error; });
      if (!child.pid) {
        throw new WorkbenchError(
          "Workbench spawn returned no PID; exact process ownership cannot be established.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      identity = await this.processGuard.inspectSpawnedWorkbench({
        pid: child.pid,
        executablePath: preflight.executablePath,
        ownerTokenArgument: ownerArgument,
        launchedAtMs,
      });
      state = await this.transitionReservedLifecycle(state, {
        workbench: identity,
      });
      childObservation = this.attachOwnedChild(
        child,
        identity,
        state.generation,
        preflight.project.comparisonKey
      );
      child.unref();
      await this.waitForCompanionReady(child, () => spawnError, preflight.companion);
      if (!this.companionProvider?.verifyStaged) {
        throw new WorkbenchError(
          "Workbench companion provider cannot re-attest the launched payload.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      this.companionProvider.verifyStaged(preflight.companion, preflight.project.displayPath);
      if (!identity) {
        throw new WorkbenchError(
          "Workbench companion became ready without an exact recorded process identity.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      await this.assertEndpointOwnedByRecordedWorkbench(
        this.processGuard,
        identity,
        `${operationKind} readiness`
      );
      state = await this.transitionReservedLifecycle(state, {
        phase: "running",
        operation: null,
      });
      if (childObservation) childObservation.generation = state.generation;
    } catch (error) {
      await this.rollbackFailedLaunch(state, identity);
      throw this.mapLifecycleError(error);
    }

    const runningIdentity = identity;
    if (!runningIdentity) {
      throw new WorkbenchError(
        "Workbench reached readiness without an exact process identity.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    this._state.connected = true;
    this._state.lastUpdated = Date.now();
    return state;
  }

  private async rollbackFailedLaunch(
    state: WorkbenchLifecycleStateV3,
    identity: WorkbenchIdentity | null
  ): Promise<void> {
    if (identity) {
      try {
        await this.terminateExact(identity);
      } catch (error) {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: launch failed and exact Workbench shutdown could not be proven: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "The lifecycle record was preserved for exact-owner recovery.",
          "RECOVERY_REQUIRED"
        );
      }
      await this.waitForPortRelease();
    } else {
      const processes = await this.processGuard.listWorkbenchProcesses();
      if (processes.length > 0) {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: launch identity was not established and Workbench PID(s) ` +
            `${processes.map((entry) => entry.pid).join(", ")} are present. ` +
            "The lifecycle record was preserved and no PID-only signal was attempted.",
          "RECOVERY_REQUIRED"
        );
      }
    }
    await this.vacateReservedLifecycle(state, state.target);
    this.resetConnectionState();
  }

  private async waitForCompanionReady(
    child: ChildProcess,
    getSpawnError: () => Error | null,
    expected: WorkbenchCompanionLaunch
  ): Promise<void> {
    const deadline = Date.now() + this.launchTimeoutMs;
    let lastErrorCode: WorkbenchErrorCode | undefined;
    while (Date.now() < deadline) {
      const spawnError = getSpawnError();
      if (spawnError) {
        throw new WorkbenchError(`Workbench failed to start: ${spawnError.message}`, "LAUNCH_FAILED");
      }
      if (child.exitCode !== null) {
        throw new WorkbenchError(
          `Workbench exited before its handler endpoint became ready (exit code ${child.exitCode}).`,
          "LAUNCH_FAILED"
        );
      }
      try {
        const response = await this.rawCall<Record<string, unknown>>(
          "EMCP_WB_Ping",
          {},
          { timeout: 3000, skipAutoLaunch: true }
        );
        const identityMatches = response.status === "ok" &&
          response.helperAddonId === expected.addonId &&
          response.helperAddonGuid === expected.addonGuid &&
          response.helperAddonVersion === expected.addonVersion &&
          response.helperProtocolVersion === expected.protocolVersion &&
          response.helperBuildIdentity === expected.buildIdentity &&
          response.helperAddonId === WORKBENCH_HELPER_ADDON_ID &&
          response.helperAddonGuid === WORKBENCH_HELPER_ADDON_GUID &&
          response.helperAddonVersion === WORKBENCH_HELPER_ADDON_VERSION &&
          response.helperProtocolVersion === WORKBENCH_HELPER_PROTOCOL_VERSION &&
          response.helperBuildIdentity === WORKBENCH_HELPER_BUILD_IDENTITY;
        if (!identityMatches) {
          throw new WorkbenchError(
            "Workbench NET API responded, but the exact MCP companion add-on identity did not match this build.",
            "IDENTITY_UNVERIFIABLE"
          );
        }
        return;
      } catch (error) {
        if (error instanceof WorkbenchError) {
          if (error.code === "IDENTITY_UNVERIFIABLE") throw error;
          lastErrorCode = error.code;
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.launchPollIntervalMs));
    }
    const hint = lastErrorCode === "API_ERROR"
      ? "The NET API opened, but the managed companion did not compile. Inspect Workbench script errors."
      : lastErrorCode === "IDENTITY_UNVERIFIABLE"
        ? "The endpoint loaded a missing, duplicate, or stale helper add-on identity."
        : "The NET API never became ready. Confirm that Workbench NET API is enabled.";
    throw new WorkbenchError(
      `Workbench did not become ready within ${this.launchTimeoutMs / 1000}s. ${hint}`,
      "LAUNCH_FAILED"
    );
  }

  private async terminateExact(
    expected: WorkbenchIdentity
  ): Promise<void> {
    let result;
    try {
      result = await this.processGuard.verifyAndTerminate(
        expected,
        OWNED_PROCESS_EXIT_TIMEOUT_MS
      );
    } catch (error) {
      const mapped = this.mapLifecycleError(error);
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: exact Workbench termination outcome is uncertain: ${mapped.message}. ` +
          "The durable lifecycle remains reserved with its exact process identity.",
        "RECOVERY_REQUIRED"
      );
    }
    if (result.kind === "refused") {
      if (result.reason === "timeout" || result.reason === "helper_failure") {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: exact Workbench termination helper returned ${result.reason}: ` +
            `${result.message}. A native signal may already have been issued; durable exact-owner ` +
            "recovery evidence was preserved.",
          "RECOVERY_REQUIRED"
        );
      }
      throw new ProvenPreSignalTerminationRefusal(
        `IDENTITY_UNVERIFIABLE: exact Workbench termination was refused before signalling ` +
          `(${result.reason}): ${result.message}. No PID-only signal was attempted.`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
  }

  private attachOwnedChild(
    child: ChildProcess,
    identity: WorkbenchIdentity,
    generation: string,
    targetKey: string
  ): OwnedChildObservation {
    const observation: OwnedChildObservation = { child, identity, generation, targetKey };
    this.ownedChild = observation;
    this.childSupervisor.supervise("owned-workbench", child, {
      onExit: async () => {
        // A retry is allowed after the first attempt has cleared the local
        // observation. A newer child under the same key cancels this retry,
        // and the durable generation checks below independently reject it.
        if (this.ownedChild && this.ownedChild !== observation) return;
        if (this.ownedChild === observation) {
          this.activityGate.invalidateForUnexpectedExit({
            generation: observation.generation,
            targetKey: observation.targetKey,
            process: {
              pid: identity.pid,
              executablePath: identity.executablePath,
              creationTime: identity.creationTime,
            },
          });
          this.resetConnectionState();
          this.ownedChild = null;
        }
        await this.activityGate.runLifecycle("recovery", () =>
          this.coordinateLifecycle("recovery", targetKey, async () =>
            this.processGuard.withLifecycleLock(async (session) => {
              const read = await session.readState();
              if (read.kind !== "valid" || read.state.generation !== observation.generation ||
                  !read.state.workbench || read.state.workbench.pid !== identity.pid ||
                  read.state.workbench.creationTime !== identity.creationTime) return;
              await this.assertNoWorkbenchProcesses(session, "Unexpected-exit recovery");
              await this.reconcileAbsentState(session, read.state, read.state.target);
            })
          )
        );
      },
      onCallbackError: (error) => logger.warn(
        `Workbench exit reconciliation failed and will retry: ${error instanceof Error
          ? error.message
          : String(error)}`
      ),
    });
    return observation;
  }

  private findWorkbenchExe(): string | null {
    if (!this.config) return null;
    const candidates = [
      join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE),
      join(this.config.workbenchPath, WORKBENCH_EXE),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  private findGameDir(): string | null {
    const configured = this.config?.gamePath;
    if (configured && existsSync(join(configured, "addons"))) return configured;
    const environment = process.env.ENFUSION_GAME_PATH;
    if (environment && existsSync(join(environment, "addons"))) return environment;
    if (!this.config) return null;
    const candidates = [
      resolve(this.config.workbenchPath, "..", "Arma Reforger"),
      resolve(this.config.workbenchPath, "..", "ArmaReforger"),
      resolve(this.config.workbenchPath, "..", "..", "Arma Reforger"),
      resolve(this.config.workbenchPath, "..", "..", "ArmaReforger"),
    ];
    return candidates.find((candidate) => existsSync(join(candidate, "addons"))) ?? null;
  }

  private async waitForPortRelease(
    probe: Pick<WorkbenchLifecycleSession, "verifyEndpointVacant"> = this.processGuard
  ): Promise<void> {
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const vacancy = await probe.verifyEndpointVacant({ host: this.host, port: this.port });
      if (vacancy.kind === "vacant") return;
      if (vacancy.kind === "unverifiable") {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: NET API endpoint ${this.host}:${this.port} vacancy is unverifiable ` +
            `(${vacancy.reason}): ${vacancy.message}`,
          "RECOVERY_REQUIRED"
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, PORT_RELEASE_POLL_MS));
    }
    throw new WorkbenchError(
      `RECOVERY_REQUIRED: NET API endpoint ${this.host}:${this.port} remained occupied after ` +
        "exact Workbench exit; the durable lifecycle state was preserved for recovery.",
      "RECOVERY_REQUIRED"
    );
  }

  private async lifecycleDiagnostic(): Promise<LifecycleDiagnostic> {
    try {
      const read = await this.processGuard.readLifecycleState();
      if (read.kind === "missing") {
        return {
          state: "missing", version: null, generation: null, phase: null, endpoint: null,
          target: null, lease: "vacant", operation: null, companionBuildIdentity: null,
        };
      }
      if (read.kind === "malformed") {
        return {
          state: "malformed", version: null, generation: null, phase: null, endpoint: null,
          target: null, lease: "unknown", operation: null, companionBuildIdentity: null,
          detail: read.message,
        };
      }
      const state = read.state;
      return {
        state: "valid",
        version: 3,
        generation: state.generation,
        phase: state.phase,
        endpoint: `${state.endpoint.host}:${state.endpoint.port}`,
        target: state.target?.path ?? null,
        lease: !state.mcpOwner ? "vacant" :
          state.mcpOwner.instanceId === this.processGuard.mcpInstanceId ? "current_mcp" : "other_mcp",
        operation: state.operation ? `${state.operation.kind}:${state.operation.operationId}` : null,
        companionBuildIdentity: state.companion?.buildIdentity ?? null,
      };
    } catch (error) {
      return {
        state: "malformed", version: null, generation: null, phase: null, endpoint: null,
        target: null, lease: "unknown", operation: null, companionBuildIdentity: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private mapLifecycleError(error: unknown): WorkbenchError {
    if (error instanceof WorkbenchError) return error;
    if (error instanceof WorkbenchActivityError) {
      return new WorkbenchError(error.message, error.code);
    }
    if (error instanceof ProjectIdentityError) {
      return new WorkbenchError(error.message, error.code);
    }
    if (error instanceof LifecycleGuardError) {
      const code: WorkbenchErrorCode = error.code === "GENERATION_MISMATCH" ||
          error.code === "HELPER_FAILURE"
        ? "STATE_INVALID"
        : error.code;
      return new WorkbenchError(error.message, code);
    }
    return new WorkbenchError(error instanceof Error ? error.message : String(error), "LAUNCH_FAILED");
  }

  private rawCall<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const request = encodeRequest(this.clientId, apiFunc, params);
    return new Promise<T>((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const socket = new Socket();
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new WorkbenchError(
          `Workbench call "${apiFunc}" timed out after ${timeout}ms`,
          "TIMEOUT"
        ));
      }, timeout);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeAllListeners();
      };
      const decode = (): void => {
        const response = Buffer.concat(chunks);
        if (response.length === 0) {
          reject(new WorkbenchError(
            `Empty response from Workbench for "${apiFunc}"`,
            "PROTOCOL_ERROR"
          ));
          return;
        }
        try {
          const result = decodeResponse<T>(response);
          logger.debug(`Workbench response for "${apiFunc}":`, result);
          resolvePromise(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const apiError = message.startsWith("Workbench error:");
          reject(new WorkbenchError(
            apiError ? message : `Failed to decode response for "${apiFunc}": ${message}`,
            apiError ? "API_ERROR" : "PROTOCOL_ERROR"
          ));
        }
      };
      socket.on("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new WorkbenchError(
          (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
            ? `Cannot connect to Workbench at ${this.host}:${this.port}.`
            : `Connection error: ${error.message}`,
          (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
            ? "CONNECTION_REFUSED"
            : "PROTOCOL_ERROR"
        ));
      });
      socket.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_RESPONSE_SIZE) {
          chunks.push(chunk);
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new WorkbenchError(
          `Response for "${apiFunc}" exceeded ${MAX_RESPONSE_SIZE} bytes`,
          "PROTOCOL_ERROR"
        ));
      });
      socket.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        decode();
      });
      socket.on("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
        decode();
      });
      socket.connect(this.port, this.host, () => {
        logger.debug(`Connected to Workbench at ${this.host}:${this.port}, calling "${apiFunc}"`);
        socket.end(request);
      });
    });
  }
}
