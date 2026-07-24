#!/usr/bin/env node
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { platform as operatingSystemPlatform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { ChildSupervisor, type SupervisedChildCounts } from "../src/foundation/child-supervisor.js";
import { redactText } from "../src/foundation/redact.js";
import {
  deadlineAt,
  pollUntil,
  systemClock,
  systemSleeper,
} from "../src/foundation/time.js";
import {
  canonicalizeExistingDirectory,
  isPathContained,
  pathComparisonKey,
} from "../src/foundation/managed-path.js";
import { getProperty, parse as parseEnfusionText } from "../src/formats/enfusion-text.js";
import {
  buildTargetBuildLaunchPlan,
  type TargetBuildLaunchPlan,
} from "../src/workbench/launch-plan.js";
import {
  ensureWorkbenchManagedBuildProfile,
  validateWorkbenchManagedBuildProfile,
  type WorkbenchManagedBuildProfile,
} from "../src/workbench/managed-build-profile.js";
import type { WorkbenchNetApiPort } from "../src/workbench/net-api-client.js";
import {
  isLoopbackLifecycleHost,
  WorkbenchProcessGuard,
  WORKBENCH_OWNER_ARG_PREFIX,
  type WorkbenchIdentity,
} from "../src/workbench/process-guard.js";
import {
  canonicalizeGproj,
  revalidateProjectIdentity,
  type CanonicalProjectIdentity,
} from "../src/workbench/project-identity.js";
import { WorkbenchSessionController } from "../src/workbench/session-controller.js";
import {
  inspectExecutableVersion,
  type ExecutableVersionEvidence,
} from "./observer-live-acceptance-support.js";

export const LIVE_WORKBENCH_BUILD_ENVIRONMENT =
  "RFO_RUN_LIVE_WORKBENCH_BUILD_ACCEPTANCE";
export const LIVE_WORKBENCH_BUILD_CONFIRMATION = "--confirm-live-run";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_VALIDATION_ROOT = join(REPOSITORY_ROOT, "docs", "validation");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1_000;
const LOG_POLL_MS = 100;
const LOG_CLOCK_SKEW_MS = 2_000;
const MAX_ATTESTED_FILES = 4_096;
const MAX_ATTESTED_BYTES = 8 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const WORKBENCH_BUILD_ACCEPTANCE_SOURCE_PATHS = [
  "package-lock.json",
  "package.json",
  "scripts/observer-live-acceptance-support.ts",
  "scripts/run-workbench-build-acceptance.ts",
  "scripts/windows/workbench-lifecycle.ps1",
  "src/config.ts",
  "src/companions/content-addressed-bundle.ts",
  "src/formats/enfusion-text.ts",
  "src/foundation/bounded-option.ts",
  "src/foundation/child-supervisor.ts",
  "src/foundation/digest.ts",
  "src/foundation/exact-process-backend.ts",
  "src/foundation/identity.ts",
  "src/foundation/json-store.ts",
  "src/foundation/machine-mutex.ts",
  "src/foundation/managed-path.ts",
  "src/foundation/recoverable-spawn.ts",
  "src/foundation/reservation-gate.ts",
  "src/foundation/time.ts",
  "src/platform/windows/exact-process-backend.ts",
  "src/utils/logger.ts",
  "src/workbench/activity-gate.ts",
  "src/workbench/diagnostics.ts",
  "src/workbench/helper-addon.ts",
  "src/workbench/launch-plan.ts",
  "src/workbench/lifecycle-execution.ts",
  "src/workbench/managed-build-profile.ts",
  "src/workbench/net-api-client.ts",
  "src/workbench/process-guard.ts",
  "src/workbench/project-identity.ts",
  "src/workbench/protocol.ts",
  "src/workbench/readiness.ts",
  "src/workbench/session-controller.ts",
  "src/workbench/session-state.ts",
  "tests/workbench/build-acceptance-contract.test.ts",
] as const;
const EVALUATOR_CONTRACT = Object.freeze({
  schemaVersion: 1,
  runCount: 2,
  planKind: "target_build",
  spawnCountPerRun: 1,
  helperReferences: 0,
  netCalls: 0,
  exitCode: 0,
  resourceDatabaseCount: 1,
  requireFreshNonemptyOutput: true,
  requireAttributedLogs: true,
  requireExactAbsence: true,
  requireEndpointVacancy: true,
  requireLifecycleVacancy: true,
  requireZeroSupervisedAtRest: true,
  publicRunnerReceipt: "unchanged_v3",
});

export interface WorkbenchBuildAcceptanceOptions {
  confirmed: boolean;
  /** Explicit configuration file. Required unless the test-only config seam is supplied. */
  configPath?: string;
  gprojPath: string;
  outputParent: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  /** Test seam only. The CLI always writes beneath repository docs/validation. */
  validationRoot?: string;
  /** Test seam only. The CLI always loads configPath. */
  config?: Config;
}

export interface RepositoryAcceptanceEvidence {
  revision: string | null;
  dirty: boolean | "unknown";
  sourceClosureSha256: string;
  sourceMembers: Array<{ path: string; sha256: string }>;
}

export interface WorkbenchBuildOutputProof {
  fileCount: number;
  totalBytes: number;
  aggregateSha256: string;
  freshArtifactCount: number;
  resourceDatabase: {
    count: 1;
    bytes: number;
    sha256: string;
  };
}

export interface WorkbenchBuildLogProof {
  fileCount: number;
  totalBytes: number;
  aggregateSha256: string;
  ownerTokenAttributed: true;
}

export interface TargetBuildAcceptanceRunEvidence {
  sequence: 1 | 2;
  planKind: "target_build";
  normalizedArguments: string[];
  initialWorkbenchVacancy: true;
  initialEndpointVacancy: true;
  spawnCount: number;
  netCallCount: number;
  helperReferenceCount: number;
  exactProcessIdentity: {
    pidPresent: true;
    creationIdentityPresent: true;
    executableMatched: true;
    ownerArgumentMatched: true;
  };
  lifecycleGenerationBound: true;
  deadline: {
    kind: "absolute";
    timeoutMs: number;
  };
  timing: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  exit: {
    reason: "exited";
    code: 0;
    signal: null;
  };
  logs: WorkbenchBuildLogProof;
  output: WorkbenchBuildOutputProof;
  exactChildAbsence: true;
  endpointVacancy: "verified";
  lifecycleVacant: true;
  supervisedAtStart: SupervisedChildCounts;
  supervisedAtRest: SupervisedChildCounts;
  workbenchVersion: ExecutableVersionEvidence;
}

export interface WorkbenchBuildAcceptanceArtifact {
  schemaVersion: 1;
  kind: "reforger_forge_target_build_pre_removal_acceptance";
  result: "passed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: {
    nodeVersion: string;
    platform: string;
    architecture: string;
    workbench: {
      executable: string;
      productVersion: string | null;
      fileVersion: string | null;
      discovery: ExecutableVersionEvidence["discovery"];
    };
  };
  repository: RepositoryAcceptanceEvidence;
  evaluator: {
    sha256: string;
    contract: typeof EVALUATOR_CONTRACT;
  };
  target: {
    addonId: string;
    addonGuid: string;
    sourceSha256: string;
  };
  configuration: {
    planKind: "target_build";
    platform: "PC";
    runCount: 2;
    outputRootsDistinctAndExclusive: true;
    publicBuildPreflightRetained: true;
    publicReceiptVersion: 3;
  };
  runs: [TargetBuildAcceptanceRunEvidence, TargetBuildAcceptanceRunEvidence];
  limitations: string[];
}

