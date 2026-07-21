import { describe, expect, it } from "vitest";
import { caseForId, OBSERVER_FAULT_MATRIX } from "../../observer/protocol/fault-matrix.js";
import {
  runRuntimeFailureMatrix,
  runPilotCancellationCase,
  type MatrixPilotCaseApplication,
  type MatrixPilotCaseScheduler,
  type RunPilotCancellationCaseInput,
} from "../../scripts/observer-runtime-failure-matrix.js";
import type { ObserverCaptureResult } from "../../src/observer/application.js";
import type { FaultControlAcknowledgement } from "../../scripts/observer-fault-matrix-support.js";

const PILOT_CASE = caseForId(OBSERVER_FAULT_MATRIX, "runtime.cancel_capture.lease_acquired.pose");

function acknowledgement(kind: "arrived" | "executed" | "terminalled"): FaultControlAcknowledgement {
  return {
    schemaVersion: 1,
    kind,
    requestId: "11111111-1111-4111-8111-111111111111",
    caseId: PILOT_CASE.id,
    phase: "lease_acquired",
    disposition: kind,
    reason: null,
  };
}

// A materially-displaced 4x4 row-major matrix (>5m from the pose position [96,90,-5]).
const DISPLACED_MATRIX = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  200, 90, -5, 1,
];

interface FakeSchedulerOptions {
  armResult?: () => Promise<ReturnType<MatrixPilotCaseScheduler["arm"]>>;
  releaseResult?: () => Promise<FaultControlAcknowledgement>;
  finishResult?: () => Promise<void>;
}

