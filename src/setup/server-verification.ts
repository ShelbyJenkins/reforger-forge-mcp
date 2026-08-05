import { execFile } from "node:child_process";
import {
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  loadConfig,
  type Config,
  type LoadConfigOptions,
} from "../config.js";
import {
  discoverSteamInstallations,
  type SteamDiscoveryDiagnostic,
  type SteamDiscoveryResult,
  type SteamDiscoveryStatus,
} from "../platform/windows/steam-discovery.js";

const execFileAsync = promisify(execFile);

export const SERVER_VERIFICATION_REPORT_SCHEMA_VERSION = 1 as const;

export type VerificationStatus =
  | "passed"
  | "failed"
  | "not_tested"
  | "not_run";

export interface VerificationStage {
  status: VerificationStatus;
  issues: string[];
}

export interface CompiledServerVerification extends VerificationStage {
  version?: string;
}

export interface SteamDiscoveryVerification extends VerificationStage {
  sourceStatus: SteamDiscoveryStatus | "error";
  workbenchCandidates: string[];
  gameCandidates: string[];
  steamRoots: string[];
  libraryRoots: string[];
  diagnostics: SteamDiscoveryDiagnostic[];
}

export interface EffectiveSettingsVerification extends VerificationStage {
  workbenchPath?: string;
  gamePath?: string;
  workbenchAddonDirs?: string[];
  workbenchHost?: string;
  workbenchPort?: number;
}

export interface ToolRegistrationVerification extends VerificationStage {
  count: number;
  names: string[];
}

export interface ServerVerificationReport {
  schemaVersion: typeof SERVER_VERIFICATION_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  success: boolean;
  nodeVersion: string;
  serverPath: string;
  packageVersion: string;
  compiledServer: CompiledServerVerification;
  startupArguments: string[];
  configPath?: string;
  steamDiscovery: SteamDiscoveryVerification;
  effectiveSettings: EffectiveSettingsVerification;
  serverHandshake: VerificationStage;
  toolRegistration: ToolRegistrationVerification;
}

export interface ServerVerificationOptions {
  packageRoot: string;
  packageVersion: string;
  startupArguments?: readonly string[];
  serverPath?: string;
  nodeVersion?: string;
}

interface AdvertisedTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
}

export interface ServerVerificationSession {
  connect(): Promise<void>;
  listTools(): Promise<{ tools: AdvertisedTool[] }>;
  close(): Promise<void>;
}

export interface ServerVerificationSessionOptions {
  command: string;
  serverPath: string;
  startupArguments: readonly string[];
  cwd: string;
  packageVersion: string;
}

export interface CompiledServerProbeResult {
  version?: string;
  issue?: string;
}

export interface ServerVerificationDependencies {
  discoverSteam?: () => SteamDiscoveryResult;
  loadConfiguration?: (
    argv: readonly string[],
    options: LoadConfigOptions
  ) => Config;
  createSession?: (
    options: ServerVerificationSessionOptions
  ) => ServerVerificationSession;
  probeCompiledServer?: (
    serverPath: string,
    cwd: string
  ) => Promise<CompiledServerProbeResult>;
  now?: () => Date;
  nodeCommand?: string;
}

const VERIFICATION_STATUSES = new Set<VerificationStatus>([
  "passed",
  "failed",
  "not_tested",
  "not_run",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedStage(issue: string): VerificationStage {
  return { status: "failed", issues: [issue] };
}

function notRunStage(): VerificationStage {
  return { status: "not_run", issues: [] };
}

function explicitConfigPath(
  startupArguments: readonly string[],
  packageRoot: string
): string | undefined {
  const index = startupArguments.indexOf("--config");
  const value = index >= 0 ? startupArguments[index + 1] : undefined;
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    return undefined;
  }
  return isAbsolute(value) ? resolve(value) : resolve(packageRoot, value);
}

function syntheticDiscoveryFailure(error: unknown): SteamDiscoveryResult {
  return {
    status: "unsupported",
    workbenchCandidates: [],
    gameCandidates: [],
    steamRoots: [],
    libraryRoots: [],
    errors: [{
      code: "UNSUPPORTED_PLATFORM",
      source: "discovery",
      message: `Steam discovery threw an unexpected error: ${errorMessage(error)}`,
    }],
  };
}

function steamDetails(
  discovery: SteamDiscoveryResult,
  sourceStatus: SteamDiscoveryStatus | "error",
  status: VerificationStatus,
  issues: string[]
): SteamDiscoveryVerification {
  return {
    status,
    sourceStatus,
    workbenchCandidates: [...discovery.workbenchCandidates],
    gameCandidates: [...discovery.gameCandidates],
    steamRoots: [...discovery.steamRoots],
    libraryRoots: [...discovery.libraryRoots],
    diagnostics: discovery.errors.map((diagnostic) => ({ ...diagnostic })),
    issues,
  };
}

async function defaultProbeCompiledServer(
  serverPath: string,
  cwd: string
): Promise<CompiledServerProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [serverPath, "--version"],
      {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      }
    );
    const version = stdout.trim();
    if (!version) {
      return { issue: "Compiled server returned an empty version." };
    }
    return { version };
  } catch (error) {
    return {
      issue: `Compiled server version probe failed: ${errorMessage(error)}`,
    };
  }
}