interface TargetMetadata {
  addonId: string;
  addonGuid: string;
  sourceSha256: string;
}

interface FileSnapshot {
  relativePath: string;
  canonicalPath: string;
  size: number;
  mtimeMs: number;
}

interface TargetBuildRunContext {
  sequence: 1 | 2;
  config: Config;
  project: CanonicalProjectIdentity;
  target: TargetMetadata;
  profile: Readonly<WorkbenchManagedBuildProfile>;
  outputRoot: string;
  timeoutMs: number;
}

export interface WorkbenchBuildAcceptanceDependencies {
  platform?: NodeJS.Platform;
  now?: () => number;
  randomId?: () => string;
  executeRun?: (context: TargetBuildRunContext) => Promise<TargetBuildAcceptanceRunEvidence>;
  repositoryEvidence?: () => RepositoryAcceptanceEvidence;
}

function acceptanceError(message: string): Error {
  const error = new Error(message);
  error.name = "WorkbenchBuildAcceptanceError";
  return error;
}

function isoTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw acceptanceError("Acceptance clock is invalid.");
  return new Date(value).toISOString();
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
}

function requireExistingDirectory(path: string, label: string): string {
  if (!path || typeof path !== "string") throw acceptanceError(`${label} is required.`);
  const lexical = resolve(path);
  const stat = lstatSync(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw acceptanceError(`${label} must be a regular non-symlink directory.`);
  }
  return canonicalizeExistingDirectory(lexical, label);
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw acceptanceError(
      `Workbench build acceptance timeout must be ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} ms.`
    );
  }
  return value;
}

export function assertLiveWorkbenchBuildAuthorized(
  confirmed: boolean,
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (!confirmed) {
    throw acceptanceError(
      `Live target-build acceptance requires ${LIVE_WORKBENCH_BUILD_CONFIRMATION}.`
    );
  }
  if (environment[LIVE_WORKBENCH_BUILD_ENVIRONMENT] !== "1") {
    throw acceptanceError(
      `Live target-build acceptance requires ${LIVE_WORKBENCH_BUILD_ENVIRONMENT}=1.`
    );
  }
}

function resolveTargetMetadata(project: CanonicalProjectIdentity): TargetMetadata {
  const current = revalidateProjectIdentity(project);
  const source = readFileSync(current.displayPath);
  const document = parseEnfusionText(source.toString("utf8"));
  const addonId = document.type === "GameProject" ? getProperty(document, "ID") : undefined;
  const addonGuid = document.type === "GameProject" ? getProperty(document, "GUID") : undefined;
  if (typeof addonId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(addonId) ||
      typeof addonGuid !== "string" || !/^[A-Fa-f0-9]{16}$/.test(addonGuid)) {
    throw acceptanceError("The explicit target .gproj has no bounded GameProject ID/GUID.");
  }
  return {
    addonId,
    addonGuid: addonGuid.toUpperCase(),
    sourceSha256: sha256(source),
  };
}

function assertTargetMetadataUnchanged(
  project: CanonicalProjectIdentity,
  expected: TargetMetadata
): void {
  const current = resolveTargetMetadata(project);
  if (current.addonId !== expected.addonId || current.addonGuid !== expected.addonGuid ||
      current.sourceSha256 !== expected.sourceSha256) {
    throw acceptanceError("The explicit target identity or source changed during acceptance.");
  }
}

