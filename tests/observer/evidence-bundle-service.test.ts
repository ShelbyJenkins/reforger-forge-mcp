import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Transformer } from "@napi-rs/image";
import { FileEvidenceBundleService, type EvidenceRunExportSnapshot } from "../../observer/agent/evidence-bundle-service.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { contractPng } from "./capture-policy-fixture.js";

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

describe("FileEvidenceBundleService", () => {
  it("publishes manifest last, verifies every member, redacts logs, and recovers an attested output", async () => {
    await withTemporaryDirectory((root) => {
      const exportWork = join(root, "export-work");
      const evidence = join(root, "evidence");
      const logs = join(root, "logs");
      mkdirSync(logs);
      const logPath = join(logs, "runtime.log");
      writeFileSync(logPath, "Authorization: Bearer do-not-export\ntoken=also-secret\nready\n");
      const service = new FileEvidenceBundleService(exportWork, [evidence], [logs]);
      expect(existsSync(evidence)).toBe(false);
      const runId = "20260719T130000Z-a1b2c3d4";
      const artifact = {
        backend: "workbench" as const,
        jobId: "job-1",
        storeKey: "workbench/job-1",
        sha256: sha256(contractPng),
        bytes: contractPng.length,
        width: 1,
        height: 1,
      };
      const snapshot: EvidenceRunExportSnapshot = {
        run: { runId, title: "Stage 4 proof", caseIds: ["CASE-1"], createdAt: "2026-07-19T13:00:00.000Z" },
        captures: [{
          label: "overview", state: "completed", backend: "workbench", jobId: "job-1", instanceId: "wb-1",
          worldId: "world-1", worldEpoch: 0, requestedView: { kind: "current" }, performancePolicy: "evidence", artifact,
        }],
        artifacts: [{ captureLabel: "overview", image: contractPng, metadata: { contentSha256: artifact.sha256, completedAt: "2026-07-19T13:00:01.000Z" } }],
      };
      const prepared = service.prepare({
        runId,
        evidenceRoot: evidence,
        includeCaptureLabels: ["overview"],
        review: { imagesReviewed: true, reviewer: "visual-reviewer", outcome: "Passed", summary: "Capture is valid." },
        supportingFiles: [{ kind: "relevantLog", label: "runtime", path: logPath }],
        releaseManagedArtifacts: true,
      });
      expect(existsSync(evidence)).toBe(false);
      const receipt = service.export(snapshot, prepared);
      expect(existsSync(evidence)).toBe(true);
      const manifest = JSON.parse(readFileSync(join(receipt.evidenceDirectory, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ manifestVersion: 1, runId, export: { completionMarker: "manifest.json" } });
      expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain("manifest.json");
      const copiedLog = readFileSync(join(receipt.evidenceDirectory, "relevant-logs", "runtime.log"), "utf8");
      expect(copiedLog).not.toMatch(/do-not-export|also-secret/);
      expect(copiedLog).toContain("[REDACTED]");
      service.verifyReceipt(snapshot, receipt, prepared.fingerprint);
      expect(service.export(snapshot, prepared)).toMatchObject({ recovered: true, manifestSha256: receipt.manifestSha256 });
    }, { prefix: "rfo-bundle-" });
  });

  it("rejects secret-bearing runtime configuration before creating output", async () => {
    await withTemporaryDirectory((root) => {
      const evidence = join(root, "evidence");
      mkdirSync(evidence);
      const service = new FileEvidenceBundleService(join(root, "work"), [evidence]);
      expect(() => service.prepare({
        runId: "20260719T130100Z-b1c2d3e4",
        evidenceRoot: evidence,
        includeCaptureLabels: ["overview"],
        review: { imagesReviewed: false, outcome: "Unreviewed", summary: "Pending review." },
        runtimeConfig: { configurationId: "unsafe", values: { apiToken: "secret" } },
      })).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    }, { prefix: "rfo-bundle-secret-" });
  });

  it("exports and verifies the managed image extension and MIME type", async () => {
    await withTemporaryDirectory((root) => {
      const evidence = join(root, "evidence");
      const image = Transformer.fromRgbaPixels(Buffer.from([255, 0, 0, 255]), 1, 1).webpSync(60);
      const artifact = {
        backend: "runtime" as const,
        jobId: "job-webp",
        storeKey: "runtime/session-1/job-webp",
        sha256: sha256(image),
        bytes: image.length,
        width: 1,
        height: 1,
        format: "webp" as const,
        mimeType: "image/webp" as const,
        fileName: "image.webp",
      };
      const snapshot: EvidenceRunExportSnapshot = {
        run: {
          runId: "20260719T130200Z-c1d2e3f4",
          title: "WebP proof",
          caseIds: [],
          createdAt: "2026-07-19T13:02:00.000Z",
        },
        captures: [{
          label: "overview",
          state: "completed",
          backend: "runtime",
          jobId: artifact.jobId,
          instanceId: "runtime-1",
          worldId: "world-1",
          worldEpoch: 1,
          requestedView: { kind: "current" },
          requestedImage: { format: "webp", quality: 60 },
          performancePolicy: "evidence",
          artifact,
        }],
        artifacts: [{
          captureLabel: "overview",
          image,
          metadata: { format: "webp", mimeType: "image/webp", contentSha256: artifact.sha256 },
        }],
      };
      const service = new FileEvidenceBundleService(join(root, "work"), [evidence]);
      const prepared = service.prepare({
        runId: snapshot.run.runId,
        evidenceRoot: evidence,
        includeCaptureLabels: ["overview"],
        review: {
          imagesReviewed: true,
          reviewer: "image-capable-reviewer",
          outcome: "Passed",
          summary: "Readable scene.",
        },
      });

      const receipt = service.export(snapshot, prepared);
      expect(readFileSync(join(receipt.evidenceDirectory, "captures", "overview.webp"))).toEqual(image);
      const manifest = JSON.parse(readFileSync(join(receipt.evidenceDirectory, "manifest.json"), "utf8"));
      expect(manifest.captures[0]).toMatchObject({
        imagePath: "captures/overview.webp",
        format: "webp",
        mimeType: "image/webp",
        requestedImage: { format: "webp", quality: 60 },
      });
      service.verifyReceipt(snapshot, receipt, prepared.fingerprint);
    }, { prefix: "rfo-bundle-webp-" });
  });
});
