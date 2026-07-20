import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "../config.js";
import {
  canonicalizeExistingDirectory,
  isPathContained,
  pathComparisonKey,
} from "../foundation/managed-path.js";
import { getProperty, parse as parseEnfusionText } from "../formats/enfusion-text.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  type WorkbenchCompanionLaunch,
} from "./helper-addon.js";
import {
  revalidateProjectIdentity,
  type CanonicalProjectIdentity,
} from "./project-identity.js";
import {
  WorkbenchManagedBuildProfileError,
  validateWorkbenchManagedBuildProfile,
  type WorkbenchManagedBuildProfile,
} from "./managed-build-profile.js";
export {
  ensureWorkbenchManagedBuildProfile,
  type WorkbenchManagedBuildProfile,
} from "./managed-build-profile.js";
import {
  isLoopbackLifecycleHost,
  WORKBENCH_OWNER_ARG_PREFIX,
  WORKBENCH_PROCESS_NAME,
  type CanonicalProjectIdentity as LifecycleProjectIdentity,
  type LifecycleEndpoint,
} from "./process-guard.js";
export {
  isLoopbackLifecycleHost,
  WORKBENCH_PROCESS_NAME,
} from "./process-guard.js";
export type { LifecycleEndpoint as WorkbenchLaunchEndpoint } from "./process-guard.js";
import { toLifecycleTarget } from "./session-state.js";
export { toLifecycleTarget } from "./session-state.js";
export type { WorkbenchLifecycleTarget } from "./session-state.js";

const WORKBENCH_SUBDIRECTORY = "Workbench";
const MAX_BUILD_TIMEOUT_MS = 60 * 60 * 1_000;
const ADDON_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const ADDON_GUID_PATTERN = /^[A-Fa-f0-9]{16}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type WorkbenchLaunchPlanErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_TARGET"
  | "INVALID_OWNER_ARGUMENT"
  | "INVALID_ENDPOINT"
  | "INVALID_COMPANION"
  | "INVALID_BUILD"
  | "PATH_OVERLAP"
  | "INVALID_COMBINATION";

export class WorkbenchLaunchPlanError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchLaunchPlanErrorCode
  ) {
    super(message);
    this.name = "WorkbenchLaunchPlanError";
  }
}

export type WorkbenchLaunchConfiguration = Pick<
  Config,
  | "workbenchPath"
  | "gamePath"
  | "workbenchAddonDirs"
  | "workbenchScriptAuthorizeAll"
>;

export interface WorkbenchSpawnPolicy {
  readonly cwd: string;
  readonly detached: boolean;
  readonly stdio: "ignore";
  readonly windowsHide: boolean;
  /** Managed Workbench is always spawned directly, never through a shell. */
  readonly shell: false;
}

export interface WorkbenchCompanionReadinessPolicy {
  readonly kind: "companion_net_api";
  readonly endpoint: Readonly<LifecycleEndpoint>;
  readonly requireEndpointOwnership: true;
  readonly pingFunction: "EMCP_WB_Ping";
  readonly expected: Readonly<{
    addonId: typeof WORKBENCH_HELPER_ADDON_ID;
    addonGuid: typeof WORKBENCH_HELPER_ADDON_GUID;
    addonVersion: typeof WORKBENCH_HELPER_ADDON_VERSION;
    protocolVersion: typeof WORKBENCH_HELPER_PROTOCOL_VERSION;
    workbenchProtocol: typeof WORKBENCH_HELPER_PROTOCOL_VERSION;
    buildIdentity: typeof WORKBENCH_HELPER_BUILD_IDENTITY;
    bundleDigest: string;
  }>;
}

export interface WorkbenchTargetBuildIdentity {
  readonly addonId: string;
  readonly addonGuid: string;
  readonly sourceSha256: string;
}

interface WorkbenchLaunchPlanBase {
  readonly executablePath: string;
  readonly project: Readonly<CanonicalProjectIdentity>;
  readonly lifecycleTarget: Readonly<LifecycleProjectIdentity>;
  readonly addonDirectories: readonly string[];
  readonly ownerArgument: string;
  readonly argv: readonly string[];
  readonly spawnOptions: Readonly<WorkbenchSpawnPolicy>;
}