function createAcceptanceBundle(
  outputParent: string,
  project: CanonicalProjectIdentity,
  config: Config,
  id: string
): { bundleRoot: string; outputs: [string, string] } {
  const parent = requireExistingDirectory(outputParent, "Acceptance output parent");
  const protectedRoots = [
    REPOSITORY_ROOT,
    project.modDirectory,
    config.workbenchPath,
    config.gamePath,
    ...(config.workbenchAddonDirs ?? []),
  ].filter(Boolean).map((path) => resolve(path));
  if (protectedRoots.some((protectedRoot) => pathsOverlap(parent, protectedRoot))) {
    throw acceptanceError(
      "Acceptance output parent must be external to the repository, target, installations, and add-on roots."
    );
  }
  if (!/^[a-f0-9-]{8,64}$/i.test(id)) throw acceptanceError("Acceptance run ID is invalid.");
  const bundleRoot = join(parent, `reforger-forge-target-build-${id}`);
  mkdirSync(bundleRoot, { recursive: false, mode: 0o700 });
  const first = join(bundleRoot, "output-1");
  const second = join(bundleRoot, "output-2");
  mkdirSync(first, { recursive: false, mode: 0o700 });
  mkdirSync(second, { recursive: false, mode: 0o700 });
  const outputs: [string, string] = [
    realpathSync.native(first),
    realpathSync.native(second),
  ];
  if (pathComparisonKey(outputs[0]) === pathComparisonKey(outputs[1]) ||
      readdirSync(outputs[0]).length !== 0 || readdirSync(outputs[1]).length !== 0) {
    throw acceptanceError("Acceptance output roots are not distinct fresh directories.");
  }
  return { bundleRoot: realpathSync.native(bundleRoot), outputs };
}

function snapshotFiles(root: string): Map<string, FileSnapshot> {
  const canonicalRoot = realpathSync.native(root);
  const files = new Map<string, FileSnapshot>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const lexical = join(directory, entry.name);
      const observed = lstatSync(lexical);
      if (entry.isSymbolicLink() || observed.isSymbolicLink()) {
        throw acceptanceError("Attested output contains a symbolic link or reparse traversal.");
      }
      const canonical = realpathSync.native(lexical);
      if (!isPathContained(canonicalRoot, canonical)) {
        throw acceptanceError("Attested output escapes its exclusive root.");
      }
      if (observed.isDirectory()) {
        visit(canonical);
      } else if (observed.isFile()) {
        const relativePath = relative(canonicalRoot, canonical).split(sep).join("/");
        files.set(relativePath, {
          relativePath,
          canonicalPath: canonical,
          size: observed.size,
          mtimeMs: observed.mtimeMs,
        });
      } else {
        throw acceptanceError("Attested output contains a non-file entry.");
      }
      if (files.size > MAX_ATTESTED_FILES) {
        throw acceptanceError("Attested output exceeds the bounded file count.");
      }
    }
  };
  visit(canonicalRoot);
  return files;
}

function reserveEmptyOutput(root: string): {
  root: string;
  assertStillReservedAndSnapshot(): Map<string, FileSnapshot>;
} {
  if (readdirSync(root).length !== 0) {
    throw acceptanceError("Target-build output must be empty before reservation.");
  }
  return Object.freeze({
    root,
    assertStillReservedAndSnapshot(): Map<string, FileSnapshot> {
      if (readdirSync(root).length !== 0) {
        throw acceptanceError("Target-build output reservation changed before spawn.");
      }
      return snapshotFiles(root);
    },
  });
}

async function hashStableFile(file: FileSnapshot): Promise<string> {
  const before = lstatSync(file.canonicalPath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== file.size ||
      before.mtimeMs !== file.mtimeMs) {
    throw acceptanceError("An evidence file changed before hashing.");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file.canonicalPath)) hash.update(chunk);
  const after = lstatSync(file.canonicalPath);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs) {
    throw acceptanceError("An evidence file changed while hashing.");
  }
  return hash.digest("hex");
}

export async function attestFreshBuildOutput(
  root: string,
  before: ReadonlyMap<string, FileSnapshot>
): Promise<WorkbenchBuildOutputProof> {
  const after = snapshotFiles(root);
  const resourceDatabases = [...after.values()].filter((file) =>
    basename(file.relativePath).toLowerCase() === "resourcedatabase.rdb"
  );
  if (resourceDatabases.length !== 1 || resourceDatabases[0].size <= 0) {
    throw acceptanceError(
      "Exit-zero target output must contain exactly one nonempty regular resourceDatabase.rdb."
    );
  }
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  let freshArtifactCount = 0;
  let databaseSha256 = "";
  for (const [relativePath, file] of [...after.entries()].sort(([left], [right]) =>
    left.localeCompare(right))) {
    const fileSha256 = await hashStableFile(file);
    const previous = before.get(relativePath);
    if (!previous || previous.size !== file.size || previous.mtimeMs !== file.mtimeMs) {
      freshArtifactCount += 1;
    }
    totalBytes += file.size;
    aggregate.update(relativePath).update("\0").update(fileSha256).update("\0");
    if (file === resourceDatabases[0]) databaseSha256 = fileSha256;
  }
  if (after.size < 1 || freshArtifactCount < 1 || totalBytes <= 0 ||
      totalBytes > MAX_ATTESTED_BYTES || !SHA256_PATTERN.test(databaseSha256)) {
    throw acceptanceError("Target-build output did not produce bounded fresh hashed evidence.");
  }
  return {
    fileCount: after.size,
    totalBytes,
    aggregateSha256: aggregate.digest("hex"),
    freshArtifactCount,
    resourceDatabase: {
      count: 1,
      bytes: resourceDatabases[0].size,
      sha256: databaseSha256,
    },
  };
}

function snapshotLogDirectories(root: string): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    snapshot.set(pathComparisonKey(path), statSync(path).mtimeMs);
  }
  return snapshot;
}

