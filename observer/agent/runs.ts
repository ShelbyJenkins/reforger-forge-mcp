import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AGENT_VERSION, PROTOCOL_VERSION, SHA256_PATTERN } from "../protocol/index.js";
import {
  type ManagedArtifactRef,
  type ArtifactStore,
} from "./artifacts.js";
import { ObserverError } from "./errors.js";
import type { JobStore } from "./jobs.js";
import {
  assertIdentifier,
  assertManagedPath,
  assertRegularManagedFile,
  atomicWriteFile,
  atomicWriteJson,
  canonicalizeExistingDirectory,
  ensureCanonicalDirectory,
  listRegularFiles,
} from "./paths.js";

const RUN_RECORD_VERSION = 1;
const RUN_MANIFEST_VERSION = 1;
const MAX_SUPPORTING_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SUPPORTING_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_CONFIG_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const SECRET_KEY_PATTERN = /(authorization|bearer|credential|password|secret|token|private.?key)/i;
const BUNDLE_MEMBER_PATTERN = /^[A-Za-z0-9._/-]{1,512}$/;

interface FilesystemIdentity {
  dev: bigint;
  ino: bigint;
}

interface EvidenceBundleFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ObserverRunBeginInput {
  title: string;
  caseIds?: string[];
  sourceRevision?: string;
  procedureRevision?: string;
  idempotencyKey?: string;
}

export interface ObserverRunReview {
  imagesReviewed: boolean;
  reviewer?: string;
  outcome: "Passed" | "Failed" | "Inconclusive" | "Unreviewed";
  summary: string;
  limitations?: string[];
}

export interface ObserverRunFinalizeInput {
  runId: string;
  evidenceRoot: string;
  includeCaptureLabels: string[];
  review: ObserverRunReview;
  runtimeConfig?: { configurationId: string; values: Record<string, unknown> };
  supportingFiles?: Array<{ kind: "relevantLog"; label: string; path: string }>;
  releaseManagedArtifacts?: boolean;
}

export interface ReserveRunCaptureInput {
  runId: string;
  captureLabel: string;
  purpose?: string;
  idempotencyKey: string;
  expectedWorldId?: string | null;
  expectedWorldEpoch?: number;
  requestedView: Record<string, unknown>;
  performancePolicy: "evidence" | "instrumented";
}

export interface BindRunCaptureInput {
  runId: string;
  captureLabel: string;
  backend: "runtime" | "workbench";
  sessionId?: string;
  jobId: string;
  instanceId: string;
  worldId: string | null;
  worldEpoch: number;
}

interface RunCaptureRecord {
  label: string;
  purpose?: string;
  idempotencyHash: string;
  requestFingerprint: string;
  expectedWorldId?: string | null;
  expectedWorldEpoch?: number;
  requestedView: Record<string, unknown>;
  performancePolicy: "evidence" | "instrumented";
  state: "reserved" | "submitted" | "completed" | "failed" | "released";
  backend?: "runtime" | "workbench";
  sessionId?: string;
  jobId?: string;
  instanceId?: string;
  worldId?: string | null;
  worldEpoch?: number;
  artifact?: ManagedArtifactRef;
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
  exportReceipt?: Record<string, unknown>;
}

