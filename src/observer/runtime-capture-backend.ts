import { ObserverAgentClient } from "./agent-client.js";
import {
  CaptureError,
  type BackendCallContext,
  type BackendJob,
  type BackendReleaseResult,
  type BackendSubmitInput,
  type CaptureArtifact,
  type CaptureBackend,
  type CaptureInstance,
  type CaptureErrorCode,
  type BackendJobRef,
  type ListInstancesInput,
} from "./capture-contract.js";
import { canonicalPublicObserverErrorCode } from "./public-contract.js";
import { assertWorldRevision, runtimeWorldFields, runtimeWorldRevision, sameWorldRevision, type WorldRevision } from "./world-revision.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CaptureError("TRANSPORT_UNAVAILABLE", `${label} returned an invalid response`);
  return value as Record<string, unknown>;
}

function code(error: unknown): CaptureErrorCode {
  return canonicalPublicObserverErrorCode(
    error && typeof error === "object" ? (error as { code?: unknown }).code : undefined,
    "TRANSPORT_UNAVAILABLE"
  );
}

function mapError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error;
  return new CaptureError(code(error), error instanceof Error ? error.message : "Runtime observer operation failed");
}

function epoch(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function worldFrom(value: Record<string, unknown>, fallback?: WorldRevision): WorldRevision {
  if (typeof value.worldRevision === "string") return assertWorldRevision(value.worldRevision, "Runtime world revision");
  return runtimeWorldRevision(typeof value.worldId === "string" ? value.worldId : null, epoch(value.worldEpoch ?? (fallback ? runtimeWorldFields(fallback).worldEpoch : 0)));
}

export interface RuntimeCaptureBackendOptions {
  maxInlineImageBytes?: number;
}

/** Maps the private runtime protocol into the backend-neutral capture domain. */
export class RuntimeCaptureBackend implements CaptureBackend {
  readonly kind = "runtime" as const;
  private readonly maxInlineImageBytes: number;

  constructor(
    private readonly agent: Pick<ObserverAgentClient, "request">,
    options: RuntimeCaptureBackendOptions = {}
  ) {
    this.maxInlineImageBytes = options.maxInlineImageBytes ?? 64 * 1024 * 1024;
  }

  async listInstances(input: ListInstancesInput, context: BackendCallContext): Promise<CaptureInstance[]> {
    try {
      const response = record(await this.agent.request("instances", {}, { deadlineAtMs: context.deadlineAtMs, signal: context.signal }), "Runtime instances");
      const values = Array.isArray(response.instances) ? response.instances : [];
      return values.filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
        .filter((value) => input.sessionId === undefined || value.sessionId === input.sessionId)
        .filter((value) => input.renderersOnly !== true || value.headless !== true)
        .filter((value) => (input.requiredCapabilities ?? []).every((capability) =>
          Array.isArray(value.capabilities) && value.capabilities.includes(capability)))
        .map((value) => this.instance(value));
    } catch (error) { throw mapError(error); }
  }

  async submit(input: BackendSubmitInput, context: BackendCallContext): Promise<BackendJob> {
    if (!input.request.sessionId) throw new CaptureError("INVALID_REQUEST", "sessionId is required for runtime capture");
    if (!sameWorldRevision(input.request.expectedWorldRevision, input.instance.worldRevision)) {
      throw new CaptureError("WORLD_CHANGED", "Selected runtime no longer matches the expected world revision");
    }
    try {
      const expected = runtimeWorldFields(input.request.expectedWorldRevision);
      const response = record(await this.agent.request("submitJob", {
        sessionId: input.request.sessionId,
        idempotencyKey: input.idempotencyKey,
        jobId: input.jobId,
        instanceId: input.instance.instanceId,
        deadlineAt: new Date(context.deadlineAtMs).toISOString(),
        deadlinePolicyMs: input.request.timeoutMs,
        view: input.request.view,
        settleFrames: input.request.settleFrames,
        performancePolicy: input.request.performancePolicy,
        expectedWorldId: expected.worldId,
        expectedWorldEpoch: expected.worldEpoch,
      }, { deadlineAtMs: context.deadlineAtMs, signal: context.signal }), "Runtime job submission");
      return this.job(response, input.instance);
    } catch (error) { throw mapError(error); }
  }

  async status(ref: BackendJobRef, context: BackendCallContext): Promise<BackendJob> {
    try {
      return this.job(record(await this.agent.request("jobStatus", { sessionId: ref.sessionId, jobId: ref.jobId }, { deadlineAtMs: context.deadlineAtMs, signal: context.signal }), "Runtime job status"), {
        backend: "runtime", instanceId: ref.instanceId, sessionId: ref.sessionId, capabilities: [], worldRevision: ref.worldRevision, worldId: null, recoveryBinding: ref.recoveryBinding,
      });
    } catch (error) { throw mapError(error); }
  }

  async cancel(ref: BackendJobRef, context: BackendCallContext): Promise<BackendJob> {
    try {
      return this.job(record(await this.agent.request("cancelJob", { sessionId: ref.sessionId, jobId: ref.jobId }, { deadlineAtMs: context.deadlineAtMs, signal: context.signal }), "Runtime job cancellation"), {
        backend: "runtime", instanceId: ref.instanceId, sessionId: ref.sessionId, capabilities: [], worldRevision: ref.worldRevision, worldId: null, recoveryBinding: ref.recoveryBinding,
      });
    } catch (error) { throw mapError(error); }
  }

  async read(ref: BackendJobRef, context: BackendCallContext): Promise<CaptureArtifact> {
    try {
      const response = record(await this.agent.request("readArtifact", { sessionId: ref.sessionId, jobId: ref.jobId, maxBytes: this.maxInlineImageBytes }, { deadlineAtMs: context.deadlineAtMs, signal: context.signal }), "Runtime artifact read");
      if (typeof response.imageBase64 !== "string") throw new CaptureError("ARTIFACT_INVALID", "Runtime observer returned an invalid image payload");
      const image = Buffer.from(response.imageBase64, "base64");
      if (image.length < 1 || image.length > this.maxInlineImageBytes) throw new CaptureError("ARTIFACT_TOO_LARGE", "Runtime artifact exceeds the inline limit");
      return { image, metadata: (response.metadata && typeof response.metadata === "object" ? response.metadata : {}) as Record<string, unknown> };
    } catch (error) { throw mapError(error); }
  }

  async release(ref: BackendJobRef, context: BackendCallContext): Promise<BackendReleaseResult> {
    try {
      const result = record(await this.agent.request("releaseJob", { sessionId: ref.sessionId, jobId: ref.jobId }, { deadlineAtMs: context.deadlineAtMs, signal: context.signal }), "Runtime artifact release");
      return { restorationConfirmed: result.restorationConfirmed !== false, artifactRemoved: result.released === true, ...result };
    } catch (error) { throw mapError(error); }
  }

  private instance(value: Record<string, unknown>): CaptureInstance {
    const worldId = typeof value.worldId === "string" ? value.worldId : null;
    const worldEpoch = epoch(value.worldEpoch);
    return {
      ...value,
      backend: "runtime",
      instanceId: String(value.instanceId ?? ""),
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((entry): entry is string => typeof entry === "string") : [],
      worldRevision: runtimeWorldRevision(worldId, worldEpoch),
      worldId,
      legacyWorldEpoch: worldEpoch,
      recoveryBinding: { sessionId: value.sessionId, instanceNonce: value.instanceNonce },
    };
  }

  private job(value: Record<string, unknown>, fallback: CaptureInstance): BackendJob {
    const revision = worldFrom(value, fallback.worldRevision);
    const jobId = typeof value.jobId === "string" ? value.jobId : "";
    if (!jobId) throw new CaptureError("TRANSPORT_UNAVAILABLE", "Runtime observer returned a job without an ID");
    return {
      ...value,
      ref: {
        backend: "runtime",
        jobId,
        instanceId: typeof value.instanceId === "string" ? value.instanceId : fallback.instanceId,
        sessionId: typeof value.sessionId === "string" ? value.sessionId : fallback.sessionId,
        worldRevision: revision,
        recoveryBinding: fallback.recoveryBinding,
      },
      state: typeof value.state === "string" ? value.state : "failed",
      ...(typeof value.artifact === "object" && value.artifact !== null ? { artifact: value.artifact as Record<string, unknown> } : {}),
    };
  }
}
