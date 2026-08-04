/**
 * Target-aware Workbench session controller and compatibility surface.
 *
 * Every NET API call uses a fresh socket. Lifecycle mutations use short
 * reserve/CAS/commit transactions under the machine-wide mutex; readiness,
 * exact termination, and endpoint-release waits run against durable exact
 * owner evidence after that mutex is released.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import { redactArguments } from "../foundation/redact.js";
import { logger } from "../utils/logger.js";
import {
  WorkbenchActivityError,
  WorkbenchActivityGate,
  type CaptureActivityBinding,
  type CaptureActivityLease,
  type WorkbenchActivityGateTiming,
} from "./activity-gate.js";
import {
  WorkbenchAddonDependencyPreflightError,
  assertWorkbenchAddonDependenciesAvailable,
} from "./addon-dependencies.js";
import {
  ChildSupervisor,
  type SupervisedChildExit,
  type SupervisedChildHandle,
  type SupervisedChildCounts,
} from "../foundation/child-supervisor.js";
import {
  WorkbenchLifecycleExecution,
  WorkbenchLifecycleExecutionError,
  type WorkbenchLifecycleExecutionDependencies,
  type WorkbenchLifecycleExecutionPort,
  type WorkbenchLifecycleSupervisedChild,
} from "./lifecycle-execution.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  WorkbenchHelperStager,
  defaultWorkbenchHelperManagedRoot,
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
  type LifecycleClaimResult,
  type LifecycleStateRead,
  type LifecycleOperationKind,
  type LifecycleStateDraft,
  type McpOwnerIdentity,
  type WorkbenchCompanionLifecycleState,
  type WorkbenchIdentity,
  type WorkbenchWindow,
  type WorkbenchLifecycleSession,
  type WorkbenchLifecycleStateV3,
  type WorkbenchSpawnRecord,
} from "./process-guard.js";
import {
  WorkbenchModalWatchdog,
  findOwnedNativeDialog,
  type WorkbenchModalEvidence,
} from "./modal-watchdog.js";
import {
  diagnoseWorkbench,
  type DiagnosticReport,
} from "./diagnostics.js";
import {
  findWorkbenchCompileFailure,
  formatWorkbenchCompileFailure,
  type WorkbenchCompileFailure,
} from "./compile-diagnostics.js";
import {
  WorkbenchNetApiClient,
  WorkbenchNetApiError,
  type WorkbenchNetApiPort,
} from "./net-api-client.js";
import {
  WorkbenchSessionStateError,
  expectedStateVersion as stateExpected,
  lifecycleStateDraft as stateDraft,
  requireReservedLifecycle as requireReservedState,
  sameLifecycleOwner,
  sameWorkbenchIdentity,
  toCompanionLifecycleState as companionLifecycleState,
  toLifecycleTarget,
  transitionReservedLifecycle as transitionReservedState,
  vacateReservedLifecycle as vacateReservedState,
  type WorkbenchLifecycleTarget,
} from "./session-state.js";
import {
  WorkbenchReadinessError,
  waitForCompanionReady as awaitCompanionReadiness,
  waitForVacancy,
  type WorkbenchCompanionIdentity,
} from "./readiness.js";
import {
  WorkbenchLaunchPlanError,
  buildLegacyWorkbenchLaunchArguments,
  buildMcpEditorLaunchPlan,
  buildMcpTargetResourceLaunchPlan,
  type CliEditorLaunchPlan,
  type McpEditorLaunchPlan,
  type McpTargetResourceLaunchPlan,
  type TargetBuildLaunchPlan,
  type TargetCheckLaunchPlan,
} from "./launch-plan.js";
import {
  ResourceTargetError,
  canonicalizeResourceTarget,
  revalidateResourceTarget,
  type CanonicalResourceTarget,
} from "./resource-target.js";
import { findExplicitEmptyPrefabOverrides } from "./prefab-save-integrity.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;
const OWNED_PROCESS_EXIT_TIMEOUT_MS = 15_000;
const PORT_RELEASE_TIMEOUT_MS = 15_000;
const PORT_RELEASE_POLL_MS = 200;
const DEFAULT_QUALIFICATION_INTERVAL_MS = 2_000;
const EXPLICIT_SAVE_MODAL_SETTLE_MS = 5_000;

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

/** A running fresh Workbench whose initial World Editor resource is immutable by launch contract. */
export interface WorkbenchTargetResourceLaunchResult extends WorkbenchLaunchResult {
  readonly resourcePath: string;
  readonly targetBound: true;
}

export interface WorkbenchSaveResourceResult {
  readonly resourcePath: string;
  readonly startupLoadPath: string;
  readonly outcome: "changed" | "no_change";
  readonly changedPaths: readonly string[];
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

export type WorkbenchForegroundExitReason = "exited" | "timed_out" | "aborted";

export interface WorkbenchRunResult<Qualification = unknown> {
  readonly planKind: "cli_editor" | "target_build" | "target_check";
  readonly process: Readonly<WorkbenchIdentity>;
  readonly lifecycleGeneration: string;
  readonly qualification: Qualification;
  readonly endpointVacancy: "verified";
  readonly exitStatus: Readonly<{
    reason: WorkbenchForegroundExitReason;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>;
}

export interface ForegroundQualificationContext {
  readonly endpoint: Readonly<{ host: string; port: number }>;
  readonly process: Readonly<WorkbenchIdentity>;
  readonly companion: Readonly<WorkbenchCompanionLaunch>;
  readonly child: SupervisedChildHandle;
  verifyEndpointOwner(): ReturnType<WorkbenchLifecycleExecutionPort["verifyEndpointOwner"]>;
}

export interface ForegroundRunOptions<Qualification = unknown> {
  readonly signal?: AbortSignal;
  readonly qualify: (context: ForegroundQualificationContext) => Promise<Qualification>;
  /** Synchronous policy revalidation performed before the final vacancy proof. */
  readonly beforeFinalVacancyCheck?: () => void;
  /** Synchronous policy revalidation after durable pre_spawn and immediately before spawn. */
  readonly beforeSpawn?: () => void;
  readonly terminationTimeoutMs?: number;
  readonly recoveryTimeoutMs?: number;
}

export interface WorkbenchBuildOutputReservation<Snapshot> {
  readonly root: string;
  assertStillReservedAndSnapshot(): Snapshot;
}

export interface BoundedRunOptions {
  /** One absolute deadline shared by spawn, foreground lifetime, and cleanup decision. */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  /** Runs before the final endpoint vacancy proof. */
  readonly beforeFinalVacancyCheck?: () => void;
  /** Runs synchronously after durable pre_spawn and before the final output snapshot. */
  readonly beforeSpawn?: () => void;
  readonly terminationTimeoutMs?: number;
  readonly recoveryTimeoutMs?: number;
}

export interface WorkbenchTargetBuildRunResult<Snapshot>
  extends WorkbenchRunResult<null> {
  readonly planKind: "target_build";
  readonly beforeOutput: Snapshot;
}

export interface WorkbenchTargetCheckRunResult extends WorkbenchRunResult<null> {
  readonly planKind: "target_check";
}

type BoundedTargetLaunchPlan = TargetBuildLaunchPlan | TargetCheckLaunchPlan;

interface BoundedTargetHooks<Snapshot> {
  beforeReservation?(): void;
  afterReservation?(): void;
  captureBeforeSpawn(): Snapshot;
}

export type WorkbenchRunErrorCode =
  | "ABORTED"
  | "DEADLINE_EXCEEDED"
  | "INCOMPLETE_PROOF"
  | "ENDPOINT_UNVERIFIABLE"
  | "IDENTITY_UNVERIFIABLE"
  | "SPAWN_FAILED";

export class WorkbenchRunError extends Error {
  constructor(message: string, public readonly code: WorkbenchRunErrorCode) {
    super(message);
    this.name = "WorkbenchRunError";
  }
}

export interface CompanionQualificationOptions {
  readonly netApi: WorkbenchNetApiPort;
  readonly attestCompanion: () => WorkbenchCompanionLaunch;
  readonly deadlineMs: number;
  readonly pollIntervalMs: number;
  readonly signal?: AbortSignal;
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

export type WorkbenchErrorCode =
  | "CONNECTION_REFUSED"
  | "TIMEOUT"
  | "PROTOCOL_ERROR"
  | "API_ERROR"
  | "LAUNCH_FAILED"
  | "PROJECT_COMPILE_FAILED"
  | "TARGET_REQUIRED"
  | "AMBIGUOUS_TARGET"
  | "INVALID_CONFIG"
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
  | "CAPTURE_INVALIDATED"
  | "UNATTENDED_SAVE_UNSUPPORTED"
  | "TARGET_SESSION_REQUIRED"
  | "TARGET_SESSION_TAINTED"
  | "SAVE_OUTCOME_UNCERTAIN";

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

/** @deprecated Use a discriminated Workbench launch plan; retained through Stage 6. */
export function buildWorkbenchLaunchArgs(
  gprojPath?: string | null,
  configuredAddonDirs?: readonly string[],
  scriptAuthorizeAll = false,
  noThrow = false,
  ownerArgument?: string,
  companion?: WorkbenchCompanionLaunchArguments
): string[] {
  try {
    return buildLegacyWorkbenchLaunchArguments(
      gprojPath,
      configuredAddonDirs,
      scriptAuthorizeAll,
      noThrow,
      ownerArgument,
      companion
    );
  } catch (error) {
    if (error instanceof WorkbenchLaunchPlanError) {
      throw new WorkbenchError(error.message, "LAUNCH_FAILED");
    }
    throw error;
  }
}

type LaunchPreflight = McpEditorLaunchPlan | McpTargetResourceLaunchPlan;

interface ExplicitResourceSessionBinding {
  readonly project: CanonicalProjectIdentity;
  readonly resource: CanonicalResourceTarget;
  readonly generation: string;
  readonly process: WorkbenchIdentity;
  taintedReason: string | null;
}

interface OwnedChildObservation {
  child: ChildProcess;
  handle: SupervisedChildHandle;
  supervisionKey: string;
  identity: WorkbenchIdentity;
  generation: string;
  targetKey: string;
}

interface ManagedRunningAuthority {
  readonly state: WorkbenchLifecycleStateV3;
  readonly snapshot: WorkbenchObserverSnapshot;
}

type CoordinatedLifecycleKind = LifecycleOperationKind | "target_build" | "target_check";

interface ActiveLifecycleOperation {
  kind: CoordinatedLifecycleKind;
  operationId: string;
  targetKey: string | null;
  promise: Promise<unknown>;
}

export interface OwnerScopedTargetBuildOptions {
  readonly signal?: AbortSignal;
}

export type OwnerScopedTargetCheckOptions = OwnerScopedTargetBuildOptions;

export interface WorkbenchClientDependencies {
  companionProvider?: WorkbenchCompanionProvider;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  netApi?: WorkbenchNetApiPort;
  companionReadiness?: typeof awaitCompanionReadiness;
  vacancyWait?: typeof waitForVacancy;
  childSupervisor?: ChildSupervisor;
  /** Shared process-lifecycle boundary used by CLI/build composition as well. */
  lifecycleExecution?: WorkbenchLifecycleExecutionPort;
  /** Explicit read-only diagnostics service for server composition and tests. */
  diagnostics?: typeof diagnoseWorkbench;
  /** A callback is evaluated at the actual launch boundary for absolute-deadline callers. */
  launchTimeoutMs?: number | (() => number);
  /** Optional absolute cap for exact termination and endpoint-release waits. */
  lifecycleDeadlineAtMs?: () => number | undefined;
  /** Optional absolute cap re-evaluated at the final NET transport boundary. */
  requestDeadlineAtMs?: () => number | undefined;
  launchPollIntervalMs?: number;
  activityGate?: WorkbenchActivityGate;
  captureRestoreTimeoutMs?: number;
  activityGateTiming?: WorkbenchActivityGateTiming;
  qualificationIntervalMs?: number;
  now?: () => number;
  /** Test-only observation hook for a native dialog detected during explicit save. */
  onExplicitSaveModal?: (evidence: WorkbenchModalEvidence) => void;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return absolute.toLowerCase();
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

function captureBindingMatchesLifecycle(
  binding: CaptureActivityBinding,
  state: WorkbenchLifecycleStateV3,
  requireGeneration = true
): boolean {
  const workbench = state.workbench;
  return (!requireGeneration || state.generation === binding.generation) &&
    state.target?.comparisonKey === binding.targetKey &&
    workbench !== null &&
    workbench.pid === binding.process.pid &&
    workbench.creationTime === binding.process.creationTime &&
    pathKey(workbench.executablePath) === pathKey(binding.process.executablePath);
}

function changedBundlePaths(
  before: ReadonlyMap<string, { readonly sha256: string; readonly size: number; readonly mtimeMs: number }>,
  after: ReadonlyMap<string, { readonly sha256: string; readonly size: number; readonly mtimeMs: number }>
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => {
    const left = before.get(path);
    const right = after.get(path);
    return !left || !right || left.sha256 !== right.sha256 || left.size !== right.size ||
      left.mtimeMs !== right.mtimeMs;
  }).sort((left, right) => left.localeCompare(right));
}

function explicitResourceLaunchArguments(resource: CanonicalResourceTarget): readonly string[] {
  const args = [
    "-wbModule=WorldEditor",
    "-run",
  ];
  if (extname(resource.displayPath).toLowerCase() !== ".et") {
    args.push("-load", resource.displayPath);
  }
  args.push("-reforgerForgeExplicitTarget", resource.displayPath);
  return Object.freeze(args);
}

export class WorkbenchSessionController {
  private activeLifecycle: ActiveLifecycleOperation | null = null;
  private activeTargetBuildAbort: AbortController | null = null;
  private activeTargetBuildPromise: Promise<unknown> | null = null;
  private targetBuildClosing = false;
  private ownedChild: OwnedChildObservation | null = null;
  /**
   * Deliberately process-local. If this MCP restarts, it cannot prove a
   * previously spawned Workbench was launched with the target resource, so
   * save is refused rather than reconstructing mutable editor state.
   */
  private explicitResourceSession: ExplicitResourceSessionBinding | null = null;
  private readonly childSupervisor: ChildSupervisor;
  private readonly runnerLifecycleExecution: WorkbenchLifecycleExecutionPort;
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };
  private readonly spawnProcess: WorkbenchClientDependencies["spawnProcess"];
  private readonly companionProvider: WorkbenchCompanionProvider | undefined;
  private readonly launchTimeoutMs: () => number;
  private readonly lifecycleDeadlineAtMs: (() => number | undefined) | undefined;
  private readonly requestDeadlineAtMs: (() => number | undefined) | undefined;
  private readonly launchPollIntervalMs: number;
  private readonly activityGate: WorkbenchActivityGate;
  private readonly netApi: WorkbenchNetApiPort;
  private readonly companionReadiness: typeof awaitCompanionReadiness;
  private readonly vacancyWait: typeof waitForVacancy;
  private readonly diagnosticsService: typeof diagnoseWorkbench;
  private readonly qualificationIntervalMs: number;
  private readonly now: () => number;
  private readonly onExplicitSaveModal: WorkbenchClientDependencies["onExplicitSaveModal"];
  private lastLaunchCompileFailure: WorkbenchCompileFailure | null = null;
  private companionAttestationKey: string | null = null;
  private qualificationCache: {
    authority: ManagedRunningAuthority;
    qualifiedAtMs: number;
  } | null = null;

