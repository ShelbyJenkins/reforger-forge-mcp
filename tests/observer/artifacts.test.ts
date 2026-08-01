import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore, type ArtifactStoreOptions } from "../../observer/agent/artifacts.js";
import { convertBmpToPng, validatePng } from "../../observer/agent/bmp.js";
import { JobStore, type JobStoreOptions } from "../../observer/agent/jobs.js";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { ImageOutputError, transformImage } from "../../src/foundation/image-output.js";
import type { Sleeper } from "../../src/foundation/time.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { createObserverSessionFixture, graphicalRegistration } from "../support/observer-fixtures.js";
import { ManualTime } from "../support/manual-time.js";

function bmp24(width = 2, height = 2): Buffer {
  const rowStride = Math.floor((24 * width + 31) / 32) * 4;
  const size = 54 + rowStride * height;
  const data = Buffer.alloc(size);
  data.write("BM", 0, "ascii");
  data.writeUInt32LE(size, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(0, 30);
  data.writeUInt32LE(rowStride * height, 34);
  for (let offset = 54; offset < size; offset += 3) {
    data[offset] = 32;
    if (offset + 1 < size) data[offset + 1] = 128;
    if (offset + 2 < size) data[offset + 2] = 240;
  }
  return data;
}

function setup(
  root: string,
  jobOptions: JobStoreOptions = {},
  timing: {
    clock?: ManualTime;
    sleeper?: Sleeper;
    stableIntervalMs?: number;
    stableTimeoutMs?: number;
    imageInspector?: ArtifactStoreOptions["imageInspector"];
    imageTransformer?: ArtifactStoreOptions["imageTransformer"];
  } = {}
) {
  const clock = timing.clock ?? new ManualTime();
  const fixture = createObserverSessionFixture({ root, clock });
  const registry = new InstanceRegistry(fixture.store, { clock });
  const registration = graphicalRegistration(fixture.created);
  registry.register(registration, fixture.created.contract.sessionToken);
  const jobs = new JobStore(fixture.store, registry, clock, jobOptions);
  const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs, {
    stableIntervalMs: timing.stableIntervalMs ?? 2,
    // Success-path stability checks need scheduler headroom under a parallel
    // full-suite run; the production default is 2 seconds.
    stableTimeoutMs: timing.stableTimeoutMs ?? 2_000,
    ...(timing.sleeper ? { clock, sleeper: timing.sleeper } : {}),
    ...(timing.imageInspector ? { imageInspector: timing.imageInspector } : {}),
    ...(timing.imageTransformer ? { imageTransformer: timing.imageTransformer } : {}),
  });
  return { root, ...fixture, clock, registry, registration, jobs, artifacts };
}

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "rfo-artifacts-" }));
}

function advanceCurrentJob(value: ReturnType<typeof setup>, jobId: string): string {
  const command = value.jobs.nextCommand(value.registration.sessionId, value.registration.instanceId, value.registration.instanceNonce);
  expect(command).toMatchObject({ jobId, commandKind: "capture", deliveryAttempt: 1 });
  const base = {
    protocolVersion: "1.0",
    sessionId: value.registration.sessionId,
    instanceId: value.registration.instanceId,
    instanceNonce: value.registration.instanceNonce,
    jobId,
    worldId: value.registration.worldId,
    worldEpoch: value.registration.worldEpoch,
    cameraLease: { held: false, restorationConfirmed: false },
  } as const;
  value.jobs.update({ ...base, sequence: 0, state: "accepted", timestamp: new Date(value.clock.now()).toISOString(), deliveryToken: command!.deliveryToken }, value.created.contract.sessionToken);
  value.jobs.update({ ...base, sequence: 1, state: "capturing", timestamp: new Date(value.clock.now()).toISOString() }, value.created.contract.sessionToken);
  value.jobs.update({ ...base, sequence: 2, state: "awaitingArtifact", timestamp: new Date(value.clock.now()).toISOString() }, value.created.contract.sessionToken);
  return command!.deliveryToken;
}

