import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { boundedOption } from "#foundation/bounded-option";
import type { CanonicalImageOutputPolicy } from "#foundation/image-output";
import { BoundedJsonMap } from "#foundation/json-store";
import {
  COMMAND_DELIVERY_LEASE_MS,
  ERROR_CODES,
  JOB_STATES,
  PROTOCOL_VERSION,
  TERMINAL_JOB_STATES,
  captureRequestSchema,
  imageOutputPolicySchema,
  artifactManifestSchema,
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
import { ObserverError, observerOptionError } from "./errors.js";
import { InstanceRegistry } from "./registry.js";
import { type Clock, SessionStore, systemClock } from "./sessions.js";

const TERMINAL = new Set<string>(TERMINAL_JOB_STATES);
const CAMERA_EXECUTION_STATES = new Set<ObserverJobState>(["positioning", "settling", "capturing", "awaitingArtifact"]);
const RESTORATION_STATES = new Set<ObserverJobState>(["restoring", "failed", "cancelled"]);
const CAPTURE_RATE_WINDOW_MS = 60_000;
export const DEFAULT_IDEMPOTENCY_RECEIPT_RETENTION_MS = 10 * 60_000;
export const DEFAULT_TERMINAL_JOB_RETENTION_MS = 10 * 60_000;
export const DEFAULT_JOB_MAX_RECORDS = 16_384;
export const DEFAULT_JOB_MAX_ESTIMATED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_JOB_MAX_RECORD_ESTIMATED_BYTES = 512 * 1024;
/** Kept unused per live record so dispatch/cancel/terminal bookkeeping cannot deadlock cleanup. */
export const JOB_MUTATION_RESERVE_BYTES = 2 * 1024;

export interface JobStoreOptions {
  /** Retain a replay receipt this long after its canonical capture deadline. */
  idempotencyReceiptRetentionMs?: number;
  terminalJobRetentionMs?: number;
  /** Per-collection hard bound for jobs, receipts, and queued references. */
  maxRecords?: number;
  /** Aggregate in-memory JSON-size estimate across all JobStore collections. */
  maxEstimatedBytes?: number;
  /** Maximum JSON-size estimate for one mutable job record. */
  maxRecordEstimatedBytes?: number;
}

export interface NormalizedCaptureRequest {
  sessionId: string;
  instanceId: string | null;
  deadlineAt: string;
  deadlinePolicy:
    | { kind: "absolute"; deadlineAt: string }
    | { kind: "relative"; timeoutMs: number };
  view: CaptureView;
  settleFrames: number;
  performancePolicy: "evidence" | "instrumented" | "performance";
  image: CanonicalImageOutputPolicy;
  expectedWorld: { kind: "any" } | { kind: "exact"; worldId: string | null };
  expectedWorldEpoch: number | null;
}

interface IdempotencyReceipt {
  jobId: string;
  fingerprint: string;
  expiresAt: number;
}

interface ArtifactReleaseReceipt {
  sessionId: string;
  jobId: string;
  released: boolean;
  expiresAt: number;
}

function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new ObserverError("INVALID_REQUEST", "Capture view contains a non-finite number");
  }
  return Object.is(value, -0) ? 0 : value;
}

/** Canonical logical request; transport-only values (for example AbortSignal) are absent. */
export function normalizeCaptureRequest(input: SubmitJobInput): NormalizedCaptureRequest {
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline)) {
    throw new ObserverError("INVALID_REQUEST", "Capture deadline is invalid");
  }
  if (input.deadlinePolicyMs !== undefined &&
      (!Number.isSafeInteger(input.deadlinePolicyMs) || input.deadlinePolicyMs < 1_000 ||
        input.deadlinePolicyMs > 5 * 60_000)) {
    throw new ObserverError("INVALID_REQUEST", "Capture deadline policy is invalid");
  }
  const deadlineAt = new Date(deadline).toISOString();
  const view: CaptureView = input.view.kind === "current"
    ? { kind: "current" }
    : input.view.kind === "pose"
      ? {
          kind: "pose",
          position: input.view.position.map(canonicalNumber) as [number, number, number],
          orientation: input.view.orientation.map(canonicalNumber) as [number, number, number, number],
          fov: canonicalNumber(input.view.fov),
        }
      : {
          kind: "lookAt",
          position: input.view.position.map(canonicalNumber) as [number, number, number],
          target: input.view.target.map(canonicalNumber) as [number, number, number],
          fov: canonicalNumber(input.view.fov),
        };
  const parsedImage = imageOutputPolicySchema.parse(input.image ?? { format: "png" });
  const image = parsedImage.format === "png" || parsedImage.quality !== undefined
    ? parsedImage
    : { ...parsedImage, quality: 75 };
  return {
    sessionId: input.sessionId,
    instanceId: input.instanceId ?? null,
    deadlineAt,
    // Direct agent callers own an absolute deadline. The MCP coordinator owns
    // a relative timeout policy and necessarily derives a fresh wall-clock
    // deadline on retry; fingerprint the policy while retaining the original
    // admitted deadline in the job itself.
    deadlinePolicy: input.deadlinePolicyMs === undefined
      ? { kind: "absolute", deadlineAt }
      : { kind: "relative", timeoutMs: input.deadlinePolicyMs },
    view,
    settleFrames: input.settleFrames ?? 0,
    performancePolicy: input.performancePolicy ?? "evidence",
    image,
    expectedWorld: input.expectedWorldId === undefined
      ? { kind: "any" }
      : { kind: "exact", worldId: input.expectedWorldId },
    expectedWorldEpoch: input.expectedWorldEpoch ?? null,
  };
}

