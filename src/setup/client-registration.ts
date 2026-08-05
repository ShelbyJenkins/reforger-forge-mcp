import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isSeq, parseDocument } from "yaml";
import { buildManagedMcpServerArguments } from "../mcp-host-identity.js";

export const SUPPORTED_CLIENT_IDS = [
  "codex",
  "cursor",
  "antigravity",
  "claude-desktop",
  "claude-code",
  "windsurf",
  "vscode",
  "continue",
  "kiro",
] as const;

export type SupportedClientId = (typeof SUPPORTED_CLIENT_IDS)[number];

export type ClientRegistrationStatus =
  | "updated"
  | "already_current"
  | "not_detected"
  | "detection_failed"
  | "manual_setup_required"
  | "failed";

export type ClientInspectionStatus =
  | "current"
  | "not_registered"
  | "different"
  | "not_detected"
  | "detection_failed"
  | "manual_setup_required"
  | "failed";

export type ClientRegistrationTarget =
  | {
      readonly kind: "config_file";
      readonly scope: "user";
      readonly path?: string;
    }
  | {
      readonly kind: "client_cli";
      readonly scope: "user";
      readonly command: string;
    };

export interface ClientManagedChange {
  readonly clientId: SupportedClientId;
  readonly clientName: string;
  readonly kind: "client_cli";
  readonly command: string;
  readonly scope: "user";
  readonly configFile: null;
  readonly configFileVerification: "unverified";
  readonly detail: string;
}

interface ClientReceipt {
  readonly id: SupportedClientId;
  readonly name: string;
  readonly target: ClientRegistrationTarget;
  readonly detail?: string;
  readonly manual: string;
  readonly modifiedFiles: readonly string[];
  readonly backupFiles: readonly string[];
  readonly managedChanges?: readonly ClientManagedChange[];
  readonly nextActions: readonly string[];
}

export interface ClientRegistrationReceipt extends ClientReceipt {
  readonly status: ClientRegistrationStatus;
}

export interface ClientInspectionReceipt extends ClientReceipt {
  readonly status: ClientInspectionStatus;
}

export interface ClientRegistrationSummary {
  readonly serverPath: string;
  readonly receipts: readonly ClientRegistrationReceipt[];
  readonly hasFailures: boolean;
}

export interface ClientInspectionSummary {
  readonly serverPath: string;
  readonly receipts: readonly ClientInspectionReceipt[];
  readonly hasFailures: boolean;
}

export type PathProbeResult =
  | { readonly status: "present" }
  | { readonly status: "absent" }
  | { readonly status: "error"; readonly message: string };

export type PathEvidenceKind = "file" | "directory";

export type CommandLookupResult =
  | { readonly status: "found"; readonly path: string }
  | { readonly status: "not_found" }
  | { readonly status: "error"; readonly message: string };

export type ClaudeCodeExtensionCommandFinder = (
  extensionRoots: readonly string[],
  architecture: NodeJS.Architecture
) => CommandLookupResult;

export interface CommandExecutionResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface ClientRegistrationOptions {
  readonly serverPath: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly probePath?: (
    path: string,
    expectedKind?: PathEvidenceKind
  ) => PathProbeResult;
  readonly probeDirectoryPrefix?: (
    parent: string,
    prefix: string
  ) => PathProbeResult;
  readonly findCommand?: (command: string) => CommandLookupResult;
  readonly findClaudeCodeExtensionCommand?:
    ClaudeCodeExtensionCommandFinder;
  readonly architecture?: NodeJS.Architecture;
  readonly runCommand?: (
    command: string,
    args: readonly string[]
  ) => CommandExecutionResult;
  readonly now?: () => Date;
}

interface ClientPaths {
  readonly home: string;
  readonly appData?: string;
  readonly localAppData?: string;
  readonly programFiles?: string;
  readonly programFilesX86?: string;
  readonly claudeConfigDirectory: string;
  readonly claudeUserConfigPath: string;
  readonly vscodeExtensionRoots: readonly string[];
  readonly kiroHome: string;
}

interface PathEvidence {
  readonly path: string;
  readonly kind: PathEvidenceKind;
}

interface DetectionContext {
  readonly paths: ClientPaths;
  readonly probePath: (
    path: string,
    expectedKind?: PathEvidenceKind
  ) => PathProbeResult;
  readonly probeDirectoryPrefix: (
    parent: string,
    prefix: string
  ) => PathProbeResult;
  readonly findCommand: (command: string) => CommandLookupResult;
  readonly findClaudeCodeExtensionCommand:
    ClaudeCodeExtensionCommandFinder;
  readonly architecture: NodeJS.Architecture;
}

interface RegistrationContext extends DetectionContext {
  readonly serverPath: string;
  readonly runCommand: (
    command: string,
    args: readonly string[]
  ) => CommandExecutionResult;
  readonly now: () => Date;
}

interface ClientDetection {
  readonly status: "detected" | "not_detected" | "detection_failed";
  readonly commandPath?: string;
  readonly detail?: string;
}

interface RegistrationResult {
  readonly status:
    | "updated"
    | "already_current"
    | "manual_setup_required";
  readonly detail?: string;
  readonly target: ClientRegistrationTarget;
  readonly modifiedFiles: readonly string[];
  readonly backupFiles: readonly string[];
}

interface InspectionResult {
  readonly status:
    | "current"
    | "not_registered"
    | "different"
    | "manual_setup_required";
  readonly detail?: string;
  readonly target: ClientRegistrationTarget;
}

interface ClientDefinition {
  readonly id: SupportedClientId;
  readonly name: string;
  readonly commands: readonly string[];
  readonly evidence: (paths: ClientPaths) => readonly PathEvidence[];
  readonly prefixEvidence?: (
    paths: ClientPaths
  ) => readonly { readonly parent: string; readonly prefix: string }[];
  readonly resolveCommand?: (
    context: DetectionContext
  ) => CommandLookupResult;
  readonly manual: string;
  readonly fallbackTarget: ClientRegistrationTarget;
  readonly target: (
    context: DetectionContext,
    detection: ClientDetection
  ) => ClientRegistrationTarget;
  readonly register: (
    context: RegistrationContext,
    detection: ClientDetection,
    clientLabel: SupportedClientId
  ) => RegistrationResult;
  readonly inspect: (
    context: RegistrationContext,
    detection: ClientDetection,
    clientLabel: SupportedClientId
  ) => InspectionResult;
}

export interface JsonRegistrationUpdateOptions {
  readonly path: string;
  readonly rootKey: string;
  readonly entry: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
}

export interface ConfigFileUpdateResult {
  readonly status: "updated" | "already_current";
  readonly backupPath?: string;
}

interface OriginalFile {
  readonly bytes: Buffer;
  readonly modifiedMilliseconds: number;
  readonly size: number;
}

class ConfigMutationError extends Error {
  readonly modifiedFiles: readonly string[];
  readonly backupFiles: readonly string[];

  constructor(
    message: string,
    modifiedFiles: readonly string[],
    backupFiles: readonly string[]
  ) {
    super(message);
    this.name = "ConfigMutationError";
    this.modifiedFiles = modifiedFiles;
    this.backupFiles = backupFiles;
  }
}

class ClientManagedMutationError extends Error {
  readonly managedChanges: readonly ClientManagedChange[];

  constructor(
    message: string,
    managedChanges: readonly ClientManagedChange[]
  ) {
    super(message);
    this.name = "ClientManagedMutationError";
    this.managedChanges = managedChanges;
  }
}

const SERVER_NAME = "reforger-forge";
const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

function configFileTarget(path?: string): ClientRegistrationTarget {
  return { kind: "config_file", scope: "user", path };
}

function clientCliTarget(command: string): ClientRegistrationTarget {
  return { kind: "client_cli", scope: "user", command };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalJoin(
  root: string | undefined,
  ...segments: readonly string[]
): string | undefined {
  return root ? join(root, ...segments) : undefined;
}

function presentPaths(
  paths: readonly (string | undefined)[]
): readonly string[] {
  return paths.filter((path): path is string => path !== undefined);
}

function fileEvidence(
  paths: readonly (string | undefined)[]
): readonly PathEvidence[] {
  return presentPaths(paths).map((path) => ({ path, kind: "file" }));
}

function directoryEvidence(
  paths: readonly (string | undefined)[]
): readonly PathEvidence[] {
  return presentPaths(paths).map((path) => ({ path, kind: "directory" }));
}

function defaultProbePath(
  path: string,
  expectedKind?: PathEvidenceKind
): PathProbeResult {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      return {
        status: "error",
        message: `Expected ${expectedKind ?? "client evidence"}, but found a symbolic link.`,
      };
    }
    if (
      (expectedKind === "file" && !metadata.isFile()) ||
      (expectedKind === "directory" && !metadata.isDirectory())
    ) {
      return {
        status: "error",
        message: `Expected a ${expectedKind}, but found a different filesystem object.`,
      };
    }
    return { status: "present" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { status: "absent" }
      : { status: "error", message: errorMessage(error) };
  }
}

function defaultProbeDirectoryPrefix(
  parent: string,
  prefix: string
): PathProbeResult {
  try {
    const entries = readdirSync(parent, { withFileTypes: true });
    const matching = entries.filter((entry) =>
      entry.name
        .toLocaleLowerCase("en-US")
        .startsWith(prefix.toLocaleLowerCase("en-US"))
    );
    if (matching.some((entry) => entry.isDirectory())) {
      return { status: "present" };
    }
    if (matching.some((entry) => entry.isSymbolicLink())) {
      return {
        status: "error",
        message: `A matching '${prefix}*' path is a symbolic link.`,
      };
    }
    return { status: "absent" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { status: "absent" }
      : { status: "error", message: errorMessage(error) };
  }
}

const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";
const MAX_EXTENSION_METADATA_BYTES = 8 * 1024 * 1024;

interface ParsedExtensionVersion {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: readonly string[];
}

interface ClaudeCodeExtensionLocation {
  readonly root: string;
  readonly relativeLocation: string;
  readonly expectedVersion?: string;
  readonly targetPlatform?: string;
}

interface ClaudeCodeExtensionCandidate {
  readonly path: string;
  readonly version: ParsedExtensionVersion;
  readonly rootPriority: number;
}

function parseExtensionVersion(
  value: string
): ParsedExtensionVersion | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/
      .exec(value);
  if (!match) return undefined;
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined
      ? {}
      : { prerelease: match[4].split(".") }),
  };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumber = /^(0|[1-9]\d*)$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^(0|[1-9]\d*)$/.test(right)
    ? Number(right)
    : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber - rightNumber;
  }
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right, "en-US");
}