  get state(): Readonly<WorkbenchState> {
    return this._state;
  }

  /** Controller-owned process lifecycle port for the standalone runner composition. */
  get lifecycleExecution(): WorkbenchLifecycleExecutionPort {
    return this.runnerLifecycleExecution;
  }

  /**
   * Keep one MCP-owned target build inside the same process-local lifecycle
   * coordinator and writer gate as editor lifecycle and observer operations.
   *
   * The callback deliberately receives the shared lifecycle execution port so
   * its one target-only build remains inside this controller's admission
   * boundary for the full lifecycle.
   */
  async runOwnerScopedTargetBuild<T>(
    gprojPath: string,
    action: (
      lifecycleExecution: WorkbenchLifecycleExecutionPort,
      signal: AbortSignal
    ) => Promise<T>,
    options: OwnerScopedTargetBuildOptions = {}
  ): Promise<T> {
    return this.runOwnerScopedTargetOperation(
      "target_build",
      "owner-scoped target build",
      gprojPath,
      action,
      options,
      (project) => this.reconcileOwnerScopedTargetBuildEntry(project)
    );
  }

  async runOwnerScopedTargetCheck<T>(
    gprojPath: string,
    action: (
      lifecycleExecution: WorkbenchLifecycleExecutionPort,
      signal: AbortSignal
    ) => Promise<T>,
    options: OwnerScopedTargetCheckOptions = {}
  ): Promise<T> {
    return this.runOwnerScopedTargetOperation(
      "target_check",
      "owner-scoped Enforce Script check",
      gprojPath,
      action,
      options,
      (project) => this.reconcileOwnerScopedTargetOperationEntry(project, "Enforce Script check")
    );
  }

