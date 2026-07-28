import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { WorkbenchError, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

function errorText(error: unknown): string {
  if (error instanceof WorkbenchError) return `\`${error.code}\` â€” ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Save only a .ent or .et resource that was supplied when this MCP launched its fresh,
 * target-bound Workbench. The tool cannot save an arbitrary existing editor.
 */
export function registerWbSaveResource(
  server: McpServer,
  _config: Config,
  client: WorkbenchClient
): void {
  server.registerTool(
    "wb_save_resource",
    {
      description:
        "Commit one explicit .ent world or .et prefab in a fresh target-bound MCP Workbench session. First call wb_launch with both " +
        "gprojPath and resourcePath, make the target-bound edits, then pass the same resourcePath here. The tool " +
        "refuses generic Workbench sessions, mismatched paths, and programmatic document switches.",
      inputSchema: {
        confirm: z.literal("save").describe("Required acknowledgement that this writes the explicit target resource"),
        resourcePath: z.string().optional().describe(
          "The exact .ent or .et path supplied to wb_launch. It must match the target-bound session."
        ),
        expectedPath: z.string().optional().describe(
          "Deprecated compatibility spelling for resourcePath; use resourcePath in new calls."
        ),
      },
    },
    async ({ resourcePath, expectedPath }) => {
      const target = resourcePath ?? expectedPath;
      if (!target) {
        const error = new WorkbenchError(
            "resourcePath is required and must equal the .ent or .et supplied to the target-bound wb_launch call.",
          "TARGET_SESSION_REQUIRED"
        );
        return {
          content: [{
            type: "text" as const,
            text: `**Explicit Save Refused**\n\n${errorText(error)}${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
      try {
        const result = await client.saveResource(target);
        const changed = result.outcome === "changed"
          ? `Changed files:\n${result.changedPaths.map((path) => `- \`${path}\``).join("\n")}`
          : "Workbench completed the save request; the target bundle was already byte-identical.";
        return {
          content: [{
            type: "text" as const,
            text:
              `**Explicit Resource Save Complete**\n\nTarget: \`${result.resourcePath}\`\n` +
              `Outcome: \`${result.outcome}\`\n\n${changed}${formatConnectionStatus(client)}`,
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: `**Explicit Save Refused**\n\n${errorText(error)}${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
