import { randomUUID } from "node:crypto";
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
import { sha256File, sha256Hex } from "#foundation/digest";
import { BoundedJsonStore, JsonStoreError } from "#foundation/json-store";
import { canonicalizePotentialPath } from "#foundation/managed-path";
import { redactText } from "#foundation/redact";
import { AGENT_VERSION, DEFAULT_LIMITS, PROTOCOL_VERSION, SHA256_PATTERN } from "../protocol/index.js";
import type { ManagedArtifactRef } from "./artifacts.js";
import { ObserverError } from "./errors.js";
import {
  assertRegularManagedFile,
  atomicWriteFile,
  atomicWriteJson,
  canonicalizeExistingDirectory,
  ensureCanonicalDirectory,
  listRegularFiles,
} from "./paths.js";

const MANIFEST_VERSION = 1;
const MAX_SUPPORTING_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SUPPORTING_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RUNTIME_CONFIG_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MEMBER_BYTES = DEFAULT_LIMITS.maxArtifactBytes;
const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const SECRET_KEY_PATTERN = /(authorization|bearer|credential|password|secret|token|private.?key)/i;
const MEMBER_PATTERN = /^[A-Za-z0-9._/-]{1,512}$/;

interface FilesystemIdentity { dev: bigint; ino: bigint }
interface BundleFile { path: string; bytes: number; sha256: string }

export interface ObserverRunReview {
  imagesReviewed: boolean;
  reviewer?: string;
  outcome: "Passed" | "Failed" | "Inconclusive" | "Unreviewed";
  summary: string;
  limitations?: string[];
}

export interface EvidenceBundleFinalizeInput {
  runId: string;
  evidenceRoot: string;
  includeCaptureLabels: string[];
  review: ObserverRunReview;
  runtimeConfig?: { configurationId: string; values: Record<string, unknown> };
  supportingFiles?: Array<{ kind: "relevantLog"; label: string; path: string }>;
  releaseManagedArtifacts?: boolean;
}

export interface EvidenceCaptureSnapshot extends Record<string, unknown> {
  label: string;
  state: string;
  backend?: "runtime" | "workbench";
  jobId?: string;
  instanceId?: string;
  worldId?: string | null;
  worldEpoch?: number;
  requestedView: Record<string, unknown>;
  performancePolicy: "evidence" | "instrumented";
  artifact?: ManagedArtifactRef;
}

