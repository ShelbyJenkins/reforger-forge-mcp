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
        "Launch or reuse the exact canonical .gproj in an automated Windows Workbench session. " +
        "Lifecycle operations are serialized by a machine-wide mutex and an exact MCP-owner lease. " +
        "A different target, live second MCP owner, user-launched Workbench, occupied endpoint, or " +
        "unverifiable process is refused before handler files change. The managed handler bundle is " +
        "transactional and Workbench is started with -noThrow. Use wb_shutdown before wb_cleanup.",
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
        // The mutable default is updated only after an exact launch/reuse succeeds.
        config.defaultMod = basename(dirname(result.gprojPath));
        const label = result.action === "launched" ? "Workbench Ready" : "Workbench Already Running";
        return {
          content: [{
            type: "text" as const,
            text:
              `**${label}** — ${result.action === "launched" ? "launched" : "reused"} exact owned ` +
              `PID ${result.pid}.\n\nProject: \`${result.gprojPath}\`\n` +
              `Lifecycle generation: \`${result.generation}\`\n\n` +
              "When finished, call **wb_shutdown** first, then **wb_cleanup** for this mod." +
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

  server.registerTool(
    "wb_cleanup",
    {
      description:
        "Remove only hash-matching, manifest-owned Workbench handler files after exact shutdown. " +
        "Cleanup is a serialized lifecycle operation and is refused while any matching, externally " +
        "owned, or unverifiable Workbench may be watching the mod. Modified and unrelated files are preserved.",
      inputSchema: {
        modDir: z.string().describe("Canonicalizable mod root containing exactly one direct .gproj file."),
      },
    },
    async ({ modDir }) => {
      try {
        const result = await client.cleanupHandlerScripts(modDir);
        if (result.kind === "not_installed") {
          return {
            content: [{
              type: "text" as const,
              text: `**No Cleanup Needed** — no managed handler bundle is installed at ` +
                `\`${result.handlerDirectory}\`.${formatConnectionStatus(client)}`,
            }],
          };
        }
        if (result.kind === "modified_files") {
          return {
            content: [{
              type: "text" as const,
              text:
                "**Cleanup Needs Manual Review** — exact managed files were removed, but modified files " +
                `were preserved:\n${result.modified.map((file) => `- \`${file}\``).join("\n")}\n\n` +
                `Unrelated files were also preserved (${result.unrelated.length}).` +
                formatConnectionStatus(client),
            }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text" as const,
            text:
              `**Cleanup Complete** — removed ${result.removed.length} manifest-owned handler file(s). ` +
              `${result.unrelated.length} unrelated file(s) were preserved.` +
              formatConnectionStatus(client),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `**Cleanup Refused**\n\n${errorText(error)}${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