function compareExtensionVersions(
  left: ParsedExtensionVersion,
  right: ParsedExtensionVersion
): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  if (left.prerelease === undefined && right.prerelease === undefined) {
    return 0;
  }
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const difference = comparePrereleaseIdentifiers(leftPart, rightPart);
    if (difference !== 0) return difference;
  }
  return 0;
}

function optionalMetadata(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireRegularDirectory(path: string, label: string): boolean {
  const metadata = optionalMetadata(path);
  if (!metadata) return false;
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link: ${path}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  return true;
}

function readExtensionJson(
  path: string,
  label: string
): unknown | undefined {
  const metadata = optionalMetadata(path);
  if (!metadata) return undefined;
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link: ${path}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
  if (
    metadata.size < 1 ||
    metadata.size > MAX_EXTENSION_METADATA_BYTES
  ) {
    throw new Error(
      `${label} has an unsupported size (${metadata.size} bytes): ${path}`
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function pathIsContained(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return (
    relation.length > 0 &&
    !relation.startsWith(`..${sep}`) &&
    relation !== ".." &&
    !isAbsolute(relation)
  );
}

function readObsoleteClaudeLocations(root: string): ReadonlySet<string> {
  const document = readExtensionJson(
    join(root, ".obsolete"),
    "VS Code extension obsolete registry"
  );
  if (document === undefined) return new Set();
  if (!isRecord(document)) {
    throw new Error("VS Code extension obsolete registry must be an object.");
  }
  const obsolete = new Set<string>();
  for (const [key, value] of Object.entries(document)) {
    if (typeof value !== "boolean") {
      throw new Error(
        "VS Code extension obsolete registry values must be booleans."
      );
    }
    if (value) obsolete.add(key.toLocaleLowerCase("en-US"));
  }
  return obsolete;
}

function catalogClaudeLocations(
  root: string,
  obsolete: ReadonlySet<string>
): readonly ClaudeCodeExtensionLocation[] | undefined {
  const document = readExtensionJson(
    join(root, "extensions.json"),
    "VS Code extension catalog"
  );
  if (document === undefined) return undefined;
  if (!Array.isArray(document)) {
    throw new Error("VS Code extension catalog must be an array.");
  }
  const locations: ClaudeCodeExtensionLocation[] = [];
  for (const entry of document) {
    if (!isRecord(entry) || !isRecord(entry.identifier)) continue;
    const identifier = entry.identifier.id;
    if (
      typeof identifier !== "string" ||
      identifier.toLocaleLowerCase("en-US") !== CLAUDE_CODE_EXTENSION_ID
    ) {
      continue;
    }
    if (
      typeof entry.version !== "string" ||
      !parseExtensionVersion(entry.version) ||
      typeof entry.relativeLocation !== "string" ||
      entry.relativeLocation.trim().length === 0
    ) {
      throw new Error(
        "Anthropic Claude Code catalog entry has invalid version or location metadata."
      );
    }
    const relativeLocation = entry.relativeLocation.trim();
    if (
      basename(relativeLocation) !== relativeLocation ||
      relativeLocation === "." ||
      relativeLocation === ".."
    ) {
      throw new Error(
        `Anthropic Claude Code catalog location is unsafe: ${relativeLocation}`
      );
    }
    if (obsolete.has(relativeLocation.toLocaleLowerCase("en-US"))) continue;
    const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
    const targetPlatform = metadata?.targetPlatform;
    if (
      targetPlatform !== undefined &&
      typeof targetPlatform !== "string"
    ) {
      throw new Error(
        "Anthropic Claude Code targetPlatform metadata must be a string."
      );
    }
    locations.push({
      root,
      relativeLocation,
      expectedVersion: entry.version,
      ...(targetPlatform === undefined ? {} : { targetPlatform }),
    });
  }
  return locations;
}

function enumeratedClaudeLocations(
  root: string,
  obsolete: ReadonlySet<string>
): readonly ClaudeCodeExtensionLocation[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const prefix = `${CLAUDE_CODE_EXTENSION_ID}-`;
  const locations: ClaudeCodeExtensionLocation[] = [];
  for (const entry of entries) {
    if (
      !entry.name.toLocaleLowerCase("en-US").startsWith(prefix) ||
      obsolete.has(entry.name.toLocaleLowerCase("en-US"))
    ) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Anthropic Claude Code extension location is a symbolic link: ${join(root, entry.name)}`
      );
    }
    if (!entry.isDirectory()) continue;
    locations.push({ root, relativeLocation: entry.name });
  }
  return locations;
}

function targetPlatformIsCompatible(
  targetPlatform: string | undefined,
  architecture: NodeJS.Architecture
): boolean {
  if (
    targetPlatform === undefined ||
    targetPlatform === "undefined" ||
    targetPlatform === "universal"
  ) {
    return true;
  }
  if (targetPlatform === `win32-${architecture}`) return true;
  return architecture === "arm64" && targetPlatform === "win32-x64";
}

function compatibleClaudeBinaryPlatforms(
  targetPlatform: string | undefined,
  architecture: "x64" | "arm64"
): readonly string[] {
  if (
    targetPlatform === "win32-x64" ||
    targetPlatform === "win32-arm64"
  ) {
    return [targetPlatform];
  }
  return architecture === "arm64"
    ? ["win32-arm64", "win32-x64"]
    : ["win32-x64"];
}

function validateClaudeExtensionLocation(
  location: ClaudeCodeExtensionLocation,
  architecture: "x64" | "arm64",
  rootPriority: number
): ClaudeCodeExtensionCandidate | undefined {
  const extensionPath = join(location.root, location.relativeLocation);
  if (!pathIsContained(location.root, extensionPath)) {
    throw new Error(
      `Anthropic Claude Code extension escapes its extension root: ${extensionPath}`
    );
  }
  if (
    !requireRegularDirectory(
      extensionPath,
      "Anthropic Claude Code extension"
    )
  ) {
    return undefined;
  }
  const manifestPath = join(extensionPath, "package.json");
  const manifest = readExtensionJson(
    manifestPath,
    "Anthropic Claude Code extension manifest"
  );
  if (manifest === undefined) return undefined;
  if (
    !isRecord(manifest) ||
    typeof manifest.publisher !== "string" ||
    manifest.publisher.toLocaleLowerCase("en-US") !== "anthropic" ||
    manifest.name !== "claude-code" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(
      `Extension manifest does not identify Anthropic Claude Code: ${manifestPath}`
    );
  }
  const version = parseExtensionVersion(manifest.version);
  if (!version) {
    throw new Error(
      `Anthropic Claude Code extension version is invalid: ${manifest.version}`
    );
  }
  if (
    location.expectedVersion !== undefined &&
    location.expectedVersion !== manifest.version
  ) {
    throw new Error(
      `Anthropic Claude Code catalog version ${location.expectedVersion} does not match manifest version ${manifest.version}.`
    );
  }
  if (!targetPlatformIsCompatible(location.targetPlatform, architecture)) {
    throw new Error(
      `Anthropic Claude Code target platform ${String(location.targetPlatform)} is incompatible with win32-${architecture}.`
    );
  }
  const binaryPlatforms = compatibleClaudeBinaryPlatforms(
    location.targetPlatform,
    architecture
  );
  const expectedDirectoryNames = new Set([
    `${CLAUDE_CODE_EXTENSION_ID}-${manifest.version}`,
    ...binaryPlatforms.map(
      (platform) =>
        `${CLAUDE_CODE_EXTENSION_ID}-${manifest.version}-${platform}`
    ),
  ].map((value) => value.toLocaleLowerCase("en-US")));
  if (
    !expectedDirectoryNames.has(
      location.relativeLocation.toLocaleLowerCase("en-US")
    )
  ) {
    throw new Error(
      `Anthropic Claude Code extension directory does not match its manifest version: ${location.relativeLocation}`
    );
  }

  const binaryLayouts = [
    ...binaryPlatforms.map((platform) => [
      "resources",
      "native-binaries",
      platform,
      "claude.exe",
    ]),
    ["resources", "native-binary", "claude.exe"],
  ];
  for (const segments of binaryLayouts) {
    const binaryPath = join(extensionPath, ...segments);
    const binaryMetadata = optionalMetadata(binaryPath);
    if (!binaryMetadata) continue;
    let parent = extensionPath;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      requireRegularDirectory(
        parent,
        "Anthropic Claude Code binary parent"
      );
    }
    if (binaryMetadata.isSymbolicLink()) {
      throw new Error(
        `Anthropic Claude Code bundled CLI is a symbolic link: ${binaryPath}`
      );
    }
    if (!binaryMetadata.isFile() || binaryMetadata.size < 1) {
      throw new Error(
        `Anthropic Claude Code bundled CLI is not a non-empty regular file: ${binaryPath}`
      );
    }
    return { path: binaryPath, version, rootPriority };
  }
  return undefined;
}

/**
 * Resolve the native Claude CLI from active VS Code extension metadata.
 *
 * PATH discovery remains the caller's first choice. This fallback never
 * executes a guessed prefix match: it validates catalog/manifest identity,
 * obsolete state, containment, and the bundled executable's filesystem shape.
 */
export function findClaudeCodeExtensionCommand(
  extensionRoots: readonly string[],
  architecture: NodeJS.Architecture
): CommandLookupResult {
  if (architecture !== "x64" && architecture !== "arm64") {
    return { status: "not_found" };
  }
  const candidates: ClaudeCodeExtensionCandidate[] = [];
  const errors: string[] = [];
  for (
    let rootPriority = 0;
    rootPriority < extensionRoots.length;
    rootPriority += 1
  ) {
    const root = extensionRoots[rootPriority];
    try {
      if (
        !requireRegularDirectory(
          root,
          "VS Code extension root"
        )
      ) {
        continue;
      }
      const obsolete = readObsoleteClaudeLocations(root);
      const catalogLocations = catalogClaudeLocations(root, obsolete);
      const locations =
        catalogLocations ?? enumeratedClaudeLocations(root, obsolete);
      for (const location of locations) {
        const candidate = validateClaudeExtensionLocation(
          location,
          architecture,
          rootPriority
        );
        if (candidate) candidates.push(candidate);
      }
    } catch (error) {
      errors.push(`${root}: ${errorMessage(error)}`);
    }
  }
  if (candidates.length > 0) {
    candidates.sort((left, right) => {
      const versionDifference = compareExtensionVersions(
        right.version,
        left.version
      );
      return versionDifference !== 0
        ? versionDifference
        : left.rootPriority - right.rootPriority;
    });
    const newest = candidates[0];
    const equallyNew = candidates.filter(
      (candidate) =>
        candidate.rootPriority === newest.rootPriority &&
        compareExtensionVersions(candidate.version, newest.version) === 0
    );
    const distinctPaths = new Set(
      equallyNew.map((candidate) =>
        resolve(candidate.path).toLocaleLowerCase("en-US")
      )
    );
    if (distinctPaths.size > 1) {
      return {
        status: "error",
        message:
          `Multiple active Anthropic Claude Code ${newest.version.raw} bundled CLIs were found in ${extensionRoots[newest.rootPriority]}.`,
      };
    }
    return { status: "found", path: newest.path };
  }
  return errors.length > 0
    ? { status: "error", message: errors.join(" ") }
    : { status: "not_found" };
}

export function selectWindowsCommandPath(
  candidates: readonly string[]
): string | undefined {
  return candidates
    .map((path) => path.trim())
    .filter(Boolean)
    .find((path) =>
      [".exe", ".com", ".cmd", ".bat"].includes(
        extname(path).toLocaleLowerCase("en-US")
      )
    );
}

export function isClaudeDesktopAppAliasPath(path: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]Claude\.exe$/i.test(path);
}

export function selectClientCommandPath(
  command: string,
  candidates: readonly string[]
): string | undefined {
  const nonemptyCandidates = candidates
    .map((path) => path.trim())
    .filter(Boolean);
  return selectWindowsCommandPath(
    command.toLocaleLowerCase("en-US") === "claude"
      ? nonemptyCandidates.filter(
          (path) => !isClaudeDesktopAppAliasPath(path)
        )
      : nonemptyCandidates
  );
}

function defaultFindCommand(command: string): CommandLookupResult {
  const result = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { status: "error", message: result.error.message };
  }
  if (result.status === 0) {
    const candidates = result.stdout.split(/\r?\n/);
    const nonemptyCandidates = candidates
      .map((path) => path.trim())
      .filter(Boolean);
    const path = selectClientCommandPath(command, nonemptyCandidates);
    if (
      !path &&
      nonemptyCandidates.length > 0 &&
      nonemptyCandidates.every(isClaudeDesktopAppAliasPath)
    ) {
      return { status: "not_found" };
    }
    return path
      ? { status: "found", path }
      : {
          status: "error",
          message: `'where.exe ${command}' returned no executable path.`,
        };
  }
  if (result.status === 1) return { status: "not_found" };
  return {
    status: "error",
    message:
      result.stderr.trim() ||
      `'where.exe ${command}' exited with code ${String(result.status)}.`,
  };
}

export function executeClientCommand(
  command: string,
  args: readonly string[]
): CommandExecutionResult {
  let executable = command;
  let executableArgs = [...args];
  let environment: NodeJS.ProcessEnv | undefined;
  if (
    process.platform === "win32" &&
    [".bat", ".cmd"].includes(extname(command).toLocaleLowerCase("en-US"))
  ) {
    const payload = Buffer.from(
      JSON.stringify([command, ...args]),
      "utf8"
    ).toString("base64");
    executable = "powershell.exe";
    executableArgs = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$decoded = [Text.Encoding]::UTF8.GetString(",
        "  [Convert]::FromBase64String($env:REFORGER_FORGE_CLIENT_COMMAND_PAYLOAD)",
        ")",
        "$parsed = ConvertFrom-Json -InputObject $decoded",
        "$values = @()",
        "foreach ($item in $parsed) { $values += [string]$item }",
        "if ($values.Count -lt 1) { exit 1 }",
        "$target = [string]$values[0]",
        "$forward = @()",
        "if ($values.Count -gt 1) {",
        "  $forward = @($values[1..($values.Count - 1)] | ForEach-Object { [string]$_ })",
        "}",
        "& $target @forward",
        "if ($null -eq $LASTEXITCODE) { if ($?) { exit 0 } else { exit 1 } }",
        "exit $LASTEXITCODE",
      ].join("\n"),
    ];
    environment = {
      ...process.env,
      REFORGER_FORGE_CLIENT_COMMAND_PAYLOAD: payload,
    };
  }
  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function derivePaths(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): ClientPaths {
  const home = resolve(environment.USERPROFILE ?? homeDirectory);
  const claudeConfigOverride = environment.CLAUDE_CONFIG_DIR?.trim();
  const claudeConfigDirectory = claudeConfigOverride
    ? resolve(claudeConfigOverride)
    : join(home, ".claude");
  const kiroHomeOverride = environment.KIRO_HOME?.trim();
  return {
    home,
    appData: environment.APPDATA
      ? resolve(environment.APPDATA)
      : undefined,
    localAppData: environment.LOCALAPPDATA
      ? resolve(environment.LOCALAPPDATA)
      : undefined,
    programFiles: environment.ProgramFiles
      ? resolve(environment.ProgramFiles)
      : undefined,
    programFilesX86: environment["PROGRAMFILES(X86)"]
      ? resolve(environment["PROGRAMFILES(X86)"]!)
      : undefined,
    claudeConfigDirectory,
    claudeUserConfigPath: claudeConfigOverride
      ? join(claudeConfigDirectory, ".claude.json")
      : join(home, ".claude.json"),
    vscodeExtensionRoots: [
      join(home, ".vscode", "extensions"),
      join(home, ".vscode-insiders", "extensions"),
    ],
    kiroHome: kiroHomeOverride ? resolve(kiroHomeOverride) : join(home, ".kiro"),
  };
}

function detectClient(
  definition: ClientDefinition,
  context: DetectionContext
): ClientDetection {
  const errors: string[] = [];
  for (const command of definition.commands) {
    const result = context.findCommand(command);
    if (result.status === "found") {
      return { status: "detected", commandPath: result.path };
    }
    if (result.status === "error") {
      errors.push(`${command}: ${result.message}`);
    }
  }

  if (definition.resolveCommand) {
    const result = definition.resolveCommand(context);
    if (result.status === "found") {
      return { status: "detected", commandPath: result.path };
    }
    if (result.status === "error") {
      return {
        status: "detection_failed",
        detail: result.message,
      };
    }
  }

  for (const evidence of definition.evidence(context.paths)) {
    const result = context.probePath(evidence.path, evidence.kind);
    if (result.status === "present") return { status: "detected" };
    if (result.status === "error") {
      errors.push(`${evidence.path}: ${result.message}`);
    }
  }

  for (const evidence of definition.prefixEvidence?.(context.paths) ?? []) {
    const result = context.probeDirectoryPrefix(
      evidence.parent,
      evidence.prefix
    );
    if (result.status === "present") return { status: "detected" };
    if (result.status === "error") {
      errors.push(`${evidence.parent}: ${result.message}`);
    }
  }

  return errors.length > 0
    ? { status: "detection_failed", detail: errors.join(" ") }
    : { status: "not_detected" };
}

function expectedStdioEntry(
  serverPath: string,
  clientLabel: SupportedClientId
): Readonly<Record<string, unknown>> {
  return {
    command: "node",
    args: buildManagedMcpServerArguments({ clientLabel, serverPath }),
  };
}

function expectedVsCodeEntry(
  serverPath: string,
  clientLabel: SupportedClientId
): Readonly<Record<string, unknown>> {
  return {
    type: "stdio",
    command: "node",
    args: buildManagedMcpServerArguments({ clientLabel, serverPath }),
  };
}

function readOriginalFile(path: string): OriginalFile | undefined {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link config: ${path}`);
    }
    if (!metadata.isFile()) {
      throw new Error(`MCP config is not a regular file: ${path}`);
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new Error(
        `MCP config exceeds the ${MAX_CONFIG_BYTES}-byte safety limit: ${path}`
      );
    }
    return {
      bytes: readFileSync(path),
      modifiedMilliseconds: metadata.mtimeMs,
      size: metadata.size,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOriginalUnchanged(
  path: string,
  original: OriginalFile | undefined
): void {
  if (!original) {
    if (existsSync(path)) {
      throw new Error(`MCP config appeared during registration: ${path}`);
    }
    return;
  }
  const metadata = statSync(path);
  const bytes = readFileSync(path);
  if (
    metadata.size !== original.size ||
    metadata.mtimeMs !== original.modifiedMilliseconds ||
    !bytes.equals(original.bytes)
  ) {
    throw new Error(`MCP config changed during registration: ${path}`);
  }
}

function assertNoSymbolicLinkAncestors(start: string): void {
  let candidate = start;
  while (true) {
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
      throw new Error(
        `Refusing an MCP config beneath a symbolic link: ${candidate}`
      );
    }
    const next = dirname(candidate);
    if (next === candidate) return;
    candidate = next;
  }
}

function ensureSafeParent(path: string): void {
  const parent = dirname(path);
  let nearestExisting = parent;
  while (!existsSync(nearestExisting)) {
    const next = dirname(nearestExisting);
    if (next === nearestExisting) break;
    nearestExisting = next;
  }
  assertNoSymbolicLinkAncestors(nearestExisting);
  mkdirSync(parent, { recursive: true });
  assertNoSymbolicLinkAncestors(parent);
}

function timestampForBackup(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function chooseBackupPath(path: string, now: Date): string {
  const base = `${path}.backup-${timestampForBackup(now)}`;
  if (!existsSync(base)) return base;
  for (let sequence = 1; sequence <= 10_000; sequence += 1) {
    const candidate = `${base}-${sequence}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a backup path for: ${path}`);
}

function writeAtomicConfig(
  path: string,
  original: OriginalFile | undefined,
  proposedText: string,
  now: () => Date
): string | undefined {
  ensureSafeParent(path);
  assertOriginalUnchanged(path, original);
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  let backupPath: string | undefined;
  let replacementCompleted = false;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, proposedText, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    assertOriginalUnchanged(path, original);
    if (original) {
      backupPath = chooseBackupPath(path, now());
      copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
      assertOriginalUnchanged(path, original);
    }
    assertNoSymbolicLinkAncestors(dirname(path));
    renameSync(temporaryPath, path);
    replacementCompleted = true;
    const installed = readFileSync(path, "utf8");
    if (installed !== proposedText) {
      throw new Error(
        `MCP config verification failed after replacement: ${path}${
          backupPath ? `; backup retained at ${backupPath}` : ""
        }`
      );
    }
    return backupPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary failure.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    if (!replacementCompleted && backupPath) {
      try {
        assertOriginalUnchanged(path, original);
        unlinkSync(backupPath);
      } catch {
        // Keep the backup if the target changed or cleanup was not safe.
      }
    }
    const modifiedFiles = replacementCompleted ? [path] : [];
    const backupFiles =
      backupPath && existsSync(backupPath) ? [backupPath] : [];
    if (modifiedFiles.length > 0 || backupFiles.length > 0) {
      throw new ConfigMutationError(
        errorMessage(error),
        modifiedFiles,
        backupFiles
      );
    }
    throw error;
  }
}

const TRANSPORT_OVERRIDE_KEYS = [
  "command",
  "args",
  "env",
  "env_vars",
  "cwd",
  "url",
  "httpUrl",
  "serverUrl",
  "headers",
  "authProviderType",
  "oauth",
  "oauthScopes",
  "bearerToken",
  "bearerTokenEnvVar",
  "type",
] as const;

function stdioTransportIsCurrent(
  value: unknown,
  expected: Readonly<Record<string, unknown>>
): boolean {
  if (!isRecord(value)) return false;
  const expectedType = expected.type;
  const existingType = value.type;
  if (
    expectedType === "stdio"
      ? existingType !== "stdio"
      : existingType !== undefined && existingType !== "stdio"
  ) {
    return false;
  }
  return (
    value.command === expected.command &&
    isDeepStrictEqual(value.args, expected.args) &&
    ![
      value.env,
      value.env_vars,
      value.cwd,
      value.url,
      value.httpUrl,
      value.serverUrl,
      value.headers,
      value.authProviderType,
      value.oauth,
      value.oauthScopes,
      value.bearerToken,
      value.bearerTokenEnvVar,
    ].some(hasMeaningfulValue)
  );
}

function mergeStandardStdioTransport(
  existing: Record<string, unknown> | undefined,
  expected: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const merged = { ...existing };
  for (const key of TRANSPORT_OVERRIDE_KEYS) delete merged[key];
  return { ...merged, ...expected };
}

export function updateJsonMcpRegistration(
  options: JsonRegistrationUpdateOptions
): ConfigFileUpdateResult {
  const original = readOriginalFile(options.path);
  let document: Record<string, unknown>;
  if (original) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original.bytes.toString("utf8"));
    } catch (error) {
      throw new Error(
        `MCP config is not valid JSON (${options.path}): ${errorMessage(error)}`
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`MCP config root must be a JSON object: ${options.path}`);
    }
    document = parsed;
  } else {
    document = {};
  }

  const existingContainer = document[options.rootKey];
  if (
    existingContainer !== undefined &&
    !isRecord(existingContainer)
  ) {
    throw new Error(
      `MCP config '${options.rootKey}' must be a JSON object: ${options.path}`
    );
  }
  const container = isRecord(existingContainer) ? existingContainer : {};
  const existingEntry = container[SERVER_NAME];
  if (existingEntry !== undefined && !isRecord(existingEntry)) {
    throw new Error(
      `MCP registration '${SERVER_NAME}' must be a JSON object: ${options.path}`
    );
  }
  if (stdioTransportIsCurrent(existingEntry, options.entry)) {
    return { status: "already_current" };
  }
  document[options.rootKey] = {
    ...container,
    [SERVER_NAME]: mergeStandardStdioTransport(existingEntry, options.entry),
  };

  const proposedText = `${JSON.stringify(document, null, 2)}\n`;
  const reparsed: unknown = JSON.parse(proposedText);
  if (!isRecord(reparsed)) {
    throw new Error(`Generated MCP config is invalid: ${options.path}`);
  }
  const backupPath = writeAtomicConfig(
    options.path,
    original,
    proposedText,
    options.now ?? (() => new Date())
  );
  return { status: "updated", backupPath };
}

function inspectJsonMcpRegistration(
  path: string,
  rootKey: string,
  entry: Readonly<Record<string, unknown>>
): "current" | "not_registered" | "different" {
  const original = readOriginalFile(path);
  if (!original) return "not_registered";
  let parsed: unknown;
  try {
    parsed = JSON.parse(original.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `MCP config is not valid JSON (${path}): ${errorMessage(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`MCP config root must be a JSON object: ${path}`);
  }
  const container = parsed[rootKey];
  if (container === undefined) return "not_registered";
  if (!isRecord(container)) {
    throw new Error(
      `MCP config '${rootKey}' must be a JSON object: ${path}`
    );
  }
  const existingEntry = container[SERVER_NAME];
  if (existingEntry === undefined) return "not_registered";
  if (!isRecord(existingEntry)) {
    throw new Error(
      `MCP registration '${SERVER_NAME}' must be a JSON object: ${path}`
    );
  }
  return stdioTransportIsCurrent(existingEntry, entry)
    ? "current"
    : "different";
}

function registerJsonClient(
  context: RegistrationContext,
  path: string | undefined,
  rootKey: string,
  entry: Readonly<Record<string, unknown>>
): RegistrationResult {
  if (!path) {
    throw new Error("The required Windows profile directory is unavailable.");
  }
  const result = updateJsonMcpRegistration({
    path,
    rootKey,
    entry,
    now: context.now,
  });
  return {
    status: result.status,
    detail: result.backupPath
      ? `Config: ${path}; previous config backed up to ${result.backupPath}`
      : `Config: ${path}`,
    target: configFileTarget(path),
    modifiedFiles: result.status === "updated" ? [path] : [],
    backupFiles: result.backupPath ? [result.backupPath] : [],
  };
}

function inspectJsonClient(
  path: string | undefined,
  rootKey: string,
  entry: Readonly<Record<string, unknown>>
): InspectionResult {
  if (!path) {
    throw new Error("The required Windows profile directory is unavailable.");
  }
  return {
    status: inspectJsonMcpRegistration(path, rootKey, entry),
    detail: `Config: ${path}`,
    target: configFileTarget(path),
  };
}

function commandFailure(
  client: string,
  action: string,
  result: CommandExecutionResult
): Error {
  const detail =
    result.error ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    `exit code ${String(result.status)}`;
  return new Error(`${client} could not ${action}: ${detail}`);
}

function runSuccessful(
  context: RegistrationContext,
  client: string,
  command: string,
  args: readonly string[],
  action: string
): CommandExecutionResult {
  const result = context.runCommand(command, args);
  if (result.status !== 0 || result.error) {
    throw commandFailure(client, action, result);
  }
  return result;
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function yamlNodeValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  ) {
    return value.toJSON();
  }
  return value;
}

function codexRegistrationIsCurrent(
  value: unknown,
  serverPath: string,
  clientLabel: SupportedClientId
): boolean {
  if (!isRecord(value) || !isRecord(value.transport)) return false;
  const transport = value.transport;
  return (
    transport.type === "stdio" &&
    transport.command === "node" &&
    isDeepStrictEqual(
      transport.args,
      buildManagedMcpServerArguments({ clientLabel, serverPath })
    ) &&
    !hasMeaningfulValue(transport.env) &&
    !hasMeaningfulValue(transport.env_vars) &&
    !hasMeaningfulValue(transport.cwd)
  );
}

function codexRestoreArguments(value: unknown): readonly string[] {
  if (!isRecord(value) || !isRecord(value.transport)) {
    throw new Error(
      "Codex returned a registration that cannot be backed up safely."
    );
  }
  const transport = value.transport;
  if (
    transport.type !== "stdio" ||
    typeof transport.command !== "string" ||
    !Array.isArray(transport.args) ||
    !transport.args.every((argument) => typeof argument === "string") ||
    hasMeaningfulValue(transport.env_vars) ||
    hasMeaningfulValue(transport.cwd) ||
    value.enabled === false ||
    hasMeaningfulValue(value.enabled_tools) ||
    hasMeaningfulValue(value.disabled_tools) ||
    hasMeaningfulValue(value.startup_timeout_sec) ||
    hasMeaningfulValue(value.tool_timeout_sec)
  ) {
    throw new Error(
      "The existing Codex registration uses settings that automatic setup cannot restore safely; update it manually."
    );
  }
  const environment = transport.env;
  if (
    environment !== undefined &&
    environment !== null &&
    (
      !isRecord(environment) ||
      Object.values(environment).some((item) => typeof item !== "string")
    )
  ) {
    throw new Error(
      "The existing Codex registration has an unsupported environment block; update it manually."
    );
  }
  const result = ["mcp", "add", SERVER_NAME];
  if (isRecord(environment)) {
    for (const [key, item] of Object.entries(environment)) {
      result.push("--env", `${key}=${String(item)}`);
    }
  }
  result.push(
    "--",
    transport.command,
    ...(transport.args as readonly string[])
  );
  return result;
}

function commandResultFailed(result: CommandExecutionResult): boolean {
  return result.status !== 0 || result.error !== undefined;
}

function codexRegistrationIsAbsent(
  result: CommandExecutionResult
): boolean {
  if (result.error || result.status !== 1) return false;
  const output = `${result.stderr}\n${result.stdout}`;
  const escapedServerName = SERVER_NAME.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  return new RegExp(
    `no MCP server named\\s+['"]?${escapedServerName}['"]?\\s+found`,
    "i"
  ).test(output);
}

function inspectCodexRegistration(
  context: RegistrationContext,
  detection: ClientDetection,
  clientLabel: SupportedClientId
): InspectionResult {
  const command = detection.commandPath ?? "codex";
  const target = clientCliTarget(command);
  if (!detection.commandPath) {
    return {
      status: "manual_setup_required",
      detail:
        "Codex state was detected, but its CLI is unavailable for read-only inspection.",
      target,
    };
  }
  const existing = context.runCommand(detection.commandPath, [
    "mcp",
    "get",
    SERVER_NAME,
    "--json",
  ]);
  if (codexRegistrationIsAbsent(existing)) {
    return {
      status: "not_registered",
      detail: `Inspected through Codex CLI: ${detection.commandPath}`,
      target,
    };
  }
  if (commandResultFailed(existing)) {
    throw commandFailure(
      "Codex",
      `inspect the existing '${SERVER_NAME}' registration`,
      existing
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing.stdout);
  } catch (error) {
    throw new Error(
      `Codex returned an invalid MCP registration: ${errorMessage(error)}`
    );
  }
  return {
    status: codexRegistrationIsCurrent(parsed, context.serverPath, clientLabel)
      ? "current"
      : "different",
    detail: `Inspected through Codex CLI: ${detection.commandPath}`,
    target,
  };
}

function registerCodex(
  context: RegistrationContext,
  detection: ClientDetection,
  clientLabel: SupportedClientId
): RegistrationResult {
  if (!detection.commandPath) {
    throw new Error(
      "Codex state was detected, but the Codex CLI is not available on PATH."
    );
  }
  const existing = context.runCommand(detection.commandPath, [
    "mcp",
    "get",
    SERVER_NAME,
    "--json",
  ]);
  let restoreArguments: readonly string[] | undefined;
  if (existing.status === 0 && !existing.error) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.stdout);
    } catch (error) {
      throw new Error(
        `Codex returned an invalid MCP registration: ${errorMessage(error)}`
      );
    }
    if (codexRegistrationIsCurrent(parsed, context.serverPath, clientLabel)) {
      return {
        status: "already_current",
        detail: `Managed through Codex CLI: ${detection.commandPath}`,
        target: clientCliTarget(detection.commandPath),
        modifiedFiles: [],
        backupFiles: [],
      };
    }
    restoreArguments = codexRestoreArguments(parsed);
    runSuccessful(
      context,
      "Codex",
      detection.commandPath,
      ["mcp", "remove", SERVER_NAME],
      `remove the existing '${SERVER_NAME}' registration`
    );
  } else {
    if (!codexRegistrationIsAbsent(existing)) {
      throw commandFailure(
        "Codex",
        `inspect the existing '${SERVER_NAME}' registration`,
        existing
      );
    }
  }

  const addition = context.runCommand(detection.commandPath, [
    "mcp",
    "add",
    SERVER_NAME,
    "--",
    "node",
    ...buildManagedMcpServerArguments({
      clientLabel,
      serverPath: context.serverPath,
    }),
  ]);
  if (commandResultFailed(addition)) {
    const failure = commandFailure(
      "Codex",
      `add the '${SERVER_NAME}' registration`,
      addition
    );
    if (!restoreArguments) throw failure;
    const restoration = context.runCommand(
      detection.commandPath,
      restoreArguments
    );
    if (commandResultFailed(restoration)) {
      const restorationFailure = commandFailure(
        "Codex",
        `restore the previous '${SERVER_NAME}' registration`,
        restoration
      );
      throw new ClientManagedMutationError(
        `${failure.message} Restoring the previous registration also failed: ${
          restorationFailure.message
        }`,
        [clientCliManagedChange(
          "codex",
          "Codex",
          detection.commandPath,
          `Removed the previous '${SERVER_NAME}' user registration through the client CLI, ` +
            "but replacement and restoration both failed; the final client-managed state is uncertain."
        )]
      );
    }
    throw new Error(
      `${failure.message} The previous registration was restored.`
    );
  }
  return {
    status: "updated",
    detail: `Managed through Codex CLI: ${detection.commandPath}`,
    target: clientCliTarget(detection.commandPath),
    modifiedFiles: [],
    backupFiles: [],
  };
}

