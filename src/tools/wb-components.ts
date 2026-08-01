import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, requireEditMode } from "../workbench/status.js";

export function registerWbComponent(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_component",
    {
      description:
        "Manage components on a named entity or an unnamed entity selected by editor index in the World Editor. Add, remove, or list components attached to an entity. Add/remove only work in edit mode.",
      inputSchema: {
        entityName: z.string().optional().describe("Name of the target entity; omit when using entityIndex"),
        entityIndex: z.number().int().min(0).optional().describe(
          "Editor entity index for an unnamed target, such as index 1 for the generated root in Prefab Edit Mode"
        ),
        action: z
          .enum(["add", "remove", "list"])
          .describe("Action to perform: add a new component, remove an existing one, or list all components"),
        componentClass: z
          .string()
          .optional()
          .describe("Component class name (required for add/remove, e.g., 'RigidBody', 'MeshObject')"),
        componentIndex: z
          .number()
          .optional()
          .describe("Component index for removal when multiple components of the same class exist"),
      },
    },
    async ({ entityName, entityIndex, action, componentClass, componentIndex }) => {
      if (action === "add" || action === "remove") {
        const modeErr = await requireEditMode(client, `${action} component`);
        if (modeErr) {
          return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }] };
        }
      }
      try {
        const normalizedName = entityName?.trim();
        if (!normalizedName && entityIndex === undefined) {
          return {
            content: [{ type: "text" as const, text: "Error: `entityName` or `entityIndex` is required." }],
            isError: true,
          };
        }
        const targetLabel = normalizedName || `editor entity #${entityIndex}`;
        if ((action === "add" || action === "remove") && !componentClass) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: \`componentClass\` is required for the "${action}" action.`,
              },
            ],
            isError: true,
          };
        }

        const params: Record<string, unknown> = { action };
        if (normalizedName) params.entityName = normalizedName;
        if (entityIndex !== undefined) params.entityIndex = entityIndex;
        if (componentClass) params.componentClass = componentClass;
        if (componentIndex !== undefined) params.componentIndex = componentIndex;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_Components", params);
        if (result.status !== "ok") {
          const message = typeof result.message === "string" && result.message.trim()
            ? result.message
            : `Workbench could not ${action} component(s) on "${targetLabel}".`;
          return {
            content: [{
              type: "text" as const,
              text: `Error managing component on "${targetLabel}": ${message}${formatConnectionStatus(client)}`,
            }],
            isError: true,
          };
        }

        if (action === "list") {
          const components = Array.isArray(result.components) ? result.components : [];
          if (components.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `**${targetLabel}** has no components.${formatConnectionStatus(client)}`,
                },
              ],
            };
          }

          const lines = [`**Components on ${targetLabel}** (${components.length})\n`];
          for (let i = 0; i < components.length; i++) {
            const comp = components[i] as Record<string, unknown>;
            const className = comp.className || comp.type || "Unknown";
            const props = comp.propertyCount ? ` (${comp.propertyCount} properties)` : "";
            lines.push(`${i}. **${className}**${props}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        const actionLabel = action === "add" ? "Added" : "Removed";
        return {
          content: [
            {
              type: "text" as const,
              text: `**Component ${actionLabel}**\n\n- **Entity:** ${targetLabel}\n- **Component:** ${componentClass}${result.message ? `\n- **Note:** ${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error managing component on "${entityName}": ${msg}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
