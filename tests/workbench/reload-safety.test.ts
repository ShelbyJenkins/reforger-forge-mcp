import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbReload } from "../../src/tools/wb-reload.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const handler = (name: string): string => readFileSync(resolve(
  testDir,
  `../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/${name}`
), "utf8");

describe("Workbench unattended lifecycle safety", () => {
  it("advertises only the working plugin reload target and defaults to it", async () => {
    let definition: { inputSchema: { target: { parse(value: unknown): string } } } | undefined;
    let registered: ((input: { target: "plugins" }) => Promise<unknown>) | undefined;
    const server = {
      registerTool: (_name: string, toolDefinition: typeof definition, toolHandler: typeof registered) => {
        definition = toolDefinition;
        registered = toolHandler;
      },
    } as unknown as McpServer;
    const call = vi.fn(async () => ({ status: "ok", message: "Plugins reloaded." }));
    const client = {
      state: { connected: true, mode: "edit", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient;
    registerWbReload(server, client);

    const target = definition?.inputSchema.target.parse(undefined);
    expect(target).toBe("plugins");
    expect(() => definition?.inputSchema.target.parse("scripts")).toThrow();
    await registered?.({ target: "plugins" });
    expect(call).toHaveBeenCalledWith("EMCP_WB_Reload", { target: "plugins" });

    const source = handler("EMCP_WB_Reload.c");
    expect(source).toContain("Script reload is disabled in every editor state");
    expect(source).not.toContain("scriptEditor.ExecuteAction");
    expect(source).not.toContain("GetWorld()");
  });

  it("disables generic execution in the direct NET API handler", () => {
    const source = handler("EMCP_WB_ExecuteAction.c");
    expect(source).toContain("Generic menu execution is disabled");
    expect(source).not.toContain("Workbench.GetModule");
    expect(source).not.toContain("worldEditor.ExecuteAction(parts)");
  });

  it("refuses play and save in the direct handler before editor operations", () => {
    const source = handler("EMCP_WB_EditorControl.c");
    const playRefusal = source.indexOf('if (req.action == "play")');
    const saveRefusal = source.indexOf('if (req.action == "save" || req.action == "saveAs")');
    const moduleLookup = source.indexOf("Workbench.GetModule(WorldEditor)");
    expect(playRefusal).toBeGreaterThan(-1);
    expect(saveRefusal).toBeGreaterThan(playRefusal);
    expect(moduleLookup).toBeGreaterThan(saveRefusal);
    expect(source).not.toContain("SwitchToGameMode");
    expect(source).not.toContain("worldEditor.Save()");
  });

  it("does not hot-inject missing handlers into a live Workbench", () => {
    const client = readFileSync(resolve(testDir, "../../src/workbench/client.ts"), "utf8");
    const controller = readFileSync(
      resolve(testDir, "../../src/workbench/session-controller.ts"),
      "utf8"
    );
    expect(client).not.toContain("recoverMissingHandlers");
    expect(controller).not.toContain("recoverMissingHandlers");
    expect(controller).toContain("requesting a clean lifecycle restart");
    expect(controller).toContain('error.message.includes("not existing Net API function")');
    expect(controller).toContain("await this.restartOwnedWorkbench()");
  });
});
