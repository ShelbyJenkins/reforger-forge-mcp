import {
  caseForId,
  OBSERVER_FAULT_MATRIX,
  type WorkbenchFaultMatrixCase,
} from "../../observer/protocol/fault-matrix.js";
import type {
  RunWorkbenchMatrixCaseInput,
  WorkbenchMatrixCaseActions,
  WorkbenchMatrixCaseAdapter,
  WorkbenchMatrixCaseApplication,
  WorkbenchMatrixCaseScheduler,
} from "../../scripts/run-workbench-observer-acceptance.js";
import type { ObserverCaptureView } from "../../src/observer/application.js";
import {
  workbenchCameraMatrix,
  type WorkbenchCameraMatrix,
} from "../../src/workbench/observer-adapter.js";
import type {
  FaultControlAcknowledgement,
} from "../../scripts/observer-fault-matrix-support.js";

export const SLICE_CASE = caseForId(
  OBSERVER_FAULT_MATRIX,
  "workbench.cancel_capture.lease_acquired.pose"
) as WorkbenchFaultMatrixCase;

const BASELINE_MATRIX: WorkbenchCameraMatrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0, 0, 0],
];

const BASELINE_CURRENT = {
  actualCamera: {
    matrix: BASELINE_MATRIX,
    position: BASELINE_MATRIX[3],
    verticalFov: 60,
    nearPlane: 0.1,
    farPlane: 2_000,
  },
  ownerCameraId: 7,
  worldIdentity: "world-1",
};

function viewFor(matrixCase: WorkbenchFaultMatrixCase): ObserverCaptureView {
  if (matrixCase.view === "current") return { kind: "current" };
  if (matrixCase.view === "pose") {
    return {
      kind: "pose",
      position: [96, 90, -5],
      orientation: [0, 0, 0, 1],
      fov: 60,
    };
  }
  return {
    kind: "lookAt",
    position: [10, 20, 30],
    target: [0, 0, 0],
    fov: 65,
  };
}

function acknowledgement(
  matrixCase: WorkbenchFaultMatrixCase,
  kind: "arrived" | "executed" | "terminalled"
): FaultControlAcknowledgement {
  return {
    schemaVersion: 1,
    kind,
    requestId: "11111111-1111-4111-8111-111111111111",
    caseId: matrixCase.id,
    phase: matrixCase.injection.phase,
    disposition: kind,
    reason: null,
  };
}

function publicStatus(
  state: string,
  errorCode: string | null,
  restored: boolean,
  view: ObserverCaptureView = { kind: "current" },
  worldIdentity = "world-1"
): Record<string, unknown> {
  const matrix = view.kind === "current" ? BASELINE_MATRIX : workbenchCameraMatrix(view);
  const verticalFov = view.kind === "current" ? 60 : view.fov;
  return {
    state,
    ...(errorCode ? { terminalErrorCode: errorCode } : {}),
    cameraLeaseHeld: !restored,
    restorationConfirmed: restored,
    worldId: "world-1",
    worldIdentity,
    ownerCameraId: 7,
    actualCamera: {
      matrix,
      position: matrix[3],
      verticalFov,
      nearPlane: 0.1,
      farPlane: 2_000,
    },
    artifact: state === "completed" ? {
      bytes: 4,
      contentSha256: "0".repeat(64),
      width: 1,
      height: 1,
    } : undefined,
  };
}

export interface FakeHarness {
  readonly input: RunWorkbenchMatrixCaseInput;
  readonly calls: string[];
}

