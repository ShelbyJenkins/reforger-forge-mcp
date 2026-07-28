import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerWbResources } from "../../src/tools/wb-resources.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

interface RegisteredTool {
  readonly name: string;
  readonly definition: {
    readonly description: string;
    readonly inputSchema: {
      readonly action: {
        safeParse(value: unknown): { readonly success: boolean };
      };
    };
  };
}

function register(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const server = {
    registerTool(name: string, definition: RegisteredTool["definition"]): void {
      tool = { name, definition };
    },
  } as unknown as McpServer;
  const client = {
    state: { connected: false, mode: "unknown", lastUpdated: 0 },
  } as unknown as WorkbenchClient;

  registerWbResources(server, client);
  if (!tool) throw new Error("Expected wb_resources registration");
  return tool;
}

describe("wb_resources MCP schema", () => {
  it("does not advertise the unsupported browse action", () => {
    const tool = register();

    expect(tool.name).toBe("wb_resources");
    expect(tool.definition.inputSchema.action.safeParse("register").success).toBe(true);
    expect(tool.definition.inputSchema.action.safeParse("browse").success).toBe(false);
    expect(tool.definition.description).not.toMatch(/browse/i);
  });
});
