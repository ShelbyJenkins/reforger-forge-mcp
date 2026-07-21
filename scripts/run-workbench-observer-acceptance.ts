#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { OBSERVER_TERMINAL_STATES } from "../observer/protocol/enforce-contract.js";
import { caseForId, OBSERVER_FAULT_MATRIX, type FaultMatrixCase } from "../observer/protocol/fault-matrix.js";
import { loadConfig, type Config } from "../src/config.js";
import {
  deadlineAt,
  pollUntil,
  systemClock,
  systemSleeper,
} from "../src/foundation/time.js";
import {
  createObserverApplication,
  type ObserverApplication,
  type ObserverCaptureView,
} from "../src/observer/application.js";
import { generateGproj } from "../src/templates/gproj.js";
import { WorkbenchClient } from "../src/workbench/client.js";
import {
  WorkbenchObserverAdapter,
  workbenchCameraMatrix,
  type WorkbenchCameraMatrix,
  type WorkbenchObserverJobStatus,
} from "../src/workbench/observer-adapter.js";
import { WorkbenchProcessGuard } from "../src/workbench/process-guard.js";
import {
  OperationalBaselineRecorder,
  analyzePngMaterial,
  buildObserverFailureMatrixArtifact,
  comparePngImages,
  inspectBlockingProcesses,
  matrixRetainedDiagnostic,
  operationalBaselineDirectoryIdentity,
  operationalBaselineEnvironment,
  operationalBaselineLaunchArgumentIdentity,
  operationalBaselineProcedureSha256,
  operationalBaselineSource,
  waitForOperationalBaselineProcessVacancy,
  writeObserverFailureMatrixArtifact,
  writeOperationalBaselineArtifact,
  type FailureMatrixPublication,
  type MatrixCaseEntry,
  type PngComparisonEvidence,
  type PngMaterialEvidence,
} from "./observer-live-acceptance-support.js";
import {
  createFaultMatrixRunScaffolding,
  removeOwnedFaultControlRoot,
  resolveFaultMatrixCases,
  type FaultMatrixRunScaffolding,
  type FaultMatrixScheduler,
} from "./observer-fault-matrix-support.js";

export const LIVE_WORKBENCH_OBSERVER_ENVIRONMENT =
  "RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE";
export const LIVE_WORKBENCH_OBSERVER_TEST_CONFIRMATION =
  "RFO_CONFIRM_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const LOCAL_CONFIG_PATH = join(REPOSITORY_ROOT, "reforger-forge.config.json");
const WORKBENCH_OPERATIONAL_BASELINE_SOURCES = [
  "dist/observer/agent/private-child.js",
  "observer/addon/.reforger-forge-observer-source.json",
  "observer/addon/addon.gproj",
  "observer/agent/private-child.ts",
  "observer/agent/application.ts",
  "observer/agent/application-operations.ts",
  "observer/agent/evidence-bundle-service.ts",
  "observer/workbench-addon/.reforger-forge-workbench-helper-source.json",
  "observer/workbench-addon/addon.gproj",
  "package-lock.json",
  "package.json",
  "scripts/windows/workbench-lifecycle.ps1",
  "scripts/observer-fault-matrix-support.ts",
  "observer/protocol/fault-matrix.ts",
  "src/foundation/redact.ts",
  "src/foundation/time.ts",
  "src/observer/public-contract.ts",
  "src/observer/application.ts",
  "src/observer/capture-service.ts",
  "src/observer/evidence-run-service.ts",
  "src/foundation/child-supervisor.ts",
  "src/workbench/activity-gate.ts",
  "src/workbench/child-supervisor.ts",
  "src/workbench/client.ts",
  "src/workbench/diagnostics.ts",
  "src/workbench/helper-addon.ts",
  "src/workbench/launch-plan.ts",
  "src/workbench/lifecycle-execution.ts",
  "src/workbench/managed-build-profile.ts",
  "src/workbench/net-api-client.ts",
  "src/workbench/observer-adapter.ts",
  "src/workbench/process-guard.ts",
  "src/workbench/protocol.ts",
  "src/workbench/readiness.ts",
  "src/workbench/session-controller.ts",
  "src/workbench/session-state.ts",
] as const;
const OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES = [
  { path: "dist/observer/agent/**/*.js", directory: "dist/observer/agent", extension: ".js" },
  { path: "dist/observer/protocol/**/*.js", directory: "dist/observer/protocol", extension: ".js" },
  { path: "observer/addon/**/*.c", directory: "observer/addon", extension: ".c" },
  { path: "observer/agent/**/*.ts", directory: "observer/agent", extension: ".ts" },
  { path: "observer/protocol/**/*.ts", directory: "observer/protocol", extension: ".ts" },
  { path: "observer/workbench-addon/**/*.c", directory: "observer/workbench-addon", extension: ".c" },
  { path: "src/**/*.ts", directory: "src", extension: ".ts" },
] as const;
const BASE_EVERON_WORLD = "{853E92315D1D9EFE}worlds/Eden/Eden.ent";
const WORKBENCH_CAPTURE_LABELS = [
  "initial-current",
  "explicit-pose",
  "post-pose-restoration-current",
  "explicit-look-at",
  "post-look-at-restoration-current",
] as const;
const TERMINAL_STATES = new Set<string>(OBSERVER_TERMINAL_STATES);

export interface WorkbenchObserverAcceptanceOptions {
  confirmed: boolean;
  environment?: NodeJS.ProcessEnv;
  artifactRoot?: string;
  /** Defaults to the repository's docs/validation directory. */
  validationRoot?: string;
  timeoutMs?: number;
  /** Phase 1 recognizes only declared matrix IDs and intentionally executes none. */
  only?: string;
}

export interface WorkbenchObserverAcceptanceResult {
  runDirectory: string;
  summaryPath: string;
  evidenceDirectory: string;
  manifestPath: string;
  baselinePath: string;
  summary: Record<string, unknown>;
}

interface RetainedCapture {
  label: string;
  submitted: Record<string, unknown>;
  completed: WorkbenchObserverJobStatus;
  image: Buffer;
  png: PngMaterialEvidence;
}

interface FinalizedBundleEvidence {
  evidenceDirectory: string;
  manifestPath: string;
  manifestSha256: string;
  files: string[];
}

export function assertLiveWorkbenchObserverAuthorized(
  confirmed: boolean,
  environment: NodeJS.ProcessEnv = process.env
): void {
  if (!confirmed) {
    throw new Error("Live Workbench observer acceptance requires --confirm-live-run");
  }
  if (environment[LIVE_WORKBENCH_OBSERVER_ENVIRONMENT] !== "1") {
    throw new Error(
      `Live Workbench observer acceptance requires ${LIVE_WORKBENCH_OBSERVER_ENVIRONMENT}=1`
    );
  }
}

function finiteMatrix(matrix: WorkbenchCameraMatrix): void {
  if (matrix.length !== 4 || matrix.some((axis) =>
    axis.length !== 3 || axis.some((value) => !Number.isFinite(value)))) {
    throw new Error("Workbench observer returned a non-finite camera matrix");
  }
}

/** Invert the row-major rotation produced by workbenchCameraMatrix. */
export function quaternionFromWorkbenchMatrix(
  matrix: WorkbenchCameraMatrix
): [number, number, number, number] {
  finiteMatrix(matrix);
  const m00 = matrix[0][0];
  const m01 = matrix[0][1];
  const m02 = matrix[0][2];
  const m10 = matrix[1][0];
  const m11 = matrix[1][1];
  const m12 = matrix[1][2];
  const m20 = matrix[2][0];
  const m21 = matrix[2][1];
  const m22 = matrix[2][2];
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    w = 0.25 * scale;
    x = (m21 - m12) / scale;
    y = (m02 - m20) / scale;
    z = (m10 - m01) / scale;
  } else if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / scale;
    x = 0.25 * scale;
    y = (m01 + m10) / scale;
    z = (m02 + m20) / scale;
  } else if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / scale;
    x = (m01 + m10) / scale;
    y = 0.25 * scale;
    z = (m12 + m21) / scale;
  } else {
    const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / scale;
    x = (m02 + m20) / scale;
    y = (m12 + m21) / scale;
    z = 0.25 * scale;
  }
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length < 0.999 || length > 1.001) {
    throw new Error("Baseline Workbench camera matrix is not a normalized rotation");
  }
  const result: [number, number, number, number] = [x / length, y / length, z / length, w / length];
  const roundTrip = workbenchCameraMatrix({
    kind: "pose",
    position: matrix[3],
    orientation: result,
    fov: 60,
  });
  assertCameraMatrixClose(matrix, roundTrip, 0.002, false);
  return result;
}

export function assertCameraMatrixClose(
  expected: WorkbenchCameraMatrix,
  actual: WorkbenchCameraMatrix,
  tolerance = 0.002,
  comparePosition = true
): void {
  finiteMatrix(expected);
  finiteMatrix(actual);
  for (let axis = 0; axis < (comparePosition ? 4 : 3); axis += 1) {
    for (let component = 0; component < 3; component += 1) {
      if (Math.abs(expected[axis][component] - actual[axis][component]) > tolerance) {
        throw new Error(
          `Camera restoration mismatch at matrix[${axis}][${component}]: ` +
          `${expected[axis][component]} != ${actual[axis][component]}`
        );
      }
    }
  }
}

