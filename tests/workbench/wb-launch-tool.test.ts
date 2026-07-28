import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { registerWbLaunch } from "../../src/tools/wb-launch.js";
import {
  WorkbenchError,
  type WorkbenchClient,
} from "../../src/workbench/client.js";

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
}

type ToolHandler = (
  input: { readonly gprojPath?: string; readonly resourcePath?: string }
) => Promise<ToolResult>;

function config(): Config {
  return {
    workbenchPath: "C:\\Arma Reforger Tools",
    gamePath: "C:\\Arma Reforger",
    dataDir: "C:\\ReforgerForge\\data",
    patternsDir: "C:\\ReforgerForge\\data\\patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
}

function register(client: WorkbenchClient, effectiveConfig: Config): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(
      name: string,
      _definition: unknown,
      candidate: ToolHandler
    ): void {
      expect(name).toBe("wb_launch");
      handler = candidate;
    },
  } as unknown as McpServer;
  registerWbLaunch(server, effectiveConfig, client);
  expect(handler).toBeDefined();
  return handler!;
}

describe("wb_launch MCP tool", () => {
  it("preserves missing dependency diagnostics and INVALID_CONFIG publicly", async () => {
    const guid = "E62D3489FAA8E058";
    const message =
      "Workbench cannot resolve every dependency declared by the target project. " +
      `Missing dependency GUID(s): ${guid}. ` +
      "Add the add-on root containing each missing project to workbenchAddonDirs, " +
      "or pass --workbench-addon-dir <directory> once for each required root. " +
      "No Workbench process was launched.";
    const ensureRunning = vi.fn(async () => {
      throw new WorkbenchError(message, "INVALID_CONFIG");
    });
    const effectiveConfig = config();
    const client = {
      ensureRunning,
      state: { connected: false, mode: "unknown", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const tool = register(client, effectiveConfig);
    const gprojPath =
      "C:\\mods\\OnePointZeroOne\\TestContent\\OnePointZeroOneTestContent.gproj";

    const result = await tool({ gprojPath });
    const text = result.content.map((item) => item.text ?? "").join("\n");

    expect(result.isError).toBe(true);
    expect(text).toContain("**Launch Refused**");
    expect(text).toContain("`INVALID_CONFIG`");
    expect(text).toContain(guid);
    expect(text).toContain("workbenchAddonDirs");
    expect(text).toContain("--workbench-addon-dir <directory>");
    expect(text).toContain("No Workbench process was launched.");
    expect(text).toContain("`Workbench: disconnected`");
    expect(ensureRunning).toHaveBeenCalledOnce();
    expect(ensureRunning).toHaveBeenCalledWith(gprojPath);
    expect(effectiveConfig.defaultMod).toBeUndefined();
  });

  it("requires an explicit project and uses the target-bound launch path for a resource", async () => {
    const ensureRunning = vi.fn();
    const ensureTargetResourceRunning = vi.fn(async () => ({
      action: "launched" as const,
      pid: 1234,
      gprojPath: "C:\\mods\\Example\\Example.gproj",
      generation: "generation-a",
      resourcePath: "C:\\mods\\Example\\Worlds\\Target.ent",
      targetBound: true as const,
    }));
    const client = {
      ensureRunning,
      ensureTargetResourceRunning,
      state: { connected: false, mode: "unknown", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const tool = register(client, config());

    const missingProject = await tool({ resourcePath: "Worlds/Target.ent" });
    expect(missingProject.isError).toBe(true);
    expect(missingProject.content[0]?.text).toContain("`TARGET_REQUIRED`");
    expect(ensureTargetResourceRunning).not.toHaveBeenCalled();

    const result = await tool({
      gprojPath: "C:\\mods\\Example\\Example.gproj",
      resourcePath: "C:\\mods\\Example\\Worlds\\Target.ent",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("Resource target");
    expect(result.content[0]?.text).toContain("wb_save_resource");
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(ensureTargetResourceRunning).toHaveBeenCalledWith(
      "C:\\mods\\Example\\Example.gproj",
      "C:\\mods\\Example\\Worlds\\Target.ent"
    );
  });
});
