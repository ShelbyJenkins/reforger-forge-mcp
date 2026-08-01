import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbComponent } from "../../src/tools/wb-components.js";
import { registerWbEntityTools } from "../../src/tools/wb-entities.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  definition: {
    inputSchema: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  };
  handler(input: Record<string, unknown>): Promise<ToolResult>;
}

function register(
  registration: (server: McpServer, client: WorkbenchClient) => void,
  client: WorkbenchClient
): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, definition: RegisteredTool["definition"], handler: RegisteredTool["handler"]): void => {
      tools.set(name, { definition, handler });
    },
  } as unknown as McpServer;
  registration(server, client);
  return tools;
}

describe("unnamed editor entity index tools", () => {
  it("passes entityIndex through wb_component", async () => {
    const call = vi.fn(async () => ({ status: "ok", components: [] }));
    const client = {
      state: { connected: true, mode: "edit", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient;
    const tool = register(registerWbComponent, client).get("wb_component")!;

    expect(tool.definition.inputSchema.entityIndex.safeParse(1).success).toBe(true);
    const result = await tool.handler({ entityIndex: 1, action: "list" });

    expect(result.isError).not.toBe(true);
    expect(call).toHaveBeenCalledWith("EMCP_WB_Components", { action: "list", entityIndex: 1 });
  });

  it("passes entityIndex through wb_entity_modify", async () => {
    const call = vi.fn(async () => ({ status: "ok", message: "42" }));
    const client = {
      state: { connected: true, mode: "edit", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient;
    const tool = register(registerWbEntityTools, client).get("wb_entity_modify")!;

    expect(tool.definition.inputSchema.entityIndex.safeParse(1).success).toBe(true);
    const result = await tool.handler({
      entityIndex: 1,
      action: "getProperty",
      propertyPath: "RFO_LivePersistenceProbeComponent",
      propertyKey: "m_iProbeValue",
    });

    expect(result.isError).not.toBe(true);
    expect(call).toHaveBeenCalledWith("EMCP_WB_ModifyEntity", {
      action: "getProperty",
      entityIndex: 1,
      propertyPath: "RFO_LivePersistenceProbeComponent",
      propertyKey: "m_iProbeValue",
    });
  });
});
