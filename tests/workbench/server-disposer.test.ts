import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";

const lifecycle = vi.hoisted(() => ({
  close: vi.fn(async () => ({
    errorRuntimes: ["runtime-unverifiable"],
    busyRuntimeIds: ["runtime-busy"],
  })),
}));

vi.mock("../../src/observer/application.js", () => ({
  createObserverApplication: () => ({
    ownedRuntimeManager: {},
    closeRuntimeLifecycle: lifecycle.close,
  }),
}));

vi.mock("../../src/observer/tools.js", () => ({
  registerObserverTools: vi.fn(),
}));

import { registerTools } from "../../src/server.js";

function config(): Config {
  return {
    workbenchPath: process.cwd(),
    projectPath: process.cwd(),
    gamePath: process.cwd(),
    dataDir: process.cwd(),
    patternsDir: process.cwd(),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
}

describe("registerTools explicit shutdown ownership", () => {
  it("returns the supported, idempotent observer lifecycle disposer", async () => {
    const server = new McpServer({ name: "embedded-test", version: "1.0.0" });
    const disposeTools = registerTools(server, config());

    expect(lifecycle.close).not.toHaveBeenCalled();
    await expect(disposeTools()).resolves.toEqual({
      errorRuntimes: ["runtime-unverifiable"],
      busyRuntimeIds: ["runtime-busy"],
    });
    await expect(disposeTools()).resolves.toEqual({
      errorRuntimes: ["runtime-unverifiable"],
      busyRuntimeIds: ["runtime-busy"],
    });
    expect(lifecycle.close).toHaveBeenCalledOnce();
  });
});
