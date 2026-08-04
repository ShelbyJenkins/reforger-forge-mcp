import type { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SearchEngine } from "../../src/index/search-engine.js";
import { registerClassResource } from "../../src/resources/class-resource.js";
import { registerGroupResource } from "../../src/resources/group-resource.js";
import { registerApiSearch } from "../../src/tools/api-search.js";
import { registerScriptCreate } from "../../src/tools/script-create.js";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../data");

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type ResourceResult = { contents: Array<{ uri: string; text?: string }> };
type ResourceRead = (
  uri: URL,
  variables: Record<string, string | string[]>
) => Promise<ResourceResult>;
type ToolHandler = (input: Record<string, unknown>) => Promise<Result>;

function captureResource(
  register: (server: McpServer, engine: SearchEngine) => void,
  engine: SearchEngine
): { template: ResourceTemplate; read: ResourceRead } {
  let captured: { template: ResourceTemplate; read: ResourceRead } | undefined;
  const server = {
    registerResource(
      _name: string,
      template: ResourceTemplate,
      _metadata: unknown,
      read: ResourceRead
    ): void {
      captured = { template, read };
    },
  } as unknown as McpServer;
  register(server, engine);
  if (!captured) throw new Error("Expected resource registration");
  return captured;
}

function captureTool(
  register: (server: McpServer, engine: SearchEngine) => void,
  engine: SearchEngine
): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(_name: string, _definition: unknown, candidate: ToolHandler): void {
      handler = candidate;
    },
  } as unknown as McpServer;
  register(server, engine);
  if (!handler) throw new Error("Expected tool registration");
  return handler;
}

function text(result: Result): string {
  return result.content.map((entry) => entry.text ?? "").join("\n");
}

function resourceText(result: ResourceResult): string {
  return result.contents.map((entry) => entry.text ?? "").join("\n");
}

describe("SearchEngine non-search first-use boundaries", () => {
  it("loads transparently through the class resource", async () => {
    const engine = new SearchEngine(dataDir);
    const resource = captureResource(registerClassResource, engine);
    expect(engine.isLoaded()).toBe(false);

    const result = await resource.read(new URL("enfusion://class/IEntity"), { className: "IEntity" });

    expect(engine.isLoaded()).toBe(true);
    expect(JSON.parse(resourceText(result))).toMatchObject({ name: "IEntity", source: "enfusion" });
  });

  it("loads transparently through the group resource", async () => {
    const engine = new SearchEngine(dataDir);
    const resource = captureResource(registerGroupResource, engine);
    expect(engine.isLoaded()).toBe(false);

    const result = await resource.read(new URL("enfusion://group/Attributes"), { groupName: "Attributes" });

    expect(engine.isLoaded()).toBe(true);
    expect(JSON.parse(resourceText(result))).toMatchObject({ name: "Attributes" });
  });

  it("loads transparently through an API search tool", async () => {
    const engine = new SearchEngine(dataDir);
    const handler = captureTool(registerApiSearch, engine);
    expect(engine.isLoaded()).toBe(false);

    const result = await handler({
      query: "IEntity",
      type: "class",
      source: "all",
      limit: 1,
      format: "detailed",
    });

    expect(engine.isLoaded()).toBe(true);
    expect(text(result)).toContain("IEntity");
  });

  it("loads transparently through script_create's parent-class lookup", async () => {
    const engine = new SearchEngine(dataDir);
    const handler = captureTool(
      (server, candidate) => registerScriptCreate(server, {} as never, candidate),
      engine
    );
    expect(engine.isLoaded()).toBe(false);

    const result = await handler({
      className: "TST_LazyComponent",
      scriptType: "component",
      parentClass: "ScriptComponent",
    });

    expect(engine.isLoaded()).toBe(true);
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("TST_LazyComponent");
  });
});
