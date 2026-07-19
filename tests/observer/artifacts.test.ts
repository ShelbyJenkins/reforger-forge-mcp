import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../observer/agent/artifacts.js";
import { convertBmpToPng, validatePng } from "../../observer/agent/bmp.js";
import { JobStore, type JobStoreOptions } from "../../observer/agent/jobs.js";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { cleanup, createSessionFixture, FakeClock, graphicalRegistration, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

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

function setup(jobOptions: JobStoreOptions = {}) {
  const root = temporaryDirectory();
  roots.push(root);
  const clock = new FakeClock();
  const fixture = createSessionFixture(root, clock);
  const registry = new InstanceRegistry(fixture.store, { clock });
  const registration = graphicalRegistration(fixture.created);
  registry.register(registration, fixture.created.contract.sessionToken);
  const jobs = new JobStore(fixture.store, registry, clock, jobOptions);
  const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs, {
    stableIntervalMs: 2,
    // Success-path stability checks need scheduler headroom under a parallel
    // full-suite run; the production default is 2 seconds.
    stableTimeoutMs: 2_000,
  });
  return { root, ...fixture, registry, registration, jobs, artifacts };
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

describe("observer artifacts", () => {
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

  it("confines, validates, hashes, and retains an announced artifact", async () => {
    const value = setup();
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

  it("retains a bounded release receipt after terminal job metadata is swept", async () => {
    const value = setup({ terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 });
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

  it("retries job completion after atomic promotion without duplicating the artifact", async () => {
    const value = setup();
    const job = value.jobs.submit({
      sessionId: value.registration.sessionId,
      idempotencyKey: "artifact-crash-window",
      deadlineAt: new Date(value.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
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
    expect(recovered.imagePath).toContain(job.request.jobId);
    expect(job.state).toBe("completed");
    expect(completion).toHaveBeenCalledTimes(2);
    expect(existsSync(join(captureRoot, filename))).toBe(false);
  });

  it("rejects traversal-shaped filenames before filesystem access", async () => {
    const value = setup();
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
