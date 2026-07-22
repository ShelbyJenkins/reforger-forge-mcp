import { WorkbenchCaptureBackend } from "../../src/observer/workbench-capture-backend.js";
import { describe, expect, it } from "vitest";
import { captureBackendContract } from "./capture-backend-contract.js";
import { contractInstance, contractPng, contractRequest } from "./capture-policy-fixture.js";

captureBackendContract("workbench", () => {
  const instance = contractInstance("workbench");
  const lowLevelCalls: string[] = [];
  let state = "queued";
  let jobId = "job-contract-1";
  const status = () => ({
    jobId,
    instanceId: instance.instanceId,
    lifecycleGeneration: "generation-1",
    canonicalTarget: "C:/project/addon.gproj",
    worldIdentity: "project/world#7",
    viewKind: "current",
    state,
    sequence: 2,
    message: state,
    cameraLeaseHeld: !["completed", "cancelled"].includes(state),
    restorationConfirmed: ["completed", "cancelled"].includes(state),
    ...(state === "completed" ? { artifact: { format: "png", pngBytes: contractPng.length, pngSha256: "a".repeat(64) } } : {}),
  });
  const adapter = {
    async instances() {
      lowLevelCalls.push("instances");
      return [{
        instanceId: instance.instanceId,
        lifecycleGeneration: "generation-1",
        canonicalTarget: "C:/project/addon.gproj",
        endpoint: { host: "127.0.0.1", port: 17777 },
        process: { pid: 42 },
        projectFile: "C:/project/addon.gproj",
        worldIdentity: "project/world#7",
        capabilities: instance.capabilities,
        activeJobId: null,
        restorationApiAvailable: true,
        readinessMessage: "ready",
      }];
    },
    async submit(input: { jobId: string }) { lowLevelCalls.push("submit"); jobId = input.jobId; return status(); },
    async recover(input: { jobId: string }) { lowLevelCalls.push("status"); jobId = input.jobId; return status(); },
    async status(input: string) { jobId = input; return status(); },
    async cancel(input: string) { lowLevelCalls.push("cancel"); jobId = input; state = "cancelled"; return status(); },
    async readCompletedArtifact(input: string) { lowLevelCalls.push("read"); jobId = input; return { image: contractPng, metadata: { contentSha256: "a".repeat(64) } }; },
    async release(input: string) { lowLevelCalls.push("release"); jobId = input; return { jobId, restorationConfirmed: true, artifactRemoved: true }; },
  };
  return {
    backend: new WorkbenchCaptureBackend(adapter as never),
    instance,
    lowLevelCalls,
    complete(): void { state = "completed"; },
  };
});

describe("Workbench capture contention projection", () => {
  it("maps the activity gate's ACTIVE_CAPTURE refusal to public CAMERA_BUSY", async () => {
    const instance = contractInstance("workbench");
    const backend = new WorkbenchCaptureBackend({
      async submit() {
        throw Object.assign(new Error("another capture owns the Workbench activity lease"), {
          code: "ACTIVE_CAPTURE",
        });
      },
    } as never);

    await expect(backend.submit({
      jobId: "contending-job",
      idempotencyKey: "contending-request",
      request: contractRequest(instance),
      instance,
    }, { deadlineAtMs: Date.now() + 5_000 })).rejects.toMatchObject({
      code: "CAMERA_BUSY",
    });
  });
});