  private async runOwnerScopedTargetOperation<T>(
    kind: "target_build" | "target_check",
    activityName: string,
    gprojPath: string,
    action: (
      lifecycleExecution: WorkbenchLifecycleExecutionPort,
      signal: AbortSignal
    ) => Promise<T>,
    options: OwnerScopedTargetBuildOptions,
    reconcile: (project: CanonicalProjectIdentity) => Promise<void>
  ): Promise<T> {
    if (this.targetBuildClosing) {
      throw new WorkbenchError(
        "Workbench target operation is unavailable because the MCP server is shutting down.",
        "LIFECYCLE_BUSY"
      );
    }
    if (this.activeTargetBuildPromise) {
      throw new WorkbenchError(
        "Another owner-scoped Workbench target operation is already active.",
        "LIFECYCLE_BUSY"
      );
    }

    let project: CanonicalProjectIdentity;
    try {
      project = canonicalizeGproj(gprojPath);
    } catch (error) {
      throw this.mapLifecycleError(error);
    }

    const operationAbort = new AbortController();
    const forwardRequestAbort = (): void => {
      operationAbort.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", forwardRequestAbort, { once: true });
    if (options.signal?.aborted) forwardRequestAbort();

    const promise = this.coordinateLifecycle(
      kind,
      project.comparisonKey,
      () => this.activityGate.runLifecycle(
        activityName,
        async () => {
          await reconcile(project);
          return action(this.runnerLifecycleExecution, operationAbort.signal);
        },
        { signal: operationAbort.signal }
      )
    );
    this.activeTargetBuildAbort = operationAbort;
    this.activeTargetBuildPromise = promise;
    try {
      return await promise;
    } finally {
      options.signal?.removeEventListener("abort", forwardRequestAbort);
      if (this.activeTargetBuildPromise === promise) {
        this.activeTargetBuildPromise = null;
        this.activeTargetBuildAbort = null;
      }
    }
  }

  /**
   * Graceful MCP shutdown boundary: stop admitting builds, cancel the active
   * request, and wait for its exact-child and endpoint cleanup before the
   * shared process guard is closed.
   */
  async closeOwnerScopedTargetBuild(): Promise<void> {
    return this.closeOwnerScopedTargetOperations();
  }

  async closeOwnerScopedTargetOperations(): Promise<void> {
    this.targetBuildClosing = true;
    const active = this.activeTargetBuildPromise;
    this.activeTargetBuildAbort?.abort(
      new Error("The MCP server is shutting down.")
    );
    if (active) await active.catch(() => undefined);
  }

  /**
   * Recover only a replacement-owner state whose native absence is fully
   * provable. This is deliberately narrower than editor launch recovery:
   * wb_build never terminates or reuses a live Workbench.
   *
   * The initial target-less claim is required when a dead MCP left target A
   * busy and the replacement request names target B. Retargeting happens only
   * after process and endpoint vacancy are proven.
   */
  private async reconcileOwnerScopedTargetBuildEntry(
    project: CanonicalProjectIdentity
  ): Promise<void> {
    return this.reconcileOwnerScopedTargetOperationEntry(project, "target build");
  }

  private async reconcileOwnerScopedTargetOperationEntry(
    project: CanonicalProjectIdentity,
    operationName: string
  ): Promise<void> {
    const state = await this.processGuard.withLifecycleLock((session) =>
      this.claimState(session, null)
    );
    await this.recoverUnpublishedSpawn(state, { terminateLive: false });
    if (await this.inspectRecordedWorkbench(state) === "live") {
      throw new WorkbenchError(
        `Owner-scoped ${operationName} refused because an exact Workbench process is still live. ` +
          "Use wb_shutdown for an owned editor or wait for the active lifecycle to finish.",
        "LIFECYCLE_BUSY"
      );
    }
    await this.assertNoWorkbenchProcesses(
      this.processGuard,
      `Owner-scoped ${operationName} recovery`
    );
    await this.waitForPortRelease();
    // Make the final process/endpoint proof and vacant publication under one
    // machine-mutex session. Native state cannot be transactionally locked,
    // but this closes the unlocked proof-to-CAS gap and rejects cooperating
    // lifecycle changes by exact generation and lease.
    await this.processGuard.withLifecycleLock(async (session) => {
      const current = await this.requireReservedLifecycle(session, state);
      await this.assertNoWorkbenchProcesses(
        session,
        `Owner-scoped ${operationName} recovery`
      );
      const vacancy = await session.verifyEndpointVacant({
        host: this.host,
        port: this.port,
      });
      if (vacancy.kind !== "vacant") {
        const detail = vacancy.kind === "occupied"
          ? `listener PID ${vacancy.listenerPid}: ${vacancy.message}`
          : `${vacancy.reason}: ${vacancy.message}`;
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: owner-scoped ${operationName} recovery preserved its busy ` +
            `reservation because final endpoint vacancy was not proven (${detail}).`,
          "RECOVERY_REQUIRED"
        );
      }
      await this.assertNoWorkbenchProcesses(
        session,
        `Owner-scoped ${operationName} recovery`
      );
      await session.transitionToVacant(stateExpected(current), {
        target: toLifecycleTarget(project),
        companion: current.companion,
      });
    });
  }

  static composeLifecycleExecution(
    dependencies: WorkbenchLifecycleExecutionDependencies = {}
  ): WorkbenchLifecycleExecutionPort {
    return new WorkbenchLifecycleExecution(dependencies);
  }

  /** Fail closed when a previous standalone spawn did not cross its durable spawn boundary. */
  static assertStandaloneEntryReady(
    lifecycleExecution: WorkbenchLifecycleExecutionPort
  ): Promise<void> {
    return lifecycleExecution.assertStandaloneEntryReady();
  }

  /** Narrow standalone composition: plan execution uses only the supplied shared port. */
  static composeRunner(
    host: string,
    port: number,
    lifecycleExecution: WorkbenchLifecycleExecutionPort,
    processGuard: WorkbenchProcessGuard = new WorkbenchProcessGuard()
  ): WorkbenchSessionController {
    return new WorkbenchSessionController(
      host,
      port,
      undefined,
      "ReforgerForgeWorkbenchRunner",
      processGuard,
      { lifecycleExecution }
    );
  }

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly config?: Config,
    clientId: string = DEFAULT_CLIENT_ID,
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
    this.netApi = dependencies.netApi ?? new WorkbenchNetApiClient(host, port, { clientId });
    this.companionReadiness = dependencies.companionReadiness ?? awaitCompanionReadiness;
    this.vacancyWait = dependencies.vacancyWait ?? waitForVacancy;
    this.diagnosticsService = dependencies.diagnostics ?? diagnoseWorkbench;
    this.childSupervisor = dependencies.childSupervisor ?? new ChildSupervisor();
    this.runnerLifecycleExecution = dependencies.lifecycleExecution ??
      WorkbenchSessionController.composeLifecycleExecution({
        processGuard: this.processGuard,
        childSupervisor: this.childSupervisor,
        spawnProcess: (command, args, options) =>
          this.spawnProcess!(command, [...args], options),
      });
    const launchTimeout = dependencies.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
    this.launchTimeoutMs = typeof launchTimeout === "function"
      ? launchTimeout
      : () => launchTimeout;
    this.lifecycleDeadlineAtMs = dependencies.lifecycleDeadlineAtMs;
    this.requestDeadlineAtMs = dependencies.requestDeadlineAtMs;
    this.launchPollIntervalMs = dependencies.launchPollIntervalMs ?? LAUNCH_POLL_INTERVAL_MS;
    this.activityGate = dependencies.activityGate ?? new WorkbenchActivityGate({
      restoreTimeoutMs: dependencies.captureRestoreTimeoutMs,
      timing: dependencies.activityGateTiming,
    });
    this.qualificationIntervalMs = dependencies.qualificationIntervalMs ??
      DEFAULT_QUALIFICATION_INTERVAL_MS;
    if (!Number.isFinite(this.qualificationIntervalMs) || this.qualificationIntervalMs < 0) {
      throw new TypeError("Workbench qualification interval must be finite and non-negative.");
    }
    this.now = dependencies.now ?? Date.now;
    this.onExplicitSaveModal = dependencies.onExplicitSaveModal;
  }

  createPlanOwnerCredential(): ReturnType<WorkbenchLifecycleExecutionPort["createOwnerCredential"]> {
    return this.runnerLifecycleExecution.createOwnerCredential();
  }

  async qualifyCompanion(
    context: ForegroundQualificationContext,
    options: CompanionQualificationOptions
  ): Promise<WorkbenchCompanionIdentity> {
    let endpointOwnershipObserved = false;
    try {
      return await this.companionReadiness({
        endpoint: context.endpoint,
        process: context.process,
        companion: context.companion,
        netApi: options.netApi,
        verifyEndpointOwner: async () => {
          const result = await context.verifyEndpointOwner();
          if (result.kind === "owned") endpointOwnershipObserved = true;
          return result;
        },
        attestCompanion: options.attestCompanion,
        deadlineMs: options.deadlineMs,
        pollIntervalMs: options.pollIntervalMs,
        child: context.child,
        signal: options.signal,
      });
    } catch (error) {
      if (!(error instanceof WorkbenchReadinessError)) throw error;
      if (error.code === "ATTESTATION_FAILED" && error.cause instanceof Error) {
        throw error.cause;
      }
      if (error.code === "CHILD_ERROR") {
        const detail = error.cause instanceof Error ? error.cause.message : error.message;
        throw new WorkbenchRunError(
          `Workbench child process reported an error: ${detail}`,
          "SPAWN_FAILED"
        );
      }
      const beforeEndpointOwnership = !endpointOwnershipObserved &&
        (error.code === "ABORTED" || error.code === "CHILD_EXITED" || error.code === "TIMEOUT");
      throw new WorkbenchRunError(
        error.message,
        error.code === "ENDPOINT_UNVERIFIABLE" || beforeEndpointOwnership
          ? "ENDPOINT_UNVERIFIABLE"
          : "IDENTITY_UNVERIFIABLE"
      );
    }
  }

  /** Execute a CLI editor plan while the caller retains log and receipt policy. */
  async runForegroundEditor<Qualification>(
    plan: CliEditorLaunchPlan,
    options: ForegroundRunOptions<Qualification>
  ): Promise<WorkbenchRunResult<Qualification>> {
    return this.activityGate.runLifecycle(
      "CLI foreground editor",
      () => this.runForegroundEditorExclusive(plan, options),
      { signal: options.signal }
    );
  }

  private async runForegroundEditorExclusive<Qualification>(
    plan: CliEditorLaunchPlan,
    options: ForegroundRunOptions<Qualification>
  ): Promise<WorkbenchRunResult<Qualification>> {
    if (plan.kind !== "cli_editor" || plan.readiness.kind !== "companion_net_api") {
      throw new WorkbenchRunError(
        "Foreground editor execution requires one qualified cli_editor launch plan.",
        "INCOMPLETE_PROOF"
      );
    }
    const execution = this.runnerLifecycleExecution;
    const endpoint = { ...plan.readiness.endpoint };
    const terminationTimeoutMs = options.terminationTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    const recoveryTimeoutMs = options.recoveryTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    await execution.assertSpawnJournalReplaceable();
    await execution.assertNoWorkbenchBeforeReservation("Workbench CLI editor reservation");
    await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench CLI editor reservation");
    let lifecycle = await execution.reserve({
      endpoint,
      target: plan.lifecycleTarget,
      companion: plan.helper,
    });
    let supervised: WorkbenchLifecycleSupervisedChild | null = null;
    let identity: WorkbenchIdentity | null = null;
    let qualification: Qualification | undefined;
    let qualified = false;
    let lifecycleGeneration: string | null = null;
    let reason: WorkbenchForegroundExitReason | null = null;
    let exit: SupervisedChildExit | null = null;
    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    let absenceProven = false;
    let endpointVacant = false;

    try {
      if (options.signal?.aborted) {
        throw new WorkbenchRunError("Workbench CLI editor run was aborted before spawn.", "ABORTED");
      }
      await execution.assertNoWorkbenchProcesses();
      options.beforeFinalVacancyCheck?.();
      await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench CLI editor spawn");
      const spawned = await execution.spawnRecoverable({
        lifecycle,
        purpose: "cli_editor",
        executablePath: plan.executablePath,
        launchArguments: plan.argv,
        spawnOptions: plan.spawnOptions,
        ownerArgument: plan.ownerArgument,
        launchedAtMs: Date.now(),
        beforeSpawn: options.beforeSpawn,
        onSupervisedChild: (observed) => { supervised = observed; },
      });
      supervised = spawned.supervisedChild;
      identity = spawned.identity;
      lifecycle = spawned.lifecycle;
      qualification = await options.qualify({
        endpoint,
        process: identity,
        companion: plan.helper,
        child: supervised.handle,
        verifyEndpointOwner: () => execution.verifyEndpointOwner(endpoint, identity!),
      });
      qualified = true;
      lifecycle = await execution.transition(lifecycle, {
        phase: "running",
        workbench: identity,
        companion: companionLifecycleState(plan.helper),
        operation: null,
      });
      lifecycleGeneration = lifecycle.generation;
      const completion = await execution.waitForExitOrControl({
        child: supervised.handle,
        timeoutMs: null,
        signal: options.signal,
      });
      if (completion.reason === "child_error") throw completion.error;
      if (completion.reason === "exited") {
        reason = "exited";
        exit = completion.exit;
      } else {
        reason = completion.reason;
      }
    } catch (error) {
      primaryError = error;
    }

    try {
      if (lifecycle.phase !== "vacant") {
        lifecycle = await execution.transition(lifecycle, {
          phase: "stopping",
          workbench: identity,
          operation: { kind: "shutdown", operationId: randomUUID() },
        });
      }
    } catch (error) {
      cleanupError = error;
    }
    if (supervised) {
      const absence = await execution.ensureExactChildAbsent({
        identity,
        child: supervised.handle,
        timeoutMs: terminationTimeoutMs,
        recoveryTimeoutMs,
      });
      exit ??= absence.exit;
      cleanupError ??= absence.error ?? null;
      absenceProven = absence.absent;
      execution.releaseAbsentSupervisedChild(supervised, absenceProven);
    } else {
      try {
        await execution.assertNoWorkbenchProcesses();
        absenceProven = true;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (absenceProven) {
      try {
        await this.waitForRunEndpointVacancy(
          execution,
          endpoint,
          "Workbench CLI editor",
          recoveryTimeoutMs
        );
        endpointVacant = true;
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (absenceProven && endpointVacant) {
      try {
        lifecycle = await execution.vacate(lifecycle, {
          endpoint,
          target: plan.lifecycleTarget,
          companion: companionLifecycleState(plan.helper),
        });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
    if (primaryError) throw primaryError;
    if (!identity || !supervised || !qualified || !lifecycleGeneration ||
        !reason || !exit || !absenceProven || !endpointVacant) {
      throw new WorkbenchRunError(
        "Workbench CLI editor completed without a fully identity-bound proof.",
        "INCOMPLETE_PROOF"
      );
    }
    return Object.freeze({
      planKind: "cli_editor" as const,
      process: Object.freeze({ ...identity }),
      lifecycleGeneration,
      qualification: qualification as Qualification,
      endpointVacancy: "verified" as const,
      exitStatus: Object.freeze({
        reason,
        exitCode: exit.code,
        signal: exit.signal,
        timedOut: false,
      }),
    });
  }

  /** Execute one helper-free target plan with the final output proof inside the spawn cut. */
  async runTargetBuild<Snapshot>(
    plan: TargetBuildLaunchPlan,
    reservation: WorkbenchBuildOutputReservation<Snapshot>,
    options: BoundedRunOptions
  ): Promise<WorkbenchTargetBuildRunResult<Snapshot>> {
    return this.activityGate.runLifecycle(
      "target build",
      async () => {
        if (pathKey(reservation.root) !== pathKey(plan.outputPath)) {
          throw new WorkbenchRunError(
            "Target build output reservation does not match the launch plan output.",
            "INCOMPLETE_PROOF"
          );
        }
        const run = await this.runBoundedTargetOperationExclusive(
          plan,
          options,
          {
            beforeReservation: () => { reservation.assertStillReservedAndSnapshot(); },
            afterReservation: () => { reservation.assertStillReservedAndSnapshot(); },
            captureBeforeSpawn: () => reservation.assertStillReservedAndSnapshot(),
          }
        );
        return Object.freeze({
          ...run,
          planKind: "target_build" as const,
          beforeOutput: run.beforeSpawnSnapshot,
        });
      },
      { signal: options.signal }
    );
  }

  /** Execute one helper-free compile-only check through the same bounded lifecycle cut. */
  async runTargetCheck(
    plan: TargetCheckLaunchPlan,
    options: BoundedRunOptions
  ): Promise<WorkbenchTargetCheckRunResult> {
    return this.activityGate.runLifecycle(
      "Enforce Script check",
      async () => {
        const run = await this.runBoundedTargetOperationExclusive(
          plan,
          options,
          { captureBeforeSpawn: () => undefined }
        );
        return Object.freeze({
          planKind: "target_check" as const,
          process: run.process,
          lifecycleGeneration: run.lifecycleGeneration,
          qualification: null,
          endpointVacancy: run.endpointVacancy,
          exitStatus: run.exitStatus,
        });
      },
      { signal: options.signal }
    );
  }

  private async runBoundedTargetOperationExclusive<Snapshot>(
    plan: BoundedTargetLaunchPlan,
    options: BoundedRunOptions,
    hooks: BoundedTargetHooks<Snapshot>
  ): Promise<WorkbenchRunResult<null> & { readonly beforeSpawnSnapshot: Snapshot }> {
    if (!(["target_build", "target_check"] as const).includes(plan.kind) ||
        plan.helper !== null || plan.readiness.kind !== "none") {
      throw new WorkbenchRunError(
        "Bounded target execution requires one helper-free target launch plan.",
        "INCOMPLETE_PROOF"
      );
    }
    if (!Number.isFinite(options.deadlineMs)) {
      throw new TypeError("Bounded target-operation absolute deadline must be finite.");
    }
    const operationName = plan.kind === "target_build" ? "target build" : "Enforce Script check";
    const execution = this.runnerLifecycleExecution;
    const endpoint = { host: this.host, port: this.port };
    const terminationTimeoutMs = options.terminationTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    const recoveryTimeoutMs = options.recoveryTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    await execution.assertSpawnJournalReplaceable();
    await execution.assertNoWorkbenchBeforeReservation(`Workbench ${operationName} reservation`);
    await execution.assertEndpointVacantBeforeSpawn(endpoint, `Workbench ${operationName} reservation`);
    hooks.beforeReservation?.();
    let lifecycle = await execution.reserve({
      endpoint,
      target: plan.lifecycleTarget,
      companion: null,
    });
    const reservedCompanion = lifecycle.companion;
    // The claim is the serialization point. A failed immediate recheck owns
    // enough durable authority to return the child-free reservation to vacant.
    try {
      hooks.afterReservation?.();
    } catch (error) {
      await execution.vacate(lifecycle, {
        endpoint,
        target: plan.lifecycleTarget,
        companion: reservedCompanion,
      });
      throw error;
    }
    let supervised: WorkbenchLifecycleSupervisedChild | null = null;
    let identity: WorkbenchIdentity | null = null;
    let lifecycleGeneration: string | null = null;
    let beforeSpawnSnapshot!: Snapshot;
    let snapshotCaptured = false;
    let reason: WorkbenchForegroundExitReason | null = null;
    let exit: SupervisedChildExit | null = null;
    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    let absenceProven = false;
    let endpointVacant = false;

    try {
      this.assertBoundedRunCanContinue(options, operationName, "before spawn");
      await execution.assertNoWorkbenchProcesses();
      options.beforeFinalVacancyCheck?.();
      await execution.assertEndpointVacantBeforeSpawn(endpoint, `Workbench ${operationName} spawn`);
      const spawned = await execution.spawnRecoverable({
        lifecycle,
        purpose: plan.kind,
        executablePath: plan.executablePath,
        launchArguments: plan.argv,
        spawnOptions: plan.spawnOptions,
        ownerArgument: plan.ownerArgument,
        launchedAtMs: Date.now(),
        beforeSpawn: () => {
          this.assertBoundedRunCanContinue(options, operationName, "immediately before spawn");
          options.beforeSpawn?.();
          beforeSpawnSnapshot = hooks.captureBeforeSpawn();
          snapshotCaptured = true;
        },
        onSupervisedChild: (observed) => { supervised = observed; },
      });
      supervised = spawned.supervisedChild;
      identity = spawned.identity;
      lifecycle = spawned.lifecycle;
      // A target-only process never advertises companion readiness. Its
      // identity-bound starting state remains the durable busy state until it
      // advances to stopping.
      lifecycleGeneration = lifecycle.generation;
      const completion = await execution.waitForExitOrControl({
        child: supervised.handle,
        timeoutMs: Math.max(1, options.deadlineMs - Date.now()),
        signal: options.signal,
      });
      if (completion.reason === "child_error") throw completion.error;
      if (completion.reason === "exited") {
        reason = "exited";
        exit = completion.exit;
      } else {
        reason = completion.reason;
      }
    } catch (error) {
      primaryError = error;
    }

    try {
      if (lifecycle.phase !== "vacant") {
        lifecycle = await execution.transition(lifecycle, {
          phase: "stopping",
          workbench: identity,
          operation: { kind: "shutdown", operationId: randomUUID() },
        });
      }
    } catch (error) {
      cleanupError = error;
    }
    if (supervised) {
      const absence = await execution.ensureExactChildAbsent({
        identity,
        child: supervised.handle,
        timeoutMs: terminationTimeoutMs,
        recoveryTimeoutMs,
      });
      exit ??= absence.exit;
      cleanupError ??= absence.error ?? null;
      absenceProven = absence.absent;
      execution.releaseAbsentSupervisedChild(supervised, absenceProven);
    } else {
      try {
        await execution.assertNoWorkbenchProcesses();
        absenceProven = true;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (absenceProven) {
      try {
        await this.waitForRunEndpointVacancy(
          execution,
          endpoint,
          `Workbench ${operationName}`,
          recoveryTimeoutMs
        );
        endpointVacant = true;
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (absenceProven && endpointVacant) {
      try {
        lifecycle = await execution.vacate(lifecycle, {
          endpoint,
          target: plan.lifecycleTarget,
          companion: reservedCompanion,
        });
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
    if (primaryError) throw primaryError;
    if (!identity || !supervised || !lifecycleGeneration || !snapshotCaptured ||
        !reason || !exit || !absenceProven || !endpointVacant) {
      throw new WorkbenchRunError(
        `Workbench ${operationName} completed without a fully identity-bound process proof.`,
        "INCOMPLETE_PROOF"
      );
    }
    return Object.freeze({
      planKind: plan.kind,
      process: Object.freeze({ ...identity }),
      lifecycleGeneration,
      qualification: null,
      beforeSpawnSnapshot,
      endpointVacancy: "verified" as const,
      exitStatus: Object.freeze({
        reason,
        exitCode: exit.code,
        signal: exit.signal,
        timedOut: reason === "timed_out",
      }),
    });
  }

  private async waitForRunEndpointVacancy(
    execution: WorkbenchLifecycleExecutionPort,
    endpoint: Readonly<{ host: string; port: number }>,
    context: string,
    timeoutMs: number
  ): Promise<void> {
    const boundedTimeoutMs = Math.max(1, timeoutMs);
    try {
      await this.vacancyWait({
        verify: (candidate) => execution.verifyEndpointVacant(candidate),
        endpoint,
        deadlineMs: Date.now() + boundedTimeoutMs,
        pollIntervalMs: Math.max(
          1,
          Math.min(PORT_RELEASE_POLL_MS, Math.floor(boundedTimeoutMs / 4))
        ),
      });
    } catch (error) {
      throw new WorkbenchRunError(
        `${context} endpoint vacancy was not proven after exact process absence: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "ENDPOINT_UNVERIFIABLE"
      );
    }
  }

  private assertBoundedRunCanContinue(
    options: BoundedRunOptions,
    operationName: string,
    stage: string
  ): void {
    if (options.signal?.aborted) {
      throw new WorkbenchRunError(`Workbench ${operationName} was aborted ${stage}.`, "ABORTED");
    }
    if (Date.now() >= options.deadlineMs) {
      throw new WorkbenchRunError(
        `Workbench ${operationName} deadline expired ${stage}.`,
        "DEADLINE_EXCEEDED"
      );
    }
  }

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    this.assertCallDoesNotBreakExplicitResourceBinding(apiFunc, params);
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

  /**
   * Save only the exact .ent or .et supplied at fresh Workbench startup. This never
   * falls back to a generic session or auto-launches after a transport error.
   */
  async saveResource(expectedPath: string): Promise<WorkbenchSaveResourceResult> {
    let binding: ExplicitResourceSessionBinding;
    try {
      binding = await this.requireExplicitResourceSession(expectedPath);
      this.assertExplicitResourceWritable(binding.resource);
      revalidateProjectIdentity(binding.project);
      revalidateResourceTarget(binding.resource, binding.project);
      if (extname(binding.resource.displayPath).toLowerCase() === ".et") {
        const emptyOverrides = findExplicitEmptyPrefabOverrides(
          readFileSync(binding.resource.displayPath, "utf8")
        );
        if (emptyOverrides.length > 0) {
          const listed = emptyOverrides.slice(0, 5).map((path) => `\`${path}\``).join(", ");
          const extra = emptyOverrides.length > 5
            ? ` and ${emptyOverrides.length - 5} more`
            : "";
          this.taintExplicitResourceSession(
            "The target contains explicit empty inherited-prefab overrides that native SaveEntityTemplate may discard."
          );
          throw new WorkbenchError(
            "Explicit save refused before invoking Workbench because the inherited prefab contains " +
              `load-bearing empty override block(s): ${listed}${extra}. Preserve these overrides with a ` +
              "minimal direct prefab edit, then relaunch the exact target.",
            "TARGET_SESSION_TAINTED"
          );
        }
      }
      await this.processGuard.verifyExactProcessArguments(
        binding.process,
        explicitResourceLaunchArguments(binding.resource)
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }

    const before = this.snapshotExplicitResourceBundle(binding.resource);
    const watchdog = new WorkbenchModalWatchdog({
      inspect: () => this.processGuard.inspectExactWindows(binding.process),
      close: (window) => this.processGuard.closeExactWindow(binding.process, window),
    });
    let baseline: readonly WorkbenchWindow[];
    try {
      baseline = await watchdog.snapshot();
      const existingDialog = findOwnedNativeDialog(baseline);
      const disabledMain = baseline.find((window) => window.ownerHandle === "0" && !window.enabled);
      if (existingDialog || disabledMain) {
        throw new WorkbenchError(
          "Explicit save refused because the target-bound Workbench already has a native dialog or disabled main window.",
          "SAVE_OUTCOME_UNCERTAIN"
        );
      }
    } catch (error) {
      this.taintExplicitResourceSession(
        `The native-dialog preflight could not prove an interactive-free save state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw this.mapLifecycleError(error);
    }

    const watchAbort = new AbortController();
    // Start native-dialog observation before the NET request is dispatched.
    // The async watchdog immediately begins exact-process inspection before its
    // first await, while the subsequent managed call performs the dispatch.
    const modalOutcome = watchdog.waitForNewModal(baseline, watchAbort.signal).then(
      (evidence) => ({ kind: "modal" as const, evidence }),
      (error: unknown) => ({ kind: "watchdog_error" as const, error })
    );
    const saveResult = this.callManagedAndCache<Record<string, unknown>>(
      "EMCP_WB_ExplicitResourceSave",
      { action: "save", expectedPath: binding.resource.displayPath },
      { timeout: 45_000, skipAutoLaunch: true }
    );
    const saveOutcome = saveResult.then(
      (result) => ({ kind: "save_result" as const, result }),
      (error: unknown) => ({ kind: "save_error" as const, error })
    );
    let firstOutcome = await Promise.race([saveOutcome, modalOutcome]);
    watchAbort.abort();
    if (firstOutcome.kind === "save_result" || firstOutcome.kind === "save_error") {
      const watcherAfterSave = await modalOutcome;
      // Promise.race may choose a save response when a native-dialog result is
      // already queued in the same turn. Never discard that evidence.
      if (watcherAfterSave.kind === "watchdog_error" ||
          (watcherAfterSave.kind === "modal" && watcherAfterSave.evidence !== null)) {
        firstOutcome = watcherAfterSave;
      }
    }

    if (firstOutcome.kind === "watchdog_error") {
      await Promise.race([
        saveOutcome,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), EXPLICIT_SAVE_MODAL_SETTLE_MS)),
      ]);
      await watchdog.snapshot().catch(() => []);
      this.taintExplicitResourceSession(
        `Native-dialog monitoring failed while the save request was in flight: ${
          firstOutcome.error instanceof Error ? firstOutcome.error.message : String(firstOutcome.error)
        }`
      );
      throw new WorkbenchError(
        "Explicit save outcome is uncertain because native-dialog monitoring failed. Shut down and relaunch the target.",
        "SAVE_OUTCOME_UNCERTAIN"
      );
    }
    if (firstOutcome.kind === "modal") {
      // A posted WM_CLOSE is asynchronous. Give the NET handler a short,
      // bounded opportunity to unwind, then inspect again before returning an
      // uncertainty. This does not turn a later "ok" response into success.
      await Promise.race([
        saveOutcome,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), EXPLICIT_SAVE_MODAL_SETTLE_MS)),
      ]);
      await watchdog.snapshot().catch(() => []);
      const evidence = firstOutcome.evidence;
      if (evidence !== null) {
        try {
          this.onExplicitSaveModal?.(evidence);
        } catch (error) {
          logger.warn(
            "Explicit-save native-dialog observation hook failed:",
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      const detail = evidence === null
        ? "the monitor stopped before the save response completed"
        : this.describeNativeDialogEvidence(evidence);
      this.taintExplicitResourceSession(`Native dialog evidence was observed during explicit save: ${detail}`);
      throw new WorkbenchError(
        "Explicit save outcome is uncertain because Workbench requested native user feedback (" + detail + "). " +
          "The target session is tainted; shut it down and relaunch the explicit target before any further save.",
        "SAVE_OUTCOME_UNCERTAIN"
      );
    }
    if (firstOutcome.kind === "save_error") {
      const cause = firstOutcome.error instanceof Error
        ? firstOutcome.error.message
        : String(firstOutcome.error);
      this.taintExplicitResourceSession(
        `The save request did not complete with a trusted result: ${cause}`
      );
      throw new WorkbenchError(
        "Explicit save outcome is uncertain because Workbench did not return a trusted completion result. " +
          `Cause: ${cause}. Shut down and relaunch the target before any further save.`,
        "SAVE_OUTCOME_UNCERTAIN"
      );
    }

    try {
      const result = firstOutcome.result;
      if (result.status !== "ok") {
        this.taintExplicitResourceSession("The explicit resource save handler did not confirm a completed save.");
        throw new WorkbenchError(
          typeof result.message === "string" && result.message.length > 0
            ? result.message
            : "Workbench did not confirm the explicit resource save.",
          "SAVE_OUTCOME_UNCERTAIN"
        );
      }
      if (result.startupLoadPath !== binding.resource.displayPath) {
        this.taintExplicitResourceSession("The helper startup target attestation changed during save.");
        throw new WorkbenchError(
          "Explicit resource save refused because Workbench no longer attested the expected startup target.",
          "SAVE_OUTCOME_UNCERTAIN"
        );
      }
    } catch (error) {
      this.taintExplicitResourceSession(
        `The save request did not complete with a trusted result: ${error instanceof Error ? error.message : String(error)}`
      );
      throw this.mapLifecycleError(error);
    }

    try {
      revalidateProjectIdentity(binding.project);
      const current = revalidateResourceTarget(binding.resource, binding.project);
      const after = this.snapshotExplicitResourceBundle(current);
      const changedPaths = changedBundlePaths(before, after);
      return Object.freeze({
        resourcePath: current.displayPath,
        startupLoadPath: binding.resource.displayPath,
        outcome: changedPaths.length > 0 ? "changed" : "no_change",
        changedPaths: Object.freeze(changedPaths),
      });
    } catch (error) {
      this.taintExplicitResourceSession(
        `The target bundle could not be revalidated after save: ${error instanceof Error ? error.message : String(error)}`
      );
      throw this.mapLifecycleError(error);
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
        response.workbenchProtocol === WORKBENCH_HELPER_PROTOCOL_VERSION &&
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
      return await this.activityGate.runManaged("observer capture qualification", async () => {
        const authority = await this.readManagedRunningAuthoritySnapshot("observer capture", false);
        const snapshot = await this.validateManagedAuthority(authority, "observer capture", true);
        const current = await this.readManagedRunningAuthoritySnapshot("observer capture", false);
        if (!this.sameManagedAuthority(authority, current)) {
          throw new WorkbenchError(
            "RECOVERY_REQUIRED: Workbench changed during observer snapshot qualification.",
            "RECOVERY_REQUIRED"
          );
        }
        return snapshot;
      });
    } catch (error) {
      // Observer qualification is deliberately exact rather than cacheable.
      // Any authority, identity, transport, or attestation failure invalidates
      // both process qualification and immutable companion attestation proof.
      this.invalidateQualification();
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

  /**
   * Convert an unprovable capture restoration into an exact-owner-exit seal.
   * Only `shutdownOwnedWorkbench` can cross the local activity gate afterward.
   */
  requireExactOwnerExit(lease: WorkbenchCaptureActivityLease): void {
    try {
      this.activityGate.requireExactOwnerExit(lease);
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  /** Count-only lifecycle evidence; no PID, owner token, or process handle is exposed. */
  diagnosticSupervisedChildCounts(): SupervisedChildCounts {
    return this.childSupervisor.counts();
  }

  /** Return the exact lifecycle lease and generation for the running target. */
  async lifecycleIdentity(): Promise<{ readonly lifecycleId: string; readonly generation: string }> {
    const read = await this.processGuard.readLifecycleState();
    if (read.kind !== "valid" || read.state.phase !== "running" || !read.state.mcpOwner || !read.state.workbench) {
      throw new WorkbenchError(
        "Workbench lifecycle is not currently running with an exact owner.",
        "STATE_INVALID"
      );
    }
    return Object.freeze({
      lifecycleId: read.state.mcpOwner.leaseId,
      generation: read.state.generation,
    });
  }

  /**
   * Return the exact project of the currently running owned Workbench.
   *
   * Add-on authoring tools use this as their implicit target. A remembered
   * target in a vacant lifecycle is intentionally not treated as active.
   */
  async activeProjectGprojPath(): Promise<string | null> {
    const read = await this.processGuard.readLifecycleState();
    if (
      read.kind !== "valid" ||
      read.state.phase !== "running" ||
      !read.state.workbench ||
      !read.state.target
    ) {
      return null;
    }
    try {
      return canonicalizeGproj(read.state.target.path).displayPath;
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async ensureRunning(gprojPath?: string): Promise<WorkbenchLaunchResult> {
    this.requireConfig("auto-launch");
    const project = await this.resolveLifecycleProject(gprojPath);
    try {
      return await this.coordinateLifecycle("launch", project.comparisonKey, (operationId) =>
        this.activityGate.runLifecycle("launch", async () =>
          this.ensureRunningCoordinated(revalidateProjectIdentity(project), operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  /**
   * Start a fresh MCP-owned Workbench directly on one .ent resource. A running
   * generic or differently-bound editor is intentionally never adopted: there
   * is no active-document API with which to prove a safe transition.
   */
  async ensureTargetResourceRunning(
    gprojPath: string,
    resourcePath: string
  ): Promise<WorkbenchTargetResourceLaunchResult> {
    this.requireConfig("target-bound launch");
    let project: CanonicalProjectIdentity;
    let resource: CanonicalResourceTarget;
    try {
      project = canonicalizeGproj(gprojPath);
      resource = canonicalizeResourceTarget(resourcePath, project);
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
    try {
      return await this.coordinateLifecycle("launch", project.comparisonKey, (operationId) =>
        this.activityGate.runLifecycle("target-bound launch", async () =>
          this.ensureTargetResourceRunningCoordinated(
            revalidateProjectIdentity(project),
            revalidateResourceTarget(resource, project),
            operationId
          )
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async restartOwnedWorkbench(): Promise<WorkbenchRestartResult> {
    this.requireConfig("restart");
    this.clearExplicitResourceSession();
    const project = await this.resolveLifecycleProject();
    try {
      return await this.coordinateLifecycle("restart", project.comparisonKey, (operationId) =>
        this.activityGate.runLifecycle("restart", async () =>
          this.restartCoordinated(revalidateProjectIdentity(project), operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async shutdownOwnedWorkbench(): Promise<WorkbenchShutdownResult> {
    this.requireConfig("shutdown");
    this.clearExplicitResourceSession();
    try {
      const read = await this.processGuard.readLifecycleState();
      const targetKey = read.kind === "valid" ? read.state.target?.comparisonKey ?? null : null;
      return await this.coordinateLifecycle("shutdown", targetKey, (operationId) =>
        this.activityGate.runOwnedShutdown(async (requiredBinding) =>
          this.shutdownCoordinated(operationId, requiredBinding)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async diagnose(): Promise<DiagnosticReport> {
    const report = await this.diagnosticsService({
      host: this.host,
      port: this.port,
      config: this.config,
      lifecycle: this.processGuard,
      callNetApi: (apiFunc, params, options) => this.rawCall(apiFunc, params, options),
      classifyNetError: (error) => error instanceof WorkbenchError ? error : null,
    });
    return this.lastLaunchCompileFailure
      ? { ...report, lastLaunchFailure: this.lastLaunchCompileFailure }
      : report;
  }

  toString(): string {
    return `WorkbenchSessionController(${this.host}:${this.port})`;
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
      this.invalidateQualification();
      return await this.activityGate.runLifecycle("companion setup", async () => {
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
            "Workbench companion setup",
            true
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
      this.invalidateQualification();
      return await this.activityGate.runLifecycle("companion retention", async () => {
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
      this.invalidateQualification();
      return await this.activityGate.runLifecycle("companion uninstall", async () => {
        const operationId = randomUUID();
        const reservation = await this.processGuard.withLifecycleLock(async (session) => {
          await session.assertNoWorkbenchProcesses();
          const current = await session.readState();
          if (current.kind === "valid" && current.state.phase !== "vacant") {
            throw new WorkbenchError(
              `Workbench companion uninstall requires a vacant lifecycle; current phase is ${current.state.phase}.`,
              "LIFECYCLE_BUSY"
            );
          }
          const endpoint = current.kind === "valid"
            ? current.state.endpoint
            : { host: this.host.trim().toLowerCase(), port: this.port };
          const claim = await session.validateAndClaim({
            endpoint,
            target: current.kind === "valid" ? current.state.target : null,
          });
          if (claim.kind === "refused") throw this.claimRefusal(claim);
          const claimed = claim.state;
          if (claimed.phase !== "vacant" || claimed.workbench !== null ||
              claimed.operation !== null) {
            throw new WorkbenchError(
              `Workbench companion uninstall requires a vacant lifecycle; current phase is ` +
                `${claimed.phase}.`,
              "LIFECYCLE_BUSY"
            );
          }
          return session.transition(
            stateExpected(claimed),
            stateDraft(claimed, {
              phase: "starting",
              workbench: null,
              operation: { kind: "recovery", operationId },
            })
          );
        });

        // Filesystem deletion is deliberately outside the machine mutex, but
        // the durable busy reservation above prevents another cooperating MCP
        // from claiming or spawning while deletion is in flight.
        let result: WorkbenchCompanionUninstallResult;
        try {
          result = this.companionProvider!.uninstall!();
        } catch (error) {
          throw new WorkbenchError(
            `RECOVERY_REQUIRED: managed companion deletion failed after lifecycle reservation ` +
              `${operationId}: ${error instanceof Error ? error.message : String(error)}. ` +
              "The durable reservation was preserved for attended recovery.",
            "RECOVERY_REQUIRED"
          );
        }
        await this.processGuard.withLifecycleLock(async (session) => {
          await session.assertNoWorkbenchProcesses();
          const current = await this.requireReservedLifecycle(session, reservation);
          if (current.phase !== "starting" || current.operation?.kind !== "recovery" ||
              current.operation.operationId !== operationId) {
            throw new WorkbenchError(
              "RECOVERY_REQUIRED: companion uninstall reservation changed before final publication.",
              "RECOVERY_REQUIRED"
            );
          }
          await session.transitionToVacant(stateExpected(current), {
            target: current.target,
            companion: null,
          });
        });
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
        const authority = await this.readManagedRunningAuthoritySnapshot(context, true);

        // Network I/O, exact-process probing, target resolution, and immutable
        // companion hashing happen without monopolizing the machine mutex.
        const snapshot = await this.validateManagedAuthority(authority, context);
        // Treat the NET result as provisional until the exact lifecycle CAS
        // below proves that its generation and owner are still authoritative.
        const result = await this.rawCall<T>(apiFunc, params, options);

        // A bounded atomic post-call snapshot makes a cross-process generation
        // or owner change stale without taking the machine-wide mutex.
        const current = await this.readManagedRunningAuthoritySnapshot(context, true);
        if (!this.sameManagedAuthority(authority, current)) {
          throw new WorkbenchError(
            "RECOVERY_REQUIRED: Workbench lifecycle generation or exact owner changed during " +
              `managed call ${apiFunc}; stale state publication was refused.`,
            "RECOVERY_REQUIRED"
          );
        }
        this._state.connected = true;
        this._state.lastUpdated = Date.now();
        this.extractMode(result);
        this.attestRecordedCompanion(snapshot);
        return result;
      });
    } catch (error) {
      // A managed-call failure makes the process/endpoint/Ping proof stale,
      // including transport and companion-identity failures.
      this.invalidateQualification();
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
    return this.managedRunningAuthorityFromRead(read, session.mcp, context, unavailableWhenVacant);
  }

  private async readManagedRunningAuthoritySnapshot(
    context: string,
    unavailableWhenVacant: boolean
  ): Promise<ManagedRunningAuthority> {
    const [read, current] = await Promise.all([
      this.processGuard.readLifecycleState(),
      this.processGuard.currentMcpOwnerIdentity(),
    ]);
    return this.managedRunningAuthorityFromRead(read, current, context, unavailableWhenVacant);
  }

  private managedRunningAuthorityFromRead(
    read: LifecycleStateRead,
    current: McpOwnerIdentity,
    context: string,
    unavailableWhenVacant: boolean
  ): ManagedRunningAuthority {
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
    context: string,
    forceQualification = false
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
    const cached = this.qualificationCache;
    const cachedAgeMs = cached ? this.now() - cached.qualifiedAtMs : Number.POSITIVE_INFINITY;
    if (!forceQualification && cached &&
        this.qualificationIntervalMs > 0 && cachedAgeMs >= 0 &&
        this.sameManagedAuthority(cached.authority, authority) &&
        cachedAgeMs <= this.qualificationIntervalMs) {
      return snapshot;
    }
    try {
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
    } catch (error) {
      this.invalidateQualification();
      throw error;
    }
    this.attestRecordedCompanion(snapshot);
    this.qualificationCache = { authority, qualifiedAtMs: this.now() };
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
      this.invalidateQualification();
      throw new WorkbenchError(
        "Managed Workbench calls require a companion provider that can re-attest staged payload hashes.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    // The immutable filesystem attestation cache is intentionally narrower
    // than the complete process/endpoint qualification cache. A lifecycle CAS
    // changes generation; within one generation the bundle digest is the
    // content-addressed staged payload identity.
    const attestationKey = JSON.stringify([
      snapshot.generation,
      snapshot.companion.bundleDigest,
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
      this.invalidateQualification();
      throw new WorkbenchError(
        `Managed Workbench companion attestation failed: ${error instanceof Error ? error.message : String(error)}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
  }

  private resetConnectionState(): void {
    this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
    this.invalidateQualification();
    this.clearExplicitResourceSession();
  }

  private clearExplicitResourceSession(): void {
    this.explicitResourceSession = null;
  }

  private taintExplicitResourceSession(reason: string): void {
    if (this.explicitResourceSession) this.explicitResourceSession.taintedReason = reason;
  }

  private assertCallDoesNotBreakExplicitResourceBinding(
    apiFunc: string,
    params: Record<string, unknown>
  ): void {
    const binding = this.explicitResourceSession;
    if (!binding) return;
    if (apiFunc === "EMCP_WB_ExplicitResourceSave") {
      throw new WorkbenchError(
        "Target-bound save requests must use wb_save_resource so the startup binding and disk evidence are verified.",
        "TARGET_SESSION_REQUIRED"
      );
    }
    const documentSwitch = (apiFunc === "EMCP_WB_EditorControl" && params.action === "openResource") ||
      (apiFunc === "EMCP_WB_Resources" && params.action === "open") ||
      (apiFunc === "EMCP_WB_ScriptEditor" && params.action === "openFile");
    if (!documentSwitch) return;
    this.taintExplicitResourceSession(
      "A programmatic resource-open request was attempted after the explicit target session was created."
    );
    throw new WorkbenchError(
      "TARGET_SESSION_TAINTED: resource-opening tools are unavailable in a target-bound save session because they could " +
        "switch the document away from the startup target. Shut down and launch the desired explicit .ent instead.",
      "TARGET_SESSION_TAINTED"
    );
  }

  private describeNativeDialogEvidence(evidence: WorkbenchModalEvidence): string {
    if (evidence.kind === "disabled_main_window") {
      return "the target Workbench main window became disabled without a safely closable owned dialog";
    }
    const dialogKind = evidence.kind === "standalone_modal"
      ? "newly visible standalone native dialog"
      : "newly visible owned native dialog";
    if (evidence.dismissed) {
      return `a ${dialogKind} was detected, its close request was posted, and the dialog disappeared`;
    }
    return evidence.closeError
      ? `a ${dialogKind} was detected but its close request failed`
      : evidence.closePosted
        ? `a ${dialogKind} was detected and its close request was posted, but dismissal was not confirmed`
        : `a ${dialogKind} was detected but its close request could not be posted`;
  }

  private async requireExplicitResourceSession(
    expectedPath: string
  ): Promise<ExplicitResourceSessionBinding> {
    const binding = this.explicitResourceSession;
    if (!binding) {
      throw new WorkbenchError(
        "TARGET_SESSION_REQUIRED: start a fresh Workbench with wb_launch { gprojPath, resourcePath } before saving.",
        "TARGET_SESSION_REQUIRED"
      );
    }
    if (binding.taintedReason) {
      throw new WorkbenchError(
        `TARGET_SESSION_TAINTED: ${binding.taintedReason} Shut down and relaunch the explicit target before saving.`,
        "TARGET_SESSION_TAINTED"
      );
    }
    const expected = canonicalizeResourceTarget(expectedPath, binding.project);
    if (expected.comparisonKey !== binding.resource.comparisonKey ||
        expected.metaComparisonKey !== binding.resource.metaComparisonKey) {
      throw new WorkbenchError(
        "TARGET_SESSION_REQUIRED: the requested save path does not match the resource supplied at Workbench startup.",
        "TARGET_SESSION_REQUIRED"
      );
    }
    const authority = await this.readManagedRunningAuthoritySnapshot(
      "explicit resource save qualification",
      true
    );
    if (!authority.state.workbench || authority.state.generation !== binding.generation ||
        authority.state.target?.comparisonKey !== binding.project.comparisonKey ||
        !sameWorkbenchIdentity(authority.state.workbench, binding.process)) {
      this.clearExplicitResourceSession();
      throw new WorkbenchError(
        "TARGET_SESSION_REQUIRED: the exact target-bound Workbench process or lifecycle generation changed.",
        "TARGET_SESSION_REQUIRED"
      );
    }
    return binding;
  }

  private assertExplicitResourceWritable(resource: CanonicalResourceTarget): void {
    const assertWritable = (path: string, label: string): void => {
      let info;
      try {
        info = statSync(path);
        if ((info.mode & 0o222) === 0) {
          throw new Error("read-only mode bits");
        }
        accessSync(path, fsConstants.W_OK);
      } catch (error) {
        throw new WorkbenchError(
          `Explicit save refused because ${label} is not writable: ${path} ` +
            `(${error instanceof Error ? error.message : String(error)}).`,
          "INVALID_TARGET"
        );
      }
    };
    assertWritable(resource.displayPath, "the target resource");
    assertWritable(dirname(resource.displayPath), "the target resource directory");
    this.visitExplicitResourceBundle(resource, (path) => {
      if (path !== resource.displayPath && path !== resource.metaPath) {
        assertWritable(path, "a target resource layer");
      }
    });
  }

  private snapshotExplicitResourceBundle(
    resource: CanonicalResourceTarget
  ): Map<string, { readonly sha256: string; readonly size: number; readonly mtimeMs: number }> {
    const snapshot = new Map<string, { readonly sha256: string; readonly size: number; readonly mtimeMs: number }>();
    const add = (path: string): void => {
      const info = statSync(path);
      if (!info.isFile()) return;
      const relativePath = relative(resource.project.modDirectory, path).replace(/\\/g, "/");
      snapshot.set(relativePath, Object.freeze({
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        size: info.size,
        mtimeMs: info.mtimeMs,
      }));
    };
    this.visitExplicitResourceBundle(resource, add);
    return snapshot;
  }

  /**
   * Workbench stores a .ent SubScene's owned layers in either a sibling
   * `<Target>_default.layer` form or a `<Target>_Layers` directory depending
   * on the resource layout. Both are part of the one explicit target bundle.
   */
  private visitExplicitResourceBundle(
    resource: CanonicalResourceTarget,
    visit: (path: string) => void
  ): void {
    visit(resource.displayPath);
    visit(resource.metaPath);
    if (extname(resource.displayPath).toLowerCase() !== ".ent") return;
    const directory = dirname(resource.displayPath);
    const stem = basename(resource.displayPath, extname(resource.displayPath));
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.startsWith(`${stem}_`) && entry.name.endsWith(".layer")) {
        visit(path);
      }
      if (entry.isDirectory() && entry.name === `${stem}_Layers`) {
        this.walkRegularFiles(path, visit);
      }
    }
  }

  private walkRegularFiles(directory: string, visit: (path: string) => void): void {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) this.walkRegularFiles(path, visit);
      else if (entry.isFile()) visit(path);
    }
  }

  private invalidateQualification(): void {
    this.qualificationCache = null;
    this.companionAttestationKey = null;
  }

  private extractMode(result: unknown): void {
    if (!result || typeof result !== "object" || !("mode" in result)) return;
    const mode = (result as Record<string, unknown>).mode;
    if (mode === "edit") this._state.mode = "edit";
    else if (mode === "play" || mode === "game") this._state.mode = "play";
    else this._state.mode = "unknown";
  }

  private coordinateLifecycle<T>(
    kind: CoordinatedLifecycleKind,
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
    this.invalidateQualification();
    let started: Promise<T>;
    try {
      // Invoke synchronously so runLifecycle records writer intent before a
      // same-turn managed reader can enter the local gate.
      started = action(operationId);
    } catch (error) {
      started = Promise.reject(error);
    }
    let promise!: Promise<T>;
    promise = started.finally(() => {
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
      });
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  private async claimState(
    session: WorkbenchLifecycleSession,
    project: CanonicalProjectIdentity | null
  ): Promise<WorkbenchLifecycleStateV3> {
    const result = await session.validateAndClaim({
      endpoint: { host: this.host.trim().toLowerCase(), port: this.port },
      target: project ? toLifecycleTarget(project) : null,
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
      if (processes.length === 0) {
        this.releaseOwnedChildAfterExactAbsence(null);
        return "absent";
      }
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
        const status = await this.processGuard.inspectOwnedWorkbench(expected);
        if (status === "absent") this.releaseOwnedChildAfterExactAbsence(expected);
        return status;
      } catch (error) {
        throw this.mapLifecycleError(error);
      }
    }
    if (processes.length === 0) {
      this.releaseOwnedChildAfterExactAbsence(expected);
      return "absent";
    }
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
    target: WorkbenchLifecycleTarget | null
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
    return requireReservedState(session, expected);
  }

  private transitionReservedLifecycle(
    expected: WorkbenchLifecycleStateV3,
    overrides: Partial<LifecycleStateDraft>
  ): Promise<WorkbenchLifecycleStateV3> {
    return transitionReservedState(this.processGuard, expected, overrides);
  }

  private vacateReservedLifecycle(
    expected: WorkbenchLifecycleStateV3,
    target: WorkbenchLifecycleTarget | null
  ): Promise<WorkbenchLifecycleStateV3> {
    return vacateReservedState(this.processGuard, expected, {
      target: target ?? expected.target,
      companion: expected.companion,
    });
  }

  private async recoverUnpublishedSpawn(
    state: WorkbenchLifecycleStateV3,
    options: { readonly terminateLive?: boolean } = {}
  ): Promise<void> {
    const journal = await this.processGuard.readSpawnJournal();
    if (journal.kind === "missing") return;
    if (journal.kind === "malformed") {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: the durable Workbench spawn journal is malformed ` +
          `(${journal.message}). Preserve it for attended/manual recovery.`,
        "RECOVERY_REQUIRED"
      );
    }
    const record: WorkbenchSpawnRecord = journal.record;
    if (record.phase === "spawned_unverified") {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: Workbench spawn transaction ${record.transactionId} recorded only ` +
          `PID ${record.pid}; exact identity was never established, so no automated signal is safe. ` +
          "Preserve the journal for attended/manual recovery.",
        "RECOVERY_REQUIRED"
      );
    }
    if (record.phase === "pre_spawn") {
      const processes = await this.processGuard.listWorkbenchProcesses();
      if (processes.length > 0) {
        throw new WorkbenchError(
          `RECOVERY_REQUIRED: Workbench spawn transaction ${record.transactionId} stopped at ` +
            `pre_spawn while Workbench PID(s) ${processes.map((entry) => entry.pid).join(", ")} ` +
            "exist. The publication boundary is uncertain; no PID-only signal was attempted.",
          "RECOVERY_REQUIRED"
        );
      }
      return;
    }
    const identity = record.identity!;
    if (state.workbench && sameWorkbenchIdentity(state.workbench, identity)) {
      // Publication reached the authoritative lifecycle state. Its ordinary
      // recovery path, including readiness reconciliation, remains in charge.
      return;
    }
    let status: "live" | "absent";
    try {
      status = await this.processGuard.inspectOwnedWorkbench(identity);
    } catch (error) {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: exact unpublished Workbench PID ${identity.pid} cannot be reverified ` +
          `(${error instanceof Error ? error.message : String(error)}). No process was signalled.`,
        "RECOVERY_REQUIRED"
      );
    }
    if (status === "absent") {
      this.releaseOwnedChildAfterExactAbsence(identity);
      return;
    }
    if (state.target && record.metadata.targetKey !== state.target.comparisonKey) {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: exact unpublished Workbench PID ${identity.pid} belongs to a different ` +
          "canonical target than the claimed lifecycle. No process was signalled.",
        "RECOVERY_REQUIRED"
      );
    }
    if (options.terminateLive === false) {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: exact unpublished Workbench PID ${identity.pid} is still live. ` +
          "Owner-scoped wb_build recovery never signals a live Workbench; use wb_shutdown " +
          "for attended recovery. The spawn journal was preserved.",
        "RECOVERY_REQUIRED"
      );
    }
    await this.terminateExact(identity);
    await this.waitForPortRelease();
  }

  private async reconcileForEnsure(
    state: WorkbenchLifecycleStateV3,
    project: CanonicalProjectIdentity
  ): Promise<{ state: WorkbenchLifecycleStateV3; live: boolean }> {
    await this.recoverUnpublishedSpawn(state);
    const status = await this.inspectRecordedWorkbench(state);
    if (status === "absent") {
      await this.assertNoWorkbenchProcesses(this.processGuard, "Lifecycle recovery");
      return {
        state: await this.vacateReservedLifecycle(state, toLifecycleTarget(project)),
        live: false,
      };
    }
    if (state.phase === "stopping") {
      await this.terminateExact(state.workbench!);
      await this.waitForPortRelease();
      return {
        state: await this.vacateReservedLifecycle(state, toLifecycleTarget(project)),
        live: false,
      };
    }
    if (state.phase === "starting" || state.phase === "restarting") {
      if (!state.workbench) {
        throw new WorkbenchError(
          "Lifecycle recovery reached a live phase without a recorded exact Workbench identity.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      // Never send a companion request to an endpoint until its listener has
      // been attributed to the exact durable Workbench identity. This keeps a
      // foreign process on the configured port completely untouched.
      await this.assertEndpointOwnedByRecordedWorkbench(
        this.processGuard,
        state.workbench,
        `${state.phase} recovery`
      );
      if (await this.ping()) {
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
        state: await this.vacateReservedLifecycle(state, toLifecycleTarget(project)),
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
      await this.validateManagedAuthority(authority, "running-session reuse", true);
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
      protectedDigests: [preflight.helper.bundleDigest],
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
        target: toLifecycleTarget(preflight.project),
        workbench: null,
        companion: companionLifecycleState(preflight.helper),
        operation: { kind: "launch", operationId },
      }));
    });
    const started = await this.startReserved(state, preflight);
    return {
      action: "launched",
      pid: started.workbench!.pid,
      gprojPath: project.displayPath,
      generation: started.generation,
    };
  }

  private async ensureTargetResourceRunningCoordinated(
    project: CanonicalProjectIdentity,
    resource: CanonicalResourceTarget,
    operationId: string
  ): Promise<WorkbenchTargetResourceLaunchResult> {
    let state = await this.processGuard.withLifecycleLock((session) =>
      this.claimState(session, project));
    const reconciled = await this.reconcileForEnsure(state, project);
    state = reconciled.state;
    if (reconciled.live) {
      const binding = this.explicitResourceSession;
      if (binding && !binding.taintedReason &&
          binding.project.comparisonKey === project.comparisonKey &&
          binding.resource.comparisonKey === resource.comparisonKey &&
          binding.generation === state.generation && state.workbench &&
          sameWorkbenchIdentity(binding.process, state.workbench)) {
        return {
          action: "reused",
          pid: state.workbench.pid,
          gprojPath: project.displayPath,
          generation: state.generation,
          resourcePath: resource.displayPath,
          targetBound: true,
        };
      }
      throw new WorkbenchError(
        "TARGET_SESSION_REQUIRED: a Workbench process is already running, but this MCP cannot prove it is " +
          "the requested fresh target-bound resource session. Shut it down before launching an explicit target.",
        "TARGET_SESSION_REQUIRED"
      );
    }

    const preflight = this.preflightTargetResourceLaunch(project, resource);
    this.companionProvider?.applyRetention?.({
      protectedDigests: [preflight.helper.bundleDigest],
    });
    state = await this.processGuard.withLifecycleLock(async (session) => {
      const current = await this.requireReservedLifecycle(session, state);
      await this.assertNoWorkbenchProcesses(session, "Target-bound launch");
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
        target: toLifecycleTarget(preflight.project),
        workbench: null,
        companion: companionLifecycleState(preflight.helper),
        operation: { kind: "launch", operationId },
      }));
    });
    const started = await this.startReserved(state, preflight);
    if (!started.workbench) {
      throw new WorkbenchError(
        "Target-bound Workbench reached readiness without an exact process identity.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    this.explicitResourceSession = {
      project: preflight.project,
      resource: preflight.resource,
      generation: started.generation,
      process: started.workbench,
      taintedReason: null,
    };
    return {
      action: "launched",
      pid: started.workbench.pid,
      gprojPath: preflight.project.displayPath,
      generation: started.generation,
      resourcePath: preflight.resource.displayPath,
      targetBound: true,
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
      companion: companionLifecycleState(preflight.helper),
    });
    const restarted = await this.startReserved(state, preflight);
    return {
      previousPid: previous.pid,
      pid: restarted.workbench!.pid,
      gprojPath: project.displayPath,
      generation: restarted.generation,
    };
  }

  private async shutdownCoordinated(
    operationId: string,
    requiredBinding: CaptureActivityBinding | null
  ): Promise<WorkbenchShutdownResult> {
    // Shutdown is identity-driven. Preserve the durable target spelling/key but
    // do not touch the .gproj: it may have been deleted or disconnected while
    // the exact recorded Workbench is still safely terminable.
    let state = await this.processGuard.withLifecycleLock((session) =>
      this.claimState(session, null));
    this.assertExactOwnerExitBinding(state, requiredBinding);
    const target = state.target;
    await this.recoverUnpublishedSpawn(state);
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
    // The stopping reservation advances the durable state generation. Its CAS
    // was derived from the fully matched sealed state above, so this final
    // pre-signal check retains the exact target/process comparison while
    // intentionally accepting only that reservation's new generation.
    this.assertExactOwnerExitBinding(state, requiredBinding, false);
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

  private assertExactOwnerExitBinding(
    state: WorkbenchLifecycleStateV3,
    requiredBinding: CaptureActivityBinding | null,
    requireGeneration = true
  ): void {
    if (!requiredBinding || captureBindingMatchesLifecycle(requiredBinding, state, requireGeneration)) return;
    throw new WorkbenchError(
      "IDENTITY_UNVERIFIABLE: exact-owner shutdown no longer matches the sealed lifecycle " +
        "generation, canonical target, or process identity; no process was signalled.",
      "IDENTITY_UNVERIFIABLE"
    );
  }

  private preflightLaunch(project: CanonicalProjectIdentity): LaunchPreflight {
    const config = this.requireConfig("launch");
    const currentProject = revalidateProjectIdentity(project);
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
    try {
      const plan = buildMcpEditorLaunchPlan({
        kind: "mcp_editor",
        config,
        project: currentProject,
        companion,
        endpoint: { host: this.host, port: this.port },
        ownerArgument: this.processGuard.ownerArgument(this.processGuard.createOwnerToken()),
        ...(config.observer?.managedRoot
          ? { managedRoot: config.observer.managedRoot }
          : {}),
      });
      assertWorkbenchAddonDependenciesAvailable({
        targetGprojPath: plan.project.displayPath,
        addonRoots: plan.addonDirectories,
        launchStatus: "No Workbench process was launched.",
      });
      return plan;
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  private preflightTargetResourceLaunch(
    project: CanonicalProjectIdentity,
    resource: CanonicalResourceTarget
  ): McpTargetResourceLaunchPlan {
    const config = this.requireConfig("target-bound launch");
    const currentProject = revalidateProjectIdentity(project);
    const currentResource = revalidateResourceTarget(resource, currentProject);
    if (!this.companionProvider) {
      throw new WorkbenchError(
        "Workbench target-bound launch requires an MCP-managed companion add-on provider.",
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
    try {
      const plan = buildMcpTargetResourceLaunchPlan({
        kind: "mcp_target_resource",
        config,
        project: currentProject,
        resource: currentResource,
        companion,
        endpoint: { host: this.host, port: this.port },
        ownerArgument: this.processGuard.ownerArgument(this.processGuard.createOwnerToken()),
        ...(config.observer?.managedRoot
          ? { managedRoot: config.observer.managedRoot }
          : {}),
      });
      assertWorkbenchAddonDependenciesAvailable({
        targetGprojPath: plan.project.displayPath,
        addonRoots: plan.addonDirectories,
        launchStatus: "No Workbench process was launched.",
      });
      return plan;
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  private async startReserved(
    initialState: WorkbenchLifecycleStateV3,
    preflight: LaunchPreflight
  ): Promise<WorkbenchLifecycleStateV3> {
    let state = initialState;
    this.lastLaunchCompileFailure = null;

    const ownerArgument = preflight.ownerArgument;
    const args = [...preflight.argv];
    const redactedArgs = redactArguments(args, {
      profile: "command_argument",
      replacement: "[owner-token-redacted]",
    });
    logger.info(
      `Launching Workbench: ${preflight.executablePath} ${redactedArgs.join(" ")} ` +
        `(cwd: ${preflight.spawnOptions.cwd})`
    );

    let child: ChildProcess | null = null;
    let identity: WorkbenchIdentity | null = null;
    let launchedAtMs: number | null = null;
    let childObservation: OwnedChildObservation | null = null;
    let resolveOwnedObservation!: (observation: OwnedChildObservation | null) => void;
    const ownedObservationReady = new Promise<OwnedChildObservation | null>((resolvePromise) => {
      resolveOwnedObservation = resolvePromise;
    });
    let ownedObservationSettled = false;
    const settleOwnedObservation = (observation: OwnedChildObservation | null): void => {
      if (ownedObservationSettled) return;
      ownedObservationSettled = true;
      resolveOwnedObservation(observation);
    };
    try {
      // The reservation is durable before spawn. Reacquire the mutex only to
      // prove the exact generation/owner is still authoritative, then release
      // it before process inspection and readiness polling.
      await this.processGuard.withLifecycleLock((session) =>
        this.requireReservedLifecycle(session, state));
      revalidateProjectIdentity(preflight.project);
      if (preflight.kind === "mcp_target_resource") {
        revalidateResourceTarget(preflight.resource, preflight.project);
      }
      if (!this.companionProvider?.verifyStaged) {
        throw new WorkbenchError(
          "Workbench companion provider cannot re-attest the launched payload.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      this.companionProvider.verifyStaged(preflight.helper, preflight.project.displayPath);
      launchedAtMs = Date.now();
      const transaction = await this.runnerLifecycleExecution.spawnRecoverable({
        lifecycle: state,
        purpose: "mcp_editor",
        executablePath: preflight.executablePath,
        launchArguments: args,
        spawnOptions: { ...preflight.spawnOptions },
        ownerArgument,
        launchedAtMs,
        beforeSpawn: () => {
          revalidateProjectIdentity(preflight.project);
          if (preflight.kind === "mcp_target_resource") {
            revalidateResourceTarget(preflight.resource, preflight.project);
          }
          if (!this.companionProvider?.verifyStaged) {
            throw new WorkbenchError(
              "Workbench companion provider cannot re-attest the launched payload.",
              "IDENTITY_UNVERIFIABLE"
            );
          }
          this.companionProvider.verifyStaged(
            preflight.helper,
            preflight.project.displayPath
          );
          assertWorkbenchAddonDependenciesAvailable({
            targetGprojPath: preflight.project.displayPath,
            addonRoots: preflight.addonDirectories,
          });
        },
        supervisionKey: "owned-workbench",
        supervisionCallbacks: {
          onExit: async () => {
            const observation = childObservation ?? await ownedObservationReady;
            if (observation) await this.reconcileOwnedChildExit(observation);
          },
          onCallbackError: (error) => logger.warn(
            `Workbench exit reconciliation failed and will retry: ${error instanceof Error
              ? error.message
              : String(error)}`
          ),
        },
      });
      child = transaction.supervisedChild.handle.child;
      identity = transaction.identity;
      state = transaction.lifecycle;
      childObservation = {
        child,
        handle: transaction.supervisedChild.handle,
        supervisionKey: transaction.supervisedChild.key,
        identity,
        generation: state.generation,
        targetKey: preflight.project.comparisonKey,
      };
      this.ownedChild = childObservation;
      settleOwnedObservation(childObservation);
      child.unref();
      const spawnTerminal = childObservation.handle.terminalState;
      if (spawnTerminal?.kind === "error") {
        throw new WorkbenchError(
          `Workbench failed to start: ${spawnTerminal.error.message}`,
          "LAUNCH_FAILED"
        );
      }
      if (!identity) {
        throw new WorkbenchError(
          "Workbench companion became ready without an exact recorded process identity.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      await this.waitForCompanionReady(
        child,
        () => {
          const terminal = childObservation?.handle.terminalState;
          return terminal?.kind === "error" ? terminal.error : null;
        },
        preflight.helper,
        identity,
        preflight.project.displayPath
      );
      if (preflight.kind === "mcp_target_resource") {
        await this.verifyExplicitResourceStartup(preflight, identity);
      }
      state = await this.transitionReservedLifecycle(state, {
        phase: "running",
        operation: null,
      });
      if (childObservation) childObservation.generation = state.generation;
    } catch (error) {
      settleOwnedObservation(null);
      const mapped = this.mapLifecycleError(error);
      const mayDiagnoseCompileFailure = mapped.code === "LAUNCH_FAILED";
      let compileFailure = launchedAtMs === null || !mayDiagnoseCompileFailure
        ? null
        : findWorkbenchCompileFailure({
            profilePath: preflight.helper.workbenchProfilePath,
            launchedAtMs,
            ownerArgument,
          });
      if (compileFailure) this.lastLaunchCompileFailure = compileFailure;
      await this.rollbackFailedLaunch(state, identity);
      if (!compileFailure && launchedAtMs !== null && mayDiagnoseCompileFailure) {
        compileFailure = findWorkbenchCompileFailure({
          profilePath: preflight.helper.workbenchProfilePath,
          launchedAtMs,
          ownerArgument,
        });
        if (compileFailure) this.lastLaunchCompileFailure = compileFailure;
      }
      if (compileFailure) {
        throw new WorkbenchError(
          formatWorkbenchCompileFailure(compileFailure),
          "PROJECT_COMPILE_FAILED"
        );
      }
      throw mapped;
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

  /** Adapts controller-owned launch evidence to the injected readiness service. */
  private async waitForCompanionReady(
    child: ChildProcess,
    getSpawnError: () => Error | null,
    companion: WorkbenchCompanionLaunch,
    identity?: WorkbenchIdentity,
    gprojPath?: string
  ): Promise<void> {
    const spawnError = getSpawnError();
    if (spawnError) {
      throw new WorkbenchError(`Workbench failed to start: ${spawnError.message}`, "LAUNCH_FAILED");
    }
    const observation = this.ownedChild;
    if (!identity || !observation || observation.child !== child) {
      throw new WorkbenchError(
        "Workbench readiness requires the exact supervised child identity.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    const launchTimeoutMs = this.launchTimeoutMs();
    if (!Number.isFinite(launchTimeoutMs) || launchTimeoutMs <= 0) {
      throw new WorkbenchError(
        "Workbench launch deadline expired before readiness qualification.",
        "LAUNCH_FAILED"
      );
    }
    await this.companionReadiness({
        endpoint: { host: this.host, port: this.port },
        process: identity,
        companion,
        netApi: {
          call: (apiFunc, params, options) => this.rawCall(apiFunc, params, {
            timeout: options?.timeoutMs,
            skipAutoLaunch: true,
          }),
        },
        verifyEndpointOwner: (endpoint, process) =>
          this.processGuard.verifyEndpointOwner(endpoint, process),
        attestCompanion: () => {
          if (!this.companionProvider?.verifyStaged) {
            throw new WorkbenchError(
              "Workbench companion provider cannot re-attest the launched payload.",
              "IDENTITY_UNVERIFIABLE"
            );
          }
          return this.companionProvider.verifyStaged(
            companion,
            gprojPath
          );
        },
        deadlineMs: Date.now() + launchTimeoutMs,
        pollIntervalMs: this.launchPollIntervalMs,
      child: observation.handle,
    });
  }

  /**
   * The helper checks the immutable -load argument before the session is ever
   * exposed to normal MCP calls.  A failure here is still inside the launch
   * transaction, so startReserved rolls the exact disposable child back.
   */
  private async verifyExplicitResourceStartup(
    preflight: McpTargetResourceLaunchPlan,
    identity: WorkbenchIdentity
  ): Promise<void> {
    await this.processGuard.verifyExactProcessArguments(
      identity,
      explicitResourceLaunchArguments(preflight.resource)
    );
    const action = extname(preflight.resource.displayPath).toLowerCase() === ".et"
      ? "openPrefab"
      : "probe";
    const result = await this.rawCall<Record<string, unknown>>(
      "EMCP_WB_ExplicitResourceSave",
      { action, expectedPath: preflight.resource.displayPath },
      { timeout: 15_000, skipAutoLaunch: true }
    );
    if (result.status !== "ok" || result.startupLoadPath !== preflight.resource.displayPath) {
      throw new WorkbenchError(
        typeof result.message === "string" && result.message.length > 0
          ? `Target-bound startup was not attested: ${result.message}`
          : "Target-bound startup was not attested by the Workbench helper.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
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
      this.releaseOwnedChildAfterExactAbsence(null);
    }
    await this.vacateReservedLifecycle(state, state.target);
    this.resetConnectionState();
  }

  private async terminateExact(
    expected: WorkbenchIdentity
  ): Promise<void> {
    let result;
    try {
      result = await this.processGuard.verifyAndTerminate(
        expected,
        this.remainingLifecycleTimeout(OWNED_PROCESS_EXIT_TIMEOUT_MS, "exact Workbench termination")
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
    this.releaseOwnedChildAfterExactAbsence(expected);
  }

  /**
   * Drop only the locally supervised handle covered by an already-proven
   * exact absence. A null identity is reserved for a proven global Workbench
   * vacancy and may therefore clear any stale local observation.
   */
  private releaseOwnedChildAfterExactAbsence(
    expected: WorkbenchIdentity | null
  ): void {
    const observation = this.ownedChild;
    if (!observation || (expected && !sameWorkbenchIdentity(observation.identity, expected))) {
      return;
    }
    this.runnerLifecycleExecution.releaseAbsentSupervisedChild({
      key: observation.supervisionKey,
      handle: observation.handle,
    }, true);
    if (this.ownedChild === observation) this.ownedChild = null;
  }

  private async reconcileOwnedChildExit(
    observation: OwnedChildObservation
  ): Promise<void> {
    const identity = observation.identity;
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
    await this.coordinateLifecycle("recovery", observation.targetKey, () =>
      this.activityGate.runLifecycle("recovery", () =>
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
  }

  private async waitForPortRelease(
    probe: Pick<WorkbenchLifecycleSession, "verifyEndpointVacant"> = this.processGuard
  ): Promise<void> {
    try {
      await this.vacancyWait({
        verify: (endpoint) => probe.verifyEndpointVacant(endpoint),
        endpoint: { host: this.host, port: this.port },
        deadlineMs: Date.now() + this.remainingLifecycleTimeout(
          PORT_RELEASE_TIMEOUT_MS,
          "Workbench endpoint release"
        ),
        pollIntervalMs: PORT_RELEASE_POLL_MS,
      });
    } catch (error) {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: NET API endpoint ${this.host}:${this.port} vacancy was not proven ` +
          `after exact Workbench exit (${error instanceof Error ? error.message : String(error)}). ` +
          "The durable lifecycle state was preserved for recovery.",
        "RECOVERY_REQUIRED"
      );
    }
  }