function readClaudeUserEntry(
  path: string
): Readonly<Record<string, unknown>> | undefined {
  const original = readOriginalFile(path);
  if (!original) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(original.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Claude Code user config is not valid JSON (${path}): ${errorMessage(error)}`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Claude Code user config root must be an object: ${path}`);
  }
  const servers = parsed.mcpServers;
  if (servers === undefined) return undefined;
  if (!isRecord(servers)) {
    throw new Error(`Claude Code 'mcpServers' must be an object: ${path}`);
  }
  const entry = servers[SERVER_NAME];
  if (entry === undefined) return undefined;
  if (!isRecord(entry)) {
    throw new Error(
      `Claude Code '${SERVER_NAME}' registration must be an object: ${path}`
    );
  }
  return entry;
}

function claudeEntryIsCurrent(
  entry: Readonly<Record<string, unknown>>,
  serverPath: string,
  clientLabel: SupportedClientId
): boolean {
  return stdioTransportIsCurrent(entry, expectedStdioEntry(serverPath, clientLabel));
}

function claudeRegistrationIsAbsent(
  result: CommandExecutionResult
): boolean {
  if (result.error || result.status !== 1) return false;
  const output = `${result.stderr}\n${result.stdout}`;
  const escapedServerName = SERVER_NAME.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  return new RegExp(
    `no MCP server named\\s+['"]?${escapedServerName}['"]?`,
    "i"
  ).test(output);
}

