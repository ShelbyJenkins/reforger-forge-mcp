import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BoundedJsonStore, JsonStoreError } from "#foundation/json-store";
import {
  SESSION_DIRECTORY_NAME,
  artifactManifestSchema,
  parseProtocolMessage,
  type ArtifactManifest,
} from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import { validateOrConvertImage } from "./bmp.js";
import { JobStore } from "./jobs.js";
import { observerLogger } from "./logger.js";
import {
  assertIdentifier,
  assertManagedPath,
  assertRegularManagedFile,
  atomicWriteFile,
  canonicalizeExistingDirectory,
  ensureCanonicalDirectory,
  resolveEngineProfileDirectory,
} from "./paths.js";
import { SessionStore } from "./sessions.js";

export interface StoredArtifact {
  artifactId: string;
  imagePath: string;
  metadataPath: string;
  sha256: string;
  width: number;
  height: number;
  mimeType: "image/png";
}

export interface ManagedArtifactRef {
  backend: "runtime" | "workbench";
  jobId: string;
  storeKey: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

export interface ManagedArtifactRead {
  image: Buffer;
  metadata: Record<string, unknown>;
}

export interface ImportedArtifactInput {
  backend: "workbench";
  jobId: string;
  image: Buffer;
  metadata: Record<string, unknown>;
}

export interface ArtifactPin {
  dispose(): void;
}

export interface ArtifactStoreOptions {
  stableIntervalMs?: number;
  stableTimeoutMs?: number;
}

interface RetainedArtifactMetadata {
  version: number;
  artifactId: string;
  contentSha256: string;
  mimeType: "image/png";
  width: number;
  height: number;
  sourceByteCount?: number;
  sourceContentSha256?: string;
  sourceManifest?: ArtifactManifest;
}

const MAX_ARTIFACT_METADATA_BYTES = 4 * 1024 * 1024;

function parseMetadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("artifact metadata must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function wait(delay: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

async function waitForStableRegularFile(path: string, timeoutMs: number, intervalMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stableChecks = 0;
  while (Date.now() <= deadline) {
    let size = -1;
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new ObserverError("ARTIFACT_INVALID", "Screenshot is not a regular file");
      size = entry.size;
    } catch (error) {
      if (error instanceof ObserverError) throw error;
    }
    if (size > 0 && size === previous) {
      stableChecks += 1;
      if (stableChecks >= 2) return size;
    } else {
      stableChecks = 0;
      previous = size;
    }
    await wait(intervalMs);
  }
  throw new ObserverError("ARTIFACT_INCOMPLETE", "Screenshot did not become stable before the artifact deadline", 408);
}

export class ArtifactStore {
  private readonly stableIntervalMs: number;
  private readonly stableTimeoutMs: number;
  private readonly inUse = new Set<string>();

  constructor(
    readonly artifactsRoot: string,
    private readonly sessions: SessionStore,
    private readonly jobs: JobStore,
    options: ArtifactStoreOptions = {}
  ) {
    this.artifactsRoot = ensureCanonicalDirectory(artifactsRoot);
    this.stableIntervalMs = options.stableIntervalMs ?? 50;
    this.stableTimeoutMs = options.stableTimeoutMs ?? 2_000;
  }

