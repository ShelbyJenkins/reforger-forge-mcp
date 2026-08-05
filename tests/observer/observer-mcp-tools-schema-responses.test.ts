import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Transformer } from "@napi-rs/image";
import { ObserverApplicationError } from "../../src/observer/errors.js";
import type { OwnedRuntimeManager } from "../../src/observer/owned-runtime-manager.js";
import { runtimeWorldRevision } from "../../src/observer/world-revision.js";
import { registerObserverTools } from "../../src/observer/tools.js";
import {
  captureToolInput,
  createToolHarness,
  png,
  toolApplication,
  toolRegistry,
} from "./application-diagnostics-fixture.js";

describe("observer MCP tools", () => {
  it("publishes a portable fixed-length capture schema without positional items or nested refs", async () => {
    const coordinator = toolApplication({ capture: vi.fn() });
    const server = new McpServer({ name: "observer-schema-test", version: "1.0.0" });
    registerObserverTools(server, coordinator, {
      ownedRuntimeManager: {} as OwnedRuntimeManager,
    });
    const client = new Client({ name: "observer-schema-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const prepare = listed.tools.find((tool) => tool.name === "observer_prepare_launch");
      const capture = listed.tools.find((tool) => tool.name === "observer_capture");
      const run = listed.tools.find((tool) => tool.name === "observer_run_finalize");
      const gameLaunch = listed.tools.find((tool) => tool.name === "game_launch");
      expect(prepare).toBeDefined();
      expect(capture).toBeDefined();
      expect(run).toBeDefined();
      expect(gameLaunch).toBeDefined();
      expect(gameLaunch!.inputSchema.required ?? []).not.toContain("action");
      expect(gameLaunch!.inputSchema.properties!.action).not.toHaveProperty("default");
      expect(gameLaunch!.inputSchema.properties!.runtimeKind).not.toHaveProperty("default");
      expect(gameLaunch!.inputSchema.properties!.waitForInstanceMs).not.toHaveProperty("default");
      expect(gameLaunch!.inputSchema.additionalProperties).toBe(false);
      expect(capture!.inputSchema.required ?? []).not.toContain("expectedWorldRevision");
      expect(capture!.inputSchema.properties).toHaveProperty("target");
      expect(capture!.inputSchema.properties).toHaveProperty("expectedWorldRevision");
      expect(capture!.inputSchema.properties).not.toHaveProperty("expectedWorldId");
      expect(capture!.inputSchema.properties).not.toHaveProperty("expectedWorldEpoch");
      expect(capture!.inputSchema.additionalProperties).toBe(false);
      expect(run!.description).toContain("reviewed capture labels");
      expect(run!.inputSchema.properties!.includeCaptureLabels).toMatchObject({
        minItems: 1,
      });
      expect(prepare!.description).toContain("native borderless-fullscreen window by default");
      expect(prepare!.description).toContain("forceNonNativeWindowSize");
      expect(prepare!.inputSchema.properties!.arguments).toMatchObject({
        description: expect.stringContaining("native fullscreen is the default"),
      });
      expect(prepare!.inputSchema.properties!.forceNonNativeWindowSize).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expect.arrayContaining(["width", "height", "justification"]),
        description: expect.stringContaining("Exceptional opt-in"),
      });

      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const entry of value) visit(entry);
          return;
        }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if ("items" in record) expect(Array.isArray(record.items)).toBe(false);
        expect(record).not.toHaveProperty("$ref");
        for (const entry of Object.values(record)) visit(entry);
      };
      visit(capture!.inputSchema);
      visit(prepare!.inputSchema);

      const captureSchema = toolRegistry(coordinator).get("observer_capture")!.definition.inputSchema!;
      const runSchema = toolRegistry(coordinator).get("observer_run_finalize")!.definition.inputSchema!;
      const view = captureSchema.view;
      expect(captureSchema.image.safeParse({ maxWidth: 1920, format: "webp", quality: 75 }).success).toBe(true);
      expect(captureSchema.image.safeParse({ format: "png", quality: 75 }).success).toBe(false);
      expect(captureSchema.image.safeParse({ maxWidth: 8_000, maxHeight: 8_000 }).success).toBe(false);
      expect(captureSchema.performancePolicy.safeParse("performance").success).toBe(false);
      expect(captureSchema.performancePolicy.safeParse("instrumented").success).toBe(true);
      expect(captureSchema.runId.safeParse("20260717T184233Z-a1b2c3d4").success).toBe(true);
      expect(runSchema.supportingFiles.safeParse([{
        kind: "relevantLog",
        label: "runtime",
        sourceCaptureLabel: "overview",
      }]).success).toBe(true);
      expect(runSchema.supportingFiles.safeParse([{
        kind: "relevantLog",
        label: "runtime",
        path: "C:\\logs\\script.log",
      }]).success).toBe(true);
      expect(runSchema.supportingFiles.safeParse([{
        kind: "relevantLog",
        label: "runtime",
        sourceCaptureLabel: "overview",
        path: "C:\\caller-cannot-mint\\script.log",
      }]).success).toBe(false);
      expect(view.safeParse({
        kind: "pose",
        position: [1, 2, 3],
        orientation: [0, 0, 0, 1],
        fov: 60,
      })).toMatchObject({ success: true, data: { position: [1, 2, 3], orientation: [0, 0, 0, 1] } });
      const boundaryCases: Array<{ input: Record<string, unknown>; success: boolean }> = [
        { input: { kind: "pose", position: [1, 2], orientation: [0, 0, 0, 1], fov: 60 }, success: false },
        { input: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 2], fov: 60 }, success: false },
        { input: { kind: "lookAt", position: [1, 2, 3], target: [1, 2, 3], fov: 60 }, success: false },
        { input: { kind: "lookAt", position: [1, 2, 3], target: [4, 5, 6], fov: 60 }, success: true },
      ];
      for (const boundary of boundaryCases) {
        expect(view.safeParse(boundary.input).success).toBe(boundary.success);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("accepts an inventory-null world for current-view capture through the public tool", async () => {
    const revision = runtimeWorldRevision(null, 7);
    const { coordinator, call } = createToolHarness({
      instances: vi.fn(async () => ({
        instances: [{
          instanceId: "runtime-null-world", sessionId: "session-1", worldId: null, worldEpoch: 7,
          worldRevision: revision,
          capabilities: ["render.capture"],
        }],
        compatibleCount: 1, waitedMs: 0, timedOut: false,
      })),
      capture: vi.fn(async () => ({
        asynchronous: true,
        job: { jobId: "job-null-world", worldId: null, worldEpoch: 7, state: "queued" },
      })),
    });
    const inventory = await call("observer_instances", {
      sessionId: "session-1",
      requiredCapabilities: ["render.capture"],
      renderersOnly: true,
      waitMs: 0,
    });
    expect(inventory.isError).not.toBe(true);
    expect(inventory.content[0].text).toContain('"worldId": null');

    const capture = await call("observer_capture", captureToolInput({
      runId: "20260717T184233Z-a1b2c3d4",
      captureLabel: "null-world-current",
      instanceId: "runtime-null-world",
      idempotencyKey: "null-world-current",
      asynchronous: true,
      expectedWorldRevision: revision,
    }));
    expect(capture.isError).not.toBe(true);
    expect(coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({
      expectedWorldRevision: revision,
      view: { kind: "current" },
    }));
  });

  it("keeps legacy world binding explicit while allowing delegated selection", async () => {
    const capture = vi.fn(async () => ({
      asynchronous: true,
      job: { jobId: "job-world-binding", state: "queued" },
    }));
    const { coordinator, tools, call } = createToolHarness({ capture });
    const definition = tools.get("observer_capture")!.definition.inputSchema!;
    const revision = runtimeWorldRevision("world-1", 7);
    const base = captureToolInput({
      runId: "20260717T184233Z-a1b2c3d4",
      captureLabel: "world-binding",
      instanceId: "runtime-instance-1",
      idempotencyKey: "world-binding",
      asynchronous: true,
    });

    expect(definition).not.toHaveProperty("expectedWorldId");
    expect(definition).not.toHaveProperty("expectedWorldEpoch");
    expect(definition.expectedWorldRevision.safeParse(undefined).success).toBe(true);
    expect(definition.expectedWorldRevision.safeParse(revision).success).toBe(true);

    const accepted = await call("observer_capture", { ...base, expectedWorldRevision: revision });
    expect(accepted.isError).not.toBe(true);
    expect(capture).toHaveBeenCalledOnce();
    expect(coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({
      expectedWorldRevision: revision,
      selectionMode: "explicit",
    }));

    const missingLegacyRevision = await call("observer_capture", base);
    expect(missingLegacyRevision.isError).toBe(true);
    expect(missingLegacyRevision.content[0].text).toContain("INVALID_REQUEST");

    const { instanceId: _instanceId, sessionId: _sessionId, ...delegatedInput } = base;
    const delegated = await call("observer_capture", delegatedInput);
    expect(delegated.isError).not.toBe(true);
    expect(coordinator.capture).toHaveBeenLastCalledWith(expect.objectContaining({ selectionMode: "delegated" }));
  });

  it("formats one validated PNG image and one concise text metadata item", async () => {
    const { call } = createToolHarness({
      capture: vi.fn(async () => ({
        asynchronous: false,
        image: png,
        job: {
          jobId: "job-1", instanceId: "instance-1", worldId: "world-1", worldEpoch: 4,
          artifact: { contaminated: false, warnings: [] },
        },
        metadata: {
          width: 1920, height: 1080,
          contentSha256: "a".repeat(64),
          completedAt: "2026-07-15T12:00:00.000Z",
          actualCamera: { position: [1, 2, 3] },
          contaminated: false, warnings: [],
        },
      })),
    });
    const result = await call("observer_capture", captureToolInput({
      expectedWorldRevision: runtimeWorldRevision("world-1", 4),
    }));

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);
    expect(result.content.filter((item) => item.type === "text")).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    expect(result.content[1].text).toContain('"worldEpoch": 4');
    expect(result.content[1].text).toContain('"width": 1920');
  });

  it("returns the retained JPEG MIME type for synchronous capture", async () => {
    const jpeg = Transformer.fromRgbaPixels(Buffer.from([255, 0, 0, 255]), 1, 1).jpegSync(60);
    const { call } = createToolHarness({
      capture: vi.fn(async () => ({
        asynchronous: false,
        image: jpeg,
        job: { jobId: "job-jpeg", instanceId: "instance-1" },
        metadata: { mimeType: "image/jpeg", format: "jpeg", width: 1, height: 1 },
      })),
    });
    const result = await call("observer_capture", captureToolInput({
      image: { format: "jpeg", quality: 60 },
      expectedWorldRevision: runtimeWorldRevision("world-jpeg", 1),
    }));

    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/jpeg",
      data: jpeg.toString("base64"),
    });
  });

  it("refuses an image larger than the MCP inline limit", async () => {
    const { call } = createToolHarness({
      maxInlineImageBytes: 8,
      capture: vi.fn(async () => ({
        asynchronous: false,
        image: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
        job: { jobId: "job-2" },
        metadata: {},
      })),
    });
    const result = await call("observer_capture", captureToolInput({
      expectedWorldRevision: runtimeWorldRevision("world-2", 5),
    }));

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("ARTIFACT_TOO_LARGE");
    expect(result.content[0].text).toContain('"jobId":"job-2"');
    expect(result.content.some((item) => item.type === "image")).toBe(false);
  });

  it("uses the sole configured evidence root when finalize omits evidenceRoot", async () => {
    const finalizeRun = vi.fn(async (input) => input);
    const coordinator = toolApplication({ finalizeRun });
    const tools = toolRegistry(coordinator, {} as never, {
      evidenceRoots: ["C:\\evidence"],
    });

    const result = await tools.get("observer_run_finalize")!.handler({
      runId: "20260717T184233Z-a1b2c3d4",
      includeCaptureLabels: ["proof"],
      review: {
        imagesReviewed: false,
        outcome: "Unreviewed",
        summary: "Pending review.",
      },
      releaseManagedArtifacts: true,
    }, { signal: new AbortController().signal });

    expect(result.isError).not.toBe(true);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      evidenceRoot: "C:\\evidence",
    }));
  });

  it("treats duplicate configured evidence roots as one effective destination", async () => {
    const finalizeRun = vi.fn(async (input) => input);
    const coordinator = toolApplication({ finalizeRun });
    const tools = toolRegistry(coordinator, {} as never, {
      evidenceRoots: ["C:\\evidence", "c:\\EVIDENCE"],
    });

    const result = await tools.get("observer_run_finalize")!.handler({
      runId: "20260717T184233Z-a1b2c3d4",
      includeCaptureLabels: ["proof"],
      review: {
        imagesReviewed: false,
        outcome: "Unreviewed",
        summary: "Pending review.",
      },
      releaseManagedArtifacts: true,
    }, { signal: new AbortController().signal });

    expect(result.isError).not.toBe(true);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      evidenceRoot: "C:\\evidence",
    }));
  });

  it("returns actionable errors when an omitted finalize root is absent or ambiguous", async () => {
    const input = {
      runId: "20260717T184233Z-a1b2c3d4",
      includeCaptureLabels: ["proof"],
      review: {
        imagesReviewed: false,
        outcome: "Unreviewed",
        summary: "Pending review.",
      },
      releaseManagedArtifacts: true,
    };
    const coordinator = toolApplication({ finalizeRun: vi.fn() });
    const withoutRoots = toolRegistry(coordinator);
    const noRoot = await withoutRoots.get("observer_run_finalize")!.handler(
      input,
      { signal: new AbortController().signal }
    );
    expect(noRoot.isError).toBe(true);
    expect(noRoot.content[0].text).toContain("CAPABILITY_UNAVAILABLE");
    expect(noRoot.content[0].text).toContain("--observer-evidence-root");

    const withMultiple = toolRegistry(coordinator, {} as never, {
      evidenceRoots: ["C:\\first", "C:\\second"],
    });
    const ambiguous = await withMultiple.get("observer_run_finalize")!.handler(
      input,
      { signal: new AbortController().signal }
    );
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("multiple evidence roots");
    expect(coordinator.finalizeRun).not.toHaveBeenCalled();
  });

  it("preserves a specific run failure at the public observer_run_status boundary", async () => {
    const coordinator = toolApplication({
      runStatus: vi.fn(async () => {
        throw new ObserverApplicationError(
          "ARTIFACT_INVALID",
          "The retained capture no longer verifies",
        );
      }),
    });
    const tools = toolRegistry(coordinator);

    const result = await tools.get("observer_run_status")!.handler({
      runId: "20260726T022925Z-d7867722",
    }, { signal: new AbortController().signal });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ARTIFACT_INVALID");
    expect(result.content[0].text).not.toContain("INTERNAL_ERROR");
  });

  it("preserves an explicit finalize root when multiple roots are configured", async () => {
    const finalizeRun = vi.fn(async (input) => input);
    const coordinator = toolApplication({ finalizeRun });
    const tools = toolRegistry(coordinator, {} as never, {
      evidenceRoots: ["C:\\first", "C:\\second"],
    });

    const result = await tools.get("observer_run_finalize")!.handler({
      runId: "20260717T184233Z-a1b2c3d4",
      evidenceRoot: "C:\\second",
      includeCaptureLabels: ["proof"],
      review: {
        imagesReviewed: false,
        outcome: "Unreviewed",
        summary: "Pending review.",
      },
      releaseManagedArtifacts: true,
    }, { signal: new AbortController().signal });

    expect(result.isError).not.toBe(true);
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      evidenceRoot: "C:\\second",
    }));
  });

  it("uses and clears the process-local active run without auto-adopting durable runs", async () => {
    const activeRunId = "20260804T120000Z-a1b2c3d4";
    const beginRun = vi.fn(async () => ({ runId: activeRunId, state: "open" }));
    const capture = vi.fn(async (input) => ({
      asynchronous: true as const,
      job: { jobId: "job-active-run", runId: input.runId, captureLabel: "current-1", state: "queued" },
    }));
    const runStatus = vi.fn(async (runId) => ({ runId, state: "open" }));
    const discardRun = vi.fn(async (runId) => ({ runId, discarded: true }));
    const first = createToolHarness({ beginRun, capture, runStatus, discardRun });

    expect((await first.call("observer_run_begin", { title: "Active run" })).isError).not.toBe(true);
    expect((await first.call("observer_capture", {
      view: { kind: "current" },
      asynchronous: true,
      timeoutMs: 30_000,
      settleFrames: 0,
      performancePolicy: "evidence",
    })).isError).not.toBe(true);
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({
      runId: activeRunId,
      selectionMode: "delegated",
    }));
    expect(capture.mock.calls[0][0]).not.toHaveProperty("captureLabel");

    expect((await first.call("observer_run_status", {})).isError).not.toBe(true);
    expect(runStatus).toHaveBeenLastCalledWith(activeRunId);
    expect((await first.call("observer_run_discard", {})).isError).not.toBe(true);
    expect(discardRun).toHaveBeenCalledWith(activeRunId);
    const cleared = await first.call("observer_run_status", {});
    expect(cleared.isError).toBe(true);
    expect(cleared.content[0].text).toContain("no active run");

    const secondRegistry = toolRegistry(toolApplication({ runStatus }));
    const notAdopted = await secondRegistry.get("observer_run_status")!.handler(
      {},
      { signal: new AbortController().signal },
    );
    expect(notAdopted.isError).toBe(true);
    expect(runStatus).toHaveBeenCalledTimes(1);
  });

  it("does not clear the active run when another explicit run is finalized or finalization fails", async () => {
    const activeRunId = "20260804T120100Z-b1c2d3e4";
    const otherRunId = "20260804T120200Z-c1d2e3f4";
    const beginRun = vi.fn(async () => ({ runId: activeRunId, state: "open" }));
    const runStatus = vi.fn(async (runId) => ({ runId, state: "open" }));
    const finalizeRun = vi.fn(async (input) => input.runId === otherRunId
      ? { run: { runId: otherRunId, state: "finalized" } }
      : Promise.reject(new ObserverApplicationError("ARTIFACT_INVALID", "finalization failed")));
    const tools = toolRegistry(toolApplication({ beginRun, runStatus, finalizeRun }), {} as never, {
      evidenceRoots: ["C:\\evidence"],
    });
    const signal = new AbortController().signal;
    await tools.get("observer_run_begin")!.handler({ title: "Active run" }, { signal });
    const finalizeInput = {
      includeCaptureLabels: ["current-1"],
      review: { imagesReviewed: false, outcome: "Unreviewed", summary: "Pending review." },
      releaseManagedArtifacts: true,
    };

    expect((await tools.get("observer_run_finalize")!.handler({
      ...finalizeInput,
      runId: otherRunId,
    }, { signal })).isError).not.toBe(true);
    await tools.get("observer_run_status")!.handler({}, { signal });
    expect(runStatus).toHaveBeenLastCalledWith(activeRunId);

    const failed = await tools.get("observer_run_finalize")!.handler(finalizeInput, { signal });
    expect(failed.isError).toBe(true);
    await tools.get("observer_run_status")!.handler({}, { signal });
    expect(runStatus).toHaveBeenLastCalledWith(activeRunId);
  });
});
