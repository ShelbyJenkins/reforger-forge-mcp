#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { OBSERVER_TERMINAL_STATES } from "../observer/protocol/enforce-contract.js";
import { OBSERVER_FAULT_MATRIX } from "../observer/protocol/fault-matrix.js";
import { systemClock, systemSleeper } from "../src/foundation/time.js";
import {
  createObserverApplication,
  type ObserverApplication,
  type ObserverCaptureResult,
  type ObserverCaptureView,
} from "../src/observer/application.js";
import { prepareObserverLaunch } from "../src/observer/launch.js";
import {
  closeObserverRuntimeLifecycle,
  OwnedRuntimeManager,
} from "../src/observer/owned-runtime-manager.js";
import {
  OperationalBaselineRecorder,
  analyzePngMaterial,
  comparePngImages,
  detectPngColorMarker,
  operationalBaselineDirectoryIdentity,
  operationalBaselineEnvironment,
  operationalBaselineLaunchArgumentIdentity,
  operationalBaselineProcedureSha256,
  operationalBaselineSource,
  waitForOperationalBaselineProcessVacancy,
  writeOperationalBaselineArtifact,
  type ColorMarkerEvidence,
  type NormalizedImageRegion,
  type PngComparisonEvidence,
  type PngMaterialEvidence,
} from "./observer-live-acceptance-support.js";
import {
  createFaultMatrixRunScaffolding,
  removeOwnedFaultControlRoot,
  resolveFaultMatrixCases,
} from "./observer-fault-matrix-support.js";
import { runRuntimeFailureMatrix } from "./observer-runtime-failure-matrix.js";
import {
  assertArmaVacant,
  assertCurrentViewReleasedFromDisplaced,
  assertLiveRuntimeObserverAuthorized,
  assertRequestedPoseRendered,
  boundedText,
  canonicalDirectory,
  canonicalFile,
  captureMatrix,
  comparisonPath,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_FOV,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_POSITION,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_TARGET,
  DEFAULT_RUNTIME_OBSERVER_POSE_FOV,
  DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION,
  DEFAULT_RUNTIME_OBSERVER_POSE_POSITION,
  DEFAULT_RUNTIME_OBSERVER_WORLD,
  findRuntimeExecutable,
  inspectAddonFixture,
  launchArguments,
  LIVE_RUNTIME_OBSERVER_ENVIRONMENT,
  OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES,
  OBSERVER_SOURCE_PATH,
  PRIVATE_CHILD_PATH,
  record,
  recordRestorationImageSimilarity,
  REPOSITORY_ROOT,
  resolveRuntimeAcceptanceArtifactRoot,
  RUNTIME_FIXTURE_SOURCE_EXTENSIONS,
  RUNTIME_OPERATIONAL_BASELINE_SOURCES,
  sha256,
  type Quaternion,
  type Vector3,
} from "./observer-runtime-launch-support.js";

export {
  LIVE_RUNTIME_OBSERVER_ENVIRONMENT,
  LIVE_RUNTIME_OBSERVER_TEST_CONFIRMATION,
  DEFAULT_RUNTIME_OBSERVER_WORLD,
  DEFAULT_RUNTIME_OBSERVER_POSE_POSITION,
  DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION,
  DEFAULT_RUNTIME_OBSERVER_POSE_FOV,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_POSITION,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_TARGET,
  DEFAULT_RUNTIME_OBSERVER_LOOK_AT_FOV,
  REPOSITORY_ROOT,
  RUNTIME_OPERATIONAL_BASELINE_SOURCES,
  OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES,
  PRIVATE_CHILD_PATH,
  OBSERVER_SOURCE_PATH,
  RUNTIME_FIXTURE_SOURCE_EXTENSIONS,
  record,
  canonicalDirectory,
  canonicalFile,
  resolveRuntimeAcceptanceArtifactRoot,
  boundedText,
  assertLiveRuntimeObserverAuthorized,
  assertArmaVacant,
  inspectAddonFixture,
  findRuntimeExecutable,
  launchArguments,
  captureMatrix,
  assertMatrixClose,
  runtimePoseMatrix,
  assertRequestedPoseRendered,
  assertCurrentViewReleasedFromDisplaced,
  recordRestorationImageSimilarity,
  type AddonFixture,
  type RuntimeCameraMatrix,
  type RuntimeRestorationImageDiagnostic,
} from "./observer-runtime-launch-support.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TERMINAL_STATES = new Set<string>(OBSERVER_TERMINAL_STATES);
const ACCEPTANCE_CASE_ID = "RFO-LIVE-RUNTIME-SCREENSHOT";
const CAPTURE_LABELS = [
  "initial-current",
  "explicit-pose",
  "post-pose-restoration-current",
  "explicit-look-at",
  "post-look-at-restoration-current",
] as const;

export interface RuntimeObserverMarkerExpectation {
  color: [number, number, number];
  roi?: NormalizedImageRegion;
  channelTolerance?: number;
  minimumMatchingPixels?: number;
  minimumMatchRatio?: number;
}

export interface RuntimeObserverAcceptanceOptions {
  confirmed: boolean;
  configPath: string;
  environment?: NodeJS.ProcessEnv;
  artifactRoot?: string;
  /** Defaults to the repository's docs/validation directory. */
  validationRoot?: string;
  timeoutMs?: number;
  worldResource?: string;
  addonDirectory?: string;
  executablePath?: string;
  launchArguments?: string[];
  posePosition?: Vector3;
  poseOrientation?: Quaternion;
  poseFov?: number;
  lookAtPosition?: Vector3;
  lookAtTarget?: Vector3;
  lookAtFov?: number;
  marker?: RuntimeObserverMarkerExpectation;
  /** Only the legacy positive-path flow is reachable through this option; a
   *  declared matrix ID is always rejected here and must be run through the
   *  --only CLI flag (scripts/observer-runtime-failure-matrix.ts). */
  only?: string;
}

export interface RuntimeObserverAcceptanceResult {
  runDirectory: string;
  summaryPath: string;
  evidenceDirectory: string;
  baselinePath: string;
  summary: Record<string, unknown>;
}

interface RetainedCapture {
  label: typeof CAPTURE_LABELS[number];
  job: Record<string, unknown>;
  metadata: Record<string, unknown>;
  image: Buffer;
  png: PngMaterialEvidence;
}

function validatePosition(position: Vector3, label: string): void {
  if (position.length !== 3 || position.some((value) => !Number.isFinite(value)) ||
      Math.hypot(...position) > 100_000) {
    throw new Error(`Runtime acceptance ${label} is invalid`);
  }
}

function validatePose(
  options: RuntimeObserverAcceptanceOptions
): Extract<ObserverCaptureView, { kind: "pose" }> {
  const position = options.posePosition ?? DEFAULT_RUNTIME_OBSERVER_POSE_POSITION;
  const orientation = options.poseOrientation ?? DEFAULT_RUNTIME_OBSERVER_POSE_ORIENTATION;
  const fov = options.poseFov ?? DEFAULT_RUNTIME_OBSERVER_POSE_FOV;
  validatePosition(position, "pose position");
  if (orientation.length !== 4 || orientation.some((value) => !Number.isFinite(value))) {
    throw new Error("Runtime acceptance pose orientation is invalid");
  }
  const quaternionLength = Math.hypot(...orientation);
  if (quaternionLength < 0.999 || quaternionLength > 1.001) {
    throw new Error("Runtime acceptance pose orientation must be a normalized quaternion");
  }
  if (!Number.isFinite(fov) || fov < 10 || fov > 120) {
    throw new Error("Runtime acceptance pose FOV must be from 10 through 120 degrees");
  }
  return {
    kind: "pose",
    position: [...position],
    orientation: [...orientation],
    fov,
  };
}

