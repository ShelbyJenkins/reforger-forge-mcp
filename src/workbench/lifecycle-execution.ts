import { randomUUID } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  ChildSupervisor,
  type ChildSupervisorCallbacks,
  type SupervisedChildExit,
  type SupervisedChildHandle,
} from "../foundation/child-supervisor.js";
import { runRecoverableSpawn } from "../foundation/recoverable-spawn.js";
import type { WorkbenchCompanionLaunch } from "./helper-addon.js";
import {
  WorkbenchProcessGuard,
  type CanonicalProjectIdentity,
  type LifecycleEndpoint,
  type VerifyEndpointOwnerResult,
  type VerifyEndpointVacantResult,
  type WorkbenchIdentity,
  type WorkbenchLifecycleStateV3,
  type WorkbenchSpawnPurpose,
} from "./process-guard.js";
import {
  expectedStateVersion,
  lifecycleStateDraft,
  toCompanionLifecycleState,
  transitionReservedLifecycle,
  vacateReservedLifecycle,
  WorkbenchSessionStateError,
} from "./session-state.js";

export type WorkbenchLifecycleExecutionErrorCode =
  | "LIFECYCLE_CONFLICT"
  | "SPAWN_FAILED"
  | "IDENTITY_UNVERIFIABLE"
  | "ENDPOINT_UNVERIFIABLE"
  | "TERMINATION_REFUSED"
  | "RECOVERY_REQUIRED";

export class WorkbenchLifecycleExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchLifecycleExecutionErrorCode
  ) {
    super(message);
    this.name = "WorkbenchLifecycleExecutionError";
  }
}

export type WorkbenchLifecycleExecutionFailureFactory = (
  message: string,
  code: WorkbenchLifecycleExecutionErrorCode
) => Error;

export type WorkbenchLifecycleChildProcess = ChildProcess;
export type WorkbenchLifecycleSpawnOptions = SpawnOptions;

/** Compatibility aliases keep existing embedders injectable without exposing the guard in runner code. */
export type WorkbenchLifecycleGuard = WorkbenchProcessGuard;
export type WorkbenchLifecycleChildSupervisor = ChildSupervisor;
export type WorkbenchLifecycleReservation = WorkbenchLifecycleStateV3;
export type WorkbenchLifecycleTransition = Parameters<typeof transitionReservedLifecycle>[2];
export type WorkbenchLifecycleVacancy = Parameters<typeof vacateReservedLifecycle>[2];
export type WorkbenchLifecycleChildExit = SupervisedChildExit;

export interface WorkbenchLifecycleSupervisedChild {
  readonly key: string;
  readonly handle: SupervisedChildHandle;
}

export interface WorkbenchLifecycleOwnerCredential {
  readonly token: string;
  readonly argument: string;
}

export interface WorkbenchLifecycleExecutionDependencies {
  processGuard?: WorkbenchProcessGuard;
  childSupervisor?: ChildSupervisor;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess;
  failure?: WorkbenchLifecycleExecutionFailureFactory;
}

export interface WorkbenchLifecycleSpawnRequest {
  lifecycle: WorkbenchLifecycleReservation;
  purpose: WorkbenchSpawnPurpose;
  executablePath: string;
  launchArguments: readonly string[];
  spawnOptions: SpawnOptions;
  ownerArgument: string;
  launchedAtMs: number;
  /** Runs after durable pre_spawn publication and immediately before process creation. */
  beforeSpawn?: () => void;
  /** Stable key/callbacks for controller-owned long-lived child reconciliation. */
  supervisionKey?: string;
  supervisionCallbacks?: ChildSupervisorCallbacks;
  onSupervisedChild?: (child: WorkbenchLifecycleSupervisedChild) => void;
}

export interface WorkbenchLifecycleSpawnResult {
  readonly supervisedChild: WorkbenchLifecycleSupervisedChild;
  readonly identity: WorkbenchIdentity;
  readonly lifecycle: WorkbenchLifecycleReservation;
}

export interface WorkbenchLifecycleAbsenceResult {
  readonly exit: WorkbenchLifecycleChildExit | null;
  readonly absent: boolean;
  readonly error?: Error;
}

export type WorkbenchLifecycleCompletion =
  | { reason: "exited"; exit: WorkbenchLifecycleChildExit }
  | { reason: "child_error"; error: Error }
  | { reason: "timed_out" | "aborted" };

