import { describe, expect, it } from "vitest";
import { type BackendJob, type CaptureBackend, type CaptureInstance } from "../../src/observer/capture-contract.js";
import { CaptureService } from "../../src/observer/capture-service.js";
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
});
