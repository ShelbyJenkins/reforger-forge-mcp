import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createObserverApplication as createAgentApplication } from "../../observer/agent/application.js";
import { createObserverApplication as createHostApplication } from "../../src/observer/application.js";
import { registerObserverTools } from "../../src/observer/tools.js";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

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
          "observer_run",
        ]);
      } finally {
        await app.close();
      }
    }, { prefix: "rfo-host-registration-" });
  });
});
