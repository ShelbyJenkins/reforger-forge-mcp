#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
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
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { OBSERVER_TERMINAL_STATES } from "../observer/protocol/enforce-contract.js";
import {
  caseForId,
  OBSERVER_FAULT_MATRIX,
  type WorkbenchFaultMatrixCase,
} from "../observer/protocol/fault-matrix.js";
import {
  deadlineAt,
  pollUntil,
  systemClock,
  systemSleeper,
} from "../src/foundation/time.js";
import {
  imageOutputDescriptor,
  inspectImage,
  transformImageSync,
  type CanonicalImageOutputPolicy,
  type ImageOutputRequest,
} from "../src/foundation/image-output.js";
import {
  type ObserverApplication,
  type ObserverCaptureView,
} from "../src/observer/application.js";
import type { CaptureInput } from "../src/observer/capture-contract.js";
import { assertWorldRevision } from "../src/observer/world-revision.js";
import {
  WorkbenchObserverAdapter,
  workbenchCameraMatrix,
  type WorkbenchCameraMatrix,
  type WorkbenchObserverJobStatus,
} from "../src/workbench/observer-adapter.js";
import {
  OperationalBaselineRecorder,
  analyzePngMaterial,
  buildObserverFailureMatrixArtifact,
  comparePngImages,
  inspectBlockingProcesses,
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
  type OperationalBaselineEnvironment,
  type OperationalBaselineMeasurement,
  type OperationalBaselineProcessSample,
  type OperationalBaselineWorkload,
  type PngComparisonEvidence,
  type PngMaterialEvidence,
} from "./observer-live-acceptance-support.js";
import {
  createFaultMatrixRunScaffolding,
  removeOwnedFaultControlRoot,
  resolveFaultMatrixCases,
} from "./observer-fault-matrix-support.js";
import {
  remainingWorkbenchMatrixCaptureTimeout,
  remainingWorkbenchMatrixStepTimeout,
} from "./workbench-observer-matrix-case.js";
import {
  BASE_EVERON_WORLD,
  WORKBENCH_MATRIX_FIXTURE_GUID,
  WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR,
  WorkbenchObserverAcceptanceRuntime,
  acceptanceConfig,
  loadAcceptanceBaseConfig,
  workbenchEnvironmentExecutables,
  workbenchResourceVirtualPath,
} from "./workbench-observer-acceptance-runtime.js";
import {
  WORKBENCH_MATRIX_FIXTURE_SOURCES,
  captureStableWorkbenchMatrixSource,
  failedWorkbenchMatrixEntry,
  runLiveWorkbenchMatrixCase as executeLiveWorkbenchMatrixCase,
  workbenchMatrixSourceRevision,
  type WorkbenchLiveRetainedCapture,
  type WorkbenchLiveMatrixCaseOutcome,
  type WorkbenchLiveMatrixCaseServices,
} from "./workbench-observer-live-matrix-case.js";

export {
  remainingWorkbenchMatrixCaptureTimeout,
  remainingWorkbenchMatrixStepTimeout,
  runWorkbenchCancelBarrierCase,
  runWorkbenchMatrixCase,
  type RunWorkbenchCancelBarrierCaseInput,
  type RunWorkbenchMatrixCaseInput,
  type WorkbenchMatrixCaseActions,
  type WorkbenchMatrixCaseAdapter,
  type WorkbenchMatrixCaseApplication,
  type WorkbenchMatrixCaseScheduler,
  type WorkbenchMatrixShutdownEvidence,
  type WorkbenchMatrixValidatedCapture,
} from "./workbench-observer-matrix-case.js";

export {
  createDisposableProject,
  workbenchResourceVirtualPath,
} from "./workbench-observer-acceptance-runtime.js";

export {
  captureStableWorkbenchMatrixSource,
  launchWorkbenchMatrixDecoy,
  requireWorkbenchReplacementWorldId,
  workbenchFailureDeadlineEvidence,
  type WorkbenchLiveDecoy,
} from "./workbench-observer-live-matrix-case.js";

export const LIVE_WORKBENCH_OBSERVER_ENVIRONMENT =
  "RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE";
export const LIVE_WORKBENCH_OBSERVER_TEST_CONFIRMATION =
  "RFO_CONFIRM_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
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
  "scripts/observer-workbench-failure-support.ts",
  "scripts/workbench-observer-acceptance-adapter.ts",
  "scripts/workbench-observer-acceptance-runtime.ts",
  "scripts/workbench-observer-live-matrix-case.ts",
  "scripts/workbench-observer-matrix-case.ts",
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
  "src/workbench/compile-diagnostics.ts",
  "src/workbench/diagnostics.ts",
  "src/workbench/helper-addon.ts",
  "src/workbench/launch-plan.ts",
  "src/workbench/lifecycle-execution.ts",
  "src/workbench/managed-build-profile.ts",
  "src/workbench/net-api-client.ts",
  "src/workbench/observer-adapter.ts",
  "src/workbench/observer-artifact-envelope.ts",
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
const WORKBENCH_CAPTURE_LABELS = [
  "initial-current",
  "explicit-pose",
  "post-pose-restoration-current",
  "explicit-look-at",
  "post-look-at-restoration-current",
  "post-cancel-restoration-current",
] as const;
const TERMINAL_STATES = new Set<string>(OBSERVER_TERMINAL_STATES);
const LIVE_IMAGE_LIMITS = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxRetainedBytes: 64 * 1024 * 1024,
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixels: 32_000_000,
});
// Keep this below Workbench's smallest supported World Editor viewport so the
// live case proves producer-side scaling regardless of desktop layout.
const LIVE_IMAGE_BOUNDS = Object.freeze({ maxWidth: 192, maxHeight: 192 });