export interface WorkbenchLifecycleExecutionPort {
  assertStandaloneEntryReady(): Promise<void>;
  assertSpawnJournalReplaceable(): Promise<void>;
  assertNoWorkbenchProcesses(): Promise<void>;
  assertNoWorkbenchBeforeReservation(stage: string): Promise<void>;
  assertEndpointVacantBeforeSpawn(endpoint: LifecycleEndpoint, stage: string): Promise<void>;
  verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult>;
  verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    identity: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult>;
  createOwnerCredential(): WorkbenchLifecycleOwnerCredential;
  reserve(args: {
    endpoint: LifecycleEndpoint;
    target: CanonicalProjectIdentity;
    /** Null is reserved for the controller's helper-free target-build plan. */
    companion: WorkbenchCompanionLaunch | null;
  }): Promise<WorkbenchLifecycleReservation>;
  transition(
    expected: WorkbenchLifecycleReservation,
    overrides: WorkbenchLifecycleTransition
  ): Promise<WorkbenchLifecycleReservation>;
  vacate(
    expected: WorkbenchLifecycleReservation,
    overrides: WorkbenchLifecycleVacancy
  ): Promise<WorkbenchLifecycleReservation>;
  spawnRecoverable(request: WorkbenchLifecycleSpawnRequest): Promise<WorkbenchLifecycleSpawnResult>;
  waitForExitOrControl(args: {
    child: SupervisedChildHandle;
    timeoutMs: number | null;
    signal?: AbortSignal;
  }): Promise<WorkbenchLifecycleCompletion>;
  ensureExactChildAbsent(args: {
    identity: WorkbenchIdentity | null;
    child: SupervisedChildHandle;
    timeoutMs: number;
    recoveryTimeoutMs: number;
  }): Promise<WorkbenchLifecycleAbsenceResult>;
  releaseAbsentSupervisedChild(
    supervised: WorkbenchLifecycleSupervisedChild,
    absenceProven: boolean
  ): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref();
  });
}

function endpointVacancyDetail(
  result: Exclude<VerifyEndpointVacantResult, { kind: "vacant" }>
): string {
  return result.kind === "occupied"
    ? `listener PID ${result.listenerPid}: ${result.message}`
    : `${result.reason}: ${result.message}`;
}

/**
 * One controller-owned execution boundary for all durable Workbench process lifecycles.
 *
 * Callers decide editor/build policy and receipt shape. This service alone claims
 * lifecycle generations, journals process creation, supervises children, proves
 * exact termination, and publishes/vacates durable ownership.
 */
export class WorkbenchLifecycleExecution implements WorkbenchLifecycleExecutionPort {
  private readonly guard: WorkbenchProcessGuard;
  private readonly childSupervisor: ChildSupervisor;
  private readonly spawnProcess: NonNullable<WorkbenchLifecycleExecutionDependencies["spawnProcess"]>;
  private readonly makeFailure: WorkbenchLifecycleExecutionFailureFactory;

  constructor(dependencies: WorkbenchLifecycleExecutionDependencies = {}) {
    this.guard = dependencies.processGuard ?? new WorkbenchProcessGuard();
    this.childSupervisor = dependencies.childSupervisor ?? new ChildSupervisor();
    this.spawnProcess = dependencies.spawnProcess ?? ((command, args, options) =>
      spawnChild(command, [...args], options));
    this.makeFailure = dependencies.failure ?? ((message, code) =>
      new WorkbenchLifecycleExecutionError(message, code));
  }

  assertSpawnJournalReplaceable(): Promise<void> {
    return this.guard.assertSpawnJournalReplaceable();
  }

  async assertStandaloneEntryReady(): Promise<void> {
    const journal = await this.guard.readSpawnJournal();
    if (journal.kind === "valid" && journal.record.phase === "pre_spawn") {
      throw this.failure(
        `Workbench spawn transaction ${journal.record.transactionId} stopped at pre_spawn. ` +
          "Preserve it for attended/manual recovery before starting another standalone launch.",
        "LIFECYCLE_CONFLICT"
      );
    }
    await this.guard.assertSpawnJournalReplaceable();
  }

  assertNoWorkbenchProcesses(): Promise<void> {
    return this.guard.assertNoWorkbenchProcesses();
  }

