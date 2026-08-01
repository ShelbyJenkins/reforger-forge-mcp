import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Transformer } from "@napi-rs/image";
import { FileEvidenceBundleService, type EvidenceRunExportSnapshot } from "../../observer/agent/evidence-bundle-service.js";
import { resolveManagedRuntimeLogLocation } from "../../observer/agent/paths.js";
import type { RuntimeLogEvidenceGrant } from "../../observer/agent/runtime-log-evidence.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { contractPng } from "./capture-policy-fixture.js";

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function runtimeSnapshot(input: {
  runId: string;
  sessionId: string;
  profilePath: string;
  scriptLogPath: string;
  includeGrant?: boolean;
  grantOverrides?: Partial<RuntimeLogEvidenceGrant>;
}): EvidenceRunExportSnapshot {
  const artifact = {
    backend: "runtime" as const,
    jobId: "job-runtime-log",
    storeKey: `runtime/${input.sessionId}/job-runtime-log`,
    sha256: sha256(contractPng),
    bytes: contractPng.length,
    width: 1,
    height: 1,
  };
  const grant: RuntimeLogEvidenceGrant = {
    version: 1,
    runId: input.runId,
    captureLabel: "overview",
    sessionId: input.sessionId,
    runtimeId: "rt-00000000-0000-4000-8000-000000000001",
    generation: "a".repeat(64),
    profilePath: input.profilePath,
    scriptLogPath: input.scriptLogPath,
    grantedAt: "2026-07-31T12:00:01.000Z",
    ...input.grantOverrides,
  };
  return {
    run: {
      runId: input.runId,
      title: "Exact runtime log proof",
      caseIds: ["MCP-035"],
      createdAt: "2026-07-31T12:00:00.000Z",
    },
    captures: [{
      label: "overview",
      state: "completed",
      backend: "runtime",
      sessionId: input.sessionId,
      jobId: artifact.jobId,
      instanceId: "runtime-instance",
      worldId: "world-1",
      worldEpoch: 1,
      requestedView: { kind: "current" },
      performancePolicy: "evidence",
      artifact,
      ...(input.includeGrant === false ? {} : { runtimeLogEvidenceGrant: grant }),
    }],
    artifacts: [{
      captureLabel: "overview",
      image: contractPng,
      metadata: { contentSha256: artifact.sha256, completedAt: "2026-07-31T12:00:01.000Z" },
    }],
  };
}