function claudeRegistrationScope(
  result: CommandExecutionResult
): "user" | "local" | "project" | "other" | undefined {
  const match = result.stdout.match(/^\s*Scope:\s*(.+?)\s*$/im);
  if (!match) return undefined;
  const scope = match[1].toLocaleLowerCase("en-US");
  if (scope.includes("user config")) return "user";
  if (scope.includes("local config")) return "local";
  if (scope.includes("project config") || scope.includes(".mcp.json")) {
    return "project";
  }
  return "other";
}

function inspectClaudeCodeRegistration(
  context: RegistrationContext,
  detection: ClientDetection,
  clientLabel: SupportedClientId
): InspectionResult {
  const command = detection.commandPath ?? "claude";
  const target = clientCliTarget(command);
  if (!detection.commandPath) {
    return {
      status: "manual_setup_required",
      detail:
        "Claude Code state was detected, but its CLI could not be resolved from PATH or the installed VS Code extension.",
      target,
    };
  }
  const inspection = context.runCommand(detection.commandPath, [
    "mcp",
    "get",
    SERVER_NAME,
  ]);
  const registrationAbsent = claudeRegistrationIsAbsent(inspection);
  if (commandResultFailed(inspection) && !registrationAbsent) {
    throw commandFailure(
      "Claude Code",
      `inspect the existing '${SERVER_NAME}' registration`,
      inspection
    );
  }

  const userConfigPath = context.paths.claudeUserConfigPath;
  const userEntry = readClaudeUserEntry(userConfigPath);
  if (registrationAbsent) {
    if (userEntry) {
      throw new Error(
        `Claude Code reported no '${SERVER_NAME}' registration, but a user entry exists in ${userConfigPath}.`
      );
    }
    return {
      status: "not_registered",
      detail: `Inspected through Claude CLI: ${detection.commandPath}`,
      target,
    };
  }

  const scope = claudeRegistrationScope(inspection);
  if (!scope) {
    return {
      status: "manual_setup_required",
      detail:
        "Claude Code returned an MCP registration without a recognizable scope.",
      target,
    };
  }
  if (scope !== "user") {
    return {
      status: "manual_setup_required",
      detail:
        `The existing '${SERVER_NAME}' registration resolves from ${scope} scope. ` +
        "Read-only inspection will not treat it as the managed user target.",
      target,
    };
  }
  if (!userEntry) {
    throw new Error(
      `Claude Code reported a user registration, but '${SERVER_NAME}' was not present in ${userConfigPath}.`
    );
  }
  return {
    status: claudeEntryIsCurrent(userEntry, context.serverPath, clientLabel)
      ? "current"
      : "different",
    detail:
      `Inspected through Claude CLI: ${detection.commandPath}; ` +
      `config: ${userConfigPath}`,
    target,
  };
}

