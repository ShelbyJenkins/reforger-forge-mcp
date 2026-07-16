import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMod } from "../../src/tools/mod.js";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type ToolHandler = (input: Record<string, unknown>) => Promise<ToolResult>;

describe("legacy generic mod build", () => {
  it("returns a safe refusal before consulting config or invoking Workbench", async () => {
    let handler: ToolHandler | undefined;
    const server = {
      registerTool: (
        name: string,
        _definition: unknown,
        registered: ToolHandler
      ): void => {
        if (name === "mod") handler = registered;
      },
    } as unknown as McpServer;

    registerMod(
      server,
      {} as Parameters<typeof registerMod>[1],
      {} as Parameters<typeof registerMod>[2],
      {} as Parameters<typeof registerMod>[3]
    );

    expect(handler).toBeDefined();
    const result = await handler?.({
      action: "build",
      addonName: "MustNotLaunch",
      gprojPath: "C:\\MustNotLaunch.gproj",
    });

    expect(result?.isError).toBe(true);
    expect(result?.content[0]?.text).toContain("Direct MCP Workbench builds are disabled");
    expect(result?.content[0]?.text).toContain("project-owned bounded build wrapper");
  });
});