function defaultCreateSession(
  options: ServerVerificationSessionOptions
): ServerVerificationSession {
  const transport = new StdioClientTransport({
    command: options.command,
    args: [options.serverPath, ...options.startupArguments],
    cwd: options.cwd,
    // Keep server diagnostics off structured stdout while also avoiding an
    // unread pipe that can backpressure a chatty server.
    stderr: "inherit",
  });
  const client = new Client({
    name: "server-verifier",
    version: options.packageVersion,
  });
  return {
    connect: () => client.connect(transport),
    listTools: async () => {
      const result = await client.listTools();
      return { tools: result.tools as AdvertisedTool[] };
    },
    close: () => client.close(),
  };
}

const REQUIRED_OBSERVER_TOOLS = [
  "observer_setup",
  "observer_prepare_launch",
  "observer_runtime",
  "observer_instances",
  "observer_capture",
  "observer_job",
  "observer_run_begin",
  "observer_run_status",
  "observer_run_finalize",
  "observer_run_discard",
] as const;

const REQUIRED_OBSERVER_COMPOSITES = ["game_launch"] as const;

export function inspectToolRegistration(
  tools: readonly AdvertisedTool[]
): ToolRegistrationVerification {
  const sorted = [...tools].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const names = sorted.map((tool) => tool.name);
  const registeredNames = new Set(names);
  const issues: string[] = [];
  const duplicateNames = names.filter(
    (name, index) => names.indexOf(name) !== index
  );
  if (duplicateNames.length > 0) {
    issues.push(
      `Duplicate runtime tools: ${[...new Set(duplicateNames)].join(", ")}`
    );
  }

  const missingDescriptions = sorted
    .filter((tool) => !tool.description || tool.description.trim().length === 0)
    .map((tool) => tool.name);
  if (missingDescriptions.length > 0) {
    issues.push(`Runtime tools missing descriptions: ${missingDescriptions.join(", ")}`);
  }

  const removedTools = ["wb_play", "wb_save", "wb_execute_action"]
    .filter((name) => registeredNames.has(name));
  if (removedTools.length > 0) {
    issues.push(
      `Removed refusal-only tools still registered: ${removedTools.join(", ")}`
    );
  }

  const modProperties =
    sorted.find((tool) => tool.name === "mod")?.inputSchema?.properties ?? {};
  const modAction = modProperties.action as { enum?: unknown } | undefined;
  const modActions = Array.isArray(modAction?.enum) ? modAction.enum : [];
  const removedModProperties = [
    "addonName",
    "platform",
    "outputPath",
    "filterPath",
  ].filter((name) => Object.hasOwn(modProperties, name));
  const removedModSurface = [
    modActions.includes("build") ? "action=build" : "",
    ...removedModProperties,
  ].filter(Boolean);
  if (removedModSurface.length > 0) {
    issues.push(
      `Removed mod build surface is still advertised: ${removedModSurface.join(", ")}`
    );
  }

  const reloadProperties =
    sorted.find((tool) => tool.name === "wb_reload")
      ?.inputSchema?.properties ?? {};
  const reloadTarget = reloadProperties.target as {
    default?: unknown;
    enum?: unknown;
  } | undefined;
  if (
    reloadTarget?.default !== "plugins" ||
    !Array.isArray(reloadTarget.enum) ||
    reloadTarget.enum.length !== 1 ||
    reloadTarget.enum[0] !== "plugins"
  ) {
    issues.push("wb_reload must advertise only target=plugins and default to it.");
  }

  const missingObserverTools = REQUIRED_OBSERVER_TOOLS
    .filter((name) => !registeredNames.has(name));
  if (missingObserverTools.length > 0) {
    issues.push(
      `Required observer tools missing at runtime: ${missingObserverTools.join(", ")}`
    );
  }
  const missingObserverComposites = REQUIRED_OBSERVER_COMPOSITES
    .filter((name) => !registeredNames.has(name));
  if (missingObserverComposites.length > 0) {
    issues.push(
      `Required observer composites missing at runtime: ${missingObserverComposites.join(", ")}`
    );
  }

  return {
    status: issues.length === 0 ? "passed" : "failed",
    count: sorted.length,
    names,
    issues,
  };
}

