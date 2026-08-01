import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { registerWbLayers } from "../../src/tools/wb-layers.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

interface RegisteredTool {
  readonly definition: {
    readonly inputSchema: {
      readonly action: { safeParse(value: unknown): { readonly success: boolean } };
    };
  };
  readonly handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function register(client: WorkbenchClient): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const server = {
    registerTool: (_name: string, definition: RegisteredTool["definition"], handler: RegisteredTool["handler"]): void => {
      tool = { definition, handler };
    },
  } as unknown as McpServer;
  registerWbLayers(server, client);
  if (!tool) throw new Error("Expected wb_layers registration");
  return tool;
}

describe("wb_layers MCP tool", () => {
  it("advertises only actions implemented by the staged helper", () => {
    const tool = register({ state: { connected: false, mode: "unknown", lastUpdated: 0 } } as WorkbenchClient);

    expect(tool.definition.inputSchema.action.safeParse("list").success).toBe(true);
    expect(tool.definition.inputSchema.action.safeParse("getEntityLayer").success).toBe(true);
    expect(tool.definition.inputSchema.action.safeParse("delete").success).toBe(false);
    expect(tool.definition.inputSchema.action.safeParse("create").success).toBe(false);
  });

  it("returns an error when the helper rejects an advertised action", async () => {
    const call = vi.fn(async (apiFunc: string) => {
      if (apiFunc === "EMCP_WB_GetState") return { mode: "edit" };
      return { status: "error", message: "Unknown action: getInfo" };
    });
    const tool = register({
      state: { connected: true, mode: "edit", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient);

    const result = await tool.handler({ action: "getInfo", subScene: 0, layerPath: "7" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown action: getInfo");
    expect(result.content[0]?.text).not.toContain("Layer Updated");
  });
});
