import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { SearchEngine } from "../../src/index/search-engine.js";

const lifecycle = vi.hoisted(() => ({
  close: vi.fn(async () => ({
    errorRuntimes: [] as Array<{ runtimeId: string; reason: string }>,
    busyRuntimeIds: [] as string[],
    applicationCloseSafe: true,
  })),
  emergencyTerminate: vi.fn(),
  idleProvider: {
    currentIdleRevision: () => 0,
    inspectIdleShutdownReadiness: async () => ({ complete: true, blockers: [], revision: 0 }),
  },
}));

vi.mock("../../src/observer/application.js", () => ({
  createObserverApplication: () => ({
    ownedRuntimeManager: lifecycle.idleProvider,
    agentClient: lifecycle.idleProvider,
    captureService: lifecycle.idleProvider,
    closeRuntimeLifecycle: lifecycle.close,
    emergencyTerminatePrivateChildren: lifecycle.emergencyTerminate,
  }),
}));

vi.mock("../../src/observer/tools.js", () => ({
  registerObserverTools: vi.fn(),
}));

import { registerTools } from "../../src/server.js";
import { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";

const fullDataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../data");

function config(): Config {
  return {
    workbenchPath: process.cwd(),
    gamePath: process.cwd(),
    dataDir: process.cwd(),
    patternsDir: process.cwd(),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    mcpIdleShutdownMs: 1_800_000,
  };
}

describe("project-neutral registerTools shutdown ownership", () => {
  beforeEach(() => {
    lifecycle.close.mockReset();
    lifecycle.close.mockResolvedValue({
      errorRuntimes: [] as Array<{ runtimeId: string; reason: string }>,
      busyRuntimeIds: [] as string[],
      applicationCloseSafe: true,
    });
    lifecycle.emergencyTerminate.mockReset();
  });

  it("returns the supported, idempotent observer lifecycle disposer", async () => {
    const server = new McpServer({ name: "embedded-test", version: "1.0.0" });
    const disposeTools = registerTools(server, config());

    expect(lifecycle.close).not.toHaveBeenCalled();
    const [first, simultaneous] = await Promise.all([disposeTools(), disposeTools()]);
    expect(first).toEqual(simultaneous);
    await expect(disposeTools()).resolves.toEqual(first);
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });

  it("exposes a bounded read-only idle proof without invoking lifecycle cleanup", async () => {
    const lifecycleRead = vi.spyOn(WorkbenchProcessGuard.prototype, "readLifecycleStateExistingOnly")
      .mockResolvedValue({ kind: "missing" });
    const journalRead = vi.spyOn(WorkbenchProcessGuard.prototype, "readSpawnJournalExistingOnly")
      .mockResolvedValue({ kind: "missing" });
    try {
      const server = new McpServer({ name: "idle-proof-test", version: "1.0.0" });
      const disposeTools = registerTools(server, config());
      const readiness = await disposeTools.inspectIdleShutdownReadiness({
        deadlineTick: performance.now() + 1_000,
        signal: new AbortController().signal,
        probeGeneration: 7,
      });
      expect(readiness).toMatchObject({ complete: true, blockers: [], probeGeneration: 7 });
      expect(readiness.sealProof).not.toBeNull();
      expect(lifecycle.close).not.toHaveBeenCalled();
      expect(disposeTools.trySealIdleAdmissions(readiness.sealProof)).toBe(true);
      await expect(disposeTools()).resolves.toMatchObject({ applicationCloseSafe: true });
    } finally {
      lifecycleRead.mockRestore();
      journalRead.mockRestore();
    }
  });

  it("registers the complete server without loading an injected full search index", async () => {
    const server = new McpServer({ name: "lazy-index-test", version: "1.0.0" });
    const searchEngine = new SearchEngine(fullDataDir);
    const disposeTools = registerTools(server, config(), { searchEngine });

    expect(searchEngine.isLoaded()).toBe(false);
    await disposeTools();
    expect(searchEngine.isLoaded()).toBe(false);
  });

  it("clears failed and fulfilled-unsafe attempts so the same lifecycle can retry", async () => {
    lifecycle.close
      .mockRejectedValueOnce(Object.assign(new Error("unsafe"), { code: "SHUTDOWN_SEAL_FAILED" }))
      .mockResolvedValueOnce({
        errorRuntimes: [],
        busyRuntimeIds: ["runtime-busy"],
        applicationCloseSafe: false,
      })
      .mockResolvedValueOnce({
        errorRuntimes: [],
        busyRuntimeIds: [],
        applicationCloseSafe: true,
      });
    const server = new McpServer({ name: "embedded-test", version: "1.0.0" });
    const disposeTools = registerTools(server, config());

    await expect(disposeTools()).rejects.toMatchObject({ code: "SHUTDOWN_SEAL_FAILED" });
    await expect(disposeTools()).resolves.toMatchObject({ applicationCloseSafe: false });
    await expect(disposeTools()).resolves.toMatchObject({ applicationCloseSafe: true });
    await expect(disposeTools()).resolves.toMatchObject({ applicationCloseSafe: true });
    expect(lifecycle.close).toHaveBeenCalledTimes(3);
  });

  it("releases the Workbench process guard's LMDB environment on disposal", async () => {
    const closeSpy = vi.spyOn(WorkbenchProcessGuard.prototype, "close");
    try {
      const server = new McpServer({ name: "embedded-test", version: "1.0.0" });
      const disposeTools = registerTools(server, config());
      expect(closeSpy).not.toHaveBeenCalled();
      await disposeTools();
      expect(closeSpy).toHaveBeenCalledOnce();
      // Idempotent: a second disposal does not re-close the guard.
      await disposeTools();
      expect(closeSpy).toHaveBeenCalledOnce();
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("exposes private-child emergency termination without exiting an embedded host", () => {
    const server = new McpServer({ name: "embedded-test", version: "1.0.0" });
    const disposeTools = registerTools(server, config());
    const exit = vi.spyOn(process, "exit");
    try {
      disposeTools.emergencyTerminate();
      expect(lifecycle.emergencyTerminate).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });
});
