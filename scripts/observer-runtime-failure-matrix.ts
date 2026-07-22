import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  caseForId,
  isCanonicalFaultMatrixTerminal,
  OBSERVER_FAULT_MATRIX,
  type FaultMatrixCase,
  type FaultMatrixTerminal,
} from "../observer/protocol/fault-matrix.js";
import { resolveEngineProfileDirectory } from "../observer/agent/paths.js";
import { deadlineAt, pollUntil, systemClock, systemSleeper } from "../src/foundation/time.js";
import {
  createObserverApplication,
  type ObserverApplication,
} from "../src/observer/application.js";
import { prepareObserverLaunch } from "../src/observer/launch.js";
import {
  closeObserverRuntimeLifecycle,
  OwnedRuntimeManager,
} from "../src/observer/owned-runtime-manager.js";
import {
  createFaultMatrixRunScaffolding,
  removeOwnedFaultControlRoot,
  type FaultMatrixRunScaffolding,
  type FaultMatrixScheduler,
} from "./observer-fault-matrix-support.js";
import {
  assertArmaVacant,
  assertCurrentViewReleasedFromDisplaced,
  assertLiveRuntimeObserverAuthorized,
  boundedText,
  captureMatrix,
  DEFAULT_RUNTIME_OBSERVER_POSE_FOV,
  DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION,
  DEFAULT_RUNTIME_OBSERVER_POSE_POSITION,
  DEFAULT_RUNTIME_OBSERVER_WORLD,
  findRuntimeExecutable,
  inspectAddonFixture,
  launchArguments,
  OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES,
  OBSERVER_SOURCE_PATH,
  PRIVATE_CHILD_PATH,
  record,
  REPOSITORY_ROOT,
  resolveRuntimeAcceptanceArtifactRoot,
  RUNTIME_FIXTURE_SOURCE_EXTENSIONS,
  RUNTIME_OPERATIONAL_BASELINE_SOURCES,
  runtimePoseMatrix,
} from "./observer-runtime-launch-support.js";
import {
  buildObserverFailureMatrixArtifact,
  matrixRetainedDiagnostic,
  OperationalBaselineRecorder,
  operationalBaselineDirectoryIdentity,
  operationalBaselineEnvironment,
  operationalBaselineLaunchArgumentIdentity,
  operationalBaselineSource,
  waitForOperationalBaselineProcessVacancy,
  writeObserverFailureMatrixArtifact,
  type MatrixCaseEntry,
  type FailureMatrixPublication,
} from "./observer-live-acceptance-support.js";

const FIXTURE_TEMPLATE_DIR = join(
  REPOSITORY_ROOT, "tests", "fixtures", "runtime-observer-failure-matrix-addon"
);
const FIXTURE_CONTROL_DIRECTORY_NAME = "RFOFaultMatrixControl";
const CASE_TIMEOUT_MS = 120_000;
const PUBLIC_TERMINAL_JOB_STATES = new Set(["completed", "failed", "cancelled"]);
const PUBLIC_PRE_LEASE_JOB_STATES = new Set(["queued", "dispatched", "accepted", "resolving", "preloading"]);
const RUNTIME_FAILURE_MATRIX_SOURCES = Object.freeze([
  ...RUNTIME_OPERATIONAL_BASELINE_SOURCES,
  "scripts/run-runtime-observer-acceptance.ts",
  "tests/fixtures/runtime-observer-failure-matrix-addon/addon.gproj",
  "tests/fixtures/runtime-observer-failure-matrix-addon/Scripts/Game/ReforgerForgeObserver/RFO_RuntimeMatrixControl.c",
] as const);

export interface RuntimeFailureMatrixOptions {
  readonly confirmed: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly artifactRoot?: string;
  readonly validationRoot?: string;
  readonly worldResource?: string;
  readonly executablePath?: string;
  readonly launchArguments?: string[];
  /** The runtime matrix currently supports exactly one selected case per run. */
  readonly only: string;
  readonly keepProfile?: boolean;
}

export interface RuntimeFailureMatrixResult extends FailureMatrixPublication {
  readonly runDirectory: string | null;
}

function pilotPoseView(): {
  kind: "pose";
  position: [number, number, number];
  orientation: [number, number, number, number];
  fov: number;
} {
  return {
    kind: "pose",
    position: [...DEFAULT_RUNTIME_OBSERVER_POSE_POSITION],
    orientation: [...DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION],
    fov: DEFAULT_RUNTIME_OBSERVER_POSE_FOV,
  };
}

/** The narrow surface runPilotCancellationCase needs, so a hermetic test fake
 *  only has to implement five methods instead of the full ObserverApplication. */
export type MatrixPilotCaseApplication = Pick<
  ObserverApplication, "capture" | "cancelJob" | "jobStatus" | "releaseJob" | "discardRun"
>;
export type MatrixPilotCaseScheduler = Pick<
  FaultMatrixScheduler, "arm" | "releaseBarrier" | "finishCase"
>;

export interface RunPilotCancellationCaseInput {
  readonly application: MatrixPilotCaseApplication;
  readonly scheduler: MatrixPilotCaseScheduler;
  readonly matrixCase: FaultMatrixCase;
  readonly managedRunId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly worldId: string;
  readonly worldEpoch: number;
  readonly caseStartedAt: number;
  readonly caseDeadlineMs: number;
  readonly caseBudgetMs: number;
  /** The live runner passes its one shared baseline recorder; hermetic unit
   *  tests may omit it when timing evidence is outside the assertion. */
  readonly baseline?: Pick<OperationalBaselineRecorder, "measure">;
  readonly onPublicTerminal?: (terminal: MatrixCaseEntry["publicTerminal"]) => void;
  /** Captures a public pre-action failure before outer cleanup can inflate its timing. */
  readonly onFailedCaseEntry?: (entry: MatrixCaseEntry) => void;
}

function measurePilotPhase<T>(
  input: RunPilotCancellationCaseInput,
  operation: string,
  phase: string,
  action: () => Promise<T>,
  observations?: (result: T) => Record<string, string | number | boolean | null>,
): Promise<T> {
  return input.baseline
    ? input.baseline.measure("capture", operation, action, phase, observations)
    : action();
}

