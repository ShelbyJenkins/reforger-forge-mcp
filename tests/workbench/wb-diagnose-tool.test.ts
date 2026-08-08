import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  registerWbDiagnose,
  wbDiagnoseRawInputSchema,
} from "../../src/tools/wb-diagnose.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

describe("wb_diagnose MCP tool", () => {
  it("surfaces the exact retained project compiler failure", async () => {
    type Input = { gprojPath?: string; includeLaunchPlan?: boolean };
    let handler: ((input: Input) => Promise<{ content: Array<{ text: string }> }>) | undefined;
    const workbenchLaunchPreview = vi.fn(() => ({
      status: "available" as const,
      preview: {
        kind: "workbench_editor" as const,
        ownership: "preview_only" as const,
        runnable: false as const,
        presentation: "presentation_only" as const,
        executablePath: "C:\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteam.exe",
        argv: [
          "-gproj",
          "C:\\Example Mod\\Example.gproj",
          "-reforgerForgeOwnerToken=<MCP-generated-owner-token>",
        ],
      },
    }));
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
        mcpLifecycle: {
          schemaVersion: 1 as const,
          instanceId: "00112233-4455-4677-8899-aabbccddeeff",
          idleShutdownMs: 60_000,
          state: "blocked" as const,
          activeRequestCount: 0,
          lastActivityAt: "2026-08-05T12:34:56.789Z",
          eligibleAt: "2026-08-05T12:35:56.789Z",
          readinessComplete: true,
          blockerCodes: ["OBSERVER_CHILD" as const],
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
      workbenchLaunchPreview,
    } as unknown as WorkbenchClient;

    registerWbDiagnose(server, client);
    expect(handler).toBeDefined();
    const result = await handler!({});
    const text = result.content.map((entry) => entry.text).join("\n");

    expect(text).toContain("### Last Launch Compiler Failure");
    expect(text).toContain("### MCP Host");
    expect(text).toContain("00112233-4455-4677-8899-aabbccddeeff");
    expect(text).toContain("### MCP Lifecycle");
    expect(text.match(/00112233-4455-4677-8899-aabbccddeeff/g)).toHaveLength(2);
    expect(text).toContain("60000 ms");
    expect(text).toContain("OBSERVER_CHILD");
    expect(text).toContain("PROJECT_COMPILE_FAILED");
    expect(text).toContain("Scripts/Game/Broken.c(7): Syntax error");
    expect(text).toContain("logs-current\\script.log");
    expect(text).not.toContain("Workbench Launch Preview");

    const previewResult = await handler!({
      includeLaunchPlan: true,
      gprojPath: "C:\\Example Mod\\Example.gproj",
    });
    const previewText = previewResult.content.map((entry) => entry.text).join("\n");
    expect(previewText).toContain("### Workbench Launch Preview");
    expect(previewText).toContain("PRESENTATION ONLY");
    expect(previewText).toContain('"-reforgerForgeOwnerToken=<MCP-generated-owner-token>"');
    expect(workbenchLaunchPreview).toHaveBeenCalledWith("C:\\Example Mod\\Example.gproj");

    workbenchLaunchPreview.mockImplementationOnce(() => {
      throw new Error("preview fixture failure\nwith detail");
    });
    const failedPreview = await handler!({
      includeLaunchPlan: true,
      gprojPath: "C:\\Example Mod\\Example.gproj",
    });
    const failedText = failedPreview.content.map((entry) => entry.text).join("\n");
    expect(failedText).toContain("### MCP Host");
    expect(failedText).toContain("### Workbench Launch Preview");
    expect(failedText).toContain("**Status:** ERROR");
    expect(failedText).toContain("preview fixture failure with detail");
  });

  it("enforces the strict selected preview input branch", () => {
    expect(wbDiagnoseRawInputSchema.safeParse({}).success).toBe(true);
    expect(wbDiagnoseRawInputSchema.safeParse({ includeLaunchPlan: false }).success).toBe(true);
    expect(wbDiagnoseRawInputSchema.safeParse({ gprojPath: "C:\\Example\\Example.gproj" }).success).toBe(false);
    expect(wbDiagnoseRawInputSchema.safeParse({ includeLaunchPlan: true }).success).toBe(false);
    expect(wbDiagnoseRawInputSchema.safeParse({
      includeLaunchPlan: true,
      gprojPath: "relative\\Example.gproj",
    }).success).toBe(false);
    expect(wbDiagnoseRawInputSchema.safeParse({
      includeLaunchPlan: true,
      gprojPath: "C:\\Example\\Example.gproj",
      unexpected: true,
    }).success).toBe(false);
  });
});
