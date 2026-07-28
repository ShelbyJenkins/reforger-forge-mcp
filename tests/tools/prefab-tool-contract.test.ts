import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { registerPrefab } from "../../src/tools/prefab.js";

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

describe("prefab MCP guidance", () => {
  it("directs visible-prefab model lookup to asset_search", () => {
    let description = "";
    const server = {
      registerTool(_name: string, definition: { readonly description: string }): void {
        description = definition.description;
      },
    } as unknown as McpServer;

    registerPrefab(server, config());

    expect(description).toContain("asset_search with type='model'");
    expect(description).not.toContain("Use api_search to find model paths");
  });
});
