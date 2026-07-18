import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename, dirname } from "node:path";
import type { Config } from "../config.js";
import { WorkbenchError, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

function errorText(error: unknown): string {
  if (error instanceof WorkbenchError) return `\`${error.code}\` — ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function registerWbLaunch(
  server: McpServer,
  config: Config,
  client: WorkbenchClient
): void {
  server.registerTool(
    "wb_launch",
    {
      description:
        "Launch or reuse the exact canonical .gproj in an owner-scoped Windows Workbench session. " +
        "The MCP stages its private helper outside the project, loads it with a dedicated profile, " +
        "and verifies the exact helper build identity before reporting readiness. Lifecycle operations " +
        "are serialized by a machine-wide mutex and exact process ownership.",
      inputSchema: {
        gprojPath: z.string().optional().describe(
          "Path to the exact .gproj to open. If omitted, a previously verified target or exactly one " +
          "configured project must be available; ambiguous fallback is refused."
        ),
      },
    },
    async ({ gprojPath }) => {
      try {
        const result = await client.ensureRunning(gprojPath);
        config.defaultMod = basename(dirname(result.gprojPath));
        const label = result.action === "launched"
          ? "Workbench Ready"
          : "Workbench Already Running";
        return {
          content: [{
            type: "text" as const,
            text:
              `**${label}** — ${result.action === "launched" ? "launched" : "reused"} exact owned ` +
              `PID ${result.pid}.\n\nProject: \`${result.gprojPath}\`\n` +
              `Lifecycle generation: \`${result.generation}\`\n\n` +
              "The managed helper and all of its temporary files remain outside the project. " +
              "Call **wb_shutdown** when finished." +
              formatConnectionStatus(client),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `**Launch Refused**\n\n${errorText(error)}${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
