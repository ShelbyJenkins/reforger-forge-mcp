import { createHash, randomUUID } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { getProperty, parse as parseEnfusionText } from "../formats/enfusion-text.js";
import {
  defaultWorkbenchHelperManagedRoot,
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  WorkbenchHelperStager,
  type WorkbenchCompanionLaunch,
  type WorkbenchCompanionProvider,
} from "./helper-addon.js";
import { canonicalizeGproj, revalidateProjectIdentity } from "./project-identity.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import {
  isLoopbackLifecycleHost,
  WORKBENCH_PROCESS_NAME,
  WorkbenchProcessGuard,
  type CanonicalProjectIdentity,
  type ExpectedStateVersion,
  type LifecycleEndpoint,
  type LifecycleStateDraft,
  type WorkbenchCompanionLifecycleState,
  type WorkbenchIdentity,
  type WorkbenchLifecycleSession,
  type WorkbenchLifecycleStateV3,
} from "./process-guard.js";

const WORKBENCH_SUBDIRECTORY = "Workbench";
const DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_ENDPOINT_POLL_MS = 200;
const DEFAULT_LOG_ATTRIBUTION_TIMEOUT_MS = 10_000;
const DEFAULT_LOG_POLL_MS = 200;
const DEFAULT_TERMINATION_TIMEOUT_MS = 15_000;
const MAX_BUILD_TIMEOUT_MS = 60 * 60 * 1_000;
const LOG_CLOCK_SKEW_MS = 2_000;
const NET_API_CLIENT_ID = "ReforgerForgeWorkbenchRunner";
const MAX_PING_RESPONSE_BYTES = 1024 * 1024;

export type WorkbenchRunnerErrorCode =
  | "INVALID_INTENT"
  | "INVALID_CONFIG"
  | "INVALID_TARGET"
  | "INVALID_LOG_ROOT"
  | "LIFECYCLE_CONFLICT"
  | "SPAWN_FAILED"
  | "IDENTITY_UNVERIFIABLE"
  | "ENDPOINT_UNVERIFIABLE"
  | "TERMINATION_REFUSED"
  | "LOG_ATTRIBUTION_FAILED"
  | "OUTPUT_ATTESTATION_FAILED"
  | "BUILD_DEADLINE_EXCEEDED"
  | "BUILD_ABORTED";

export class WorkbenchRunnerError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchRunnerErrorCode
  ) {
    super(message);
    this.name = "WorkbenchRunnerError";
  }
}

export interface WorkbenchEditorIntent {
  kind: "editor";
  gprojPath: string;
  /** Deliberately literal: detached one-shot editor ownership is unsupported. */
  foreground: true;
}

export interface WorkbenchBuildIntent {
  kind: "build";
  gprojPath: string;
  platform: "PC";
  outputPath: string;
  timeoutMs: number;
}

export type WorkbenchRunnerIntent = WorkbenchEditorIntent | WorkbenchBuildIntent;