function validateLookAt(
  options: RuntimeObserverAcceptanceOptions
): Extract<ObserverCaptureView, { kind: "lookAt" }> {
  const position = options.lookAtPosition ?? DEFAULT_RUNTIME_OBSERVER_LOOK_AT_POSITION;
  const target = options.lookAtTarget ?? DEFAULT_RUNTIME_OBSERVER_LOOK_AT_TARGET;
  const fov = options.lookAtFov ?? DEFAULT_RUNTIME_OBSERVER_LOOK_AT_FOV;
  validatePosition(position, "look-at position");
  validatePosition(target, "look-at target");
  if (Math.hypot(
    target[0] - position[0],
    target[1] - position[1],
    target[2] - position[2]
  ) < 0.001) {
    throw new Error("Runtime acceptance look-at position and target must differ");
  }
  if (!Number.isFinite(fov) || fov < 10 || fov > 120) {
    throw new Error("Runtime acceptance look-at FOV must be from 10 through 120 degrees");
  }
  return { kind: "lookAt", position: [...position], target: [...target], fov };
}

function validateCapture(
  result: ObserverCaptureResult,
  label: typeof CAPTURE_LABELS[number],
  expected: { instanceId: string; worldId: string; worldEpoch: number }
): RetainedCapture {
  if (result.asynchronous) throw new Error(`${label} unexpectedly returned an asynchronous job`);
  const job = record(result.job, `${label} job`);
  const metadata = record(result.metadata, `${label} metadata`);
  if (job.state !== "completed" || job.instanceId !== expected.instanceId ||
      job.worldId !== expected.worldId || job.worldEpoch !== expected.worldEpoch) {
    throw new Error(`${label} completion identity does not match its selected runtime instance`);
  }
  const png = analyzePngMaterial(result.image);
  if (!png.materiallyVaried) {
    throw new Error(`${label} screenshot is blank or lacks material color/luminance variation`);
  }
  if (metadata.contentSha256 !== png.sha256 || metadata.width !== png.width ||
      metadata.height !== png.height || metadata.instanceId !== expected.instanceId ||
      metadata.worldId !== expected.worldId || metadata.worldEpoch !== expected.worldEpoch) {
    throw new Error(`${label} PNG, metadata, and selected runtime identity disagree`);
  }
  return { label, job, metadata, image: result.image, png };
}

async function captureIntoRunUnmeasured(
  application: ObserverApplication,
  input: {
    runId: string;
    label: typeof CAPTURE_LABELS[number];
    purpose: string;
    sessionId: string;
    instanceId: string;
    worldId: string;
    worldEpoch: number;
    view: ObserverCaptureView;
    timeoutMs: number;
  }
): Promise<RetainedCapture> {
  const result = await application.capture({
    runId: input.runId,
    captureLabel: input.label,
    purpose: input.purpose,
    sessionId: input.sessionId,
    instanceId: input.instanceId,
    expectedWorldId: input.worldId,
    expectedWorldEpoch: input.worldEpoch,
    idempotencyKey: `${input.runId}-${input.label}`,
    view: input.view,
    settleFrames: 3,
    performancePolicy: "evidence",
    asynchronous: false,
    timeoutMs: input.timeoutMs,
  });
  return validateCapture(result, input.label, input);
}

async function captureIntoRun(
  application: ObserverApplication,
  input: {
    runId: string;
    label: typeof CAPTURE_LABELS[number];
    purpose: string;
    sessionId: string;
    instanceId: string;
    worldId: string;
    worldEpoch: number;
    view: ObserverCaptureView;
    timeoutMs: number;
  },
  baseline: OperationalBaselineRecorder
): Promise<RetainedCapture> {
  return baseline.measure(
    "capture",
    `ObserverApplication.capture(${input.label})`,
    () => captureIntoRunUnmeasured(application, input),
    input.label
  );
}

