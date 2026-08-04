import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, resolve } from "node:path";
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
}));

vi.mock("../../src/observer/application.js", () => ({
  createObserverApplication: () => ({
    ownedRuntimeManager: {},
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