export interface RunStoreOptions {
  evidenceRoots?: string[];
  supportingLogRoots?: string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparisonPath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function assertSafeWindowsPath(value: string, label: string): void {
  if (process.platform !== "win32") return;
  if (/^\\\\[.?]\\/.test(value) || value.slice(2).includes(":")) {
    throw new ObserverError("INVALID_REQUEST", `${label} uses a device path or alternate data stream`);
  }
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(comparisonPath(root), comparisonPath(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function filesystemIdentity(path: string): FilesystemIdentity {
  const info = statSync(path, { bigint: true });
  return { dev: info.dev, ino: info.ino };
}

function sameFilesystemIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeBundleMemberPath(value: unknown): value is string {
  if (typeof value !== "string" || !BUNDLE_MEMBER_PATTERN.test(value) ||
      value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function presentationText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownText(value: unknown): string {
  return presentationText(value).replace(/([\\`*_[\]{}()#+.!|<>-])/g, "\\$1");
}

function boundedText(value: unknown, label: string, maximum: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ObserverError("INVALID_REQUEST", `${label} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}

function normalizeLabel(value: string, label = "Capture label"): string {
  const source = boundedText(value, label, 128)!;
  const normalized = source.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 96);
  if (!normalized || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(normalized)) {
    throw new ObserverError("INVALID_REQUEST", `${label} cannot be normalized to a safe evidence filename`);
  }
  return normalized;
}

function validateRevision(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, label, 256);
}

function validateCaseIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new ObserverError("INVALID_REQUEST", "caseIds must be an array of at most 64 identifiers");
  const result = value.map((item) => {
    if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(item)) {
      throw new ObserverError("INVALID_REQUEST", "caseIds contains an invalid identifier");
    }
    return item;
  });
  if (new Set(result).size !== result.length) throw new ObserverError("INVALID_REQUEST", "caseIds contains a duplicate identifier");
  return result;
}

function assertNoSecrets(value: unknown, path = "runtimeConfig"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new ObserverError("INVALID_REQUEST", `${path}.${key} looks secret-bearing and cannot be exported`);
    assertNoSecrets(item, `${path}.${key}`);
  }
}

function redactLog(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:authorization|credential|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function publicCapture(capture: RunCaptureRecord, missingArtifact: boolean): Record<string, unknown> {
  return {
    captureLabel: capture.label,
    purpose: capture.purpose ?? null,
    state: capture.state,
    backend: capture.backend ?? null,
    jobId: capture.jobId ?? null,
    instanceId: capture.instanceId ?? null,
    worldId: capture.worldId ?? null,
    worldEpoch: capture.worldEpoch ?? null,
    expectedWorldId: capture.expectedWorldId ?? null,
    expectedWorldEpoch: capture.expectedWorldEpoch ?? null,
    artifactAvailable: capture.artifact !== undefined && !missingArtifact,
    missingArtifact,
    terminalErrorCode: capture.terminalErrorCode ?? null,
    terminalMessage: capture.terminalMessage ?? null,
    updatedAt: capture.updatedAt,
  };
}

export class ObserverRunStore {
  readonly runsRoot: string;
  readonly exportWorkRoot: string;
  readonly evidenceRoots: readonly string[];
  readonly supportingLogRoots: readonly string[];
  private readonly evidenceRootIdentities: ReadonlyMap<string, FilesystemIdentity>;

  constructor(
    runsRoot: string,
    exportWorkRoot: string,
    private readonly artifacts: ArtifactStore,
    private readonly jobs: JobStore,
    options: RunStoreOptions = {}
  ) {
    this.runsRoot = ensureCanonicalDirectory(runsRoot);
    this.exportWorkRoot = ensureCanonicalDirectory(exportWorkRoot);
    this.evidenceRoots = (options.evidenceRoots ?? []).map((root) => this.approvedRoot(root, "Evidence root"));
    this.supportingLogRoots = (options.supportingLogRoots ?? []).map((root) => this.approvedRoot(root, "Supporting log root"));
    this.evidenceRootIdentities = new Map(
      this.evidenceRoots.map((root) => [comparisonPath(root), filesystemIdentity(root)])
    );
  }

  begin(input: ObserverRunBeginInput): Record<string, unknown> {
    const normalized = {
      title: boundedText(input.title, "Run title", 256)!,
      caseIds: validateCaseIds(input.caseIds),
      sourceRevision: validateRevision(input.sourceRevision, "Source revision"),
      procedureRevision: validateRevision(input.procedureRevision, "Procedure revision"),
    };
    const beginFingerprint = sha256(JSON.stringify(normalized));
    const idempotencyHash = input.idempotencyKey === undefined
      ? undefined
      : sha256(boundedText(input.idempotencyKey, "Idempotency key", 128)!);
    if (idempotencyHash) {
      for (const record of this.records()) {
        if (record.idempotencyHash !== idempotencyHash) continue;
        if (record.beginFingerprint !== beginFingerprint) {
          throw new ObserverError("INVALID_REQUEST", "Run idempotency key was reused with different input", 409);
        }
        return this.publicRun(record);
      }
    }
    const timestamp = new Date();
    const runId = `${timestamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomBytes(4).toString("hex")}`;
    const root = join(this.runsRoot, runId);
    mkdirSync(root, { mode: 0o700 });
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
    this.write(record);
    return this.publicRun(record);
  }

  reserveCapture(input: ReserveRunCaptureInput): Record<string, unknown> {
    const record = this.requireOpen(input.runId);
    const captureLabel = normalizeLabel(input.captureLabel);
    const idempotencyHash = sha256(boundedText(input.idempotencyKey, "Idempotency key", 128)!);
    const normalized = {
      captureLabel,
      purpose: boundedText(input.purpose, "Capture purpose", 512, false),
      expectedWorldId: input.expectedWorldId,
      expectedWorldEpoch: input.expectedWorldEpoch,
      requestedView: input.requestedView,
      performancePolicy: input.performancePolicy,
    };
    if (input.expectedWorldId !== undefined && input.expectedWorldId !== null) boundedText(input.expectedWorldId, "Expected world ID", 512);
    if (input.expectedWorldEpoch !== undefined && (!Number.isSafeInteger(input.expectedWorldEpoch) || input.expectedWorldEpoch < 0)) {
      throw new ObserverError("INVALID_REQUEST", "Expected world epoch must be a non-negative integer");
    }
    const requestFingerprint = sha256(JSON.stringify(normalized));
    const existing = record.captures.find((capture) => capture.label === captureLabel);
    if (existing) {
      if (existing.idempotencyHash !== idempotencyHash || existing.requestFingerprint !== requestFingerprint) {
        throw new ObserverError("INVALID_REQUEST", `Capture label '${captureLabel}' is already reserved in this run`, 409);
      }
      return { runId: record.runId, capture: publicCapture(existing, this.missing(existing)) };
    }
    const now = new Date().toISOString();
    const capture: RunCaptureRecord = {
      label: captureLabel,
      ...(normalized.purpose ? { purpose: normalized.purpose } : {}),
      idempotencyHash,
      requestFingerprint,
      ...(input.expectedWorldId !== undefined ? { expectedWorldId: input.expectedWorldId } : {}),
      ...(input.expectedWorldEpoch !== undefined ? { expectedWorldEpoch: input.expectedWorldEpoch } : {}),
      requestedView: input.requestedView,
      performancePolicy: input.performancePolicy,
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
    const label = normalizeLabel(input.captureLabel);
    const capture = record.captures.find((item) => item.label === label);
    if (!capture) throw new ObserverError("INVALID_REQUEST", "Run capture label is not reserved", 404);
    assertIdentifier(input.jobId, "Job ID");
    assertIdentifier(input.instanceId, "Instance ID");
    if (!Number.isSafeInteger(input.worldEpoch) || input.worldEpoch < 0) throw new ObserverError("INVALID_REQUEST", "World epoch is invalid");
    if (capture.jobId && (capture.jobId !== input.jobId || capture.backend !== input.backend)) {
      throw new ObserverError("INVALID_REQUEST", "Reserved run capture is already bound to a different job", 409);
    }
    capture.backend = input.backend;
    capture.sessionId = input.sessionId;
    capture.jobId = input.jobId;
    capture.instanceId = input.instanceId;
    capture.worldId = input.worldId;
    capture.worldEpoch = input.worldEpoch;
    capture.state = "submitted";
    capture.updatedAt = new Date().toISOString();
    record.updatedAt = capture.updatedAt;
    this.refreshCapture(capture);
    this.write(record);
    return { runId: record.runId, capture: publicCapture(capture, this.missing(capture)) };
  }

  attachImportedArtifact(runId: string, captureLabel: string, ref: ManagedArtifactRef): Record<string, unknown> {
    const record = this.requireOpen(runId);
    const capture = record.captures.find((item) => item.label === normalizeLabel(captureLabel));
    if (!capture || capture.backend !== "workbench" || capture.jobId !== ref.jobId) {
      throw new ObserverError("INVALID_REQUEST", "Imported artifact does not match the run capture", 409);
    }
    if (capture.artifact && JSON.stringify(capture.artifact) !== JSON.stringify(ref)) {
      throw new ObserverError("ARTIFACT_INVALID", "Run capture already references a different artifact", 409);
    }
    capture.artifact = ref;
    capture.state = "completed";
    capture.updatedAt = new Date().toISOString();
    record.updatedAt = capture.updatedAt;
    this.write(record);
    return { runId, capture: publicCapture(capture, false) };
  }

  failCapture(runId: string, captureLabel: string, code: string, message: string): Record<string, unknown> {
    const record = this.requireOpen(runId);
    const capture = record.captures.find((item) => item.label === normalizeLabel(captureLabel));
    if (!capture) throw new ObserverError("INVALID_REQUEST", "Run capture label is not reserved", 404);
    const refreshed = this.refreshCapture(capture);
    if (capture.state === "completed" || capture.state === "released") {
      if (refreshed) {
        record.updatedAt = capture.updatedAt;
        this.write(record);
      }
      return { runId, capture: publicCapture(capture, this.missing(capture)) };
    }
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
    if (record.state === "finalized") this.verifyFinalizedReceipt(record);
    let changed = false;
    for (const capture of record.captures) changed = this.refreshCapture(capture) || changed;
    if (changed) {
      record.updatedAt = new Date().toISOString();
      this.write(record);
    }
    return this.publicRun(record);
  }

  finalize(input: ObserverRunFinalizeInput): Record<string, unknown> {
    const record = this.require(input.runId);
    const normalizedInput = this.validateFinalize(input);
    const finalizeFingerprint = sha256(JSON.stringify(normalizedInput));
    if (record.state === "finalized") {
      if (record.finalizeFingerprint !== finalizeFingerprint || !record.exportReceipt) {
        throw new ObserverError("INVALID_REQUEST", "Finalized run cannot be exported with different input", 409);
      }
      this.verifyFinalizedReceipt(record);
      return { run: this.publicRun(record), receipt: record.exportReceipt };
    }
    if (record.state !== "open") throw new ObserverError("INVALID_REQUEST", `Run is ${record.state} and cannot be finalized`, 409);
    for (const capture of record.captures) this.refreshCapture(capture);
    const byLabel = new Map(record.captures.map((capture) => [capture.label, capture]));
    const selected = normalizedInput.includeCaptureLabels.map((label) => {
      const capture = byLabel.get(label);
      if (!capture) throw new ObserverError("INVALID_REQUEST", `Run has no capture labeled '${label}'`, 404);
      if (capture.state !== "completed" || !capture.artifact || this.missing(capture)) {
        throw new ObserverError("ARTIFACT_INCOMPLETE", `Capture '${label}' has no retained completed artifact`, 409);
      }
      return capture;
    });
    const evidenceRoot = this.resolveEvidenceRoot(normalizedInput.evidenceRoot);
    const outputRoot = join(evidenceRoot, record.runId);
    if (existsSync(outputRoot)) {
      const recovered = this.recoverExistingExport(
        record,
        evidenceRoot,
        outputRoot,
        finalizeFingerprint,
        normalizedInput,
        selected
      );
      if (recovered) return recovered;
      throw new ObserverError("INVALID_REQUEST", "Evidence output already exists and will not be overwritten", 409);
    }

    const workRoot = join(this.exportWorkRoot, `${record.runId}-${randomUUID()}`);
    mkdirSync(workRoot, { mode: 0o700 });
    const pins = selected.map((capture) => this.artifacts.pinForOperation(capture.artifact!));
    let outputCreated = false;
    let outputCommitted = false;
    let outputIdentity: FilesystemIdentity | null = null;
    try {
      const captureManifest: Array<Record<string, unknown>> = [];
      for (const capture of selected) {
        const artifact = this.artifacts.readRef(capture.artifact!);
        const imageRelative = `captures/${capture.label}.png`;
        const metadataRelative = `captures/${capture.label}.json`;
        atomicWriteFile(workRoot, join(workRoot, imageRelative), artifact.image);
        const item = this.captureManifest(capture, artifact.metadata, imageRelative, metadataRelative);
        atomicWriteJson(workRoot, join(workRoot, metadataRelative), item);
        captureManifest.push(item);
      }

      const supportingManifest = this.copySupportingFiles(workRoot, normalizedInput.supportingFiles);
      if (normalizedInput.runtimeConfig) {
        atomicWriteJson(workRoot, join(workRoot, "runtime-config.json"), normalizedInput.runtimeConfig);
      }
      const finalizedAt = new Date().toISOString();
      const manifestBase = {
        manifestVersion: RUN_MANIFEST_VERSION,
        runId: record.runId,
        title: record.title,
        caseIds: record.caseIds,
        createdAt: record.createdAt,
        finalizedAt,
        sourceRevision: record.sourceRevision ?? null,
        procedureRevision: record.procedureRevision ?? null,
        review: normalizedInput.review,
        versions: { observerProtocol: PROTOCOL_VERSION, observerAgent: AGENT_VERSION },
        captures: captureManifest,
        supportingFiles: supportingManifest,
        runtimeConfig: normalizedInput.runtimeConfig ? { supplied: true, path: "runtime-config.json" } : { supplied: false },
        relevantLogs: supportingManifest.length > 0 ? { supplied: true } : { supplied: false },
        export: {
          completionMarker: "manifest.json",
          requestSha256: finalizeFingerprint,
          managedArtifactsReleased: normalizedInput.releaseManagedArtifacts,
        },
      };
      atomicWriteFile(workRoot, join(workRoot, "RESULT.md"), this.resultMarkdown(manifestBase));
      const bundleFiles = this.hashBundleMembers(workRoot);
      const manifest = { ...manifestBase, files: bundleFiles };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      atomicWriteFile(workRoot, join(workRoot, "manifest.json"), manifestBytes);

      this.revalidateEvidenceRoot(evidenceRoot);
      mkdirSync(outputRoot, { mode: 0o755 });
      outputCreated = true;
      outputIdentity = this.captureEvidenceOutputIdentity(evidenceRoot, outputRoot);
      const files = listRegularFiles(workRoot);
      for (const relativePath of files.filter((path) => path !== "manifest.json")) {
        this.assertEvidenceOutputIdentity(evidenceRoot, outputRoot, outputIdentity);
        const source = assertRegularManagedFile(workRoot, join(workRoot, ...relativePath.split("/")));
        const target = join(outputRoot, ...relativePath.split("/"));
        atomicWriteFile(outputRoot, target, readFileSync(source), 0o644);
      }
      this.assertEvidenceOutputIdentity(evidenceRoot, outputRoot, outputIdentity);
      atomicWriteFile(outputRoot, join(outputRoot, "manifest.json"), manifestBytes, 0o644);
      this.verifyEvidenceBundle(
        record,
        evidenceRoot,
        outputRoot,
        finalizeFingerprint,
        normalizedInput,
        selected,
        sha256(manifestBytes)
      );
      outputCommitted = true;

      for (const pin of pins) pin.dispose();
      if (normalizedInput.releaseManagedArtifacts) {
        for (const capture of record.captures) {
          if (!capture.artifact) continue;
          this.artifacts.releaseRef(capture.artifact);
          capture.state = "released";
          capture.updatedAt = finalizedAt;
        }
      }
      const receipt = {
        runId: record.runId,
        evidenceDirectory: outputRoot,
        manifestSha256: sha256(manifestBytes),
        captureCount: selected.length,
        supportingFileCount: supportingManifest.length,
        finalizedAt,
        managedArtifactsReleased: normalizedInput.releaseManagedArtifacts,
      };
      record.state = "finalized";
      record.finalizedAt = finalizedAt;
      record.updatedAt = finalizedAt;
      record.finalizeFingerprint = finalizeFingerprint;
      record.exportReceipt = receipt;
      this.write(record);
      return { run: this.publicRun(record), receipt };
    } catch (error) {
      if (outputCreated && !outputCommitted && outputIdentity) {
        this.cleanupIncompleteOutput(evidenceRoot, outputRoot, outputIdentity);
      }
      throw error;
    } finally {
      for (const pin of pins) pin.dispose();
      if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
    }
  }

  discard(runId: string): Record<string, unknown> {
    const record = this.require(runId);
    if (record.state === "finalized") {
      throw new ObserverError("INVALID_REQUEST", "Finalized run records are retained with their export receipt", 409);
    }
    const released: string[] = [];
    for (const capture of record.captures) {
      if (!capture.artifact) continue;
      if (this.artifacts.releaseRef(capture.artifact).released) released.push(capture.label);
    }
    const root = this.rootFor(runId);
    rmSync(root, { recursive: true, force: false });
    return { runId, discarded: true, releasedCaptureLabels: released };
  }

  protectedStoreKeys(): Set<string> {
    const result = new Set<string>();
    for (const record of this.records()) {
      if (record.state !== "open") continue;
      for (const capture of record.captures) {
        if (capture.artifact) result.add(capture.artifact.storeKey);
        else if (capture.backend === "runtime" && capture.sessionId && capture.jobId) {
          result.add(`runtime/${capture.sessionId}/${capture.jobId}`);
        }
      }
    }
    return result;
  }

  assertJobReleaseAllowed(backend: "runtime" | "workbench", jobId: string, sessionId?: string): void {
    for (const record of this.records()) {
      if (record.state !== "open") continue;
      const capture = record.captures.find((item) =>
        item.backend === backend && item.jobId === jobId && (backend !== "runtime" || item.sessionId === sessionId)
      );
      if (capture) {
        throw new ObserverError(
          "INVALID_REQUEST",
          `Capture '${capture.label}' is retained by open run ${record.runId}; finalize or discard the run instead`,
          409
        );
      }
    }
  }

  applyRetention(maxAgeMs: number): { expiredRuns: string[]; removedRunRecords: string[]; removedExportWork: string[] } {
    const now = Date.now();
    const expiredRuns: string[] = [];
    const removedRunRecords: string[] = [];
    for (const record of this.records()) {
      const age = now - Date.parse(record.updatedAt);
      if (age <= maxAgeMs) continue;
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
        rmSync(this.rootFor(record.runId), { recursive: true, force: false });
        removedRunRecords.push(record.runId);
      }
    }
    const removedExportWork: string[] = [];
    for (const entry of readdirSync(this.exportWorkRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(this.exportWorkRoot, entry.name);
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
      rmSync(path, { recursive: true, force: false });
      removedExportWork.push(entry.name);
    }
    return { expiredRuns, removedRunRecords, removedExportWork };
  }

  diagnostics(): Record<string, unknown> {
    const records = this.records();
    return {
      evidenceRootCount: this.evidenceRoots.length,
      supportingLogRootCount: this.supportingLogRoots.length,
      runs: {
        total: records.length,
        open: records.filter((record) => record.state === "open").length,
        finalized: records.filter((record) => record.state === "finalized").length,
        expired: records.filter((record) => record.state === "expired").length,
      },
    };
  }

  private validateFinalize(input: ObserverRunFinalizeInput): ObserverRunFinalizeInput {
    this.assertRunId(input.runId);
    if (!Array.isArray(input.includeCaptureLabels) || input.includeCaptureLabels.length < 1 || input.includeCaptureLabels.length > 64) {
      throw new ObserverError("INVALID_REQUEST", "includeCaptureLabels must contain from 1 through 64 labels");
    }
    const labels = input.includeCaptureLabels.map((label) => normalizeLabel(label));
    if (new Set(labels).size !== labels.length) throw new ObserverError("INVALID_REQUEST", "includeCaptureLabels contains duplicate normalized labels");
    const review = input.review;
    if (!review || typeof review !== "object") throw new ObserverError("INVALID_REQUEST", "review is required");
    if (typeof review.imagesReviewed !== "boolean" || !["Passed", "Failed", "Inconclusive", "Unreviewed"].includes(review.outcome)) {
      throw new ObserverError("INVALID_REQUEST", "Review state or outcome is invalid");
    }
    const reviewer = boundedText(review.reviewer, "Reviewer", 256, false);
    if (review.imagesReviewed && !reviewer) throw new ObserverError("INVALID_REQUEST", "An image-capable reviewer identity is required when imagesReviewed is true");
    if (!review.imagesReviewed && !["Unreviewed", "Inconclusive"].includes(review.outcome)) {
      throw new ObserverError("INVALID_REQUEST", "Unreviewed images may only have Unreviewed or Inconclusive outcome");
    }
    if (review.imagesReviewed && review.outcome === "Unreviewed") {
      throw new ObserverError("INVALID_REQUEST", "Reviewed images cannot have an Unreviewed outcome");
    }
    const summary = boundedText(review.summary, "Review summary", 2_048)!;
    const limitations = review.limitations ?? [];
    if (!Array.isArray(limitations) || limitations.length > 32) throw new ObserverError("INVALID_REQUEST", "Review limitations must contain at most 32 entries");
    const normalizedLimitations = limitations.map((value) => boundedText(value, "Review limitation", 512)!);
    let runtimeConfig = input.runtimeConfig;
    if (runtimeConfig) {
      const configurationId = boundedText(runtimeConfig.configurationId, "Runtime configuration ID", 128)!;
      if (!runtimeConfig.values || typeof runtimeConfig.values !== "object" || Array.isArray(runtimeConfig.values)) {
        throw new ObserverError("INVALID_REQUEST", "runtimeConfig.values must be an object");
      }
      assertNoSecrets(runtimeConfig.values);
      runtimeConfig = { configurationId, values: runtimeConfig.values };
      if (Buffer.byteLength(JSON.stringify(runtimeConfig)) > MAX_RUNTIME_CONFIG_BYTES) throw new ObserverError("INVALID_REQUEST", "Runtime configuration snapshot is too large");
    }
    const supportingFiles = input.supportingFiles ?? [];
    if (!Array.isArray(supportingFiles) || supportingFiles.length > 16) throw new ObserverError("INVALID_REQUEST", "supportingFiles must contain at most 16 entries");
    const normalizedSupporting = supportingFiles.map((file) => {
      if (file.kind !== "relevantLog") throw new ObserverError("INVALID_REQUEST", "Only relevantLog supporting files are allowed");
      return { kind: file.kind, label: normalizeLabel(file.label, "Supporting file label"), path: boundedText(file.path, "Supporting file path", 32_768)! };
    });
    if (new Set(normalizedSupporting.map((file) => file.label)).size !== normalizedSupporting.length) {
      throw new ObserverError("INVALID_REQUEST", "supportingFiles contains duplicate normalized labels");
    }
    return {
      runId: input.runId,
      evidenceRoot: boundedText(input.evidenceRoot, "Evidence root", 32_768)!,
      includeCaptureLabels: labels,
      review: {
        imagesReviewed: review.imagesReviewed === true,
        ...(reviewer ? { reviewer } : {}),
        outcome: review.outcome,
        summary,
        ...(normalizedLimitations.length > 0 ? { limitations: normalizedLimitations } : {}),
      },
      ...(runtimeConfig ? { runtimeConfig } : {}),
      ...(normalizedSupporting.length > 0 ? { supportingFiles: normalizedSupporting } : {}),
      releaseManagedArtifacts: input.releaseManagedArtifacts !== false,
    };
  }

  private copySupportingFiles(workRoot: string, files: ObserverRunFinalizeInput["supportingFiles"]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const file of files ?? []) {
      const canonical = this.resolveSupportingFile(file.path);
      const descriptor = openSync(canonical, "r");
      let bytes: Buffer;
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile()) throw new ObserverError("INVALID_REQUEST", "Relevant log attachment is not a regular file");
        if (opened.size > MAX_SUPPORTING_FILE_BYTES || total + opened.size > MAX_SUPPORTING_TOTAL_BYTES) {
          throw new ObserverError("INVALID_REQUEST", "Relevant log attachments exceed the evidence size limit");
        }
        const pathEntry = lstatSync(canonical);
        const currentCanonical = realpathSync.native(canonical);
        const current = statSync(currentCanonical);
        if (pathEntry.isSymbolicLink() || !pathEntry.isFile() ||
            comparisonPath(currentCanonical) !== comparisonPath(canonical) ||
            opened.dev !== current.dev || opened.ino !== current.ino) {
          throw new ObserverError("INVALID_REQUEST", "Relevant log attachment changed identity while it was opened", 409);
        }
        bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (bytes.length !== opened.size || after.size !== opened.size ||
            after.dev !== opened.dev || after.ino !== opened.ino ||
            after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
          throw new ObserverError("INVALID_REQUEST", "Relevant log attachment changed while it was read", 409);
        }
      } finally {
        closeSync(descriptor);
      }
      total += bytes.length;
      if (bytes.length > MAX_SUPPORTING_FILE_BYTES || total > MAX_SUPPORTING_TOTAL_BYTES) {
        throw new ObserverError("INVALID_REQUEST", "Relevant log attachments exceed the evidence size limit");
      }
      if (bytes.includes(0)) throw new ObserverError("INVALID_REQUEST", "Relevant log attachments must be text files");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const filtered = Buffer.from(redactLog(text), "utf8");
      const relativePath = `relevant-logs/${file.label}.log`;
      atomicWriteFile(workRoot, join(workRoot, relativePath), filtered);
      result.push({ kind: "relevantLog", label: file.label, path: relativePath, bytes: filtered.length, sha256: sha256(filtered) });
    }
    return result;
  }

  private captureManifest(
    capture: RunCaptureRecord,
    metadata: Record<string, unknown>,
    imagePath: string,
    metadataPath: string
  ): Record<string, unknown> {
    const ref = capture.artifact!;
    const warnings = Array.isArray(metadata.warnings)
      ? metadata.warnings.filter((value): value is string => typeof value === "string").slice(0, 16)
      : [];
    if (capture.performancePolicy === "instrumented" && !warnings.some((warning) => /instrumented/i.test(warning))) {
      warnings.push("Capture used the instrumented performance policy");
    }
    return {
      label: capture.label,
      purpose: capture.purpose ?? null,
      imagePath,
      metadataPath,
      backend: capture.backend,
      jobId: capture.jobId,
      instanceId: capture.instanceId,
      worldId: capture.worldId ?? null,
      worldEpoch: capture.worldEpoch,
      requestedView: capture.requestedView,
      actualCamera: metadata.actualCamera ?? null,
      actualFov: metadata.actualFov ?? null,
      width: ref.width,
      height: ref.height,
      bytes: ref.bytes,
      sha256: ref.sha256,
      screenshotIssuedAt: metadata.screenshotIssuedAt ?? null,
      completedAt: metadata.completedAt ?? null,
      contaminated: capture.performancePolicy === "instrumented" || metadata.contaminated === true,
      warnings,
    };
  }

  private resultMarkdown(manifest: {
    runId: string;
    title: string;
    caseIds: string[];
    review: ObserverRunReview;
    captures: Array<Record<string, unknown>>;
    supportingFiles: Array<Record<string, unknown>>;
  }): string {
    const lines = [
      `# ${markdownText(manifest.title)}`,
      "",
      `- Run: \`${manifest.runId}\``,
      `- Outcome: **${manifest.review.outcome}**`,
      `- Images reviewed: ${manifest.review.imagesReviewed ? "yes" : "no"}`,
      `- Reviewer: ${markdownText(manifest.review.reviewer ?? "not supplied")}`,
      `- Cases: ${manifest.caseIds.length > 0 ? manifest.caseIds.map(markdownText).join(", ") : "not supplied"}`,
      "",
      markdownText(manifest.review.summary),
      "",
      "## Captures",
      "",
      ...manifest.captures.map((capture) => `- [${markdownText(capture.label)}](./${capture.imagePath})${capture.contaminated ? " — contaminated/instrumented" : ""}`),
    ];
    if (manifest.supportingFiles.length > 0) {
      lines.push("", "## Supporting evidence", "", ...manifest.supportingFiles.map((file) => `- [${markdownText(file.label)}](./${file.path})`));
    }
    const limitations = manifest.review.limitations ?? [];
    if (limitations.length > 0) lines.push("", "## Limitations", "", ...limitations.map((value) => `- ${markdownText(value)}`));
    return `${lines.join("\n")}\n`;
  }

  private hashBundleMembers(root: string): EvidenceBundleFile[] {
    return listRegularFiles(root)
      .filter((path) => path !== "manifest.json")
      .sort((left, right) => left.localeCompare(right))
      .map((path) => {
        const bytes = readFileSync(assertRegularManagedFile(root, join(root, ...path.split("/"))));
        return { path, bytes: bytes.length, sha256: sha256(bytes) };
      });
  }

  private parseBundleFiles(manifest: Record<string, unknown>): EvidenceBundleFile[] {
    if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 256) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest has no bounded member attestation list", 409);
    }
    const seen = new Set<string>();
    const files = manifest.files.map((raw): EvidenceBundleFile => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest contains an invalid member attestation", 409);
      }
      const entry = raw as Record<string, unknown>;
      if (!safeBundleMemberPath(entry.path) || entry.path === "manifest.json" ||
          !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0 ||
          typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest contains an unsafe member attestation", 409);
      }
      const key = entry.path.toLowerCase();
      if (seen.has(key)) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest repeats a member path", 409);
      seen.add(key);
      return { path: entry.path, bytes: entry.bytes as number, sha256: entry.sha256 };
    });
    const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
    if (!isDeepStrictEqual(files, sorted)) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest member attestations are not canonical", 409);
    }
    return files;
  }

  private verifyEvidenceBundle(
    record: ObserverRunRecord,
    evidenceRoot: string,
    outputRoot: string,
    fingerprint: string,
    expectedInput?: ObserverRunFinalizeInput,
    expectedCaptures?: RunCaptureRecord[],
    expectedManifestSha256?: string
  ): { manifest: Record<string, unknown>; manifestBytes: Buffer } {
    try {
      const outputIdentity = this.captureEvidenceOutputIdentity(evidenceRoot, outputRoot);
      const manifestPath = assertRegularManagedFile(outputRoot, join(outputRoot, "manifest.json"));
      const manifestBytes = readFileSync(manifestPath);
      if (manifestBytes.length === 0 || manifestBytes.length > MAX_MANIFEST_BYTES) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest size is invalid", 409);
      }
      if (expectedManifestSha256 && sha256(manifestBytes) !== expectedManifestSha256) {
        throw new ObserverError("ARTIFACT_INVALID", "Finalized evidence manifest no longer matches its receipt", 409);
      }
      const parsed = JSON.parse(manifestBytes.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest root is invalid", 409);
      }
      const manifest = parsed as Record<string, unknown>;
      const exportRecord = manifest.export;
      if (manifest.manifestVersion !== RUN_MANIFEST_VERSION || manifest.runId !== record.runId ||
          !exportRecord || typeof exportRecord !== "object" || Array.isArray(exportRecord) ||
          (exportRecord as Record<string, unknown>).requestSha256 !== fingerprint ||
          (exportRecord as Record<string, unknown>).completionMarker !== "manifest.json" ||
          typeof (exportRecord as Record<string, unknown>).managedArtifactsReleased !== "boolean") {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest is not bound to this finalize request", 409);
      }
      const files = this.parseBundleFiles(manifest);
      const actualPaths = listRegularFiles(outputRoot).sort((left, right) => left.localeCompare(right));
      const expectedPaths = [...files.map((file) => file.path), "manifest.json"]
        .sort((left, right) => left.localeCompare(right));
      if (!isDeepStrictEqual(actualPaths, expectedPaths)) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence directory has missing or unmanifested members", 409);
      }
      for (const file of files) {
        this.assertEvidenceOutputIdentity(evidenceRoot, outputRoot, outputIdentity);
        const path = assertRegularManagedFile(outputRoot, join(outputRoot, ...file.path.split("/")));
        const bytes = readFileSync(path);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
          throw new ObserverError("ARTIFACT_INVALID", `Evidence member no longer matches its attestation: ${file.path}`, 409);
        }
      }
      this.verifyManifestPayloadContract(record, outputRoot, manifest, files, expectedInput, expectedCaptures);
      this.assertEvidenceOutputIdentity(evidenceRoot, outputRoot, outputIdentity);
      return { manifest, manifestBytes };
    } catch (error) {
      if (error instanceof ObserverError) throw error;
      throw new ObserverError(
        "ARTIFACT_INVALID",
        `Evidence bundle verification failed: ${error instanceof Error ? error.message : String(error)}`,
        409
      );
    }
  }

  private verifyManifestPayloadContract(
    record: ObserverRunRecord,
    outputRoot: string,
    manifest: Record<string, unknown>,
    files: EvidenceBundleFile[],
    expectedInput?: ObserverRunFinalizeInput,
    expectedCaptures?: RunCaptureRecord[]
  ): void {
    if (manifest.title !== record.title || !isDeepStrictEqual(manifest.caseIds, record.caseIds) ||
        manifest.sourceRevision !== (record.sourceRevision ?? null) ||
        manifest.procedureRevision !== (record.procedureRevision ?? null) ||
        typeof manifest.finalizedAt !== "string") {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest run metadata does not match its managed run", 409);
    }
    if (!manifest.review || typeof manifest.review !== "object" || Array.isArray(manifest.review) ||
        !Array.isArray(manifest.captures) || !Array.isArray(manifest.supportingFiles)) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest payload sections are invalid", 409);
    }
    if (expectedInput && !isDeepStrictEqual(manifest.review, expectedInput.review)) {
      throw new ObserverError("ARTIFACT_INVALID", "Recovered evidence review does not match the finalize request", 409);
    }
    const exportRecord = manifest.export as Record<string, unknown>;
    if (expectedInput && exportRecord.managedArtifactsReleased !== expectedInput.releaseManagedArtifacts) {
      throw new ObserverError("ARTIFACT_INVALID", "Recovered artifact-release policy does not match the finalize request", 409);
    }

    const captures = manifest.captures as unknown[];
    const selected = expectedCaptures ?? captures.map((raw) => {
      const label = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>).label
        : undefined;
      const capture = typeof label === "string" ? record.captures.find((item) => item.label === label) : undefined;
      if (!capture) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest references an unknown run capture", 409);
      return capture;
    });
    if (captures.length !== selected.length) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest capture set is incomplete", 409);
    }

    const memberByPath = new Map(files.map((file) => [file.path, file]));
    const requiredPaths = new Set<string>(["RESULT.md"]);
    for (let index = 0; index < selected.length; index += 1) {
      const raw = captures[index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest contains an invalid capture", 409);
      }
      const item = raw as Record<string, unknown>;
      const capture = selected[index];
      const ref = capture.artifact;
      const imagePath = `captures/${capture.label}.png`;
      const metadataPath = `captures/${capture.label}.json`;
      if (!ref || item.label !== capture.label || item.imagePath !== imagePath || item.metadataPath !== metadataPath ||
          item.backend !== capture.backend || item.jobId !== capture.jobId || item.instanceId !== capture.instanceId ||
          item.worldId !== (capture.worldId ?? null) || item.worldEpoch !== capture.worldEpoch ||
          !isDeepStrictEqual(item.requestedView, capture.requestedView) ||
          item.width !== ref.width || item.height !== ref.height || item.bytes !== ref.bytes || item.sha256 !== ref.sha256) {
        throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' is not bound to its managed artifact`, 409);
      }
      const imageMember = memberByPath.get(imagePath);
      if (!imageMember || imageMember.bytes !== ref.bytes || imageMember.sha256 !== ref.sha256) {
        throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' image attestation is invalid`, 409);
      }
      const metadataMember = memberByPath.get(metadataPath);
      if (!metadataMember) throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' metadata is missing`, 409);
      const metadata = JSON.parse(readFileSync(
        assertRegularManagedFile(outputRoot, join(outputRoot, ...metadataPath.split("/"))),
        "utf8"
      )) as unknown;
      if (!isDeepStrictEqual(metadata, item)) {
        throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' metadata does not match its manifest`, 409);
      }
      requiredPaths.add(imagePath);
      requiredPaths.add(metadataPath);
    }

    const supporting = manifest.supportingFiles as unknown[];
    const expectedSupporting = expectedInput?.supportingFiles ?? [];
    if (expectedInput && supporting.length !== expectedSupporting.length) {
      throw new ObserverError("ARTIFACT_INVALID", "Recovered supporting evidence does not match the finalize request", 409);
    }
    for (let index = 0; index < supporting.length; index += 1) {
      const raw = supporting[index];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest contains an invalid supporting member", 409);
      }
      const item = raw as Record<string, unknown>;
      const expected = expectedSupporting[index];
      const expectedPath = expected
        ? `relevant-logs/${expected.label}.log`
        : typeof item.label === "string" ? `relevant-logs/${item.label}.log` : undefined;
      if (item.kind !== "relevantLog" || typeof item.label !== "string" ||
          !safeBundleMemberPath(item.path) || item.path !== expectedPath ||
          (expected && (item.label !== expected.label || item.kind !== expected.kind))) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence supporting member is not bound to the finalize request", 409);
      }
      const member = memberByPath.get(item.path);
      if (!member || item.bytes !== member.bytes || item.sha256 !== member.sha256) {
        throw new ObserverError("ARTIFACT_INVALID", `Evidence supporting member attestation is invalid: ${item.path}`, 409);
      }
      requiredPaths.add(item.path);
    }

    const runtimeDescriptor = manifest.runtimeConfig;
    if (!runtimeDescriptor || typeof runtimeDescriptor !== "object" || Array.isArray(runtimeDescriptor)) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence runtime configuration descriptor is invalid", 409);
    }
    const runtimeSupplied = (runtimeDescriptor as Record<string, unknown>).supplied === true;
    if (runtimeSupplied) {
      if ((runtimeDescriptor as Record<string, unknown>).path !== "runtime-config.json" || !memberByPath.has("runtime-config.json")) {
        throw new ObserverError("ARTIFACT_INVALID", "Evidence runtime configuration member is invalid", 409);
      }
      requiredPaths.add("runtime-config.json");
      if (expectedInput?.runtimeConfig) {
        const runtimeValue = JSON.parse(readFileSync(
          assertRegularManagedFile(outputRoot, join(outputRoot, "runtime-config.json")),
          "utf8"
        )) as unknown;
        if (!isDeepStrictEqual(runtimeValue, expectedInput.runtimeConfig)) {
          throw new ObserverError("ARTIFACT_INVALID", "Recovered runtime configuration does not match the finalize request", 409);
        }
      }
    }
    if (expectedInput && runtimeSupplied !== (expectedInput.runtimeConfig !== undefined)) {
      throw new ObserverError("ARTIFACT_INVALID", "Recovered runtime configuration presence does not match the finalize request", 409);
    }

    const attestedPaths = new Set(files.map((file) => file.path));
    if (attestedPaths.size !== requiredPaths.size || [...requiredPaths].some((path) => !attestedPaths.has(path))) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest attests an unexpected payload member set", 409);
    }
    const review = manifest.review as ObserverRunReview;
    const expectedResult = this.resultMarkdown({
      runId: record.runId,
      title: record.title,
      caseIds: record.caseIds,
      review,
      captures: captures as Array<Record<string, unknown>>,
      supportingFiles: supporting as Array<Record<string, unknown>>,
    });
    const actualResult = readFileSync(assertRegularManagedFile(outputRoot, join(outputRoot, "RESULT.md")), "utf8");
    if (actualResult !== expectedResult) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence RESULT.md does not match its manifest", 409);
    }
  }

  private recoverExistingExport(
    record: ObserverRunRecord,
    evidenceRoot: string,
    outputRoot: string,
    fingerprint: string,
    expectedInput: ObserverRunFinalizeInput,
    expectedCaptures: RunCaptureRecord[]
  ): Record<string, unknown> | null {
    try {
      const { manifest, manifestBytes: bytes } = this.verifyEvidenceBundle(
        record,
        evidenceRoot,
        outputRoot,
        fingerprint,
        expectedInput,
        expectedCaptures
      );
      const exportRecord = manifest.export as Record<string, unknown> | undefined;
      const finalizedAt = manifest.finalizedAt as string;
      const captures = (manifest.captures as unknown[]).length;
      const supporting = (manifest.supportingFiles as unknown[]).length;
      if (exportRecord?.managedArtifactsReleased === true) {
        for (const capture of record.captures) {
          if (!capture.artifact) continue;
          this.artifacts.releaseRef(capture.artifact);
          capture.state = "released";
          capture.updatedAt = finalizedAt;
        }
      }
      const receipt = {
        runId: record.runId,
        evidenceDirectory: outputRoot,
        manifestSha256: sha256(bytes),
        captureCount: captures,
        supportingFileCount: supporting,
        finalizedAt,
        managedArtifactsReleased: exportRecord?.managedArtifactsReleased === true,
        recovered: true,
      };
      record.state = "finalized";
      record.finalizedAt = finalizedAt;
      record.updatedAt = finalizedAt;
      record.finalizeFingerprint = fingerprint;
      record.exportReceipt = receipt;
      this.write(record);
      return { run: this.publicRun(record), receipt };
    } catch {
      return null;
    }
  }

  private verifyFinalizedReceipt(record: ObserverRunRecord): void {
    const directory = record.exportReceipt?.evidenceDirectory;
    const expectedSha256 = record.exportReceipt?.manifestSha256;
    const fingerprint = record.finalizeFingerprint;
    if (typeof directory !== "string" || typeof expectedSha256 !== "string" || !SHA256_PATTERN.test(expectedSha256) ||
        typeof fingerprint !== "string" || !SHA256_PATTERN.test(fingerprint) || basename(directory) !== record.runId) {
      throw new ObserverError("ARTIFACT_INVALID", "Finalized run receipt is invalid", 409);
    }
    const evidenceRoot = this.resolveEvidenceRoot(dirname(directory));
    const expectedDirectory = join(evidenceRoot, record.runId);
    if (comparisonPath(resolve(directory)) !== comparisonPath(resolve(expectedDirectory))) {
      throw new ObserverError("ARTIFACT_INVALID", "Finalized evidence directory is outside its configured root", 409);
    }
    this.verifyEvidenceBundle(record, evidenceRoot, expectedDirectory, fingerprint, undefined, undefined, expectedSha256);
  }

  private refreshCapture(capture: RunCaptureRecord): boolean {
    if (capture.state === "released" || capture.state === "failed" || !capture.jobId || !capture.backend) return false;
    if (capture.artifact) {
      const missing = this.missing(capture);
      if (missing && capture.state === "completed") {
        capture.state = "failed";
        capture.terminalErrorCode = "ARTIFACT_INCOMPLETE";
        capture.terminalMessage = "The retained artifact is missing";
        capture.updatedAt = new Date().toISOString();
        return true;
      }
      return false;
    }
    if (capture.backend === "runtime" && capture.sessionId) {
      try {
        capture.artifact = this.artifacts.runtimeRef(capture.sessionId, capture.jobId);
        capture.state = "completed";
        capture.updatedAt = new Date().toISOString();
        return true;
      } catch { /* artifact may not have arrived yet */ }
      try {
        const job = this.jobs.require(capture.sessionId, capture.jobId);
        if (job.state === "completed") {
          capture.state = "failed";
          capture.terminalErrorCode = "ARTIFACT_INCOMPLETE";
          capture.terminalMessage = "Completed runtime capture has no retained artifact";
          capture.updatedAt = new Date().toISOString();
          return true;
        }
        if (job.state === "failed" || job.state === "cancelled") {
          capture.state = "failed";
          capture.terminalErrorCode = job.terminalErrorCode ?? (job.state === "cancelled" ? "CANCELLED" : "CAPTURE_REJECTED");
          capture.terminalMessage = job.terminalMessage ?? `Capture ended in ${job.state}`;
          capture.updatedAt = new Date().toISOString();
          return true;
        }
      } catch { /* durable artifact recovery does not require an in-memory job */ }
    }
    return false;
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
      warnings: record.captures
        .filter((capture) => capture.performancePolicy === "instrumented")
        .map((capture) => `Capture '${capture.label}' used instrumented policy`),
      exportReceipt: record.exportReceipt ?? null,
    };
  }

  private revalidateEvidenceRoot(root: string): void {
    const expected = this.evidenceRootIdentities.get(comparisonPath(root));
    try {
      if (!expected || !existsSync(root)) throw new Error("root is unavailable");
      const entry = lstatSync(root);
      const canonical = realpathSync.native(root);
      if (entry.isSymbolicLink() || !entry.isDirectory() ||
          comparisonPath(canonical) !== comparisonPath(root) ||
          !sameFilesystemIdentity(expected, filesystemIdentity(canonical))) {
        throw new Error("root identity changed");
      }
    } catch (error) {
      throw new ObserverError(
        "ARTIFACT_INVALID",
        `Configured evidence root changed identity: ${error instanceof Error ? error.message : String(error)}`,
        409
      );
    }
  }

  private captureEvidenceOutputIdentity(evidenceRoot: string, outputRoot: string): FilesystemIdentity {
    this.revalidateEvidenceRoot(evidenceRoot);
    const expectedOutput = join(evidenceRoot, basename(outputRoot));
    if (comparisonPath(resolve(outputRoot)) !== comparisonPath(resolve(expectedOutput)) ||
        comparisonPath(dirname(resolve(outputRoot))) !== comparisonPath(resolve(evidenceRoot))) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence output is not a direct child of its configured root", 409);
    }
    const entry = lstatSync(outputRoot);
    const canonical = realpathSync.native(outputRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory() ||
        comparisonPath(canonical) !== comparisonPath(resolve(outputRoot)) ||
        comparisonPath(dirname(canonical)) !== comparisonPath(evidenceRoot)) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence output directory identity is invalid", 409);
    }
    return filesystemIdentity(canonical);
  }

  private assertEvidenceOutputIdentity(
    evidenceRoot: string,
    outputRoot: string,
    expected: FilesystemIdentity
  ): void {
    const actual = this.captureEvidenceOutputIdentity(evidenceRoot, outputRoot);
    if (!sameFilesystemIdentity(expected, actual)) {
      throw new ObserverError("ARTIFACT_INVALID", "Evidence output directory changed identity during finalization", 409);
    }
  }

  private cleanupIncompleteOutput(
    evidenceRoot: string,
    outputRoot: string,
    expected: FilesystemIdentity
  ): void {
    try {
      if (!existsSync(outputRoot)) return;
      this.assertEvidenceOutputIdentity(evidenceRoot, outputRoot, expected);
      // Refuse recursive cleanup if any member is a link or non-regular entry.
      // This leaves a manifest-less partial directory for manual review instead
      // of following attacker-controlled filesystem topology.
      listRegularFiles(outputRoot);
      this.assertEvidenceOutputIdentity(evidenceRoot, outputRoot, expected);
      rmSync(outputRoot, { recursive: true, force: false });
    } catch {
      // Preserve an unproven path; the original finalization error is authoritative.
    }
  }

  private approvedRoot(input: string, label: string): string {
    const source = boundedText(input, label, 32_768)!;
    assertSafeWindowsPath(source, label);
    const absolute = resolve(source);
    if (!existsSync(absolute)) throw new ObserverError("INVALID_REQUEST", `${label} does not exist`);
    if (lstatSync(absolute).isSymbolicLink()) throw new ObserverError("INVALID_REQUEST", `${label} must not be a symbolic link`);
    if (dirname(absolute) === absolute) throw new ObserverError("INVALID_REQUEST", `${label} must not be a filesystem root`);
    return canonicalizeExistingDirectory(absolute, label);
  }

  private resolveEvidenceRoot(input: string): string {
    if (this.evidenceRoots.length === 0) throw new ObserverError("INVALID_REQUEST", "No observer evidence roots are configured", 409);
    assertSafeWindowsPath(input, "Evidence root");
    const absolute = resolve(input);
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) throw new ObserverError("INVALID_REQUEST", "Evidence root is not an existing regular directory");
    const canonical = canonicalizeExistingDirectory(absolute, "Evidence root");
    const approved = this.evidenceRoots.find((root) => comparisonPath(root) === comparisonPath(canonical));
    if (!approved) throw new ObserverError("INVALID_REQUEST", "Evidence root is not in the configured allowlist", 403);
    this.revalidateEvidenceRoot(approved);
    return approved;
  }

  private resolveSupportingFile(input: string): string {
    assertSafeWindowsPath(input, "Supporting log path");
    const absolute = resolve(input);
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
      throw new ObserverError("INVALID_REQUEST", "Supporting log is not a regular file");
    }
    const canonical = realpathSync.native(absolute);
    const roots = [...this.supportingLogRoots];
    if (!roots.some((root) => contained(root, canonical))) {
      throw new ObserverError("INVALID_REQUEST", "Supporting log is outside configured supporting log roots", 403);
    }
    return canonical;
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
    const root = this.rootFor(runId);
    if (!existsSync(root)) throw new ObserverError("INVALID_REQUEST", "Observer run was not found", 404);
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new ObserverError("INVALID_REQUEST", "Observer run path is invalid", 409);
    const path = assertRegularManagedFile(root, join(root, "run.json"));
    const bytes = readFileSync(path);
    if (bytes.length > 2 * 1024 * 1024) throw new ObserverError("INVALID_REQUEST", "Observer run record is too large", 409);
    const record = JSON.parse(bytes.toString("utf8")) as ObserverRunRecord;
    this.assertRecord(record, runId);
    return record;
  }

  private records(): ObserverRunRecord[] {
    const result: ObserverRunRecord[] = [];
    for (const entry of readdirSync(this.runsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID_PATTERN.test(entry.name)) continue;
      try { result.push(this.require(entry.name)); } catch { /* preserve malformed records for manual review */ }
    }
    return result;
  }

  private write(record: ObserverRunRecord): void {
    const root = this.rootFor(record.runId);
    ensureCanonicalDirectory(root);
    atomicWriteJson(root, join(root, "run.json"), record);
  }

  private assertRecord(record: ObserverRunRecord, expectedRunId: string): void {
    if (!record || record.version !== RUN_RECORD_VERSION || record.runId !== expectedRunId ||
        !["open", "finalized", "expired"].includes(record.state) || !Array.isArray(record.captures) ||
        typeof record.title !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") {
      throw new ObserverError("INVALID_REQUEST", "Observer run record is invalid", 409);
    }
  }

  private assertRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) throw new ObserverError("INVALID_REQUEST", "Observer run ID is invalid");
  }
}
