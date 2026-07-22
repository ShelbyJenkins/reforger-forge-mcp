import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caseForId,
  OBSERVER_FAULT_MATRIX,
  type WorkbenchFaultMatrixCase,
} from "../../observer/protocol/fault-matrix.js";
import {
  createDisposableProject,
  captureStableWorkbenchMatrixSource,
  launchWorkbenchMatrixDecoy,
  parseWorkbenchObserverCliArgs,
  readWorkbenchCliFlag,
  readWorkbenchCliOption,
  remainingWorkbenchMatrixCaptureTimeout,
  remainingWorkbenchMatrixStepTimeout,
  removeWorkbenchCaseDirectoryIfSafe,
  requireWorkbenchReplacementWorldId,
  runWorkbenchFailureMatrix,
  runWorkbenchMatrixCase,
  workbenchFailureDeadlineEvidence,
  workbenchFailureMatrixCaseIds,
  type RunWorkbenchMatrixCaseInput,
  type WorkbenchMatrixCaseActions,
  type WorkbenchMatrixCaseAdapter,
  type WorkbenchMatrixCaseApplication,
  type WorkbenchMatrixCaseScheduler,
} from "../../scripts/run-workbench-observer-acceptance.js";
import type { ObserverCaptureView } from "../../src/observer/application.js";
import { workbenchCameraMatrix, type WorkbenchCameraMatrix } from "../../src/workbench/observer-adapter.js";
import type { FaultControlAcknowledgement } from "../../scripts/observer-fault-matrix-support.js";