export function captureRequestFingerprint(input: SubmitJobInput): string {
  return normalizedCaptureRequestFingerprint(normalizeCaptureRequest(input));
}

function normalizedCaptureRequestFingerprint(input: NormalizedCaptureRequest): string {
  const { deadlineAt: _derivedDeadlineAt, ...logicalRequest } = input;
  return createHash("sha256")
    .update(JSON.stringify(logicalRequest), "utf8")
    .digest("hex");
}

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
  /** Host-assigned ID used for durable pre-binding; generated when omitted. */
  jobId?: string;
  instanceId?: string;
  deadlineAt: string;
  /** Host-private relative deadline policy used for semantic retry identity. */
  deadlinePolicyMs?: number;
  view: CaptureView;
  settleFrames?: number;
  performancePolicy?: "evidence" | "instrumented" | "performance";
  image?: CanonicalImageOutputPolicy;
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
  /** Host-only terminal evidence when the exact runtime process is vacant. */
  vacancyDisposition?: "exact_runtime_vacant";
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
  /** Equal-width retained disposition doubles as the bounded release tombstone. */
  artifactReleaseDisposition: "unseen" | "erased" | "absent";
}

const deliveryRecordSchema = z.object({
  attempt: z.number().int().positive(),
  token: z.string().min(1).max(256),
  leaseExpiresAt: z.number().int().nonnegative(),
  acknowledgedAt: z.number().int().nonnegative().nullable(),
});

