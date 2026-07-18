#!/usr/bin/env node

import { loadConfig } from "../config.js";
import {
  parseWorkbenchRunnerArguments,
  runWorkbenchIntent,
  type WorkbenchRunnerReceipt,
} from "./runner.js";

function redactPrivateOwnerTokens(message: string): string {
  return message.replace(
    /-reforgerForgeOwnerToken(?:=|\s+)[^\s"']+/gi,
    "-reforgerForgeOwnerToken=[redacted]"
  );
}

function receiptExitCode(receipt: WorkbenchRunnerReceipt): number {
  if (receipt.intent === "build" && receipt.validationFailure) return 1;
  if (receipt.exitStatus.reason === "timed_out") return 124;
  if (receipt.exitStatus.reason === "aborted") return 130;
  if (receipt.exitStatus.exitCode === null) return receipt.exitStatus.signal ? 1 : 0;
  return receipt.exitStatus.exitCode >= 0 && receipt.exitStatus.exitCode <= 255
    ? receipt.exitStatus.exitCode
    : 1;
}

const abortController = new AbortController();
const requestAbort = (): void => abortController.abort();
process.on("SIGINT", requestAbort);
process.on("SIGTERM", requestAbort);

try {
  const intent = parseWorkbenchRunnerArguments(process.argv.slice(2));
  const receipt = await runWorkbenchIntent(loadConfig(), intent, {
    signal: abortController.signal,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receiptExitCode(receipt);
} catch (error) {
  const record = error && typeof error === "object" ? error as { code?: unknown } : null;
  const message = redactPrivateOwnerTokens(
    error instanceof Error ? error.message : String(error)
  );
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: typeof record?.code === "string" ? record.code : "RUNNER_FAILED",
    message,
  })}\n`);
  process.exitCode = abortController.signal.aborted ? 130 : 1;
} finally {
  process.off("SIGINT", requestAbort);
  process.off("SIGTERM", requestAbort);
}
