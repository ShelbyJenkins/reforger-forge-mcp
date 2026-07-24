#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config.js";
import { loadConfig, partitionConfigurationArguments } from "../config.js";
import { redactText } from "../foundation/redact.js";
import { setDebugEnabled } from "../utils/logger.js";
import {
  parseWorkbenchRunnerArguments,
  runWorkbenchIntent,
  type WorkbenchRunnerReceipt,
} from "./runner.js";

export function receiptExitCode(receipt: WorkbenchRunnerReceipt): number {
  if (receipt.intent === "build" && receipt.validationFailure) return 1;
  if (receipt.exitStatus.reason === "timed_out") return 124;
  if (receipt.exitStatus.reason === "aborted") return 130;
  if (receipt.exitStatus.exitCode === null) return receipt.exitStatus.signal ? 1 : 0;
  return receipt.exitStatus.exitCode >= 0 && receipt.exitStatus.exitCode <= 255
    ? receipt.exitStatus.exitCode
    : 1;
}

export function installedPackageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version)) {
    throw new Error("Installed package manifest does not contain a valid version");
  }
  return manifest.version;
}

interface WorkbenchRunnerCliOutput {
  write(value: string): unknown;
}

export interface WorkbenchRunnerCliDependencies {
  readonly loadConfiguration?: (argumentsArray: readonly string[]) => Config;
  readonly runIntent?: typeof runWorkbenchIntent;
  readonly packageVersion?: () => string;
  readonly setDebug?: (enabled: boolean) => void;
  readonly stdout?: WorkbenchRunnerCliOutput;
  readonly stderr?: WorkbenchRunnerCliOutput;
  readonly signal?: AbortSignal;
}

/**
 * Execute one CLI request and emit exactly one stdout receipt or one stderr
 * error record. Process signal wiring and `process.exitCode` remain in `main`.
 */
export async function executeWorkbenchRunnerCli(
  cliArguments: readonly string[],
  dependencies: WorkbenchRunnerCliDependencies = {}
): Promise<number> {
  const stdout = dependencies.stdout ?? { write: (value: string) => process.stdout.write(value) };
  const stderr = dependencies.stderr ?? { write: (value: string) => process.stderr.write(value) };
  const partitioned = partitionConfigurationArguments(cliArguments);
  if (partitioned.remainingArguments.length === 1
      && partitioned.remainingArguments[0] === "--version") {
    stdout.write(`${(dependencies.packageVersion ?? installedPackageVersion)()}\n`);
    return 0;
  }

  try {
    const intent = parseWorkbenchRunnerArguments(partitioned.remainingArguments);
    const config = (dependencies.loadConfiguration ?? loadConfig)(
      partitioned.configurationArguments
    );
    (dependencies.setDebug ?? setDebugEnabled)(config.debug === true);
    const receipt = await (dependencies.runIntent ?? runWorkbenchIntent)(
      config,
      intent,
      dependencies.signal ? { signal: dependencies.signal } : {}
    );
    stdout.write(`${JSON.stringify(receipt)}\n`);
    return receiptExitCode(receipt);
  } catch (error) {
    const record = error && typeof error === "object" ? error as { code?: unknown } : null;
    const message = redactText(error instanceof Error ? error.message : String(error), {
      profile: "command_argument",
      replacement: "[redacted]",
    });
    stderr.write(`${JSON.stringify({
      ok: false,
      code: typeof record?.code === "string" ? record.code : "RUNNER_FAILED",
      message,
    })}\n`);
    return dependencies.signal?.aborted ? 130 : 1;
  }
}

async function main(): Promise<void> {
  const abortController = new AbortController();
  const requestAbort = (): void => abortController.abort();
  process.on("SIGINT", requestAbort);
  process.on("SIGTERM", requestAbort);

  try {
    process.exitCode = await executeWorkbenchRunnerCli(process.argv.slice(2), {
      signal: abortController.signal,
    });
  } finally {
    process.off("SIGINT", requestAbort);
    process.off("SIGTERM", requestAbort);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) void main();