export interface WorkbenchRunnerExitStatus {
  reason: "exited" | "timed_out" | "aborted";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface WorkbenchEditorRunnerReceipt {
  version: 2;
  intent: "editor";
  pid: number;
  target: string;
  lifecycleGeneration: string;
  endpointOwnership: "verified";
  companionIdentity: WorkbenchRunnerCompanionIdentity;
  logDirectory: string;
  exitStatus: WorkbenchRunnerExitStatus;
}

export interface WorkbenchBuildPreflightProof {
  pid: number;
  executablePath: string;
  creationTime: string;
  lifecycleGeneration: string;
  endpointOwnership: "verified";
  endpointVacancy: "verified";
  logDirectory: string;
}

export interface WorkbenchBuildOutputProof {
  root: string;
  freshArtifactCount: number;
  freshBytes: number;
  resourceDatabasePath: string;
  previousResourceDatabaseSha256: string | null;
  resourceDatabaseSha256: string;
}

export interface WorkbenchBuildValidationFailure {
  code: "OUTPUT_ATTESTATION_FAILED";
  message: string;
}

export interface WorkbenchBuildRunnerReceipt {
  version: 3;
  intent: "build";
  /** Exact target-only build child, never the companion preflight child. */
  pid: number;
  executablePath: string;
  creationTime: string;
  target: string;
  targetAddon: { addonId: string; addonGuid: string; sourceSha256: string };
  lifecycleGeneration: string;
  processOwnership: "verified";
  endpointVacancy: "verified";
  companionIdentity: WorkbenchRunnerCompanionIdentity;
  preflight: WorkbenchBuildPreflightProof;
  logDirectory: string;
  output: WorkbenchBuildOutputProof | null;
  /** Present only when an exit-0 build failed post-exit output attestation. */
  validationFailure: WorkbenchBuildValidationFailure | null;
  exitStatus: WorkbenchRunnerExitStatus;
}

export type WorkbenchRunnerReceipt = WorkbenchEditorRunnerReceipt | WorkbenchBuildRunnerReceipt;

export interface WorkbenchRunnerCompanionIdentity {
  addonId: string;
  addonGuid: string;
  addonVersion: string;
  protocolVersion: string;
  workbenchProtocol: string;
  buildIdentity: string;
  bundleDigest: string;
}

export type WorkbenchRunnerCompanionProbe = (
  endpoint: Readonly<LifecycleEndpoint>,
  timeoutMs: number
) => Promise<Record<string, unknown>>;

export interface WorkbenchRunnerDependencies {
  processGuard?: WorkbenchProcessGuard;
  companionProvider?: WorkbenchCompanionProvider;
  spawnProcess?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Explicit test/embedding override. The CLI normally derives this from MCP configuration. */
  logRoot?: string;
  signal?: AbortSignal;
  endpointProbeTimeoutMs?: number;
  endpointPollMs?: number;
  companionProbe?: WorkbenchRunnerCompanionProbe;
  logAttributionTimeoutMs?: number;
  logPollMs?: number;
  terminationTimeoutMs?: number;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ChildObservation {
  closePromise: Promise<ChildExit>;
  errorPromise: Promise<WorkbenchRunnerError>;
  hasClosed: () => boolean;
  getError: () => WorkbenchRunnerError | null;
}

interface CandidateLogDirectory {
  path: string;
  name: string;
  modifiedMs: number;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return isContainedPath(left, right) || isContainedPath(right, left);
}

function positiveInteger(value: number, label: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? "a positive integer" : `between 1 and ${maximum}`;
    throw new WorkbenchRunnerError(`${label} must be ${range}.`, "INVALID_INTENT");
  }
  return value;
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
    if (!statSync(canonical).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new WorkbenchRunnerError(
      `${label} is not an accessible directory: ${absolute} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      label === "Workbench log root" ? "INVALID_LOG_ROOT" : "INVALID_CONFIG"
    );
  }
  return canonical;
}

export function resolveWorkbenchExecutable(config: Pick<Config, "workbenchPath">): string {
  if (typeof config.workbenchPath !== "string" || config.workbenchPath.trim().length === 0) {
    throw new WorkbenchRunnerError(
      "MCP workbenchPath must be a non-empty directory path.",
      "INVALID_CONFIG"
    );
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
  throw new WorkbenchRunnerError(
    `Cannot find the exact Workbench executable under configured path ${root}.`,
    "INVALID_CONFIG"
  );
}

export function validateWorkbenchAddonDirectories(
  configured: readonly string[] | undefined
): string[] {
  if (configured !== undefined && !Array.isArray(configured)) {
    throw new WorkbenchRunnerError(
      "MCP workbenchAddonDirs must be an array of directory paths.",
      "INVALID_CONFIG"
    );
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const entry of configured ?? []) {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.includes(",")) {
      throw new WorkbenchRunnerError(
        "Every MCP workbenchAddonDirs entry must be a non-empty path without commas.",
        "INVALID_CONFIG"
      );
    }
    const directory = canonicalDirectory(entry.trim(), "Workbench add-on root");
    const key = pathKey(directory);
    if (seen.has(key)) continue;
    seen.add(key);
    canonical.push(directory);
  }
  return canonical;
}

function logRootCandidates(addonDirectories: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const addonDirectory of addonDirectories) {
    if (basename(addonDirectory).toLowerCase() !== "addons") continue;
    const productDirectory = dirname(addonDirectory);
    if (basename(productDirectory).replace(/\s+/g, "").toLowerCase() !== "armareforger") continue;
    candidates.push(join(dirname(productDirectory), "ArmaReforgerWorkbench", "logs"));
  }
  candidates.push(join(homedir(), "Documents", "My Games", "ArmaReforgerWorkbench", "logs"));
  return candidates;
}

export function resolveWorkbenchLogRoot(
  addonDirectories: readonly string[],
  explicitPath = process.env.REFORGER_FORGE_WORKBENCH_LOG_ROOT
): string {
  if (explicitPath !== undefined) {
    if (typeof explicitPath !== "string" || explicitPath.trim().length === 0) {
      throw new WorkbenchRunnerError(
        "REFORGER_FORGE_WORKBENCH_LOG_ROOT must be a non-empty directory path.",
        "INVALID_LOG_ROOT"
      );
    }
    return canonicalDirectory(explicitPath.trim(), "Workbench log root");
  }

  const roots = new Map<string, string>();
  for (const candidate of logRootCandidates(addonDirectories)) {
    if (!existsSync(candidate)) continue;
    const canonical = canonicalDirectory(candidate, "Workbench log root");
    roots.set(pathKey(canonical), canonical);
  }
  if (roots.size !== 1) {
    const detail = roots.size === 0
      ? "No Workbench log root could be derived from workbenchAddonDirs."
      : `Derived ${roots.size} distinct Workbench log roots.`;
    throw new WorkbenchRunnerError(
      `${detail} Set REFORGER_FORGE_WORKBENCH_LOG_ROOT explicitly.`,
      "INVALID_LOG_ROOT"
    );
  }
  return [...roots.values()][0];
}

function validateEndpoint(config: Pick<Config, "workbenchHost" | "workbenchPort">): LifecycleEndpoint {
  const host = config.workbenchHost?.trim().toLowerCase();
  const port = config.workbenchPort;
  if (!host || !isLoopbackLifecycleHost(host) ||
      !Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new WorkbenchRunnerError(
      "The standalone Workbench runner requires a numeric loopback MCP endpoint and valid port.",
      "INVALID_CONFIG"
    );
  }
  return { host, port };
}

function validateBuildOutput(intent: WorkbenchBuildIntent): string {
  if (intent.platform !== "PC") {
    throw new WorkbenchRunnerError(
      "The structured Workbench build runner currently supports only platform PC.",
      "INVALID_INTENT"
    );
  }
  positiveInteger(intent.timeoutMs, "Build timeoutMs", MAX_BUILD_TIMEOUT_MS);
  if (typeof intent.outputPath !== "string" || intent.outputPath.trim().length === 0) {
    throw new WorkbenchRunnerError("Build outputPath must be non-empty.", "INVALID_INTENT");
  }
  const output = resolve(intent.outputPath.trim());
  try {
    mkdirSync(output, { recursive: true });
    const canonical = canonicalDirectory(output, "Workbench build output");
    assertEmptyBuildOutput(canonical);
    return canonical;
  } catch (error) {
    if (error instanceof WorkbenchRunnerError) throw error;
    throw new WorkbenchRunnerError(
      `Workbench build output cannot be prepared: ${output} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      "INVALID_INTENT"
    );
  }
}

function assertEmptyBuildOutput(root: string): void {
  if (readdirSync(root).length !== 0) {
    throw new WorkbenchRunnerError(
      `Workbench build output must be a unique empty directory before launch: ${root}`,
      "OUTPUT_ATTESTATION_FAILED"
    );
  }
}

interface WorkbenchBuildProjectMetadata {
  addonId: string;
  addonGuid: string;
  sourceSha256: string;
}

interface BuildOutputArtifactState {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string | null;
}

function resolveBuildProjectMetadata(gprojPath: string): WorkbenchBuildProjectMetadata {
  let document;
  let source: Buffer;
  try {
    source = readFileSync(gprojPath);
    document = parseEnfusionText(source.toString("utf8"));
  } catch (error) {
    throw new WorkbenchRunnerError(
      `Workbench build project could not be parsed: ${gprojPath} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      "INVALID_TARGET"
    );
  }
  const addonId = document.type === "GameProject" ? getProperty(document, "ID") : undefined;
  const addonGuid = document.type === "GameProject" ? getProperty(document, "GUID") : undefined;
  if (typeof addonId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(addonId) ||
      typeof addonGuid !== "string" || !/^[A-Fa-f0-9]{16}$/.test(addonGuid)) {
    throw new WorkbenchRunnerError(
      `Workbench build project must declare one safe GameProject ID and GUID: ${gprojPath}`,
      "INVALID_TARGET"
    );
  }
  return {
    addonId,
    addonGuid: addonGuid.toUpperCase(),
    sourceSha256: createHash("sha256").update(source).digest("hex"),
  };
}

function snapshotBuildOutput(root: string): Map<string, BuildOutputArtifactState> {
  const artifacts = new Map<string, BuildOutputArtifactState>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const lexical = join(directory, entry.name);
      const relativePath = relative(root, lexical).split(sep).join("/");
      const stat = lstatSync(lexical);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new WorkbenchRunnerError(
          `Workbench build output contains a symbolic link or reparse traversal: ${lexical}`,
          "OUTPUT_ATTESTATION_FAILED"
        );
      }
      const canonical = realpathSync.native(lexical);
      if (!isContainedPath(root, canonical)) {
        throw new WorkbenchRunnerError(
          `Workbench build output entry escapes its canonical root: ${lexical}`,
          "OUTPUT_ATTESTATION_FAILED"
        );
      }
      if (stat.isDirectory()) {
        visit(canonical);
        continue;
      }
      if (!stat.isFile()) {
        throw new WorkbenchRunnerError(
          `Workbench build output contains an unsupported filesystem entry: ${lexical}`,
          "OUTPUT_ATTESTATION_FAILED"
        );
      }
      const isResourceDatabase = basename(relativePath).toLowerCase() === "resourcedatabase.rdb";
      const sha256 = isResourceDatabase
        ? createHash("sha256").update(readFileSync(canonical)).digest("hex")
        : null;
      const confirmed = lstatSync(lexical);
      if (!confirmed.isFile() || confirmed.isSymbolicLink() ||
          confirmed.size !== stat.size || confirmed.mtimeMs !== stat.mtimeMs ||
          pathKey(realpathSync.native(lexical)) !== pathKey(canonical)) {
        throw new WorkbenchRunnerError(
          `Workbench build output changed during attestation: ${lexical}`,
          "OUTPUT_ATTESTATION_FAILED"
        );
      }
      artifacts.set(relativePath, {
        path: canonical,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256,
      });
    }
  };
  visit(root);
  return artifacts;
}

function attestFreshBuildOutput(
  root: string,
  before: ReadonlyMap<string, BuildOutputArtifactState>
): WorkbenchBuildOutputProof {
  const after = snapshotBuildOutput(root);
  const fresh: BuildOutputArtifactState[] = [];
  const resourceDatabases = [...after.entries()].filter(([relativePath]) =>
    basename(relativePath).toLowerCase() === "resourcedatabase.rdb"
  );
  if (resourceDatabases.length !== 1) {
    throw new WorkbenchRunnerError(
      `Workbench exit-zero output must contain exactly one regular resourceDatabase.rdb; ` +
        `found ${resourceDatabases.length}.`,
      "OUTPUT_ATTESTATION_FAILED"
    );
  }
  const [resourceDatabaseRelativePath, resourceDatabase] = resourceDatabases[0];
  const previousResourceDatabase = before.get(resourceDatabaseRelativePath);
  if (resourceDatabase.size <= 0 || !resourceDatabase.sha256 ||
      previousResourceDatabase?.sha256 === resourceDatabase.sha256) {
    throw new WorkbenchRunnerError(
      "Workbench exited successfully without a fresh nonempty hashed resourceDatabase.rdb.",
      "OUTPUT_ATTESTATION_FAILED"
    );
  }
  for (const [relativePath, artifact] of after) {
    const previous = before.get(relativePath);
    const contentChanged = artifact.sha256 !== null && artifact.sha256 !== previous?.sha256;
    if (artifact.size <= 0 || (!contentChanged && previous && previous.size === artifact.size &&
        previous.mtimeMs === artifact.mtimeMs)) {
      continue;
    }
    fresh.push(artifact);
  }
  if (fresh.length === 0) {
    throw new WorkbenchRunnerError(
      "Workbench exited successfully without fresh nonempty build artifacts.",
      "OUTPUT_ATTESTATION_FAILED"
    );
  }
  return {
    root,
    freshArtifactCount: fresh.length,
    freshBytes: fresh.reduce((total, artifact) => total + artifact.size, 0),
    resourceDatabasePath: resourceDatabase.path,
    previousResourceDatabaseSha256: previousResourceDatabase?.sha256 ?? null,
    resourceDatabaseSha256: resourceDatabase.sha256,
  };
}

function validateCompanionLaunch(
  companion: WorkbenchCompanionLaunch,
  projectDirectory: string
): WorkbenchCompanionLaunch {
  if (!companion || typeof companion !== "object" ||
      !/^[A-Fa-f0-9]{16}$/.test(companion.addonGuid) ||
      typeof companion.addonId !== "string" || companion.addonId.length === 0 ||
      typeof companion.bundleDigest !== "string" || !/^[a-f0-9]{64}$/.test(companion.bundleDigest) ||
      typeof companion.buildIdentity !== "string" || companion.buildIdentity.length === 0 ||
      companion.addonId !== WORKBENCH_HELPER_ADDON_ID ||
      companion.addonGuid !== WORKBENCH_HELPER_ADDON_GUID ||
      companion.addonVersion !== WORKBENCH_HELPER_ADDON_VERSION ||
      companion.protocolVersion !== WORKBENCH_HELPER_PROTOCOL_VERSION ||
      companion.buildIdentity !== WORKBENCH_HELPER_BUILD_IDENTITY) {
    throw new WorkbenchRunnerError(
      "The managed Workbench companion returned an invalid immutable identity.",
      "INVALID_CONFIG"
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
  const workbenchProfilePath = canonicalDirectory(
    companion.workbenchProfilePath,
    "Workbench companion profile"
  );
  if (!isContainedPath(addonSearchRoot, addonDirectory)) {
    throw new WorkbenchRunnerError(
      "The managed Workbench companion add-on escapes its declared search root.",
      "INVALID_CONFIG"
    );
  }
  for (const managedPath of [addonSearchRoot, addonDirectory, workbenchProfilePath]) {
    if (pathsOverlap(projectDirectory, managedPath)) {
      throw new WorkbenchRunnerError(
        "Workbench companion add-on and profile paths must not overlap the target project.",
        "INVALID_CONFIG"
      );
    }
  }
  return {
    ...companion,
    addonSearchRoot,
    addonDirectory,
    workbenchProfilePath,
  };
}

function commonProfileArguments(
  config: Pick<Config, "workbenchScriptAuthorizeAll">,
  addonDirectories: readonly string[],
  profilePath: string
): string[] {
  const args: string[] = [];
  if (addonDirectories.length > 0) args.push("-addonsDir", addonDirectories.join(","));
  args.push("-profile", profilePath);
  args.push("-noThrow");
  if (config.workbenchScriptAuthorizeAll === true) args.push("-scriptAuthorizeAll");
  return args;
}

function editorArguments(
  config: Pick<Config, "workbenchScriptAuthorizeAll">,
  intent: WorkbenchEditorIntent,
  target: string,
  addonDirectories: readonly string[],
  companion: WorkbenchCompanionLaunch,
  ownerArgument: string
): string[] {
  if (intent.foreground !== true) {
    throw new WorkbenchRunnerError(
      "Editor intent must be foreground; one-shot detached ownership is unsupported.",
      "INVALID_INTENT"
    );
  }
  const args = commonProfileArguments(
    config,
    addonDirectories,
    companion.workbenchProfilePath
  );
  args.push(
    "-addons",
    companion.addonGuid,
    "-gproj",
    target,
    ownerArgument,
    "-wbModule=WorldEditor",
    "-run"
  );
  return args;
}

function buildPreflightArguments(
  config: Pick<Config, "workbenchScriptAuthorizeAll">,
  target: string,
  addonDirectories: readonly string[],
  companion: WorkbenchCompanionLaunch,
  ownerArgument: string
): string[] {
  const args = commonProfileArguments(
    config,
    addonDirectories,
    companion.workbenchProfilePath
  );
  args.push(
    "-addons",
    companion.addonGuid,
    "-gproj",
    target,
    ownerArgument,
    "-wbModule=ResourceManager",
    "-run"
  );
  return args;
}

function targetBuildArguments(
  config: Pick<Config, "workbenchScriptAuthorizeAll">,
  intent: WorkbenchBuildIntent,
  target: string,
  addonDirectories: readonly string[],
  profilePath: string,
  ownerArgument: string,
  outputPath: string,
  addonId: string
): string[] {
  const args = commonProfileArguments(config, addonDirectories, profilePath);
  args.push(
    "-gproj",
    target,
    "-gprojConfig",
    intent.platform,
    ownerArgument,
    "-wbModule=ResourceManager",
    "-builddata",
    intent.platform,
    outputPath,
    addonId
  );
  return args;
}

function observeChild(child: ChildProcess): ChildObservation {
  let closed = false;
  let childError: WorkbenchRunnerError | null = null;
  let resolveError!: (error: WorkbenchRunnerError) => void;
  const errorPromise = new Promise<WorkbenchRunnerError>((resolvePromise) => {
    resolveError = resolvePromise;
  });
  const closePromise = new Promise<ChildExit>((resolvePromise) => {
    child.once("close", (code, signal) => {
      closed = true;
      resolvePromise({ code, signal: signal as NodeJS.Signals | null });
    });
  });
  child.once("error", (error) => {
    childError = new WorkbenchRunnerError(
      `Workbench child process reported an error: ${error.message}`,
      "SPAWN_FAILED"
    );
    resolveError(childError);
  });
  return {
    closePromise,
    errorPromise,
    hasClosed: () => closed,
    getError: () => childError,
  };
}

function rawCompanionPing(
  endpoint: Readonly<LifecycleEndpoint>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const request = encodeRequest(NET_API_CLIENT_ID, "EMCP_WB_Ping", {});
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const socket = new Socket();
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      callback();
    };
    const decode = (): void => {
      const response = Buffer.concat(chunks);
      if (response.length === 0) {
        reject(new Error("Workbench returned an empty Ping response."));
        return;
      }
      try {
        resolvePromise(decodeResponse<Record<string, unknown>>(response));
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new Error(`Workbench companion Ping timed out after ${timeoutMs}ms.`));
      });
    }, timeoutMs);
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_PING_RESPONSE_BYTES) {
        finish(() => {
          socket.destroy();
          reject(new Error("Workbench companion Ping response exceeded the size limit."));
        });
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => finish(decode));
    socket.on("close", () => finish(decode));
    socket.connect(endpoint.port, endpoint.host, () => socket.end(request));
  });
}

function exactCompanionIdentity(
  response: Record<string, unknown>,
  expected: WorkbenchCompanionLaunch
): WorkbenchRunnerCompanionIdentity {
  const matches = response.status === "ok" &&
    response.helperAddonId === expected.addonId &&
    response.helperAddonGuid === expected.addonGuid &&
    response.helperAddonVersion === expected.addonVersion &&
    response.helperProtocolVersion === expected.protocolVersion &&
    response.workbenchProtocol === expected.protocolVersion &&
    response.helperBuildIdentity === expected.buildIdentity &&
    response.helperAddonId === WORKBENCH_HELPER_ADDON_ID &&
    response.helperAddonGuid === WORKBENCH_HELPER_ADDON_GUID &&
    response.helperAddonVersion === WORKBENCH_HELPER_ADDON_VERSION &&
    response.helperProtocolVersion === WORKBENCH_HELPER_PROTOCOL_VERSION &&
    response.helperBuildIdentity === WORKBENCH_HELPER_BUILD_IDENTITY;
  if (!matches) {
    throw new WorkbenchRunnerError(
      "Workbench NET API responded without the exact MCP-managed companion identity.",
      "IDENTITY_UNVERIFIABLE"
    );
  }
  return Object.freeze({
    addonId: expected.addonId,
    addonGuid: expected.addonGuid,
    addonVersion: expected.addonVersion,
    protocolVersion: expected.protocolVersion,
    workbenchProtocol: expected.protocolVersion,
    buildIdentity: expected.buildIdentity,
    bundleDigest: expected.bundleDigest,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref();
  });
}

function abortPromise(signal: AbortSignal | undefined): Promise<"aborted"> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolvePromise) => {
    signal.addEventListener("abort", () => resolvePromise("aborted"), { once: true });
  });
}

async function inspectSpawnedIdentity(
  session: WorkbenchLifecycleSession,
  child: ChildProcess,
  childExit: ChildObservation,
  executablePath: string,
  ownerArgument: string,
  launchedAtMs: number
): Promise<WorkbenchIdentity> {
  if (!child.pid) {
    throw new WorkbenchRunnerError(
      "Workbench spawn returned no PID, so exact ownership cannot be established.",
      "IDENTITY_UNVERIFIABLE"
    );
  }
  return Promise.race([
    session.inspectSpawnedWorkbench({
      pid: child.pid,
      executablePath,
      ownerTokenArgument: ownerArgument,
      launchedAtMs,
    }),
    childExit.closePromise.then((exit) => {
      throw new WorkbenchRunnerError(
        `Workbench exited before exact ownership was established ` +
          `(exit code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"}).`,
        "IDENTITY_UNVERIFIABLE"
      );
    }),
  ]);
}

