import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../../observer/agent/artifacts.js";
import { convertBmpToPng } from "../../observer/agent/bmp.js";
import { ObserverRunStore } from "../../observer/agent/runs.js";
import { FileEvidenceBundleService } from "../../observer/agent/evidence-bundle-service.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

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
  data.writeUInt32LE(rowStride * height, 34);
  for (let offset = 54; offset < size; offset += 3) {
    data[offset] = 32;
    if (offset + 1 < size) data[offset + 1] = 128;
    if (offset + 2 < size) data[offset + 2] = 240;
  }
  return data;
}

function setup(root: string) {
  const evidence = join(root, "evidence");
  const logs = join(root, "logs");
  mkdirSync(evidence);
  mkdirSync(logs);
  const artifacts = new ArtifactStore(
    join(root, "artifacts"),
    {} as never,
    {} as never
  );
  const exporter = new FileEvidenceBundleService(join(root, "export-work"), [evidence], [logs]);
  const runs = new ObserverRunStore(join(root, "runs"), artifacts, exporter);
  return { root, evidence, logs, artifacts, runs };
}

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "rfo-runs-" }));
}

function completedCapture(
  value: ReturnType<typeof setup>,
  label = "Feature -- Proof",
  title = "Observer evidence workflow"
) {
  const begun = value.runs.begin({
    title,
    caseIds: ["RR-OBS-1"],
    sourceRevision: "working-tree-1",
    procedureRevision: "procedure-2",
    idempotencyKey: "begin-one",
  });
  const runId = begun.runId as string;
  value.runs.reserveCapture({
    runId,
    captureLabel: label,
    purpose: "Show the expected state",
    idempotencyKey: "capture-one",
    expectedWorldId: "world-1",
    expectedWorldEpoch: 3,
    requestedView: { kind: "current" },
    performancePolicy: "evidence",
  });
  value.runs.bindCapture({
    runId,
    captureLabel: label,
    backend: "workbench",
    jobId: "wb-job-1",
    instanceId: "workbench-1",
    worldId: "world-1",
    worldEpoch: 3,
  });
  const ref = value.artifacts.importArtifact({
    backend: "workbench",
    jobId: "wb-job-1",
    image: convertBmpToPng(bmp24()).png,
    metadata: {
      actualCamera: { position: [1, 2, 3] },
      actualFov: 70,
      completedAt: "2026-07-17T20:00:00.000Z",
      contaminated: false,
      warnings: [],
    },
  });
  value.runs.attachImportedArtifact(runId, label, ref);
  return { runId, ref };
}

function reviewedFinalizeInput(value: ReturnType<typeof setup>, runId: string) {
  return {
    runId,
    evidenceRoot: value.evidence,
    includeCaptureLabels: ["feature-proof"],
    review: {
      imagesReviewed: true,
      reviewer: "image-reviewer",
      outcome: "Passed" as const,
      summary: "The expected world state is visible.",
    },
    releaseManagedArtifacts: false,
  };
}

function regularFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return result.sort((left, right) => left.localeCompare(right));
}

