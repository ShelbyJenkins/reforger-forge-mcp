import { createHash, randomUUID } from "node:crypto";
import { redactText } from "../foundation/redact.js";
import {
  CaptureError,
  hasRestorationObligation,
  isTerminalJob,
  type BackendCallContext,
  type BackendJob,
  type BackendJobRef,
  type BackendReleaseResult,
  type CaptureArtifact,
  type CaptureBackend,
  type CaptureBackendKind,
  type CaptureInput,
  type CaptureErrorCode,
  type CaptureInstance,
  type CaptureResult,
  type CaptureRunPort,
  type ListInstancesInput,
  type PublicCaptureJob,
} from "./capture-contract.js";
import { canonicalPublicObserverErrorCode } from "./public-contract.js";
import { CaptureJobStore, type CaptureJobRecord } from "./capture-job-store.js";
import {
  DEFAULT_IMAGE_POLICY_LIMITS,
  idempotencyScope,
  normalizeCaptureRequest,
  type ImagePolicyDefaults,
} from "./capture-request.js";
import {
  assertWorldRevision,
  isWorldRevision,
  legacyWorldFields,
  runtimeWorldRevision,
  sameWorldRevision,
  workbenchWorldRevision,
  type WorldRevision,
} from "./world-revision.js";

export interface CaptureServiceOptions {
  backends: readonly CaptureBackend[];
  store?: CaptureJobStore;
  runPort?: CaptureRunPort;
  defaultTimeoutMs?: number;
  pollIntervalMs?: number;
  maxInlineImageBytes?: number;
  imagePolicyDefaults?: Partial<ImagePolicyDefaults>;
  clock?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  createJobId?: () => string;
}

export interface CaptureInstanceList {
  instances: CaptureInstance[];
  compatibleCount: number;
  waitedMs: number;
  timedOut: boolean;
  warnings?: string[];
}

export interface CaptureQuiesceFailure {
  jobId: string;
  code: string;
  summary: string;
}

export interface CaptureQuiesceResult {
  quiescent: boolean;
  remainingJobIds: string[];
  remainingAdmissionScopes: string[];
  remainingActiveOperationIds: string[];
  failures: CaptureQuiesceFailure[];
}

interface ActiveCapture {
  promise: Promise<BackendJob>;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1_000 || result > 5 * 60_000) throw new CaptureError("INVALID_REQUEST", "Capture timeout is invalid");
  return result;
}

function errorCode(error: unknown): CaptureErrorCode {
  return canonicalPublicObserverErrorCode(
    error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  );
}

