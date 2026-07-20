import { CaptureError } from "../../src/observer/capture-contract.js";
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
