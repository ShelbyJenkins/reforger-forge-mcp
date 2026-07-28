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
import { runtimeWorldRevision } from "../../src/observer/world-revision.js";
import type { FaultControlAcknowledgement } from "../../scripts/observer-fault-matrix-support.js";
import type { OperationalBaselineBoundary } from "../../scripts/observer-live-acceptance-support.js";

const PILOT_CASE = caseForId(OBSERVER_FAULT_MATRIX, "runtime.cancel_capture.lease_acquired.pose");
const PUBLIC_BARRIER_JOB = {
  jobId: "job-pose-1",
  instanceId: "instance-1",
  state: "acquiringCamera",
  worldId: "world-1",
  worldEpoch: 0,
  cameraLease: { everHeld: true, held: true, restorationConfirmed: false },
} as const;

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
  armResult?: () => ReturnType<MatrixPilotCaseScheduler["arm"]>;
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
    async finishCase(publicTerminal) {
      calls.push(publicTerminal
        ? `finishCase:${publicTerminal.state}/${String(publicTerminal.errorCode)}`
        : "finishCase:none/none");
      if (options.finishResult) return options.finishResult();
    },
  };
}

interface FakeApplicationOptions {
  finalJob?: Record<string, unknown>;
  preBarrierJob?: Record<string, unknown>;
  preBarrierJobImpl?: (statusCall: number) => Record<string, unknown>;
  followUpJob?: ObserverCaptureResult;
  cancelJobImpl?: () => Promise<Record<string, unknown>>;
  releaseJobImpl?: () => Promise<Record<string, unknown>>;
  onPilotCapture?: () => void;
}

