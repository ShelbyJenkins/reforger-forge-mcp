import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbReload(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Reload Workbench plugins. Use wb_restart for a clean, owner-scoped game-script compilation session.",
      inputSchema: {
        target: z
          .enum(["plugins"])
          .default("plugins")
          .describe("Reload Workbench plugins"),
      },
    },
    async ({ target }) => {
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target });
        if (result.status === "error") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Reload refused: ${result.message || "unsafe live-world reload"} Use wb_restart to compile scripts in a clean MCP-owned session.${formatConnectionStatus(client)}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `**Reload Complete**\n\n${result.message || "Reload triggered."}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error reloading: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}