function registerClaudeCode(
  context: RegistrationContext,
  detection: ClientDetection,
  clientLabel: SupportedClientId
): RegistrationResult {
  if (!detection.commandPath) {
    throw new Error(
      "Claude Code state was detected, but the Claude CLI could not be resolved from PATH or the installed VS Code extension."
    );
  }
  const inspection = context.runCommand(detection.commandPath, [
    "mcp",
    "get",
    SERVER_NAME,
  ]);
  const registrationAbsent = claudeRegistrationIsAbsent(inspection);
  if (commandResultFailed(inspection) && !registrationAbsent) {
    throw commandFailure(
      "Claude Code",
      `inspect the existing '${SERVER_NAME}' registration`,
      inspection
    );
  }

  const userConfigPath = context.paths.claudeUserConfigPath;
  const userEntry = readClaudeUserEntry(userConfigPath);
  if (!registrationAbsent) {
    const scope = claudeRegistrationScope(inspection);
    if (!scope) {
      throw new Error(
        "Claude Code returned an MCP registration without a recognizable scope; update it manually."
      );
    }
    if (scope !== "user") {
      return {
        status: "manual_setup_required",
        detail:
          `The existing '${SERVER_NAME}' registration resolves from ${scope} scope. ` +
          "Automatic setup will not replace a non-user registration.",
        target: clientCliTarget(detection.commandPath),
        modifiedFiles: [],
        backupFiles: [],
      };
    }
    if (!userEntry) {
      throw new Error(
        `Claude Code reported a user registration, but '${SERVER_NAME}' was not present in ${userConfigPath}.`
      );
    }
  } else if (userEntry) {
    throw new Error(
      `Claude Code reported no '${SERVER_NAME}' registration, but a user entry exists in ${userConfigPath}.`
    );
  }

  if (userEntry && claudeEntryIsCurrent(userEntry, context.serverPath, clientLabel)) {
    return {
      status: "already_current",
      detail: `Managed through Claude CLI: ${detection.commandPath}; config: ${userConfigPath}`,
      target: clientCliTarget(detection.commandPath),
      modifiedFiles: [],
      backupFiles: [],
    };
  }
  if (userEntry) {
    runSuccessful(
      context,
      "Claude Code",
      detection.commandPath,
      ["mcp", "remove", SERVER_NAME, "--scope", "user"],
      `remove the existing user '${SERVER_NAME}' registration`
    );
  }
  const payload = JSON.stringify({
    type: "stdio",
    command: "node",
    args: buildManagedMcpServerArguments({
      clientLabel,
      serverPath: context.serverPath,
    }),
  });
  const addition = context.runCommand(detection.commandPath, [
    "mcp",
    "add-json",
    "--scope",
    "user",
    SERVER_NAME,
    payload,
  ]);
  if (commandResultFailed(addition)) {
    const failure = commandFailure(
      "Claude Code",
      `add the user '${SERVER_NAME}' registration`,
      addition
    );
    if (!userEntry) throw failure;
    const restoration = context.runCommand(detection.commandPath, [
      "mcp",
      "add-json",
      "--scope",
      "user",
      SERVER_NAME,
      JSON.stringify(userEntry),
    ]);
    if (commandResultFailed(restoration)) {
      const restorationFailure = commandFailure(
        "Claude Code",
        `restore the previous user '${SERVER_NAME}' registration`,
        restoration
      );
      throw new ClientManagedMutationError(
        `${failure.message} Restoring the previous registration also failed: ${
          restorationFailure.message
        }`,
        [clientCliManagedChange(
          "claude-code",
          "Claude Code",
          detection.commandPath,
          `Removed the previous '${SERVER_NAME}' user registration through the client CLI, ` +
            "but replacement and restoration both failed; the final client-managed state is uncertain."
        )]
      );
    }
    throw new Error(
      `${failure.message} The previous registration was restored.`
    );
  }
  return {
    status: "updated",
    detail: `Managed through Claude CLI: ${detection.commandPath}`,
    target: clientCliTarget(detection.commandPath),
    modifiedFiles: [],
    backupFiles: [],
  };
}