export interface WorkbenchObserverAcceptanceOptions {
  confirmed: boolean;
  configPath: string;
  environment?: NodeJS.ProcessEnv;
  artifactRoot?: string;
  /** Defaults beneath the external acceptance artifact root. */
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

interface RetainedCapture extends WorkbenchLiveRetainedCapture {
  readonly output: NonNullable<WorkbenchLiveRetainedCapture["output"]>;
  readonly comparisonImage: Buffer;
  readonly request: CaptureInput;
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

function assertNoArmaOrWorkbench(deadlineAtMs?: number): void {
  const timeoutMs = deadlineAtMs === undefined
    ? 15_000
    : remainingWorkbenchMatrixStepTimeout(deadlineAtMs, 15_000, "process preflight");
  const blockers = inspectBlockingProcesses(timeoutMs);
  if (blockers.length > 0) {
    throw new Error(
      "Live acceptance refuses to start while any Arma Reforger or Workbench process exists: " +
      blockers.map((entry) => `${entry.processName} (${entry.id})`).join(", ")
    );
  }
}

export function workbenchCaptureCapabilityProbeWaitMs(
  deadline: number,
  now = Date.now()
): number | null {
  // A normal Workbench Net API inventory can take several seconds. Leave the
  // outer poll responsive without imposing a timeout shorter than the
  // handler's own 10-second budget.
  if (deadline - now < 1_000) return null;
  return Math.min(15_000, remainingWorkbenchMatrixCaptureTimeout(deadline, now));
}

export async function waitForCaptureCapability(
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
      const waitMs = workbenchCaptureCapabilityProbeWaitMs(deadline);
      // Preserve the last actionable inventory warning when the outer
      // deadline has too little room for one more meaningful backend probe.
      if (waitMs === null) return undefined;
      try {
        const inventory = await application.instances({
          renderersOnly: true,
          // Bound the backend probe itself; pollUntil cannot pre-empt an
          // outstanding probe when the outer deadline expires.
          waitMs,
        });
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

async function pollTerminalState(
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
  return result.value;
}

async function pollTerminal(
  application: ObserverApplication,
  jobId: string,
  deadline: number
): Promise<Record<string, unknown>> {
  const status = await pollTerminalState(application, jobId, deadline);
  if (status.state !== "completed" || status.cameraLeaseHeld || !status.restorationConfirmed) {
    throw new Error(
      `Workbench observer job ${jobId} ended ${status.state}; ` +
      `restored=${status.restorationConfirmed}, leaseHeld=${status.cameraLeaseHeld}, ` +
      `error=${status.terminalErrorCode ?? "none"}, message=${status.terminalMessage ?? ""}`
    );
  }
  return status;
}

function canonicalAcceptanceImage(
  image: ImageOutputRequest | undefined,
  defaultLossyQuality: number,
): CanonicalImageOutputPolicy {
  const format = image?.format ?? "png";
  return {
    format,
    ...(image?.maxWidth === undefined ? {} : { maxWidth: image.maxWidth }),
    ...(image?.maxHeight === undefined ? {} : { maxHeight: image.maxHeight }),
    ...(format === "png" ? {} : { quality: image?.quality ?? defaultLossyQuality }),
  };
}

function analyzeCapturedImage(
  image: Buffer,
  policy: CanonicalImageOutputPolicy,
): {
  output: NonNullable<WorkbenchLiveRetainedCapture["output"]>;
  png: PngMaterialEvidence;
  comparisonImage: Buffer;
} {
  const descriptor = inspectImage(image, policy.format, LIVE_IMAGE_LIMITS);
  const comparisonImage = policy.format === "png"
    ? Buffer.from(image)
    : transformImageSync(image, descriptor, { format: "png" }, LIVE_IMAGE_LIMITS).image;
  const png = analyzePngMaterial(comparisonImage);
  const outputDescriptor = imageOutputDescriptor(policy.format);
  return {
    output: {
      format: policy.format,
      mimeType: outputDescriptor.mimeType,
      extension: outputDescriptor.extension,
      width: descriptor.width,
      height: descriptor.height,
      byteCount: descriptor.bytes,
      sha256: descriptor.sha256,
      quality: policy.quality ?? null,
    },
    png,
    comparisonImage,
  };
}

async function captureAndRetainUnmeasured(
  application: ObserverApplication,
  view: ObserverCaptureView,
  label: string,
  runId: string,
  instanceId: string,
  expectedWorldRevision: string,
  deadline: number,
  image?: ImageOutputRequest,
  defaultLossyQuality = 75,
): Promise<RetainedCapture> {
  const expectedImage = canonicalAcceptanceImage(image, defaultLossyQuality);
  const request: CaptureInput = {
    runId,
    captureLabel: label,
    purpose: `Live Workbench acceptance capture: ${label}`,
    instanceId,
    expectedWorldRevision: assertWorldRevision(expectedWorldRevision),
    idempotencyKey: `${runId}:${label}`,
    view,
    settleFrames: 3,
    performancePolicy: "evidence",
    ...(image === undefined ? {} : { image }),
    asynchronous: true,
    timeoutMs: Math.max(1_000, Math.min(5 * 60_000, deadline - Date.now())),
  };
  const capture = await application.capture(request);
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
  const { output, png, comparisonImage } = analyzeCapturedImage(retained.image, expectedImage);
  if (!png.materiallyVaried) {
    throw new Error(`${label} screenshot is blank or lacks material color/luminance variation`);
  }
  if (completed.artifact?.width !== output.width || completed.artifact.height !== output.height ||
      completed.artifact.format !== output.format || completed.artifact.mimeType !== output.mimeType) {
    throw new Error(`${label} completed dimensions or format disagree with the independently validated artifact`);
  }
  if (retained.metadata.contentSha256 !== output.sha256 || retained.metadata.bytes !== output.byteCount ||
      retained.metadata.width !== output.width || retained.metadata.height !== output.height ||
      retained.metadata.format !== output.format || retained.metadata.mimeType !== output.mimeType ||
      retained.metadata.imageQuality !== output.quality ||
      !isDeepStrictEqual(retained.metadata.requestedImage, expectedImage)) {
    throw new Error(`${label} managed artifact metadata disagrees with the independently validated image contract`);
  }
  const artifact = record(managedCompleted.artifact, `${label} managed job artifact metadata`);
  if (artifact.bytes !== output.byteCount || artifact.contentSha256 !== output.sha256 ||
      artifact.width !== output.width || artifact.height !== output.height ||
      artifact.format !== output.format || artifact.mimeType !== output.mimeType ||
      artifact.imageQuality !== output.quality || !isDeepStrictEqual(artifact.requestedImage, expectedImage)) {
    throw new Error(`${label} managed job artifact metadata disagrees with the independently validated image`);
  }
  return { label, submitted, completed, image: retained.image, png, output, comparisonImage, request };
}

async function captureAndRetain(
  application: ObserverApplication,
  view: ObserverCaptureView,
  label: string,
  runId: string,
  instanceId: string,
  expectedWorldRevision: string,
  deadline: number,
  baseline: OperationalBaselineRecorder,
  image?: ImageOutputRequest,
  defaultLossyQuality = 75,
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
      expectedWorldRevision,
      deadline,
      image,
      defaultLossyQuality,
    ),
    label
  );
}

function assertProducerBoundedPng(capture: RetainedCapture): Record<string, unknown> {
  const artifact = capture.completed.artifact;
  if (!artifact) throw new Error("Bounded PNG capture omitted Workbench artifact dimensions");
  const { viewportWidth, viewportHeight } = artifact;
  if (!Number.isSafeInteger(viewportWidth) || viewportWidth < 1 ||
      !Number.isSafeInteger(viewportHeight) || viewportHeight < 1) {
    throw new Error("Bounded PNG capture omitted a valid source viewport");
  }
  const scale = Math.min(
    1,
    LIVE_IMAGE_BOUNDS.maxWidth / viewportWidth,
    LIVE_IMAGE_BOUNDS.maxHeight / viewportHeight,
  );
  const expectedWidth = Math.max(1, Math.floor(viewportWidth * scale));
  const expectedHeight = Math.max(1, Math.floor(viewportHeight * scale));
  if (scale >= 1) {
    throw new Error(
      `Workbench source viewport ${viewportWidth}x${viewportHeight} was not larger than the acceptance bound`,
    );
  }
  if (artifact.sourceWidth !== expectedWidth || artifact.sourceHeight !== expectedHeight ||
      capture.output.width !== expectedWidth || capture.output.height !== expectedHeight ||
      capture.output.format !== "png" || capture.output.mimeType !== "image/png") {
    throw new Error("Workbench did not persist the expected fit-inside PNG before host retention");
  }
  return {
    viewportWidth,
    viewportHeight,
    requestedMaxWidth: LIVE_IMAGE_BOUNDS.maxWidth,
    requestedMaxHeight: LIVE_IMAGE_BOUNDS.maxHeight,
    producerWidth: artifact.sourceWidth,
    producerHeight: artifact.sourceHeight,
    retainedWidth: capture.output.width,
    retainedHeight: capture.output.height,
    producerResized: true,
  };
}

async function verifyCaptureReplay(
  application: ObserverApplication,
  capture: RetainedCapture,
): Promise<Record<string, unknown>> {
  const replay = await application.capture(capture.request);
  if (!replay.asynchronous || replay.job.jobId !== capture.completed.jobId ||
      replay.job.state !== "completed" || replay.job.cameraLeaseHeld === true ||
      replay.job.restorationConfirmed !== true) {
    throw new Error("Exact observer capture replay did not return the existing restored completed job");
  }
  return {
    jobId: replay.job.jobId,
    state: replay.job.state,
    reused: true,
    restorationConfirmed: replay.job.restorationConfirmed,
  };
}

async function cancelAndVerifyCapture(
  application: ObserverApplication,
  view: ObserverCaptureView,
  instanceId: string,
  expectedWorldRevision: string,
  deadline: number,
): Promise<Record<string, unknown>> {
  const request: CaptureInput = {
    instanceId,
    expectedWorldRevision: assertWorldRevision(expectedWorldRevision),
    idempotencyKey: `workbench-live-cancel-${randomUUID()}`,
    view,
    settleFrames: 120,
    performancePolicy: "evidence",
    image: { format: "webp", ...LIVE_IMAGE_BOUNDS },
    asynchronous: true,
    timeoutMs: Math.max(1_000, Math.min(5 * 60_000, deadline - Date.now())),
  };
  const submitted = await application.capture(request);
  if (!submitted.asynchronous || typeof submitted.job.jobId !== "string" ||
      submitted.job.cameraLeaseHeld !== true) {
    throw new Error("Cancellation acceptance did not acquire a Workbench camera lease");
  }
  const jobId = submitted.job.jobId;
  let terminal = await application.cancelJob(undefined, jobId);
  if (typeof terminal.state !== "string" || !TERMINAL_STATES.has(terminal.state)) {
    terminal = await pollTerminalState(application, jobId, deadline);
  }
  if (terminal.state !== "cancelled" || terminal.cameraLeaseHeld === true ||
      terminal.restorationConfirmed !== true) {
    throw new Error(
      `Cancellation acceptance ended ${String(terminal.state)} without exact camera restoration`,
    );
  }
  const release = await application.releaseJob(undefined, jobId);
  return {
    jobId,
    submittedLeaseHeld: true,
    terminalState: terminal.state,
    restorationConfirmed: terminal.restorationConfirmed,
    release,
  };
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

function retainedOutput(
  capture: WorkbenchLiveRetainedCapture,
): NonNullable<WorkbenchLiveRetainedCapture["output"]> {
  return capture.output ?? {
    format: "png",
    mimeType: "image/png",
    extension: ".png",
    width: capture.png.width,
    height: capture.png.height,
    byteCount: capture.png.byteCount,
    sha256: capture.png.sha256,
    quality: null,
  };
}

function validateFinalizedBundle(
  finalized: Record<string, unknown>,
  evidenceRoot: string,
  runId: string,
  captures: WorkbenchLiveRetainedCapture[]
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
      `captures/${capture.label}${retainedOutput(capture).extension}`,
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
    const expectedOutput = retainedOutput(capture);
    if (imagePath !== `captures/${capture.label}${expectedOutput.extension}` ||
        metadataPath !== `captures/${capture.label}.json`) {
      throw new Error(`Finalized evidence used non-standard paths for capture ${capture.label}`);
    }
    const image = readFileSync(join(evidenceDirectory, ...imagePath.split("/")));
    const analyzed = analyzeCapturedImage(image, {
      format: expectedOutput.format,
      ...(expectedOutput.quality === null ? {} : { quality: expectedOutput.quality }),
    });
    if (analyzed.output.sha256 !== expectedOutput.sha256 ||
        analyzed.output.byteCount !== expectedOutput.byteCount ||
        analyzed.output.width !== expectedOutput.width || analyzed.output.height !== expectedOutput.height ||
        item.sha256 !== expectedOutput.sha256 || item.bytes !== expectedOutput.byteCount ||
        item.width !== expectedOutput.width || item.height !== expectedOutput.height ||
        item.format !== expectedOutput.format || item.mimeType !== expectedOutput.mimeType) {
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
  loadAcceptanceBaseConfig(options.configPath);
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
  const summaryPath = join(runDirectory, "summary.json");
  const validationRoot = resolve(options.validationRoot ?? join(artifactRoot, "validation"));
  let runtime: WorkbenchObserverAcceptanceRuntime<WorkbenchObserverAdapter>;
  try {
    runtime = new WorkbenchObserverAcceptanceRuntime({
      configPath: options.configPath,
      runDirectory,
      clientIdPrefix: "live-workbench-observer",
      launchTimeoutMs: Math.min(180_000, timeoutMs),
      createAdapter: (client) => new WorkbenchObserverAdapter(client, {
        handlerTimeoutMs: 10_000,
      }),
    });
  } catch (error) {
    try {
      rmSync(runDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Workbench observer composition failed and its unlaunched scratch directory could not be removed"
      );
    }
    throw error;
  }
  const {
    application,
    adapter,
    baseline,
    client,
    config,
    evidenceRoot,
    guard,
    project,
  } = runtime;
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
      procedureRevision: "workbench-observer-live-acceptance-v4",
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
        path: workbenchResourceVirtualPath(project.worldResource),
      }, { skipAutoLaunch: true, timeout: 30_000 }),
      "representative_net_api"
    );
    if (open.status !== "ok" || !String(open.message ?? "").startsWith("Opened resource:")) {
      throw new Error(`Disposable acceptance world did not open: ${String(open.message ?? "no response")}`);
    }
    const selected = await waitForCaptureCapability(application, deadline);
    const instanceId = requiredString(selected.instanceId, "Selected Workbench observer instance ID");
    const expectedWorldRevision = requiredString(selected.worldRevision, "Selected Workbench observer world revision");
    const expectedWorldId = requiredString(selected.worldId, "Selected Workbench observer world ID");
    const defaultLossyQuality = config.observer?.defaultLossyImageQuality ?? 75;