const SLICE_CASE = caseForId(
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

interface FakeHarness {
  readonly input: RunWorkbenchMatrixCaseInput;
  readonly calls: string[];
}

function fakeHarness(matrixCase: WorkbenchFaultMatrixCase): FakeHarness {
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

describe("complete Workbench failure-matrix dispatch", () => {
  it("dispatches every one of the 69 canonical rows across all actions and barriers", async () => {
    const workbenchCases = OBSERVER_FAULT_MATRIX.cases.filter(
      (matrixCase): matrixCase is WorkbenchFaultMatrixCase => matrixCase.backend === "workbench"
    );
    expect(workbenchCases).toHaveLength(69);
    const actions = new Set<string>();
    const phases = new Set<string>();
    for (const matrixCase of workbenchCases) {
      const harness = fakeHarness(matrixCase);
      const entry = await runWorkbenchMatrixCase(harness.input);
      actions.add(matrixCase.injection.action);
      phases.add(matrixCase.injection.phase);
      expect(entry).toMatchObject({
        caseId: matrixCase.id,
        result: "passed",
        publicTerminal: matrixCase.expectedTerminal,
        camera: matrixCase.cameraDisposition,
        control: { arrival: "arrived", action: "executed" },
      });
      expect(entry.retainedDiagnostics.length).toBeGreaterThan(0);
      if (matrixCase.injection.phase === "before_lease") {
        expect(entry.limitations).toEqual([
          expect.stringMatching(/Ping.*no retained job.*host-bound.*Submit/),
        ]);
      } else {
        expect(entry.limitations).toEqual([]);
      }
      if (matrixCase.expectedTerminal.state === "completed") {
        expect(entry.artifactEvidence).toMatchObject({
          validation: "validated",
          manifestPublished: true,
        });
      } else if (matrixCase.injection.action.startsWith("write_")) {
        expect(entry.artifactEvidence).toMatchObject({
          validation: "rejected",
          manifestPublished: false,
        });
      } else {
        expect(entry.artifactEvidence).toMatchObject({
          validation: "not_created",
          manifestPublished: false,
        });
      }
    }
    expect(actions).toEqual(new Set([
      "complete_capture",
      "cancel_capture",
      "disable_fixture_handler",
      "submit_competing_capture",
      "replace_fixture_world",
      "write_truncated_artifact",
      "write_crc_artifact",
      "write_mismatched_artifact",
      "stop_owned_workbench",
      "release_twice",
    ]));
    expect(phases).toEqual(new Set([
      "before_lease",
      "lease_acquired",
      "capture_in_progress",
      "restoration_in_progress",
      "terminal_release",
    ]));
  }, 20_000);

  it("starts a non-before capture only from the scheduler post-publication callback", async () => {
    const harness = fakeHarness(SLICE_CASE);
    await runWorkbenchMatrixCase(harness.input);
    const published = harness.calls.indexOf(`arm:published:${SLICE_CASE.id}`);
    const captured = harness.calls.indexOf("capture:matrix-primary");
    const callbackReturned = harness.calls.indexOf("arm:callback-returned");
    expect(published).toBeLessThan(captured);
    expect(captured).toBeLessThan(callbackReturned);
  });

  it("releases a cancelled primary before attempting the fresh follow-up acquisition", async () => {
    const harness = fakeHarness(SLICE_CASE);
    await runWorkbenchMatrixCase(harness.input);
    expect(harness.calls.indexOf("adapterRelease:job-primary")).toBeLessThan(
      harness.calls.indexOf("capture:matrix-followup-current")
    );
  });

  it("gets the exact-exit barrier acknowledgement before sealing and shutting down", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.stop_owned_workbench.capture_in_progress.pose"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    await runWorkbenchMatrixCase(harness.input);
    const released = harness.calls.indexOf("releaseBarrier:published:release");
    const sealed = harness.calls.indexOf("requireExactExit:job-primary");
    const shutdown = harness.calls.indexOf("shutdownOwnedWorkbench");
    const confirmed = harness.calls.indexOf("confirmExactExit:job-primary");
    expect(released).toBeLessThan(sealed);
    expect(sealed).toBeLessThan(shutdown);
    expect(shutdown).toBeLessThan(confirmed);
  });

  it("starts the declared capture after release publication so its real Ping both drains and fails", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.disable_fixture_handler.before_lease.current"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const entry = await runWorkbenchMatrixCase(harness.input);
    expect(entry.publicTerminal).toEqual({ state: "failed", errorCode: "TRANSPORT_UNAVAILABLE" });
    expect(entry.camera).toBe("not_acquired");
    expect(harness.calls).toContain("armHandlerLoss:before_lease");
    expect(harness.calls.indexOf("releaseBarrier:published:release")).toBeLessThan(
      harness.calls.indexOf("capture:matrix-primary")
    );
    expect(harness.calls).toContain("capturePingResponseLost");
  });

  it("rejects handler-loss rows unless the one-shot seam reports the declared loss boundary", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.disable_fixture_handler.before_lease.current"
    ) as WorkbenchFaultMatrixCase;

    for (const loss of [
      { category: "inactive" as const, faultInjected: false },
      { category: "delegate_failed" as const, faultInjected: true },
    ]) {
      const harness = fakeHarness(matrixCase);
      await expect(runWorkbenchMatrixCase({
        ...harness.input,
        actions: {
          ...harness.input.actions,
          handlerLossResult: () => loss,
        },
      })).rejects.toThrow(/handler-loss seam was not consumed at the declared boundary/);
    }
  });

  it("rejects a completed requested view whose independently reported camera is corrupted", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.complete_capture.terminal_release.pose"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const jobStatus = harness.input.application.jobStatus;
    await expect(runWorkbenchMatrixCase({
      ...harness.input,
      application: {
        ...harness.input.application,
        jobStatus: async (sessionId, jobId) => {
          const status = await jobStatus(sessionId, jobId);
          const actualCamera = status.actualCamera as Record<string, unknown>;
          return {
            ...status,
            actualCamera: { ...actualCamera, verticalFov: 12 },
          };
        },
      },
    })).rejects.toThrow(/rendered FOV differs from the requested view/);
  });

  it("rejects a post-restoration current capture whose camera owner differs from baseline", async () => {
    const harness = fakeHarness(SLICE_CASE);
    const jobStatus = harness.input.application.jobStatus;
    await expect(runWorkbenchMatrixCase({
      ...harness.input,
      application: {
        ...harness.input.application,
        jobStatus: async (sessionId, jobId) => {
          const status = await jobStatus(sessionId, jobId);
          return jobId === "job-followup"
            ? { ...status, ownerCameraId: 999 }
            : status;
        },
      },
    })).rejects.toThrow(/post-restoration current capture did not match baseline/);
  });

  it("does not start a late status pump when arm rejects before capture submission resolves", async () => {
    const harness = fakeHarness(SLICE_CASE);
    const capture = harness.input.application.capture;
    let releaseCapture!: () => void;
    const captureGate = new Promise<void>((resolveGate) => {
      releaseCapture = resolveGate;
    });
    const run = runWorkbenchMatrixCase({
      ...harness.input,
      application: {
        ...harness.input.application,
        capture: async (input) => {
          await captureGate;
          return capture(input);
        },
      },
      scheduler: {
        ...harness.input.scheduler,
        arm: async (_caseId, afterPublished) => {
          afterPublished?.();
          throw new Error("fixture rejected arm");
        },
      },
    });

    await expect(run).rejects.toThrow(/fixture rejected arm/);
    releaseCapture();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    expect(harness.calls.some((call) => call.startsWith("adapterStatus:"))).toBe(false);
  });

  it("publishes and checks the declared terminal before running decoy diagnostics", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.stop_owned_workbench.terminal_release.current"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const order: string[] = [];
    await expect(runWorkbenchMatrixCase({
      ...harness.input,
      onPublicTerminal: () => {
        order.push("public-terminal");
      },
      actions: {
        ...harness.input.actions,
        verifyShutdownDecoy: async () => {
          order.push("decoy-diagnostic");
          throw new Error("decoy comparison unavailable");
        },
      },
    })).rejects.toThrow(/decoy comparison unavailable/);
    expect(order).toEqual(["public-terminal", "decoy-diagnostic"]);
  });

  it("records a handler-loss public terminal before reading the private seam result", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.disable_fixture_handler.capture_in_progress.pose"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const order: string[] = [];
    await expect(runWorkbenchMatrixCase({
      ...harness.input,
      onPublicTerminal: () => {
        order.push("public-terminal");
      },
      actions: {
        ...harness.input.actions,
        handlerLossResult: () => {
          order.push("private-seam-result");
          throw new Error("private seam evidence unavailable");
        },
      },
    })).rejects.toThrow(/private seam evidence unavailable/);
    expect(order).toEqual(["public-terminal", "private-seam-result"]);
  });
});

