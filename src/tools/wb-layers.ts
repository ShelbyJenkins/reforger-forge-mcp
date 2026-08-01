import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, requireEditMode } from "../workbench/status.js";

const MUTATING_LAYER_ACTIONS = new Set(["toggleLock"]);

function throwIfLayerHelperFailed(result: Record<string, unknown>, action: string): void {
  if (result.status === "ok") return;
  const message = typeof result.message === "string" && result.message.trim()
    ? result.message
    : `Workbench layer ${action} failed.`;
  throw new Error(message);
}

export function registerWbLayers(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_layers",
    {
      description:
        "Inspect World Editor layer IDs, find an entity's layer, query layer visibility or info, and toggle a layer lock. toggleLock works only in edit mode. Create, delete, rename, active-layer, and visibility mutations are not advertised because the staged helper does not implement them.",
      inputSchema: {
        action: z
          .enum([
            "list",
            "getActive",
            "getEntityLayer",
            "isVisible",
            "getInfo",
            "toggleLock",
          ])
          .describe("Layer management action to perform"),
        subScene: z
          .number()
          .default(0)
          .describe("SubScene index (default 0, the main scene)"),
        layerPath: z
          .string()
          .optional()
          .describe("Numeric layer ID as a string, required for isVisible, getInfo, and toggleLock."),
        entityName: z
          .string()
          .optional()
          .describe("Entity name, required for getEntityLayer."),
      },
    },
    async ({ action, subScene, layerPath, entityName }) => {
      if (MUTATING_LAYER_ACTIONS.has(action)) {
        const modeErr = await requireEditMode(client, `${action} layer`);
        if (modeErr) {
          return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }] };
        }
      }
      try {
        const params: Record<string, unknown> = { action, subScene };
        if (layerPath) params.layerPath = layerPath;
        if (entityName) params.entityName = entityName;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_Layers", params);
        throwIfLayerHelperFailed(result, action);

        if (action === "list") {
          const layers = Array.isArray(result.layers) ? result.layers : [];
          if (layers.length === 0) {
            return {
              content: [{ type: "text" as const, text: `**No layers found.**${formatConnectionStatus(client)}` }],
            };
          }

          const lines = [`**Layers** (SubScene ${subScene})\n`];
          for (const layer of layers) {
            const l = layer as Record<string, unknown>;
            const path = l.path || l.name ||
              (l.layerID !== undefined ? `Layer ${l.layerID}` : "(unnamed)");
            const flags: string[] = [];
            if (l.active) flags.push("ACTIVE");
            if (l.locked) flags.push("LOCKED");
            if (l.visible === false) flags.push("HIDDEN");
            const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
            const entityCount = l.entityCount !== undefined ? ` (${l.entityCount} entities)` : "";
            lines.push(`- ${path}${flagStr}${entityCount}`);
          }

          if (result.activeLayer) {
            lines.push(`\nActive layer: **${result.activeLayer}**`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        if (action === "isVisible" || action === "getInfo" || action === "getEntityLayer" || action === "getActive") {
          const lines = [`**Layer ${layerPath || result.layerID}**\n`];
          if (result.layerVisible !== undefined) lines.push(`- **Visible:** ${result.layerVisible}`);
          if (result.layerLocked !== undefined) lines.push(`- **Locked:** ${result.layerLocked}`);
          if (result.layerActive !== undefined) lines.push(`- **Active:** ${result.layerActive}`);
          if (result.layerEntityCount !== undefined) lines.push(`- **Entities:** ${result.layerEntityCount}`);
          if (result.layerID !== undefined) lines.push(`- **Layer ID:** ${result.layerID}`);
          if (result.currentSubScene !== undefined) lines.push(`- **Current SubScene:** ${result.currentSubScene}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        if (action === "toggleLock") {
          const nowLocked = result.layerLocked;
          return {
            content: [{
              type: "text" as const,
              text: `**Layer Lock Toggled**\n\nLayer "${layerPath}" is now ${nowLocked ? "locked" : "unlocked"}${formatConnectionStatus(client)}`,
            }],
          };
        }

        const actionLabels: Record<string, string> = {
          getActive: "Read active layer",
          getEntityLayer: `Read layer for entity "${entityName}"`,
          isVisible: `Queried visibility of layer "${layerPath}"`,
          getInfo: `Got info for layer "${layerPath}"`,
          toggleLock: `Toggled lock on layer "${layerPath}"`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `**Layer Updated**\n\n${actionLabels[action] || action}${result.message ? `\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text" as const, text: `Error managing layers (${action}): ${msg}${formatConnectionStatus(client)}` },
          ],
          isError: true,
        };
      }
    }
  );
}