export function isServerVerificationSuccessful(
  report: Pick<
    ServerVerificationReport,
    | "steamDiscovery"
    | "effectiveSettings"
    | "serverHandshake"
    | "toolRegistration"
  >
): boolean {
  return [
    report.steamDiscovery,
    report.effectiveSettings,
    report.serverHandshake,
    report.toolRegistration,
  ].every((stage) => stage.status === "passed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  field: string,
  options: { nonEmpty?: boolean } = {}
): asserts value is string {
  if (
    typeof value !== "string" ||
    (options.nonEmpty === true && value.trim().length === 0)
  ) {
    throw new Error(`Verification report field ${field} must be a string.`);
  }
}

function requireStringArray(
  value: unknown,
  field: string
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(
      `Verification report field ${field} must be an array of strings.`
    );
  }
}

function requireStage(
  value: unknown,
  field: string
): asserts value is VerificationStage {
  if (!isRecord(value) || !VERIFICATION_STATUSES.has(
    value.status as VerificationStatus
  )) {
    throw new Error(
      `Verification report field ${field}.status is invalid.`
    );
  }
  requireStringArray(value.issues, `${field}.issues`);
}

/**
 * Validate an untrusted serialized verifier result before it can authorize
 * the setup transaction's registration step.
 */
export function parseServerVerificationReport(
  value: unknown
): ServerVerificationReport {
  if (!isRecord(value)) {
    throw new Error("Verification report must be a JSON object.");
  }
  if (value.schemaVersion !== SERVER_VERIFICATION_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported verification report schema: ${String(value.schemaVersion)}.`
    );
  }
  requireString(value.generatedAt, "generatedAt", { nonEmpty: true });
  if (Number.isNaN(Date.parse(value.generatedAt))) {
    throw new Error("Verification report field generatedAt is invalid.");
  }
  if (typeof value.success !== "boolean") {
    throw new Error("Verification report field success must be a boolean.");
  }
  requireString(value.nodeVersion, "nodeVersion", { nonEmpty: true });
  requireString(value.serverPath, "serverPath", { nonEmpty: true });
  if (!isAbsolute(value.serverPath)) {
    throw new Error("Verification report field serverPath must be absolute.");
  }
  requireString(value.packageVersion, "packageVersion", { nonEmpty: true });
  requireStringArray(value.startupArguments, "startupArguments");
  if (value.configPath !== undefined) {
    requireString(value.configPath, "configPath", { nonEmpty: true });
    if (!isAbsolute(value.configPath)) {
      throw new Error("Verification report field configPath must be absolute.");
    }
  }

  requireStage(value.compiledServer, "compiledServer");
  const compiledServerRecord =
    value.compiledServer as unknown as Record<string, unknown>;
  if (
    compiledServerRecord.version !== undefined &&
    typeof compiledServerRecord.version !== "string"
  ) {
    throw new Error(
      "Verification report field compiledServer.version must be a string."
    );
  }

  requireStage(value.steamDiscovery, "steamDiscovery");
  const steamDiscoveryRecord =
    value.steamDiscovery as unknown as Record<string, unknown>;
  if (
    ![
      "success",
      "not_found",
      "ambiguous",
      "malformed",
      "unsupported",
      "error",
    ].includes(String(steamDiscoveryRecord.sourceStatus))
  ) {
    throw new Error(
      "Verification report field steamDiscovery.sourceStatus is invalid."
    );
  }
  for (const field of [
    "workbenchCandidates",
    "gameCandidates",
    "steamRoots",
    "libraryRoots",
  ] as const) {
    requireStringArray(
      steamDiscoveryRecord[field],
      `steamDiscovery.${field}`
    );
  }
  if (!Array.isArray(steamDiscoveryRecord.diagnostics)) {
    throw new Error(
      "Verification report field steamDiscovery.diagnostics must be an array."
    );
  }

  requireStage(value.effectiveSettings, "effectiveSettings");
  const effectiveSettingsRecord =
    value.effectiveSettings as unknown as Record<string, unknown>;
  for (const field of [
    "workbenchPath",
    "gamePath",
    "workbenchHost",
  ] as const) {
    const fieldValue = effectiveSettingsRecord[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      throw new Error(
        `Verification report field effectiveSettings.${field} must be a string.`
      );
    }
  }
  if (effectiveSettingsRecord.workbenchAddonDirs !== undefined) {
    requireStringArray(
      effectiveSettingsRecord.workbenchAddonDirs,
      "effectiveSettings.workbenchAddonDirs"
    );
  }
  if (
    effectiveSettingsRecord.workbenchPort !== undefined &&
    (!Number.isInteger(effectiveSettingsRecord.workbenchPort) ||
      Number(effectiveSettingsRecord.workbenchPort) < 1 ||
      Number(effectiveSettingsRecord.workbenchPort) > 65_535)
  ) {
    throw new Error(
      "Verification report field effectiveSettings.workbenchPort is invalid."
    );
  }

  requireStage(value.serverHandshake, "serverHandshake");
  requireStage(value.toolRegistration, "toolRegistration");
  const toolRegistrationRecord =
    value.toolRegistration as unknown as Record<string, unknown>;
  if (
    !Number.isInteger(toolRegistrationRecord.count) ||
    Number(toolRegistrationRecord.count) < 0
  ) {
    throw new Error(
      "Verification report field toolRegistration.count must be a non-negative integer."
    );
  }
  requireStringArray(
    toolRegistrationRecord.names,
    "toolRegistration.names"
  );
  const registeredToolNames = toolRegistrationRecord.names as string[];
  if (Number(toolRegistrationRecord.count) !== registeredToolNames.length) {
    throw new Error(
      "Verification report toolRegistration.count does not agree with toolRegistration.names."
    );
  }
  if (new Set(registeredToolNames).size !== registeredToolNames.length) {
    throw new Error(
      "Verification report field toolRegistration.names must not contain duplicates."
    );
  }
  if (
    toolRegistrationRecord.status === "passed" &&
    registeredToolNames.length === 0
  ) {
    throw new Error(
      "Passed tool registration verification must include at least one registered tool."
    );
  }

  const report = value as unknown as ServerVerificationReport;
  const calculatedSuccess = isServerVerificationSuccessful(report);
  if (report.success !== calculatedSuccess) {
    throw new Error(
      "Verification report success does not agree with its verification stages."
    );
  }
  if (
    report.success &&
    (report.compiledServer.status !== "passed" ||
      report.compiledServer.version !== report.packageVersion)
  ) {
    throw new Error(
      "Successful verification report does not prove the expected compiled server version."
    );
  }
  return report;
}

export async function readServerVerificationReport(
  reportPath: string
): Promise<ServerVerificationReport> {
  if (!isAbsolute(reportPath)) {
    throw new Error("Verification report path must be absolute.");
  }
  let document: unknown;
  try {
    document = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read verification report ${reportPath}: ${errorMessage(error)}`
    );
  }
  return parseServerVerificationReport(document);
}