function fakeScheduler(calls: string[], options: FakeSchedulerOptions = {}): MatrixPilotCaseScheduler {
  return {
    async arm(caseId) {
      calls.push(`arm:${caseId}`);
      if (options.armResult) return options.armResult();
      return { case: PILOT_CASE, requestId: "req-arm", arrived: acknowledgement("arrived") };
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
  finalJob?: Record<string, unknown>;
  followUpJob?: ObserverCaptureResult;
  cancelJobImpl?: () => Promise<Record<string, unknown>>;
}

function fakeApplication(calls: string[], options: FakeApplicationOptions = {}): MatrixPilotCaseApplication {
  const finalJob = options.finalJob ?? {
    state: "cancelled",
    cameraLease: { everHeld: true, held: false, restorationConfirmed: true },
  };
  return {
    async capture(input) {
      calls.push(`capture:${input.captureLabel}:asynchronous=${input.asynchronous}`);
      if (input.captureLabel === "matrix-pilot-pose") {
        return { asynchronous: true, job: { jobId: "job-pose-1", state: "accepted" } };
      }
      if (options.followUpJob) return options.followUpJob;
      return {
        asynchronous: false,
        job: { jobId: "job-followup-1", state: "completed" },
        image: Buffer.alloc(0),
        metadata: { actualCamera: { matrix: DISPLACED_MATRIX } },
      };
    },
    async cancelJob(_sessionId, jobId) {
      calls.push(`cancelJob:${jobId}`);
      if (options.cancelJobImpl) return options.cancelJobImpl();
      return {};
    },
    async jobStatus(_sessionId, jobId) {
      calls.push(`jobStatus:${jobId}`);
      return finalJob;
    },
    async discardRun(runId) {
      calls.push(`discardRun:${runId}`);
      return {};
    },
  };
}

function baseInput(overrides: Partial<RunPilotCancellationCaseInput> = {}): Omit<RunPilotCancellationCaseInput, "application" | "scheduler"> {
  return {
    matrixCase: PILOT_CASE,
    managedRunId: "run-1",
    sessionId: "session-1",
    instanceId: "instance-1",
    worldId: "world-1",
    worldEpoch: 0,
    caseStartedAt: Date.now(),
    caseDeadlineMs: Date.now() + 30_000,
    caseBudgetMs: 120_000,
    ...overrides,
  };
}

describe("runPilotCancellationCase", () => {
  it("arms the barrier before cancelling, releases before polling, and finishes the case last", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls);
    const entry = await runPilotCancellationCase({ application, scheduler, ...baseInput() });

    expect(calls).toEqual([
      "capture:matrix-pilot-pose:asynchronous=true",
      `arm:${PILOT_CASE.id}`,
      "cancelJob:job-pose-1",
      "releaseBarrier:cancel",
      "jobStatus:job-pose-1",
      "capture:matrix-pilot-followup-current:asynchronous=false",
      "finishCase",
      "discardRun:run-1",
    ]);
    expect(entry.result).toBe("passed");
    expect(entry.publicTerminal).toEqual({ state: "cancelled", errorCode: null });
    expect(entry.camera).toBe("restored");
    expect(entry.artifact).toBe("not_created");
    expect(entry.deadline.outcome).toBe("completed");
    expect(entry.retainedDiagnostics.length).toBeGreaterThan(0);
  });

  it("captures the public terminal result before performing the follow-up diagnostic probe", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls);
    await runPilotCancellationCase({ application, scheduler, ...baseInput() });
    const jobStatusIndex = calls.indexOf("jobStatus:job-pose-1");
    const followUpIndex = calls.indexOf("capture:matrix-pilot-followup-current:asynchronous=false");
    expect(jobStatusIndex).toBeGreaterThan(-1);
    expect(followUpIndex).toBeGreaterThan(jobStatusIndex);
  });

  it("fails closed when the job's terminal state disagrees with the declared expectation", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, { finalJob: { state: "failed", errorCode: "INTERNAL_ERROR" } });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/reached state=failed/);
    // No follow-up probe or case closure after an unexpected terminal result.
    expect(calls).not.toContain("capture:matrix-pilot-followup-current:asynchronous=false");
    expect(calls).not.toContain("finishCase");
  });

  it("fails closed when the camera lease was not proven restored", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      finalJob: { state: "cancelled", cameraLease: { everHeld: true, held: true, restorationConfirmed: false } },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/camera acquisition followed by restoration/);
  });

  it("fails closed when the mandatory follow-up capture does not complete", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      followUpJob: { asynchronous: false, job: { jobId: "job-followup-1", state: "failed" }, image: Buffer.alloc(0), metadata: {} },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/follow-up current capture did not complete/);
  });

  it("fails closed when the follow-up capture is not materially displaced from the explicit pose", async () => {
    const calls: string[] = [];
    const stillAtPose = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      96, 90, -5, 1,
    ];
    const application = fakeApplication(calls, {
      followUpJob: {
        asynchronous: false,
        job: { jobId: "job-followup-1", state: "completed" },
        image: Buffer.alloc(0),
        metadata: { actualCamera: { matrix: stillAtPose } },
      },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/remains at the displaced position/);
  });

  it("propagates a refused barrier release without finishing or discarding the run", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls, {
      releaseResult: async () => { throw new Error("REPLAY_REFUSED"); },
    });
    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/REPLAY_REFUSED/);
    expect(calls).not.toContain("finishCase");
    expect(calls).not.toContain("discardRun:run-1");
  });

  it("propagates a failed host-runner cancel dispatch before releasing the barrier", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      cancelJobImpl: async () => { throw new Error("transport unavailable"); },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/transport unavailable/);
    expect(calls).not.toContain("releaseBarrier:cancel");
  });
});

describe("runRuntimeFailureMatrix authorization gate", () => {
  it("rejects an unconfirmed run before any filesystem or process interaction", async () => {
    await expect(runRuntimeFailureMatrix({
      confirmed: false,
      environment: {},
      only: PILOT_CASE.id,
    })).rejects.toThrow(/--confirm-live-run/);
  });

  it("rejects a confirmed run missing the live environment gate", async () => {
    await expect(runRuntimeFailureMatrix({
      confirmed: true,
      environment: {},
      only: PILOT_CASE.id,
    })).rejects.toThrow(/RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE/);
  });

  it("rejects an undeclared case ID once authorized, before touching the filesystem or a process", async () => {
    await expect(runRuntimeFailureMatrix({
      confirmed: true,
      environment: { RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE: "1" },
      only: "runtime.cancel_capture.before_lease.pose",
    })).rejects.toThrow(/Unknown fault-matrix case/);
  });
});
