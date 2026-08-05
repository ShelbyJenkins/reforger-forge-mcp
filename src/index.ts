#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CONFIGURATION_USAGE,
  loadConfig,
  partitionConfigurationArguments,
  type Config,
} from "./config.js";
import { registerTools } from "./server.js";
import { runCliShutdown } from "./mcp-lifecycle.js";
import {
  createMcpHostIdentity,
  formatMcpProcessTitle,
  partitionMcpHostArguments,
  type McpHostIdentity,
} from "./mcp-host-identity.js";
import {
  discoverSteamInstallations,
  STEAM_DISCOVERY_EXIT_CODES,
} from "./platform/windows/steam-discovery.js";
import {
  CHECK_ADDON_DIRS_COMMAND,
  checkAddonDirs,
  formatCheckAddonDirsReport,
  parseCheckAddonDirsArguments,
} from "./workbench/addon-dirs-diagnostic.js";
import { logger, setDebugEnabled } from "./utils/logger.js";

const SERVER_VERSION = "1.2.0";

function usage(): string {
  return [
    "Usage:",
    "  reforger-forge-mcp [configuration options]",
    "  reforger-forge-mcp discover-steam",
    "  reforger-forge-mcp check-addon-dirs --gproj <path>",
    "",
    "Steam installation paths are discovered automatically when not explicitly supplied.",
    "",
    CONFIGURATION_USAGE,
    "",
    "Other:",
    "  discover-steam                          Print Steam discovery as JSON and exit.",
    "  check-addon-dirs --gproj <path>         Report dependency GUID resolution by standard add-on root.",
    "  -h, --help                               Show this help.",
    "  --version                                Show the package version.",
    "",
  ].join("\n");
}

async function runServer(config: Config, hostIdentity: McpHostIdentity): Promise<void> {
  const server = new McpServer({
    name: "reforger-forge-mcp",
    version: SERVER_VERSION,
  });
  const disposeTools = registerTools(server, config, { hostIdentity });
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      process.stdin.off("end", onStdinEnd);
      process.stdin.off("close", onStdinClose);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      await runCliShutdown({
        reason,
        closeProtocol: () => server.close(),
        disposeTools: (deadlineAtMs) => disposeTools(deadlineAtMs),
        emergencyTerminate: disposeTools.emergencyTerminate,
        emergencyCleanup: disposeTools.emergencyCleanup,
        info: logger.info,
        warn: logger.warn,
        error: logger.error,
        exit: (code) => process.exit(code),
      });
    })();
    return shutdownPromise;
  };

  const requestShutdown = (reason: string): void => {
    void shutdown(reason).catch((error) => {
      process.exitCode = 1;
      logger.error(`MCP shutdown orchestration failed: ${error instanceof Error ? error.message : String(error)}`);
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
    logger.info(
      `MCP host started product=${hostIdentity.product} client=${hostIdentity.clientLabel} ` +
      `instanceId=${hostIdentity.instanceId} pid=${hostIdentity.pid}`
    );
  } catch (error) {
    await shutdown("startup failure").catch(() => undefined);
    throw error;
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const hostArguments = partitionMcpHostArguments(argv);
  const partitioned = partitionConfigurationArguments(hostArguments.remainingArguments);
  const rejectServerOnlyHostArguments = (): void => {
    if (hostArguments.explicitlySupplied) {
      throw new Error("--mcp-client-label is valid only when starting the MCP stdio server.");
    }
  };
  if (partitioned.remainingArguments.length === 1
      && partitioned.remainingArguments[0] === "discover-steam") {
    rejectServerOnlyHostArguments();
    if (partitioned.configurationArguments.length > 0) {
      throw new Error("discover-steam does not accept server configuration arguments.");
    }
    const result = discoverSteamInstallations();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = STEAM_DISCOVERY_EXIT_CODES[result.status];
    return;
  }
  if (partitioned.remainingArguments[0] === CHECK_ADDON_DIRS_COMMAND) {
    rejectServerOnlyHostArguments();
    if (partitioned.configurationArguments.length > 0) {
      throw new Error(`${CHECK_ADDON_DIRS_COMMAND} does not accept server configuration arguments.`);
    }
    const targetGprojPath = parseCheckAddonDirsArguments(
      partitioned.remainingArguments
    );
    process.stdout.write(`${formatCheckAddonDirsReport(checkAddonDirs(targetGprojPath))}\n`);
    return;
  }
  if (partitioned.remainingArguments.length === 1
      && ["-h", "--help"].includes(partitioned.remainingArguments[0])) {
    rejectServerOnlyHostArguments();
    process.stdout.write(usage());
    return;
  }
  if (partitioned.remainingArguments.length === 1
      && partitioned.remainingArguments[0] === "--version") {
    rejectServerOnlyHostArguments();
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
  const hostIdentity = createMcpHostIdentity({
    clientLabel: hostArguments.clientLabel,
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  process.title = formatMcpProcessTitle(hostIdentity);
  await runServer(config, hostIdentity);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = 1;
  logger.error(error instanceof Error ? error.message : String(error));
}
