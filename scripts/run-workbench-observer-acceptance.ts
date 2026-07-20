#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
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
  comparePngImages,
  inspectBlockingProcesses,
  operationalBaselineEnvironment,
  operationalBaselineLaunchArgumentIdentity,
  operationalBaselineProcedureSha256,
  operationalBaselineSource,
  waitForOperationalBaselineProcessVacancy,
  writeOperationalBaselineArtifact,
  type PngComparisonEvidence,
  type PngMaterialEvidence,
} from "./observer-live-acceptance-support.js";

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
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export interface WorkbenchObserverAcceptanceOptions {
  confirmed: boolean;
  environment?: NodeJS.ProcessEnv;
  artifactRoot?: string;
  /** Defaults to the repository's docs/validation directory. */
  validationRoot?: string;
  timeoutMs?: number;
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

function createDisposableProject(runDirectory: string): {
  modDirectory: string;
  projectPath: string;
  worldResource: string;
} {
  const modDirectory = join(runDirectory, "ObserverAcceptance");
  const worldsDirectory = join(modDirectory, "Worlds");
  mkdirSync(worldsDirectory, { recursive: true });
  const projectPath = join(modDirectory, "ObserverAcceptance.gproj");
  writeFileSync(projectPath, generateGproj({
    name: "ObserverAcceptance",
    title: "ReforgerForge Workbench observer acceptance",
    guid: randomGuid(),
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
  while (Date.now() < deadline) {
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
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for Workbench observer capture capability: ${lastError}`);
}

async function pollTerminal(
  application: ObserverApplication,
  jobId: string,
  deadline: number
): Promise<Record<string, unknown>> {
  let status: Record<string, unknown> | null = null;
  do {
    if (Date.now() >= deadline) {
      const last = status
        ? `; last state=${String(status.state)}, message=${String(status.terminalMessage ?? "")}`
        : "; no status response was retained";
      throw new Error(`Timed out waiting for Workbench observer job ${jobId}${last}`);
    }
    status = await application.jobStatus(undefined, jobId);
    if (typeof status.state !== "string") {
      throw new Error(`Workbench observer job ${jobId} returned no state`);
    }
    if (!TERMINAL_STATES.has(status.state)) await delay(250);
  } while (typeof status.state !== "string" || !TERMINAL_STATES.has(status.state));
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

function usage(): string {
  return `Usage: npm run dev:observer:acceptance:workbench -- --confirm-live-run [--artifact-root <directory>] [--validation-root <directory>] [--timeout-ms <60000..600000>]\n\n` +
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
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
