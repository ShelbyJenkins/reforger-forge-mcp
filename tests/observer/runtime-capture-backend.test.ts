import { describe, expect, it } from "vitest";
import { CaptureError, hasRestorationObligation } from "../../src/observer/capture-contract.js";
import { RuntimeCaptureBackend } from "../../src/observer/runtime-capture-backend.js";
import { captureBackendContract } from "./capture-backend-contract.js";
import { contractInstance, contractPng } from "./capture-policy-fixture.js";

captureBackendContract("runtime", () => {
  const instance = contractInstance("runtime");
  const lowLevelCalls: string[] = [];
  let state = "queued";
  const agent = {
    async request(operation: string, payload: Record<string, unknown>, options?: { deadlineAtMs?: number }): Promise<unknown> {
      if ((options?.deadlineAtMs ?? Infinity) <= Date.now()) throw new CaptureError("CAPTURE_TIMEOUT", "deadline expired");
      const call = operation === "jobStatus" ? "status" : operation === "readArtifact" ? "read" :
        operation === "cancelJob" ? "cancel" : operation === "releaseJob" ? "release" :
          operation === "submitJob" ? "submit" : operation;
      lowLevelCalls.push(call);
      if (operation === "instances") return { instances: [{
        instanceId: instance.instanceId,
        sessionId: instance.sessionId,
        capabilities: instance.capabilities,
        worldId: null,
        worldEpoch: 7,
        stale: false,
        transportHealthy: true,
        headless: false,
      }] };
      if (operation === "readArtifact") {
        if (state !== "completed") throw new CaptureError("ARTIFACT_INCOMPLETE", "not completed");
        return { imageBase64: contractPng.toString("base64"), metadata: { contentSha256: "a".repeat(64) } };
      }
      if (operation === "cancelJob") state = "cancelled";
      if (operation === "releaseJob") return { released: true, restorationConfirmed: true };
      return {
        jobId: payload.jobId,
        sessionId: instance.sessionId,
        instanceId: instance.instanceId,
        worldId: null,
        worldEpoch: 7,
        state,
        cameraLease: { held: !["completed", "cancelled"].includes(state), restorationConfirmed: ["completed", "cancelled"].includes(state) },
        restorationConfirmed: ["completed", "cancelled"].includes(state),
      };
    },
  };
  return {
    backend: new RuntimeCaptureBackend(agent as never),
    instance,
    lowLevelCalls,
    complete(): void { state = "completed"; },
  };
});

describe("RuntimeCaptureBackend lease projection", () => {
  const instance = contractInstance("runtime");
  const ref = {
    backend: "runtime" as const,
    jobId: "job-runtime-lease",
    instanceId: instance.instanceId,
    sessionId: instance.sessionId,
    worldRevision: instance.worldRevision,
    recoveryBinding: instance.recoveryBinding,
  };

  it("projects production nested lease evidence and treats exact runtime vacancy as resolved", async () => {
    let cameraLease: Record<string, unknown> = {
      everHeld: true,
      held: true,
      restorationConfirmed: false,
    };
    const backend = new RuntimeCaptureBackend({
      async request() {
        return {
          jobId: ref.jobId,
          sessionId: ref.sessionId,
          instanceId: ref.instanceId,
          worldId: null,
          worldEpoch: 7,
          state: "failed",
          cameraLease,
        };
      },
    } as never);

    const held = await backend.status(ref, { deadlineAtMs: Date.now() + 1_000 });
    expect(held).toMatchObject({
      cameraLeaseHeld: true,
      restorationConfirmed: false,
    });
    expect(hasRestorationObligation(held)).toBe(true);

    cameraLease = {
      everHeld: true,
      held: false,
      restorationConfirmed: false,
      vacancyDisposition: "exact_runtime_vacant",
    };
    const vacant = await backend.status(ref, { deadlineAtMs: Date.now() + 1_000 });
    expect(vacant).toMatchObject({
      cameraLeaseHeld: false,
      restorationConfirmed: true,
    });
    expect(hasRestorationObligation(vacant)).toBe(false);
  });

  it("fails closed when a terminal response omits restoration evidence", async () => {
    const backend = new RuntimeCaptureBackend({
      async request() {
        return {
          jobId: ref.jobId,
          sessionId: ref.sessionId,
          instanceId: ref.instanceId,
          worldId: null,
          worldEpoch: 7,
          state: "failed",
        };
      },
    } as never);

    await expect(backend.status(ref, { deadlineAtMs: Date.now() + 1_000 })).resolves.toMatchObject({
      cameraLeaseHeld: false,
      restorationConfirmed: false,
    });
  });
});
