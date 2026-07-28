import { describe, expect, it } from "vitest";
import {
  CaptureError,
  type BackendJob,
  type CaptureBackend,
  type CaptureBackendKind,
  type CaptureRunPort,
} from "../../src/observer/capture-contract.js";
import { CaptureService } from "../../src/observer/capture-service.js";
import { contractInstance, contractJob, contractPng } from "./capture-policy-fixture.js";

function serviceHarness(kind: CaptureBackendKind) {
  let now = 1_000_000;
  let state = "queued";
  let cancelCalls = 0;
  const events: string[] = [];
  const deadlines: number[] = [];
  const instance = contractInstance(kind);
  let job: BackendJob | undefined;
  const backend: CaptureBackend = {
    kind,
    async listInstances(_input, context) { deadlines.push(context.deadlineAtMs); return [instance]; },
    async submit(input, context) { events.push("submit"); deadlines.push(context.deadlineAtMs); job = contractJob(instance, state, input.jobId); return job; },
    async status(ref, context) { events.push("status"); deadlines.push(context.deadlineAtMs); job = { ...contractJob(instance, state, ref.jobId), ref }; return job; },
    async cancel(ref, context) { events.push("cancel"); cancelCalls += 1; deadlines.push(context.deadlineAtMs); state = "cancelled"; job = { ...contractJob(instance, state, ref.jobId), ref }; return job; },
    async read(_ref, context) {
      events.push("read"); deadlines.push(context.deadlineAtMs);
      if (state !== "completed") throw new CaptureError("ARTIFACT_INCOMPLETE", "not complete");
      return { image: contractPng, metadata: { contentSha256: "a".repeat(64) } };
    },
    async release(_ref, context) { events.push("backend-release"); deadlines.push(context.deadlineAtMs); return { restorationConfirmed: true, artifactRemoved: true }; },
  };
  const runPort: CaptureRunPort = {
    async reserve(input) { events.push("reserve"); return { runId: input.runId, captureLabel: input.captureLabel, jobId: input.jobId }; },
    async bind() { events.push("bind"); },
    async complete() { events.push("promote"); },
    async fail() { events.push("fail"); },
    async assertReleaseAllowed() { events.push("release-preflight"); },
    async releaseManagedArtifact() { events.push("managed-release"); return { released: true }; },
  };
  const service = new CaptureService({
    backends: [backend],
    runPort,
    clock: () => now,
    createJobId: () => `job-${kind}`,
    pollIntervalMs: 10,
    sleep: async () => { now += 10; },
    defaultTimeoutMs: 1_000,
  });
  const input = {
    ...(kind === "runtime" ? { sessionId: "session-1" } : {}),
    instanceId: instance.instanceId,
    idempotencyKey: `service-${kind}`,
    view: { kind: "current" } as const,
    asynchronous: true,
    timeoutMs: 1_000,
    expectedWorldRevision: instance.worldRevision,
  };
  return {
    service, input, events, deadlines,
    get cancelCalls() { return cancelCalls; },
    advance(ms: number) { now += ms; },
    complete() { state = "completed"; },
  };
}

export function captureServiceContract(kind: CaptureBackendKind): void {
  describe(`CaptureService ${kind} contract`, () => {
    it("deduplicates concurrent admission and conflicts on every changed semantic request", async () => {
      const harness = serviceHarness(kind);
      try {
        const [first, retry] = await Promise.all([harness.service.capture(harness.input), harness.service.capture(harness.input)]);
        expect(retry).toEqual(first);
        expect(harness.events.filter((event) => event === "submit")).toHaveLength(1);
        await expect(harness.service.capture({ ...harness.input, timeoutMs: 2_000 }))
          .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      } finally { await harness.service.close(); }
    });

    it("durably binds before side effects and promotes before retiring a handler", async () => {
      const harness = serviceHarness(kind);
      try {
        const request = { ...harness.input, runId: "20260719T120000Z-a1b2c3d4", captureLabel: "overview" };
        const submitted = await harness.service.capture(request);
        harness.complete();
        await harness.service.status(undefined, submitted.job.jobId);
        expect(harness.events.indexOf("bind")).toBeLessThan(harness.events.indexOf("submit"));
        expect(harness.events.indexOf("read")).toBeLessThan(harness.events.indexOf("promote"));
        if (kind === "workbench") expect(harness.events.indexOf("promote")).toBeLessThan(harness.events.indexOf("backend-release"));
      } finally { await harness.service.close(); }
    });

    it("expires asynchronous work without polling and requests cancellation once", async () => {
      const harness = serviceHarness(kind);
      try {
        await harness.service.capture(harness.input);
        harness.advance(1_001);
        await harness.service.sweep();
        await harness.service.sweep();
        expect(harness.cancelCalls).toBe(1);
      } finally { await harness.service.close(); }
    });

    it("keeps one immutable execution deadline through admission calls", async () => {
      const harness = serviceHarness(kind);
      try {
        await harness.service.capture(harness.input);
        expect(new Set(harness.deadlines)).toHaveLength(1);
        harness.advance(100);
        await harness.service.capture(harness.input);
        expect(harness.events.filter((event) => event === "submit")).toHaveLength(1);
        expect(new Set(harness.deadlines)).toHaveLength(1);
      } finally { await harness.service.close(); }
    });
  });
}