  async assertNoWorkbenchBeforeReservation(stage: string): Promise<void> {
    try {
      await this.guard.assertNoWorkbenchProcesses();
    } catch (error) {
      throw this.failure(
        `${stage} refused because another Workbench process is present or its identity cannot be proven: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "LIFECYCLE_CONFLICT"
      );
    }
  }

  async assertEndpointVacantBeforeSpawn(
    endpoint: LifecycleEndpoint,
    stage: string
  ): Promise<void> {
    let vacancy: VerifyEndpointVacantResult;
    try {
      vacancy = await this.guard.verifyEndpointVacant(endpoint);
    } catch (error) {
      throw this.failure(
        `${stage} refused because endpoint vacancy inspection failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "ENDPOINT_UNVERIFIABLE"
      );
    }
    if (vacancy.kind !== "vacant") {
      throw this.failure(
        `${stage} refused because Workbench endpoint vacancy is not proven ` +
          `(${endpointVacancyDetail(vacancy)}).`,
        "ENDPOINT_UNVERIFIABLE"
      );
    }
  }

  verifyEndpointVacant(endpoint: LifecycleEndpoint): Promise<VerifyEndpointVacantResult> {
    return this.guard.verifyEndpointVacant(endpoint);
  }

  verifyEndpointOwner(
    endpoint: LifecycleEndpoint,
    identity: WorkbenchIdentity
  ): Promise<VerifyEndpointOwnerResult> {
    return this.guard.verifyEndpointOwner(endpoint, identity);
  }

  createOwnerCredential(): WorkbenchLifecycleOwnerCredential {
    const token = this.guard.createOwnerToken();
    return Object.freeze({ token, argument: this.guard.ownerArgument(token) });
  }

  async reserve(args: {
    endpoint: LifecycleEndpoint;
    target: CanonicalProjectIdentity;
    companion: WorkbenchCompanionLaunch | null;
  }): Promise<WorkbenchLifecycleReservation> {
    return this.guard.withLifecycleLock(async (session) => {
      const read = await session.readState();
      if (read.kind !== "missing" && read.kind !== "valid") {
        throw this.failure(
          `Standalone Workbench launch is refused while lifecycle state is ${read.kind}; ` +
            "use the MCP lifecycle recovery path first.",
          "LIFECYCLE_CONFLICT"
        );
      }
      if (read.kind === "valid") {
        const state = read.state;
        if (state.endpoint.host !== args.endpoint.host ||
            state.endpoint.port !== args.endpoint.port) {
          throw this.failure(
            `The durable lifecycle endpoint ${state.endpoint.host}:${state.endpoint.port} ` +
              `conflicts with ${args.endpoint.host}:${args.endpoint.port}.`,
            "LIFECYCLE_CONFLICT"
          );
        }
        if (state.phase !== "vacant" || state.workbench !== null || state.operation !== null) {
          throw this.failure(
            `The durable Workbench lifecycle is ${state.phase}; recover or shut it down ` +
              "before an external run.",
            "LIFECYCLE_CONFLICT"
          );
        }
      }
      const claim = await session.validateAndClaim({
        endpoint: args.endpoint,
        target: args.target,
      });
      if (claim.kind === "refused") {
        throw this.failure(
          `The standalone Workbench lifecycle claim was refused (${claim.code}): ${claim.message}`,
          "LIFECYCLE_CONFLICT"
        );
      }
      const claimed = claim.state;
      if (claimed.phase !== "vacant" || claimed.workbench !== null ||
          claimed.operation !== null) {
        throw this.failure(
          `The claimed Workbench lifecycle is ${claimed.phase}, not vacant.`,
          "LIFECYCLE_CONFLICT"
        );
      }
      return session.transition(
        expectedStateVersion(claimed),
        lifecycleStateDraft(claimed, {
          phase: "starting",
          target: args.target,
          companion: args.companion ? toCompanionLifecycleState(args.companion) : null,
          workbench: null,
          operation: { kind: "launch", operationId: randomUUID() },
        })
      );
    });
  }

  async transition(
    expected: WorkbenchLifecycleReservation,
    overrides: WorkbenchLifecycleTransition
  ): Promise<WorkbenchLifecycleReservation> {
    try {
      return await transitionReservedLifecycle(this.guard, expected, overrides);
    } catch (error) {
      throw this.mapSessionStateError(error);
    }
  }

  async vacate(
    expected: WorkbenchLifecycleReservation,
    overrides: WorkbenchLifecycleVacancy
  ): Promise<WorkbenchLifecycleReservation> {
    try {
      return await vacateReservedLifecycle(this.guard, expected, overrides);
    } catch (error) {
      throw this.mapSessionStateError(error);
    }
  }

