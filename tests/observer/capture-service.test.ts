import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import {
  type BackendJob,
  type CaptureBackend,
  type CaptureInstance,
  type CaptureRunPort,
} from "../../src/observer/capture-contract.js";
import { CaptureService } from "../../src/observer/capture-service.js";
import { CaptureJobStore } from "../../src/observer/capture-job-store.js";
import { RuntimeCaptureBackend } from "../../src/observer/runtime-capture-backend.js";
import { WorkbenchCaptureBackend } from "../../src/observer/workbench-capture-backend.js";
import { runtimeWorldRevision, workbenchWorldRevision } from "../../src/observer/world-revision.js";
import { WorkbenchError } from "../../src/workbench/client.js";
import { WorkbenchObserverAdapter } from "../../src/workbench/observer-adapter.js";
import { captureServiceContract } from "./capture-service-contract.js";

captureServiceContract("runtime");
captureServiceContract("workbench");

const nullRuntimeRevision = runtimeWorldRevision(null, 0);

function backend(capabilities: string[] = ["render.capture", "camera.runtime"]): { backend: CaptureBackend; calls: string[] } {
  const calls: string[] = [];
  const instance: CaptureInstance = {
    backend: "runtime", instanceId: "runtime-1", sessionId: "session-1", capabilities,
    worldRevision: runtimeWorldRevision(null, 0), worldId: null, legacyWorldEpoch: 0, recoveryBinding: { nonce: "n" },
  };
  const jobs = new Map<string, BackendJob>();
  const backend: CaptureBackend = {
    kind: "runtime",
    async listInstances() { return [instance]; },
    async submit(input) {
      calls.push("submit");
      const job: BackendJob = { ref: { ...input.instance, jobId: input.jobId, backend: "runtime", recoveryBinding: input.instance.recoveryBinding } as never, state: "queued", restorationConfirmed: false };
      jobs.set(input.jobId, job);
      return job;
    },
    async status(ref) {
      calls.push("status");
      const job = jobs.get(ref.jobId)!;
      const completed = { ...job, ref, state: "completed", restorationConfirmed: true, cameraLeaseHeld: false };
      jobs.set(ref.jobId, completed);
      return completed;
    },
    async cancel(ref) { calls.push("cancel"); return { ...(jobs.get(ref.jobId)!), ref, state: "cancelled", restorationConfirmed: true, cameraLeaseHeld: false }; },
    async read(_ref) { calls.push("read"); return { image: Buffer.from("png"), metadata: { contentSha256: "a".repeat(64) } }; },
    async release(_ref) { calls.push("release"); return { restorationConfirmed: true, artifactRemoved: true }; },
  };
  return { backend, calls };
}

