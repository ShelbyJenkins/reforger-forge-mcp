import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, getAuthoritativeWorkbenchMode } from "../workbench/status.js";

function throwIfEditorHelperFailed(result: Record<string, unknown>, action: string): void {
  if (result.status !== "error") return;

  const message = typeof result.message === "string" && result.message.trim()
    ? result.message
    : `Workbench editor ${action} failed.`;
  throw new Error(message);
}

export function registerWbEditorTools(server: McpServer, client: WorkbenchClient): void {
  // wb_stop — Switch to edit mode
  server.registerTool(
    "wb_stop",
    {
      description:
        "Stop game mode and return to the World Editor. Equivalent to pressing Stop in the World Editor. " +
        "Returns an idempotent success when Workbench is already in edit mode.",
      inputSchema: {},
    },
    async () => {
      // The cached edit state can become stale if a person enters Play between
      // MCP calls. Every successful stop response must begin with this fresh
      // helper-state observation.
      const initialState = await getAuthoritativeWorkbenchMode(client);
      if (initialState.mode === "edit") {
        return {
          content: [{
            type: "text" as const,
            text: `**Already Stopped** — Workbench is already in edit mode.${formatConnectionStatus(client)}`,
          }],
        };
      }

      if (initialState.mode !== "play") {
        return {
          content: [{
            type: "text" as const,
            text: "Cannot stop play mode: Workbench mode is unknown. Call `wb_state` first to confirm play mode." + formatConnectionStatus(client),
          }],
          isError: true,
        };
      }
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action: "stop",
        });

        // SwitchToEditMode() acknowledging the command is not proof that
        // Workbench actually left game mode. Refresh from the authoritative
        // state handler before telling a caller that edit-only operations are
        // safe to perform.
        const state = await getAuthoritativeWorkbenchMode(client);
        if (state.mode !== "edit") {
          const stateMessage = state.message
            ? `\n${state.message}`
            : "";
          return {
            content: [{
              type: "text" as const,
              text: `**Edit Mode Not Confirmed**\n\nWorkbench acknowledged the stop request, but its post-command state is \`${state.reportedMode}\`. Edit-only operations remain blocked.${stateMessage}${formatConnectionStatus(client)}`,
            }],
            isError: true,
          };
        }

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
        throwIfEditorHelperFailed(result, "open resource");

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
