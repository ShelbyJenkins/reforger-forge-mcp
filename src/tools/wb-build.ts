import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { redactText } from "../foundation/redact.js";
import type { WorkbenchCompanionProvider } from "../workbench/helper-addon.js";
import type {
  WorkbenchLifecycleExecutionPort,
  WorkbenchLifecycleGuard,
} from "../workbench/lifecycle-execution.js";
import {
  runWorkbenchIntent,
  type WorkbenchBuildReceipt,
  type WorkbenchRunnerReceipt,
} from "../workbench/runner.js";
import { assertSteamClientReady } from "../workbench/runner-prerequisites.js";
import type { OwnerScopedTargetBuildOptions } from "../workbench/session-controller.js";

const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_BUILD_TIMEOUT_MS = 60 * 60 * 1_000;

export interface OwnerScopedTargetBuildPort {
  runOwnerScopedTargetBuild<T>(
    gprojPath: string,
    action: (
      lifecycleExecution: WorkbenchLifecycleExecutionPort,
      signal: AbortSignal
    ) => Promise<T>,
    options?: OwnerScopedTargetBuildOptions
  ): Promise<T>;
}

export interface WbBuildToolDependencies {
  readonly companionProvider: WorkbenchCompanionProvider;
  readonly managedRoot: string;
  readonly processGuard: WorkbenchLifecycleGuard;
  readonly runIntent?: typeof runWorkbenchIntent;
  readonly assertSteamReady?: () => void;
}

function successfulBuild(receipt: WorkbenchBuildReceipt): boolean {
  return receipt.exitStatus.reason === "exited" &&
    receipt.exitStatus.exitCode === 0 &&
    receipt.exitStatus.signal === null &&
    receipt.validationFailure === null &&
    receipt.output !== null;
}

function errorRecord(error: unknown, aborted: boolean): {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
} {
  const coded = error && typeof error === "object"
    ? error as { code?: unknown }
    : null;
  return {
    ok: false,
    code: aborted
      ? "BUILD_ABORTED"
      : typeof coded?.code === "string"
        ? coded.code
        : "BUILD_FAILED",
    message: redactText(error instanceof Error ? error.message : String(error), {
      profile: "command_argument",
      replacement: "[redacted]",
    }),
  };
}

export function registerWbBuild(
  server: McpServer,
  config: Config,
  client: OwnerScopedTargetBuildPort,
  dependencies: WbBuildToolDependencies
): void {
  server.registerTool(
    "wb_build",
    {
      description:
        "Build one exact Arma Reforger .gproj through the active MCP owner's guarded " +
        "Workbench lifecycle. Requires a caller-exclusive empty output directory, refuses " +
        "a running editor or concurrent lifecycle mutation, and returns the full helper-free " +
        "receipt only after exact process cleanup and endpoint vacancy. The exitStatus " +
        "classification distinguishes ordinary nonzero exits from Windows exceptions; fresh " +
        "output attestation runs only after a zero native exit.",
      inputSchema: {
        gprojPath: z.string().trim().min(1).describe(
          "Absolute path to the exact target .gproj. No configured or prior-target fallback is used."
        ),
        outputPath: z.string().trim().min(1).describe(
          "Caller-exclusive missing or empty output directory outside the target and managed roots."
        ),
        platform: z.literal("PC").default("PC").describe(
          "Target platform. The guarded builder currently supports only PC."
        ),
        timeoutMs: z.number().int().min(1_000).max(MAX_BUILD_TIMEOUT_MS)
          .default(DEFAULT_BUILD_TIMEOUT_MS)
          .describe("Absolute build deadline in milliseconds, including target build and cleanup."),
      },
    },
    async ({ gprojPath, outputPath, platform, timeoutMs }, extra) => {
      try {
        const receipt = await client.runOwnerScopedTargetBuild(
          gprojPath,
          async (lifecycleExecution, signal): Promise<WorkbenchRunnerReceipt> => {
            (dependencies.assertSteamReady ?? assertSteamClientReady)();
            return (dependencies.runIntent ?? runWorkbenchIntent)(
              config,
              {
                kind: "build",
                gprojPath,
                outputPath,
                platform,
                timeoutMs,
              },
              {
                lifecycleExecution,
                runnerProcessGuard: dependencies.processGuard,
                companionProvider: dependencies.companionProvider,
                managedRoot: dependencies.managedRoot,
                lifecycleEntry: "owner_scoped",
                signal,
              }
            );
          },
          { signal: extra.signal }
        );
        if (receipt.intent !== "build") {
          throw new Error("Owner-scoped Workbench build returned a non-build receipt.");
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(receipt, null, 2),
          }],
          ...(successfulBuild(receipt) ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(errorRecord(error, extra.signal.aborted), null, 2),
          }],
          isError: true,
        };
      }
    }
  );
}