export interface McpEditorLaunchPlan extends WorkbenchLaunchPlanBase {
  readonly kind: "mcp_editor";
  readonly window: "visible";
  readonly process: "detached";
  readonly helper: Readonly<WorkbenchCompanionLaunch>;
  readonly readiness: Readonly<WorkbenchCompanionReadinessPolicy>;
  readonly lifetime: Readonly<{
    kind: "return_after_ready";
    supervised: true;
  }>;
}

export interface CliEditorLaunchPlan extends WorkbenchLaunchPlanBase {
  readonly kind: "cli_editor";
  readonly window: "visible";
  readonly process: "foreground";
  readonly helper: Readonly<WorkbenchCompanionLaunch>;
  readonly readiness: Readonly<WorkbenchCompanionReadinessPolicy>;
  readonly lifetime: Readonly<{
    kind: "wait_for_exit_or_abort";
    supervised: true;
  }>;
}

export interface TargetBuildLaunchPlan extends WorkbenchLaunchPlanBase {
  readonly kind: "target_build";
  readonly window: "hidden";
  readonly process: "foreground";
  readonly helper: null;
  readonly readiness: Readonly<{ kind: "none" }>;
  readonly lifetime: Readonly<{
    kind: "bounded_exit_and_output";
    timeoutMs: number;
    absoluteDeadline: true;
  }>;
  readonly platform: "PC";
  readonly outputPath: string;
  readonly buildProfile: Readonly<WorkbenchManagedBuildProfile>;
  readonly targetAddon: Readonly<WorkbenchTargetBuildIdentity>;
}

export type WorkbenchLaunchPlan =
  | McpEditorLaunchPlan
  | CliEditorLaunchPlan
  | TargetBuildLaunchPlan;

interface EditorLaunchPlanInputBase {
  readonly config: WorkbenchLaunchConfiguration;
  readonly project: CanonicalProjectIdentity;
  readonly companion: WorkbenchCompanionLaunch;
  readonly endpoint: LifecycleEndpoint;
  readonly ownerArgument: string;
  /** When supplied, all companion paths must remain beneath this private root. */
  readonly managedRoot?: string;
}

export interface McpEditorLaunchPlanInput extends EditorLaunchPlanInputBase {
  readonly kind: "mcp_editor";
}

export interface CliEditorLaunchPlanInput extends EditorLaunchPlanInputBase {
  readonly kind: "cli_editor";
}

export interface TargetBuildLaunchPlanInput {
  readonly kind: "target_build";
  readonly config: WorkbenchLaunchConfiguration;
  readonly project: CanonicalProjectIdentity;
  readonly ownerArgument: string;
  readonly managedProfile: WorkbenchManagedBuildProfile;
  readonly outputPath: string;
  readonly platform: "PC";
  readonly timeoutMs: number;
}

export type WorkbenchLaunchPlanInput =
  | McpEditorLaunchPlanInput
  | CliEditorLaunchPlanInput
  | TargetBuildLaunchPlanInput;

export interface LegacyWorkbenchCompanionLaunchArguments {
  readonly addonGuid: string;
  readonly addonSearchRoot: string;
  readonly workbenchProfilePath: string;
}

function planError(
  code: WorkbenchLaunchPlanErrorCode,
  message: string
): WorkbenchLaunchPlanError {
  return new WorkbenchLaunchPlanError(message, code);
}

