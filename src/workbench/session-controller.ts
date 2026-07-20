/**
 * Target-aware Workbench session controller and compatibility surface.
 *
 * Every NET API call uses a fresh socket. Lifecycle mutations use short
 * reserve/CAS/commit transactions under the machine-wide mutex; readiness,
 * exact termination, and endpoint-release waits run against durable exact
 * owner evidence after that mutex is released.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  WorkbenchActivityError,
  WorkbenchActivityGate,
  type CaptureActivityBinding,
  type CaptureActivityLease,
  type WorkbenchActivityGateTiming,
} from "./activity-gate.js";
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
  type WorkbenchLifecycleReservation,
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
  type WorkbenchLifecycleSession,
  type WorkbenchLifecycleStateV3,
  type WorkbenchSpawnRecord,
} from "./process-guard.js";
import {
  diagnoseWorkbench,
  type DiagnosticReport,
} from "./diagnostics.js";
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
  type CliEditorLaunchPlan,
  type McpEditorLaunchPlan,
  type TargetBuildLaunchPlan,
} from "./launch-plan.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;
const OWNED_PROCESS_EXIT_TIMEOUT_MS = 15_000;
const PORT_RELEASE_TIMEOUT_MS = 15_000;
const PORT_RELEASE_POLL_MS = 200;
const DEFAULT_QUALIFICATION_INTERVAL_MS = 2_000;

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

export type WorkbenchForegroundExitReason = "exited" | "timed_out" | "aborted";

export interface WorkbenchRunResult<Qualification = unknown> {
  readonly planKind: "cli_editor" | "target_build";
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
  /** Internal V3 bridge: preserves the preflight reservation through target spawn. */
  readonly handoff?: WorkbenchTargetBuildHandoff;
}

