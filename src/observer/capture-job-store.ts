import { CaptureError, type BackendJob, type BackendJobRef, type CanonicalCaptureRequest, type PublicCaptureJob } from "./capture-contract.js";

export interface CaptureJobRecord {
  readonly jobId: string;
  readonly idempotencyScope: string;
  readonly fingerprint: string;
  readonly request: CanonicalCaptureRequest;
  readonly ref: BackendJobRef;
  readonly deadlineAtMs: number;
  readonly createdAtMs: number;
  readonly retentionUntilMs: number;
  runId?: string;
  captureLabel?: string;
  lastBackendJob: BackendJob;
  lastProjection: PublicCaptureJob;
  cancelRequested: boolean;
  releaseReceipt?: Record<string, unknown>;
  runCompleted?: boolean;
  managedArtifactReleased?: boolean;
  estimatedBytes: number;
  pinned: boolean;
}

export interface CaptureJobStoreOptions {
  maxRecords?: number;
  maxRecordBytes?: number;
  maxBytes?: number;
  retentionMs?: number;
  clock?: () => number;
}

const DEFAULT_MAX_RECORDS = 16_384;
const DEFAULT_MAX_RECORD_BYTES = 512 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 10 * 60_000;

function estimate(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.MAX_SAFE_INTEGER; }
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return structuredClone(value);
}

/**
 * Bounded public receipt/index store.  Backend state remains in the backend;
 * this store only retains the public transaction and the exact ref needed for
 * safe recovery.
 */
export class CaptureJobStore {
  private readonly jobs = new Map<string, CaptureJobRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly backendRefs = new Map<string, string>();
  private readonly maxRecords: number;
  private readonly maxRecordBytes: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private bytes = 0;

  constructor(options: CaptureJobStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.now = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) throw new TypeError("maxRecords must be positive");
    if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1) throw new TypeError("maxRecordBytes must be positive");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < this.maxRecordBytes) throw new TypeError("maxBytes is too small");
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 0) throw new TypeError("retentionMs must be non-negative");
  }

  get size(): number { return this.jobs.size; }

  get(idempotencyScope: string): CaptureJobRecord | undefined {
    const jobId = this.idempotency.get(idempotencyScope);
    return jobId ? this.jobs.get(jobId) : undefined;
  }

  getById(jobId: string): CaptureJobRecord | undefined { return this.jobs.get(jobId); }

  getByBackendRef(ref: Pick<BackendJobRef, "backend" | "jobId">): CaptureJobRecord | undefined {
    return this.jobs.get(this.backendRefs.get(`${ref.backend}:${ref.jobId}`) ?? "");
  }

  entries(): CaptureJobRecord[] { return [...this.jobs.values()].map((record) => clone(record)); }

  add(record: Omit<CaptureJobRecord, "estimatedBytes" | "pinned"> & { pinned?: boolean }): CaptureJobRecord {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(record.jobId)) throw new CaptureError("INVALID_REQUEST", "Capture job ID is invalid");
    if (this.jobs.has(record.jobId)) throw new CaptureError("INVALID_REQUEST", "Capture job ID is already retained");
    if (this.jobs.size >= this.maxRecords) {
      this.sweep(this.now(), { force: true });
      if (this.jobs.size >= this.maxRecords) throw new CaptureError("CAPTURE_REJECTED", "Capture job receipt capacity is exhausted");
    }
    const candidate: CaptureJobRecord = {
      ...clone(record),
      lastBackendJob: clone(record.lastBackendJob),
      lastProjection: clone(record.lastProjection),
      estimatedBytes: 0,
      pinned: record.pinned === true,
    };
    candidate.estimatedBytes = estimate(candidate);
    if (candidate.estimatedBytes > this.maxRecordBytes) throw new CaptureError("CAPTURE_REJECTED", "Capture job receipt exceeds its record bound");
    if (this.bytes + candidate.estimatedBytes > this.maxBytes) {
      this.sweep(this.now(), { force: true });
      if (this.bytes + candidate.estimatedBytes > this.maxBytes) throw new CaptureError("CAPTURE_REJECTED", "Capture job receipt capacity is exhausted");
    }
    if (this.idempotency.has(candidate.idempotencyScope)) throw new CaptureError("INVALID_REQUEST", "Capture idempotency scope is already retained");
    const backendKey = `${candidate.ref.backend}:${candidate.ref.jobId}`;
    if (this.backendRefs.has(backendKey)) throw new CaptureError("INVALID_REQUEST", "Backend job reference is already retained");
    this.jobs.set(candidate.jobId, candidate);
    this.idempotency.set(candidate.idempotencyScope, candidate.jobId);
    this.backendRefs.set(backendKey, candidate.jobId);
    this.bytes += candidate.estimatedBytes;
    return clone(candidate);
  }

  update(jobId: string, update: (record: CaptureJobRecord) => void): CaptureJobRecord {
    const current = this.jobs.get(jobId);
    if (!current) throw new CaptureError("JOB_NOT_FOUND", `Capture job ${jobId} is not retained`);
    const before = current.estimatedBytes;
    const candidate = clone(current);
    update(candidate);
    candidate.estimatedBytes = estimate(candidate);
    if (candidate.estimatedBytes > this.maxRecordBytes || this.bytes - before + candidate.estimatedBytes > this.maxBytes) {
      throw new CaptureError("CAPTURE_REJECTED", "Capture job receipt capacity is exhausted");
    }
    this.jobs.set(jobId, candidate);
    this.bytes = this.bytes - before + candidate.estimatedBytes;
    return clone(candidate);
  }

  pin(jobId: string, pinned = true): CaptureJobRecord {
    return this.update(jobId, (record) => { record.pinned = pinned; });
  }

  release(jobId: string, receipt: Record<string, unknown>): CaptureJobRecord {
    return this.update(jobId, (record) => {
      record.releaseReceipt = clone(receipt);
      record.lastProjection = { ...record.lastProjection, state: "released" };
    });
  }

  /** Remove only unpinned records whose retention has expired. */
  sweep(now = this.now(), options: { force?: boolean } = {}): string[] {
    const removed: string[] = [];
    for (const [jobId, record] of this.jobs) {
      if (record.pinned) continue;
      if (!options.force && record.retentionUntilMs > now) continue;
      // Never orphan a backend job/handler reference. Even an exactly restored
      // terminal Workbench transaction keeps the helper's activeJobId until
      // backend release succeeds and its durable receipt is retained.
      if (!record.releaseReceipt) continue;
      // Force only evicts terminal records.
      const state = record.lastBackendJob.state;
      if (state !== "completed" && state !== "failed" && state !== "cancelled" && state !== "released") continue;
      this.jobs.delete(jobId);
      this.idempotency.delete(record.idempotencyScope);
      this.backendRefs.delete(`${record.ref.backend}:${record.ref.jobId}`);
      this.bytes -= record.estimatedBytes;
      removed.push(jobId);
    }
    return removed;
  }

  diagnostics(): Record<string, unknown> {
    return {
      records: this.jobs.size,
      bytes: this.bytes,
      maxRecords: this.maxRecords,
      maxRecordBytes: this.maxRecordBytes,
      maxBytes: this.maxBytes,
      pinnedRecords: [...this.jobs.values()].filter((record) => record.pinned).length,
      idempotencyReceipts: this.idempotency.size,
      backendReferences: this.backendRefs.size,
    };
  }
}
