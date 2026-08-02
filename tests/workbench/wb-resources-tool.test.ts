import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerWbResources } from "../../src/tools/wb-resources.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

interface ToolResult {
  readonly content: Array<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

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
  readonly handler: (input: Record<string, unknown>) => Promise<ToolResult>;
}

function register(clientOverride?: WorkbenchClient): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      definition: RegisteredTool["definition"],
      handler: RegisteredTool["handler"]
    ): void {
      tool = { name, definition, handler };
    },
  } as unknown as McpServer;
  const client = clientOverride ?? {
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
    expect(tool.definition.description).toMatch(/absolute existing file.*exact active/i);
  });

  it("refuses deferred registration for a file outside the exact active project", async () => {
    await withTemporaryDirectory(async (root) => {
      const activeAddon = join(root, "addons", "Active");
      const otherAddon = join(root, "addons", "Other");
      const activeGprojPath = join(activeAddon, "Active.gproj");
      const outsideResourcePath = join(otherAddon, "Prefabs", "Outside.et");
      mkdirSync(activeAddon, { recursive: true });
      mkdirSync(join(otherAddon, "Prefabs"), { recursive: true });
      writeFileSync(activeGprojPath, "GameProject {}\n", "utf8");
      writeFileSync(outsideResourcePath, "GenericEntity {}\n", "utf8");
      const call = vi.fn(async (apiFunc: string) =>
        apiFunc === "EMCP_WB_GetState"
          ? { mode: "no_world_editor" }
          : { status: "ok" }
      );
      const tool = register({
        state: { connected: true, mode: "unknown", lastUpdated: Date.now() },
        activeProjectGprojPath: async () => activeGprojPath,
        call,
      } as unknown as WorkbenchClient);

      const result = await tool.handler({ action: "register", path: outsideResourcePath });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/outside the active Workbench project/i);
      expect(call).not.toHaveBeenCalledWith(
        "EMCP_WB_Resources",
        expect.anything(),
        expect.anything()
      );
    }, { prefix: "rfo-resource-project-identity-" });
  });

  it("refuses a relative deferred-registration path before the helper call", async () => {
    await withTemporaryDirectory(async (root) => {
      const addon = join(root, "Example");
      const gprojPath = join(addon, "Example.gproj");
      mkdirSync(addon, { recursive: true });
      writeFileSync(gprojPath, "GameProject {}\n", "utf8");
      const call = vi.fn(async (apiFunc: string) =>
        apiFunc === "EMCP_WB_GetState" ? { mode: "no_world_editor" } : { status: "ok" }
      );
      const tool = register({
        state: { connected: true, mode: "unknown", lastUpdated: Date.now() },
        activeProjectGprojPath: async () => gprojPath,
        call,
      } as unknown as WorkbenchClient);

      const result = await tool.handler({ action: "register", path: "Prefabs/Relative.et" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/requires an absolute filesystem path/i);
      expect(call).not.toHaveBeenCalledWith(
        "EMCP_WB_Resources",
        expect.anything(),
        expect.anything()
      );
    }, { prefix: "rfo-resource-relative-" });
  });

  it.each([
    "Particles/Example/Smoke.ptc",
    "Particles/Example/Smoke.PTC",
  ])("gets registered particle metadata without the unsupported built-in handler: %s", async (path) => {
    const call = vi.fn(async (apiFunc: string) => {
      if (apiFunc !== "EMCP_WB_Resources") throw new Error(`Unexpected API function: ${apiFunc}`);
      return {
        status: "ok",
        action: "getInfo",
        path,
        resourceName: `{D5C3520FD0C5DF9A}${path}`,
        guid: "D5C3520FD0C5DF9A",
        resourceClass: "PTCResourceClass",
        sourcePath: `C:\\Example\\${path.replaceAll("/", "\\")}`,
        editor: "ParticleEditor",
        configurationCount: 6,
      };
    });
    const tool = register({
      state: { connected: true, mode: "unknown", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient);

    const result = await tool.handler({ action: "getInfo", path });

    expect(result.isError).not.toBe(true);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("EMCP_WB_Resources", { action: "getInfo", path });
    expect(result.content[0]?.text).toContain("PTCResourceClass");
    expect(result.content[0]?.text).toContain("D5C3520FD0C5DF9A");
    expect(result.content[0]?.text).toContain("ParticleEditor");
    expect(result.content[0]?.text).not.toMatch(/unsu+pported resource type/i);
  });

  it("keeps the native metadata handler for resource classes it supports", async () => {
    const call = vi.fn(async () => ({
      guid: "0123456789ABCDEF",
      type: "EntityTemplateResourceClass",
    }));
    const tool = register({
      state: { connected: true, mode: "unknown", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient);

    const result = await tool.handler({ action: "getInfo", path: "Prefabs/Example.et" });

    expect(result.isError).not.toBe(true);
    expect(call).toHaveBeenCalledWith("GetResourceInfo", { path: "Prefabs/Example.et" });
    expect(result.content[0]?.text).toContain("EntityTemplateResourceClass");
  });
});