    const initial = await captureAndRetain(
      application,
      { kind: "current" },
      "initial-current",
      observerRunId,
      instanceId,
      expectedWorldRevision,
      deadline,
      baseline,
      { format: "png", ...LIVE_IMAGE_BOUNDS },
      defaultLossyQuality,
    );
    const boundedPng = assertProducerBoundedPng(initial);
    const replay = await verifyCaptureReplay(application, initial);
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
      expectedWorldRevision,
      deadline,
      baseline,
      { format: "jpeg", quality: 61, ...LIVE_IMAGE_BOUNDS },
      defaultLossyQuality,
    );
    const poseDifference: PngComparisonEvidence = comparePngImages(
      initial.comparisonImage,
      pose.comparisonImage,
    );
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
      expectedWorldRevision,
      deadline,
      baseline,
      { format: "webp", ...LIVE_IMAGE_BOUNDS },
      defaultLossyQuality,
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
      expectedWorldRevision,
      deadline,
      baseline,
      { format: "png", ...LIVE_IMAGE_BOUNDS },
      defaultLossyQuality,
    );
    const lookAtDifference: PngComparisonEvidence = comparePngImages(
      initial.comparisonImage,
      lookAt.comparisonImage,
    );
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
      expectedWorldRevision,
      deadline,
      baseline,
      { format: "jpeg", quality: 68, ...LIVE_IMAGE_BOUNDS },
      defaultLossyQuality,
    );
    assertRestoredWorkbenchCurrent(initial, postLookAt, "Post-look-at current capture");
    const cancellation = await cancelAndVerifyCapture(
      application,
      poseView,
      instanceId,
      expectedWorldRevision,
      deadline,
    );
    const postCancel = await captureAndRetain(
      application,
      { kind: "current" },
      "post-cancel-restoration-current",
      observerRunId,
      instanceId,
      expectedWorldRevision,
      deadline,
      baseline,
      { format: "png", ...LIVE_IMAGE_BOUNDS },
      defaultLossyQuality,
    );
    assertRestoredWorkbenchCurrent(initial, postCancel, "Post-cancellation current capture");
    summary.inventory = inventory;
    summary.ping = ping;
    summary.boundedPng = boundedPng;
    summary.replay = replay;
    summary.cancellation = cancellation;
    summary.poseRequest = poseView;
    summary.poseScreenshotDifference = poseDifference;
    summary.lookAtRequest = lookAtView;
    summary.lookAtScreenshotDifference = lookAtDifference;
    const captures = [initial, pose, postPose, lookAt, postLookAt, postCancel];
    summary.captures = captures.map((capture) => ({
      label: capture.label,
      managedJobId: capture.completed.jobId,
      output: capture.output,
      material: capture.png,
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
        summary: "Automation validated bounded PNG production, JPEG/WebP conversion and MIME binding, material variation, replay, cancellation, explicit pose/look-at execution, and exact camera restoration. The image contents still require human review.",
        limitations: [
          "This automated acceptance does not make a gameplay or editorial-content claim from the screenshots.",
        ],
      },
      runtimeConfig: {
        configurationId: "workbench-observer-live-acceptance-v4",
        values: {
          backend: "workbench",
          worldResource: project.worldResource,
          captureSequence: captures.map((capture) => capture.label).join(","),
          settleFrames: 3,
          expectedWorldRevision,
          imageBounds: LIVE_IMAGE_BOUNDS,
          defaultLossyQuality,
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
        const cleanupClient = runtime.createRecoveryClient(
          "live-workbench-observer-recovery"
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
            runtime.readProcessCounts
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
      await runtime.close();
    } catch (error) {
      failure ??= error;
      summary.status = "failed";
      summary.lifecycleGuardClose = error instanceof Error ? error.message : String(error);
    }
    try {
      const baselineFailed = Boolean(failure) || summary.status !== "passed";
      const artifact = baseline.artifact({
        result: baselineFailed ? "failed" : "passed",
        environment: baselineEnvironment,
        workload: {
          procedureRevision: "workbench-observer-live-acceptance-v4",
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
              restorations: ["post-pose-current", "post-look-at-current", "post-cancel-current"],
              image: {
                bounds: LIVE_IMAGE_BOUNDS,
                formats: ["png", "jpeg", "webp"],
                explicitQualities: { jpeg: [61, 68] },
                defaultQualityFormat: "webp",
              },
              replay: "exact-completed-request",
              cancellation: { view: "pose", settleFrames: 120 },
              lookAt: {
                positionInInitialBasis: { right: -90, up: 35, forward: -60 },
                targetInInitialBasis: { forward: 150 },
                fovDeltaWithinBounds: 15,
              },
            }),
          },
          launchArguments: runtime.launchArguments,
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

export interface WorkbenchFailureMatrixOptions {
  readonly confirmed: boolean;
  readonly configPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly artifactRoot?: string;
  readonly validationRoot?: string;
  /** Per-case budget. A full run has 69 independent budgets. */
  readonly timeoutMs?: number;
  /** Omitted for full canonical Workbench coverage. */
  readonly only?: string;
  /** Valid only with --only; retained only when that selected case fails. */
  readonly keepProfile?: boolean;
}

export interface WorkbenchFailureMatrixResult extends FailureMatrixPublication {
  /** External image-review bundle directory for successful completed rows. */
  readonly runDirectory: string | null;
}

export function workbenchCaseRequiresRecovery(
  entry: Pick<MatrixCaseEntry, "cleanup" | "decoy">,
  retainForDecoyRecovery = false
): boolean {
  return retainForDecoyRecovery ||
    !entry.cleanup.lifecycleVacant ||
    !entry.cleanup.endpointVacant ||
    !entry.cleanup.childVacant ||
    !entry.cleanup.exactOwnerVacant ||
    entry.decoy?.category === "unproven";
}

export function removeWorkbenchCaseDirectoryIfSafe(input: {
  readonly caseDirectory: string;
  readonly entry: Pick<MatrixCaseEntry, "cleanup" | "decoy">;
  readonly retainForDecoyRecovery?: boolean;
  readonly retainExplicitly?: boolean;
  readonly remove?: (path: string) => void;
  readonly onRemovalError?: (error: unknown) => void;
}): boolean {
  if (input.retainExplicitly || workbenchCaseRequiresRecovery(
    input.entry,
    input.retainForDecoyRecovery
  )) return false;
  try {
    (input.remove ?? ((path) => rmSync(path, { recursive: true, force: true })))(
      input.caseDirectory
    );
    return true;
  } catch (error) {
    input.onRemovalError?.(error);
    return false;
  }
}

const WORKBENCH_LIVE_MATRIX_CASE_SERVICES: WorkbenchLiveMatrixCaseServices = {
  assertNoArmaOrWorkbench,
  waitForCaptureCapability,
  captureAndRetainUnmeasured,
  validateFinalizedBundle,
  quaternionFromWorkbenchMatrix,
  readSource: () => operationalBaselineSource(
    SCRIPT_PATH,
    "scripts/run-workbench-observer-acceptance.ts",
    REPOSITORY_ROOT,
    [...WORKBENCH_OPERATIONAL_BASELINE_SOURCES, ...WORKBENCH_MATRIX_FIXTURE_SOURCES],
    OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES
  ),
};

async function runLiveWorkbenchMatrixCase(input: {
  readonly configPath: string;
  readonly matrixCase: WorkbenchFaultMatrixCase;
  readonly caseDirectory: string;
  readonly timeoutMs: number;
  readonly caseStartedAt: number;
}): Promise<WorkbenchLiveMatrixCaseOutcome> {
  return executeLiveWorkbenchMatrixCase(input, WORKBENCH_LIVE_MATRIX_CASE_SERVICES);
}

/**
 * Run either all 69 Workbench declarations in canonical order or one selected
 * diagnostic row. Every row receives a new project, profile, lifecycle guard,
 * control capability, adapter and observer application. Publication happens
 * exactly once, after every selected row has completed cleanup.
 */
export async function runWorkbenchFailureMatrix(
  options: WorkbenchFailureMatrixOptions
): Promise<WorkbenchFailureMatrixResult> {
  if (options.keepProfile && !options.only) {
    throw new Error("--keep-profile is valid only with a single --only matrix case");
  }
  assertLiveWorkbenchObserverAuthorized(options.confirmed, options.environment);
  let selectedCases: readonly WorkbenchFaultMatrixCase[];
  if (options.only) {
    const selected = caseForId(OBSERVER_FAULT_MATRIX, options.only);
    if (selected.backend !== "workbench") {
      throw new Error(`Fault-matrix case ${options.only} is not a Workbench case`);
    }
    selectedCases = [selected];
  } else {
    selectedCases = OBSERVER_FAULT_MATRIX.cases.filter(
      (matrixCase): matrixCase is WorkbenchFaultMatrixCase => matrixCase.backend === "workbench"
    );
  }
  const timeoutMs = options.timeoutMs ?? 240_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 600_000) {
    throw new Error("Live Workbench matrix per-case timeout must be 60000..600000 ms");
  }
  loadAcceptanceBaseConfig(options.configPath);
  const initialSourceRevision = workbenchMatrixSourceRevision();
  if (!options.only &&
      (initialSourceRevision.tree !== "clean" || initialSourceRevision.commit === null)) {
    throw new Error("A full Workbench matrix requires a clean committed source revision before launch");
  }
  const artifactRoot = canonicalDirectory(
    options.artifactRoot ?? (() => {
      const path = join(tmpdir(), "reforger-forge-workbench-observer-acceptance");
      mkdirSync(path, { recursive: true });
      return path;
    })(),
    "Workbench matrix evidence root"
  );
  assertEvidenceOutsideRepository(artifactRoot);
  const validationRoot = resolve(options.validationRoot ?? join(artifactRoot, "validation"));
  const aggregateRunDirectory = mkdtempSync(join(artifactRoot, "matrix-run-"));
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const entries: MatrixCaseEntry[] = [];
  const measurements: OperationalBaselineMeasurement[] = [];
  const processCounts: OperationalBaselineProcessSample[] = [];
  const knownSecretValues: string[] = [aggregateRunDirectory];
  const failures: unknown[] = [];
  let environment: OperationalBaselineEnvironment | null = null;
  let launchArguments = operationalBaselineLaunchArgumentIdentity([], false);
  let retainedRunDirectory: string | null = null;
  let reviewDirectory: string | null = null;
  let reviewBundleCount = 0;

  for (const [index, matrixCase] of selectedCases.entries()) {
    const caseStartedAt = Date.now();
    const caseDirectory = join(aggregateRunDirectory, `case-${String(index + 1).padStart(3, "0")}`);
    mkdirSync(caseDirectory, { recursive: true });
    let outcome: WorkbenchLiveMatrixCaseOutcome;
    try {
      outcome = await runLiveWorkbenchMatrixCase({
        configPath: options.configPath,
        matrixCase,
        caseDirectory,
        timeoutMs,
        caseStartedAt,
      });
    } catch (error) {
      // Composition/source-recording failures occur outside the native case's
      // guarded launch body. Preserve a bounded failed row and continue so one
      // aggregate diagnostic artifact still covers the complete selection.
      const fallbackConfig = acceptanceConfig(
        options.configPath,
        join(caseDirectory, "fallback-project"),
        join(caseDirectory, "fallback-managed")
      );
      const fallbackCleanup = {
        lifecycleVacant: false,
        endpointVacant: false,
        childVacant: false,
        exactOwnerVacant: false,
      };
      const fallbackSecrets = [caseDirectory];
      outcome = {
        entry: failedWorkbenchMatrixEntry({
          matrixCase,
          publicTerminal: null,
          startedAt: caseStartedAt,
          failureObservedAt: Date.now(),
          budgetMs: timeoutMs,
          failure: error,
          knownSecretValues: fallbackSecrets,
          cleanup: fallbackCleanup,
          exactOwnerShutdown: false,
          decoy: matrixCase.injection.action === "stop_owned_workbench"
            ? { category: "unproven", identityUnchanged: null }
            : { category: "not_applicable", identityUnchanged: null },
        }),
        failure: error,
        knownSecretValues: fallbackSecrets,
        measurements: [],
        processCounts: [],
        launchArguments: operationalBaselineLaunchArgumentIdentity([], false),
        environment: operationalBaselineEnvironment(workbenchEnvironmentExecutables(fallbackConfig)),
        retainForDecoyRecovery: false,
      };
    }
    entries.push(outcome.entry);
    measurements.push(...outcome.measurements);
    processCounts.push(...outcome.processCounts);
    environment ??= outcome.environment;
    if (outcome.launchArguments.observed) launchArguments = outcome.launchArguments;
    for (const value of outcome.knownSecretValues) {
      if (!knownSecretValues.includes(value)) knownSecretValues.push(value);
    }
    if (outcome.failure) failures.push(outcome.failure);
    let reviewExportFailed = false;
    if (!outcome.failure && outcome.entry.artifactEvidence?.manifestPublished === true) {
      try {
        const sourceEvidence = join(caseDirectory, "evidence");
        if (!existsSync(sourceEvidence)) {
          throw new Error(`Completed matrix row ${matrixCase.id} has no reviewable evidence directory`);
        }
        reviewDirectory ??= mkdtempSync(join(artifactRoot, "matrix-image-review-"));
        cpSync(
          sourceEvidence,
          join(reviewDirectory, `case-${String(index + 1).padStart(3, "0")}`),
          { recursive: true, errorOnExist: true, force: false }
        );
        reviewBundleCount += 1;
      } catch (error) {
        reviewExportFailed = true;
        failures.push(error);
      }
    }
    const retainSelectedFailure = Boolean(options.only && options.keepProfile && outcome.failure);
    let removed = false;
    try {
      removed = removeWorkbenchCaseDirectoryIfSafe({
        caseDirectory,
        entry: outcome.entry,
        retainForDecoyRecovery: outcome.retainForDecoyRecovery,
        retainExplicitly: retainSelectedFailure || reviewExportFailed,
        onRemovalError: (error) => failures.push(error),
      });
    } catch (error) {
      failures.push(error);
      removed = false;
    }
    if (!removed) {
      // Retain the common external root so every unresolved lifecycle/profile
      // remains discoverable even when more than one full-run row fails.
      retainedRunDirectory = aggregateRunDirectory;
    }
  }

  if (!options.only && failures.length === 0 && reviewBundleCount === 0) {
    failures.push(new Error("A full passing Workbench matrix produced no external image-review bundles"));
  }

  const coverage = {
    kind: options.only ? "partial" as const : "full" as const,
    selectedCaseIds: selectedCases.map((matrixCase) => matrixCase.id),
  };
  const aggregateConfig = acceptanceConfig(
    options.configPath,
    join(aggregateRunDirectory, "aggregate-project"),
    join(aggregateRunDirectory, "aggregate-managed")
  );
  environment ??= operationalBaselineEnvironment(workbenchEnvironmentExecutables(aggregateConfig));
  const fixtureTemplateIdentity = operationalBaselineDirectoryIdentity(
    WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR,
    [".c", ".gproj"]
  );
  const workload: OperationalBaselineWorkload = {
    procedureRevision: "workbench-failure-matrix-v3",
    runtimeKind: "workbench",
    overallTimeoutMs: timeoutMs * selectedCases.length,
    worldResource: "Worlds/ObserverMatrixA.ent",
    fixture: {
      kind: "disposable_workbench_world",
      id: "ObserverMatrixA_B",
      guid: null,
      sourceFileCount: 5 + fixtureTemplateIdentity.fileCount,
      sourceSha256: operationalBaselineProcedureSha256({
        parentWorld: BASE_EVERON_WORLD,
        worlds: ["ObserverMatrixA", "ObserverMatrixB"],
        fixtureAddonGuid: WORKBENCH_MATRIX_FIXTURE_GUID,
        fixtureAddonSourceSha256: fixtureTemplateIdentity.sha256,
      }),
    },
    capture: {
      labels: ["matrix-baseline-current", "matrix-primary", "matrix-followup-current", "matrix-competing"],
      settleFrames: 3,
      performancePolicy: "evidence",
      asynchronous: true,
      configurationSha256: operationalBaselineProcedureSha256({
        selectedCaseIds: coverage.selectedCaseIds,
        settleFrames: 3,
        performancePolicy: "evidence",
      }),
    },
    launchArguments,
  };
  const limitations = [
    "Every selected case uses a fresh disposable project, profile, lifecycle and fixture capability.",
    "Automation validates PNG structure and metadata but records image review as unreviewed.",
    "The matrix records observations and absolute deadlines without applying performance thresholds.",
  ];
  // Bracket the final Git check with two complete source-closure reads. A full
  // artifact cannot combine a clean commit claim with bytes changed during
  // hashing/publication preparation.
  const finalSource = captureStableWorkbenchMatrixSource({
    readSource: () => operationalBaselineSource(
      SCRIPT_PATH,
      "scripts/run-workbench-observer-acceptance.ts",
      REPOSITORY_ROOT,
      [...WORKBENCH_OPERATIONAL_BASELINE_SOURCES, ...WORKBENCH_MATRIX_FIXTURE_SOURCES],
      OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES
    ),
    readRevision: workbenchMatrixSourceRevision,
  });
  const { source, sourceRevision } = finalSource;
  if (!finalSource.stable) {
    failures.push(new Error("The Workbench matrix source bytes or revision changed during final identity capture"));
  }
  if (!options.only &&
      (sourceRevision.tree !== "clean" || sourceRevision.commit === null ||
        sourceRevision.commit !== initialSourceRevision.commit)) {
    failures.push(new Error("The Workbench matrix source revision changed or became dirty during execution"));
  }
  const finishedAtMs = Date.now();
  const overallResult = failures.length === 0 ? "passed" as const : "failed" as const;
  const failureName = overallResult === "failed"
    ? failures[0] instanceof Error ? failures[0].name : "WorkbenchFailureMatrixError"
    : undefined;
  const artifact = buildObserverFailureMatrixArtifact({
    backend: "workbench",
    result: overallResult,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    environment,
    workload,
    source,
    matrix: OBSERVER_FAULT_MATRIX,
    coverage,
    sourceRevision,
    cases: entries,
    measurements,
    processCounts,
    limitations,
    failure: failureName ? { name: failureName } : null,
    knownSecretValues,
  });
  const publication = writeObserverFailureMatrixArtifact(
    validationRoot,
    artifact,
    OBSERVER_FAULT_MATRIX,
    knownSecretValues
  );

  if (!retainedRunDirectory) {
    try { rmSync(aggregateRunDirectory, { recursive: true, force: true }); } catch { /* evidence is already published */ }
  }
  if (failures.length > 0) {
    const first = failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
    first.message = `${first.message}. Workbench failure-matrix artifact: ${publication.jsonPath}` +
      (retainedRunDirectory ? ` (recovery directory retained: ${retainedRunDirectory})` : "") +
      (reviewDirectory ? ` (image-review directory retained: ${reviewDirectory})` : "");
    throw first;
  }
  return { ...publication, runDirectory: reviewDirectory };
}
function usage(): string {
  return `Usage: npm run dev:observer:acceptance:workbench -- --config <file> [--confirm-live-run] [--artifact-root <directory>] [--validation-root <directory>] [--timeout-ms <60000..600000>]\n` +
    `       npm run dev:observer:acceptance:workbench -- --config <file> --matrix --confirm-live-run [matrix options]\n` +
    `       npm run dev:observer:acceptance:workbench -- --config <file> --only <workbench-case-id> --confirm-live-run [--keep-profile] [matrix options]\n` +
    `       npm run dev:observer:acceptance:workbench -- --list-cases\n\n` +
    `No matrix selector runs the existing positive-path acceptance. --matrix selects all 69 Workbench cases; --only selects one partial-coverage case.\n` +
    `Required environment: ${LIVE_WORKBENCH_OBSERVER_ENVIRONMENT}=1\n`;
}

/** Declared Workbench cases, exposed without invoking authorization or live setup. */
export function workbenchFailureMatrixCaseIds(): readonly string[] {
  return OBSERVER_FAULT_MATRIX.cases
    .filter((matrixCase) => matrixCase.backend === "workbench")
    .map((matrixCase) => matrixCase.id);
}

/** Read one value option and reject ambiguous duplicate singleton options. */
export function readWorkbenchCliOption(args: readonly string[], name: string): string | undefined {
  const indices = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (indices.length > 1) throw new Error(`${name} may be specified only once`);
  if (indices.length === 0) return undefined;
  const value = args[indices[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** Read one boolean flag and reject ambiguous duplicate singleton flags. */
export function readWorkbenchCliFlag(args: readonly string[], name: string): boolean {
  const count = args.filter((arg) => arg === name).length;
  if (count > 1) throw new Error(`${name} may be specified only once`);
  return count === 1;
}

interface WorkbenchCliLiveOptions {
  readonly confirmed: boolean;
  readonly configPath: string;
  readonly artifactRoot?: string;
  readonly validationRoot?: string;
  readonly timeoutMs?: number;
}

export type WorkbenchObserverCliCommand =
  | { readonly mode: "help" }
  | { readonly mode: "list" }
  | ({ readonly mode: "positive" } & WorkbenchCliLiveOptions)
  | ({ readonly mode: "matrix"; readonly only?: string; readonly keepProfile: boolean } & WorkbenchCliLiveOptions);

/** Strict, consuming parser: every token is recognized exactly once or rejected. */
export function parseWorkbenchObserverCliArgs(args: readonly string[]): WorkbenchObserverCliCommand {
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--config", "--artifact-root", "--validation-root", "--timeout-ms", "--only",
  ]);
  const flagOptions = new Set([
    "--help", "--list-cases", "--confirm-live-run", "--matrix", "--keep-profile",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]!;
    const option = raw === "-h" ? "--help" : raw;
    if (valueOptions.has(option)) {
      if (seen.has(option)) throw new Error(`${option} may be specified only once`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
      seen.add(option);
      values[option] = value;
      index += 1;
      continue;
    }
    if (flagOptions.has(option)) {
      if (seen.has(option)) throw new Error(`${option} may be specified only once`);
      seen.add(option);
      flags.add(option);
      continue;
    }
    throw new Error(`Unknown or stray Workbench acceptance argument: ${raw}`);
  }

  if (flags.has("--help") || flags.has("--list-cases")) {
    const selected = flags.has("--help") ? "--help" : "--list-cases";
    if (seen.size !== 1) throw new Error(`${selected} must be used by itself`);
    return { mode: selected === "--help" ? "help" : "list" };
  }
  if (flags.has("--matrix") && values["--only"]) {
    throw new Error("--matrix and --only are mutually exclusive selectors");
  }
  if (flags.has("--keep-profile") && !values["--only"]) {
    throw new Error("--keep-profile is valid only together with --only");
  }
  const configPath = values["--config"];
  if (!configPath) {
    throw new Error("Live Workbench observer acceptance requires --config <file>");
  }
  const timeoutValue = values["--timeout-ms"];
  const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
  if (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 600_000)) {
    throw new Error("--timeout-ms must be a safe integer from 60000 through 600000");
  }
  const common: WorkbenchCliLiveOptions = {
    confirmed: flags.has("--confirm-live-run"),
    configPath,
    ...(values["--artifact-root"] ? { artifactRoot: values["--artifact-root"] } : {}),
    ...(values["--validation-root"] ? { validationRoot: values["--validation-root"] } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  const only = values["--only"];
  if (only) {
    const selected = caseForId(OBSERVER_FAULT_MATRIX, only);
    if (selected.backend !== "workbench") {
      throw new Error(`Fault-matrix case ${only} is not a Workbench case`);
    }
    return { mode: "matrix", ...common, only, keepProfile: flags.has("--keep-profile") };
  }
  if (flags.has("--matrix")) {
    return { mode: "matrix", ...common, keepProfile: false };
  }
  return { mode: "positive", ...common };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    const command = parseWorkbenchObserverCliArgs(process.argv.slice(2));
    if (command.mode === "help") {
      process.stdout.write(usage());
    } else if (command.mode === "list") {
      process.stdout.write(`${workbenchFailureMatrixCaseIds().join("\n")}\n`);
    } else if (command.mode === "matrix") {
      const result = await runWorkbenchFailureMatrix(command);
      process.stdout.write(
        `Workbench observer failure matrix passed (${command.only ? "partial" : "full"} coverage).\n` +
        `RFO_WORKBENCH_OBSERVER_FAILURE_MATRIX_JSON=${result.jsonPath}\n` +
        `RFO_WORKBENCH_OBSERVER_FAILURE_MATRIX_MARKDOWN=${result.markdownPath}\n` +
        (result.runDirectory
          ? `RFO_WORKBENCH_OBSERVER_FAILURE_MATRIX_REVIEW_DIRECTORY=${result.runDirectory}\n`
          : "")
      );
    } else {
      const result = await runWorkbenchObserverAcceptance(command);
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
