import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { caseForId, OBSERVER_FAULT_MATRIX, type FaultMatrixCase } from "../observer/protocol/fault-matrix.js";
import { systemClock, systemSleeper } from "../src/foundation/time.js";
import {
  createObserverApplication,
  type ObserverApplication,
} from "../src/observer/application.js";
import { prepareObserverLaunch } from "../src/observer/launch.js";
import { OwnedRuntimeManager } from "../src/observer/owned-runtime-manager.js";
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
 *  only has to implement four methods instead of the full ObserverApplication. */
export type MatrixPilotCaseApplication = Pick<
  ObserverApplication, "capture" | "cancelJob" | "jobStatus" | "discardRun"
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
}

async function pollJobTerminal(
  application: MatrixPilotCaseApplication,
  sessionId: string,
  jobId: string,
  deadlineMs: number
): Promise<Record<string, unknown>> {
  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  for (;;) {
    const job = record(await application.jobStatus(sessionId, jobId), "matrix pilot job status");
    if (terminalStates.has(String(job.state))) return job;
    if (Date.now() >= deadlineMs) {
      throw new Error(`Matrix pilot job ${jobId} did not reach a terminal state before the case deadline`);
    }
    await delay(100);
  }
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
  const captureTimeoutMs = Math.max(1_000, Math.min(60_000, caseDeadlineMs - Date.now()));
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

  const arrived = await scheduler.arm(matrixCase.id);
  diagnostics.push(`barrier arrived: phase=${arrived.arrived.phase} disposition=${arrived.arrived.disposition}`);

  await application.cancelJob(sessionId, jobId);
  const executed = await scheduler.releaseBarrier("cancel");
  diagnostics.push(`barrier released: disposition=${executed.disposition}`);

  const finalJob = await pollJobTerminal(application, sessionId, jobId, caseDeadlineMs);
  const finalErrorCode = typeof finalJob.errorCode === "string" ? finalJob.errorCode : null;
  if (finalJob.state !== matrixCase.expectedTerminal.state || finalErrorCode !== matrixCase.expectedTerminal.errorCode) {
    throw new Error(
      `Matrix pilot job reached state=${String(finalJob.state)} errorCode=${String(finalErrorCode)}, ` +
      `expected state=${matrixCase.expectedTerminal.state} errorCode=${String(matrixCase.expectedTerminal.errorCode)}`
    );
  }
  const lease = record(finalJob.cameraLease, "matrix pilot job camera lease");
  if (lease.everHeld !== true || lease.held !== false || lease.restorationConfirmed !== true) {
    throw new Error("Matrix pilot job did not prove camera acquisition followed by restoration after cancellation");
  }

  // Mandatory follow-up: a fresh synchronous current capture must succeed
  // and be materially displaced from the explicit pose, proving no stale
  // lease or held camera survived the cancellation.
  const followUp = await application.capture({
    runId: managedRunId,
    captureLabel: "matrix-pilot-followup-current",
    purpose: "Prove no stale camera lease survives the cancelled fault-matrix pilot case",
    sessionId,
    instanceId,
    expectedWorldId: worldId,
    expectedWorldEpoch: worldEpoch,
    idempotencyKey: `${managedRunId}-${matrixCase.id}-followup`,
    view: { kind: "current" },
    settleFrames: 3,
    performancePolicy: "evidence",
    asynchronous: false,
    timeoutMs: captureTimeoutMs,
  });
  if (followUp.asynchronous) throw new Error("Matrix pilot follow-up capture unexpectedly returned asynchronously");
  const followUpJob = record(followUp.job, "matrix pilot follow-up job");
  if (followUpJob.state !== "completed") {
    throw new Error("Matrix pilot follow-up current capture did not complete after cancellation");
  }
  const followUpMetadata = record(followUp.metadata, "matrix pilot follow-up metadata");
  const followUpMatrix = captureMatrix(followUpMetadata, "Matrix pilot follow-up capture");
  const poseMatrix = runtimePoseMatrix(poseView);
  const distanceMeters = assertCurrentViewReleasedFromDisplaced(poseMatrix, followUpMatrix);
  diagnostics.push(`follow-up current capture released ${distanceMeters.toFixed(3)}m from the pose position`);

  await scheduler.finishCase();
  await application.discardRun(managedRunId);

  const elapsedMs = Date.now() - caseStartedAt;
  return {
    caseId: matrixCase.id,
    schedule: {
      backend: "runtime",
      view: matrixCase.view,
      phase: matrixCase.injection.phase,
      action: matrixCase.injection.action,
    },
    result: "passed",
    publicTerminal: { state: finalJob.state as string, errorCode: finalErrorCode },
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
    retainedDiagnostics: diagnostics.map((tail) => matrixRetainedDiagnostic(tail)),
  };
}