function assertRestoredWorkbenchCurrent(
  baseline: RetainedCapture,
  restored: RetainedCapture,
  label: string
): void {
  assertCameraMatrixClose(
    baseline.completed.actualCamera.matrix,
    restored.completed.actualCamera.matrix
  );
  if (Math.abs(
    baseline.completed.actualCamera.verticalFov -
    restored.completed.actualCamera.verticalFov
  ) > 0.002 ||
      baseline.completed.ownerCameraId !== restored.completed.ownerCameraId ||
      baseline.completed.worldIdentity !== restored.completed.worldIdentity) {
    throw new Error(
      `${label} did not match baseline FOV, camera owner, and editor world identity`
    );
  }
}

function randomGuid(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

const WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR = join(
  REPOSITORY_ROOT, "tests", "fixtures", "workbench-observer-failure-matrix-addon"
);
/** Fixed GUID of tests/fixtures/workbench-observer-failure-matrix-addon/addon.gproj. */
const WORKBENCH_MATRIX_FIXTURE_GUID = "2C6B8D14F9A0473E";
const WORKBENCH_MATRIX_FIXTURE_ADDON_DIR_NAME = "ObserverMatrixFixture";

/**
 * Copy the disposable matrix fixture add-on into the generated project search
 * root so Workbench can resolve it, and return the dependency GUID the opened
 * project must declare so the fixture's `modded class EMCP_WB_ObserverService`
 * is loaded. Staged only for a matrix run; the positive-path acceptance never
 * calls this, so with no staged fixture the helper stays inert.
 */
function stageWorkbenchMatrixFixture(runDirectory: string): string {
  const fixtureDirectory = join(runDirectory, WORKBENCH_MATRIX_FIXTURE_ADDON_DIR_NAME);
  cpSync(WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR, fixtureDirectory, { recursive: true });
  return WORKBENCH_MATRIX_FIXTURE_GUID;
}

function createDisposableProject(runDirectory: string, options?: {
  stageMatrixFixture?: boolean;
}): {
  modDirectory: string;
  projectPath: string;
  worldResource: string;
} {
  // In matrix mode the disposable project declares a dependency on the copied
  // fixture add-on so opening it loads the fixture's modded observer service.
  const dependencies = options?.stageMatrixFixture
    ? [stageWorkbenchMatrixFixture(runDirectory)]
    : undefined;
  const modDirectory = join(runDirectory, "ObserverAcceptance");
  const worldsDirectory = join(modDirectory, "Worlds");
  mkdirSync(worldsDirectory, { recursive: true });
  const projectPath = join(modDirectory, "ObserverAcceptance.gproj");
  writeFileSync(projectPath, generateGproj({
    name: "ObserverAcceptance",
    title: "ReforgerForge Workbench observer acceptance",
    guid: randomGuid(),
    dependencies,
  }), { encoding: "utf8", flag: "wx" });
  const worldGuid = randomGuid();
  const worldPath = join(worldsDirectory, "ObserverAcceptance.ent");
  writeFileSync(worldPath, `SubScene {\n Parent "${BASE_EVERON_WORLD}"\n}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  writeFileSync(`${worldPath}.meta`, [
    "MetaFileClass {",
    ` Name "{${worldGuid}}Worlds/ObserverAcceptance.ent"`,
    " Configurations {",
    "  ENTResourceClass PC {",
    "  }",
    "  ENTResourceClass HEADLESS : PC {",
    "  }",
    " }",
    "}",
    "",
  ].join("\n"), { encoding: "utf8", flag: "wx" });
  return {
    modDirectory,
    projectPath,
    worldResource: `{${worldGuid}}Worlds/ObserverAcceptance.ent`,
  };
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  const entry = lstatSync(absolute);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${absolute}`);
  }
  return realpathSync.native(absolute);
}

function assertEvidenceOutsideRepository(path: string): void {
  const relation = relative(realpathSync.native(REPOSITORY_ROOT), path);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("Workbench observer evidence root must be outside the repository");
  }
}

function acceptanceConfig(projectRoot: string, managedRoot: string): Config {
  if (!existsSync(LOCAL_CONFIG_PATH)) {
    throw new Error("Live Workbench acceptance requires the repository-local, gitignored reforger-forge.config.json");
  }
  // Parse independently first so a malformed local file cannot silently fall
  // back to machine defaults in loadConfig().
  JSON.parse(readFileSync(LOCAL_CONFIG_PATH, "utf8"));
  const local = loadConfig();
  const workbenchPath = canonicalDirectory(local.workbenchPath, "Workbench tools directory");
  const gamePath = canonicalDirectory(local.gamePath, "Arma Reforger game directory");
  const configuredRoots = (local.workbenchAddonDirs ?? []).map((path, index) =>
    canonicalDirectory(path, `Workbench addon root ${index + 1}`));
  const host = local.workbenchHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Live Workbench observer acceptance requires a loopback NET API endpoint");
  }
  return {
    ...local,
    workbenchPath,
    gamePath,
    projectPath: projectRoot,
    workbenchAddonDirs: [...configuredRoots, projectRoot],
    workbenchScriptAuthorizeAll: false,
    observer: {
      ...local.observer!,
      managedRoot,
      profileRoot: join(managedRoot, "profiles"),
    },
  };
}

function firstRegularExecutable(candidates: string[]): string | undefined {
  return candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    const entry = lstatSync(candidate);
    return entry.isFile() && !entry.isSymbolicLink();
  });
}

function workbenchEnvironmentExecutables(config: Config): {
  workbenchExecutable?: string;
  gameExecutable?: string;
} {
  return {
    workbenchExecutable: firstRegularExecutable([
      join(config.workbenchPath, "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
      join(config.workbenchPath, "ArmaReforgerWorkbenchSteamDiag.exe"),
    ]),
    gameExecutable: firstRegularExecutable([
      join(config.gamePath, "ArmaReforgerSteamDiag.exe"),
      join(config.gamePath, "ArmaReforgerDiag.exe"),
      join(config.gamePath, "ArmaReforgerSteam.exe"),
      join(config.gamePath, "ArmaReforger.exe"),
    ]),
  };
}

function assertNoArmaOrWorkbench(): void {
  const blockers = inspectBlockingProcesses();
  if (blockers.length > 0) {
    throw new Error(
      "Live acceptance refuses to start while any Arma Reforger or Workbench process exists: " +
      blockers.map((entry) => `${entry.processName} (${entry.id})`).join(", ")
    );
  }
}

async function waitForCaptureCapability(
  application: ObserverApplication,
  deadline: number
): Promise<Record<string, unknown>> {
  let lastError = "observer handler has not responded";
  const result = await pollUntil<Record<string, unknown>>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(deadline),
    intervalMs: 1_000,
    probe: async (): Promise<Record<string, unknown> | undefined> => {
      try {
        const inventory = await application.instances({ renderersOnly: true });
        const eligible = inventory.instances.filter((instance) =>
          instance.backend === "workbench" &&
          Array.isArray(instance.capabilities) &&
          instance.capabilities.includes("render.capture")
        );
        if (eligible.length === 1) return eligible[0];
        if (eligible.length > 1) {
          throw new Error("Multiple compatible Workbench observer instances are available");
        }
        lastError = inventory.warnings?.join("; ") || "an editor world is not yet renderer-ready";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      return undefined;
    },
  });
  if (result.kind === "value") return result.value;
  throw new Error(`Timed out waiting for Workbench observer capture capability: ${lastError}`);
}

async function pollTerminal(
  application: ObserverApplication,
  jobId: string,
  deadline: number
): Promise<Record<string, unknown>> {
  let status: Record<string, unknown> | null = null;
  const result = await pollUntil<Record<string, unknown>>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(deadline),
    intervalMs: 250,
    probe: async (): Promise<Record<string, unknown> | undefined> => {
      status = await application.jobStatus(undefined, jobId);
      if (typeof status.state !== "string") {
        throw new Error(`Workbench observer job ${jobId} returned no state`);
      }
      return TERMINAL_STATES.has(status.state) ? status : undefined;
    },
  });
  if (result.kind === "expired") {
    const lastStatus = status as Record<string, unknown> | null;
    const last = lastStatus
      ? `; last state=${String(lastStatus.state)}, message=${String(lastStatus.terminalMessage ?? "")}`
      : "; no status response was retained";
    throw new Error(`Timed out waiting for Workbench observer job ${jobId}${last}`);
  }
  status = result.value;
  if (status.state !== "completed" || status.cameraLeaseHeld || !status.restorationConfirmed) {
    throw new Error(
      `Workbench observer job ${jobId} ended ${status.state}; ` +
      `restored=${status.restorationConfirmed}, leaseHeld=${status.cameraLeaseHeld}, ` +
      `error=${status.terminalErrorCode ?? "none"}, message=${status.terminalMessage ?? ""}`
    );
  }
  return status;
}

