import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, requirePlayMode } from "../workbench/status.js";

export function registerWbEditorTools(server: McpServer, client: WorkbenchClient): void {
  // wb_play — Switch to game mode (Play in Editor)
  server.registerTool(
    "wb_play",
    {
      description:
        "Report that in-editor Play is disabled for unattended automation because it can compile scripts in a live editor process.",
      inputSchema: {
        debugMode: z
          .boolean()
          .optional()
          .describe("Enable debug mode (script breakpoints, extra logging)"),
        fullScreen: z
          .boolean()
          .optional()
          .describe("Launch in full-screen mode instead of windowed"),
      },
    },
    async () => {
      return {
        content: [{
          type: "text" as const,
          text:
            "**Play Refused** — in-editor Play can compile scripts in a live Workbench process. " +
            "Use a standalone diagnostic/autotest runtime launcher instead." +
            formatConnectionStatus(client),
        }],
        isError: true,
      };
    }
  );

  // wb_stop — Switch to edit mode
  server.registerTool(
    "wb_stop",
    {
      description:
        "Stop game mode and return to the World Editor. Equivalent to pressing Stop in the World Editor. Requires play mode.",
      inputSchema: {},
    },
    async () => {
      const modeErr = requirePlayMode(client, "stop play mode");
      if (modeErr) {
        return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }] };
      }
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action: "stop",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `**Edit Mode Restored**\n\nWorkbench has returned to edit mode.${result.message ? `\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error stopping play mode: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_save — Save the current world
  server.registerTool(
    "wb_save",
    {
      description:
        "Report that unattended save is disabled because Workbench may open a modal dialog. Save manually before restart.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("File path for Save As. Omit to save to the current file."),
      },
    },
    async ({ path }) => {
      return {
        content: [{
          type: "text" as const,
          text:
            `**Save Refused** — unattended save${path ? "-as" : ""} is disabled because Workbench may open a modal dialog. ` +
            `Save intentional editor changes manually before owner-scoped restart.` +
            formatConnectionStatus(client),
        }],
        isError: true,
      };
    }
  );

  // wb_undo_redo — Undo or redo
  server.registerTool(
    "wb_undo_redo",
    {
      description: "Undo or redo the last action in the World Editor.",
      inputSchema: {
        action: z
          .enum(["undo", "redo"])
          .describe("Whether to undo or redo"),
      },
    },
    async ({ action }) => {
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action,
        });

        const label = action === "undo" ? "Undo" : "Redo";
        return {
          content: [
            {
              type: "text" as const,
              text: `**${label} Complete**${result.message ? `\n\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error performing ${action}: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_open_resource — Open a resource in Workbench
  server.registerTool(
    "wb_open_resource",
    {
      description:
        "Open a resource file in the appropriate Workbench editor (e.g., a .et prefab in the Prefab Editor, a .c script in the Script Editor).",
      inputSchema: {
        path: z
          .string()
          .describe("Resource path to open (e.g., 'Prefabs/Weapons/AK47.et', 'Scripts/Game/MyScript.c')"),
      },
    },
    async ({ path }) => {
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action: "openResource",
          path,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `**Resource Opened**\n\nOpened: ${path}${result.message ? `\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error opening resource: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}
