import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { registerTools } from "../../src/server.js";
import { registerWbCheck } from "../../src/tools/wb-check.js";
import type { WorkbenchLifecycleExecutionPort } from "../../src/workbench/lifecycle-execution.js";
import type { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";
import {
  classifyWorkbenchExitStatus,
  type WorkbenchCheckReceipt,
  type WorkbenchRunnerDependencies,
  type WorkbenchRunnerIntent,
  type WorkbenchRunnerReceipt,
} from "../../src/workbench/runner.js";

vi.mock("../../src/observer/application.js", () => ({
  createObserverApplication: () => ({
    ownedRuntimeManager: {},
    closeRuntimeLifecycle: async () => ({}),
  }),
}));

vi.mock("../../src/observer/tools.js", () => ({
  registerObserverTools: vi.fn(),
}));

interface RegisteredTool {
  definition: {
    description?: string;
    inputSchema?: Record<string, { safeParse(value: unknown): { success: boolean; data?: unknown } }>;
    outputSchema?: Record<string, { safeParse(value: unknown): { success: boolean } }>;
  };
  handler(
    input: { gprojPath: string; configuration: string; timeoutMs: number },
    extra: { signal: AbortSignal }
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

const config = {
  workbenchPath: "C:\\Arma Reforger Tools",
  gamePath: "C:\\Arma Reforger",
  dataDir: "C:\\ReforgerForge\\data",
  patternsDir: "C:\\ReforgerForge\\data\\patterns",
  workbenchHost: "127.0.0.1",
  workbenchPort: 5775,
} as Config;

function receipt(
  compilation: WorkbenchCheckReceipt["compilation"] = { status: "compiled" },
  exitCode = 0
): WorkbenchCheckReceipt {
  return {
    intent: "check",
    scope: "enforceScripts",
    engineValidated: true,
    pid: 25_001,
    executablePath: "C:\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
    creationTime: "133900000000025001",
    target: "C:\\mods\\Example\\Example.gproj",
    targetAddon: {
      addonId: "Example",
      addonGuid: "1122334455667788",
      sourceSha256: "a".repeat(64),
    },
    configuration: "PC",
    lifecycleGeneration: "generation-check",
    processOwnership: "verified",
    endpointVacancy: "verified",
    logDirectory: "C:\\managed\\logs\\check",
    compilation,
    exitStatus: classifyWorkbenchExitStatus({
      reason: "exited",
      exitCode,
      signal: null,
      timedOut: false,
    }),
  };
}

function register(
  client: { runOwnerScopedTargetCheck: (...args: never[]) => Promise<unknown> },
  runIntent: (
    config: Config,
    intent: WorkbenchRunnerIntent,
    dependencies?: WorkbenchRunnerDependencies
  ) => Promise<WorkbenchRunnerReceipt>
): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      definition: RegisteredTool["definition"],
      handler: RegisteredTool["handler"]
    ): void {
      expect(name).toBe("wb_check");
      tool = { definition, handler };
    },
  } as unknown as McpServer;
  registerWbCheck(server, config, client as never, {
    managedRoot: "C:\\managed",
    processGuard: {} as WorkbenchProcessGuard,
    runIntent,
    assertSteamReady: vi.fn(),
  });
  return tool!;
}

describe("wb_check MCP tool", () => {
  it("is wired exactly once into complete MCP server registration", async () => {
    const names: string[] = [];
    const server = {
      registerTool(name: string): void { names.push(name); },
      registerPrompt(): void {},
      registerResource(): void {},
    } as unknown as McpServer;
    const dispose = registerTools(server, config);
    try {
      expect(names.filter((name) => name === "wb_check")).toEqual(["wb_check"]);
    } finally {
      await dispose();
    }
  });

  it("declares the narrow input/output contract", () => {
    const tool = register(
      { runOwnerScopedTargetCheck: vi.fn() },
      vi.fn()
    );
    const input = tool.definition.inputSchema!;
    expect(tool.definition.description).toMatch(/script-compilation preflight only/i);
    expect(input.gprojPath.safeParse("Example.gproj").success).toBe(false);
    expect(input.gprojPath.safeParse("C:\\mods\\Example\\Example.gproj").success).toBe(true);
    expect(input.configuration.safeParse(undefined)).toMatchObject({ success: true, data: "PC" });
    expect(input.configuration.safeParse("PC client").success).toBe(false);
    expect(input.timeoutMs.safeParse(undefined)).toMatchObject({ success: true, data: 120_000 });
    expect(input.timeoutMs.safeParse(999).success).toBe(false);
    expect(input.timeoutMs.safeParse(600_001).success).toBe(false);
    expect(tool.definition.outputSchema).toBeDefined();
  });

  it("returns human text and structured content from the same successful receipt", async () => {
    const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
    const expected = receipt();
    const runIntent = vi.fn(async (
      receivedConfig: Config,
      intent: WorkbenchRunnerIntent,
      dependencies: WorkbenchRunnerDependencies = {}
    ): Promise<WorkbenchRunnerReceipt> => {
      expect(receivedConfig).toBe(config);
      expect(intent).toEqual({
        kind: "check",
        gprojPath: "C:\\mods\\Example\\Example.gproj",
        configuration: "PC",
        timeoutMs: 120_000,
      });
      expect(dependencies).toMatchObject({
        lifecycleExecution: sharedExecution,
        lifecycleEntry: "owner_scoped",
        managedRoot: "C:\\managed",
      });
      return expected;
    });
    const client = {
      runOwnerScopedTargetCheck: vi.fn(async (
        _gprojPath: string,
        action: (execution: WorkbenchLifecycleExecutionPort, signal: AbortSignal) => Promise<unknown>,
        options: { signal?: AbortSignal }
      ) => action(sharedExecution, options.signal!)),
    };
    const tool = register(client as never, runIntent);
    const signal = new AbortController().signal;

    const result = await tool.handler({
      gprojPath: "C:\\mods\\Example\\Example.gproj",
      configuration: "PC",
      timeoutMs: 120_000,
    }, { signal });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toMatch(/Enforce Scripts compiled/);
    expect(result.structuredContent).toEqual(expected);
    expect(client.runOwnerScopedTargetCheck).toHaveBeenCalledOnce();
    expect(runIntent).toHaveBeenCalledOnce();
  });

  it("returns PROJECT_COMPILE_FAILED as an actionable typed error receipt", async () => {
    const failed = receipt({
      status: "failed",
      code: "PROJECT_COMPILE_FAILED",
      module: "Game",
      diagnostics: ["Broken.c(7): Unexpected token"],
      logPath: "C:\\managed\\logs\\check\\script.log",
    }, -1);
    const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
    const tool = register({
      runOwnerScopedTargetCheck: async (
        _gprojPath: string,
        action: (execution: WorkbenchLifecycleExecutionPort, signal: AbortSignal) => Promise<unknown>,
        options: { signal?: AbortSignal }
      ) => action(sharedExecution, options.signal!),
    } as never, vi.fn(async () => failed));

    const result = await tool.handler({
      gprojPath: "C:\\mods\\Example\\Example.gproj",
      configuration: "PC",
      timeoutMs: 120_000,
    }, { signal: new AbortController().signal });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/failed to compile in module Game/i);
    expect(result.structuredContent).toEqual(failed);
  });
});