function retainDiagnosticCapture(root: string, capture: RetainedCapture): Record<string, unknown> {
  const captureRoot = join(root, "captures");
  const metadataRoot = join(root, "metadata");
  mkdirSync(captureRoot, { recursive: true });
  mkdirSync(metadataRoot, { recursive: true });
  const imagePath = join(captureRoot, `${capture.label}.png`);
  const metadataPath = join(metadataRoot, `${capture.label}.json`);
  writeFileSync(imagePath, capture.image, { flag: "wx" });
  writeFileSync(metadataPath, `${JSON.stringify(capture.metadata, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return {
    label: capture.label,
    imagePath,
    metadataPath,
    sha256: sha256(capture.image),
    png: capture.png,
  };
}

function listBundleFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const status = lstatSync(full);
      if (status.isSymbolicLink()) throw new Error(`Evidence bundle contains a link: ${relativePath}`);
      if (entry.isDirectory()) visit(full, relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`Evidence bundle contains a non-regular member: ${relativePath}`);
    }
  };
  visit(root, "");
  return files.sort((left, right) => left.localeCompare(right));
}

function removeOwnedScratch(runDirectory: string, path: string, label: string): Record<string, unknown> {
  const canonicalRun = canonicalDirectory(runDirectory, "Acceptance run directory");
  const canonical = canonicalDirectory(path, label);
  if (comparisonPath(dirname(canonical)) !== comparisonPath(canonicalRun) ||
      comparisonPath(canonical) === comparisonPath(canonicalRun)) {
    throw new Error(`${label} is not an exact child of the owned acceptance run`);
  }
  // Refuse recursive cleanup when the owned tree contains a link or a special
  // filesystem entry. A failed acceptance then preserves it for inspection.
  listBundleFiles(canonical);
  // LMDB has closed before this point, but Windows can briefly report EPERM
  // while releasing its memory-mapped files. Keep the cleanup exact and
  // fail-closed, while allowing Node's bounded recursive-rm retry to bridge
  // that post-close filesystem race.
  rmSync(canonical, {
    recursive: true,
    force: false,
    maxRetries: 10,
    retryDelay: 100,
  });
  if (existsSync(canonical)) throw new Error(`${label} remained after exact cleanup`);
  return { removed: true, path: canonical };
}

function verifyEvidenceBundle(
  evidenceRoot: string,
  runId: string,
  finalizeResult: Record<string, unknown>,
  captures: RetainedCapture[]
): { evidenceDirectory: string; manifestSha256: string; files: string[] } {
  const receipt = record(finalizeResult.receipt, "Observer finalize receipt");
  const finalizedRun = record(finalizeResult.run, "Finalized observer run");
  const evidenceDirectory = canonicalDirectory(String(receipt.evidenceDirectory ?? ""), "Finalized evidence directory");
  if (comparisonPath(dirname(evidenceDirectory)) !== comparisonPath(evidenceRoot) || basename(evidenceDirectory) !== runId) {
    throw new Error("Finalized evidence directory is not the expected direct child of the configured root");
  }
  if (receipt.runId !== runId || receipt.captureCount !== captures.length ||
      receipt.supportingFileCount !== 0 || receipt.managedArtifactsReleased !== true ||
      finalizedRun.runId !== runId || finalizedRun.state !== "finalized") {
    throw new Error("Observer finalize receipt/run state does not attest the expected released capture set");
  }
  const finalizedCaptures = Array.isArray(finalizedRun.captures) ? finalizedRun.captures : [];
  if (finalizedCaptures.length !== captures.length || finalizedCaptures.some((value) =>
    !value || typeof value !== "object" || (value as Record<string, unknown>).state !== "released")) {
    throw new Error("Finalized observer run did not release every selected managed artifact");
  }
  const files = listBundleFiles(evidenceDirectory);
  const manifestPath = canonicalFile(join(evidenceDirectory, "manifest.json"), "Evidence manifest");
  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (receipt.manifestSha256 !== manifestSha256) {
    throw new Error("Evidence receipt digest does not match manifest.json");
  }
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "Evidence manifest");
  const review = record(manifest.review, "Evidence review");
  const exportRecord = record(manifest.export, "Evidence export declaration");
  const runtimeConfig = record(manifest.runtimeConfig, "Evidence runtime configuration declaration");
  const relevantLogs = record(manifest.relevantLogs, "Evidence relevant-log declaration");
  if (manifest.manifestVersion !== 1 || manifest.runId !== runId ||
      review.imagesReviewed !== false || review.outcome !== "Unreviewed" ||
      exportRecord.completionMarker !== "manifest.json" ||
      exportRecord.managedArtifactsReleased !== true ||
      runtimeConfig.supplied !== true || runtimeConfig.path !== "runtime-config.json" ||
      relevantLogs.supplied !== false) {
    throw new Error("Automated acceptance bundle has an invalid run or review declaration");
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.captures) ||
      !Array.isArray(manifest.supportingFiles) || manifest.supportingFiles.length !== 0) {
    throw new Error("Evidence manifest has no file/capture attestations");
  }
  const expectedMembers = [
    "RESULT.md",
    "runtime-config.json",
    ...captures.flatMap((capture) => [
      `captures/${capture.label}.json`,
      `captures/${capture.label}.png`,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const attested = new Set<string>();
  for (const raw of manifest.files) {
    const member = record(raw, "Evidence file attestation");
    const path = String(member.path ?? "");
    if (!/^[A-Za-z0-9._/-]{1,512}$/.test(path) || path.startsWith("/") || path.includes("..") || attested.has(path)) {
      throw new Error(`Evidence manifest contains an unsafe or duplicate member: ${path}`);
    }
    const bytes = readFileSync(canonicalFile(join(evidenceDirectory, ...path.split("/")), `Evidence member ${path}`));
    if (member.bytes !== bytes.length || member.sha256 !== sha256(bytes)) {
      throw new Error(`Evidence member does not match its attestation: ${path}`);
    }
    attested.add(path);
  }
  const attestedMembers = [...attested].sort((left, right) => left.localeCompare(right));
  if (attestedMembers.length !== expectedMembers.length ||
      attestedMembers.some((path, index) => path !== expectedMembers[index])) {
    throw new Error("Evidence manifest does not attest the exact standardized member set");
  }
  const expectedFiles = [...expectedMembers, "manifest.json"].sort((left, right) => left.localeCompare(right));
  if (files.length !== expectedFiles.length || files.some((path, index) => path !== expectedFiles[index])) {
    throw new Error("Finalized evidence directory contains an unattested or missing member");
  }
  const resultMarkdown = readFileSync(join(evidenceDirectory, "RESULT.md"), "utf8");
  if (!resultMarkdown.includes(`Run: \`${runId}\``) ||
      !resultMarkdown.includes("Outcome: **Unreviewed**") ||
      !resultMarkdown.includes("Images reviewed: no")) {
    throw new Error("Evidence RESULT.md does not declare the automated unreviewed outcome");
  }
  const runtimeConfigValue = record(
    JSON.parse(readFileSync(join(evidenceDirectory, "runtime-config.json"), "utf8")),
    "Evidence runtime-config.json"
  );
  if (runtimeConfigValue.configurationId !== "runtime-observer-acceptance-v2") {
    throw new Error("Evidence runtime-config.json has an unexpected configuration identity");
  }
  const captureByLabel = new Map(captures.map((capture) => [capture.label, capture]));
  if (manifest.captures.length !== captures.length) {
    throw new Error("Evidence manifest capture count is incomplete");
  }
  const seenCaptureLabels = new Set<string>();
  for (const raw of manifest.captures) {
    const item = record(raw, "Evidence capture");
    const label = String(item.label ?? "") as typeof CAPTURE_LABELS[number];
    if (seenCaptureLabels.has(label)) {
      throw new Error(`Evidence manifest contains duplicate capture label: ${label}`);
    }
    seenCaptureLabels.add(label);
    const capture = captureByLabel.get(label);
    if (!capture || item.imagePath !== `captures/${label}.png` ||
        item.metadataPath !== `captures/${label}.json`) {
      throw new Error(`Evidence manifest references an unexpected capture: ${label}`);
    }
    const exportedMetadata = record(
      JSON.parse(readFileSync(join(evidenceDirectory, "captures", `${label}.json`), "utf8")),
      `Exported capture metadata ${label}`
    );
    if (!isDeepStrictEqual(exportedMetadata, item) || item.backend !== "runtime" ||
        item.jobId !== capture.job.jobId || item.jobId !== capture.metadata.jobId ||
        item.instanceId !== capture.metadata.instanceId ||
        item.worldId !== capture.metadata.worldId || item.worldEpoch !== capture.metadata.worldEpoch ||
        !isDeepStrictEqual(item.requestedView, capture.metadata.requestedView) ||
        !isDeepStrictEqual(item.actualCamera, capture.metadata.actualCamera) ||
        item.actualFov !== (capture.metadata.actualFov ?? null) ||
        item.contaminated !== false || !Array.isArray(item.warnings)) {
      throw new Error(`Exported capture metadata is not bound to its validated runtime artifact: ${label}`);
    }
    const image = readFileSync(join(evidenceDirectory, "captures", `${label}.png`));
    const png = analyzePngMaterial(image);
    if (png.sha256 !== capture.png.sha256 || png.byteCount !== capture.png.byteCount ||
        item.sha256 !== png.sha256 || item.bytes !== png.byteCount ||
        item.width !== png.width || item.height !== png.height) {
      throw new Error(`Exported capture differs from its validated inline image: ${label}`);
    }
  }
  if (CAPTURE_LABELS.some((label) => !seenCaptureLabels.has(label))) {
    throw new Error("Evidence manifest does not contain every required acceptance capture label");
  }
  return { evidenceDirectory, manifestSha256, files };
}

async function cancelRunJobs(
  application: ObserverApplication,
  sessionId: string,
  runId: string,
  deadline: number
): Promise<void> {
  const run = await application.runStatus(runId);
  const captures = Array.isArray(run.captures) ? run.captures : [];
  for (const raw of captures) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const capture = raw as Record<string, unknown>;
    if (typeof capture.jobId !== "string" || TERMINAL_STATES.has(String(capture.state))) continue;
    let job = await application.cancelJob(sessionId, capture.jobId);
    while (!TERMINAL_STATES.has(String(job.state)) && Date.now() < deadline) {
      await delay(250);
      job = await application.jobStatus(sessionId, capture.jobId);
    }
    const lease = job.cameraLease && typeof job.cameraLease === "object"
      ? job.cameraLease as Record<string, unknown>
      : {};
    if (!TERMINAL_STATES.has(String(job.state)) || lease.held === true ||
        (lease.everHeld === true && lease.restorationConfirmed !== true)) {
      throw new Error(`Runtime observer job ${capture.jobId} did not reach restored terminal cleanup`);
    }
  }
}

