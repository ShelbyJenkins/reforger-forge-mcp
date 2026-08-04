import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { registerWbValidate } from "../../src/tools/wb-validate.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

interface ToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

interface ToolDefinition {
  readonly description: string;
}

type ToolHandler = (
  input: { readonly action: "material" | "texture"; readonly path: string }
) => Promise<ToolResult>;

function register(client: WorkbenchClient): {
  readonly definition: ToolDefinition;
  readonly handler: ToolHandler;
} {
  let definition: ToolDefinition | undefined;
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(
      name: string,
      candidateDefinition: ToolDefinition,
      candidateHandler: ToolHandler
    ): void {
      expect(name).toBe("wb_validate");
      definition = candidateDefinition;
      handler = candidateHandler;
    },
  } as unknown as McpServer;

  registerWbValidate(server, client);
  if (!definition || !handler) throw new Error("Expected wb_validate registration");
  return { definition, handler };
}

describe("wb_validate MCP tool", () => {
  it("documents the metadata-independent material scope separately from texture import validation", () => {
    const { definition } = register({
      state: { connected: false, mode: "unknown", lastUpdated: 0 },
    } as unknown as WorkbenchClient);

    expect(definition.description).toMatch(/material checks cover parameters.*texture GUIDs.*slot\/suffix/i);
    expect(definition.description).toMatch(/without requiring loose source metadata for packed dependencies/i);
    expect(definition.description).toMatch(/texture checks cover registered source import metadata/i);
  });

  it("returns a nonfatal material advisory as a successful validation result", async () => {
    const path = "Materials/SedanRed.emat";
    const call = vi.fn(async () => ({
      status: "ok",
      action: "material",
      resourceName: `{0123456789ABCDEF}${path}`,
      absolutePath: `C:\\Example\\${path.replaceAll("/", "\\")}`,
      reports: ["NormalPower is out of limitation"],
      severity: [2],
      valid: true,
      clean: false,
    }));
    const { handler } = register({
      state: { connected: true, mode: "edit", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient);

    const result = await handler({ action: "material", path });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain("Material Validation Passed with Advisories");
    expect(result.content[0]?.text).toContain("advisory (severity 2)");
    expect(call).toHaveBeenCalledWith("EMCP_WB_ValidateResource", { action: "material", path });
  });

  it("preserves a genuinely unresolved material texture reference as fatal", async () => {
    const path = "Materials/Broken.emat";
    const call = vi.fn(async () => ({
      status: "ok",
      action: "material",
      resourceName: `{FEDCBA9876543210}${path}`,
      absolutePath: `C:\\Example\\${path.replaceAll("/", "\\")}`,
      reports: ["Broken.emat has an unresolved texture GUID in BCRMap"],
      severity: [3],
      valid: false,
      clean: false,
    }));
    const { handler } = register({
      state: { connected: true, mode: "edit", lastUpdated: Date.now() },
      call,
    } as unknown as WorkbenchClient);

    const result = await handler({ action: "material", path });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Material Validation Failed");
    expect(result.content[0]?.text).toContain("fatal");
    expect(result.content[0]?.text).toContain("unresolved texture GUID");
  });
});
