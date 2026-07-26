import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ObserverCoordinatorError } from "../../src/observer/errors.js";
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
    registerObserverTools(server, coordinator);
    const client = new Client({ name: "observer-schema-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const capture = listed.tools.find((tool) => tool.name === "observer_capture");
      expect(capture).toBeDefined();

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

      const captureSchema = toolRegistry(coordinator).get("observer_capture")!.definition.inputSchema!;
      const view = captureSchema.view;
      expect(captureSchema.performancePolicy.safeParse("performance").success).toBe(false);
      expect(captureSchema.performancePolicy.safeParse("instrumented").success).toBe(true);
      expect(captureSchema.runId.safeParse("20260717T184233Z-a1b2c3d4").success).toBe(true);
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
    const { coordinator, tools, call } = createToolHarness({
      instances: vi.fn(async () => ({
        instances: [{
          instanceId: "runtime-null-world", sessionId: "session-1", worldId: null, worldEpoch: 7,
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

    const expectedWorldId = tools.get("observer_capture")!.definition.inputSchema!.expectedWorldId;
    expect(expectedWorldId.safeParse(null).success).toBe(true);
    expect(expectedWorldId.safeParse(undefined).success).toBe(true);
    const capture = await call("observer_capture", captureToolInput({
      runId: "20260717T184233Z-a1b2c3d4",
      captureLabel: "null-world-current",
      instanceId: "runtime-null-world",
      idempotencyKey: "null-world-current",
      asynchronous: true,
      expectedWorldId: null,
      expectedWorldEpoch: 7,
    }));
    expect(capture.isError).not.toBe(true);
    expect(coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({
      expectedWorldId: null,
      expectedWorldEpoch: 7,
      view: { kind: "current" },
    }));
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
    const result = await call("observer_capture", captureToolInput());

    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(2);
    expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);
    expect(result.content.filter((item) => item.type === "text")).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    expect(result.content[1].text).toContain('"worldEpoch": 4');
    expect(result.content[1].text).toContain('"width": 1920');
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
    const result = await call("observer_capture", captureToolInput());

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

    const result = await tools.get("observer_run")!.handler({
      action: "finalize",
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

    const result = await tools.get("observer_run")!.handler({
      action: "finalize",
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
      action: "finalize",
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
    const noRoot = await withoutRoots.get("observer_run")!.handler(
      input,
      { signal: new AbortController().signal }
    );
    expect(noRoot.isError).toBe(true);
    expect(noRoot.content[0].text).toContain("CAPABILITY_UNAVAILABLE");
    expect(noRoot.content[0].text).toContain("--project-path");

    const withMultiple = toolRegistry(coordinator, {} as never, {
      evidenceRoots: ["C:\\first", "C:\\second"],
    });
    const ambiguous = await withMultiple.get("observer_run")!.handler(
      input,
      { signal: new AbortController().signal }
    );
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("multiple evidence roots");
    expect(coordinator.finalizeRun).not.toHaveBeenCalled();
  });

  it("preserves a specific run failure at the public observer_run boundary", async () => {
    const coordinator = toolApplication({
      runStatus: vi.fn(async () => {
        throw new ObserverCoordinatorError(
          "ARTIFACT_INVALID",
          "The retained capture no longer verifies",
        );
      }),
    });
    const tools = toolRegistry(coordinator);

    const result = await tools.get("observer_run")!.handler({
      action: "status",
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

    const result = await tools.get("observer_run")!.handler({
      action: "finalize",
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
});
