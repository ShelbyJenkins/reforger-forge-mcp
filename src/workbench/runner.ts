import { createHash } from "node:crypto";
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
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { redactText } from "../foundation/redact.js";
import {
  deadlineAt,
  deadlineAfter,
  deriveDeadline,
  pollUntil,
  systemClock,
  systemSleeper,
  type Deadline,
} from "../foundation/time.js";
import {
  canonicalizeExistingDirectory,
  isPathContained,
  pathComparisonKey,
} from "../foundation/managed-path.js";
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
import {
  buildCliEditorLaunchPlan,
  buildTargetBuildLaunchPlan,
  isLoopbackLifecycleHost,
  WORKBENCH_PROCESS_NAME,
  WorkbenchLaunchPlanError,
  type WorkbenchLaunchEndpoint,
  toLifecycleTarget,
  type WorkbenchLifecycleTarget,
} from "./launch-plan.js";
import {
  ensureWorkbenchManagedBuildProfile,
  type WorkbenchManagedBuildProfile,
} from "./managed-build-profile.js";
import {
  canonicalizeGproj,
  revalidateProjectIdentity,
  type CanonicalProjectIdentity as CanonicalGprojIdentity,
} from "./project-identity.js";
import {
  WorkbenchNetApiClient,
  type WorkbenchNetApiPort,
} from "./net-api-client.js";
import {
  type WorkbenchLifecycleChildProcess,
  type WorkbenchLifecycleChildSupervisor,
  type WorkbenchLifecycleExecutionPort,
  type WorkbenchLifecycleGuard,
  type WorkbenchLifecycleSpawnOptions,
} from "./lifecycle-execution.js";
import {
  WorkbenchRunError,
  WorkbenchSessionController,
  type WorkbenchTargetBuildHandoff,
} from "./session-controller.js";

const WORKBENCH_SUBDIRECTORY = "Workbench";
const DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_ENDPOINT_POLL_MS = 200;
const DEFAULT_LOG_ATTRIBUTION_TIMEOUT_MS = 10_000;
const DEFAULT_LOG_POLL_MS = 200;
const DEFAULT_TERMINATION_TIMEOUT_MS = 15_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 15_000;
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
  | "RECOVERY_REQUIRED"
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