function fakeApplication(calls: string[], options: FakeApplicationOptions = {}): MatrixPilotCaseApplication {
  let cancellationRequested = false;
  let preBarrierStatusCalls = 0;
  const finalJob = options.finalJob ?? {
    state: "cancelled",
    cameraLease: { everHeld: true, held: false, restorationConfirmed: true },
  };
  return {
    async capture(input) {
      const label = input.captureLabel ?? `view:${input.view?.kind}`;
      calls.push(`capture:${label}:asynchronous=${input.asynchronous}`);
      if (input.captureLabel === "matrix-pilot-pose") {
        options.onPilotCapture?.();
        return { asynchronous: true, job: { jobId: "job-pose-1", state: "accepted" } };
      }
      // The mandatory follow-up probe is deliberately not run-registered
      // (no runId/captureLabel): it must never be mistaken for a promoted
      // evidence capture, and it must not race the run's own discard/finalize
      // convergence into releasing a job the run still thinks it owns.
      if (input.runId !== undefined || input.captureLabel !== undefined) {
        throw new Error("Follow-up capture must not be registered with the observer run");
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
      cancellationRequested = true;
      if (options.cancelJobImpl) return options.cancelJobImpl();
      return {};
    },
    async jobStatus(_sessionId, jobId) {
      calls.push(`jobStatus:${jobId}`);
      if (!cancellationRequested) {
        preBarrierStatusCalls += 1;
        return options.preBarrierJobImpl?.(preBarrierStatusCalls) ?? options.preBarrierJob ?? PUBLIC_BARRIER_JOB;
      }
      return finalJob;
    },
    async releaseJob(_sessionId, jobId) {
      calls.push(`releaseJob:${jobId}`);
      if (options.releaseJobImpl) return options.releaseJobImpl();
      return { released: true, artifactRemoved: true, restorationConfirmed: true };
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
    worldRevision: runtimeWorldRevision("world-1", 0),
    worldId: "world-1",
    worldEpoch: 0,
    caseStartedAt: Date.now(),
    caseDeadlineMs: Date.now() + 30_000,
    caseBudgetMs: 120_000,
    ...overrides,
  };
}

function recordingBaseline(
  events: string[],
): NonNullable<RunPilotCancellationCaseInput["baseline"]> {
  return {
    async measure<T>(
      _boundary: OperationalBaselineBoundary,
      operation: string,
      action: () => Promise<T>,
      phase = "complete",
      observations?: (result: T) => Record<string, string | number | boolean | null>,
    ): Promise<T> {
      events.push(`measure:start:${phase}:${operation}`);
      try {
        const result = await action();
        observations?.(result);
        events.push(`measure:passed:${phase}:${operation}`);
        return result;
      } catch (error) {
        events.push(`measure:failed:${phase}:${operation}`);
        throw error;
      }
    },
  };
}

describe("runPilotCancellationCase", () => {
  it("issues the barrier arm before submission, then cancels, releases, and finishes last", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls);
    const entry = await runPilotCancellationCase({ application, scheduler, ...baseInput() });

    expect(calls).toEqual([
      `arm:${PILOT_CASE.id}`,
      "capture:matrix-pilot-pose:asynchronous=true",
      "jobStatus:job-pose-1",
      "jobStatus:job-pose-1",
      "cancelJob:job-pose-1",
      "releaseBarrier:cancel",
      "jobStatus:job-pose-1",
      "capture:view:current:asynchronous=false",
      "releaseJob:job-followup-1",
      "finishCase:cancelled/null",
      "discardRun:run-1",
    ]);
    expect(entry.result).toBe("passed");
    expect(entry.publicTerminal).toEqual({ state: "cancelled", errorCode: null });
    expect(entry.camera).toBe("restored");
    expect(entry.artifact).toBe("not_created");
    expect(entry.control).toEqual({ arrival: "arrived", action: "executed" });
    expect(entry.deadline.outcome).toBe("completed");
    expect(entry.retainedDiagnostics.length).toBeGreaterThan(0);
  });

  it("records separate ordered barrier, action, terminal, and recovery measurements", async () => {
    const calls: string[] = [];
    const measurementEvents: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls);

    await runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput({ baseline: recordingBaseline(measurementEvents) }),
    });

    expect(measurementEvents.filter((event) => event.startsWith("measure:start:"))).toEqual([
      "measure:start:barrier_arrival:FaultMatrixScheduler.arm",
      "measure:start:action_acknowledgement:ObserverApplication.cancelJob/FaultMatrixScheduler.releaseBarrier",
      "measure:start:public_terminal:ObserverApplication.jobStatus(terminal)",
      "measure:start:recovery:ObserverApplication.capture/releaseJob(follow-up)",
    ]);
    expect(measurementEvents.filter((event) => event.startsWith("measure:passed:"))).toHaveLength(4);
    expect(measurementEvents.some((event) => event.startsWith("measure:failed:"))).toBe(false);
  });

  it("finishes the barrier-arrival measurement as failed when arming fails", async () => {
    const calls: string[] = [];
    const measurementEvents: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls, {
      armResult: async () => { throw new Error("barrier unavailable"); },
    });

    await expect(runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput({ baseline: recordingBaseline(measurementEvents) }),
    })).rejects.toThrow(/barrier unavailable/);

    expect(measurementEvents).toContain(
      "measure:failed:barrier_arrival:FaultMatrixScheduler.arm"
    );
  });

  it("waits for phase arrival concurrently with the async submission", async () => {
    const calls: string[] = [];
    let resolveArrival!: (value: Awaited<ReturnType<MatrixPilotCaseScheduler["arm"]>>) => void;
    const arrival = new Promise<Awaited<ReturnType<MatrixPilotCaseScheduler["arm"]>>>((resolve) => {
      resolveArrival = resolve;
    });
    const scheduler = fakeScheduler(calls, { armResult: () => arrival });
    const application = fakeApplication(calls, {
      onPilotCapture: () => resolveArrival({
        case: PILOT_CASE,
        requestId: "req-arm",
        arrived: acknowledgement("arrived"),
      }),
    });

    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .resolves.toMatchObject({ result: "passed" });
    expect(calls.slice(0, 2)).toEqual([
      `arm:${PILOT_CASE.id}`,
      "capture:matrix-pilot-pose:asynchronous=true",
    ]);
  });

  it("polls bounded pre-phase public states after fixture arrival before cancelling", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      preBarrierJobImpl: (statusCall) => {
        if (statusCall <= 2) return { ...PUBLIC_BARRIER_JOB, state: "accepted" };
        if (statusCall === 3) return { ...PUBLIC_BARRIER_JOB, state: "resolving" };
        return PUBLIC_BARRIER_JOB;
      },
    });
    const scheduler = fakeScheduler(calls);

    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .resolves.toMatchObject({ result: "passed" });

    const cancelIndex = calls.indexOf("cancelJob:job-pose-1");
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(calls.slice(0, cancelIndex).filter((call) => call === "jobStatus:job-pose-1"))
      .toHaveLength(4);
  });

  it("captures the public terminal result before performing the follow-up diagnostic probe", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls);
    await runPilotCancellationCase({ application, scheduler, ...baseInput() });
    const jobStatusIndex = calls.lastIndexOf("jobStatus:job-pose-1");
    const followUpIndex = calls.indexOf("capture:view:current:asynchronous=false");
    expect(jobStatusIndex).toBeGreaterThan(-1);
    expect(followUpIndex).toBeGreaterThan(jobStatusIndex);
  });

  it("fails closed when the job's terminal state disagrees with the declared expectation", async () => {
    const calls: string[] = [];
    const measurementEvents: string[] = [];
    const application = fakeApplication(calls, {
      finalJob: { state: "failed", terminalErrorCode: "INTERNAL_ERROR" },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput({ baseline: recordingBaseline(measurementEvents) }),
    }))
      .rejects.toThrow(/reached state=failed/);
    // No follow-up probe or case closure after an unexpected terminal result.
    expect(calls).not.toContain("capture:view:current:asynchronous=false");
    expect(calls.some((call) => call.startsWith("finishCase:"))).toBe(false);
    expect(measurementEvents).toContain(
      "measure:failed:public_terminal:ObserverApplication.jobStatus(terminal)"
    );
  });

  it("fails promptly and preserves a canonical public terminal reached before barrier arrival", async () => {
    const calls: string[] = [];
    const neverArrives = new Promise<Awaited<ReturnType<MatrixPilotCaseScheduler["arm"]>>>(() => undefined);
    const scheduler = fakeScheduler(calls, { armResult: () => neverArrives });
    const application = fakeApplication(calls, {
      preBarrierJob: {
        state: "failed",
        terminalErrorCode: "CAMERA_BUSY",
        cameraLease: { everHeld: false, held: false, restorationConfirmed: false },
      },
    });
    let observed: unknown;
    let failedEntry: unknown;

    await expect(runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput(),
      onPublicTerminal: (terminal) => { observed = terminal; },
      onFailedCaseEntry: (entry) => { failedEntry = entry; },
    })).rejects.toThrow(/failed.*CAMERA_BUSY.*before barrier arrival/);

    expect(observed).toEqual({ state: "failed", errorCode: "CAMERA_BUSY" });
    expect(failedEntry).toMatchObject({
      result: "failed",
      publicTerminal: { state: "failed", errorCode: "CAMERA_BUSY" },
      deadline: { outcome: "completed", budgetMs: 120_000 },
      worldRevision: "unavailable",
      camera: "not_acquired",
      artifact: "not_created",
    });
    expect((failedEntry as { retainedDiagnostics: Array<{ tail: string }> }).retainedDiagnostics[0]!.tail)
      .toMatch(/failed.*CAMERA_BUSY.*camera=not_acquired/);
    expect(calls.filter((call) => call.startsWith("arm:"))).toHaveLength(1);
    expect(calls).not.toContain("cancelJob:job-pose-1");
    expect(calls).not.toContain("releaseBarrier:cancel");
    expect(calls.some((call) => call.startsWith("finishCase:"))).toBe(false);
    expect(calls).not.toContain("discardRun:run-1");
  });

  it("preserves a canonical terminal observed by the public proof after fixture arrival", async () => {
    const calls: string[] = [];
    const scheduler = fakeScheduler(calls);
    const application = fakeApplication(calls, {
      preBarrierJobImpl: (statusCall) => statusCall === 1
        ? PUBLIC_BARRIER_JOB
        : {
            ...PUBLIC_BARRIER_JOB,
            state: "failed",
            terminalErrorCode: "CAMERA_BUSY",
            cameraLease: { everHeld: true, held: false, restorationConfirmed: true },
          },
    });
    let failedEntry: unknown;

    await expect(runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput(),
      onFailedCaseEntry: (entry) => { failedEntry = entry; },
    })).rejects.toThrow(/failed.*CAMERA_BUSY.*before cancellation dispatch/);

    expect(failedEntry).toMatchObject({
      result: "failed",
      publicTerminal: { state: "failed", errorCode: "CAMERA_BUSY" },
      deadline: { outcome: "completed" },
      worldRevision: "unchanged",
      artifact: "not_created",
    });
    expect(calls).not.toContain("cancelJob:job-pose-1");
    expect(calls).not.toContain("releaseBarrier:cancel");
  });

  it.each([
    ["job identity", { ...PUBLIC_BARRIER_JOB, jobId: "job-other" }, /jobId=job-other/],
    ["instance identity", { ...PUBLIC_BARRIER_JOB, instanceId: "instance-other" }, /instanceId=instance-other/],
    ["canonical state", { ...PUBLIC_BARRIER_JOB, state: "positioning" }, /state=positioning/],
    ["held lease", {
      ...PUBLIC_BARRIER_JOB,
      cameraLease: { everHeld: false, held: false, restorationConfirmed: false },
    }, /cameraLease\.everHeld=false/],
    ["unrestored lease", {
      ...PUBLIC_BARRIER_JOB,
      cameraLease: { everHeld: true, held: true, restorationConfirmed: true },
    }, /cameraLease\.restorationConfirmed=true/],
    ["world revision", { ...PUBLIC_BARRIER_JOB, worldEpoch: 1 }, /worldEpoch=1/],
  ])("fails closed before cancel when public barrier proof has the wrong %s", async (_label, preBarrierJob, expected) => {
    const calls: string[] = [];
    const application = fakeApplication(calls, { preBarrierJob });
    const scheduler = fakeScheduler(calls);

    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(expected);

    expect(calls).not.toContain("cancelJob:job-pose-1");
    expect(calls).not.toContain("releaseBarrier:cancel");
    expect(calls.some((call) => call.startsWith("finishCase:"))).toBe(false);
  });

  it("fails closed when the camera lease was not proven restored", async () => {
    const calls: string[] = [];
    let observed: unknown;
    const application = fakeApplication(calls, {
      finalJob: {
        state: "cancelled",
        cameraLease: { everHeld: true, held: true, restorationConfirmed: false },
      },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput(),
      onPublicTerminal: (terminal) => { observed = terminal; },
    }))
      .rejects.toThrow(/camera acquisition followed by restoration/);
    expect(observed).toEqual({ state: "cancelled", errorCode: null });
  });

  it("fails closed when the mandatory follow-up capture does not complete", async () => {
    const calls: string[] = [];
    const measurementEvents: string[] = [];
    const application = fakeApplication(calls, {
      followUpJob: { asynchronous: false, job: { jobId: "job-followup-1", state: "failed" }, image: Buffer.alloc(0), metadata: {} },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput({ baseline: recordingBaseline(measurementEvents) }),
    }))
      .rejects.toThrow(/follow-up current capture did not complete/);
    expect(calls).not.toContain("releaseJob:job-followup-1");
    expect(measurementEvents).toContain(
      "measure:failed:recovery:ObserverApplication.capture/releaseJob(follow-up)"
    );
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
    expect(calls).toContain("releaseJob:job-followup-1");
  });

  it("fails closed when explicit follow-up artifact release fails", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls, {
      releaseJobImpl: async () => { throw new Error("release unavailable"); },
    });
    const scheduler = fakeScheduler(calls);

    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/release unavailable/);
    expect(calls).toContain("releaseJob:job-followup-1");
    expect(calls.some((call) => call.startsWith("finishCase:"))).toBe(false);
    expect(calls).not.toContain("discardRun:run-1");
  });

  it("propagates a refused barrier release without finishing or discarding the run", async () => {
    const calls: string[] = [];
    const application = fakeApplication(calls);
    const scheduler = fakeScheduler(calls, {
      releaseResult: async () => { throw new Error("REPLAY_REFUSED"); },
    });
    await expect(runPilotCancellationCase({ application, scheduler, ...baseInput() }))
      .rejects.toThrow(/REPLAY_REFUSED/);
    expect(calls.some((call) => call.startsWith("finishCase:"))).toBe(false);
    expect(calls).not.toContain("discardRun:run-1");
  });

  it("propagates a failed host-runner cancel dispatch before releasing the barrier", async () => {
    const calls: string[] = [];
    const measurementEvents: string[] = [];
    const application = fakeApplication(calls, {
      cancelJobImpl: async () => { throw new Error("transport unavailable"); },
    });
    const scheduler = fakeScheduler(calls);
    await expect(runPilotCancellationCase({
      application,
      scheduler,
      ...baseInput({ baseline: recordingBaseline(measurementEvents) }),
    }))
      .rejects.toThrow(/transport unavailable/);
    expect(calls).not.toContain("releaseBarrier:cancel");
    expect(measurementEvents).toContain(
      "measure:failed:action_acknowledgement:ObserverApplication.cancelJob/FaultMatrixScheduler.releaseBarrier"
    );
  });
});

