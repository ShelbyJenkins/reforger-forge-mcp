import { describe, expect, it } from "vitest";
import { caseForId, OBSERVER_FAULT_MATRIX } from "../../observer/protocol/fault-matrix.js";
import {
  runWorkbenchCancelBarrierCase,
  runWorkbenchFailureMatrix,
  type RunWorkbenchCancelBarrierCaseInput,
  type WorkbenchMatrixCaseAdapter,
  type WorkbenchMatrixCaseApplication,
  type WorkbenchMatrixCaseScheduler,
} from "../../scripts/run-workbench-observer-acceptance.js";
import type { ObserverCaptureResult, ObserverCaptureView } from "../../src/observer/application.js";
import type { FaultControlAcknowledgement } from "../../scripts/observer-fault-matrix-support.js";

const SLICE_CASE = caseForId(OBSERVER_FAULT_MATRIX, "workbench.cancel_capture.lease_acquired.pose");

function acknowledgement(kind: "arrived" | "executed" | "terminalled"): FaultControlAcknowledgement {
  return {
    schemaVersion: 1,
    kind,
    requestId: "11111111-1111-4111-8111-111111111111",
    caseId: SLICE_CASE.id,
    phase: "lease_acquired",
    disposition: kind,
    reason: null,
  };
}

const POSE_VIEW: ObserverCaptureView = {
  kind: "pose",
  position: [96, 90, -5],
  orientation: [0, 0, 0, 1],
  fov: 60,
};

interface FakeSchedulerOptions {
  releaseResult?: () => Promise<FaultControlAcknowledgement>;
  finishResult?: () => Promise<void>;
}

function fakeScheduler(calls: string[], options: FakeSchedulerOptions = {}): WorkbenchMatrixCaseScheduler {
  return {
    async arm(caseId) {
      calls.push(`arm:${caseId}`);
      return { case: SLICE_CASE, requestId: "req-arm", arrived: acknowledgement("arrived") };
    },
    async releaseBarrier(kind) {
      calls.push(`releaseBarrier:${kind ?? "release"}`);
      if (options.releaseResult) return options.releaseResult();
      return acknowledgement("executed");
    },
    async finishCase() {
      calls.push("finishCase");
      if (options.finishResult) return options.finishResult();
    },
  };
}

interface FakeApplicationOptions {
  cancelledJob?: Record<string, unknown>;
  followUpJob?: ObserverCaptureResult;
  cancelJobImpl?: () => Promise<Record<string, unknown>>;
}

function fakeApplication(calls: string[], options: FakeApplicationOptions = {}): WorkbenchMatrixCaseApplication {
  const cancelledJob = options.cancelledJob ?? {
    state: "cancelled",
    terminalErrorCode: null,
    cameraLeaseHeld: false,
    restorationConfirmed: true,
  };
  return {
    async capture(input) {
      calls.push(`capture:${input.captureLabel}:asynchronous=${input.asynchronous}`);
      if (input.captureLabel === "matrix-slice-pose") {
        return { asynchronous: true, job: { jobId: "job-pose-1", state: "accepted" } };
      }
      if (options.followUpJob) return options.followUpJob;
      return { asynchronous: true, job: { jobId: "job-followup-1", state: "accepted" } };
    },
    async cancelJob(_sessionId, jobId) {
      calls.push(`cancelJob:${jobId}`);
      if (options.cancelJobImpl) return options.cancelJobImpl();
      return {};
    },
    async jobStatus(_sessionId, jobId) {
      // The status pump also calls this; only record the terminal-poll shape by
      // returning a terminal state so pollMatrixTerminal resolves deterministically.
      if (jobId === "job-followup-1") {
        return { state: "completed", cameraLeaseHeld: false, restorationConfirmed: true };
      }
      return cancelledJob;
    },
  };
}

function fakeAdapter(calls: string[]): WorkbenchMatrixCaseAdapter {
  return {
    async release(jobId) {
      calls.push(`release:${jobId}`);
      return { jobId, restorationConfirmed: true, artifactRemoved: true };
    },
  };
}

function baseInput(
  overrides: Partial<RunWorkbenchCancelBarrierCaseInput> = {}
): Omit<RunWorkbenchCancelBarrierCaseInput, "application" | "adapter" | "scheduler"> {
  return {
    matrixCase: SLICE_CASE,
    runId: "run-1",
    instanceId: "instance-1",
    expectedWorldId: "world-1",
    poseView: POSE_VIEW,
    caseStartedAt: Date.now(),
    caseDeadline: Date.now() + 30_000,
    caseBudgetMs: 240_000,
    ...overrides,
  };
}

