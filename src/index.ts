#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CONFIGURATION_USAGE,
  loadConfig,
  partitionConfigurationArguments,
} from "./config.js";
import {
  createMcpHostIdentity,
  formatMcpProcessTitle,
  partitionMcpHostArguments,
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
import {
  MCP_SERVER_VERSION,
  runMcpStdioServer,
} from "./mcp-stdio-server.js";

const SERVER_VERSION = MCP_SERVER_VERSION;

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
  await runMcpStdioServer({
    config,
    hostIdentity,
    stdin: process.stdin,
    stdout: process.stdout,
    signals: process,
    logger,
    nowTick: () => performance.now(),
    nowWall: () => new Date(),
    scheduleTurn: (callback) => setImmediate(callback),
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    exit: (code) => process.exit(code),
    setExitCode: (code) => { process.exitCode = code; },
  });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.exitCode = 1;
  logger.error(error instanceof Error ? error.message : String(error));
}