function canonicalDirectory(path: string, label: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw planError("INVALID_CONFIG", `${label} must be a non-empty directory path.`);
  }
  const absolute = resolve(path.trim());
  try {
    return canonicalizeExistingDirectory(absolute, label);
  } catch (error) {
    throw planError(
      "INVALID_CONFIG",
      `${label} is not an accessible directory: ${absolute} ` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
}

function immutableProject(project: CanonicalProjectIdentity): Readonly<CanonicalProjectIdentity> {
  return Object.freeze({ ...project });
}

/** Resolve only the two supported locations for the exact diagnostic Workbench executable. */
export function resolveWorkbenchExecutablePath(
  config: Pick<WorkbenchLaunchConfiguration, "workbenchPath">
): string {
  if (!config || typeof config.workbenchPath !== "string" ||
      config.workbenchPath.trim().length === 0) {
    throw planError("INVALID_CONFIG", "MCP workbenchPath must be a non-empty directory path.");
  }
  const root = resolve(config.workbenchPath.trim());
  const candidates = [
    join(root, WORKBENCH_SUBDIRECTORY, WORKBENCH_PROCESS_NAME),
    join(root, WORKBENCH_PROCESS_NAME),
  ];
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync.native(candidate);
      if (!statSync(canonical).isFile()) continue;
      if (basename(canonical).toLowerCase() !== WORKBENCH_PROCESS_NAME.toLowerCase()) continue;
      return canonical;
    } catch {
      // Continue through the fixed, bounded candidate list.
    }
  }
  throw planError(
    "INVALID_CONFIG",
    `Cannot find the exact Workbench executable under configured path ${root}.`
  );
}

/** Canonicalize and order add-on roots without losing the caller's precedence. */
export function canonicalizeWorkbenchAddonDirectories(
  configured: readonly string[] | undefined
): readonly string[] {
  if (configured !== undefined && !Array.isArray(configured)) {
    throw planError("INVALID_CONFIG", "MCP workbenchAddonDirs must be an array of paths.");
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const entry of configured ?? []) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw planError(
        "INVALID_CONFIG",
        "Every MCP workbenchAddonDirs entry must be a non-empty path."
      );
    }
    if (entry.includes(",")) {
      throw planError(
        "INVALID_CONFIG",
        `Workbench add-on directory cannot contain a comma: ${entry}`
      );
    }
    const directory = canonicalDirectory(entry, "Workbench add-on root");
    const key = pathComparisonKey(directory);
    if (seen.has(key)) continue;
    seen.add(key);
    canonical.push(directory);
  }
  return Object.freeze(canonical);
}

function mergeAddonDirectories(
  configured: readonly string[] | undefined,
  extras: readonly string[]
): readonly string[] {
  return canonicalizeWorkbenchAddonDirectories([
    ...(configured ?? []),
    ...extras,
  ]);
}

function validateOwnerArgument(ownerArgument: string): string {
  if (typeof ownerArgument !== "string" ||
      !ownerArgument.startsWith(WORKBENCH_OWNER_ARG_PREFIX)) {
    throw planError(
      "INVALID_OWNER_ARGUMENT",
      `Workbench owner argument must use ${WORKBENCH_OWNER_ARG_PREFIX}.`
    );
  }
  const token = ownerArgument.slice(WORKBENCH_OWNER_ARG_PREFIX.length);
  if (token.length === 0 || token.trim() !== token || /[\u0000-\u001f\u007f\s]/.test(token)) {
    throw planError(
      "INVALID_OWNER_ARGUMENT",
      "Workbench owner argument must contain one non-empty, whitespace-free token."
    );
  }
  return ownerArgument;
}

function validateEndpoint(endpoint: LifecycleEndpoint): Readonly<LifecycleEndpoint> {
  const host = endpoint?.host?.trim().toLowerCase();
  const port = endpoint?.port;
  if (!host || !isLoopbackLifecycleHost(host) ||
      !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw planError(
      "INVALID_ENDPOINT",
      "Managed editor plans require a numeric loopback NET API endpoint and valid port."
    );
  }
  return Object.freeze({ host, port });
}