  async intake(input: unknown, token: string): Promise<StoredArtifact> {
    const parsed = parseProtocolMessage(artifactManifestSchema, input);
    if (!parsed.success) throw new ObserverError(parsed.error.code, parsed.error.message);
    const manifest = parsed.data;
    const session = this.sessions.authorize(manifest.sessionId, token);
    const job = this.jobs.require(manifest.sessionId, manifest.jobId);
    if (manifest.instanceId !== job.selectedInstanceId || manifest.instanceNonce !== job.selectedInstanceNonce) {
      throw new ObserverError("ARTIFACT_INVALID", "Artifact runtime identity does not match the job", 409);
    }
    if (manifest.worldId !== job.worldId || manifest.worldEpoch !== job.worldEpoch) {
      throw new ObserverError("WORLD_CHANGED", "Artifact world identity does not match the job", 409);
    }
    // Admission is checked before touching either the runtime-owned source file
    // or the retained store. Runtime messages can therefore never promote an
    // artifact from an inadmissible job state.
    this.jobs.preflightArtifact(manifest.sessionId, manifest.jobId, manifest);
    assertIdentifier(manifest.relativeScreenshotFilename.replace(/\.(bmp|png)$/i, ""), "Screenshot filename");
    const engineProfileDirectory = resolveEngineProfileDirectory(session.profilePath, { requireExisting: true });
    const capturePath = join(engineProfileDirectory, SESSION_DIRECTORY_NAME, "captures");
    assertManagedPath(session.profilePath, capturePath);
    assertManagedPath(engineProfileDirectory, capturePath);
    const captureRoot = canonicalizeExistingDirectory(capturePath, "Observer capture directory");
    assertManagedPath(session.profilePath, captureRoot);
    const sourcePath = join(captureRoot, manifest.relativeScreenshotFilename);
    assertManagedPath(captureRoot, sourcePath);
    const sessionRoot = ensureCanonicalDirectory(join(this.artifactsRoot, assertIdentifier(manifest.sessionId, "Session ID")));
    const jobRoot = join(sessionRoot, assertIdentifier(manifest.jobId, "Job ID"));
    assertManagedPath(sessionRoot, jobRoot);
    const imagePath = join(jobRoot, "image.png");
    const metadataPath = join(jobRoot, "metadata.json");
    if (existsSync(jobRoot)) {
      if (lstatSync(jobRoot).isSymbolicLink()) throw new ObserverError("ARTIFACT_INVALID", "Artifact directory is a symbolic link");
      let existing: RetainedArtifactMetadata | null = null;
      let retainedSha256: string | null = null;
      try {
        const retainedImage = assertRegularManagedFile(jobRoot, imagePath);
        assertRegularManagedFile(jobRoot, metadataPath);
        existing = this.readMetadata(jobRoot, metadataPath) as unknown as RetainedArtifactMetadata;
        retainedSha256 = createHash("sha256").update(readFileSync(retainedImage)).digest("hex");
      } catch { /* conflict is reported below */ }
      if (!existing || retainedSha256 === null || existing.version !== 1 || existing.artifactId !== manifest.artifactId ||
        existing.mimeType !== "image/png" || existing.contentSha256 !== retainedSha256 ||
        !isDeepStrictEqual(existing.sourceManifest, manifest)) {
        throw new ObserverError("ARTIFACT_INVALID", "Artifact directory already exists with different content", 409);
      }
      // Always retry the host completion step. This closes the crash window
      // after atomic promotion but before the in-memory job commit.
      this.jobs.completeArtifact(manifest.sessionId, manifest.jobId, manifest, imagePath);
      this.removeCommittedSource(captureRoot, sourcePath, existing.sourceByteCount, existing.sourceContentSha256);
      return {
        artifactId: manifest.artifactId,
        imagePath,
        metadataPath,
        sha256: retainedSha256,
        width: existing.width,
        height: existing.height,
        mimeType: "image/png",
      };
    }

    const stableSize = await waitForStableRegularFile(sourcePath, this.stableTimeoutMs, this.stableIntervalMs);
    assertRegularManagedFile(captureRoot, sourcePath);
    if (stableSize > session.limits.maxArtifactBytes) throw new ObserverError("ARTIFACT_TOO_LARGE", "Screenshot exceeds the session byte limit");
    if (manifest.expectedByteCount !== undefined && manifest.expectedByteCount !== stableSize) {
      throw new ObserverError("ARTIFACT_INCOMPLETE", "Screenshot byte count does not match its completion manifest");
    }
    const source = readFileSync(sourcePath);
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const image = validateOrConvertImage(source, extname(sourcePath), { maxBytes: session.limits.maxArtifactBytes });
    const sha256 = createHash("sha256").update(image.png).digest("hex");
    const temporary = join(sessionRoot, `.${manifest.jobId}.${randomUUID()}.tmp`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      atomicWriteFile(temporary, join(temporary, "image.png"), image.png);
      const metadata = {
        version: 1,
        artifactId: manifest.artifactId,
        contentSha256: sha256,
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        sourceFormat: image.sourceFormat,
        sourceByteCount: stableSize,
        sourceContentSha256: sourceSha256,
        sessionId: manifest.sessionId,
        instanceId: manifest.instanceId,
        jobId: manifest.jobId,
        worldId: manifest.worldId,
        worldEpoch: manifest.worldEpoch,
        requestedView: job.request.view,
        actualCamera: manifest.actualCamera,
        actualFov: manifest.actualFov,
        screenshotIssuedAt: manifest.screenshotIssuedAt,
        completedAt: manifest.completedAt,
        retainedAt: new Date().toISOString(),
        contaminated: manifest.contaminated,
        warnings: manifest.warnings,
        sourceManifest: manifest,
        bundleDigest: session.bundleDigest,
        protocolVersion: manifest.protocolVersion,
      };
      this.writeMetadata(temporary, join(temporary, "metadata.json"), metadata);
      // Re-read the exact managed source immediately before promotion. A file
      // replacement after the stability check must not be retained under the
      // original completion manifest.
      assertRegularManagedFile(captureRoot, sourcePath);
      const finalSource = readFileSync(sourcePath);
      if (finalSource.length !== stableSize || createHash("sha256").update(finalSource).digest("hex") !== sourceSha256) {
        throw new ObserverError("ARTIFACT_INCOMPLETE", "Screenshot changed during artifact intake", 409);
      }
      renameSync(temporary, jobRoot);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    this.jobs.completeArtifact(manifest.sessionId, manifest.jobId, manifest, imagePath);
    this.removeCommittedSource(captureRoot, sourcePath, stableSize, sourceSha256);
    return { artifactId: manifest.artifactId, imagePath, metadataPath, sha256, width: image.width, height: image.height, mimeType: image.mimeType };
  }

  release(sessionId: string, jobId: string): { released: boolean } {
    assertIdentifier(sessionId, "Session ID");
    assertIdentifier(jobId, "Job ID");
    const retainedReceipt = this.jobs.artifactReleaseReceipt(sessionId, jobId);
    if (retainedReceipt) return retainedReceipt;
    // Reserve the bounded tombstone before any filesystem mutation. A late
    // release remains idempotent even after its terminal JobRecord was swept.
    this.jobs.preflightArtifactRelease(sessionId, jobId);
    const root = join(this.artifactsRoot, sessionId, jobId);
    assertManagedPath(this.artifactsRoot, root);
    if (!existsSync(root)) {
      this.jobs.recordArtifactRelease(sessionId, jobId, false);
      return { released: false };
    }
    const entry = lstatSync(root);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ObserverError("ARTIFACT_INVALID", "Retained artifact path is not a managed directory", 409);
    }
    if (this.inUse.has(root)) throw new ObserverError("ARTIFACT_INCOMPLETE", "Retained artifact is currently in use", 409);
    // Verify both expected managed files before the recursive directory removal;
    // unrelated or replaced content is preserved for review.
    assertRegularManagedFile(root, join(root, "image.png"));
    assertRegularManagedFile(root, join(root, "metadata.json"));
    const unrelated = readdirSync(root).filter((name) => name !== "image.png" && name !== "metadata.json");
    if (unrelated.length > 0) throw new ObserverError("ARTIFACT_INVALID", "Retained artifact directory contains unrelated files", 409);
    rmSync(root, { recursive: true, force: false });
    this.jobs.recordArtifactRelease(sessionId, jobId, true);
    return { released: true };
  }