export function fakeHarness(matrixCase: WorkbenchFaultMatrixCase): FakeHarness {
  const calls: string[] = [];
  let barrierReleased = false;
  let handlerLossArmed = false;
  let handlerLossConsumed = false;
  let shutdownComplete = false;
  let exactExitRequired = false;
  let terminalReleaseShutdownArmed = false;
  let handlerLossCategory: "inactive" | "handler_request_lost" | "handler_response_lost" = "inactive";
  const action = matrixCase.injection.action;
  const phase = matrixCase.injection.phase;
  const captureView = viewFor(matrixCase);

  const completed = (view: ObserverCaptureView = { kind: "current" }) =>
    publicStatus("completed", null, true, view);
  const terminalForPrimary = (): Record<string, unknown> => {
    if (action === "replace_fixture_world" && phase !== "terminal_release") {
      return publicStatus("failed", "RESTORATION_UNCONFIRMED", false);
    }
    if (action === "stop_owned_workbench" && matrixCase.cameraDisposition === "exact_process_exit") {
      return publicStatus("failed", "WORKBENCH_EXITED", false);
    }
    return completed(captureView);
  };

  const application = {
    async capture(input: Parameters<WorkbenchMatrixCaseApplication["capture"]>[0]) {
      const captureKind = String(input.idempotencyKey).includes("matrix-competing")
        ? "matrix-competing"
        : String(input.idempotencyKey).includes("matrix-followup-current")
          ? "matrix-followup-current"
          : "matrix-primary";
      calls.push(`capture:${captureKind}`);
      if (captureKind === "matrix-competing") {
        throw Object.assign(new Error("camera busy"), { code: "CAMERA_BUSY" });
      }
      if (captureKind === "matrix-followup-current") {
        return { asynchronous: true as const, job: { jobId: "job-followup", state: "submitted" } };
      }
      if (phase === "before_lease" && barrierReleased) {
        if (action === "disable_fixture_handler" && handlerLossArmed && !handlerLossConsumed) {
          handlerLossConsumed = true;
          handlerLossCategory = "handler_response_lost";
          calls.push("capturePingResponseLost");
          throw Object.assign(new Error("lost real capture Ping response"), { code: "HANDLER_UNAVAILABLE" });
        }
        if (action === "replace_fixture_world") {
          throw Object.assign(new Error("world changed"), { code: "WORLD_CHANGED" });
        }
        if (action === "stop_owned_workbench" && shutdownComplete) {
          throw Object.assign(new Error("Workbench exited"), { code: "WORKBENCH_EXITED" });
        }
      }
      return { asynchronous: true as const, job: { jobId: "job-primary", state: "submitted" } };
    },
    async cancelJob(_sessionId: string | undefined, jobId: string) {
      calls.push(`cancel:${jobId}`);
      return publicStatus("cancelled", null, true);
    },
    async jobStatus(_sessionId: string | undefined, jobId: string) {
      calls.push(`jobStatus:${jobId}`);
      if (jobId === "job-followup") return completed();
      if (action === "disable_fixture_handler") {
        handlerLossCategory = phase === "before_lease" || matrixCase.view === "pose"
          ? "handler_response_lost"
          : "handler_request_lost";
        throw Object.assign(new Error("handler unavailable"), { code: "TRANSPORT_UNAVAILABLE" });
      }
      if (action === "stop_owned_workbench" && phase === "terminal_release" &&
          terminalReleaseShutdownArmed) {
        calls.push("preReleaseShutdown");
        shutdownComplete = true;
      }
      if (action === "write_truncated_artifact" || action === "write_crc_artifact" ||
          action === "write_mismatched_artifact") {
        throw Object.assign(new Error("artifact invalid"), { code: "ARTIFACT_INVALID" });
      }
      return terminalForPrimary();
    },
    async readJob(_sessionId: string | undefined, jobId: string) {
      calls.push(`read:${jobId}`);
      return {
        job: {
          ...completed(),
          ...(action === "release_twice" && jobId === "job-primary" ? {
            handlerRelease: {
              idempotentReplay: {
                attempted: true,
                identicalRequest: true,
                equivalentAcknowledgement: true,
              },
            },
          } : {}),
        },
        image: Buffer.from([1, 2, 3, 4]),
        metadata: {
          contentSha256: "0".repeat(64),
          bytes: 4,
          width: 1,
          height: 1,
          actualCamera: jobId === "job-primary"
            ? terminalForPrimary().actualCamera
            : BASELINE_CURRENT.actualCamera,
        },
      };
    },
  } as WorkbenchMatrixCaseApplication;

  const adapter = {
    async ping() {
      calls.push("ping");
      if (handlerLossArmed && phase === "before_lease" && !handlerLossConsumed) {
        handlerLossConsumed = true;
        throw Object.assign(new Error("lost real ping response"), { code: "HANDLER_UNAVAILABLE" });
      }
      return {};
    },
    async status(jobId: string) {
      calls.push(`adapterStatus:${jobId}`);
      if (!barrierReleased) {
        return publicStatus(
          phase === "terminal_release" ? "completed" : "capturing",
          null,
          phase === "terminal_release"
        );
      }
      return terminalForPrimary();
    },
    async cancel(jobId: string) {
      calls.push(`adapterCancel:${jobId}`);
      return publicStatus("cancelled", null, true);
    },
    async release(jobId: string) {
      calls.push(`adapterRelease:${jobId}`);
      return { jobId, restorationConfirmed: true, artifactRemoved: true };
    },
    readCompletedArtifact(jobId: string) {
      calls.push(`readCompleted:${jobId}`);
      return { image: Buffer.from([1]), metadata: {} };
    },
  } as unknown as WorkbenchMatrixCaseAdapter;

  const scheduler = {
    async arm(caseId: string, afterPublished?: () => void) {
      calls.push(`arm:published:${caseId}`);
      afterPublished?.();
      calls.push("arm:callback-returned");
      await Promise.resolve();
      await Promise.resolve();
      calls.push("arm:arrived");
      return { case: matrixCase, requestId: "arm-request", arrived: acknowledgement(matrixCase, "arrived") };
    },
    async releaseBarrier(kind: "release" | "cancel" = "release", afterPublished?: () => void) {
      calls.push(`releaseBarrier:published:${kind}`);
      barrierReleased = true;
      afterPublished?.();
      calls.push("releaseBarrier:callback-returned");
      await Promise.resolve();
      return acknowledgement(matrixCase, "executed");
    },
    async finishCase(terminal?: { state: string; errorCode: string | null }) {
      calls.push(`finish:${String(terminal?.state)}:${String(terminal?.errorCode)}`);
    },
    async finishAfterExactOwnerExit(
      terminal: { state: string; errorCode: string | null },
      exactOwnerVacant: boolean
    ) {
      calls.push(`finishExact:${terminal.state}:${String(terminal.errorCode)}`);
      if (!shutdownComplete || !exactOwnerVacant) throw new Error("exact closeout preceded shutdown");
    },
  } as WorkbenchMatrixCaseScheduler;

  const actions: WorkbenchMatrixCaseActions = {
    requireExactOwnerExit: (jobId) => {
      calls.push(`requireExactExit:${jobId}`);
      exactExitRequired = true;
    },
    confirmExactOwnerExit: (jobId, exactOwnerVacant) => {
      calls.push(`confirmExactExit:${jobId}`);
      if (!exactExitRequired || !shutdownComplete || !exactOwnerVacant) {
        throw new Error("exact-exit confirmation was out of order");
      }
    },
    armHandlerLoss: ({ phase: selectedPhase }) => {
      calls.push(`armHandlerLoss:${selectedPhase}`);
      handlerLossArmed = true;
    },
    handlerLossResult: () => ({
      category: handlerLossCategory,
      faultInjected: handlerLossCategory !== "inactive",
    }),
    replaceFixtureWorld: async () => {
      calls.push("replaceWorld");
      return { currentWorldId: "world-2" };
    },
    armTerminalReleaseOwnerShutdown: () => {
      calls.push("armTerminalReleaseOwnerShutdown");
      terminalReleaseShutdownArmed = true;
    },
    shutdownOwnedWorkbench: async () => {
      calls.push("shutdownOwnedWorkbench");
      shutdownComplete = true;
      return { exactOwnerVacant: true };
    },
    verifyShutdownDecoy: async () => {
      calls.push("verifyShutdownDecoy");
      return action === "stop_owned_workbench"
        ? { category: "unchanged" as const, identityUnchanged: true }
        : undefined;
    },
    artifactMutationResult: () => {
      calls.push("artifactMutationResult");
      if (action === "write_truncated_artifact") {
        return { mutation: "truncated", originalByteLength: 4, mutatedByteLength: 3, byteLengthChanged: true };
      }
      if (action === "write_crc_artifact") {
        return { mutation: "crc_corruption", originalByteLength: 4, mutatedByteLength: 4, byteLengthChanged: false };
      }
      if (action === "write_mismatched_artifact") {
        return { mutation: "byte_length_mismatch", originalByteLength: 4, mutatedByteLength: 5, byteLengthChanged: true };
      }
      return null;
    },
    finalizeValidatedCapture: async () => {
      calls.push("finalizeValidatedCapture");
      return { manifestPublished: true };
    },
    discardRun: async () => {
      calls.push("discardRun");
    },
  };

  return {
    calls,
    input: {
      application,
      adapter,
      scheduler,
      actions,
      matrixCase,
      runId: "run-1",
      instanceId: "instance-1",
      expectedWorldId: "world-1",
      baselineCurrent: BASELINE_CURRENT,
      captureView,
      caseStartedAt: Date.now(),
      caseDeadline: Date.now() + 30_000,
      caseBudgetMs: 30_000,
    },
  };
}