function validateCompanion(
  companion: WorkbenchCompanionLaunch,
  project: CanonicalProjectIdentity,
  managedRootPath?: string
): Readonly<WorkbenchCompanionLaunch> {
  if (!companion || typeof companion !== "object" ||
      companion.addonId !== WORKBENCH_HELPER_ADDON_ID ||
      companion.addonGuid !== WORKBENCH_HELPER_ADDON_GUID ||
      companion.addonVersion !== WORKBENCH_HELPER_ADDON_VERSION ||
      companion.protocolVersion !== WORKBENCH_HELPER_PROTOCOL_VERSION ||
      companion.buildIdentity !== WORKBENCH_HELPER_BUILD_IDENTITY ||
      typeof companion.reused !== "boolean" ||
      !ADDON_GUID_PATTERN.test(companion.addonGuid) ||
      !SHA256_PATTERN.test(companion.bundleDigest)) {
    throw planError(
      "INVALID_COMPANION",
      "The managed Workbench companion has an invalid immutable identity."
    );
  }

  const addonSearchRoot = canonicalDirectory(
    companion.addonSearchRoot,
    "Workbench companion add-on search root"
  );
  const addonDirectory = canonicalDirectory(
    companion.addonDirectory,
    "Workbench companion add-on directory"
  );
  const profilePath = canonicalDirectory(
    companion.workbenchProfilePath,
    "Workbench companion profile"
  );
  if (!isPathContained(addonSearchRoot, addonDirectory) ||
      basename(addonDirectory) !== WORKBENCH_HELPER_ADDON_ID) {
    throw planError(
      "INVALID_COMPANION",
      "The managed Workbench companion add-on escapes or disagrees with its search root."
    );
  }

  for (const managedPath of [addonSearchRoot, addonDirectory, profilePath]) {
    if (pathsOverlap(project.modDirectory, managedPath)) {
      throw planError(
        "PATH_OVERLAP",
        "Workbench companion add-on and profile paths must not overlap the target project."
      );
    }
  }

  if (managedRootPath !== undefined) {
    const managedRoot = canonicalDirectory(managedRootPath, "Workbench managed root");
    if (pathsOverlap(project.modDirectory, managedRoot)) {
      throw planError("PATH_OVERLAP", "Workbench managed root must not overlap the target project.");
    }
    for (const managedPath of [addonSearchRoot, addonDirectory, profilePath]) {
      if (!isPathContained(managedRoot, managedPath)) {
        throw planError(
          "INVALID_COMPANION",
          "Workbench companion paths must remain beneath the declared managed root."
        );
      }
    }
  }

  return Object.freeze({
    ...companion,
    addonSearchRoot,
    addonDirectory,
    workbenchProfilePath: profilePath,
  });
}

function rejectDuplicateCompanion(
  addonDirectories: readonly string[],
  companion: Readonly<WorkbenchCompanionLaunch>
): void {
  for (const root of addonDirectories) {
    const candidate = join(root, companion.addonId);
    if (!existsSync(candidate)) continue;
    let canonicalCandidate: string;
    try {
      canonicalCandidate = realpathSync.native(candidate);
    } catch (error) {
      throw planError(
        "INVALID_COMPANION",
        `Configured Workbench add-on root contains an unreadable helper candidate: ${candidate} ` +
          `(${error instanceof Error ? error.message : String(error)})`
      );
    }
    if (pathComparisonKey(canonicalCandidate) !== pathComparisonKey(companion.addonDirectory)) {
      throw planError(
        "INVALID_COMPANION",
        `Configured Workbench add-on root contains a second ${companion.addonId}: ` +
          `${canonicalCandidate}`
      );
    }
  }
}

function companionReadiness(
  endpoint: LifecycleEndpoint,
  companion: Readonly<WorkbenchCompanionLaunch>
): Readonly<WorkbenchCompanionReadinessPolicy> {
  return Object.freeze({
    kind: "companion_net_api",
    endpoint: validateEndpoint(endpoint),
    requireEndpointOwnership: true,
    pingFunction: "EMCP_WB_Ping",
    expected: Object.freeze({
      addonId: WORKBENCH_HELPER_ADDON_ID,
      addonGuid: WORKBENCH_HELPER_ADDON_GUID,
      addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
      protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
      workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
      buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
      bundleDigest: companion.bundleDigest,
    }),
  });
}

