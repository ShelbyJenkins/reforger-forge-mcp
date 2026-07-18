import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  COMMAND_DELIVERY_LEASE_MS,
  PROTOCOL_VERSION,
  TERMINAL_JOB_STATES,
  captureRequestSchema,
  isRuntimeJobTransition,
  jobStatusSchema,
  parseProtocolMessage,
  runtimeCommandEnvelopeSchema,
  type ArtifactManifest,
  type CameraLeaseStatus,
  type CaptureRequest,
  type CaptureView,
  type JobStatus,
  type ObserverErrorCode,
  type ObserverJobState,
  type RuntimeCommandEnvelope,
} from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import { InstanceRegistry } from "./registry.js";
import { type Clock, SessionStore, systemClock } from "./sessions.js";

const TERMINAL = new Set<string>(TERMINAL_JOB_STATES);
const CAMERA_EXECUTION_STATES = new Set<ObserverJobState>(["positioning", "settling", "capturing", "awaitingArtifact"]);
const RESTORATION_STATES = new Set<ObserverJobState>(["restoring", "failed", "cancelled"]);
const CAPTURE_RATE_WINDOW_MS = 60_000;

function decimalWireValue(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
    throw new ObserverError("INVALID_REQUEST", "Runtime wire view contains an out-of-bounds number");
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  const fixed = normalized.toFixed(9).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function runtimeWireView(view: CaptureView): {
  position: string[];
  orientation: string[];
  target: string[];
  fov: string;
} {
  if (view.kind === "current") return { position: [], orientation: [], target: [], fov: "0" };
  return {
    position: view.position.map(decimalWireValue),
    orientation: view.kind === "pose" ? view.orientation.map(decimalWireValue) : [],
    target: view.kind === "lookAt" ? view.target.map(decimalWireValue) : [],
    fov: decimalWireValue(view.fov),
  };
}

export interface SubmitJobInput {
  sessionId: string;
  idempotencyKey: string;
  instanceId?: string;
  deadlineAt: string;
  view: CaptureView;
  settleFrames?: number;
  performancePolicy?: "evidence" | "instrumented" | "performance";
  expectedWorldId?: string | null;
  expectedWorldEpoch?: number;
}

export interface CommandDeliveryRecord {
  attempt: number;
  token: string;
  leaseExpiresAt: number;
  acknowledgedAt: number | null;
}

export interface CameraLeaseRecord {
  everHeld: boolean;
  held: boolean;
  leaseId: string | null;
  observerCameraId: string | number | null;
  restorationConfirmed: boolean;
}

export interface JobRecord {
  request: CaptureRequest;
  sessionId: string;
  selectedInstanceId: string;
  selectedInstanceNonce: string;
  worldId: string | null;
  worldEpoch: number;
  state: ObserverJobState;
  statusSequence: number;
  createdAt: number;
  updatedAt: number;
  cancellationRequestedAt: number | null;
  captureDelivery: CommandDeliveryRecord | null;
  cancellationDelivery: CommandDeliveryRecord | null;
  cameraLease: CameraLeaseRecord;
  /** Compatibility diagnostic derived only from explicit `cameraLease.held` evidence. */
  cameraWasAcquired: boolean;
  artifactAwaited: boolean;
  terminalErrorCode: ObserverErrorCode | null;
  terminalMessage: string | null;
  artifact: ArtifactManifest | null;
  artifactPath: string | null;
}

export interface ArtifactCompletionPreflight {
  record: JobRecord;
  alreadyCompleted: boolean;
}

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly pendingByInstance = new Map<string, string[]>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly registry: InstanceRegistry,
    private readonly clock: Clock = systemClock
  ) {}

  submit(input: SubmitJobInput): JobRecord {
    const session = this.sessions.get(input.sessionId);
    if (input.expectedWorldId !== undefined && input.expectedWorldId !== null &&
        (typeof input.expectedWorldId !== "string" || input.expectedWorldId.length < 1 || input.expectedWorldId.length > 512)) {
      throw new ObserverError("INVALID_REQUEST", "Expected world ID is invalid");
    }
    if (input.expectedWorldEpoch !== undefined &&
        (!Number.isSafeInteger(input.expectedWorldEpoch) || input.expectedWorldEpoch < 0)) {
      throw new ObserverError("INVALID_REQUEST", "Expected world epoch is invalid");
    }
    const idempotencyKey = `${input.sessionId}\0${input.idempotencyKey}`;
    const originalId = this.idempotency.get(idempotencyKey);
    if (originalId) return this.require(input.sessionId, originalId);
    if (input.performancePolicy === "performance") {
      throw new ObserverError("PERFORMANCE_POLICY_BLOCKED", "Performance capture requires an external measurement coordinator", 409);
    }

    const deadline = Date.parse(input.deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= this.clock.now()) {
      throw new ObserverError("CAPTURE_TIMEOUT", "Capture deadline has already expired", 408);
    }
    this.assertSessionCaptureLimits(session.limits, input);
    const recentCaptureCount = [...this.jobs.values()].filter((job) =>
      job.sessionId === input.sessionId && job.createdAt > this.clock.now() - CAPTURE_RATE_WINDOW_MS
    ).length;
    if (recentCaptureCount >= session.limits.maxCaptureRatePerMinute) {
      throw new ObserverError("CAPTURE_REJECTED", "Observer session capture rate limit was reached", 429);
    }
    const activeCount = [...this.jobs.values()].filter((job) => job.sessionId === input.sessionId && !TERMINAL.has(job.state)).length;
    if (activeCount >= session.limits.maxPendingJobs) {
      throw new ObserverError("CAPTURE_REJECTED", "Observer session job queue is full", 429);
    }

    const required = input.view.kind === "current"
      ? (["render.capture"] as const)
      : (["render.capture", "camera.runtime", "world.query"] as const);
    const instance = this.registry.select(input.sessionId, required, input.instanceId);
    if (input.expectedWorldId !== undefined && instance.worldId !== input.expectedWorldId) {
      throw new ObserverError("WORLD_CHANGED", "Selected runtime no longer matches the expected world ID", 409);
    }
    if (input.expectedWorldEpoch !== undefined && instance.worldEpoch !== input.expectedWorldEpoch) {
      throw new ObserverError("WORLD_CHANGED", "Selected runtime no longer matches the expected world epoch", 409);
    }
    if (instance.worldId === null && input.view.kind !== "current") {
      throw new ObserverError("WORLD_UNAVAILABLE", "Camera views require an active world", 409);
    }

    const jobId = `j-${randomUUID()}`;
    const request = captureRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      jobId,
      idempotencyKey: input.idempotencyKey,
      instanceId: instance.registration.instanceId,
      worldEpoch: instance.worldEpoch,
      deadlineAt: new Date(deadline).toISOString(),
      view: input.view,
      settleFrames: input.settleFrames ?? 0,
      performancePolicy: input.performancePolicy ?? "evidence",
    });
    const now = this.clock.now();
    const record: JobRecord = {
      request,
      sessionId: input.sessionId,
      selectedInstanceId: instance.registration.instanceId,
      selectedInstanceNonce: instance.registration.instanceNonce,
      worldId: instance.worldId,
      worldEpoch: instance.worldEpoch,
      state: "queued",
      statusSequence: -1,
      createdAt: now,
      updatedAt: now,
      cancellationRequestedAt: null,
      captureDelivery: null,
      cancellationDelivery: null,
      cameraLease: {
        everHeld: false,
        held: false,
        leaseId: null,
        observerCameraId: null,
        restorationConfirmed: false,
      },
      cameraWasAcquired: false,
      artifactAwaited: false,
      terminalErrorCode: null,
      terminalMessage: null,
      artifact: null,
      artifactPath: null,
    };
    this.jobs.set(jobId, record);
    this.idempotency.set(idempotencyKey, jobId);
    const queueKey = this.instanceKey(input.sessionId, record.selectedInstanceId);
    const queue = this.pendingByInstance.get(queueKey) ?? [];
    queue.push(jobId);
    this.pendingByInstance.set(queueKey, queue);
    return record;
  }

  nextCommand(sessionId: string, instanceId: string, instanceNonce: string): RuntimeCommandEnvelope | null {
    const instance = this.registry.require(sessionId, instanceId);
    if (instance.registration.instanceNonce !== instanceNonce) {
      throw new ObserverError("UNAUTHORIZED", "Runtime instance nonce is invalid", 401);
    }
    if (this.registry.isStale(instance)) throw new ObserverError("INSTANCE_STALE", "Runtime instance is stale", 409);

    const inFlight = [...this.jobs.values()].find((record) =>
      record.sessionId === sessionId &&
      record.selectedInstanceId === instanceId &&
      record.state !== "queued" &&
      !TERMINAL.has(record.state)
    );
    const reportedJobs = new Set([instance.activeJobId, instance.cameraLeaseJobId].filter((value): value is string => value !== null));
    if (reportedJobs.size > 0 && (!inFlight || [...reportedJobs].some((jobId) => jobId !== inFlight.request.jobId))) {
      return null;
    }
    if (inFlight) {
      if (inFlight.cancellationRequestedAt !== null &&
        (!inFlight.cancellationDelivery || inFlight.cancellationDelivery.acknowledgedAt === null)) {
        return this.commandEnvelope(inFlight, "cancel");
      }
      if (inFlight.state === "dispatched" && inFlight.captureDelivery?.acknowledgedAt === null) {
        return this.commandEnvelope(inFlight, "capture");
      }
      return null;
    }
    if (reportedJobs.size > 0) return null;

    const queue = this.pendingByInstance.get(this.instanceKey(sessionId, instanceId)) ?? [];
    for (const jobId of queue) {
      const record = this.require(sessionId, jobId);
      if (record.state !== "queued") continue;
      if (record.cancellationRequestedAt !== null) {
        this.finish(record, "cancelled", "CANCELLED", "Capture was cancelled before delivery");
        continue;
      }
      if (Date.parse(record.request.deadlineAt) <= this.clock.now()) {
        this.finish(record, "failed", "CAPTURE_TIMEOUT", "Capture deadline expired before delivery");
        continue;
      }
      record.state = "dispatched";
      record.updatedAt = this.clock.now();
      return this.commandEnvelope(record, "capture");
    }
    return null;
  }

  update(input: unknown, token: string): JobRecord {
    const parsed = parseProtocolMessage(jobStatusSchema, input);
    if (!parsed.success) throw new ObserverError(parsed.error.code, parsed.error.message);
    const status = parsed.data;
    this.sessions.authorize(status.sessionId, token);
    const record = this.require(status.sessionId, status.jobId);
    if (record.selectedInstanceId !== status.instanceId || record.selectedInstanceNonce !== status.instanceNonce) {
      throw new ObserverError("UNAUTHORIZED", "Job status does not match its selected runtime", 401);
    }
    if (TERMINAL.has(record.state)) throw new ObserverError("INVALID_REQUEST", "Terminal job state cannot be rewritten", 409);
    if (status.sequence <= record.statusSequence) {
      throw new ObserverError("INVALID_REQUEST", "Job status sequence is stale or duplicated", 409);
    }
    if (status.state === "completed") {
      throw new ObserverError("ARTIFACT_INCOMPLETE", "Runtime cannot complete a job before host artifact validation", 409);
    }
    if (!isRuntimeJobTransition(record.state, status.state)) {
      throw new ObserverError("INVALID_REQUEST", `Illegal observer job transition: ${record.state} -> ${status.state}`, 409);
    }
    if (!status.cameraLease) {
      throw new ObserverError("INVALID_REQUEST", "Job status requires explicit cameraLease evidence", 409);
    }

    const restorationUnconfirmed = status.state === "failed" && status.errorCode === "RESTORATION_UNCONFIRMED";
    if (restorationUnconfirmed && (record.state !== "restoring" || !record.cameraLease.everHeld)) {
      throw new ObserverError("INVALID_REQUEST", "RESTORATION_UNCONFIRMED requires a recorded camera lease and restoring state", 409);
    }
    const cameraLease = this.validateCameraLeaseEvidence(record, status.cameraLease, status.state, restorationUnconfirmed);
    if (status.worldEpoch !== record.worldEpoch || status.worldId !== record.worldId) {
      record.cameraLease = cameraLease;
      record.cameraWasAcquired = cameraLease.everHeld;
      if (cameraLease.everHeld && !cameraLease.restorationConfirmed) {
        // Preserve the validated execution phase so a subsequent explicit
        // restoration report remains reachable even though the world changed.
        record.state = status.state;
        record.statusSequence = status.sequence;
        record.updatedAt = this.clock.now();
      }
      this.failWorldChange(record);
      throw new ObserverError("WORLD_CHANGED", "Runtime world identity changed during capture", 409);
    }
    if ((status.state === "failed" || status.state === "cancelled") && cameraLease.everHeld &&
      (cameraLease.held || !cameraLease.restorationConfirmed) && !restorationUnconfirmed) {
      throw new ObserverError("CAMERA_BUSY", "A job that held a camera lease must explicitly confirm restoration before becoming terminal", 409);
    }

    this.acknowledgeDelivery(record, status);
    record.cameraLease = cameraLease;
    record.cameraWasAcquired = cameraLease.everHeld;
    record.state = status.state;
    record.statusSequence = status.sequence;
    record.updatedAt = this.clock.now();
    if (status.state === "awaitingArtifact") record.artifactAwaited = true;
    if (status.state === "failed") {
      record.terminalErrorCode = status.errorCode ?? "INTERNAL_ERROR";
      record.terminalMessage = status.message ?? "Runtime capture failed";
    } else if (status.state === "cancelled") {
      record.terminalErrorCode = "CANCELLED";
      record.terminalMessage = status.message ?? "Capture cancelled";
    }
    return record;
  }

  cancel(sessionId: string, jobId: string): JobRecord {
    const record = this.require(sessionId, jobId);
    if (TERMINAL.has(record.state)) return record;
    record.cancellationRequestedAt ??= this.clock.now();
    record.updatedAt = this.clock.now();
    if (record.state === "queued") {
      this.finish(record, "cancelled", "CANCELLED", "Capture cancelled before dispatch");
    }
    return record;
  }

  preflightArtifact(sessionId: string, jobId: string, manifest: ArtifactManifest): ArtifactCompletionPreflight {
    const record = this.require(sessionId, jobId);
    this.assertArtifactIdentity(record, manifest);
    if (record.state === "completed") {
      if (record.artifact && isDeepStrictEqual(record.artifact, manifest)) {
        return { record, alreadyCompleted: true };
      }
      throw new ObserverError("ARTIFACT_INVALID", "Completed job already has different artifact identity or metadata", 409);
    }
    if (TERMINAL.has(record.state)) throw new ObserverError("INVALID_REQUEST", "Terminal job cannot accept an artifact", 409);
    if (!record.artifactAwaited) {
      throw new ObserverError("ARTIFACT_INCOMPLETE", "Runtime has not reported awaitingArtifact for this job", 409);
    }
    if (record.request.view.kind === "current") {
      if (record.state !== "awaitingArtifact") {
        throw new ObserverError("ARTIFACT_INCOMPLETE", "Current-view artifacts are accepted only while awaitingArtifact", 409);
      }
    } else if (record.cameraLease.held || !record.cameraLease.restorationConfirmed || record.state !== "restoring") {
      throw new ObserverError("CAMERA_BUSY", "Camera artifact cannot be accepted until exact restoration is confirmed", 409);
    }
    return { record, alreadyCompleted: false };
  }

  completeArtifact(sessionId: string, jobId: string, manifest: ArtifactManifest, artifactPath: string): JobRecord {
    const preflight = this.preflightArtifact(sessionId, jobId, manifest);
    const record = preflight.record;
    if (preflight.alreadyCompleted) {
      if (record.artifactPath !== artifactPath) {
        throw new ObserverError("ARTIFACT_INVALID", "Completed artifact retry used a different retained path", 409);
      }
      return record;
    }
    record.artifact = manifest;
    record.artifactPath = artifactPath;
    record.state = "completed";
    record.updatedAt = this.clock.now();
    return record;
  }

  sweepDeadlines(): string[] {
    const failed: string[] = [];
    for (const record of this.jobs.values()) {
      if (TERMINAL.has(record.state) || Date.parse(record.request.deadlineAt) > this.clock.now()) continue;
      if (record.state !== "queued" && (!record.artifactAwaited ||
        (record.cameraLease.everHeld && !record.cameraLease.restorationConfirmed))) {
        record.cancellationRequestedAt ??= this.clock.now();
        record.updatedAt = this.clock.now();
        continue;
      }
      this.finish(record, "failed", "CAPTURE_TIMEOUT", "Capture deadline expired");
      failed.push(record.request.jobId);
    }
    return failed;
  }

  require(sessionId: string, jobId: string): JobRecord {
    const record = this.jobs.get(jobId);
    if (!record || record.sessionId !== sessionId) {
      throw new ObserverError("INVALID_REQUEST", "Observer job was not found", 404);
    }
    return record;
  }

  diagnostics(sessionId?: string): Array<Record<string, unknown>> {
    return [...this.jobs.values()].filter((record) => !sessionId || record.sessionId === sessionId).map((record) => ({
      jobId: record.request.jobId,
      sessionId: record.sessionId,
      instanceId: record.selectedInstanceId,
      state: record.state,
      worldId: record.worldId,
      worldEpoch: record.worldEpoch,
      deadlineAt: record.request.deadlineAt,
      cancellationRequested: record.cancellationRequestedAt !== null,
      terminalErrorCode: record.terminalErrorCode,
      artifactPath: record.artifactPath,
      captureDeliveryAttempt: record.captureDelivery?.attempt ?? 0,
      captureDeliveryAcknowledged: record.captureDelivery?.acknowledgedAt !== null && record.captureDelivery !== null,
      cancellationDeliveryAttempt: record.cancellationDelivery?.attempt ?? 0,
      cancellationDeliveryAcknowledged: record.cancellationDelivery?.acknowledgedAt !== null && record.cancellationDelivery !== null,
      cameraLease: { ...record.cameraLease },
      artifactAwaited: record.artifactAwaited,
    }));
  }

  private commandEnvelope(record: JobRecord, commandKind: "capture" | "cancel"): RuntimeCommandEnvelope {
    const deliveryKey = commandKind === "capture" ? "captureDelivery" : "cancellationDelivery";
    let delivery = record[deliveryKey];
    if (!delivery) {
      delivery = {
        attempt: 1,
        token: randomUUID(),
        leaseExpiresAt: this.clock.now() + COMMAND_DELIVERY_LEASE_MS,
        acknowledgedAt: null,
      };
      record[deliveryKey] = delivery;
      record.updatedAt = this.clock.now();
    } else if (delivery.acknowledgedAt === null && delivery.leaseExpiresAt <= this.clock.now()) {
      // Keep the acknowledgement identity stable across delivery retries. A
      // runtime may have received the command and be retrying an accepted
      // status after only its HTTP response was lost; rotating the token would
      // make that valid acknowledgement permanently stale.
      delivery.attempt += 1;
      delivery.leaseExpiresAt = this.clock.now() + COMMAND_DELIVERY_LEASE_MS;
      record.updatedAt = this.clock.now();
    }
    return runtimeCommandEnvelopeSchema.parse({
      ...record.request,
      commandKind,
      deliveryAttempt: delivery.attempt,
      deliveryToken: delivery.token,
      deliveryLeaseExpiresAt: new Date(delivery.leaseExpiresAt).toISOString(),
      wireView: runtimeWireView(record.request.view),
      ...(commandKind === "cancel" && record.cancellationRequestedAt !== null
        ? { cancellationRequestedAt: new Date(record.cancellationRequestedAt).toISOString() }
        : {}),
    });
  }

  private acknowledgeDelivery(record: JobRecord, status: JobStatus): void {
    const capture = record.captureDelivery;
    const cancellation = record.cancellationDelivery;
    if (status.state === "accepted") {
      if (!capture || status.deliveryToken !== capture.token) {
        throw new ObserverError("INVALID_REQUEST", "Accepted status does not acknowledge the active capture delivery token", 409);
      }
      capture.acknowledgedAt ??= this.clock.now();
      return;
    }
    if (record.state === "dispatched") {
      const expected = cancellation ?? capture;
      if (!expected || status.deliveryToken !== expected.token) {
        throw new ObserverError("INVALID_REQUEST", "Dispatch-terminal status does not acknowledge the active delivery token", 409);
      }
      expected.acknowledgedAt ??= this.clock.now();
      return;
    }
    if (status.deliveryToken !== undefined) {
      if (cancellation && status.deliveryToken === cancellation.token) {
        cancellation.acknowledgedAt ??= this.clock.now();
      } else if (!capture || status.deliveryToken !== capture.token) {
        throw new ObserverError("INVALID_REQUEST", "Job status contains an unknown delivery token", 409);
      }
    }
  }

  private validateCameraLeaseEvidence(
    record: JobRecord,
    evidence: CameraLeaseStatus,
    nextState: ObserverJobState,
    allowUnconfirmedTerminal = false
  ): CameraLeaseRecord {
    const next: CameraLeaseRecord = { ...record.cameraLease };
    if (evidence.held) {
      if (record.request.view.kind === "current") {
        throw new ObserverError("CAMERA_BUSY", "Current-view capture must not acquire an observer camera lease", 409);
      }
      if (next.restorationConfirmed) {
        throw new ObserverError("CAMERA_BUSY", "A restored camera lease cannot be reacquired by the same job", 409);
      }
      if (!next.everHeld && nextState !== "acquiringCamera") {
        throw new ObserverError("INVALID_REQUEST", "Initial camera ownership must be reported while acquiringCamera", 409);
      }
      if (next.everHeld && (next.leaseId !== evidence.leaseId || next.observerCameraId !== evidence.observerCameraId)) {
        throw new ObserverError("CAMERA_BUSY", "Runtime changed camera ownership identity during a job", 409);
      }
      next.everHeld = true;
      next.held = true;
      next.leaseId = evidence.leaseId;
      next.observerCameraId = evidence.observerCameraId;
    } else {
      if (evidence.restorationConfirmed) {
        if (!next.everHeld) {
          throw new ObserverError("INVALID_REQUEST", "Runtime cannot confirm restoration for a lease the job never held", 409);
        }
        if (!RESTORATION_STATES.has(nextState)) {
          throw new ObserverError("INVALID_REQUEST", "Camera restoration may be confirmed only during restoration or terminal reporting", 409);
        }
        next.held = false;
        next.restorationConfirmed = true;
      } else if (next.everHeld) {
        if (nextState !== "restoring" && !allowUnconfirmedTerminal) {
          throw new ObserverError("CAMERA_BUSY", "Dropping a held lease without restoration confirmation requires restoring state", 409);
        }
        next.held = false;
      }
    }

    if (record.request.view.kind !== "current" && CAMERA_EXECUTION_STATES.has(nextState) && !next.held) {
      throw new ObserverError("CAMERA_BUSY", `${nextState} requires explicit matching camera lease evidence`, 409);
    }
    return next;
  }

  private assertSessionCaptureLimits(limits: ReturnType<SessionStore["get"]>["limits"], input: SubmitJobInput): void {
    const settleFrames = input.settleFrames ?? 0;
    if (!Number.isInteger(settleFrames) || settleFrames < 0 || settleFrames > limits.maxSettleFrames) {
      throw new ObserverError("CAPTURE_REJECTED", "Requested settle frames exceed the observer session limit", 400);
    }
    if (input.view.kind !== "current" && (input.view.fov < limits.minFov || input.view.fov > limits.maxFov)) {
      throw new ObserverError("CAPTURE_REJECTED", "Requested FOV is outside the observer session limits", 400);
    }
    if (input.view.kind === "pose") {
      this.assertCaptureDistance(input.view.position, limits.maxCaptureDistance);
    } else if (input.view.kind === "lookAt") {
      this.assertCaptureDistance(input.view.position, limits.maxCaptureDistance);
      this.assertCaptureDistance(input.view.target, limits.maxCaptureDistance);
      this.assertCaptureDistance([
        input.view.target[0] - input.view.position[0],
        input.view.target[1] - input.view.position[1],
        input.view.target[2] - input.view.position[2],
      ], limits.maxCaptureDistance);
    }
  }

  private assertCaptureDistance(vector: readonly [number, number, number], maxCaptureDistance: number): void {
    if (Math.hypot(...vector) > maxCaptureDistance) {
      throw new ObserverError("CAPTURE_REJECTED", "Requested camera coordinates exceed the maximum capture distance", 400);
    }
  }

  private assertArtifactIdentity(record: JobRecord, manifest: ArtifactManifest): void {
    if (manifest.sessionId !== record.sessionId || manifest.jobId !== record.request.jobId ||
      manifest.instanceId !== record.selectedInstanceId || manifest.instanceNonce !== record.selectedInstanceNonce) {
      throw new ObserverError("ARTIFACT_INVALID", "Artifact identity does not match the observer job", 409);
    }
    if (manifest.worldId !== record.worldId || manifest.worldEpoch !== record.worldEpoch) {
      throw new ObserverError("WORLD_CHANGED", "Artifact world identity does not match the observer job", 409);
    }
    const expectedBase = `${record.request.jobId}.`;
    if (!manifest.relativeScreenshotFilename.startsWith(expectedBase)) {
      throw new ObserverError("ARTIFACT_INVALID", "Artifact filename is not bound to the observer job", 409);
    }
    if (manifest.requestedSettleFrames !== record.request.settleFrames ||
      manifest.actualSettleFrames < record.request.settleFrames) {
      throw new ObserverError("ARTIFACT_INVALID", "Artifact settle-frame evidence does not match the observer request", 409);
    }
    if (Date.parse(manifest.completedAt) > Date.parse(record.request.deadlineAt)) {
      throw new ObserverError("CAPTURE_TIMEOUT", "Artifact completed after the observer job deadline", 408);
    }
    if (record.request.view.kind !== "current" && manifest.actualFov === undefined) {
      throw new ObserverError("ARTIFACT_INVALID", "Camera artifact is missing actual FOV evidence", 409);
    }
    if (record.request.view.kind !== "current" && !manifest.actualCamera.matrix &&
      !(manifest.actualCamera.position && manifest.actualCamera.orientation)) {
      throw new ObserverError("ARTIFACT_INVALID", "Camera artifact is missing actual transform evidence", 409);
    }
  }

  private failWorldChange(record: JobRecord): void {
    if (record.cameraLease.everHeld && !record.cameraLease.restorationConfirmed) {
      record.cancellationRequestedAt ??= this.clock.now();
      record.updatedAt = this.clock.now();
      return;
    }
    this.finish(record, "failed", "WORLD_CHANGED", "World identity changed during capture");
  }

  private finish(record: JobRecord, state: "failed" | "cancelled", code: ObserverErrorCode, message: string): void {
    if (record.cameraLease.everHeld && (record.cameraLease.held || !record.cameraLease.restorationConfirmed)) {
      throw new ObserverError("CAMERA_BUSY", "Camera restoration must be explicitly confirmed before host termination", 409);
    }
    record.state = state;
    record.terminalErrorCode = code;
    record.terminalMessage = message;
    record.updatedAt = this.clock.now();
  }

  private instanceKey(sessionId: string, instanceId: string): string {
    return `${sessionId}\0${instanceId}`;
  }
}