async function probeEndpointOwnership(args: {
  session: WorkbenchLifecycleSession;
  endpoint: LifecycleEndpoint;
  identity: WorkbenchIdentity;
  childExit: ChildObservation;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<"verified"> {
  const deadline = Date.now() + args.timeoutMs;
  while (!args.childExit.hasClosed() && !args.signal?.aborted) {
    const childError = args.childExit.getError();
    if (childError) throw childError;
    const result = await args.session.verifyEndpointOwner(args.endpoint, args.identity);
    if (result.kind === "owned") return "verified";
    if (result.reason !== "listener_not_found") {
      const exitedDuringInspection = await Promise.race([
        args.childExit.closePromise.then(() => true),
        delay(args.pollMs).then(() => false),
      ]);
      if (exitedDuringInspection) break;
      throw new WorkbenchRunnerError(
        `Workbench endpoint ownership could not be proven (${result.reason}): ${result.message}`,
        "ENDPOINT_UNVERIFIABLE"
      );
    }
    if (Date.now() >= deadline) break;
    await Promise.race([
      args.childExit.closePromise.then(() => undefined),
      args.childExit.errorPromise.then(() => undefined),
      delay(args.pollMs),
    ]);
  }
  if (args.signal?.aborted) {
    throw new WorkbenchRunnerError(
      "Workbench companion readiness was aborted before endpoint ownership was proven.",
      "ENDPOINT_UNVERIFIABLE"
    );
  }
  const childError = args.childExit.getError();
  if (childError) throw childError;
  throw new WorkbenchRunnerError(
    "Workbench exited or timed out before exact endpoint ownership was proven.",
    "ENDPOINT_UNVERIFIABLE"
  );
}

async function waitForCompanionIdentity(args: {
  endpoint: LifecycleEndpoint;
  expected: WorkbenchCompanionLaunch;
  childExit: ChildObservation;
  probe: WorkbenchRunnerCompanionProbe;
  timeoutMs: number;
  pollMs: number;
  signal?: AbortSignal;
}): Promise<WorkbenchRunnerCompanionIdentity> {
  const deadline = Date.now() + args.timeoutMs;
  let lastError: unknown;
  while (!args.childExit.hasClosed() && !args.signal?.aborted && Date.now() < deadline) {
    const childError = args.childExit.getError();
    if (childError) throw childError;
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const response = await args.probe(args.endpoint, Math.min(3_000, remaining));
      return exactCompanionIdentity(response, args.expected);
    } catch (error) {
      if (error instanceof WorkbenchRunnerError && error.code === "IDENTITY_UNVERIFIABLE") {
        throw error;
      }
      lastError = error;
    }
    await Promise.race([
      args.childExit.closePromise.then(() => undefined),
      args.childExit.errorPromise.then(() => undefined),
      delay(args.pollMs),
    ]);
  }
  if (args.signal?.aborted) {
    throw new WorkbenchRunnerError(
      "Workbench companion readiness was aborted before exact identity was proven.",
      "IDENTITY_UNVERIFIABLE"
    );
  }
  const childError = args.childExit.getError();
  if (childError) throw childError;
  const detail = lastError instanceof Error ? ` Last Ping error: ${lastError.message}` : "";
  throw new WorkbenchRunnerError(
    `Workbench did not prove the exact companion identity before exit or timeout.${detail}`,
    "IDENTITY_UNVERIFIABLE"
  );
}

function snapshotLogDirectories(logRoot: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const entry of readdirSync(logRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(logRoot, entry.name);
    snapshot.set(pathKey(path), statSync(path).mtimeMs);
  }
  return snapshot;
}

function candidateLogDirectories(
  logRoot: string,
  before: ReadonlyMap<string, number>,
  launchedAtMs: number
): CandidateLogDirectory[] {
  const candidates: CandidateLogDirectory[] = [];
  for (const entry of readdirSync(logRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const joined = join(logRoot, entry.name);
    const modifiedMs = statSync(joined).mtimeMs;
    if (!before.has(pathKey(joined)) || modifiedMs >= launchedAtMs - LOG_CLOCK_SKEW_MS) {
      const canonical = realpathSync.native(joined);
      if (pathKey(dirname(canonical)) !== pathKey(logRoot)) {
        throw new WorkbenchRunnerError(
          `Workbench log candidate escapes the configured log root: ${joined}`,
          "LOG_ATTRIBUTION_FAILED"
        );
      }
      candidates.push({ path: canonical, name: entry.name, modifiedMs });
    }
  }
  return candidates.sort((left, right) =>
    left.modifiedMs - right.modifiedMs || left.name.localeCompare(right.name)
  );
}

async function streamContainsAny(path: string, needles: readonly string[]): Promise<boolean> {
  const longest = Math.max(...needles.map((needle) => Buffer.byteLength(needle, "utf8")));
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
    const text = combined.toString("utf8");
    if (needles.some((needle) => text.includes(needle))) return true;
    carry = combined.subarray(Math.max(0, combined.length - longest - 4));
  }
  return false;
}

async function logDirectoryContainsOwner(
  candidate: CandidateLogDirectory,
  ownerToken: string
): Promise<boolean> {
  const needles = [
    `-reforgerForgeOwnerToken=${ownerToken}`,
    `-reforgerForgeOwnerToken ${ownerToken}`,
  ];
  const files = readdirSync(candidate.path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith(".log"))
    .map((entry) => join(candidate.path, entry.name));
  for (const file of files) {
    if (await streamContainsAny(file, needles)) return true;
  }
  return false;
}

async function attributeLogDirectory(args: {
  logRoot: string;
  before: ReadonlyMap<string, number>;
  launchedAtMs: number;
  ownerToken: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<string> {
  const deadline = Date.now() + args.timeoutMs;
  do {
    const matches: string[] = [];
    const candidates = candidateLogDirectories(args.logRoot, args.before, args.launchedAtMs);
    for (const candidate of candidates) {
      if (await logDirectoryContainsOwner(candidate, args.ownerToken)) matches.push(candidate.path);
    }
    if (matches.length > 1) {
      throw new WorkbenchRunnerError(
        `The exact private owner token appeared in ${matches.length} Workbench log directories.`,
        "LOG_ATTRIBUTION_FAILED"
      );
    }
    if (matches.length === 1) return matches[0];
    if (Date.now() < deadline) await delay(args.pollMs);
  } while (Date.now() < deadline);
  throw new WorkbenchRunnerError(
    "No Workbench log directory contained the exact private owner token before the attribution deadline.",
    "LOG_ATTRIBUTION_FAILED"
  );
}

function expectedState(state: WorkbenchLifecycleStateV3): ExpectedStateVersion {
  return { generation: state.generation, leaseId: state.mcpOwner?.leaseId ?? null };
}

function lifecycleDraft(
  state: WorkbenchLifecycleStateV3,
  overrides: Partial<LifecycleStateDraft>
): LifecycleStateDraft {
  return {
    phase: overrides.phase ?? state.phase,
    endpoint: overrides.endpoint ?? state.endpoint,
    target: overrides.target === undefined ? state.target : overrides.target,
    mcpOwner: overrides.mcpOwner === undefined ? state.mcpOwner : overrides.mcpOwner,
    workbench: overrides.workbench === undefined ? state.workbench : overrides.workbench,
    companion: overrides.companion === undefined ? state.companion : overrides.companion,
    operation: overrides.operation === undefined ? state.operation : overrides.operation,
  };
}

function companionState(companion: WorkbenchCompanionLaunch): WorkbenchCompanionLifecycleState {
  return {
    addonId: companion.addonId,
    addonGuid: companion.addonGuid,
    addonDirectory: companion.addonDirectory,
    addonSearchRoot: companion.addonSearchRoot,
    bundleDigest: companion.bundleDigest,
    buildIdentity: companion.buildIdentity,
    profilePath: companion.workbenchProfilePath,
  };
}

async function claimExternalRunLifecycle(
  session: WorkbenchLifecycleSession,
  endpoint: LifecycleEndpoint,
  target: CanonicalProjectIdentity,
  companion: WorkbenchCompanionLaunch
): Promise<WorkbenchLifecycleStateV3> {
  const read = await session.readState();
  if (read.kind !== "missing" && read.kind !== "valid") {
    throw new WorkbenchRunnerError(
      `Standalone Workbench launch is refused while lifecycle state is ${read.kind}; ` +
        "use the MCP lifecycle recovery path first.",
      "LIFECYCLE_CONFLICT"
    );
  }
  if (read.kind === "valid") {
    const state = read.state;
    if (state.endpoint.host !== endpoint.host || state.endpoint.port !== endpoint.port) {
      throw new WorkbenchRunnerError(
        `The durable lifecycle endpoint ${state.endpoint.host}:${state.endpoint.port} conflicts with ` +
          `${endpoint.host}:${endpoint.port}.`,
        "LIFECYCLE_CONFLICT"
      );
    }
    if (state.phase !== "vacant" || state.workbench !== null || state.operation !== null) {
      throw new WorkbenchRunnerError(
        `The durable Workbench lifecycle is ${state.phase}; recover or shut it down before an external run.`,
        "LIFECYCLE_CONFLICT"
      );
    }
  }
  const claim = await session.validateAndClaim({
    endpoint,
    target,
  });
  if (claim.kind === "refused") {
    throw new WorkbenchRunnerError(
      `The standalone Workbench lifecycle claim was refused (${claim.code}): ${claim.message}`,
      "LIFECYCLE_CONFLICT"
    );
  }
  const claimed = claim.state;
  if (claimed.phase !== "vacant" || claimed.workbench !== null || claimed.operation !== null) {
    throw new WorkbenchRunnerError(
      `The claimed Workbench lifecycle is ${claimed.phase}, not vacant.`,
      "LIFECYCLE_CONFLICT"
    );
  }
  return session.transition(expectedState(claimed), lifecycleDraft(claimed, {
    phase: "starting",
    target,
    companion: companionState(companion),
    workbench: null,
    operation: { kind: "launch", operationId: randomUUID() },
  }));
}

async function waitForExitOrControl(args: {
  childExit: ChildObservation;
  timeoutMs: number | null;
  signal?: AbortSignal;
}): Promise<
  | { reason: "exited"; exit: ChildExit }
  | { reason: "child_error"; error: WorkbenchRunnerError }
  | { reason: "timed_out" | "aborted" }
> {
  const controls: Array<Promise<{ reason: "timed_out" | "aborted" }>> = [
    abortPromise(args.signal).then(() => ({ reason: "aborted" as const })),
  ];
  if (args.timeoutMs !== null) {
    controls.push(delay(Math.max(1, args.timeoutMs)).then(() => ({ reason: "timed_out" as const })));
  }
  return Promise.race([
    args.childExit.closePromise.then((exit) => ({ reason: "exited" as const, exit })),
    args.childExit.errorPromise.then((error) => ({ reason: "child_error" as const, error })),
    ...controls,
  ]);
}

interface ExactAbsenceResult {
  exit: ChildExit;
  error?: WorkbenchRunnerError;
}

async function terminateExactAndObserve(args: {
  session: WorkbenchLifecycleSession;
  guard: WorkbenchProcessGuard;
  identity: WorkbenchIdentity;
  childExit: ChildObservation;
  timeoutMs: number;
}): Promise<ExactAbsenceResult> {
  let refusal: WorkbenchRunnerError | undefined;
  try {
    const result = await args.session.verifyAndTerminate(args.identity, args.timeoutMs);
    if (result.kind === "refused") {
      refusal = new WorkbenchRunnerError(
        `Exact Workbench termination was refused (${result.reason}): ${result.message}`,
        "TERMINATION_REFUSED"
      );
    }
  } catch (error) {
    refusal = new WorkbenchRunnerError(
      `Exact Workbench termination could not be verified: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      "TERMINATION_REFUSED"
    );
  }
  let exit: ChildExit | null = args.childExit.hasClosed()
    ? await args.childExit.closePromise
    : null;
  // On refusal or uncertain helper outcome, keep the lifecycle lock until the
  // exact identity disappears naturally. ChildProcess error is not an exit.
  const pollMs = Math.max(1, Math.min(250, args.timeoutMs));
  for (;;) {
    let status: "live" | "absent";
    try {
      status = await args.guard.inspectOwnedWorkbench(args.identity);
    } catch (error) {
      const observed = await args.childExit.closePromise;
      return {
        exit: observed,
        error: refusal ?? new WorkbenchRunnerError(
          `Exact Workbench absence became unverifiable: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          "IDENTITY_UNVERIFIABLE"
        ),
      };
    }
    if (status === "absent") {
      return {
        exit: exit ?? { code: null, signal: null },
        ...(refusal ? { error: refusal } : {}),
      };
    }
    const observed = await Promise.race([
      args.childExit.closePromise.then((value) => ({ kind: "close" as const, value })),
      delay(pollMs).then(() => ({ kind: "poll" as const })),
    ]);
    if (observed.kind === "close") exit = observed.value;
  }
}

async function ensureExactChildAbsent(args: {
  session: WorkbenchLifecycleSession;
  guard: WorkbenchProcessGuard;
  identity: WorkbenchIdentity | null;
  childExit: ChildObservation;
  timeoutMs: number;
}): Promise<ExactAbsenceResult> {
  if (!args.identity) {
    return { exit: await args.childExit.closePromise };
  }
  try {
    const status = await args.guard.inspectOwnedWorkbench(args.identity);
    if (status === "absent") {
      return {
        exit: args.childExit.hasClosed()
          ? await args.childExit.closePromise
          : { code: null, signal: null },
      };
    }
  } catch (error) {
    // If exact OS inspection becomes contradictory, the retained ChildProcess
    // close event is the only safe proof that this spawned child is gone.
    return {
      exit: await args.childExit.closePromise,
      error: new WorkbenchRunnerError(
        `Exact Workbench absence became unverifiable: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "IDENTITY_UNVERIFIABLE"
      ),
    };
  }
  return terminateExactAndObserve(args as {
    session: WorkbenchLifecycleSession;
    guard: WorkbenchProcessGuard;
    identity: WorkbenchIdentity;
    childExit: ChildObservation;
    timeoutMs: number;
  });
}

function safeSpawn(
  spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>,
  executablePath: string,
  args: readonly string[],
  options: SpawnOptions
): ChildProcess {
  try {
    return spawnProcess(executablePath, args, options);
  } catch (error) {
    throw new WorkbenchRunnerError(
      `Could not spawn Workbench: ${error instanceof Error ? error.message : String(error)}`,
      "SPAWN_FAILED"
    );
  }
}

interface BuildCompanionPreflightArgs {
  session: WorkbenchLifecycleSession;
  guard: WorkbenchProcessGuard;
  config: Config;
  executablePath: string;
  target: CanonicalProjectIdentity;
  companion: WorkbenchCompanionLaunch;
  companionProvider: WorkbenchCompanionProvider;
  reattestCompanion: () => WorkbenchCompanionLaunch;
  reattestTarget: () => WorkbenchBuildProjectMetadata;
  addonDirectories: readonly string[];
  endpoint: LifecycleEndpoint;
  logRoot: string;
  spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>;
  endpointProbeTimeoutMs: number;
  endpointPollMs: number;
  companionProbe: WorkbenchRunnerCompanionProbe;
  logAttributionTimeoutMs: number;
  logPollMs: number;
  terminationTimeoutMs: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

interface BuildCompanionPreflightResult {
  proof: WorkbenchBuildPreflightProof;
  companionIdentity: WorkbenchRunnerCompanionIdentity;
}

async function runBuildCompanionPreflight(
  args: BuildCompanionPreflightArgs
): Promise<BuildCompanionPreflightResult> {
  let lifecycle = await claimExternalRunLifecycle(
    args.session,
    args.endpoint,
    args.target,
    args.companion
  );
  let child: ChildProcess | null = null;
  let childExit: ChildObservation | null = null;
  let identity: WorkbenchIdentity | null = null;
  let verifiedCompanion: WorkbenchRunnerCompanionIdentity | null = null;
  let lifecycleGeneration: string | null = null;
  let endpointOwnership: "verified" | null = null;
  let beforeLogs: Map<string, number> | null = null;
  let ownerToken: string | null = null;
  let logDirectory: string | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let absenceProven = false;
  let endpointVacant = false;

  try {
    if (args.signal?.aborted) {
      throw new WorkbenchRunnerError(
        "Workbench build was aborted before companion preflight spawn.",
        "BUILD_ABORTED"
      );
    }
    if (Date.now() >= args.deadlineMs) {
      throw new WorkbenchRunnerError(
        "Workbench build deadline expired before companion preflight spawn.",
        "BUILD_DEADLINE_EXCEEDED"
      );
    }
    await args.session.assertNoWorkbenchProcesses();
    args.reattestTarget();
    args.reattestCompanion();
    args.companionProvider.applyRetention?.({ protectedDigests: [args.companion.bundleDigest] });
    beforeLogs = snapshotLogDirectories(args.logRoot);
    ownerToken = args.guard.createOwnerToken();
    const ownerArgument = args.guard.ownerArgument(ownerToken);
    const launchArguments = buildPreflightArguments(
      args.config,
      args.target.path,
      args.addonDirectories,
      args.companion,
      ownerArgument
    );
    if (args.signal?.aborted) {
      throw new WorkbenchRunnerError(
        "Workbench build was aborted before companion preflight spawn.",
        "BUILD_ABORTED"
      );
    }
    if (Date.now() >= args.deadlineMs) {
      throw new WorkbenchRunnerError(
        "Workbench build deadline expired before companion preflight spawn.",
        "BUILD_DEADLINE_EXCEEDED"
      );
    }
    args.reattestTarget();
    args.reattestCompanion();
    const launchedAtMs = Date.now();
    child = safeSpawn(args.spawnProcess, args.executablePath, launchArguments, {
      cwd: dirname(args.executablePath),
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    childExit = observeChild(child);
    identity = await inspectSpawnedIdentity(
      args.session,
      child,
      childExit,
      args.executablePath,
      ownerArgument,
      launchedAtMs
    );
    lifecycle = await args.session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
      phase: "starting",
      workbench: identity,
    }));
    endpointOwnership = await probeEndpointOwnership({
      session: args.session,
      endpoint: args.endpoint,
      identity,
      childExit,
      timeoutMs: Math.max(1, Math.min(args.endpointProbeTimeoutMs, args.deadlineMs - Date.now())),
      pollMs: args.endpointPollMs,
      signal: args.signal,
    });
    verifiedCompanion = await waitForCompanionIdentity({
      endpoint: args.endpoint,
      expected: args.companion,
      childExit,
      probe: args.companionProbe,
      timeoutMs: Math.max(1, Math.min(args.endpointProbeTimeoutMs, args.deadlineMs - Date.now())),
      pollMs: args.endpointPollMs,
      signal: args.signal,
    });
    args.reattestCompanion();
    lifecycle = await args.session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
      phase: "running",
      workbench: identity,
      companion: companionState(args.companion),
      operation: null,
    }));
    lifecycleGeneration = lifecycle.generation;
  } catch (error) {
    primaryError = error;
  }

  try {
    if (lifecycle.phase !== "vacant") {
      lifecycle = await args.session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
        phase: "stopping",
        workbench: identity,
        operation: { kind: "shutdown", operationId: randomUUID() },
      }));
    }
  } catch (error) {
    cleanupError = error;
  }

  if (childExit) {
    const absence = await ensureExactChildAbsent({
      session: args.session,
      guard: args.guard,
      identity,
      childExit,
      timeoutMs: args.terminationTimeoutMs,
    });
    cleanupError ??= absence.error ?? null;
    absenceProven = !absence.error;
  }

  if (!primaryError && !cleanupError && beforeLogs && ownerToken) {
    try {
      logDirectory = await attributeLogDirectory({
        logRoot: args.logRoot,
        before: beforeLogs,
        launchedAtMs: identity?.launchedAtMs ?? Date.now(),
        ownerToken,
        timeoutMs: args.logAttributionTimeoutMs,
        pollMs: args.logPollMs,
      });
    } catch (error) {
      primaryError = error;
    }
  }

  if (absenceProven) {
    try {
      const vacancy = await args.session.verifyEndpointVacant(args.endpoint);
      if (vacancy.kind !== "vacant") {
        throw new WorkbenchRunnerError(
          `Workbench companion endpoint remained occupied after exact child absence: ${vacancy.message}`,
          "ENDPOINT_UNVERIFIABLE"
        );
      }
      endpointVacant = true;
      args.reattestTarget();
      args.reattestCompanion();
    } catch (error) {
      primaryError ??= error;
    }
  }

  try {
    lifecycle = await args.session.transitionToVacant(expectedState(lifecycle), {
      endpoint: args.endpoint,
      target: args.target,
      companion: companionState(args.companion),
    });
  } catch (error) {
    cleanupError ??= error;
  }

  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  if (!identity || !verifiedCompanion || !lifecycleGeneration ||
      endpointOwnership !== "verified" || !logDirectory || !absenceProven || !endpointVacant) {
    throw new WorkbenchRunnerError(
      "Workbench companion preflight completed without a fully identity-bound proof.",
      "IDENTITY_UNVERIFIABLE"
    );
  }
  return {
    proof: {
      pid: identity.pid,
      lifecycleGeneration,
      endpointOwnership,
      endpointVacancy: "verified",
      executablePath: identity.executablePath,
      creationTime: identity.creationTime,
      logDirectory,
    },
    companionIdentity: verifiedCompanion,
  };
}

interface TargetBuildStageArgs {
  session: WorkbenchLifecycleSession;
  guard: WorkbenchProcessGuard;
  config: Config;
  intent: WorkbenchBuildIntent;
  executablePath: string;
  target: CanonicalProjectIdentity;
  buildProject: WorkbenchBuildProjectMetadata;
  companion: WorkbenchCompanionLaunch;
  companionProvider: WorkbenchCompanionProvider;
  reattestCompanion: () => WorkbenchCompanionLaunch;
  reattestTarget: () => WorkbenchBuildProjectMetadata;
  addonDirectories: readonly string[];
  endpoint: LifecycleEndpoint;
  logRoot: string;
  outputPath: string;
  preflight: BuildCompanionPreflightResult;
  spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>;
  logAttributionTimeoutMs: number;
  logPollMs: number;
  terminationTimeoutMs: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

async function runTargetBuildStage(args: TargetBuildStageArgs): Promise<WorkbenchBuildRunnerReceipt> {
  let lifecycle = await claimExternalRunLifecycle(
    args.session,
    args.endpoint,
    args.target,
    args.companion
  );
  let child: ChildProcess | null = null;
  let childExit: ChildObservation | null = null;
  let identity: WorkbenchIdentity | null = null;
  let lifecycleGeneration: string | null = null;
  let beforeLogs: Map<string, number> | null = null;
  let beforeOutput: Map<string, BuildOutputArtifactState> | null = null;
  let ownerToken: string | null = null;
  let launchedAtMs = 0;
  let reason: WorkbenchRunnerExitStatus["reason"] | null = null;
  let exit: ChildExit | null = null;
  let logDirectory: string | null = null;
  let output: WorkbenchBuildOutputProof | null = null;
  let validationFailure: WorkbenchBuildValidationFailure | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;
  let absenceProven = false;
  let endpointVacant = false;

  try {
    await args.session.assertNoWorkbenchProcesses();
    if (args.signal?.aborted) {
      throw new WorkbenchRunnerError(
        "Workbench build was aborted after companion preflight and before target spawn.",
        "BUILD_ABORTED"
      );
    }
    if (Date.now() >= args.deadlineMs) {
      throw new WorkbenchRunnerError(
        "Workbench build deadline expired after companion preflight and before target spawn.",
        "BUILD_DEADLINE_EXCEEDED"
      );
    }
    const revalidatedTarget = args.reattestTarget();
    args.reattestCompanion();
    args.companionProvider.applyRetention?.({ protectedDigests: [args.companion.bundleDigest] });
    beforeLogs = snapshotLogDirectories(args.logRoot);
    assertEmptyBuildOutput(args.outputPath);
    beforeOutput = snapshotBuildOutput(args.outputPath);
    ownerToken = args.guard.createOwnerToken();
    const ownerArgument = args.guard.ownerArgument(ownerToken);
    const launchArguments = targetBuildArguments(
      args.config,
      args.intent,
      args.target.path,
      args.addonDirectories,
      args.companion.workbenchProfilePath,
      ownerArgument,
      args.outputPath,
      revalidatedTarget.addonId
    );
    if (args.signal?.aborted) {
      throw new WorkbenchRunnerError(
        "Workbench build was aborted after companion preflight and before target spawn.",
        "BUILD_ABORTED"
      );
    }
    if (Date.now() >= args.deadlineMs) {
      throw new WorkbenchRunnerError(
        "Workbench build deadline expired after companion preflight and before target spawn.",
        "BUILD_DEADLINE_EXCEEDED"
      );
    }
    args.reattestTarget();
    args.reattestCompanion();
    launchedAtMs = Date.now();
    child = safeSpawn(args.spawnProcess, args.executablePath, launchArguments, {
      cwd: dirname(args.executablePath),
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    childExit = observeChild(child);
    identity = await inspectSpawnedIdentity(
      args.session,
      child,
      childExit,
      args.executablePath,
      ownerArgument,
      launchedAtMs
    );
    lifecycle = await args.session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
      phase: "starting",
      workbench: identity,
    }));
    lifecycle = await args.session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
      phase: "running",
      workbench: identity,
      companion: companionState(args.companion),
      operation: null,
    }));
    lifecycleGeneration = lifecycle.generation;

    const completion = await waitForExitOrControl({
      childExit,
      timeoutMs: Math.max(1, args.deadlineMs - Date.now()),
      signal: args.signal,
    });
    const observedChildError = childExit.getError();
    if (observedChildError) throw observedChildError;
    if (completion.reason === "child_error") throw completion.error;
    if (completion.reason === "exited") {
      reason = "exited";
      exit = completion.exit;
    } else {
      reason = completion.reason;
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    if (lifecycle.phase !== "vacant") {
      lifecycle = await args.session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
        phase: "stopping",
        workbench: identity,
        operation: { kind: "shutdown", operationId: randomUUID() },
      }));
    }
  } catch (error) {
    cleanupError = error;
  }

  if (childExit) {
    const absence = await ensureExactChildAbsent({
      session: args.session,
      guard: args.guard,
      identity,
      childExit,
      timeoutMs: args.terminationTimeoutMs,
    });
    exit ??= absence.exit;
    cleanupError ??= absence.error ?? null;
    absenceProven = !absence.error;
  }

  if (absenceProven) {
    if (!primaryError && !cleanupError && reason === "exited" && exit?.code === 0 && beforeOutput) {
      try {
        output = attestFreshBuildOutput(args.outputPath, beforeOutput);
      } catch (error) {
        if (error instanceof WorkbenchRunnerError && error.code === "OUTPUT_ATTESTATION_FAILED") {
          validationFailure = {
            code: "OUTPUT_ATTESTATION_FAILED",
            message: error.message.replace(
              /-reforgerForgeOwnerToken(?:=|\s+)[^\s"']+/gi,
              "-reforgerForgeOwnerToken=[redacted]"
            ),
          };
        } else {
          primaryError = error;
        }
      }
    }
    try {
      args.reattestTarget();
      args.reattestCompanion();
    } catch (error) {
      primaryError ??= error;
    }
    try {
      const vacancy = await args.session.verifyEndpointVacant(args.endpoint);
      if (vacancy.kind !== "vacant") {
        throw new WorkbenchRunnerError(
          `Workbench endpoint was occupied after exact target-build child absence: ${vacancy.message}`,
          "ENDPOINT_UNVERIFIABLE"
        );
      }
      endpointVacant = true;
    } catch (error) {
      primaryError ??= error;
    }
  }

  if (!primaryError && !cleanupError && beforeLogs && ownerToken) {
    try {
      logDirectory = await attributeLogDirectory({
        logRoot: args.logRoot,
        before: beforeLogs,
        launchedAtMs,
        ownerToken,
        timeoutMs: args.logAttributionTimeoutMs,
        pollMs: args.logPollMs,
      });
    } catch (error) {
      primaryError = error;
    }
  }

  try {
    lifecycle = await args.session.transitionToVacant(expectedState(lifecycle), {
      endpoint: args.endpoint,
      target: args.target,
      companion: companionState(args.companion),
    });
  } catch (error) {
    cleanupError ??= error;
  }

  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  if (!identity || !lifecycleGeneration || !reason || !exit || !logDirectory ||
      !absenceProven || !endpointVacant) {
    throw new WorkbenchRunnerError(
      "Workbench target build completed without a fully identity-bound process proof.",
      "IDENTITY_UNVERIFIABLE"
    );
  }
  return {
    version: 3,
    intent: "build",
    pid: identity.pid,
    executablePath: identity.executablePath,
    creationTime: identity.creationTime,
    target: args.target.path,
    targetAddon: {
      addonId: args.buildProject.addonId,
      addonGuid: args.buildProject.addonGuid,
      sourceSha256: args.buildProject.sourceSha256,
    },
    lifecycleGeneration,
    processOwnership: "verified",
    endpointVacancy: "verified",
    companionIdentity: args.preflight.companionIdentity,
    preflight: args.preflight.proof,
    logDirectory,
    output,
    validationFailure,
    exitStatus: {
      reason,
      exitCode: exit.code,
      signal: exit.signal,
      timedOut: reason === "timed_out",
    },
  };
}

/**
 * Run a structured Workbench purpose while retaining the shared machine mutex
 * and exact child ownership for the complete process lifetime.
 *
 * The runner claims the version-3 lifecycle as its own exact process, records
 * the staged companion and spawned Workbench, and returns it to vacant only
 * after exact child absence. A concurrent MCP therefore sees durable busy
 * state in addition to the machine mutex.
 */
export async function runWorkbenchIntent(
  config: Config,
  intent: WorkbenchRunnerIntent,
  dependencies: WorkbenchRunnerDependencies = {}
): Promise<WorkbenchRunnerReceipt> {
  if (!intent || (intent.kind !== "editor" && intent.kind !== "build")) {
    throw new WorkbenchRunnerError("Workbench runner intent is unsupported.", "INVALID_INTENT");
  }
  const project = canonicalizeGproj(intent.gprojPath);
  const buildProject = intent.kind === "build"
    ? resolveBuildProjectMetadata(project.displayPath)
    : null;
  const executablePath = resolveWorkbenchExecutable(config);
  const configuredAddonDirectories = validateWorkbenchAddonDirectories(config.workbenchAddonDirs);
  const companionProvider = dependencies.companionProvider ?? new WorkbenchHelperStager({
    managedRoot: config.observer?.managedRoot ?? defaultWorkbenchHelperManagedRoot(),
  });
  let companion: WorkbenchCompanionLaunch;
  try {
    companion = validateCompanionLaunch(
      companionProvider.ensureStaged(project.displayPath),
      project.modDirectory
    );
  } catch (error) {
    if (error instanceof WorkbenchRunnerError) throw error;
    throw new WorkbenchRunnerError(
      `Workbench companion add-on could not be staged: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      "INVALID_CONFIG"
    );
  }
  const reattestCompanion = (): WorkbenchCompanionLaunch => {
    if (!companionProvider.verifyStaged || !companionProvider.verifySourceDigest) {
      throw new WorkbenchRunnerError(
        "Workbench companion provider cannot re-attest both staged and packaged source identity.",
        "INVALID_CONFIG"
      );
    }
    let attested: WorkbenchCompanionLaunch;
    try {
      const sourceDigest = companionProvider.verifySourceDigest(companion.bundleDigest);
      if (sourceDigest !== companion.bundleDigest) {
        throw new Error("packaged source digest does not match the staged bundle");
      }
      attested = validateCompanionLaunch(
        companionProvider.verifyStaged(companion, project.displayPath),
        project.modDirectory
      );
    } catch (error) {
      throw new WorkbenchRunnerError(
        `Workbench companion source/stage re-attestation failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "IDENTITY_UNVERIFIABLE"
      );
    }
    if (attested.bundleDigest !== companion.bundleDigest ||
        pathKey(attested.addonDirectory) !== pathKey(companion.addonDirectory) ||
        pathKey(attested.addonSearchRoot) !== pathKey(companion.addonSearchRoot) ||
        pathKey(attested.workbenchProfilePath) !== pathKey(companion.workbenchProfilePath)) {
      throw new WorkbenchRunnerError(
        "Workbench companion re-attestation changed its staged identity.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    companion = attested;
    return companion;
  };
  const reattestBuildTarget = (): WorkbenchBuildProjectMetadata => {
    if (!buildProject) {
      throw new WorkbenchRunnerError(
        "Workbench build target metadata was not prepared.",
        "INVALID_TARGET"
      );
    }
    let current: WorkbenchBuildProjectMetadata;
    try {
      const identity = revalidateProjectIdentity(project);
      current = resolveBuildProjectMetadata(identity.displayPath);
    } catch (error) {
      if (error instanceof WorkbenchRunnerError) throw error;
      throw new WorkbenchRunnerError(
        `Workbench build target identity could not be revalidated: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "INVALID_TARGET"
      );
    }
    if (current.addonId !== buildProject.addonId ||
        current.addonGuid !== buildProject.addonGuid ||
        current.sourceSha256 !== buildProject.sourceSha256) {
      throw new WorkbenchRunnerError(
        "Workbench build target path, add-on ID/GUID, or project content changed after validation.",
        "INVALID_TARGET"
      );
    }
    return current;
  };
  reattestCompanion();
  const targetAddonSearchRoot = canonicalDirectory(
    dirname(project.modDirectory),
    "Workbench target add-on search root"
  );
  const targetAddonDirectories = validateWorkbenchAddonDirectories([
    ...configuredAddonDirectories,
    targetAddonSearchRoot,
  ]);
  const preflightAddonDirectories = validateWorkbenchAddonDirectories([
    ...targetAddonDirectories,
    companion.addonSearchRoot,
  ]);
  const buildAddonDirectories = targetAddonDirectories;
  const endpoint = validateEndpoint(config);
  const managedLogRoot = join(companion.workbenchProfilePath, "logs");
  if (!dependencies.logRoot) mkdirSync(managedLogRoot, { recursive: true });
  const logRoot = dependencies.logRoot
    ? canonicalDirectory(dependencies.logRoot, "Workbench log root")
    : canonicalDirectory(managedLogRoot, "Workbench log root");
  const outputPath = intent.kind === "build" ? validateBuildOutput(intent) : null;
  if (intent.kind === "editor" && intent.foreground !== true) {
    throw new WorkbenchRunnerError(
      "Editor intent must be foreground; detached mode has no persistent guardian.",
      "INVALID_INTENT"
    );
  }

  const endpointProbeTimeoutMs = positiveInteger(
    dependencies.endpointProbeTimeoutMs ?? DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS,
    "Endpoint probe timeout"
  );
  const endpointPollMs = positiveInteger(
    dependencies.endpointPollMs ?? DEFAULT_ENDPOINT_POLL_MS,
    "Endpoint poll interval"
  );
  const logAttributionTimeoutMs = positiveInteger(
    dependencies.logAttributionTimeoutMs ?? DEFAULT_LOG_ATTRIBUTION_TIMEOUT_MS,
    "Log attribution timeout"
  );
  const logPollMs = positiveInteger(
    dependencies.logPollMs ?? DEFAULT_LOG_POLL_MS,
    "Log poll interval"
  );
  const terminationTimeoutMs = positiveInteger(
    dependencies.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS,
    "Termination timeout"
  );
  const guard = dependencies.processGuard ?? new WorkbenchProcessGuard();
  const spawnProcess = dependencies.spawnProcess ?? ((command, args, options) =>
    spawnChild(command, [...args], options));

  return guard.withLifecycleLock(async (session) => {
    const target: CanonicalProjectIdentity = {
      path: project.displayPath,
      comparisonKey: project.comparisonKey,
    };
    if (intent.kind === "build") {
      if (!buildProject || !outputPath) {
        throw new WorkbenchRunnerError(
          "Workbench build project metadata or output was not prepared.",
          "INVALID_INTENT"
        );
      }
      const deadlineMs = Date.now() + intent.timeoutMs;
      const preflight = await runBuildCompanionPreflight({
        session,
        guard,
        config,
        executablePath,
        target,
        companion,
        companionProvider,
        reattestCompanion,
        reattestTarget: reattestBuildTarget,
        addonDirectories: preflightAddonDirectories,
        endpoint,
        logRoot,
        spawnProcess,
        endpointProbeTimeoutMs,
        endpointPollMs,
        companionProbe: dependencies.companionProbe ?? rawCompanionPing,
        logAttributionTimeoutMs,
        logPollMs,
        terminationTimeoutMs,
        deadlineMs,
        signal: dependencies.signal,
      });
      return runTargetBuildStage({
        session,
        guard,
        config,
        intent,
        executablePath,
        target,
        buildProject,
        companion,
        companionProvider,
        reattestCompanion,
        reattestTarget: reattestBuildTarget,
        addonDirectories: buildAddonDirectories,
        endpoint,
        logRoot,
        outputPath,
        preflight,
        spawnProcess,
        logAttributionTimeoutMs,
        logPollMs,
        terminationTimeoutMs,
        deadlineMs,
        signal: dependencies.signal,
      });
    }
    const editorIntent = intent;
    let lifecycle = await claimExternalRunLifecycle(session, endpoint, target, companion);
    let child: ChildProcess | null = null;
    let childExit: ChildObservation | null = null;
    let identity: WorkbenchIdentity | null = null;
    let verifiedCompanion: WorkbenchRunnerCompanionIdentity | null = null;
    let lifecycleGeneration: string | null = null;
    let endpointOwnership: "verified" | null = null;
    let beforeLogs: Map<string, number> | null = null;
    let ownerToken: string | null = null;
    let launchedAtMs = 0;
    let reason: WorkbenchRunnerExitStatus["reason"] | null = null;
    let exit: ChildExit | null = null;
    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    let logDirectory: string | null = null;
    let absenceProven = false;

    try {
      await session.assertNoWorkbenchProcesses();
      reattestCompanion();
      companionProvider.applyRetention?.({ protectedDigests: [companion.bundleDigest] });
      beforeLogs = snapshotLogDirectories(logRoot);
      ownerToken = guard.createOwnerToken();
      const ownerArgument = guard.ownerArgument(ownerToken);
      const args = editorArguments(
        config,
        editorIntent,
        project.displayPath,
        preflightAddonDirectories,
        companion,
        ownerArgument
      );
      launchedAtMs = Date.now();
      child = safeSpawn(spawnProcess, executablePath, args, {
        cwd: dirname(executablePath),
        detached: false,
        stdio: "ignore",
        windowsHide: false,
      });
      childExit = observeChild(child);
      identity = await inspectSpawnedIdentity(
        session,
        child,
        childExit,
        executablePath,
        ownerArgument,
        launchedAtMs
      );
      lifecycle = await session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
        phase: "starting",
        workbench: identity,
      }));

      endpointOwnership = await probeEndpointOwnership({
        session,
        endpoint,
        identity,
        childExit,
        timeoutMs: endpointProbeTimeoutMs,
        pollMs: endpointPollMs,
        signal: dependencies.signal,
      });
      verifiedCompanion = await waitForCompanionIdentity({
        endpoint,
        expected: companion,
        childExit,
        probe: dependencies.companionProbe ?? rawCompanionPing,
        timeoutMs: endpointProbeTimeoutMs,
        pollMs: endpointPollMs,
        signal: dependencies.signal,
      });
      reattestCompanion();
      lifecycle = await session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
        phase: "running",
        workbench: identity,
        companion: companionState(companion),
        operation: null,
      }));
      lifecycleGeneration = lifecycle.generation;

      const completion = await waitForExitOrControl({
        childExit,
        timeoutMs: null,
        signal: dependencies.signal,
      });
      const observedChildError = childExit.getError();
      if (observedChildError) throw observedChildError;
      if (completion.reason === "child_error") throw completion.error;
      if (completion.reason === "exited") {
        reason = "exited";
        exit = completion.exit;
      } else {
        reason = completion.reason;
      }
    } catch (error) {
      primaryError = error;
    }

    try {
      if (lifecycle.phase !== "vacant") {
        lifecycle = await session.transition(expectedState(lifecycle), lifecycleDraft(lifecycle, {
          phase: "stopping",
          workbench: identity,
          operation: { kind: "shutdown", operationId: randomUUID() },
        }));
      }
    } catch (error) {
      cleanupError = error;
    }

    if (childExit) {
      const absence = await ensureExactChildAbsent({
        session,
        guard,
        identity,
        childExit,
        timeoutMs: terminationTimeoutMs,
      });
      exit ??= absence.exit;
      cleanupError ??= absence.error ?? null;
      absenceProven = !absence.error;
    }

    if (absenceProven) {
      try {
        reattestCompanion();
      } catch (error) {
        primaryError ??= error;
      }
    }

    if (!primaryError && !cleanupError && beforeLogs && ownerToken) {
      try {
        logDirectory = await attributeLogDirectory({
          logRoot,
          before: beforeLogs,
          launchedAtMs,
          ownerToken,
          timeoutMs: logAttributionTimeoutMs,
          pollMs: logPollMs,
        });
      } catch (error) {
        primaryError = error;
      }
    }

    try {
      lifecycle = await session.transitionToVacant(expectedState(lifecycle), {
        endpoint,
        target,
        companion: companionState(companion),
      });
    } catch (error) {
      cleanupError ??= error;
    }

    if (cleanupError) throw cleanupError;
    if (primaryError) throw primaryError;
    if (!identity || !verifiedCompanion || !lifecycleGeneration ||
        endpointOwnership !== "verified" || !reason || !exit || !logDirectory || !absenceProven) {
      throw new WorkbenchRunnerError(
        "Workbench runner completed without a fully identity-bound receipt.",
        "IDENTITY_UNVERIFIABLE"
      );
    }
    return {
      version: 2,
      intent: "editor",
      pid: identity.pid,
      target: project.displayPath,
      lifecycleGeneration,
      endpointOwnership,
      companionIdentity: verifiedCompanion,
      logDirectory,
      exitStatus: {
        reason,
        exitCode: exit.code,
        signal: exit.signal,
        timedOut: reason === "timed_out",
      },
    };
  });
}