function semanticFinalizeInput(runId: string, evidenceRoot: string) {
  return {
    runId,
    evidenceRoot,
    includeCaptureLabels: ["overview"],
    review: {
      imagesReviewed: true,
      reviewer: "visual-reviewer",
      outcome: "Passed" as const,
      summary: "Capture and correlated runtime log are valid.",
    },
    supportingFiles: [{
      kind: "relevantLog" as const,
      label: "runtime",
      sourceCaptureLabel: "overview",
    }],
    releaseManagedArtifacts: false,
  };
}

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

  it("admits only the granted script.log for a selected exact-owned runtime capture", async () => {
    await withTemporaryDirectory((root) => {
      const profilePath = join(root, "profiles", "exact-runtime");
      mkdirSync(profilePath, { recursive: true });
      const sessionId = "s-00000000-0000-4000-8000-000000000001";
      const runtimeLog = resolveManagedRuntimeLogLocation(profilePath, sessionId, { create: true });
      writeFileSync(
        runtimeLog.scriptLogPath,
        "Authorization: Bearer do-not-export\nexact runtime ready\n",
        "utf8"
      );
      writeFileSync(join(profilePath, "profile", "private-settings.conf"), "private", "utf8");
      const evidence = join(root, "evidence");
      const runId = "20260731T120000Z-a1b2c3d4";
      const snapshot = runtimeSnapshot({
        runId,
        sessionId,
        profilePath,
        scriptLogPath: runtimeLog.scriptLogPath,
      });
      const service = new FileEvidenceBundleService(join(root, "work"), [evidence]);
      const prepared = service.prepare(semanticFinalizeInput(runId, evidence));

      const receipt = service.export(snapshot, prepared);
      const copied = readFileSync(join(receipt.evidenceDirectory, "relevant-logs", "runtime.log"), "utf8");
      expect(copied).toContain("exact runtime ready");
      expect(copied).not.toContain("do-not-export");
      const manifest = JSON.parse(readFileSync(join(receipt.evidenceDirectory, "manifest.json"), "utf8"));
      expect(manifest.supportingFiles).toEqual([expect.objectContaining({
        kind: "relevantLog",
        label: "runtime",
        sourceCaptureLabel: "overview",
        path: "relevant-logs/runtime.log",
      })]);
      expect(JSON.stringify(manifest)).not.toContain(profilePath);
      service.verifyReceipt(snapshot, receipt, prepared.fingerprint);
    }, { prefix: "rfo-exact-runtime-log-" });
  });

  it("rejects semantic runtime logs without a selected exact-owned capture grant", async () => {
    await withTemporaryDirectory((root) => {
      const profilePath = join(root, "profiles", "external-runtime");
      mkdirSync(profilePath, { recursive: true });
      const sessionId = "s-00000000-0000-4000-8000-000000000002";
      const runtimeLog = resolveManagedRuntimeLogLocation(profilePath, sessionId, { create: true });
      writeFileSync(runtimeLog.scriptLogPath, "externally launched\n", "utf8");
      const evidence = join(root, "evidence");
      const runId = "20260731T120100Z-b1c2d3e4";
      const service = new FileEvidenceBundleService(join(root, "work"), [evidence]);
      expect(() => service.export(
        runtimeSnapshot({
          runId,
          sessionId,
          profilePath,
          scriptLogPath: runtimeLog.scriptLogPath,
          includeGrant: false,
        }),
        service.prepare(semanticFinalizeInput(runId, evidence))
      )).toThrowError(expect.objectContaining({
        code: "SESSION_UNVERIFIABLE",
        message: expect.stringContaining("no exact-owned runtime log evidence authority"),
      }));

      expect(() => service.prepare({
        ...semanticFinalizeInput(runId, evidence),
        includeCaptureLabels: ["different-capture"],
      })).toThrowError(expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("must be selected for export"),
      }));
    }, { prefix: "rfo-external-runtime-log-" });
  });

  it("keeps other profiles and private profile files outside path-form admission", async () => {
    await withTemporaryDirectory((root) => {
      const profilePath = join(root, "profiles", "other-session");
      mkdirSync(profilePath, { recursive: true });
      const sessionId = "s-00000000-0000-4000-8000-000000000003";
      const runtimeLog = resolveManagedRuntimeLogLocation(profilePath, sessionId, { create: true });
      writeFileSync(runtimeLog.scriptLogPath, "other profile\n", "utf8");
      const privateFile = join(profilePath, "profile", "private-settings.conf");
      writeFileSync(privateFile, "private\n", "utf8");
      const evidence = join(root, "evidence");
      const runId = "20260731T120200Z-c1d2e3f4";
      const snapshot = runtimeSnapshot({
        runId,
        sessionId,
        profilePath,
        scriptLogPath: runtimeLog.scriptLogPath,
      });
      const service = new FileEvidenceBundleService(join(root, "work"), [evidence]);
      for (const path of [runtimeLog.scriptLogPath, privateFile, join(profilePath, "..", "other-session", "profile", "private-settings.conf")]) {
        const prepared = service.prepare({
          ...semanticFinalizeInput(runId, evidence),
          supportingFiles: [{ kind: "relevantLog", label: "runtime", path }],
        });
        expect(() => service.export(snapshot, prepared)).toThrowError(expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("outside configured supporting log roots"),
        }));
      }
    }, { prefix: "rfo-profile-path-deny-" });
  });

  it("rejects semantic grants redirected to another profile, a private file, or traversal", async () => {
    await withTemporaryDirectory((root) => {
      const profilePath = join(root, "profiles", "exact-runtime");
      const otherProfilePath = join(root, "profiles", "other-runtime");
      mkdirSync(profilePath, { recursive: true });
      mkdirSync(otherProfilePath, { recursive: true });
      const sessionId = "s-00000000-0000-4000-8000-000000000005";
      const runtimeLog = resolveManagedRuntimeLogLocation(profilePath, sessionId, { create: true });
      const otherRuntimeLog = resolveManagedRuntimeLogLocation(otherProfilePath, sessionId, { create: true });
      writeFileSync(runtimeLog.scriptLogPath, "exact profile\n", "utf8");
      writeFileSync(otherRuntimeLog.scriptLogPath, "other profile\n", "utf8");
      const privateFile = join(profilePath, "profile", "private-settings.conf");
      writeFileSync(privateFile, "private\n", "utf8");
      const evidence = join(root, "evidence");
      const runId = "20260731T120400Z-e1f2a3b4";
      const service = new FileEvidenceBundleService(join(root, "work"), [evidence]);

      for (const scriptLogPath of [
        otherRuntimeLog.scriptLogPath,
        privateFile,
        join(runtimeLog.directory, "..", "..", "private-settings.conf"),
      ]) {
        expect(() => service.export(
          runtimeSnapshot({
            runId,
            sessionId,
            profilePath,
            scriptLogPath: runtimeLog.scriptLogPath,
            grantOverrides: { scriptLogPath },
          }),
          service.prepare(semanticFinalizeInput(runId, evidence))
        )).toThrowError(expect.objectContaining({
          code: "SESSION_UNVERIFIABLE",
          message: expect.stringContaining("does not name its assigned script.log"),
        }));
      }
    }, { prefix: "rfo-semantic-profile-deny-" });
  });

  it("rejects a junction escape and replacement race for a granted script.log", async () => {
    await withTemporaryDirectory((root) => {
      const profilePath = join(root, "profiles", "exact-runtime");
      mkdirSync(profilePath, { recursive: true });
      const sessionId = "s-00000000-0000-4000-8000-000000000004";
      const runtimeLog = resolveManagedRuntimeLogLocation(profilePath, sessionId, { create: true });
      writeFileSync(runtimeLog.scriptLogPath, "original\n", "utf8");
      const evidence = join(root, "evidence");
      const runId = "20260731T120300Z-d1e2f3a4";
      const snapshot = runtimeSnapshot({ runId, sessionId, profilePath, scriptLogPath: runtimeLog.scriptLogPath });

      const replacementService = new FileEvidenceBundleService(
        join(root, "replacement-work"),
        [evidence],
        [],
        {
          afterSupportingFileOpen(canonicalPath) {
            const original = `${canonicalPath}.opened`;
            renameSync(canonicalPath, original);
            writeFileSync(canonicalPath, "replacement\n", "utf8");
          },
        }
      );
      expect(() => replacementService.export(
        snapshot,
        replacementService.prepare(semanticFinalizeInput(runId, evidence))
      )).toThrowError(expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("changed identity"),
      }));

      rmSync(runtimeLog.directory, { recursive: true, force: false });
      const outside = join(root, "outside-runtime-logs");
      mkdirSync(outside);
      writeFileSync(join(outside, "script.log"), "outside\n", "utf8");
      symlinkSync(outside, runtimeLog.directory, "junction");
      const junctionService = new FileEvidenceBundleService(join(root, "junction-work"), [join(root, "junction-evidence")]);
      expect(() => junctionService.export(
        snapshot,
        junctionService.prepare(semanticFinalizeInput(runId, join(root, "junction-evidence")))
      )).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    }, { prefix: "rfo-runtime-log-race-" });
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
