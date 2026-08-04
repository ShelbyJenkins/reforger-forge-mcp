import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { redactText } from "../foundation/redact.js";
import type {
  WorkbenchLifecycleExecutionPort,
  WorkbenchLifecycleGuard,
} from "../workbench/lifecycle-execution.js";
import {
  runWorkbenchIntent,
  type WorkbenchCheckReceipt,
  type WorkbenchRunnerReceipt,
} from "../workbench/runner.js";
import { assertSteamClientReady } from "../workbench/runner-prerequisites.js";
import type { OwnerScopedTargetCheckOptions } from "../workbench/session-controller.js";

const DEFAULT_CHECK_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_CHECK_TIMEOUT_MS = 10 * 60 * 1_000;

const exitStatusSchema = z.object({
  reason: z.enum(["exited", "timed_out", "aborted"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  classification: z.enum([
    "success",
    "nonzero_exit",
    "windows_exception",
    "signal",
    "timed_out",
    "aborted",
    "unknown",
  ]),
  nativeStatus: z.string().nullable(),
  exceptionName: z.string().nullable(),
});

const compilationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("compiled") }),
  z.object({
    status: z.literal("failed"),
    code: z.literal("PROJECT_COMPILE_FAILED"),
    module: z.string(),
    diagnostics: z.array(z.string()),
    logPath: z.string(),
  }),
  z.object({
    status: z.literal("indeterminate"),
    code: z.literal("COMPILATION_INDETERMINATE"),
    message: z.string(),
  }),
]);

export const wbCheckOutputSchema = {
  intent: z.literal("check"),
  scope: z.literal("enforceScripts"),
  engineValidated: z.literal(true),
  pid: z.number().int().positive(),
  executablePath: z.string(),
  creationTime: z.string(),
  target: z.string(),
  targetAddon: z.object({
    addonId: z.string(),
    addonGuid: z.string(),
    sourceSha256: z.string(),
  }),
  configuration: z.string(),
  lifecycleGeneration: z.string(),
  processOwnership: z.literal("verified"),
  endpointVacancy: z.literal("verified"),
  logDirectory: z.string(),
  compilation: compilationSchema,
  exitStatus: exitStatusSchema,
};

export interface OwnerScopedTargetCheckPort {
  runOwnerScopedTargetCheck<T>(
    gprojPath: string,
    action: (
      lifecycleExecution: WorkbenchLifecycleExecutionPort,
      signal: AbortSignal
    ) => Promise<T>,
    options?: OwnerScopedTargetCheckOptions
  ): Promise<T>;
}

export interface WbCheckToolDependencies {
  readonly managedRoot: string;
  readonly processGuard: WorkbenchLifecycleGuard;
  readonly runIntent?: typeof runWorkbenchIntent;
  readonly assertSteamReady?: () => void;
}

function successfulCheck(receipt: WorkbenchCheckReceipt): boolean {
  return receipt.compilation.status === "compiled" &&
    receipt.exitStatus.reason === "exited" &&
    receipt.exitStatus.exitCode === 0;
}

function renderCheck(receipt: WorkbenchCheckReceipt): string {
  const summary = receipt.compilation.status === "compiled"
    ? `Enforce Scripts compiled for ${receipt.target} (${receipt.configuration}).`
    : receipt.compilation.status === "failed"
      ? `Enforce Scripts failed to compile in module ${receipt.compilation.module} ` +
        `for ${receipt.target} (${receipt.configuration}).`
      : `Enforce Script compilation was indeterminate for ${receipt.target} ` +
        `(${receipt.configuration}).`;
  return `${summary}\n${JSON.stringify(receipt, null, 2)}`;
}

function errorRecord(error: unknown, aborted: boolean): {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
} {
  const coded = error && typeof error === "object" ? error as { code?: unknown } : null;
  return {
    ok: false,
    code: aborted
      ? "CHECK_ABORTED"
      : typeof coded?.code === "string"
        ? coded.code
        : "CHECK_FAILED",
    message: redactText(error instanceof Error ? error.message : String(error), {
      profile: "command_argument",
      replacement: "[redacted]",
    }),
  };
}

export function registerWbCheck(
  server: McpServer,
  config: Config,
  client: OwnerScopedTargetCheckPort,
  dependencies: WbCheckToolDependencies
): void {
  server.registerTool(
    "wb_check",
    {
      description:
        "Compile the Enforce Scripts of one exact Arma Reforger .gproj through a hidden, " +
        "helper-free, guarded Workbench process. This is a script-compilation preflight only: " +
        "it does not validate resources, packaging, materials, prefabs, worlds, or the whole add-on. " +
        "It refuses live or unowned Workbench processes, concurrent lifecycle mutation, unresolved " +
        "spawn recovery, dependency ambiguity, and unknown project configurations.",
      inputSchema: {
        gprojPath: z.string().trim().min(1).refine(isAbsolute, {
          message: "gprojPath must be an exact absolute path.",
        }).describe(
          "Absolute path to the exact target .gproj. No configured or prior-target fallback is used."
        ),
        configuration: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)
          .default("PC")
          .describe("Script configuration declared by the target .gproj (initial default: PC)."),
        timeoutMs: z.number().int().min(1_000).max(MAX_CHECK_TIMEOUT_MS)
          .default(DEFAULT_CHECK_TIMEOUT_MS)
          .describe("Absolute compile-and-cleanup deadline in milliseconds."),
      },
      outputSchema: wbCheckOutputSchema,
    },
    async ({ gprojPath, configuration, timeoutMs }, extra) => {
      try {
        const receipt = await client.runOwnerScopedTargetCheck(
          gprojPath,
          async (lifecycleExecution, signal): Promise<WorkbenchRunnerReceipt> => {
            (dependencies.assertSteamReady ?? assertSteamClientReady)();
            return (dependencies.runIntent ?? runWorkbenchIntent)(
              config,
              { kind: "check", gprojPath, configuration, timeoutMs },
              {
                lifecycleExecution,
                runnerProcessGuard: dependencies.processGuard,
                managedRoot: dependencies.managedRoot,
                lifecycleEntry: "owner_scoped",
                signal,
              }
            );
          },
          { signal: extra.signal }
        );
        if (receipt.intent !== "check") {
          throw new Error("Owner-scoped Workbench check returned a non-check receipt.");
        }
        return {
          content: [{ type: "text" as const, text: renderCheck(receipt) }],
          structuredContent: { ...receipt },
          ...(successfulCheck(receipt) ? {} : { isError: true }),
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