async function captureAndRetainUnmeasured(
  application: ObserverApplication,
  view: ObserverCaptureView,
  label: string,
  runId: string,
  instanceId: string,
  expectedWorldId: string,
  deadline: number
): Promise<RetainedCapture> {
  const capture = await application.capture({
    runId,
    captureLabel: label,
    purpose: `Live Workbench acceptance capture: ${label}`,
    instanceId,
    expectedWorldId,
    expectedWorldEpoch: 0,
    idempotencyKey: `${runId}:${label}`,
    view,
    settleFrames: 3,
    performancePolicy: "evidence",
    asynchronous: true,
    timeoutMs: Math.max(1_000, Math.min(5 * 60_000, deadline - Date.now())),
  });
  if (!capture.asynchronous || typeof capture.job.jobId !== "string") {
    throw new Error(`${label} did not return an asynchronous managed Workbench job`);
  }
  const submitted = capture.job;
  const jobId = capture.job.jobId;
  const managedCompleted = await pollTerminal(application, jobId, deadline);
  const completed = {
    ...managedCompleted,
    worldIdentity: requiredString(managedCompleted.worldId, `${label} managed world identity`),
  } as unknown as WorkbenchObserverJobStatus;
  if (completed.state !== "completed" || completed.cameraLeaseHeld || !completed.restorationConfirmed) {
    throw new Error(`${label} managed job state disagrees with the Workbench adapter's terminal restoration proof`);
  }
  const retained = await application.readJob(undefined, jobId);
  const png = analyzePngMaterial(retained.image);
  if (!png.materiallyVaried) {
    throw new Error(`${label} screenshot is blank or lacks material color/luminance variation`);
  }
  if (completed.artifact?.width !== png.width || completed.artifact.height !== png.height) {
    throw new Error(`${label} PNG dimensions disagree with the independently validated source artifact`);
  }
  if (retained.metadata.contentSha256 !== png.sha256 || retained.metadata.bytes !== png.byteCount ||
      retained.metadata.width !== png.width || retained.metadata.height !== png.height) {
    throw new Error(`${label} managed artifact metadata disagrees with the independently validated PNG`);
  }
  const artifact = record(managedCompleted.artifact, `${label} managed job artifact metadata`);
  if (artifact.bytes !== png.byteCount || artifact.contentSha256 !== png.sha256 ||
      artifact.width !== png.width || artifact.height !== png.height) {
    throw new Error(`${label} managed job artifact metadata disagrees with the independently validated PNG`);
  }
  return { label, submitted, completed, image: retained.image, png };
}

async function captureAndRetain(
  application: ObserverApplication,
  view: ObserverCaptureView,
  label: string,
  runId: string,
  instanceId: string,
  expectedWorldId: string,
  deadline: number,
  baseline: OperationalBaselineRecorder
): Promise<RetainedCapture> {
  return baseline.measure(
    "capture",
    `ObserverApplication.capture/jobStatus/readJob(${label})`,
    () => captureAndRetainUnmeasured(
      application,
      view,
      label,
      runId,
      instanceId,
      expectedWorldId,
      deadline
    ),
    label
  );
}