function resolveMcpWorkingDirectory(
  config: WorkbenchLaunchConfiguration,
  executablePath: string
): string {
  const configuredCandidates = [
    config.gamePath,
    process.env.ENFUSION_GAME_PATH,
    resolve(config.workbenchPath, "..", "Arma Reforger"),
    resolve(config.workbenchPath, "..", "ArmaReforger"),
    resolve(config.workbenchPath, "..", "..", "Arma Reforger"),
    resolve(config.workbenchPath, "..", "..", "ArmaReforger"),
  ];
  for (const candidate of configuredCandidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    try {
      const canonical = realpathSync.native(resolve(candidate.trim()));
      if (statSync(canonical).isDirectory() && statSync(join(canonical, "addons")).isDirectory()) {
        return canonical;
      }
    } catch {
      // Fall back to the executable directory, matching the existing MCP policy.
    }
  }
  return dirname(executablePath);
}

function spawnPolicy(
  cwd: string,
  detached: boolean,
  windowsHide: boolean
): Readonly<WorkbenchSpawnPolicy> {
  return Object.freeze({
    cwd,
    detached,
    stdio: "ignore",
    windowsHide,
    shell: false,
  });
}

function immutableArguments(args: string[], ownerArgument: string): readonly string[] {
  const ownerArguments = args.filter((arg) => arg.startsWith(WORKBENCH_OWNER_ARG_PREFIX));
  if (ownerArguments.length !== 1 || ownerArguments[0] !== ownerArgument) {
    throw planError(
      "INVALID_OWNER_ARGUMENT",
      "Managed Workbench launch arguments must contain exactly one exact owner-token slot."
    );
  }
  if (!args.includes("-noThrow")) {
    throw planError("INVALID_COMBINATION", "Every managed Workbench plan must include -noThrow.");
  }
  return Object.freeze([...args]);
}

function assertNoFields(value: object, fields: readonly string[], kind: string): void {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw planError(
        "INVALID_COMBINATION",
        `${kind} launch plans do not accept the ${field} policy override.`
      );
    }
  }
}

function editorArguments(
  kind: "mcp_editor" | "cli_editor",
  addonDirectories: readonly string[],
  companion: Readonly<WorkbenchCompanionLaunch>,
  project: CanonicalProjectIdentity,
  scriptAuthorizeAll: boolean,
  ownerArgument: string
): readonly string[] {
  const args: string[] = [];
  if (addonDirectories.length > 0) args.push("-addonsDir", addonDirectories.join(","));
  if (kind === "mcp_editor") {
    args.push(
      "-addons",
      companion.addonGuid,
      "-profile",
      companion.workbenchProfilePath,
      "-gproj",
      project.displayPath
    );
    if (scriptAuthorizeAll) args.push("-scriptAuthorizeAll");
    args.push("-noThrow", ownerArgument);
  } else {
    args.push("-profile", companion.workbenchProfilePath, "-noThrow");
    if (scriptAuthorizeAll) args.push("-scriptAuthorizeAll");
    args.push(
      "-addons",
      companion.addonGuid,
      "-gproj",
      project.displayPath,
      ownerArgument,
      "-wbModule=WorldEditor",
      "-run"
    );
  }
  return immutableArguments(args, ownerArgument);
}

/**
 * @deprecated Stage-2 argument-only compatibility surface. New launch sites
 * must construct one of the three discriminated Workbench launch plans.
 * Retained through Stage 6 for published callers of `WorkbenchClient`.
 */