async function fileContainsOwner(path: string, ownerToken: string): Promise<boolean> {
  const needles = [
    `${WORKBENCH_OWNER_ARG_PREFIX}${ownerToken}`,
    `${WORKBENCH_OWNER_ARG_PREFIX.slice(0, -1)} ${ownerToken}`,
  ];
  let carry = "";
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    const text = carry + chunk;
    if (needles.some((needle) => text.includes(needle))) return true;
    carry = text.slice(-Math.max(...needles.map((needle) => needle.length)) - 4);
  }
  return false;
}

async function attributeLogDirectory(args: {
  logRoot: string;
  before: ReadonlyMap<string, number>;
  launchedAtMs: number;
  ownerToken: string;
  deadlineMs: number;
}): Promise<string> {
  const result = await pollUntil<string>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(args.deadlineMs),
    intervalMs: LOG_POLL_MS,
    probe: async (): Promise<string | undefined> => {
      const matches: string[] = [];
      for (const entry of readdirSync(args.logRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const lexical = join(args.logRoot, entry.name);
        const modifiedMs = statSync(lexical).mtimeMs;
        if (args.before.has(pathComparisonKey(lexical)) &&
            modifiedMs < args.launchedAtMs - LOG_CLOCK_SKEW_MS) continue;
        const candidate = realpathSync.native(lexical);
        if (pathComparisonKey(dirname(candidate)) !== pathComparisonKey(args.logRoot)) {
          throw acceptanceError("Workbench log candidate escapes its managed root.");
        }
        const logs = readdirSync(candidate, { withFileTypes: true })
          .filter((file) => file.isFile() && !file.isSymbolicLink() &&
            file.name.toLowerCase().endsWith(".log"))
          .map((file) => join(candidate, file.name));
        for (const log of logs) {
          if (await fileContainsOwner(log, args.ownerToken)) {
            matches.push(candidate);
            break;
          }
        }
      }
      if (matches.length > 1) {
        throw acceptanceError("Owner evidence appeared in multiple Workbench log directories.");
      }
      return matches.length === 1 ? matches[0] : undefined;
    },
  });
  if (result.kind === "value") return result.value;
  throw acceptanceError("No exactly attributed Workbench log appeared before the run deadline.");
}

async function attestLogDirectory(path: string): Promise<WorkbenchBuildLogProof> {
  const files = snapshotFiles(path);
  const logs = [...files.entries()].filter(([relativePath]) =>
    relativePath.toLowerCase().endsWith(".log"));
  if (logs.length < 1) throw acceptanceError("Attributed Workbench logs contain no regular log file.");
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  for (const [relativePath, file] of logs.sort(([left], [right]) => left.localeCompare(right))) {
    const digest = await hashStableFile(file);
    totalBytes += file.size;
    aggregate.update(relativePath).update("\0").update(digest).update("\0");
  }
  if (totalBytes <= 0 || totalBytes > MAX_ATTESTED_BYTES) {
    throw acceptanceError("Attributed Workbench logs are empty or exceed the evidence bound.");
  }
  return {
    fileCount: logs.length,
    totalBytes,
    aggregateSha256: aggregate.digest("hex"),
    ownerTokenAttributed: true,
  };
}

function normalizedArguments(plan: TargetBuildLaunchPlan, sequence: 1 | 2): string[] {
  const replacements = new Map<string, string>([
    [plan.ownerArgument, "<owner-token:redacted>"],
    [plan.project.displayPath, "<target.gproj>"],
    [plan.outputPath, `<exclusive-output-${sequence}>`],
    [plan.buildProfile.profilePath, "<managed-build-profile>"],
    [plan.addonDirectories.join(","), `<addon-roots:${plan.addonDirectories.length}>`],
  ]);
  return plan.argv.map((argument) => replacements.get(argument) ?? argument);
}

function helperReferenceCount(plan: TargetBuildLaunchPlan): number {
  return [
    plan.helper !== null,
    plan.readiness.kind !== "none",
    plan.argv.includes("-addons"),
    plan.argv.some((argument) => /EMCP_WB_|ReforgerForgeWorkbenchHelper/i.test(argument)),
    plan.addonDirectories.some((directory) =>
      isPathContained(plan.buildProfile.managedRoot, directory)),
  ].filter(Boolean).length;
}

function exactIdentityProof(
  identity: WorkbenchIdentity,
  plan: TargetBuildLaunchPlan
): TargetBuildAcceptanceRunEvidence["exactProcessIdentity"] {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
      !/^\d+$/.test(identity.creationTime) ||
      pathComparisonKey(identity.executablePath) !== pathComparisonKey(plan.executablePath) ||
      identity.ownerTokenArgument !== plan.ownerArgument) {
    throw acceptanceError("Controller returned incomplete exact process identity evidence.");
  }
  return {
    pidPresent: true,
    creationIdentityPresent: true,
    executableMatched: true,
    ownerArgumentMatched: true,
  };
}

