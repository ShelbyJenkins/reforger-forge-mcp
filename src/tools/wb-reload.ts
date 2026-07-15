import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function isInProcessScriptReload(target: "scripts" | "plugins" | "both"): boolean {
  return target === "scripts" || target === "both";
}

export function registerWbReload(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Reload Workbench plugins. In-process game-script reload is always refused; use wb_restart for a clean, owner-scoped compilation session.",
      inputSchema: {
        target: z
          .enum(["scripts", "plugins", "both"])
          .default("scripts")
          .describe("What to reload: scripts, plugins, or both"),
      },
    },
    async ({ target }) => {
      try {
        if (isInProcessScriptReload(target)) {
          return {
            content: [{
              type: "text" as const,
              text:
                "Script reload is disabled for unattended automation in every editor state. " +
                "Use wb_restart, which compiles in a clean, verified MCP-owned -noThrow process." +
                formatConnectionStatus(client),
            }],
            isError: true,
          };
        }
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