function updateContinueConfig(
  context: RegistrationContext,
  configPath: string,
  clientLabel: SupportedClientId
): RegistrationResult {
  const original = readOriginalFile(configPath);
  if (!original) {
    const legacyPaths = [
      join(dirname(configPath), "config.json"),
      join(dirname(configPath), "config.yml"),
    ];
    if (legacyPaths.some((path) => existsSync(path))) {
      return {
        status: "manual_setup_required",
        detail:
          "A legacy Continue config exists; automatic YAML creation was skipped to avoid changing config precedence.",
        target: configFileTarget(configPath),
        modifiedFiles: [],
        backupFiles: [],
      };
    }
  }

  const source = original
    ? original.bytes.toString("utf8")
    : [
        "name: ReforgerForge",
        "version: 1.0.0",
        "schema: v1",
        "",
      ].join("\n");
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(
      `Continue config is not valid YAML (${configPath}): ${
        document.errors.map((error) => error.message).join(" ")
      }`
    );
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`Continue config root must be a YAML map: ${configPath}`);
  }
  for (const key of ["name", "version", "schema"] as const) {
    const value = document.get(key);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `Continue config requires a non-empty '${key}' string: ${configPath}`
      );
    }
  }

  let serversNode = document.get("mcpServers", true);
  if (serversNode === undefined || serversNode === null) {
    serversNode = document.createNode([]);
    document.set("mcpServers", serversNode);
  }
  if (!isSeq(serversNode)) {
    throw new Error(
      `Continue 'mcpServers' must be a YAML sequence: ${configPath}`
    );
  }
  const expectedTransport = {
    command: "node",
    args: buildManagedMcpServerArguments({
      clientLabel,
      serverPath: context.serverPath,
    }),
  };
  const indexes = serversNode.items
    .map((item, index) => ({ index, value: yamlNodeValue(item) }))
    .filter(
      (candidate) =>
        isRecord(candidate.value) && candidate.value.name === SERVER_NAME
    );
  if (indexes.length > 1) {
    throw new Error(
      `Continue config contains duplicate '${SERVER_NAME}' servers: ${configPath}`
    );
  }
  const index = indexes[0]?.index ?? -1;
  const existingServer =
    index >= 0 && isRecord(indexes[0]?.value)
      ? indexes[0].value
      : undefined;
  if (stdioTransportIsCurrent(existingServer, expectedTransport)) {
    return {
      status: "already_current",
      detail: `Config: ${configPath}`,
      target: configFileTarget(configPath),
      modifiedFiles: [],
      backupFiles: [],
    };
  }
  const expected = {
    ...mergeStandardStdioTransport(existingServer, expectedTransport),
    name: SERVER_NAME,
  };
  const expectedNode = document.createNode(expected);
  if (index >= 0) {
    serversNode.items[index] = expectedNode;
  } else {
    serversNode.add(expectedNode);
  }
  const proposedText = document.toString();
  const validation = parseDocument(proposedText);
  if (validation.errors.length > 0 || !isMap(validation.contents)) {
    throw new Error(`Generated Continue config is invalid: ${configPath}`);
  }
  const backupPath = writeAtomicConfig(
    configPath,
    original,
    proposedText,
    context.now
  );
  return {
    status: "updated",
    detail: backupPath
      ? `Config: ${configPath}; previous config backed up to ${backupPath}`
      : `Config: ${configPath}`,
    target: configFileTarget(configPath),
    modifiedFiles: [configPath],
    backupFiles: backupPath ? [backupPath] : [],
  };
}

function inspectContinueConfig(
  context: RegistrationContext,
  configPath: string,
  clientLabel: SupportedClientId
): InspectionResult {
  const target = configFileTarget(configPath);
  const original = readOriginalFile(configPath);
  if (!original) {
    const legacyPaths = [
      join(dirname(configPath), "config.json"),
      join(dirname(configPath), "config.yml"),
    ];
    if (legacyPaths.some((path) => existsSync(path))) {
      return {
        status: "manual_setup_required",
        detail:
          "A legacy Continue config exists; the current YAML target cannot be evaluated without changing config precedence.",
        target,
      };
    }
    return {
      status: "not_registered",
      detail: `Config: ${configPath}`,
      target,
    };
  }

  const document = parseDocument(original.bytes.toString("utf8"));
  if (document.errors.length > 0) {
    throw new Error(
      `Continue config is not valid YAML (${configPath}): ${
        document.errors.map((error) => error.message).join(" ")
      }`
    );
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`Continue config root must be a YAML map: ${configPath}`);
  }
  for (const key of ["name", "version", "schema"] as const) {
    const value = document.get(key);
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `Continue config requires a non-empty '${key}' string: ${configPath}`
      );
    }
  }
  const serversNode = document.get("mcpServers", true);
  if (serversNode === undefined || serversNode === null) {
    return {
      status: "not_registered",
      detail: `Config: ${configPath}`,
      target,
    };
  }
  if (!isSeq(serversNode)) {
    throw new Error(
      `Continue 'mcpServers' must be a YAML sequence: ${configPath}`
    );
  }
  const entries = serversNode.items
    .map((item) => yamlNodeValue(item))
    .filter(
      (candidate) => isRecord(candidate) && candidate.name === SERVER_NAME
    );
  if (entries.length > 1) {
    throw new Error(
      `Continue config contains duplicate '${SERVER_NAME}' servers: ${configPath}`
    );
  }
  if (entries.length === 0) {
    return {
      status: "not_registered",
      detail: `Config: ${configPath}`,
      target,
    };
  }
  return {
    status: stdioTransportIsCurrent(entries[0], {
      command: "node",
      args: buildManagedMcpServerArguments({
        clientLabel,
        serverPath: context.serverPath,
      }),
    })
      ? "current"
      : "different",
    detail: `Config: ${configPath}`,
    target,
  };
}