  async spawnRecoverable(
    request: WorkbenchLifecycleSpawnRequest
  ): Promise<WorkbenchLifecycleSpawnResult> {
    const transactionId = randomUUID();
    const supervisionKey = request.supervisionKey ??
      `runner:${request.purpose}:${transactionId}`;
    let supervisedHandle: SupervisedChildHandle | null = null;
    const transaction = await runRecoverableSpawn({
      transactionId,
      metadata: {
        purpose: request.purpose,
        lifecycleGeneration: request.lifecycle.generation,
        targetKey: request.lifecycle.target?.comparisonKey ?? "",
      },
      backend: this.guard.backend,
      journal: this.guard.createSpawnJournal(request.lifecycle),
      fence: {
        assertActive: () => this.guard.assertLifecycleAuthority(request.lifecycle),
      },
      spawn: () => {
        request.beforeSpawn?.();
        return this.safeSpawn(
          request.executablePath,
          request.launchArguments,
          request.spawnOptions
        );
      },
      childPid: (child) => {
        if (!child.pid) {
          throw this.failure(
            "Workbench spawn returned no PID, so exact ownership cannot be established.",
            "IDENTITY_UNVERIFIABLE"
          );
        }
        return child.pid;
      },
      awaitSpawn: (child) => {
        supervisedHandle = this.childSupervisor.supervise(
          supervisionKey,
          child,
          request.supervisionCallbacks
        );
        request.onSupervisedChild?.({ key: supervisionKey, handle: supervisedHandle });
        return Promise.resolve();
      },
      inspect: (child) => this.inspectSpawnedIdentity(
        child,
        supervisedHandle!,
        request.executablePath,
        request.ownerArgument,
        request.launchedAtMs
      ),
      publish: (identity) => this.transition(request.lifecycle, {
        phase: "starting",
        workbench: identity,
      }),
    });
    if (!supervisedHandle) {
      throw this.failure(
        "Workbench spawn observation was not installed before journal publication.",
        "RECOVERY_REQUIRED"
      );
    }
    return {
      supervisedChild: { key: supervisionKey, handle: supervisedHandle },
      identity: transaction.identity,
      lifecycle: transaction.publication,
    };
  }