describe("CaptureService", () => {
  it("projects capture/restoration obligations while completed clean evidence is nonblocking", async () => {
    const fake = backend();
    const service = new CaptureService({
      backends: [fake.backend],
      createJobId: () => "job-readiness",
    });
    const inspect = () => service.inspectIdleShutdownReadiness({
      deadlineTick: performance.now() + 1_000,
      signal: new AbortController().signal,
      probeGeneration: 1,
    });
    try {
      await service.capture({
        sessionId: "session-1",
        idempotencyKey: "readiness",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      });
      await expect(inspect()).resolves.toMatchObject({
        complete: true,
        blockers: ["OBSERVER_CAPTURE", "OBSERVER_RESTORATION"],
      });
      await service.status("job-readiness");
      await expect(inspect()).resolves.toMatchObject({ complete: true, blockers: [] });
    } finally {
      await service.close();
    }
  });

  it("keeps current capture available while refusing explicit views without camera.runtime", async () => {
    const currentOnly = backend(["render.capture"]);
    const service = new CaptureService({ backends: [currentOnly.backend], createJobId: () => "job-current-only" });

    try {
      await expect(service.capture({
        sessionId: "session-1",
        instanceId: "runtime-1",
        idempotencyKey: "detached-look-at",
        view: { kind: "lookAt", position: [0, 1, 0], target: [1, 1, 0], fov: 60 },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      expect(currentOnly.calls).not.toContain("submit");

      await expect(service.capture({
        sessionId: "session-1",
        instanceId: "runtime-1",
        idempotencyKey: "detached-current",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      })).resolves.toMatchObject({ asynchronous: true });
      expect(currentOnly.calls).toContain("submit");
    } finally {
      await service.close();
    }
  });

  it("preserves a selected Workbench Ping transport failure during instance selection", async () => {
    const calls: string[] = [];
    const adapter = new WorkbenchObserverAdapter({
      async getRunningObserverSnapshot() {
        return {
          generation: "generation-transport-loss",
          target: { path: "C:/fixture/addon.gproj", comparisonKey: "c:/fixture/addon.gproj" },
          endpoint: { host: "127.0.0.1", port: 17777 },
          process: {
            pid: 4242,
            executablePath: "C:/Workbench/ArmaReforgerWorkbenchSteamDiag.exe",
            creationTime: "123456",
            launchedAtMs: 1_000,
          },
        };
      },
      async call(apiFunc: string) {
        calls.push(apiFunc);
        throw new WorkbenchError("fixture lost the observer Ping response", "TIMEOUT");
      },
    } as never);
    const service = new CaptureService({
      backends: [new WorkbenchCaptureBackend(adapter)],
      createJobId: () => "job-workbench-transport-loss",
    });

    try {
      await expect(service.capture({
        instanceId: "generation-transport-loss:c:/fixture/addon.gproj",
        idempotencyKey: "workbench-transport-loss",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: workbenchWorldRevision("unavailable-workbench-world"),
      })).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
      expect(calls).toEqual(["EMCP_WB_ObserverPing"]);
    } finally {
      await service.close();
    }
  });

  it("reports a selected Workbench instance as stale after a successful empty inventory", async () => {
    const service = new CaptureService({
      backends: [new WorkbenchCaptureBackend({
        async instances() { return []; },
      } as never)],
      createJobId: () => "job-workbench-stale-instance",
    });

    try {
      await expect(service.capture({
        instanceId: "missing-workbench-instance",
        idempotencyKey: "workbench-stale-instance",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      })).rejects.toMatchObject({ code: "STALE_INSTANCE" });
    } finally {
      await service.close();
    }
  });

  it("deduplicates concurrent identical admissions and replays the retained job", async () => {
    const fake = backend();
    const service = new CaptureService({ backends: [fake.backend], pollIntervalMs: 1, sleep: async () => undefined, createJobId: () => "job-1" });
    const input = { sessionId: "session-1", idempotencyKey: "same", view: { kind: "current" } as const, asynchronous: true, timeoutMs: 1_000, expectedWorldRevision: nullRuntimeRevision };
    const [first, retry] = await Promise.all([service.capture(input), service.capture(input)]);
    expect(first).toEqual(retry);
    expect(fake.calls.filter((call) => call === "submit")).toHaveLength(1);
  });

  it("returns cleanup recovery information when runless automatic release fails", async () => {
    const fake = backend();
    fake.backend.release = async () => {
      fake.calls.push("release");
      throw new Error("fixture artifact release remained unavailable");
    };
    const service = new CaptureService({
      backends: [fake.backend],
      pollIntervalMs: 1,
      sleep: async () => undefined,
      createJobId: () => "job-cleanup-required",
    });

    try {
      await expect(service.capture({
        sessionId: "session-1",
        idempotencyKey: "cleanup-required",
        view: { kind: "current" },
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      })).resolves.toMatchObject({
        asynchronous: false,
        job: { jobId: "job-cleanup-required", state: "completed" },
        cleanupRequired: true,
        cleanupWarning: "fixture artifact release remained unavailable",
      });
      await expect(service.status("job-cleanup-required")).resolves.toMatchObject({
        jobId: "job-cleanup-required",
        state: "completed",
      });
      expect(fake.calls.filter((call) => call === "release")).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("automatically releases an oversized runless capture before reporting its inline limit", async () => {
    const fake = backend();
    fake.backend.read = async () => {
      fake.calls.push("read");
      return { image: Buffer.alloc(16, 7), metadata: { contentSha256: "a".repeat(64) } };
    };
    const service = new CaptureService({
      backends: [fake.backend],
      pollIntervalMs: 1,
      sleep: async () => undefined,
      maxInlineImageBytes: 8,
      createJobId: () => "job-oversized-runless",
    });

    try {
      await expect(service.capture({
        sessionId: "session-1",
        idempotencyKey: "oversized-runless",
        view: { kind: "current" },
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      })).rejects.toMatchObject({
        code: "ARTIFACT_TOO_LARGE",
        details: {
          job: { jobId: "job-oversized-runless", state: "completed" },
          cleanupRequired: false,
          cleanup: { jobId: "job-oversized-runless" },
        },
      });
      await expect(service.status("job-oversized-runless")).resolves.toMatchObject({
        jobId: "job-oversized-runless",
        state: "released",
      });
      expect(fake.calls.filter((call) => call === "release")).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("keeps bounded cancellation retryable after a restoration attempt fails", async () => {
    const fake = backend();
    let attempts = 0;
    fake.backend.cancel = async (ref) => {
      fake.calls.push("cancel");
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("camera restoration remained unconfirmed"), {
          code: "RESTORATION_UNCONFIRMED",
        });
      }
      return {
        ref,
        state: "cancelled",
        restorationConfirmed: true,
        cameraLeaseHeld: false,
      };
    };
    const service = new CaptureService({
      backends: [fake.backend],
      createJobId: () => "job-cancel-retry",
    });

    try {
      await service.capture({
        sessionId: "session-1",
        idempotencyKey: "cancel-retry",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      });
      await expect(service.cancel("job-cancel-retry"))
        .rejects.toMatchObject({ code: "RESTORATION_UNCONFIRMED" });
      await expect(service.cancel("job-cancel-retry"))
        .resolves.toMatchObject({ state: "cancelled", restorationConfirmed: true });
      expect(fake.calls.filter((call) => call === "cancel")).toHaveLength(2);
    } finally {
      await service.close();
    }
  });

  it("does not sweep away a terminal job that still holds a camera lease", async () => {
    let now = 1_000;
    const revision = workbenchWorldRevision("C:/fixture/addon.gproj|world-a|0|false");
    const instance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-held-terminal",
      capabilities: ["render.capture", "camera.editor"],
      worldRevision: revision,
      worldId: "C:/fixture/addon.gproj|world-a|0|false",
      legacyWorldEpoch: 0,
      recoveryBinding: { lifecycleGeneration: "generation-held" },
    };
    const retainedFailure = (jobId: string): BackendJob => ({
      ref: {
        backend: "workbench",
        jobId,
        instanceId: instance.instanceId,
        worldRevision: revision,
        recoveryBinding: instance.recoveryBinding,
      },
      state: "failed",
      terminalErrorCode: "RESTORATION_UNCONFIRMED",
      cameraLeaseHeld: true,
      restorationConfirmed: false,
    });
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [instance]; },
      async submit(input) { return retainedFailure(input.jobId); },
      async status(ref) { return retainedFailure(ref.jobId); },
      async cancel(ref) { return retainedFailure(ref.jobId); },
      async read() { throw new Error("failed capture has no artifact"); },
      async release() { throw new Error("held lease cannot be released"); },
    };
    const store = new CaptureJobStore({ retentionMs: 0, clock: () => now });
    const service = new CaptureService({
      backends: [workbench],
      store,
      clock: () => now,
      createJobId: () => "job-held-terminal",
    });

    try {
      await service.capture({
        instanceId: instance.instanceId,
        idempotencyKey: "held-terminal",
        view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: revision,
      });
      now += 1;
      await expect(service.sweep(now)).resolves.toEqual({
        expiredJobIds: [],
        removedJobIds: [],
      });
      await expect(service.status("job-held-terminal")).resolves.toMatchObject({
        state: "failed",
        cameraLeaseHeld: true,
        restorationConfirmed: false,
      });
    } finally {
      await service.close();
    }
  });

  it("does not sweep a completed Workbench handler before retaining its release receipt", async () => {
    let now = 1_000;
    let releaseCalls = 0;
    const revision = workbenchWorldRevision("C:/fixture/addon.gproj|world-restored|0|false");
    const instance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-restored-terminal",
      capabilities: ["render.capture", "camera.editor"],
      worldRevision: revision,
      worldId: "C:/fixture/addon.gproj|world-restored|0|false",
      legacyWorldEpoch: 0,
      recoveryBinding: { lifecycleGeneration: "generation-restored" },
    };
    const completed = (jobId: string): BackendJob => ({
      ref: {
        backend: "workbench",
        jobId,
        instanceId: instance.instanceId,
        worldRevision: revision,
        recoveryBinding: instance.recoveryBinding,
      },
      state: "completed",
      cameraLeaseHeld: false,
      restorationConfirmed: true,
    });
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [instance]; },
      async submit(input) { return completed(input.jobId); },
      async status(ref) { return completed(ref.jobId); },
      async cancel(ref) { return completed(ref.jobId); },
      async read() { return { image: Buffer.from("png"), metadata: {} }; },
      async release() {
        releaseCalls += 1;
        return { restorationConfirmed: true, artifactRemoved: true };
      },
    };
    const store = new CaptureJobStore({ retentionMs: 0, clock: () => now });
    const service = new CaptureService({
      backends: [workbench],
      store,
      clock: () => now,
      createJobId: () => "job-restored-terminal",
    });

    try {
      await service.capture({
        instanceId: instance.instanceId,
        idempotencyKey: "restored-terminal",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: revision,
      });
      now += 11 * 60_000;
      await expect(service.sweep(now)).resolves.toEqual({
        expiredJobIds: [],
        removedJobIds: [],
      });
      await expect(service.status("job-restored-terminal")).resolves.toMatchObject({
        state: "completed",
        cameraLeaseHeld: false,
        restorationConfirmed: true,
      });

      await service.release("job-restored-terminal");
      expect(releaseCalls).toBe(1);
      await expect(service.sweep(now)).resolves.toEqual({
        expiredJobIds: [],
        removedJobIds: ["job-restored-terminal"],
      });
    } finally {
      await service.close();
    }
  });

  it("polls synchronously, reads only after completion, and replays a release receipt", async () => {
    const fake = backend();
    const service = new CaptureService({ backends: [fake.backend], pollIntervalMs: 1, sleep: async () => undefined, createJobId: () => "job-2" });
    const result = await service.capture({ sessionId: "session-1", idempotencyKey: "sync", view: { kind: "current" }, timeoutMs: 1_000, expectedWorldRevision: nullRuntimeRevision });
    expect(result.asynchronous).toBe(false);
    if (!result.asynchronous) expect(result.image).toEqual(Buffer.from("png"));
    const receipt = await service.release("job-2");
    expect(await service.release("job-2")).toEqual(receipt);
    expect(fake.calls).toEqual(["submit", "status", "read", "release"]);
  });

  it("rejects a changed semantic retry before routing", async () => {
    const fake = backend();
    const service = new CaptureService({ backends: [fake.backend], createJobId: () => "job-3" });
    await service.capture({ sessionId: "session-1", idempotencyKey: "conflict", view: { kind: "current" }, asynchronous: true, timeoutMs: 1_000, expectedWorldRevision: nullRuntimeRevision });
    await expect(service.capture({ sessionId: "session-1", idempotencyKey: "conflict", view: { kind: "lookAt", position: [0, 0, 0], target: [1, 0, 0], fov: 60 }, asynchronous: true, timeoutMs: 1_000, expectedWorldRevision: nullRuntimeRevision }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("defers runtime run-artifact release until the durable run records its release", async () => {
    const fake = backend();
    const runPort: CaptureRunPort = {
      async reserve(input) {
        return {
          runId: input.runId,
          captureLabel: input.captureLabel ?? "current-1",
          jobId: input.jobId,
        };
      },
      async bind() {},
      async complete() {},
      async fail() {},
      async assertReleaseAllowed() {},
    };
    const service = new CaptureService({
      backends: [fake.backend],
      runPort,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      createJobId: () => "job-run-owned",
    });
    const capture = {
      captureLabel: "proof",
      backend: "runtime",
      sessionId: "session-1",
      jobId: "job-run-owned",
      instanceId: "runtime-1",
      state: "completed",
      artifactAvailable: true,
    };

    try {
      await service.capture({
        sessionId: "session-1",
        runId: "run-1",
        captureLabel: "proof",
        idempotencyKey: "run-owned",
        view: { kind: "current" },
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      });

      await service.convergeRun({ runId: "run-1", state: "open", captures: [capture] });
      await service.convergeRun({ runId: "run-1", state: "finalized", captures: [capture] });
      expect(fake.calls.filter((call) => call === "release")).toHaveLength(0);

      await service.convergeRun({
        runId: "run-1",
        state: "finalized",
        captures: [{ ...capture, state: "released", artifactAvailable: false }],
      });
      expect(fake.calls.filter((call) => call === "release")).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("discard converges a failed Workbench job after its displaced camera lease is relinquished", async () => {
    let now = 1_000;
    const calls: string[] = [];
    const revision = workbenchWorldRevision("C:/fixture/addon.gproj|world-a|0|false");
    const instance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-generation-a",
      capabilities: ["render.capture", "camera.editor"],
      worldRevision: revision,
      worldId: "C:/fixture/addon.gproj|world-a|0|false",
      legacyWorldEpoch: 0,
      recoveryBinding: { lifecycleGeneration: "generation-a" },
    };
    const ref = {
      ...instance,
      backend: "workbench" as const,
      jobId: "job-relinquished-run",
      recoveryBinding: instance.recoveryBinding,
    };
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [instance]; },
      async submit() {
        calls.push("submit");
        return { ref, state: "settling", cameraLeaseHeld: true, restorationConfirmed: false };
      },
      async status() {
        calls.push("status");
        return {
          ref,
          state: "failed",
          terminalErrorCode: "RESTORATION_UNCONFIRMED",
          cameraLeaseHeld: true,
          restorationConfirmed: false,
        };
      },
      async cancel() {
        calls.push("cancel");
        return {
          ref,
          state: "failed",
          terminalErrorCode: "RESTORATION_UNCONFIRMED",
          cameraLeaseHeld: false,
          restorationConfirmed: false,
        };
      },
      async read() { throw new Error("failed capture has no artifact"); },
      async release() {
        calls.push("release");
        return { restorationConfirmed: false, artifactRemoved: false };
      },
    };
    const runPort: CaptureRunPort = {
      async reserve(input) { return { runId: input.runId, captureLabel: input.captureLabel ?? "current-1", jobId: input.jobId }; },
      async bind() {},
      async complete() {},
      async fail() {},
      async assertReleaseAllowed() {},
    };
    const store = new CaptureJobStore({ clock: () => now });
    const service = new CaptureService({
      backends: [workbench],
      runPort,
      store,
      clock: () => now,
      createJobId: () => "job-relinquished-run",
    });

    try {
      await service.capture({
        runId: "run-relinquished",
        captureLabel: "failed-pose",
        instanceId: instance.instanceId,
        idempotencyKey: "failed-pose",
        view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: revision,
      });

      await service.convergeRun({
        runId: "run-relinquished",
        state: "discarded",
        captures: [{
          captureLabel: "failed-pose",
          backend: "workbench",
          jobId: ref.jobId,
          instanceId: instance.instanceId,
          state: "failed",
          artifactAvailable: false,
        }],
      });

      expect(calls).toEqual(["submit", "status", "cancel", "release"]);
      await expect(service.status(ref.jobId)).resolves.toMatchObject({
        state: "released",
        cameraLeaseHeld: false,
        restorationConfirmed: false,
      });

      now += 11 * 60_000;
      await expect(service.sweep(now)).resolves.toEqual({
        expiredJobIds: [],
        removedJobIds: [ref.jobId],
      });
      expect(calls).toEqual(["submit", "status", "cancel", "release"]);
      await expect(service.status(ref.jobId)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    } finally {
      await service.close();
    }
  });

  it("keeps discarded Workbench cleanup visible and retryable across transport loss", async () => {
    const calls: string[] = [];
    let transportHealthy = false;
    const revision = workbenchWorldRevision("C:/fixture/addon.gproj|world-b|0|false");
    const instance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-generation-b",
      capabilities: ["render.capture", "camera.editor"],
      worldRevision: revision,
      worldId: "C:/fixture/addon.gproj|world-b|0|false",
      legacyWorldEpoch: 0,
      recoveryBinding: { lifecycleGeneration: "generation-b" },
    };
    const ref = {
      ...instance,
      backend: "workbench" as const,
      jobId: "job-discard-transport-loss",
      recoveryBinding: instance.recoveryBinding,
    };
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [instance]; },
      async submit() {
        calls.push("submit");
        return { ref, state: "settling", cameraLeaseHeld: true, restorationConfirmed: false };
      },
      async status() {
        calls.push("status");
        if (!transportHealthy) {
          throw Object.assign(new Error("Workbench observer transport is temporarily unavailable"), {
            code: "TRANSPORT_UNAVAILABLE",
          });
        }
        return {
          ref,
          state: "failed",
          terminalErrorCode: "RESTORATION_UNCONFIRMED",
          cameraLeaseHeld: true,
          restorationConfirmed: false,
        };
      },
      async cancel() {
        calls.push("cancel");
        return {
          ref,
          state: "failed",
          terminalErrorCode: "RESTORATION_UNCONFIRMED",
          cameraLeaseHeld: false,
          restorationConfirmed: false,
        };
      },
      async read() { throw new Error("failed capture has no artifact"); },
      async release() {
        calls.push("release");
        return { restorationConfirmed: false, artifactRemoved: false };
      },
    };
    const runPort: CaptureRunPort = {
      async reserve(input) { return { runId: input.runId, captureLabel: input.captureLabel ?? "current-1", jobId: input.jobId }; },
      async bind() {},
      async complete() {},
      async fail() {},
      async assertReleaseAllowed() {},
    };
    const service = new CaptureService({
      backends: [workbench],
      runPort,
      createJobId: () => ref.jobId,
    });

    try {
      await service.capture({
        runId: "run-discard-transport-loss",
        captureLabel: "lost-cleanup",
        instanceId: instance.instanceId,
        idempotencyKey: "lost-cleanup",
        view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: revision,
      });

      const discardedRun = {
        runId: "run-discard-transport-loss",
        state: "discarded",
        captures: [{
          captureLabel: "lost-cleanup",
          backend: "workbench",
          jobId: ref.jobId,
          instanceId: instance.instanceId,
          state: "failed",
          artifactAvailable: false,
        }],
      };
      await expect(service.convergeRun(discardedRun)).rejects.toMatchObject({
        code: "TRANSPORT_UNAVAILABLE",
        details: {
          runId: discardedRun.runId,
          job: expect.objectContaining({
            jobId: ref.jobId,
            cameraLeaseHeld: true,
            restorationConfirmed: false,
          }),
          recovery: expect.stringContaining("observer_job cancel/release"),
        },
      });
      expect(calls).toEqual(["submit", "status"]);

      transportHealthy = true;
      await expect(service.cancel(ref.jobId)).resolves.toMatchObject({
        state: "failed",
        cameraLeaseHeld: false,
        restorationConfirmed: false,
      });
      await expect(service.release(ref.jobId)).resolves.toMatchObject({
        backend: "workbench",
        jobId: ref.jobId,
        restorationConfirmed: false,
      });
      expect(calls).toEqual(["submit", "status", "cancel", "release"]);
    } finally {
      await service.close();
    }
  });

  it("reports a discarded Workbench job whose first cancellation still holds the camera lease", async () => {
    const calls: string[] = [];
    let cancelAttempts = 0;
    const revision = workbenchWorldRevision("C:/fixture/addon.gproj|world-c|0|false");
    const instance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-generation-c",
      capabilities: ["render.capture", "camera.editor"],
      worldRevision: revision,
      worldId: "C:/fixture/addon.gproj|world-c|0|false",
      legacyWorldEpoch: 0,
      recoveryBinding: { lifecycleGeneration: "generation-c" },
    };
    const ref = {
      ...instance,
      backend: "workbench" as const,
      jobId: "job-discard-held-cancel",
      recoveryBinding: instance.recoveryBinding,
    };
    const failed = (cameraLeaseHeld: boolean): BackendJob => ({
      ref,
      state: "failed",
      terminalErrorCode: "RESTORATION_UNCONFIRMED",
      cameraLeaseHeld,
      restorationConfirmed: false,
    });
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [instance]; },
      async submit() {
        calls.push("submit");
        return { ref, state: "settling", cameraLeaseHeld: true, restorationConfirmed: false };
      },
      async status() {
        calls.push("status");
        return failed(true);
      },
      async cancel() {
        calls.push("cancel");
        cancelAttempts += 1;
        return failed(cancelAttempts === 1);
      },
      async read() { throw new Error("failed capture has no artifact"); },
      async release() {
        calls.push("release");
        return { restorationConfirmed: false, artifactRemoved: false };
      },
    };
    const runPort: CaptureRunPort = {
      async reserve(input) { return { runId: input.runId, captureLabel: input.captureLabel ?? "current-1", jobId: input.jobId }; },
      async bind() {},
      async complete() {},
      async fail() {},
      async assertReleaseAllowed() {},
    };
    const service = new CaptureService({
      backends: [workbench],
      runPort,
      createJobId: () => ref.jobId,
    });

    try {
      await service.capture({
        runId: "run-discard-held-cancel",
        captureLabel: "held-cancel",
        instanceId: instance.instanceId,
        idempotencyKey: "held-cancel",
        view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
        asynchronous: true,
        timeoutMs: 1_000,
        expectedWorldRevision: revision,
      });

      await expect(service.convergeRun({
        runId: "run-discard-held-cancel",
        state: "discarded",
        captures: [{
          captureLabel: "held-cancel",
          backend: "workbench",
          jobId: ref.jobId,
          instanceId: instance.instanceId,
          state: "failed",
          artifactAvailable: false,
        }],
      })).rejects.toMatchObject({
        code: "RESTORATION_UNCONFIRMED",
        details: {
          job: expect.objectContaining({ jobId: ref.jobId, cameraLeaseHeld: true }),
          recovery: expect.stringContaining("observer_job cancel/release"),
        },
      });
      expect(calls).toEqual(["submit", "status", "cancel"]);

      await expect(service.cancel(ref.jobId)).resolves.toMatchObject({
        state: "failed",
        cameraLeaseHeld: false,
        restorationConfirmed: false,
      });
      await service.release(ref.jobId);
      expect(calls).toEqual(["submit", "status", "cancel", "cancel", "release"]);
    } finally {
      await service.close();
    }
  });

  it("completes a run-bound capture too large to inline instead of leaving it permanently unrecoverable", async () => {
    // Regression for MCP-019: RuntimeCaptureBackend must use its own larger
    // transport ceiling, decoupled from CaptureService's smaller "safe to
    // inline in one MCP response" limit. Constructing the backend with that
    // smaller limit (as production once did) makes the backend reject
    // fetching the artifact at all once it exceeds that limit, so the run
    // capture is never persisted and every later observer_run status,
    // finalize, and discard call re-fails identically forever.
    const instanceId = "runtime-large";
    const sessionId = "session-large";
    const largeImage = Buffer.alloc(9 * 1024 * 1024, 7);
    const agent = {
      async request(operation: string, payload: Record<string, unknown> = {}) {
        if (operation === "instances") {
          return {
            instances: [{
              instanceId, sessionId, capabilities: ["render.capture", "camera.runtime"],
              worldId: null, worldEpoch: 0, stale: false, transportHealthy: true, headless: false,
            }],
          };
        }
        if (operation === "submitJob") return { jobId: payload.jobId, sessionId, instanceId, worldId: null, worldEpoch: 0, state: "queued" };
        if (operation === "jobStatus") return { jobId: payload.jobId, sessionId, instanceId, worldId: null, worldEpoch: 0, state: "completed", restorationConfirmed: true };
        if (operation === "readArtifact") return { imageBase64: largeImage.toString("base64"), metadata: { contentSha256: "a".repeat(64) } };
        if (operation === "releaseJob") return { released: true, restorationConfirmed: true };
        throw new Error(`unexpected operation ${operation}`);
      },
    };
    const completed: Array<{ runId: string; captureLabel: string }> = [];
    const failed: Array<{ runId: string; captureLabel: string; code: string }> = [];
    const runPort: CaptureRunPort = {
      async reserve(input) { return { runId: input.runId, captureLabel: input.captureLabel ?? "current-1", jobId: input.jobId }; },
      async bind() {},
      async complete(input) { completed.push({ runId: input.runId, captureLabel: input.captureLabel }); },
      async fail(input) { failed.push({ runId: input.runId, captureLabel: input.captureLabel, code: input.code }); },
      async assertReleaseAllowed() {},
    };
    const service = new CaptureService({
      backends: [new RuntimeCaptureBackend(agent as never)],
      runPort,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      maxInlineImageBytes: 8 * 1024 * 1024,
      createJobId: () => "job-large",
    });

    try {
      await expect(service.capture({
        sessionId,
        runId: "run-large",
        captureLabel: "oversized",
        idempotencyKey: "large-capture",
        view: { kind: "current" },
        timeoutMs: 1_000,
        expectedWorldRevision: nullRuntimeRevision,
      })).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });

      // The artifact was still fetched and persisted into the run
      // (runPort.complete), not abandoned as a failed capture (runPort.fail).
      expect(completed).toEqual([{ runId: "run-large", captureLabel: "oversized" }]);
      expect(failed).toEqual([]);

      // observer_run status/finalize/discard all funnel through convergeRun;
      // it must not need to re-fetch (and re-reject) the already-persisted artifact.
      await expect(service.convergeRun({
        runId: "run-large",
        state: "open",
        captures: [{
          captureLabel: "oversized", backend: "runtime", jobId: "job-large",
          instanceId, sessionId, state: "completed", artifactAvailable: true,
        }],
      })).resolves.toBeUndefined();
    } finally {
      await service.close();
    }
  });

  it("delegates targetless capture only to one compatible renderer and reports opaque ambiguity targets", async () => {
    const runtime = backend();
    const workbenchRevision = workbenchWorldRevision("project|world-a|0|false");
    const workbenchInstance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-ambiguous",
      capabilities: ["render.capture", "camera.editor"],
      worldRevision: workbenchRevision,
      worldId: "project|world-a|0|false",
      recoveryBinding: { lifecycleGeneration: "generation-a" },
    };
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [workbenchInstance]; },
      async submit(input) { return { ref: { ...workbenchInstance, jobId: input.jobId }, state: "queued" } as never; },
      async status(ref) { return { ref, state: "queued" }; },
      async cancel(ref) { return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async read() { throw new Error("not completed"); },
      async release() { return { restorationConfirmed: true, artifactRemoved: true }; },
    };
    const sole = new CaptureService({ backends: [runtime.backend], createJobId: () => "job-delegated-sole" });
    const ambiguous = new CaptureService({ backends: [runtime.backend, workbench], createJobId: () => "job-delegated-ambiguous" });
    try {
      await expect(sole.capture({
        idempotencyKey: "delegated-sole",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
      })).resolves.toMatchObject({ asynchronous: true, job: { instanceId: "runtime-1" } });
      await expect(ambiguous.capture({
        idempotencyKey: "delegated-ambiguous",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
      })).rejects.toMatchObject({
        code: "AMBIGUOUS_INSTANCE",
        details: { candidates: [
          expect.objectContaining({ backend: "runtime", target: expect.stringMatching(/^ct1\./) }),
          expect.objectContaining({ backend: "workbench", target: expect.stringMatching(/^ct1\./) }),
        ] },
      });
    } finally {
      await sole.close();
      await ambiguous.close();
    }
  });

  it("revises one delegated admission after a submit-time world change on the same exact instance", async () => {
    const firstRevision = runtimeWorldRevision("world-a", 1);
    const secondRevision = runtimeWorldRevision("world-b", 2);
    let revision = firstRevision;
    let submitCount = 0;
    const requests: string[] = [];
    const events: string[] = [];
    const instance = (): CaptureInstance => ({
      backend: "runtime",
      instanceId: "runtime-refresh",
      sessionId: "session-refresh",
      capabilities: ["render.capture", "camera.runtime"],
      worldRevision: revision,
      worldId: revision === firstRevision ? "world-a" : "world-b",
      recoveryBinding: { instanceNonce: "same-nonce" },
    });
    const dynamic: CaptureBackend = {
      kind: "runtime",
      async listInstances() { events.push("inventory"); return [instance()]; },
      async submit(input) {
        submitCount += 1;
        requests.push(input.request.expectedWorldRevision);
        events.push(`submit-${submitCount}`);
        if (submitCount === 1) {
          revision = secondRevision;
          throw Object.assign(new Error("world changed before admission"), { code: "WORLD_CHANGED" });
        }
        return { ref: { ...input.instance, backend: "runtime", jobId: input.jobId } as never, state: "queued" };
      },
      async status(ref) { return { ref, state: "queued" }; },
      async cancel(ref) { return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async read() { throw new Error("not completed"); },
      async release() { return { restorationConfirmed: true, artifactRemoved: true }; },
    };
    const runPort: CaptureRunPort = {
      async reserve(input) { events.push("reserve"); return { runId: input.runId, captureLabel: "current-1", jobId: input.jobId }; },
      async bind() { events.push("bind"); },
      async reviseAdmission(input) { events.push(`revise-${input.retryCount}`); },
      async submitted() { events.push("submitted"); },
      async complete() {},
      async fail() {},
      async assertReleaseAllowed() {},
    };
    const service = new CaptureService({ backends: [dynamic], runPort, createJobId: () => "job-world-refresh" });
    try {
      await expect(service.capture({
        runId: "20260804T120000Z-a1b2c3d4",
        idempotencyKey: "delegated-world-refresh",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
      })).resolves.toMatchObject({
        asynchronous: true,
        job: { jobId: "job-world-refresh", worldRevision: secondRevision, captureLabel: "current-1" },
      });
      expect(requests).toEqual([firstRevision, secondRevision]);
      expect(events).toEqual(["inventory", "reserve", "bind", "submit-1", "inventory", "revise-1", "submit-2", "submitted"]);
    } finally {
      await service.close();
    }
  });

  it("refuses delegated world refresh when the instance recovery binding was replaced", async () => {
    let inventoryCount = 0;
    let submitCount = 0;
    const dynamic: CaptureBackend = {
      kind: "runtime",
      async listInstances() {
        inventoryCount += 1;
        return [{
          backend: "runtime", instanceId: "runtime-reused", sessionId: "session-reused",
          capabilities: ["render.capture"],
          worldRevision: runtimeWorldRevision(`world-${inventoryCount}`, inventoryCount),
          worldId: `world-${inventoryCount}`,
          recoveryBinding: { instanceNonce: `nonce-${inventoryCount}` },
        }];
      },
      async submit() {
        submitCount += 1;
        throw Object.assign(new Error("world changed before admission"), { code: "WORLD_CHANGED" });
      },
      async status(ref) { return { ref, state: "queued" }; },
      async cancel(ref) { return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async read() { throw new Error("not completed"); },
      async release() { return { restorationConfirmed: true, artifactRemoved: true }; },
    };
    const service = new CaptureService({ backends: [dynamic], createJobId: () => "job-replaced-instance" });
    try {
      await expect(service.capture({
        idempotencyKey: "replaced-instance",
        view: { kind: "current" },
        asynchronous: true,
        timeoutMs: 1_000,
      })).rejects.toMatchObject({ code: "STALE_INSTANCE" });
      expect(submitCount).toBe(1);
    } finally {
      await service.close();
    }
  });

  it("primes and releases the same Workbench lifecycle before an explicit pose without reserving prime evidence", async () => {
    const revision = workbenchWorldRevision("project|world-prime|0|false");
    let primed = false;
    const events: string[] = [];
    const ids = ["job-pose", "job-prime"];
    const instance = (): CaptureInstance => ({
      backend: "workbench",
      instanceId: "workbench-prime",
      capabilities: primed ? ["render.capture", "camera.editor"] : ["render.capture"],
      restorationApiAvailable: true,
      worldRevision: revision,
      worldId: "project|world-prime|0|false",
      recoveryBinding: { lifecycleGeneration: "generation-prime" },
    });
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { events.push("inventory"); return [instance()]; },
      async submit(input) {
        events.push(`submit-${input.request.view.kind}`);
        return {
          ref: { ...input.instance, backend: "workbench", jobId: input.jobId } as never,
          state: input.request.view.kind === "current" ? "completed" : "queued",
          cameraLeaseHeld: input.request.view.kind !== "current",
          restorationConfirmed: input.request.view.kind === "current",
        };
      },
      async status(ref) { return { ref, state: "completed", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async cancel(ref) { return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async read() { events.push("read-current"); return { image: Buffer.from("png"), metadata: {} }; },
      async release() { events.push("release-current"); primed = true; return { restorationConfirmed: true, artifactRemoved: true }; },
    };
    const reservations: Array<{ runId: string; view: string }> = [];
    const runPort: CaptureRunPort = {
      async reserve(input) {
        reservations.push({ runId: input.runId, view: input.request.view.kind });
        return { runId: input.runId, captureLabel: "pose-1", jobId: input.jobId };
      },
      async bind() {},
      async submitted() {},
      async complete() {},
      async fail() {},
      async assertReleaseAllowed() {},
    };
    const service = new CaptureService({ backends: [workbench], runPort, createJobId: () => ids.shift()! });
    try {
      await expect(service.capture({
        instanceId: "workbench-prime",
        expectedWorldRevision: revision,
        idempotencyKey: "workbench-pose-with-prime",
        runId: "20260804T130000Z-a1b2c3d4",
        view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
        asynchronous: true,
        timeoutMs: 5_000,
      })).resolves.toMatchObject({ asynchronous: true, job: { jobId: "job-pose", state: "queued", captureLabel: "pose-1" } });
      expect(events).toEqual([
        "inventory", "inventory", "submit-current", "read-current", "release-current", "inventory", "submit-pose",
      ]);
      expect(reservations).toEqual([{ runId: "20260804T130000Z-a1b2c3d4", view: "pose" }]);
    } finally {
      await service.close();
    }
  });

  it("skips a second prime on the proven editor but primes again after a Workbench restart", async () => {
    let generation = 1;
    const proven = new Set<number>();
    const events: string[] = [];
    let nextJob = 0;
    const revision = (): ReturnType<typeof workbenchWorldRevision> => workbenchWorldRevision(`project|world-prime-${generation}|0|false`);
    const instance = (): CaptureInstance => ({
      backend: "workbench",
      instanceId: `workbench-generation-${generation}`,
      capabilities: proven.has(generation) ? ["render.capture", "camera.editor"] : ["render.capture"],
      restorationApiAvailable: true,
      worldRevision: revision(),
      worldId: `project|world-prime-${generation}|0|false`,
      recoveryBinding: { lifecycleGeneration: `generation-${generation}` },
    });
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [instance()]; },
      async submit(input) {
        events.push(`submit-${input.request.view.kind}-g${generation}`);
        return {
          ref: { ...input.instance, backend: "workbench", jobId: input.jobId } as never,
          state: input.request.view.kind === "current" ? "completed" : "queued",
          cameraLeaseHeld: input.request.view.kind !== "current",
          restorationConfirmed: input.request.view.kind === "current",
        };
      },
      async status(ref) { return { ref, state: "completed", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async cancel(ref) { return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async read() { return { image: Buffer.from("png"), metadata: {} }; },
      async release(ref) {
        const releasedGeneration = Number(ref.instanceId.split("-").at(-1));
        proven.add(releasedGeneration);
        events.push(`release-current-g${releasedGeneration}`);
        return { restorationConfirmed: true, artifactRemoved: true };
      },
    };
    const service = new CaptureService({
      backends: [workbench],
      createJobId: () => `job-prime-generation-${++nextJob}`,
    });
    const pose = (key: string) => service.capture({
      instanceId: instance().instanceId,
      expectedWorldRevision: revision(),
      idempotencyKey: key,
      view: { kind: "pose" as const, position: [1, 2, 3] as [number, number, number], orientation: [0, 0, 0, 1] as [number, number, number, number], fov: 60 },
      asynchronous: true,
      timeoutMs: 5_000,
    });

    try {
      await expect(pose("first-generation-pose")).resolves.toMatchObject({ asynchronous: true });
      await expect(pose("same-generation-pose")).resolves.toMatchObject({ asynchronous: true });
      generation = 2;
      await expect(pose("restarted-generation-pose")).resolves.toMatchObject({ asynchronous: true });
      expect(events).toEqual([
        "submit-current-g1", "release-current-g1", "submit-pose-g1",
        "submit-pose-g1",
        "submit-current-g2", "release-current-g2", "submit-pose-g2",
      ]);
    } finally {
      await service.close();
    }
  });

  it("cancels and releases a retained prime when the caller aborts, without submitting the pose", async () => {
    const controller = new AbortController();
    const revision = workbenchWorldRevision("project|world-prime-cancel|0|false");
    const events: string[] = [];
    const instance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-prime-cancel",
      capabilities: ["render.capture"],
      restorationApiAvailable: true,
      worldRevision: revision,
      worldId: "project|world-prime-cancel|0|false",
      recoveryBinding: { lifecycleGeneration: "generation-prime-cancel" },
    };
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { events.push("inventory"); return [instance]; },
      async submit(input) {
        events.push(`submit-${input.request.view.kind}`);
        return { ref: { ...input.instance, jobId: input.jobId } as never, state: "queued", cameraLeaseHeld: true, restorationConfirmed: false };
      },
      async status(ref) { return { ref, state: "queued", cameraLeaseHeld: true, restorationConfirmed: false }; },
      async cancel(ref) {
        events.push("cancel-current");
        return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true };
      },
      async read() { throw new Error("cancelled prime has no artifact"); },
      async release() { events.push("release-current"); return { restorationConfirmed: true, artifactRemoved: true }; },
    };
    const ids = ["job-unused-outer", "job-prime-cancel"];
    const service = new CaptureService({
      backends: [workbench],
      createJobId: () => ids.shift()!,
      sleep: async () => {
        controller.abort();
        throw Object.assign(new Error("caller cancelled during prime"), { code: "CANCELLED" });
      },
    });

    try {
      await expect(service.capture({
        instanceId: instance.instanceId,
        expectedWorldRevision: revision,
        idempotencyKey: "cancel-during-prime",
        view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
        asynchronous: true,
        timeoutMs: 5_000,
        signal: controller.signal,
      })).rejects.toMatchObject({
        code: "CANCELLED",
        details: {
          job: { jobId: "job-prime-cancel", state: "released" },
          cleanupRequired: false,
          cleanup: { jobId: "job-prime-cancel" },
        },
      });
      expect(events).toEqual(["inventory", "inventory", "submit-current", "cancel-current", "release-current"]);
      expect(events).not.toContain("submit-pose");
    } finally {
      await service.close();
    }
  });

  it("fails closed with a recovery job when prime release cannot be proven", async () => {
    const revision = workbenchWorldRevision("project|world-prime-release-failure|0|false");
    const events: string[] = [];
    const instance: CaptureInstance = {
      backend: "workbench",
      instanceId: "workbench-prime-release-failure",
      capabilities: ["render.capture"],
      restorationApiAvailable: true,
      worldRevision: revision,
      worldId: "project|world-prime-release-failure|0|false",
      recoveryBinding: { lifecycleGeneration: "generation-prime-release-failure" },
    };
    const workbench: CaptureBackend = {
      kind: "workbench",
      async listInstances() { return [instance]; },
      async submit(input) {
        events.push(`submit-${input.request.view.kind}`);
        return { ref: { ...input.instance, jobId: input.jobId } as never, state: "completed", cameraLeaseHeld: false, restorationConfirmed: true };
      },
      async status(ref) { return { ref, state: "completed", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async cancel(ref) { return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }; },
      async read() { return { image: Buffer.from("png"), metadata: {} }; },
      async release() { throw Object.assign(new Error("prime restoration receipt unavailable"), { code: "RESTORATION_UNCONFIRMED" }); },
    };
    const ids = ["job-unused-release-outer", "job-prime-release-failure"];
    const service = new CaptureService({ backends: [workbench], createJobId: () => ids.shift()! });

    try {
      await expect(service.capture({
        instanceId: instance.instanceId,
        expectedWorldRevision: revision,
        idempotencyKey: "prime-release-failure",
        view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
        asynchronous: true,
        timeoutMs: 5_000,
      })).rejects.toMatchObject({
        code: "RESTORATION_UNCONFIRMED",
        details: {
          job: { jobId: "job-prime-release-failure", state: "completed" },
          cleanupRequired: true,
          recovery: expect.stringContaining("job-prime-release-failure"),
        },
      });
      expect(events).toEqual(["submit-current"]);
    } finally {
      await service.close();
    }
  });

  it("adopts a world changed by priming only for delegated selection", async () => {
    const exercise = async (selection: "explicit" | "delegated") => {
      const firstRevision = workbenchWorldRevision(`project|world-prime-${selection}-a|0|false`);
      const secondRevision = workbenchWorldRevision(`project|world-prime-${selection}-b|0|false`);
      let currentRevision = firstRevision;
      let primed = false;
      const events: string[] = [];
      let nextJob = 0;
      const instance = (): CaptureInstance => ({
        backend: "workbench",
        instanceId: `workbench-prime-world-${selection}`,
        capabilities: primed ? ["render.capture", "camera.editor"] : ["render.capture"],
        restorationApiAvailable: true,
        worldRevision: currentRevision,
        worldId: `project|world-prime-${selection}`,
        recoveryBinding: { lifecycleGeneration: `generation-prime-world-${selection}` },
      });
      const workbench: CaptureBackend = {
        kind: "workbench",
        async listInstances() { return [instance()]; },
        async submit(input) {
          events.push(`submit-${input.request.view.kind}`);
          return {
            ref: { ...input.instance, jobId: input.jobId } as never,
            state: input.request.view.kind === "current" ? "completed" : "queued",
            cameraLeaseHeld: input.request.view.kind !== "current",
            restorationConfirmed: input.request.view.kind === "current",
          };
        },
        async status(ref) { return { ref, state: "completed", cameraLeaseHeld: false, restorationConfirmed: true }; },
        async cancel(ref) { return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }; },
        async read() { return { image: Buffer.from("png"), metadata: {} }; },
        async release() {
          currentRevision = secondRevision;
          primed = true;
          return { restorationConfirmed: true, artifactRemoved: true };
        },
      };
      const service = new CaptureService({
        backends: [workbench],
        createJobId: () => `job-prime-world-${selection}-${++nextJob}`,
      });
      const binding = selection === "explicit"
        ? { instanceId: instance().instanceId, expectedWorldRevision: firstRevision }
        : {};
      try {
        const capture = service.capture({
          ...binding,
          idempotencyKey: `prime-world-${selection}`,
          view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
          asynchronous: true,
          timeoutMs: 5_000,
        });
        if (selection === "explicit") {
          await expect(capture).rejects.toMatchObject({ code: "WORLD_CHANGED" });
          expect(events).toEqual(["submit-current"]);
        } else {
          await expect(capture).resolves.toMatchObject({
            asynchronous: true,
            job: { worldRevision: secondRevision },
          });
          expect(events).toEqual(["submit-current", "submit-pose"]);
        }
      } finally {
        await service.close();
      }
    };

    await exercise("explicit");
    await exercise("delegated");
  });
});

