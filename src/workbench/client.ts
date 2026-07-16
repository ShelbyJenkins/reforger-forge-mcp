/**
 * TCP client and target-aware Workbench lifecycle coordinator.
 *
 * Every NET API call uses a fresh socket. Every process/filesystem mutation is
 * serialized in-process and then performed while the machine-wide lifecycle
 * mutex is held by WorkbenchProcessGuard.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Socket } from "node:net";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import {
  HandlerBundleError,
  HandlerBundleManager,
  HANDLER_FOLDER,
  type HandlerCleanupResult,
  type HandlerTransactionRecord,
  type PreparedHandlerTransaction,
} from "./handler-bundle.js";
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
  type HandlerLifecycleState,
  type LifecycleClaimResult,
  type LifecycleOperationKind,
  type LifecycleStateDraft,
  type WorkbenchIdentity,
  type WorkbenchLifecycleSession,
  type WorkbenchLifecycleStateV2,
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

export interface LifecycleDiagnostic {
  state: "missing" | "valid" | "legacy" | "malformed";
  version: number | null;
  generation: string | null;
  phase: string | null;
  endpoint: string | null;
  target: string | null;
  lease: "current_mcp" | "other_mcp" | "vacant" | "unknown";
  operation: string | null;
  handlerTransaction: string | null;
  detail?: string;
}

export interface DiagnosticReport {
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  projectPath: { path: string; exists: boolean } | null;
  defaultMod: string | null;
  bundledScripts: { path: string; exists: boolean };
  standaloneAddon: { path: string; exists: boolean; fileCount: number };
  installedMods: Array<{ modDir: string; handlerDir: string; fileCount: number }>;
  netApi: "up_with_handlers" | "up_no_handlers" | "refused" | "timeout" | "error";
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
  | "LEGACY_OWNER"
  | "IDENTITY_UNVERIFIABLE"
  | "STATE_INVALID"
  | "CLEANUP_BLOCKED_LIVE"
  | "HANDLER_CONFLICT"
  | "RECOVERY_REQUIRED"
  | "UNSUPPORTED_PLATFORM"
  | "LIFECYCLE_BUSY";

export class WorkbenchError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchErrorCode = "API_ERROR"
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

export function buildWorkbenchLaunchArgs(
  gprojPath?: string | null,
  configuredAddonDirs?: readonly string[],
  scriptAuthorizeAll = false,
  noThrow = false,
  ownerArgument?: string
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
  for (const configuredDir of configuredAddonDirs ?? []) {
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
  if (gprojPath) args.push("-gproj", gprojPath);
  if (scriptAuthorizeAll) args.push("-scriptAuthorizeAll");
  if (noThrow) args.push("-noThrow");
  if (ownerArgument) args.push(ownerArgument);
  return args;
}

interface LaunchPreflight {
  project: CanonicalProjectIdentity;
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

interface ActiveLifecycleOperation {
  kind: LifecycleOperationKind;
  operationId: string;
  targetKey: string | null;
  promise: Promise<unknown>;
}

export interface WorkbenchClientDependencies {
  handlerBundle?: HandlerBundleManager;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  launchTimeoutMs?: number;
  launchPollIntervalMs?: number;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function stateExpected(state: WorkbenchLifecycleStateV2): ExpectedStateVersion {
  return { generation: state.generation, leaseId: state.mcpOwner?.leaseId ?? null };
}

function stateDraft(
  state: WorkbenchLifecycleStateV2,
  overrides: Partial<LifecycleStateDraft>
): LifecycleStateDraft {
  return {
    phase: overrides.phase ?? state.phase,
    endpoint: overrides.endpoint ?? state.endpoint,
    target: overrides.target === undefined ? state.target : overrides.target,
    mcpOwner: overrides.mcpOwner === undefined ? state.mcpOwner : overrides.mcpOwner,
    workbench: overrides.workbench === undefined ? state.workbench : overrides.workbench,
    handler: overrides.handler === undefined ? state.handler : overrides.handler,
    operation: overrides.operation === undefined ? state.operation : overrides.operation,
  };
}

function handlerState(
  transaction: HandlerTransactionRecord,
  phase: HandlerLifecycleState["phase"],
  keepTransaction = true
): HandlerLifecycleState {
  return {
    modDirectory: transaction.modDirectory,
    manifestGeneration: transaction.manifest.generation,
    transactionId: keepTransaction ? transaction.id : null,
    phase,
    backupPath: keepTransaction ? transaction.backupPath : null,
  };
}

export class WorkbenchClient {
  private activeLifecycle: ActiveLifecycleOperation | null = null;
  private ownedChild: OwnedChildObservation | null = null;
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };
  private readonly handlerBundle: HandlerBundleManager;
  private readonly spawnProcess: WorkbenchClientDependencies["spawnProcess"];
  private readonly launchTimeoutMs: number;
  private readonly launchPollIntervalMs: number;

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
    this.handlerBundle = dependencies.handlerBundle ?? new HandlerBundleManager({
      stateDir: this.processGuard.stateDir,
    });
    this.spawnProcess = dependencies.spawnProcess ?? ((command, args, options) =>
      spawn(command, args, options));
    this.launchTimeoutMs = dependencies.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
    this.launchPollIntervalMs = dependencies.launchPollIntervalMs ?? LAUNCH_POLL_INTERVAL_MS;
  }

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    try {
      return await this.callAndCache<T>(apiFunc, params, options);
    } catch (error) {
      if (error instanceof WorkbenchError) {
        if (["CONNECTION_REFUSED", "TIMEOUT", "PROTOCOL_ERROR"].includes(error.code)) {
          this.resetConnectionState();
        }
        if (!options.skipAutoLaunch && this.config && error.code === "CONNECTION_REFUSED") {
          logger.info("Workbench is unavailable; requesting target-aware auto-launch.");
          await this.ensureRunning();
          return this.callAndCache<T>(apiFunc, params, options);
        }
        if (!options.skipAutoLaunch && this.config && error.code === "API_ERROR" &&
            (error.message.includes("Undefined API func") ||
              error.message.includes("not existing Net API function"))) {
          logger.info("Owned Workbench handlers are unavailable; requesting a clean lifecycle restart.");
          await this.restartOwnedWorkbench();
          return this.callAndCache<T>(apiFunc, params, options);
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
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      return true;
    } catch {
      return false;
    }
  }

  async ensureRunning(gprojPath?: string): Promise<WorkbenchLaunchResult> {
    this.requireConfig("auto-launch");
    const project = await this.resolveLifecycleProject(gprojPath);
    try {
      return await this.coordinateLifecycle("launch", project.comparisonKey, async (operationId) =>
        this.processGuard.withLifecycleLock(async (session) =>
          this.ensureRunningLocked(session, revalidateProjectIdentity(project), operationId)
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
      return await this.coordinateLifecycle("restart", project.comparisonKey, async (operationId) =>
        this.processGuard.withLifecycleLock(async (session) =>
          this.restartLocked(session, revalidateProjectIdentity(project), operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async shutdownOwnedWorkbench(): Promise<WorkbenchShutdownResult> {
    this.requireConfig("shutdown");
    const read = await this.processGuard.readLifecycleState();
    const project = read.kind === "valid" && read.state.target
      ? canonicalizeGproj(read.state.target.path)
      : null;
    try {
      return await this.coordinateLifecycle("shutdown", project?.comparisonKey ?? null, async (operationId) =>
        this.processGuard.withLifecycleLock(async (session) =>
          this.shutdownLocked(session, project, operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async cleanupHandlerScripts(modDir: string): Promise<HandlerCleanupResult> {
    const project = this.projectFromModDirectory(modDir);
    try {
      return await this.coordinateLifecycle("cleanup", project.comparisonKey, async (operationId) =>
        this.processGuard.withLifecycleLock(async (session) => {
        const lockedProject = revalidateProjectIdentity(project);
        let state = await this.claimState(session, lockedProject);
        const processStatus = await this.inspectRecordedWorkbench(state);
        if (processStatus === "live") {
          throw new WorkbenchError(
            `Cleanup is blocked while Workbench PID ${state.workbench!.pid} may be watching ` +
              `${project.displayPath}. Call wb_shutdown first.`,
            "CLEANUP_BLOCKED_LIVE"
          );
        }
        if (processStatus === "absent") {
          state = await this.reconcileAbsentState(session, state, lockedProject);
        }
        await this.assertNoWorkbenchProcesses(session, "cleanup");
        state = await session.transition(stateExpected(state), stateDraft(state, {
          phase: "cleaning",
          target: this.lifecycleTarget(lockedProject),
          operation: { kind: "cleanup", operationId },
          handler: state.handler ? { ...state.handler, phase: "cleaning" } : null,
        }));
        try {
          const result = this.handlerBundle.cleanup(lockedProject);
          const manifest = this.handlerBundle.readManifest(lockedProject.modDirectory);
          const nextHandler = manifest ? {
            modDirectory: lockedProject.modDirectory,
            manifestGeneration: manifest.generation,
            transactionId: null,
            phase: "installed" as const,
            backupPath: null,
          } : null;
          await session.transitionToVacant(stateExpected(state), {
            target: this.lifecycleTarget(lockedProject),
            handler: nextHandler,
          });
          return result;
        } catch (error) {
          await session.transition(stateExpected(state), stateDraft(state, {
            phase: "vacant",
            operation: null,
            handler: state.handler ? { ...state.handler, phase: "installed" } : null,
          })).catch(() => undefined);
          throw this.mapLifecycleError(error);
        }
        })
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
    const bundledScripts = {
      path: this.handlerBundle.bundleDir,
      exists: existsSync(this.handlerBundle.bundleDir),
    };
    const standaloneBase = this.config?.projectPath
      ? join(this.config.projectPath, HANDLER_FOLDER)
      : join("<unknown>", HANDLER_FOLDER);
    const standaloneScripts = join(standaloneBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const standaloneAddon = {
      path: standaloneBase,
      exists: existsSync(standaloneBase),
      fileCount: existsSync(standaloneScripts)
        ? readdirSync(standaloneScripts).filter((name) => name.toLowerCase().endsWith(".c")).length
        : 0,
    };
    const installedMods: DiagnosticReport["installedMods"] = [];
    if (this.config?.projectPath && existsSync(this.config.projectPath)) {
      try {
        for (const entry of readdirSync(this.config.projectPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const modDir = join(this.config.projectPath, entry.name);
          const handlerDir = join(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
          if (!existsSync(handlerDir)) continue;
          installedMods.push({
            modDir,
            handlerDir,
            fileCount: readdirSync(handlerDir).filter((name) => name.toLowerCase().endsWith(".c")).length,
          });
        }
      } catch {
        // Diagnostics remain best effort and non-mutating.
      }
    }

    let netApi: DiagnosticReport["netApi"] = "refused";
    let netApiError: string | undefined;
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      netApi = "up_with_handlers";
    } catch (error) {
      if (error instanceof WorkbenchError) {
        netApiError = error.message;
        if (error.code === "CONNECTION_REFUSED") netApi = "refused";
        else if (error.code === "TIMEOUT") netApi = "timeout";
        else if (error.code === "API_ERROR" &&
          (error.message.includes("not existing Net API function") || error.message.includes("Undefined API func"))) {
          netApi = "up_no_handlers";
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
      bundledScripts,
      standaloneAddon,
      installedMods,
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

  private projectFromModDirectory(modDir: string): CanonicalProjectIdentity {
    let canonicalMod: string;
    try {
      canonicalMod = realpathSync.native(resolve(modDir));
      if (!statSync(canonicalMod).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new WorkbenchError(`Invalid mod directory: ${resolve(modDir)}`, "INVALID_TARGET");
    }
    const candidates = readdirSync(canonicalMod, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".gproj")
      .map((entry) => canonicalizeGproj(join(canonicalMod, entry.name)));
    const unique = new Map(candidates.map((entry) => [entry.comparisonKey, entry]));
    if (unique.size !== 1) {
      const paths = [...unique.values()].map((entry) => entry.displayPath).sort();
      throw new WorkbenchError(
        unique.size === 0
          ? `No .gproj exists directly in mod directory ${canonicalMod}.`
          : `Cleanup target is ambiguous; provide a mod directory containing exactly one .gproj:\n` +
            paths.map((path) => `  - ${path}`).join("\n"),
        unique.size === 0 ? "TARGET_REQUIRED" : "AMBIGUOUS_TARGET"
      );
    }
    return [...unique.values()][0];
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
  ): Promise<WorkbenchLifecycleStateV2> {
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
    state: WorkbenchLifecycleStateV2
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
    session: WorkbenchLifecycleSession,
    action: string
  ): Promise<void> {
    try {
      await session.assertNoWorkbenchProcesses();
    } catch (error) {
      const mapped = this.mapLifecycleError(error);
      throw new WorkbenchError(
        `${action} refused: ${mapped.message}`,
        mapped.code
      );
    }
  }

  private async reconcileAbsentState(
    session: WorkbenchLifecycleSession,
    state: WorkbenchLifecycleStateV2,
    project: CanonicalProjectIdentity | null
  ): Promise<WorkbenchLifecycleStateV2> {
    let restoredTransaction: HandlerTransactionRecord | null = null;
    let nextHandler = state.handler;
    if (state.handler?.backupPath && state.handler.transactionId) {
      try {
        restoredTransaction = this.handlerBundle.restore(state.handler.backupPath);
        const manifest = this.handlerBundle.readManifest(restoredTransaction.modDirectory);
        nextHandler = manifest ? {
          modDirectory: restoredTransaction.modDirectory,
          manifestGeneration: manifest.generation,
          transactionId: null,
          phase: "installed",
          backupPath: null,
        } : null;
      } catch (error) {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: could not roll back handler transaction ` +
            `${state.handler.transactionId}: ${error instanceof Error ? error.message : String(error)}`,
          "RECOVERY_REQUIRED"
        );
      }
    }
    this.resetConnectionState();
    const vacant = await session.transitionToVacant(stateExpected(state), {
      target: project ? this.lifecycleTarget(project) : state.target,
      handler: nextHandler,
    });
    if (restoredTransaction) {
      try {
        this.handlerBundle.discardTransaction(restoredTransaction);
      } catch (error) {
        logger.warn(
          `Recovered handler transaction ${restoredTransaction.id}, but its backup could not be ` +
            `pruned: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return vacant;
  }

  private async reconcileForEnsure(
    session: WorkbenchLifecycleSession,
    state: WorkbenchLifecycleStateV2,
    project: CanonicalProjectIdentity
  ): Promise<{ state: WorkbenchLifecycleStateV2; live: boolean }> {
    const status = await this.inspectRecordedWorkbench(state);
    if (status === "absent") {
      await this.assertNoWorkbenchProcesses(session, "Lifecycle recovery");
      return { state: await this.reconcileAbsentState(session, state, project), live: false };
    }
    if (state.phase === "stopping") {
      const stopped = await this.terminateExact(session, state.workbench!);
      if (!stopped) throw new WorkbenchError("Exact Workbench shutdown could not be proven.", "RECOVERY_REQUIRED");
      await this.waitForPortRelease();
      return { state: await this.reconcileAbsentState(session, state, project), live: false };
    }
    if (state.phase === "starting" || state.phase === "restarting") {
      if (await this.ping()) {
        let nextHandler = state.handler;
        let completedTransaction: HandlerTransactionRecord | null = null;
        if (state.handler?.backupPath) {
          const record = this.handlerBundle.loadTransaction(state.handler.backupPath);
          if (record.phase !== "applied") {
            throw new WorkbenchError(
              `RECOVERY_REQUIRED: live Workbench has an un-applied handler transaction ${record.id}.`,
              "RECOVERY_REQUIRED"
            );
          }
          completedTransaction = record;
          nextHandler = handlerState(record, "installed", false);
        }
        const running = await session.transition(stateExpected(state), stateDraft(state, {
          phase: "running",
          operation: null,
          handler: nextHandler,
        }));
        if (completedTransaction) {
          try {
            this.handlerBundle.commit(completedTransaction);
          } catch (error) {
            logger.warn(
              `Handler transaction ${completedTransaction.id} was durably completed, but its ` +
                `backup could not be pruned: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        return { state: running, live: true };
      }
      await this.terminateExact(session, state.workbench!);
      await this.waitForPortRelease();
      return { state: await this.reconcileAbsentState(session, state, project), live: false };
    }
    return { state, live: true };
  }

  private async ensureRunningLocked(
    session: WorkbenchLifecycleSession,
    project: CanonicalProjectIdentity,
    operationId: string
  ): Promise<WorkbenchLaunchResult> {
    let state = await this.claimState(session, project);
    const reconciled = await this.reconcileForEnsure(session, state, project);
    state = reconciled.state;
    if (reconciled.live) {
      if (!state.workbench || !state.target || state.target.comparisonKey !== project.comparisonKey) {
        throw new WorkbenchError("Recorded Workbench target does not match the requested project.", "TARGET_CONFLICT");
      }
      if (!(await this.ping())) {
        throw new WorkbenchError(
          `Exact owned Workbench PID ${state.workbench.pid} is running but its handler endpoint is unavailable.`,
          "LAUNCH_FAILED"
        );
      }
      return {
        action: "reused",
        pid: state.workbench.pid,
        gprojPath: project.displayPath,
        generation: state.generation,
      };
    }

    await this.assertNoWorkbenchProcesses(session, "Launch");
    if (await this.isPortListening()) {
      throw new WorkbenchError(
        `UNOWNED_WORKBENCH: NET API endpoint ${this.host}:${this.port} is occupied without the exact ` +
          "recorded Workbench identity.",
        "UNOWNED_WORKBENCH"
      );
    }
    const preflight = this.preflightLaunch(project);
    const started = await this.startLocked(session, state, preflight, "starting", "launch", operationId);
    return {
      action: "launched",
      pid: started.workbench!.pid,
      gprojPath: project.displayPath,
      generation: started.generation,
    };
  }

  private async restartLocked(
    session: WorkbenchLifecycleSession,
    project: CanonicalProjectIdentity,
    operationId: string
  ): Promise<WorkbenchRestartResult> {
    let state = await this.claimState(session, project);
    const reconciled = await this.reconcileForEnsure(session, state, project);
    state = reconciled.state;
    if (!reconciled.live || !state.workbench) {
      throw new WorkbenchError("Restart refused: no exact owned Workbench is running.", "LAUNCH_FAILED");
    }

    // Complete replacement preflight before changing state or stopping a healthy process.
    const preflight = this.preflightLaunch(revalidateProjectIdentity(project));
    const previous = state.workbench;
    const priorPhase = state.phase;
    state = await session.transition(stateExpected(state), stateDraft(state, {
      phase: "restarting",
      operation: { kind: "restart", operationId },
    }));
    try {
      await this.terminateExact(session, previous);
    } catch (error) {
      await session.transition(stateExpected(state), stateDraft(state, {
        phase: priorPhase,
        operation: null,
      })).catch(() => undefined);
      throw error;
    }
    this.resetConnectionState();
    await this.waitForPortRelease();
    state = await session.transition(stateExpected(state), stateDraft(state, {
      phase: "restarting",
      workbench: null,
    }));
    const restarted = await this.startLocked(
      session,
      state,
      preflight,
      "restarting",
      "restart",
      operationId
    );
    return {
      previousPid: previous.pid,
      pid: restarted.workbench!.pid,
      gprojPath: project.displayPath,
      generation: restarted.generation,
    };
  }

  private async shutdownLocked(
    session: WorkbenchLifecycleSession,
    project: CanonicalProjectIdentity | null,
    operationId: string
  ): Promise<WorkbenchShutdownResult> {
    let state = await this.claimState(session, project);
    const status = await this.inspectRecordedWorkbench(state);
    if (status === "absent") {
      await this.assertNoWorkbenchProcesses(session, "Shutdown");
      state = await this.reconcileAbsentState(session, state, project);
      return {
        stopped: false,
        previousPid: null,
        gprojPath: project?.displayPath ?? state.target?.path ?? null,
        generation: state.generation,
      };
    }
    const expected = state.workbench!;
    state = await session.transition(stateExpected(state), stateDraft(state, {
      phase: "stopping",
      operation: { kind: "shutdown", operationId },
    }));
    try {
      await this.terminateExact(session, expected);
    } catch (error) {
      await session.transition(stateExpected(state), stateDraft(state, {
        phase: "running",
        operation: null,
      })).catch(() => undefined);
      throw error;
    }
    await this.waitForPortRelease();
    this.resetConnectionState();
    const observedChild = this.ownedChild;
    if (observedChild && observedChild.identity.pid === expected.pid &&
        observedChild.identity.creationTime === expected.creationTime) {
      this.ownedChild = null;
    }
    const vacant = await this.reconcileAbsentState(session, state, project);
    return {
      stopped: true,
      previousPid: expected.pid,
      gprojPath: project?.displayPath ?? state.target?.path ?? null,
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
    // Validate all arguments and the complete handler source/target before a restart stops anything.
    const args = buildWorkbenchLaunchArgs(
      currentProject.displayPath,
      this.config?.workbenchAddonDirs,
      this.config?.workbenchScriptAuthorizeAll === true,
      true
    );
    try {
      this.handlerBundle.preflight(currentProject);
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
    return {
      project: currentProject,
      executablePath,
      cwd: this.findGameDir() ?? dirname(executablePath),
      args,
    };
  }

  private async startLocked(
    session: WorkbenchLifecycleSession,
    initialState: WorkbenchLifecycleStateV2,
    preflight: LaunchPreflight,
    transientPhase: "starting" | "restarting",
    operationKind: "launch" | "restart",
    operationId: string
  ): Promise<WorkbenchLifecycleStateV2> {
    let state = await session.transition(stateExpected(initialState), stateDraft(initialState, {
      phase: transientPhase,
      target: this.lifecycleTarget(preflight.project),
      workbench: null,
      operation: { kind: operationKind, operationId },
    }));
    const originalHandler = initialState.handler;
    let transaction: PreparedHandlerTransaction;
    try {
      transaction = this.handlerBundle.prepare(preflight.project);
    } catch (error) {
      await session.transitionToVacant(stateExpected(state), {
        target: this.lifecycleTarget(preflight.project),
        handler: originalHandler,
      }).catch(() => undefined);
      throw this.mapLifecycleError(error);
    }

    try {
      state = await session.transition(stateExpected(state), stateDraft(state, {
        handler: handlerState(transaction.record, "installing"),
      }));
    } catch (error) {
      this.handlerBundle.abortPrepared(transaction.record);
      throw error;
    }

    try {
      const applied = this.handlerBundle.apply(transaction);
      state = await session.transition(stateExpected(state), stateDraft(state, {
        handler: handlerState(applied, "installed"),
      }));
    } catch (error) {
      try {
        const restored = this.handlerBundle.restore(transaction.record.backupPath);
        await session.transitionToVacant(stateExpected(state), {
          target: this.lifecycleTarget(preflight.project),
          handler: originalHandler,
        });
        try {
          this.handlerBundle.discardTransaction(restored);
        } catch (discardError) {
          logger.warn(
            `Rolled back handler transaction ${restored.id}, but its backup could not be pruned: ` +
              `${discardError instanceof Error ? discardError.message : String(discardError)}`
          );
        }
      } catch (rollbackError) {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: handler installation failed and rollback could not be completed. ` +
            `Transaction ${transaction.record.id} remains durable at ` +
            `${transaction.record.backupPath}: ` +
            `${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          "RECOVERY_REQUIRED"
        );
      }
      throw this.mapLifecycleError(error);
    }

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
      const launchedAtMs = Date.now();
      child = this.spawnProcess!(preflight.executablePath, args, {
        detached: true,
        stdio: "ignore",
        cwd: preflight.cwd,
        windowsHide: true,
      });
      child.once("error", (error) => { spawnError = error; });
      if (!child.pid) {
        throw new WorkbenchError(
          "Workbench spawn returned no PID; exact process ownership cannot be established.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      identity = await session.inspectSpawnedWorkbench({
        pid: child.pid,
        executablePath: preflight.executablePath,
        ownerTokenArgument: ownerArgument,
        launchedAtMs,
      });
      state = await session.transition(stateExpected(state), stateDraft(state, {
        workbench: identity,
      }));
      childObservation = this.attachOwnedChild(
        child,
        identity,
        state.generation,
        preflight.project.comparisonKey
      );
      child.unref();
      await this.waitForHandlerReady(child, () => spawnError);
      state = await session.transition(stateExpected(state), stateDraft(state, {
        phase: "running",
        handler: handlerState(transaction.record, "installed", false),
        operation: null,
      }));
      // This final CAS is the transaction commit point. Until it succeeds the
      // backup remains durable and a failure terminates the exact child before
      // rolling watched files back.
      if (childObservation) childObservation.generation = state.generation;
    } catch (error) {
      await this.rollbackFailedLaunch(
        session,
        state,
        transaction.record,
        identity,
        originalHandler
      );
      throw this.mapLifecycleError(error);
    }

    const runningIdentity = identity;
    if (!runningIdentity) {
      throw new WorkbenchError(
        "Workbench reached readiness without an exact process identity.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    try {
      // The lifecycle CAS above is authoritative. Removing the rollback journal
      // is post-commit pruning, so a crash here can leave only a harmless orphan
      // rather than state that points at a missing recovery record.
      this.handlerBundle.commit(transaction.record);
    } catch (error) {
      logger.warn(
        `Handler transaction ${transaction.record.id} was durably completed for Workbench PID ` +
          `${runningIdentity.pid}, but its backup could not be pruned: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
    this._state.connected = true;
    this._state.lastUpdated = Date.now();
    return state;
  }

  private async rollbackFailedLaunch(
    session: WorkbenchLifecycleSession,
    state: WorkbenchLifecycleStateV2,
    transaction: HandlerTransactionRecord,
    identity: WorkbenchIdentity | null,
    originalHandler: HandlerLifecycleState | null
  ): Promise<void> {
    if (identity) {
      const result = await session.verifyAndTerminate(identity, OWNED_PROCESS_EXIT_TIMEOUT_MS);
      if (result.kind === "refused") {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: launch failed and exact Workbench shutdown was refused (${result.reason}): ` +
            `${result.message}. Handler transaction ${transaction.id} was preserved.`,
          "RECOVERY_REQUIRED"
        );
      }
      await this.waitForPortRelease();
    } else {
      const processes = await this.processGuard.listWorkbenchProcesses();
      if (processes.length > 0) {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: launch identity was not established and Workbench PID(s) ` +
            `${processes.map((entry) => entry.pid).join(", ")} are present. Handler transaction ` +
            `${transaction.id} was preserved; watched files were not changed again.`,
          "RECOVERY_REQUIRED"
        );
      }
    }
    const restored = this.handlerBundle.restore(transaction.backupPath);
    await session.transitionToVacant(stateExpected(state), {
      target: state.target,
      handler: originalHandler,
    });
    try {
      this.handlerBundle.discardTransaction(restored);
    } catch (error) {
      logger.warn(
        `Rolled back failed launch transaction ${restored.id}, but its backup could not be ` +
          `pruned: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    this.resetConnectionState();
  }

  private async waitForHandlerReady(
    child: ChildProcess,
    getSpawnError: () => Error | null
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
        await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
        return;
      } catch (error) {
        if (error instanceof WorkbenchError) lastErrorCode = error.code;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.launchPollIntervalMs));
    }
    const hint = lastErrorCode === "API_ERROR"
      ? "The NET API opened, but the managed handler bundle did not compile. Inspect Workbench script errors."
      : "The NET API never became ready. Confirm that Workbench NET API is enabled.";
    throw new WorkbenchError(
      `Workbench did not become ready within ${this.launchTimeoutMs / 1000}s. ${hint}`,
      "LAUNCH_FAILED"
    );
  }

  private async terminateExact(
    session: WorkbenchLifecycleSession,
    expected: WorkbenchIdentity
  ): Promise<boolean> {
    const result = await session.verifyAndTerminate(expected, OWNED_PROCESS_EXIT_TIMEOUT_MS);
    if (result.kind === "refused") {
      throw new WorkbenchError(
        `IDENTITY_UNVERIFIABLE: exact Workbench termination was refused (${result.reason}): ` +
          `${result.message}. No PID-only signal was attempted.`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return true;
  }

  private attachOwnedChild(
    child: ChildProcess,
    identity: WorkbenchIdentity,
    generation: string,
    targetKey: string
  ): OwnedChildObservation {
    const observation: OwnedChildObservation = { child, identity, generation, targetKey };
    this.ownedChild = observation;
    child.once("exit", () => {
      if (this.ownedChild !== observation) return;
      this.resetConnectionState();
      this.ownedChild = null;
      void this.coordinateLifecycle("recovery", targetKey, async () =>
        this.processGuard.withLifecycleLock(async (session) => {
          const read = await session.readState();
          if (read.kind !== "valid" || read.state.generation !== observation.generation ||
              !read.state.workbench || read.state.workbench.pid !== identity.pid ||
              read.state.workbench.creationTime !== identity.creationTime) return;
          await this.assertNoWorkbenchProcesses(session, "Unexpected-exit recovery");
          await this.reconcileAbsentState(session, read.state,
            read.state.target ? canonicalizeGproj(read.state.target.path) : null);
        })
      ).catch((error) => logger.warn(
        `Workbench exit reconciliation failed: ${error instanceof Error ? error.message : String(error)}`
      ));
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

  private async waitForPortRelease(): Promise<void> {
    const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!(await this.isPortListening())) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, PORT_RELEASE_POLL_MS));
    }
    throw new WorkbenchError(
      `NET API endpoint ${this.host}:${this.port} remained occupied after exact Workbench exit.`,
      "IDENTITY_UNVERIFIABLE"
    );
  }

  private isPortListening(timeoutMs = 500): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const socket = new Socket();
      let settled = false;
      const finish = (listening: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolvePromise(listening);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
      socket.connect(this.port, this.host);
    });
  }

  private async lifecycleDiagnostic(): Promise<LifecycleDiagnostic> {
    try {
      const read = await this.processGuard.readLifecycleState();
      if (read.kind === "missing") {
        return {
          state: "missing", version: null, generation: null, phase: null, endpoint: null,
          target: null, lease: "vacant", operation: null, handlerTransaction: null,
        };
      }
      if (read.kind === "legacy") {
        return {
          state: "legacy", version: 1, generation: null, phase: null, endpoint: null,
          target: null, lease: "unknown", operation: null, handlerTransaction: null,
          detail: "A live legacy record is never adopted; close its Workbench once before migration.",
        };
      }
      if (read.kind === "malformed") {
        return {
          state: "malformed", version: null, generation: null, phase: null, endpoint: null,
          target: null, lease: "unknown", operation: null, handlerTransaction: null,
          detail: read.message,
        };
      }
      const state = read.state;
      return {
        state: "valid",
        version: 2,
        generation: state.generation,
        phase: state.phase,
        endpoint: `${state.endpoint.host}:${state.endpoint.port}`,
        target: state.target?.path ?? null,
        lease: !state.mcpOwner ? "vacant" :
          state.mcpOwner.instanceId === this.processGuard.mcpInstanceId ? "current_mcp" : "other_mcp",
        operation: state.operation ? `${state.operation.kind}:${state.operation.operationId}` : null,
        handlerTransaction: state.handler?.transactionId ?? null,
      };
    } catch (error) {
      return {
        state: "malformed", version: null, generation: null, phase: null, endpoint: null,
        target: null, lease: "unknown", operation: null, handlerTransaction: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private mapLifecycleError(error: unknown): WorkbenchError {
    if (error instanceof WorkbenchError) return error;
    if (error instanceof ProjectIdentityError) {
      return new WorkbenchError(error.message, error.code);
    }
    if (error instanceof HandlerBundleError) {
      const code = error.code === "HANDLER_CONFLICT" || error.code === "HANDLER_MANIFEST_INVALID"
        ? "HANDLER_CONFLICT"
        : "LAUNCH_FAILED";
      return new WorkbenchError(error.message, code);
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