export interface EvidenceArtifactSnapshot {
  captureLabel: string;
  image?: Buffer;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface EvidenceRunExportSnapshot {
  run: Readonly<{
    runId: string;
    title: string;
    caseIds: readonly string[];
    createdAt: string;
    sourceRevision?: string;
    procedureRevision?: string;
  }>;
  captures: readonly Readonly<EvidenceCaptureSnapshot>[];
  artifacts: readonly Readonly<EvidenceArtifactSnapshot>[];
}

export interface PreparedEvidenceExport {
  readonly fingerprint: string;
  readonly evidenceRoot: string;
  readonly outputRoot: string;
  readonly input: Readonly<EvidenceBundleFinalizeInput>;
  readonly includeCaptureLabels: readonly string[];
  readonly releaseManagedArtifacts: boolean;
}

export interface EvidenceExportReceipt extends Record<string, unknown> {
  runId: string;
  evidenceDirectory: string;
  manifestSha256: string;
  captureCount: number;
  supportingFileCount: number;
  finalizedAt: string;
  managedArtifactsReleased: boolean;
  recovered?: boolean;
}

export interface EvidenceBundleService {
  prepare(input: EvidenceBundleFinalizeInput): PreparedEvidenceExport;
  export(snapshot: EvidenceRunExportSnapshot, prepared: PreparedEvidenceExport): EvidenceExportReceipt;
  verifyReceipt(snapshot: EvidenceRunExportSnapshot, receipt: EvidenceExportReceipt, fingerprint: string): void;
  sweepWork(now: number, maxAgeMs: number): string[];
  diagnostics(): Record<string, unknown>;
}

function comparisonPath(value: string): string { return value.toLowerCase(); }
function contained(root: string, candidate: string): boolean {
  const value = relative(comparisonPath(root), comparisonPath(candidate));
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}
function identity(path: string): FilesystemIdentity {
  const info = statSync(path, { bigint: true });
  return { dev: info.dev, ino: info.ino };
}
function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function assertWindowsPath(value: string, label: string): void {
  if (/^\\\\[.?]\\/.test(value) || value.slice(2).includes(":")) {
    throw new ObserverError("INVALID_REQUEST", `${label} uses a device path or alternate data stream`);
  }
}
function boundedText(value: unknown, label: string, maximum: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ObserverError("INVALID_REQUEST", `${label} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value.trim();
}
export function normalizeEvidenceLabel(value: string, label = "Capture label"): string {
  const source = boundedText(value, label, 128)!;
  const normalized = source.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 96);
  if (!normalized || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(normalized)) throw new ObserverError("INVALID_REQUEST", `${label} cannot be normalized to a safe evidence filename`);
  return normalized;
}
function assertNoSecrets(value: unknown, path = "runtimeConfig"): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new ObserverError("INVALID_REQUEST", `${path}.${key} looks secret-bearing and cannot be exported`);
    assertNoSecrets(item, `${path}.${key}`);
  }
}
function presentation(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
function markdown(value: unknown): string { return presentation(value).replace(/([\\`*_[\]{}()#+.!|<>-])/g, "\\$1"); }
function safeMember(value: unknown): value is string {
  return typeof value === "string" && MEMBER_PATTERN.test(value) && !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export class FileEvidenceBundleService implements EvidenceBundleService {
  readonly exportWorkRoot: string;
  readonly evidenceRoots: readonly string[];
  readonly supportingLogRoots: readonly string[];
  private readonly evidenceIdentities = new Map<string, FilesystemIdentity>();

  constructor(exportWorkRoot: string, evidenceRoots: readonly string[], supportingLogRoots: readonly string[] = []) {
    if (evidenceRoots.length === 0) throw new ObserverError("CAPABILITY_UNAVAILABLE", "Evidence bundle service requires at least one evidence root", 409);
    this.exportWorkRoot = ensureCanonicalDirectory(exportWorkRoot);
    this.evidenceRoots = evidenceRoots.map((root) => this.approvedEvidenceRoot(root));
    this.supportingLogRoots = supportingLogRoots.map((root) => this.approvedRoot(root, "Supporting log root"));
    for (const root of this.evidenceRoots) {
      if (existsSync(root)) {
        this.evidenceIdentities.set(comparisonPath(root), identity(root));
      }
    }
  }

  prepare(input: EvidenceBundleFinalizeInput): PreparedEvidenceExport {
    if (!RUN_ID_PATTERN.test(input.runId)) throw new ObserverError("INVALID_REQUEST", "Observer run ID is invalid");
    if (!Array.isArray(input.includeCaptureLabels) || input.includeCaptureLabels.length < 1 || input.includeCaptureLabels.length > 64) {
      throw new ObserverError("INVALID_REQUEST", "includeCaptureLabels must contain from 1 through 64 labels");
    }
    const labels = input.includeCaptureLabels.map((label) => normalizeEvidenceLabel(label));
    if (new Set(labels).size !== labels.length) throw new ObserverError("INVALID_REQUEST", "includeCaptureLabels contains duplicate normalized labels");
    const review = input.review;
    if (!review || typeof review !== "object" || typeof review.imagesReviewed !== "boolean" || !["Passed", "Failed", "Inconclusive", "Unreviewed"].includes(review.outcome)) {
      throw new ObserverError("INVALID_REQUEST", "Review state or outcome is invalid");
    }
    const reviewer = boundedText(review.reviewer, "Reviewer", 256, false);
    if (review.imagesReviewed && !reviewer) throw new ObserverError("INVALID_REQUEST", "An image-capable reviewer identity is required when imagesReviewed is true");
    if (!review.imagesReviewed && !["Unreviewed", "Inconclusive"].includes(review.outcome)) throw new ObserverError("INVALID_REQUEST", "Unreviewed images may only have Unreviewed or Inconclusive outcome");
    if (review.imagesReviewed && review.outcome === "Unreviewed") throw new ObserverError("INVALID_REQUEST", "Reviewed images cannot have an Unreviewed outcome");
    const limitations = review.limitations ?? [];
    if (!Array.isArray(limitations) || limitations.length > 32) throw new ObserverError("INVALID_REQUEST", "Review limitations must contain at most 32 entries");
    let runtimeConfig = input.runtimeConfig;
    if (runtimeConfig) {
      if (!runtimeConfig.values || typeof runtimeConfig.values !== "object" || Array.isArray(runtimeConfig.values)) throw new ObserverError("INVALID_REQUEST", "runtimeConfig.values must be an object");
      assertNoSecrets(runtimeConfig.values);
      runtimeConfig = { configurationId: boundedText(runtimeConfig.configurationId, "Runtime configuration ID", 128)!, values: runtimeConfig.values };
      if (Buffer.byteLength(JSON.stringify(runtimeConfig)) > MAX_RUNTIME_CONFIG_BYTES) throw new ObserverError("INVALID_REQUEST", "Runtime configuration snapshot is too large");
    }
    const supporting = input.supportingFiles ?? [];
    if (!Array.isArray(supporting) || supporting.length > 16) throw new ObserverError("INVALID_REQUEST", "supportingFiles must contain at most 16 entries");
    const normalizedSupporting = supporting.map((file) => {
      if (file.kind !== "relevantLog") throw new ObserverError("INVALID_REQUEST", "Only relevantLog supporting files are allowed");
      return { kind: file.kind, label: normalizeEvidenceLabel(file.label, "Supporting file label"), path: boundedText(file.path, "Supporting file path", 32_768)! };
    });
    if (new Set(normalizedSupporting.map((file) => file.label)).size !== normalizedSupporting.length) throw new ObserverError("INVALID_REQUEST", "supportingFiles contains duplicate normalized labels");
    const normalized: EvidenceBundleFinalizeInput = {
      runId: input.runId,
      evidenceRoot: boundedText(input.evidenceRoot, "Evidence root", 32_768)!,
      includeCaptureLabels: labels,
      review: {
        imagesReviewed: review.imagesReviewed,
        ...(reviewer ? { reviewer } : {}),
        outcome: review.outcome,
        summary: boundedText(review.summary, "Review summary", 2_048)!,
        ...(limitations.length ? { limitations: limitations.map((value) => boundedText(value, "Review limitation", 512)!) } : {}),
      },
      ...(runtimeConfig ? { runtimeConfig } : {}),
      ...(normalizedSupporting.length ? { supportingFiles: normalizedSupporting } : {}),
      releaseManagedArtifacts: input.releaseManagedArtifacts !== false,
    };
    const evidenceRoot = this.resolveEvidenceRoot(normalized.evidenceRoot);
    return {
      fingerprint: sha256Hex(JSON.stringify(normalized)),
      evidenceRoot,
      outputRoot: join(evidenceRoot, input.runId),
      input: normalized,
      includeCaptureLabels: labels,
      releaseManagedArtifacts: normalized.releaseManagedArtifacts === true,
    };
  }

  export(snapshot: EvidenceRunExportSnapshot, prepared: PreparedEvidenceExport): EvidenceExportReceipt {
    this.assertSnapshot(snapshot, prepared.input.runId);
    this.activateEvidenceRoot(prepared.evidenceRoot);
    if (existsSync(prepared.outputRoot)) {
      try {
        const verified = this.verifyBundle(snapshot, prepared.outputRoot, prepared.evidenceRoot, prepared.fingerprint, prepared.input, prepared.includeCaptureLabels);
        return this.receipt(snapshot.run.runId, prepared.outputRoot, verified.manifestSha256, verified.manifest, true);
      } catch {
        throw new ObserverError("INVALID_REQUEST", "Evidence output already exists and will not be overwritten", 409);
      }
    }
    const selected = prepared.includeCaptureLabels.map((label) => {
      const capture = snapshot.captures.find((item) => item.label === label);
      if (!capture) throw new ObserverError("INVALID_REQUEST", `Run has no capture labeled '${label}'`, 404);
      if (capture.state !== "completed" || !capture.artifact) throw new ObserverError("ARTIFACT_INCOMPLETE", `Capture '${label}' has no retained completed artifact`, 409);
      const artifact = snapshot.artifacts.find((item) => item.captureLabel === label);
      if (!artifact?.image || !artifact.metadata) throw new ObserverError("ARTIFACT_INCOMPLETE", `Capture '${label}' has no retained completed artifact`, 409);
      return { capture, artifact };
    });
    const workRoot = join(this.exportWorkRoot, `${snapshot.run.runId}-${randomUUID()}`);
    mkdirSync(workRoot, { mode: 0o700 });
    let outputCreated = false;
    let outputCommitted = false;
    let outputIdentity: FilesystemIdentity | null = null;
    try {
      const captures: Array<Record<string, unknown>> = [];
      for (const { capture, artifact } of selected) {
        const imagePath = `captures/${capture.label}.png`;
        const metadataPath = `captures/${capture.label}.json`;
        atomicWriteFile(workRoot, join(workRoot, imagePath), artifact.image!);
        const item = this.captureManifest(capture, artifact.metadata!, imagePath, metadataPath);
        atomicWriteJson(workRoot, join(workRoot, metadataPath), item);
        captures.push(item);
      }
      const supportingFiles = this.copySupportingFiles(workRoot, prepared.input.supportingFiles);
      if (prepared.input.runtimeConfig) atomicWriteJson(workRoot, join(workRoot, "runtime-config.json"), prepared.input.runtimeConfig);
      const finalizedAt = new Date().toISOString();
      const manifestBase = {
        manifestVersion: MANIFEST_VERSION,
        runId: snapshot.run.runId,
        title: snapshot.run.title,
        caseIds: [...snapshot.run.caseIds],
        createdAt: snapshot.run.createdAt,
        finalizedAt,
        sourceRevision: snapshot.run.sourceRevision ?? null,
        procedureRevision: snapshot.run.procedureRevision ?? null,
        review: prepared.input.review,
        versions: { observerProtocol: PROTOCOL_VERSION, observerAgent: AGENT_VERSION },
        captures,
        supportingFiles,
        runtimeConfig: prepared.input.runtimeConfig ? { supplied: true, path: "runtime-config.json" } : { supplied: false },
        relevantLogs: supportingFiles.length ? { supplied: true } : { supplied: false },
        export: { completionMarker: "manifest.json", requestSha256: prepared.fingerprint, managedArtifactsReleased: prepared.releaseManagedArtifacts },
      };
      atomicWriteFile(workRoot, join(workRoot, "RESULT.md"), this.resultMarkdown(manifestBase));
      const manifest = { ...manifestBase, files: this.hashMembers(workRoot) };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      atomicWriteFile(workRoot, join(workRoot, "manifest.json"), manifestBytes);
      this.revalidateEvidenceRoot(prepared.evidenceRoot);
      mkdirSync(prepared.outputRoot, { mode: 0o755 });
      outputCreated = true;
      outputIdentity = this.captureOutputIdentity(prepared.evidenceRoot, prepared.outputRoot);
      for (const relativePath of listRegularFiles(workRoot).filter((path) => path !== "manifest.json")) {
        this.assertOutputIdentity(prepared.evidenceRoot, prepared.outputRoot, outputIdentity);
        const source = assertRegularManagedFile(workRoot, join(workRoot, ...relativePath.split("/")));
        atomicWriteFile(prepared.outputRoot, join(prepared.outputRoot, ...relativePath.split("/")), readFileSync(source), 0o644);
      }
      this.assertOutputIdentity(prepared.evidenceRoot, prepared.outputRoot, outputIdentity);
      atomicWriteFile(prepared.outputRoot, join(prepared.outputRoot, "manifest.json"), manifestBytes, 0o644);
      const verified = this.verifyBundle(snapshot, prepared.outputRoot, prepared.evidenceRoot, prepared.fingerprint, prepared.input, prepared.includeCaptureLabels, sha256Hex(manifestBytes));
      outputCommitted = true;
      return this.receipt(snapshot.run.runId, prepared.outputRoot, verified.manifestSha256, verified.manifest, false);
    } catch (error) {
      if (outputCreated && !outputCommitted && outputIdentity) this.cleanupIncomplete(prepared.evidenceRoot, prepared.outputRoot, outputIdentity);
      throw error;
    } finally {
      if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
    }
  }

  verifyReceipt(snapshot: EvidenceRunExportSnapshot, receipt: EvidenceExportReceipt, fingerprint: string): void {
    if (!SHA256_PATTERN.test(receipt.manifestSha256) || basename(receipt.evidenceDirectory) !== snapshot.run.runId) throw new ObserverError("ARTIFACT_INVALID", "Finalized run receipt is invalid", 409);
    const root = this.resolveEvidenceRoot(dirname(receipt.evidenceDirectory));
    if (comparisonPath(resolve(receipt.evidenceDirectory)) !== comparisonPath(resolve(join(root, snapshot.run.runId)))) throw new ObserverError("ARTIFACT_INVALID", "Finalized evidence directory is outside its configured root", 409);
    this.verifyBundle(snapshot, receipt.evidenceDirectory, root, fingerprint, undefined, undefined, receipt.manifestSha256);
  }

  sweepWork(now: number, maxAgeMs: number): string[] {
    const removed: string[] = [];
    for (const entry of readdirSync(this.exportWorkRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(this.exportWorkRoot, entry.name);
      if (now - statSync(path).mtimeMs <= maxAgeMs) continue;
      rmSync(path, { recursive: true, force: false });
      removed.push(entry.name);
    }
    return removed;
  }

  diagnostics(): Record<string, unknown> {
    return { enabled: true, evidenceRootCount: this.evidenceRoots.length, supportingLogRootCount: this.supportingLogRoots.length };
  }

  private receipt(runId: string, outputRoot: string, manifestSha256: string, manifest: Record<string, unknown>, recovered: boolean): EvidenceExportReceipt {
    return {
      runId,
      evidenceDirectory: outputRoot,
      manifestSha256,
      captureCount: Array.isArray(manifest.captures) ? manifest.captures.length : 0,
      supportingFileCount: Array.isArray(manifest.supportingFiles) ? manifest.supportingFiles.length : 0,
      finalizedAt: String(manifest.finalizedAt),
      managedArtifactsReleased: (manifest.export as Record<string, unknown>).managedArtifactsReleased === true,
      ...(recovered ? { recovered: true } : {}),
    };
  }

  private captureManifest(capture: Readonly<EvidenceCaptureSnapshot>, metadata: Readonly<Record<string, unknown>>, imagePath: string, metadataPath: string): Record<string, unknown> {
    const ref = capture.artifact!;
    const warnings = Array.isArray(metadata.warnings) ? metadata.warnings.filter((value): value is string => typeof value === "string").slice(0, 16) : [];
    if (capture.performancePolicy === "instrumented" && !warnings.some((warning) => /instrumented/i.test(warning))) warnings.push("Capture used the instrumented performance policy");
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

  private resultMarkdown(manifest: { runId: string; title: string; caseIds: readonly string[]; review: ObserverRunReview; captures: Array<Record<string, unknown>>; supportingFiles: Array<Record<string, unknown>> }): string {
    const lines = [
      `# ${markdown(manifest.title)}`, "", `- Run: \`${manifest.runId}\``, `- Outcome: **${manifest.review.outcome}**`,
      `- Images reviewed: ${manifest.review.imagesReviewed ? "yes" : "no"}`, `- Reviewer: ${markdown(manifest.review.reviewer ?? "not supplied")}`,
      `- Cases: ${manifest.caseIds.length ? manifest.caseIds.map(markdown).join(", ") : "not supplied"}`, "", markdown(manifest.review.summary), "", "## Captures", "",
      ...manifest.captures.map((capture) => `- [${markdown(capture.label)}](./${capture.imagePath})${capture.contaminated ? " — contaminated/instrumented" : ""}`),
    ];
    if (manifest.supportingFiles.length) lines.push("", "## Supporting evidence", "", ...manifest.supportingFiles.map((file) => `- [${markdown(file.label)}](./${file.path})`));
    if (manifest.review.limitations?.length) lines.push("", "## Limitations", "", ...manifest.review.limitations.map((value) => `- ${markdown(value)}`));
    return `${lines.join("\n")}\n`;
  }

  private copySupportingFiles(workRoot: string, files: EvidenceBundleFinalizeInput["supportingFiles"]): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const file of files ?? []) {
      const canonical = this.resolveSupportingFile(file.path);
      const descriptor = openSync(canonical, "r");
      let bytes: Buffer;
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.size > MAX_SUPPORTING_FILE_BYTES || total + opened.size > MAX_SUPPORTING_TOTAL_BYTES) throw new ObserverError("INVALID_REQUEST", "Relevant log attachments exceed the evidence size limit");
        const pathEntry = lstatSync(canonical);
        const currentCanonical = realpathSync.native(canonical);
        const current = statSync(currentCanonical);
        if (pathEntry.isSymbolicLink() || !pathEntry.isFile() || comparisonPath(currentCanonical) !== comparisonPath(canonical) || opened.dev !== current.dev || opened.ino !== current.ino) throw new ObserverError("INVALID_REQUEST", "Relevant log attachment changed identity while it was opened", 409);
        bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (bytes.length !== opened.size || after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new ObserverError("INVALID_REQUEST", "Relevant log attachment changed while it was read", 409);
      } finally { closeSync(descriptor); }
      total += bytes.length;
      if (bytes.includes(0)) throw new ObserverError("INVALID_REQUEST", "Relevant log attachments must be text files");
      const filtered = Buffer.from(redactText(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { profile: "diagnostic" }), "utf8");
      const path = `relevant-logs/${file.label}.log`;
      atomicWriteFile(workRoot, join(workRoot, path), filtered);
      result.push({ kind: "relevantLog", label: file.label, path, bytes: filtered.length, sha256: sha256Hex(filtered) });
    }
    return result;
  }

  private hashMembers(root: string): BundleFile[] {
    return listRegularFiles(root).filter((path) => path !== "manifest.json").sort((a, b) => a.localeCompare(b)).map((relativePath) => {
      const path = assertRegularManagedFile(root, join(root, ...relativePath.split("/")));
      const bytes = lstatSync(path).size;
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_MEMBER_BYTES) throw new ObserverError("ARTIFACT_INVALID", `Evidence member exceeds its byte limit: ${relativePath}`, 409);
      return { path: relativePath, bytes, sha256: sha256File(path, { maxBytes: MAX_MEMBER_BYTES }) };
    });
  }

  private readJson(root: string, path: string, maxBytes: number, invalid: string, size = invalid): { value: Record<string, unknown>; sha256: string } {
    try {
      const inspected = new BoundedJsonStore<Record<string, unknown>>({
        root, minRecordBytes: 1, maxRecordBytes: maxBytes,
        parse: (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
          return value as Record<string, unknown>;
        },
      }).inspect(path);
      if (inspected.kind !== "valid") throw new ObserverError("ARTIFACT_INVALID", invalid, 409);
      return { value: inspected.value, sha256: inspected.sha256 };
    } catch (error) {
      if (error instanceof ObserverError) throw error;
      if (error instanceof JsonStoreError && ["RECORD_TOO_SMALL", "RECORD_TOO_LARGE"].includes(error.code)) throw new ObserverError("ARTIFACT_INVALID", size, 409);
      throw new ObserverError("ARTIFACT_INVALID", invalid, 409);
    }
  }

  private parseFiles(manifest: Record<string, unknown>): BundleFile[] {
    if (!Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 256) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest has no bounded member attestation list", 409);
    const seen = new Set<string>();
    const files = manifest.files.map((raw): BundleFile => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest contains an invalid member attestation", 409);
      const item = raw as Record<string, unknown>;
      if (!safeMember(item.path) || item.path === "manifest.json" || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0 || typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256)) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest contains an unsafe member attestation", 409);
      const key = item.path.toLowerCase();
      if (seen.has(key)) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest repeats a member path", 409);
      seen.add(key);
      return { path: item.path, bytes: item.bytes as number, sha256: item.sha256 };
    });
    if (!isDeepStrictEqual(files, [...files].sort((a, b) => a.path.localeCompare(b.path)))) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest member attestations are not canonical", 409);
    return files;
  }

