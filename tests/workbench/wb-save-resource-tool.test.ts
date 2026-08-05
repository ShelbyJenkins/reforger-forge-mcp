import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { WorkbenchError, type WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbSaveResource } from "../../src/tools/wb-save-resource.js";

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
}

interface RegisteredTool {
  readonly name: string;
  readonly definition: {
    readonly description: string;
    readonly inputSchema: Record<string, {
      safeParse(value: unknown): { readonly success: boolean };
    }>;
  };
  readonly handler: (input: {
    readonly confirm?: string;
    readonly resourcePath?: string;
    readonly expectedPath?: string;
  }) => Promise<ToolResult>;
}

function config(): Config {
  return {
    workbenchPath: "C:\\Arma Reforger Tools",
    gamePath: "C:\\Arma Reforger",
    dataDir: "C:\\ReforgerForge\\data",
    patternsDir: "C:\\ReforgerForge\\data\\patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
}

function register(client: WorkbenchClient, effectiveConfig: Config): RegisteredTool | undefined {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      definition: RegisteredTool["definition"],
      handler: RegisteredTool["handler"]
    ): void {
      registered = { name, definition, handler };
    },
  } as unknown as McpServer;
  registerWbSaveResource(server, effectiveConfig, client);
  return registered;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("wb_save_resource MCP tool", () => {
  it("advertises the inherited-prefab empty-override refusal", () => {
    const client = {
      state: { connected: true, mode: "edit", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const tool = register(client, config());

    expect(tool!.definition.description).toContain("explicit empty nested overrides");
  });

  it("requires an explicit target path before contacting the client", async () => {
    const saveResource = vi.fn();
    const client = {
      saveResource,
      state: { connected: true, mode: "edit", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const tool = register(client, config());

    expect(tool).toBeDefined();
    expect(tool!.name).toBe("wb_save_resource");
    expect(tool!.definition.inputSchema.confirm.safeParse("save").success).toBe(true);
    expect(tool!.definition.inputSchema.confirm.safeParse("SAVE").success).toBe(false);

    const result = await tool!.handler({ confirm: "save" });
    const text = resultText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("**Explicit Save Refused**");
    expect(text).toContain("`TARGET_SESSION_REQUIRED`");
    expect(text).toContain("`TARGET_SESSION_REQUIRED` — ");
    expect(text).not.toContain("â€”");
    expect(text).toContain("resourcePath is required");
    expect(text.match(/Next action:/g)).toHaveLength(1);
    expect(saveResource).not.toHaveBeenCalled();
  });

  it("forwards only the explicit startup target and reports bundle evidence", async () => {
    const saveResource = vi.fn(async () => ({
      resourcePath: "C:\\Mods\\Example\\Worlds\\Target.ent",
      startupLoadPath: "C:\\Mods\\Example\\Worlds\\Target.ent",
      outcome: "changed" as const,
      changedPaths: ["Worlds/Target_Layers/default.layer"],
    }));
    const client = {
      saveResource,
      state: { connected: true, mode: "edit", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const tool = register(client, config());

    const result = await tool!.handler({
      confirm: "save",
      resourcePath: "C:\\Mods\\Example\\Worlds\\Target.ent",
    });

    expect(result.isError).not.toBe(true);
    expect(resultText(result)).toContain("**Explicit Resource Save Complete**");
    expect(resultText(result)).toContain("`changed`");
    expect(resultText(result)).toContain("Target_Layers/default.layer");
    expect(saveResource).toHaveBeenCalledWith("C:\\Mods\\Example\\Worlds\\Target.ent");
  });

  it("returns the controller's target-session refusal unchanged", async () => {
    const saveResource = vi.fn(async () => {
      throw new WorkbenchError("The generic editor is not a target-bound session.", "TARGET_SESSION_REQUIRED");
    });
    const client = {
      saveResource,
      state: { connected: true, mode: "edit", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const tool = register(client, config());

    const result = await tool!.handler({
      confirm: "save",
      expectedPath: "C:\\Mods\\Example\\Worlds\\Target.ent",
    });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("`TARGET_SESSION_REQUIRED`");
    expect(resultText(result)).not.toContain("Next action:");
    expect(saveResource).toHaveBeenCalledWith("C:\\Mods\\Example\\Worlds\\Target.ent");
  });

  it("never turns an uncertain save outcome into success or retry advice", async () => {
    const diagnostic =
      "Explicit save outcome is uncertain; shut down and relaunch the exact target before saving again.";
    const saveResource = vi.fn(async () => {
      throw new WorkbenchError(
        diagnostic,
        "SAVE_OUTCOME_UNCERTAIN",
        { kind: "message_owns_recovery" }
      );
    });
    const client = {
      saveResource,
      state: { connected: true, mode: "edit", lastUpdated: 0 },
    } as unknown as WorkbenchClient;
    const tool = register(client, config());

    const result = await tool!.handler({
      confirm: "save",
      resourcePath: "C:\\Mods\\Example\\Worlds\\Target.ent",
    });
    const text = resultText(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("`SAVE_OUTCOME_UNCERTAIN` — ");
    expect(text).toContain(diagnostic);
    expect(text).not.toContain("Next action:");
    expect(text).not.toContain("Complete");
  });
});