function asCaptureError(error: unknown, details?: Record<string, unknown>): CaptureError {
  if (error instanceof CaptureError) {
    return details ? new CaptureError(error.code, error.message, { ...error.details, ...details }) : error;
  }
  return new CaptureError(errorCode(error), error instanceof Error ? error.message : "Observer capture failed", details);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CaptureError("CANCELLED", "Observer capture was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new CaptureError("CANCELLED", "Observer capture was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function combinedSignal(left: AbortSignal | undefined, right: AbortSignal): AbortSignal {
  if (!left) return right;
  return AbortSignal.any([left, right]);
}

function isCompatible(instance: CaptureInstance, request: ReturnType<typeof normalizeCaptureRequest>): boolean {
  if (instance.stale === true || instance.transportHealthy === false) return false;
  const capabilities = new Set(instance.capabilities);
  if (!capabilities.has("render.capture")) return false;
  if (request.view.kind !== "current" && !capabilities.has(instance.backend === "workbench" ? "camera.editor" : "camera.runtime")) return false;
  return true;
}

function isQueryCompatible(instance: CaptureInstance, query: ListInstancesInput): boolean {
  if (instance.stale === true || instance.transportHealthy === false || instance.headless === true) return false;
  if (query.renderersOnly && !instance.capabilities.includes("render.capture")) return false;
  return (query.requiredCapabilities ?? []).every((capability) => instance.capabilities.includes(capability));
}

function publicJob(job: BackendJob): PublicCaptureJob {
  const legacy = legacyWorldFields(job.ref.worldRevision);
  const projection: PublicCaptureJob = {
    ...job,
    backend: job.ref.backend,
    jobId: job.ref.jobId,
    instanceId: job.ref.instanceId,
    worldRevision: job.ref.worldRevision,
    worldId: legacy.worldId,
    worldEpoch: legacy.worldEpoch,
    state: job.state,
  };
  delete (projection as Record<string, unknown>).ref;
  return projection;
}

function refFor(instance: CaptureInstance, jobId: string): BackendJobRef {
  return {
    backend: instance.backend,
    jobId,
    instanceId: instance.instanceId,
    sessionId: instance.sessionId,
    worldRevision: instance.worldRevision,
    recoveryBinding: instance.recoveryBinding,
  };
}

export class CaptureService {
  readonly store: CaptureJobStore;
  readonly defaultTimeoutMs: number;
  readonly maxInlineImageBytes: number;
  readonly imagePolicyDefaults: ImagePolicyDefaults;
  private readonly backends = new Map<CaptureBackendKind, CaptureBackend>();
  private readonly runPort?: CaptureRunPort;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly createJobId: () => string;
  private readonly active = new Map<string, ActiveCapture>();
  private readonly admissions = new Map<string, Promise<CaptureResult>>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly shutdownAbort = new AbortController();
  private sealed = false;
  private terminalClosed = false;

  constructor(options: CaptureServiceOptions) {
    if (!options.backends.length) throw new TypeError("CaptureService requires at least one backend");
    this.store = options.store ?? new CaptureJobStore({ clock: options.clock });
    this.defaultTimeoutMs = boundedTimeout(options.defaultTimeoutMs, 30_000);
    this.maxInlineImageBytes = options.maxInlineImageBytes ?? 8 * 1024 * 1024;
    this.imagePolicyDefaults = {
      ...DEFAULT_IMAGE_POLICY_LIMITS,
      ...options.imagePolicyDefaults,
    };
    if (Object.values(this.imagePolicyDefaults).some((value) => !Number.isSafeInteger(value) || value < 1) ||
        this.imagePolicyDefaults.maximumWidth > DEFAULT_IMAGE_POLICY_LIMITS.maximumWidth ||
        this.imagePolicyDefaults.maximumHeight > DEFAULT_IMAGE_POLICY_LIMITS.maximumHeight ||
        this.imagePolicyDefaults.maximumPixels > DEFAULT_IMAGE_POLICY_LIMITS.maximumPixels ||
        this.imagePolicyDefaults.maximumLossyQuality > 100 ||
        this.imagePolicyDefaults.minimumLossyQuality > this.imagePolicyDefaults.lossyQuality ||
        this.imagePolicyDefaults.lossyQuality > this.imagePolicyDefaults.maximumLossyQuality) {
      throw new TypeError("Capture image quality defaults are inconsistent");
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.now = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.createJobId = options.createJobId ?? (() => randomUUID());
    this.runPort = options.runPort;
    for (const backend of options.backends) {
      if (this.backends.has(backend.kind)) throw new TypeError(`Duplicate capture backend: ${backend.kind}`);
      this.backends.set(backend.kind, backend);
    }
    this.sweepTimer = setInterval(() => { void this.sweep().catch(() => undefined); }, Math.max(50, Math.min(1_000, this.pollIntervalMs)));
    this.sweepTimer.unref();
  }

  async instances(query: ListInstancesInput & { waitMs?: number; signal?: AbortSignal } = {}): Promise<CaptureInstanceList> {
    const started = this.now();
    const waitMs = query.waitMs ?? 0;
    const deadlineAtMs = started + waitMs;
    for (;;) {
      if (query.signal?.aborted) throw new CaptureError("CANCELLED", "Observer instance wait was cancelled");
      const warnings: string[] = [];
      const all: CaptureInstance[] = [];
      for (const backend of this.backends.values()) {
        try {
          all.push(...await backend.listInstances(query, { deadlineAtMs: waitMs > 0 ? deadlineAtMs : this.now() + this.defaultTimeoutMs, signal: query.signal }));
        } catch (error) {
          // Runtime remains useful if optional Workbench is absent, and vice
          // versa. A fully unavailable inventory still maps to no endpoint.
          warnings.push(`${backend.kind} observer unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 512));
        }
      }
      const compatible = all.filter((instance) => isQueryCompatible(instance, query));
      const elapsed = this.now() - started;
      if (waitMs <= 0 || compatible.length > 0 || this.now() >= deadlineAtMs) {
        const projected = all.map(({ recoveryBinding: _recoveryBinding, ...instance }) => ({ ...instance }));
        return { instances: projected as CaptureInstance[], compatibleCount: compatible.length, waitedMs: elapsed, timedOut: waitMs > 0 && compatible.length === 0, ...(warnings.length ? { warnings } : {}) };
      }
      await this.sleep(Math.min(this.pollIntervalMs, Math.max(1, deadlineAtMs - this.now())), query.signal);
    }
  }

  async capture(input: CaptureInput): Promise<CaptureResult> {
    if (this.sealed) throw new CaptureError("TRANSPORT_UNAVAILABLE", "Observer capture admission is closed");
    const request = normalizeCaptureRequest(input, this.defaultTimeoutMs, this.imagePolicyDefaults);
    const scope = idempotencyScope(input);
    const retained = this.store.get(scope);
    if (retained) {
      if (retained.fingerprint !== request.fingerprint) throw new CaptureError("IDEMPOTENCY_CONFLICT", "Capture idempotency key was reused with a different request");
      if (retained.releaseReceipt) throw new CaptureError("JOB_RELEASED", "Capture idempotency key belongs to a released job", { release: retained.releaseReceipt });
      return this.finishExisting(retained, input);
    }
    const inFlight = this.admissions.get(scope);
    if (inFlight) return inFlight;
    const admitted = this.admit({
      ...input,
      signal: combinedSignal(input.signal, this.shutdownAbort.signal),
    }, request, scope);
    this.admissions.set(scope, admitted);
    try { return await admitted; } finally { this.admissions.delete(scope); }
  }

  private async admit(input: CaptureInput, request: ReturnType<typeof normalizeCaptureRequest>, scope: string): Promise<CaptureResult> {
    if (input.signal?.aborted) throw new CaptureError("CANCELLED", "Observer capture was cancelled");
    const deadlineAtMs = this.now() + request.timeoutMs;
    let reservation: Awaited<ReturnType<NonNullable<CaptureRunPort["reserve"]>>> | undefined;
    const generatedJobId = this.validatedJobId(this.createJobId());
    let jobId = generatedJobId;
    try {
      if (request.runId && request.captureLabel) {
        if (!this.runPort) throw new CaptureError("CAPABILITY_UNAVAILABLE", "Durable capture runs are unavailable");
        reservation = await this.runPort.reserve({ runId: request.runId, captureLabel: request.captureLabel, ...(request.purpose ? { purpose: request.purpose } : {}), idempotencyKey: input.idempotencyKey, request, jobId: generatedJobId });
      }
      const instance = await this.selectInstance(request, deadlineAtMs, input.signal);
      if (!instance.sessionId && instance.backend === "runtime") throw new CaptureError("INVALID_REQUEST", "sessionId is required for runtime capture");
      this.assertExpectedWorld(input, instance);
      const reservedJobId = reservation?.jobId ??
        (reservation && typeof reservation.capture === "object" && reservation.capture !== null && typeof (reservation.capture as Record<string, unknown>).jobId === "string"
          ? (reservation.capture as Record<string, unknown>).jobId as string : undefined);
      jobId = this.validatedJobId(reservedJobId ?? generatedJobId);
      const ref = refFor(instance, jobId);
      const queued: BackendJob = { ref, state: "queued" };
      const initial: Omit<CaptureJobRecord, "estimatedBytes"> = {
        jobId,
        idempotencyScope: scope,
        fingerprint: request.fingerprint,
        request,
        ref,
        deadlineAtMs,
        createdAtMs: this.now(),
        retentionUntilMs: deadlineAtMs + 10 * 60_000,
        ...(request.runId ? { runId: request.runId } : {}),
        ...(request.captureLabel ? { captureLabel: request.captureLabel } : {}),
        lastBackendJob: queued,
        lastProjection: publicJob(queued),
        cancelRequested: false,
        pinned: Boolean(request.runId),
      };
      this.store.add(initial);
      if (request.runId && request.captureLabel) await this.runPort!.bind({ runId: request.runId, captureLabel: request.captureLabel, ref });
      const backend = this.backends.get(instance.backend)!;
      let submitted: BackendJob;
      if (reservation?.state === "submitted" || reservation?.state === "completed" ||
          (reservation && typeof reservation.capture === "object" && reservation.capture !== null &&
            ["submitted", "completed"].includes(String((reservation.capture as Record<string, unknown>).state)))) {
        try {
          submitted = await backend.status(ref, this.context(deadlineAtMs, input.signal));
        } catch (error) {
          if (errorCode(error) !== "JOB_NOT_FOUND") throw error;
          submitted = await backend.submit({ jobId, idempotencyKey: input.idempotencyKey, request, instance }, this.context(deadlineAtMs, input.signal));
        }
      } else {
        submitted = await backend.submit({ jobId, idempotencyKey: input.idempotencyKey, request, instance }, this.context(deadlineAtMs, input.signal));
      }
      this.store.update(jobId, (record) => {
        record.lastBackendJob = { ...submitted, ref: { ...submitted.ref, jobId } };
        record.lastProjection = publicJob(record.lastBackendJob);
      });
      if (request.asynchronous) {
        if (isTerminalJob(submitted)) await this.completeIfNeeded(this.store.getById(jobId)!);
        return { asynchronous: true, job: this.store.getById(jobId)!.lastProjection };
      }
      const terminal = await this.poll(this.store.getById(jobId)!, input.signal);
      if (terminal.state !== "completed") throw this.terminalError(terminal);
      const artifact = await this.readArtifact(this.store.getById(jobId)!, deadlineAtMs, input.signal);
      await this.completeArtifact(this.store.getById(jobId)!, terminal, artifact);
      if (artifact.image.length <= this.maxInlineImageBytes) {
        return { asynchronous: false, job: this.store.getById(jobId)!.lastProjection, image: artifact.image, metadata: artifact.metadata };
      }
    } catch (error) {
      const mapped = asCaptureError(error);
      const retainedJob = this.store.getById(jobId);
      if (retainedJob) {
        await this.failRun(retainedJob, mapped);
        if (!isTerminalJob(retainedJob.lastBackendJob)) this.store.update(jobId, (record) => {
          record.lastBackendJob = { ...record.lastBackendJob, terminalErrorCode: mapped.code, terminalMessage: mapped.message };
          record.lastProjection = publicJob(record.lastBackendJob);
        });
      }
      throw mapped;
    }
    // Only reached once the artifact has already been successfully fetched
    // and durably completed above (every other path in the try block above
    // returns or throws). Being too large to return inline is not a capture
    // failure: it must not flow through the catch block above, which would
    // otherwise incorrectly re-mark an already completed run capture as failed.
    throw new CaptureError("ARTIFACT_TOO_LARGE", "Validated capture exceeds the configured inline limit", { job: this.store.getById(jobId)!.lastProjection });
  }

  async status(sessionId: string | undefined, jobId: string): Promise<PublicCaptureJob> {
    const record = this.requireJob(sessionId, jobId);
    if (record.releaseReceipt) return record.lastProjection;
    if (isTerminalJob(record.lastBackendJob)) {
      await this.completeIfNeeded(record);
      return this.store.getById(jobId)!.lastProjection;
    }
    if (record.deadlineAtMs <= this.now()) {
      await this.cancelOnce(record).catch(() => undefined);
      return this.store.getById(jobId)!.lastProjection;
    }
    const job = await this.refresh(record, this.operationDeadline());
    if (job.state === "completed") await this.completeIfNeeded(this.store.getById(jobId)!);
    return this.store.getById(jobId)!.lastProjection;
  }

  async cancel(sessionId: string | undefined, jobId: string): Promise<PublicCaptureJob> {
    const record = this.requireJob(sessionId, jobId);
    if (record.releaseReceipt) return record.lastProjection;
    const active = this.active.get(`cancel:${jobId}`);
    if (active) { await active.promise; return this.store.getById(jobId)!.lastProjection; }
    const promise = this.cancelOnce(record);
    this.active.set(`cancel:${jobId}`, { promise });
    try { await promise; } finally { this.active.delete(`cancel:${jobId}`); }
    return this.store.getById(jobId)!.lastProjection;
  }

  async read(sessionId: string | undefined, jobId: string): Promise<{ job: PublicCaptureJob; image: Buffer; metadata: Record<string, unknown> }> {
    const record = this.requireJob(sessionId, jobId);
    const operationDeadline = this.operationDeadline();
    const job = isTerminalJob(record.lastBackendJob) ? record.lastBackendJob : await this.refresh(record, operationDeadline);
    if (job.state !== "completed") throw new CaptureError("ARTIFACT_INCOMPLETE", "Capture is not completed", { job: publicJob(job) });
    const artifact = await this.readArtifact(record, operationDeadline);
    await this.completeArtifact(this.store.getById(jobId)!, job, artifact);
    if (artifact.image.length > this.maxInlineImageBytes) throw new CaptureError("ARTIFACT_TOO_LARGE", "Validated capture exceeds the configured inline limit", { job: publicJob(job) });
    return { job: this.store.getById(jobId)!.lastProjection, image: artifact.image, metadata: artifact.metadata };
  }

  async release(sessionId: string | undefined, jobId: string): Promise<Record<string, unknown>> {
    const record = this.requireJob(sessionId, jobId);
    if (record.releaseReceipt) return { ...record.releaseReceipt };
    if (this.runPort) await this.runPort.assertReleaseAllowed({ jobId, backend: record.ref.backend, sessionId: record.ref.sessionId });
    let current = record.lastBackendJob;
    const workbenchLeaseResolved = (): boolean =>
      record.ref.backend === "workbench" && isTerminalJob(current) && current.cameraLeaseHeld === false;
    if (!isTerminalJob(current) || (hasRestorationObligation(current) && !workbenchLeaseResolved())) {
      current = await this.refresh(record);
      if (!isTerminalJob(current) || (hasRestorationObligation(current) && !workbenchLeaseResolved())) {
        throw new CaptureError("CAMERA_BUSY", "Capture release requires terminal state with no active camera lease", { job: publicJob(current) });
      }
    }
    const retainedHandler = current.handlerRelease && typeof current.handlerRelease === "object"
      ? current.handlerRelease as Record<string, unknown> : null;
    const result = retainedHandler ?? await this.backends.get(record.ref.backend)!.release(record.ref, this.context(this.operationDeadline()));
    let managed: Record<string, unknown> = {};
    if (record.runCompleted && !record.managedArtifactReleased && this.runPort?.releaseManagedArtifact) {
      managed = await this.runPort.releaseManagedArtifact(record.ref);
    }
    const managedArtifactReleased = record.ref.backend === "runtime"
      ? result.artifactRemoved !== false
      : record.managedArtifactReleased === true
        ? true
      : record.runCompleted
        ? managed.released === true || managed.alreadyAbsent === true || managed.managedArtifactReleased === true
        : result.artifactRemoved === true;
    const receipt = { ...result, ...managed, backend: record.ref.backend, jobId, managedArtifactReleased };
    this.store.update(jobId, (stored) => {
      stored.releaseReceipt = receipt;
      stored.managedArtifactReleased = managedArtifactReleased;
      stored.lastBackendJob = { ...current, state: "released", restorationConfirmed: result.restorationConfirmed !== false };
      stored.lastProjection = publicJob(stored.lastBackendJob);
      stored.pinned = false;
    });
    return receipt;
  }

  async sweep(now = this.now()): Promise<{ expiredJobIds: string[]; removedJobIds: string[] }> {
    const expiredJobIds: string[] = [];
    for (const record of this.store.entries()) {
      if (record.releaseReceipt || isTerminalJob(record.lastBackendJob) || record.deadlineAtMs > now) continue;
      expiredJobIds.push(record.jobId);
      await this.cancelOnce(record).catch(() => undefined);
    }
    return { expiredJobIds, removedJobIds: this.store.sweep(now) };
  }

  diagnostics(): Record<string, unknown> { return { ...this.store.diagnostics(), backends: [...this.backends.keys()] }; }

  /**
   * Reattach public records from the durable run binding. This is deliberately
   * exact-ref recovery: the run supplies backend, instance and revision; no
   * backend is asked to recover from a bare job ID.
   */
  async convergeRun(run: Record<string, unknown>): Promise<void> {
    const runId = typeof run.runId === "string" ? run.runId : undefined;
    const captures = Array.isArray(run.captures)
      ? run.captures.filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value))
      : [];
    for (const capture of captures) {
      const backend = capture.backend;
      const jobId = capture.jobId;
      const instanceId = capture.instanceId;
      if ((backend !== "runtime" && backend !== "workbench") || typeof jobId !== "string" || typeof instanceId !== "string") continue;
      let record = this.store.getById(jobId);
      if (!record) {
        const worldRevision = this.recoveredRevision(backend, capture);
        const ref: BackendJobRef = {
          backend,
          jobId,
          instanceId,
          ...(typeof capture.sessionId === "string" ? { sessionId: capture.sessionId } : {}),
          worldRevision,
          recoveryBinding: {},
        };
        const fingerprint = createHash("sha256").update(JSON.stringify({ recovered: true, runId, jobId, backend, instanceId, worldRevision })).digest("hex");
        const request = {
          ...(typeof capture.sessionId === "string" ? { sessionId: capture.sessionId } : {}),
          instanceId,
          view: { kind: "current" } as const,
          settleFrames: 0,
          performancePolicy: "evidence" as const,
          image: { format: "png" as const },
          timeoutMs: this.defaultTimeoutMs,
          expectedWorldRevision: worldRevision,
          runId,
          ...(typeof capture.captureLabel === "string" ? { captureLabel: capture.captureLabel } : {}),
          asynchronous: true,
          fingerprint,
        };
        const completed = capture.artifactAvailable === true && capture.missingArtifact !== true;
        const job: BackendJob = {
          ref,
          state: "queued",
          restorationConfirmed: false,
          ...(completed && capture.artifact && typeof capture.artifact === "object" ? { artifact: capture.artifact as Record<string, unknown> } : {}),
          managedArtifactAvailable: completed,
        };
        try {
          this.store.add({
            jobId,
            idempotencyScope: `recovered:${backend}:${jobId}`,
            fingerprint,
            request,
            ref,
            deadlineAtMs: this.now() + this.defaultTimeoutMs,
            createdAtMs: this.now(),
            retentionUntilMs: this.now() + 10 * 60_000,
            ...(runId ? { runId } : {}),
            ...(typeof capture.captureLabel === "string" ? { captureLabel: capture.captureLabel } : {}),
            lastBackendJob: job,
            lastProjection: publicJob(job),
            cancelRequested: false,
            runCompleted: completed,
            pinned: run.state === "open",
          });
        } catch (error) {
          if (errorCode(error) !== "INVALID_REQUEST") throw error;
        }
        record = this.store.getById(jobId);
      }
      if (!record || record.releaseReceipt) continue;
      const runReleasedArtifact = capture.state === "released" || run.state === "discarded" ||
        (run.state === "finalized" && capture.artifactAvailable !== true);
      if (runReleasedArtifact) {
        this.store.update(jobId, (stored) => {
          stored.runCompleted = true;
          stored.managedArtifactReleased = true;
          stored.pinned = false;
          stored.lastBackendJob = {
            ...stored.lastBackendJob,
            ...(isTerminalJob(stored.lastBackendJob) ? {} : { state: "completed" }),
            restorationConfirmed: stored.lastBackendJob.restorationConfirmed !== false,
            managedArtifactAvailable: false,
          };
          stored.lastProjection = publicJob(stored.lastBackendJob);
        });
        record = this.store.getById(jobId);
      } else if (run.state !== "open") {
        this.store.update(jobId, (stored) => { stored.pinned = false; });
        record = this.store.getById(jobId);
      }
      if (!record) continue;
      if (runReleasedArtifact && record.lastBackendJob.handlerRelease &&
          typeof record.lastBackendJob.handlerRelease === "object") {
        this.retainReleasedRunReceipt(
          jobId,
          backend,
          record.lastBackendJob.handlerRelease as BackendReleaseResult
        );
        continue;
      }
      try {
        let job = await this.refresh(record, this.operationDeadline());
        if (backend === "workbench" && runReleasedArtifact &&
            (!isTerminalJob(job) || job.cameraLeaseHeld === true)) {
          job = await this.cancelOnce(this.store.getById(jobId)!);
        }
        if (backend === "workbench" && runReleasedArtifact &&
            (!isTerminalJob(job) || job.cameraLeaseHeld !== false)) {
          throw new CaptureError(
            "RESTORATION_UNCONFIRMED",
            `Discarded run retained an active Workbench camera lease for job ${jobId}`,
            {
              runId,
              job: publicJob(job),
              recovery: `Retry observer_job cancel/release for retained Workbench job ${jobId}`,
            }
          );
        }
        const workbenchLeaseResolved = backend === "workbench" &&
          isTerminalJob(job) && job.cameraLeaseHeld === false;
        if (job.state === "completed" || workbenchLeaseResolved) {
          const current = this.store.getById(jobId)!;
          // Workbench has already imported a separate managed copy, so its
          // external handler may be released during convergence. Runtime run
          // artifacts are the managed copy: finalize/discard retain exclusive
          // release ownership until the durable run snapshot says it is gone.
          const mayReleaseBackend = backend === "workbench" || runReleasedArtifact;
          if (mayReleaseBackend &&
              (current.runCompleted || current.lastBackendJob.managedArtifactAvailable === true)) {
            const released = await this.backends.get(backend)!.release(current.ref, this.context(this.operationDeadline()));
            if (runReleasedArtifact) {
              this.retainReleasedRunReceipt(jobId, backend, released);
            } else {
              this.store.update(jobId, (stored) => {
                stored.runCompleted = true;
                stored.lastBackendJob = { ...stored.lastBackendJob, handlerRelease: released };
                stored.lastProjection = publicJob(stored.lastBackendJob);
              });
            }
          } else {
            await this.completeIfNeeded(current);
          }
        }
      } catch (error) {
        const code = errorCode(error);
        if (code === "JOB_NOT_FOUND" && record.lastBackendJob.managedArtifactAvailable === true) {
          this.store.update(jobId, (stored) => {
            stored.runCompleted = true;
            stored.lastBackendJob = { ...stored.lastBackendJob, state: "completed", restorationConfirmed: true, recoveredFromManagedArtifact: true };
            stored.lastProjection = publicJob(stored.lastBackendJob);
          });
          continue;
        }
        if (code === "TRANSPORT_UNAVAILABLE" && backend === "workbench" && runReleasedArtifact) {
          const retained = this.store.getById(jobId) ?? record;
          throw asCaptureError(error, {
            runId,
            job: publicJob(retained.lastBackendJob),
            recovery: `Retry observer_job cancel/release for retained Workbench job ${jobId}`,
          });
        }
        if (code !== "JOB_NOT_FOUND" && code !== "TRANSPORT_UNAVAILABLE") throw error;
      }
    }
  }

  async quiesce(deadlineAtMs: number): Promise<CaptureQuiesceResult> {
    if (!Number.isFinite(deadlineAtMs)) throw new TypeError("Capture quiescence deadline is invalid");
    this.sealed = true;
    if (!this.shutdownAbort.signal.aborted) this.shutdownAbort.abort();
    const failures = new Map<string, CaptureQuiesceFailure>();

    while (this.now() < deadlineAtMs) {
      const admissions = [...this.admissions.values()];
      const activeOperations = [...this.active.values()].map((entry) => entry.promise);
      if (!await this.settleBeforeDeadline([...admissions, ...activeOperations], deadlineAtMs)) break;

      const obligations = this.shutdownObligations();
      if (this.admissions.size === 0 && this.active.size === 0 && obligations.length === 0) {
        return {
          quiescent: true,
          remainingJobIds: [],
          remainingAdmissionScopes: [],
          remainingActiveOperationIds: [],
          failures: [],
        };
      }

      const attempts = obligations.map(async (record) => {
        try {
          await this.cancelOnce(record, deadlineAtMs);
          failures.delete(record.jobId);
        } catch (error) {
          failures.set(record.jobId, {
            jobId: record.jobId.slice(0, 96),
            code: errorCode(error),
            summary: redactText(error instanceof Error ? error.message : String(error), {
              profile: "diagnostic",
              maxLength: 240,
            }),
          });
        }
      });
      if (!await this.settleBeforeDeadline(attempts, deadlineAtMs)) break;
      if (this.shutdownObligations().length > 0 && this.now() < deadlineAtMs) {
        await this.delayBeforeDeadline(deadlineAtMs);
      }
    }

    return {
      quiescent: false,
      remainingJobIds: this.shutdownObligations().map((record) => record.jobId).slice(0, 32),
      remainingAdmissionScopes: [...this.admissions.keys()].slice(0, 16),
      remainingActiveOperationIds: [...this.active.keys()].slice(0, 16),
      failures: [...failures.values()].slice(0, 16),
    };
  }

  async close(): Promise<void> {
    if (this.terminalClosed) return;
    this.sealed = true;
    if (!this.shutdownAbort.signal.aborted) this.shutdownAbort.abort();
    clearInterval(this.sweepTimer);
    // Application shutdown calls quiesce() before this terminal cleanup. Keep
    // direct service disposal backward-compatible and bounded to one
    // best-effort cancellation pass for isolated/unit consumers.
    await Promise.allSettled(this.shutdownObligations().map((record) => this.cancelOnce(record)));
    this.terminalClosed = true;
  }

  private shutdownObligations(): CaptureJobRecord[] {
    return this.store.entries().filter((record) =>
      !record.releaseReceipt && hasRestorationObligation(record.lastBackendJob));
  }

  private async settleBeforeDeadline(promises: readonly Promise<unknown>[], deadlineAtMs: number): Promise<boolean> {
    if (promises.length === 0) return true;
    const remaining = deadlineAtMs - this.now();
    if (remaining <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
      timer.unref();
    });
    const settled = Promise.allSettled(promises).then(() => true as const);
    try { return await Promise.race([settled, expired]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async delayBeforeDeadline(deadlineAtMs: number): Promise<void> {
    const remaining = deadlineAtMs - this.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(this.pollIntervalMs, remaining));
      timer.unref();
    });
  }

  private async selectInstance(request: ReturnType<typeof normalizeCaptureRequest>, deadlineAtMs: number, signal?: AbortSignal): Promise<CaptureInstance> {
    const candidates: CaptureInstance[] = [];
    const errors: string[] = [];
    const failures: CaptureError[] = [];
    for (const backend of this.backends.values()) {
      if (!request.sessionId && backend.kind === "runtime") continue;
      try {
        candidates.push(...await backend.listInstances({ sessionId: request.sessionId }, this.context(deadlineAtMs, signal)));
      } catch (error) {
        const failure = asCaptureError(error);
        failures.push(failure);
        errors.push(failure.message);
      }
    }
    const eligible = candidates.filter((instance) => {
      if (request.instanceId && instance.instanceId !== request.instanceId) return false;
      if (request.sessionId && instance.backend === "runtime" && instance.sessionId !== request.sessionId) return false;
      if (!request.sessionId && instance.backend !== "workbench") return false;
      return isCompatible(instance, request);
    });
    if (eligible.length !== 1) {
      if (request.instanceId && eligible.length === 0) {
        const selected = candidates.find((instance) => instance.instanceId === request.instanceId);
        const selectedWasObserved = selected !== undefined;
        // An explicit instance can be declared stale only after the relevant
        // inventories answered. If selection itself lost transport, absence
        // from the partial inventory is not evidence that the instance left.
        if (!selectedWasObserved && failures.length > 0) throw failures[0];
        if (selected && selected.stale !== true && selected.transportHealthy !== false &&
            (!request.sessionId || selected.backend !== "runtime" || selected.sessionId === request.sessionId)) {
          const requiredCapability = request.view.kind === "current"
            ? "render.capture"
            : selected.backend === "workbench" ? "camera.editor" : "camera.runtime";
          if (!selected.capabilities.includes(requiredCapability)) {
            throw new CaptureError(
              "CAPABILITY_UNAVAILABLE",
              `Selected observer cannot prove required capability: ${requiredCapability}`,
              { instanceId: selected.instanceId, requiredCapability }
            );
          }
        }
        throw new CaptureError("STALE_INSTANCE", "Selected observer instance is unavailable");
      }
      if (eligible.length > 1) throw new CaptureError("AMBIGUOUS_INSTANCE", "Multiple compatible observer instances are available", { instanceIds: eligible.map((entry) => entry.instanceId) });
      if (request.view.kind !== "current") {
        const capability = candidates.find((instance) => {
          if (instance.stale === true || instance.transportHealthy === false || !instance.capabilities.includes("render.capture")) return false;
          if (request.sessionId && instance.backend === "runtime" && instance.sessionId !== request.sessionId) return false;
          if (!request.sessionId && instance.backend !== "workbench") return false;
          const required = instance.backend === "workbench" ? "camera.editor" : "camera.runtime";
          return !instance.capabilities.includes(required);
        });
        if (capability) {
          const requiredCapability = capability.backend === "workbench" ? "camera.editor" : "camera.runtime";
          throw new CaptureError(
            "CAPABILITY_UNAVAILABLE",
            `No eligible observer can prove required capability: ${requiredCapability}`,
            { requiredCapability }
          );
        }
      }
      throw new CaptureError("NO_RENDER_ENDPOINT", errors[0] ?? "No compatible observer renderer is available");
    }
    return eligible[0];
  }

  private assertExpectedWorld(input: CaptureInput, instance: CaptureInstance): void {
    if (!sameWorldRevision(input.expectedWorldRevision, instance.worldRevision)) {
      throw new CaptureError("WORLD_CHANGED", "Selected observer no longer matches the expected world revision", { expectedWorldRevision: input.expectedWorldRevision, actualWorldRevision: instance.worldRevision });
    }
    if (instance.worldId === null && input.view.kind !== "current") throw new CaptureError("WORLD_UNAVAILABLE", "Camera views require an active world");
  }

  private context(deadlineAtMs: number, signal?: AbortSignal): BackendCallContext {
    if (deadlineAtMs <= this.now()) throw new CaptureError("CAPTURE_TIMEOUT", "Capture deadline has expired");
    return { deadlineAtMs, signal };
  }

  private async poll(record: CaptureJobRecord, signal?: AbortSignal): Promise<BackendJob> {
    let job = record.lastBackendJob;
    while (!isTerminalJob(job)) {
      const remaining = record.deadlineAtMs - this.now();
      if (remaining <= 0) {
        await this.cancelOnce(record).catch(() => undefined);
        throw new CaptureError("CAPTURE_TIMEOUT", "Observer capture exceeded its deadline", { job: publicJob(job) });
      }
      await this.sleep(Math.min(this.pollIntervalMs, remaining), signal);
      job = await this.refresh(this.store.getById(record.jobId)!, record.deadlineAtMs);
    }
    return job;
  }

  private async refresh(record: CaptureJobRecord, deadlineAtMs = this.operationDeadline()): Promise<BackendJob> {
    const backend = this.backends.get(record.ref.backend);
    if (!backend) throw new CaptureError("TRANSPORT_UNAVAILABLE", `Capture backend ${record.ref.backend} is unavailable`);
    const job = await backend.status(record.ref, this.context(deadlineAtMs));
    this.store.update(record.jobId, (stored) => {
      stored.lastBackendJob = { ...job, ref: { ...stored.ref, ...job.ref, jobId: stored.jobId } };
      stored.lastProjection = publicJob(stored.lastBackendJob);
    });
    return this.store.getById(record.jobId)!.lastBackendJob;
  }

  private async cancelOnce(record: CaptureJobRecord, deadlineAtMs = this.operationDeadline()): Promise<BackendJob> {
    if (record.cancelRequested) return record.lastBackendJob;
    this.store.update(record.jobId, (stored) => { stored.cancelRequested = true; });
    const backend = this.backends.get(record.ref.backend)!;
    try {
      const job = await backend.cancel(record.ref, this.context(deadlineAtMs));
      this.store.update(record.jobId, (stored) => {
        stored.lastBackendJob = { ...job, ref: { ...stored.ref, ...job.ref, jobId: stored.jobId } };
        stored.lastProjection = publicJob(stored.lastBackendJob);
        // A bounded cancellation attempt that still reports an active
        // restoration obligation must remain retryable. The backend command is
        // idempotent for the exact retained job binding.
        stored.cancelRequested = !hasRestorationObligation(stored.lastBackendJob);
      });
      await this.failRun(this.store.getById(record.jobId)!, new CaptureError("CANCELLED", "Capture was cancelled"));
      return this.store.getById(record.jobId)!.lastBackendJob;
    } catch (error) {
      this.store.update(record.jobId, (stored) => { stored.cancelRequested = false; });
      throw asCaptureError(error);
    }
  }

  private retainReleasedRunReceipt(
    jobId: string,
    backend: CaptureBackendKind,
    released: BackendReleaseResult
  ): void {
    const receipt = {
      ...released,
      backend,
      jobId,
      managedArtifactReleased: true,
    };
    this.store.update(jobId, (stored) => {
      stored.releaseReceipt = receipt;
      stored.runCompleted = true;
      stored.managedArtifactReleased = true;
      stored.pinned = false;
      stored.lastBackendJob = {
        ...stored.lastBackendJob,
        state: "released",
        cameraLeaseHeld: false,
        restorationConfirmed: released.restorationConfirmed !== false,
        managedArtifactAvailable: false,
        handlerRelease: released,
      };
      stored.lastProjection = publicJob(stored.lastBackendJob);
    });
  }

  private async completeIfNeeded(record: CaptureJobRecord, deadlineAtMs = this.operationDeadline()): Promise<void> {
    if (record.lastBackendJob.state !== "completed" || !record.runId || !record.captureLabel || record.runCompleted) return;
    // The backend can already have an imported artifact after restart; read is
    // intentionally delegated to the backend and remains idempotent there.
    const artifact = await this.readArtifact(record, deadlineAtMs);
    await this.completeArtifact(record, record.lastBackendJob, artifact);
  }

  private async completeArtifact(record: CaptureJobRecord, job: BackendJob, artifact: CaptureArtifact): Promise<void> {
    if (record.runId && record.captureLabel && this.runPort) {
      await this.runPort.complete({ runId: record.runId, captureLabel: record.captureLabel, ref: record.ref, artifact, job });
      this.store.update(record.jobId, (stored) => { stored.pinned = true; stored.runCompleted = true; });
      if (record.ref.backend === "workbench") {
        if (!record.lastBackendJob.handlerRelease) {
          const released = await this.backends.get("workbench")!.release(record.ref, this.context(Math.max(record.deadlineAtMs, this.now() + 1_000)));
          this.store.update(record.jobId, (stored) => { stored.lastBackendJob = { ...stored.lastBackendJob, handlerRelease: released }; stored.lastProjection = publicJob(stored.lastBackendJob); });
        }
      }
    }
    this.store.update(record.jobId, (stored) => { stored.lastBackendJob = { ...stored.lastBackendJob, artifact: artifact.metadata }; stored.lastProjection = publicJob(stored.lastBackendJob); });
  }

  private async failRun(record: CaptureJobRecord, error: CaptureError): Promise<void> {
    if (!record.runId || !record.captureLabel || !this.runPort) return;
    await this.runPort.fail({ runId: record.runId, captureLabel: record.captureLabel, ref: record.ref, code: error.code, message: error.message }).catch(() => undefined);
  }

  private terminalError(job: BackendJob): CaptureError {
    const code = canonicalPublicObserverErrorCode(
      job.terminalErrorCode,
      job.state === "cancelled" ? "CANCELLED" : "CAPTURE_REJECTED"
    );
    return new CaptureError(code, job.terminalMessage ?? job.message ?? `Capture ended in ${job.state}`, { job: publicJob(job) });
  }

  private requireJob(sessionId: string | undefined, jobId: string): CaptureJobRecord {
    const record = this.store.getById(jobId);
    if (!record) throw new CaptureError("JOB_NOT_FOUND", `Capture job ${jobId} is not retained`);
    if (record.ref.sessionId && sessionId && record.ref.sessionId !== sessionId) throw new CaptureError("SESSION_MISMATCH", "Capture job belongs to a different session");
    return record;
  }

  private async finishExisting(record: CaptureJobRecord, input: CaptureInput): Promise<CaptureResult> {
    if (input.asynchronous) return { asynchronous: true, job: record.lastProjection };
    const result = await this.read(record.ref.sessionId, record.jobId);
    return { asynchronous: false, ...result };
  }

  private validatedJobId(value: string): string {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw new CaptureError("INVALID_REQUEST", "Generated capture job ID is invalid");
    return value;
  }

  private operationDeadline(): number {
    return this.now() + this.defaultTimeoutMs;
  }

  private async readArtifact(record: CaptureJobRecord, deadlineAtMs: number, signal?: AbortSignal): Promise<CaptureArtifact> {
    try {
      return await this.backends.get(record.ref.backend)!.read(record.ref, this.context(deadlineAtMs, signal));
    } catch (error) {
      if (!record.runCompleted || !this.runPort?.readManagedArtifact || !["JOB_NOT_FOUND", "ARTIFACT_INCOMPLETE"].includes(errorCode(error))) throw error;
      return this.runPort.readManagedArtifact(record.ref, this.maxInlineImageBytes);
    }
  }

  private recoveredRevision(backend: CaptureBackendKind, capture: Record<string, unknown>): WorldRevision {
    if (isWorldRevision(capture.worldRevision)) return assertWorldRevision(capture.worldRevision);
    const worldId = typeof capture.worldId === "string" ? capture.worldId : null;
    if (backend === "workbench") return workbenchWorldRevision(worldId ?? "unavailable-workbench-world");
    const epoch = Number.isSafeInteger(capture.worldEpoch) && (capture.worldEpoch as number) >= 0 ? capture.worldEpoch as number : 0;
    return runtimeWorldRevision(worldId, epoch);
  }
}
