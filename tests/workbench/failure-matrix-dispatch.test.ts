import { describe, expect, it } from "vitest";
import {
  caseForId,
  OBSERVER_FAULT_MATRIX,
  type WorkbenchFaultMatrixCase,
} from "../../observer/protocol/fault-matrix.js";
import { runWorkbenchMatrixCase } from "../../scripts/run-workbench-observer-acceptance.js";
import {
  fakeHarness,
  SLICE_CASE,
} from "./failure-matrix-runner-fixture.js";

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

  it("lets the before-submit capture seam own a before-lease Workbench shutdown", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.stop_owned_workbench.before_lease.current"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const capture = harness.input.application.capture;
    const performShutdown = harness.input.actions.shutdownOwnedWorkbench!;
    let shutdownPromise: Promise<{ readonly exactOwnerVacant: boolean }> | null = null;
    const shutdownOwnedWorkbench = () => {
      shutdownPromise ??= performShutdown();
      return shutdownPromise;
    };

    const entry = await runWorkbenchMatrixCase({
      ...harness.input,
      application: {
        ...harness.input.application,
        capture: async (input) => {
          if (!String(input.idempotencyKey).includes("matrix-primary")) {
            return capture(input);
          }
          // Model live discovery Ping acknowledging the barrier before Submit
          // reaches the acceptance adapter's armed delivery seam.
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 0));
          harness.calls.push("capture:before-submit-hook");
          await shutdownOwnedWorkbench();
          return capture(input);
        },
      },
      actions: {
        ...harness.input.actions,
        shutdownOwnedWorkbench,
      },
    });

    expect(entry.publicTerminal).toEqual({ state: "failed", errorCode: "WORKBENCH_EXITED" });
    expect(harness.calls.indexOf("capture:before-submit-hook")).toBeLessThan(
      harness.calls.indexOf("shutdownOwnedWorkbench")
    );
    expect(harness.calls.filter((call) => call === "shutdownOwnedWorkbench")).toHaveLength(1);
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

  it("waits for artifact validation instead of treating a nonterminal status as success", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.write_crc_artifact.capture_in_progress.pose"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const jobStatus = harness.input.application.jobStatus;
    const artifactMutationResult = harness.input.actions.artifactMutationResult!;
    let statusCalls = 0;
    let mutationInvoked = false;

    const entry = await runWorkbenchMatrixCase({
      ...harness.input,
      application: {
        ...harness.input.application,
        jobStatus: async (sessionId, jobId) => {
          statusCalls += 1;
          if (jobId === "job-primary" && statusCalls === 1) {
            return { state: "capturing" };
          }
          try {
            return await jobStatus(sessionId, jobId);
          } finally {
            if (jobId === "job-primary") mutationInvoked = true;
          }
        },
      },
      actions: {
        ...harness.input.actions,
        artifactMutationResult: () => mutationInvoked ? artifactMutationResult() : null,
      },
    });

    expect(statusCalls).toBeGreaterThan(1);
    expect(entry).toMatchObject({
      result: "passed",
      publicTerminal: { state: "failed", errorCode: "ARTIFACT_INVALID" },
      artifactEvidence: { validation: "rejected", manifestPublished: false },
    });
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