  read(sessionId: string, jobId: string): { image: Buffer; metadata: unknown } {
    assertIdentifier(sessionId, "Session ID");
    assertIdentifier(jobId, "Job ID");
    const root = join(this.artifactsRoot, sessionId, jobId);
    assertManagedPath(this.artifactsRoot, root);
    if (!existsSync(root)) throw new ObserverError("ARTIFACT_INCOMPLETE", "Retained artifact is not available", 404);
    const imagePath = assertRegularManagedFile(this.artifactsRoot, join(root, "image.png"));
    const metadataPath = assertRegularManagedFile(this.artifactsRoot, join(root, "metadata.json"));
    this.inUse.add(root);
    try {
      return { image: readFileSync(imagePath), metadata: this.readMetadata(root, metadataPath) };
    } finally {
      this.inUse.delete(root);
    }
  }

  runtimeRef(sessionId: string, jobId: string): ManagedArtifactRef {
    const value = this.read(sessionId, jobId);
    return this.refFromRead("runtime", `runtime/${assertIdentifier(sessionId, "Session ID")}/${assertIdentifier(jobId, "Job ID")}`, jobId, value.image, value.metadata);
  }

  workbenchRef(jobId: string): ManagedArtifactRef {
    assertIdentifier(jobId, "Job ID");
    const root = join(this.artifactsRoot, "workbench", jobId);
    const imagePath = assertRegularManagedFile(this.artifactsRoot, join(root, "image.png"));
    const metadataPath = assertRegularManagedFile(this.artifactsRoot, join(root, "metadata.json"));
    return this.refFromRead(
      "workbench",
      `workbench/${jobId}`,
      jobId,
      readFileSync(imagePath),
      this.readMetadata(root, metadataPath)
    );
  }