function writeSummary(path: string, summary: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function comparisonPath(value: string): string {
  const absolute = resolve(value);
  return absolute.toLowerCase();
}

function bundleFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Finalized evidence contains a symbolic link: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).replace(/\\/g, "/"));
      else throw new Error(`Finalized evidence contains an unsupported filesystem entry: ${path}`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function validateFinalizedBundle(
  finalized: Record<string, unknown>,
  evidenceRoot: string,
  runId: string,
  captures: RetainedCapture[]
): FinalizedBundleEvidence {
  const receipt = record(finalized.receipt, "Observer finalization receipt");
  const evidenceDirectory = canonicalDirectory(
    requiredString(receipt.evidenceDirectory, "Finalized evidence directory"),
    "Finalized evidence directory"
  );
  const expectedDirectory = resolve(evidenceRoot, runId);
  if (comparisonPath(evidenceDirectory) !== comparisonPath(expectedDirectory)) {
    throw new Error("Observer finalized the Workbench evidence outside the selected run bundle path");
  }
  const manifestPath = join(evidenceDirectory, "manifest.json");
  const manifestEntry = lstatSync(manifestPath);
  if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) {
    throw new Error("Finalized Workbench evidence has no regular manifest completion marker");
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  if (receipt.manifestSha256 !== manifestSha256 || receipt.captureCount !== captures.length ||
      receipt.managedArtifactsReleased !== true) {
    throw new Error("Finalized Workbench evidence receipt disagrees with the committed bundle");
  }
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "Finalized evidence manifest");
  const review = record(manifest.review, "Finalized evidence review");
  if (manifest.manifestVersion !== 1 || manifest.runId !== runId ||
      review.imagesReviewed !== false || review.outcome !== "Unreviewed") {
    throw new Error("Finalized Workbench evidence manifest has the wrong run or automated-review contract");
  }

  const actualFiles = bundleFiles(evidenceDirectory);
  const expectedFiles = [
    "RESULT.md",
    "manifest.json",
    "runtime-config.json",
    ...captures.flatMap((capture) => [
      `captures/${capture.label}.json`,
      `captures/${capture.label}.png`,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Finalized Workbench evidence contains missing or unexpected bundle members");
  }

  if (!Array.isArray(manifest.files)) throw new Error("Finalized evidence manifest has no member attestations");
  const attested = manifest.files.map((value, index) => {
    const item = record(value, `Finalized evidence member attestation ${index}`);
    return {
      path: requiredString(item.path, `Finalized evidence member path ${index}`),
      bytes: item.bytes,
      sha256: item.sha256,
    };
  });
  const expectedAttestedPaths = actualFiles.filter((path) => path !== "manifest.json");
  if (JSON.stringify(attested.map((item) => item.path)) !== JSON.stringify(expectedAttestedPaths)) {
    throw new Error("Finalized evidence member attestations are incomplete or non-canonical");
  }
  for (const item of attested) {
    const bytes = readFileSync(join(evidenceDirectory, ...item.path.split("/")));
    if (item.bytes !== bytes.length || item.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error(`Finalized evidence member attestation failed for ${item.path}`);
    }
  }

  if (!Array.isArray(manifest.captures) || manifest.captures.length !== captures.length) {
    throw new Error("Finalized evidence manifest has the wrong capture count");
  }
  for (const capture of captures) {
    const item = manifest.captures
      .map((value, index) => record(value, `Finalized capture manifest ${index}`))
      .find((value) => value.label === capture.label);
    if (!item) throw new Error(`Finalized evidence omitted capture ${capture.label}`);
    const imagePath = requiredString(item.imagePath, `Finalized capture image path ${capture.label}`);
    const metadataPath = requiredString(item.metadataPath, `Finalized capture metadata path ${capture.label}`);
    if (imagePath !== `captures/${capture.label}.png` || metadataPath !== `captures/${capture.label}.json`) {
      throw new Error(`Finalized evidence used non-standard paths for capture ${capture.label}`);
    }
    const image = readFileSync(join(evidenceDirectory, ...imagePath.split("/")));
    const png = analyzePngMaterial(image);
    if (png.sha256 !== capture.png.sha256 || png.width !== capture.png.width || png.height !== capture.png.height ||
        item.sha256 !== png.sha256 || item.bytes !== png.byteCount || item.width !== png.width || item.height !== png.height) {
      throw new Error(`Finalized evidence image disagrees with managed capture ${capture.label}`);
    }
    const metadata = record(
      JSON.parse(readFileSync(join(evidenceDirectory, ...metadataPath.split("/")), "utf8")),
      `Finalized capture metadata ${capture.label}`
    );
    if (JSON.stringify(metadata) !== JSON.stringify(item)) {
      throw new Error(`Finalized evidence metadata disagrees with manifest capture ${capture.label}`);
    }
  }
  return { evidenceDirectory, manifestPath, manifestSha256, files: actualFiles };
}

export async function runWorkbenchObserverAcceptance(
  options: WorkbenchObserverAcceptanceOptions
): Promise<WorkbenchObserverAcceptanceResult> {
  assertLiveWorkbenchObserverAuthorized(options.confirmed, options.environment);
  const phaseOneFaultCases = resolveFaultMatrixCases(OBSERVER_FAULT_MATRIX, options.only);
  if (phaseOneFaultCases.length > 0) {
    throw new Error("Workbench fault-matrix execution is not enabled until the Phase 3 fixture bridge is installed");
  }
  const timeoutMs = options.timeoutMs ?? 240_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 600_000) {
    throw new Error("Live Workbench observer timeout must be 60000..600000 ms");
  }
  assertNoArmaOrWorkbench();
  const artifactRoot = canonicalDirectory(
    options.artifactRoot ?? (() => {
      const path = join(tmpdir(), "reforger-forge-workbench-observer-acceptance");
      mkdirSync(path, { recursive: true });
      return path;
    })(),
    "Workbench observer evidence root"
  );
  assertEvidenceOutsideRepository(artifactRoot);
  const runDirectory = mkdtempSync(join(artifactRoot, "run-"));
  const projectRoot = join(runDirectory, "project");
  const managedRoot = join(runDirectory, "observer-managed");
  const evidenceRoot = join(runDirectory, "evidence");
  mkdirSync(projectRoot);
  mkdirSync(managedRoot);
  mkdirSync(evidenceRoot);
  const summaryPath = join(runDirectory, "summary.json");
  const validationRoot = resolve(
    options.validationRoot ?? join(REPOSITORY_ROOT, "docs", "validation")
  );
  const project = createDisposableProject(projectRoot);
  const config = acceptanceConfig(projectRoot, managedRoot);
  const guard = new WorkbenchProcessGuard({
    stateDir: join(runDirectory, "lifecycle"),
    helperPath: join(REPOSITORY_ROOT, "scripts", "windows", "workbench-lifecycle.ps1"),
    lockTimeoutMs: 20_000,
  });
  let baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity([], false);
  const client = new WorkbenchClient(
    config.workbenchHost,
    config.workbenchPort,
    config,
    `live-workbench-observer-${randomUUID()}`,
    guard,
    {
      launchTimeoutMs: 180_000,
      launchPollIntervalMs: 1_000,
      // Acceptance projects are created immediately before launch. A fixed,
      // argument-array-only force update indexes the world without a shell.
      spawnProcess: (command, argumentsArray, spawnOptions) => {
        const actualArguments = [...argumentsArray, "-forceUpdate"];
        baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity(actualArguments);
        return spawn(command, actualArguments, spawnOptions);
      },
    }
  );
  const adapter = new WorkbenchObserverAdapter(client, { handlerTimeoutMs: 10_000 });
  // This script is executed through tsx after `npm run build`; the source-file
  // default would otherwise resolve beneath src/ instead of the compiled agent.
  const observerAgentPath = join(REPOSITORY_ROOT, "dist", "observer", "agent", "private-child.js");
  if (!existsSync(observerAgentPath)) {
    throw new Error(`Compiled observer agent is missing: ${observerAgentPath}`);
  }
  const application = createObserverApplication({
    agentPath: observerAgentPath,
    managedRoot,
    profileRoot: join(managedRoot, "profiles"),
    projectPath: projectRoot,
    sourceAddon: join(REPOSITORY_ROOT, "observer", "addon"),
    requestTimeoutMs: 60_000,
    defaultCaptureTimeoutMs: 5 * 60_000,
    maxInlineImageBytes: 64 * 1024 * 1024,
    evidenceRoots: [evidenceRoot],
    workbenchAdapter: adapter,
  });
  let cleanupClient = client;
  const readBaselineProcessCounts = () => {
    const primary = client.diagnosticSupervisedChildCounts();
    const recovery = cleanupClient === client
      ? { active: 0, reconciling: 0, total: 0 }
      : cleanupClient.diagnosticSupervisedChildCounts();
    const observerPrivateChildren = application.diagnosticPrivateChildCount();
    return {
      active: primary.active + recovery.active + observerPrivateChildren,
      reconciling: primary.reconciling + recovery.reconciling,
      total: primary.total + recovery.total + observerPrivateChildren,
    };
  };
  const baseline = new OperationalBaselineRecorder({
    backend: "workbench",
    readSupervisedProcessCounts: readBaselineProcessCounts,
  });
  const baselineEnvironment = operationalBaselineEnvironment(
    workbenchEnvironmentExecutables(config)
  );
  const baselineSource = operationalBaselineSource(
    SCRIPT_PATH,
    "scripts/run-workbench-observer-acceptance.ts",
    REPOSITORY_ROOT,
    WORKBENCH_OPERATIONAL_BASELINE_SOURCES,
    OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES
  );
  baseline.sampleProcessCounts("rest.beforeLaunch");
  const deadline = Date.now() + timeoutMs;
  const summary: Record<string, unknown> = {
    version: 1,
    status: "running",
    startedAt: baseline.startedAt,
    runDirectory,
    project: project.projectPath,
    worldResource: project.worldResource,
    processPolicy: "preflight-all-Arma; exact Workbench lifecycle owner shutdown only",
    evidencePolicy: "managed observer run; manifest-last standardized bundle; automated images remain unreviewed",
  };
  writeSummary(summaryPath, summary);
  let failure: unknown = null;
  let observerRunId: string | null = null;
  let faultScaffolding: ReturnType<typeof createFaultMatrixRunScaffolding> | null = null;
  let bundle: FinalizedBundleEvidence | null = null;
  let baselinePath = "";
  try {
    assertNoArmaOrWorkbench();
    const begun = await application.beginRun({
      title: "Live Workbench observer screenshot acceptance",
      caseIds: ["WB-OBSERVER-LIVE-CAPTURE"],
      procedureRevision: "workbench-observer-live-acceptance-v3",
      idempotencyKey: `workbench-live-${randomUUID()}`,
    });
    observerRunId = requiredString(begun.runId, "Managed observer run ID");
    summary.observerRun = begun;
    const launched = await baseline.measure(
      "launch",
      "WorkbenchClient.ensureRunning",
      () => client.ensureRunning(project.projectPath),
      "running_confirmation"
    );
    summary.launch = launched;
    const workbenchLifecycle = await client.lifecycleIdentity();
    const fixtureContentIdentity = operationalBaselineProcedureSha256({
      projectPath: project.projectPath,
      worldResource: project.worldResource,
    });
    const generatedProjectIdentity = operationalBaselineProcedureSha256({
      projectPath: project.projectPath,
      generation: launched.generation,
    });
    const generatedAddonIdentity = operationalBaselineProcedureSha256({
      observerAddon: "generated-workbench-observer-helper",
      projectPath: project.projectPath,
    });
    const faultBinding = Object.freeze({
      fixtureId: generatedProjectIdentity,
      lifecycleId: workbenchLifecycle.lifecycleId,
      lifecycleGeneration: workbenchLifecycle.generation,
    });
    faultScaffolding = createFaultMatrixRunScaffolding({
      runRoot: runDirectory,
      controlRoot: join(runDirectory, "fault-control"),
      matrix: OBSERVER_FAULT_MATRIX,
      bootstrap: {
        schemaVersion: 1,
        runId: observerRunId,
        backend: "workbench",
        capability: randomUUID(),
        fixtureContentIdentity,
        generatedProjectIdentity,
        generatedAddonIdentity,
        binding: faultBinding,
      },
      clock: systemClock,
      sleeper: systemSleeper,
      readLifecycleBinding: () => faultBinding,
      onCleanup: () => {
        if (faultScaffolding) removeOwnedFaultControlRoot(faultScaffolding.controlRoot);
      },
    });
    summary.faultMatrixControl = { configured: true, declaredCaseCount: phaseOneFaultCases.length };
    const open = await baseline.measure(
      "managed_call",
      "WorkbenchClient.call(EMCP_WB_EditorControl.openResource)",
      () => client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
        action: "openResource",
        path: project.worldResource,
      }, { skipAutoLaunch: true, timeout: 30_000 }),
      "representative_net_api"
    );
    if (open.status !== "ok" || !String(open.message ?? "").startsWith("Opened resource:")) {
      throw new Error(`Disposable acceptance world did not open: ${String(open.message ?? "no response")}`);
    }
    const selected = await waitForCaptureCapability(application, deadline);
    const instanceId = requiredString(selected.instanceId, "Selected Workbench observer instance ID");
    const expectedWorldId = requiredString(selected.worldId, "Selected Workbench observer world ID");

    const initial = await captureAndRetain(
      application,
      { kind: "current" },
      "initial-current",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline,
      baseline
    );
    const inventory = await application.instances({ renderersOnly: true });
    const workbenchInventory = inventory.instances.filter((instance) => instance.backend === "workbench");
    const ping = await baseline.measure(
      "managed_call",
      "WorkbenchObserverAdapter.ping(EMCP_WB_Ping)",
      () => adapter.ping(),
      "representative_net_api"
    );
    if (workbenchInventory.length !== 1 || workbenchInventory[0].instanceId !== instanceId ||
        workbenchInventory[0].worldId !== expectedWorldId ||
        !ping.capabilities.includes("render.capture") ||
        !ping.capabilities.includes("camera.editor") || !ping.restorationApiAvailable) {
      throw new Error("Workbench failed to advertise proven render.capture and camera.editor after current-view restoration");
    }
    const baselineCamera = initial.completed.actualCamera;
    const baselineFov = baselineCamera.verticalFov;
    if (!Number.isFinite(baselineFov) || baselineFov < 1 || baselineFov > 179) {
      throw new Error(`Baseline editor FOV is outside pose request bounds: ${baselineFov}`);
    }
    const orientation = quaternionFromWorkbenchMatrix(baselineCamera.matrix);
    const posePosition: [number, number, number] = [
      baselineCamera.position[0] + 75,
      baselineCamera.position[1] + 25,
      baselineCamera.position[2] + 50,
    ];
    const poseFov = baselineFov <= 169 ? baselineFov + 10 : baselineFov - 10;
    const poseView = {
      kind: "pose" as const,
      position: posePosition,
      orientation,
      fov: poseFov,
    };
    const pose = await captureAndRetain(
      application,
      poseView,
      "explicit-pose",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline,
      baseline
    );
    const poseDifference: PngComparisonEvidence = comparePngImages(initial.image, pose.image);
    if (!poseDifference.materiallyDifferent) {
      throw new Error("Explicit pose screenshot is not materially different from the initial current view");
    }
    if (!pose.submitted.cameraLeaseHeld || !pose.completed.restorationConfirmed) {
      throw new Error("Explicit pose did not prove camera acquisition followed by restoration");
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(pose.completed.actualCamera.position[axis] - posePosition[axis]) > 0.01) {
        throw new Error(`Explicit pose rendered position differs at axis ${axis}`);
      }
    }
    if (Math.abs(pose.completed.actualCamera.verticalFov - poseFov) > 0.02) {
      throw new Error("Explicit pose rendered FOV differs from the requested FOV");
    }
    assertCameraMatrixClose(
      workbenchCameraMatrix(poseView),
      pose.completed.actualCamera.matrix
    );
    const postPose = await captureAndRetain(
      application,
      { kind: "current" },
      "post-pose-restoration-current",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline,
      baseline
    );
    assertRestoredWorkbenchCurrent(initial, postPose, "Post-pose current capture");

    const right = baselineCamera.matrix[0];
    const up = baselineCamera.matrix[1];
    const forward = baselineCamera.matrix[2];
    const lookAtPosition: [number, number, number] = [
      baselineCamera.position[0] - right[0] * 90 + up[0] * 35 - forward[0] * 60,
      baselineCamera.position[1] - right[1] * 90 + up[1] * 35 - forward[1] * 60,
      baselineCamera.position[2] - right[2] * 90 + up[2] * 35 - forward[2] * 60,
    ];
    const lookAtTarget: [number, number, number] = [
      baselineCamera.position[0] + forward[0] * 150,
      baselineCamera.position[1] + forward[1] * 150,
      baselineCamera.position[2] + forward[2] * 150,
    ];
    const lookAtFov = baselineFov <= 164 ? baselineFov + 15 : baselineFov - 15;
    const lookAtView = {
      kind: "lookAt" as const,
      position: lookAtPosition,
      target: lookAtTarget,
      fov: lookAtFov,
    };
    const lookAt = await captureAndRetain(
      application,
      lookAtView,
      "explicit-look-at",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline,
      baseline
    );
    const lookAtDifference: PngComparisonEvidence = comparePngImages(initial.image, lookAt.image);
    if (!lookAtDifference.materiallyDifferent) {
      throw new Error("Explicit look-at screenshot is not materially different from the initial current view");
    }
    if (!lookAt.submitted.cameraLeaseHeld || !lookAt.completed.restorationConfirmed) {
      throw new Error("Explicit look-at did not prove camera acquisition followed by restoration");
    }
    assertCameraMatrixClose(
      workbenchCameraMatrix(lookAtView),
      lookAt.completed.actualCamera.matrix
    );
    if (Math.abs(lookAt.completed.actualCamera.verticalFov - lookAtFov) > 0.02) {
      throw new Error("Explicit look-at rendered FOV differs from the requested FOV");
    }
    const postLookAt = await captureAndRetain(
      application,
      { kind: "current" },
      "post-look-at-restoration-current",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline,
      baseline
    );
    assertRestoredWorkbenchCurrent(initial, postLookAt, "Post-look-at current capture");
    summary.inventory = inventory;
    summary.ping = ping;
    summary.poseRequest = poseView;
    summary.poseScreenshotDifference = poseDifference;
    summary.lookAtRequest = lookAtView;
    summary.lookAtScreenshotDifference = lookAtDifference;
    const captures = [initial, pose, postPose, lookAt, postLookAt];
    summary.captures = captures.map((capture) => ({
      label: capture.label,
      managedJobId: capture.completed.jobId,
      png: capture.png,
      submittedLeaseHeld: capture.submitted.cameraLeaseHeld,
      restorationConfirmed: capture.completed.restorationConfirmed,
    }));
    summary.observerRunBeforeFinalize = await application.runStatus(observerRunId);
    const finalized = await application.finalizeRun({
      runId: observerRunId,
      evidenceRoot,
      includeCaptureLabels: captures.map((capture) => capture.label),
      review: {
        imagesReviewed: false,
        outcome: "Unreviewed",
        summary: "Automation validated screenshot integrity, material variation, explicit pose and look-at execution, and exact camera restoration after both views. The image contents still require human review.",
        limitations: [
          "This automated acceptance does not make a gameplay or editorial-content claim from the screenshots.",
        ],
      },
      runtimeConfig: {
        configurationId: "workbench-observer-live-acceptance-v3",
        values: {
          backend: "workbench",
          worldResource: project.worldResource,
          captureSequence: captures.map((capture) => capture.label).join(","),
          settleFrames: 3,
          expectedWorldEpoch: 0,
        },
      },
      releaseManagedArtifacts: true,
    });
    bundle = validateFinalizedBundle(finalized, evidenceRoot, observerRunId, captures);
    summary.finalization = finalized;
    summary.evidenceBundle = bundle;
    summary.status = "passed";
  } catch (error) {
    failure = error;
    summary.status = "failed";
    summary.failure = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  } finally {
    if (faultScaffolding) {
      try {
        await faultScaffolding.scheduler.finishCase();
      } catch (error) {
        failure ??= error;
        summary.status = "failed";
        summary.faultMatrixControl = error instanceof Error ? error.message : String(error);
      }
    }
    if (observerRunId) {
      try {
        summary.observerRunFinalStatus = await application.runStatus(observerRunId);
      } catch (error) {
        summary.observerRunFinalStatus = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      await baseline.measure(
        "shutdown",
        "WorkbenchObserverAdapter.restoreAll",
        () => adapter.restoreAll(),
        "observer_restoration"
      );
      summary.adapterRestoration = "complete";
    } catch (error) {
      failure ??= error;
      summary.adapterRestoration = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
    }
    try {
      await baseline.measure(
        "shutdown",
        "ObserverApplication.close",
        () => application.close(),
        "observer_cleanup"
      );
      summary.applicationShutdown = "complete";
    } catch (error) {
      failure ??= error;
      summary.applicationShutdown = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
    }
    try {
      summary.shutdown = await baseline.measure(
        "shutdown",
        "WorkbenchClient.shutdownOwnedWorkbench",
        async () => {
          const result = await client.shutdownOwnedWorkbench();
          if (!result.stopped) {
            throw new Error("Owned Workbench shutdown did not terminate the launched lifecycle child");
          }
          return result;
        },
        "termination",
        (result) => ({ stopped: result.stopped })
      );
    } catch (error) {
      failure ??= error;
      summary.shutdown = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
      // This target is a newly created disposable acceptance project. If the
      // in-process activity gate remains fail-closed after restoration failure,
      // use a fresh gate with the same persisted exact-owner guard to discard
      // only this acceptance Workbench. Production adapter/lifecycle behavior
      // remains unchanged and no PID termination or foreign scan is used.
      try {
        cleanupClient = new WorkbenchClient(
          config.workbenchHost,
          config.workbenchPort,
          config,
          `live-workbench-observer-recovery-${randomUUID()}`,
          guard
        );
        summary.shutdownRecovery = await baseline.measure(
          "shutdown",
          "WorkbenchClient.shutdownOwnedWorkbench(recovery)",
          () => cleanupClient.shutdownOwnedWorkbench(),
          "termination_recovery"
        );
      } catch (recoveryError) {
        summary.shutdownRecovery = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      }
    }
    const remaining = await guard.listWorkbenchProcesses();
    summary.remainingWorkbenchProcesses = remaining;
    if (remaining.length > 0) {
      const error = new Error(
        `Exact-owner shutdown did not establish Workbench vacancy; retained run: ${runDirectory}`
      );
      failure ??= error;
      summary.status = "failed";
    } else {
      summary.projectCleanupRequired = false;
    }
    let supervisedProcessVacancy: Awaited<ReturnType<
      typeof waitForOperationalBaselineProcessVacancy
    >> | null = null;
    try {
      supervisedProcessVacancy = await baseline.measure(
        "shutdown",
        "waitForOperationalBaselineProcessVacancy",
        async () => {
          const evidence = await waitForOperationalBaselineProcessVacancy(
            readBaselineProcessCounts
          );
          supervisedProcessVacancy = evidence;
          if (!evidence.vacant) {
            const error = new Error(
              `Supervised process vacancy was not observed within ${evidence.timeoutMs} ms ` +
              `(active=${evidence.counts.active}, reconciling=${evidence.counts.reconciling}, ` +
              `total=${evidence.counts.total})`
            );
            error.name = "SupervisedProcessVacancyTimeoutError";
            throw error;
          }
          return evidence;
        },
        "supervised_exit_settle",
        (evidence) => ({
          vacant: evidence.vacant,
          polls: evidence.polls,
          waitedMs: evidence.waitedMs,
          finalActive: evidence.counts.active,
          finalReconciling: evidence.counts.reconciling,
          finalTotal: evidence.counts.total,
        })
      );
      summary.supervisedProcessVacancy = supervisedProcessVacancy;
    } catch (error) {
      failure ??= error;
      summary.status = "failed";
      summary.supervisedProcessVacancy = {
        ...(supervisedProcessVacancy ?? {}),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    baseline.sampleProcessCounts("rest.afterShutdown");
    try {
      const baselineFailed = Boolean(failure) || summary.status !== "passed";
      const artifact = baseline.artifact({
        result: baselineFailed ? "failed" : "passed",
        environment: baselineEnvironment,
        workload: {
          procedureRevision: "workbench-observer-live-acceptance-v3",
          runtimeKind: "workbench",
          overallTimeoutMs: timeoutMs,
          worldResource: BASE_EVERON_WORLD,
          fixture: {
            kind: "disposable_workbench_world",
            id: "ObserverAcceptance",
            guid: null,
            sourceFileCount: 3,
            sourceSha256: operationalBaselineProcedureSha256({
              projectName: "ObserverAcceptance",
              parentWorld: BASE_EVERON_WORLD,
              worldResourcePattern: "{random-16-hex}Worlds/ObserverAcceptance.ent",
            }),
          },
          capture: {
            labels: [...WORKBENCH_CAPTURE_LABELS],
            settleFrames: 3,
            performancePolicy: "evidence",
            asynchronous: true,
            configurationSha256: operationalBaselineProcedureSha256({
              initial: "current",
              pose: {
                positionOffset: [75, 25, 50],
                orientation: "initial-camera",
                fovDeltaWithinBounds: 10,
              },
              restorations: ["post-pose-current", "post-look-at-current"],
              lookAt: {
                positionInInitialBasis: { right: -90, up: 35, forward: -60 },
                targetInInitialBasis: { forward: 150 },
                fovDeltaWithinBounds: 15,
              },
            }),
          },
          launchArguments: baselineLaunchArguments,
        },
        source: baselineSource,
        limitations: [
          "Descriptive controlled-run baseline only; no timing or process-count thresholds are applied.",
          "Supervised counts combine ChildSupervisor-managed Workbench lifecycle children with count-only ObserverApplication private-child tracking through actual child exit.",
          "Configured Workbench add-on roots outside the disposable project and managed helper are represented by path-list cardinality, not external add-on content; compare runs only when those roots are unchanged.",
        ],
        ...(baselineFailed ? {
          failureName: failure instanceof Error ? failure.name : "AcceptanceFailed",
        } : {}),
      });
      baselinePath = writeOperationalBaselineArtifact(validationRoot, artifact);
      summary.operationalBaseline = {
        artifact: relative(REPOSITORY_ROOT, baselinePath).replace(/\\/g, "/"),
        result: artifact.result,
        kind: artifact.kind,
      };
    } catch (error) {
      failure ??= error;
      summary.operationalBaseline = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
    }
    summary.finishedAt = new Date().toISOString();
    writeSummary(summaryPath, summary);
  }
  if (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    error.message = `${error.message}. Retained Workbench observer evidence: ${summaryPath}`;
    throw error;
  }
  if (!bundle) throw new Error(`Workbench observer acceptance produced no finalized evidence bundle. Summary: ${summaryPath}`);
  return {
    runDirectory,
    summaryPath,
    evidenceDirectory: bundle.evidenceDirectory,
    manifestPath: bundle.manifestPath,
    baselinePath,
    summary,
  };
}

// --- Phase 3 Workbench fault-matrix vertical slice ---------------------------
//
// The Workbench helper has no autonomous per-frame tick, so the fixture's
// control inbox is only drained when the host makes a NET API Status call
// (which reaches the modded EMCP_WB_ObserverService.Advance/OnLeaseAcquiredBarrier
// in tests/fixtures/workbench-observer-failure-matrix-addon). This pump keeps
// polling jobStatus so the scheduler's mailbox handshake (arm/release/terminal)
// is driven forward while it blocks on the outbox. The adapter's activity gate
// is released only by adapter.release()/WORKBENCH_EXITED, not by cancel, so a
// still-unreleased job keeps status() hitting the handler through cancellation
// and the terminal handshake.
class WorkbenchStatusPump {
  private running = false;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    private readonly application: Pick<ObserverApplication, "jobStatus">,
    private readonly jobId: string,
    private readonly intervalMs = 150
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        // A transient status error must not stop the pump; the scheduler owns
        // the bounded deadline that fails the case if arrival never happens.
        try { await this.application.jobStatus(undefined, this.jobId); } catch { /* keep driving */ }
        if (!this.running) break;
        await delay(this.intervalMs);
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}

async function pollMatrixTerminal(
  application: Pick<ObserverApplication, "jobStatus">,
  jobId: string,
  deadline: number
): Promise<Record<string, unknown>> {
  let status: Record<string, unknown> | null = null;
  const result = await pollUntil<Record<string, unknown>>({
    clock: systemClock,
    sleeper: systemSleeper,
    deadline: deadlineAt(deadline),
    intervalMs: 250,
    probe: async (): Promise<Record<string, unknown> | undefined> => {
      status = await application.jobStatus(undefined, jobId);
      if (typeof status.state !== "string") throw new Error(`Workbench matrix job ${jobId} returned no state`);
      return TERMINAL_STATES.has(status.state) ? status : undefined;
    },
  });
  if (result.kind === "expired") {
    throw new Error(`Workbench matrix job ${jobId} did not reach a terminal state before the case deadline`);
  }
  return result.value;
}

export interface WorkbenchFailureMatrixOptions {
  readonly confirmed: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly artifactRoot?: string;
  readonly validationRoot?: string;
  readonly timeoutMs?: number;
  /** The Workbench matrix currently supports exactly one selected case per run. */
  readonly only: string;
  readonly keepProfile?: boolean;
}

export interface WorkbenchFailureMatrixResult extends FailureMatrixPublication {
  readonly runDirectory: string | null;
}

/** The narrow application surface the per-case executor needs, for hermetic fakes. */
export type WorkbenchMatrixCaseApplication = Pick<
  ObserverApplication, "capture" | "cancelJob" | "jobStatus"
>;
export type WorkbenchMatrixCaseAdapter = Pick<WorkbenchObserverAdapter, "release">;
export type WorkbenchMatrixCaseScheduler = Pick<
  FaultMatrixScheduler, "arm" | "releaseBarrier" | "finishCase"
>;

export interface RunWorkbenchCancelBarrierCaseInput {
  readonly application: WorkbenchMatrixCaseApplication;
  readonly adapter: WorkbenchMatrixCaseAdapter;
  readonly scheduler: WorkbenchMatrixCaseScheduler;
  readonly matrixCase: FaultMatrixCase;
  readonly runId: string;
  readonly instanceId: string;
  readonly expectedWorldId: string;
  readonly poseView: ObserverCaptureView;
  readonly caseStartedAt: number;
  readonly caseDeadline: number;
  readonly caseBudgetMs: number;
}

/**
 * The declared vertical-slice interaction: submit an asynchronous pose capture,
 * prove the lease_acquired barrier from the fixture's own acknowledgement,
 * cancel through ObserverApplication.cancelJob, observe the cancelled/CANCELLED
 * terminal with exact restoration, run a mandatory follow-up current capture
 * proving no stale lease survived, and seal the control channel. Isolated from
 * live launch/teardown so it can run against fakes in a hermetic test.
 */
export async function runWorkbenchCancelBarrierCase(
  input: RunWorkbenchCancelBarrierCaseInput
): Promise<MatrixCaseEntry> {
  const {
    application, adapter, scheduler, matrixCase, runId, instanceId,
    expectedWorldId, poseView, caseStartedAt, caseDeadline, caseBudgetMs,
  } = input;
  const diagnostics: string[] = [];
  const captureTimeoutMs = Math.max(1_000, Math.min(60_000, caseDeadline - Date.now()));

  const submitted = await application.capture({
    runId,
    captureLabel: "matrix-slice-pose",
    purpose: `Fault-matrix slice ${matrixCase.id}`,
    instanceId,
    expectedWorldId,
    expectedWorldEpoch: 0,
    idempotencyKey: `${runId}-${matrixCase.id}`,
    view: poseView,
    settleFrames: 3,
    performancePolicy: "evidence",
    asynchronous: true,
    timeoutMs: captureTimeoutMs,
  });
  if (!submitted.asynchronous) {
    throw new Error("Workbench matrix pose capture unexpectedly returned a synchronous result");
  }
  const jobId = requiredString(submitted.job.jobId, "Workbench matrix slice job ID");

  // Prove the barrier arrival while driving the fixture inbox through status.
  const armPump = new WorkbenchStatusPump(application, jobId);
  armPump.start();
  let arrived;
  try {
    arrived = await scheduler.arm(matrixCase.id);
  } finally {
    await armPump.stop();
  }
  diagnostics.push(`barrier arrived: phase=${arrived.arrived.phase} disposition=${arrived.arrived.disposition}`);

  await application.cancelJob(undefined, jobId);

  const releasePump = new WorkbenchStatusPump(application, jobId);
  releasePump.start();
  let finalJob: Record<string, unknown>;
  try {
    const executed = await scheduler.releaseBarrier("cancel");
    diagnostics.push(`barrier released: disposition=${executed.disposition}`);
    finalJob = await pollMatrixTerminal(application, jobId, caseDeadline);
  } finally {
    await releasePump.stop();
  }
  const finalErrorCode = typeof finalJob.terminalErrorCode === "string" ? finalJob.terminalErrorCode : null;
  if (finalJob.state !== matrixCase.expectedTerminal.state || finalErrorCode !== matrixCase.expectedTerminal.errorCode) {
    throw new Error(
      `Workbench matrix job reached state=${String(finalJob.state)} errorCode=${String(finalErrorCode)}, ` +
      `expected state=${matrixCase.expectedTerminal.state} errorCode=${String(matrixCase.expectedTerminal.errorCode)}`
    );
  }
  if (finalJob.cameraLeaseHeld === true || finalJob.restorationConfirmed !== true) {
    throw new Error("Workbench matrix cancellation did not prove exact editor camera restoration");
  }
  // Release the cancelled job's handler lease so the follow-up current capture
  // can acquire a fresh lease and the terminal handshake has an active job.
  await adapter.release(jobId);

  // Mandatory follow-up: a fresh current capture must complete, proving no stale
  // lease or held camera survived the cancellation. Keep the job unreleased and
  // pumped so the terminal control handshake is driven, then release it.
  const followUp = await application.capture({
    runId,
    captureLabel: "matrix-slice-followup-current",
    purpose: "Prove no stale editor camera lease survives the cancelled Workbench slice",
    instanceId,
    expectedWorldId,
    expectedWorldEpoch: 0,
    idempotencyKey: `${runId}-${matrixCase.id}-followup`,
    view: { kind: "current" },
    settleFrames: 3,
    performancePolicy: "evidence",
    asynchronous: true,
    timeoutMs: captureTimeoutMs,
  });
  if (!followUp.asynchronous) throw new Error("Workbench matrix follow-up capture unexpectedly returned synchronously");
  const followUpJobId = requiredString(followUp.job.jobId, "Workbench matrix follow-up job ID");
  const followUpPump = new WorkbenchStatusPump(application, followUpJobId);
  followUpPump.start();
  let followUpJob: Record<string, unknown>;
  try {
    // Seal the control channel while the follow-up job keeps status() reaching
    // the handler, so the fixture reads the terminal command and acknowledges.
    await scheduler.finishCase();
    followUpJob = await pollMatrixTerminal(application, followUpJobId, caseDeadline);
  } finally {
    await followUpPump.stop();
  }
  if (followUpJob.state !== "completed" || followUpJob.cameraLeaseHeld === true || followUpJob.restorationConfirmed !== true) {
    throw new Error("Workbench matrix follow-up current capture did not complete with proven restoration after cancellation");
  }
  await adapter.release(followUpJobId);
  diagnostics.push("follow-up current capture completed after cancellation with no retained lease");

  const elapsedMs = Date.now() - caseStartedAt;
  return {
    caseId: matrixCase.id,
    schedule: {
      backend: "workbench",
      view: matrixCase.view,
      phase: matrixCase.injection.phase,
      action: matrixCase.injection.action,
    },
    result: "passed",
    publicTerminal: { state: finalJob.state as string, errorCode: finalErrorCode },
    deadline: { outcome: "completed", elapsedMs, budgetMs: caseBudgetMs },
    worldRevision: "unchanged",
    camera: "restored",
    artifact: "not_created",
    cleanup: { lifecycleVacant: false, endpointVacant: false, childVacant: false, exactOwnerVacant: false },
    retainedDiagnostics: diagnostics.map((tail) => matrixRetainedDiagnostic(tail)),
  };
}

const WORKBENCH_MATRIX_FIXTURE_SOURCES = [
  "tests/fixtures/workbench-observer-failure-matrix-addon/addon.gproj",
  "tests/fixtures/workbench-observer-failure-matrix-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverMatrixControl.c",
] as const;

/**
 * Workbench-only orchestration for the Phase 3 fault-matrix vertical slice:
 * disposable project + staged fixture, gated launch, control root under the
 * Workbench profile, barrier-driven cancellation, and the shared v2 evidence
 * artifact. CLI/live-run authorization is delegated here once a matrix case has
 * been selected by run-workbench-observer-acceptance.ts's argument parser.
 */
export async function runWorkbenchFailureMatrix(
  options: WorkbenchFailureMatrixOptions
): Promise<WorkbenchFailureMatrixResult> {
  assertLiveWorkbenchObserverAuthorized(options.confirmed, options.environment);
  const matrixCase = caseForId(OBSERVER_FAULT_MATRIX, options.only);
  if (matrixCase.backend !== "workbench") {
    throw new Error(`Fault-matrix case ${options.only} is not a Workbench case`);
  }
  if (matrixCase.injection.action !== "cancel_capture") {
    throw new Error(`Workbench matrix runner currently supports only the cancellation slice, not ${matrixCase.injection.action}`);
  }
  const timeoutMs = options.timeoutMs ?? 240_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 600_000) {
    throw new Error("Live Workbench matrix timeout must be 60000..600000 ms");
  }
  assertNoArmaOrWorkbench();
  const artifactRoot = canonicalDirectory(
    options.artifactRoot ?? (() => {
      const path = join(tmpdir(), "reforger-forge-workbench-observer-acceptance");
      mkdirSync(path, { recursive: true });
      return path;
    })(),
    "Workbench matrix evidence root"
  );
  assertEvidenceOutsideRepository(artifactRoot);
  const runDirectory = mkdtempSync(join(artifactRoot, "matrix-run-"));
  const projectRoot = join(runDirectory, "project");
  const managedRoot = join(runDirectory, "observer-managed");
  const evidenceRoot = join(runDirectory, "evidence");
  mkdirSync(projectRoot);
  mkdirSync(managedRoot);
  mkdirSync(evidenceRoot);
  const validationRoot = resolve(
    options.validationRoot ?? join(REPOSITORY_ROOT, "docs", "validation")
  );
  const project = createDisposableProject(projectRoot, { stageMatrixFixture: true });
  const fixtureTemplateIdentity = operationalBaselineDirectoryIdentity(
    WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR, [".c", ".gproj"]
  );
  const config = acceptanceConfig(projectRoot, managedRoot);
  const guard = new WorkbenchProcessGuard({
    stateDir: join(runDirectory, "lifecycle"),
    helperPath: join(REPOSITORY_ROOT, "scripts", "windows", "workbench-lifecycle.ps1"),
    lockTimeoutMs: 20_000,
  });
  let baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity([], false);
  const client = new WorkbenchClient(
    config.workbenchHost,
    config.workbenchPort,
    config,
    `live-workbench-matrix-${randomUUID()}`,
    guard,
    {
      launchTimeoutMs: 180_000,
      launchPollIntervalMs: 1_000,
      spawnProcess: (command, argumentsArray, spawnOptions) => {
        const actualArguments = [...argumentsArray, "-forceUpdate"];
        baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity(actualArguments);
        return spawn(command, actualArguments, spawnOptions);
      },
    }
  );
  const adapter = new WorkbenchObserverAdapter(client, { handlerTimeoutMs: 10_000 });
  const observerAgentPath = join(REPOSITORY_ROOT, "dist", "observer", "agent", "private-child.js");
  if (!existsSync(observerAgentPath)) {
    throw new Error(`Compiled observer agent is missing: ${observerAgentPath}`);
  }
  const application = createObserverApplication({
    agentPath: observerAgentPath,
    managedRoot,
    profileRoot: join(managedRoot, "profiles"),
    projectPath: projectRoot,
    sourceAddon: join(REPOSITORY_ROOT, "observer", "addon"),
    requestTimeoutMs: 60_000,
    defaultCaptureTimeoutMs: 5 * 60_000,
    maxInlineImageBytes: 64 * 1024 * 1024,
    evidenceRoots: [evidenceRoot],
    workbenchAdapter: adapter,
  });
  let cleanupClient = client;
  const readProcessCounts = () => {
    const primary = client.diagnosticSupervisedChildCounts();
    const recovery = cleanupClient === client
      ? { active: 0, reconciling: 0, total: 0 }
      : cleanupClient.diagnosticSupervisedChildCounts();
    const observerPrivateChildren = application.diagnosticPrivateChildCount();
    return {
      active: primary.active + recovery.active + observerPrivateChildren,
      reconciling: primary.reconciling + recovery.reconciling,
      total: primary.total + recovery.total + observerPrivateChildren,
    };
  };

  const caseStartedAt = Date.now();
  const caseDeadline = caseStartedAt + timeoutMs;
  let observerRunId: string | null = null;
  let faultScaffolding: FaultMatrixRunScaffolding | null = null;
  let caseEntry: MatrixCaseEntry | null = null;
  let failure: unknown = null;
  let controlCapability: string | null = null;

  try {
    assertNoArmaOrWorkbench();
    const begun = await application.beginRun({
      title: `Workbench observer failure-matrix slice: ${matrixCase.id}`,
      caseIds: [matrixCase.id],
      procedureRevision: "workbench-failure-matrix-v1",
      idempotencyKey: `workbench-matrix-${randomUUID()}`,
    });
    observerRunId = requiredString(begun.runId, "Managed observer run ID");

    await client.ensureRunning(project.projectPath);
    const workbenchLifecycle = await client.lifecycleIdentity();
    const companionStatus = client.managedCompanionStatus();
    // Workbench launches with -profile <roleRoot/profile>; the Enfusion
    // "$profile:" keyword resolves one directory deeper, so the fixture's
    // "$profile:RFOWorkbenchObserverMatrix" control root lives beneath
    // <roleRoot>/profile/profile. Create it defensively before staging.
    const fixtureProfileRoot = join(companionStatus.roleRoot, "profile", "profile");
    mkdirSync(fixtureProfileRoot, { recursive: true });
    const controlRoot = join(fixtureProfileRoot, "RFOWorkbenchObserverMatrix");

    const fixtureContentIdentity = operationalBaselineProcedureSha256({
      fixture: "workbench-observer-failure-matrix-addon",
      sourceSha256: fixtureTemplateIdentity.sha256,
    });
    const generatedProjectIdentity = operationalBaselineProcedureSha256({
      projectPath: project.projectPath,
      worldResource: project.worldResource,
    });
    const faultBinding = Object.freeze({
      fixtureId: generatedProjectIdentity,
      lifecycleId: workbenchLifecycle.lifecycleId,
      lifecycleGeneration: workbenchLifecycle.generation,
    });
    controlCapability = randomUUID();
    faultScaffolding = createFaultMatrixRunScaffolding({
      runRoot: fixtureProfileRoot,
      controlRoot,
      matrix: OBSERVER_FAULT_MATRIX,
      bootstrap: {
        schemaVersion: 1,
        runId: observerRunId,
        backend: "workbench",
        capability: controlCapability,
        fixtureContentIdentity,
        generatedProjectIdentity,
        generatedAddonIdentity: WORKBENCH_MATRIX_FIXTURE_GUID,
        binding: faultBinding,
      },
      clock: systemClock,
      sleeper: systemSleeper,
      readLifecycleBinding: () => faultBinding,
    });

    const open = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
      action: "openResource",
      path: project.worldResource,
    }, { skipAutoLaunch: true, timeout: 30_000 });
    if (open.status !== "ok" || !String(open.message ?? "").startsWith("Opened resource:")) {
      throw new Error(`Disposable matrix world did not open: ${String(open.message ?? "no response")}`);
    }
    const selected = await waitForCaptureCapability(application, caseDeadline);
    const instanceId = requiredString(selected.instanceId, "Selected Workbench observer instance ID");
    const expectedWorldId = requiredString(selected.worldId, "Selected Workbench observer world ID");

    // Derive a materially displaced pose from the current editor camera.
    const baseline = await captureAndRetainUnmeasured(
      application, { kind: "current" }, "matrix-slice-baseline", observerRunId,
      instanceId, expectedWorldId, caseDeadline
    );
    await adapter.release(requiredString(baseline.completed.jobId, "matrix baseline job ID"));
    const baselineCamera = baseline.completed.actualCamera;
    const baselineFov = baselineCamera.verticalFov;
    if (!Number.isFinite(baselineFov) || baselineFov < 1 || baselineFov > 179) {
      throw new Error(`Baseline editor FOV is outside pose bounds: ${baselineFov}`);
    }
    const poseView: ObserverCaptureView = {
      kind: "pose",
      position: [
        baselineCamera.position[0] + 75,
        baselineCamera.position[1] + 25,
        baselineCamera.position[2] + 50,
      ],
      orientation: quaternionFromWorkbenchMatrix(baselineCamera.matrix),
      fov: baselineFov <= 169 ? baselineFov + 10 : baselineFov - 10,
    };

    caseEntry = await runWorkbenchCancelBarrierCase({
      application,
      adapter,
      scheduler: faultScaffolding.scheduler,
      matrixCase,
      runId: observerRunId,
      instanceId,
      expectedWorldId,
      poseView,
      caseStartedAt,
      caseDeadline,
      caseBudgetMs: timeoutMs,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (faultScaffolding) {
      try {
        await faultScaffolding.scheduler.finishCase();
      } catch (error) {
        failure ??= error;
      }
      try {
        removeOwnedFaultControlRoot(faultScaffolding.controlRoot);
      } catch { /* best-effort; run directory retained/removed wholesale below */ }
    }
    try {
      await adapter.restoreAll();
    } catch (error) {
      failure ??= error;
    }
    try {
      await application.close();
    } catch (error) {
      failure ??= error;
    }
    let exactWorkbenchVacancy = false;
    try {
      const shutdown = await client.shutdownOwnedWorkbench();
      exactWorkbenchVacancy = shutdown.stopped;
      if (!shutdown.stopped) failure ??= new Error("Owned Workbench shutdown did not terminate the launched lifecycle child");
    } catch (error) {
      failure ??= error;
      try {
        cleanupClient = new WorkbenchClient(
          config.workbenchHost, config.workbenchPort, config,
          `live-workbench-matrix-recovery-${randomUUID()}`, guard
        );
        const recovery = await cleanupClient.shutdownOwnedWorkbench();
        exactWorkbenchVacancy = recovery.stopped;
      } catch { /* preserve the primary failure */ }
    }
    let endpointVacant = false;
    try {
      const remaining = await guard.listWorkbenchProcesses();
      endpointVacant = remaining.length === 0;
      if (!endpointVacant) failure ??= new Error("Exact-owner shutdown did not establish Workbench vacancy");
    } catch (error) {
      failure ??= error;
    }
    let supervisedVacant = false;
    try {
      const evidence = await waitForOperationalBaselineProcessVacancy(readProcessCounts);
      supervisedVacant = evidence.vacant;
      if (!evidence.vacant) {
        failure ??= new Error(`Supervised process vacancy was not observed (active=${evidence.counts.active})`);
      }
    } catch (error) {
      failure ??= error;
    }
    if (caseEntry) {
      caseEntry = {
        ...caseEntry,
        cleanup: {
          lifecycleVacant: exactWorkbenchVacancy,
          endpointVacant,
          childVacant: supervisedVacant,
          exactOwnerVacant: exactWorkbenchVacancy,
        },
      };
      if (!exactWorkbenchVacancy || !endpointVacant || !supervisedVacant) {
        caseEntry = { ...caseEntry, result: "failed" };
        failure ??= new Error("Workbench matrix slice cleanup did not prove full vacancy");
      }
    }
  }

  const baselineEnvironment = operationalBaselineEnvironment(
    workbenchEnvironmentExecutables(config)
  );
  const baselineSource = operationalBaselineSource(
    SCRIPT_PATH,
    "scripts/run-workbench-observer-acceptance.ts",
    REPOSITORY_ROOT,
    [...WORKBENCH_OPERATIONAL_BASELINE_SOURCES, ...WORKBENCH_MATRIX_FIXTURE_SOURCES],
    OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES
  );
  const overallResult: "passed" | "failed" = failure || !caseEntry || caseEntry.result !== "passed" ? "failed" : "passed";
  const finalCaseEntry: MatrixCaseEntry = caseEntry ?? {
    caseId: matrixCase.id,
    schedule: {
      backend: "workbench",
      view: matrixCase.view,
      phase: matrixCase.injection.phase,
      action: matrixCase.injection.action,
    },
    result: "failed",
    publicTerminal: { state: "failed", errorCode: null },
    deadline: { outcome: "expired", elapsedMs: Date.now() - caseStartedAt, budgetMs: timeoutMs },
    worldRevision: "unavailable",
    camera: "unproven",
    artifact: "unproven",
    cleanup: { lifecycleVacant: false, endpointVacant: false, childVacant: false, exactOwnerVacant: false },
    retainedDiagnostics: failure
      ? [matrixRetainedDiagnostic(failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure))]
      : [],
  };

  const artifact = buildObserverFailureMatrixArtifact({
    backend: "workbench",
    result: overallResult,
    startedAt: new Date(caseStartedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - caseStartedAt,
    environment: baselineEnvironment,
    workload: {
      procedureRevision: "workbench-failure-matrix-v1",
      runtimeKind: "workbench",
      overallTimeoutMs: timeoutMs,
      worldResource: BASE_EVERON_WORLD,
      fixture: {
        kind: "addon",
        id: "RFOWorkbenchObserverMatrix",
        guid: WORKBENCH_MATRIX_FIXTURE_GUID,
        sourceFileCount: fixtureTemplateIdentity.fileCount,
        sourceSha256: fixtureTemplateIdentity.sha256,
      },
      capture: {
        labels: ["matrix-slice-baseline", "matrix-slice-pose", "matrix-slice-followup-current"],
        settleFrames: 3,
        performancePolicy: "evidence",
        asynchronous: true,
        configurationSha256: fixtureTemplateIdentity.sha256,
      },
      launchArguments: baselineLaunchArguments,
    },
    source: baselineSource,
    matrix: OBSERVER_FAULT_MATRIX,
    cases: [finalCaseEntry],
    measurements: [],
    processCounts: [],
    limitations: [
      "Phase 3 vertical slice: exactly one declared Workbench case (cancellation at lease_acquired, explicit pose).",
      "The remaining canonical cancellation phases and fault families are deferred until this slice has a retained live result.",
      "The fixture control-channel authorizer is hardcoded to this one declared case rather than a general port of FaultControlAuthorizer.",
    ],
    failure: failure ? { name: failure instanceof Error ? failure.name : "WorkbenchFailureMatrixError" } : null,
    knownSecretValues: controlCapability ? [WORKBENCH_MATRIX_FIXTURE_GUID, controlCapability] : [WORKBENCH_MATRIX_FIXTURE_GUID],
  });

  const publication = writeObserverFailureMatrixArtifact(
    validationRoot,
    artifact,
    OBSERVER_FAULT_MATRIX,
    controlCapability ? [WORKBENCH_MATRIX_FIXTURE_GUID, controlCapability] : [WORKBENCH_MATRIX_FIXTURE_GUID]
  );

  const preserveRunDirectory = Boolean(failure) && Boolean(options.keepProfile);
  if (!preserveRunDirectory) {
    try { rmSync(runDirectory, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
  }
  if (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    error.message = `${error.message}. Workbench failure-matrix artifact: ${publication.jsonPath}` +
      (preserveRunDirectory ? ` (run directory retained: ${runDirectory})` : "");
    throw error;
  }
  return { ...publication, runDirectory: null };
}

function usage(): string {
  return `Usage: npm run dev:observer:acceptance:workbench -- --confirm-live-run [--artifact-root <directory>] [--validation-root <directory>] [--timeout-ms <60000..600000>] [--only <workbench-case-id> [--keep-profile]]\n\n` +
    `Required environment: ${LIVE_WORKBENCH_OBSERVER_ENVIRONMENT}=1\n`;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
  } else {
    try {
      const only = readOption("--only");
      const keepProfile = process.argv.includes("--keep-profile");
      if (keepProfile && !only) {
        throw new Error("--keep-profile is valid only together with --only");
      }
      if (only) {
        // A selected fault-matrix case dispatches to the Workbench matrix
        // runner. The positive-path acceptance never accepts --only.
        const result = await runWorkbenchFailureMatrix({
          confirmed: process.argv.includes("--confirm-live-run"),
          artifactRoot: readOption("--artifact-root"),
          validationRoot: readOption("--validation-root"),
          only,
          keepProfile,
          timeoutMs: readOption("--timeout-ms") ? Number(readOption("--timeout-ms")) : undefined,
        });
        process.stdout.write(
          `Workbench observer failure-matrix slice passed.\n` +
          `RFO_WORKBENCH_OBSERVER_FAILURE_MATRIX_JSON=${result.jsonPath}\n` +
          `RFO_WORKBENCH_OBSERVER_FAILURE_MATRIX_MARKDOWN=${result.markdownPath}\n`
        );
      } else {
        const result = await runWorkbenchObserverAcceptance({
          confirmed: process.argv.includes("--confirm-live-run"),
          artifactRoot: readOption("--artifact-root"),
          validationRoot: readOption("--validation-root"),
          timeoutMs: readOption("--timeout-ms") ? Number(readOption("--timeout-ms")) : undefined,
        });
        process.stdout.write(
          `Workbench observer acceptance passed.\n` +
          `RFO_WORKBENCH_OBSERVER_ACCEPTANCE_RESULT=${result.summaryPath}\n` +
          `RFO_WORKBENCH_OBSERVER_ACCEPTANCE_MANIFEST=${result.manifestPath}\n` +
          `RFO_WORKBENCH_OPERATIONAL_BASELINE=${result.baselinePath}\n`
        );
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
