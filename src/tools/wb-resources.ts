import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { isPathContained } from "../foundation/managed-path.js";
import { canonicalizeGproj } from "../workbench/project-identity.js";
import { formatConnectionStatus, requireResourceManagerMode } from "../workbench/status.js";

const RESOURCE_MUTATION_TIMEOUT_MS = 120_000;

function throwIfResourceHelperFailed(result: Record<string, unknown>, action: string): void {
  if (result.status !== "error") return;

  const message = typeof result.message === "string" && result.message.trim()
    ? result.message
    : `Workbench resource ${action} failed.`;
  throw new Error(message);
}

async function validateRegistrationPath(
  client: WorkbenchClient,
  resourcePath: string
): Promise<string> {
  if (!isAbsolute(resourcePath)) {
    throw new Error(
      "wb_resources register requires an absolute filesystem path inside the active Workbench project."
    );
  }

  const activeGprojPath = await client.activeProjectGprojPath();
  if (!activeGprojPath) {
    throw new Error(
      "wb_resources register requires an already-running Workbench with an exact active project."
    );
  }
  const project = canonicalizeGproj(activeGprojPath);

  let canonicalResourcePath: string;
  try {
    canonicalResourcePath = realpathSync.native(resourcePath);
  } catch {
    throw new Error(`wb_resources register path does not exist or cannot be resolved: ${resourcePath}`);
  }
  if (!statSync(canonicalResourcePath).isFile()) {
    throw new Error(`wb_resources register path is not a regular file: ${canonicalResourcePath}`);
  }
  if (!isPathContained(project.modDirectory, canonicalResourcePath)) {
    throw new Error(
      `wb_resources register path is outside the active Workbench project: ${canonicalResourcePath}`
    );
  }
  return canonicalResourcePath;
}

export function registerWbResources(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_resources",
    {
      description:
        "Manage Workbench resources. Register new resources, rebuild resource databases, get resource info, or open a resource in its editor. Registration requires an absolute existing file contained by the exact active Workbench project.",
      inputSchema: {
        action: z
          .enum(["register", "rebuild", "getInfo", "open"])
          .describe(
            "Action: register (add resource to DB), rebuild (regenerate resource DB), getInfo (resource metadata), or open (open in editor)"
          ),
        path: z
          .string()
          .describe(
            "Resource path. Required for all actions. For register, pass the absolute filesystem path inside the addon loaded by Workbench."
          ),
        buildRuntime: z
          .boolean()
          .optional()
          .describe("Build runtime data during register/rebuild (slower but ensures assets are ready)"),
      },
    },
    async ({ action, path, buildRuntime }) => {
      try {
        // ResourceManager mutations are document-independent but still refuse
        // a freshly confirmed Play mode.
        if (action === "register" || action === "rebuild") {
          const modeErr = await requireResourceManagerMode(client, `${action} resource`);
          if (modeErr) {
            return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }] };
          }
        }

        if (action === "getInfo") {
          // Use built-in GetResourceInfo handler
          const result = await client.call<Record<string, unknown>>("GetResourceInfo", {
            path,
          });

          const lines = [`**Resource Info**\n`];
          lines.push(`- **Path:** ${path}`);
          if (result.guid) lines.push(`- **GUID:** ${result.guid}`);
          if (result.type) lines.push(`- **Type:** ${result.type}`);
          if (result.size !== undefined) lines.push(`- **Size:** ${result.size}`);
          if (result.lastModified) lines.push(`- **Modified:** ${result.lastModified}`);
          if (result.dependencies && Array.isArray(result.dependencies)) {
            lines.push(`\n### Dependencies (${result.dependencies.length})`);
            for (const dep of result.dependencies) {
              lines.push(`- ${dep}`);
            }
          }

          // Fallback for unknown response shapes
          const knownKeys = new Set(["guid", "type", "size", "lastModified", "dependencies", "path"]);
          for (const [key, val] of Object.entries(result)) {
            if (!knownKeys.has(key) && val !== undefined) {
              lines.push(`- **${key}:** ${typeof val === "object" ? JSON.stringify(val) : val}`);
            }
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        const helperPath = action === "register"
          ? await validateRegistrationPath(client, path)
          : path;

        // register, rebuild, open all use EMCP_WB_Resources
        const params: Record<string, unknown> = { action, path: helperPath };
        if (buildRuntime !== undefined) params.buildRuntime = buildRuntime;

        const result = await client.call<Record<string, unknown>>(
          "EMCP_WB_Resources",
          params,
          action === "register" || action === "rebuild"
            ? { timeout: RESOURCE_MUTATION_TIMEOUT_MS, skipAutoLaunch: true }
            : undefined
        );
        throwIfResourceHelperFailed(result, action);

        const actionLabels: Record<string, string> = {
          register: `Registered resource: ${helperPath}`,
          rebuild: `Rebuilt resource database for: ${path}`,
          open: `Opened resource: ${path}`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `**${actionLabels[action]}**${result.message ? `\n\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error managing resource "${path}" (${action}): ${msg}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
