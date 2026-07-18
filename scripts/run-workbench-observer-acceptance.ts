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
  ObserverCoordinator,
  type ObserverCaptureView,
} from "../src/observer/coordinator.js";
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
  analyzePngMaterial,
  comparePngImages,
  inspectBlockingProcesses,
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
const BASE_EVERON_WORLD = "{853E92315D1D9EFE}worlds/Eden/Eden.ent";
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export interface WorkbenchObserverAcceptanceOptions {
  confirmed: boolean;
  environment?: NodeJS.ProcessEnv;
  artifactRoot?: string;
  timeoutMs?: number;
}

export interface WorkbenchObserverAcceptanceResult {
  runDirectory: string;
  summaryPath: string;
  evidenceDirectory: string;
  manifestPath: string;
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
    workbenchNoThrow: true,
    observer: {
      ...local.observer!,
      managedRoot,
      profileRoot: join(managedRoot, "profiles"),
    },
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
  coordinator: ObserverCoordinator,
  deadline: number
): Promise<Record<string, unknown>> {
  let lastError = "observer handler has not responded";
  while (Date.now() < deadline) {
    try {
      const inventory = await coordinator.instances({ renderersOnly: true });
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
  coordinator: ObserverCoordinator,
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
    status = await coordinator.jobStatus(undefined, jobId);
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

async function captureAndRetain(
  coordinator: ObserverCoordinator,
  view: ObserverCaptureView,
  label: string,
  runId: string,
  instanceId: string,
  expectedWorldId: string,
  deadline: number
): Promise<RetainedCapture> {
  const capture = await coordinator.capture({
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
  const managedCompleted = await pollTerminal(coordinator, jobId, deadline);
  const completed = {
    ...managedCompleted,
    worldIdentity: requiredString(managedCompleted.worldId, `${label} managed world identity`),
  } as unknown as WorkbenchObserverJobStatus;
  if (completed.state !== "completed" || completed.cameraLeaseHeld || !completed.restorationConfirmed) {
    throw new Error(`${label} managed job state disagrees with the Workbench adapter's terminal restoration proof`);
  }
  const retained = await coordinator.readJob(undefined, jobId);
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
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
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
  const project = createDisposableProject(projectRoot);
  const config = acceptanceConfig(projectRoot, managedRoot);
  const guard = new WorkbenchProcessGuard({
    stateDir: join(runDirectory, "lifecycle"),
    helperPath: join(REPOSITORY_ROOT, "scripts", "windows", "workbench-lifecycle.ps1"),
    lockTimeoutMs: 20_000,
  });
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
      spawnProcess: (command, argumentsArray, spawnOptions) =>
        spawn(command, [...argumentsArray, "-forceUpdate"], spawnOptions),
    }
  );
  const adapter = new WorkbenchObserverAdapter(client, { handlerTimeoutMs: 10_000 });
  // This script is executed through tsx after `npm run build`; the source-file
  // default would otherwise resolve beneath src/ instead of the compiled agent.
  const observerAgentPath = join(REPOSITORY_ROOT, "dist", "observer", "agent", "private-child.js");
  if (!existsSync(observerAgentPath)) {
    throw new Error(`Compiled observer agent is missing: ${observerAgentPath}`);
  }
  const coordinator = new ObserverCoordinator({
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
  const deadline = Date.now() + timeoutMs;
  const summary: Record<string, unknown> = {
    version: 1,
    status: "running",
    startedAt: new Date().toISOString(),
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
  try {
    assertNoArmaOrWorkbench();
    const begun = await coordinator.beginRun({
      title: "Live Workbench observer screenshot acceptance",
      caseIds: ["WB-OBSERVER-LIVE-CAPTURE"],
      procedureRevision: "workbench-observer-live-acceptance-v3",
      idempotencyKey: `workbench-live-${randomUUID()}`,
    });
    observerRunId = requiredString(begun.runId, "Managed observer run ID");
    summary.observerRun = begun;
    const launched = await client.ensureRunning(project.projectPath);
    summary.launch = launched;
    const open = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
      action: "openResource",
      path: project.worldResource,
    }, { skipAutoLaunch: true, timeout: 30_000 });
    if (open.status !== "ok" || !String(open.message ?? "").startsWith("Opened resource:")) {
      throw new Error(`Disposable acceptance world did not open: ${String(open.message ?? "no response")}`);
    }
    const selected = await waitForCaptureCapability(coordinator, deadline);
    const instanceId = requiredString(selected.instanceId, "Selected Workbench observer instance ID");
    const expectedWorldId = requiredString(selected.worldId, "Selected Workbench observer world ID");

    const initial = await captureAndRetain(
      coordinator,
      { kind: "current" },
      "initial-current",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline
    );
    const inventory = await coordinator.instances({ renderersOnly: true });
    const workbenchInventory = inventory.instances.filter((instance) => instance.backend === "workbench");
    const ping = await adapter.ping();
    if (workbenchInventory.length !== 1 || workbenchInventory[0].instanceId !== instanceId ||
        workbenchInventory[0].worldId !== expectedWorldId ||
        !ping.capabilities.includes("render.capture") ||
        !ping.capabilities.includes("camera.editor") || !ping.restorationApiAvailable) {
      throw new Error("Workbench failed to advertise proven render.capture and camera.editor after current-view restoration");
    }
    const baseline = initial.completed.actualCamera;
    const baselineFov = baseline.verticalFov;
    if (!Number.isFinite(baselineFov) || baselineFov < 1 || baselineFov > 179) {
      throw new Error(`Baseline editor FOV is outside pose request bounds: ${baselineFov}`);
    }
    const orientation = quaternionFromWorkbenchMatrix(baseline.matrix);
    const posePosition: [number, number, number] = [
      baseline.position[0] + 75,
      baseline.position[1] + 25,
      baseline.position[2] + 50,
    ];
    const poseFov = baselineFov <= 169 ? baselineFov + 10 : baselineFov - 10;
    const poseView = {
      kind: "pose" as const,
      position: posePosition,
      orientation,
      fov: poseFov,
    };
    const pose = await captureAndRetain(
      coordinator,
      poseView,
      "explicit-pose",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline
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
      coordinator,
      { kind: "current" },
      "post-pose-restoration-current",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline
    );
    assertRestoredWorkbenchCurrent(initial, postPose, "Post-pose current capture");

    const right = baseline.matrix[0];
    const up = baseline.matrix[1];
    const forward = baseline.matrix[2];
    const lookAtPosition: [number, number, number] = [
      baseline.position[0] - right[0] * 90 + up[0] * 35 - forward[0] * 60,
      baseline.position[1] - right[1] * 90 + up[1] * 35 - forward[1] * 60,
      baseline.position[2] - right[2] * 90 + up[2] * 35 - forward[2] * 60,
    ];
    const lookAtTarget: [number, number, number] = [
      baseline.position[0] + forward[0] * 150,
      baseline.position[1] + forward[1] * 150,
      baseline.position[2] + forward[2] * 150,
    ];
    const lookAtFov = baselineFov <= 164 ? baselineFov + 15 : baselineFov - 15;
    const lookAtView = {
      kind: "lookAt" as const,
      position: lookAtPosition,
      target: lookAtTarget,
      fov: lookAtFov,
    };
    const lookAt = await captureAndRetain(
      coordinator,
      lookAtView,
      "explicit-look-at",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline
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
      coordinator,
      { kind: "current" },
      "post-look-at-restoration-current",
      observerRunId,
      instanceId,
      expectedWorldId,
      deadline
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
    summary.observerRunBeforeFinalize = await coordinator.runStatus(observerRunId);
    const finalized = await coordinator.finalizeRun({
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
        summary.observerRunFinalStatus = await coordinator.runStatus(observerRunId);
      } catch (error) {
        summary.observerRunFinalStatus = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      await adapter.restoreAll();
      summary.adapterRestoration = "complete";
    } catch (error) {
      failure ??= error;
      summary.adapterRestoration = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
    }
    try {
      await coordinator.close();
      summary.coordinatorShutdown = "complete";
    } catch (error) {
      failure ??= error;
      summary.coordinatorShutdown = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
    }
    try {
      summary.shutdown = await client.shutdownOwnedWorkbench();
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
        summary.shutdownRecovery = await cleanupClient.shutdownOwnedWorkbench();
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
    summary,
  };
}

function usage(): string {
  return `Usage: npm run observer:acceptance:workbench -- --confirm-live-run [--artifact-root <directory>] [--timeout-ms <60000..600000>]\n\n` +
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
        timeoutMs: readOption("--timeout-ms") ? Number(readOption("--timeout-ms")) : undefined,
      });
      process.stdout.write(
        `Workbench observer acceptance passed.\n` +
        `RFO_WORKBENCH_OBSERVER_ACCEPTANCE_RESULT=${result.summaryPath}\n` +
        `RFO_WORKBENCH_OBSERVER_ACCEPTANCE_MANIFEST=${result.manifestPath}\n`
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