export interface WorkbenchTargetBuildRunResult<Snapshot>
  extends WorkbenchRunResult<null> {
  readonly planKind: "target_build";
  readonly beforeOutput: Snapshot;
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

export interface WorkbenchTemporaryCompanionPreflightPlan {
  readonly kind: "temporary_companion_preflight";
  readonly executablePath: string;
  readonly lifecycleTarget: WorkbenchLifecycleTarget;
  readonly helper: Readonly<WorkbenchCompanionLaunch>;
  readonly endpoint: Readonly<{ host: string; port: number }>;
  readonly ownerArgument: string;
  readonly argv: readonly string[];
  readonly spawnOptions: Readonly<SpawnOptions>;
}

export interface WorkbenchPreflightProofContext<Qualification> {
  readonly process: Readonly<WorkbenchIdentity>;
  readonly lifecycleGeneration: string;
  readonly qualification: Qualification;
}

export interface TemporaryCompanionPreflightOptions<Qualification>
  extends ForegroundRunOptions<Qualification> {
  readonly deadlineMs: number;
  /** Best-effort precheck immediately before the transition-only lifecycle claim. */
  readonly beforeClaim?: () => void;
  /** Immediate post-claim reservation proof; failure returns the child-free state to vacant. */
  readonly afterClaim?: () => void;
  /** Evidence/reattestation hook after exact absence and vacancy, before handoff publication. */
  readonly beforeHandoff?: (
    proof: WorkbenchPreflightProofContext<Qualification>
  ) => void | Promise<void>;
}

export interface WorkbenchTemporaryCompanionPreflightResult<Qualification>
  extends WorkbenchPreflightProofContext<Qualification> {
  readonly endpointOwnership: "verified";
  readonly endpointVacancy: "verified";
  readonly handoff: WorkbenchTargetBuildHandoff;
}

/** Opaque, one-shot reservation continuity between legacy V3 preflight and target build. */
export class WorkbenchTargetBuildHandoff {
  private status: "fresh" | "consumed" | "cancelled" = "fresh";

  /** @internal Created only after exact preflight absence and endpoint vacancy. */
  constructor(private readonly lifecycle: WorkbenchLifecycleReservation) {}

  consume(
    endpoint: Readonly<{ host: string; port: number }>,
    target: WorkbenchLifecycleTarget
  ): WorkbenchLifecycleReservation {
    if (this.status !== "fresh") {
      throw new WorkbenchRunError("Target-build lifecycle handoff was already consumed.", "INCOMPLETE_PROOF");
    }
    if (this.lifecycle.phase !== "starting" || this.lifecycle.workbench !== null ||
        this.lifecycle.endpoint.host !== endpoint.host || this.lifecycle.endpoint.port !== endpoint.port ||
        this.lifecycle.target?.comparisonKey !== target.comparisonKey ||
        pathKey(this.lifecycle.target?.path ?? "") !== pathKey(target.path)) {
      throw new WorkbenchRunError(
        "Target-build lifecycle handoff no longer matches its endpoint and canonical target.",
        "INCOMPLETE_PROOF"
      );
    }
    this.status = "consumed";
    return this.lifecycle;
  }

  cancel(): WorkbenchLifecycleReservation | null {
    if (this.status !== "fresh") return null;
    this.status = "cancelled";
    return this.lifecycle;
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

type LaunchPreflight = McpEditorLaunchPlan;

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

interface ActiveLifecycleOperation {
  kind: LifecycleOperationKind;
  operationId: string;
  targetKey: string | null;
  promise: Promise<unknown>;
}

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
  launchTimeoutMs?: number;
  launchPollIntervalMs?: number;
  activityGate?: WorkbenchActivityGate;
  captureRestoreTimeoutMs?: number;
  activityGateTiming?: WorkbenchActivityGateTiming;
  qualificationIntervalMs?: number;
  now?: () => number;
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

export class WorkbenchSessionController {
  private activeLifecycle: ActiveLifecycleOperation | null = null;
  private ownedChild: OwnedChildObservation | null = null;
  private readonly childSupervisor: ChildSupervisor;
  private readonly runnerLifecycleExecution: WorkbenchLifecycleExecutionPort;
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };
  private readonly spawnProcess: WorkbenchClientDependencies["spawnProcess"];
  private readonly companionProvider: WorkbenchCompanionProvider | undefined;
  private readonly launchTimeoutMs: number;
  private readonly launchPollIntervalMs: number;
  private readonly activityGate: WorkbenchActivityGate;
  private readonly netApi: WorkbenchNetApiPort;
  private readonly companionReadiness: typeof awaitCompanionReadiness;
  private readonly vacancyWait: typeof waitForVacancy;
  private readonly diagnosticsService: typeof diagnoseWorkbench;
  private readonly qualificationIntervalMs: number;
  private readonly now: () => number;
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
    lifecycleExecution: WorkbenchLifecycleExecutionPort
  ): WorkbenchSessionController {
    return new WorkbenchSessionController(
      host,
      port,
      undefined,
      "ReforgerForgeWorkbenchRunner",
      new WorkbenchProcessGuard(),
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
    this.launchTimeoutMs = dependencies.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
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

  /** Temporary V3 build qualification; removed only after the live target-only gate. */
  async runTemporaryCompanionPreflight<Qualification>(
    plan: WorkbenchTemporaryCompanionPreflightPlan,
    options: TemporaryCompanionPreflightOptions<Qualification>
  ): Promise<WorkbenchTemporaryCompanionPreflightResult<Qualification>> {
    return this.activityGate.runLifecycle(
      "temporary build companion preflight",
      () => this.runTemporaryCompanionPreflightExclusive(plan, options),
      { signal: options.signal }
    );
  }

  private async runTemporaryCompanionPreflightExclusive<Qualification>(
    plan: WorkbenchTemporaryCompanionPreflightPlan,
    options: TemporaryCompanionPreflightOptions<Qualification>
  ): Promise<WorkbenchTemporaryCompanionPreflightResult<Qualification>> {
    if (plan.kind !== "temporary_companion_preflight" ||
        !Number.isFinite(options.deadlineMs)) {
      throw new WorkbenchRunError(
        "Temporary companion preflight requires a finite deadline and validated plan.",
        "INCOMPLETE_PROOF"
      );
    }
    const execution = this.runnerLifecycleExecution;
    const endpoint = { ...plan.endpoint };
    const terminationTimeoutMs = options.terminationTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    const recoveryTimeoutMs = options.recoveryTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    await execution.assertSpawnJournalReplaceable();
    await execution.assertNoWorkbenchBeforeReservation("Workbench companion preflight reservation");
    await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench companion preflight reservation");
    options.beforeClaim?.();
    let lifecycle = await execution.reserve({
      endpoint,
      target: plan.lifecycleTarget,
      companion: plan.helper,
    });
    try {
      options.afterClaim?.();
    } catch (error) {
      await execution.vacate(lifecycle, {
        endpoint,
        target: plan.lifecycleTarget,
        companion: companionLifecycleState(plan.helper),
      });
      throw error;
    }
    let supervised: WorkbenchLifecycleSupervisedChild | null = null;
    let identity: WorkbenchIdentity | null = null;
    let qualification: Qualification | undefined;
    let qualified = false;
    let lifecycleGeneration: string | null = null;
    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    let absenceProven = false;
    let endpointVacant = false;
    let handoff: WorkbenchTargetBuildHandoff | null = null;

    try {
      if (options.signal?.aborted) {
        throw new WorkbenchRunError("Workbench companion preflight was aborted before spawn.", "ABORTED");
      }
      if (Date.now() >= options.deadlineMs) {
        throw new WorkbenchRunError(
          "Workbench build deadline expired before companion preflight spawn.",
          "DEADLINE_EXCEEDED"
        );
      }
      await execution.assertNoWorkbenchProcesses();
      options.beforeFinalVacancyCheck?.();
      await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench companion preflight spawn");
      const spawned = await execution.spawnRecoverable({
        lifecycle,
        purpose: "runner_companion_preflight",
        executablePath: plan.executablePath,
        launchArguments: plan.argv,
        spawnOptions: plan.spawnOptions,
        ownerArgument: plan.ownerArgument,
        launchedAtMs: Date.now(),
        beforeSpawn: () => {
          if (options.signal?.aborted) {
            throw new WorkbenchRunError(
              "Workbench companion preflight was aborted immediately before spawn.",
              "ABORTED"
            );
          }
          if (Date.now() >= options.deadlineMs) {
            throw new WorkbenchRunError(
              "Workbench build deadline expired immediately before companion preflight spawn.",
              "DEADLINE_EXCEEDED"
            );
          }
          options.beforeSpawn?.();
        },
        onSupervisedChild: (observed) => { supervised = observed; },
      });
      supervised = spawned.supervisedChild;
      identity = spawned.identity;
      lifecycle = spawned.lifecycle;
      if (Date.now() >= options.deadlineMs) {
        throw new WorkbenchRunError(
          "Workbench build deadline expired before companion readiness could be qualified.",
          "DEADLINE_EXCEEDED"
        );
      }
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
          "Workbench companion preflight",
          recoveryTimeoutMs
        );
        endpointVacant = true;
      } catch (error) {
        primaryError ??= error;
      }
    }
    if (!primaryError && !cleanupError && identity && lifecycleGeneration &&
        qualified && absenceProven && endpointVacant) {
      try {
        await options.beforeHandoff?.({
          process: Object.freeze({ ...identity }),
          lifecycleGeneration,
          qualification: qualification as Qualification,
        });
      } catch (error) {
        primaryError = error;
      }
    }
    if (absenceProven && endpointVacant) {
      try {
        if (!primaryError && !cleanupError) {
          lifecycle = await execution.transition(lifecycle, {
            phase: "starting",
            endpoint,
            target: plan.lifecycleTarget,
            workbench: null,
            companion: companionLifecycleState(plan.helper),
            operation: { kind: "launch", operationId: randomUUID() },
          });
          handoff = new WorkbenchTargetBuildHandoff(lifecycle);
        } else {
          lifecycle = await execution.vacate(lifecycle, {
            endpoint,
            target: plan.lifecycleTarget,
            companion: companionLifecycleState(plan.helper),
          });
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
    if (primaryError) throw primaryError;
    if (!identity || !qualified || !lifecycleGeneration || !absenceProven ||
        !endpointVacant || !handoff) {
      throw new WorkbenchRunError(
        "Workbench companion preflight completed without a fully identity-bound proof.",
        "INCOMPLETE_PROOF"
      );
    }
    return Object.freeze({
      process: Object.freeze({ ...identity }),
      lifecycleGeneration,
      qualification: qualification as Qualification,
      endpointOwnership: "verified" as const,
      endpointVacancy: "verified" as const,
      handoff,
    });
  }

  /** Execute one helper-free target plan with the final output proof inside the spawn cut. */
  async cancelTargetBuildHandoff(
    handoff: WorkbenchTargetBuildHandoff,
    target: WorkbenchLifecycleTarget
  ): Promise<boolean> {
    return this.activityGate.runLifecycle("cancel target-build handoff", async () => {
      const lifecycle = handoff.cancel();
      if (!lifecycle) return false;
      const endpoint = { host: this.host, port: this.port };
      await this.runnerLifecycleExecution.assertNoWorkbenchProcesses();
      const vacancy = await this.runnerLifecycleExecution.verifyEndpointVacant(endpoint);
      if (vacancy.kind !== "vacant") {
        throw new WorkbenchRunError(
          `Target-build handoff cancellation preserved its busy reservation because endpoint ` +
            `vacancy was not proven (${vacancy.kind}).`,
          "ENDPOINT_UNVERIFIABLE"
        );
      }
      await this.runnerLifecycleExecution.vacate(lifecycle, {
        endpoint,
        target,
        companion: lifecycle.companion,
      });
      return true;
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
      () => this.runTargetBuildExclusive(plan, reservation, options),
      { signal: options.signal }
    );
  }

  private async runTargetBuildExclusive<Snapshot>(
    plan: TargetBuildLaunchPlan,
    reservation: WorkbenchBuildOutputReservation<Snapshot>,
    options: BoundedRunOptions
  ): Promise<WorkbenchTargetBuildRunResult<Snapshot>> {
    if (plan.kind !== "target_build" || plan.helper !== null || plan.readiness.kind !== "none") {
      throw new WorkbenchRunError(
        "Target build execution requires one helper-free target_build launch plan.",
        "INCOMPLETE_PROOF"
      );
    }
    if (pathKey(reservation.root) !== pathKey(plan.outputPath)) {
      throw new WorkbenchRunError(
        "Target build output reservation does not match the launch plan output.",
        "INCOMPLETE_PROOF"
      );
    }
    if (!Number.isFinite(options.deadlineMs)) {
      throw new TypeError("Target build absolute deadline must be finite.");
    }
    const execution = this.runnerLifecycleExecution;
    const endpoint = { host: this.host, port: this.port };
    const terminationTimeoutMs = options.terminationTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    const recoveryTimeoutMs = options.recoveryTimeoutMs ?? OWNED_PROCESS_EXIT_TIMEOUT_MS;
    await execution.assertSpawnJournalReplaceable();
    await execution.assertNoWorkbenchBeforeReservation("Workbench target-build reservation");
    await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench target-build reservation");
    if (!options.handoff) reservation.assertStillReservedAndSnapshot();
    let lifecycle = options.handoff
      ? options.handoff.consume(endpoint, plan.lifecycleTarget)
      : await execution.reserve({
          endpoint,
          target: plan.lifecycleTarget,
          companion: null,
        });
    const reservedCompanion = lifecycle.companion;
    // The claim is the serialization point. A failed immediate recheck owns
    // enough durable authority to return the child-free reservation to vacant.
    try {
      reservation.assertStillReservedAndSnapshot();
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
    let beforeOutput: Snapshot | null = null;
    let reason: WorkbenchForegroundExitReason | null = null;
    let exit: SupervisedChildExit | null = null;
    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    let absenceProven = false;
    let endpointVacant = false;

    try {
      this.assertBoundedRunCanContinue(options, "before target-build spawn");
      await execution.assertNoWorkbenchProcesses();
      options.beforeFinalVacancyCheck?.();
      await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench target-build spawn");
      const spawned = await execution.spawnRecoverable({
        lifecycle,
        purpose: "target_build",
        executablePath: plan.executablePath,
        launchArguments: plan.argv,
        spawnOptions: plan.spawnOptions,
        ownerArgument: plan.ownerArgument,
        launchedAtMs: Date.now(),
        beforeSpawn: () => {
          this.assertBoundedRunCanContinue(options, "immediately before target-build spawn");
          options.beforeSpawn?.();
          beforeOutput = reservation.assertStillReservedAndSnapshot();
        },
        onSupervisedChild: (observed) => { supervised = observed; },
      });
      supervised = spawned.supervisedChild;
      identity = spawned.identity;
      lifecycle = spawned.lifecycle;
      // A target-only process never advertises companion readiness. Its
      // identity-bound starting state remains the durable busy state until it
      // advances to stopping, keeping version-3 editor invariants intact.
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
          "Workbench target build",
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
    if (!identity || !supervised || !lifecycleGeneration || beforeOutput === null ||
        !reason || !exit || !absenceProven || !endpointVacant) {
      throw new WorkbenchRunError(
        "Workbench target build completed without a fully identity-bound process proof.",
        "INCOMPLETE_PROOF"
      );
    }
    return Object.freeze({
      planKind: "target_build" as const,
      process: Object.freeze({ ...identity }),
      lifecycleGeneration,
      qualification: null,
      beforeOutput,
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

  private assertBoundedRunCanContinue(options: BoundedRunOptions, stage: string): void {
    if (options.signal?.aborted) {
      throw new WorkbenchRunError(`Workbench target build was aborted ${stage}.`, "ABORTED");
    }
    if (Date.now() >= options.deadlineMs) {
      throw new WorkbenchRunError(
        `Workbench target build deadline expired ${stage}.`,
        "DEADLINE_EXCEEDED"
      );
    }
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

  /** Count-only lifecycle evidence; no PID, owner token, or process handle is exposed. */
  diagnosticSupervisedChildCounts(): SupervisedChildCounts {
    return this.childSupervisor.counts();
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

  async restartOwnedWorkbench(): Promise<WorkbenchRestartResult> {
    this.requireConfig("restart");
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
    try {
      const read = await this.processGuard.readLifecycleState();
      const targetKey = read.kind === "valid" ? read.state.target?.comparisonKey ?? null : null;
      return await this.coordinateLifecycle("shutdown", targetKey, (operationId) =>
        this.activityGate.runLifecycle("shutdown", async () =>
          this.shutdownCoordinated(operationId)
        )
      );
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  async diagnose(): Promise<DiagnosticReport> {
    return this.diagnosticsService({
      host: this.host,
      port: this.port,
      config: this.config,
      lifecycle: this.processGuard,
      callNetApi: (apiFunc, params, options) => this.rawCall(apiFunc, params, options),
      classifyNetError: (error) => error instanceof WorkbenchError ? error : null,
    });
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
        projectRoot: this.config?.projectPath,
        defaultMod: this.config?.defaultMod,
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
    state: WorkbenchLifecycleStateV3
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
    if (state.target && record.metadata.targetKey !== state.target.comparisonKey) {
      throw new WorkbenchError(
        `RECOVERY_REQUIRED: exact unpublished Workbench PID ${identity.pid} belongs to a different ` +
          "canonical target than the claimed lifecycle. No process was signalled.",
        "RECOVERY_REQUIRED"
      );
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
    operationId: string
  ): Promise<WorkbenchShutdownResult> {
    // Shutdown is identity-driven. Preserve the durable target spelling/key but
    // do not touch the .gproj: it may have been deleted or disconnected while
    // the exact recorded Workbench is still safely terminable.
    let state = await this.processGuard.withLifecycleLock((session) =>
      this.claimState(session, null));
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
      return buildMcpEditorLaunchPlan({
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
    } catch (error) {
      throw this.mapLifecycleError(error);
    }
  }

  private async startReserved(
    initialState: WorkbenchLifecycleStateV3,
    preflight: LaunchPreflight
  ): Promise<WorkbenchLifecycleStateV3> {
    let state = initialState;

    const ownerArgument = preflight.ownerArgument;
    const args = [...preflight.argv];
    const redactedArgs = args.map((arg) => arg === ownerArgument ? "[owner-token-redacted]" : arg);
    logger.info(
      `Launching Workbench: ${preflight.executablePath} ${redactedArgs.join(" ")} ` +
        `(cwd: ${preflight.spawnOptions.cwd})`
    );

    let child: ChildProcess | null = null;
    let identity: WorkbenchIdentity | null = null;
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
      if (!this.companionProvider?.verifyStaged) {
        throw new WorkbenchError(
          "Workbench companion provider cannot re-attest the launched payload.",
          "IDENTITY_UNVERIFIABLE"
        );
      }
      this.companionProvider.verifyStaged(preflight.helper, preflight.project.displayPath);
      const launchedAtMs = Date.now();
      const transaction = await this.runnerLifecycleExecution.spawnRecoverable({
        lifecycle: state,
        purpose: "mcp_editor",
        executablePath: preflight.executablePath,
        launchArguments: args,
        spawnOptions: { ...preflight.spawnOptions },
        ownerArgument,
        launchedAtMs,
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
      state = await this.transitionReservedLifecycle(state, {
        phase: "running",
        operation: null,
      });
      if (childObservation) childObservation.generation = state.generation;
    } catch (error) {
      settleOwnedObservation(null);
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

  /** Adapts controller-owned launch evidence to the injected readiness service. */
  private async waitForCompanionReady(
    child: ChildProcess,
    getSpawnError: () => Error | null,
    companion: WorkbenchCompanionLaunch,
    identity?: WorkbenchIdentity,
    projectPath?: string
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
            projectPath
          );
        },
        deadlineMs: Date.now() + this.launchTimeoutMs,
        pollIntervalMs: this.launchPollIntervalMs,
        child: observation.handle,
      });
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
        deadlineMs: Date.now() + PORT_RELEASE_TIMEOUT_MS,
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
    if (error instanceof ProjectIdentityError) {
      return new WorkbenchError(error.message, error.code);
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
    return this.netApi.call<T>(apiFunc, params, {
      timeoutMs: options.timeout,
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