const durableJobRecordSchema = z.object({
  request: captureRequestSchema,
  sessionId: z.string().min(1).max(96),
  selectedInstanceId: z.string().min(1).max(96),
  selectedInstanceNonce: z.string().min(32).max(256),
  worldId: z.string().min(1).max(512).nullable(),
  worldEpoch: z.number().int().nonnegative(),
  state: z.enum(JOB_STATES),
  statusSequence: z.number().int().min(-1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  cancellationRequestedAt: z.number().int().nonnegative().nullable(),
  captureDelivery: deliveryRecordSchema.nullable(),
  cancellationDelivery: deliveryRecordSchema.nullable(),
  cameraLease: z.object({
    everHeld: z.boolean(),
    held: z.boolean(),
    leaseId: z.string().min(1).max(96).nullable(),
    observerCameraId: z.union([z.string().min(1).max(96), z.number().int().nonnegative()]).nullable(),
    restorationConfirmed: z.boolean(),
    vacancyDisposition: z.literal("exact_runtime_vacant").optional(),
  }),
  cameraWasAcquired: z.boolean(),
  artifactAwaited: z.boolean(),
  terminalErrorCode: z.enum(ERROR_CODES).nullable(),
  terminalMessage: z.string().max(512).nullable(),
  artifact: artifactManifestSchema.nullable(),
  artifactPath: z.string().min(1).max(32_768).nullable(),
  artifactReleaseDisposition: z.enum(["unseen", "erased", "absent"]),
});

export type JobStoreDurableMutation =
  | { kind: "upsert"; sessionId: string; record: JobRecord }
  | { kind: "remove"; sessionId: string; jobId: string };

export interface ArtifactCompletionPreflight {
  record: JobRecord;
  alreadyCompleted: boolean;
}

export class JobStore {
  private readonly jobs: BoundedJsonMap<string, JobRecord>;
  private readonly idempotency: BoundedJsonMap<string, IdempotencyReceipt>;
  private readonly artifactReleaseReceipts: BoundedJsonMap<string, ArtifactReleaseReceipt>;
  private readonly pendingByInstance: BoundedJsonMap<string, string[]>;
  private readonly idempotencyReceiptRetentionMs: number;
  private readonly terminalJobRetentionMs: number;
  readonly maxRecords: number;
  readonly maxEstimatedBytes: number;
  readonly maxRecordEstimatedBytes: number;
  private durableMutationHook: ((mutation: JobStoreDurableMutation) => void) | null = null;

  constructor(
    private readonly sessions: SessionStore,
    private readonly registry: InstanceRegistry,
    private readonly clock: Clock = systemClock,
    options: JobStoreOptions = {}
  ) {
    this.idempotencyReceiptRetentionMs = boundedOption(
      options.idempotencyReceiptRetentionMs,
      DEFAULT_IDEMPOTENCY_RECEIPT_RETENTION_MS,
      1,
      24 * 60 * 60_000,
      "Idempotency receipt retention",
      observerOptionError
    );
    this.terminalJobRetentionMs = boundedOption(
      options.terminalJobRetentionMs,
      DEFAULT_TERMINAL_JOB_RETENTION_MS,
      1,
      24 * 60 * 60_000,
      "Terminal job retention",
      observerOptionError
    );
    this.maxRecords = boundedOption(
      options.maxRecords,
      DEFAULT_JOB_MAX_RECORDS,
      1,
      1_000_000,
      "Job store record limit",
      observerOptionError
    );
    this.maxEstimatedBytes = boundedOption(
      options.maxEstimatedBytes,
      DEFAULT_JOB_MAX_ESTIMATED_BYTES,
      1_024,
      1024 * 1024 * 1024,
      "Job store byte limit",
      observerOptionError
    );
    this.maxRecordEstimatedBytes = boundedOption(
      options.maxRecordEstimatedBytes,
      Math.min(DEFAULT_JOB_MAX_RECORD_ESTIMATED_BYTES, this.maxEstimatedBytes),
      512,
      this.maxEstimatedBytes,
      "Job record byte limit",
      observerOptionError
    );
    const capacityError = () => new ObserverError(
      "TRANSPORT_UNAVAILABLE",
      "Observer job store retention budget is exhausted",
      503
    );
    this.jobs = new BoundedJsonMap({
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      maxRecordEstimatedBytes: this.maxRecordEstimatedBytes,
      estimateBytes: (_jobId, record) => this.jobRecordBytes(record),
      capacityError,
    });
    this.idempotency = new BoundedJsonMap({
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (key, receipt) => Buffer.byteLength(JSON.stringify([key, receipt]), "utf8"),
      capacityError,
    });
    this.artifactReleaseReceipts = new BoundedJsonMap({
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (key, receipt) => Buffer.byteLength(JSON.stringify([key, receipt]), "utf8"),
      capacityError,
    });
    this.pendingByInstance = new BoundedJsonMap({
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (key, queue) => Buffer.byteLength(JSON.stringify([key, queue]), "utf8"),
      capacityError,
    });
  }

  setDurableMutationHook(hook: ((mutation: JobStoreDurableMutation) => void) | null): void {
    this.durableMutationHook = hook;
  }

  durableSnapshot(
    sessionId: string,
    mutation?: JobStoreDurableMutation
  ): JobRecord[] {
    const records = new Map(
      [...this.jobs.values()]
        .filter((record) => record.sessionId === sessionId)
        .map((record): [string, JobRecord] => [record.request.jobId, structuredClone(record)])
    );
    if (mutation?.sessionId === sessionId) {
      if (mutation.kind === "upsert") {
        records.set(mutation.record.request.jobId, structuredClone(mutation.record));
      } else {
        records.delete(mutation.jobId);
      }
    }
    return [...records.values()]
      .sort((left, right) => left.request.jobId.localeCompare(right.request.jobId))
      .map((record) => durableJobRecordSchema.parse(record) as JobRecord);
  }

  restoreDurable(sessionId: string, recordsInput: unknown): void {
    this.sessions.get(sessionId);
    const inputs = z.array(durableJobRecordSchema).max(this.maxRecords).parse(recordsInput);
    const parsed = inputs.map((record) => structuredClone(record) as JobRecord);
    const seen = new Set<string>();
    for (const record of parsed) {
      if (record.sessionId !== sessionId || seen.has(record.request.jobId)) {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Durable observer jobs do not belong to one exact session",
          409
        );
      }
      seen.add(record.request.jobId);
      if (this.jobRecordBytes(record) > this.maxRecordEstimatedBytes) {
        throw new ObserverError(
          "TRANSPORT_UNAVAILABLE",
          "Durable observer job exceeds its recovery budget",
          503
        );
      }
      const existing = this.jobs.get(record.request.jobId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Durable observer job conflicts with current in-memory state",
          409
        );
      }
    }
    const newRecords = parsed.filter((record) => !this.jobs.has(record.request.jobId));
    const projectedRecords = this.jobs.size + newRecords.length;
    const projectedBytes = this.estimatedStoreBytes() +
      newRecords.reduce((total, record) => total + this.jobRecordBytes(record), 0);
    if (projectedRecords > this.maxRecords ||
        projectedBytes + projectedRecords * JOB_MUTATION_RESERVE_BYTES > this.maxEstimatedBytes) {
      throw new ObserverError(
        "TRANSPORT_UNAVAILABLE",
        "Durable observer jobs exceed the recovery store budget",
        503
      );
    }
    for (const record of newRecords) {
      this.jobs.set(record.request.jobId, record);
      if (record.state === "queued") {
        const key = this.instanceKey(record.sessionId, record.selectedInstanceId);
        const queue = this.pendingByInstance.get(key) ?? [];
        if (!queue.includes(record.request.jobId)) queue.push(record.request.jobId);
        this.pendingByInstance.set(key, queue);
      }
    }
  }

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
    const normalized = normalizeCaptureRequest(input);
    const fingerprint = normalizedCaptureRequestFingerprint(normalized);
    const idempotencyKey = this.idempotencyLookupKey(input.sessionId, input.idempotencyKey);
    const retained = this.idempotency.get(idempotencyKey);
    if (retained && retained.expiresAt > this.clock.now()) {
      if (retained.fingerprint !== fingerprint) {
        throw new ObserverError(
          "IDEMPOTENCY_CONFLICT",
          "Observer capture idempotency key was reused with a different request",
          409
        );
      }
      return this.require(input.sessionId, retained.jobId);
    }
    if (retained) this.idempotency.delete(idempotencyKey);
    if (input.performancePolicy === "performance") {
      throw new ObserverError("PERFORMANCE_POLICY_BLOCKED", "Performance capture requires an external measurement coordinator", 409);
    }

    const deadline = Date.parse(normalized.deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= this.clock.now()) {
      throw new ObserverError("CAPTURE_TIMEOUT", "Capture deadline has already expired", 408);
    }
    if (deadline > session.expiresAt) {
      throw new ObserverError("CAPTURE_TIMEOUT", "Capture deadline exceeds the observer session lifetime", 408);
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

    const jobId = input.jobId ?? `j-${randomUUID()}`;
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(jobId)) {
      throw new ObserverError("INVALID_REQUEST", "Capture job ID is invalid");
    }
    const request = captureRequestSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      jobId,
      idempotencyKey: input.idempotencyKey,
      instanceId: instance.registration.instanceId,
      worldEpoch: instance.worldEpoch,
      deadlineAt: normalized.deadlineAt,
      view: normalized.view,
      settleFrames: normalized.settleFrames,
      performancePolicy: normalized.performancePolicy,
      image: normalized.image,
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
      artifactReleaseDisposition: "unseen",
    };
    const receipt: IdempotencyReceipt = {
      jobId,
      fingerprint,
      // A retry window begins at the semantic deadline and can never outlive
      // the owning session, so even an abandoned receipt has a hard bound.
      expiresAt: Math.min(session.expiresAt, deadline + this.idempotencyReceiptRetentionMs),
    };
    const queueKey = this.instanceKey(input.sessionId, record.selectedInstanceId);
    this.assertCapacity({ jobId, record, idempotencyKey, receipt, queueKey });
    this.durableMutationHook?.({ kind: "upsert", sessionId: record.sessionId, record });
    this.jobs.set(jobId, record);
    this.idempotency.set(idempotencyKey, receipt);
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
    // A terminal RESTORATION_UNCONFIRMED report is still authoritative camera
    // state. A later heartbeat with cleared job IDs cannot reopen this
    // instance to a queued successor until restoration or exact process
    // vacancy disposes the obligation.
    if ([...this.jobs.values()].some((record) =>
      record.sessionId === sessionId && record.selectedInstanceId === instanceId &&
      this.hasRestorationObligation(record))) return null;

    const queueKey = this.instanceKey(sessionId, instanceId);
    const queue = this.pendingByInstance.get(queueKey) ?? [];
    while (queue.length > 0) {
      const jobId = queue.shift()!;
      const record = this.jobs.get(jobId);
      if (!record || record.sessionId !== sessionId || record.state !== "queued") continue;
      if (record.cancellationRequestedAt !== null) {
        this.finish(record, "cancelled", "CANCELLED", "Capture was cancelled before delivery");
        continue;
      }
      if (Date.parse(record.request.deadlineAt) <= this.clock.now()) {
        this.finish(record, "failed", "CAPTURE_TIMEOUT", "Capture deadline expired before delivery");
        continue;
      }
      try {
        const command = this.commandEnvelope(record, "capture", "dispatched");
        if (queue.length === 0) this.pendingByInstance.delete(queueKey);
        return command;
      } catch (error) {
        // Dispatch admission is failure-atomic: restore the exact queue head if
        // the mutable record would exceed its retained-store budget.
        queue.unshift(jobId);
        this.pendingByInstance.set(queueKey, queue);
        throw error;
      }
    }
    this.pendingByInstance.delete(queueKey);
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
    const candidate = structuredClone(record);
    if (status.worldEpoch !== record.worldEpoch || status.worldId !== record.worldId) {
      candidate.cameraLease = cameraLease;
      candidate.cameraWasAcquired = cameraLease.everHeld;
      if (cameraLease.everHeld && !cameraLease.restorationConfirmed) {
        // Preserve the validated execution phase so a subsequent explicit
        // restoration report remains reachable even though the world changed.
        candidate.state = status.state;
        candidate.statusSequence = status.sequence;
        candidate.updatedAt = this.clock.now();
        candidate.cancellationRequestedAt ??= this.clock.now();
      } else {
        candidate.state = "failed";
        candidate.terminalErrorCode = "WORLD_CHANGED";
        candidate.terminalMessage = "World identity changed during capture";
        candidate.updatedAt = this.clock.now();
      }
      this.commitRecordMutation(record, candidate);
      if (TERMINAL.has(record.state)) this.removePendingReference(record);
      throw new ObserverError("WORLD_CHANGED", "Runtime world identity changed during capture", 409);
    }
    if ((status.state === "failed" || status.state === "cancelled") && cameraLease.everHeld &&
      (cameraLease.held || !cameraLease.restorationConfirmed) && !restorationUnconfirmed) {
      throw new ObserverError("CAMERA_BUSY", "A job that held a camera lease must explicitly confirm restoration before becoming terminal", 409);
    }

    this.acknowledgeDelivery(candidate, status);
    candidate.cameraLease = cameraLease;
    candidate.cameraWasAcquired = cameraLease.everHeld;
    candidate.state = status.state;
    candidate.statusSequence = status.sequence;
    candidate.updatedAt = this.clock.now();
    if (status.state === "awaitingArtifact") candidate.artifactAwaited = true;
    if (status.state === "failed") {
      candidate.terminalErrorCode = status.errorCode ?? "INTERNAL_ERROR";
      candidate.terminalMessage = status.message ?? "Runtime capture failed";
    } else if (status.state === "cancelled") {
      candidate.terminalErrorCode = "CANCELLED";
      candidate.terminalMessage = status.message ?? "Capture cancelled";
    }
    this.commitRecordMutation(record, candidate);
    if (TERMINAL.has(record.state)) this.removePendingReference(record);
    return record;
  }

  cancel(sessionId: string, jobId: string): JobRecord {
    const record = this.require(sessionId, jobId);
    if (TERMINAL.has(record.state)) return record;
    const candidate = structuredClone(record);
    candidate.cancellationRequestedAt ??= this.clock.now();
    candidate.updatedAt = this.clock.now();
    if (candidate.state === "queued") {
      candidate.state = "cancelled";
      candidate.terminalErrorCode = "CANCELLED";
      candidate.terminalMessage = "Capture cancelled before dispatch";
    }
    this.commitRecordMutation(record, candidate);
    if (TERMINAL.has(record.state)) this.removePendingReference(record);
    return record;
  }

  /**
   * Terminalize work that can no longer report restoration because the host
   * has independently proved the exact runtime process vacant. This is not a
   * restoration claim: the distinct disposition preserves what happened.
   */
  vacateSession(sessionId: string): string[] {
    const disposedJobIds: string[] = [];
    for (const record of this.jobs.values()) {
      if (record.sessionId !== sessionId ||
          record.cameraLease.vacancyDisposition === "exact_runtime_vacant") continue;
      const candidate = structuredClone(record);
      candidate.cameraLease.held = false;
      candidate.cameraLease.vacancyDisposition = "exact_runtime_vacant";
      candidate.updatedAt = this.clock.now();
      if (!TERMINAL.has(candidate.state)) {
        candidate.state = "failed";
        candidate.cancellationRequestedAt ??= candidate.updatedAt;
        candidate.terminalErrorCode = "INSTANCE_STALE";
        candidate.terminalMessage = "Exact observer runtime process exited before capture completion";
      }
      this.commitRecordMutation(record, candidate);
      this.removePendingReference(record);
      disposedJobIds.push(record.request.jobId);
    }
    return disposedJobIds;
  }

  preflightArtifact(sessionId: string, jobId: string, manifest: ArtifactManifest): ArtifactCompletionPreflight {
    const record = this.require(sessionId, jobId);
    if (record.artifactReleaseDisposition !== "unseen") {
      throw new ObserverError("JOB_RELEASED", "Observer job artifact has already been released", 410);
    }
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
    const candidate = structuredClone(record);
    candidate.artifact = manifest;
    candidate.artifactPath = artifactPath;
    candidate.state = "completed";
    candidate.updatedAt = this.clock.now();
    this.commitRecordMutation(record, candidate);
    return record;
  }

  artifactReleaseReceipt(sessionId: string, jobId: string): { released: boolean } | null {
    this.sweepArtifactReleaseReceipts(this.clock.now());
    const retained = this.artifactReleaseReceipts.get(this.artifactReleaseKey(sessionId, jobId));
    if (retained && retained.sessionId === sessionId && retained.jobId === jobId) {
      return { released: retained.released };
    }
    const record = this.jobs.get(jobId);
    if (!record || record.sessionId !== sessionId || record.artifactReleaseDisposition === "unseen") return null;
    return { released: record.artifactReleaseDisposition === "erased" };
  }

  preflightArtifactRelease(sessionId: string, jobId: string): { released: boolean } | null {
    const retained = this.artifactReleaseReceipt(sessionId, jobId);
    if (retained) return retained;
    const receipt: ArtifactReleaseReceipt = {
      sessionId,
      jobId,
      released: false,
      expiresAt: this.clock.now() + this.terminalJobRetentionMs,
    };
    const key = this.artifactReleaseKey(sessionId, jobId);
    if (this.artifactReleaseReceipts.size + 1 > this.maxRecords ||
        this.estimatedStoreBytes(undefined, [key, receipt]) +
          this.jobs.size * JOB_MUTATION_RESERVE_BYTES > this.maxEstimatedBytes) {
      throw new ObserverError(
        "TRANSPORT_UNAVAILABLE",
        "Observer artifact-release receipt budget is exhausted",
        503
      );
    }
    return null;
  }

  recordArtifactRelease(sessionId: string, jobId: string, released: boolean): void {
    if (this.preflightArtifactRelease(sessionId, jobId)) return;
    this.artifactReleaseReceipts.set(this.artifactReleaseKey(sessionId, jobId), {
      sessionId,
      jobId,
      released,
      expiresAt: this.clock.now() + this.terminalJobRetentionMs,
    });
    const record = this.jobs.get(jobId);
    if (!record || record.sessionId !== sessionId || record.artifactReleaseDisposition !== "unseen") return;
    const candidate = structuredClone(record);
    candidate.artifactReleaseDisposition = released ? "erased" : "absent";
    candidate.updatedAt = this.clock.now();
    this.commitRecordMutation(record, candidate);
  }

  sweepDeadlines(now = this.clock.now()): string[] {
    const failed: string[] = [];
    for (const record of this.jobs.values()) {
      if (TERMINAL.has(record.state) || Date.parse(record.request.deadlineAt) > now) continue;
      if (record.state !== "queued" && record.request.view.kind !== "current" && (!record.artifactAwaited ||
        (record.cameraLease.everHeld && !record.cameraLease.restorationConfirmed))) {
        const candidate = structuredClone(record);
        candidate.cancellationRequestedAt ??= now;
        candidate.updatedAt = now;
        this.commitRecordMutation(record, candidate);
        continue;
      }
      this.finish(record, "failed", "CAPTURE_TIMEOUT", "Capture deadline expired");
      failed.push(record.request.jobId);
    }
    return failed;
  }

  sweep(
    now = this.clock.now(),
    options: { pinnedJobIds?: ReadonlySet<string> } = {}
  ): { removedJobs: string[]; removedIdempotency: number; removedReleaseReceipts: number; removedQueueEntries: number } {
    this.sweepDeadlines(now);
    let removedIdempotency = 0;
    for (const [key, receipt] of this.idempotency) {
      if (receipt.expiresAt <= now) {
        this.idempotency.delete(key);
        removedIdempotency += 1;
      }
    }
    const removedReleaseReceipts = this.sweepArtifactReleaseReceipts(now);
    const retainedReceiptJobs = new Set([...this.idempotency.values()].map((receipt) => receipt.jobId));
    const removedJobs: string[] = [];
    for (const [jobId, record] of this.jobs) {
      if (!TERMINAL.has(record.state) || record.updatedAt + this.terminalJobRetentionMs > now ||
          retainedReceiptJobs.has(jobId) || options.pinnedJobIds?.has(jobId) ||
          this.hasRestorationObligation(record)) continue;
      this.durableMutationHook?.({ kind: "remove", sessionId: record.sessionId, jobId });
      this.jobs.delete(jobId);
      removedJobs.push(jobId);
    }
    let removedQueueEntries = 0;
    for (const [key, queue] of this.pendingByInstance) {
      const retained = queue.filter((jobId) => this.jobs.get(jobId)?.state === "queued");
      removedQueueEntries += queue.length - retained.length;
      if (retained.length === 0) this.pendingByInstance.delete(key);
      else this.pendingByInstance.set(key, retained);
    }
    return { removedJobs, removedIdempotency, removedReleaseReceipts, removedQueueEntries };
  }

  stats(): {
    jobs: number;
    terminalJobs: number;
    restorationObligations: number;
    releaseTombstones: number;
    idempotencyReceipts: number;
    pendingQueues: number;
    pendingQueueEntries: number;
    approximateBytes: number;
    maxRecords: number;
    maxEstimatedBytes: number;
    maxRecordEstimatedBytes: number;
    reservedMutationBytes: number;
  } {
    const pendingQueueEntries = [...this.pendingByInstance.values()]
      .reduce((total, queue) => total + queue.length, 0);
    const records = [...this.jobs.values()];
    const approximateBytes = this.estimatedStoreBytes();
    return {
      jobs: this.jobs.size,
      terminalJobs: records.filter((record) => TERMINAL.has(record.state)).length,
      restorationObligations: records.filter((record) => this.hasRestorationObligation(record)).length,
      releaseTombstones: this.artifactReleaseReceipts.size,
      idempotencyReceipts: this.idempotency.size,
      pendingQueues: this.pendingByInstance.size,
      pendingQueueEntries,
      approximateBytes,
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      maxRecordEstimatedBytes: this.maxRecordEstimatedBytes,
      reservedMutationBytes: this.jobs.size * JOB_MUTATION_RESERVE_BYTES,
    };
  }

  obligationJobIds(pinnedJobIds: ReadonlySet<string> = new Set()): Set<string> {
    return new Set([...this.jobs.values()]
      .filter((record) =>
        pinnedJobIds.has(record.request.jobId) ||
        !TERMINAL.has(record.state) ||
        this.hasRestorationObligation(record))
      .map((record) => record.request.jobId));
  }

  sessionPins(pinnedJobIds: ReadonlySet<string> = new Set()): Set<string> {
    const obligationJobIds = this.obligationJobIds(pinnedJobIds);
    return new Set([...this.jobs.values()]
      .filter((record) => obligationJobIds.has(record.request.jobId))
      .map((record) => record.sessionId));
  }

  require(sessionId: string, jobId: string): JobRecord {
    const record = this.jobs.get(jobId);
    if (!record || record.sessionId !== sessionId) {
      throw new ObserverError("JOB_NOT_FOUND", "Observer job was not found", 404);
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
      artifactReleaseDisposition: record.artifactReleaseDisposition,
      captureDeliveryAttempt: record.captureDelivery?.attempt ?? 0,
      captureDeliveryAcknowledged: record.captureDelivery?.acknowledgedAt !== null && record.captureDelivery !== null,
      cancellationDeliveryAttempt: record.cancellationDelivery?.attempt ?? 0,
      cancellationDeliveryAcknowledged: record.cancellationDelivery?.acknowledgedAt !== null && record.cancellationDelivery !== null,
      cameraLease: { ...record.cameraLease },
      artifactAwaited: record.artifactAwaited,
    }));
  }

  private commandEnvelope(
    record: JobRecord,
    commandKind: "capture" | "cancel",
    nextState?: ObserverJobState
  ): RuntimeCommandEnvelope {
    const candidate = structuredClone(record);
    if (nextState) candidate.state = nextState;
    const deliveryKey = commandKind === "capture" ? "captureDelivery" : "cancellationDelivery";
    let delivery = candidate[deliveryKey];
    if (!delivery) {
      delivery = {
        attempt: 1,
        token: randomUUID(),
        leaseExpiresAt: this.clock.now() + COMMAND_DELIVERY_LEASE_MS,
        acknowledgedAt: null,
      };
      candidate[deliveryKey] = delivery;
      candidate.updatedAt = this.clock.now();
    } else if (delivery.acknowledgedAt === null && delivery.leaseExpiresAt <= this.clock.now()) {
      // Keep the acknowledgement identity stable across delivery retries. A
      // runtime may have received the command and be retrying an accepted
      // status after only its HTTP response was lost; rotating the token would
      // make that valid acknowledgement permanently stale.
      delivery.attempt += 1;
      delivery.leaseExpiresAt = this.clock.now() + COMMAND_DELIVERY_LEASE_MS;
      candidate.updatedAt = this.clock.now();
    }
    const command = runtimeCommandEnvelopeSchema.parse({
      ...candidate.request,
      commandKind,
      deliveryAttempt: delivery.attempt,
      deliveryToken: delivery.token,
      deliveryLeaseExpiresAt: new Date(delivery.leaseExpiresAt).toISOString(),
      wireView: runtimeWireView(candidate.request.view),
      ...(commandKind === "cancel" && candidate.cancellationRequestedAt !== null
        ? { cancellationRequestedAt: new Date(candidate.cancellationRequestedAt).toISOString() }
        : {}),
    });
    this.commitRecordMutation(record, candidate);
    return command;
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

  private finish(record: JobRecord, state: "failed" | "cancelled", code: ObserverErrorCode, message: string): void {
    if (record.cameraLease.everHeld && (record.cameraLease.held || !record.cameraLease.restorationConfirmed)) {
      throw new ObserverError("CAMERA_BUSY", "Camera restoration must be explicitly confirmed before host termination", 409);
    }
    const candidate = structuredClone(record);
    candidate.state = state;
    candidate.terminalErrorCode = code;
    candidate.terminalMessage = message;
    candidate.updatedAt = this.clock.now();
    this.commitRecordMutation(record, candidate);
    this.removePendingReference(record);
  }

  private removePendingReference(record: JobRecord): void {
    const key = this.instanceKey(record.sessionId, record.selectedInstanceId);
    const queue = this.pendingByInstance.get(key);
    if (!queue) return;
    const retained = queue.filter((jobId) => jobId !== record.request.jobId);
    if (retained.length === 0) this.pendingByInstance.delete(key);
    else this.pendingByInstance.set(key, retained);
  }

  private idempotencyLookupKey(sessionId: string, idempotencyKey: string): string {
    return createHash("sha256").update(`${sessionId}\0${idempotencyKey}`, "utf8").digest("hex");
  }

  private assertCapacity(
    addition: {
      jobId: string;
      record: JobRecord;
      idempotencyKey: string;
      receipt: IdempotencyReceipt;
      queueKey: string;
    }
  ): void {
    const pendingQueueEntries = [...this.pendingByInstance.values()]
      .reduce((total, queue) => total + queue.length, 0);
    if (this.jobs.size + 1 > this.maxRecords ||
        this.idempotency.size + 1 > this.maxRecords ||
        pendingQueueEntries + 1 > this.maxRecords ||
        this.jobRecordBytes(addition.record) > this.maxRecordEstimatedBytes ||
        this.estimatedStoreBytes(addition) +
          (this.jobs.size + 1) * JOB_MUTATION_RESERVE_BYTES > this.maxEstimatedBytes) {
      throw new ObserverError(
        "TRANSPORT_UNAVAILABLE",
        "Observer job store retention budget is exhausted",
        503
      );
    }
  }

  private commitRecordMutation(record: JobRecord, candidate: JobRecord): void {
    const candidateBytes = this.jobRecordBytes(candidate);
    const projectedBytes = this.estimatedStoreBytes() - this.jobRecordBytes(record) + candidateBytes;
    if (candidateBytes > this.maxRecordEstimatedBytes ||
        projectedBytes + this.jobs.size * JOB_MUTATION_RESERVE_BYTES > this.maxEstimatedBytes) {
      throw new ObserverError(
        "TRANSPORT_UNAVAILABLE",
        "Observer job store retention budget is exhausted",
        503
      );
    }
    this.durableMutationHook?.({ kind: "upsert", sessionId: candidate.sessionId, record: candidate });
    Object.assign(record, candidate);
  }

  private jobRecordBytes(record: JobRecord): number {
    return Buffer.byteLength(JSON.stringify(record), "utf8");
  }

  private estimatedStoreBytes(addition?: {
    jobId: string;
    record: JobRecord;
    idempotencyKey: string;
    receipt: IdempotencyReceipt;
    queueKey: string;
  }, releaseAddition?: [string, ArtifactReleaseReceipt]): number {
    const jobs: Array<[string, JobRecord]> = [...this.jobs.entries()];
    const idempotency: Array<[string, IdempotencyReceipt]> = [...this.idempotency.entries()];
    const artifactReleaseReceipts: Array<[string, ArtifactReleaseReceipt]> = [
      ...this.artifactReleaseReceipts.entries(),
    ];
    const queues: Array<[string, string[]]> = [...this.pendingByInstance.entries()]
      .map(([key, values]): [string, string[]] => [key, [...values]]);
    if (addition) {
      jobs.push([addition.jobId, addition.record]);
      idempotency.push([addition.idempotencyKey, addition.receipt]);
      const queue = queues.find(([key]) => key === addition.queueKey);
      if (queue) queue[1].push(addition.jobId);
      else queues.push([addition.queueKey, [addition.jobId]]);
    }
    if (releaseAddition) artifactReleaseReceipts.push(releaseAddition);
    return Buffer.byteLength(JSON.stringify({ jobs, idempotency, artifactReleaseReceipts, queues }), "utf8");
  }

  private artifactReleaseKey(sessionId: string, jobId: string): string {
    return createHash("sha256").update(`${sessionId}\0${jobId}`, "utf8").digest("hex");
  }

  private sweepArtifactReleaseReceipts(now: number): number {
    let removed = 0;
    for (const [key, receipt] of this.artifactReleaseReceipts) {
      if (receipt.expiresAt > now) continue;
      this.artifactReleaseReceipts.delete(key);
      removed += 1;
    }
    return removed;
  }

  private hasRestorationObligation(record: JobRecord): boolean {
    return record.cameraLease.everHeld && !record.cameraLease.restorationConfirmed &&
      record.cameraLease.vacancyDisposition !== "exact_runtime_vacant";
  }

  private instanceKey(sessionId: string, instanceId: string): string {
    return `${sessionId}\0${instanceId}`;
  }
}
