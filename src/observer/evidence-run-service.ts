import type {
  BoundRunCapture,
  CaptureArtifact,
  CaptureRunPort,
  CompletedRunCapture,
  FailedRunCapture,
  ReservedRunCapture,
  RunCaptureReservation,
} from "./capture-contract.js";
import { CaptureError } from "./capture-contract.js";
import { legacyWorldFields } from "./world-revision.js";

export interface ObserverAgentOperationClient {
  request(operation: string, payload?: Record<string, unknown>, options?: { deadlineAtMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CaptureError("TRANSPORT_UNAVAILABLE", `${label} returned an invalid response`);
  return value as Record<string, unknown>;
}

/** Durable run owner for the host capture service; bundle export stays agent-side. */
export class EvidenceRunService implements CaptureRunPort {
  constructor(
    private readonly agent: ObserverAgentOperationClient,
    private readonly converge?: (run: Record<string, unknown>) => Promise<void>
  ) {}

  async reserve(input: RunCaptureReservation): Promise<ReservedRunCapture> {
    const result = object(await this.agent.request("runReserveCapture", {
      runId: input.runId,
      captureLabel: input.captureLabel,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      idempotencyKey: input.idempotencyKey,
      jobId: input.jobId,
      requestFingerprint: input.request.fingerprint,
      expectedWorldRevision: input.request.expectedWorldRevision,
      ...(input.request.sessionId !== undefined ? { sessionId: input.request.sessionId } : {}),
      ...(input.request.instanceId !== undefined ? { requestedInstanceId: input.request.instanceId } : {}),
      requestedView: input.request.view,
      settleFrames: input.request.settleFrames,
      performancePolicy: input.request.performancePolicy,
      image: input.request.image,
      timeoutMs: input.request.timeoutMs,
      asynchronous: input.request.asynchronous,
    }), "Run capture reservation");
    const capture = result.capture && typeof result.capture === "object" && !Array.isArray(result.capture)
      ? result.capture as Record<string, unknown> : {};
    return {
      runId: input.runId,
      captureLabel: input.captureLabel,
      ...capture,
      ...(typeof capture.jobId === "string" ? { jobId: capture.jobId } : {}),
      ...(typeof capture.backend === "string" ? { backend: capture.backend as "runtime" | "workbench" } : {}),
      ...(typeof capture.state === "string" ? { state: capture.state } : {}),
    };
  }

  async bind(input: BoundRunCapture): Promise<void> {
    const legacy = legacyWorldFields(input.ref.worldRevision);
    await this.agent.request("runBindCapture", {
      runId: input.runId,
      captureLabel: input.captureLabel,
      backend: input.ref.backend,
      ...(input.ref.sessionId ? { sessionId: input.ref.sessionId } : {}),
      jobId: input.ref.jobId,
      instanceId: input.ref.instanceId,
      worldId: legacy.worldId,
      worldEpoch: legacy.worldEpoch,
      worldRevision: input.ref.worldRevision,
    });
  }

  async complete(input: CompletedRunCapture): Promise<void> {
    if (input.ref.backend === "workbench") {
      await this.agent.request("importWorkbenchArtifact", {
        jobId: input.ref.jobId,
        image: input.artifact.image,
        metadata: input.artifact.metadata,
        runId: input.runId,
        captureLabel: input.captureLabel,
      });
    } else {
      await this.agent.request("runCompleteCapture", {
        runId: input.runId,
        captureLabel: input.captureLabel,
        backend: input.ref.backend,
        sessionId: input.ref.sessionId,
        jobId: input.ref.jobId,
      });
    }
  }

  async fail(input: FailedRunCapture): Promise<void> {
    await this.agent.request("runFailCapture", {
      runId: input.runId,
      captureLabel: input.captureLabel,
      code: input.code,
      message: input.message.slice(0, 512),
    });
  }

  async assertReleaseAllowed(input: { jobId: string; backend: "runtime" | "workbench"; sessionId?: string }): Promise<void> {
    await this.agent.request("assertJobReleaseAllowed", {
      backend: input.backend,
      jobId: input.jobId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
  }

  async readManagedArtifact(ref: { backend: "runtime" | "workbench"; jobId: string; sessionId?: string }, maxBytes: number): Promise<CaptureArtifact> {
    const operation = ref.backend === "workbench" ? "readWorkbenchArtifact" : "readArtifact";
    const response = object(await this.agent.request(operation, {
      jobId: ref.jobId,
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      maxBytes,
    }), "Managed artifact read");
    if (typeof response.imageBase64 !== "string") throw new CaptureError("ARTIFACT_INVALID", "Managed artifact response has no image payload");
    const image = Buffer.from(response.imageBase64, "base64");
    return { image, metadata: object(response.metadata ?? {}, "Managed artifact metadata") };
  }

  async releaseManagedArtifact(ref: { backend: "runtime" | "workbench"; jobId: string; sessionId?: string }): Promise<Record<string, unknown>> {
    if (ref.backend === "runtime") return { managedArtifactReleased: true, handledByBackend: true };
    return object(await this.agent.request("releaseWorkbenchArtifact", { jobId: ref.jobId }), "Managed artifact release");
  }

  async status(runId: string): Promise<Record<string, unknown>> {
    const initial = object(await this.agent.request("runStatus", { runId }), "Run status");
    await this.converge?.(initial);
    return object(await this.agent.request("runStatus", { runId }), "Run status");
  }

  async begin(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    return object(await this.agent.request("runBegin", input), "Run begin");
  }

  async finalize(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = await this.status(String(input.runId ?? ""));
    const result = object(await this.agent.request("runFinalize", input, { timeoutMs: 5 * 60_000 }), "Run finalization");
    const finalized = result.run && typeof result.run === "object" && !Array.isArray(result.run)
      ? result.run as Record<string, unknown> : {};
    const receipt = result.receipt && typeof result.receipt === "object" && !Array.isArray(result.receipt)
      ? result.receipt as Record<string, unknown> : {};
    const released = receipt.managedArtifactsReleased === true;
    const captures = Array.isArray(finalized.captures) ? finalized.captures :
      Array.isArray(run.captures) ? run.captures.map((value) => {
        if (!released || !value || typeof value !== "object" || Array.isArray(value)) return value;
        return { ...value as Record<string, unknown>, state: "released", artifactAvailable: false, missingArtifact: false };
      }) : [];
    await this.converge?.({ ...run, ...finalized, state: finalized.state ?? "finalized", captures });
    return result;
  }

  async discard(runId: string): Promise<Record<string, unknown>> {
    const run = await this.status(runId);
    const result = object(await this.agent.request("runDiscard", { runId }), "Run discard");
    const released = new Set(Array.isArray(result.releasedCaptureLabels)
      ? result.releasedCaptureLabels.filter((value): value is string => typeof value === "string") : []);
    const captures = Array.isArray(run.captures) ? run.captures.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const capture = value as Record<string, unknown>;
      return released.has(String(capture.captureLabel ?? ""))
        ? { ...capture, state: "released", artifactAvailable: false, missingArtifact: false }
        : capture;
    }) : [];
    await this.converge?.({ ...run, state: "discarded", captures });
    return result;
  }
}
