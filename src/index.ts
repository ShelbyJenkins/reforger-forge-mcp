#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CONFIGURATION_USAGE,
  loadConfig,
  partitionConfigurationArguments,
  type Config,
} from "./config.js";
import { registerTools } from "./server.js";
import { logger, setDebugEnabled } from "./utils/logger.js";

const SERVER_VERSION = "1.1.0";

function usage(): string {
  return [
    "Usage: reforger-forge-mcp [configuration options]",
    "",
    "Required installation paths must come from an explicit --config file or CLI flags.",
    "",
    CONFIGURATION_USAGE,
    "",
    "Other:",
    "  -h, --help                               Show this help.",
    "  --version                                Show the package version.",
    "",
  ].join("\n");
}

async function runServer(config: Config): Promise<void> {
  const server = new McpServer({
    name: "reforger-forge-mcp",
    version: SERVER_VERSION,
  });
  const disposeTools = registerTools(server, config);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | null = null;

  const reportSealResult = (result: Record<string, unknown>): void => {
    const errors = Array.isArray(result.errorRuntimes) ? result.errorRuntimes.length : 0;
    const busy = Array.isArray(result.busyRuntimeIds) ? result.busyRuntimeIds.length : 0;
    if (errors > 0 || busy > 0) {
      logger.warn(`shutdown left ${busy} busy and ${errors} unverifiable runtime lifecycle(s) unsealed`);
    }
  };

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      process.stdin.off("end", onStdinEnd);
      process.stdin.off("close", onStdinClose);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      try {
        reportSealResult(await disposeTools());
      } finally {
        await server.close();
      }
      logger.info(`ReforgerForge MCP server stopped (${reason})`);
    })();
    return shutdownPromise;
  };

  const requestShutdown = (reason: string): void => {
    void shutdown(reason).catch((error) => {
      process.exitCode = 1;
      logger.error(`MCP shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  function onStdinEnd(): void { requestShutdown("stdin EOF"); }
  function onStdinClose(): void { requestShutdown("stdin closed"); }
  function onSigint(): void { requestShutdown("SIGINT"); }
  function onSigterm(): void { requestShutdown("SIGTERM"); }

  process.stdin.once("end", onStdinEnd);
  process.stdin.once("close", onStdinClose);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await server.connect(transport);
    logger.info("ReforgerForge MCP server started");
  } catch (error) {
    await shutdown("startup failure").catch(() => undefined);
    throw error;
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const partitioned = partitionConfigurationArguments(argv);
  if (partitioned.remainingArguments.length === 1
      && ["-h", "--help"].includes(partitioned.remainingArguments[0])) {
    process.stdout.write(usage());
    return;
  }
  if (partitioned.remainingArguments.length === 1
      && partitioned.remainingArguments[0] === "--version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (partitioned.remainingArguments.length > 0) {
    throw new Error(
      `Unknown argument${partitioned.remainingArguments.length === 1 ? "" : "s"}: ` +
      partitioned.remainingArguments.join(" ")
    );
  }

  const config = loadConfig(partitioned.configurationArguments);
  setDebugEnabled(config.debug === true);
  await runServer(config);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = 1;
  logger.error(error instanceof Error ? error.message : String(error));
}