function currentArtifactManifest(
  value: ReturnType<typeof setup>,
  jobId: string,
  artifactId: string,
  source: Buffer,
): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    sessionId: value.registration.sessionId,
    instanceId: value.registration.instanceId,
    instanceNonce: value.registration.instanceNonce,
    jobId,
    artifactId,
    relativeScreenshotFilename: `${jobId}.bmp`,
    screenshotIssuedAt: new Date(value.clock.now()).toISOString(),
    completedAt: new Date(value.clock.now() + 1).toISOString(),
    expectedByteCount: source.length,
    worldId: value.registration.worldId,
    worldEpoch: value.registration.worldEpoch,
    actualCamera: {},
    requestedSettleFrames: 0,
    actualSettleFrames: 0,
    contaminated: false,
    warnings: [],
  };
}

describe("observer artifacts", () => {
  scopedIt("maps stable-file expiry to ARTIFACT_INCOMPLETE without wall-clock waiting", async (root) => {
    const clock = new ManualTime();
    const delays: number[] = [];
    const sleeper: Sleeper = {
      async sleep(durationMs: number): Promise<void> {
        delays.push(durationMs);
        clock.advance(durationMs);
      },
    };
    const value = setup(root, {}, { clock, sleeper, stableTimeoutMs: 4 });
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "artifact-timeout",
      deadlineAt: new Date(clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
    });
    advanceCurrentJob(value, job.request.jobId);

    await expect(value.artifacts.intake({
      protocolVersion: "1.0",
      sessionId: value.registration.sessionId,
      instanceId: value.registration.instanceId,
      instanceNonce: value.registration.instanceNonce,
      jobId: job.request.jobId,
      artifactId: "artifact-timeout",
      relativeScreenshotFilename: `${job.request.jobId}.bmp`,
      screenshotIssuedAt: new Date(clock.now()).toISOString(),
      completedAt: new Date(clock.now()).toISOString(),
      worldId: value.registration.worldId,
      worldEpoch: value.registration.worldEpoch,
      actualCamera: {},
      requestedSettleFrames: 0,
      actualSettleFrames: 0,
      contaminated: false,
      warnings: [],
    }, value.created.contract.sessionToken)).rejects.toMatchObject({
      code: "ARTIFACT_INCOMPLETE",
    });
    expect(delays).toEqual([2, 2]);
  });

  it("validates narrow BMP input and emits deterministic PNG", () => {
    const first = convertBmpToPng(bmp24());
    const second = convertBmpToPng(bmp24());
    expect(first.png.equals(second.png)).toBe(true);
    expect(validatePng(first.png)).toMatchObject({ width: 2, height: 2, sourceFormat: "png" });
    expect(() => validatePng(first.png, { maxPixels: 3 })).toThrowError(expect.objectContaining({ code: "ARTIFACT_TOO_LARGE" }));
  });

  it("rejects truncated, trailing, compressed, and excessive BMP input", () => {
    expect(() => convertBmpToPng(bmp24().subarray(0, 40))).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
    expect(() => convertBmpToPng(Buffer.concat([bmp24(), Buffer.from([0])]))).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
    const compressed = bmp24();
    compressed.writeUInt32LE(1, 30);
    expect(() => convertBmpToPng(compressed)).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
    expect(() => convertBmpToPng(bmp24(), { maxWidth: 1 })).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
  });

  scopedIt("confines, validates, hashes, and retains an announced artifact", async (root) => {
    const value = setup(root);
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "artifact-1",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
    });
    advanceCurrentJob(value, job.request.jobId);
    const captureRoot = join(value.profilePath, "profile", "ReforgerForgeObserver", "captures");
    const source = bmp24();
    writeFileSync(join(captureRoot, `${job.request.jobId}.bmp`), source);
    const manifest = {
      protocolVersion: "1.0",
      sessionId: value.registration.sessionId,
      instanceId: value.registration.instanceId,
      instanceNonce: value.registration.instanceNonce,
      jobId: job.request.jobId,
      artifactId: "artifact-1",
      relativeScreenshotFilename: `${job.request.jobId}.bmp`,
      screenshotIssuedAt: new Date(value.clock.now()).toISOString(),
      completedAt: new Date(value.clock.now() + 1).toISOString(),
      expectedByteCount: source.length,
      worldId: value.registration.worldId,
      worldEpoch: value.registration.worldEpoch,
      actualCamera: {},
      requestedSettleFrames: 0,
      actualSettleFrames: 0,
      contaminated: false,
      warnings: [],
    };
    const stored = await value.artifacts.intake(manifest, value.created.contract.sessionToken);
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(stored.imagePath).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(job.state).toBe("completed");
    expect(existsSync(join(captureRoot, `${job.request.jobId}.bmp`))).toBe(false);
    expect(value.artifacts.read(value.registration.sessionId, job.request.jobId).metadata).toMatchObject({ worldEpoch: 1, bundleDigest: value.created.contract.bundleDigest });
    expect(await value.artifacts.intake(manifest, value.created.contract.sessionToken)).toEqual(stored);
    const replacement = Buffer.from(source);
    replacement[replacement.length - 1] ^= 0xff;
    const sourcePath = join(captureRoot, `${job.request.jobId}.bmp`);
    writeFileSync(sourcePath, replacement);
    expect(await value.artifacts.intake(manifest, value.created.contract.sessionToken)).toEqual(stored);
    expect(existsSync(sourcePath)).toBe(true);
    expect(value.artifacts.release(value.registration.sessionId, job.request.jobId)).toEqual({ released: true });
    expect(value.artifacts.release(value.registration.sessionId, job.request.jobId)).toEqual({ released: true });
    expect(value.jobs.stats()).toMatchObject({ releaseTombstones: 1 });
    expect(() => value.jobs.completeArtifact(
      value.registration.sessionId,
      job.request.jobId,
      manifest,
      stored.imagePath
    )).toThrowError(expect.objectContaining({ code: "JOB_RELEASED" }));
  });

  scopedIt("transforms a runtime BMP into the requested bounded WebP artifact", async (root) => {
    const value = setup(root);
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "artifact-webp",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
      image: { format: "webp", quality: 55, maxWidth: 1 },
    });
    advanceCurrentJob(value, job.request.jobId);
    const captureRoot = join(value.profilePath, "profile", "ReforgerForgeObserver", "captures");
    const source = bmp24(2, 2);
    writeFileSync(join(captureRoot, `${job.request.jobId}.bmp`), source);

    const stored = await value.artifacts.intake({
      protocolVersion: "1.0",
      sessionId: value.registration.sessionId,
      instanceId: value.registration.instanceId,
      instanceNonce: value.registration.instanceNonce,
      jobId: job.request.jobId,
      artifactId: "artifact-webp",
      relativeScreenshotFilename: `${job.request.jobId}.bmp`,
      screenshotIssuedAt: new Date(value.clock.now()).toISOString(),
      completedAt: new Date(value.clock.now() + 1).toISOString(),
      expectedByteCount: source.length,
      worldId: value.registration.worldId,
      worldEpoch: value.registration.worldEpoch,
      actualCamera: {},
      requestedSettleFrames: 0,
      actualSettleFrames: 0,
      contaminated: false,
      warnings: [],
    }, value.created.contract.sessionToken);

    expect(stored).toMatchObject({
      format: "webp",
      mimeType: "image/webp",
      width: 1,
      height: 1,
    });
    expect(stored.imagePath).toMatch(/image\.webp$/);
    const retained = value.artifacts.read(value.registration.sessionId, job.request.jobId);
    expect(retained.image.toString("ascii", 0, 4)).toBe("RIFF");
    expect(retained.metadata).toMatchObject({
      requestedImage: { format: "webp", quality: 55, maxWidth: 1 },
      format: "webp",
      mimeType: "image/webp",
      resized: true,
      transcoded: true,
    });
    expect(value.artifacts.runtimeRef(value.registration.sessionId, job.request.jobId))
      .toMatchObject({ format: "webp", mimeType: "image/webp", fileName: "image.webp" });
    expect(value.artifacts.release(value.registration.sessionId, job.request.jobId)).toEqual({ released: true });
  });

  scopedIt("maps an injected decoder failure without promoting or deleting the source", async (root) => {
    const imageInspector: NonNullable<ArtifactStoreOptions["imageInspector"]> = () => {
      throw new ImageOutputError("ARTIFACT_INVALID", "injected decoder failure");
    };
    const value = setup(root, {}, { imageInspector });
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "artifact-decoder-failure",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
      image: { format: "jpeg", quality: 61 },
    });
    advanceCurrentJob(value, job.request.jobId);
    const captureRoot = join(value.profilePath, "profile", "ReforgerForgeObserver", "captures");
    const sourcePath = join(captureRoot, `${job.request.jobId}.bmp`);
    const source = bmp24();
    writeFileSync(sourcePath, source);

    await expect(value.artifacts.intake(
      currentArtifactManifest(value, job.request.jobId, "artifact-decoder-failure", source),
      value.created.contract.sessionToken,
    )).rejects.toMatchObject({ code: "ARTIFACT_INVALID", message: "injected decoder failure" });

    expect(job.state).toBe("awaitingArtifact");
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(join(root, "artifacts", value.registration.sessionId, job.request.jobId))).toBe(false);
  });

  scopedIt("recovers an injected encoder failure before promotion with exact default quality", async (root) => {
    const observedPolicies: unknown[] = [];
    let attempts = 0;
    const imageTransformer: NonNullable<ArtifactStoreOptions["imageTransformer"]> = async (...args) => {
      attempts += 1;
      observedPolicies.push(args[2]);
      if (attempts === 1) {
        throw new ImageOutputError("ARTIFACT_INVALID", "injected encoder failure");
      }
      return transformImage(...args);
    };
    const value = setup(root, {}, { imageTransformer });
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "artifact-encoder-recovery",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
      image: { format: "webp", maxWidth: 1 },
    });
    advanceCurrentJob(value, job.request.jobId);
    const captureRoot = join(value.profilePath, "profile", "ReforgerForgeObserver", "captures");
    const sourcePath = join(captureRoot, `${job.request.jobId}.bmp`);
    const source = bmp24();
    writeFileSync(sourcePath, source);
    const manifest = currentArtifactManifest(
      value,
      job.request.jobId,
      "artifact-encoder-recovery",
      source,
    );

    await expect(value.artifacts.intake(manifest, value.created.contract.sessionToken))
      .rejects.toMatchObject({ code: "ARTIFACT_INVALID", message: "injected encoder failure" });
    const sessionRoot = join(root, "artifacts", value.registration.sessionId);
    expect(job.state).toBe("awaitingArtifact");
    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(join(sessionRoot, job.request.jobId))).toBe(false);
    expect(readdirSync(sessionRoot).filter((name) => name.startsWith(`.${job.request.jobId}.`))).toEqual([]);

    const recovered = await value.artifacts.intake(manifest, value.created.contract.sessionToken);
    expect(recovered).toMatchObject({ format: "webp", mimeType: "image/webp", width: 1, height: 1 });
    expect(observedPolicies).toEqual([
      { format: "webp", quality: 75, maxWidth: 1 },
      { format: "webp", quality: 75, maxWidth: 1 },
    ]);
    expect(value.artifacts.read(value.registration.sessionId, job.request.jobId).metadata).toMatchObject({
      requestedImage: { format: "webp", quality: 75, maxWidth: 1 },
      imageQuality: 75,
      format: "webp",
      mimeType: "image/webp",
    });
    expect(job.state).toBe("completed");
    expect(existsSync(sourcePath)).toBe(false);
  });

  scopedIt("retains a bounded release receipt after terminal job metadata is swept", async (root) => {
    const value = setup(root, { terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 });
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "late-artifact-release",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
    });
    advanceCurrentJob(value, job.request.jobId);
    const captureRoot = join(value.profilePath, "profile", "ReforgerForgeObserver", "captures");
    const source = bmp24();
    writeFileSync(join(captureRoot, `${job.request.jobId}.bmp`), source);
    await value.artifacts.intake({
      protocolVersion: "1.0",
      sessionId: value.registration.sessionId,
      instanceId: value.registration.instanceId,
      instanceNonce: value.registration.instanceNonce,
      jobId: job.request.jobId,
      artifactId: "late-artifact-release",
      relativeScreenshotFilename: `${job.request.jobId}.bmp`,
      screenshotIssuedAt: new Date(value.clock.now()).toISOString(),
      completedAt: new Date(value.clock.now() + 1).toISOString(),
      expectedByteCount: source.length,
      worldId: value.registration.worldId,
      worldEpoch: value.registration.worldEpoch,
      actualCamera: {},
      requestedSettleFrames: 0,
      actualSettleFrames: 0,
      contaminated: false,
      warnings: [],
    }, value.created.contract.sessionToken);
    value.clock.advance(10_002);
    expect(value.jobs.sweep(value.clock.now()).removedJobs).toContain(job.request.jobId);

    expect(value.artifacts.release(value.registration.sessionId, job.request.jobId)).toEqual({ released: true });
    expect(value.artifacts.release(value.registration.sessionId, job.request.jobId)).toEqual({ released: true });
    expect(value.jobs.stats()).toMatchObject({ jobs: 0, releaseTombstones: 1 });
  });

  scopedIt("retries job completion after atomic promotion without duplicating the artifact", async (root) => {
    const value = setup(root);
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "artifact-crash-window",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
      image: { format: "jpeg", quality: 61, maxWidth: 1 },
    });
    advanceCurrentJob(value, job.request.jobId);
    const captureRoot = join(value.profilePath, "profile", "ReforgerForgeObserver", "captures");
    const filename = `${job.request.jobId}.bmp`;
    const source = bmp24();
    writeFileSync(join(captureRoot, filename), source);
    const manifest = {
      protocolVersion: "1.0",
      sessionId: value.registration.sessionId,
      instanceId: value.registration.instanceId,
      instanceNonce: value.registration.instanceNonce,
      jobId: job.request.jobId,
      artifactId: "artifact-crash-window",
      relativeScreenshotFilename: filename,
      screenshotIssuedAt: new Date(value.clock.now()).toISOString(),
      completedAt: new Date(value.clock.now() + 1).toISOString(),
      expectedByteCount: source.length,
      worldId: value.registration.worldId,
      worldEpoch: value.registration.worldEpoch,
      actualCamera: {},
      requestedSettleFrames: 0,
      actualSettleFrames: 0,
      contaminated: false,
      warnings: [],
    };
    const original = value.jobs.completeArtifact.bind(value.jobs);
    const completion = vi.spyOn(value.jobs, "completeArtifact")
      .mockImplementationOnce(() => { throw new Error("simulated post-promotion interruption"); })
      .mockImplementation(original);
    await expect(value.artifacts.intake(manifest, value.created.contract.sessionToken)).rejects.toThrow("simulated post-promotion interruption");
    expect(job.state).toBe("awaitingArtifact");
    expect(existsSync(join(captureRoot, filename))).toBe(true);
    const recovered = await value.artifacts.intake(manifest, value.created.contract.sessionToken);
    expect(recovered).toMatchObject({ format: "jpeg", mimeType: "image/jpeg", width: 1, height: 1 });
    expect(recovered.imagePath).toMatch(/image\.jpg$/);
    expect(value.artifacts.read(value.registration.sessionId, job.request.jobId).metadata).toMatchObject({
      requestedImage: { format: "jpeg", quality: 61, maxWidth: 1 },
      imageQuality: 61,
      format: "jpeg",
      mimeType: "image/jpeg",
    });
    expect(job.state).toBe("completed");
    expect(completion).toHaveBeenCalledTimes(2);
    expect(existsSync(join(captureRoot, filename))).toBe(false);
  });

  scopedIt("rejects traversal-shaped filenames before filesystem access", async (root) => {
    const value = setup(root);
    await expect(value.artifacts.intake({
      protocolVersion: "1.0",
      sessionId: value.registration.sessionId,
      instanceId: value.registration.instanceId,
      instanceNonce: value.registration.instanceNonce,
      jobId: "job-1",
      artifactId: "artifact-1",
      relativeScreenshotFilename: "../escape.bmp",
      screenshotIssuedAt: new Date(value.clock.now()).toISOString(),
      completedAt: new Date(value.clock.now()).toISOString(),
      worldId: "world-1",
      worldEpoch: 1,
      actualCamera: {},
      requestedSettleFrames: 0,
      actualSettleFrames: 0,
      contaminated: false,
      warnings: [],
    }, value.created.contract.sessionToken)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