function writeSummary(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function runRuntimeObserverAcceptance(
  options: RuntimeObserverAcceptanceOptions
): Promise<RuntimeObserverAcceptanceResult> {
  assertLiveRuntimeObserverAuthorized(options.confirmed, options.environment);
  const phaseOneFaultCases = resolveFaultMatrixCases(OBSERVER_FAULT_MATRIX, options.only);
  if (phaseOneFaultCases.length > 0) {
    throw new Error("Runtime fault-matrix execution is not enabled until the Phase 2 fixture bridge is installed");
  }
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 900_000) {
    throw new Error("Live runtime observer timeout must be 60000..900000 ms");
  }
  const worldResource = boundedText(
    options.worldResource ?? DEFAULT_RUNTIME_OBSERVER_WORLD,
    "Runtime acceptance world resource",
    1_024
  );
  const poseView = validatePose(options);
  const lookAtView = validateLookAt(options);
  const fixture = inspectAddonFixture(options.addonDirectory);
  const executable = findRuntimeExecutable(options.executablePath, options.configPath);
  const baseArguments = launchArguments(worldResource, fixture, options.launchArguments);
  let baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity(baseArguments, false);
  const baselineFixtureContent = fixture
    ? operationalBaselineDirectoryIdentity(fixture.addonDirectory, RUNTIME_FIXTURE_SOURCE_EXTENSIONS)
    : null;
  const markerConfiguration = options.marker ? {
    color: [...options.marker.color],
    roi: options.marker.roi ? { ...options.marker.roi } : null,
    channelTolerance: options.marker.channelTolerance ?? null,
    minimumMatchingPixels: options.marker.minimumMatchingPixels ?? null,
    minimumMatchRatio: options.marker.minimumMatchRatio ?? null,
  } : null;
  const baselineCaptureConfigurationSha256 = operationalBaselineProcedureSha256({
    poseView,
    lookAtView,
    marker: markerConfiguration,
    materialDifferencePolicy: {
      channelTolerance: 8,
      minimumChangedPixelRatio: 0.01,
      minimumMeanAbsoluteError: 1.5,
    },
    restorationImagePolicy: {
      acceptanceRole: "diagnostic-only",
      maximumChangedPixelRatioForSimilarity: 0.25,
      maximumMeanAbsoluteErrorForSimilarity: 12,
    },
  });
  if (!existsSync(PRIVATE_CHILD_PATH)) {
    throw new Error("Compiled observer private child is missing; run npm run build before live acceptance");
  }
  assertArmaVacant("Live runtime observer acceptance preflight");

  const artifactRoot = resolveRuntimeAcceptanceArtifactRoot(options.artifactRoot);
  const runDirectory = mkdtempSync(join(artifactRoot, "run-"));
  const managedRoot = join(runDirectory, "managed");
  const profileRoot = join(runDirectory, "profiles");
  const evidenceRoot = join(runDirectory, "evidence");
  const diagnosticsRoot = join(runDirectory, "diagnostics");
  for (const directory of [managedRoot, profileRoot, evidenceRoot]) mkdirSync(directory);
  const summaryPath = join(runDirectory, "acceptance-summary.json");
  const validationRoot = resolve(
    options.validationRoot ?? join(REPOSITORY_ROOT, "docs", "validation")
  );
  const deadline = Date.now() + timeoutMs;
  const application = createObserverApplication({
    agentPath: PRIVATE_CHILD_PATH,
    managedRoot,
    profileRoot,
    projectPath: fixture?.addonDirectory,
    sourceAddon: OBSERVER_SOURCE_PATH,
    evidenceRoots: [evidenceRoot],
    startupTimeoutMs: 20_000,
    requestTimeoutMs: 60_000,
    defaultCaptureTimeoutMs: Math.min(timeoutMs, 300_000),
    maxInlineImageBytes: 64 * 1024 * 1024,
  });
  const runtimeManager = new OwnedRuntimeManager({
    managedRoot,
    gamePath: dirname(executable),
    projectPath: fixture?.addonDirectory,
    observerGate: application,
    executableResolver: () => executable,
  });
  const readBaselineProcessCounts = () => {
    const runtimeChildren = runtimeManager.diagnosticSupervisedChildCounts();
    const observerPrivateChildren = application.diagnosticPrivateChildCount();
    return {
      active: runtimeChildren.active + observerPrivateChildren,
      reconciling: runtimeChildren.reconciling,
      total: runtimeChildren.total + observerPrivateChildren,
    };
  };
  const baseline = new OperationalBaselineRecorder({
    backend: "runtime",
    readSupervisedProcessCounts: readBaselineProcessCounts,
  });
  const baselineEnvironment = operationalBaselineEnvironment({ gameExecutable: executable });
  const baselineSource = operationalBaselineSource(
    SCRIPT_PATH,
    "scripts/run-runtime-observer-acceptance.ts",
    REPOSITORY_ROOT,
    RUNTIME_OPERATIONAL_BASELINE_SOURCES,
    OBSERVER_OPERATIONAL_BASELINE_SOURCE_CLOSURES
  );
  baseline.sampleProcessCounts("rest.beforeLaunch");
  const summary: Record<string, unknown> = {
    version: 1,
    status: "running",
    startedAt: baseline.startedAt,
    runDirectory,
    worldResource,
    executable: basename(executable),
    fixture: fixture ? {
      addonId: fixture.addonId,
      addonGuid: fixture.addonGuid,
      gprojPath: fixture.gprojPath,
    } : null,
    processPolicy: "preflight-all-Arma; exact OwnedRuntimeManager identity termination only",
  };
  writeSummary(summaryPath, summary);
  let runtimeId: string | null = null;
  let sessionId: string | null = null;
  let managedRunId: string | null = null;
  let faultScaffolding: ReturnType<typeof createFaultMatrixRunScaffolding> | null = null;
  let finalized = false;
  let evidenceDirectory = "";
  let baselinePath = "";
  let failure: unknown = null;
  try {
    summary.setup = await application.ensureSetup();
    const begun = await application.beginRun({
      title: "Live graphical runtime observer screenshot acceptance",
      caseIds: [ACCEPTANCE_CASE_ID],
      procedureRevision: "runtime-observer-acceptance-v2",
      idempotencyKey: `runtime-acceptance-${randomUUID()}`,
    });
    if (typeof begun.runId !== "string") throw new Error("Observer run begin returned no run ID");
    managedRunId = begun.runId;
    summary.observerRunId = managedRunId;

    const prepared = await prepareObserverLaunch(application, {
      runtimeKind: "listenServer",
      arguments: baseArguments,
      profilePath: join(profileRoot, "graphical-runtime"),
      sessionTtlMs: Math.min(24 * 60 * 60_000, timeoutMs + 120_000),
      transportPreference: ["rest", "mailbox"],
      forceUpdate: true,
      idempotencyKey: `runtime-launch-${randomUUID()}`,
    }, runtimeManager);
    sessionId = prepared.sessionId;
    if (!prepared.preparedLaunchId) {
      throw new Error("Observer launch preparation returned no owned-runtime handle");
    }
    const preparedLaunchId = prepared.preparedLaunchId;
    baselineLaunchArguments = operationalBaselineLaunchArgumentIdentity([
      ...prepared.arguments,
      "-reforgerForgeOwnerToken=<redacted>",
    ]);
    summary.preparedLaunch = {
      preparedLaunchId,
      sessionId,
      expiresAt: prepared.expiresAt,
      bundleDigest: prepared.bundleDigest,
      profilePath: prepared.profilePath,
      argumentCount: prepared.arguments.length,
      warnings: prepared.warnings,
    };

    assertArmaVacant("Live runtime observer acceptance launch");
    const launch = await baseline.measure(
      "launch",
      "OwnedRuntimeManager.start/status(running)",
      async () => {
        const startedRuntime = await runtimeManager.start({
          preparedLaunchId,
          idempotencyKey: `runtime-start-${randomUUID()}`,
        });
        runtimeId = startedRuntime.runtimeId;
        if (startedRuntime.state !== "running" || startedRuntime.exactOwned !== true ||
            startedRuntime.sessionId !== sessionId) {
          throw new Error("Owned runtime did not start with an exact session-bound identity");
        }
        const runningRuntime = await baseline.measure(
          "managed_call",
          "OwnedRuntimeManager.status",
          () => runtimeManager.status(startedRuntime.runtimeId),
          "representative_status_api"
        );
        if (runningRuntime.state !== "running" || runningRuntime.exactOwned !== true ||
            runningRuntime.sessionId !== sessionId) {
          throw new Error("Owned runtime status did not confirm the exact running process");
        }
        return { startedRuntime, runningRuntime };
      },
      "running_confirmation"
    );
    const { startedRuntime, runningRuntime } = launch;
    summary.runtimeStart = startedRuntime;
    summary.ownedRuntimePid = startedRuntime.pid;
    summary.runtimeStatus = runningRuntime;
    const runtimeLifecycle = await runtimeManager.lifecycleIdentity(startedRuntime.runtimeId);
    const fixtureContentIdentity = baselineFixtureContent?.sha256 ?? operationalBaselineProcedureSha256({ fixture: "no-generated-addon" });
    const generatedProjectIdentity = operationalBaselineProcedureSha256({
      preparedLaunchId,
      bundleDigest: prepared.bundleDigest,
    });
    const generatedAddonIdentity = fixture?.addonGuid ?? operationalBaselineProcedureSha256({ addon: "no-generated-addon" });
    const faultBinding = Object.freeze({
      fixtureId: fixture?.addonGuid ?? fixture?.addonId ?? "runtime-generated-fixture",
      lifecycleId: runtimeLifecycle.runtimeId,
      lifecycleGeneration: runtimeLifecycle.generation,
    });
    faultScaffolding = createFaultMatrixRunScaffolding({
      runRoot: runDirectory,
      controlRoot: join(runDirectory, "fault-control"),
      matrix: OBSERVER_FAULT_MATRIX,
      bootstrap: {
        schemaVersion: 1,
        runId: managedRunId!,
        backend: "runtime",
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
    const remainingForInventory = Math.max(1_000, deadline - Date.now());
    const inventory = await baseline.measure(
      "managed_call",
      "ObserverApplication.instances(renderersOnly)",
      () => application.instances({
        sessionId: sessionId ?? undefined,
        requiredCapabilities: ["render.capture", "camera.runtime"],
        renderersOnly: true,
        waitMs: remainingForInventory,
      }),
      "representative_observer_api"
    );
    const compatible = inventory.instances.filter((instance) =>
      instance.backend !== "workbench" && instance.sessionId === sessionId &&
      instance.runtimeKind === "listenServer" &&
      instance.stale !== true && instance.transportHealthy !== false && instance.headless === false &&
      Array.isArray(instance.capabilities) &&
      ["render.capture", "camera.runtime"].every((capability) =>
        (instance.capabilities as unknown[]).includes(capability)));
    if (compatible.length !== 1 || inventory.timedOut) {
      throw new Error(`Expected exactly one graphical runtime observer, found ${compatible.length}`);
    }
    const selected = compatible[0];
    const instanceId = String(selected.instanceId ?? "");
    const worldId = typeof selected.worldId === "string" ? selected.worldId : "";
    const worldEpoch = selected.worldEpoch;
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(instanceId) || !worldId ||
        !Number.isSafeInteger(worldEpoch) || (worldEpoch as number) < 0) {
      throw new Error("Selected graphical runtime has invalid instance/world identity");
    }
    summary.inventory = inventory;

    const captureTimeoutMs = Math.max(1_000, Math.min(120_000, deadline - Date.now()));
    const common = {
      runId: managedRunId,
      sessionId,
      instanceId,
      worldId,
      worldEpoch: worldEpoch as number,
      timeoutMs: captureTimeoutMs,
    };
    const initial = await captureIntoRun(application, {
      ...common,
      label: "initial-current",
      purpose: "Prove the initialized graphical runtime can produce a material current-view PNG",
      view: { kind: "current" },
    }, baseline);
    const diagnosticCaptures: Record<string, unknown>[] = [];
    diagnosticCaptures.push(retainDiagnosticCapture(diagnosticsRoot, initial));
    summary.diagnosticCaptures = diagnosticCaptures;
    const pose = await captureIntoRun(application, {
      ...common,
      label: "explicit-pose",
      purpose: "Prove explicit quaternion pose capture and its independent transactional restoration",
      view: poseView,
    }, baseline);
    diagnosticCaptures.push(retainDiagnosticCapture(diagnosticsRoot, pose));
    const poseLease = record(pose.job.cameraLease, "Explicit pose camera lease");
    if (poseLease.everHeld !== true || poseLease.held !== false ||
        poseLease.restorationConfirmed !== true) {
      throw new Error("Explicit pose did not prove camera acquisition followed by restoration");
    }
    const poseMatrix = assertRequestedPoseRendered(pose.metadata, poseView);
    const poseDifference: PngComparisonEvidence = comparePngImages(initial.image, pose.image, {
      channelTolerance: 8,
      minimumChangedPixelRatio: 0.01,
      minimumMeanAbsoluteError: 1.5,
    });
    if (!poseDifference.materiallyDifferent) {
      throw new Error("Initial and explicit-pose screenshots are not materially different");
    }
    const postPose = await captureIntoRun(application, {
      ...common,
      label: "post-pose-restoration-current",
      purpose: "Prove the runtime current camera was restored after the explicit pose capture",
      view: { kind: "current" },
    }, baseline);
    diagnosticCaptures.push(retainDiagnosticCapture(diagnosticsRoot, postPose));
    const postPoseDistanceMeters = assertCurrentViewReleasedFromDisplaced(
      poseMatrix,
      captureMatrix(postPose.metadata, "Post-pose-restoration capture")
    );
    if (typeof initial.metadata.actualFov === "number" &&
        typeof postPose.metadata.actualFov === "number" &&
        Math.abs(initial.metadata.actualFov - postPose.metadata.actualFov) > 0.1) {
      throw new Error("Post-pose-restoration current FOV does not match the pre-pose current FOV");
    }
    const poseRestorationSimilarity: PngComparisonEvidence = comparePngImages(
      initial.image,
      postPose.image,
      {
        channelTolerance: 8,
        maximumChangedPixelRatioForSimilarity: 0.25,
        maximumMeanAbsoluteErrorForSimilarity: 12,
      }
    );
    const poseRestorationImageDiagnostic = recordRestorationImageSimilarity(
      poseRestorationSimilarity
    );

    const lookAt = await captureIntoRun(application, {
      ...common,
      label: "explicit-look-at",
      purpose: "Prove explicit look-at capture and its independent transactional restoration",
      view: lookAtView,
    }, baseline);
    diagnosticCaptures.push(retainDiagnosticCapture(diagnosticsRoot, lookAt));
    const lookAtLease = record(lookAt.job.cameraLease, "Explicit look-at camera lease");
    if (lookAtLease.everHeld !== true || lookAtLease.held !== false ||
        lookAtLease.restorationConfirmed !== true) {
      throw new Error("Explicit look-at did not prove camera acquisition followed by restoration");
    }
    if (!isDeepStrictEqual(lookAt.metadata.requestedView, lookAtView)) {
      throw new Error("Explicit look-at metadata does not preserve the exact requested view");
    }
    const lookAtMatrix = captureMatrix(lookAt.metadata, "Explicit look-at capture");
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(lookAtMatrix[12 + axis] - lookAtView.position[axis]) > 0.05) {
        throw new Error(`Explicit look-at rendered position differs at axis ${axis}`);
      }
    }
    if (typeof lookAt.metadata.actualFov !== "number" ||
        Math.abs(lookAt.metadata.actualFov - lookAtView.fov) > 0.05) {
      throw new Error("Explicit look-at rendered FOV differs from the requested FOV");
    }
    const lookAtDifference: PngComparisonEvidence = comparePngImages(
      postPose.image,
      lookAt.image,
      {
        channelTolerance: 8,
        minimumChangedPixelRatio: 0.01,
        minimumMeanAbsoluteError: 1.5,
      }
    );
    if (!lookAtDifference.materiallyDifferent) {
      throw new Error("Pre-look-at current and explicit-look-at screenshots are not materially different");
    }
    const postLookAt = await captureIntoRun(application, {
      ...common,
      label: "post-look-at-restoration-current",
      purpose: "Prove the runtime current camera was restored after the explicit look-at capture",
      view: { kind: "current" },
    }, baseline);
    diagnosticCaptures.push(retainDiagnosticCapture(diagnosticsRoot, postLookAt));
    const postLookAtDistanceMeters = assertCurrentViewReleasedFromDisplaced(
      lookAtMatrix,
      captureMatrix(postLookAt.metadata, "Post-look-at-restoration capture")
    );
    if (typeof postPose.metadata.actualFov === "number" &&
        typeof postLookAt.metadata.actualFov === "number" &&
        Math.abs(postPose.metadata.actualFov - postLookAt.metadata.actualFov) > 0.1) {
      throw new Error("Post-look-at-restoration current FOV does not match the pre-look-at current FOV");
    }
    const lookAtRestorationSimilarity: PngComparisonEvidence = comparePngImages(
      postPose.image,
      postLookAt.image,
      {
        channelTolerance: 8,
        maximumChangedPixelRatioForSimilarity: 0.25,
        maximumMeanAbsoluteErrorForSimilarity: 12,
      }
    );
    const lookAtRestorationImageDiagnostic = recordRestorationImageSimilarity(
      lookAtRestorationSimilarity
    );
    let marker: ColorMarkerEvidence | null = null;
    if (options.marker) {
      marker = detectPngColorMarker(lookAt.image, options.marker);
      if (!marker.detected) throw new Error("Configured deterministic color marker was not detected");
    }
    const captures = [initial, pose, postPose, lookAt, postLookAt];
    summary.captureValidation = {
      captures: captures.map((capture) => ({ label: capture.label, png: capture.png })),
      pose: {
        requestedView: poseView,
        renderedMatrix: poseMatrix,
        differenceFromPreCapture: poseDifference,
        restorationOracle: {
          leaseEverHeld: true,
          leaseRestorationConfirmed: true,
          postReleasedFromExplicitView: true,
          postDistanceFromExplicitViewMeters: postPoseDistanceMeters,
        },
        restorationImageDiagnostic: poseRestorationImageDiagnostic,
      },
      lookAt: {
        requestedView: lookAtView,
        renderedMatrix: lookAtMatrix,
        differenceFromPreCapture: lookAtDifference,
        restorationOracle: {
          leaseEverHeld: true,
          leaseRestorationConfirmed: true,
          postReleasedFromExplicitView: true,
          postDistanceFromExplicitViewMeters: postLookAtDistanceMeters,
        },
        restorationImageDiagnostic: lookAtRestorationImageDiagnostic,
      },
      marker,
    };

    const finalizedResult = await application.finalizeRun({
      runId: managedRunId,
      evidenceRoot,
      includeCaptureLabels: [...CAPTURE_LABELS],
      review: {
        imagesReviewed: false,
        outcome: "Unreviewed",
        summary: "Automation validated PNG structure, material image content, exact explicit-pose execution, explicit look-at execution, independent camera-lease restoration after each mode, and bundle integrity.",
        limitations: [
          "No image-capable human reviewed this automated acceptance bundle.",
          "Each pre/post-restoration pixel comparison is diagnostic only because a live current camera may move or rotate naturally between captures.",
        ],
      },
      runtimeConfig: {
        configurationId: "runtime-observer-acceptance-v2",
        values: {
          worldResource,
          fixtureAddonId: fixture?.addonId ?? null,
          fixtureAddonGuid: fixture?.addonGuid ?? null,
          executable: basename(executable),
          captureSequence: [...CAPTURE_LABELS],
          poseView,
          lookAtView,
          markerConfigured: options.marker !== undefined,
          restorationImageDiagnosticOnly: true,
          poseRestorationImageMateriallySimilar: poseRestorationSimilarity.materiallySimilar,
          poseRestorationImageChangedPixelRatio: poseRestorationSimilarity.changedPixelRatio,
          poseRestorationImageMeanAbsoluteError: poseRestorationSimilarity.meanAbsoluteError,
          postPoseDistanceMeters,
          lookAtRestorationImageMateriallySimilar: lookAtRestorationSimilarity.materiallySimilar,
          lookAtRestorationImageChangedPixelRatio: lookAtRestorationSimilarity.changedPixelRatio,
          lookAtRestorationImageMeanAbsoluteError: lookAtRestorationSimilarity.meanAbsoluteError,
          postLookAtDistanceMeters,
        },
      },
      releaseManagedArtifacts: true,
    });
    // The managed run is immutable once finalize returns, even if this
    // harness's independent bundle verification subsequently finds a defect.
    finalized = true;
    const verified = verifyEvidenceBundle(evidenceRoot, managedRunId, finalizedResult, captures);
    evidenceDirectory = verified.evidenceDirectory;
    summary.finalize = finalizedResult;
    summary.bundleVerification = verified;
    summary.status = "passed";
  } catch (error) {
    failure = error;
    summary.status = "failed";
    summary.failure = error instanceof Error
      ? { name: error.name, message: error.message }
      : String(error);
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
    if (!finalized && managedRunId) {
      let safeToDiscard = sessionId === null;
      if (sessionId) {
        try {
          await cancelRunJobs(application, sessionId, managedRunId, Date.now() + 30_000);
          summary.jobCleanup = "restored";
          safeToDiscard = true;
        } catch (error) {
          failure ??= error;
          summary.jobCleanup = error instanceof Error ? error.message : String(error);
          summary.status = "failed";
        }
      }
      if (safeToDiscard) {
        try {
          summary.runDiscard = await application.discardRun(managedRunId);
        } catch (error) {
          failure ??= error;
          summary.runDiscard = error instanceof Error ? error.message : String(error);
          summary.status = "failed";
        }
      } else {
        summary.runDiscard = "preserved because restored terminal job state was not proven";
      }
    }
    let exactRuntimeVacancy = runtimeId === null;
    if (runtimeId) {
      const ownedRuntimeId = runtimeId;
      const terminationSpan = baseline.start(
        "shutdown",
        "OwnedRuntimeManager.stop",
        "termination"
      );
      const observerCleanupSpan = baseline.start(
        "shutdown",
        "OwnedRuntimeManager.stop",
        "observer_cleanup"
      );
      let terminationRecorded = false;
      let observerCleanupRecorded = false;
      try {
        const stoppedRuntime = await runtimeManager.stop({
          runtimeId,
          waitForRestorationMs: 20_000,
          idempotencyKey: `runtime-stop-${randomUUID()}`,
        });
        summary.runtimeShutdown = stoppedRuntime;
        if (stoppedRuntime.state !== "exited" || stoppedRuntime.exactOwned !== true ||
            stoppedRuntime.identityVacant !== true || stoppedRuntime.terminationComplete !== true ||
            stoppedRuntime.observerCleanupPending !== false || !stoppedRuntime.stoppedAt) {
          throw new Error(
            "Owned runtime stop did not prove exact termination and completed observer cleanup"
          );
        }
        const terminationFinishedMs = Date.parse(stoppedRuntime.stoppedAt);
        const terminationStartedMs = Date.parse(terminationSpan.startedAt);
        if (!Number.isFinite(terminationFinishedMs) || terminationFinishedMs < terminationStartedMs) {
          throw new Error("Owned runtime stop returned an invalid durable termination timestamp");
        }
        baseline.finish(terminationSpan, {
          finishedAt: new Date(terminationFinishedMs).toISOString(),
          durationMs: terminationFinishedMs - terminationStartedMs,
          observations: {
            terminationComplete: true,
            identityVacant: true,
            durableStoppedAt: true,
          },
        });
        terminationRecorded = true;
        baseline.finish(observerCleanupSpan, {
          observations: { observerCleanupPending: false },
        });
        observerCleanupRecorded = true;
        const vacantRuntime = await baseline.measure(
          "managed_call",
          "OwnedRuntimeManager.status(after stop)",
          () => runtimeManager.status(ownedRuntimeId),
          "shutdown_status_confirmation"
        );
        summary.runtimeVacancy = vacantRuntime;
        if (vacantRuntime.state !== "exited" || vacantRuntime.exactOwned !== true ||
            vacantRuntime.identityVacant !== true || vacantRuntime.terminationComplete !== true ||
            vacantRuntime.observerCleanupPending !== false) {
          throw new Error("Owned runtime stop did not prove exact-process vacancy");
        }
        exactRuntimeVacancy = true;
      } catch (error) {
        if (!terminationRecorded) {
          try {
            baseline.finish(terminationSpan, {
              outcome: "failed",
              errorName: error instanceof Error ? error.name : "NonErrorThrow",
            });
          } catch { /* the primary shutdown failure remains authoritative */ }
        }
        if (!observerCleanupRecorded) {
          try {
            baseline.finish(observerCleanupSpan, {
              outcome: "failed",
              errorName: error instanceof Error ? error.name : "NonErrorThrow",
            });
          } catch { /* the primary shutdown failure remains authoritative */ }
        }
        failure ??= error;
        summary.runtimeShutdown = error instanceof Error ? error.message : String(error);
        summary.status = "failed";
      }
    }
    if (sessionId) {
      const confirmedSessionId = sessionId;
      if (exactRuntimeVacancy) {
        try {
          summary.sessionRevoke = await baseline.measure(
            "shutdown",
            "ObserverApplication.revokeSession",
            () => application.revokeSession(confirmedSessionId),
            "observer_cleanup_confirmation"
          );
        } catch (error) {
          failure ??= error;
          summary.sessionRevoke = error instanceof Error ? error.message : String(error);
          summary.status = "failed";
        }
      } else {
        summary.sessionRevoke = "preserved because exact-process vacancy was not proven";
      }
    }
    try {
      summary.runtimeLifecycleShutdown = await baseline.measure(
        "shutdown",
        "ObserverApplication.close",
        () => closeObserverRuntimeLifecycle(runtimeManager, application),
        "observer_process_cleanup"
      );
      summary.applicationShutdown = "complete";
    } catch (error) {
      failure ??= error;
      summary.applicationShutdown = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
    }
    try {
      assertArmaVacant("Live runtime observer acceptance cleanup");
      summary.processVacancy = "proven";
    } catch (error) {
      failure ??= error;
      summary.processVacancy = error instanceof Error ? error.message : String(error);
      summary.status = "failed";
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
    if (!failure && summary.status === "passed") {
      try {
        summary.scratchCleanup = {
          profiles: removeOwnedScratch(runDirectory, profileRoot, "Owned observer profile scratch"),
          managed: removeOwnedScratch(runDirectory, managedRoot, "Owned observer managed scratch"),
          diagnostics: removeOwnedScratch(runDirectory, diagnosticsRoot, "Owned observer diagnostic scratch"),
        };
      } catch (error) {
        failure = error;
        summary.scratchCleanup = error instanceof Error ? error.message : String(error);
        summary.status = "failed";
      }
    }
    baseline.sampleProcessCounts("rest.afterShutdown");
    try {
      const baselineFailed = Boolean(failure) || summary.status !== "passed";
      const artifact = baseline.artifact({
        result: baselineFailed ? "failed" : "passed",
        environment: baselineEnvironment,
        workload: {
          procedureRevision: "runtime-observer-acceptance-v2",
          runtimeKind: "listenServer",
          overallTimeoutMs: timeoutMs,
          worldResource,
          fixture: fixture && baselineFixtureContent ? {
            kind: "addon",
            id: fixture.addonId,
            guid: fixture.addonGuid,
            sourceFileCount: baselineFixtureContent.fileCount,
            sourceSha256: baselineFixtureContent.sha256,
          } : null,
          capture: {
            labels: [...CAPTURE_LABELS],
            settleFrames: 3,
            performancePolicy: "evidence",
            asynchronous: false,
            configurationSha256: baselineCaptureConfigurationSha256,
          },
          launchArguments: baselineLaunchArguments,
        },
        source: baselineSource,
        limitations: [
          "Descriptive controlled-run baseline only; no timing or process-count thresholds are applied.",
          "Supervised counts combine ChildSupervisor-managed owned-runtime children with count-only ObserverApplication private-child tracking through actual child exit.",
          "The termination duration ends at the durable stoppedAt timestamp; observer-cleanup duration ends only after stop returns observerCleanupPending=false.",
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
    error.message = `${error.message}. Retained runtime observer acceptance summary: ${summaryPath}`;
    throw error;
  }
  return { runDirectory, summaryPath, evidenceDirectory, baselinePath, summary };
}

const RUNTIME_SINGLETON_CLI_FLAGS = new Set<string>([
  "--help", "-h", "--list-cases", "--confirm-live-run", "--keep-profile",
]);

const RUNTIME_SINGLETON_CLI_VALUE_OPTIONS = new Set<string>([
  "--config", "--only", "--world", "--addon-dir", "--executable", "--artifact-root",
  "--validation-root", "--timeout-ms", "--pose-position", "--pose-orientation",
  "--pose-fov", "--look-at-position", "--look-at-target", "--look-at-fov",
  "--marker-rgb", "--marker-roi",
]);

const RUNTIME_REPEATABLE_CLI_VALUE_OPTIONS = new Set<string>(["--launch-arg"]);

export interface ParsedRuntimeCliArguments {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly repeatedValues: ReadonlyMap<string, readonly string[]>;
}

export function parseRuntimeCliArguments(
  argv: readonly string[]
): ParsedRuntimeCliArguments {
  const seenSingletons = new Set<string>();
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const repeatedValues = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (RUNTIME_SINGLETON_CLI_FLAGS.has(name)) {
      const key = name === "-h" ? "--help" : name;
      if (seenSingletons.has(key)) throw new Error(`${name} may be specified only once`);
      seenSingletons.add(key);
      flags.add(key);
      continue;
    }
    if (RUNTIME_SINGLETON_CLI_VALUE_OPTIONS.has(name)) {
      if (seenSingletons.has(name)) throw new Error(`${name} may be specified only once`);
      seenSingletons.add(name);
      const value = argv[index + 1];
      if (
        !value ||
        value.startsWith("--") ||
        RUNTIME_SINGLETON_CLI_FLAGS.has(value) ||
        RUNTIME_SINGLETON_CLI_VALUE_OPTIONS.has(value) ||
        RUNTIME_REPEATABLE_CLI_VALUE_OPTIONS.has(value)
      ) {
        throw new Error(`${name} requires a value`);
      }
      values.set(name, value);
      index += 1;
      continue;
    }
    if (RUNTIME_REPEATABLE_CLI_VALUE_OPTIONS.has(name)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${name} requires a value`);
      const existing = repeatedValues.get(name) ?? [];
      existing.push(value);
      repeatedValues.set(name, existing);
      index += 1;
      continue;
    }
    throw new Error(`Unknown runtime observer acceptance argument: ${name}`);
  }
  return { flags, values, repeatedValues };
}

export function parseVector3(value: string, label: string): Vector3 {
  const parts = value.split(",").map((item) => Number(item.trim()));
  if (parts.length !== 3 || parts.some((item) => !Number.isFinite(item))) {
    throw new Error(`${label} must contain three comma-separated finite numbers`);
  }
  return parts as Vector3;
}

export function parseQuaternion(value: string, label: string): Quaternion {
  const parts = value.split(",").map((item) => Number(item.trim()));
  if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
    throw new Error(`${label} must contain four comma-separated finite numbers`);
  }
  const length = Math.hypot(...parts);
  if (length < 0.999 || length > 1.001) {
    throw new Error(`${label} must be a normalized quaternion`);
  }
  return parts as Quaternion;
}

function parseMarker(
  rawColor: string | undefined,
  rawRoi: string | undefined
): RuntimeObserverMarkerExpectation | undefined {
  if (!rawColor) return undefined;
  const color = parseVector3(rawColor, "Marker RGB");
  if (color.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("Marker RGB channels must be integers from 0 through 255");
  }
  let roi: NormalizedImageRegion | undefined;
  if (rawRoi) {
    const parts = rawRoi.split(",").map((item) => Number(item.trim()));
    if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
      throw new Error("Marker ROI must contain x,y,width,height normalized fractions");
    }
    roi = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return { color: color as [number, number, number], ...(roi ? { roi } : {}) };
}

function usage(): string {
  return [
    "Usage: npm run dev:observer:acceptance:runtime -- --config <file> --confirm-live-run [--world <resource>]",
    "       [--addon-dir <directory>] [--executable <file>] [--artifact-root <directory>]",
    "       [--validation-root <directory>]",
    "       [--timeout-ms <60000..900000>] [--launch-arg <token>]...",
    "       [--pose-position <x,y,z>] [--pose-orientation <x,y,z,w>] [--pose-fov <degrees>]",
    "       [--look-at-position <x,y,z>] [--look-at-target <x,y,z>] [--look-at-fov <degrees>]",
    "       [--marker-rgb <r,g,b>] [--marker-roi <x,y,width,height>]",
    "",
    "Fault-matrix mode:",
    "  npm run dev:observer:acceptance:runtime -- --config <file> --only <case-id> --confirm-live-run",
    "       [--keep-profile] [--executable <file>] [--artifact-root <directory>] [--validation-root <directory>]",
    "  npm run dev:observer:acceptance:runtime -- --list-cases",
    "Matrix mode always creates and validates its own disposable fixture; it rejects --addon-dir.",
    "--keep-profile is valid only together with --only, and only preserves scratch on a failed case.",
    "",
    `Required environment: ${LIVE_RUNTIME_OBSERVER_ENVIRONMENT}=1`,
    `Default world: ${DEFAULT_RUNTIME_OBSERVER_WORLD}`,
    "The default is an installed stock fixture; all harness roots are external to the current project.",
    "",
  ].join("\n");
}

async function runCli(): Promise<void> {
  const parsed = parseRuntimeCliArguments(process.argv.slice(2));
  const readFlag = (name: string): boolean => parsed.flags.has(name === "-h" ? "--help" : name);
  const readOption = (name: string): string | undefined => parsed.values.get(name);
  const readOptions = (name: string): string[] => [
    ...(parsed.repeatedValues.get(name) ?? []),
  ];
  if (readFlag("--help")) {
    process.stdout.write(usage());
    return;
  }
  if (readFlag("--list-cases")) {
    for (const item of OBSERVER_FAULT_MATRIX.cases) {
      if (item.backend === "runtime") process.stdout.write(`${item.id}\n`);
    }
    return;
  }
  const environment = process.env;
  const configPath = readOption("--config");
  if (!configPath) {
    throw new Error("Live runtime observer acceptance requires --config <file>");
  }
  const only = readOption("--only");
  const keepProfile = readFlag("--keep-profile");
  if (keepProfile && !only) {
    throw new Error("--keep-profile is valid only together with --only");
  }
  if (only !== undefined) {
    const addonDir = readOption("--addon-dir");
    if (addonDir) {
      throw new Error("--only (fault-matrix mode) rejects a user-selected --addon-dir; it always creates its own fixture");
    }
    const result = await runRuntimeFailureMatrix({
      confirmed: readFlag("--confirm-live-run"),
      configPath,
      environment,
      worldResource: readOption("--world"),
      executablePath: readOption("--executable"),
      artifactRoot: readOption("--artifact-root"),
      validationRoot: readOption("--validation-root"),
      launchArguments: readOptions("--launch-arg"),
      only,
      keepProfile,
    });
    process.stdout.write(
      `Runtime failure-matrix case passed.\n` +
      `RFO_RUNTIME_FAILURE_MATRIX_JSON=${result.jsonPath}\n` +
      `RFO_RUNTIME_FAILURE_MATRIX_MARKDOWN=${result.markdownPath}\n`
    );
    return;
  }
  const worldResource = readOption("--world");
  const posePosition = readOption("--pose-position");
  const poseOrientation = readOption("--pose-orientation");
  const poseFov = readOption("--pose-fov");
  const lookAtPosition = readOption("--look-at-position");
  const lookAtTarget = readOption("--look-at-target");
  const lookAtFov = readOption("--look-at-fov");
  const timeout = readOption("--timeout-ms");
  const result = await runRuntimeObserverAcceptance({
    confirmed: readFlag("--confirm-live-run"),
    configPath,
    environment,
    worldResource,
    addonDirectory: readOption("--addon-dir"),
    executablePath: readOption("--executable"),
    artifactRoot: readOption("--artifact-root"),
    validationRoot: readOption("--validation-root"),
    timeoutMs: timeout ? Number(timeout) : undefined,
    launchArguments: readOptions("--launch-arg"),
    posePosition: posePosition ? parseVector3(posePosition, "Pose position") : undefined,
    poseOrientation: poseOrientation
      ? parseQuaternion(poseOrientation, "Pose orientation")
      : undefined,
    poseFov: poseFov ? Number(poseFov) : undefined,
    lookAtPosition: lookAtPosition ? parseVector3(lookAtPosition, "Look-at position") : undefined,
    lookAtTarget: lookAtTarget ? parseVector3(lookAtTarget, "Look-at target") : undefined,
    lookAtFov: lookAtFov ? Number(lookAtFov) : undefined,
    marker: parseMarker(readOption("--marker-rgb"), readOption("--marker-roi")),
  });
  process.stdout.write(
    `Runtime observer acceptance passed.\n` +
    `RFO_RUNTIME_OBSERVER_ACCEPTANCE_RESULT=${result.summaryPath}\n` +
    `RFO_RUNTIME_OBSERVER_EVIDENCE=${result.evidenceDirectory}\n` +
    `RFO_RUNTIME_OPERATIONAL_BASELINE=${result.baselinePath}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
