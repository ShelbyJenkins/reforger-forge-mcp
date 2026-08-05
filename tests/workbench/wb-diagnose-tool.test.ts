import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerWbDiagnose } from "../../src/tools/wb-diagnose.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

describe("wb_diagnose MCP tool", () => {
  it("surfaces the exact retained project compiler failure", async () => {
    let handler: (() => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const server = {
      registerTool(_name: string, _definition: unknown, candidate: typeof handler): void {
        handler = candidate;
      },
    } as unknown as McpServer;
    const client = {
      diagnose: async () => ({
        mcpHost: {
          schemaVersion: 1 as const,
          product: "reforger-forge-mcp" as const,
          clientLabel: "codex",
          instanceId: "00112233-4455-4677-8899-aabbccddeeff",
          pid: process.pid,
          startedAt: "2026-08-05T12:34:56.789Z",
        },
        host: "127.0.0.1",
        port: 5775,
        workbenchExe: null,
        companionAddon: null,
        netApi: "refused" as const,
        lifecycle: {
          state: "missing" as const,
          version: null,
          generation: null,
          phase: null,
          endpoint: null,
          target: null,
          lease: "vacant" as const,
          leaseOwner: null,
          leasePreemptible: true,
          operation: null,
          companionBuildIdentity: null,
        },
        lastLaunchFailure: {
          code: "PROJECT_COMPILE_FAILED" as const,
          module: "Game",
          diagnostics: ["Scripts/Game/Broken.c(7): Syntax error"],
          logPath: "C:\\managed\\logs\\logs-current\\script.log",
        },
      }),
    } as unknown as WorkbenchClient;

    registerWbDiagnose(server, client);
    expect(handler).toBeDefined();
    const result = await handler!();
    const text = result.content.map((entry) => entry.text).join("\n");

    expect(text).toContain("### Last Launch Compiler Failure");
    expect(text).toContain("### MCP Host");
    expect(text).toContain("00112233-4455-4677-8899-aabbccddeeff");
    expect(text).toContain("PROJECT_COMPILE_FAILED");
    expect(text).toContain("Scripts/Game/Broken.c(7): Syntax error");
    expect(text).toContain("logs-current\\script.log");
  });
});
