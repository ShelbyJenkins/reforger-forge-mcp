import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../workbench/client.js";

export function registerWbDiagnose(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_diagnose",
    {
      description:
        "Report Workbench configuration, managed companion identity, lifecycle ownership, and " +
        "NET API health without auto-launching Workbench.",
      inputSchema: {},
    },
    async () => {
      const report = await client.diagnose();
      const lines: string[] = ["## Reforger Forge Workbench Diagnostic\n"];

      lines.push("### Configuration");
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

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
