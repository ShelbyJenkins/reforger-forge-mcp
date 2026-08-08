import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { registerWbLaunch } from "../../src/tools/wb-launch.js";
import {
  WorkbenchError,
  type WorkbenchClient,
} from "../../src/workbench/client.js";

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
}

interface ToolDefinition {
  readonly description?: string;
}

type ToolHandler = (
  input: { readonly gprojPath?: string; readonly resourcePath?: string }
) => Promise<ToolResult>;

function register(client: WorkbenchClient): {
  readonly handler: ToolHandler;
  readonly definition: ToolDefinition;
} {
  let handler: ToolHandler | undefined;
  let definition: ToolDefinition | undefined;
  const server = {
    registerTool(
      name: string,
      candidateDefinition: ToolDefinition,
      candidate: ToolHandler
    ): void {
      expect(name).toBe("wb_launch");
      definition = candidateDefinition;
      handler = candidate;
    },
  } as unknown as McpServer;
  registerWbLaunch(server, client);
  expect(handler).toBeDefined();
  expect(definition).toBeDefined();
  return { handler: handler!, definition: definition! };
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
    const client = {
      ensureRunning,
      state: { connected: false, mode: "unknown", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const { handler: tool, definition } = register(client);
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
    expect(definition.description).toContain("normal, focusable attended editor window");
    expect(definition.description).toContain("Cold configured-project enumeration is not available");
    expect(definition.description).not.toContain("exactly one configured project");
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
    const { handler: tool } = register(client);

    const missingProject = await tool({ resourcePath: "Worlds/Target.ent" });
    expect(missingProject.isError).toBe(true);
    expect(missingProject.content[0]?.text).toContain("`TARGET_REQUIRED`");
    expect(missingProject.content[0]?.text).toContain("`TARGET_REQUIRED` — ");
    expect(missingProject.content[0]?.text).not.toContain("â€”");
    expect(missingProject.content[0]?.text?.match(/Next action:/g)).toHaveLength(1);
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

  it("labels project compiler failures distinctly from lifecycle launch refusals", async () => {
    const ensureRunning = vi.fn(async () => {
      throw new WorkbenchError(
        "Workbench could not compile the Game project script module. First compiler diagnostic: Broken.c(7): Syntax error",
        "PROJECT_COMPILE_FAILED"
      );
    });
    const client = {
      ensureRunning,
      state: { connected: false, mode: "unknown", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const { handler } = register(client);

    const result = await handler({ gprojPath: "C:\\mods\\Broken\\Broken.gproj" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("**Project Compilation Failed**");
    expect(result.content[0]?.text).toContain("`PROJECT_COMPILE_FAILED`");
    expect(result.content[0]?.text).toContain("Broken.c(7): Syntax error");
    expect(result.content[0]?.text).not.toContain("**Launch Refused**");
    expect(result.content[0]?.text).not.toContain("Next action:");
  });

  it("retains generic launch error treatment", async () => {
    const ensureRunning = vi.fn(async () => {
      throw new Error("generic launch failure");
    });
    const client = {
      ensureRunning,
      state: { connected: false, mode: "unknown", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const { handler } = register(client);

    const result = await handler({ gprojPath: "C:\\mods\\Example\\Example.gproj" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("generic launch failure");
    expect(result.content[0]?.text).not.toContain("`LAUNCH_FAILED`");
  });
});
