import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  inspectDetectedClients,
  type ClientInspectionSummary,
  type ClientRegistrationOptions,
} from "./client-registration.js";
import {
  verifyMcpServer,
  type ServerVerificationOptions,
  type ServerVerificationReport,
  type VerificationStage,
} from "./server-verification.js";
import {
  composeSetupReceipt,
  type SetupReceipt,
  type VerificationLevelReceipt,
} from "./setup-receipt.js";
import {
  WorkbenchNetApiClient,
  type WorkbenchNetApiPort,
} from "../workbench/net-api-client.js";

export interface DoctorOptions {
  readonly serverPath: string;
  readonly packageRoot?: string;
  readonly packageVersion?: string;
  readonly startupArguments?: readonly string[];
  readonly checkWorkbench?: boolean;
}

export interface DoctorDependencies {
  readonly verifyServer?: (
    options: ServerVerificationOptions
  ) => Promise<ServerVerificationReport>;
  readonly inspectClients?: (
    options: ClientRegistrationOptions
  ) => ClientInspectionSummary;
  readonly createWorkbenchClient?: (
    host: string,
    port: number
  ) => WorkbenchNetApiPort;
  readonly readPackageVersion?: (packageRoot: string) => string;
  readonly nodePath?: string;
  readonly nodeVersion?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPackageVersion(packageRoot: string): string {
  const packagePath = join(packageRoot, "package.json");
  const document = JSON.parse(readFileSync(packagePath, "utf8")) as {
    version?: unknown;
  };
  if (
    typeof document.version !== "string" ||
    document.version.trim().length === 0
  ) {
    throw new Error(`${packagePath} does not declare a non-empty version.`);
  }
  return document.version;
}

function regularFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function level(
  stage: VerificationStage,
  detail?: string
): VerificationLevelReceipt {
  return {
    status: stage.status,
    ...(detail === undefined ? {} : { detail }),
    issues: [...stage.issues],
  };
}

function failedLevel(issue: string): VerificationLevelReceipt {
  return { status: "failed", issues: [issue] };
}

function notRunLevel(detail: string): VerificationLevelReceipt {
  return { status: "not_run", detail, issues: [] };
}

function inspectionFailureLevel(error: unknown): VerificationLevelReceipt {
  return {
    status: "attention_required",
    detail: "MCP client registration could not be inspected.",
    issues: [errorMessage(error)],
  };
}

function skippedClients(
  summary: ClientInspectionSummary | undefined
): string[] {
  return (summary?.receipts ?? [])
    .filter((receipt) => receipt.status === "not_detected")
    .map((receipt) => `${receipt.name}: not detected`);
}

function ambiguousFindings(
  report: ServerVerificationReport | undefined
): string[] {
  if (report?.steamDiscovery.sourceStatus !== "ambiguous") return [];
  const findings: string[] = [];
  if (report.steamDiscovery.gameCandidates.length > 1) {
    findings.push(
      `Arma Reforger candidates: ${report.steamDiscovery.gameCandidates.join(", ")}`
    );
  }
  if (report.steamDiscovery.workbenchCandidates.length > 1) {
    findings.push(
      `Arma Reforger Tools candidates: ${report.steamDiscovery.workbenchCandidates.join(", ")}`
    );
  }
  return findings;
}

function verificationNextActions(
  report: ServerVerificationReport | undefined,
  workbench: VerificationLevelReceipt,
  clientInspectionFailure: unknown,
  customClientInspectionSkipped: boolean
): string[] {
  const actions: string[] = [];
  if (report === undefined) {
    actions.push("Review the doctor error and retry server verification.");
  } else {
    if (report.steamDiscovery.status === "failed") {
      actions.push(
        "Install Arma Reforger and Arma Reforger Tools through Steam, or supply explicit installation paths."
      );
    }
    if (report.effectiveSettings.status === "failed") {
      actions.push(
        "Correct the optional configuration or startup arguments and run doctor again."
      );
    }
    if (report.serverHandshake.status === "failed") {
      actions.push(
        "Review the MCP server handshake error, rebuild the package, and run doctor again."
      );
    }
    if (report.toolRegistration.status === "failed") {
      actions.push(
        "Rebuild the package and reconcile the runtime tool surface with README.md."
      );
    }
  }
  if (workbench.status === "failed") {
    actions.push(
      "Start Workbench with its NET API available, then rerun doctor with --check-workbench."
    );
  }
  if (clientInspectionFailure !== undefined) {
    actions.push(
      "Review the client inspection error, then rerun Doctor."
    );
  }
  if (customClientInspectionSkipped) {
    actions.push(
      "Inspect client entries for the custom server arguments manually; standard setup registration is config-free."
    );
  }
  return actions;
}

/**
 * Perform read-only diagnostics and return one canonical receipt.
 *
 * The ordinary path never connects to Workbench. When explicitly requested,
 * the only live operation is one direct EMCP_WB_Ping transport call.
 */
export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {}
): Promise<SetupReceipt> {
  if (!isAbsolute(options.serverPath)) {
    throw new Error("Doctor requires an absolute MCP server path.");
  }
  const serverPath = resolve(options.serverPath);
  const packageRoot = resolve(
    options.packageRoot ?? dirname(dirname(serverPath))
  );
  const startupArguments = [...(options.startupArguments ?? [])];

  let packageVersion: string;
  let packageVersionFailure: unknown;
  try {
    packageVersion =
      options.packageVersion ??
      (dependencies.readPackageVersion ?? readPackageVersion)(packageRoot);
  } catch (error) {
    packageVersionFailure = error;
    packageVersion = "unknown";
  }

  let report: ServerVerificationReport | undefined;
  let reportFailure: unknown;
  try {
    report = await (dependencies.verifyServer ?? verifyMcpServer)({
      packageRoot,
      packageVersion,
      serverPath,
      startupArguments,
      nodeVersion: dependencies.nodeVersion ?? process.version,
    });
  } catch (error) {
    reportFailure = error;
  }

  let clientSummary: ClientInspectionSummary | undefined;
  let clientInspectionFailure: unknown;
  const customClientInspectionSkipped = startupArguments.length > 0;
  if (!customClientInspectionSkipped) {
    try {
      clientSummary = (
        dependencies.inspectClients ?? inspectDetectedClients
      )({ serverPath });
    } catch (error) {
      clientInspectionFailure = error;
    }
  }

  let workbenchNetApi: VerificationLevelReceipt = {
    status: "not_tested",
    detail: "Live Workbench connectivity was not requested.",
    issues: [],
  };
  if (options.checkWorkbench === true) {
    const host = report?.effectiveSettings.workbenchHost;
    const port = report?.effectiveSettings.workbenchPort;
    if (
      report?.effectiveSettings.status !== "passed" ||
      host === undefined ||
      port === undefined
    ) {
      workbenchNetApi = failedLevel(
        "Workbench NET API could not be checked because effective settings were unavailable."
      );
    } else {
      try {
        const client = (
          dependencies.createWorkbenchClient ??
          ((clientHost, clientPort) =>
            new WorkbenchNetApiClient(clientHost, clientPort))
        )(host, port);
        await client.call("EMCP_WB_Ping", {}, { timeoutMs: 5_000 });
        workbenchNetApi = {
          status: "passed",
          detail: `One read-only EMCP_WB_Ping succeeded at ${host}:${port}.`,
          issues: [],
        };
      } catch (error) {
        workbenchNetApi = failedLevel(
          `Read-only EMCP_WB_Ping failed: ${errorMessage(error)}`
        );
      }
    }
  }

  const verifierFailure = reportFailure ?? packageVersionFailure;
  const steamDiscovery = report
    ? level(
      report.steamDiscovery,
      `Steam metadata status: ${report.steamDiscovery.sourceStatus}.`
    )
    : notRunLevel("Server verification did not produce a report.");
  const effectiveSettings = report
    ? level(report.effectiveSettings)
    : notRunLevel("Effective settings were not resolved.");
  const serverHandshake = report
    ? level(report.serverHandshake)
    : failedLevel(
      `Server verification could not run: ${errorMessage(
        verifierFailure ?? "unknown verification failure"
      )}`
    );
  const toolRegistration = report
    ? level(
      report.toolRegistration,
      report.toolRegistration.status === "passed"
        ? `${report.toolRegistration.count} tools agree with the documented surface.`
        : `${report.toolRegistration.count} tools were observed.`
    )
    : notRunLevel("Tool registration was not inspected.");
  const clientRegistration = customClientInspectionSkipped
    ? {
      status: "not_tested" as const,
      detail:
        "Standard config-free client registration was not compared against custom startup arguments.",
      issues: [],
    }
    : clientInspectionFailure === undefined
      ? undefined
      : inspectionFailureLevel(clientInspectionFailure);

  return composeSetupReceipt({
    operation: "doctor",
    runtime: {
      serverPath,
      serverPresent: regularFileExists(serverPath),
      nodePath: dependencies.nodePath ?? process.execPath,
      nodeVersion:
        report?.nodeVersion ??
        dependencies.nodeVersion ??
        process.version,
      serverVersion: report?.compiledServer.version ?? null,
      transport: "stdio",
    },
    settings: {
      configPath: report?.configPath ?? null,
      projectPath: report?.effectiveSettings.projectPath ?? null,
      gamePath: report?.effectiveSettings.gamePath ?? null,
      workbenchPath: report?.effectiveSettings.workbenchPath ?? null,
      workbenchAddonDirs: [
        ...(report?.effectiveSettings.workbenchAddonDirs ?? []),
      ],
      startupArguments:
        report?.startupArguments ?? startupArguments,
      steamCandidates: {
        game: [...(report?.steamDiscovery.gameCandidates ?? [])],
        workbench: [
          ...(report?.steamDiscovery.workbenchCandidates ?? []),
        ],
      },
    },
    verification: {
      steamDiscovery,
      effectiveSettings,
      serverHandshake,
      toolRegistration,
      ...(clientRegistration === undefined
        ? {}
        : { clientRegistration }),
      workbenchNetApi,
      observerCapture: {
        status: "not_tested",
        detail: "Doctor does not stage or run observer capture.",
        issues: [],
      },
    },
    ...(clientSummary === undefined
      ? {}
      : { registration: clientSummary }),
    skipped: skippedClients(clientSummary),
    ambiguous: ambiguousFindings(report),
    nextActions: verificationNextActions(
      report,
      workbenchNetApi,
      clientInspectionFailure,
      customClientInspectionSkipped
    ),
  });
}