export type ParsedWorkbenchRunnerCommand = WorkbenchRunnerIntent;

/** Strict parser for the standalone CLI's two supported purposes. */
export function parseWorkbenchRunnerArguments(argv: readonly string[]): ParsedWorkbenchRunnerCommand {
  const [command, ...tokens] = argv;
  if (command !== "editor" && command !== "build") {
    throw new WorkbenchRunnerError(
      "Usage: reforger-forge-workbench editor --gproj <path> --foreground | " +
        "build --gproj <path> --platform PC --output <path> --timeout-ms <n>",
      "INVALID_INTENT"
    );
  }
  const values = new Map<string, string>();
  let foreground = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--foreground") {
      if (foreground) {
        throw new WorkbenchRunnerError("--foreground may appear only once.", "INVALID_INTENT");
      }
      foreground = true;
      continue;
    }
    if (!["--gproj", "--platform", "--output", "--timeout-ms"].includes(token)) {
      throw new WorkbenchRunnerError(`Unsupported Workbench runner argument: ${token}`, "INVALID_INTENT");
    }
    if (values.has(token) || index + 1 >= tokens.length || tokens[index + 1].startsWith("--")) {
      throw new WorkbenchRunnerError(`Argument ${token} requires one unique value.`, "INVALID_INTENT");
    }
    values.set(token, tokens[index + 1]);
    index += 1;
  }
  const gprojPath = values.get("--gproj");
  if (!gprojPath) {
    throw new WorkbenchRunnerError("--gproj is required.", "INVALID_INTENT");
  }
  if (command === "editor") {
    if (!foreground || values.size !== 1) {
      throw new WorkbenchRunnerError(
        "Editor requires exactly --gproj <path> --foreground; detached mode is unsupported.",
        "INVALID_INTENT"
      );
    }
    return { kind: "editor", gprojPath, foreground: true };
  }
  if (foreground || values.size !== 4) {
    throw new WorkbenchRunnerError(
      "Build requires exactly --gproj, --platform PC, --output, and --timeout-ms.",
      "INVALID_INTENT"
    );
  }
  if (values.get("--platform") !== "PC") {
    throw new WorkbenchRunnerError("Build --platform must be PC.", "INVALID_INTENT");
  }
  const timeoutMs = Number(values.get("--timeout-ms"));
  positiveInteger(timeoutMs, "Build --timeout-ms", MAX_BUILD_TIMEOUT_MS);
  return {
    kind: "build",
    gprojPath,
    platform: "PC",
    outputPath: values.get("--output")!,
    timeoutMs,
  };
}
