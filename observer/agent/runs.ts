import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "#foundation/digest";
import { LmdbRecordStore } from "#foundation/lmdb-record-store";
import type { ArtifactStore, ManagedArtifactRef } from "./artifacts.js";
import {
  DisabledEvidenceBundleService,
  type EvidenceBundleFinalizeInput,
  type EvidenceBundleService,
  type EvidenceCaptureSnapshot,
  type EvidenceExportReceipt,
  type EvidenceRunExportSnapshot,
  normalizeEvidenceLabel,
} from "./evidence-bundle-service.js";
import { ObserverError } from "./errors.js";
import { assertIdentifier, assertManagedPath, ensureCanonicalDirectory } from "./paths.js";

export type { EvidenceBundleFinalizeInput as ObserverRunFinalizeInput, ObserverRunReview } from "./evidence-bundle-service.js";

const RUN_RECORD_VERSION = 1;
const MAX_RUN_RECORD_BYTES = 2 * 1024 * 1024;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const RUN_RECORD_FAMILY = "run";
const RUN_RECORD_KEY_PREFIX = ["observer", "runs"] as const;

export interface ObserverRunBeginInput {
  title: string;
  caseIds?: string[];
  sourceRevision?: string;
  procedureRevision?: string;
  idempotencyKey?: string;
}

export interface ReserveRunCaptureInput {
  runId: string;
  captureLabel: string;
  purpose?: string;
  idempotencyKey: string;
  jobId?: string;
  requestFingerprint?: string;
  sessionId?: string;
  requestedInstanceId?: string;
  expectedWorldRevision?: string;
  expectedWorldId?: string | null;
  expectedWorldEpoch?: number;
  requestedView: Record<string, unknown>;
  settleFrames?: number;
  performancePolicy: "evidence" | "instrumented";
  timeoutMs?: number;
  asynchronous?: boolean;
}

export interface BindRunCaptureInput {
  runId: string;
  captureLabel: string;
  backend: "runtime" | "workbench";
  sessionId?: string;
  jobId: string;
  instanceId: string;
  worldRevision?: string;
  worldId: string | null;
  worldEpoch: number;
}

