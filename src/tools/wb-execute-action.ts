import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export interface MenuActionSafety {
  blocked: boolean;
  reason?: "script-lifecycle" | "file-lifecycle" | "unsupported";
  normalized: string[];
}

export function classifyMenuAction(menuPath: string): MenuActionSafety {
  const normalized = menuPath
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.some((segment) =>
    segment.includes("compile") || segment.includes("reload") || segment.includes("validate"))) {
    return { blocked: true, reason: "script-lifecycle", normalized };
  }

  const root = normalized[0] ?? "";
  const modalOrDestructiveFileAction = normalized.slice(1).some((segment) =>
    segment === "save" || segment.startsWith("save ") ||
    segment === "open" || segment.startsWith("open ") ||
    segment === "close" || segment.startsWith("close ") ||
    segment === "new" || segment.startsWith("new ") ||
    segment === "exit" || segment.startsWith("exit ") ||
    segment === "quit" || segment.startsWith("quit "));
  if (root === "file" && modalOrDestructiveFileAction) {
    return { blocked: true, reason: "file-lifecycle", normalized };
  }
  // Arbitrary Workbench menu actions have no machine-readable modal contract.
  // A finite denylist cannot prove that Import, Options, plugin actions, or a
  // future menu item will not open a dialog, so unattended generic execution is
  // disabled. Dedicated wb_* tools expose the operations with known behavior.
  return { blocked: true, reason: "unsupported", normalized };
}

export function registerWbExecuteAction(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_execute_action",
    {
      description:
        "Generic Workbench menu execution is disabled for unattended safety because arbitrary actions have no nonmodal contract. Use dedicated wb_* tools.",
      inputSchema: {
        menuPath: z
          .string()
          .describe(
            "Comma-separated menu path (e.g., 'File,Save', 'Edit,Undo')"
          ),
      },
    },
    async ({ menuPath }) => {
      const safety = classifyMenuAction(menuPath);
      return {
        content: [{
          type: "text" as const,
          text: safety.reason === "script-lifecycle"
            ? `**Blocked:** "${menuPath}" can compile, validate, or reload scripts. Use wb_restart for clean owner-scoped compilation.${formatConnectionStatus(client)}`
            : safety.reason === "file-lifecycle"
              ? `**Blocked:** "${menuPath}" can close the editor, replace state, or open a modal file/save dialog. Perform it manually.${formatConnectionStatus(client)}`
              : `**Blocked:** arbitrary menu execution is disabled because Workbench does not guarantee that an action is nonmodal. Use a dedicated wb_* tool or perform it manually.${formatConnectionStatus(client)}`,
        }],
        isError: true,
      };
    }
  );
}