describe("runRuntimeFailureMatrix authorization gate", () => {
  it("rejects an unconfirmed run before any filesystem or process interaction", async () => {
    await expect(runRuntimeFailureMatrix({
      confirmed: false,
      configPath: "not-read-before-live-preflight.json",
      environment: {},
      only: PILOT_CASE.id,
    })).rejects.toThrow(/--confirm-live-run/);
  });

  it("rejects a confirmed run missing the live environment gate", async () => {
    await expect(runRuntimeFailureMatrix({
      confirmed: true,
      configPath: "not-read-before-live-preflight.json",
      environment: {},
      only: PILOT_CASE.id,
    })).rejects.toThrow(/RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE/);
  });

  it("rejects an undeclared case ID once authorized, before touching the filesystem or a process", async () => {
    await expect(runRuntimeFailureMatrix({
      confirmed: true,
      configPath: "not-read-before-live-preflight.json",
      environment: { RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE: "1" },
      only: "runtime.cancel_capture.before_lease.pose",
    })).rejects.toThrow(/Unknown fault-matrix case/);
  });

  it("rejects all user launch arguments in matrix mode before filesystem or process interaction", async () => {
    await expect(runRuntimeFailureMatrix({
      confirmed: true,
      configPath: "not-read-before-live-preflight.json",
      environment: { RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE: "1" },
      only: PILOT_CASE.id,
      launchArguments: ["-addonsDir", "unattested"],
    })).rejects.toThrow(/rejects --launch-arg/);
  });
});