async function pollJobTerminal(
  application: MatrixPilotCaseApplication,
  sessionId: string,
  jobId: string,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = await pollUntil<Record<string, unknown>>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(deadlineMs),
    intervalMs: 100,
    signal,
    probe: async () => {
      const job = record(await application.jobStatus(sessionId, jobId), "matrix pilot job status");
      return PUBLIC_TERMINAL_JOB_STATES.has(String(job.state)) ? job : undefined;
    },
  });
  if (result.kind === "expired") {
    throw new Error("Matrix pilot job did not reach a terminal state before the case deadline");
  }
  return result.value;
}

function publicTerminalFromJob(
  job: Record<string, unknown>,
  label: string,
): FaultMatrixTerminal {
  const errorCode = job.state === "failed" && typeof job.terminalErrorCode === "string"
    ? job.terminalErrorCode
    : null;
  const terminal = { state: String(job.state ?? ""), errorCode };
  if (!isCanonicalFaultMatrixTerminal(terminal)) {
    throw new Error(
      `${label} reached non-canonical state=${String(job.state)} errorCode=${String(errorCode)}`
    );
  }
  return terminal;
}

function assertPilotBarrierPublicStatus(
  job: Record<string, unknown>,
  expected: {
    readonly jobId: string;
    readonly instanceId: string;
    readonly worldId: string;
    readonly worldEpoch: number;
  },
): void {
  const lease = job.cameraLease && typeof job.cameraLease === "object" && !Array.isArray(job.cameraLease)
    ? job.cameraLease as Record<string, unknown>
    : null;
  const failures: string[] = [];
  if (job.jobId !== expected.jobId) failures.push(`jobId=${String(job.jobId)}`);
  if (job.instanceId !== expected.instanceId) failures.push(`instanceId=${String(job.instanceId)}`);
  if (job.state !== "acquiringCamera") failures.push(`state=${String(job.state)}`);
  if (job.worldId !== expected.worldId) failures.push(`worldId=${String(job.worldId)}`);
  if (job.worldEpoch !== expected.worldEpoch) failures.push(`worldEpoch=${String(job.worldEpoch)}`);
  if (lease?.everHeld !== true) failures.push(`cameraLease.everHeld=${String(lease?.everHeld)}`);
  if (lease?.held !== true) failures.push(`cameraLease.held=${String(lease?.held)}`);
  if (lease?.restorationConfirmed !== false) {
    failures.push(`cameraLease.restorationConfirmed=${String(lease?.restorationConfirmed)}`);
  }
  if (failures.length > 0) {
    throw new Error(
      `Matrix pilot public lease_acquired predicate was not proven for the selected job: ${failures.join(", ")}`
    );
  }
}

async function pollPilotBarrierPublicStatus(
  application: MatrixPilotCaseApplication,
  sessionId: string,
  expected: {
    readonly jobId: string;
    readonly instanceId: string;
    readonly worldId: string;
    readonly worldEpoch: number;
  },
  deadlineMs: number,
): Promise<Record<string, unknown>> {
  let lastState = "unobserved";
  const result = await pollUntil<Record<string, unknown>>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(deadlineMs),
    intervalMs: 100,
    probe: async () => {
      const job = record(
        await application.jobStatus(sessionId, expected.jobId),
        "matrix pilot public status at barrier",
      );
      lastState = String(job.state ?? "");

      // Identity and world drift can never converge while this exact job is
      // held at the fixture barrier, so fail immediately instead of polling a
      // different job/revision until the case budget expires.
      const identityFailures: string[] = [];
      if (job.jobId !== expected.jobId) identityFailures.push(`jobId=${String(job.jobId)}`);
      if (job.instanceId !== expected.instanceId) identityFailures.push(`instanceId=${String(job.instanceId)}`);
      if (job.worldId !== expected.worldId) identityFailures.push(`worldId=${String(job.worldId)}`);
      if (job.worldEpoch !== expected.worldEpoch) identityFailures.push(`worldEpoch=${String(job.worldEpoch)}`);
      if (identityFailures.length > 0) {
        throw new Error(
          `Matrix pilot public lease_acquired identity was not proven for the selected job: ${identityFailures.join(", ")}`
        );
      }

      if (PUBLIC_TERMINAL_JOB_STATES.has(lastState)) return job;
      if (lastState === "acquiringCamera") {
        assertPilotBarrierPublicStatus(job, expected);
        return job;
      }
      // The fixture's arrival file can become visible before the private agent
      // ingests the matching acquiringCamera status. Only true pre-phase
      // states are retryable; later phases prove the barrier/public predicate
      // was missed and must fail immediately.
      if (PUBLIC_PRE_LEASE_JOB_STATES.has(lastState)) return undefined;
      throw new Error(
        `Matrix pilot public job advanced past lease_acquired before the predicate was proven: state=${lastState}`
      );
    },
  });
  if (result.kind === "expired") {
    throw new Error(
      `Matrix pilot public job did not reach the lease_acquired predicate before the case deadline (lastState=${lastState})`
    );
  }
  return result.value;
}

function remainingCaseCaptureTimeout(deadlineMs: number): number {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs < 1_000) throw new Error("Runtime matrix case deadline expired before capture dispatch");
  return Math.min(60_000, remainingMs);
}

function preActionFailureEntry(
  input: RunPilotCancellationCaseInput,
  job: Record<string, unknown>,
  terminal: FaultMatrixTerminal,
  stage: "before barrier arrival" | "before cancellation dispatch",
): MatrixCaseEntry {
  const observedAt = Date.now();
  const lease = job.cameraLease && typeof job.cameraLease === "object" && !Array.isArray(job.cameraLease)
    ? job.cameraLease as Record<string, unknown>
    : null;
  const camera = lease?.everHeld === false && lease.held === false
    ? "not_acquired" as const
    : "unproven" as const;
  const observedWorldId = typeof job.worldId === "string" ? job.worldId : null;
  const observedWorldEpoch = job.worldEpoch;
  const worldRevision = observedWorldId === null || !Number.isSafeInteger(observedWorldEpoch)
    ? "unavailable" as const
    : observedWorldId === input.worldId && observedWorldEpoch === input.worldEpoch
      ? "unchanged" as const
      : "changed" as const;
  const elapsedMs = Math.min(
    input.caseBudgetMs,
    Math.max(0, observedAt - input.caseStartedAt),
  );
  return {
    caseId: input.matrixCase.id,
    schedule: {
      backend: "runtime",
      view: input.matrixCase.view,
      phase: input.matrixCase.injection.phase,
      action: input.matrixCase.injection.action,
    },
    result: "failed",
    publicTerminal: terminal,
    deadline: { outcome: "completed", elapsedMs, budgetMs: input.caseBudgetMs },
    worldRevision,
    camera,
    artifact: terminal.state === "completed" ? "unproven" : "not_created",
    cleanup: {
      lifecycleVacant: false,
      endpointVacant: false,
      childVacant: false,
      exactOwnerVacant: false,
    },
    retainedDiagnostics: [matrixRetainedDiagnostic(
      `public terminal ${stage}: state=${terminal.state} errorCode=${terminal.errorCode ?? "none"} ` +
      `elapsedMs=${elapsedMs} camera=${camera}`
    )],
  };
}