describe("Workbench failure-matrix safety helpers", () => {
  const vacantCleanup = {
    lifecycleVacant: true,
    endpointVacant: true,
    childVacant: true,
    exactOwnerVacant: true,
  };
  const noDecoy = { category: "not_applicable" as const, identityUnchanged: null };

  it("never removes a case directory with an unresolved cleanup or decoy proof", () => {
    const remove = vi.fn();
    for (const key of Object.keys(vacantCleanup) as Array<keyof typeof vacantCleanup>) {
      expect(removeWorkbenchCaseDirectoryIfSafe({
        caseDirectory: "case-directory",
        entry: {
          cleanup: { ...vacantCleanup, [key]: false },
          decoy: noDecoy,
        },
        remove,
      })).toBe(false);
    }
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: {
        cleanup: vacantCleanup,
        decoy: { category: "unproven", identityUnchanged: null },
      },
      remove,
    })).toBe(false);
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: { cleanup: vacantCleanup, decoy: noDecoy },
      retainForDecoyRecovery: true,
      remove,
    })).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports removal failures and removes only fully proven disposable directories", () => {
    const removalError = new Error("locked directory");
    const onRemovalError = vi.fn();
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: { cleanup: vacantCleanup, decoy: noDecoy },
      remove: () => {
        throw removalError;
      },
      onRemovalError,
    })).toBe(false);
    expect(onRemovalError).toHaveBeenCalledWith(removalError);

    const remove = vi.fn();
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: { cleanup: vacantCleanup, decoy: noDecoy },
      remove,
    })).toBe(true);
    expect(remove).toHaveBeenCalledWith("case-directory");
  });

  it("uses the remaining absolute case budget at capture dispatch", () => {
    expect(remainingWorkbenchMatrixCaptureTimeout(10_000, 5_000)).toBe(5_000);
    expect(remainingWorkbenchMatrixCaptureTimeout(400_000, 0)).toBe(300_000);
    expect(() => remainingWorkbenchMatrixCaptureTimeout(5_999, 5_000))
      .toThrow(/deadline expired before capture dispatch/);
  });

  it("derives infrastructure waits from the same absolute case deadline", () => {
    expect(remainingWorkbenchMatrixStepTimeout(10_000, 15_000, "preflight", 4_500))
      .toBe(5_500);
    expect(remainingWorkbenchMatrixStepTimeout(30_000, 10_000, "decoy", 4_500))
      .toBe(10_000);
    expect(() => remainingWorkbenchMatrixStepTimeout(4_500, 10_000, "decoy", 4_500))
      .toThrow(/deadline expired before decoy/);
  });

  it("records early failures as cancelled and clamps true timeouts to the budget", () => {
    expect(workbenchFailureDeadlineEvidence(1_000, 1_400, 1_000)).toEqual({
      outcome: "cancelled",
      elapsedMs: 400,
      budgetMs: 1_000,
    });
    expect(workbenchFailureDeadlineEvidence(1_000, 2_500, 1_000)).toEqual({
      outcome: "expired",
      elapsedMs: 1_000,
      budgetMs: 1_000,
    });
  });

  it("rejects a replacement world identity that did not actually change", () => {
    expect(requireWorkbenchReplacementWorldId("world-a", "world-b")).toBe("world-b");
    expect(() => requireWorkbenchReplacementWorldId("world-a", "world-a"))
      .toThrow(/did not change the observed Workbench world identity/);
  });

  it("detects source-closure mutation across the final revision bracket", () => {
    const source = (sha256: string) => ({
      harness: { path: "scripts/harness.ts", sha256 },
      recorder: { path: "scripts/recorder.ts", sha256: "b".repeat(64) },
      measured: [{ path: "src/measured.ts", sha256: "c".repeat(64) }],
    });
    const readSource = vi.fn()
      .mockReturnValueOnce(source("a".repeat(64)))
      .mockReturnValueOnce(source("d".repeat(64)));
    const readRevision = vi.fn().mockReturnValue({
      commit: "e".repeat(40),
      tree: "clean" as const,
    });
    const captured = captureStableWorkbenchMatrixSource({ readSource, readRevision });
    expect(captured.stable).toBe(false);
    expect(captured.source).toEqual(source("d".repeat(64)));
    expect(readSource).toHaveBeenCalledTimes(2);
    expect(readRevision).toHaveBeenCalledTimes(2);
  });

  it("exits a spawned decoy through its sentinel when identity qualification fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-decoy-failure-"));
    let observedExit = false;
    try {
      const inspectProcess = vi.fn().mockResolvedValue(null);
      await expect(launchWorkbenchMatrixDecoy(
        root,
        { inspectProcess },
        {
          inspectionDeadlineMs: 1,
          onSpawn: (child) => {
            child.once("exit", () => {
              observedExit = true;
            });
          },
        }
      )).rejects.toThrow(/decoy exact identity could not be verified/);
      expect(inspectProcess).toHaveBeenCalled();
      expect(existsSync(join(root, "decoy-exit.sentinel"))).toBe(true);
      expect(observedExit).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not grant decoy qualification cleanup a fresh window past the case deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-decoy-deadline-"));
    let exited!: Promise<void>;
    try {
      const startedAt = Date.now();
      await expect(launchWorkbenchMatrixDecoy(
        root,
        { inspectProcess: vi.fn().mockResolvedValue(null) },
        {
          deadlineAtMs: startedAt + 5,
          onSpawn: (child) => {
            exited = new Promise((resolveExit) => child.once("exit", () => resolveExit()));
          },
        }
      )).rejects.toThrow(/qualification failed and sentinel exit could not be proven/);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(existsSync(join(root, "decoy-exit.sentinel"))).toBe(true);
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("decoy did not honor its sentinel")),
          2_000
        )),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("createDisposableProject matrix resources", () => {
  it("stages the fixture dependency and generates isolated Matrix A/B worlds", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-matrix-project-"));
    try {
      const project = createDisposableProject(root, { stageMatrixFixture: true });
      expect(project.worldResource).toMatch(/^\{[A-F0-9]{16}\}Worlds\/ObserverMatrixA\.ent$/);
      expect(project.alternateWorldResource).toMatch(/^\{[A-F0-9]{16}\}Worlds\/ObserverMatrixB\.ent$/);
      expect(existsSync(join(project.modDirectory, "Worlds", "ObserverMatrixA.ent"))).toBe(true);
      expect(existsSync(join(project.modDirectory, "Worlds", "ObserverMatrixB.ent"))).toBe(true);
      expect(existsSync(join(root, "ObserverMatrixFixture", "addon.gproj"))).toBe(true);
      expect(readFileSync(project.projectPath, "utf8")).toContain('"2C6B8D14F9A0473E"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the positive path on its original single ObserverAcceptance world", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-positive-project-"));
    try {
      const project = createDisposableProject(root);
      expect(project.worldResource).toMatch(/^\{[A-F0-9]{16}\}Worlds\/ObserverAcceptance\.ent$/);
      expect(project.alternateWorldResource).toBeNull();
      expect(existsSync(join(root, "ObserverMatrixFixture"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Workbench failure-matrix CLI", () => {
  it("lists exactly the 69 declared Workbench cases", () => {
    const caseIds = workbenchFailureMatrixCaseIds();
    expect(caseIds).toHaveLength(69);
    expect(caseIds).toContain(SLICE_CASE.id);
    expect(caseIds.every((caseId) => caseId.startsWith("workbench."))).toBe(true);
  });

  it("preserves positive mode by default and selects full or partial matrix mode explicitly", () => {
    expect(parseWorkbenchObserverCliArgs([])).toEqual({ mode: "positive", confirmed: false });
    expect(parseWorkbenchObserverCliArgs(["--matrix", "--confirm-live-run"])).toEqual({
      mode: "matrix",
      confirmed: true,
      keepProfile: false,
    });
    expect(parseWorkbenchObserverCliArgs(["--only", SLICE_CASE.id, "--keep-profile"])).toEqual({
      mode: "matrix",
      confirmed: false,
      only: SLICE_CASE.id,
      keepProfile: true,
    });
  });

  it("rejects unknown, stray, duplicate, missing and incompatible arguments", () => {
    expect(() => parseWorkbenchObserverCliArgs(["stray"])).toThrow(/Unknown or stray/);
    expect(() => parseWorkbenchObserverCliArgs(["--unknown"])).toThrow(/Unknown or stray/);
    expect(() => parseWorkbenchObserverCliArgs(["--matrix", "--matrix"])).toThrow(/only once/);
    expect(() => parseWorkbenchObserverCliArgs(["--only"])).toThrow(/requires a value/);
    expect(() => parseWorkbenchObserverCliArgs(["--matrix", "--only", SLICE_CASE.id])).toThrow(/mutually exclusive/);
    expect(() => parseWorkbenchObserverCliArgs(["--keep-profile"])).toThrow(/only together with --only/);
    expect(() => parseWorkbenchObserverCliArgs(["--help", "--matrix"])).toThrow(/by itself/);
    expect(() => parseWorkbenchObserverCliArgs(["--only", "runtime.cancel_capture.lease_acquired.pose"]))
      .toThrow(/not a Workbench case/);
    expect(() => parseWorkbenchObserverCliArgs(["--only", "workbench.unknown.before_lease.current"]))
      .toThrow(/Unknown fault-matrix case/);
  });

  it("retains the singleton helper behavior used by downstream parser tests", () => {
    expect(() => readWorkbenchCliOption(
      ["--only", SLICE_CASE.id, "--only", SLICE_CASE.id],
      "--only"
    )).toThrow(/only once/);
    expect(() => readWorkbenchCliFlag(
      ["--keep-profile", "--keep-profile"],
      "--keep-profile"
    )).toThrow(/only once/);
  });
});

describe("runWorkbenchFailureMatrix preflight gates", () => {
  it("rejects unconfirmed full and partial runs before filesystem/process work", async () => {
    await expect(runWorkbenchFailureMatrix({ confirmed: false, environment: {} }))
      .rejects.toThrow(/--confirm-live-run/);
    await expect(runWorkbenchFailureMatrix({
      confirmed: false,
      environment: {},
      only: SLICE_CASE.id,
    })).rejects.toThrow(/--confirm-live-run/);
  });

  it("rejects a confirmed run missing the live environment gate", async () => {
    await expect(runWorkbenchFailureMatrix({ confirmed: true, environment: {} }))
      .rejects.toThrow(/RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE/);
  });

  it("rejects keep-profile without a selected partial case", async () => {
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      environment: { RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE: "1" },
      keepProfile: true,
    })).rejects.toThrow(/only with a single --only/);
  });

  it("rejects unknown and runtime IDs after authorization but before launch", async () => {
    const environment = { RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE: "1" };
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      environment,
      only: "workbench.unknown.before_lease.current",
    })).rejects.toThrow(/Unknown fault-matrix case/);
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      environment,
      only: "runtime.cancel_capture.lease_acquired.pose",
    })).rejects.toThrow(/not a Workbench case/);
  });
});

