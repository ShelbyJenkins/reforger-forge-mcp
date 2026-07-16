#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { generateGproj } from "../src/templates/gproj.js";
import { WorkbenchClient } from "../src/workbench/client.js";
import {
  WorkbenchObserverAdapter,
  workbenchCameraMatrix,
  type WorkbenchCameraMatrix,
  type WorkbenchObserverJobStatus,
  type WorkbenchObserverView,
} from "../src/workbench/observer-adapter.js";
import { WorkbenchProcessGuard } from "../src/workbench/process-guard.js";
import {
  analyzePngMaterial,
  inspectBlockingProcesses,
  type PngMaterialEvidence,
} from "./run-observer-ai-stress-acceptance.js";

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
  summary: Record<string, unknown>;
}

interface RetainedCapture {
  label: string;
  submitted: WorkbenchObserverJobStatus;
  completed: WorkbenchObserverJobStatus;
  imagePath: string;
  metadataPath: string;
  png: PngMaterialEvidence;
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

function acceptanceConfig(runDirectory: string): Config {
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
    projectPath: runDirectory,
    workbenchAddonDirs: [...configuredRoots, runDirectory],
    workbenchScriptAuthorizeAll: false,
    workbenchNoThrow: true,
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
  adapter: WorkbenchObserverAdapter,
  deadline: number
): Promise<void> {
  let lastError = "observer handler has not responded";
  while (Date.now() < deadline) {
    try {
      const instance = await adapter.ping();
      if (instance.capabilities.includes("render.capture")) return;
      lastError = instance.readinessMessage || "an editor world is not yet renderer-ready";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for Workbench observer capture capability: ${lastError}`);
}

async function pollTerminal(
  adapter: WorkbenchObserverAdapter,
  jobId: string,
  deadline: number
): Promise<WorkbenchObserverJobStatus> {
  let status: WorkbenchObserverJobStatus | null = null;
  do {
    if (Date.now() >= deadline) {
      const last = status ? `; last state=${status.state}, message=${status.message}` : "; no status response was retained";
      throw new Error(`Timed out waiting for Workbench observer job ${jobId}${last}`);
    }
    status = await adapter.status(jobId);
    if (!TERMINAL_STATES.has(status.state)) await delay(250);
  } while (!TERMINAL_STATES.has(status.state));
  if (status.state !== "completed" || status.cameraLeaseHeld || !status.restorationConfirmed) {
    throw new Error(
      `Workbench observer job ${jobId} ended ${status.state}; ` +
      `restored=${status.restorationConfirmed}, leaseHeld=${status.cameraLeaseHeld}, ` +
      `error=${status.terminalErrorCode ?? "none"}, message=${status.message}`
    );
  }
  return status;
}

async function captureAndRetain(
  adapter: WorkbenchObserverAdapter,
  view: WorkbenchObserverView,
  label: string,
  evidenceDirectory: string,
  deadline: number
): Promise<RetainedCapture> {
  const submitted = await adapter.submit({
    jobId: `${label}-${randomUUID().replace(/-/g, "")}`,
    view,
    settlePolls: 3,
  });
  const completed = await pollTerminal(adapter, submitted.jobId, deadline);
  const retained = adapter.readCompletedArtifact(submitted.jobId);
  const png = analyzePngMaterial(retained.image);
  if (!png.materiallyVaried) {
    throw new Error(`${label} screenshot is blank or lacks material color/luminance variation`);
  }
  if (completed.artifact?.width !== png.width || completed.artifact.height !== png.height) {
    throw new Error(`${label} PNG dimensions disagree with the independently validated source artifact`);
  }
  const imagePath = join(evidenceDirectory, `${label}.png`);
  const metadataPath = join(evidenceDirectory, `${label}.json`);
  writeFileSync(imagePath, retained.image, { flag: "wx", mode: 0o600 });
  writeFileSync(metadataPath, `${JSON.stringify({ submitted, completed, adapterMetadata: retained.metadata, png }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await adapter.release(submitted.jobId);
  return { label, submitted, completed, imagePath, metadataPath, png };
}

function writeSummary(path: string, summary: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
  const evidenceDirectory = join(runDirectory, "evidence");
  mkdirSync(evidenceDirectory);
  const summaryPath = join(evidenceDirectory, "summary.json");
  const project = createDisposableProject(runDirectory);
  const config = acceptanceConfig(runDirectory);
  const guard = new WorkbenchProcessGuard({
    stateDir: join(runDirectory, "lifecycle"),
    legacyStatePath: join(runDirectory, "legacy-owner.json"),
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
  };
  writeSummary(summaryPath, summary);
  let failure: unknown = null;
  try {
    assertNoArmaOrWorkbench();
    const launched = await client.ensureRunning(project.projectPath);
    summary.launch = launched;
    const open = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
      action: "openResource",
      path: project.worldResource,
    }, { skipAutoLaunch: true, timeout: 30_000 });
    if (open.status !== "ok" || !String(open.message ?? "").startsWith("Opened resource:")) {
      throw new Error(`Disposable acceptance world did not open: ${String(open.message ?? "no response")}`);
    }
    await waitForCaptureCapability(adapter, deadline);

    const initial = await captureAndRetain(
      adapter,
      { kind: "current" },
      "initial-current",
      evidenceDirectory,
      deadline
    );
    const inventory = await adapter.instances();
    const ping = await adapter.ping();
    if (inventory.length !== 1 || !ping.capabilities.includes("render.capture") ||
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
    const pose = await captureAndRetain(
      adapter,
      { kind: "pose", position: posePosition, orientation, fov: poseFov },
      "explicit-pose",
      evidenceDirectory,
      deadline
    );
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
    const post = await captureAndRetain(
      adapter,
      { kind: "current" },
      "post-restoration-current",
      evidenceDirectory,
      deadline
    );
    assertCameraMatrixClose(baseline.matrix, post.completed.actualCamera.matrix);
    if (Math.abs(baselineFov - post.completed.actualCamera.verticalFov) > 0.002 ||
        initial.completed.ownerCameraId !== post.completed.ownerCameraId ||
        initial.completed.worldIdentity !== post.completed.worldIdentity) {
      throw new Error("Post-pose current capture did not match baseline FOV, camera owner, and editor world identity");
    }
    summary.inventory = inventory;
    summary.ping = ping;
    summary.poseRequest = { position: posePosition, orientation, fov: poseFov };
    summary.captures = [initial, pose, post].map((capture) => ({
      label: capture.label,
      imagePath: capture.imagePath,
      metadataPath: capture.metadataPath,
      png: capture.png,
      submittedLeaseHeld: capture.submitted.cameraLeaseHeld,
      restorationConfirmed: capture.completed.restorationConfirmed,
    }));
    summary.status = "passed";
  } catch (error) {
    failure = error;
    summary.status = "failed";
    summary.failure = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  } finally {
    try {
      await adapter.restoreAll();
      summary.adapterRestoration = "complete";
    } catch (error) {
      failure ??= error;
      summary.adapterRestoration = error instanceof Error ? error.message : String(error);
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
      try {
        summary.handlerCleanup = await cleanupClient.cleanupHandlerScripts(project.modDirectory);
      } catch (error) {
        failure ??= error;
        summary.handlerCleanup = error instanceof Error ? error.message : String(error);
        summary.status = "failed";
      }
    }
    summary.finishedAt = new Date().toISOString();
    writeSummary(summaryPath, summary);
  }
  if (failure) {
    const error = failure instanceof Error ? failure : new Error(String(failure));
    error.message = `${error.message}. Retained Workbench observer evidence: ${summaryPath}`;
    throw error;
  }
  return { runDirectory, summaryPath, summary };
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
      process.stdout.write(`Workbench observer acceptance passed.\nRFO_WORKBENCH_OBSERVER_ACCEPTANCE_RESULT=${result.summaryPath}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
