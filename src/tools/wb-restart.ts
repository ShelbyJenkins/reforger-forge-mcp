import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbRestart(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_restart",
    {
      description:
        "Safely restart only the Workbench process launched by this MCP server instance. " +
        "Retains the same .gproj, waits for the old NET API port to be released, and starts " +
        "a clean unattended session for script compilation. Refuses to terminate a " +
        "pre-existing or user-launched Workbench. Save intentional editor changes before use.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.restartOwnedWorkbench();
        const project = result.gprojPath ? `\nProject: ${result.gprojPath}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Workbench Restarted Safely** — Replaced MCP-owned process ` +
                `${result.previousPid} with ${result.pid}.${project}\n\n` +
                "A clean `-noThrow` startup compilation ran; inspect the Workbench log for failures. Assertions are logged instead of blocking on a modal dialog." +
                formatConnectionStatus(client),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