/**
 * The declared pilot case's interaction sequence: arm the barrier on an
 * already-submitted asynchronous job, dispatch the host-runner cancel_capture
 * action, capture the public terminal result before any diagnostics, prove
 * the camera lease was restored, run the mandatory post-fault follow-up
 * capture, and seal the control channel. Isolated from live launch/teardown
 * concerns so it can run against fakes in a hermetic test.
 */
export async function runPilotCancellationCase(
  input: RunPilotCancellationCaseInput
): Promise<MatrixCaseEntry> {
  const {
    application, scheduler, matrixCase, managedRunId, sessionId,
    instanceId, worldId, worldEpoch, caseStartedAt, caseDeadlineMs, caseBudgetMs,
  } = input;
  const diagnostics: string[] = [];
  const poseView = pilotPoseView();
  const captureTimeoutMs = remainingCaseCaptureTimeout(caseDeadlineMs);
  // Calling arm() writes the new-file command synchronously before its first
  // acknowledgement wait yields. Keep that wait concurrent with submission:
  // awaiting arrival before capture would deadlock, while submitting before
  // issuing the arm command lets the lease-acquired state race past the hook.
  const arrivalPromise = measurePilotPhase(
    input,
    "FaultMatrixScheduler.arm",
    "barrier_arrival",
    () => scheduler.arm(matrixCase.id),
    (result) => ({
      phase: result.arrived.phase,
      disposition: result.arrived.disposition,
    }),
  );
  // Preserve the original promise for the authoritative await below, while
  // ensuring an early submission-shape failure cannot create an unhandled
  // rejection before outer closeout aborts the arrival wait.
  void arrivalPromise.catch(() => undefined);
  const submitted = await application.capture({
    runId: managedRunId,
    captureLabel: "matrix-pilot-pose",
    purpose: `Fault-matrix pilot case ${matrixCase.id}`,
    sessionId,
    instanceId,
    expectedWorldId: worldId,
    expectedWorldEpoch: worldEpoch,
    idempotencyKey: `${managedRunId}-${matrixCase.id}`,
    view: poseView,
    settleFrames: 3,
    performancePolicy: "evidence",
    asynchronous: true,
    timeoutMs: captureTimeoutMs,
  });
  if (!submitted.asynchronous) {
    throw new Error("Matrix pilot capture unexpectedly returned a synchronous result");
  }
  const submittedJob = record(submitted.job, "matrix pilot submitted job");
  const jobId = String(submittedJob.jobId ?? "");
  if (!jobId) throw new Error("Matrix pilot capture returned no job ID");

  // A job can fail before reaching the armed boundary (for example, a real
  // runtime can report CAMERA_BUSY while its first player camera is still
  // materializing). Observe that public terminal concurrently with the
  // one-shot arm wait so the case fails immediately and retains the real
  // terminal instead of manufacturing a barrier timeout/INTERNAL_ERROR.
  const terminalPollAbort = new AbortController();
  const terminalPromise = pollJobTerminal(
    application,
    sessionId,
    jobId,
    caseDeadlineMs,
    terminalPollAbort.signal,
  );
  let firstOutcome:
    | { readonly kind: "arrived"; readonly arrived: Awaited<typeof arrivalPromise> }
    | { readonly kind: "terminal"; readonly job: Record<string, unknown> };
  try {
    firstOutcome = await Promise.race([
      arrivalPromise.then((arrived) => ({ kind: "arrived" as const, arrived })),
      terminalPromise.then((job) => ({ kind: "terminal" as const, job })),
    ]);
  } catch (error) {
    const terminalPollStopped = new Error("Matrix pilot barrier wait ended before terminal observation");
    terminalPollAbort.abort(terminalPollStopped);
    try { await terminalPromise; } catch { /* the race error remains authoritative */ }
    throw error;
  }
  if (firstOutcome.kind === "terminal") {
    const terminal = publicTerminalFromJob(firstOutcome.job, "Matrix pilot job before barrier arrival");
    input.onPublicTerminal?.(terminal);
    input.onFailedCaseEntry?.(preActionFailureEntry(input, firstOutcome.job, terminal, "before barrier arrival"));
    throw new Error(
      `Matrix pilot job reached terminal state=${terminal.state} errorCode=${String(terminal.errorCode)} before barrier arrival`
    );
  }

  // Stop and join the losing terminal poll. If it observed a real terminal at
  // the same boundary, preserve that result and fail closed before dispatching
  // the mutation; otherwise only our exact abort reason is suppressible.
  const terminalPollStopped = new Error("Matrix pilot barrier arrived before a public terminal");
  terminalPollAbort.abort(terminalPollStopped);
  try {
    const terminalAfterArrival = await terminalPromise;
    const terminal = publicTerminalFromJob(
      terminalAfterArrival,
      "Matrix pilot job before cancellation dispatch",
    );
    input.onPublicTerminal?.(terminal);
    input.onFailedCaseEntry?.(preActionFailureEntry(
      input,
      terminalAfterArrival,
      terminal,
      "before cancellation dispatch",
    ));
    throw new Error(
      `Matrix pilot job reached terminal state=${terminal.state} errorCode=${String(terminal.errorCode)} before cancellation dispatch`
    );
  } catch (error) {
    if (error !== terminalPollStopped) throw error;
  }

  const arrived = firstOutcome.arrived;
  // The fixture acknowledgement is capability-bound but not job-ID-bound.
  // Before mutating anything, independently prove through the public API that
  // this exact selected job is held at the catalog's lease_acquired predicate
  // in the same world revision. The barrier keeps that state stable while the
  // check crosses the private-agent transport.
  const barrierJob = await pollPilotBarrierPublicStatus(
    application,
    sessionId,
    { jobId, instanceId, worldId, worldEpoch },
    caseDeadlineMs,
  );
  if (PUBLIC_TERMINAL_JOB_STATES.has(String(barrierJob.state))) {
    const terminal = publicTerminalFromJob(barrierJob, "Matrix pilot job before cancellation dispatch");
    input.onPublicTerminal?.(terminal);
    input.onFailedCaseEntry?.(preActionFailureEntry(
      input,
      barrierJob,
      terminal,
      "before cancellation dispatch",
    ));
    throw new Error(
      `Matrix pilot job reached terminal state=${terminal.state} errorCode=${String(terminal.errorCode)} before cancellation dispatch`
    );
  }
  diagnostics.push("public lease_acquired predicate proven for selected job and unchanged world revision");
  diagnostics.push(`barrier arrived: phase=${arrived.arrived.phase} disposition=${arrived.arrived.disposition}`);

  const executed = await measurePilotPhase(
    input,
    "ObserverApplication.cancelJob/FaultMatrixScheduler.releaseBarrier",
    "action_acknowledgement",
    async () => {
      await application.cancelJob(sessionId, jobId);
      return scheduler.releaseBarrier("cancel");
    },
    (result) => ({ disposition: result.disposition }),
  );
  diagnostics.push(`barrier released: disposition=${executed.disposition}`);

  const terminalResult = await measurePilotPhase(
    input,
    "ObserverApplication.jobStatus(terminal)",
    "public_terminal",
    async () => {
      const finalJob = await pollJobTerminal(application, sessionId, jobId, caseDeadlineMs);
      const publicTerminal = publicTerminalFromJob(finalJob, "Matrix pilot job");
      input.onPublicTerminal?.(publicTerminal);
      if (publicTerminal.state !== matrixCase.expectedTerminal.state ||
          publicTerminal.errorCode !== matrixCase.expectedTerminal.errorCode) {
        throw new Error(
          `Matrix pilot job reached state=${String(finalJob.state)} errorCode=${String(publicTerminal.errorCode)}, ` +
          `expected state=${matrixCase.expectedTerminal.state} errorCode=${String(matrixCase.expectedTerminal.errorCode)}`
        );
      }
      return { finalJob, publicTerminal };
    },
    (result) => ({
      state: result.publicTerminal.state,
      errorCode: result.publicTerminal.errorCode,
    }),
  );
  const { finalJob, publicTerminal } = terminalResult;

  const recovery = await measurePilotPhase(
    input,
    "ObserverApplication.capture/releaseJob(follow-up)",
    "recovery",
    async () => {
      const lease = record(finalJob.cameraLease, "matrix pilot job camera lease");
      if (lease.everHeld !== true || lease.held !== false || lease.restorationConfirmed !== true) {
        throw new Error("Matrix pilot job did not prove camera acquisition followed by restoration after cancellation");
      }

      // Mandatory follow-up: a fresh synchronous current capture must succeed
      // and be materially displaced from the explicit pose, proving no stale
      // lease or held camera survived the cancellation.
      // Deliberately not registered with managedRunId/a captureLabel: this probe
      // is diagnostic-only evidence, never a promoted artifact, and a completed
      // runtime capture bound to the run would make the later discardRun's own
      // convergence step try to auto-release it through the same guard that
      // refuses independent release of a still-open run's capture -- a deadlock.
      const followUp = await application.capture({
        sessionId,
        instanceId,
        expectedWorldId: worldId,
        expectedWorldEpoch: worldEpoch,
        idempotencyKey: `${managedRunId}-${matrixCase.id}-followup`,
        view: { kind: "current" },
        settleFrames: 3,
        performancePolicy: "evidence",
        asynchronous: false,
        timeoutMs: remainingCaseCaptureTimeout(caseDeadlineMs),
      });
      if (followUp.asynchronous) throw new Error("Matrix pilot follow-up capture unexpectedly returned asynchronously");
      const followUpJob = record(followUp.job, "matrix pilot follow-up job");
      const followUpJobId = String(followUpJob.jobId ?? "");
      let followUpProofFailure: unknown;
      let distanceMeters: number | null = null;
      try {
        if (followUpJob.state !== "completed") {
          throw new Error("Matrix pilot follow-up current capture did not complete after cancellation");
        }
        if (!followUpJobId) throw new Error("Matrix pilot follow-up capture returned no job ID");
        const followUpMetadata = record(followUp.metadata, "matrix pilot follow-up metadata");
        const followUpMatrix = captureMatrix(followUpMetadata, "Matrix pilot follow-up capture");
        const poseMatrix = runtimePoseMatrix(poseView);
        distanceMeters = assertCurrentViewReleasedFromDisplaced(poseMatrix, followUpMatrix);
      } catch (error) {
        followUpProofFailure = error;
      }

      // The follow-up is intentionally not run-registered, so discardRun cannot
      // own its artifact cleanup. Once a completed result has supplied its proof,
      // explicitly release it even when a later metadata assertion failed.
      let followUpReleaseFailure: unknown;
      if (followUpJob.state === "completed" && followUpJobId) {
        try {
          const released = record(
            await application.releaseJob(sessionId, followUpJobId),
            "matrix pilot follow-up release",
          );
          if (released.artifactRemoved !== true) {
            throw new Error("Matrix pilot follow-up artifact was not explicitly removed");
          }
          diagnostics.push("follow-up current capture artifact explicitly released");
        } catch (error) {
          followUpReleaseFailure = error;
        }
      }
      if (followUpProofFailure && followUpReleaseFailure) {
        throw new AggregateError(
          [followUpProofFailure, followUpReleaseFailure],
          "Matrix pilot follow-up proof and explicit release both failed",
        );
      }
      if (followUpProofFailure) throw followUpProofFailure;
      if (followUpReleaseFailure) throw followUpReleaseFailure;
      return { distanceMeters: distanceMeters! };
    },
    (result) => ({
      cameraRestored: true,
      followUpCompleted: true,
      artifactRemoved: true,
      displacementMeters: result.distanceMeters,
    }),
  );
  diagnostics.push(
    `follow-up current capture released ${recovery.distanceMeters.toFixed(3)}m from the pose position`
  );

  await scheduler.finishCase(publicTerminal);
  await application.discardRun(managedRunId);

  const finishedAt = Date.now();
  if (finishedAt > caseDeadlineMs) throw new Error("Runtime matrix case exceeded its absolute deadline");
  const elapsedMs = Math.min(caseBudgetMs, Math.max(0, finishedAt - caseStartedAt));
  return {
    caseId: matrixCase.id,
    schedule: {
      backend: "runtime",
      view: matrixCase.view,
      phase: matrixCase.injection.phase,
      action: matrixCase.injection.action,
    },
    result: "passed",
    publicTerminal,
    deadline: { outcome: "completed", elapsedMs, budgetMs: caseBudgetMs },
    worldRevision: "unchanged",
    camera: "restored",
    artifact: "not_created",
    cleanup: {
      lifecycleVacant: false,
      endpointVacant: false,
      childVacant: false,
      exactOwnerVacant: false,
    },
    control: { arrival: "arrived", action: "executed" },
    retainedDiagnostics: diagnostics.map((tail) => matrixRetainedDiagnostic(tail)),
  };
}