function jsonDefinition(
  definition: Omit<
    ClientDefinition,
    "register" | "inspect" | "target" | "fallbackTarget"
  > & {
    readonly configPath: (context: DetectionContext) => string | undefined;
    readonly rootKey?: string;
    readonly vscodeEntry?: boolean;
  }
): ClientDefinition {
  const entry = (serverPath: string) =>
    definition.vscodeEntry
      ? expectedVsCodeEntry(serverPath, definition.id)
      : expectedStdioEntry(serverPath, definition.id);
  return {
    ...definition,
    fallbackTarget: configFileTarget(),
    target: (context) => configFileTarget(definition.configPath(context)),
    register: (context) => {
      const path = definition.configPath(context);
      return registerJsonClient(
        context,
        path,
        definition.rootKey ?? "mcpServers",
        entry(context.serverPath)
      );
    },
    inspect: (context) =>
      inspectJsonClient(
        definition.configPath(context),
        definition.rootKey ?? "mcpServers",
        entry(context.serverPath)
      ),
  };
}

function antigravityConfigPath(context: DetectionContext): string {
  const canonicalPath = join(
    context.paths.home,
    ".gemini",
    "config",
    "mcp_config.json"
  );
  const alternatePath = join(
    context.paths.home,
    ".gemini",
    "antigravity",
    "mcp_config.json"
  );
  const canonical = context.probePath(canonicalPath, "file");
  if (canonical.status === "present") return canonicalPath;
  if (canonical.status === "error") {
    throw new Error(
      `Could not inspect the canonical Antigravity MCP target (${canonicalPath}): ${canonical.message}`
    );
  }
  const alternate = context.probePath(alternatePath, "file");
  if (alternate.status === "present") return alternatePath;
  if (alternate.status === "error") {
    throw new Error(
      `Could not inspect the alternate Antigravity MCP target (${alternatePath}): ${alternate.message}`
    );
  }
  return canonicalPath;
}

function clientDefinitions(): readonly ClientDefinition[] {
  return [
    {
      id: "codex",
      name: "Codex",
      commands: ["codex"],
      evidence: (paths) => [
        ...fileEvidence([join(paths.home, ".codex", "config.toml")]),
        ...directoryEvidence([join(paths.home, ".codex")]),
      ],
      manual:
        "Run: codex mcp add reforger-forge -- node --title=ReforgerForge-MCP-codex <absolute-dist-index.js> --mcp-client-label codex",
      fallbackTarget: clientCliTarget("codex"),
      target: (_context, detection) =>
        clientCliTarget(detection.commandPath ?? "codex"),
      register: registerCodex,
      inspect: inspectCodexRegistration,
    },
    jsonDefinition({
      id: "cursor",
      name: "Cursor",
      commands: ["cursor", "cursor-agent"],
      evidence: (paths) => [
        ...directoryEvidence([
          join(paths.home, ".cursor"),
          optionalJoin(paths.appData, "Cursor"),
        ]),
        ...fileEvidence([
          optionalJoin(paths.localAppData, "Programs", "cursor", "Cursor.exe"),
          optionalJoin(paths.localAppData, "Cursor", "Cursor.exe"),
          optionalJoin(paths.programFiles, "Cursor", "Cursor.exe"),
          optionalJoin(paths.programFilesX86, "Cursor", "Cursor.exe"),
        ]),
      ],
      manual: "Edit %USERPROFILE%\\.cursor\\mcp.json.",
      configPath: (context) =>
        join(context.paths.home, ".cursor", "mcp.json"),
    }),
    jsonDefinition({
      id: "antigravity",
      name: "Google Antigravity",
      commands: ["antigravity", "agy"],
      evidence: (paths) => [
        ...fileEvidence([
          join(paths.home, ".gemini", "antigravity", "mcp_config.json"),
          optionalJoin(
            paths.localAppData,
            "Programs",
            "Antigravity",
            "Antigravity.exe"
          ),
          optionalJoin(
            paths.localAppData,
            "Programs",
            "Antigravity",
            "Antigravity IDE.exe"
          ),
        ]),
        ...directoryEvidence([
          join(paths.home, ".gemini", "antigravity"),
          join(paths.home, ".gemini", "antigravity-cli"),
          optionalJoin(paths.appData, "Antigravity"),
        ]),
      ],
      manual:
        "Edit %USERPROFILE%\\.gemini\\config\\mcp_config.json (or the existing alternate .gemini\\antigravity\\mcp_config.json selected by setup).",
      configPath: antigravityConfigPath,
    }),
    jsonDefinition({
      id: "claude-desktop",
      name: "Claude Desktop",
      commands: [],
      evidence: (paths) => [
        ...directoryEvidence([
          optionalJoin(paths.appData, "Claude"),
        ]),
        ...fileEvidence([
          optionalJoin(paths.localAppData, "AnthropicClaude", "Claude.exe"),
          optionalJoin(paths.localAppData, "Programs", "Claude", "Claude.exe"),
          optionalJoin(
            paths.localAppData,
            "Microsoft",
            "WindowsApps",
            "Claude.exe"
          ),
          optionalJoin(paths.programFiles, "Claude", "Claude.exe"),
        ]),
      ],
      prefixEvidence: (paths) =>
        paths.localAppData
          ? [
              {
                parent: join(paths.localAppData, "AnthropicClaude"),
                prefix: "app-",
              },
              {
                parent: join(paths.localAppData, "Packages"),
                prefix: "Claude_",
              },
              {
                parent: join(paths.localAppData, "Packages"),
                prefix: "Anthropic.Claude_",
              },
            ]
          : [],
      manual: "Edit %APPDATA%\\Claude\\claude_desktop_config.json.",
      configPath: (context) =>
        optionalJoin(
          context.paths.appData,
          "Claude",
          "claude_desktop_config.json"
        ),
    }),
    {
      id: "claude-code",
      name: "Claude Code",
      commands: ["claude"],
      resolveCommand: (context) =>
        context.findClaudeCodeExtensionCommand(
          context.paths.vscodeExtensionRoots,
          context.architecture
        ),
      evidence: (paths) => [
        ...directoryEvidence([paths.claudeConfigDirectory]),
        ...fileEvidence([paths.claudeUserConfigPath]),
      ],
      prefixEvidence: (paths) => [
        {
          parent: join(paths.home, ".vscode", "extensions"),
          prefix: "anthropic.claude-code-",
        },
      ],
      manual:
        "Run 'claude mcp get reforger-forge'; remove or rename any conflicting local/project entry, then run 'claude mcp add-json --scope user reforger-forge <stdio-json with --title=ReforgerForge-MCP-claude-code and --mcp-client-label claude-code>'.",
      fallbackTarget: clientCliTarget("claude"),
      target: (_context, detection) =>
        clientCliTarget(detection.commandPath ?? "claude"),
      register: registerClaudeCode,
      inspect: inspectClaudeCodeRegistration,
    },
    jsonDefinition({
      id: "windsurf",
      name: "Windsurf",
      commands: ["windsurf"],
      evidence: (paths) => [
        ...directoryEvidence([
          join(paths.home, ".codeium", "windsurf"),
          optionalJoin(paths.appData, "Windsurf"),
        ]),
        ...fileEvidence([
          optionalJoin(
            paths.localAppData,
            "Programs",
            "Windsurf",
            "Windsurf.exe"
          ),
          optionalJoin(paths.programFiles, "Windsurf", "Windsurf.exe"),
        ]),
      ],
      manual:
        "Edit %USERPROFILE%\\.codeium\\windsurf\\mcp_config.json.",
      configPath: (context) =>
        join(
          context.paths.home,
          ".codeium",
          "windsurf",
          "mcp_config.json"
        ),
    }),
    jsonDefinition({
      id: "vscode",
      name: "VS Code",
      commands: ["code"],
      evidence: (paths) => [
        ...directoryEvidence([
          optionalJoin(paths.appData, "Code"),
        ]),
        ...fileEvidence([
          optionalJoin(
            paths.localAppData,
            "Programs",
            "Microsoft VS Code",
            "Code.exe"
          ),
          optionalJoin(paths.programFiles, "Microsoft VS Code", "Code.exe"),
          optionalJoin(paths.programFilesX86, "Microsoft VS Code", "Code.exe"),
        ]),
      ],
      manual: "Edit %APPDATA%\\Code\\User\\mcp.json.",
      configPath: (context) =>
        optionalJoin(context.paths.appData, "Code", "User", "mcp.json"),
      rootKey: "servers",
      vscodeEntry: true,
    }),
    {
      id: "continue",
      name: "Continue.dev",
      commands: ["cn", "continue"],
      evidence: (paths) =>
        directoryEvidence([join(paths.home, ".continue")]),
      prefixEvidence: (paths) => [
        {
          parent: join(paths.home, ".vscode", "extensions"),
          prefix: "continue.continue-",
        },
        {
          parent: join(paths.home, ".cursor", "extensions"),
          prefix: "continue.continue-",
        },
      ],
      manual: "Edit %USERPROFILE%\\.continue\\config.yaml.",
      fallbackTarget: configFileTarget(),
      target: (context) =>
        configFileTarget(
          join(context.paths.home, ".continue", "config.yaml")
        ),
      register: (context, _detection, clientLabel) =>
        updateContinueConfig(
          context,
          join(context.paths.home, ".continue", "config.yaml"),
          clientLabel
        ),
      inspect: (context, _detection, clientLabel) =>
        inspectContinueConfig(
          context,
          join(context.paths.home, ".continue", "config.yaml"),
          clientLabel
        ),
    },
    jsonDefinition({
      id: "kiro",
      name: "Kiro",
      commands: ["kiro", "kiro-cli"],
      evidence: (paths) => [
        ...directoryEvidence([
          paths.kiroHome,
          optionalJoin(paths.appData, "Kiro"),
        ]),
        ...fileEvidence([
          optionalJoin(
            paths.localAppData,
            "Programs",
            "Kiro",
            "Kiro.exe"
          ),
        ]),
      ],
      manual:
        "Edit %KIRO_HOME%\\settings\\mcp.json when KIRO_HOME is set, otherwise %USERPROFILE%\\.kiro\\settings\\mcp.json.",
      configPath: (context) =>
        join(context.paths.kiroHome, "settings", "mcp.json"),
    }),
  ];
}