async function executeControllerTargetBuild(
  context: TargetBuildRunContext,
  processGuard: WorkbenchProcessGuard
): Promise<TargetBuildAcceptanceRunEvidence> {
  const startedMs = Date.now();
  const deadlineMs = startedMs + context.timeoutMs;
  const childSupervisor = new ChildSupervisor();
  const supervisedAtStart = childSupervisor.counts();
  let spawnCount = 0;
  let netCallCount = 0;
  let expectedPlan: TargetBuildLaunchPlan | null = null;
  const spawnProcess = (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ): ChildProcess => {
    spawnCount += 1;
    if (!expectedPlan || command !== expectedPlan.executablePath ||
        args.length !== expectedPlan.argv.length ||
        args.some((argument, index) => argument !== expectedPlan!.argv[index])) {
      throw acceptanceError("Lifecycle execution attempted a process outside the target-build plan.");
    }
    return spawn(command, [...args], options);
  };
  const lifecycleExecution = WorkbenchSessionController.composeLifecycleExecution({
    processGuard,
    childSupervisor,
    spawnProcess,
  });
  const netApi: WorkbenchNetApiPort = {
    call: async <T>(): Promise<T> => {
      netCallCount += 1;
      throw acceptanceError("Target-build acceptance forbids NET API calls.");
    },
  };
  const controller = new WorkbenchSessionController(
    context.config.workbenchHost,
    context.config.workbenchPort,
    undefined,
    "ReforgerForgeTargetBuildAcceptance",
    processGuard,
    { childSupervisor, lifecycleExecution, netApi }
  );

  await lifecycleExecution.assertSpawnJournalReplaceable();
  await lifecycleExecution.assertNoWorkbenchProcesses();
  const endpoint = {
    host: context.config.workbenchHost,
    port: context.config.workbenchPort,
  };
  const initialEndpoint = await lifecycleExecution.verifyEndpointVacant(endpoint);
  if (initialEndpoint.kind !== "vacant") {
    throw acceptanceError("Target-build acceptance requires initial endpoint vacancy.");
  }
  const owner = lifecycleExecution.createOwnerCredential();
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  const plan = buildTargetBuildLaunchPlan({
    kind: "target_build",
    config: context.config,
    project: revalidateProjectIdentity(context.project),
    ownerArgument: owner.argument,
    managedProfile: validateWorkbenchManagedBuildProfile(context.profile, context.project),
    outputPath: context.outputRoot,
    platform: "PC",
    timeoutMs: remainingMs,
  });
  if (plan.targetAddon.addonId !== context.target.addonId ||
      plan.targetAddon.addonGuid !== context.target.addonGuid ||
      plan.targetAddon.sourceSha256 !== context.target.sourceSha256) {
    throw acceptanceError("Target-build plan does not match the acceptance target identity.");
  }
  expectedPlan = plan;
  const beforeLogs = snapshotLogDirectories(plan.buildProfile.logRoot);
  const reservation = reserveEmptyOutput(context.outputRoot);
  const result = await controller.runTargetBuild(plan, reservation, {
    deadlineMs,
    beforeFinalVacancyCheck: () => {
      assertTargetMetadataUnchanged(context.project, context.target);
      validateWorkbenchManagedBuildProfile(context.profile, context.project);
      reservation.assertStillReservedAndSnapshot();
    },
    beforeSpawn: () => {
      assertTargetMetadataUnchanged(context.project, context.target);
      validateWorkbenchManagedBuildProfile(context.profile, context.project);
    },
  });
  if (result.planKind !== "target_build" || result.qualification !== null ||
      result.lifecycleGeneration.length === 0 || result.endpointVacancy !== "verified") {
    throw acceptanceError("Target-build controller returned an incomplete lifecycle-bound proof.");
  }
  if (result.exitStatus.reason !== "exited" || result.exitStatus.exitCode !== 0 ||
      result.exitStatus.signal !== null) {
    throw acceptanceError("Target-only Workbench build did not exit successfully.");
  }
  const output = await attestFreshBuildOutput(context.outputRoot, result.beforeOutput);
  const attributedLog = await attributeLogDirectory({
    logRoot: plan.buildProfile.logRoot,
    before: beforeLogs,
    launchedAtMs: result.process.launchedAtMs,
    ownerToken: owner.token,
    deadlineMs,
  });
  const logs = await attestLogDirectory(attributedLog);
  const lifecycle = await processGuard.readLifecycleState();
  const lifecycleVacant = lifecycle.kind === "valid" &&
    lifecycle.state.phase === "vacant" && lifecycle.state.workbench === null &&
    lifecycle.state.operation === null && lifecycle.state.companion === null;
  if (!lifecycleVacant) throw acceptanceError("Lifecycle did not return to helper-free vacancy.");
  const supervisedAtRest = childSupervisor.counts();
  const finishedMs = Date.now();
  return {
    sequence: context.sequence,
    planKind: "target_build",
    normalizedArguments: normalizedArguments(plan, context.sequence),
    initialWorkbenchVacancy: true,
    initialEndpointVacancy: true,
    spawnCount,
    netCallCount,
    helperReferenceCount: helperReferenceCount(plan),
    exactProcessIdentity: exactIdentityProof(result.process, plan),
    lifecycleGenerationBound: true,
    deadline: { kind: "absolute", timeoutMs: context.timeoutMs },
    timing: {
      startedAt: isoTime(startedMs),
      finishedAt: isoTime(finishedMs),
      durationMs: finishedMs - startedMs,
    },
    exit: { reason: "exited", code: 0, signal: null },
    logs,
    output,
    exactChildAbsence: true,
    endpointVacancy: result.endpointVacancy,
    lifecycleVacant: true,
    supervisedAtStart,
    supervisedAtRest,
    workbenchVersion: inspectExecutableVersion(plan.executablePath),
  };
}

