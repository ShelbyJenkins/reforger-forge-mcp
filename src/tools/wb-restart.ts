import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatWorkbenchRefusal } from "../workbench/refusal-remedy.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbRestart(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_restart",
    {
      description:
        "Restart only the exact Workbench bound to the lifecycle record's canonical .gproj. " +
        "The replacement opens as a normal, focusable attended editor window. " +
        "A replacement MCP may claim the lease only after the prior MCP's exact process identity is " +
        "proven dead. Complete replacement preflight runs before the healthy process is stopped; " +
        "termination uses the retained verified OS handle. Different-target, user-launched, live-other-MCP, " +
        "and unverifiable processes are refused. Save intentional editor changes before use.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.restartOwnedWorkbench();
        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Workbench Restarted Safely** — Replaced MCP-owned process ` +
                `${result.previousPid} with ${result.pid}.\nProject: \`${result.gprojPath}\`\n` +
                `Lifecycle generation: \`${result.generation}\`\n\n` +
                "A clean `-noThrow` startup compilation ran; inspect the Workbench log for failures. Assertions are logged instead of blocking on a modal dialog." +
                formatConnectionStatus(client),
            },
          ],
        };
      } catch (error) {
        const message = formatWorkbenchRefusal(error, { operation: "wb_restart" });
        return {
          content: [
            {
              type: "text" as const,
              text: `**Restart Refused**\n\n${message}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