describe("runner safety/source closure", () => {
  it("includes the fixture-only support and decoy without a direct process kill path", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "run-workbench-observer-acceptance.ts"),
      "utf8"
    );
    const liveCaseSource = readFileSync(
      join(process.cwd(), "scripts", "workbench-observer-live-matrix-case.ts"),
      "utf8"
    );
    const ownedSource = `${source}\n${liveCaseSource}`;
    expect(source).toContain('"scripts/observer-workbench-failure-support.ts"');
    expect(source).toContain('"scripts/workbench-observer-acceptance-adapter.ts"');
    expect(source).toContain('"scripts/workbench-observer-acceptance-runtime.ts"');
    expect(source).toContain('"scripts/workbench-observer-live-matrix-case.ts"');
    expect(source).toContain('"scripts/workbench-observer-matrix-case.ts"');
    expect(ownedSource).toContain('"tests/fixtures/workbench-observer-failure-matrix-decoy.mjs"');
    expect(ownedSource.match(/safe\.directory=/g)).toHaveLength(2);
    expect(ownedSource).not.toMatch(/\.kill\s*\(/);
    expect(ownedSource).not.toMatch(/\b(?:taskkill|Stop-Process|KillProcess)\b/);
    expect(ownedSource).not.toContain("vertical slice");
  });
});