function reattestBundleMember(
  value: ReturnType<typeof setup>,
  runId: string,
  relativePath: string,
  bytes: Buffer
): void {
  const output = join(value.evidence, runId);
  writeFileSync(join(output, ...relativePath.split("/")), bytes);
  const manifestPath = join(output, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  const member = manifest.files.find((item) => item.path === relativePath);
  if (!member) throw new Error(`Missing evidence member ${relativePath}`);
  member.bytes = bytes.length;
  member.sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, manifestBytes);

  const recordPath = join(value.root, "runs", runId, "run.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
    exportReceipt: { manifestSha256: string };
  };
  record.exportReceipt.manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

describe("managed observer runs", () => {
  scopedIt("normalizes unique labels and rejects collisions", (root) => {
    const value = setup(root);
    const begun = value.runs.begin({ title: "Labels" });
    const input = {
      runId: begun.runId as string,
      captureLabel: "Arena / Overhead",
      idempotencyKey: "capture-one",
      requestedView: { kind: "current" },
      performancePolicy: "evidence" as const,
    };
    const reserved = value.runs.reserveCapture(input);
    expect(reserved).toMatchObject({ capture: { captureLabel: "arena-overhead", state: "reserved" } });
    expect(() => value.runs.reserveCapture({ ...input, captureLabel: "arena---overhead", idempotencyKey: "capture-two" }))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  scopedIt("exports a reviewed manifest-last bundle and releases managed artifacts", (root) => {
    const value = setup(root);
    const { runId, ref } = completedCapture(value);
    const log = join(value.logs, "runtime.log");
    writeFileSync(log, "ready\ntoken=do-not-export\nfinished\n", "utf8");
    const finalized = value.runs.finalize({
      runId,
      evidenceRoot: value.evidence,
      includeCaptureLabels: ["feature-proof"],
      review: {
        imagesReviewed: true,
        reviewer: "image-reviewer",
        outcome: "Passed",
        summary: "The expected world state is visible.",
      },
      runtimeConfig: { configurationId: "rr-test", values: { warmupDurationSeconds: 60 } },
      supportingFiles: [{ kind: "relevantLog", label: "runtime", path: log }],
      releaseManagedArtifacts: true,
    });
    const output = join(value.evidence, runId);
    expect(finalized).toMatchObject({ receipt: { runId, captureCount: 1, managedArtifactsReleased: true } });
    expect(existsSync(join(output, "RESULT.md"))).toBe(true);
    expect(existsSync(join(output, "captures", "feature-proof.png"))).toBe(true);
    expect(existsSync(join(output, "captures", "feature-proof.json"))).toBe(true);
    expect(existsSync(join(output, "runtime-config.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      runId,
      review: { imagesReviewed: true, outcome: "Passed" },
      captures: [{ label: "feature-proof", backend: "workbench", worldId: "world-1" }],
    });
    const members = manifest.files as Array<{ path: string; bytes: number; sha256: string }>;
    expect(members.map((member) => member.path)).toEqual(
      regularFiles(output).filter((path) => path !== "manifest.json")
    );
    for (const member of members) {
      const bytes = readFileSync(join(output, ...member.path.split("/")));
      expect(member).toMatchObject({
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    expect(JSON.stringify(manifest)).not.toContain(value.root);
    expect(readFileSync(join(output, "relevant-logs", "runtime.log"), "utf8")).toContain("token=[REDACTED]");
    expect(value.artifacts.hasRef(ref)).toBe(false);

    const retried = value.runs.finalize({
      runId,
      evidenceRoot: value.evidence,
      includeCaptureLabels: ["feature-proof"],
      review: {
        imagesReviewed: true,
        reviewer: "image-reviewer",
        outcome: "Passed",
        summary: "The expected world state is visible.",
      },
      runtimeConfig: { configurationId: "rr-test", values: { warmupDurationSeconds: 60 } },
      supportingFiles: [{ kind: "relevantLog", label: "runtime", path: log }],
      releaseManagedArtifacts: true,
    });
    expect(retried).toMatchObject({ receipt: { manifestSha256: finalized.receipt && (finalized.receipt as Record<string, unknown>).manifestSha256 } });
  });

  scopedIt("rejects corrupted and unmanifested members when a finalized receipt is retried", (root) => {
    const value = setup(root);
    const { runId, ref } = completedCapture(value);
    const input = reviewedFinalizeInput(value, runId);
    value.runs.finalize(input);
    const output = join(value.evidence, runId);
    const imagePath = join(output, "captures", "feature-proof.png");
    const image = readFileSync(imagePath);

    writeFileSync(imagePath, Buffer.from("not the attested image"));
    expect(() => value.runs.finalize(input)).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));

    writeFileSync(imagePath, image);
    writeFileSync(join(output, "unmanifested.txt"), "must not be ignored", "utf8");
    expect(() => value.runs.finalize(input)).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
    expect(value.artifacts.hasRef(ref)).toBe(true);
  });

  scopedIt("rejects an oversized evidence manifest through the bounded descriptor reader", (root) => {
    const value = setup(root);
    const { runId } = completedCapture(value);
    const input = reviewedFinalizeInput(value, runId);
    value.runs.finalize(input);
    writeFileSync(
      join(value.evidence, runId, "manifest.json"),
      `${" ".repeat(2 * 1024 * 1024)}{}`,
      "utf8"
    );

    expect(() => value.runs.finalize(input)).toThrowError(expect.objectContaining({
      code: "ARTIFACT_INVALID",
      message: "Evidence manifest size is invalid",
    }));
  });

  scopedIt("rejects re-attested capture metadata whose JSON representation exceeds its descriptor bound", (root) => {
    const value = setup(root);
    const { runId } = completedCapture(value);
    const input = reviewedFinalizeInput(value, runId);
    value.runs.finalize(input);
    const metadataPath = join(value.evidence, runId, "captures", "feature-proof.json");
    const canonicalJson = readFileSync(metadataPath, "utf8");
    const oversizedButEquivalent = Buffer.from(`${" ".repeat(2 * 1024 * 1024)}${canonicalJson}`);
    reattestBundleMember(value, runId, "captures/feature-proof.json", oversizedButEquivalent);

    expect(() => value.runs.finalize(input)).toThrowError(expect.objectContaining({
      code: "ARTIFACT_INVALID",
      message: "Evidence capture 'feature-proof' metadata does not match its manifest",
    }));
  });

  scopedIt("rejects re-attested runtime JSON whose representation exceeds the runtime-config bound", (root) => {
    const value = setup(root);
    const { runId } = completedCapture(value);
    const runtimeConfig = { configurationId: "rr-test", values: { warmupDurationSeconds: 60 } };
    const input = { ...reviewedFinalizeInput(value, runId), runtimeConfig };
    value.runs.finalize(input);
    const oversizedButEquivalent = Buffer.from(`${" ".repeat(64 * 1024)}${JSON.stringify(runtimeConfig)}`);
    reattestBundleMember(value, runId, "runtime-config.json", oversizedButEquivalent);

    expect(() => value.runs.finalize(input)).toThrowError(expect.objectContaining({
      code: "ARTIFACT_INVALID",
      message: "Recovered runtime configuration does not match the finalize request",
    }));
  });

  scopedIt("refuses a manifest-only forged recovery without releasing its managed artifact", (root) => {
    const value = setup(root);
    const { runId, ref } = completedCapture(value);
    const input = reviewedFinalizeInput(value, runId);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const output = join(value.evidence, runId);
    mkdirSync(output);
    writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
      manifestVersion: 1,
      runId,
      finalizedAt: "2026-07-17T20:00:00.000Z",
      export: { requestSha256: fingerprint, managedArtifactsReleased: true },
    }, null, 2)}\n`, "utf8");

    expect(() => value.runs.finalize(input)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(value.runs.status(runId)).toMatchObject({ state: "open" });
    expect(value.artifacts.hasRef(ref)).toBe(true);
  });

  scopedIt("recovers a fully attested manifest-last bundle after the run-record commit was interrupted", (root) => {
    const value = setup(root);
    const { runId, ref } = completedCapture(value);
    const input = reviewedFinalizeInput(value, runId);
    value.runs.finalize(input);
    const recordPath = join(value.root, "runs", runId, "run.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.state = "open";
    delete record.finalizedAt;
    delete record.finalizeFingerprint;
    delete record.exportReceipt;
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    expect(value.runs.finalize(input)).toMatchObject({
      run: { state: "finalized" },
      receipt: { recovered: true, managedArtifactsReleased: false },
    });
    expect(value.artifacts.hasRef(ref)).toBe(true);
  });

  scopedIt("refuses an evidence root that was replaced after it was allowlisted", (root) => {
    const value = setup(root);
    const { runId, ref } = completedCapture(value);
    const original = `${value.evidence}-original`;
    renameSync(value.evidence, original);
    mkdirSync(value.evidence);

    expect(() => value.runs.finalize(reviewedFinalizeInput(value, runId)))
      .toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
    expect(existsSync(join(value.evidence, runId))).toBe(false);
    expect(value.artifacts.hasRef(ref)).toBe(true);
  });

  scopedIt("escapes control characters and Markdown structure in RESULT.md presentation fields", (root) => {
    const value = setup(root);
    const { runId } = completedCapture(value, "Feature -- Proof", "Trusted\n# Forged *Title*");
    value.runs.finalize({
      ...reviewedFinalizeInput(value, runId),
      review: {
        imagesReviewed: true,
        reviewer: "reviewer\n## Forged Reviewer",
        outcome: "Passed",
        summary: "Visible\u0000\n## Forged Summary [link](https://example.invalid)",
        limitations: ["Known\n## Forged Limitation *bold*"],
      },
    });

    const result = readFileSync(join(value.evidence, runId, "RESULT.md"), "utf8");
    expect(result).not.toContain("\u0000");
    expect(result).not.toContain("\n# Forged");
    expect(result).not.toContain("\n## Forged");
    expect(result).toContain("\\*Title\\*");
    expect(result).toContain("\\[link\\]\\(https://example\\.invalid\\)");
  });

  scopedIt("refuses arbitrary roots, secret config, and unreviewed pass claims", (root) => {
    const value = setup(root);
    const { runId } = completedCapture(value);
    const base = {
      runId,
      evidenceRoot: value.evidence,
      includeCaptureLabels: ["feature-proof"],
      review: {
        imagesReviewed: false,
        outcome: "Passed" as const,
        summary: "Not actually reviewed.",
      },
    };
    expect(() => value.runs.finalize(base)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => value.runs.finalize({
      ...base,
      review: { imagesReviewed: true, reviewer: "reviewer", outcome: "Passed", summary: "Reviewed." },
      runtimeConfig: { configurationId: "bad", values: { apiToken: "secret" } },
    })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(() => value.runs.finalize({
      ...base,
      evidenceRoot: value.root,
      review: { imagesReviewed: true, reviewer: "reviewer", outcome: "Passed", summary: "Reviewed." },
    })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  scopedIt("protects artifacts retained by an open run from independent release", (root) => {
    const value = setup(root);
    const { runId, ref } = completedCapture(value);
    expect(value.runs.protectedStoreKeys()).toContain(ref.storeKey);
    expect(() => value.runs.assertJobReleaseAllowed("workbench", ref.jobId))
      .toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(value.runs.discard(runId)).toMatchObject({ discarded: true, releasedCaptureLabels: ["feature-proof"] });
    expect(value.artifacts.hasRef(ref)).toBe(false);
  });

  scopedIt("expires abandoned open runs and interrupted export work", (root) => {
    const value = setup(root);
    const { runId, ref } = completedCapture(value);
    const recordPath = join(value.root, "runs", runId, "run.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.updatedAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const interrupted = join(value.root, "export-work", "interrupted");
    mkdirSync(interrupted);
    writeFileSync(join(interrupted, "partial.png"), "partial");
    utimesSync(interrupted, new Date(0), new Date(0));

    const swept = value.runs.applyRetention(1_000);

    expect(swept).toMatchObject({ expiredRuns: [runId], removedExportWork: ["interrupted"] });
    expect(value.runs.status(runId)).toMatchObject({ state: "expired" });
    expect(value.artifacts.hasRef(ref)).toBe(false);
    expect(existsSync(interrupted)).toBe(false);
  });
});
