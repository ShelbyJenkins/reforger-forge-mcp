import {
  WorkbenchObserverAdapterError,
  type WorkbenchObserverAdapter,
  type WorkbenchObserverInstance,
  type WorkbenchObserverJobStatus,
} from "../workbench/observer-adapter.js";
import {
  CaptureError,
  type BackendCallContext,
  type BackendJob,
  type BackendJobRef,
  type BackendReleaseResult,
  type BackendSubmitInput,
  type CaptureArtifact,
  type CaptureBackend,
  type CaptureInstance,
  type ListInstancesInput,
} from "./capture-contract.js";
import { canonicalPublicObserverErrorCode } from "./public-contract.js";
import { legacyWorldFields, sameWorldRevision, workbenchWorldRevision } from "./world-revision.js";

function mapError(error: unknown): CaptureError {
  if (error instanceof CaptureError) return error;
  if (error instanceof WorkbenchObserverAdapterError) {
    const code = error.code === "HANDLER_UNAVAILABLE" ? "TRANSPORT_UNAVAILABLE" :
      error.code === "HANDLER_REJECTED" ? "CAPTURE_REJECTED" : error.code;
    return new CaptureError(code, error.message);
  }
  const code = canonicalPublicObserverErrorCode(
    (error as { code?: unknown } | null | undefined)?.code,
    "TRANSPORT_UNAVAILABLE"
  );
  return new CaptureError(code, error instanceof Error ? error.message : "Workbench observer operation failed");
}

async function within<T>(operation: () => Promise<T>, context: BackendCallContext): Promise<T> {
  const remaining = context.deadlineAtMs - Date.now();
  if (remaining <= 0) throw new CaptureError("CAPTURE_TIMEOUT", "Workbench operation exceeded its capture deadline");
  if (context.signal?.aborted) throw new CaptureError("CANCELLED", "Workbench operation was cancelled");
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CaptureError("CAPTURE_TIMEOUT", "Workbench operation exceeded its capture deadline"));
    }, remaining);
    timer.unref();
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CaptureError("CANCELLED", "Workbench operation was cancelled"));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    operation().then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

export class WorkbenchCaptureBackend implements CaptureBackend {
  readonly kind = "workbench" as const;

  constructor(private readonly adapter: Pick<WorkbenchObserverAdapter, "instances" | "submit" | "recover" | "status" | "cancel" | "release" | "readCompletedArtifact">) {}

  async listInstances(input: ListInstancesInput, context: BackendCallContext): Promise<CaptureInstance[]> {
    try {
      const instances = await within(() => this.adapter.instances(), context);
      return instances.map((value) => this.instance(value));
    } catch (error) { throw mapError(error); }
  }

  async submit(input: BackendSubmitInput, context: BackendCallContext): Promise<BackendJob> {
    const legacy = legacyWorldFields(input.instance.worldRevision);
    const opaqueMismatch = input.request.expectedWorldRevision !== undefined &&
      !sameWorldRevision(input.request.expectedWorldRevision, input.instance.worldRevision) &&
      !(input.request.expectedWorldId === legacy.worldId && input.request.expectedWorldEpoch === legacy.worldEpoch);
    if (opaqueMismatch ||
        (input.request.expectedWorldId !== undefined && input.request.expectedWorldId !== legacy.worldId) ||
        (input.request.expectedWorldEpoch !== undefined && input.request.expectedWorldEpoch !== legacy.worldEpoch)) {
      throw new CaptureError("WORLD_CHANGED", "Selected Workbench instance no longer matches the expected world revision");
    }
    try {
      const status = await within(() => this.adapter.submit({
        jobId: input.jobId,
        view: input.request.view,
        settlePolls: input.request.settleFrames,
      }), context);
      return this.job(status, input.instance);
    } catch (error) { throw mapError(error); }
  }

  async status(ref: BackendJobRef, context: BackendCallContext): Promise<BackendJob> {
    try {
      const status = await within(() => this.adapter.recover({ jobId: ref.jobId, expectedInstanceId: ref.instanceId }), context);
      return this.job(status, {
        backend: "workbench", instanceId: ref.instanceId, capabilities: [], worldRevision: ref.worldRevision, worldId: null,
        recoveryBinding: ref.recoveryBinding,
      });
    } catch (error) { throw mapError(error); }
  }

  async cancel(ref: BackendJobRef, context: BackendCallContext): Promise<BackendJob> {
    try {
      const status = await within(() => this.adapter.cancel(ref.jobId), context);
      return this.job(status, {
        backend: "workbench", instanceId: ref.instanceId, capabilities: [], worldRevision: ref.worldRevision, worldId: null,
        recoveryBinding: ref.recoveryBinding,
      });
    } catch (error) { throw mapError(error); }
  }

  async read(ref: BackendJobRef, context: BackendCallContext): Promise<CaptureArtifact> {
    try {
      const result = await within(async () => this.adapter.readCompletedArtifact(ref.jobId), context);
      return { image: result.image, metadata: result.metadata };
    } catch (error) { throw mapError(error); }
  }

  async release(ref: BackendJobRef, context: BackendCallContext): Promise<BackendReleaseResult> {
    try {
      const result = await within(() => this.adapter.release(ref.jobId), context);
      return { ...result, restorationConfirmed: result.restorationConfirmed, artifactRemoved: result.artifactRemoved };
    } catch (error) { throw mapError(error); }
  }

  private instance(value: WorkbenchObserverInstance): CaptureInstance {
    const revision = workbenchWorldRevision(value.worldIdentity);
    const legacy = legacyWorldFields(revision);
    return {
      ...value,
      backend: "workbench",
      instanceId: value.instanceId,
      capabilities: value.capabilities,
      worldRevision: revision,
      worldId: legacy.worldId,
      legacyWorldEpoch: legacy.worldEpoch,
      stale: false,
      transportHealthy: true,
      headless: false,
      selectedTransport: "workbench-netapi",
      recoveryBinding: {
        lifecycleGeneration: value.lifecycleGeneration,
        canonicalTarget: value.canonicalTarget,
      },
    };
  }

  private job(value: WorkbenchObserverJobStatus, fallback: CaptureInstance): BackendJob {
    const revision = workbenchWorldRevision(value.worldIdentity);
    const { artifact: completedArtifact, ...statusWithoutArtifact } = value;
    return {
      ...statusWithoutArtifact,
      ref: {
        backend: "workbench",
        jobId: value.jobId,
        instanceId: value.instanceId,
        worldRevision: revision,
        recoveryBinding: {
          ...fallback.recoveryBinding,
          lifecycleGeneration: value.lifecycleGeneration,
          canonicalTarget: value.canonicalTarget,
        },
      },
      state: value.state,
      message: value.message,
      ...(value.terminalErrorCode ? { terminalErrorCode: value.terminalErrorCode } : {}),
      cameraLeaseHeld: value.cameraLeaseHeld,
      restorationConfirmed: value.restorationConfirmed,
      ...(completedArtifact ? { artifact: { ...completedArtifact } } : {}),
      metadata: {
        actualCamera: value.actualCamera,
        actualFov: value.actualFov,
        worldIdentity: value.worldIdentity,
        viewKind: value.viewKind,
      },
    };
  }
}
