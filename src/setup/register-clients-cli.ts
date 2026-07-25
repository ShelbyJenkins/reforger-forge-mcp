#!/usr/bin/env node

/**
 * Internal registration-only final step for scripts/setup.ps1.
 *
 * Setup owns the build and reusable MCP verification gates before invoking
 * this file. This command validates that exact verifier report before making
 * any client change, then emits the transaction's canonical completion
 * receipt. Standalone explicit-config installation remains a separate path.
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFailedRegistrationSummary,
  registerDetectedClients,
  type ClientRegistrationSummary,
} from "./client-registration.js";
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

export interface ParsedRegistrationArguments {
  readonly serverPath: string;
  readonly verificationReportPath: string;
  readonly json: boolean;
}

export interface RegistrationCliDependencies {
  readonly readReport?: (
    reportPath: string
  ) => Promise<ServerVerificationReport>;
  readonly register?: (
    options: { readonly serverPath: string }
  ) => ClientRegistrationSummary;
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

export function registrationUsage(): string {
  return [
    "Usage:",
    "  node dist/setup/register-clients-cli.js --server <absolute-dist-index.js> --verification-report <absolute-report.json> [--json]",
  ].join("\n");
}

export function parseRegistrationArguments(
  args: readonly string[]
): ParsedRegistrationArguments {
  let serverPath: string | undefined;
  let verificationReportPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    switch (argument) {
      case "--server":
        if (serverPath !== undefined || value === undefined) {
          throw new Error(registrationUsage());
        }
        if (!isAbsolute(value)) {
          throw new Error(
            `--server must be an absolute path.\n${registrationUsage()}`
          );
        }
        serverPath = resolve(value);
        index += 1;
        break;
      case "--verification-report":
        if (verificationReportPath !== undefined || value === undefined) {
          throw new Error(registrationUsage());
        }
        if (!isAbsolute(value)) {
          throw new Error(
            `--verification-report must be absolute.\n${registrationUsage()}`
          );
        }
        verificationReportPath = resolve(value);
        index += 1;
        break;
      case "--json":
        if (json) throw new Error(registrationUsage());
        json = true;
        break;
      default:
        throw new Error(
          `Unknown registration argument: ${argument}\n${registrationUsage()}`
        );
    }
  }
  if (serverPath === undefined || verificationReportPath === undefined) {
    throw new Error(registrationUsage());
  }
  return { serverPath, verificationReportPath, json };
}

function skippedClients(summary: ClientRegistrationSummary): string[] {
  return summary.receipts
    .filter((receipt) => receipt.status === "not_detected")
    .map((receipt) => `${receipt.name}: not detected`);
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

function receiptFromRegistration(
  report: ServerVerificationReport,
  registration: ClientRegistrationSummary,
  serverPresent: boolean
): SetupReceipt {
  return composeSetupReceiptFromReports({
    operation: "setup",
    verificationReport: report,
    registration,
    serverPresent,
    skipped: skippedClients(registration),
    ambiguous: ambiguousFindings(report),
  });
}

function validateRegistrationGate(
  report: ServerVerificationReport,
  serverPath: string
): void {
  if (resolve(report.serverPath) !== serverPath) {
    throw new Error(
      "Verification report server path does not match the registration target."
    );
  }
  if (!report.success) {
    throw new Error(
      "Client registration requires a successful verifier report."
    );
  }
  if (report.startupArguments.length > 0) {
    throw new Error(
      "The standard setup registrar accepts only the config-free verifier report."
    );
  }
}

export async function executeRegistrationCli(
  argv: readonly string[],
  dependencies: RegistrationCliDependencies = {}
): Promise<number> {
  const writeStdout =
    dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const serverExists = dependencies.serverExists ?? regularFileExists;
  let parsed: ParsedRegistrationArguments | undefined;
  let receipt: SetupReceipt;
  let exitCode: number;

  try {
    parsed = parseRegistrationArguments(argv);
    const report = await (
      dependencies.readReport ?? readServerVerificationReport
    )(parsed.verificationReportPath);
    validateRegistrationGate(report, parsed.serverPath);
    if (!serverExists(parsed.serverPath)) {
      throw new Error(
        "The verified MCP server is no longer a regular file; client registration was not attempted."
      );
    }

    let registration: ClientRegistrationSummary;
    try {
      registration = (
        dependencies.register ?? registerDetectedClients
      )({ serverPath: parsed.serverPath });
    } catch (error) {
      registration = createFailedRegistrationSummary(
        parsed.serverPath,
        `Registration initialization failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    receipt = receiptFromRegistration(
      report,
      registration,
      serverExists(parsed.serverPath)
    );
    exitCode =
      receipt.overallStatus === "passed"
        ? 0
        : receipt.overallStatus === "attention_required"
          ? 2
          : 1;
  } catch (error) {
    const serverPath =
      parsed?.serverPath ??
      resolve(process.cwd(), "dist", "index.js");
    receipt = createSetupFailureReceipt({
      operation: "setup",
      serverPath,
      serverPresent: serverExists(serverPath),
      nodePath: dependencies.nodePath ?? process.execPath,
      nodeVersion: dependencies.nodeVersion ?? process.version,
      layer: parsed === undefined ? "registration" : "verification",
      message: error instanceof Error ? error.message : String(error),
      nextActions: [
        "Do not register clients from an unverified report; rerun setup.",
      ],
    });
    exitCode = 1;
  }

  const json = parsed?.json === true || argv.includes("--json");
  writeStdout(
    `${
      json
        ? serializeSetupReceipt(receipt)
        : formatSetupReceipt(receipt)
    }\n`
  );
  return exitCode;
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined &&
    resolve(entryPoint) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) {
  process.exitCode = await executeRegistrationCli(process.argv.slice(2));
}
