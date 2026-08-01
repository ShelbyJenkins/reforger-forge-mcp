import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { registerTools } from "../../src/server.js";
import { registerWbBuild } from "../../src/tools/wb-build.js";
import { WorkbenchActivityGate } from "../../src/workbench/activity-gate.js";
import type { WorkbenchCompanionProvider } from "../../src/workbench/helper-addon.js";
import type { WorkbenchLifecycleExecutionPort } from "../../src/workbench/lifecycle-execution.js";
import type { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";
import {
  classifyWorkbenchExitStatus,
  WorkbenchRunnerError,
  type WorkbenchBuildReceipt,
  type WorkbenchRunnerDependencies,
  type WorkbenchRunnerIntent,
  type WorkbenchRunnerReceipt,
} from "../../src/workbench/runner.js";
import { WorkbenchSessionController } from "../../src/workbench/session-controller.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

vi.mock("../../src/observer/application.js", () => ({
  createObserverApplication: () => ({
    ownedRuntimeManager: {},
    closeRuntimeLifecycle: async () => ({}),
  }),
}));

vi.mock("../../src/observer/tools.js", () => ({
  registerObserverTools: vi.fn(),
}));

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface RegisteredTool {
  definition: {
    description?: string;
    inputSchema?: Record<string, {
      safeParse(value: unknown): { success: boolean; data?: unknown };
    }>;
  };
  handler(
    input: Record<string, unknown>,
    extra: { signal: AbortSignal }
  ): Promise<ToolResult>;
}

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

function receipt(
  overrides: Partial<WorkbenchBuildReceipt> = {}
): WorkbenchBuildReceipt {
  return {
    intent: "build",
    pid: 22_001,
    executablePath: "C:\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
    creationTime: "133900000000022001",
    target: "C:\\mods\\OnePointZeroOne\\OnePointZeroOne.gproj",
    targetAddon: {
      addonId: "OnePointZeroOne",
      addonGuid: "1122334455667788",
      sourceSha256: "a".repeat(64),
    },
    lifecycleGeneration: "generation-build",
    processOwnership: "verified",
    endpointVacancy: "verified",
    logDirectory: "C:\\managed\\logs\\build",
    output: {
      root: "C:\\build\\OnePointZeroOne",
      freshArtifactCount: 2,
      freshBytes: 4096,
      resourceDatabasePath: "C:\\build\\OnePointZeroOne\\resourceDatabase.rdb",
      previousResourceDatabaseSha256: null,
      resourceDatabaseSha256: "c".repeat(64),
    },
    validationFailure: null,
    exitStatus: classifyWorkbenchExitStatus({
      reason: "exited",
      exitCode: 0,
      signal: null,
      timedOut: false,
    }),
    ...overrides,
  };
}

function registry(
  client: unknown,
  dependencies: {
    companionProvider: WorkbenchCompanionProvider;
    managedRoot: string;
    runIntent: (
      config: Config,
      intent: WorkbenchRunnerIntent,
      dependencies?: WorkbenchRunnerDependencies
    ) => Promise<WorkbenchRunnerReceipt>;
    assertSteamReady(): void;
    processGuard: WorkbenchProcessGuard;
  }
): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const server = {
    registerTool(
      name: string,
      definition: RegisteredTool["definition"],
      handler: RegisteredTool["handler"]
    ): void {
      expect(name).toBe("wb_build");
      registered = { definition, handler };
    },
  } as unknown as McpServer;
  registerWbBuild(server, config(), client as never, dependencies);
  expect(registered).toBeDefined();
  return registered!;
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

function resultReceipt(result: ToolResult): WorkbenchBuildReceipt {
  const text = resultText(result);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(text.slice(start, end + 1)) as WorkbenchBuildReceipt;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("wb_build MCP tool", () => {
  it("is wired exactly once into the complete MCP server registration", async () => {
    const registeredNames: string[] = [];
    const closeBuild = vi.spyOn(
      WorkbenchSessionController.prototype,
      "closeOwnerScopedTargetBuild"
    );
    const server = {
      registerTool(name: string): void {
        registeredNames.push(name);
      },
      registerPrompt(): void {},
      registerResource(): void {},
    } as unknown as McpServer;
    const dispose = registerTools(server, config());

    try {
      expect(registeredNames.filter((name) => name === "wb_build")).toEqual(["wb_build"]);
      await dispose();
      expect(closeBuild).toHaveBeenCalledOnce();
    } finally {
      await dispose();
      closeBuild.mockRestore();
    }
  });

  it("registers an explicit target/output schema with one bounded PC build", () => {
    const tool = registry(
      { runOwnerScopedTargetBuild: vi.fn() },
      {
        companionProvider: {} as WorkbenchCompanionProvider,
        managedRoot: "C:\\managed",
        runIntent: vi.fn(),
        assertSteamReady: vi.fn(),
        processGuard: {} as WorkbenchProcessGuard,
      }
    );
    const schema = tool.definition.inputSchema!;

    expect(tool.definition.description).toMatch(/Windows exceptions/i);
    expect(schema.gprojPath.safeParse(undefined).success).toBe(false);
    expect(schema.gprojPath.safeParse("").success).toBe(false);
    expect(schema.gprojPath.safeParse("C:\\mods\\OPZO\\OPZO.gproj").success).toBe(true);
    expect(schema.outputPath.safeParse(undefined).success).toBe(false);
    expect(schema.outputPath.safeParse("").success).toBe(false);
    expect(schema.platform.safeParse(undefined)).toMatchObject({
      success: true,
      data: "PC",
    });
    expect(schema.platform.safeParse("Linux").success).toBe(false);
    expect(schema.timeoutMs.safeParse(undefined)).toMatchObject({
      success: true,
      data: 600_000,
    });
    expect(schema.timeoutMs.safeParse(999).success).toBe(false);
    expect(schema.timeoutMs.safeParse(1_000).success).toBe(true);
    expect(schema.timeoutMs.safeParse(3_600_000).success).toBe(true);
    expect(schema.timeoutMs.safeParse(3_600_001).success).toBe(false);
  });

  it("runs with the MCP controller's exact lifecycle execution and forwards cancellation", async () => {
    const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
    const sharedProcessGuard = {} as WorkbenchProcessGuard;
    const companionProvider = {} as WorkbenchCompanionProvider;
    const signalController = new AbortController();
    const successfulReceipt = receipt();
    let steamReady = false;
    const assertSteamReady = vi.fn(() => {
      steamReady = true;
    });
    const runIntent = vi.fn(async (
      receivedConfig: Config,
      intent: WorkbenchRunnerIntent,
      dependencies: WorkbenchRunnerDependencies = {}
    ): Promise<WorkbenchRunnerReceipt> => {
      expect(steamReady).toBe(true);
      expect(receivedConfig).toEqual(config());
      expect(intent).toEqual({
        kind: "build",
        gprojPath: "C:\\mods\\OnePointZeroOne\\OnePointZeroOne.gproj",
        platform: "PC",
        outputPath: "C:\\build\\OnePointZeroOne",
        timeoutMs: 600_000,
      });
      expect(dependencies).toMatchObject({
        lifecycleExecution: sharedExecution,
        runnerProcessGuard: sharedProcessGuard,
        companionProvider,
        managedRoot: "C:\\managed",
        lifecycleEntry: "owner_scoped",
        signal: signalController.signal,
      });
      return successfulReceipt;
    });
    const client = {
      runOwnerScopedTargetBuild: vi.fn(async (
        gprojPath: string,
        action: (
          execution: WorkbenchLifecycleExecutionPort,
          signal: AbortSignal
        ) => Promise<WorkbenchRunnerReceipt>,
        options: { signal?: AbortSignal }
      ) => {
        expect(gprojPath).toBe("C:\\mods\\OnePointZeroOne\\OnePointZeroOne.gproj");
        expect(options.signal).toBe(signalController.signal);
        return action(sharedExecution, signalController.signal);
      }),
    };
    const tool = registry(client, {
      companionProvider,
      managedRoot: "C:\\managed",
      runIntent,
      assertSteamReady,
      processGuard: sharedProcessGuard,
    });

    const result = await tool.handler({
      gprojPath: "C:\\mods\\OnePointZeroOne\\OnePointZeroOne.gproj",
      outputPath: "C:\\build\\OnePointZeroOne",
      platform: "PC",
      timeoutMs: 600_000,
    }, { signal: signalController.signal });

    expect(result.isError).not.toBe(true);
    expect(resultReceipt(result)).toEqual(successfulReceipt);
    expect(assertSteamReady).toHaveBeenCalledOnce();
    expect(client.runOwnerScopedTargetBuild).toHaveBeenCalledOnce();
    expect(runIntent).toHaveBeenCalledOnce();
  });

  it("reuses the MCP process guard in the runner controller composition", () => {
    const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
    const sharedProcessGuard = {} as WorkbenchProcessGuard;
    const runner = WorkbenchSessionController.composeRunner(
      "127.0.0.1",
      5775,
      sharedExecution,
      sharedProcessGuard
    ) as unknown as {
      processGuard: WorkbenchProcessGuard;
      runnerLifecycleExecution: WorkbenchLifecycleExecutionPort;
    };

    expect(runner.processGuard).toBe(sharedProcessGuard);
    expect(runner.runnerLifecycleExecution).toBe(sharedExecution);
  });

  it("keeps the complete build callback inside the controller's shared activity gate", async () => {
    await withTemporaryDirectory(async (root) => {
      const gprojPath = join(root, "OnePointZeroOne.gproj");
      writeFileSync(gprojPath, "GameProject {}\n");
      const activityGate = new WorkbenchActivityGate();
      const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
      const controller = new WorkbenchSessionController(
        "127.0.0.1",
        5775,
        undefined,
        undefined,
        {} as never,
        {
          activityGate,
          lifecycleExecution: sharedExecution,
        }
      );
      Object.assign(controller, {
        reconcileOwnerScopedTargetBuildEntry: async () => undefined,
      });
      const entered = deferred<WorkbenchLifecycleExecutionPort>();
      const release = deferred();
      const build = controller.runOwnerScopedTargetBuild(
        gprojPath,
        async (execution) => {
          entered.resolve(execution);
          await release.promise;
          return receipt();
        },
        {}
      );

      await expect(entered.promise).resolves.toBe(sharedExecution);
      await expect(activityGate.runManaged("late NET request", async () => "late"))
        .rejects.toMatchObject({ code: "LIFECYCLE_BUSY" });
      const launchAction = vi.fn(async () => "launched");
      const queuedLaunch = activityGate.runLifecycle("launch", launchAction);
      await Promise.resolve();
      expect(launchAction).not.toHaveBeenCalled();

      release.resolve();
      await expect(build).resolves.toEqual(receipt());
      await expect(queuedLaunch).resolves.toBe("launched");
      expect(launchAction).toHaveBeenCalledOnce();
      await expect(activityGate.runManaged("post-build NET request", async () => "ready"))
        .resolves.toBe("ready");
    }, { prefix: "rfo-owner-build-gate-" });
  });

  it("aborts and awaits active owner-scoped build cleanup before closing", async () => {
    await withTemporaryDirectory(async (root) => {
      const gprojPath = join(root, "OnePointZeroOne.gproj");
      writeFileSync(gprojPath, "GameProject {}\n");
      const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
      const controller = new WorkbenchSessionController(
        "127.0.0.1",
        5775,
        undefined,
        undefined,
        {} as never,
        { lifecycleExecution: sharedExecution }
      );
      Object.assign(controller, {
        reconcileOwnerScopedTargetBuildEntry: async () => undefined,
      });
      const entered = deferred<AbortSignal>();
      const aborted = deferred();
      const releaseCleanup = deferred();
      const build = controller.runOwnerScopedTargetBuild(
        gprojPath,
        async (execution, signal) => {
          expect(execution).toBe(sharedExecution);
          entered.resolve(signal);
          signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          await releaseCleanup.promise;
          return receipt({
            output: null,
            exitStatus: classifyWorkbenchExitStatus({
              reason: "aborted",
              exitCode: null,
              signal: null,
              timedOut: false,
            }),
          });
        },
        {}
      );
      const buildSignal = await entered.promise;
      expect(buildSignal.aborted).toBe(false);

      let closeSettled = false;
      const close = controller.closeOwnerScopedTargetBuild().finally(() => {
        closeSettled = true;
      });
      await aborted.promise;
      expect(buildSignal.aborted).toBe(true);
      await Promise.resolve();
      expect(closeSettled).toBe(false);

      const refusedAction = vi.fn(async () => receipt());
      await expect(controller.runOwnerScopedTargetBuild(
        gprojPath,
        refusedAction,
        {}
      )).rejects.toBeInstanceOf(Error);
      expect(refusedAction).not.toHaveBeenCalled();

      releaseCleanup.resolve();
      await expect(build).resolves.toMatchObject({
        exitStatus: { reason: "aborted" },
      });
      await expect(close).resolves.toBeUndefined();
      expect(closeSettled).toBe(true);
    }, { prefix: "rfo-owner-build-close-" });
  });

  it("returns unsuccessful native and attestation receipts intact as MCP errors", async () => {
    const cases = [
      receipt({
        output: null,
        exitStatus: classifyWorkbenchExitStatus({
          reason: "exited",
          exitCode: 7,
          signal: null,
          timedOut: false,
        }),
      }),
      receipt({
        output: null,
        exitStatus: classifyWorkbenchExitStatus({
          reason: "exited",
          exitCode: 0xC0000005,
          signal: null,
          timedOut: false,
        }),
      }),
      receipt({
        output: null,
        validationFailure: {
          code: "OUTPUT_ATTESTATION_FAILED",
          message: "Expected exactly one fresh resourceDatabase.rdb.",
        },
      }),
    ];

    for (const failedReceipt of cases) {
      const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
      const tool = registry(
        {
          runOwnerScopedTargetBuild: (
            _gprojPath: string,
            action: (
              execution: WorkbenchLifecycleExecutionPort,
              signal: AbortSignal
            ) => Promise<WorkbenchRunnerReceipt>,
            options: { signal?: AbortSignal }
          ) => action(sharedExecution, options.signal ?? new AbortController().signal),
        },
        {
          companionProvider: {} as WorkbenchCompanionProvider,
          managedRoot: "C:\\managed",
          runIntent: vi.fn(async () => failedReceipt),
          assertSteamReady: vi.fn(),
          processGuard: {} as WorkbenchProcessGuard,
        }
      );

      const result = await tool.handler({
        gprojPath: "C:\\mods\\OnePointZeroOne\\OnePointZeroOne.gproj",
        outputPath: "C:\\build\\OnePointZeroOne",
        platform: "PC",
        timeoutMs: 600_000,
      }, { signal: new AbortController().signal });

      expect(result.isError).toBe(true);
      expect(resultReceipt(result)).toEqual(failedReceipt);
    }
  });

  it("preserves missing dependency GUIDs and remediation in the public error JSON", async () => {
    const message =
      "Workbench cannot resolve every dependency declared by the target project. " +
      "Missing dependency GUID(s): 64B73652C12170E6, 64C912EF952E1075. " +
      "Add the add-on root containing each missing project to workbenchAddonDirs, " +
      "or pass --workbench-addon-dir <directory> once for each required root. " +
      "No Workbench process was launched.";
    const runIntent = vi.fn(async (): Promise<WorkbenchRunnerReceipt> => {
      throw new WorkbenchRunnerError(message, "INVALID_CONFIG");
    });
    const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
    const tool = registry(
      {
        runOwnerScopedTargetBuild: (
          _gprojPath: string,
          action: (
            execution: WorkbenchLifecycleExecutionPort,
            signal: AbortSignal
          ) => Promise<WorkbenchRunnerReceipt>,
          options: { signal?: AbortSignal }
        ) => action(sharedExecution, options.signal ?? new AbortController().signal),
      },
      {
        companionProvider: {} as WorkbenchCompanionProvider,
        managedRoot: "C:\\managed",
        runIntent,
        assertSteamReady: vi.fn(),
        processGuard: {} as WorkbenchProcessGuard,
      }
    );

    const result = await tool.handler({
      gprojPath: "C:\\mods\\OnePointZeroOne\\OnePointZeroOne.gproj",
      outputPath: "C:\\build\\OnePointZeroOne",
      platform: "PC",
      timeoutMs: 600_000,
    }, { signal: new AbortController().signal });

    expect(result.isError).toBe(true);
    expect(JSON.parse(resultText(result))).toEqual({
      ok: false,
      code: "INVALID_CONFIG",
      message,
    });
    expect(runIntent).toHaveBeenCalledOnce();
  });

  it("reports runner error codes while preserving the request abort signal", async () => {
    const signalController = new AbortController();
    signalController.abort("caller cancelled");
    const runIntent = vi.fn(async (
      _config: Config,
      _intent: WorkbenchRunnerIntent,
      dependencies: WorkbenchRunnerDependencies = {}
    ): Promise<WorkbenchRunnerReceipt> => {
      expect(dependencies.signal).toBe(signalController.signal);
      expect(dependencies.signal?.aborted).toBe(true);
      throw new WorkbenchRunnerError(
        "Workbench build was aborted before spawn.",
        "BUILD_ABORTED"
      );
    });
    const sharedExecution = {} as WorkbenchLifecycleExecutionPort;
    const tool = registry(
      {
        runOwnerScopedTargetBuild: (
          _gprojPath: string,
          action: (
            execution: WorkbenchLifecycleExecutionPort,
            signal: AbortSignal
          ) => Promise<WorkbenchRunnerReceipt>,
          options: { signal?: AbortSignal }
        ) => action(sharedExecution, options.signal ?? new AbortController().signal),
      },
      {
        companionProvider: {} as WorkbenchCompanionProvider,
        managedRoot: "C:\\managed",
        runIntent,
        assertSteamReady: vi.fn(),
        processGuard: {} as WorkbenchProcessGuard,
      }
    );

    const result = await tool.handler({
      gprojPath: "C:\\mods\\OnePointZeroOne\\OnePointZeroOne.gproj",
      outputPath: "C:\\build\\OnePointZeroOne",
      platform: "PC",
      timeoutMs: 600_000,
    }, { signal: signalController.signal });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("BUILD_ABORTED");
    expect(runIntent).toHaveBeenCalledOnce();
  });
});
