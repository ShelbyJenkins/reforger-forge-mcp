import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerTools } from "../../src/server.js";

interface PromptResult {
  messages: Array<{ content: { type: string; text: string } }>;
}

type PromptHandler = (input: Record<string, string>) => PromptResult;

interface RuntimeRegistry {
  tools: Map<string, unknown>;
  prompts: Map<string, PromptHandler>;
}

const OBSOLETE_TOOL_NAMES = /\b(?:mod_create|mod_validate|prefab_create|project_browse|project_read|project_write)\b/;

function collectRuntimeRegistry(withGamePath = true): RuntimeRegistry {
  const tools = new Map<string, unknown>();
  const prompts = new Map<string, PromptHandler>();
  const server = {
    registerTool: (name: string, definition: unknown): void => {
      tools.set(name, definition);
    },
    registerPrompt: (name: string, _definition: unknown, handler: PromptHandler): void => {
      prompts.set(name, handler);
    },
    registerResource: (): void => undefined,
  } as unknown as McpServer;

  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const config = {
    workbenchPath: packageRoot,
    ...(withGamePath ? { gamePath: packageRoot } : {}),
    dataDir: join(packageRoot, "data"),
    patternsDir: join(packageRoot, "data", "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  } as Config;
  registerTools(server, config);
  return { tools, prompts };
}

function promptText(result: PromptResult): string {
  return result.messages.map((message) => message.content.text).join("\n");
}

function assertExecutableContract(text: string, registeredTools: Map<string, unknown>): void {
  expect(text).not.toMatch(OBSOLETE_TOOL_NAMES);
  expect(text).not.toContain("wb_play");
  expect(text).toContain("no automated Play tool exists");
  expect(text).toContain("enter Play mode manually");
  expect(text).toContain("wait for the user to confirm");
  expect(text).toContain("**wb_state**");
  expect(text).toContain("**wb_stop**");

  const referencedToolNames = new Set(text.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? []);
  for (const match of text.matchAll(/\*\*([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\*\*/g)) {
    referencedToolNames.add(match[1]);
  }

  for (const name of referencedToolNames) {
    expect(
      registeredTools.has(name),
      `prompt references tool-like name ${name}, but registerTools() did not register it`
    ).toBe(true);
  }
}

describe("prompt/tool contracts", () => {
  let registry: RuntimeRegistry;

  beforeAll(() => {
    registry = collectRuntimeRegistry();
  });

  it("collects tools and prompts from the real runtime registration path", () => {
    expect(registry.tools.size).toBe(63);
    expect(registry.tools.has("game_launch")).toBe(true);
    expect(registry.tools.has("observer_runtime")).toBe(true);
    expect(registry.tools.has("mod")).toBe(true);
    expect(registry.tools.has("project")).toBe(true);
    expect(registry.tools.has("prefab")).toBe(true);
    expect(registry.tools.has("wb_state")).toBe(true);
    expect(registry.tools.has("wb_play")).toBe(false);
    expect(registry.tools.has("wb_save")).toBe(false);
    expect(registry.tools.has("wb_execute_action")).toBe(false);
    expect(registry.prompts.has("create-mod")).toBe(true);
    expect(registry.prompts.has("modify-mod")).toBe(true);
  });

  it("registers neither owned-runtime entry point when gamePath is absent", () => {
    const withoutOwnedRuntime = collectRuntimeRegistry(false);
    expect(withoutOwnedRuntime.tools.size).toBe(61);
    expect(withoutOwnedRuntime.tools.has("game_launch")).toBe(false);
    expect(withoutOwnedRuntime.tools.has("observer_runtime")).toBe(false);
  });

  it("create-mod uses registered merged tools and an attended manual Play checkpoint", () => {
    const handler = registry.prompts.get("create-mod");
    expect(handler).toBeDefined();
    const text = promptText(handler?.({
      outputDir: "C:/mods",
      description: "A small test mod",
    }) as PromptResult);

    assertExecutableContract(text, registry.tools);
    expect(text).toContain('**mod** with `action: "create"`');
    expect(text).toContain('**mod** with `action: "validate"`');
    expect(text).toContain('**prefab** with `action: "create"`');
    expect(text).toContain('**project** with `action: "write"`');
    expect(text).toContain('outputDir: "C:/mods"');
    expect(text).toContain("gprojPath");
    expect(text).toContain("workbenchAddonDirs");
  });

  it("modify-mod uses registered merged tools and an attended manual Play checkpoint", () => {
    const handler = registry.prompts.get("modify-mod");
    expect(handler).toBeDefined();
    const text = promptText(handler?.({
      gprojPath: "C:/mods/TestMod/TestMod.gproj",
      task: "Change one script",
    }) as PromptResult);

    assertExecutableContract(text, registry.tools);
    expect(text).toContain('**mod** with `action: "validate"`');
    expect(text).toContain('**prefab** with `action: "create"`');
    expect(text).toContain('**project** with `action: "browse"`');
    expect(text).toContain('`action: "read"`');
    expect(text).toContain('`action: "write"`');
    expect(text).toContain('gprojPath: "C:/mods/TestMod/TestMod.gproj"');
    expect(text).toContain("derive their write root from the lifecycle");
  });
});