export async function verifyMcpServer(
  options: ServerVerificationOptions,
  dependencies: ServerVerificationDependencies = {}
): Promise<ServerVerificationReport> {
  const packageRoot = resolve(options.packageRoot);
  const serverPath = options.serverPath === undefined
    ? join(packageRoot, "dist", "index.js")
    : isAbsolute(options.serverPath)
      ? resolve(options.serverPath)
      : resolve(packageRoot, options.serverPath);
  const startupArguments = [...(options.startupArguments ?? [])];
  const discoverSteam =
    dependencies.discoverSteam ?? discoverSteamInstallations;
  const loadConfiguration = dependencies.loadConfiguration ?? loadConfig;
  const createSession = dependencies.createSession ?? defaultCreateSession;
  const probeCompiledServer =
    dependencies.probeCompiledServer ?? defaultProbeCompiledServer;

  const compiledProbe = await probeCompiledServer(serverPath, packageRoot);
  const compiledIssues: string[] = [];
  if (compiledProbe.issue) compiledIssues.push(compiledProbe.issue);
  if (
    compiledProbe.version === undefined &&
    compiledProbe.issue === undefined
  ) {
    compiledIssues.push("Compiled server version probe returned no version.");
  }
  if (
    compiledProbe.version !== undefined &&
    compiledProbe.version !== options.packageVersion
  ) {
    compiledIssues.push(
      `Compiled server version ${compiledProbe.version} does not match package version ${options.packageVersion}.`
    );
  }
  const compiledServer: CompiledServerVerification = {
    status: compiledIssues.length === 0 ? "passed" : "failed",
    ...(compiledProbe.version === undefined
      ? {}
      : { version: compiledProbe.version }),
    issues: compiledIssues,
  };

  let discovery: SteamDiscoveryResult;
  let discoverySourceStatus: SteamDiscoveryStatus | "error";
  let discoveryThrown: unknown;
  try {
    discovery = discoverSteam();
    discoverySourceStatus = discovery.status;
  } catch (error) {
    discoveryThrown = error;
    discovery = syntheticDiscoveryFailure(error);
    discoverySourceStatus = "error";
  }

  let effectiveConfig: Config | undefined;
  let configurationFailure: unknown;
  try {
    effectiveConfig = loadConfiguration(startupArguments, {
      cwd: packageRoot,
      discoverSteam: () => discovery,
    });
  } catch (error) {
    configurationFailure = error;
  }

  let steamDiscovery: SteamDiscoveryVerification;
  let effectiveSettings: EffectiveSettingsVerification;
  if (effectiveConfig) {
    steamDiscovery = steamDetails(
      discovery,
      discoverySourceStatus,
      "passed",
      []
    );
    effectiveSettings = {
      status: "passed",
      workbenchPath: effectiveConfig.workbenchPath,
      gamePath: effectiveConfig.gamePath,
      workbenchAddonDirs: [...(effectiveConfig.workbenchAddonDirs ?? [])],
      workbenchHost: effectiveConfig.workbenchHost,
      workbenchPort: effectiveConfig.workbenchPort,
      issues: [],
    };
  } else if (discovery.status === "success" && discoveryThrown === undefined) {
    steamDiscovery = steamDetails(
      discovery,
      discoverySourceStatus,
      "passed",
      []
    );
    effectiveSettings = {
      status: "failed",
      issues: [
        `Effective settings validation failed: ${errorMessage(configurationFailure)}`,
      ],
    };
  } else {
    const discoveryIssues = discoveryThrown === undefined
      ? discovery.errors.map((diagnostic) => diagnostic.message)
      : [`Steam discovery failed: ${errorMessage(discoveryThrown)}`];
    steamDiscovery = steamDetails(
      discovery,
      discoverySourceStatus,
      "failed",
      discoveryIssues.length > 0
        ? discoveryIssues
        : [`Steam discovery returned ${discovery.status}.`]
    );
    effectiveSettings = {
      status: "not_run",
      issues: configurationFailure === undefined
        ? []
        : [
          `Effective settings could not be resolved: ${errorMessage(configurationFailure)}`,
        ],
    };
  }

  let serverHandshake: VerificationStage = notRunStage();
  let toolRegistration: ToolRegistrationVerification = {
    status: "not_run",
    count: 0,
    names: [],
    issues: [],
  };

  if (effectiveSettings.status === "passed") {
    if (compiledServer.status !== "passed") {
      serverHandshake = failedStage(
        `Compiled server is not runnable: ${compiledServer.issues.join(" ")}`
      );
    } else {
      let session: ServerVerificationSession | undefined;
      try {
        session = createSession({
          command: dependencies.nodeCommand ?? process.execPath,
          serverPath,
          startupArguments,
          cwd: packageRoot,
          packageVersion: options.packageVersion,
        });
        await session.connect();
        serverHandshake = { status: "passed", issues: [] };
        try {
          const { tools } = await session.listTools();
          toolRegistration = inspectToolRegistration(tools);
        } catch (error) {
          toolRegistration = {
            status: "failed",
            count: 0,
            names: [],
            issues: [`Tool listing failed: ${errorMessage(error)}`],
          };
        }
      } catch (error) {
        serverHandshake = failedStage(
          `MCP server handshake failed: ${errorMessage(error)}`
        );
      } finally {
        if (session) {
          try {
            await session.close();
          } catch (error) {
            const issue = `MCP verification client close failed: ${errorMessage(error)}`;
            if (serverHandshake.status === "passed") {
              toolRegistration = {
                ...toolRegistration,
                status: "failed",
                issues: [...toolRegistration.issues, issue],
              };
            } else {
              serverHandshake.issues.push(issue);
            }
          }
        }
      }
    }
  }

  const report: ServerVerificationReport = {
    schemaVersion: SERVER_VERIFICATION_REPORT_SCHEMA_VERSION,
    generatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    success: false,
    nodeVersion: options.nodeVersion ?? process.version,
    serverPath,
    packageVersion: options.packageVersion,
    compiledServer,
    startupArguments,
    ...(explicitConfigPath(startupArguments, packageRoot) === undefined
      ? {}
      : { configPath: explicitConfigPath(startupArguments, packageRoot) }),
    steamDiscovery,
    effectiveSettings,
    serverHandshake,
    toolRegistration,
  };
  report.success = isServerVerificationSuccessful(report);
  return report;
}