  importArtifact(input: ImportedArtifactInput): ManagedArtifactRef {
    assertIdentifier(input.jobId, "Job ID");
    if (!Buffer.isBuffer(input.image) || input.image.length === 0) {
      throw new ObserverError("ARTIFACT_INVALID", "Imported observer artifact is empty");
    }
    const validated = validateOrConvertImage(input.image, ".png", { maxBytes: 64 * 1024 * 1024 });
    const sha256 = createHash("sha256").update(validated.png).digest("hex");
    const backendRoot = ensureCanonicalDirectory(join(this.artifactsRoot, input.backend));
    const root = join(backendRoot, input.jobId);
    assertManagedPath(backendRoot, root);
    const imagePath = join(root, "image.png");
    const metadataPath = join(root, "metadata.json");
    const retainedMetadata: Record<string, unknown> = {
      ...input.metadata,
      version: 1,
      backend: input.backend,
      jobId: input.jobId,
      contentSha256: sha256,
      mimeType: "image/png",
      width: validated.width,
      height: validated.height,
      bytes: validated.png.length,
      retainedAt: typeof input.metadata.retainedAt === "string" ? input.metadata.retainedAt : new Date().toISOString(),
    };
    if (existsSync(root)) {
      if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
        throw new ObserverError("ARTIFACT_INVALID", "Imported artifact path is not a managed directory", 409);
      }
      const existing = this.readRef({
        backend: input.backend,
        jobId: input.jobId,
        storeKey: `${input.backend}/${input.jobId}`,
        sha256,
        bytes: validated.png.length,
        width: validated.width,
        height: validated.height,
      });
      if (typeof existing.metadata.retainedAt === "string" && typeof input.metadata.retainedAt !== "string") {
        retainedMetadata.retainedAt = existing.metadata.retainedAt;
      }
      if (!existing.image.equals(validated.png) || !isDeepStrictEqual(existing.metadata, retainedMetadata)) {
        throw new ObserverError("ARTIFACT_INVALID", "Imported artifact already exists with different content", 409);
      }
      return this.refFromRead(input.backend, `${input.backend}/${input.jobId}`, input.jobId, existing.image, existing.metadata);
    }
    const temporary = join(backendRoot, `.${input.jobId}.${randomUUID()}.tmp`);
    mkdirSync(temporary, { mode: 0o700 });
    try {
      atomicWriteFile(temporary, join(temporary, "image.png"), validated.png);
      this.writeMetadata(temporary, join(temporary, "metadata.json"), retainedMetadata);
      renameSync(temporary, root);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    return {
      backend: input.backend,
      jobId: input.jobId,
      storeKey: `${input.backend}/${input.jobId}`,
      sha256,
      bytes: validated.png.length,
      width: validated.width,
      height: validated.height,
    };
  }