describe("runWorkbenchCancelBarrierCase", () => {
  it("arms before cancelling, releases the barrier, then releases both jobs and finishes last", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const adapter = fakeAdapter(calls);
    const scheduler = fakeScheduler(calls);
    const entry = await runWorkbenchCancelBarrierCase({ application, adapter, scheduler, ...baseInput() });

    // Filter out the concurrent status-pump noise; assert only the ordered
    // control-flow milestones.
    const milestones = calls.filter((call) => !call.startsWith("jobStatus:"));
    expect(milestones).toEqual([
      "capture:matrix-slice-pose:asynchronous=true",
      `arm:${SLICE_CASE.id}`,
      "cancelJob:job-pose-1",
      "releaseBarrier:cancel",
      "release:job-pose-1",
      "capture:matrix-slice-followup-current:asynchronous=true",
      "finishCase",
      "release:job-followup-1",
    ]);
    expect(entry.result).toBe("passed");
    expect(entry.publicTerminal).toEqual({ state: "cancelled", errorCode: null });
    expect(entry.camera).toBe("restored");
    expect(entry.artifact).toBe("not_created");
    expect(entry.deadline.outcome).toBe("completed");
    expect(entry.schedule.backend).toBe("workbench");
    expect(entry.retainedDiagnostics.length).toBeGreaterThan(0);
  });

  it("cancels the pose job before releasing the barrier", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const adapter = fakeAdapter(calls);
    const scheduler = fakeScheduler(calls);
    await runWorkbenchCancelBarrierCase({ application, adapter, scheduler, ...baseInput() });
    const cancelIndex = calls.indexOf("cancelJob:job-pose-1");
    const releaseBarrierIndex = calls.indexOf("releaseBarrier:cancel");
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(releaseBarrierIndex).toBeGreaterThan(cancelIndex);
  });

  it("fails closed when the terminal state disagrees with the declared expectation", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      cancelledJob: { state: "failed", terminalErrorCode: "INTERNAL_ERROR", cameraLeaseHeld: false, restorationConfirmed: true },
    });
    const adapter = fakeAdapter(calls);
    const scheduler = fakeScheduler(calls);
    await expect(runWorkbenchCancelBarrierCase({ application, adapter, scheduler, ...baseInput() }))
      .rejects.toThrow(/reached state=failed/);
    expect(calls).not.toContain("finishCase");
  });

  it("fails closed when cancellation cannot prove exact restoration", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      cancelledJob: { state: "cancelled", terminalErrorCode: null, cameraLeaseHeld: true, restorationConfirmed: false },
    });
    const adapter = fakeAdapter(calls);
    const scheduler = fakeScheduler(calls);
    await expect(runWorkbenchCancelBarrierCase({ application, adapter, scheduler, ...baseInput() }))
      .rejects.toThrow(/exact editor camera restoration/);
  });

  it("fails closed when the mandatory follow-up capture does not complete", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      followUpJob: { asynchronous: true, job: { jobId: "job-followup-1", state: "accepted" } },
      cancelledJob: { state: "cancelled", terminalErrorCode: null, cameraLeaseHeld: false, restorationConfirmed: true },
    });
    // Override jobStatus so the follow-up job never completes.
    const failingApplication: WorkbenchMatrixCaseApplication = {
      ...application,
      async jobStatus(_sessionId, jobId) {
        if (jobId === "job-followup-1") return { state: "failed", cameraLeaseHeld: false, restorationConfirmed: false };
        return { state: "cancelled", terminalErrorCode: null, cameraLeaseHeld: false, restorationConfirmed: true };
      },
    };
    const adapter = fakeAdapter(calls);
    const scheduler = fakeScheduler(calls);
    await expect(runWorkbenchCancelBarrierCase({ application: failingApplication, adapter, scheduler, ...baseInput() }))
      .rejects.toThrow(/follow-up current capture did not complete/);
  });

  it("propagates a refused barrier release without finishing the case", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const adapter = fakeAdapter(calls);
    const scheduler = fakeScheduler(calls, {
      releaseResult: async () => { throw new Error("REPLAY_REFUSED"); },
    });
    await expect(runWorkbenchCancelBarrierCase({ application, adapter, scheduler, ...baseInput() }))
      .rejects.toThrow(/REPLAY_REFUSED/);
    expect(calls).not.toContain("finishCase");
  });

  it("propagates a failed host-runner cancel dispatch before releasing the barrier", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      cancelJobImpl: async () => { throw new Error("transport unavailable"); },
    });
    const adapter = fakeAdapter(calls);
    const scheduler = fakeScheduler(calls);
    await expect(runWorkbenchCancelBarrierCase({ application, adapter, scheduler, ...baseInput() }))
      .rejects.toThrow(/transport unavailable/);
    expect(calls).not.toContain("releaseBarrier:cancel");
  });
});

describe("runWorkbenchFailureMatrix authorization gate", () => {
  it("rejects an unconfirmed run before any filesystem or process interaction", async () => {
    await expect(runWorkbenchFailureMatrix({
      confirmed: false,
      environment: {},
      only: SLICE_CASE.id,
    })).rejects.toThrow(/--confirm-live-run/);
  });

  it("rejects a confirmed run missing the live environment gate", async () => {
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      environment: {},
      only: SLICE_CASE.id,
    })).rejects.toThrow(/RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE/);
  });

  it("rejects an undeclared case ID once authorized, before touching the filesystem or a process", async () => {
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      environment: { RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE: "1" },
      only: "workbench.cancel_capture.before_lease.pose",
    })).rejects.toThrow(/Unknown fault-matrix case/);
  });

  it("rejects a runtime case ID given to the Workbench matrix runner", async () => {
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      environment: { RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE: "1" },
      only: "runtime.cancel_capture.lease_acquired.pose",
    })).rejects.toThrow(/is not a Workbench case/);
  });
});
