import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { WorkbenchClient, type WorkbenchState } from "../../src/workbench/client.js";

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

function stubClient(initialState: WorkbenchState, refreshedModes: WorkbenchState["mode"][] = []): {
  client: WorkbenchClient;
  call: ReturnType<typeof vi.fn>;
} {
  const state = { ...initialState };
  const pendingModes = [...refreshedModes];
  const call = vi.fn(async (apiFunc: string) => {
    if (apiFunc === "EMCP_WB_GetState") {
      const nextMode = pendingModes.shift();
      if (nextMode !== undefined) state.mode = nextMode;
    }
    return { mode: state.mode };
  });
  const client = {
    get state() {
      return state;
    },
    call,
  } as unknown as WorkbenchClient;
  return { client, call };
}

describe("registered editor stop safeguards", () => {
  it("wb_stop confirms cached edit mode before returning its idempotent success", async () => {
    const { client, call } = stubClient({
      connected: true,
      mode: "edit",
      lastUpdated: Date.now(),
    });
    const handler = registeredEditorTools(client).get("wb_stop");

    const result = await handler?.({});

    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("Already Stopped");
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      "EMCP_WB_GetState",
      {},
      { skipAutoLaunch: true }
    );
  });

  it("wb_stop safely refreshes a connected unknown mode before deciding", async () => {
    const { client, call } = stubClient({
      connected: true,
      mode: "unknown",
      lastUpdated: Date.now(),
    }, ["edit"]);
    const handler = registeredEditorTools(client).get("wb_stop");

    const result = await handler?.({});

    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("Already Stopped");
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(
      "EMCP_WB_GetState",
      {},
      { skipAutoLaunch: true }
    );
  });

  it("wb_stop does not auto-refresh a disconnected client with unknown mode", async () => {
    const { client, call } = stubClient({
      connected: false,
      mode: "unknown",
      lastUpdated: 0,
    });
    const handler = registeredEditorTools(client).get("wb_stop");

    const result = await handler?.({});

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("mode is unknown");
    expect(result?.content[0]?.text).toContain("wb_state");
    expect(call).not.toHaveBeenCalled();
  });

  it("wb_stop confirms edit mode after Workbench acknowledges the stop command", async () => {
    const { client, call } = stubClient({
      connected: true,
      mode: "play",
      lastUpdated: Date.now(),
    }, ["play", "edit"]);
    const handler = registeredEditorTools(client).get("wb_stop");

    const result = await handler?.({});

    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("Edit Mode Restored");
    expect(result?.content[0]?.text).toContain("Workbench: edit mode");
    expect(call).toHaveBeenNthCalledWith(1, "EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(call).toHaveBeenNthCalledWith(2, "EMCP_WB_EditorControl", { action: "stop" });
    expect(call).toHaveBeenNthCalledWith(3, "EMCP_WB_GetState", {}, { skipAutoLaunch: true });
  });

  it("wb_stop fails closed when the post-command state remains in game mode", async () => {
    const { client, call } = stubClient({
      connected: true,
      mode: "play",
      lastUpdated: Date.now(),
    });
    const handler = registeredEditorTools(client).get("wb_stop");

    const result = await handler?.({});

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("Edit Mode Not Confirmed");
    expect(result?.content[0]?.text).toContain("`play`");
    expect(result?.content[0]?.text).toContain("Workbench: play mode");
    expect(call).toHaveBeenNthCalledWith(1, "EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(call).toHaveBeenNthCalledWith(2, "EMCP_WB_EditorControl", { action: "stop" });
    expect(call).toHaveBeenNthCalledWith(3, "EMCP_WB_GetState", {}, { skipAutoLaunch: true });
  });

  it("wb_stop stops when a cached edit state has gone stale into play mode", async () => {
    const { client, call } = stubClient({
      connected: true,
      mode: "edit",
      lastUpdated: Date.now(),
    }, ["play", "edit"]);
    const handler = registeredEditorTools(client).get("wb_stop");

    const result = await handler?.({});

    expect(result?.isError).not.toBe(true);
    expect(result?.content[0]?.text).toContain("Edit Mode Restored");
    expect(result?.content[0]?.text).not.toContain("Already Stopped");
    expect(call).toHaveBeenNthCalledWith(1, "EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(call).toHaveBeenNthCalledWith(2, "EMCP_WB_EditorControl", { action: "stop" });
    expect(call).toHaveBeenNthCalledWith(3, "EMCP_WB_GetState", {}, { skipAutoLaunch: true });
  });
});
