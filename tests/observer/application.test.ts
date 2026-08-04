import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createObserverApplication as createAgentApplication } from "../../observer/agent/application.js";
import { convertBmpToPng } from "../../observer/agent/bmp.js";
import { createObserverApplication as createHostApplication } from "../../src/observer/application.js";
import { registerObserverTools } from "../../src/observer/tools.js";
import { observerAddonSource, repositoryRoot } from "../support/observer-fixtures.js";
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

describe("observer application composition roots", () => {
  it("constructs one agent graph and reports disabled evidence without roots", async () => {
    await withTemporaryDirectory(async (root) => {
      const app = createAgentApplication({ root, sourceDirectory: observerAddonSource });
      expect(app.server).toBeDefined();
      expect(app.operations).toBeDefined();
      expect(app.runs.evidenceDiagnostics()).toMatchObject({ enabled: false });
      await app.server.close();
    }, { prefix: "rfo-agent-root-" });
  });

  it("constructs the optional exporter only for an explicitly allowed destination", async () => {
    await withTemporaryDirectory(async (root) => {
      const evidence = join(root, "evidence");
      mkdirSync(evidence);
      const app = createAgentApplication({ root: join(root, "managed"), sourceDirectory: observerAddonSource, evidenceRoots: [evidence] });
      expect(app.evidenceBundle).toBeDefined();
      expect(app.runs.evidenceDiagnostics()).toMatchObject({ enabled: true, evidenceRootCount: 1 });
      const run = app.runs.begin({ title: "record only" });
      expect(existsSync(join(root, "managed", "runs", run.runId as string))).toBe(false);
      const store = app.runs.recordStoreForTest();
      await app.server.close();
      expect(() => store.listIds("run")).toThrowError(/closed/);
      // Windows cannot remove an open LMDB memory map. This directly proves
      // server shutdown closed the run-record environment as well.
      rmSync(join(root, "managed", "state", "run-records-v1"), { recursive: true, force: false });
    }, { prefix: "rfo-agent-exporter-" });
  });

  it("reopens and finalizes a retained runtime run through a replacement private child", async () => {
    await withTemporaryDirectory(async (root) => {
      const managedRoot = join(root, "managed");
      const profileRoot = join(managedRoot, "profiles");
      const evidenceRoot = join(root, "evidence");
      mkdirSync(evidenceRoot);
      const seed = createAgentApplication({
        root: managedRoot,
        profileRoot,
        sourceDirectory: observerAddonSource,
      });
      const sessionId = "opzo-runtime-session";
      const jobId = "opzo-runtime-job";
      const captureLabel = "opzo-runtime-proof";
      const begun = seed.runs.begin({
        title: "OPZO replacement publication",
        caseIds: ["MCP-015"],
        idempotencyKey: "mcp-015-replacement",
      });
      const runId = String(begun.runId);
      seed.runs.reserveCapture({
        runId,
        captureLabel,
        idempotencyKey: "opzo-runtime-capture",
        sessionId,
        jobId,
        requestedInstanceId: "opzo-runtime-instance",
        expectedWorldId: "opzo-world",
        expectedWorldEpoch: 4,
        requestedView: { kind: "current" },
        performancePolicy: "evidence",
        asynchronous: true,
      });
      seed.runs.bindCapture({
        runId,
        captureLabel,
        backend: "runtime",
        sessionId,
        jobId,
        instanceId: "opzo-runtime-instance",
        worldId: "opzo-world",
        worldEpoch: 4,
      });
      const image = convertBmpToPng(bmp24()).png;
      const artifactRoot = join(seed.control.paths.artifacts, sessionId, jobId);
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(join(artifactRoot, "image.png"), image);
      writeFileSync(join(artifactRoot, "metadata.json"), `${JSON.stringify({
        version: 1,
        sessionId,
        jobId,
        instanceId: "opzo-runtime-instance",
        width: 2,
        height: 2,
        contentSha256: createHash("sha256").update(image).digest("hex"),
        completedAt: "2026-07-26T02:29:25.000Z",
        requestedView: { kind: "current" },
        contaminated: false,
        warnings: [],
      }, null, 2)}\n`);
      seed.runs.completeCapture(runId, captureLabel);
      await seed.server.close();

      const privateChild = join(repositoryRoot, "tests", "observer", "fixtures", "private-child-entry.mjs");
      const first = createHostApplication({
        agentPath: privateChild,
        managedRoot,
        profileRoot,
        sourceAddon: observerAddonSource,
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 10_000,
      });
      const replacement = createHostApplication({
        agentPath: privateChild,
        managedRoot,
        profileRoot,
        sourceAddon: observerAddonSource,
        evidenceRoots: [evidenceRoot],
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 10_000,
      });
      try {
        await expect(first.runStatus(runId)).resolves.toMatchObject({
          runId,
          state: "open",
          captures: [{
            captureLabel,
            state: "completed",
            backend: "runtime",
            artifactAvailable: true,
          }],
        });
        await expect(replacement.runStatus(runId)).resolves.toMatchObject({
          runId,
          state: "open",
          captures: [{
            captureLabel,
            state: "completed",
            artifactAvailable: true,
          }],
        });

        const finalized = await replacement.finalizeRun({
          runId,
          evidenceRoot,
          includeCaptureLabels: [captureLabel],
          review: {
            imagesReviewed: true,
            reviewer: "integration-reviewer",
            outcome: "Passed",
            summary: "The retained OPZO runtime capture is publishable after replacement.",
          },
          releaseManagedArtifacts: true,
        });
        expect(finalized).toMatchObject({
          run: { runId, state: "finalized" },
          receipt: {
            runId,
            captureCount: 1,
            managedArtifactsReleased: true,
          },
        });
        expect(existsSync(join(evidenceRoot, runId, "manifest.json"))).toBe(true);
        expect(existsSync(artifactRoot)).toBe(false);
      } finally {
        const closures = await Promise.allSettled([first.close(), replacement.close()]);
        expect(closures.every((result) => result.status === "fulfilled")).toBe(true);
      }
    }, { prefix: "rfo-agent-replacement-" });
  });

  it("composes host transport, capture, runs, and diagnostics once", async () => {
    await withTemporaryDirectory(async (root) => {
      const app = createHostApplication({ managedRoot: join(root, "managed"), profileRoot: join(root, "profiles") });
      expect(app.agentClient).toBeDefined();
      expect(app.captureService).toBeDefined();
      expect(app.evidenceRuns).toBeDefined();
      expect(app.diagnosticPrivateChildCount()).toBe(0);
      await app.close();
      expect(app.diagnosticPrivateChildCount()).toBe(0);
    }, { prefix: "rfo-host-root-" });
  });

  it("registers MCP tools directly against the host application interface", async () => {
    await withTemporaryDirectory(async (root) => {
      const registered: string[] = [];
      const server = {
        registerTool(name: string): void { registered.push(name); },
      } as unknown as McpServer;
      const app = createHostApplication({ managedRoot: join(root, "managed"), profileRoot: join(root, "profiles") });
      try {
        registerObserverTools(server, app, { ownedRuntimeManager: {} as never });
        expect(registered).toEqual([
          "observer_setup",
          "observer_prepare_launch",
          "observer_instances",
          "observer_capture",
          "observer_job",
          "observer_runtime",
          "observer_run_begin",
          "observer_run_status",
          "observer_run_finalize",
          "observer_run_discard",
        ]);
      } finally {
        await app.close();
      }
    }, { prefix: "rfo-host-registration-" });
  });
});
