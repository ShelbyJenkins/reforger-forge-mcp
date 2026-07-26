import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import type { SearchEngine } from "../../src/index/search-engine.js";
import type { PatternLibrary } from "../../src/patterns/loader.js";
import { registerMod } from "../../src/tools/mod.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

const addonsRoot = resolve(import.meta.dirname, "../../../addons");
const baseClasses = new Set([
  "scr_missionheader",
  "scr_basegamemodecomponentclass",
  "scr_basegamemodecomponent",
]);

function handler(): ToolHandler {
  let callback: ToolHandler | undefined;
  const server = {
    registerTool(
      _name: string,
      _definition: unknown,
      toolHandler: ToolHandler
    ): void {
      callback = toolHandler;
    },
  } as unknown as McpServer;
  const config: Config = {
    workbenchPath: "C:\\Arma Reforger Tools",
    gamePath: "C:\\Arma Reforger",
    projectPath: addonsRoot,
    dataDir: "C:\\ReforgerForge\\data",
    patternsDir: "C:\\ReforgerForge\\patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
  const searchEngine = {
    hasClass: (name: string) => baseClasses.has(name.toLowerCase()),
  } as SearchEngine;
  registerMod(server, config, searchEngine, {} as PatternLibrary);
  return callback!;
}

function text(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("mod validate declared dependency classes", () => {
  it("recognizes Core config classes used by OnePointZeroOne DefaultContent", async () => {
    const result = await handler()({
      action: "validate",
      projectPath: resolve(addonsRoot, "OnePointZeroOne", "DefaultContent"),
      checks: ["configs"],
    });
    const report = text(result);

    expect(report).not.toContain('Root class "OPZO_BodyIdentityCatalog"');
    expect(report).not.toContain('Class "OPZO_BodyIdentityProfile"');
    expect(report).toContain("All checks passed!");
  });

  it("recognizes Core parents used by OnePointZeroOne TestContent", async () => {
    const result = await handler()({
      action: "validate",
      projectPath: resolve(addonsRoot, "OnePointZeroOne", "TestContent"),
      checks: ["references"],
    });
    const report = text(result);

    expect(report).not.toContain('Extends "OPZO_BodyIdentityComponentClass"');
    expect(report).not.toContain('Extends "OPZO_BodyIdentityComponent"');
    expect(report).toContain("All checks passed!");
  });
});