function rethrowLaunchPlanError(error: unknown): never {
  if (error instanceof WorkbenchRunnerError) throw error;
  if (error instanceof WorkbenchLaunchPlanError) {
    throw new WorkbenchRunnerError(
      error.message,
      error.code === "INVALID_TARGET" ? "INVALID_TARGET" : "INVALID_CONFIG"
    );
  }
  throw new WorkbenchRunnerError(
    `Workbench launch plan could not be prepared: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    "INVALID_CONFIG"
  );
}

function mapControllerRunError(
  error: unknown,
  intent: "editor" | "build"
): unknown {
  if (!(error instanceof WorkbenchRunError)) return error;
  if (error.code === "ABORTED") {
    return new WorkbenchRunnerError(
      error.message,
      intent === "build" ? "BUILD_ABORTED" : "ENDPOINT_UNVERIFIABLE"
    );
  }
  if (error.code === "DEADLINE_EXCEEDED") {
    return new WorkbenchRunnerError(error.message, "BUILD_DEADLINE_EXCEEDED");
  }
  return new WorkbenchRunnerError(
    error.message,
    error.code === "ENDPOINT_UNVERIFIABLE" || error.code === "SPAWN_FAILED"
      ? error.code
      : "IDENTITY_UNVERIFIABLE"
  );
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

/**
 * @deprecated Currently emitted until the target-only live evidence gate
 * passes; retained readable/exported through Stage 6.
 */
export interface WorkbenchBuildRunnerReceiptV3 {
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

/** Pre-encoded post-gate contract. Stage 3 does not emit this shape yet. */
export interface WorkbenchBuildRunnerReceiptV4 {
  version: 4;
  intent: "build";
  pid: number;
  executablePath: string;
  creationTime: string;
  target: string;
  targetAddon: { addonId: string; addonGuid: string; sourceSha256: string };
  lifecycleGeneration: string;
  processOwnership: "verified";
  endpointVacancy: "verified";
  logDirectory: string;
  output: WorkbenchBuildOutputProof | null;
  validationFailure: WorkbenchBuildValidationFailure | null;
  exitStatus: WorkbenchRunnerExitStatus;
}

/** Compatibility name for the currently emitted version-3 receipt. */
export type WorkbenchBuildRunnerReceipt = WorkbenchBuildRunnerReceiptV3;

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
  endpoint: Readonly<WorkbenchLaunchEndpoint>,
  timeoutMs: number
) => Promise<Record<string, unknown>>;

export interface WorkbenchRunnerDependencies {
  processGuard?: WorkbenchLifecycleGuard;
  companionProvider?: WorkbenchCompanionProvider;
  /** Explicit shared managed root for embedded/custom companion providers. */
  managedRoot?: string;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: WorkbenchLifecycleSpawnOptions
  ) => WorkbenchLifecycleChildProcess;
  /** Explicit test/embedding override. The CLI normally derives this from MCP configuration. */
  logRoot?: string;
  signal?: AbortSignal;
  endpointProbeTimeoutMs?: number;
  endpointPollMs?: number;
  companionProbe?: WorkbenchRunnerCompanionProbe;
  logAttributionTimeoutMs?: number;
  logPollMs?: number;
  terminationTimeoutMs?: number;
  /** Hard post-termination bound for proving exact child absence. */
  recoveryTimeoutMs?: number;
  /** Shared child registry for the complete editor or two-stage build run. */
  childSupervisor?: WorkbenchLifecycleChildSupervisor;
  /** Precomposed controller-owned lifecycle boundary for embedding and tests. */
  lifecycleExecution?: WorkbenchLifecycleExecutionPort;
}

interface CandidateLogDirectory {
  path: string;
  name: string;
  modifiedMs: number;
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
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
  try {
    return canonicalizeExistingDirectory(absolute, label);
  } catch (error) {
    throw new WorkbenchRunnerError(
      `${label} is not an accessible directory: ${absolute} ` +
        `(${error instanceof Error ? error.message : String(error)})`,
      label === "Workbench log root" ? "INVALID_LOG_ROOT" : "INVALID_CONFIG"
    );
  }
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
    const key = pathComparisonKey(directory);
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
    roots.set(pathComparisonKey(canonical), canonical);
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

function validateEndpoint(
  config: Pick<Config, "workbenchHost" | "workbenchPort">
): WorkbenchLaunchEndpoint {
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

function validateBuildOutput(
  intent: WorkbenchBuildIntent,
  protectedRoots: ReadonlyArray<{ label: string; path: string }> = []
): string {
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
  assertBuildOutputIsolated(output, protectedRoots);
  try {
    mkdirSync(output, { recursive: true });
    const canonical = canonicalDirectory(output, "Workbench build output");
    // Recheck after filesystem canonicalization so a junction/symlinked parent
    // cannot make a lexically separate output alias a protected lifecycle root.
    assertBuildOutputIsolated(canonical, protectedRoots);
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

function assertBuildOutputIsolated(
  output: string,
  protectedRoots: ReadonlyArray<{ label: string; path: string }>
): void {
  for (const protectedRoot of protectedRoots) {
    if (pathsOverlap(output, protectedRoot.path)) {
      throw new WorkbenchRunnerError(
        `Workbench build output must not overlap ${protectedRoot.label}: ${protectedRoot.path}`,
        "INVALID_INTENT"
      );
    }
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

interface WorkbenchBuildOutputReservation {
  readonly root: string;
  /** Synchronous final check used from the recoverable-spawn callback. */
  revalidateAndSnapshot(): Map<string, BuildOutputArtifactState>;
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
      if (!isPathContained(root, canonical)) {
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
          pathComparisonKey(realpathSync.native(lexical)) !== pathComparisonKey(canonical)) {
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

function reserveBuildOutput(root: string): WorkbenchBuildOutputReservation {
  assertEmptyBuildOutput(root);
  return Object.freeze({
    root,
    revalidateAndSnapshot(): Map<string, BuildOutputArtifactState> {
      assertEmptyBuildOutput(root);
      return snapshotBuildOutput(root);
    },
  });
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
  if (!isPathContained(addonSearchRoot, addonDirectory)) {
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

function runnerCompanionPing(
  endpoint: Readonly<WorkbenchLaunchEndpoint>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const transport = new WorkbenchNetApiClient(endpoint.host, endpoint.port, {
    clientId: NET_API_CLIENT_ID,
    responseCapBytes: MAX_PING_RESPONSE_BYTES,
  });
  return transport.call<Record<string, unknown>>("EMCP_WB_Ping", {}, {
    timeoutMs,
    responseCapBytes: MAX_PING_RESPONSE_BYTES,
  });
}

function companionProbePort(
  endpoint: Readonly<WorkbenchLaunchEndpoint>,
  probe: WorkbenchRunnerCompanionProbe
): WorkbenchNetApiPort {
  return Object.freeze({
    async call<T = Record<string, unknown>>(
      apiFunc: string,
      _params: Record<string, unknown> = {},
      options: { timeoutMs?: number } = {}
    ): Promise<T> {
      if (apiFunc !== "EMCP_WB_Ping") {
        throw new TypeError(`Runner readiness probe does not support ${apiFunc}.`);
      }
      const response = await probe(
        endpoint,
        options.timeoutMs ?? DEFAULT_ENDPOINT_PROBE_TIMEOUT_MS
      );
      return response as T;
    },
  });
}

function snapshotLogDirectories(logRoot: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const entry of readdirSync(logRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(logRoot, entry.name);
    snapshot.set(pathComparisonKey(path), statSync(path).mtimeMs);
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
    if (!before.has(pathComparisonKey(joined)) || modifiedMs >= launchedAtMs - LOG_CLOCK_SKEW_MS) {
      const canonical = realpathSync.native(joined);
      if (pathComparisonKey(dirname(canonical)) !== pathComparisonKey(logRoot)) {
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
  deadline: Deadline;
  pollMs: number;
}): Promise<string> {
  const result = await pollUntil<string>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: args.deadline,
    intervalMs: args.pollMs,
    probe: async (): Promise<string | undefined> => {
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
      return matches.length === 1 ? matches[0] : undefined;
    },
  });
  if (result.kind === "value") return result.value;
  throw new WorkbenchRunnerError(
    "No Workbench log directory contained the exact private owner token before the attribution deadline.",
    "LOG_ATTRIBUTION_FAILED"
  );
}

interface BuildCompanionPreflightArgs {
  controller: WorkbenchSessionController;
  config: Config;
  executablePath: string;
  target: WorkbenchLifecycleTarget;
  companion: WorkbenchCompanionLaunch;
  companionProvider: WorkbenchCompanionProvider;
  reattestCompanion: () => WorkbenchCompanionLaunch;
  reattestTarget: () => WorkbenchBuildProjectMetadata;
  addonDirectories: readonly string[];
  endpoint: WorkbenchLaunchEndpoint;
  logRoot: string;
  outputReservation: WorkbenchBuildOutputReservation;
  endpointProbeTimeoutMs: number;
  endpointPollMs: number;
  companionProbe: WorkbenchRunnerCompanionProbe;
  logAttributionTimeoutMs: number;
  logPollMs: number;
  terminationTimeoutMs: number;
  recoveryTimeoutMs: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

interface BuildCompanionPreflightResult {
  proof: WorkbenchBuildPreflightProof;
  companionIdentity: WorkbenchRunnerCompanionIdentity;
  handoff: WorkbenchTargetBuildHandoff;
}

async function runBuildCompanionPreflight(
  args: BuildCompanionPreflightArgs
): Promise<BuildCompanionPreflightResult> {
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
  args.companionProvider.applyRetention?.({ protectedDigests: [args.companion.bundleDigest] });
  const beforeLogs = snapshotLogDirectories(args.logRoot);
  const owner = args.controller.createPlanOwnerCredential();
  const launchArguments = buildPreflightArguments(
    args.config,
    args.target.path,
    args.addonDirectories,
    args.companion,
    owner.argument
  );
  let logDirectory: string | null = null;
  try {
    const result = await args.controller.runTemporaryCompanionPreflight({
      kind: "temporary_companion_preflight",
      executablePath: args.executablePath,
      lifecycleTarget: args.target,
      helper: args.companion,
      endpoint: args.endpoint,
      ownerArgument: owner.argument,
      argv: launchArguments,
      spawnOptions: {
        cwd: dirname(args.executablePath),
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      },
    }, {
      deadlineMs: args.deadlineMs,
      signal: args.signal,
      terminationTimeoutMs: args.terminationTimeoutMs,
      recoveryTimeoutMs: args.recoveryTimeoutMs,
      beforeClaim: () => { args.outputReservation.revalidateAndSnapshot(); },
      afterClaim: () => { args.outputReservation.revalidateAndSnapshot(); },
      beforeFinalVacancyCheck: () => {
        args.reattestTarget();
        args.reattestCompanion();
      },
      beforeSpawn: () => {
        args.reattestTarget();
        args.reattestCompanion();
      },
      qualify: (context) => args.controller.qualifyCompanion(context, {
        netApi: companionProbePort(args.endpoint, args.companionProbe),
        attestCompanion: args.reattestCompanion,
        deadlineMs: deriveDeadline(
          systemClock,
          deadlineAt(args.deadlineMs),
          args.endpointProbeTimeoutMs
        ).atMs,
        pollIntervalMs: args.endpointPollMs,
        signal: args.signal,
      }),
      beforeHandoff: async (proof) => {
        args.reattestTarget();
        args.reattestCompanion();
        logDirectory = await attributeLogDirectory({
          logRoot: args.logRoot,
          before: beforeLogs,
          launchedAtMs: proof.process.launchedAtMs,
          ownerToken: owner.token,
          deadline: deriveDeadline(
            systemClock,
            deadlineAt(args.deadlineMs),
            args.logAttributionTimeoutMs
          ),
          pollMs: args.logPollMs,
        });
      },
    });
    if (!logDirectory) {
      throw new WorkbenchRunnerError(
        "Workbench companion preflight completed without an attributed log directory.",
        "LOG_ATTRIBUTION_FAILED"
      );
    }
    return {
      proof: {
        pid: result.process.pid,
        lifecycleGeneration: result.lifecycleGeneration,
        endpointOwnership: result.endpointOwnership,
        endpointVacancy: result.endpointVacancy,
        executablePath: result.process.executablePath,
        creationTime: result.process.creationTime,
        logDirectory,
      },
      companionIdentity: result.qualification,
      handoff: result.handoff,
    };
  } catch (error) {
    throw mapControllerRunError(error, "build");
  }
}


interface TargetBuildStageArgs {
  controller: WorkbenchSessionController;
  config: Config;
  intent: WorkbenchBuildIntent;
  project: CanonicalGprojIdentity;
  target: WorkbenchLifecycleTarget;
  buildProject: WorkbenchBuildProjectMetadata;
  managedProfile: Readonly<WorkbenchManagedBuildProfile>;
  companion: WorkbenchCompanionLaunch;
  companionProvider: WorkbenchCompanionProvider;
  reattestCompanion: () => WorkbenchCompanionLaunch;
  reattestTarget: () => WorkbenchBuildProjectMetadata;
  logRoot: string;
  outputReservation: WorkbenchBuildOutputReservation;
  preflight: BuildCompanionPreflightResult;
  logAttributionTimeoutMs: number;
  logPollMs: number;
  terminationTimeoutMs: number;
  recoveryTimeoutMs: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

async function runTargetBuildStage(args: TargetBuildStageArgs): Promise<WorkbenchBuildRunnerReceipt> {
  try {
    return await runTargetBuildStageWithHandoff(args);
  } catch (error) {
    try {
      await args.controller.cancelTargetBuildHandoff(args.preflight.handoff, args.target);
    } catch (cleanupError) {
      throw mapControllerRunError(cleanupError, "build");
    }
    throw mapControllerRunError(error, "build");
  }
}

async function runTargetBuildStageWithHandoff(
  args: TargetBuildStageArgs
): Promise<WorkbenchBuildRunnerReceipt> {
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
  const beforeLogs = snapshotLogDirectories(args.logRoot);
  args.outputReservation.revalidateAndSnapshot();
  const owner = args.controller.createPlanOwnerCredential();
  const remainingBuildMs = Math.max(1, args.deadlineMs - Date.now());
  let launchPlan: ReturnType<typeof buildTargetBuildLaunchPlan>;
  try {
    launchPlan = buildTargetBuildLaunchPlan({
      kind: "target_build",
      config: args.config,
      project: args.project,
      ownerArgument: owner.argument,
      managedProfile: args.managedProfile,
      outputPath: args.outputReservation.root,
      platform: args.intent.platform,
      timeoutMs: remainingBuildMs,
    });
  } catch (error) {
    rethrowLaunchPlanError(error);
  }
  if (launchPlan.targetAddon.addonId !== revalidatedTarget.addonId ||
      launchPlan.targetAddon.addonGuid !== revalidatedTarget.addonGuid ||
      launchPlan.targetAddon.sourceSha256 !== revalidatedTarget.sourceSha256) {
    throw new WorkbenchRunnerError(
      "Workbench target launch plan changed its validated add-on identity.",
      "INVALID_TARGET"
    );
  }

  let run;
  try {
    run = await args.controller.runTargetBuild(launchPlan, {
      root: args.outputReservation.root,
      assertStillReservedAndSnapshot: () => args.outputReservation.revalidateAndSnapshot(),
    }, {
      deadlineMs: args.deadlineMs,
      signal: args.signal,
      terminationTimeoutMs: args.terminationTimeoutMs,
      recoveryTimeoutMs: args.recoveryTimeoutMs,
      handoff: args.preflight.handoff,
      beforeFinalVacancyCheck: () => {
        args.reattestTarget();
        args.reattestCompanion();
      },
      beforeSpawn: () => {
        args.reattestTarget();
        args.reattestCompanion();
      },
    });
  } catch (error) {
    throw mapControllerRunError(error, "build");
  }

  let output: WorkbenchBuildOutputProof | null = null;
  let validationFailure: WorkbenchBuildValidationFailure | null = null;
  if (run.exitStatus.reason === "exited" && run.exitStatus.exitCode === 0) {
    try {
      output = attestFreshBuildOutput(args.outputReservation.root, run.beforeOutput);
    } catch (error) {
      if (error instanceof WorkbenchRunnerError && error.code === "OUTPUT_ATTESTATION_FAILED") {
        validationFailure = {
          code: "OUTPUT_ATTESTATION_FAILED",
          message: redactText(error.message, {
            profile: "command_argument",
            replacement: "[redacted]",
          }),
        };
      } else {
        throw error;
      }
    }
  }
  args.reattestTarget();
  args.reattestCompanion();
  const logDirectory = await attributeLogDirectory({
    logRoot: args.logRoot,
    before: beforeLogs,
    launchedAtMs: run.process.launchedAtMs,
    ownerToken: owner.token,
    deadline: deriveDeadline(
      systemClock,
      deadlineAt(args.deadlineMs),
      args.logAttributionTimeoutMs
    ),
    pollMs: args.logPollMs,
  });
  return {
    version: 3,
    intent: "build",
    pid: run.process.pid,
    executablePath: run.process.executablePath,
    creationTime: run.process.creationTime,
    target: args.target.path,
    targetAddon: {
      addonId: args.buildProject.addonId,
      addonGuid: args.buildProject.addonGuid,
      sourceSha256: args.buildProject.sourceSha256,
    },
    lifecycleGeneration: run.lifecycleGeneration,
    processOwnership: "verified",
    endpointVacancy: run.endpointVacancy,
    companionIdentity: args.preflight.companionIdentity,
    preflight: args.preflight.proof,
    logDirectory,
    output,
    validationFailure,
    exitStatus: run.exitStatus,
  };
}


/**
 * Run a structured Workbench purpose under a durable version-3 reservation.
 *
 * The machine mutex is held only to reserve or CAS lifecycle state. Readiness,
 * foreground lifetime, and bounded recovery run without the mutex; each later
 * commit reacquires it and revalidates the reserved generation plus exact MCP
 * and Workbench owner identities.
 */
export async function runWorkbenchIntent(
  config: Config,
  intent: WorkbenchRunnerIntent,
  dependencies: WorkbenchRunnerDependencies = {}
): Promise<WorkbenchRunnerReceipt> {
  if (!intent || (intent.kind !== "editor" && intent.kind !== "build")) {
    throw new WorkbenchRunnerError("Workbench runner intent is unsupported.", "INVALID_INTENT");
  }
  const lifecycleExecution = dependencies.lifecycleExecution ??
    WorkbenchSessionController.composeLifecycleExecution({
      processGuard: dependencies.processGuard,
      childSupervisor: dependencies.childSupervisor,
      spawnProcess: dependencies.spawnProcess,
      failure: (message, code) => new WorkbenchRunnerError(message, code),
  });
  try {
    await WorkbenchSessionController.assertStandaloneEntryReady(lifecycleExecution);
  } catch (error) {
    throw new WorkbenchRunnerError(
      `Standalone Workbench launch is refused while durable spawn recovery is unresolved: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      "LIFECYCLE_CONFLICT"
    );
  }
  const project = canonicalizeGproj(intent.gprojPath);
  const buildProject = intent.kind === "build"
    ? resolveBuildProjectMetadata(project.displayPath)
    : null;
  const executablePath = intent.kind === "build"
    ? resolveWorkbenchExecutable(config)
    : null;
  const configuredAddonDirectories = intent.kind === "build"
    ? validateWorkbenchAddonDirectories(config.workbenchAddonDirs)
    : [];
  const managedRootPath = dependencies.managedRoot ??
    config.observer?.managedRoot ??
    defaultWorkbenchHelperManagedRoot();
  const companionProvider = dependencies.companionProvider ?? new WorkbenchHelperStager({
    managedRoot: managedRootPath,
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
        pathComparisonKey(attested.addonDirectory) !== pathComparisonKey(companion.addonDirectory) ||
        pathComparisonKey(attested.addonSearchRoot) !== pathComparisonKey(companion.addonSearchRoot) ||
        pathComparisonKey(attested.workbenchProfilePath) !== pathComparisonKey(companion.workbenchProfilePath)) {
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
  let managedBuildProfile: Readonly<WorkbenchManagedBuildProfile> | null = null;
  if (intent.kind === "build") {
    try {
      managedBuildProfile = ensureWorkbenchManagedBuildProfile(managedRootPath, project);
    } catch (error) {
      rethrowLaunchPlanError(error);
    }
  }
  const targetAddonSearchRoot = intent.kind === "build"
    ? canonicalDirectory(dirname(project.modDirectory), "Workbench target add-on search root")
    : null;
  const targetAddonDirectories = targetAddonSearchRoot
    ? validateWorkbenchAddonDirectories([
        ...configuredAddonDirectories,
        targetAddonSearchRoot,
      ])
    : [];
  const preflightAddonDirectories = intent.kind === "build"
    ? validateWorkbenchAddonDirectories([
        ...targetAddonDirectories,
        companion.addonSearchRoot,
      ])
    : [];
  const endpoint = validateEndpoint(config);
  const managedLogRoot = join(companion.workbenchProfilePath, "logs");
  if (!dependencies.logRoot) mkdirSync(managedLogRoot, { recursive: true });
  const logRoot = dependencies.logRoot
    ? canonicalDirectory(dependencies.logRoot, "Workbench log root")
    : canonicalDirectory(managedLogRoot, "Workbench log root");
  const buildLogRoot = dependencies.logRoot
    ? logRoot
    : managedBuildProfile?.logRoot ?? logRoot;
  const protectedOutputRoots = [
    { label: "the target mod", path: project.modDirectory },
    { label: "the companion add-on search root", path: companion.addonSearchRoot },
    { label: "the companion profile", path: companion.workbenchProfilePath },
  ];
  if (intent.kind === "build") {
    protectedOutputRoots.push({
      label: "the observer managed root",
      path: canonicalDirectory(managedRootPath, "Observer managed root"),
    });
  }
  const outputPath = intent.kind === "build"
    ? validateBuildOutput(intent, protectedOutputRoots)
    : null;
  const outputReservation = outputPath ? reserveBuildOutput(outputPath) : null;
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
  const recoveryTimeoutMs = positiveInteger(
    dependencies.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS,
    "Recovery timeout"
  );
  const controller = WorkbenchSessionController.composeRunner(
    endpoint.host,
    endpoint.port,
    lifecycleExecution
  );

  const target: WorkbenchLifecycleTarget = toLifecycleTarget(project);
  if (intent.kind === "build") {
    if (!buildProject || !outputReservation || !executablePath || !managedBuildProfile) {
      throw new WorkbenchRunnerError(
        "Workbench build project metadata, profile, executable, or output was not prepared.",
        "INVALID_INTENT"
      );
    }
    const deadlineMs = Date.now() + intent.timeoutMs;
    const preflight = await runBuildCompanionPreflight({
      controller,
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
      outputReservation,
      endpointProbeTimeoutMs,
      endpointPollMs,
      companionProbe: dependencies.companionProbe ?? runnerCompanionPing,
      logAttributionTimeoutMs,
      logPollMs,
      terminationTimeoutMs,
      recoveryTimeoutMs,
      deadlineMs,
      signal: dependencies.signal,
    });
    return runTargetBuildStage({
      controller,
      config,
      intent,
      project,
      target,
      buildProject,
      managedProfile: managedBuildProfile,
      companion,
      companionProvider,
      reattestCompanion,
      reattestTarget: reattestBuildTarget,
      logRoot: buildLogRoot,
      outputReservation,
      preflight,
      logAttributionTimeoutMs,
      logPollMs,
      terminationTimeoutMs,
      recoveryTimeoutMs,
      deadlineMs,
      signal: dependencies.signal,
    });
  }
  reattestCompanion();
  companionProvider.applyRetention?.({ protectedDigests: [companion.bundleDigest] });
  const beforeLogs = snapshotLogDirectories(logRoot);
  const owner = controller.createPlanOwnerCredential();
  let launchPlan: ReturnType<typeof buildCliEditorLaunchPlan>;
  try {
    launchPlan = buildCliEditorLaunchPlan({
      kind: "cli_editor",
      config,
      project,
      companion,
      endpoint,
      ownerArgument: owner.argument,
      managedRoot: managedRootPath,
    });
  } catch (error) {
    rethrowLaunchPlanError(error);
  }

  let run;
  try {
    run = await controller.runForegroundEditor(launchPlan, {
      signal: dependencies.signal,
      terminationTimeoutMs,
      recoveryTimeoutMs,
      beforeFinalVacancyCheck: () => { reattestCompanion(); },
      beforeSpawn: () => { reattestCompanion(); },
      qualify: (context) => controller.qualifyCompanion(context, {
        netApi: companionProbePort(endpoint, dependencies.companionProbe ?? runnerCompanionPing),
        attestCompanion: reattestCompanion,
        deadlineMs: deadlineAfter(systemClock, endpointProbeTimeoutMs).atMs,
        pollIntervalMs: endpointPollMs,
        signal: dependencies.signal,
      }),
    });
  } catch (error) {
    throw mapControllerRunError(error, "editor");
  }
  reattestCompanion();
  const logDirectory = await attributeLogDirectory({
    logRoot,
    before: beforeLogs,
    launchedAtMs: run.process.launchedAtMs,
    ownerToken: owner.token,
    deadline: deadlineAfter(systemClock, logAttributionTimeoutMs),
    pollMs: logPollMs,
  });
  return {
    version: 2,
    intent: "editor",
    pid: run.process.pid,
    target: project.displayPath,
    lifecycleGeneration: run.lifecycleGeneration,
    endpointOwnership: "verified",
    companionIdentity: run.qualification,
    logDirectory,
    exitStatus: run.exitStatus,
  };

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