  async waitForExitOrControl(args: {
    child: SupervisedChildHandle;
    timeoutMs: number | null;
    signal?: AbortSignal;
  }): Promise<WorkbenchLifecycleCompletion> {
    const controls: Array<Promise<WorkbenchLifecycleCompletion>> = [];
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let removeAbortListener: () => void = () => undefined;
    if (args.signal) {
      if (args.signal.aborted) {
        controls.push(Promise.resolve({ reason: "aborted" }));
      } else {
        controls.push(new Promise((resolvePromise) => {
          const onAbort = (): void => resolvePromise({ reason: "aborted" });
          args.signal!.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => args.signal!.removeEventListener("abort", onAbort);
        }));
      }
    }
    if (args.timeoutMs !== null) {
      controls.push(new Promise((resolvePromise) => {
        timeout = setTimeout(
          () => resolvePromise({ reason: "timed_out" }),
          Math.max(1, args.timeoutMs!)
        );
        timeout.unref?.();
      }));
    }
    try {
      return await Promise.race([
        args.child.exit.then((exit) => ({ reason: "exited" as const, exit })),
        args.child.error.then((error) => ({
          reason: "child_error" as const,
          error: this.failure(
            `Workbench child process reported an error: ${error.message}`,
            "SPAWN_FAILED"
          ),
        })),
        ...controls,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      removeAbortListener();
    }
  }

  async ensureExactChildAbsent(args: {
    identity: WorkbenchIdentity | null;
    child: SupervisedChildHandle;
    timeoutMs: number;
    recoveryTimeoutMs: number;
  }): Promise<WorkbenchLifecycleAbsenceResult> {
    if (!args.identity) {
      const result = await Promise.race([
        args.child.exit.then((exit) => ({ kind: "exit" as const, exit })),
        delay(args.recoveryTimeoutMs).then(() => ({ kind: "deadline" as const })),
      ]);
      if (result.kind === "exit") return { exit: result.exit, absent: true };
      return {
        exit: null,
        absent: false,
        error: this.failure(
          `RECOVERY_REQUIRED: spawned Workbench did not exit within the ` +
            `${args.recoveryTimeoutMs}ms recovery deadline before exact identity publication.`,
          "RECOVERY_REQUIRED"
        ),
      };
    }
    return this.terminateExactAndObserve({ ...args, identity: args.identity });
  }

  releaseAbsentSupervisedChild(
    supervised: WorkbenchLifecycleSupervisedChild,
    absenceProven: boolean
  ): void {
    if (absenceProven) {
      this.childSupervisor.forget(supervised.key, supervised.handle.child);
    }
  }

  private async inspectSpawnedIdentity(
    child: ChildProcess,
    supervisedChild: SupervisedChildHandle,
    executablePath: string,
    ownerArgument: string,
    launchedAtMs: number
  ): Promise<WorkbenchIdentity> {
    if (!child.pid) {
      throw this.failure(
        "Workbench spawn returned no PID, so exact ownership cannot be established.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return Promise.race([
      this.guard.inspectSpawnedWorkbench({
        pid: child.pid,
        executablePath,
        ownerTokenArgument: ownerArgument,
        launchedAtMs,
      }),
      supervisedChild.exit.then((exit) => {
        throw this.failure(
          `Workbench exited before exact ownership was established ` +
            `(exit code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"}).`,
          "IDENTITY_UNVERIFIABLE"
        );
      }),
    ]);
  }

  private async terminateExactAndObserve(args: {
    identity: WorkbenchIdentity;
    child: SupervisedChildHandle;
    timeoutMs: number;
    recoveryTimeoutMs: number;
  }): Promise<WorkbenchLifecycleAbsenceResult> {
    let refusal: Error | undefined;
    try {
      const result = await this.guard.verifyAndTerminate(args.identity, args.timeoutMs);
      if (result.kind === "refused") {
        refusal = this.failure(
          `Exact Workbench termination was refused (${result.reason}): ${result.message}`,
          "TERMINATION_REFUSED"
        );
      }
    } catch (error) {
      refusal = this.failure(
        `Exact Workbench termination could not be verified: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "TERMINATION_REFUSED"
      );
    }
    let exit: WorkbenchLifecycleChildExit | null = args.child.terminalState?.kind === "exit"
      ? args.child.terminalState.exit
      : null;
    const recoveryDeadline = Date.now() + args.recoveryTimeoutMs;
    const pollMs = Math.max(1, Math.min(250, args.recoveryTimeoutMs));
    while (Date.now() < recoveryDeadline) {
      const remainingMs = Math.max(1, recoveryDeadline - Date.now());
      const inspection = await Promise.race([
        this.guard.inspectOwnedWorkbench(args.identity)
          .then((status) => ({ kind: "status" as const, status }))
          .catch((error: unknown) => ({ kind: "error" as const, error })),
        delay(remainingMs).then(() => ({ kind: "deadline" as const })),
      ]);
      if (inspection.kind !== "status") {
        const detail = inspection.kind === "error"
          ? (inspection.error instanceof Error ? inspection.error.message : String(inspection.error))
          : `inspection exceeded the remaining ${remainingMs}ms recovery budget`;
        return {
          exit,
          absent: false,
          error: this.failure(
            `RECOVERY_REQUIRED: exact Workbench absence became unverifiable during bounded ` +
              `recovery (${detail}). The durable lifecycle remains stopping with its exact ` +
              "owner identity.",
            "RECOVERY_REQUIRED"
          ),
        };
      }
      if (inspection.status === "absent") {
        return {
          exit: exit ?? { code: null, signal: null },
          absent: true,
          ...(refusal ? { error: refusal } : {}),
        };
      }
      const observed = await Promise.race([
        args.child.exit.then((value) => ({ kind: "exit" as const, value })),
        delay(pollMs).then(() => ({ kind: "poll" as const })),
      ]);
      if (observed.kind === "exit") exit = observed.value;
    }
    return {
      exit,
      absent: false,
      error: this.failure(
        `RECOVERY_REQUIRED: exact Workbench PID ${args.identity.pid} remained live or ` +
          `unverifiable after the ${args.recoveryTimeoutMs}ms recovery deadline. ` +
          "The durable lifecycle remains stopping with its exact owner identity.",
        "RECOVERY_REQUIRED"
      ),
    };
  }

  private safeSpawn(
    executablePath: string,
    args: readonly string[],
    options: SpawnOptions
  ): ChildProcess {
    try {
      return this.spawnProcess(executablePath, args, options);
    } catch (error) {
      throw this.failure(
        `Could not spawn Workbench: ${error instanceof Error ? error.message : String(error)}`,
        "SPAWN_FAILED"
      );
    }
  }

  private mapSessionStateError(error: unknown): unknown {
    if (!(error instanceof WorkbenchSessionStateError)) return error;
    return this.failure(`RECOVERY_REQUIRED: ${error.message}`, "RECOVERY_REQUIRED");
  }

  private failure(message: string, code: WorkbenchLifecycleExecutionErrorCode): Error {
    return this.makeFailure(message, code);
  }
}
