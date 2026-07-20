import type {
  BackendJob,
  BackendJobRef,
  CaptureBackendKind,
  CaptureInstance,
  CanonicalCaptureRequest,
} from "../../src/observer/capture-contract.js";
import { normalizeCaptureRequest } from "../../src/observer/capture-request.js";
import { runtimeWorldRevision, workbenchWorldRevision } from "../../src/observer/world-revision.js";

export const contractPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

export function contractInstance(kind: CaptureBackendKind): CaptureInstance {
  const runtime = kind === "runtime";
  return {
    backend: kind,
    instanceId: `${kind}-instance-1`,
    ...(runtime ? { sessionId: "session-1" } : {}),
    capabilities: ["render.capture", runtime ? "camera.runtime" : "camera.editor"],
    worldRevision: runtime ? runtimeWorldRevision(null, 7) : workbenchWorldRevision("project/world#7"),
    worldId: runtime ? null : "project/world#7",
    legacyWorldEpoch: runtime ? 7 : 0,
    stale: false,
    transportHealthy: true,
    headless: false,
    recoveryBinding: runtime ? { instanceNonce: "nonce-1" } : { lifecycleGeneration: "generation-1" },
  };
}

export function contractRequest(instance: CaptureInstance, overrides: Record<string, unknown> = {}): CanonicalCaptureRequest {
  return normalizeCaptureRequest({
    ...(instance.sessionId ? { sessionId: instance.sessionId } : {}),
    instanceId: instance.instanceId,
    idempotencyKey: "contract-request",
    view: { kind: "current" },
    asynchronous: true,
    timeoutMs: 5_000,
    expectedWorldRevision: instance.worldRevision,
    ...overrides,
  } as never);
}

export function contractRef(instance: CaptureInstance, jobId = "job-contract-1"): BackendJobRef {
  return {
    backend: instance.backend,
    jobId,
    instanceId: instance.instanceId,
    ...(instance.sessionId ? { sessionId: instance.sessionId } : {}),
    worldRevision: instance.worldRevision,
    recoveryBinding: instance.recoveryBinding,
  };
}

export function contractJob(instance: CaptureInstance, state: string, jobId = "job-contract-1"): BackendJob {
  const terminal = ["completed", "failed", "cancelled", "released"].includes(state);
  return {
    ref: contractRef(instance, jobId),
    state,
    cameraLeaseHeld: !terminal,
    restorationConfirmed: terminal,
  };
}