interface RunCaptureRecord extends EvidenceCaptureSnapshot {
  purpose?: string;
  idempotencyHash: string;
  requestFingerprint: string;
  sessionId?: string;
  requestedInstanceId?: string;
  expectedWorldRevision?: string;
  expectedWorldId?: string | null;
  expectedWorldEpoch?: number;
  settleFrames?: number;
  timeoutMs?: number;
  asynchronous?: boolean;
  worldRevision?: string;
  terminalErrorCode?: string;
  terminalMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface ObserverRunRecord {
  version: typeof RUN_RECORD_VERSION;
  runId: string;
  state: "open" | "finalized" | "expired";
  title: string;
  caseIds: string[];
  sourceRevision?: string;
  procedureRevision?: string;
  idempotencyHash?: string;
  beginFingerprint: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  captures: RunCaptureRecord[];
  finalizeFingerprint?: string;
  exportReceipt?: EvidenceExportReceipt;
}

function boundedText(value: unknown, label: string, maximum: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ObserverError("INVALID_REQUEST", `${label} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

function validateRevision(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, 256);
}

function validateCaseIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ObserverError("INVALID_REQUEST", "caseIds must be an array of at most 64 identifiers");
  const result = value.map((item) => {
    if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(item)) throw new ObserverError("INVALID_REQUEST", "caseIds contains an invalid identifier");
    return item;
  });
  if (new Set(result).size !== result.length) throw new ObserverError("INVALID_REQUEST", "caseIds contains a duplicate identifier");
  return result;
}

function publicCapture(capture: RunCaptureRecord, missingArtifact: boolean): Record<string, unknown> {
  return {
    captureLabel: capture.label,
    purpose: capture.purpose ?? null,
    state: capture.state,
    backend: capture.backend ?? null,
    sessionId: capture.sessionId ?? null,
    jobId: capture.jobId ?? null,
    instanceId: capture.instanceId ?? null,
    worldRevision: capture.worldRevision ?? null,
    worldId: capture.worldId ?? null,
    worldEpoch: capture.worldEpoch ?? null,
    expectedWorldRevision: capture.expectedWorldRevision ?? null,
    expectedWorldId: capture.expectedWorldId ?? null,
    expectedWorldEpoch: capture.expectedWorldEpoch ?? null,
    artifactAvailable: capture.artifact !== undefined && !missingArtifact,
    missingArtifact,
    terminalErrorCode: capture.terminalErrorCode ?? null,
    terminalMessage: capture.terminalMessage ?? null,
    updatedAt: capture.updatedAt,
  };
}

/** Durable, backend-neutral run owner. Filesystem export is an optional port. */
export class ObserverRunStore {
  readonly runsRoot: string;
  private readonly exporter: EvidenceBundleService;
  private readonly exportEnabled: boolean;
  private readonly recordStorageRoot: string;
  private recordStoreInstance: LmdbRecordStore | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    runsRoot: string,
    private readonly artifacts: ArtifactStore,
    exporter?: EvidenceBundleService,
    recordStorageRoot = runsRoot,
  ) {
    this.runsRoot = ensureCanonicalDirectory(runsRoot);
    this.recordStorageRoot = ensureCanonicalDirectory(recordStorageRoot);
    this.exporter = exporter ?? new DisabledEvidenceBundleService();
    this.exportEnabled = exporter !== undefined;
  }

  begin(input: ObserverRunBeginInput): Record<string, unknown> {
    this.assertExportAdmission();
    const normalized = {
      title: boundedText(input.title, "Run title", 256)!,
      caseIds: validateCaseIds(input.caseIds),
      sourceRevision: validateRevision(input.sourceRevision, "Source revision"),
      procedureRevision: validateRevision(input.procedureRevision, "Procedure revision"),
    };
    const beginFingerprint = sha256Hex(JSON.stringify(normalized));
    const idempotencyHash = input.idempotencyKey === undefined ? undefined : sha256Hex(boundedText(input.idempotencyKey, "Idempotency key", 128)!);
    if (idempotencyHash) {
      for (const record of this.records()) {
        if (record.idempotencyHash !== idempotencyHash) continue;
        if (record.beginFingerprint !== beginFingerprint) throw new ObserverError("INVALID_REQUEST", "Run idempotency key was reused with different input", 409);
        return this.publicRun(record);
      }
    }
    const timestamp = new Date();
    const runId = `${timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(4).toString("hex")}`;
    const record: ObserverRunRecord = {
      version: RUN_RECORD_VERSION,
      runId,
      state: "open",
      ...normalized,
      ...(idempotencyHash ? { idempotencyHash } : {}),
      beginFingerprint,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      captures: [],
    };
    this.write(record, true);
    return this.publicRun(record);
  }

  reserveCapture(input: ReserveRunCaptureInput): Record<string, unknown> {
    this.assertExportAdmission();
    const record = this.requireOpen(input.runId);
    const label = normalizeEvidenceLabel(input.captureLabel);
    const idempotencyHash = sha256Hex(boundedText(input.idempotencyKey, "Idempotency key", 128)!);
    if (input.expectedWorldId !== undefined && input.expectedWorldId !== null) boundedText(input.expectedWorldId, "Expected world ID", 512);
    if (input.expectedWorldEpoch !== undefined && (!Number.isSafeInteger(input.expectedWorldEpoch) || input.expectedWorldEpoch < 0)) throw new ObserverError("INVALID_REQUEST", "Expected world epoch must be a non-negative integer");
    if (input.jobId !== undefined) assertIdentifier(input.jobId, "Job ID");
    const semantic = {
      captureLabel: label,
      purpose: boundedText(input.purpose, "Capture purpose", 512, false),
      sessionId: input.sessionId ?? null,
      requestedInstanceId: input.requestedInstanceId ?? null,
      expectedWorldRevision: input.expectedWorldRevision ?? null,
      expectedWorldId: input.expectedWorldId,
      expectedWorldEpoch: input.expectedWorldEpoch,
      requestedView: input.requestedView,
      settleFrames: input.settleFrames ?? 0,
      performancePolicy: input.performancePolicy,
      timeoutMs: input.timeoutMs ?? null,
      asynchronous: input.asynchronous === true,
    };
    const requestFingerprint = input.requestFingerprint ?? sha256Hex(JSON.stringify(semantic));
    if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) throw new ObserverError("INVALID_REQUEST", "Capture request fingerprint is invalid");
    const existing = record.captures.find((capture) => capture.label === label);
    if (existing) {
      if (existing.idempotencyHash !== idempotencyHash || existing.requestFingerprint !== requestFingerprint || (input.jobId && existing.jobId && input.jobId !== existing.jobId)) {
        throw new ObserverError("INVALID_REQUEST", `Capture label '${label}' is already reserved in this run`, 409);
      }
      return { runId: record.runId, capture: publicCapture(existing, this.missing(existing)) };
    }
    const now = new Date().toISOString();
    const capture: RunCaptureRecord = {
      label,
      ...(semantic.purpose ? { purpose: semantic.purpose } : {}),
      idempotencyHash,
      requestFingerprint,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.requestedInstanceId ? { requestedInstanceId: input.requestedInstanceId } : {}),
      ...(input.expectedWorldRevision ? { expectedWorldRevision: input.expectedWorldRevision } : {}),
      ...(input.expectedWorldId !== undefined ? { expectedWorldId: input.expectedWorldId } : {}),
      ...(input.expectedWorldEpoch !== undefined ? { expectedWorldEpoch: input.expectedWorldEpoch } : {}),
      requestedView: input.requestedView,
      settleFrames: input.settleFrames ?? 0,
      performancePolicy: input.performancePolicy,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      asynchronous: input.asynchronous === true,
      state: "reserved",
      createdAt: now,
      updatedAt: now,
    };
    record.captures.push(capture);
    record.updatedAt = now;
    this.write(record);
    return { runId: record.runId, capture: publicCapture(capture, false) };
  }

  bindCapture(input: BindRunCaptureInput): Record<string, unknown> {
    const record = this.requireOpen(input.runId);
    const capture = record.captures.find((item) => item.label === normalizeEvidenceLabel(input.captureLabel));
    if (!capture) throw new ObserverError("INVALID_REQUEST", "Run capture label is not reserved", 404);
    assertIdentifier(input.jobId, "Job ID");
    assertIdentifier(input.instanceId, "Instance ID");
    if (!Number.isSafeInteger(input.worldEpoch) || input.worldEpoch < 0) throw new ObserverError("INVALID_REQUEST", "World epoch is invalid");
    if (capture.jobId && capture.jobId !== input.jobId) throw new ObserverError("INVALID_REQUEST", "Reserved run capture is already bound to a different job", 409);
    if (capture.backend && capture.backend !== input.backend) throw new ObserverError("INVALID_REQUEST", "Reserved run capture is already bound to a different backend", 409);
    Object.assign(capture, {
      backend: input.backend,
      sessionId: input.sessionId,
      jobId: input.jobId,
      instanceId: input.instanceId,
      worldRevision: input.worldRevision,
      worldId: input.worldId,
      worldEpoch: input.worldEpoch,
      state: "submitted",
      updatedAt: new Date().toISOString(),
    });
    record.updatedAt = capture.updatedAt;
    this.write(record);
    return { runId: record.runId, capture: publicCapture(capture, this.missing(capture)) };
  }

  attachImportedArtifact(runId: string, captureLabel: string, ref: ManagedArtifactRef): Record<string, unknown> {
    const record = this.requireOpen(runId);
    const capture = record.captures.find((item) => item.label === normalizeEvidenceLabel(captureLabel));
    if (!capture || capture.backend !== "workbench" || capture.jobId !== ref.jobId) throw new ObserverError("INVALID_REQUEST", "Imported artifact does not match the run capture", 409);
    return this.attach(record, capture, ref);
  }

  completeCapture(runId: string, captureLabel: string): Record<string, unknown> {
    const record = this.requireOpen(runId);
    const capture = record.captures.find((item) => item.label === normalizeEvidenceLabel(captureLabel));
    if (!capture?.backend || !capture.jobId) throw new ObserverError("INVALID_REQUEST", "Run capture is not durably bound", 409);
    const ref = capture.backend === "runtime"
      ? this.artifacts.runtimeRef(capture.sessionId ?? "", capture.jobId)
      : this.artifacts.workbenchRef(capture.jobId);
    return this.attach(record, capture, ref);
  }

  failCapture(runId: string, captureLabel: string, code: string, message: string): Record<string, unknown> {
    const record = this.requireOpen(runId);
    const capture = record.captures.find((item) => item.label === normalizeEvidenceLabel(captureLabel));
    if (!capture) throw new ObserverError("INVALID_REQUEST", "Run capture label is not reserved", 404);
    if (capture.state === "completed" || capture.state === "released") return { runId, capture: publicCapture(capture, this.missing(capture)) };
    capture.state = "failed";
    capture.terminalErrorCode = boundedText(code, "Capture error code", 96)!;
    capture.terminalMessage = boundedText(message, "Capture error message", 512)!;
    capture.updatedAt = new Date().toISOString();
    record.updatedAt = capture.updatedAt;
    this.write(record);
    return { runId, capture: publicCapture(capture, false) };
  }

  status(runId: string): Record<string, unknown> {
    const record = this.require(runId);
    if (record.state === "finalized") this.verifyFinalized(record);
    let changed = false;
    for (const capture of record.captures) {
      if (capture.state === "completed" && this.missing(capture)) {
        capture.state = "failed";
        capture.terminalErrorCode = "ARTIFACT_INCOMPLETE";
        capture.terminalMessage = "The retained artifact is missing";
        capture.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) { record.updatedAt = new Date().toISOString(); this.write(record); }
    return this.publicRun(record);
  }

  finalize(input: EvidenceBundleFinalizeInput): Record<string, unknown> {
    if (!this.exportEnabled) this.assertExportAdmission();
    const record = this.require(input.runId);
    const prepared = this.exporter.prepare(input);
    if (record.state === "finalized") {
      if (record.finalizeFingerprint !== prepared.fingerprint || !record.exportReceipt) throw new ObserverError("INVALID_REQUEST", "Finalized run cannot be exported with different input", 409);
      this.exporter.verifyReceipt(this.snapshot(record, false), record.exportReceipt, prepared.fingerprint);
      return { run: this.publicRun(record), receipt: record.exportReceipt };
    }
    if (record.state !== "open") throw new ObserverError("INVALID_REQUEST", `Run is ${record.state} and cannot be finalized`, 409);
    const selected = prepared.includeCaptureLabels.map((label) => {
      const capture = record.captures.find((item) => item.label === label);
      if (!capture) throw new ObserverError("INVALID_REQUEST", `Run has no capture labeled '${label}'`, 404);
      if (capture.state !== "completed" || !capture.artifact) throw new ObserverError("ARTIFACT_INCOMPLETE", `Capture '${label}' has no retained completed artifact`, 409);
      return capture;
    });
    const pins = selected.filter((capture) => !this.missing(capture)).map((capture) => this.artifacts.pinForOperation(capture.artifact!));
    try {
      const receipt = this.exporter.export(this.snapshot(record, true), prepared);
      for (const pin of pins) pin.dispose();
      if (prepared.releaseManagedArtifacts) {
        for (const capture of record.captures) {
          if (!capture.artifact) continue;
          try { this.artifacts.releaseRef(capture.artifact); } catch (error) {
            if (!receipt.recovered) throw error;
          }
          capture.state = "released";
          capture.updatedAt = receipt.finalizedAt;
        }
      }
      record.state = "finalized";
      record.finalizedAt = receipt.finalizedAt;
      record.updatedAt = receipt.finalizedAt;
      record.finalizeFingerprint = prepared.fingerprint;
      record.exportReceipt = receipt;
      this.write(record);
      return { run: this.publicRun(record), receipt };
    } finally {
      for (const pin of pins) pin.dispose();
    }
  }

  discard(runId: string): Record<string, unknown> {
    const record = this.require(runId);
    if (record.state === "finalized") throw new ObserverError("INVALID_REQUEST", "Finalized run records are retained with their export receipt", 409);
    const released: string[] = [];
    for (const capture of record.captures) {
      if (!capture.artifact) continue;
      if (this.artifacts.releaseRef(capture.artifact).released) released.push(capture.label);
    }
    // The artifact directory is deliberately removed before the record. If a
    // process stops between these operations, the retained LMDB record makes a
    // later discard/retention pass resumable instead of losing the owner index.
    this.removeArtifactDirectory(runId);
    this.recordStore().remove(RUN_RECORD_FAMILY, this.recordId(runId));
    return { runId, discarded: true, releasedCaptureLabels: released };
  }

  protectedStoreKeys(): Set<string> {
    const result = new Set<string>();
    for (const record of this.records()) {
      if (record.state !== "open") continue;
      for (const capture of record.captures) {
        if (capture.artifact) result.add(capture.artifact.storeKey);
        else if (capture.backend === "runtime" && capture.sessionId && capture.jobId) result.add(`runtime/${capture.sessionId}/${capture.jobId}`);
      }
    }
    return result;
  }

  protectedRuntimeJobIds(): Set<string> {
    return new Set(this.records().filter((record) => record.state === "open").flatMap((record) => record.captures.filter((capture) => capture.backend === "runtime" && capture.jobId).map((capture) => capture.jobId!)));
  }
  protectedSessionIds(): Set<string> {
    return new Set(this.records().filter((record) => record.state === "open").flatMap((record) => record.captures.filter((capture) => capture.backend === "runtime" && capture.sessionId).map((capture) => capture.sessionId!)));
  }
  assertJobReleaseAllowed(backend: "runtime" | "workbench", jobId: string, sessionId?: string): void {
    for (const record of this.records()) {
      if (record.state !== "open") continue;
      const capture = record.captures.find((item) => item.backend === backend && item.jobId === jobId && (backend !== "runtime" || item.sessionId === sessionId));
      if (capture) throw new ObserverError("INVALID_REQUEST", `Capture '${capture.label}' is retained by open run ${record.runId}; finalize or discard the run instead`, 409);
    }
  }

  applyRetention(maxAgeMs: number): { expiredRuns: string[]; removedRunRecords: string[]; removedExportWork: string[] } {
    const now = Date.now();
    const expiredRuns: string[] = [];
    const removedRunRecords: string[] = [];
    for (const record of this.records()) {
      if (now - Date.parse(record.updatedAt) <= maxAgeMs) continue;
      if (record.state === "open") {
        let released = true;
        for (const capture of record.captures) {
          if (!capture.artifact) continue;
          try { this.artifacts.releaseRef(capture.artifact); } catch { released = false; }
        }
        if (!released) continue;
        record.state = "expired";
        record.updatedAt = new Date(now).toISOString();
        this.write(record);
        expiredRuns.push(record.runId);
      } else {
        // Keep the durable index until all co-located file cleanup is complete;
        // see discard() for why this ordering is intentional.
        this.removeArtifactDirectory(record.runId);
        this.recordStore().remove(RUN_RECORD_FAMILY, this.recordId(record.runId));
        removedRunRecords.push(record.runId);
      }
    }
    return { expiredRuns, removedRunRecords, removedExportWork: this.exporter.sweepWork(now, maxAgeMs) };
  }

  diagnostics(): Record<string, unknown> {
    const records = this.records();
    const usage = this.recordUsage();
    return {
      evidence: this.exporter.diagnostics(),
      runs: {
        total: records.length,
        open: records.filter((record) => record.state === "open").length,
        finalized: records.filter((record) => record.state === "finalized").length,
        expired: records.filter((record) => record.state === "expired").length,
        recordBytes: usage.bytes,
      },
    };
  }

  /** Exact serialized bytes owned by the private run-record namespace. */
  recordUsage(): { records: number; bytes: number } {
    const usage = this.recordStore().usage([RUN_RECORD_FAMILY]);
    return { records: usage.records, bytes: usage.bytes };
  }

  evidenceDiagnostics(): Record<string, unknown> { return this.exporter.diagnostics(); }

  /** Release the lazily opened run-record environment during agent shutdown. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const store = this.recordStoreInstance;
    this.closePromise = store ? store.close() : Promise.resolve();
    return this.closePromise;
  }

  /**
   * Test-only seam for records that used to be directly manipulated as
   * `{runsRoot}/{runId}/run.json`. Production callers use the public methods.
   */
  recordStoreForTest(): LmdbRecordStore {
    if (process.env.VITEST === undefined && process.env.NODE_ENV !== "test") {
      throw new Error("recordStoreForTest is a test-only seam and must not be called outside the test runner.");
    }
    return this.recordStore();
  }

  private attach(record: ObserverRunRecord, capture: RunCaptureRecord, ref: ManagedArtifactRef): Record<string, unknown> {
    if (capture.artifact && JSON.stringify(capture.artifact) !== JSON.stringify(ref)) throw new ObserverError("ARTIFACT_INVALID", "Run capture already references a different artifact", 409);
    capture.artifact = ref;
    capture.state = "completed";
    capture.updatedAt = new Date().toISOString();
    record.updatedAt = capture.updatedAt;
    this.write(record);
    return { runId: record.runId, capture: publicCapture(capture, false) };
  }

  private snapshot(record: ObserverRunRecord, includeImages: boolean): EvidenceRunExportSnapshot {
    return {
      run: {
        runId: record.runId,
        title: record.title,
        caseIds: [...record.caseIds],
        createdAt: record.createdAt,
        ...(record.sourceRevision ? { sourceRevision: record.sourceRevision } : {}),
        ...(record.procedureRevision ? { procedureRevision: record.procedureRevision } : {}),
      },
      captures: structuredClone(record.captures),
      artifacts: record.captures.filter((capture) => capture.artifact).map((capture) => {
        if (!includeImages || this.missing(capture)) return { captureLabel: capture.label };
        const artifact = this.artifacts.readRef(capture.artifact!);
        return { captureLabel: capture.label, image: artifact.image, metadata: artifact.metadata };
      }),
    };
  }

  private verifyFinalized(record: ObserverRunRecord): void {
    if (!record.exportReceipt || !record.finalizeFingerprint || !/^[a-f0-9]{64}$/.test(record.finalizeFingerprint)) throw new ObserverError("ARTIFACT_INVALID", "Finalized run receipt is invalid", 409);
    this.exporter.verifyReceipt(this.snapshot(record, false), record.exportReceipt, record.finalizeFingerprint);
  }

  private missing(capture: RunCaptureRecord): boolean {
    if (capture.state === "released") return false;
    return capture.artifact ? !this.artifacts.hasRef(capture.artifact) : false;
  }
  private publicRun(record: ObserverRunRecord): Record<string, unknown> {
    return {
      runId: record.runId,
      state: record.state,
      title: record.title,
      caseIds: record.caseIds,
      sourceRevision: record.sourceRevision ?? null,
      procedureRevision: record.procedureRevision ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finalizedAt: record.finalizedAt ?? null,
      captures: record.captures.map((capture) => publicCapture(capture, this.missing(capture))),
      warnings: record.captures.filter((capture) => capture.performancePolicy === "instrumented").map((capture) => `Capture '${capture.label}' used instrumented policy`),
      exportReceipt: record.exportReceipt ?? null,
    };
  }
  private assertExportAdmission(): void {
    if (!this.exportEnabled) throw new ObserverError("CAPABILITY_UNAVAILABLE", "Observer evidence export is unavailable because no evidence root is configured", 409);
  }
  private rootFor(runId: string): string {
    this.assertRunId(runId);
    const root = join(this.runsRoot, runId);
    assertManagedPath(this.runsRoot, root);
    return root;
  }
  private requireOpen(runId: string): ObserverRunRecord {
    const record = this.require(runId);
    if (record.state !== "open") throw new ObserverError("INVALID_REQUEST", `Run is ${record.state} and no longer accepts captures`, 409);
    return record;
  }
  private require(runId: string): ObserverRunRecord {
    this.assertRunId(runId);
    try {
      return this.readRecord(this.recordId(runId), runId);
    } catch (error) {
      if (error instanceof ObserverError) throw error;
      throw new ObserverError("INVALID_REQUEST", "Observer run record is invalid", 409);
    }
  }
  private records(): ObserverRunRecord[] {
    const result: ObserverRunRecord[] = [];
    for (const recordId of this.recordStore().listIds(RUN_RECORD_FAMILY)) {
      try { result.push(this.readRecord(recordId)); } catch { /* preserve malformed records */ }
    }
    return result;
  }
  private write(record: ObserverRunRecord, exclusive = false): void {
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    this.recordStore().putRaw(RUN_RECORD_FAMILY, this.recordId(record.runId), bytes, { exclusive });
  }
  private readRecord(recordId: string, expectedRunId?: string): ObserverRunRecord {
    const raw = this.recordStore().getRaw(RUN_RECORD_FAMILY, recordId);
    if (raw === null) {
      if (expectedRunId) throw new ObserverError("INVALID_REQUEST", "Observer run was not found", 404);
      throw new Error("missing run record");
    }
    if (raw.byteLength < 2 || raw.byteLength > MAX_RUN_RECORD_BYTES) throw new Error("run record size is invalid");
    const value: unknown = JSON.parse(Buffer.from(raw).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("run record must be an object");
    const record = value as ObserverRunRecord;
    if (typeof record.runId !== "string") throw new Error("run record ID is invalid");
    if (expectedRunId && record.runId !== expectedRunId) throw new Error("run record ID does not match its key");
    this.assertRecord(record, record.runId);
    if (this.recordId(record.runId) !== recordId) throw new Error("run record key does not match its ID");
    return record;
  }
  private removeArtifactDirectory(runId: string): void {
    const root = this.rootFor(runId);
    if (!existsSync(root)) return;
    const info = lstatSync(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ObserverError("INVALID_REQUEST", "Observer run path is invalid", 409);
    }
    rmSync(root, { recursive: true, force: false });
  }
  private recordStore(): LmdbRecordStore {
    if (this.closed) throw new ObserverError("INVALID_REQUEST", "Observer run store is closed", 409);
    if (!this.recordStoreInstance) {
      this.recordStoreInstance = new LmdbRecordStore({
        storageRoot: this.recordStorageRoot,
        keyPrefix: RUN_RECORD_KEY_PREFIX,
        maxRecordBytes: MAX_RUN_RECORD_BYTES,
      });
    }
    return this.recordStoreInstance;
  }
  /** Durable-key segments are lowercase; the public run ID remains byte-for-byte unchanged in the value. */
  private recordId(runId: string): string {
    this.assertRunId(runId);
    return runId.toLowerCase();
  }
  private assertRecord(record: ObserverRunRecord, runId: string): void {
    if (record.version !== RUN_RECORD_VERSION || record.runId !== runId || !["open", "finalized", "expired"].includes(record.state) || !Array.isArray(record.captures) || typeof record.title !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new ObserverError("INVALID_REQUEST", "Observer run record is invalid", 409);
  }
  private assertRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) throw new ObserverError("INVALID_REQUEST", "Observer run ID is invalid");
  }
}
