import { describe, expect, it } from "vitest";
import {
  type BackendJob,
  type CaptureBackend,
  type CaptureInstance,
  type CaptureRunPort,
} from "../../src/observer/capture-contract.js";
import { CaptureService } from "../../src/observer/capture-service.js";
import { RuntimeCaptureBackend } from "../../src/observer/runtime-capture-backend.js";
import { WorkbenchCaptureBackend } from "../../src/observer/workbench-capture-backend.js";
import { runtimeWorldRevision } from "../../src/observer/world-revision.js";
import { WorkbenchError } from "../../src/workbench/client.js";
import { WorkbenchObserverAdapter } from "../../src/workbench/observer-adapter.js";
import { captureServiceContract } from "./capture-service-contract.js";

captureServiceContract("runtime");
captureServiceContract("workbench");

function backend(): { backend: CaptureBackend; calls: string[] } {
  const calls: string[] = [];
  const instance: CaptureInstance = {
    backend: "runtime", instanceId: "runtime-1", sessionId: "session-1", capabilities: ["render.capture", "camera.runtime"],
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
      })).rejects.toMatchObject({ code: "STALE_INSTANCE" });
    } finally {
      await service.close();
    }
  });

  it("deduplicates concurrent identical admissions and replays the retained job", async () => {
    const fake = backend();
    const service = new CaptureService({ backends: [fake.backend], pollIntervalMs: 1, sleep: async () => undefined, createJobId: () => "job-1" });
    const input = { sessionId: "session-1", idempotencyKey: "same", view: { kind: "current" } as const, asynchronous: true, timeoutMs: 1_000 };
    const [first, retry] = await Promise.all([service.capture(input), service.capture(input)]);
    expect(first).toEqual(retry);
    expect(fake.calls.filter((call) => call === "submit")).toHaveLength(1);
  });

  it("polls synchronously, reads only after completion, and replays a release receipt", async () => {
    const fake = backend();
    const service = new CaptureService({ backends: [fake.backend], pollIntervalMs: 1, sleep: async () => undefined, createJobId: () => "job-2" });
    const result = await service.capture({ sessionId: "session-1", idempotencyKey: "sync", view: { kind: "current" }, timeoutMs: 1_000 });
    expect(result.asynchronous).toBe(false);
    if (!result.asynchronous) expect(result.image).toEqual(Buffer.from("png"));
    const receipt = await service.release("session-1", "job-2");
    expect(await service.release("session-1", "job-2")).toEqual(receipt);
    expect(fake.calls).toEqual(["submit", "status", "read", "release"]);
  });

  it("rejects a changed semantic retry before routing", async () => {
    const fake = backend();
    const service = new CaptureService({ backends: [fake.backend], createJobId: () => "job-3" });
    await service.capture({ sessionId: "session-1", idempotencyKey: "conflict", view: { kind: "current" }, asynchronous: true, timeoutMs: 1_000 });
    await expect(service.capture({ sessionId: "session-1", idempotencyKey: "conflict", view: { kind: "lookAt", position: [0, 0, 0], target: [1, 0, 0], fov: 60 }, asynchronous: true, timeoutMs: 1_000 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("defers runtime run-artifact release until the durable run records its release", async () => {
    const fake = backend();
    const runPort: CaptureRunPort = {
      async reserve(input) {
        return {
          runId: input.runId,
          captureLabel: input.captureLabel,
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
      async reserve(input) { return { runId: input.runId, captureLabel: input.captureLabel, jobId: input.jobId }; },
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
});