function statusLine(label: string, stage: VerificationStage): string {
  return `${label.padEnd(24)}${stage.status.replace("_", " ")}`;
}

export function formatServerVerificationReport(
  report: ServerVerificationReport
): string {
  const lines = [
    "ReforgerForge MCP verification",
    "",
    `Node:       ${report.nodeVersion}`,
    `Server:     ${report.serverPath}`,
    `Version:    ${report.compiledServer.version ?? "unavailable"} (package ${report.packageVersion})`,
    `Config:     ${report.configPath ?? "none (automatic discovery and internal defaults)"}`,
    `Arguments:  ${report.startupArguments.length > 0
      ? JSON.stringify(report.startupArguments)
      : "none"}`,
    `Tools:      ${report.toolRegistration.count}`,
    "",
    statusLine("Compiled server:", report.compiledServer),
    statusLine("Steam discovery:", report.steamDiscovery),
    statusLine("Effective settings:", report.effectiveSettings),
    statusLine("Server handshake:", report.serverHandshake),
    statusLine("Tool registration:", report.toolRegistration),
  ];

  if (report.effectiveSettings.workbenchPath) {
    lines.push(
      "",
      `Tools path: ${report.effectiveSettings.workbenchPath}`,
      `Game path:  ${report.effectiveSettings.gamePath}`,
      `Addons:     ${(report.effectiveSettings.workbenchAddonDirs ?? []).join(", ") || "none"}`
    );
  }
  if (report.toolRegistration.names.length > 0) {
    lines.push("", `Registered tools: ${report.toolRegistration.names.join(", ")}`);
  }

  const issues = [
    ...report.compiledServer.issues,
    ...report.steamDiscovery.issues,
    ...report.effectiveSettings.issues,
    ...report.serverHandshake.issues,
    ...report.toolRegistration.issues,
  ];
  if (issues.length > 0) {
    lines.push("", "Issues:", ...issues.map((issue) => `  - ${issue}`));
  }
  return `${lines.join("\n")}\n`;
}

export function serializeServerVerificationReport(
  report: ServerVerificationReport
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeServerVerificationReportAtomic(
  reportPath: string,
  report: ServerVerificationReport
): Promise<void> {
  if (!isAbsolute(reportPath)) {
    throw new Error("Verification report path must be absolute.");
  }
  const temporaryPath = join(
    dirname(reportPath),
    `.${process.pid}-${randomUUID()}.verification.tmp`
  );
  try {
    await writeFile(
      temporaryPath,
      serializeServerVerificationReport(report),
      { encoding: "utf8", flag: "wx" }
    );
    await rename(temporaryPath, reportPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
