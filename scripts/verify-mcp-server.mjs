#!/usr/bin/env node
/**
 * Verifies configuration, discovery, the MCP handshake, and the registered
 * tool contract without reserving any server arguments.
 *
 * Run: node scripts/verify-mcp-server.mjs [configuration options]
 */
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  formatServerVerificationReport,
  isServerVerificationSuccessful,
  serializeServerVerificationReport,
  verifyMcpServer,
  writeServerVerificationReportAtomic,
} from "../dist/setup/server-verification.js";
import { partitionMcpHostArguments } from "../dist/mcp-host-identity.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostPartition = partitionMcpHostArguments(process.argv.slice(2));
const serverArguments = hostPartition.remainingArguments;
const packageDocument = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8")
);
if (
  typeof packageDocument.version !== "string" ||
  packageDocument.version.length === 0
) {
  throw new Error("package.json must declare a non-empty version");
}

const jsonOutput = process.env.REFORGER_FORGE_VERIFY_JSON === "1";
const quietOutput = process.env.REFORGER_FORGE_VERIFY_QUIET === "1";
const reportPath = process.env.REFORGER_FORGE_VERIFY_REPORT_PATH;

try {
  const report = await verifyMcpServer({
    packageRoot: root,
    packageVersion: packageDocument.version,
    hostClientLabel: hostPartition.clientLabel,
    startupArguments: serverArguments,
  });

  if (jsonOutput) {
    process.stdout.write(serializeServerVerificationReport(report));
  } else if (!quietOutput) {
    process.stdout.write(formatServerVerificationReport(report));
  }

  if (reportPath) {
    await writeServerVerificationReportAtomic(reportPath, report);
  }

  if (!isServerVerificationSuccessful(report)) {
    process.exitCode = 1;
  }
} catch (error) {
  process.exitCode = 1;
  process.stderr.write(
    `ReforgerForge verification failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
}
