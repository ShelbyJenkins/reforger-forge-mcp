import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PatternLibrary } from "../../src/patterns/loader.js";
import { registerCreateModPrompt } from "../../src/prompts/create-mod.js";
import { registerModifyModPrompt } from "../../src/prompts/modify-mod.js";

interface PromptResult {
  messages: Array<{ content: { type: string; text: string } }>;
}

type PromptHandler = (input: Record<string, string>) => PromptResult;

const REGISTERED_UNDERSCORE_TOOLS = new Set([
  "api_search",
  "asset_search",
  "component_search",
  "config_create",
  "game_browse",
  "game_read",
  "layout_create",
  "script_create",
  "server_config",
  "wb_cleanup",
  "wb_launch",
  "wb_play",
  "wb_resources",
  "wb_restart",
  "wb_state",
  "wb_stop",
  "wiki_read",
  "wiki_search",
]);

const OBSOLETE_TOOL_NAMES = /\b(?:mod_create|mod_validate|prefab_create|project_browse|project_read|project_write)\b/;

function promptCollector(): {
  server: McpServer;
  prompts: Map<string, PromptHandler>;
} {
  const prompts = new Map<string, PromptHandler>();
  const server = {
    registerPrompt: (name: string, _definition: unknown, handler: PromptHandler): void => {
      prompts.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, prompts };
}

function promptText(result: PromptResult): string {
  return result.messages.map((message) => message.content.text).join("\n");
}

function assertExecutableContract(text: string): void {
  expect(text).not.toMatch(OBSOLETE_TOOL_NAMES);
  expect(text).not.toContain("**wb_play**");
  expect(text).toContain("enter Play mode manually");
  expect(text).toContain("wait for the user to confirm");
  expect(text).toContain("**wb_state**");
  expect(text).toContain("**wb_stop**");

  const referencedUnderscoreNames = new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
  for (const name of referencedUnderscoreNames) {
    expect(
      REGISTERED_UNDERSCORE_TOOLS.has(name),
      `prompt references unregistered tool-like name ${name}`
    ).toBe(true);
  }
}

describe("prompt/tool contracts", () => {
  it("create-mod uses merged tools and an attended manual Play checkpoint", () => {
    const { server, prompts } = promptCollector();
    const patterns = { getSummary: () => "fixture pattern" } as unknown as PatternLibrary;
    registerCreateModPrompt(server, patterns);

    const handler = prompts.get("create-mod");
    expect(handler).toBeDefined();
    const text = promptText(handler?.({ description: "A small test mod" }) as PromptResult);

    assertExecutableContract(text);
    expect(text).toContain('**mod** with `action: "create"`');
    expect(text).toContain('**mod** with `action: "validate"`');
    expect(text).toContain('**prefab** with `action: "create"`');
    expect(text).toContain('**project** with `action: "write"`');
  });

  it("modify-mod uses merged tools and an attended manual Play checkpoint", () => {
    const { server, prompts } = promptCollector();
    registerModifyModPrompt(server);

    const handler = prompts.get("modify-mod");
    expect(handler).toBeDefined();
    const text = promptText(handler?.({
      projectPath: "C:/mods/TestMod",
      task: "Change one script",
    }) as PromptResult);

    assertExecutableContract(text);
    expect(text).toContain('**mod** with `action: "validate"`');
    expect(text).toContain('**prefab** with `action: "create"`');
    expect(text).toContain('**project** with `action: "browse"`');
    expect(text).toContain('`action: "read"`');
    expect(text).toContain('`action: "write"`');
  });
});
