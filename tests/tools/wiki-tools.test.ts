import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { SearchEngine } from "../../src/index/search-engine.js";
import type { WikiPage } from "../../src/index/types.js";
import { registerWikiRead } from "../../src/tools/wiki-read.js";
import { registerWikiSearch } from "../../src/tools/wiki-search.js";

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly isError?: boolean;
}

interface RegisteredTool<Input extends Record<string, unknown>> {
  readonly name: string;
  readonly definition: {
    readonly description: string;
  };
  readonly handler: (input: Input) => Promise<ToolResult>;
}

function registerTool<Input extends Record<string, unknown>>(
  register: (server: McpServer, searchEngine: SearchEngine) => void,
  searchEngine: SearchEngine
): RegisteredTool<Input> {
  let tool: RegisteredTool<Input> | undefined;
  const server = {
    registerTool(
      name: string,
      definition: RegisteredTool<Input>["definition"],
      handler: RegisteredTool<Input>["handler"]
    ): void {
      tool = { name, definition, handler };
    },
  } as unknown as McpServer;
  register(server, searchEngine);
  if (!tool) throw new Error("Expected a registered tool");
  return tool;
}

function searchEngineWith(page: WikiPage): SearchEngine {
  return {
    getWikiPage: (title: string) => title === page.title ? page : undefined,
    searchWiki: () => [page],
  } as unknown as SearchEngine;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("wiki tool output bounds", () => {
  it("advertises the cap and reports truncation for a longer wiki page", async () => {
    const page: WikiPage = {
      title: "Long Guide",
      source: "arma",
      content: "x".repeat(100_001),
    };
    const tool = registerTool<{ title: string }>(registerWikiRead, searchEngineWith(page));

    expect(tool.name).toBe("wiki_read");
    expect(tool.definition.description).toContain("100,000 characters");
    expect(tool.definition.description).toContain("truncation notice");

    const text = resultText(await tool.handler({ title: page.title }));
    expect(text).toContain("truncated at 100,000 chars, 100,001 chars total");
    expect(text).toContain(page.content.slice(0, 100_000));
    expect(text).not.toContain(page.content);
  });

  it("directs preview callers to the bounded wiki_read result", async () => {
    const page: WikiPage = {
      title: "Preview Guide",
      source: "arma",
      content: "x".repeat(8_001),
    };
    const tool = registerTool<{ query: string; limit: number }>(
      registerWikiSearch,
      searchEngineWith(page)
    );

    expect(tool.name).toBe("wiki_search");
    expect(tool.definition.description).toContain("up to 100,000 characters");
    expect(tool.definition.description).toContain("truncation notice");

    const text = resultText(await tool.handler({ query: "preview", limit: 1 }));
    expect(text).toContain("wiki_read returns up to 100,000 characters");
  });
});