/**
 * Runtime-only orchestration for the Phase 2 fault-matrix pilot: fixture
 * preparation, barrier wait, action dispatch, public-result capture before
 * diagnostics, the mandatory post-fault follow-up probe, and conversion to
 * the shared v3 evidence entry. CLI/live-run authorization stays owned by
 * scripts/run-runtime-observer-acceptance.ts, which delegates here once a
 * matrix case has been selected.
 */
export async function runRuntimeFailureMatrix(
  options: RuntimeFailureMatrixOptions
): Promise<RuntimeFailureMatrixResult> {
  assertLiveRuntimeObserverAuthorized(options.confirmed, options.environment);
  const matrixCase: FaultMatrixCase = caseForId(OBSERVER_FAULT_MATRIX, options.only);
  if (matrixCase.backend !== "runtime") {
    throw new Error(`Fault-matrix case ${options.only} is not a runtime case`);
  }
  if ((options.launchArguments?.length ?? 0) > 0) {
    throw new Error("Runtime fault-matrix mode rejects --launch-arg; launch and fixture arguments are fully owned");
  }

  const worldResource = boundedText(
    options.worldResource ?? DEFAULT_RUNTIME_OBSERVER_WORLD,
    "Runtime matrix world resource",
    1_024
  );
  const executable = findRuntimeExecutable(options.executablePath);
  const validationRoot = options.validationRoot ?? join(REPOSITORY_ROOT, "docs", "validation");

  assertArmaVacant("Runtime failure-matrix preflight");
  const artifactRoot = resolveRuntimeAcceptanceArtifactRoot(options.artifactRoot);
  const runDirectory = mkdtempSync(join(artifactRoot, "matrix-run-"));
  try {
  const managedRoot = join(runDirectory, "managed");
  const profileRoot = join(runDirectory, "profiles");
  const evidenceRoot = join(runDirectory, "evidence");
  const fixtureCopyDirectory = join(runDirectory, "fixture");
  for (const directory of [managedRoot, profileRoot, evidenceRoot]) mkdirSync(directory);
  cpSync(FIXTURE_TEMPLATE_DIR, fixtureCopyDirectory, { recursive: true });
  const fixture = inspectAddonFixture(fixtureCopyDirectory);
  if (!fixture) {
    throw new Error("Generated runtime matrix fixture copy is missing its .gproj identity");
  }
  const fixtureTemplateIdentity = operationalBaselineDirectoryIdentity(
    FIXTURE_TEMPLATE_DIR, RUNTIME_FIXTURE_SOURCE_EXTENSIONS
  );
  const fixtureContentIdentity = operationalBaselineDirectoryIdentity(
    fixtureCopyDirectory, RUNTIME_FIXTURE_SOURCE_EXTENSIONS
  );
  if (fixtureTemplateIdentity.fileCount !== fixtureContentIdentity.fileCount ||
      fixtureTemplateIdentity.sha256 !== fixtureContentIdentity.sha256) {
    throw new Error("Generated runtime matrix fixture copy does not match its committed template");
  }

  const runStartedAt = Date.now();
  let caseStartedAt = runStartedAt;
  let caseDeadlineMs = caseStartedAt + CASE_TIMEOUT_MS;
  const application = createObserverApplication({
    agentPath: PRIVATE_CHILD_PATH,
    managedRoot,
    profileRoot,
    projectPath: fixture.addonDirectory,
    sourceAddon: OBSERVER_SOURCE_PATH,
    evidenceRoots: [evidenceRoot],
    startupTimeoutMs: 20_000,
    requestTimeoutMs: 60_000,
    defaultCaptureTimeoutMs: CASE_TIMEOUT_MS,
    maxInlineImageBytes: 64 * 1024 * 1024,
  });
  const runtimeManager = new OwnedRuntimeManager({
    managedRoot,
    gamePath: join(executable, ".."),
    projectPath: fixture.addonDirectory,
    observerGate: application,
    executableResolver: () => executable,
  });
  const readProcessCounts = () => {
    const runtimeChildren = runtimeManager.diagnosticSupervisedChildCounts();
    const observerPrivateChildren = application.diagnosticPrivateChildCount();
    return {
      active: runtimeChildren.active + observerPrivateChildren,
      reconciling: runtimeChildren.reconciling,
      total: runtimeChildren.total + observerPrivateChildren,
    };
  };
  const baseline = new OperationalBaselineRecorder({
    backend: "runtime",
    readSupervisedProcessCounts: readProcessCounts,
  });
  const baselineEnvironment = operationalBaselineEnvironment({ gameExecutable: executable });
  const baselineSource = operationalBaselineSource(
    join(REPOSITORY_ROOT, "scripts", "observer-runtime-failure-matrix.ts"),
    "scripts/observer-runtime-failure-matrix.ts",
    REPOSITORY_ROOT,
    RUNTIME_FAILURE_MATRIX_SOURCES,
    OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES
  );
  baseline.sampleProcessCounts("rest.beforeLaunch");

  let runtimeId: string | null = null;
  let sessionId: string | null = null;
  let managedRunId: string | null = null;
  let faultScaffolding: FaultMatrixRunScaffolding | null = null;
  let caseEntry: MatrixCaseEntry | null = null;
  let observedFailedCaseEntry: MatrixCaseEntry | null = null;
  let observedPublicTerminal: MatrixCaseEntry["publicTerminal"] | null = null;
  let failure: unknown = null;
  let controlCapability: string | null = null;
  const matrixKnownSecretValues: string[] = [];
  const rememberMatrixSecret = (value: string | null | undefined): void => {
    if (value && !matrixKnownSecretValues.includes(value)) matrixKnownSecretValues.push(value);
  };
  let exactRuntimeVacancy = false;
  let globalVacant = false;
  let supervisedVacant = false;
  let baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity(
    launchArguments(worldResource, fixture, options.launchArguments)
  );

  try {
    await baseline.measure(
      "managed_call",
      "ObserverApplication.ensureSetup",
      () => application.ensureSetup(),
      "setup"
    );
    const begun = record(
      await application.beginRun({
        title: `Runtime observer failure-matrix pilot: ${matrixCase.id}`,
        caseIds: [matrixCase.id],
        procedureRevision: "runtime-failure-matrix-v1",
        idempotencyKey: `runtime-matrix-${randomUUID()}`,
      }),
      "matrix observer run"
    );
    managedRunId = String(begun.runId ?? "");
    if (!managedRunId) throw new Error("Observer run begin returned no run ID");
    rememberMatrixSecret(managedRunId);

    const baseArguments = launchArguments(worldResource, fixture, options.launchArguments);
    const prepared = record(
      await prepareObserverLaunch(application, {
        runtimeKind: "listenServer",
        arguments: baseArguments,
        profilePath: join(profileRoot, "graphical-runtime"),
        sessionTtlMs: CASE_TIMEOUT_MS + 120_000,
        transportPreference: ["rest", "mailbox"],
        forceUpdate: true,
        idempotencyKey: `runtime-matrix-launch-${randomUUID()}`,
      }, runtimeManager),
      "matrix prepared launch"
    );
    baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity([
      ...(Array.isArray(prepared.arguments) ? (prepared.arguments as string[]) : baseArguments),
      "-reforgerForgeOwnerToken=<redacted>",
    ]);
    sessionId = String(prepared.sessionId ?? "");
    const preparedLaunchId = String(prepared.preparedLaunchId ?? "");
    if (!sessionId || !preparedLaunchId) {
      throw new Error("Observer launch preparation returned no owned-runtime handle");
    }
    rememberMatrixSecret(sessionId);
    rememberMatrixSecret(preparedLaunchId);

    assertArmaVacant("Runtime failure-matrix launch");
    const launch = await baseline.measure(
      "launch",
      "OwnedRuntimeManager.start/status(running)",
      async () => {
        const startedRuntime = await runtimeManager.start({
          preparedLaunchId,
          idempotencyKey: `runtime-matrix-start-${randomUUID()}`,
        });
        runtimeId = startedRuntime.runtimeId;
        rememberMatrixSecret(runtimeId);
        if (startedRuntime.state !== "running" || startedRuntime.exactOwned !== true ||
            startedRuntime.sessionId !== sessionId) {
          throw new Error("Owned runtime did not start with an exact session-bound identity for the matrix pilot");
        }
        const runningRuntime = await baseline.measure(
          "managed_call",
          "OwnedRuntimeManager.status",
          () => runtimeManager.status(startedRuntime.runtimeId),
          "representative_status_api"
        );
        if (runningRuntime.state !== "running" || runningRuntime.exactOwned !== true ||
            runningRuntime.sessionId !== sessionId) {
          throw new Error("Owned runtime status did not confirm the exact running matrix process");
        }
        return { startedRuntime, runningRuntime };
      },
      "running_confirmation"
    );
    const { startedRuntime } = launch;
    const runtimeLifecycle = await runtimeManager.lifecycleIdentity(startedRuntime.runtimeId);
    rememberMatrixSecret(runtimeLifecycle.runtimeId);
    rememberMatrixSecret(runtimeLifecycle.generation);

    // The profile directory is normally created by the launched process
    // itself; create it defensively so the control root's parent is always
    // present regardless of exact engine/staging timing. Enfusion mounts
    // $profile: at a "profile" subdirectory of the -profile argument value,
    // not the argument value itself (see resolveEngineProfileDirectory) --
    // the fixture's control root must live under that real engine mount or
    // the fixture can never observe it.
    const profileDirectory = join(profileRoot, "graphical-runtime");
    mkdirSync(profileDirectory, { recursive: true });
    const engineProfileDirectory = resolveEngineProfileDirectory(profileDirectory, { create: true });
    const controlRoot = join(engineProfileDirectory, FIXTURE_CONTROL_DIRECTORY_NAME);
    const faultBinding = Object.freeze({
      fixtureId: fixture.addonGuid,
      lifecycleId: runtimeLifecycle.runtimeId,
      lifecycleGeneration: runtimeLifecycle.generation,
    });
    controlCapability = randomUUID();
    rememberMatrixSecret(controlCapability);
    faultScaffolding = createFaultMatrixRunScaffolding({
      runRoot: profileDirectory,
      controlRoot,
      matrix: OBSERVER_FAULT_MATRIX,
      bootstrap: {
        schemaVersion: 1,
        runId: managedRunId,
        backend: "runtime",
        capability: controlCapability,
        fixtureContentIdentity: fixtureContentIdentity.sha256,
        generatedProjectIdentity: fixture.addonGuid,
        generatedAddonIdentity: fixture.addonGuid,
        binding: faultBinding,
      },
      clock: systemClock,
      sleeper: systemSleeper,
      caseDeadlineMs: CASE_TIMEOUT_MS,
      readLifecycleBinding: () => faultBinding,
    });

    const remainingForInventory = CASE_TIMEOUT_MS;
    const inventory = await baseline.measure(
      "managed_call",
      "ObserverApplication.instances(renderersOnly)",
      () => application.instances({
        sessionId: sessionId ?? undefined,
        requiredCapabilities: ["render.capture", "camera.runtime"],
        renderersOnly: true,
        waitMs: remainingForInventory,
      }),
      "instance_readiness"
    );
    const compatible = inventory.instances.filter((instance) =>
      instance.backend !== "workbench" && instance.sessionId === sessionId &&
      instance.runtimeKind === "listenServer" && instance.stale !== true &&
      instance.transportHealthy !== false && instance.headless === false &&
      Array.isArray(instance.capabilities) &&
      ["render.capture", "camera.runtime"].every((capability) =>
        (instance.capabilities as unknown[]).includes(capability)));
    if (compatible.length !== 1 || inventory.timedOut) {
      throw new Error(`Expected exactly one graphical runtime observer, found ${compatible.length}`);
    }
    const selected = compatible[0]!;
    const instanceId = String(selected.instanceId ?? "");
    const worldId = typeof selected.worldId === "string" ? selected.worldId : "";
    const worldEpoch = selected.worldEpoch as number;
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(instanceId) || !worldId ||
        !Number.isSafeInteger(worldEpoch) || worldEpoch < 0) {
      throw new Error("Selected graphical runtime has invalid instance/world identity for the matrix pilot");
    }
    rememberMatrixSecret(instanceId);

    // The per-case deadline begins only after the exact runtime and renderer
    // are ready. Runtime startup is measured separately and must not silently
    // consume the barrier/action budget.
    caseStartedAt = Date.now();
    caseDeadlineMs = caseStartedAt + CASE_TIMEOUT_MS;
    faultScaffolding.scheduler.setDeadline(deadlineAt(caseDeadlineMs));
    caseEntry = await baseline.measure(
      "capture",
      "runPilotCancellationCase",
      () => runPilotCancellationCase({
        application,
        scheduler: faultScaffolding!.scheduler,
        matrixCase,
        managedRunId: managedRunId!,
        sessionId: sessionId!,
        instanceId,
        worldId,
        worldEpoch,
        caseStartedAt,
        caseDeadlineMs,
        caseBudgetMs: CASE_TIMEOUT_MS,
        baseline,
        onPublicTerminal: (terminal) => { observedPublicTerminal = terminal; },
        onFailedCaseEntry: (entry) => { observedFailedCaseEntry = entry; },
      }),
      "fault_matrix_pilot"
    );
  } catch (error) {
    failure = error;
  } finally {
    if (faultScaffolding) {
      try {
        await faultScaffolding.scheduler.finishCase();
      } catch (error) {
        failure ??= error;
      }
      try {
        removeOwnedFaultControlRoot(faultScaffolding.controlRoot);
      } catch (error) {
        // A live capability/bootstrap left behind is a case failure even when
        // the enclosing run directory is expected to be removed later.
        failure ??= error;
      }
    }
    if (!caseEntry && managedRunId) {
      try {
        await application.discardRun(managedRunId);
      } catch (error) {
        if (failure) {
          const cleanupErrorName = error instanceof Error ? error.name : "NonErrorThrow";
          failure = new AggregateError(
            [failure, error],
            `Matrix pilot failed and failed-case observer run discard also failed (${cleanupErrorName})`,
          );
        } else {
          failure = error;
        }
      }
    }
    exactRuntimeVacancy = runtimeId === null;
    if (runtimeId) {
      const ownedRuntimeId = runtimeId;
      const terminationSpan = baseline.start(
        "shutdown", "OwnedRuntimeManager.stop", "termination"
      );
      const observerCleanupSpan = baseline.start(
        "shutdown", "OwnedRuntimeManager.stop", "observer_cleanup"
      );
      let terminationRecorded = false;
      let observerCleanupRecorded = false;
      try {
        const stopped = await runtimeManager.stop({
          runtimeId: ownedRuntimeId,
          waitForRestorationMs: 20_000,
          idempotencyKey: `runtime-matrix-stop-${randomUUID()}`,
        });
        if (stopped.state !== "exited" || stopped.exactOwned !== true ||
            stopped.identityVacant !== true || stopped.terminationComplete !== true ||
            stopped.observerCleanupPending !== false) {
          throw new Error("Owned runtime stop did not prove exact termination and observer cleanup");
        }
        baseline.finish(terminationSpan, {
          observations: { terminationComplete: true, identityVacant: true },
        });
        terminationRecorded = true;
        baseline.finish(observerCleanupSpan, {
          observations: { observerCleanupPending: false },
        });
        observerCleanupRecorded = true;
        const vacantRuntime = await baseline.measure(
          "managed_call",
          "OwnedRuntimeManager.status(after stop)",
          () => runtimeManager.status(ownedRuntimeId),
          "shutdown_status_confirmation"
        );
        exactRuntimeVacancy = vacantRuntime.state === "exited" && vacantRuntime.exactOwned === true &&
          vacantRuntime.identityVacant === true && vacantRuntime.terminationComplete === true &&
          vacantRuntime.observerCleanupPending === false;
        if (!exactRuntimeVacancy) {
          throw new Error("Owned runtime status did not revalidate exact-process vacancy");
        }
      } catch (error) {
        if (!terminationRecorded) {
          try {
            baseline.finish(terminationSpan, {
              outcome: "failed",
              errorName: error instanceof Error ? error.name : "NonErrorThrow",
            });
          } catch { /* preserve the primary shutdown failure */ }
        }
        if (!observerCleanupRecorded) {
          try {
            baseline.finish(observerCleanupSpan, {
              outcome: "failed",
              errorName: error instanceof Error ? error.name : "NonErrorThrow",
            });
          } catch { /* preserve the primary shutdown failure */ }
        }
        failure ??= error;
      }
    }
    if (sessionId && exactRuntimeVacancy) {
      try {
        await application.revokeSession(sessionId);
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await baseline.measure(
        "shutdown",
        "ObserverApplication.close",
        () => closeObserverRuntimeLifecycle(runtimeManager, application),
        "observer_process_cleanup"
      );
    } catch (error) {
      failure ??= error;
    }
    try {
      assertArmaVacant("Runtime failure-matrix cleanup");
      globalVacant = true;
    } catch (error) {
      failure ??= error;
    }
    try {
      const evidence = await baseline.measure(
        "shutdown",
        "waitForOperationalBaselineProcessVacancy",
        async () => {
          const result = await waitForOperationalBaselineProcessVacancy(readProcessCounts);
          if (!result.vacant) {
            const error = new Error(
              `Supervised process vacancy was not observed after the matrix pilot case (active=${result.counts.active})`
            );
            error.name = "SupervisedProcessVacancyTimeoutError";
            throw error;
          }
          return result;
        },
        "supervised_exit_settle",
        (result) => ({
          vacant: result.vacant,
          polls: result.polls,
          waitedMs: result.waitedMs,
          finalActive: result.counts.active,
          finalReconciling: result.counts.reconciling,
          finalTotal: result.counts.total,
        })
      );
      supervisedVacant = evidence.vacant;
    } catch (error) {
      failure ??= error;
    }
    const entryBeforeCleanup = caseEntry ?? observedFailedCaseEntry;
    if (entryBeforeCleanup) {
      const entryAfterCleanup: MatrixCaseEntry = {
        ...entryBeforeCleanup,
        cleanup: {
          lifecycleVacant: exactRuntimeVacancy,
          endpointVacant: globalVacant,
          childVacant: supervisedVacant,
          exactOwnerVacant: exactRuntimeVacancy,
        },
      };
      if (caseEntry) caseEntry = entryAfterCleanup;
      else observedFailedCaseEntry = entryAfterCleanup;
      if (!exactRuntimeVacancy || !globalVacant || !supervisedVacant) {
        if (caseEntry) caseEntry = { ...caseEntry, result: "failed" };
        else observedFailedCaseEntry = { ...entryAfterCleanup, result: "failed" };
        failure ??= new Error("Matrix pilot case cleanup did not prove full vacancy");
      }
    }
    baseline.sampleProcessCounts("rest.afterShutdown");
  }
  const overallResult: "passed" | "failed" = failure || !caseEntry || caseEntry.result !== "passed" ? "failed" : "passed";
  const finalCaseEntry: MatrixCaseEntry = caseEntry ?? observedFailedCaseEntry ?? {
    caseId: matrixCase.id,
    schedule: {
      backend: "runtime",
      view: matrixCase.view,
      phase: matrixCase.injection.phase,
      action: matrixCase.injection.action,
    },
    result: "failed",
    publicTerminal: observedPublicTerminal ?? { state: "failed", errorCode: "INTERNAL_ERROR" },
    deadline: {
      outcome: Date.now() >= caseDeadlineMs ? "expired" : "cancelled",
      elapsedMs: Math.min(CASE_TIMEOUT_MS, Math.max(0, Date.now() - caseStartedAt)),
      budgetMs: CASE_TIMEOUT_MS,
    },
    worldRevision: "unavailable",
    camera: "unproven",
    artifact: "unproven",
    cleanup: {
      lifecycleVacant: exactRuntimeVacancy,
      endpointVacant: globalVacant,
      childVacant: supervisedVacant,
      exactOwnerVacant: exactRuntimeVacancy,
    },
    retainedDiagnostics: failure
      ? [matrixRetainedDiagnostic(
        failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure),
        matrixKnownSecretValues
      )]
      : [],
  };

  const limitations = [
    "Phase 2 pilot: exactly one declared runtime case (cancellation at lease_acquired, explicit pose).",
    "The remaining canonical cancellation phases and fault families are deferred until this pilot has a retained passing live result with measured timings.",
    "The fixture's control-channel authorizer is hardcoded to this one declared case rather than a general port of FaultControlAuthorizer.",
  ];
  const workload = {
    procedureRevision: "runtime-failure-matrix-v1",
    runtimeKind: "listenServer" as const,
    overallTimeoutMs: CASE_TIMEOUT_MS,
    worldResource,
    fixture: {
      kind: "addon" as const,
      id: fixture.addonId,
      guid: fixture.addonGuid,
      sourceFileCount: fixtureTemplateIdentity.fileCount,
      sourceSha256: fixtureTemplateIdentity.sha256,
    },
    capture: {
      labels: ["matrix-pilot-pose", "matrix-pilot-followup-current"],
      settleFrames: 3,
      performancePolicy: "evidence" as const,
      asynchronous: true,
      configurationSha256: fixtureContentIdentity.sha256,
    },
    launchArguments: baselineLaunchArguments,
  };
  const baselineArtifact = baseline.artifact({
    result: overallResult,
    environment: baselineEnvironment,
    workload,
    source: baselineSource,
    limitations,
    ...(overallResult === "failed" ? {
      failureName: failure instanceof Error ? failure.name : "RuntimeFailureMatrixError",
    } : {}),
  });
  const artifact = buildObserverFailureMatrixArtifact({
    backend: "runtime",
    result: overallResult,
    startedAt: baselineArtifact.startedAt,
    finishedAt: baselineArtifact.finishedAt,
    durationMs: baselineArtifact.durationMs,
    environment: baselineArtifact.environment,
    workload: baselineArtifact.workload,
    matrix: OBSERVER_FAULT_MATRIX,
    cases: [finalCaseEntry],
    source: baselineArtifact.source,
    measurements: baselineArtifact.measurements,
    processCounts: baselineArtifact.processCounts,
    limitations: baselineArtifact.limitations,
    failure: baselineArtifact.failure,
    knownSecretValues: matrixKnownSecretValues,
  });

  const publication = writeObserverFailureMatrixArtifact(
    validationRoot,
    artifact,
    OBSERVER_FAULT_MATRIX,
    matrixKnownSecretValues
  );

  // --keep-profile only ever preserves scratch for a failed selected case;
  // a passing run has nothing left to debug.
  const preserveRunDirectory = Boolean(failure) && Boolean(options.keepProfile);
  if (!preserveRunDirectory) {
    try { rmSync(runDirectory, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
  }

  if (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    error.message = `${error.message}. Runtime failure-matrix artifact: ${publication.jsonPath}` +
      (preserveRunDirectory ? ` (run directory retained: ${runDirectory})` : "");
    throw error;
  }
  return { ...publication, runDirectory: null };
  } catch (error) {
    if (!options.keepProfile) {
      try { rmSync(runDirectory, { recursive: true, force: true }); } catch { /* preserve the root failure */ }
    }
    throw error;
  }
}