export function buildLegacyWorkbenchLaunchArguments(
  gprojPath?: string | null,
  configuredAddonDirs?: readonly string[],
  scriptAuthorizeAll = false,
  noThrow = false,
  ownerArgument?: string,
  companion?: LegacyWorkbenchCompanionLaunchArguments
): string[] {
  const args: string[] = [];
  const addonDirs: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];

  if (configuredAddonDirs !== undefined && !Array.isArray(configuredAddonDirs)) {
    throw planError(
      "INVALID_CONFIG",
      "Workbench addon directories must be configured as an array of paths."
    );
  }
  const requestedAddonDirs = [
    ...(configuredAddonDirs ?? []),
    ...(companion ? [companion.addonSearchRoot] : []),
  ];
  for (const configuredDir of requestedAddonDirs) {
    if (typeof configuredDir !== "string" || configuredDir.trim().length === 0) {
      throw planError(
        "INVALID_CONFIG",
        "Workbench addon directories must be non-empty paths."
      );
    }
    const configuredPath = configuredDir.trim();
    if (configuredPath.includes(",")) {
      throw planError(
        "INVALID_CONFIG",
        `Workbench addon directory cannot contain a comma: ${configuredPath}`
      );
    }
    const addonDir = resolve(configuredPath);
    const key = pathComparisonKey(addonDir);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!statSync(addonDir).isDirectory()) invalid.push(addonDir);
      else addonDirs.push(addonDir);
    } catch {
      invalid.push(addonDir);
    }
  }
  if (invalid.length > 0) {
    const description = invalid.length === 1
      ? "Configured Workbench addon path is not a directory"
      : "Configured Workbench addon paths are not directories";
    throw planError(
      "INVALID_CONFIG",
      `${description}:\n${invalid.map((path) => `  - ${path}`).join("\n")}`
    );
  }
  if (addonDirs.length > 0) args.push("-addonsDir", addonDirs.join(","));
  if (companion) {
    if (!ADDON_GUID_PATTERN.test(companion.addonGuid)) {
      throw planError("INVALID_COMPANION", "Workbench companion add-on GUID is invalid.");
    }
    const profilePath = resolve(companion.workbenchProfilePath);
    try {
      if (!statSync(profilePath).isDirectory()) throw new Error("not a directory");
    } catch {
      throw planError(
        "INVALID_COMPANION",
        `Workbench companion profile path is not a directory: ${profilePath}`
      );
    }
    args.push("-addons", companion.addonGuid, "-profile", profilePath);
  }
  if (gprojPath) args.push("-gproj", gprojPath);
  if (scriptAuthorizeAll) args.push("-scriptAuthorizeAll");
  if (noThrow) args.push("-noThrow");
  if (ownerArgument) args.push(ownerArgument);
  return args;
}

function preparedEditorInput(
  input: McpEditorLaunchPlanInput | CliEditorLaunchPlanInput
): {
  executablePath: string;
  project: CanonicalProjectIdentity;
  companion: Readonly<WorkbenchCompanionLaunch>;
  addonDirectories: readonly string[];
  ownerArgument: string;
  readiness: Readonly<WorkbenchCompanionReadinessPolicy>;
} {
  assertNoFields(input, [
    "managedProfile",
    "outputPath",
    "platform",
    "timeoutMs",
    "argv",
    "spawnOptions",
    "foreground",
    "detached",
    "windowsHide",
    "shell",
    "noThrow",
    "run",
    "module",
  ], input.kind);
  const project = revalidateProjectIdentity(input.project);
  const executablePath = resolveWorkbenchExecutablePath(input.config);
  const ownerArgument = validateOwnerArgument(input.ownerArgument);
  const companion = validateCompanion(input.companion, project, input.managedRoot);
  const targetAddonSearchRoot = canonicalDirectory(
    dirname(project.modDirectory),
    "Workbench target add-on search root"
  );
  const extras = input.kind === "cli_editor"
    ? [targetAddonSearchRoot, companion.addonSearchRoot]
    : [companion.addonSearchRoot];
  const addonDirectories = mergeAddonDirectories(input.config.workbenchAddonDirs, extras);
  rejectDuplicateCompanion(addonDirectories, companion);
  return {
    executablePath,
    project,
    companion,
    addonDirectories,
    ownerArgument,
    readiness: companionReadiness(input.endpoint, companion),
  };
}

export function buildMcpEditorLaunchPlan(
  input: McpEditorLaunchPlanInput
): McpEditorLaunchPlan {
  const prepared = preparedEditorInput(input);
  const project = immutableProject(prepared.project);
  return Object.freeze({
    kind: "mcp_editor",
    window: "visible",
    process: "detached",
    executablePath: prepared.executablePath,
    project,
    lifecycleTarget: toLifecycleTarget(prepared.project),
    addonDirectories: prepared.addonDirectories,
    ownerArgument: prepared.ownerArgument,
    argv: editorArguments(
      "mcp_editor",
      prepared.addonDirectories,
      prepared.companion,
      prepared.project,
      input.config.workbenchScriptAuthorizeAll === true,
      prepared.ownerArgument
    ),
    spawnOptions: spawnPolicy(
      resolveMcpWorkingDirectory(input.config, prepared.executablePath),
      true,
      false
    ),
    helper: prepared.companion,
    readiness: prepared.readiness,
    lifetime: Object.freeze({ kind: "return_after_ready", supervised: true }),
  });
}