function gitOutput(args: readonly string[]): { ok: boolean; stdout: string } {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${REPOSITORY_ROOT.replace(/\\/g, "/")}`, ...args],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  return {
    ok: !result.error && result.status === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

export function repositoryAcceptanceEvidence(): RepositoryAcceptanceEvidence {
  const members = WORKBENCH_BUILD_ACCEPTANCE_SOURCE_PATHS.map((path) => {
    const absolute = join(REPOSITORY_ROOT, ...path.split("/"));
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw acceptanceError("Acceptance source closure contains a non-regular member.");
    }
    return { path, sha256: sha256(readFileSync(absolute)) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const closure = createHash("sha256");
  closure.update("reforger-forge-target-build-acceptance-source-v1\0");
  for (const member of members) {
    closure.update(member.path).update("\0").update(member.sha256).update("\0");
  }
  const revisionResult = gitOutput(["rev-parse", "HEAD"]);
  const revision = revisionResult.ok && /^[a-f0-9]{40,64}$/i.test(revisionResult.stdout.trim())
    ? revisionResult.stdout.trim().toLowerCase()
    : null;
  const dirtyResult = gitOutput(["status", "--porcelain", "--untracked-files=all"]);
  return {
    revision,
    dirty: dirtyResult.ok ? dirtyResult.stdout.length > 0 : "unknown",
    sourceClosureSha256: closure.digest("hex"),
    sourceMembers: members,
  };
}

function validateRepositoryEvidence(evidence: RepositoryAcceptanceEvidence): void {
  const keys = new Set(evidence.sourceMembers.map((member) => member.path.toLowerCase()));
  if (!evidence.revision || !/^[a-f0-9]{40,64}$/.test(evidence.revision) ||
      typeof evidence.dirty !== "boolean" ||
      !SHA256_PATTERN.test(evidence.sourceClosureSha256) ||
      evidence.sourceMembers.length < WORKBENCH_BUILD_ACCEPTANCE_SOURCE_PATHS.length ||
      keys.size !== evidence.sourceMembers.length ||
      !WORKBENCH_BUILD_ACCEPTANCE_SOURCE_PATHS.every((path) => keys.has(path.toLowerCase())) ||
      evidence.sourceMembers.some((member) =>
        isAbsolute(member.path) || member.path.includes("\\") ||
        !SHA256_PATTERN.test(member.sha256))) {
    throw acceptanceError("Repository revision, dirty-tree, or source-closure proof is incomplete.");
  }
}

function validateRunEvidence(
  run: TargetBuildAcceptanceRunEvidence,
  sequence: 1 | 2,
  timeoutMs: number
): void {
  const zeroCounts = (counts: SupervisedChildCounts): boolean =>
    counts.active === 0 && counts.reconciling === 0 && counts.total === 0;
  const startedAt = Date.parse(run.timing.startedAt);
  const finishedAt = Date.parse(run.timing.finishedAt);
  const hasTargetArguments = run.normalizedArguments.includes("-wbModule=ResourceManager") &&
    run.normalizedArguments.includes("-builddata") &&
    run.normalizedArguments.includes("PC") &&
    run.normalizedArguments.filter((argument) => argument === "<owner-token:redacted>").length === 1;
  if (run.sequence !== sequence || run.planKind !== "target_build" ||
      run.initialWorkbenchVacancy !== true || run.initialEndpointVacancy !== true ||
      run.spawnCount !== 1 || run.netCallCount !== 0 || run.helperReferenceCount !== 0 ||
      run.deadline.kind !== "absolute" || run.deadline.timeoutMs !== timeoutMs ||
      run.exit.reason !== "exited" || run.exit.code !== 0 || run.exit.signal !== null ||
      run.exactChildAbsence !== true || run.endpointVacancy !== "verified" ||
      run.lifecycleVacant !== true || !zeroCounts(run.supervisedAtStart) ||
      !zeroCounts(run.supervisedAtRest) || run.logs.ownerTokenAttributed !== true ||
      run.logs.fileCount < 1 || run.logs.totalBytes < 1 ||
      !SHA256_PATTERN.test(run.logs.aggregateSha256) || run.output.fileCount < 1 ||
      run.output.totalBytes < 1 || run.output.freshArtifactCount < 1 ||
      !SHA256_PATTERN.test(run.output.aggregateSha256) ||
      run.output.resourceDatabase.count !== 1 || run.output.resourceDatabase.bytes < 1 ||
      !SHA256_PATTERN.test(run.output.resourceDatabase.sha256) ||
      run.exactProcessIdentity.pidPresent !== true ||
      run.exactProcessIdentity.creationIdentityPresent !== true ||
      run.exactProcessIdentity.executableMatched !== true ||
      run.exactProcessIdentity.ownerArgumentMatched !== true ||
      run.lifecycleGenerationBound !== true || !hasTargetArguments ||
      run.normalizedArguments.includes("-run") || run.normalizedArguments.includes("-addons") ||
      !Number.isFinite(startedAt) || !Number.isFinite(finishedAt) ||
      finishedAt < startedAt || !Number.isFinite(run.timing.durationMs) ||
      run.timing.durationMs < 0 ||
      run.normalizedArguments.some((argument) =>
        argument.includes(WORKBENCH_OWNER_ARG_PREFIX) ||
        /^[A-Za-z]:[\\/]/.test(argument) || /^\\\\/.test(argument))) {
    throw acceptanceError(`Target-only acceptance run ${sequence} is missing required proof.`);
  }
  const version = run.workbenchVersion;
  if (version.discovery !== "windows_file_metadata" || (!version.version && !version.fileVersion) ||
      basename(version.executable) !== version.executable) {
    throw acceptanceError(`Target-only acceptance run ${sequence} lacks Workbench version proof.`);
  }
}

function evaluatorSha256(): string {
  return sha256(JSON.stringify(EVALUATOR_CONTRACT));
}

function assertNoRawIdentityKeys(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawIdentityKeys(item);
    return;
  }
  const forbidden = new Set([
    "pid",
    "ownerToken",
    "ownerArgument",
    "creationTime",
    "executablePath",
    "gprojPath",
    "outputPath",
    "logDirectory",
  ]);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) throw acceptanceError(`Acceptance artifact contains forbidden key ${key}.`);
    assertNoRawIdentityKeys(child);
  }
}

export function assertSanitizedBuildAcceptanceArtifact(
  artifact: WorkbenchBuildAcceptanceArtifact,
  sensitiveValues: readonly string[] = []
): void {
  assertNoRawIdentityKeys(artifact);
  const serialized = JSON.stringify(artifact);
  if (/[A-Za-z]:[\\/]/.test(serialized) || /\\\\[^"\\]+[\\/]/.test(serialized) ||
      /\/(?:Users|home)\//i.test(serialized) ||
      serialized.includes(WORKBENCH_OWNER_ARG_PREFIX)) {
    throw acceptanceError("Acceptance artifact contains a raw path or owner token.");
  }
  const lowered = serialized.toLocaleLowerCase("en-US");
  for (const value of sensitiveValues) {
    const normalized = value?.trim().toLocaleLowerCase("en-US");
    if (normalized && normalized.length >= 3 && lowered.includes(normalized)) {
      throw acceptanceError("Acceptance artifact contains a sensitive source value.");
    }
  }
}

function writeAcceptanceArtifact(
  validationRoot: string,
  artifact: WorkbenchBuildAcceptanceArtifact,
  id: string
): string {
  mkdirSync(validationRoot, { recursive: true });
  const stat = lstatSync(validationRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw acceptanceError("Validation root must be a regular non-symlink directory.");
  }
  const stamp = artifact.startedAt.replace(/[:.]/g, "-");
  const filename = `${stamp}-target-build-pre-removal-acceptance-${id}.json`;
  const finalPath = join(validationRoot, filename);
  const temporaryPath = join(validationRoot, `.${filename}.${randomUUID()}.tmp`);
  if (existsSync(finalPath) || existsSync(temporaryPath)) {
    throw acceptanceError("Acceptance artifact path unexpectedly collided.");
  }
  writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporaryPath, finalPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* preserve publication failure */ }
    throw error;
  }
  return finalPath;
}

export async function runWorkbenchBuildAcceptance(
  options: WorkbenchBuildAcceptanceOptions,
  dependencies: WorkbenchBuildAcceptanceDependencies = {}
): Promise<{ artifact: WorkbenchBuildAcceptanceArtifact; artifactPath: string }> {
  assertLiveWorkbenchBuildAuthorized(options.confirmed, options.environment);
  const activePlatform = dependencies.platform ?? operatingSystemPlatform();
  if (activePlatform !== "win32") {
    throw acceptanceError("Live target-build acceptance requires Windows Workbench.");
  }
  if (!options.gprojPath || !isAbsolute(options.gprojPath)) {
    throw acceptanceError("Live target-build acceptance requires an explicit absolute --gproj.");
  }
  const timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = dependencies.now ?? Date.now;
  const randomId = dependencies.randomId ?? randomUUID;
  if (!options.config && !options.configPath) {
    throw acceptanceError("Live target-build acceptance requires --config <file>.");
  }
  const config = options.config ?? loadConfig(["--config", options.configPath!]);
  if (!isLoopbackLifecycleHost(config.workbenchHost)) {
    throw acceptanceError("Controlled target-build acceptance requires a numeric loopback endpoint.");
  }
  const project = canonicalizeGproj(options.gprojPath);
  const target = resolveTargetMetadata(project);
  const bundle = createAcceptanceBundle(options.outputParent, project, config, randomId());
  const profile = ensureWorkbenchManagedBuildProfile(join(bundle.bundleRoot, "managed"), project);
  const repositoryBefore = (dependencies.repositoryEvidence ?? repositoryAcceptanceEvidence)();
  validateRepositoryEvidence(repositoryBefore);
  const startedMs = now();
  // Both native builds belong to one acceptance process and therefore must
  // reuse its lifecycle identity. A fresh guard for run two looks like a
  // competing live MCP while run one's process-scoped lease is still valid.
  const sharedProcessGuard = dependencies.executeRun ? null : new WorkbenchProcessGuard();
  const executeRun = dependencies.executeRun ?? ((context: TargetBuildRunContext) =>
    executeControllerTargetBuild(context, sharedProcessGuard!));
  let first: TargetBuildAcceptanceRunEvidence;
  let second: TargetBuildAcceptanceRunEvidence;
  try {
    first = await executeRun({
      sequence: 1,
      config,
      project,
      target,
      profile,
      outputRoot: bundle.outputs[0],
      timeoutMs,
    });
    validateRunEvidence(first, 1, timeoutMs);
    second = await executeRun({
      sequence: 2,
      config,
      project,
      target,
      profile,
      outputRoot: bundle.outputs[1],
      timeoutMs,
    });
    validateRunEvidence(second, 2, timeoutMs);
  } finally {
    await sharedProcessGuard?.close();
  }
  const repositoryAfter = (dependencies.repositoryEvidence ?? repositoryAcceptanceEvidence)();
  validateRepositoryEvidence(repositoryAfter);
  if (repositoryBefore.revision !== repositoryAfter.revision ||
      repositoryBefore.dirty !== repositoryAfter.dirty ||
      repositoryBefore.sourceClosureSha256 !== repositoryAfter.sourceClosureSha256) {
    throw acceptanceError("Repository revision or measured source closure changed between builds.");
  }
  if (first.workbenchVersion.executable !== second.workbenchVersion.executable ||
      first.workbenchVersion.version !== second.workbenchVersion.version ||
      first.workbenchVersion.fileVersion !== second.workbenchVersion.fileVersion) {
    throw acceptanceError("Workbench version identity changed between target-only builds.");
  }
  assertTargetMetadataUnchanged(project, target);
  const finishedMs = now();
  const artifact: WorkbenchBuildAcceptanceArtifact = {
    schemaVersion: 1,
    kind: "reforger_forge_target_build_pre_removal_acceptance",
    result: "passed",
    startedAt: isoTime(startedMs),
    finishedAt: isoTime(finishedMs),
    durationMs: Math.max(0, finishedMs - startedMs),
    environment: {
      nodeVersion: process.version,
      platform: activePlatform,
      architecture: process.arch,
      workbench: {
        executable: first.workbenchVersion.executable,
        productVersion: first.workbenchVersion.version,
        fileVersion: first.workbenchVersion.fileVersion,
        discovery: first.workbenchVersion.discovery,
      },
    },
    repository: repositoryBefore,
    evaluator: { sha256: evaluatorSha256(), contract: EVALUATOR_CONTRACT },
    target,
    configuration: {
      planKind: "target_build",
      platform: "PC",
      runCount: 2,
      outputRootsDistinctAndExclusive: true,
      publicBuildPreflightRetained: true,
      publicReceiptVersion: 3,
    },
    runs: [first, second],
    limitations: [
      "This is a repository-only pre-removal target_build prototype; the public build command still uses its helper preflight and version-3 receipt.",
      "Exact PID, creation identity, owner token, and machine paths are represented only as boolean proofs and are intentionally omitted.",
      "The artifact proves controlled build lifecycle and output behavior, not gameplay, editor rendering, or future version-4 receipt behavior.",
    ],
  };
  const username = options.environment?.USERNAME ?? process.env.USERNAME ?? "";
  assertSanitizedBuildAcceptanceArtifact(artifact, [
    options.configPath ?? "",
    options.gprojPath,
    options.outputParent,
    bundle.bundleRoot,
    project.modDirectory,
    config.workbenchPath,
    config.gamePath,
    profile.managedRoot,
    username,
  ]);
  const artifactPath = writeAcceptanceArtifact(
    resolve(options.validationRoot ?? DEFAULT_VALIDATION_ROOT),
    artifact,
    randomId()
  );
  return { artifact, artifactPath };
}

interface ParsedArguments {
  confirmed: boolean;
  configPath: string;
  gprojPath: string;
  outputParent: string;
  timeoutMs: number;
  help: boolean;
}

export function parseWorkbenchBuildAcceptanceArguments(argv: readonly string[]): ParsedArguments {
  let confirmed = false;
  let configPath = "";
  let gprojPath = "";
  let outputParent = "";
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let help = false;
  const take = (index: number, option: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw acceptanceError(`${option} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === LIVE_WORKBENCH_BUILD_CONFIRMATION) confirmed = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--config") {
      if (configPath) throw acceptanceError("--config may be supplied only once.");
      configPath = take(index, argument);
      index += 1;
    } else if (argument === "--gproj") {
      if (gprojPath) throw acceptanceError("--gproj may be supplied only once.");
      gprojPath = take(index, argument);
      index += 1;
    } else if (argument === "--output-root") {
      if (outputParent) throw acceptanceError("--output-root may be supplied only once.");
      outputParent = take(index, argument);
      index += 1;
    } else if (argument === "--timeout-ms") {
      timeoutMs = Number(take(index, argument));
      index += 1;
    } else {
      throw acceptanceError(`Unknown target-build acceptance option: ${argument}`);
    }
  }
  if (!help && (!configPath || !gprojPath || !outputParent)) {
    throw acceptanceError(
      "Live target-build acceptance requires --config, --gproj, and --output-root."
    );
  }
  if (!help) requireTimeout(timeoutMs);
  return { confirmed, configPath, gprojPath, outputParent, timeoutMs, help };
}

