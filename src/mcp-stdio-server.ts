import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config } from "./config.js";
import {
  ActivityTrackingTransport,
  McpProtocolActivity,
  TrackedMcpServer,
  type McpTurnScheduler,
} from "./mcp-activity-transport.js";
import {
  McpIdleShutdownController,
  externallyManagedMcpLifecycleDiagnostic,
  type McpIdleShutdownTimer,
} from "./mcp-idle-shutdown.js";
import {
  validateMcpHostIdentity,
  type McpHostIdentity,
} from "./mcp-host-identity.js";
import { runCliShutdown } from "./mcp-lifecycle.js";
import { registerTools } from "./server.js";

export const MCP_SERVER_VERSION = "1.2.0";

export interface McpStdioSignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface McpStdioLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface RunMcpStdioServerOptions {
  readonly config: Config;
  readonly hostIdentity: McpHostIdentity;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly signals: McpStdioSignalSource;
  readonly logger: McpStdioLogger;
  readonly nowTick?: () => number;
  readonly nowWall?: () => Date;
  readonly scheduleTurn?: McpTurnScheduler;
  readonly setTimer?: (callback: () => void, milliseconds: number) => McpIdleShutdownTimer;
  readonly clearTimer?: (handle: McpIdleShutdownTimer) => void;
  readonly exit: (code: number) => void;
  readonly setExitCode: (code: number) => void;
}

/** CLI stdio composition root. Embedded `registerTools` callers never enter here. */
export async function runMcpStdioServer(options: RunMcpStdioServerOptions): Promise<void> {
  validateMcpHostIdentity(options.hostIdentity);
  const activity = new McpProtocolActivity({
    nowTick: options.nowTick,
    nowWall: options.nowWall,
    scheduleTurn: options.scheduleTurn,
  });
  const server = new TrackedMcpServer({
    name: "reforger-forge-mcp",
    version: MCP_SERVER_VERSION,
  }, activity);
  let controller: McpIdleShutdownController | null = null;
  const lifecycleDiagnostic = () => controller?.diagnostic() ??
    externallyManagedMcpLifecycleDiagnostic(options.hostIdentity, options.config.mcpIdleShutdownMs);
  const disposeTools = registerTools(server, options.config, {
    hostIdentity: options.hostIdentity,
    mcpLifecycleDiagnostic: lifecycleDiagnostic,
  });
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    controller?.cancel(reason);
    if (shutdownPromise) return shutdownPromise;
    // Publish the coalescing promise before protocol close can synchronously
    // fire the transport's onclose callback and re-enter this function.
    shutdownPromise = Promise.resolve().then(async () => {
      options.stdin.off("end", onStdinEnd);
      options.stdin.off("close", onStdinClose);
      options.signals.off("SIGINT", onSigint);
      options.signals.off("SIGTERM", onSigterm);
      await runCliShutdown({
        reason,
        closeProtocol: () => server.close(),
        disposeTools: (deadlineAtMs) => disposeTools(deadlineAtMs),
        emergencyTerminate: disposeTools.emergencyTerminate,
        emergencyCleanup: disposeTools.emergencyCleanup,
        info: options.logger.info,
        warn: options.logger.warn,
        error: options.logger.error,
        clock: () => (options.nowWall?.() ?? new Date()).getTime(),
        setTimer: options.setTimer as typeof setTimeout | undefined,
        clearTimer: options.clearTimer as typeof clearTimeout | undefined,
        exit: options.exit,
      });
    });
    return shutdownPromise;
  };

  const requestShutdown = (reason: string): void => {
    void shutdown(reason).catch((error) => {
      options.setExitCode(1);
      options.logger.error(
        `MCP shutdown orchestration failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };
  function onStdinEnd(): void { requestShutdown("stdin EOF"); }
  function onStdinClose(): void { requestShutdown("stdin closed"); }
  function onSigint(): void { requestShutdown("SIGINT"); }
  function onSigterm(): void { requestShutdown("SIGTERM"); }

  const rawTransport = new StdioServerTransport(options.stdin, options.stdout);
  const transport = new ActivityTrackingTransport(
    rawTransport,
    activity,
    () => requestShutdown("transport closed"),
  );
  controller = new McpIdleShutdownController({
    hostIdentity: options.hostIdentity,
    idleShutdownMs: options.config.mcpIdleShutdownMs,
    activity,
    readiness: disposeTools,
    shutdown,
    nowTick: options.nowTick,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    info: options.logger.info,
    warn: options.logger.warn,
    debug: options.logger.debug,
  });

  options.stdin.once("end", onStdinEnd);
  options.stdin.once("close", onStdinClose);
  options.signals.once("SIGINT", onSigint);
  options.signals.once("SIGTERM", onSigterm);

  try {
    await server.connect(transport);
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }
    controller.start();
    options.logger.info(
      `MCP host started product=${options.hostIdentity.product} client=${options.hostIdentity.clientLabel} ` +
      `instanceId=${options.hostIdentity.instanceId} pid=${options.hostIdentity.pid}`
    );
  } catch (error) {
    await shutdown("startup failure").catch(() => undefined);
    throw error;
  }
}