  private verifyBundle(
    snapshot: EvidenceRunExportSnapshot,
    outputRoot: string,
    evidenceRoot: string,
    fingerprint: string,
    expectedInput?: Readonly<EvidenceBundleFinalizeInput>,
    expectedLabels?: readonly string[],
    expectedManifestSha256?: string,
  ): { manifest: Record<string, unknown>; manifestSha256: string } {
    try {
      const outputIdentity = this.captureOutputIdentity(evidenceRoot, outputRoot);
      const manifestRecord = this.readJson(outputRoot, join(outputRoot, "manifest.json"), MAX_MANIFEST_BYTES, "Evidence manifest root is invalid", "Evidence manifest size is invalid");
      if (expectedManifestSha256 && manifestRecord.sha256 !== expectedManifestSha256) throw new ObserverError("ARTIFACT_INVALID", "Finalized evidence manifest no longer matches its receipt", 409);
      const manifest = manifestRecord.value;
      const exportRecord = manifest.export;
      if (manifest.manifestVersion !== MANIFEST_VERSION || manifest.runId !== snapshot.run.runId || !exportRecord || typeof exportRecord !== "object" || Array.isArray(exportRecord) || (exportRecord as Record<string, unknown>).requestSha256 !== fingerprint || (exportRecord as Record<string, unknown>).completionMarker !== "manifest.json" || typeof (exportRecord as Record<string, unknown>).managedArtifactsReleased !== "boolean") throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest is not bound to this finalize request", 409);
      if (manifest.title !== snapshot.run.title || !isDeepStrictEqual(manifest.caseIds, [...snapshot.run.caseIds]) || manifest.sourceRevision !== (snapshot.run.sourceRevision ?? null) || manifest.procedureRevision !== (snapshot.run.procedureRevision ?? null) || typeof manifest.finalizedAt !== "string") throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest run metadata does not match its managed run", 409);
      if (!manifest.review || typeof manifest.review !== "object" || Array.isArray(manifest.review) || !Array.isArray(manifest.captures) || !Array.isArray(manifest.supportingFiles)) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest payload sections are invalid", 409);
      if (expectedInput && (!isDeepStrictEqual(manifest.review, expectedInput.review) || (exportRecord as Record<string, unknown>).managedArtifactsReleased !== expectedInput.releaseManagedArtifacts)) throw new ObserverError("ARTIFACT_INVALID", "Recovered evidence review does not match the finalize request", 409);
      const files = this.parseFiles(manifest);
      const actualPaths = listRegularFiles(outputRoot).sort((a, b) => a.localeCompare(b));
      const expectedPaths = [...files.map((file) => file.path), "manifest.json"].sort((a, b) => a.localeCompare(b));
      if (!isDeepStrictEqual(actualPaths, expectedPaths)) throw new ObserverError("ARTIFACT_INVALID", "Evidence directory has missing or unmanifested members", 409);
      for (const file of files) {
        this.assertOutputIdentity(evidenceRoot, outputRoot, outputIdentity);
        const path = assertRegularManagedFile(outputRoot, join(outputRoot, ...file.path.split("/")));
        if (file.bytes > MAX_MEMBER_BYTES || lstatSync(path).size !== file.bytes || sha256File(path, { maxBytes: MAX_MEMBER_BYTES }) !== file.sha256) throw new ObserverError("ARTIFACT_INVALID", `Evidence member no longer matches its attestation: ${file.path}`, 409);
      }
      this.verifyPayload(snapshot, outputRoot, manifest, files, expectedInput, expectedLabels);
      this.assertOutputIdentity(evidenceRoot, outputRoot, outputIdentity);
      return { manifest, manifestSha256: manifestRecord.sha256 };
    } catch (error) {
      if (error instanceof ObserverError) throw error;
      throw new ObserverError("ARTIFACT_INVALID", `Evidence bundle verification failed: ${error instanceof Error ? error.message : String(error)}`, 409);
    }
  }