export function buildCliEditorLaunchPlan(
  input: CliEditorLaunchPlanInput
): CliEditorLaunchPlan {
  const prepared = preparedEditorInput(input);
  const project = immutableProject(prepared.project);
  return Object.freeze({
    kind: "cli_editor",
    window: "visible",
    process: "foreground",
    executablePath: prepared.executablePath,
    project,
    lifecycleTarget: toLifecycleTarget(prepared.project),
    addonDirectories: prepared.addonDirectories,
    ownerArgument: prepared.ownerArgument,
    argv: editorArguments(
      "cli_editor",
      prepared.addonDirectories,
      prepared.companion,
      prepared.project,
      input.config.workbenchScriptAuthorizeAll === true,
      prepared.ownerArgument
    ),
    spawnOptions: spawnPolicy(dirname(prepared.executablePath), false, false),
    helper: prepared.companion,
    readiness: prepared.readiness,
    lifetime: Object.freeze({ kind: "wait_for_exit_or_abort", supervised: true }),
  });
}

function resolveTargetBuildIdentity(project: CanonicalProjectIdentity): WorkbenchTargetBuildIdentity {
  let source: Buffer;
  let document;
  try {
    source = readFileSync(project.displayPath);
    document = parseEnfusionText(source.toString("utf8"));
  } catch (error) {
    throw planError(
      "INVALID_TARGET",
      `Workbench build project could not be parsed: ${project.displayPath} ` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }
  const addonId = document.type === "GameProject" ? getProperty(document, "ID") : undefined;
  const addonGuid = document.type === "GameProject" ? getProperty(document, "GUID") : undefined;
  if (typeof addonId !== "string" || !ADDON_ID_PATTERN.test(addonId) ||
      typeof addonGuid !== "string" || !ADDON_GUID_PATTERN.test(addonGuid)) {
    throw planError(
      "INVALID_TARGET",
      `Workbench build project must declare one safe GameProject ID and GUID: ` +
        `${project.displayPath}`
    );
  }
  return Object.freeze({
    addonId,
    addonGuid: addonGuid.toUpperCase(),
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  });
}

function validateOutputPath(
  outputPath: string,
  project: CanonicalProjectIdentity,
  profile: Readonly<WorkbenchManagedBuildProfile>
): string {
  const output = canonicalDirectory(outputPath, "Workbench build output");
  if (pathsOverlap(output, project.modDirectory)) {
    throw planError("PATH_OVERLAP", "Workbench build output must not overlap the target project.");
  }
  if (pathsOverlap(output, profile.managedRoot)) {
    throw planError("PATH_OVERLAP", "Workbench build output must not overlap the managed root.");
  }
  return output;
}

export function buildTargetBuildLaunchPlan(
  input: TargetBuildLaunchPlanInput
): TargetBuildLaunchPlan {
  assertNoFields(input, [
    "companion",
    "endpoint",
    "managedRoot",
    "argv",
    "spawnOptions",
    "foreground",
    "detached",
    "windowsHide",
    "shell",
    "noThrow",
    "run",
    "module",
  ], input.kind);
  if (input.platform !== "PC") {
    throw planError("INVALID_BUILD", "Structured Workbench builds support only platform PC.");
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 ||
      input.timeoutMs > MAX_BUILD_TIMEOUT_MS) {
    throw planError(
      "INVALID_BUILD",
      `Target build timeoutMs must be between 1 and ${MAX_BUILD_TIMEOUT_MS}.`
    );
  }

  const projectIdentity = revalidateProjectIdentity(input.project);
  const project = immutableProject(projectIdentity);
  const executablePath = resolveWorkbenchExecutablePath(input.config);
  const ownerArgument = validateOwnerArgument(input.ownerArgument);
  let buildProfile: Readonly<WorkbenchManagedBuildProfile>;
  try {
    buildProfile = validateWorkbenchManagedBuildProfile(input.managedProfile, projectIdentity);
  } catch (error) {
    if (error instanceof WorkbenchManagedBuildProfileError) {
      throw planError(error.code, error.message);
    }
    throw error;
  }
  const outputPath = validateOutputPath(input.outputPath, projectIdentity, buildProfile);
  const targetAddon = resolveTargetBuildIdentity(projectIdentity);
  const targetAddonSearchRoot = canonicalDirectory(
    dirname(projectIdentity.modDirectory),
    "Workbench target add-on search root"
  );
  const addonDirectories = mergeAddonDirectories(
    input.config.workbenchAddonDirs,
    [targetAddonSearchRoot]
  );
  for (const addonDirectory of addonDirectories) {
    if (pathsOverlap(addonDirectory, buildProfile.managedRoot)) {
      throw planError(
        "INVALID_BUILD",
        "Target-build add-on roots must not include the private managed root or helper roots."
      );
    }
    // The helper can also be supplied from an externally configured add-on
    // search root that does not overlap this process's managed directory.
    // Target-only plans must reject that capability by identity, not merely by
    // checking the default managed path.
    const helperCandidate = basename(addonDirectory).toLowerCase() ===
      WORKBENCH_HELPER_ADDON_ID.toLowerCase()
      ? addonDirectory
      : join(addonDirectory, WORKBENCH_HELPER_ADDON_ID);
    try {
      if (existsSync(helperCandidate) && statSync(helperCandidate).isDirectory()) {
        throw planError(
          "INVALID_BUILD",
          `Target-build add-on roots must not expose ${WORKBENCH_HELPER_ADDON_ID}.`
        );
      }
    } catch (error) {
      if (error instanceof WorkbenchLaunchPlanError) throw error;
      throw planError(
        "INVALID_BUILD",
        `Target-build helper exclusion could not be proven for ${addonDirectory}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const args: string[] = [];
  if (addonDirectories.length > 0) args.push("-addonsDir", addonDirectories.join(","));
  args.push("-profile", buildProfile.profilePath, "-noThrow");
  if (input.config.workbenchScriptAuthorizeAll === true) args.push("-scriptAuthorizeAll");
  args.push(
    "-gproj",
    projectIdentity.displayPath,
    "-gprojConfig",
    input.platform,
    ownerArgument,
    "-wbModule=ResourceManager",
    "-builddata",
    input.platform,
    outputPath,
    targetAddon.addonId
  );
  const argv = immutableArguments(args, ownerArgument);
  if (argv.includes("-run") || argv.includes("-addons") ||
      argv.includes(WORKBENCH_HELPER_ADDON_GUID)) {
    throw planError(
      "INVALID_BUILD",
      "Target-build arguments must not activate or reference the Workbench editor helper."
    );
  }

  return Object.freeze({
    kind: "target_build",
    window: "hidden",
    process: "foreground",
    executablePath,
    project,
    lifecycleTarget: toLifecycleTarget(projectIdentity),
    addonDirectories,
    ownerArgument,
    argv,
    spawnOptions: spawnPolicy(dirname(executablePath), false, true),
    helper: null,
    readiness: Object.freeze({ kind: "none" }),
    lifetime: Object.freeze({
      kind: "bounded_exit_and_output",
      timeoutMs: input.timeoutMs,
      absoluteDeadline: true,
    }),
    platform: input.platform,
    outputPath,
    buildProfile,
    targetAddon,
  });
}

export function buildWorkbenchLaunchPlan(
  input: WorkbenchLaunchPlanInput
): WorkbenchLaunchPlan {
  if (!input || typeof input !== "object") {
    throw planError("INVALID_COMBINATION", "Workbench launch plan input must be an object.");
  }
  switch (input.kind) {
    case "mcp_editor":
      return buildMcpEditorLaunchPlan(input);
    case "cli_editor":
      return buildCliEditorLaunchPlan(input);
    case "target_build":
      return buildTargetBuildLaunchPlan(input);
    default:
      throw planError(
        "INVALID_COMBINATION",
        `Unsupported Workbench launch plan kind: ${String((input as { kind?: unknown }).kind)}`
      );
  }
}