/**
 * Runtime-only orchestration for the Phase 2 fault-matrix pilot: fixture
 * preparation, barrier wait, action dispatch, public-result capture before
 * diagnostics, the mandatory post-fault follow-up probe, and conversion to
 * the shared v2 evidence entry. CLI/live-run authorization stays owned by
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

  const caseStartedAt = Date.now();
  const caseDeadlineMs = caseStartedAt + CASE_TIMEOUT_MS;
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

  let runtimeId: string | null = null;
  let sessionId: string | null = null;
  let managedRunId: string | null = null;
  let faultScaffolding: FaultMatrixRunScaffolding | null = null;
  let caseEntry: MatrixCaseEntry | null = null;
  let failure: unknown = null;
  let controlCapability: string | null = null;
  let baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity(
    launchArguments(worldResource, fixture, options.launchArguments)
  );

  try {
    await application.ensureSetup();
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

    assertArmaVacant("Runtime failure-matrix launch");
    const startedRuntime = await runtimeManager.start({
      preparedLaunchId,
      idempotencyKey: `runtime-matrix-start-${randomUUID()}`,
    });
    runtimeId = startedRuntime.runtimeId;
    if (startedRuntime.state !== "running" || startedRuntime.exactOwned !== true) {
      throw new Error("Owned runtime did not start with an exact identity for the matrix pilot");
    }
    const runtimeLifecycle = await runtimeManager.lifecycleIdentity(startedRuntime.runtimeId);

    // The profile directory is normally created by the launched process
    // itself; create it defensively so the control root's parent is always
    // present regardless of exact engine/staging timing.
    const profileDirectory = join(profileRoot, "graphical-runtime");
    mkdirSync(profileDirectory, { recursive: true });
    const controlRoot = join(profileDirectory, FIXTURE_CONTROL_DIRECTORY_NAME);
    const faultBinding = Object.freeze({
      fixtureId: fixture.addonGuid,
      lifecycleId: runtimeLifecycle.runtimeId,
      lifecycleGeneration: runtimeLifecycle.generation,
    });
    controlCapability = randomUUID();
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
      readLifecycleBinding: () => faultBinding,
    });

    const remainingForInventory = Math.max(1_000, caseDeadlineMs - Date.now());
    const inventory = await application.instances({
      sessionId,
      requiredCapabilities: ["render.capture", "camera.runtime"],
      renderersOnly: true,
      waitMs: remainingForInventory,
    });
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

    caseEntry = await runPilotCancellationCase({
      application,
      scheduler: faultScaffolding.scheduler,
      matrixCase,
      managedRunId,
      sessionId,
      instanceId,
      worldId,
      worldEpoch,
      caseStartedAt,
      caseDeadlineMs,
      caseBudgetMs: CASE_TIMEOUT_MS,
    });
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
      } catch { /* best-effort; the run directory is removed or retained wholesale below */ }
    }
    if (!caseEntry && managedRunId) {
      try {
        await application.discardRun(managedRunId);
      } catch { /* preserve the primary failure */ }
    }
    let exactRuntimeVacancy = runtimeId === null;
    if (runtimeId) {
      try {
        const stopped = await runtimeManager.stop({
          runtimeId,
          waitForRestorationMs: 20_000,
          idempotencyKey: `runtime-matrix-stop-${randomUUID()}`,
        });
        exactRuntimeVacancy = stopped.state === "exited" && stopped.exactOwned === true &&
          stopped.identityVacant === true && stopped.terminationComplete === true &&
          stopped.observerCleanupPending === false;
      } catch (error) {
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
      await application.close();
    } catch (error) {
      failure ??= error;
    }
    let globalVacant = false;
    try {
      assertArmaVacant("Runtime failure-matrix cleanup");
      globalVacant = true;
    } catch (error) {
      failure ??= error;
    }
    let supervisedVacant = false;
    try {
      const evidence = await waitForOperationalBaselineProcessVacancy(readProcessCounts);
      supervisedVacant = evidence.vacant;
      if (!evidence.vacant) {
        failure ??= new Error(
          `Supervised process vacancy was not observed after the matrix pilot case (active=${evidence.counts.active})`
        );
      }
    } catch (error) {
      failure ??= error;
    }
    if (caseEntry) {
      caseEntry = {
        ...caseEntry,
        cleanup: {
          lifecycleVacant: exactRuntimeVacancy,
          endpointVacant: globalVacant,
          childVacant: supervisedVacant,
          exactOwnerVacant: exactRuntimeVacancy,
        },
      };
      if (!exactRuntimeVacancy || !globalVacant || !supervisedVacant) {
        caseEntry = { ...caseEntry, result: "failed" };
        failure ??= new Error("Matrix pilot case cleanup did not prove full vacancy");
      }
    }
  }

  const baselineEnvironment = operationalBaselineEnvironment({ gameExecutable: executable });
  const baselineSource = operationalBaselineSource(
    join(REPOSITORY_ROOT, "scripts", "observer-runtime-failure-matrix.ts"),
    "scripts/observer-runtime-failure-matrix.ts",
    REPOSITORY_ROOT,
    RUNTIME_OPERATIONAL_BASELINE_SOURCES,
    OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES
  );
  const overallResult: "passed" | "failed" = failure || !caseEntry || caseEntry.result !== "passed" ? "failed" : "passed";
  const finalCaseEntry: MatrixCaseEntry = caseEntry ?? {
    caseId: matrixCase.id,
    schedule: {
      backend: "runtime",
      view: matrixCase.view,
      phase: matrixCase.injection.phase,
      action: matrixCase.injection.action,
    },
    result: "failed",
    publicTerminal: { state: "failed", errorCode: null },
    deadline: { outcome: "expired", elapsedMs: Date.now() - caseStartedAt, budgetMs: CASE_TIMEOUT_MS },
    worldRevision: "unavailable",
    camera: "unproven",
    artifact: "unproven",
    cleanup: { lifecycleVacant: false, endpointVacant: false, childVacant: false, exactOwnerVacant: false },
    retainedDiagnostics: failure
      ? [matrixRetainedDiagnostic(failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure))]
      : [],
  };

  const artifact = buildObserverFailureMatrixArtifact({
    backend: "runtime",
    result: overallResult,
    startedAt: new Date(caseStartedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - caseStartedAt,
    environment: baselineEnvironment,
    workload: {
      procedureRevision: "runtime-failure-matrix-v1",
      runtimeKind: "listenServer",
      overallTimeoutMs: CASE_TIMEOUT_MS,
      worldResource,
      fixture: {
        kind: "addon",
        id: fixture.addonId,
        guid: fixture.addonGuid,
        sourceFileCount: fixtureTemplateIdentity.fileCount,
        sourceSha256: fixtureTemplateIdentity.sha256,
      },
      capture: {
        labels: ["matrix-pilot-pose", "matrix-pilot-followup-current"],
        settleFrames: 3,
        performancePolicy: "evidence",
        asynchronous: true,
        configurationSha256: fixtureContentIdentity.sha256,
      },
      launchArguments: baselineLaunchArguments,
    },
    source: baselineSource,
    matrix: OBSERVER_FAULT_MATRIX,
    cases: [finalCaseEntry],
    measurements: [],
    processCounts: [],
    limitations: [
      "Phase 2 pilot: exactly one declared runtime case (cancellation at lease_acquired, explicit pose).",
      "The remaining canonical cancellation phases and fault families are deferred until this pilot has a retained live result.",
      "The fixture's control-channel authorizer is hardcoded to this one declared case rather than a general port of FaultControlAuthorizer.",
    ],
    failure: failure ? { name: failure instanceof Error ? failure.name : "RuntimeFailureMatrixError" } : null,
    knownSecretValues: controlCapability ? [fixture.addonGuid, controlCapability] : [fixture.addonGuid],
  });

  const publication = writeObserverFailureMatrixArtifact(
    validationRoot,
    artifact,
    OBSERVER_FAULT_MATRIX,
    controlCapability ? [fixture.addonGuid, controlCapability] : [fixture.addonGuid]
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
}
