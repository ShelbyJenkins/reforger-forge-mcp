import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, win32 } from "node:path";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";

const wbDiagnoseRawInputShape = {
  gprojPath: z.string().max(32_767).refine((value) => value.trim().length > 0, {
    message: "gprojPath must be nonblank",
  }).optional(),
  includeLaunchPlan: z.boolean().optional(),
};

export const wbDiagnoseRawInputSchema = z.object(wbDiagnoseRawInputShape).strict().superRefine(
  (value, context) => {
    if (value.includeLaunchPlan === true && value.gprojPath === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gprojPath"],
        message: "gprojPath is required when includeLaunchPlan is true",
      });
    }
    if (value.includeLaunchPlan !== true && value.gprojPath !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gprojPath"],
        message: "gprojPath is accepted only when includeLaunchPlan is true",
      });
    }
    if (value.includeLaunchPlan === true && value.gprojPath !== undefined &&
        !isAbsolute(value.gprojPath) && !win32.isAbsolute(value.gprojPath)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gprojPath"],
        message: "gprojPath must use an absolute caller spelling",
      });
    }
  }
);

function boundedPreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 512);
}

export function registerWbDiagnose(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_diagnose",
    {
      description:
        "Report Workbench configuration, managed companion identity, lifecycle ownership, and " +
        "NET API health without auto-launching Workbench.",
      inputSchema: wbDiagnoseRawInputShape,
    },
    async (input) => {
      const selected = wbDiagnoseRawInputSchema.parse(input);
      const report = await client.diagnose();
      const lines: string[] = ["## Reforger Forge Workbench Diagnostic\n"];

      lines.push("### MCP Host");
      lines.push(`- **Schema:** ${report.mcpHost.schemaVersion}`);
      lines.push(`- **Product:** ${report.mcpHost.product}`);
      lines.push(`- **Client:** ${report.mcpHost.clientLabel}`);
      lines.push(`- **Instance:** ${report.mcpHost.instanceId}`);
      lines.push(`- **PID:** ${report.mcpHost.pid}`);
      lines.push(`- **Started:** ${report.mcpHost.startedAt}`);

      lines.push("\n### MCP Lifecycle");
      lines.push(`- **Instance:** ${report.mcpLifecycle.instanceId}`);
      lines.push(`- **Mode:** ${report.mcpLifecycle.state}`);
      lines.push(`- **Idle shutdown:** ${report.mcpLifecycle.idleShutdownMs} ms`);
      lines.push(`- **Active request slots:** ${report.mcpLifecycle.activeRequestCount ?? "externally managed"}`);
      lines.push(`- **Last activity:** ${report.mcpLifecycle.lastActivityAt ?? "externally managed"}`);
      lines.push(`- **Eligible at:** ${report.mcpLifecycle.eligibleAt ?? "externally managed"}`);
      lines.push(`- **Readiness complete:** ${report.mcpLifecycle.readinessComplete ?? "not checked"}`);
      lines.push(`- **Blockers:** ${report.mcpLifecycle.blockerCodes.join(", ") || "none"}`);

      lines.push("\n### Configuration");
      lines.push(`- **NET API:** ${report.host}:${report.port}`);
      lines.push(report.workbenchExe
        ? `- **Workbench executable:** ${report.workbenchExe.exists ? "FOUND" : "NOT FOUND"} — \`${report.workbenchExe.path}\``
        : "- **Workbench executable:** config not loaded");
      lines.push("- **Project target:** exact gprojPath or the running lifecycle");

      lines.push("\n### Managed Workbench Companion");
      if (report.companionAddon) {
        lines.push(`- **Package source:** VERIFIED — \`${report.companionAddon.path}\``);
        lines.push(`- **Add-on:** ${report.companionAddon.addonId} (${report.companionAddon.addonGuid})`);
        lines.push(`- **Build identity:** \`${report.companionAddon.buildIdentity}\``);
        lines.push(`- **Bundle digest:** \`${report.companionAddon.bundleDigest}\``);
      } else {
        lines.push("- **Package source:** MISSING OR INVALID");
      }

      lines.push("\n### NET API Connection");
      switch (report.netApi) {
        case "up_with_companion":
          lines.push("- **Status:** CONNECTED — the managed companion responded.");
          break;
        case "up_no_companion":
          lines.push("- **Status:** PORT OPEN, MANAGED COMPANION NOT LOADED");
          lines.push("  - Close the unowned session, then use wb_launch to stage and load the exact helper.");
          break;
        case "refused":
          lines.push("- **Status:** CONNECTION REFUSED — Workbench is not running or NET API is disabled.");
          break;
        case "timeout":
          lines.push("- **Status:** TIMEOUT — check firewall and endpoint ownership.");
          break;
        case "error":
          lines.push("- **Status:** ERROR");
          break;
      }
      if (report.netApiError) lines.push(`- **Raw error:** \`${report.netApiError}\``);

      const lifecycle = report.lifecycle;
      lines.push("\n### Lifecycle State");
      lines.push(`- **Record:** ${lifecycle.state}${lifecycle.version ? ` (schema v${lifecycle.version})` : ""}`);
      lines.push(`- **Generation:** ${lifecycle.generation ?? "(none)"}`);
      lines.push(`- **Phase:** ${lifecycle.phase ?? "(none)"}`);
      lines.push(`- **Endpoint:** ${lifecycle.endpoint ?? "(none)"}`);
      lines.push(`- **Canonical target:** ${lifecycle.target ? `\`${lifecycle.target}\`` : "(none)"}`);
      lines.push(`- **MCP lease:** ${lifecycle.lease}`);
      lines.push(`- **Operation:** ${lifecycle.operation ?? "(none)"}`);
      lines.push(`- **Companion build:** ${lifecycle.companionBuildIdentity ?? "(none)"}`);
      if (lifecycle.detail) lines.push(`- **Detail:** ${lifecycle.detail}`);

      if (report.lastLaunchFailure) {
        lines.push("\n### Last Launch Compiler Failure");
        lines.push(`- **Classification:** ${report.lastLaunchFailure.code}`);
        lines.push(`- **Module:** ${report.lastLaunchFailure.module}`);
        for (const diagnostic of report.lastLaunchFailure.diagnostics) {
          lines.push(`- **Compiler diagnostic:** ${diagnostic}`);
        }
        lines.push(`- **Exact script log:** \`${report.lastLaunchFailure.logPath}\``);
      }

      const issues: string[] = [];
      if (!report.companionAddon) {
        issues.push("The packaged Workbench companion failed verification. Re-install reforger-forge-mcp.");
      }
      if (report.netApi === "up_no_companion") {
        issues.push(
          "NET API is reachable without the exact managed companion. Close that Workbench, then call wb_launch."
        );
      }
      if (issues.length > 0) {
        lines.push("\n### Issues Detected");
        for (const issue of issues) lines.push(`- ${issue}`);
      }

      if (selected.includeLaunchPlan === true) {
        lines.push("\n### Workbench Launch Preview");
        try {
          const result = client.workbenchLaunchPreview(selected.gprojPath!);
          if (result.status === "unavailable") {
            lines.push("- **Status:** UNAVAILABLE");
            lines.push(`- **Detail:** ${result.message}`);
          } else {
            lines.push("- **Status:** AVAILABLE — PRESENTATION ONLY");
            lines.push("- **Runnable:** false");
            lines.push(`- **Executable:** \`${result.preview.executablePath}\``);
            lines.push("- **Arguments (JSON, presentation only):**");
            lines.push("```json");
            lines.push(JSON.stringify(result.preview.argv, null, 2));
            lines.push("```");
          }
        } catch (error) {
          lines.push("- **Status:** ERROR");
          lines.push(`- **Detail:** ${boundedPreviewError(error)}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
