#!/usr/bin/env node

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readServerVerificationReport,
  type ServerVerificationReport,
} from "./server-verification.js";
import {
  composeSetupReceiptFromReports,
  createSetupFailureReceipt,
  formatSetupReceipt,
  serializeSetupReceipt,
  type SetupReceipt,
} from "./setup-receipt.js";

export interface ParsedSetupReceiptArguments {
  readonly serverPath: string;
  readonly verificationReportPath: string;
  readonly json: boolean;
}

export interface SetupReceiptCliDependencies {
  readonly readReport?: (
    reportPath: string
  ) => Promise<ServerVerificationReport>;
  readonly writeStdout?: (text: string) => void;
  readonly nodePath?: string;
  readonly nodeVersion?: string;
  readonly serverExists?: (serverPath: string) => boolean;
}

function regularFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function setupReceiptUsage(): string {
  return [
    "Usage:",
    "  node dist/setup/setup-receipt-cli.js --server <absolute-dist-index.js> --verification-report <absolute-report.json> [--json]",
    "",
    "This internal setup command renders a failed verification transaction.",
  ].join("\n");
}

export function parseSetupReceiptArguments(
  argv: readonly string[]
): ParsedSetupReceiptArguments {
  let serverPath: string | undefined;
  let verificationReportPath: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--server":
        if (serverPath !== undefined || value === undefined) {
          throw new Error(setupReceiptUsage());
        }
        if (!isAbsolute(value)) {
          throw new Error(`--server must be absolute.\n${setupReceiptUsage()}`);
        }
        serverPath = resolve(value);
        index += 1;
        break;
      case "--verification-report":
        if (verificationReportPath !== undefined || value === undefined) {
          throw new Error(setupReceiptUsage());
        }
        if (!isAbsolute(value)) {
          throw new Error(
            `--verification-report must be absolute.\n${setupReceiptUsage()}`
          );
        }
        verificationReportPath = resolve(value);
        index += 1;
        break;
      case "--json":
        if (json) throw new Error(setupReceiptUsage());
        json = true;
        break;
      default:
        throw new Error(
          `Unknown setup receipt argument: ${argument}\n${setupReceiptUsage()}`
        );
    }
  }

  if (serverPath === undefined || verificationReportPath === undefined) {
    throw new Error(setupReceiptUsage());
  }
  return { serverPath, verificationReportPath, json };
}

function ambiguousFindings(report: ServerVerificationReport): string[] {
  if (report.steamDiscovery.sourceStatus !== "ambiguous") return [];
  return [
    ...(report.steamDiscovery.gameCandidates.length > 1
      ? [
        `Arma Reforger candidates: ${report.steamDiscovery.gameCandidates.join(", ")}`,
      ]
      : []),
    ...(report.steamDiscovery.workbenchCandidates.length > 1
      ? [
        `Arma Reforger Tools candidates: ${report.steamDiscovery.workbenchCandidates.join(", ")}`,
      ]
      : []),
  ];
}

function verificationActions(report: ServerVerificationReport): string[] {
  const actions: string[] = [];
  if (report.steamDiscovery.status === "failed") {
    actions.push(
      "Install Arma Reforger and Arma Reforger Tools through Steam, or supply explicit installation paths."
    );
  }
  if (report.effectiveSettings.status !== "passed") {
    actions.push(
      "Correct the optional configuration or startup arguments, then rerun setup."
    );
  }
  if (report.serverHandshake.status === "failed") {
    actions.push(
      "Review the MCP handshake error, rebuild the package, and rerun setup."
    );
  }
  if (report.toolRegistration.status === "failed") {
    actions.push(
      "Rebuild the package and reconcile the runtime tool surface with README.md."
    );
  }
  if (actions.length === 0) {
    actions.push("Review the verification issues and rerun setup.");
  }
  return actions;
}

function receiptFromReport(
  report: ServerVerificationReport,
  serverPresent: boolean
): SetupReceipt {
  return composeSetupReceiptFromReports({
    operation: "setup",
    verificationReport: report,
    serverPresent,
    clientRegistration: {
      status: "not_run",
      detail: "Client registration was skipped because server verification failed.",
      issues: [],
    },
    skipped: [
      "Client registration: skipped because server verification failed.",
    ],
    ambiguous: ambiguousFindings(report),
    nextActions: verificationActions(report),
    failure: {
      layer: "verification",
      message: "MCP server verification did not pass every required level.",
    },
  });
}

export async function executeSetupReceiptCli(
  argv: readonly string[],
  dependencies: SetupReceiptCliDependencies = {}
): Promise<number> {
  const writeStdout =
    dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const nodePath = dependencies.nodePath ?? process.execPath;
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  const serverExists = dependencies.serverExists ?? regularFileExists;

  let parsed: ParsedSetupReceiptArguments | undefined;
  let receipt: SetupReceipt;
  try {
    parsed = parseSetupReceiptArguments(argv);
    const report = await (
      dependencies.readReport ?? readServerVerificationReport
    )(parsed.verificationReportPath);
    if (resolve(report.serverPath) !== parsed.serverPath) {
      throw new Error(
        "Verification report server path does not match the setup server."
      );
    }
    if (report.success) {
      throw new Error(
        "Failed-setup receipt renderer received a successful verification report."
      );
    }
    receipt = receiptFromReport(report, serverExists(parsed.serverPath));
  } catch (error) {
    const serverPath =
      parsed?.serverPath ??
      resolve(process.cwd(), "dist", "index.js");
    receipt = createSetupFailureReceipt({
      operation: "setup",
      serverPath,
      serverPresent: serverExists(serverPath),
      nodePath,
      nodeVersion,
      layer: "verification",
      message: error instanceof Error ? error.message : String(error),
      nextActions: [
        "Review the verification error and rerun setup.",
      ],
    });
  }

  const json = parsed?.json === true || argv.includes("--json");
  writeStdout(
    `${
      json
        ? serializeSetupReceipt(receipt)
        : formatSetupReceipt(receipt)
    }\n`
  );
  return 1;
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined &&
    resolve(entryPoint) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  process.exitCode = await executeSetupReceiptCli(process.argv.slice(2));
}