export function workbenchBuildAcceptanceUsage(): string {
  return "Usage: npm run dev:workbench:acceptance:build -- --confirm-live-run " +
    "--config <file> --gproj <absolute-real-target.gproj> " +
    "--output-root <existing-external-directory> " +
    "[--timeout-ms <60000..3600000>]\n\n" +
    `Also set ${LIVE_WORKBENCH_BUILD_ENVIRONMENT}=1. The harness creates and retains two ` +
    "exclusive output roots, runs the controller target_build path twice, and writes only a " +
    "sanitized pre-removal artifact beneath docs/validation. It does not change the public " +
    "two-phase build command or emit a version-4 receipt.\n";
}

export function redactConsoleError(error: unknown, values: readonly string[]): string {
  const pathValues = values.filter((value) => value.length > 0 && (
    isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
  ));
  const message = redactText(error instanceof Error ? error.message : String(error), {
    profile: "diagnostic",
    replacement: "<redacted-path>",
    knownSecretValues: pathValues,
    maxLength: 4_096,
  });
  return redactText(message, {
    profile: "command_argument",
    replacement: "<redacted>",
    maxLength: 4_096,
  });
}

async function main(): Promise<void> {
  let parsed: ParsedArguments;
  try {
    parsed = parseWorkbenchBuildAcceptanceArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${redactConsoleError(error, process.argv.slice(2))}\n`);
    process.stderr.write(workbenchBuildAcceptanceUsage());
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    process.stdout.write(workbenchBuildAcceptanceUsage());
    return;
  }
  try {
    const result = await runWorkbenchBuildAcceptance({
      confirmed: parsed.confirmed,
      configPath: parsed.configPath,
      gprojPath: parsed.gprojPath,
      outputParent: parsed.outputParent,
      timeoutMs: parsed.timeoutMs,
    });
    process.stdout.write(`${JSON.stringify({
      result: "passed",
      runs: result.artifact.runs.length,
      artifact: relative(REPOSITORY_ROOT, result.artifactPath).split(sep).join("/"),
      publicBuildReceipt: "unchanged-v3",
    })}\n`);
  } catch (error) {
    process.stderr.write(`${redactConsoleError(error, [
      parsed.gprojPath,
      parsed.outputParent,
      parsed.configPath,
      process.env.USERNAME ?? "",
    ])}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) void main();
