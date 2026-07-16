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

function collectRuntimeRegistry(): RuntimeRegistry {
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
  const config: Config = {
    workbenchPath: packageRoot,
    projectPath: packageRoot,
    gamePath: packageRoot,
    dataDir: join(packageRoot, "data"),
    patternsDir: join(packageRoot, "data", "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    workbenchNoThrow: true,
  };
  registerTools(server, config);
  return { tools, prompts };
}

function promptText(result: PromptResult): string {
  return result.messages.map((message) => message.content.text).join("\n");
}

function assertExecutableContract(text: string, registeredTools: Map<string, unknown>): void {
  expect(text).not.toMatch(OBSOLETE_TOOL_NAMES);
  expect(text).not.toContain("**wb_play**");
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
    expect(registry.tools.size).toBeGreaterThan(30);
    expect(registry.tools.has("mod")).toBe(true);
    expect(registry.tools.has("project")).toBe(true);
    expect(registry.tools.has("prefab")).toBe(true);
    expect(registry.tools.has("wb_state")).toBe(true);
    expect(registry.prompts.has("create-mod")).toBe(true);
    expect(registry.prompts.has("modify-mod")).toBe(true);
  });

  it("create-mod uses registered merged tools and an attended manual Play checkpoint", () => {
    const handler = registry.prompts.get("create-mod");
    expect(handler).toBeDefined();
    const text = promptText(handler?.({ description: "A small test mod" }) as PromptResult);

    assertExecutableContract(text, registry.tools);
    expect(text).toContain('**mod** with `action: "create"`');
    expect(text).toContain('**mod** with `action: "validate"`');
    expect(text).toContain('**prefab** with `action: "create"`');
    expect(text).toContain('**project** with `action: "write"`');
  });

  it("modify-mod uses registered merged tools and an attended manual Play checkpoint", () => {
    const handler = registry.prompts.get("modify-mod");
    expect(handler).toBeDefined();
    const text = promptText(handler?.({
      projectPath: "C:/mods/TestMod",
      task: "Change one script",
    }) as PromptResult);

    assertExecutableContract(text, registry.tools);
    expect(text).toContain('**mod** with `action: "validate"`');
    expect(text).toContain('**prefab** with `action: "create"`');
    expect(text).toContain('**project** with `action: "browse"`');
    expect(text).toContain('`action: "read"`');
    expect(text).toContain('`action: "write"`');
  });
});