  readRef(ref: ManagedArtifactRef): ManagedArtifactRead {
    const root = this.rootForRef(ref);
    const imagePath = assertRegularManagedFile(root, join(root, "image.png"));
    const metadataPath = assertRegularManagedFile(root, join(root, "metadata.json"));
    const alreadyInUse = this.inUse.has(root);
    this.inUse.add(root);
    try {
      const image = readFileSync(imagePath);
      const metadataRecord = this.readMetadata(root, metadataPath);
      const actualSha256 = createHash("sha256").update(image).digest("hex");
      if (actualSha256 !== ref.sha256 || image.length !== ref.bytes ||
          metadataRecord.width !== ref.width || metadataRecord.height !== ref.height ||
          metadataRecord.contentSha256 !== actualSha256) {
        throw new ObserverError("ARTIFACT_INVALID", "Retained artifact no longer matches its managed reference", 409);
      }
      return { image, metadata: metadataRecord };
    } finally {
      if (!alreadyInUse) this.inUse.delete(root);
    }
  }

  releaseRef(ref: ManagedArtifactRef): { released: boolean } {
    const root = this.rootForRef(ref, false);
    if (!existsSync(root)) return { released: false };
    if (this.inUse.has(root)) throw new ObserverError("ARTIFACT_INCOMPLETE", "Retained artifact is currently in use", 409);
    this.readRef(ref);
    const entry = lstatSync(root);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ObserverError("ARTIFACT_INVALID", "Retained artifact path is not a managed directory", 409);
    }
    assertRegularManagedFile(root, join(root, "image.png"));
    assertRegularManagedFile(root, join(root, "metadata.json"));
    if (readdirSync(root).some((name) => name !== "image.png" && name !== "metadata.json")) {
      throw new ObserverError("ARTIFACT_INVALID", "Retained artifact directory contains unrelated files", 409);
    }
    rmSync(root, { recursive: true, force: false });
    return { released: true };
  }

