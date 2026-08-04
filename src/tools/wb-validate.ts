import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

type ValidationReceipt = {
  action: "material" | "texture";
  resourceName: string;
  absolutePath: string;
  reports: string[];
  severity: number[];
  valid: boolean;
  clean: boolean;
};

function workbenchBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return undefined;
}

function receiptFrom(result: Record<string, unknown>, action: "material" | "texture"): ValidationReceipt {
  if (result.status !== "ok") {
    const message = typeof result.message === "string" ? result.message : JSON.stringify(result);
    throw new Error(`Workbench validation refused: ${message}`);
  }
  if (result.action !== action) throw new Error("Workbench validation response action did not match the request.");
  if (typeof result.resourceName !== "string" || result.resourceName.length === 0) {
    throw new Error("Workbench validation response omitted its registered resource identity.");
  }
  if (typeof result.absolutePath !== "string" || result.absolutePath.length === 0) {
    throw new Error("Workbench validation response omitted its source or virtual resource path.");
  }
  if (!Array.isArray(result.reports) || !result.reports.every((entry) => typeof entry === "string")) {
    throw new Error("Workbench validation response has malformed reports.");
  }
  if (!Array.isArray(result.severity) || !result.severity.every((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 3)) {
    throw new Error("Workbench validation response has malformed severities.");
  }
  if (result.reports.length !== result.severity.length) {
    throw new Error("Workbench validation response has mismatched report and severity counts.");
  }
  const valid = !result.severity.includes(3);
  const clean = result.reports.length === 0;
  const returnedValid = workbenchBoolean(result.valid);
  const returnedClean = workbenchBoolean(result.clean);
  if (returnedValid === undefined || returnedValid !== valid ||
      returnedClean === undefined || returnedClean !== clean) {
    throw new Error("Workbench validation response has inconsistent validity flags.");
  }
  return {
    action,
    resourceName: result.resourceName,
    absolutePath: result.absolutePath,
    reports: result.reports,
    severity: result.severity,
    valid,
    clean,
  };
}

export function registerWbValidate(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_validate",
    {
      description:
        "Validate one registered material or texture resource through a path-bound Workbench helper. Material checks cover parameters, resolvable texture GUIDs, and slot/suffix compatibility without requiring loose source metadata for packed dependencies; texture checks cover registered source import metadata. Fatal findings are returned as an error; advisory findings remain explicit.",
      inputSchema: {
        action: z
          .enum(["material", "texture"])
          .describe("Validator to run: material or texture"),
        path: z
          .string()
          .describe("Registered resource path to validate (for example, 'Assets/MyMat.emat' or 'Assets/MyTex.edds')"),
      },
    },
    async ({ action, path }) => {
      try {
        const raw = await client.call<Record<string, unknown>>(
          "EMCP_WB_ValidateResource",
          { action, path }
        );
        const receipt = receiptFrom(raw, action);
        const label = action === "material" ? "Material" : "Texture";
        const lines: string[] = [
          receipt.valid
            ? receipt.clean ? `**${label} Validation Passed**` : `**${label} Validation Passed with Advisories**`
            : `**${label} Validation Failed**`,
          "",
          `- **Resource:** ${receipt.resourceName}`,
          `- **Source / virtual path:** ${receipt.absolutePath}`,
          `- **Status:** ${receipt.valid ? receipt.clean ? "Valid and clean" : "Valid with advisories" : "Invalid"}`,
        ];
        if (receipt.reports.length > 0) {
          lines.push("", `### Findings (${receipt.reports.length})`);
          for (let index = 0; index < receipt.reports.length; index += 1) {
            const severity = receipt.severity[index];
            const label = severity === 3 ? "fatal" : severity === 2 ? "advisory (severity 2)" : "advisory (severity 1)";
            lines.push(`- **${label}:** ${receipt.reports[index]}`);
          }
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }],
          ...(receipt.valid ? {} : { isError: true }),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{
            type: "text" as const,
            text: `Error validating ${action} "${path}": ${message}${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
    }
  );
}
