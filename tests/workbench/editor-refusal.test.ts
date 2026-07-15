import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { WorkbenchClient } from "../../src/workbench/client.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredEditorTools(client: WorkbenchClient): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler): void => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerWbEditorTools(server, client);
  return handlers;
}

describe("registered unattended editor refusals", () => {
  it("wb_play refuses without making any NET API call", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1);
    const call = vi.spyOn(client, "call");
    const handler = registeredEditorTools(client).get("wb_play");

    expect(handler).toBeDefined();
    const result = await handler?.({ debugMode: true, fullScreen: true });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("Play Refused");
    expect(result?.content[0]?.text).toContain("standalone diagnostic/autotest runtime launcher");
    expect(call).not.toHaveBeenCalled();
  });

  it("wb_save and save-as refuse before any operation that could open a modal", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1);
    const call = vi.spyOn(client, "call");
    const handler = registeredEditorTools(client).get("wb_save");

    expect(handler).toBeDefined();
    const save = await handler?.({});
    const saveAs = await handler?.({ path: "Worlds/NeverOpened.ent" });

    expect(save?.isError).toBe(true);
    expect(save?.content[0]?.text).toContain("Save Refused");
    expect(saveAs?.isError).toBe(true);
    expect(saveAs?.content[0]?.text).toContain("unattended save-as");
    expect(saveAs?.content[0]?.text).not.toContain("Save Pending");
    expect(call).not.toHaveBeenCalled();
  });
});