function createRegistrationContext(
  options: ClientRegistrationOptions,
  requireServerFile: boolean
): RegistrationContext {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error(
      `Automatic MCP client registration supports Windows only, not '${platform}'.`
    );
  }
  if (!isAbsolute(options.serverPath)) {
    throw new Error("The MCP server path must be absolute.");
  }
  const serverPath = resolve(options.serverPath);
  if (requireServerFile) {
    const metadata = statSync(serverPath);
    if (!metadata.isFile()) {
      throw new Error(`MCP server is not a regular file: ${serverPath}`);
    }
  }

  const environment = options.environment ?? process.env;
  const paths = derivePaths(
    environment,
    options.homeDirectory ?? homedir()
  );
  const context: RegistrationContext = {
    serverPath,
    paths,
    probePath: options.probePath ?? defaultProbePath,
    probeDirectoryPrefix:
      options.probeDirectoryPrefix ?? defaultProbeDirectoryPrefix,
    findCommand: options.findCommand ?? defaultFindCommand,
    findClaudeCodeExtensionCommand:
      options.findClaudeCodeExtensionCommand ??
      findClaudeCodeExtensionCommand,
    architecture: options.architecture ?? process.arch,
    runCommand: options.runCommand ?? executeClientCommand,
    now: options.now ?? (() => new Date()),
  };
  return context;
}

function receiptTarget(
  definition: ClientDefinition,
  context: RegistrationContext,
  detection: ClientDetection
): ClientRegistrationTarget {
  try {
    return definition.target(context, detection);
  } catch {
    return definition.fallbackTarget;
  }
}

function registrationNextActions(
  definition: ClientDefinition,
  status: ClientRegistrationStatus
): readonly string[] {
  if (status === "updated") {
    return [
      `Restart ${definition.name} and confirm the '${SERVER_NAME}' tools are available.`,
    ];
  }
  if (
    status === "detection_failed" ||
    status === "manual_setup_required" ||
    status === "failed"
  ) {
    return [definition.manual];
  }
  return [];
}

function registrationManagedChanges(
  definition: ClientDefinition,
  result: RegistrationResult
): readonly ClientManagedChange[] {
  if (result.status !== "updated" || result.target.kind !== "client_cli") {
    return [];
  }
  return [clientCliManagedChange(
    definition.id,
    definition.name,
    result.target.command,
    `Updated the '${SERVER_NAME}' user registration through the client CLI.`
  )];
}

function clientCliManagedChange(
  clientId: SupportedClientId,
  clientName: string,
  command: string,
  detail: string
): ClientManagedChange {
  return {
    clientId,
    clientName,
    kind: "client_cli",
    command,
    scope: "user",
    configFile: null,
    configFileVerification: "unverified",
    detail:
      `${detail} The exact client-owned configuration file was not verified.`,
  };
}

function inspectionNextActions(
  definition: ClientDefinition,
  status: ClientInspectionStatus
): readonly string[] {
  if (status === "not_registered" || status === "different") {
    return [
      `Run setup to install the standard '${SERVER_NAME}' user registration for ${definition.name}.`,
    ];
  }
  if (
    status === "detection_failed" ||
    status === "manual_setup_required" ||
    status === "failed"
  ) {
    return [definition.manual];
  }
  return [];
}

export function registerDetectedClients(
  options: ClientRegistrationOptions
): ClientRegistrationSummary {
  const context = createRegistrationContext(options, true);
  const receipts: ClientRegistrationReceipt[] = [];
  for (const definition of clientDefinitions()) {
    let detection: ClientDetection;
    try {
      detection = detectClient(definition, context);
    } catch (error) {
      detection = {
        status: "detection_failed",
        detail: errorMessage(error),
      };
    }
    if (detection.status === "not_detected") {
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: "not_detected",
        manual: definition.manual,
        target: receiptTarget(definition, context, detection),
        modifiedFiles: [],
        backupFiles: [],
        nextActions: [],
      });
      continue;
    }
    if (detection.status === "detection_failed") {
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: "detection_failed",
        detail: detection.detail,
        manual: definition.manual,
        target: receiptTarget(definition, context, detection),
        modifiedFiles: [],
        backupFiles: [],
        nextActions: registrationNextActions(
          definition,
          "detection_failed"
        ),
      });
      continue;
    }
    try {
      const result = definition.register(context, detection, definition.id);
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: result.status,
        detail: result.detail,
        manual: definition.manual,
        target: result.target,
        modifiedFiles: result.modifiedFiles,
        backupFiles: result.backupFiles,
        managedChanges: registrationManagedChanges(definition, result),
        nextActions: registrationNextActions(definition, result.status),
      });
    } catch (error) {
      const mutation =
        error instanceof ConfigMutationError ? error : undefined;
      const managedMutation =
        error instanceof ClientManagedMutationError ? error : undefined;
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: "failed",
        detail: errorMessage(error),
        manual: definition.manual,
        target: receiptTarget(definition, context, detection),
        modifiedFiles: mutation?.modifiedFiles ?? [],
        backupFiles: mutation?.backupFiles ?? [],
        managedChanges: managedMutation?.managedChanges ?? [],
        nextActions: registrationNextActions(definition, "failed"),
      });
    }
  }
  const hasFailures = receipts.some((receipt) =>
    [
      "detection_failed",
      "manual_setup_required",
      "failed",
    ].includes(receipt.status)
  );
  return { serverPath: context.serverPath, receipts, hasFailures };
}

export function inspectDetectedClients(
  options: ClientRegistrationOptions
): ClientInspectionSummary {
  // Inspection compares configured values only. The compiled server's
  // existence is reported by Doctor as a separate level and must not prevent
  // client status from being inspected.
  const context = createRegistrationContext(options, false);
  const receipts: ClientInspectionReceipt[] = [];
  for (const definition of clientDefinitions()) {
    let detection: ClientDetection;
    try {
      detection = detectClient(definition, context);
    } catch (error) {
      detection = {
        status: "detection_failed",
        detail: errorMessage(error),
      };
    }
    if (detection.status === "not_detected") {
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: "not_detected",
        manual: definition.manual,
        target: receiptTarget(definition, context, detection),
        modifiedFiles: [],
        backupFiles: [],
        nextActions: [],
      });
      continue;
    }
    if (detection.status === "detection_failed") {
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: "detection_failed",
        detail: detection.detail,
        manual: definition.manual,
        target: receiptTarget(definition, context, detection),
        modifiedFiles: [],
        backupFiles: [],
        nextActions: inspectionNextActions(
          definition,
          "detection_failed"
        ),
      });
      continue;
    }
    try {
      const result = definition.inspect(context, detection, definition.id);
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: result.status,
        detail: result.detail,
        manual: definition.manual,
        target: result.target,
        modifiedFiles: [],
        backupFiles: [],
        nextActions: inspectionNextActions(definition, result.status),
      });
    } catch (error) {
      receipts.push({
        id: definition.id,
        name: definition.name,
        status: "failed",
        detail: errorMessage(error),
        manual: definition.manual,
        target: receiptTarget(definition, context, detection),
        modifiedFiles: [],
        backupFiles: [],
        nextActions: inspectionNextActions(definition, "failed"),
      });
    }
  }
  const hasFailures = receipts.some((receipt) =>
    [
      "not_registered",
      "different",
      "detection_failed",
      "manual_setup_required",
      "failed",
    ].includes(receipt.status)
  );
  return { serverPath: context.serverPath, receipts, hasFailures };
}

export function createFailedRegistrationSummary(
  serverPath: string,
  detail: string
): ClientRegistrationSummary {
  return {
    serverPath,
    receipts: clientDefinitions().map((definition) => ({
      id: definition.id,
      name: definition.name,
      status: "failed",
      detail,
      manual: definition.manual,
      target: definition.fallbackTarget,
      modifiedFiles: [],
      backupFiles: [],
      nextActions: [definition.manual],
    })),
    hasFailures: true,
  };
}

function statusLabel(status: ClientRegistrationStatus): string {
  switch (status) {
    case "already_current":
      return "already current";
    case "not_detected":
      return "not detected";
    case "detection_failed":
      return "detection failed";
    case "manual_setup_required":
      return "manual setup required";
    default:
      return status;
  }
}

export function formatRegistrationReceipt(
  summary: ClientRegistrationSummary
): string {
  const width = Math.max(...summary.receipts.map((receipt) => receipt.name.length));
  const lines = [
    "",
    "MCP client registration receipt",
    "===============================",
  ];
  for (const receipt of summary.receipts) {
    const detail = receipt.detail ? `: ${receipt.detail}` : "";
    lines.push(
      `  ${receipt.name.padEnd(width)}  ${statusLabel(receipt.status)}${detail}`
    );
    for (const path of receipt.modifiedFiles) {
      lines.push(`${" ".repeat(width + 4)}Changed: ${path}`);
    }
    for (const path of receipt.backupFiles) {
      lines.push(`${" ".repeat(width + 4)}Backup: ${path}`);
    }
    for (const change of receipt.managedChanges ?? []) {
      lines.push(
        `${" ".repeat(width + 4)}Managed change: ${change.detail} ` +
        `(command: ${change.command}; exact config file: unverified)`
      );
    }
    if (
      receipt.status === "detection_failed" ||
      receipt.status === "manual_setup_required" ||
      receipt.status === "failed"
    ) {
      lines.push(`${" ".repeat(width + 4)}Manual: ${receipt.manual}`);
    }
  }
  lines.push(
    "",
    summary.hasFailures
      ? "Server setup succeeded, but one or more client registrations need manual attention."
      : "All detected MCP clients are registered."
  );
  return lines.join("\n");
}
