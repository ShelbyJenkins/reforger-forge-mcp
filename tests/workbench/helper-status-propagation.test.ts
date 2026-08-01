import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { registerWbPrefabs } from "../../src/tools/wb-prefabs.js";
import { registerWbResources } from "../../src/tools/wb-resources.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

function registeredTools(
  register: (server: McpServer, client: WorkbenchClient) => void,
  client: WorkbenchClient
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: ToolHandler): void => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  register(server, client);
  return handlers;
}

function helperErrorClient(message: string): {
  client: WorkbenchClient;
  call: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn(async (apiFunc: string) => {
    if (apiFunc === "EMCP_WB_GetState") return { mode: "edit" };
    return { status: "error", message };
  });
  const client = {
    state: { connected: true, mode: "edit", lastUpdated: Date.now() },
    call,
  } as unknown as WorkbenchClient;
  return { client, call };
}

describe("Workbench helper status propagation", () => {
  it("registers from a generic no-document session with an operation-specific deadline", async () => {
    const call = vi.fn(async (apiFunc: string) => {
      if (apiFunc === "EMCP_WB_GetState") return { mode: "no_world_editor" };
      return { status: "ok", message: "Resource registered" };
    });
    const client = {
      state: { connected: true, mode: "unknown", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient;
    const handler = registeredTools(registerWbResources, client).get("wb_resources");

    const result = await handler?.({ action: "register", path: "C:\\Mods\\Example\\New.et" });

    expect(result?.isError).not.toBe(true);
    expect(call).toHaveBeenNthCalledWith(
      2,
      "EMCP_WB_Resources",
      { action: "register", path: "C:\\Mods\\Example\\New.et" },
      { timeout: 120_000, skipAutoLaunch: true }
    );
  });

  it.each([
    ["register", "RegisterResourceFile returned false for: Prefabs/Failed.et"],
    ["open", "SetOpenedResource returned false for: Prefabs/Failed.et"],
  ])("wb_resources exposes a helper %s failure", async (action, message) => {
    const { client } = helperErrorClient(message);
    const handler = registeredTools(registerWbResources, client).get("wb_resources");

    const result = await handler?.({ action, path: "Prefabs/Failed.et" });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain(message);
    expect(result?.content[0]?.text).not.toContain("No resources found");
  });

  it("wb_open_resource exposes a helper failure", async () => {
    const message = "SetOpenedResource returned false for: Prefabs/Failed.et";
    const { client } = helperErrorClient(message);
    const handler = registeredTools(registerWbEditorTools, client).get("wb_open_resource");

    const result = await handler?.({ path: "Prefabs/Failed.et" });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain(message);
    expect(result?.content[0]?.text).not.toContain("Resource Opened");
  });

  it("wb_prefabs exposes failed ancestor and save operations", async () => {
    const message = "Entity not found: MissingEntity";
    const { client } = helperErrorClient(message);
    const handlers = registeredTools(registerWbPrefabs, client);

    const ancestor = await handlers.get("wb_prefabs")?.({
      action: "getAncestor",
      entityName: "MissingEntity",
    });
    const save = await handlers.get("wb_prefabs")?.({
      action: "save",
      entityName: "MissingEntity",
    });

    expect(ancestor?.isError).toBe(true);
    expect(ancestor?.content[0]?.text).toContain(message);
    expect(ancestor?.content[0]?.text).not.toContain("Ancestor Prefab");
    expect(save?.isError).toBe(true);
    expect(save?.content[0]?.text).toContain(message);
    expect(save?.content[0]?.text).not.toContain("Prefab Saved");
  });

  it("resource-opening helpers report false native results as errors", () => {
    const resourcesPath = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Resources.c",
      import.meta.url
    ));
    const editorPath = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_EditorControl.c",
      import.meta.url
    ));
    const resources = readFileSync(resourcesPath, "utf8");
    const editor = readFileSync(editorPath, "utf8");

    expect(resources).toMatch(
      /if \(result\)\s*\{\s*resp\.status = "ok";[\s\S]*?\}\s*else\s*\{\s*resp\.status = "error";\s*resp\.message = "RegisterResourceFile returned false/
    );
    expect(resources).toMatch(
      /if \(result\)\s*\{\s*resp\.status = "ok";[\s\S]*?\}\s*else\s*\{\s*resp\.status = "error";\s*resp\.message = "SetOpenedResource returned false/
    );
    expect(editor).toMatch(
      /if \(opened\)\s*\{\s*resp\.status = "ok";[\s\S]*?\}\s*else\s*\{\s*resp\.status = "error";\s*resp\.message = "SetOpenedResource returned false/
    );
  });

  it("resource-opening helpers reject unresolved resource paths before opening", () => {
    const resourcesPath = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Resources.c",
      import.meta.url
    ));
    const editorPath = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_EditorControl.c",
      import.meta.url
    ));
    const resources = readFileSync(resourcesPath, "utf8");
    const editor = readFileSync(editorPath, "utf8");

    for (const source of [resources, editor]) {
      expect(source).toContain("GetMetaFile(req.path)");
      expect(source).toContain(
        'resp.message = "Resource metadata not found for: " + req.path;'
      );
    }
  });

  it("the state helper distinguishes no document from actual Play mode", () => {
    const statePath = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_GetState.c",
      import.meta.url
    ));
    const pingPath = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c",
      import.meta.url
    ));

    for (const source of [readFileSync(statePath, "utf8"), readFileSync(pingPath, "utf8")]) {
      expect(source).toContain("GetGame().InPlayMode()");
      expect(source).toContain('resp.mode = "game";');
      expect(source).toContain('resp.mode = "no_world_editor";');
    }
  });

  it("gives every direct resource-registration wrapper the extended deadline", () => {
    const wrapperPaths = [
      "../../src/tools/game-duplicate.ts",
      "../../src/tools/wb-entity-duplicate.ts",
    ];

    for (const relativePath of wrapperPaths) {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      const source = readFileSync(path, "utf8");
      expect(source).toContain("{ timeout: 120_000, skipAutoLaunch: true }");
      expect(source).not.toContain("{ timeout: 30000 }");
    }
  });
});