  pinForOperation(ref: ManagedArtifactRef): ArtifactPin {
    const root = this.rootForRef(ref);
    if (this.inUse.has(root)) {
      throw new ObserverError("ARTIFACT_INCOMPLETE", "Retained artifact is already in use", 409);
    }
    this.inUse.add(root);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.inUse.delete(root);
      },
    };
  }

  hasRef(ref: ManagedArtifactRef): boolean {
    try {
      this.readRef(ref);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (error instanceof ObserverError && ["INVALID_REQUEST", "ARTIFACT_INCOMPLETE"].includes(error.code)) return false;
      throw error;
    }
  }

  applyRetention(maxAgeMs: number, maxTotalBytes: number, protectedStoreKeys: ReadonlySet<string> = new Set()): { removed: string[]; retainedBytes: number } {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) {
      throw new ObserverError("INVALID_REQUEST", "Artifact retention limits must be non-negative safe integers");
    }
    const candidates: Array<{ root: string; mtimeMs: number; bytes: number }> = [];
    let total = 0;
    for (const sessionEntry of readdirSync(this.artifactsRoot, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) continue;
      const sessionRoot = join(this.artifactsRoot, sessionEntry.name);
      for (const jobEntry of readdirSync(sessionRoot, { withFileTypes: true })) {
        if (!jobEntry.isDirectory() || jobEntry.isSymbolicLink()) continue;
        const root = join(sessionRoot, jobEntry.name);
        const image = join(root, "image.png");
        const metadata = join(root, "metadata.json");
        if (!existsSync(image) || !existsSync(metadata)) continue;
        const bytes = statSync(image).size + statSync(metadata).size;
        const mtimeMs = Math.min(statSync(image).mtimeMs, statSync(metadata).mtimeMs);
        const storeKey = sessionEntry.name === "workbench"
          ? `workbench/${jobEntry.name}`
          : `runtime/${sessionEntry.name}/${jobEntry.name}`;
        total += bytes;
        if (!protectedStoreKeys.has(storeKey)) candidates.push({ root, mtimeMs, bytes });
      }
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const removed: string[] = [];
    const now = Date.now();
    for (const item of candidates) {
      if (this.inUse.has(item.root)) continue;
      const overAge = maxAgeMs >= 0 && now - item.mtimeMs > maxAgeMs;
      const overSize = total > maxTotalBytes;
      if (!overAge && !overSize) continue;
      rmSync(item.root, { recursive: true, force: true });
      total -= item.bytes;
      removed.push(item.root);
    }
    return { removed, retainedBytes: total };
  }

  private metadataStore(root: string): BoundedJsonStore<Record<string, unknown>> {
    return new BoundedJsonStore({
      root,
      minRecordBytes: 2,
      maxRecordBytes: MAX_ARTIFACT_METADATA_BYTES,
      parse: parseMetadataObject,
    });
  }

  private readMetadata(root: string, path: string): Record<string, unknown> {
    try {
      const metadata = this.metadataStore(root).read(path);
      if (!metadata) throw new Error("artifact metadata is missing");
      return metadata;
    } catch (error) {
      if (error instanceof ObserverError) throw error;
      throw new ObserverError(
        "ARTIFACT_INVALID",
        error instanceof JsonStoreError
          ? `Retained artifact metadata is invalid: ${error.message}`
          : "Retained artifact metadata is invalid",
        409
      );
    }
  }

  private writeMetadata(root: string, path: string, value: Record<string, unknown>): void {
    try {
      this.metadataStore(root).write(path, value);
    } catch (error) {
      throw new ObserverError(
        "ARTIFACT_INVALID",
        error instanceof Error
          ? `Artifact metadata could not be retained: ${error.message}`
          : "Artifact metadata could not be retained",
        409
      );
    }
  }

  private refFromRead(
    backend: ManagedArtifactRef["backend"],
    storeKey: string,
    jobId: string,
    image: Buffer,
    metadataInput: unknown
  ): ManagedArtifactRef {
    if (!metadataInput || typeof metadataInput !== "object" || Array.isArray(metadataInput)) {
      throw new ObserverError("ARTIFACT_INVALID", "Retained artifact metadata is invalid", 409);
    }
    const metadata = metadataInput as Record<string, unknown>;
    const width = metadata.width;
    const height = metadata.height;
    if (!Number.isSafeInteger(width) || (width as number) <= 0 || !Number.isSafeInteger(height) || (height as number) <= 0) {
      throw new ObserverError("ARTIFACT_INVALID", "Retained artifact dimensions are invalid", 409);
    }
    const contentSha256 = createHash("sha256").update(image).digest("hex");
    if (metadata.contentSha256 !== undefined && metadata.contentSha256 !== contentSha256) {
      throw new ObserverError("ARTIFACT_INVALID", "Retained artifact digest metadata is invalid", 409);
    }
    return {
      backend,
      jobId,
      storeKey,
      sha256: contentSha256,
      bytes: image.length,
      width: width as number,
      height: height as number,
    };
  }

  private rootForRef(ref: ManagedArtifactRef, requireExisting = true): string {
    assertIdentifier(ref.jobId, "Job ID");
    let root: string;
    if (ref.backend === "workbench") {
      if (ref.storeKey !== `workbench/${ref.jobId}`) throw new ObserverError("ARTIFACT_INVALID", "Workbench artifact store key is invalid", 409);
      root = join(this.artifactsRoot, "workbench", ref.jobId);
    } else {
      const match = /^runtime\/([A-Za-z0-9_-]{1,96})\/([A-Za-z0-9_-]{1,96})$/.exec(ref.storeKey);
      if (!match || match[2] !== ref.jobId) throw new ObserverError("ARTIFACT_INVALID", "Runtime artifact store key is invalid", 409);
      root = join(this.artifactsRoot, match[1], match[2]);
    }
    assertManagedPath(this.artifactsRoot, root);
    if (requireExisting && !existsSync(root)) throw new ObserverError("ARTIFACT_INCOMPLETE", "Retained artifact is not available", 404);
    return root;
  }

  private removeCommittedSource(captureRoot: string, sourcePath: string, expectedSize?: number, expectedSha256?: string): void {
    if (!existsSync(sourcePath)) return;
    try {
      const managed = assertRegularManagedFile(captureRoot, sourcePath);
      const source = readFileSync(managed);
      if (expectedSize !== undefined && source.length !== expectedSize) return;
      if (expectedSha256 !== undefined && createHash("sha256").update(source).digest("hex") !== expectedSha256) return;
      unlinkSync(managed);
    } catch (error) {
      observerLogger.warn("committed observer screenshot source was preserved", {
        errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
      });
    }
  }
}
