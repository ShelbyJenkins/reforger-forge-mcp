import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkbenchError, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

function errorText(error: unknown): string {
  if (error instanceof WorkbenchError) return `\`${error.code}\` — ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function registerWbLaunch(
  server: McpServer,
  client: WorkbenchClient
): void {
  server.registerTool(
    "wb_launch",
    {
      description:
        "Launch or reuse the exact canonical .gproj in an owner-scoped Windows Workbench session. Fresh launches " +
        "open a normal, focusable attended editor window. Supply both " +
        "gprojPath and resourcePath to create a fresh target-bound World Editor session for one .ent world or .et prefab; that form " +
        "is required before wb_save_resource. " +
        "The MCP stages its private helper outside the project, loads it with a dedicated profile, " +
        "and verifies the exact helper build identity before reporting readiness. Lifecycle operations " +
        "are serialized by a machine-wide mutex and exact process ownership.",
      inputSchema: {
        gprojPath: z.string().optional().describe(
          "Path to the exact .gproj to open. If omitted, a previously verified target or exactly one " +
          "configured project must be available; ambiguous fallback is refused."
        ),
        resourcePath: z.string().optional().describe(
          "Optional existing .ent world or .et prefab to supply to Workbench at startup with -load. Requires gprojPath; " +
          "wb_save_resource may save only this exact startup target."
        ),
      },
    },
    async ({ gprojPath, resourcePath }) => {
      try {
        if (resourcePath !== undefined && gprojPath === undefined) {
          throw new WorkbenchError(
            "A target-bound Workbench launch requires both gprojPath and resourcePath.",
            "TARGET_REQUIRED"
          );
        }
        const result = resourcePath === undefined
          ? await client.ensureRunning(gprojPath)
          : await client.ensureTargetResourceRunning(gprojPath!, resourcePath);
        const label = result.action === "launched"
          ? "Workbench Ready"
          : "Workbench Already Running";
        const resourceDetails = "resourcePath" in result && typeof result.resourcePath === "string"
          ? `Resource target: \`${result.resourcePath}\`\n\n` +
            "This session refuses wb_open_resource. Call wb_save_resource with this exact path when its edits are ready to commit."
          : "The managed helper and all of its temporary files remain outside the project. Call **wb_shutdown** when finished.";
        return {
          content: [{
            type: "text" as const,
            text:
              `**${label}** — ${result.action === "launched" ? "launched" : "reused"} exact owned ` +
              `PID ${result.pid}.\n\nProject: \`${result.gprojPath}\`\n` +
              `Lifecycle generation: \`${result.generation}\`\n\n` +
              resourceDetails +
              formatConnectionStatus(client),
          }],
        };
      } catch (error) {
        const heading = error instanceof WorkbenchError && error.code === "PROJECT_COMPILE_FAILED"
          ? "Project Compilation Failed"
          : "Launch Refused";
        return {
          content: [{
            type: "text" as const,
            text: `**${heading}**\n\n${errorText(error)}${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