  private remainingLifecycleTimeout(defaultMs: number, operation: string): number {
    const deadlineAtMs = this.lifecycleDeadlineAtMs?.();
    if (deadlineAtMs === undefined) return defaultMs;
    const remainingMs = Math.floor(deadlineAtMs - Date.now());
    if (remainingMs <= 0) {
      throw new WorkbenchError(
        `${operation} exceeded its absolute lifecycle deadline.`,
        "TIMEOUT"
      );
    }
    return Math.min(defaultMs, remainingMs);
  }

  private mapLifecycleError(error: unknown): WorkbenchError {
    if (error instanceof WorkbenchError) return error;
    if (error instanceof WorkbenchLifecycleExecutionError) {
      const code: WorkbenchErrorCode = error.code === "SPAWN_FAILED"
        ? "LAUNCH_FAILED"
        : error.code === "LIFECYCLE_CONFLICT"
          ? "LIFECYCLE_BUSY"
          : error.code === "ENDPOINT_UNVERIFIABLE" || error.code === "TERMINATION_REFUSED"
            ? "IDENTITY_UNVERIFIABLE"
            : error.code;
      return new WorkbenchError(error.message, code);
    }
    if (error instanceof WorkbenchActivityError) {
      return new WorkbenchError(error.message, error.code);
    }
    if (error instanceof WorkbenchAddonDependencyPreflightError) {
      return new WorkbenchError(error.message, error.code);
    }
    if (error instanceof ProjectIdentityError) {
      return new WorkbenchError(error.message, error.code);
    }
    if (error instanceof ResourceTargetError) {
      const code: WorkbenchErrorCode = error.code === "RESOURCE_REQUIRED"
        ? "TARGET_REQUIRED"
        : error.code === "RESOURCE_TARGET_CHANGED"
          ? "TARGET_CHANGED"
          : "INVALID_TARGET";
      return new WorkbenchError(error.message, code);
    }
    if (error instanceof WorkbenchSessionStateError) {
      return new WorkbenchError(`RECOVERY_REQUIRED: ${error.message}`, "RECOVERY_REQUIRED");
    }
    if (error instanceof WorkbenchReadinessError) {
      const code: WorkbenchErrorCode = error.code === "IDENTITY_UNVERIFIABLE" ||
          error.code === "ENDPOINT_UNVERIFIABLE" || error.code === "ATTESTATION_FAILED"
        ? "IDENTITY_UNVERIFIABLE"
        : "LAUNCH_FAILED";
      return new WorkbenchError(error.message, code);
    }
    if (error instanceof WorkbenchLaunchPlanError) {
      const code: WorkbenchErrorCode = error.code === "INVALID_TARGET"
        ? "INVALID_TARGET"
        : error.code === "INVALID_COMPANION" || error.code === "PATH_OVERLAP"
          ? "IDENTITY_UNVERIFIABLE"
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
    const deadlineAtMs = this.requestDeadlineAtMs?.();
    let timeoutMs = options.timeout;
    if (deadlineAtMs !== undefined) {
      if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) {
        throw new WorkbenchError("Workbench request absolute deadline is invalid.", "TIMEOUT");
      }
      const remainingMs = Math.floor(deadlineAtMs - this.now());
      if (remainingMs <= 0) {
        throw new WorkbenchError(
          `Workbench call "${apiFunc}" exceeded its absolute request deadline.`,
          "TIMEOUT"
        );
      }
      timeoutMs = timeoutMs === undefined ? remainingMs : Math.min(timeoutMs, remainingMs);
    }
    return this.netApi.call<T>(apiFunc, params, {
      timeoutMs,
    }).then((result) => {
      logger.debug(`Workbench response for "${apiFunc}":`, result);
      return result;
    }).catch((error: unknown) => {
      if (!(error instanceof WorkbenchNetApiError)) throw error;
      const code: WorkbenchErrorCode = error.code === "connection_refused"
        ? "CONNECTION_REFUSED"
        : error.code === "timeout"
          ? "TIMEOUT"
          : error.code === "api_error"
            ? "API_ERROR"
            : "PROTOCOL_ERROR";
      throw new WorkbenchError(error.message, code);
    });
  }
}
