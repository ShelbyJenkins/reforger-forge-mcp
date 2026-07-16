import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchError, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbShutdown(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_shutdown",
    {
      description:
        "Stop only the exact Workbench process recorded by the version-2 lifecycle state. " +
        "The MCP owner lease, canonical project, executable path, exact creation time, command-line " +
        "owner token, endpoint, and Windows user must verify before termination through the retained " +
        "OS process handle. User-launched and unverifiable Workbench processes are never signalled. " +
        "Call this before wb_cleanup.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.shutdownOwnedWorkbench();
        if (!result.stopped) {
          return {
            content: [{
              type: "text" as const,
              text:
                `**Workbench Already Stopped** — no exact owned process was running.\n\n` +
                `Project: ${result.gprojPath ? `\`${result.gprojPath}\`` : "(none)"}\n` +
                `Lifecycle generation: \`${result.generation}\`` +
                formatConnectionStatus(client),
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text:
              `**Workbench Shut Down Safely** — exact owned PID ${result.previousPid} exited and the ` +
              `NET API endpoint was released.\n\nProject: \`${result.gprojPath ?? "unknown"}\`\n` +
              `Lifecycle generation: \`${result.generation}\`\n\n` +
              "It is now safe to call **wb_cleanup**." +
              formatConnectionStatus(client),
          }],
        };
      } catch (error) {
        const message = error instanceof WorkbenchError
          ? `\`${error.code}\` — ${error.message}`
          : error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text" as const,
            text: `**Shutdown Refused**\n\n${message}${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