describe("CaptureService shutdown quiescence", () => {
  it("seals admissions, aborts work admitted immediately before shutdown, and cancels its retained job", async () => {
    let submitEntered!: () => void;
    const entered = new Promise<void>((resolve) => { submitEntered = resolve; });
    const calls: string[] = [];
    const instance: CaptureInstance = {
      backend: "runtime",
      instanceId: "runtime-quiesce",
      sessionId: "session-quiesce",
      capabilities: ["render.capture"],
      worldRevision: nullRuntimeRevision,
      worldId: null,
      recoveryBinding: {},
    };
    const controlled: CaptureBackend = {
      kind: "runtime",
      async listInstances() { return [instance]; },
      async submit(_input, context) {
        calls.push("submit");
        submitEntered();
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => reject(Object.assign(new Error("shutdown abort"), { code: "CANCELLED" }));
          if (context.signal?.aborted) abort();
          else context.signal?.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      },
      async status(ref) { return { ref, state: "queued", restorationConfirmed: false }; },
      async cancel(ref) {
        calls.push("cancel");
        return { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true };
      },
      async read() { throw new Error("not completed"); },
      async release() { return { restorationConfirmed: true, artifactRemoved: true }; },
    };
    const service = new CaptureService({
      backends: [controlled],
      pollIntervalMs: 1,
      createJobId: () => "job-admission-race",
    });
    const capture = service.capture({
      sessionId: instance.sessionId,
      instanceId: instance.instanceId,
      idempotencyKey: "admission-before-shutdown",
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
      expectedWorldRevision: nullRuntimeRevision,
    });
    await entered;

    const quiescence = service.quiesce(Date.now() + 1_000);
    await expect(capture).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(quiescence).resolves.toMatchObject({
      quiescent: true,
      remainingJobIds: [],
      remainingAdmissionScopes: [],
    });
    await expect(service.capture({
      sessionId: instance.sessionId,
      idempotencyKey: "after-shutdown",
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
      expectedWorldRevision: nullRuntimeRevision,
    })).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    expect(calls).toEqual(["submit", "cancel"]);
    await service.close();
  });

  it("repeats cancellation until camera and restoration obligations converge", async () => {
    const fake = backend();
    let cancellations = 0;
    fake.backend.cancel = async (ref) => {
      cancellations += 1;
      return cancellations === 1
        ? { ref, state: "restoring", cameraLeaseHeld: true, restorationConfirmed: false }
        : { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true };
    };
    const service = new CaptureService({
      backends: [fake.backend],
      pollIntervalMs: 1,
      createJobId: () => "job-restoration-convergence",
    });
    await service.capture({
      sessionId: "session-1",
      idempotencyKey: "restoration-convergence",
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
      expectedWorldRevision: nullRuntimeRevision,
    });

    await expect(service.quiesce(Date.now() + 1_000)).resolves.toMatchObject({ quiescent: true });
    expect(cancellations).toBe(2);
    await service.close();
  });

  it("returns structured remaining obligations at expiry and safely resumes on retry", async () => {
    const fake = backend();
    let mayRestore = false;
    fake.backend.cancel = async (ref) => mayRestore
      ? { ref, state: "cancelled", cameraLeaseHeld: false, restorationConfirmed: true }
      : { ref, state: "restoring", cameraLeaseHeld: true, restorationConfirmed: false };
    const service = new CaptureService({
      backends: [fake.backend],
      pollIntervalMs: 1,
      createJobId: () => "job-retry-quiescence",
    });
    await service.capture({
      sessionId: "session-1",
      idempotencyKey: "retry-quiescence",
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 1_000,
      expectedWorldRevision: nullRuntimeRevision,
    });

    await expect(service.quiesce(Date.now() + 20)).resolves.toMatchObject({
      quiescent: false,
      remainingJobIds: ["job-retry-quiescence"],
    });
    mayRestore = true;
    await expect(service.quiesce(Date.now() + 1_000)).resolves.toMatchObject({
      quiescent: true,
      remainingJobIds: [],
    });
    await service.close();
  });
});
