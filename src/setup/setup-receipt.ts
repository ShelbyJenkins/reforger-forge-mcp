import type {
  ClientInspectionReceipt,
  ClientInspectionSummary,
  ClientManagedChange,
  ClientRegistrationReceipt,
  ClientRegistrationSummary,
} from "./client-registration.js";
import type {
  ServerVerificationReport,
  VerificationStage,
} from "./server-verification.js";

export const SETUP_RECEIPT_SCHEMA_VERSION = 1 as const;

export type SetupReceiptOperation = "setup" | "doctor";
export type SetupReceiptOverallStatus =
  | "passed"
  | "attention_required"
  | "failed";
export type SetupFailureLayer =
  | "platform"
  | "package"
  | "runtime"
  | "dependencies"
  | "build"
  | "verification"
  | "registration"
  | "doctor";
export type VerificationLevelStatus =
  | "passed"
  | "attention_required"
  | "failed"
  | "not_tested"
  | "not_run";

export interface VerificationLevelReceipt {
  readonly status: VerificationLevelStatus;
  readonly detail?: string;
  readonly issues: readonly string[];
}

export interface SetupRuntimeReceipt {
  readonly serverPath: string;
  readonly serverPresent: boolean;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly serverVersion: string | null;
  readonly transport: "stdio";
}

export interface SteamCandidateReceipt {
  readonly game: readonly string[];
  readonly workbench: readonly string[];
}

export interface SetupSettingsReceipt {
  readonly configPath: string | null;
  readonly gamePath: string | null;
  readonly workbenchPath: string | null;
  readonly workbenchAddonDirs: readonly string[];
  readonly startupArguments: readonly string[];
  readonly steamCandidates: SteamCandidateReceipt;
}

export interface SetupVerificationReceipt {
  readonly steamDiscovery: VerificationLevelReceipt;
  readonly effectiveSettings: VerificationLevelReceipt;
  readonly serverHandshake: VerificationLevelReceipt;
  readonly toolRegistration: VerificationLevelReceipt;
  readonly clientRegistration: VerificationLevelReceipt;
  readonly workbenchNetApi: VerificationLevelReceipt;
  readonly observerCapture: VerificationLevelReceipt;
}

export interface SetupFailureReceipt {
  readonly layer: SetupFailureLayer;
  readonly message: string;
}

export interface SetupReceipt {
  readonly schemaVersion: typeof SETUP_RECEIPT_SCHEMA_VERSION;
  readonly operation: SetupReceiptOperation;
  readonly overallStatus: SetupReceiptOverallStatus;
  readonly runtime: SetupRuntimeReceipt;
  readonly settings: SetupSettingsReceipt;
  readonly verification: SetupVerificationReceipt;
  readonly clients: readonly SetupClientReceipt[];
  readonly modifiedFiles: readonly string[];
  readonly managedChanges: readonly ClientManagedChange[];
  readonly backups: readonly string[];
  readonly skipped: readonly string[];
  readonly ambiguous: readonly string[];
  readonly nextActions: readonly string[];
  readonly failure?: SetupFailureReceipt;
}

export interface ComposeSetupReceiptOptions {
  readonly operation: SetupReceiptOperation;
  readonly runtime: SetupRuntimeReceipt;
  readonly settings: SetupSettingsReceipt;
  readonly verification: Omit<
    SetupVerificationReceipt,
    "clientRegistration"
  > & {
    readonly clientRegistration?: VerificationLevelReceipt;
  };
  readonly registration?: ClientRegistrationSummary | ClientInspectionSummary;
  readonly clients?: readonly SetupClientReceipt[];
  readonly modifiedFiles?: readonly string[];
  readonly managedChanges?: readonly ClientManagedChange[];
  readonly backups?: readonly string[];
  readonly skipped?: readonly string[];
  readonly ambiguous?: readonly string[];
  readonly nextActions?: readonly string[];
  readonly failure?: SetupFailureReceipt;
}

export type SetupClientReceipt =
  | ClientRegistrationReceipt
  | ClientInspectionReceipt;

export interface ComposeSetupReceiptFromReportsOptions {
  readonly operation: SetupReceiptOperation;
  readonly verificationReport: ServerVerificationReport;
  readonly registration?: ClientRegistrationSummary | ClientInspectionSummary;
  readonly nodePath?: string;
  readonly serverPresent?: boolean;
  readonly clientRegistration?: VerificationLevelReceipt;
  readonly workbenchNetApi?: VerificationLevelReceipt;
  readonly observerCapture?: VerificationLevelReceipt;
  readonly modifiedFiles?: readonly string[];
  readonly managedChanges?: readonly ClientManagedChange[];
  readonly backups?: readonly string[];
  readonly skipped?: readonly string[];
  readonly ambiguous?: readonly string[];
  readonly nextActions?: readonly string[];
  readonly failure?: SetupFailureReceipt;
}