  private verifyPayload(snapshot: EvidenceRunExportSnapshot, outputRoot: string, manifest: Record<string, unknown>, files: BundleFile[], input?: Readonly<EvidenceBundleFinalizeInput>, expectedLabels?: readonly string[]): void {
    const captures = manifest.captures as unknown[];
    const labels = expectedLabels ?? captures.map((raw) => String((raw as Record<string, unknown>).label));
    if (captures.length !== labels.length) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest capture set is incomplete", 409);
    const members = new Map(files.map((file) => [file.path, file]));
    const required = new Set<string>(["RESULT.md"]);
    for (let index = 0; index < labels.length; index += 1) {
      const capture = snapshot.captures.find((item) => item.label === labels[index]);
      const raw = captures[index];
      if (!capture?.artifact || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest references an unknown run capture", 409);
      const item = raw as Record<string, unknown>;
      const imagePath = `captures/${capture.label}.png`;
      const metadataPath = `captures/${capture.label}.json`;
      const ref = capture.artifact;
      if (item.label !== capture.label || item.imagePath !== imagePath || item.metadataPath !== metadataPath || item.backend !== capture.backend || item.jobId !== capture.jobId || item.instanceId !== capture.instanceId || item.worldId !== (capture.worldId ?? null) || item.worldEpoch !== capture.worldEpoch || !isDeepStrictEqual(item.requestedView, capture.requestedView) || item.width !== ref.width || item.height !== ref.height || item.bytes !== ref.bytes || item.sha256 !== ref.sha256) throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' is not bound to its managed artifact`, 409);
      const image = members.get(imagePath);
      if (!image || image.bytes !== ref.bytes || image.sha256 !== ref.sha256) throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' image attestation is invalid`, 409);
      const metadata = members.get(metadataPath);
      if (!metadata) throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' metadata is missing`, 409);
      const metadataValue = this.readJson(outputRoot, join(outputRoot, ...metadataPath.split("/")), MAX_MANIFEST_BYTES, `Evidence capture '${capture.label}' metadata does not match its manifest`).value;
      if (!isDeepStrictEqual(metadataValue, item)) throw new ObserverError("ARTIFACT_INVALID", `Evidence capture '${capture.label}' metadata does not match its manifest`, 409);
      required.add(imagePath); required.add(metadataPath);
    }
    const supporting = manifest.supportingFiles as unknown[];
    const expectedSupporting = input?.supportingFiles ?? [];
    if (input && supporting.length !== expectedSupporting.length) throw new ObserverError("ARTIFACT_INVALID", "Recovered supporting evidence does not match the finalize request", 409);
    supporting.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest contains an invalid supporting member", 409);
      const item = raw as Record<string, unknown>;
      const expected = expectedSupporting[index];
      const path = expected ? `relevant-logs/${expected.label}.log` : `relevant-logs/${item.label}.log`;
      if (item.kind !== "relevantLog" || !safeMember(item.path) || item.path !== path || (expected && item.label !== expected.label)) throw new ObserverError("ARTIFACT_INVALID", "Evidence supporting member is not bound to the finalize request", 409);
      const member = members.get(item.path);
      if (!member || item.bytes !== member.bytes || item.sha256 !== member.sha256) throw new ObserverError("ARTIFACT_INVALID", `Evidence supporting member attestation is invalid: ${item.path}`, 409);
      required.add(item.path);
    });
    const runtime = manifest.runtimeConfig;
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) throw new ObserverError("ARTIFACT_INVALID", "Evidence runtime configuration descriptor is invalid", 409);
    const runtimeSupplied = (runtime as Record<string, unknown>).supplied === true;
    if (runtimeSupplied) {
      if ((runtime as Record<string, unknown>).path !== "runtime-config.json" || !members.has("runtime-config.json")) throw new ObserverError("ARTIFACT_INVALID", "Evidence runtime configuration member is invalid", 409);
      const value = this.readJson(outputRoot, join(outputRoot, "runtime-config.json"), MAX_RUNTIME_CONFIG_BYTES, "Recovered runtime configuration does not match the finalize request").value;
      if (input?.runtimeConfig && !isDeepStrictEqual(value, input.runtimeConfig)) throw new ObserverError("ARTIFACT_INVALID", "Recovered runtime configuration does not match the finalize request", 409);
      required.add("runtime-config.json");
    }
    if (input && runtimeSupplied !== (input.runtimeConfig !== undefined)) throw new ObserverError("ARTIFACT_INVALID", "Recovered runtime configuration presence does not match the finalize request", 409);
    if (required.size !== files.length || [...required].some((path) => !members.has(path))) throw new ObserverError("ARTIFACT_INVALID", "Evidence manifest attests an unexpected payload member set", 409);
    const expectedResult = this.resultMarkdown({ runId: snapshot.run.runId, title: snapshot.run.title, caseIds: snapshot.run.caseIds, review: manifest.review as ObserverRunReview, captures: captures as Array<Record<string, unknown>>, supportingFiles: supporting as Array<Record<string, unknown>> });
    if (readFileSync(assertRegularManagedFile(outputRoot, join(outputRoot, "RESULT.md")), "utf8") !== expectedResult) throw new ObserverError("ARTIFACT_INVALID", "Evidence RESULT.md does not match its manifest", 409);
  }

  private approvedRoot(input: string, label: string): string {
    const source = boundedText(input, label, 32_768)!;
    assertWindowsPath(source, label);
    const absolute = resolve(source);
    if (!existsSync(absolute)) throw new ObserverError("INVALID_REQUEST", `${label} does not exist`);
    if (lstatSync(absolute).isSymbolicLink()) throw new ObserverError("INVALID_REQUEST", `${label} must not be a symbolic link`);
    if (dirname(absolute) === absolute) throw new ObserverError("INVALID_REQUEST", `${label} must not be a filesystem root`);
    return canonicalizeExistingDirectory(absolute, label);
  }
  private approvedEvidenceRoot(input: string): string {
    const source = boundedText(input, "Evidence root", 32_768)!;
    assertWindowsPath(source, "Evidence root");
    const absolute = resolve(source);
    if (dirname(absolute) === absolute) {
      throw new ObserverError("INVALID_REQUEST", "Evidence root must not be a filesystem root");
    }
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      throw new ObserverError("INVALID_REQUEST", "Evidence root must not be a symbolic link");
    }
    try {
      return canonicalizePotentialPath(absolute, {
        linkPolicy: "follow-existing",
        existingAncestor: "directory",
        label: "Evidence root",
      });
    } catch (error) {
      throw new ObserverError(
        "INVALID_REQUEST",
        `Evidence root is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  private resolveEvidenceRoot(input: string): string {
    assertWindowsPath(input, "Evidence root");
    const candidate = this.approvedEvidenceRoot(input);
    const approved = this.evidenceRoots.find((root) => comparisonPath(root) === comparisonPath(candidate));
    if (!approved) throw new ObserverError("INVALID_REQUEST", "Evidence root is not in the configured allowlist", 403);
    if (existsSync(approved)) {
      const key = comparisonPath(approved);
      if (!this.evidenceIdentities.has(key)) {
        this.evidenceIdentities.set(key, identity(approved));
      }
      this.revalidateEvidenceRoot(approved);
    }
    return approved;
  }
  private activateEvidenceRoot(root: string): void {
    const approved = this.evidenceRoots.find(
      (candidate) => comparisonPath(candidate) === comparisonPath(root)
    );
    if (!approved) {
      throw new ObserverError("INVALID_REQUEST", "Evidence root is not in the configured allowlist", 403);
    }
    const prospective = this.approvedEvidenceRoot(approved);
    if (comparisonPath(prospective) !== comparisonPath(approved)) {
      throw new ObserverError("ARTIFACT_INVALID", "Configured evidence root changed before creation", 409);
    }
    if (!existsSync(approved)) {
      mkdirSync(approved, { recursive: true, mode: 0o755 });
    }
    if (lstatSync(approved).isSymbolicLink()) {
      throw new ObserverError("ARTIFACT_INVALID", "Configured evidence root became a symbolic link", 409);
    }
    const canonical = canonicalizeExistingDirectory(approved, "Evidence root");
    if (comparisonPath(canonical) !== comparisonPath(approved)) {
      throw new ObserverError("ARTIFACT_INVALID", "Configured evidence root changed during creation", 409);
    }
    const key = comparisonPath(approved);
    const currentIdentity = identity(canonical);
    const expectedIdentity = this.evidenceIdentities.get(key);
    if (expectedIdentity && !sameIdentity(expectedIdentity, currentIdentity)) {
      throw new ObserverError("ARTIFACT_INVALID", "Configured evidence root changed identity", 409);
    }
    this.evidenceIdentities.set(key, currentIdentity);
    this.revalidateEvidenceRoot(approved);
  }
  private resolveSupportingFile(input: string): string {
    assertWindowsPath(input, "Supporting log path");
    const absolute = resolve(input);
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) throw new ObserverError("INVALID_REQUEST", "Supporting log is not a regular file");
    const canonical = realpathSync.native(absolute);
    if (!this.supportingLogRoots.some((root) => contained(root, canonical))) throw new ObserverError("INVALID_REQUEST", "Supporting log is outside configured supporting log roots", 403);
    return canonical;
  }
  private revalidateEvidenceRoot(root: string): void {
    const expected = this.evidenceIdentities.get(comparisonPath(root));
    try {
      const entry = lstatSync(root);
      const canonical = realpathSync.native(root);
      if (!expected || entry.isSymbolicLink() || !entry.isDirectory() || comparisonPath(canonical) !== comparisonPath(root) || !sameIdentity(expected, identity(canonical))) throw new Error("root identity changed");
    } catch (error) { throw new ObserverError("ARTIFACT_INVALID", `Configured evidence root changed identity: ${error instanceof Error ? error.message : String(error)}`, 409); }
  }
  private captureOutputIdentity(evidenceRoot: string, outputRoot: string): FilesystemIdentity {
    this.revalidateEvidenceRoot(evidenceRoot);
    if (comparisonPath(resolve(outputRoot)) !== comparisonPath(resolve(join(evidenceRoot, basename(outputRoot)))) || comparisonPath(dirname(resolve(outputRoot))) !== comparisonPath(resolve(evidenceRoot))) throw new ObserverError("ARTIFACT_INVALID", "Evidence output is not a direct child of its configured root", 409);
    const entry = lstatSync(outputRoot);
    const canonical = realpathSync.native(outputRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory() || comparisonPath(canonical) !== comparisonPath(resolve(outputRoot)) || comparisonPath(dirname(canonical)) !== comparisonPath(evidenceRoot)) throw new ObserverError("ARTIFACT_INVALID", "Evidence output directory identity is invalid", 409);
    return identity(canonical);
  }
  private assertOutputIdentity(root: string, output: string, expected: FilesystemIdentity): void {
    if (!sameIdentity(expected, this.captureOutputIdentity(root, output))) throw new ObserverError("ARTIFACT_INVALID", "Evidence output directory changed identity during finalization", 409);
  }
  private cleanupIncomplete(root: string, output: string, expected: FilesystemIdentity): void {
    try {
      if (!existsSync(output)) return;
      this.assertOutputIdentity(root, output, expected);
      listRegularFiles(output);
      this.assertOutputIdentity(root, output, expected);
      rmSync(output, { recursive: true, force: false });
    } catch { /* preserve unproven path */ }
  }
  private assertSnapshot(snapshot: EvidenceRunExportSnapshot, runId: string): void {
    if (snapshot.run.runId !== runId || !RUN_ID_PATTERN.test(runId) || !Array.isArray(snapshot.captures) || !Array.isArray(snapshot.artifacts)) throw new ObserverError("INVALID_REQUEST", "Evidence export snapshot is invalid", 409);
  }
}

export class EvidenceBundleUnavailableError extends ObserverError {
  constructor(message = "Observer evidence export is unavailable because no evidence root is configured") {
    super("CAPABILITY_UNAVAILABLE", message, 409);
    this.name = "EvidenceBundleUnavailableError";
  }
}

export class DisabledEvidenceBundleService implements EvidenceBundleService {
  prepare(_input: EvidenceBundleFinalizeInput): PreparedEvidenceExport { throw new EvidenceBundleUnavailableError(); }
  export(_snapshot: EvidenceRunExportSnapshot, _prepared: PreparedEvidenceExport): EvidenceExportReceipt { throw new EvidenceBundleUnavailableError(); }
  verifyReceipt(_snapshot: EvidenceRunExportSnapshot, _receipt: EvidenceExportReceipt, _fingerprint: string): void { throw new EvidenceBundleUnavailableError(); }
  sweepWork(_now: number, _maxAgeMs: number): string[] { return []; }
  diagnostics(): Record<string, unknown> { return { enabled: false, reason: "no_evidence_root" }; }
}
