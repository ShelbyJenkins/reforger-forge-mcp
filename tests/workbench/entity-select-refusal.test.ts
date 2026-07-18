import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbEntityTools } from "../../src/tools/wb-entities.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredEntityTools(client: WorkbenchClient): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler): void => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerWbEntityTools(server, client);
  return handlers;
}

describe("wb_entity_select safe refusal", () => {
  it("refuses select before making a NET API call", async () => {
    const call = vi.fn();
    const client = { call } as unknown as WorkbenchClient;
    const handler = registeredEntityTools(client).get("wb_entity_select");

    expect(handler).toBeDefined();
    const result = await handler?.({ action: "select", name: "TargetEntity" });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("Selection Refused");
    expect(result?.content[0]?.text).toContain("existing selection was left unchanged");
    expect(call).not.toHaveBeenCalled();
  });

  it("the direct Workbench handler never clears selection or reports success", () => {
    const sourcePath = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_SelectEntity.c",
      import.meta.url
    ));
    const source = readFileSync(sourcePath, "utf8");
    const selectStart = source.indexOf('if (req.action == "select")');
    const selectEnd = source.indexOf('else if (req.action == "deselect")');
    const selectBranch = source.slice(selectStart, selectEnd);

    expect(selectStart).toBeGreaterThanOrEqual(0);
    expect(selectEnd).toBeGreaterThan(selectStart);
    expect(selectBranch).not.toContain("ClearEntitySelection");
    expect(selectBranch).not.toContain('resp.status = "ok"');
    expect(selectBranch).not.toContain("EMCP_WB_ExecuteAction");
    expect(selectBranch).toContain('resp.status = "error"');
    expect(selectBranch).toContain("existing selection was left unchanged");
  });
});