export interface CreateSetupFailureReceiptOptions {
  readonly operation: SetupReceiptOperation;
  readonly serverPath: string;
  readonly serverPresent: boolean;
  readonly nodePath: string;
  readonly nodeVersion: string;
  readonly layer: SetupFailureLayer;
  readonly message: string;
  readonly nextActions?: readonly string[];
}

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0
  ))];
}

function clientFiles(
  clients: readonly SetupClientReceipt[],
  key: "modifiedFiles" | "backupFiles"
): string[] {
  return clients.flatMap((client) => client[key]);
}

function clientNextActions(
  clients: readonly SetupClientReceipt[]
): string[] {
  return clients.flatMap((client) => client.nextActions);
}

function clientManagedChanges(
  clients: readonly SetupClientReceipt[]
): readonly ClientManagedChange[] {
  return clients.flatMap((client) => client.managedChanges ?? []);
}

function uniqueManagedChanges(
  values: readonly ClientManagedChange[]
): ClientManagedChange[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = [
      value.clientId,
      value.kind,
      value.command,
      value.scope,
      value.configFileVerification,
      value.detail,
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clientRegistrationLevel(
  clients: readonly SetupClientReceipt[]
): VerificationLevelReceipt {
  if (clients.length === 0) {
    return {
      status: "not_tested",
      detail: "Client registration was not inspected.",
      issues: [],
    };
  }

  const attentionStatuses = new Set([
    "different",
    "not_registered",
    "detection_failed",
    "manual_setup_required",
    "failed",
  ]);
  const attention = clients.filter((client) =>
    attentionStatuses.has(client.status)
  );
  if (attention.length > 0) {
    return {
      status: "attention_required",
      detail: `${attention.length} client${
        attention.length === 1 ? "" : "s"
      } need attention.`,
      issues: attention.map((client) =>
        `${client.name}: ${client.detail ?? client.status}`
      ),
    };
  }

  const detected = clients.filter((client) =>
    client.status !== "not_detected"
  ).length;
  return {
    status: "passed",
    detail:
      detected === 0
        ? "No supported MCP clients were detected."
        : `${detected} detected client${detected === 1 ? "" : "s"} ${
            clients.some((client) => client.status === "updated")
              ? "registered or already current"
              : "inspected"
          }.`,
    issues: [],
  };
}

function calculateOverallStatus(
  verification: SetupVerificationReceipt,
  failure: SetupFailureReceipt | undefined
): SetupReceiptOverallStatus {
  if (failure !== undefined) return "failed";
  const levels = Object.values(verification);
  if (levels.some((level) => level.status === "failed")) return "failed";
  if (levels.some((level) => level.status === "attention_required")) {
    return "attention_required";
  }
  return "passed";
}

/**
 * Build the one canonical receipt consumed by both human and JSON renderers.
 *
 * Client file changes, backups, and next actions are folded into the top-level
 * lists so setup callers cannot accidentally omit changes reported by an
 * individual registrar.
 */
export function composeSetupReceipt(
  options: ComposeSetupReceiptOptions
): SetupReceipt {
  const clients = options.registration?.receipts ?? options.clients ?? [];
  const verification: SetupVerificationReceipt = {
    ...options.verification,
    clientRegistration:
      options.verification.clientRegistration ??
      clientRegistrationLevel(clients),
  };
  return {
    schemaVersion: SETUP_RECEIPT_SCHEMA_VERSION,
    operation: options.operation,
    overallStatus: calculateOverallStatus(verification, options.failure),
    runtime: options.runtime,
    settings: options.settings,
    verification,
    clients,
    modifiedFiles: unique([
      ...(options.modifiedFiles ?? []),
      ...clientFiles(clients, "modifiedFiles"),
    ]),
    managedChanges: uniqueManagedChanges([
      ...(options.managedChanges ?? []),
      ...clientManagedChanges(clients),
    ]),
    backups: unique([
      ...(options.backups ?? []),
      ...clientFiles(clients, "backupFiles"),
    ]),
    skipped: unique(options.skipped ?? []),
    ambiguous: unique(options.ambiguous ?? []),
    nextActions: unique([
      ...(options.nextActions ?? []),
      ...clientNextActions(clients),
    ]),
    ...(options.failure === undefined ? {} : { failure: options.failure }),
  };
}

function verificationStage(
  stage: VerificationStage,
  detail?: string
): VerificationLevelReceipt {
  return {
    status: stage.status,
    ...(detail === undefined ? {} : { detail }),
    issues: [...stage.issues],
  };
}

/**
 * Compose a setup or doctor receipt directly from the reusable server
 * verifier and client registrar/inspector reports.
 */
export function composeSetupReceiptFromReports(
  options: ComposeSetupReceiptFromReportsOptions
): SetupReceipt {
  const report = options.verificationReport;
  return composeSetupReceipt({
    operation: options.operation,
    runtime: {
      serverPath: report.serverPath,
      serverPresent:
        options.serverPresent ??
        report.compiledServer.version !== undefined,
      nodePath: options.nodePath ?? process.execPath,
      nodeVersion: report.nodeVersion,
      serverVersion: report.compiledServer.version ?? null,
      transport: "stdio",
    },
    settings: {
      configPath: report.configPath ?? null,
      gamePath: report.effectiveSettings.gamePath ?? null,
      workbenchPath: report.effectiveSettings.workbenchPath ?? null,
      workbenchAddonDirs: [
        ...(report.effectiveSettings.workbenchAddonDirs ?? []),
      ],
      startupArguments: [...report.startupArguments],
      steamCandidates: {
        game: [...report.steamDiscovery.gameCandidates],
        workbench: [...report.steamDiscovery.workbenchCandidates],
      },
    },
    verification: {
      steamDiscovery: verificationStage(
        report.steamDiscovery,
        `Steam metadata status: ${report.steamDiscovery.sourceStatus}.`
      ),
      effectiveSettings: verificationStage(report.effectiveSettings),
      serverHandshake: verificationStage(report.serverHandshake),
      toolRegistration: verificationStage(
        report.toolRegistration,
        `${report.toolRegistration.count} tools were observed.`
      ),
      ...(options.clientRegistration === undefined
        ? {}
        : { clientRegistration: options.clientRegistration }),
      workbenchNetApi: options.workbenchNetApi ?? {
        status: "not_tested",
        detail: "Live Workbench connectivity was not requested.",
        issues: [],
      },
      observerCapture: options.observerCapture ?? {
        status: "not_tested",
        detail: "Observer capture was not requested.",
        issues: [],
      },
    },
    ...(options.registration === undefined
      ? {}
      : { registration: options.registration }),
    modifiedFiles: options.modifiedFiles,
    managedChanges: options.managedChanges,
    backups: options.backups,
    skipped: options.skipped,
    ambiguous: options.ambiguous,
    nextActions: options.nextActions,
    failure: options.failure,
  });
}

/**
 * Produce a canonical receipt even when setup failed before the reusable
 * verifier could return its more detailed evidence.
 */
export function createSetupFailureReceipt(
  options: CreateSetupFailureReceiptOptions
): SetupReceipt {
  const notRun = (detail: string): VerificationLevelReceipt => ({
    status: "not_run",
    detail,
    issues: [],
  });
  return composeSetupReceipt({
    operation: options.operation,
    runtime: {
      serverPath: options.serverPath,
      serverPresent: options.serverPresent,
      nodePath: options.nodePath,
      nodeVersion: options.nodeVersion,
      serverVersion: null,
      transport: "stdio",
    },
    settings: {
      configPath: null,
      gamePath: null,
      workbenchPath: null,
      workbenchAddonDirs: [],
      startupArguments: [],
      steamCandidates: { game: [], workbench: [] },
    },
    verification: {
      steamDiscovery: notRun("Setup stopped before Steam discovery."),
      effectiveSettings: notRun("Setup stopped before settings validation."),
      serverHandshake: notRun("Setup stopped before the MCP handshake."),
      toolRegistration: notRun("Setup stopped before tool inspection."),
      clientRegistration: notRun("Setup stopped before client registration."),
      workbenchNetApi: {
        status: "not_tested",
        detail: "Live Workbench connectivity was not requested.",
        issues: [],
      },
      observerCapture: {
        status: "not_tested",
        detail: "Observer capture was not requested.",
        issues: [],
      },
    },
    nextActions: options.nextActions,
    failure: {
      layer: options.layer,
      message: options.message,
    },
  });
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

function formatLevel(level: VerificationLevelReceipt): string {
  const detail = level.detail ? ` — ${level.detail}` : "";
  const issues =
    level.issues.length > 0 ? ` (${level.issues.join("; ")})` : "";
  return `${label(level.status)}${detail}${issues}`;
}

function formatPath(path: string | null, absent: string): string {
  return path ?? absent;
}

function appendList(
  lines: string[],
  heading: string,
  values: readonly string[]
): void {
  lines.push("", `${heading}:`);
  if (values.length === 0) {
    lines.push("  none");
    return;
  }
  lines.push(...values.map((value) => `  - ${value}`));
}

function appendModifiedFiles(
  lines: string[],
  files: readonly string[],
  managedChanges: readonly ClientManagedChange[]
): void {
  lines.push("", "Modified files:");
  if (files.length > 0) {
    lines.push(...files.map((file) => `  - ${file}`));
    return;
  }
  lines.push(
    managedChanges.length > 0
      ? "  none directly verified; client-CLI changes are listed separately"
      : "  none"
  );
}

function appendManagedChanges(
  lines: string[],
  changes: readonly ClientManagedChange[]
): void {
  lines.push("", "CLI-managed changes:");
  if (changes.length === 0) {
    lines.push("  none");
    return;
  }
  for (const change of changes) {
    lines.push(
      `  - ${change.clientName}: ${change.detail} ` +
      `(command: ${change.command}; scope: ${change.scope}; ` +
      "exact config file: unverified)"
    );
  }
}

/** Render every canonical receipt field without performing any I/O. */
export function formatSetupReceipt(receipt: SetupReceipt): string {
  const operationLabel =
    receipt.operation === "setup" ? "setup" : "doctor";
  const title =
    receipt.overallStatus === "passed"
      ? `ReforgerForge ${operationLabel} complete`
      : receipt.overallStatus === "attention_required"
        ? `ReforgerForge ${operationLabel} requires attention`
        : `ReforgerForge ${operationLabel} failed`;
  const settings = receipt.settings;
  const levels = receipt.verification;
  const settingsResolved = levels.effectiveSettings.status === "passed";
  const lines = [
    title,
    "",
    `Receipt schema: ${receipt.schemaVersion}`,
    `Operation:      ${receipt.operation}`,
    `Overall status:${` ${label(receipt.overallStatus)}`}`,
    ...(receipt.failure === undefined
      ? []
      : [
        `Failed layer:   ${receipt.failure.layer}`,
        `Failure:        ${receipt.failure.message}`,
      ]),
    "",
    `Server:         ${receipt.runtime.serverPath}`,
    `Server present: ${receipt.runtime.serverPresent ? "yes" : "no"}`,
    `Node:           ${receipt.runtime.nodePath} (${receipt.runtime.nodeVersion})`,
    `Version:        ${receipt.runtime.serverVersion ?? "unavailable"}`,
    `Transport:      ${receipt.runtime.transport}`,
    `Config:         ${
      settings.configPath ??
      (settingsResolved
        ? "none (automatic discovery and internal defaults)"
        : "not resolved")
    }`,
    `Game:           ${formatPath(
      settings.gamePath,
      settingsResolved ? "unavailable" : "not resolved"
    )}`,
    `Tools:          ${formatPath(
      settings.workbenchPath,
      settingsResolved ? "unavailable" : "not resolved"
    )}`,
    `Addon roots:    ${
      settings.workbenchAddonDirs.length > 0
        ? settings.workbenchAddonDirs.join(", ")
        : "none"
    }`,
    `Startup args:   ${
      settings.startupArguments.length > 0
        ? JSON.stringify(settings.startupArguments)
        : "none"
    }`,
    `Game candidates:${
      settings.steamCandidates.game.length > 0
        ? ` ${settings.steamCandidates.game.join(", ")}`
        : " none"
    }`,
    `Tools candidates:${
      settings.steamCandidates.workbench.length > 0
        ? ` ${settings.steamCandidates.workbench.join(", ")}`
        : " none"
    }`,
    "",
    `Steam discovery:    ${formatLevel(levels.steamDiscovery)}`,
    `Effective settings: ${formatLevel(levels.effectiveSettings)}`,
    `Server handshake:   ${formatLevel(levels.serverHandshake)}`,
    `Tool registration:  ${formatLevel(levels.toolRegistration)}`,
    `Client registration:${` ${formatLevel(levels.clientRegistration)}`}`,
    `Workbench NET API:  ${formatLevel(levels.workbenchNetApi)}`,
    `Observer capture:   ${formatLevel(levels.observerCapture)}`,
    "",
    "Clients:",
  ];
  if (receipt.clients.length === 0) {
    lines.push("  none inspected");
  } else {
    for (const client of receipt.clients) {
      lines.push(
        `  - ${client.name}: ${label(client.status)}${
          client.detail ? ` — ${client.detail}` : ""
        }`
      );
    }
  }
  appendModifiedFiles(lines, receipt.modifiedFiles, receipt.managedChanges);
  appendManagedChanges(lines, receipt.managedChanges);
  appendList(lines, "Backups", receipt.backups);
  appendList(lines, "Skipped", receipt.skipped);
  appendList(lines, "Ambiguous", receipt.ambiguous);
  appendList(lines, "Next actions", receipt.nextActions);
  return lines.join("\n");
}

/** Serialize the exact same canonical object used by the human renderer. */
export function serializeSetupReceipt(receipt: SetupReceipt): string {
  return JSON.stringify(receipt, null, 2);
}
