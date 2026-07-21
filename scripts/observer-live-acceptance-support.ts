import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  platform,
  release,
  totalmem,
} from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { redactArguments, redactText } from "#foundation/redact";
import {
  caseForId,
  isCanonicalFaultMatrixTerminal,
  type FaultMatrix,
  type FaultMatrixBackend,
  type MatrixEvidenceField,
} from "../observer/protocol/fault-matrix.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 64 * 1024 * 1024;
// The shared matrix identity adds five explicit source members to the
// backend-specific baseline lists; keep the manifest bounded without making
// Workbench's 36-member closure impossible to publish.
const MAX_MEASURED_SOURCE_IDENTITIES = 64;
const MAX_PNG_PIXELS = 32_000_000;

const BLOCKING_PROCESS_NAMES = new Set([
  "armareforger",
  "armareforgerdiag",
  "armareforgersteam",
  "armareforgersteamdiag",
  "armareforgerserver",
  "armareforgerserverdiag",
  "armareforgerserversteam",
  "armareforgerserversteamdiag",
  "armareforgerworkbench",
  "armareforgerworkbenchdiag",
  "armareforgerworkbenchsteam",
  "armareforgerworkbenchsteamdiag",
]);

export type OperationalBaselineBackend = "workbench" | "runtime";
export type OperationalBaselineBoundary =
  | "launch"
  | "managed_call"
  | "capture"
  | "shutdown";

export interface AcceptanceSupervisedProcessCounts {
  active: number;
  reconciling: number;
  total: number;
}

export interface OperationalBaselineVacancyWaitResult {
  vacant: boolean;
  timeoutMs: number;
  pollIntervalMs: number;
  polls: number;
  waitedMs: number;
  counts: AcceptanceSupervisedProcessCounts;
}

export interface OperationalBaselineProcessSample extends AcceptanceSupervisedProcessCounts {
  label: string;
  at: string;
}

export interface OperationalBaselineMeasurement {
  boundary: OperationalBaselineBoundary;
  operation: string;
  phase: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "passed" | "failed";
  processCountBefore: AcceptanceSupervisedProcessCounts;
  processCountAfter: AcceptanceSupervisedProcessCounts;
  observations?: Record<string, string | number | boolean | null>;
  errorName?: string;
}

export interface ExecutableVersionEvidence {
  executable: string;
  version: string | null;
  fileVersion: string | null;
  discovery: "windows_file_metadata" | "unavailable";
}

export interface OperationalBaselineEnvironment {
  node: {
    version: string;
    architecture: string;
  };
  operatingSystem: {
    platform: string;
    release: string;
    architecture: string;
  };
  machineClass: {
    cpuModel: string;
    logicalCpuCount: number;
    totalMemoryGiB: number;
  };
  workbench: ExecutableVersionEvidence | null;
  game: ExecutableVersionEvidence | null;
}

export interface OperationalBaselineSourceIdentity {
  path: string;
  sha256: string;
}

export interface OperationalBaselineSourceClosure {
  /** Repository-relative glob-like label written to the artifact. */
  path: string;
  /** Repository-relative directory whose matching files form the closure. */
  directory: string;
  extension: `.${string}`;
}

export interface OperationalBaselineLaunchArguments {
  observed: boolean;
  count: number;
  sha256: string;
  normalization: "absolute_paths_and_owner_tokens_redacted_v1";
}

export interface OperationalBaselineFixtureIdentity {
  kind: "disposable_workbench_world" | "addon";
  id: string;
  guid: string | null;
  sourceFileCount: number;
  sourceSha256: string;
}

export interface OperationalBaselineWorkload {
  procedureRevision: string;
  runtimeKind: "workbench" | "listenServer";
  overallTimeoutMs: number;
  worldResource: string;
  fixture: OperationalBaselineFixtureIdentity | null;
  capture: {
    labels: string[];
    settleFrames: number;
    performancePolicy: "evidence";
    asynchronous: boolean;
    configurationSha256: string;
  };
  launchArguments: OperationalBaselineLaunchArguments;
}

export interface OperationalBaselineArtifact {
  schemaVersion: 1;
  kind:
    | "reforger_forge_workbench_operational_baseline"
    | "reforger_forge_runtime_operational_baseline";
  backend: OperationalBaselineBackend;
  result: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: OperationalBaselineEnvironment;
  workload: OperationalBaselineWorkload;
  source: {
    harness: OperationalBaselineSourceIdentity;
    recorder: OperationalBaselineSourceIdentity;
    measured: OperationalBaselineSourceIdentity[];
  };
  measurements: OperationalBaselineMeasurement[];
  processCounts: OperationalBaselineProcessSample[];
  thresholds: null;
  limitations: string[];
  failure: { name: string } | null;
}

export interface OperationalBaselineClock {
  wallNow(): Date;
  monotonicNow(): number;
}

export interface OperationalBaselineSpan {
  boundary: OperationalBaselineBoundary;
  operation: string;
  phase: string;
  startedAt: string;
  startedMonotonicMs: number;
  processCountBefore: AcceptanceSupervisedProcessCounts;
}

export interface CompleteSpanOptions {
  outcome?: "passed" | "failed";
  errorName?: string;
  /** Use only for a durable event timestamp observed when the operation resolves. */
  finishedAt?: string;
  durationMs?: number;
  observations?: Record<string, string | number | boolean | null>;
}

export interface OperationalBaselineRecorderOptions {
  backend: OperationalBaselineBackend;
  readSupervisedProcessCounts: () => AcceptanceSupervisedProcessCounts;
  clock?: OperationalBaselineClock;
}

const SYSTEM_CLOCK: OperationalBaselineClock = {
  wallNow: () => new Date(),
  monotonicNow: () => performance.now(),
};

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative`);
  return value;
}

function processCounts(
  value: AcceptanceSupervisedProcessCounts
): AcceptanceSupervisedProcessCounts {
  const active = finiteNonNegative(value.active, "Active supervised process count");
  const reconciling = finiteNonNegative(
    value.reconciling,
    "Reconciling supervised process count"
  );
  const total = finiteNonNegative(value.total, "Total supervised process count");
  if (![active, reconciling, total].every(Number.isSafeInteger) || total !== active + reconciling) {
    throw new Error("Supervised process counts must be safe integers whose total equals active plus reconciling");
  }
  return { active, reconciling, total };
}

export async function waitForOperationalBaselineProcessVacancy(
  readCounts: () => AcceptanceSupervisedProcessCounts,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    monotonicNow?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {}
): Promise<OperationalBaselineVacancyWaitResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > timeoutMs) {
    throw new Error("Operational baseline vacancy-wait bounds are invalid");
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wait = options.wait ?? (async (milliseconds: number) => delay(milliseconds));
  const startedAt = monotonicNow();
  if (!Number.isFinite(startedAt)) throw new Error("Operational baseline vacancy-wait clock is invalid");
  let polls = 0;
  for (;;) {
    const counts = processCounts(readCounts());
    polls += 1;
    const now = monotonicNow();
    if (!Number.isFinite(now) || now < startedAt) {
      throw new Error("Operational baseline vacancy-wait clock moved backwards");
    }
    const waitedMs = Number((now - startedAt).toFixed(3));
    if (counts.total === 0 || waitedMs >= timeoutMs) {
      return {
        vacant: counts.total === 0,
        timeoutMs,
        pollIntervalMs,
        polls,
        waitedMs,
        counts,
      };
    }
    await wait(Math.min(pollIntervalMs, timeoutMs - waitedMs));
  }
}

function isoTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function portableIsAbsolute(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function validRepositoryRelativeSourcePath(path: string): boolean {
  return Boolean(path) && path.length <= 160 && path === path.replace(/\\/g, "/") &&
    !portableIsAbsolute(path) && !/[\0\r\n]/.test(path) &&
    path.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..");
}

function validateSourceIdentity(source: OperationalBaselineSourceIdentity): void {
  if (!/^[a-f0-9]{64}$/.test(source.sha256) ||
      !validRepositoryRelativeSourcePath(source.path)) {
    throw new Error("Operational baseline source identity is invalid");
  }
}

function compareSourcePath(
  left: OperationalBaselineSourceIdentity,
  right: OperationalBaselineSourceIdentity
): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 12) throw new Error("Operational baseline canonical value is too deeply nested");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Operational baseline canonical number must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") {
    if (value.length > 32_768 || /\0/.test(value)) {
      throw new Error("Operational baseline canonical string is invalid");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 512) throw new Error("Operational baseline canonical array is too large");
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (!value || typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("Operational baseline canonical value must contain plain data");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 128) throw new Error("Operational baseline canonical object is too large");
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => {
    if (!key || key.length > 160 || /[\0\r\n]/.test(key) || item === undefined) {
      throw new Error("Operational baseline canonical object key or value is invalid");
    }
    return `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`;
  }).join(",")}}`;
}

export function operationalBaselineProcedureSha256(value: unknown): string {
  return createHash("sha256")
    .update("rfo-operational-baseline-procedure-v1\0")
    .update(canonicalJson(value))
    .digest("hex");
}

export function operationalBaselineLaunchArgumentIdentity(
  argumentsArray: readonly string[],
  observed = true
): OperationalBaselineLaunchArguments {
  if (!Array.isArray(argumentsArray) || argumentsArray.length > 512 ||
      argumentsArray.some((token) => typeof token !== "string" || token.length > 32_768 || /[\0\r\n]/.test(token))) {
    throw new Error("Operational baseline launch arguments are invalid");
  }
  const canonicalArguments = redactArguments(argumentsArray, {
    profile: "evidence_portability",
    replacement: "<redacted>",
  });
  const sha256 = createHash("sha256")
    .update("rfo-operational-baseline-launch-arguments-v1\0")
    .update(canonicalJson(canonicalArguments))
    .digest("hex");
  return {
    observed,
    count: argumentsArray.length,
    sha256,
    normalization: "absolute_paths_and_owner_tokens_redacted_v1",
  };
}

function aggregateContentMembers(
  members: Array<{ path: string; sha256: string }>,
  domain: string
): string {
  members.sort(compareSourcePath);
  const hash = createHash("sha256");
  hash.update(`${domain}\0`);
  for (const member of members) {
    hash.update(member.path);
    hash.update("\0");
    hash.update(member.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function operationalBaselineDirectoryIdentity(
  directoryPath: string,
  extensions: readonly `.${string}`[]
): { fileCount: number; sha256: string } {
  const normalizedExtensions = [...new Set(extensions.map((extension) => extension.toLowerCase()))]
    .sort();
  if (normalizedExtensions.length < 1 || normalizedExtensions.length > 32 ||
      normalizedExtensions.some((extension) => !/^\.[a-z0-9]+$/.test(extension))) {
    throw new Error("Operational baseline content extensions are invalid");
  }
  const root = resolve(directoryPath);
  const rootEntry = lstatSync(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error("Operational baseline content root must be a non-symlink directory");
  }
  const members: Array<{ path: string; sha256: string }> = [];
  let totalBytes = 0;
  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const memberPath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absoluteMemberPath = join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Operational baseline content root must not contain symbolic links");
      }
      if (entry.isDirectory()) {
        visit(absoluteMemberPath, memberPath);
        continue;
      }
      if (!entry.isFile() || !normalizedExtensions.some((extension) =>
        entry.name.toLowerCase().endsWith(extension))) continue;
      if (!memberPath || memberPath.length > 512 || /[\0\r\n]/.test(memberPath) ||
          memberPath.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error("Operational baseline content member path is invalid");
      }
      const memberEntry = lstatSync(absoluteMemberPath);
      if (!memberEntry.isFile() || memberEntry.isSymbolicLink() || memberEntry.size > 64 * 1024 * 1024) {
        throw new Error("Operational baseline content member is not a bounded regular file");
      }
      totalBytes += memberEntry.size;
      if (totalBytes > 256 * 1024 * 1024 || members.length >= 512) {
        throw new Error("Operational baseline content closure is too large");
      }
      members.push({
        path: memberPath.replace(/\\/g, "/"),
        sha256: createHash("sha256").update(readFileSync(absoluteMemberPath)).digest("hex"),
      });
    }
  };
  visit(root, "");
  if (members.length < 1) throw new Error("Operational baseline content closure is empty");
  return {
    fileCount: members.length,
    sha256: aggregateContentMembers(members, "rfo-operational-baseline-content-closure-v1"),
  };
}

function assertExactObjectKeys(
  value: unknown,
  expected: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length ||
      actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function validateWorkload(
  workload: OperationalBaselineWorkload,
  backend: OperationalBaselineBackend,
  result: "passed" | "failed"
): void {
  assertExactObjectKeys(workload, [
    "procedureRevision",
    "runtimeKind",
    "overallTimeoutMs",
    "worldResource",
    "fixture",
    "capture",
    "launchArguments",
  ], "Operational baseline workload");
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(workload.procedureRevision) ||
      !Number.isSafeInteger(workload.overallTimeoutMs) ||
      workload.overallTimeoutMs < 60_000 || workload.overallTimeoutMs > 900_000 ||
      !workload.worldResource || workload.worldResource.length > 1_024 ||
      /[\0\r\n]/.test(workload.worldResource) || portableIsAbsolute(workload.worldResource) ||
      workload.worldResource.replace(/\\/g, "/").split("/").includes("..")) {
    throw new Error("Operational baseline workload identity is invalid");
  }
  if ((backend === "workbench" && workload.runtimeKind !== "workbench") ||
      (backend === "runtime" && workload.runtimeKind !== "listenServer")) {
    throw new Error("Operational baseline workload runtime kind disagrees with its backend");
  }
  if (workload.fixture === null) {
    if (backend === "workbench") {
      throw new Error("Workbench operational baseline requires a disposable fixture identity");
    }
  } else {
    assertExactObjectKeys(workload.fixture, [
      "kind", "id", "guid", "sourceFileCount", "sourceSha256",
    ], "Operational baseline fixture identity");
    if ((backend === "workbench" && workload.fixture.kind !== "disposable_workbench_world") ||
        (backend === "runtime" && workload.fixture.kind !== "addon") ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(workload.fixture.id) ||
        (workload.fixture.guid !== null && !/^[A-F0-9]{16}$/.test(workload.fixture.guid)) ||
        !Number.isSafeInteger(workload.fixture.sourceFileCount) ||
        workload.fixture.sourceFileCount < 1 || workload.fixture.sourceFileCount > 512 ||
        !/^[a-f0-9]{64}$/.test(workload.fixture.sourceSha256)) {
      throw new Error("Operational baseline fixture identity is invalid");
    }
  }
  assertExactObjectKeys(workload.capture, [
    "labels", "settleFrames", "performancePolicy", "asynchronous", "configurationSha256",
  ], "Operational baseline capture workload");
  if (!Array.isArray(workload.capture.labels) || workload.capture.labels.length < 1 ||
      workload.capture.labels.length > 16 ||
      workload.capture.labels.some((label) =>
        typeof label !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(label)) ||
      new Set(workload.capture.labels).size !== workload.capture.labels.length ||
      !Number.isSafeInteger(workload.capture.settleFrames) ||
      workload.capture.settleFrames < 0 || workload.capture.settleFrames > 1_000 ||
      workload.capture.performancePolicy !== "evidence" ||
      typeof workload.capture.asynchronous !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(workload.capture.configurationSha256)) {
    throw new Error("Operational baseline capture workload is invalid");
  }
  assertExactObjectKeys(workload.launchArguments, [
    "observed", "count", "sha256", "normalization",
  ], "Operational baseline launch-argument identity");
  if (typeof workload.launchArguments.observed !== "boolean" ||
      !Number.isSafeInteger(workload.launchArguments.count) ||
      workload.launchArguments.count < 0 || workload.launchArguments.count > 512 ||
      !/^[a-f0-9]{64}$/.test(workload.launchArguments.sha256) ||
      workload.launchArguments.normalization !== "absolute_paths_and_owner_tokens_redacted_v1" ||
      (result === "passed" && (!workload.launchArguments.observed ||
        workload.launchArguments.count < 1))) {
    throw new Error("Operational baseline launch-argument identity is invalid");
  }
}

/**
 * Small, acceptance-only measurement collector. It records observations but
 * deliberately contains no thresholds, aggregation, or production hooks.
 */
export class OperationalBaselineRecorder {
  readonly backend: OperationalBaselineBackend;
  readonly startedAt: string;
  private readonly startedMonotonicMs: number;
  private readonly readCounts: () => AcceptanceSupervisedProcessCounts;
  private readonly clock: OperationalBaselineClock;
  private readonly measurements: OperationalBaselineMeasurement[] = [];
  private readonly samples: OperationalBaselineProcessSample[] = [];

  constructor(options: OperationalBaselineRecorderOptions) {
    this.backend = options.backend;
    this.readCounts = options.readSupervisedProcessCounts;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.startedAt = this.clock.wallNow().toISOString();
    this.startedMonotonicMs = this.clock.monotonicNow();
  }

  sampleProcessCounts(label: string): AcceptanceSupervisedProcessCounts {
    if (!label || label.length > 512 || /[\0\r\n]/.test(label)) {
      throw new Error("Process-count sample label is invalid");
    }
    const counts = processCounts(this.readCounts());
    this.samples.push({ label, at: this.clock.wallNow().toISOString(), ...counts });
    return counts;
  }

  start(
    boundary: OperationalBaselineBoundary,
    operation: string,
    phase = "complete"
  ): OperationalBaselineSpan {
    if (!operation || operation.length > 240 || /[\0\r\n]/.test(operation) ||
        !phase || phase.length > 80 || /[\0\r\n]/.test(phase)) {
      throw new Error("Operational baseline measurement labels are invalid");
    }
    const startedAt = this.clock.wallNow().toISOString();
    const startedMonotonicMs = this.clock.monotonicNow();
    return {
      boundary,
      operation,
      phase,
      startedAt,
      startedMonotonicMs,
      processCountBefore: this.sampleProcessCounts(`${boundary}.${phase}.${operation}.before`),
    };
  }

  finish(
    span: OperationalBaselineSpan,
    options: CompleteSpanOptions = {}
  ): OperationalBaselineMeasurement {
    const observedFinishedAt = this.clock.wallNow().toISOString();
    const durationMs = Number((options.durationMs ??
      (this.clock.monotonicNow() - span.startedMonotonicMs)).toFixed(3));
    finiteNonNegative(durationMs, "Operational baseline duration");
    const finishedAt = options.finishedAt ?? observedFinishedAt;
    const startedMs = isoTimestamp(span.startedAt, "Measurement start");
    const finishedMs = isoTimestamp(finishedAt, "Measurement finish");
    if (finishedMs < startedMs) throw new Error("Operational baseline measurement finished before it started");
    const measurement: OperationalBaselineMeasurement = {
      boundary: span.boundary,
      operation: span.operation,
      phase: span.phase,
      startedAt: span.startedAt,
      finishedAt,
      durationMs,
      outcome: options.outcome ?? "passed",
      processCountBefore: span.processCountBefore,
      processCountAfter: this.sampleProcessCounts(
        `${span.boundary}.${span.phase}.${span.operation}.after`
      ),
      ...(options.observations ? { observations: { ...options.observations } } : {}),
      ...(options.errorName ? { errorName: options.errorName } : {}),
    };
    this.measurements.push(measurement);
    return measurement;
  }

  async measure<T>(
    boundary: OperationalBaselineBoundary,
    operation: string,
    action: () => Promise<T>,
    phase = "complete",
    observations?: (result: T) => Record<string, string | number | boolean | null>
  ): Promise<T> {
    const span = this.start(boundary, operation, phase);
    try {
      const result = await action();
      this.finish(span, observations ? { observations: observations(result) } : undefined);
      return result;
    } catch (error) {
      this.finish(span, {
        outcome: "failed",
        errorName: error instanceof Error ? error.name : "NonErrorThrow",
      });
      throw error;
    }
  }

  artifact(input: {
    result: "passed" | "failed";
    environment: OperationalBaselineEnvironment;
    workload: OperationalBaselineWorkload;
    source: OperationalBaselineArtifact["source"];
    limitations: string[];
    failureName?: string;
  }): OperationalBaselineArtifact {
    const finishedAt = this.clock.wallNow().toISOString();
    const durationMs = Number((this.clock.monotonicNow() - this.startedMonotonicMs).toFixed(3));
    return buildOperationalBaselineArtifact({
      backend: this.backend,
      result: input.result,
      startedAt: this.startedAt,
      finishedAt,
      durationMs,
      environment: input.environment,
      workload: input.workload,
      source: input.source,
      measurements: this.measurements,
      processCounts: this.samples,
      limitations: input.limitations,
      failure: input.failureName ? { name: input.failureName } : null,
    });
  }
}

export function buildOperationalBaselineArtifact(input: Omit<
  OperationalBaselineArtifact,
  "schemaVersion" | "kind" | "thresholds"
>): OperationalBaselineArtifact {
  const started = isoTimestamp(input.startedAt, "Baseline start");
  const finished = isoTimestamp(input.finishedAt, "Baseline finish");
  if (finished < started) throw new Error("Operational baseline finished before it started");
  finiteNonNegative(input.durationMs, "Operational baseline duration");
  validateWorkload(input.workload, input.backend, input.result);
  validateSourceIdentity(input.source.harness);
  validateSourceIdentity(input.source.recorder);
  if (!Array.isArray(input.source.measured) || input.source.measured.length < 1 ||
      input.source.measured.length > MAX_MEASURED_SOURCE_IDENTITIES) {
    throw new Error("Operational baseline measured-source identity list is invalid");
  }
  const measuredPathKeys = new Set<string>();
  let previousMeasuredPath: string | null = null;
  for (const source of input.source.measured) {
    validateSourceIdentity(source);
    const pathKey = source.path.toLocaleLowerCase("en-US");
    if (measuredPathKeys.has(pathKey)) {
      throw new Error("Operational baseline measured-source identities contain a duplicate path");
    }
    measuredPathKeys.add(pathKey);
    if (previousMeasuredPath !== null && previousMeasuredPath >= source.path) {
      throw new Error("Operational baseline measured-source identities are not in canonical path order");
    }
    previousMeasuredPath = source.path;
  }
  if ((input.result === "passed" && input.failure !== null) ||
      (input.result === "failed" && !input.failure?.name)) {
    throw new Error("Operational baseline failure classification disagrees with its result");
  }
  if (input.result === "passed" && input.measurements.some((item) => item.outcome === "failed")) {
    throw new Error("A passed operational baseline cannot contain a failed measurement");
  }
  for (const measurement of input.measurements) {
    const measurementStart = isoTimestamp(measurement.startedAt, "Measurement start");
    const measurementFinish = isoTimestamp(measurement.finishedAt, "Measurement finish");
    if (measurementFinish < measurementStart) {
      throw new Error("Operational baseline measurement finished before it started");
    }
    finiteNonNegative(measurement.durationMs, "Operational baseline measurement duration");
    processCounts(measurement.processCountBefore);
    processCounts(measurement.processCountAfter);
    if (measurement.observations) {
      for (const [key, value] of Object.entries(measurement.observations)) {
        if (!key || key.length > 80 || /[\0\r\n]/.test(key) ||
            (typeof value === "number" && !Number.isFinite(value)) ||
            (typeof value === "string" && (value.length > 160 || /[\0\r\n]/.test(value)))) {
          throw new Error("Operational baseline measurement observation is invalid");
        }
      }
    }
  }
  for (const sample of input.processCounts) {
    isoTimestamp(sample.at, "Process-count sample timestamp");
    processCounts(sample);
  }
  for (const executable of [input.environment.workbench, input.environment.game]) {
    if (executable && (!executable.executable ||
        portableBasename(executable.executable) !== executable.executable)) {
      throw new Error("Operational baseline executable identity must not contain a path");
    }
  }
  if (input.result === "passed") {
    const engine = input.backend === "workbench"
      ? input.environment.workbench
      : input.environment.game;
    if (!engine || engine.discovery !== "windows_file_metadata" ||
        (boundedVersion(engine.version) === null && boundedVersion(engine.fileVersion) === null)) {
      throw new Error(
        `A passed operational baseline requires ${input.backend === "workbench" ? "Workbench" : "game"} ` +
        "Windows file metadata with a product or file version"
      );
    }
    const passed = (
      boundary: OperationalBaselineBoundary,
      operation: string,
      phase: string
    ): OperationalBaselineMeasurement | undefined => input.measurements.find((measurement) =>
      measurement.outcome === "passed" && measurement.boundary === boundary &&
      measurement.operation === operation && measurement.phase === phase);
    const restBefore = input.processCounts.find((sample) => sample.label === "rest.beforeLaunch");
    const restAfter = input.processCounts.find((sample) => sample.label === "rest.afterShutdown");
    if (!restBefore || !restAfter || restBefore.total !== 0 || restAfter.total !== 0) {
      throw new Error("A passed operational baseline requires zero supervised processes at both rest boundaries");
    }
    const supervisedExitSettle = passed(
      "shutdown",
      "waitForOperationalBaselineProcessVacancy",
      "supervised_exit_settle"
    );
    if (!supervisedExitSettle || supervisedExitSettle.observations?.vacant !== true ||
        supervisedExitSettle.observations?.finalTotal !== 0) {
      throw new Error(
        "A passed operational baseline requires measured supervised exit-settle vacancy evidence"
      );
    }
    const capture = input.measurements.find((measurement) =>
      measurement.outcome === "passed" && measurement.boundary === "capture");
    const observerClose = input.measurements.find((measurement) =>
      measurement.outcome === "passed" && measurement.boundary === "shutdown" &&
      measurement.operation === "ObserverApplication.close");
    if (!capture || !observerClose) {
      throw new Error("A passed operational baseline requires capture availability and observer cleanup evidence");
    }
    if (input.backend === "workbench") {
      const launch = passed("launch", "WorkbenchClient.ensureRunning", "running_confirmation");
      const managed = passed(
        "managed_call",
        "WorkbenchObserverAdapter.ping(EMCP_WB_Ping)",
        "representative_net_api"
      );
      const termination = passed(
        "shutdown",
        "WorkbenchClient.shutdownOwnedWorkbench",
        "termination"
      );
      if (!launch || !managed || !termination ||
          termination.observations?.stopped !== true) {
        throw new Error("A passed Workbench baseline is missing required lifecycle/NET API evidence");
      }
    } else {
      const launch = passed(
        "launch",
        "OwnedRuntimeManager.start/status(running)",
        "running_confirmation"
      );
      const managed = passed(
        "managed_call",
        "OwnedRuntimeManager.status",
        "representative_status_api"
      );
      const termination = passed("shutdown", "OwnedRuntimeManager.stop", "termination");
      const cleanup = passed("shutdown", "OwnedRuntimeManager.stop", "observer_cleanup");
      if (!launch || !managed || !termination || !cleanup ||
          termination.observations?.terminationComplete !== true ||
          termination.observations?.identityVacant !== true ||
          cleanup.observations?.observerCleanupPending !== false) {
        throw new Error("A passed runtime baseline is missing required lifecycle/cleanup evidence");
      }
    }
  }
  return {
    schemaVersion: 1,
    kind: input.backend === "workbench"
      ? "reforger_forge_workbench_operational_baseline"
      : "reforger_forge_runtime_operational_baseline",
    ...input,
    workload: {
      ...input.workload,
      fixture: input.workload.fixture ? { ...input.workload.fixture } : null,
      capture: {
        ...input.workload.capture,
        labels: [...input.workload.capture.labels],
      },
      launchArguments: { ...input.workload.launchArguments },
    },
    source: {
      harness: { ...input.source.harness },
      recorder: { ...input.source.recorder },
      measured: input.source.measured.map((source) => ({ ...source })),
    },
    measurements: input.measurements.map((measurement) => ({ ...measurement })),
    processCounts: input.processCounts.map((sample) => ({ ...sample })),
    thresholds: null,
    limitations: [...input.limitations],
  };
}

function boundedVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 128 && !/[\0\r\n]/.test(trimmed) ? trimmed : null;
}

function portableBasename(path: string): string {
  return basename(path.replace(/\\/g, "/"));
}

export function inspectExecutableVersion(executablePath: string): ExecutableVersionEvidence {
  const executable = portableBasename(executablePath);
  const unavailable: ExecutableVersionEvidence = {
    executable,
    version: null,
    fileVersion: null,
    discovery: "unavailable",
  };
  if (!existsSync(executablePath)) return unavailable;
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$item = Get-Item -LiteralPath $env:RFO_OPERATIONAL_BASELINE_VERSION_PATH",
    "$value = [ordered]@{ productVersion = $item.VersionInfo.ProductVersion; fileVersion = $item.VersionInfo.FileVersion }",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $value -Compress))",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, RFO_OPERATIONAL_BASELINE_VERSION_PATH: executablePath },
    }
  );
  if (result.error || result.status !== 0) return unavailable;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const productVersion = boundedVersion(parsed.productVersion);
    const fileVersion = boundedVersion(parsed.fileVersion);
    return {
      executable,
      version: productVersion ?? fileVersion,
      fileVersion,
      discovery: productVersion || fileVersion ? "windows_file_metadata" : "unavailable",
    };
  } catch {
    return unavailable;
  }
}

export function operationalBaselineEnvironment(options: {
  workbenchExecutable?: string;
  gameExecutable?: string;
  inspectVersion?: (path: string) => ExecutableVersionEvidence;
} = {}): OperationalBaselineEnvironment {
  const cpu = cpus();
  const inspectVersion = options.inspectVersion ?? inspectExecutableVersion;
  return {
    node: { version: process.version, architecture: process.arch },
    operatingSystem: { platform: platform(), release: release(), architecture: arch() },
    machineClass: {
      cpuModel: (cpu[0]?.model ?? "unknown").replace(/\s+/g, " ").trim().slice(0, 160),
      logicalCpuCount: cpu.length,
      totalMemoryGiB: Number((totalmem() / (1024 ** 3)).toFixed(1)),
    },
    workbench: options.workbenchExecutable ? inspectVersion(options.workbenchExecutable) : null,
    game: options.gameExecutable ? inspectVersion(options.gameExecutable) : null,
  };
}

export function operationalBaselineSource(
  harnessPath: string,
  repositoryRelativeHarness: string,
  repositoryRoot: string,
  measuredRepositoryRelativePaths: readonly string[],
  measuredClosures: readonly OperationalBaselineSourceClosure[] = [],
  recorderPath = fileURLToPath(import.meta.url),
  repositoryRelativeRecorder = "scripts/observer-live-acceptance-support.ts"
): OperationalBaselineArtifact["source"] {
  const identity = (absolutePath: string, repositoryRelativePath: string): OperationalBaselineSourceIdentity => {
    const normalizedPath = repositoryRelativePath.replace(/\\/g, "/");
    if (!validRepositoryRelativeSourcePath(normalizedPath)) {
      throw new Error("Operational baseline source identity is invalid");
    }
    const entry = lstatSync(absolutePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Operational baseline source identity must name a regular non-symlink file");
    }
    const source = {
      path: normalizedPath,
      sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
    };
    validateSourceIdentity(source);
    return source;
  };
  const closureIdentity = (closure: OperationalBaselineSourceClosure): OperationalBaselineSourceIdentity => {
    const path = closure.path.replace(/\\/g, "/");
    const directory = closure.directory.replace(/\\/g, "/");
    if (!validRepositoryRelativeSourcePath(path) ||
        !validRepositoryRelativeSourcePath(directory) || /[*?\[\]]/.test(directory) ||
        !/^\.[a-z0-9]+$/i.test(closure.extension)) {
      throw new Error("Operational baseline source closure is invalid");
    }
    const members: Array<{ path: string; sha256: string }> = [];
    const absoluteClosureDirectory = join(repositoryRoot, ...directory.split("/"));
    const directoryEntry = lstatSync(absoluteClosureDirectory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new Error("Operational baseline source closure must name a non-symlink directory");
    }
    const visit = (absoluteDirectory: string, repositoryRelativeDirectory: string): void => {
      for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
        const memberPath = `${repositoryRelativeDirectory}/${entry.name}`;
        const absoluteMemberPath = join(absoluteDirectory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error("Operational baseline source closure must not contain symbolic links");
        }
        if (entry.isDirectory()) {
          visit(absoluteMemberPath, memberPath);
        } else if (entry.isFile() && entry.name.endsWith(closure.extension)) {
          if (!validRepositoryRelativeSourcePath(memberPath)) {
            throw new Error("Operational baseline source closure member is invalid");
          }
          members.push({
            path: memberPath,
            sha256: createHash("sha256").update(readFileSync(absoluteMemberPath)).digest("hex"),
          });
        }
      }
    };
    visit(absoluteClosureDirectory, directory);
    members.sort(compareSourcePath);
    if (members.length < 1 || members.length > 256) {
      throw new Error("Operational baseline source closure has an invalid member count");
    }
    const hash = createHash("sha256");
    hash.update("rfo-operational-baseline-source-closure-v1\0");
    for (const member of members) {
      hash.update(member.path);
      hash.update("\0");
      hash.update(member.sha256);
      hash.update("\0");
    }
    return { path, sha256: hash.digest("hex") };
  };
  const measured = measuredRepositoryRelativePaths.map((repositoryRelativePath) =>
    identity(join(repositoryRoot, ...repositoryRelativePath.replace(/\\/g, "/").split("/")), repositoryRelativePath)
  ).concat(measuredClosures.map(closureIdentity)).sort(compareSourcePath);
  const measuredKeys = new Set(measured.map((source) => source.path.toLocaleLowerCase("en-US")));
  if (measured.length < 1 || measured.length > MAX_MEASURED_SOURCE_IDENTITIES || measuredKeys.size !== measured.length) {
    throw new Error("Operational baseline measured-source identity list is invalid");
  }
  return {
    harness: identity(harnessPath, repositoryRelativeHarness),
    recorder: identity(recorderPath, repositoryRelativeRecorder),
    measured,
  };
}

/** Write manifest-last through a unique sibling, then atomically rename it. */
export function writeOperationalBaselineArtifact(
  outputDirectory: string,
  artifact: OperationalBaselineArtifact
): string {
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Operational baseline output must be a non-symlink directory");
  }
  const timestamp = artifact.startedAt.replace(/[:.]/g, "-");
  const nonce = randomUUID();
  const filename = `${timestamp}-${artifact.backend}-operational-baseline-${nonce}.json`;
  const finalPath = join(directory, filename);
  const temporaryPath = join(directory, `.${filename}.${process.pid}.tmp`);
  if (existsSync(finalPath) || existsSync(temporaryPath)) {
    throw new Error("Operational baseline artifact name unexpectedly collided");
  }
  writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporaryPath, finalPath);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* preserve the publication error */ }
    throw error;
  }
  return finalPath;
}

export type MatrixArtifactBackend = FaultMatrixBackend;

export interface MatrixRetainedDiagnostic {
  readonly sha256: string;
  readonly byteCount: number;
  readonly tail: string;
}

export interface MatrixCaseEntry {
  readonly caseId: string;
  readonly schedule: {
    readonly backend: MatrixArtifactBackend;
    readonly view: "current" | "pose" | "lookAt" | null;
    readonly phase: string;
    readonly action: string;
  };
  readonly result: "passed" | "failed";
  readonly publicTerminal: { readonly state: string; readonly errorCode: string | null };
  readonly deadline: {
    readonly outcome: "completed" | "expired" | "cancelled";
    readonly elapsedMs: number;
    readonly budgetMs: number;
  };
  readonly worldRevision: "unchanged" | "changed" | "not_acquired" | "unavailable";
  readonly camera: "restored" | "exact_process_exit" | "not_acquired" | "unproven";
  readonly artifact: "validated" | "not_created" | "rejected" | "unproven";
  readonly cleanup: {
    readonly lifecycleVacant: boolean;
    readonly endpointVacant: boolean;
    readonly childVacant: boolean;
    readonly exactOwnerVacant: boolean;
  };
  readonly retainedDiagnostics: readonly MatrixRetainedDiagnostic[];
}

export interface ObserverFailureMatrixArtifact {
  readonly schemaVersion: 2;
  readonly kind:
    | "reforger_forge_runtime_observer_failure_matrix"
    | "reforger_forge_workbench_observer_failure_matrix";
  readonly backend: MatrixArtifactBackend;
  readonly result: "passed" | "failed";
  readonly evaluator: { readonly kind: "local_maintainer"; readonly stableId: null };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly environment: OperationalBaselineEnvironment;
  readonly workload: OperationalBaselineWorkload;
  readonly source: OperationalBaselineArtifact["source"];
  readonly matrix: {
    readonly schemaVersion: 1;
    readonly declaredCaseIds: readonly string[];
    readonly sourceClosureSha256: string;
  };
  readonly cases: readonly MatrixCaseEntry[];
  readonly measurements: readonly OperationalBaselineMeasurement[];
  readonly processCounts: readonly OperationalBaselineProcessSample[];
  readonly limitations: readonly string[];
  readonly failure: { readonly name: string } | null;
}

export interface FailureMatrixArtifactInput extends Omit<ObserverFailureMatrixArtifact,
  "schemaVersion" | "kind" | "evaluator" | "matrix"> {
  readonly matrix: FaultMatrix;
  readonly knownSecretValues?: readonly string[];
}

export interface FailureMatrixPublication {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly artifact: ObserverFailureMatrixArtifact;
}

const MATRIX_DIAGNOSTIC_MAXIMUM = 4 * 1024;
const MATRIX_HASH = /^[a-f0-9]{64}$/;
const FAILURE_MATRIX_REQUIRED_SOURCE_PATHS = Object.freeze([
  "observer/protocol/fault-matrix.ts",
  "scripts/observer-fault-matrix-support.ts",
  "scripts/observer-live-acceptance-support.ts",
  "src/foundation/redact.ts",
  "src/foundation/time.ts",
  "src/observer/public-contract.ts",
] as const);
const MATRIX_PORTABLE_IDENTIFIER_ASSIGNMENT = /((?:pid|process[_ -]?id|hostname|host|username|user|lifecycle(?:id|generation|[_ -]id|[_ -]generation)|handler(?:id|lease|[_ -]id|[_ -]lease))\s*[:=]\s*)([^\s,;}\]]+)/gi;
const MATRIX_CHECK_FIELD: Readonly<Record<string, keyof MatrixCaseEntry["cleanup"]>> = Object.freeze({
  lifecycle_vacant: "lifecycleVacant",
  endpoint_vacant: "endpointVacant",
  child_vacant: "childVacant",
  exact_owner_vacant: "exactOwnerVacant",
});
const MATRIX_LOCAL_IDENTIFIER_ASSIGNMENT = /(\b(?:pid|process(?:[_ -]?id)?|host(?:name)?|user(?:name)?|lifecycle(?:[_ -]?(?:id|generation))?|handler(?:[_ -]?(?:id|lease))?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|[^\s,;}\]]+)/gi;

function exactKeys(value: unknown, expected: readonly string[], _label: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

const MATRIX_LOCAL_IDENTIFIER_KEYS = new Set([
  "pid", "processid", "hostname", "host", "username", "user",
  "lifecycleid", "lifecyclegeneration", "handlerid", "handlerlease",
]);

function redactMatrixLocalIdentifiers(value: string): string {
  return value.split(";").map((part) => {
    const equals = part.indexOf("=");
    const colon = part.indexOf(":");
    const boundary = equals < 0 ? colon : colon < 0 ? equals : Math.min(equals, colon);
    if (boundary < 0) return part;
    const key = part.slice(0, boundary).trim().replace(/[_ -]/g, "").toLowerCase();
    return MATRIX_LOCAL_IDENTIFIER_KEYS.has(key)
      ? part.slice(0, boundary + 1) + "[REDACTED]"
      : part;
  }).join(";");
}

function safeMatrixText(value: string, knownSecretValues: readonly string[]): string {
  const centrallyRedacted = redactText(value, {
    profile: "evidence_portability",
    knownSecretValues,
    maxLength: MATRIX_DIAGNOSTIC_MAXIMUM,
  })
    // The central portability profile recognizes whole POSIX arguments. A
    // diagnostic may embed one after ordinary prose, so retain no such span.
    .replace(/(^|[\s;])\/(?:[^\s,;}\]]+)/g, "$1<absolute-path>")
    .replace(MATRIX_LOCAL_IDENTIFIER_ASSIGNMENT, "$1[REDACTED]")
    .replace(MATRIX_PORTABLE_IDENTIFIER_ASSIGNMENT, "$1[REDACTED]");
  const redacted = redactMatrixLocalIdentifiers(centrallyRedacted);
  // Redaction is intentionally followed by a portability gate. A new diagnostic
  // shape must fail publication until the central redactor learns how to handle it.
  const unsafe = [
    /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|(?:^|\s)\/[A-Za-z0-9._-]+)/,
    /-reforgerForgeOwnerToken=(?!\[REDACTED\])/i,
    /\bBearer\s+(?!\[REDACTED\])/i,
    /\b(?:capability|lifecycle|handler|owner)\s*[:=]\s*[A-Za-z0-9._-]{8,}/i,
  ];
  if (knownSecretValues.some((secret) => secret && redacted.includes(secret)) || unsafe.some((pattern) => pattern.test(redacted))) {
    throw new Error("Failure-matrix diagnostic remains unsafe after redaction");
  }
  return redacted;
}

/** Redact a retained diagnostic at its only matrix-evidence presentation boundary. */
export function matrixRetainedDiagnostic(
  tail: string,
  knownSecretValues: readonly string[] = []
): MatrixRetainedDiagnostic {
  if (typeof tail !== "string") throw new Error("Failure-matrix diagnostic tail must be a string");
  const redacted = safeMatrixText(tail, knownSecretValues);
  return Object.freeze({
    sha256: createHash("sha256").update(redacted).digest("hex"),
    byteCount: Buffer.byteLength(redacted, "utf8"),
    tail: redacted,
  });
}

/** Stable digest of the actual sorted harness/source closure, never a runner literal. */
export function failureMatrixSourceClosureSha256(source: OperationalBaselineArtifact["source"]): string {
  const members = [source.harness, source.recorder, ...source.measured]
    .map((member) => ({ path: member.path, sha256: member.sha256 }))
    .sort(compareSourcePath);
  if (members.length < 3 || new Set(members.map((member) => member.path.toLowerCase())).size !== members.length) {
    throw new Error("Failure-matrix source closure is invalid");
  }
  const memberPaths = new Set(members.map((member) => member.path.toLowerCase()));
  for (const requiredPath of FAILURE_MATRIX_REQUIRED_SOURCE_PATHS) {
    if (!memberPaths.has(requiredPath.toLowerCase())) {
      throw new Error(`Failure-matrix source closure omits required ${requiredPath}`);
    }
  }
  return aggregateContentMembers(members, "rfo-observer-failure-matrix-source-closure-v1");
}

function validateMatrixDiagnostic(value: unknown, knownSecretValues: readonly string[]): asserts value is MatrixRetainedDiagnostic {
  if (!exactKeys(value, ["sha256", "byteCount", "tail"], "Failure-matrix retained diagnostic") ||
      typeof value.sha256 !== "string" || !MATRIX_HASH.test(value.sha256) ||
      typeof value.byteCount !== "number" || !Number.isSafeInteger(value.byteCount) || value.byteCount < 0 || value.byteCount > MATRIX_DIAGNOSTIC_MAXIMUM ||
      typeof value.tail !== "string" || Buffer.byteLength(value.tail, "utf8") !== value.byteCount ||
      value.tail.length > MATRIX_DIAGNOSTIC_MAXIMUM ||
      safeMatrixText(value.tail, knownSecretValues) !== value.tail ||
      createHash("sha256").update(value.tail).digest("hex") !== value.sha256) {
    throw new Error("Failure-matrix retained diagnostic is invalid or unsafe");
  }
}

function validateMatrixCleanup(value: unknown): asserts value is MatrixCaseEntry["cleanup"] {
  if (!exactKeys(value, ["lifecycleVacant", "endpointVacant", "childVacant", "exactOwnerVacant"], "Failure-matrix cleanup") ||
      Object.values(value).some((member) => typeof member !== "boolean")) {
    throw new Error("Failure-matrix cleanup is invalid");
  }
}

function hasEvidence(entry: MatrixCaseEntry, field: MatrixEvidenceField): boolean {
  switch (field) {
    case "public_terminal": return Boolean(entry.publicTerminal.state);
    case "deadline": return entry.deadline.outcome === "completed";
    case "world_revision": return entry.worldRevision !== "unavailable";
    case "camera": return entry.camera !== "unproven";
    case "artifact": return entry.artifact !== "unproven";
    case "cleanup": return true;
    case "retained_diagnostics": return entry.retainedDiagnostics.length > 0;
  }
}

function validateMatrixCaseEntry(
  value: unknown,
  matrix: FaultMatrix,
  artifactResult: "passed" | "failed",
  knownSecretValues: readonly string[]
): asserts value is MatrixCaseEntry {
  if (!exactKeys(value, [
    "caseId", "schedule", "result", "publicTerminal", "deadline", "worldRevision", "camera", "artifact", "cleanup", "retainedDiagnostics",
  ], "Failure-matrix case entry") || typeof value.caseId !== "string" ||
      (value.result !== "passed" && value.result !== "failed")) {
    throw new Error("Failure-matrix case entry is invalid");
  }
  const declared = caseForId(matrix, value.caseId);
  if (!exactKeys(value.schedule, ["backend", "view", "phase", "action"], "Failure-matrix case schedule") ||
      value.schedule.backend !== declared.backend || value.schedule.view !== declared.view ||
      value.schedule.phase !== declared.injection.phase || value.schedule.action !== declared.injection.action) {
    throw new Error("Failure-matrix case schedule disagrees with its declaration");
  }
  // Failed rows retain their observed public terminal, but still cannot turn
  // evidence into an unbounded transport for arbitrary state/error strings.
  if (!isCanonicalFaultMatrixTerminal(value.publicTerminal)) {
    throw new Error("Failure-matrix public terminal is invalid");
  }
  const deadline = value.deadline;
  if (!exactKeys(deadline, ["outcome", "elapsedMs", "budgetMs"], "Failure-matrix deadline") ||
      (deadline.outcome !== "completed" && deadline.outcome !== "expired" && deadline.outcome !== "cancelled") ||
      typeof deadline.elapsedMs !== "number" || !Number.isSafeInteger(deadline.elapsedMs) || deadline.elapsedMs < 0 ||
      typeof deadline.budgetMs !== "number" || !Number.isSafeInteger(deadline.budgetMs) || deadline.budgetMs < 1 ||
      deadline.elapsedMs > deadline.budgetMs) {
    throw new Error("Failure-matrix deadline is invalid");
  }
  if (typeof value.worldRevision !== "string" || !["unchanged", "changed", "not_acquired", "unavailable"].includes(value.worldRevision) ||
      typeof value.camera !== "string" || !["restored", "exact_process_exit", "not_acquired", "unproven"].includes(value.camera) ||
      typeof value.artifact !== "string" || !["validated", "not_created", "rejected", "unproven"].includes(value.artifact) ||
      !Array.isArray(value.retainedDiagnostics) || value.retainedDiagnostics.length > 16) {
    throw new Error("Failure-matrix case dispositions are invalid");
  }
  validateMatrixCleanup(value.cleanup);
  for (const diagnostic of value.retainedDiagnostics) validateMatrixDiagnostic(diagnostic, knownSecretValues);
  if (value.result === "passed") {
    if (value.publicTerminal.state !== declared.expectedTerminal.state ||
        value.publicTerminal.errorCode !== declared.expectedTerminal.errorCode ||
        value.camera !== declared.cameraDisposition) {
      throw new Error("A passed failure-matrix case contradicts its declaration");
    }
    for (const field of declared.requiredEvidence) {
      if (!hasEvidence(value as unknown as MatrixCaseEntry, field)) throw new Error(`A passed failure-matrix case lacks required ${field} evidence`);
    }
    for (const check of declared.requiredChecks) {
      if (!value.cleanup[MATRIX_CHECK_FIELD[check]]) {
        throw new Error(`A passed failure-matrix case lacks required ${check} proof`);
      }
    }
  }
  if (artifactResult === "passed" && value.result !== "passed") {
    throw new Error("A passed failure-matrix artifact cannot contain a failed case");
  }
}

function validateFailureMatrixArtifact(
  artifact: ObserverFailureMatrixArtifact,
  matrix: FaultMatrix,
  knownSecretValues: readonly string[]
): void {
  if (!exactKeys(artifact, [
    "schemaVersion", "kind", "backend", "result", "evaluator", "startedAt", "finishedAt", "durationMs", "environment", "workload",
    "source", "matrix", "cases", "measurements", "processCounts", "limitations", "failure",
  ], "Failure-matrix artifact") || artifact.schemaVersion !== 2 ||
      artifact.kind !== `reforger_forge_${artifact.backend}_observer_failure_matrix` ||
      (artifact.backend !== "runtime" && artifact.backend !== "workbench") ||
      (artifact.result !== "passed" && artifact.result !== "failed") ||
      !exactKeys(artifact.evaluator, ["kind", "stableId"], "Failure-matrix evaluator") ||
      artifact.evaluator.kind !== "local_maintainer" || artifact.evaluator.stableId !== null) {
    throw new Error("Failure-matrix artifact identity is invalid");
  }
  const started = isoTimestamp(artifact.startedAt, "Failure-matrix start");
  const finished = isoTimestamp(artifact.finishedAt, "Failure-matrix finish");
  if (finished < started || !Number.isFinite(artifact.durationMs) || artifact.durationMs < 0) {
    throw new Error("Failure-matrix timing is invalid");
  }
  // Reuse the established baseline validator for all retained operational evidence.
  buildOperationalBaselineArtifact({
    backend: artifact.backend,
    result: artifact.result,
    startedAt: artifact.startedAt,
    finishedAt: artifact.finishedAt,
    durationMs: artifact.durationMs,
    environment: artifact.environment,
    workload: artifact.workload,
    source: artifact.source,
    measurements: artifact.measurements,
    processCounts: artifact.processCounts,
    limitations: [...artifact.limitations],
    failure: artifact.failure,
  } as Omit<OperationalBaselineArtifact, "schemaVersion" | "kind" | "thresholds">);
  const declaredBackendCases = matrix.cases.filter((item) => item.backend === artifact.backend);
  if (!exactKeys(artifact.matrix, ["schemaVersion", "declaredCaseIds", "sourceClosureSha256"], "Failure-matrix catalog") ||
      artifact.matrix.schemaVersion !== 1 || !MATRIX_HASH.test(artifact.matrix.sourceClosureSha256) ||
      !Array.isArray(artifact.matrix.declaredCaseIds) ||
      artifact.matrix.declaredCaseIds.length !== declaredBackendCases.length ||
      artifact.matrix.declaredCaseIds.some((id, index) => id !== declaredBackendCases[index]!.id) ||
      artifact.matrix.sourceClosureSha256 !== failureMatrixSourceClosureSha256(artifact.source)) {
    throw new Error("Failure-matrix catalog identity is invalid");
  }
  if (!Array.isArray(artifact.cases) || artifact.cases.length !== declaredBackendCases.length ||
      artifact.cases.some((entry, index) => entry.caseId !== declaredBackendCases[index]!.id)) {
    throw new Error("Failure-matrix entries must occur once in sorted declared order");
  }
  for (const entry of artifact.cases) validateMatrixCaseEntry(entry, matrix, artifact.result, knownSecretValues);
  if ((artifact.result === "passed" && artifact.failure !== null) ||
      (artifact.result === "failed" && !artifact.failure?.name) ||
      (artifact.failure !== null && (!exactKeys(artifact.failure, ["name"], "Failure-matrix failure") ||
        !boundedVersion(artifact.failure.name)))) {
    throw new Error("Failure-matrix failure classification is invalid");
  }
  if (!Array.isArray(artifact.limitations) || artifact.limitations.some((item) =>
    typeof item !== "string" || item.length > 512 || safeMatrixText(item, knownSecretValues) !== item)) {
    throw new Error("Failure-matrix limitations are unsafe");
  }
}

/** Build a v2 matrix artifact while preserving the v1 baseline's environment/source evidence shape. */
export function buildObserverFailureMatrixArtifact(input: FailureMatrixArtifactInput): ObserverFailureMatrixArtifact {
  const knownSecretValues = [...new Set(input.knownSecretValues ?? [])];
  if (knownSecretValues.some((value) => typeof value !== "string" || !value)) {
    throw new Error("Failure-matrix known secret values are invalid");
  }
  const artifact: ObserverFailureMatrixArtifact = {
    schemaVersion: 2,
    kind: `reforger_forge_${input.backend}_observer_failure_matrix`,
    backend: input.backend,
    result: input.result,
    evaluator: { kind: "local_maintainer", stableId: null },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    environment: input.environment,
    workload: input.workload,
    source: input.source,
    matrix: {
      schemaVersion: 1,
      declaredCaseIds: input.matrix.cases.filter((item) => item.backend === input.backend).map((item) => item.id),
      sourceClosureSha256: failureMatrixSourceClosureSha256(input.source),
    },
    cases: input.cases.map((entry) => ({
      ...entry,
      retainedDiagnostics: entry.retainedDiagnostics.map((diagnostic) => matrixRetainedDiagnostic(diagnostic.tail, knownSecretValues)),
    })),
    measurements: input.measurements,
    processCounts: input.processCounts,
    limitations: input.limitations.map((item) => safeMatrixText(item, knownSecretValues)),
    failure: input.failure,
  };
  validateFailureMatrixArtifact(artifact, input.matrix, knownSecretValues);
  return Object.freeze(artifact);
}

function failureMatrixMarkdown(artifact: ObserverFailureMatrixArtifact): string {
  const product = artifact.backend === "runtime" ? artifact.environment.game : artifact.environment.workbench;
  const productVersion = product?.version ?? product?.fileVersion ?? "unavailable";
  const lines = [
    "# Observer failure matrix",
    "",
    `Result: ${artifact.result}`,
    `Backend: ${artifact.backend}`,
    `Product version: ${productVersion}`,
    `Evaluator: ${artifact.evaluator.kind}`,
    `Source closure SHA-256: ${artifact.matrix.sourceClosureSha256}`,
    "",
    "| Case | Result | Terminal | Deadline | Camera |",
    "| --- | --- | --- | --- | --- |",
    ...artifact.cases.map((entry) => `| ${entry.caseId} | ${entry.result} | ${entry.publicTerminal.state}/${entry.publicTerminal.errorCode ?? "none"} | ${entry.deadline.outcome} | ${entry.camera} |`),
    "",
    "## Retained diagnostic hashes",
    "",
    ...artifact.cases.flatMap((entry) => entry.retainedDiagnostics.map((diagnostic) =>
      `- ${entry.caseId}: ${diagnostic.sha256} (${diagnostic.byteCount} bytes)`)),
    "",
    "## Limitations",
    "",
    ...artifact.limitations.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

export function validateObserverFailureMatrixSummary(
  summary: unknown,
  markdown: string,
): asserts summary is { readonly basename: string; readonly sha256: string } {
  if (!exactKeys(summary, ["basename", "sha256"], "Failure-matrix summary") ||
      typeof summary.basename !== "string" || !/^[0-9TZ-]+-(runtime|workbench)-observer-failure-matrix-[0-9a-f-]+\.md$/i.test(summary.basename) ||
      typeof summary.sha256 !== "string" || !MATRIX_HASH.test(summary.sha256) ||
      createHash("sha256").update(markdown).digest("hex") !== summary.sha256) {
    throw new Error("Failure-matrix summary hash is invalid");
  }
}

/**
 * Publish the redacted summary first and JSON manifest last. Any schema,
 * redaction, or closeout failure removes only this attempt's temporary siblings.
 */
export function writeObserverFailureMatrixArtifact(
  outputDirectory: string,
  artifact: ObserverFailureMatrixArtifact,
  matrix: FaultMatrix,
  knownSecretValues: readonly string[] = []
): FailureMatrixPublication {
  validateFailureMatrixArtifact(artifact, matrix, knownSecretValues);
  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Failure-matrix output must be a non-symlink directory");
  const timestamp = artifact.startedAt.replace(/[:.]/g, "-");
  const nonce = randomUUID();
  const stem = `${timestamp}-${artifact.backend}-observer-failure-matrix-${nonce}`;
  const markdownName = `${stem}.md`;
  const jsonName = `${stem}.json`;
  const markdownPath = join(directory, markdownName);
  const jsonPath = join(directory, jsonName);
  const markdownTemporary = join(directory, `.${markdownName}.${process.pid}.tmp`);
  const jsonTemporary = join(directory, `.${jsonName}.${process.pid}.tmp`);
  if ([markdownPath, jsonPath, markdownTemporary, jsonTemporary].some(existsSync)) {
    throw new Error("Failure-matrix artifact name unexpectedly collided");
  }
  try {
    const markdown = failureMatrixMarkdown(artifact);
    if (safeMatrixText(markdown, knownSecretValues) !== markdown) throw new Error("Failure-matrix summary is unsafe");
    writeFileSync(markdownTemporary, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(markdownTemporary, markdownPath);
    const markdownBytes = readFileSync(markdownPath, "utf8");
    const manifest = {
      ...artifact,
      summary: {
        basename: markdownName,
        sha256: createHash("sha256").update(markdownBytes).digest("hex"),
      },
    };
    validateObserverFailureMatrixSummary(manifest.summary, markdownBytes);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    // Every free-text field was redacted and validated above. Do not run the
    // JSON envelope through text redaction: repository-relative source names
    // are structured identity fields, not diagnostics.
    if (knownSecretValues.some((secret) => secret && serialized.includes(secret))) {
      throw new Error("Failure-matrix manifest is unsafe");
    }
    writeFileSync(jsonTemporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(jsonTemporary, jsonPath);
    return Object.freeze({ jsonPath, markdownPath, artifact });
  } catch (error) {
    for (const path of [markdownTemporary, jsonTemporary]) {
      try { if (existsSync(path)) unlinkSync(path); } catch { /* preserve root failure */ }
    }
    // A final summary without a final manifest is not a valid publication closure.
    try { if (existsSync(markdownPath) && !existsSync(jsonPath)) unlinkSync(markdownPath); } catch { /* preserve root failure */ }
    throw error;
  }
}

export interface PngMaterialEvidence {
  width: number;
  height: number;
  channels: 3 | 4;
  byteCount: number;
  sha256: string;
  sampledPixels: number;
  quantizedColorCount: number;
  nonBlackRatio: number;
  luminanceMinimum: number;
  luminanceMaximum: number;
  luminanceStandardDeviation: number;
  materiallyVaried: boolean;
}

export interface DecodedPngImage {
  width: number;
  height: number;
  channels: 3 | 4;
  sourceByteCount: number;
  sourceSha256: string;
  pixels: Buffer;
}

/** A resolution-independent region. Every value is expressed as a fraction of the image. */
export interface NormalizedImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PngComparisonOptions {
  roi?: NormalizedImageRegion;
  /** A pixel is changed when any visible RGB channel exceeds this delta. */
  channelTolerance?: number;
  minimumChangedPixelRatio?: number;
  minimumMeanAbsoluteError?: number;
  maximumChangedPixelRatioForSimilarity?: number;
  maximumMeanAbsoluteErrorForSimilarity?: number;
}

export interface PngComparisonEvidence {
  width: number;
  height: number;
  pixelRegion: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  comparedPixels: number;
  changedPixels: number;
  changedPixelRatio: number;
  meanAbsoluteError: number;
  rootMeanSquareError: number;
  maximumChannelDifference: number;
  similarityScore: number;
  materiallyDifferent: boolean;
  materiallySimilar: boolean;
}

export type RgbColor = readonly [red: number, green: number, blue: number];

export interface ColorMarkerOptions {
  color: RgbColor;
  roi?: NormalizedImageRegion;
  channelTolerance?: number;
  minimumMatchingPixels?: number;
  minimumMatchRatio?: number;
  /** RGBA pixels below this alpha are not eligible to match. */
  minimumAlpha?: number;
}

export interface ColorMarkerEvidence {
  detected: boolean;
  inspectedPixels: number;
  matchingPixels: number;
  matchingPixelRatio: number;
  pixelBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  normalizedCentroid: readonly [x: number, y: number] | null;
}

export interface ProcessRow {
  Id?: unknown;
  ProcessName?: unknown;
}

export interface BlockingProcess {
  id: number;
  processName: string;
}

export function findBlockingProcesses(rows: ProcessRow[]): BlockingProcess[] {
  return rows.flatMap((row) => {
    const processName = typeof row.ProcessName === "string" ? row.ProcessName : "";
    const id = typeof row.Id === "number" ? row.Id : Number(row.Id);
    return BLOCKING_PROCESS_NAMES.has(processName.toLowerCase()) && Number.isSafeInteger(id) && id > 0
      ? [{ id, processName }]
      : [];
  }).sort((left, right) => left.id - right.id);
}

export function inspectBlockingProcesses(): BlockingProcess[] {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-Process -ErrorAction Stop | Select-Object -Property Id,ProcessName)",
    "[Console]::Out.Write((ConvertTo-Json -InputObject $items -Compress))",
  ].join("; ");
  const inspection = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  if (inspection.error || inspection.status !== 0) {
    throw new Error(
      "Cannot prove that Arma Reforger and Workbench are absent; process inspection failed. No application was launched."
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspection.stdout || "[]");
  } catch {
    throw new Error(
      "Cannot prove that Arma Reforger and Workbench are absent; process inspection returned invalid data. No application was launched."
    );
  }
  return findBlockingProcesses(Array.isArray(parsed) ? parsed : [parsed]);
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, above: number, upperLeft: number): number {
  const candidate = left + above - upperLeft;
  const leftDistance = Math.abs(candidate - left);
  const aboveDistance = Math.abs(candidate - above);
  const diagonalDistance = Math.abs(candidate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) return left;
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

export function decodePng(png: Buffer): DecodedPngImage {
  if (png.length < 45 || png.length > MAX_PNG_BYTES || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Retained capture is not a bounded PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | 0 = 0;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  let dataEnded = false;
  const compressed: Buffer[] = [];
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error("PNG chunk header is truncated");
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) throw new Error("PNG chunk exceeds file bounds");
    const body = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    const crcInput = Buffer.concat([Buffer.from(type, "ascii"), body]);
    if (crc32(crcInput) !== expectedCrc) throw new Error(`PNG ${type} CRC is invalid`);
    if (type === "IHDR") {
      if (sawHeader || offset !== 8 || length !== 13) throw new Error("PNG IHDR placement is invalid");
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const pixels = width * height;
      if (!Number.isSafeInteger(pixels) || width < 64 || height < 64 || pixels > MAX_PNG_PIXELS) {
        throw new Error(`PNG dimensions are outside the live screenshot bounds: ${width}x${height}`);
      }
      if (body[8] !== 8 || ![2, 6].includes(body[9]) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
        throw new Error("PNG encoding is outside the supported RGB/RGBA non-interlaced subset");
      }
      channels = body[9] === 6 ? 4 : 3;
      sawHeader = true;
    } else if (type === "IDAT") {
      if (!sawHeader || dataEnded) throw new Error("PNG IDAT placement is invalid");
      sawData = true;
      compressed.push(body);
    } else if (type === "IEND") {
      if (length !== 0 || end !== png.length) throw new Error("PNG IEND or trailing data is invalid");
      sawEnd = true;
    } else {
      if (sawData) dataEnded = true;
      if (/^[A-Z]/.test(type)) throw new Error(`Unexpected critical PNG chunk ${type}`);
    }
    offset = end;
  }
  if (!sawHeader || !sawData || !sawEnd || channels === 0) {
    throw new Error("PNG is missing required chunks");
  }

  const stride = width * channels;
  const expectedDecoded = height * (stride + 1);
  let filtered: Buffer;
  try {
    filtered = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedDecoded + 1 });
  } catch {
    throw new Error("PNG compressed image data is invalid or exceeds its decoded budget");
  }
  if (filtered.length !== expectedDecoded) throw new Error("PNG decoded image length is invalid");
  const pixels = Buffer.allocUnsafe(width * height * channels);
  for (let row = 0; row < height; row += 1) {
    const filterOffset = row * (stride + 1);
    const filter = filtered[filterOffset];
    if (filter > 4) throw new Error(`PNG row ${row} uses invalid filter ${filter}`);
    const outputOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[filterOffset + 1 + column];
      const left = column >= channels ? pixels[outputOffset + column - channels] : 0;
      const above = row > 0 ? pixels[outputOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[outputOffset + column - stride - channels]
        : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      pixels[outputOffset + column] = (raw + predictor) & 0xff;
    }
  }

  return {
    width,
    height,
    channels,
    sourceByteCount: png.length,
    sourceSha256: createHash("sha256").update(png).digest("hex"),
    pixels,
  };
}

export function analyzePngMaterial(png: Buffer): PngMaterialEvidence {
  const decoded = decodePng(png);
  const { width, height, channels, pixels } = decoded;

  const pixelCount = width * height;
  const sampleStep = Math.max(1, Math.floor(pixelCount / 100_000));
  const colors = new Set<number>();
  let sampledPixels = 0;
  let nonBlack = 0;
  let luminanceMinimum = 255;
  let luminanceMaximum = 0;
  let luminanceMean = 0;
  let luminanceM2 = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const pixelOffset = pixel * channels;
    const red = pixels[pixelOffset];
    const green = pixels[pixelOffset + 1];
    const blue = pixels[pixelOffset + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sampledPixels += 1;
    if (Math.max(red, green, blue) > 8) nonBlack += 1;
    luminanceMinimum = Math.min(luminanceMinimum, luminance);
    luminanceMaximum = Math.max(luminanceMaximum, luminance);
    const delta = luminance - luminanceMean;
    luminanceMean += delta / sampledPixels;
    luminanceM2 += delta * (luminance - luminanceMean);
    if (colors.size < 4_096) {
      colors.add(((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3));
    }
  }
  const standardDeviation = Math.sqrt(luminanceM2 / Math.max(1, sampledPixels - 1));
  const nonBlackRatio = nonBlack / sampledPixels;
  const materiallyVaried = sampledPixels >= 1_000 && colors.size >= 16 && nonBlackRatio >= 0.01 &&
    luminanceMaximum - luminanceMinimum >= 10 && standardDeviation >= 2.5;
  return {
    width,
    height,
    channels,
    byteCount: decoded.sourceByteCount,
    sha256: decoded.sourceSha256,
    sampledPixels,
    quantizedColorCount: colors.size,
    nonBlackRatio: Number(nonBlackRatio.toFixed(6)),
    luminanceMinimum: Number(luminanceMinimum.toFixed(3)),
    luminanceMaximum: Number(luminanceMaximum.toFixed(3)),
    luminanceStandardDeviation: Number(standardDeviation.toFixed(3)),
    materiallyVaried,
  };
}

interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function assertDecodedImage(image: DecodedPngImage, label: string): void {
  const pixelCount = image.width * image.height;
  if (!Number.isSafeInteger(pixelCount) || image.width < 1 || image.height < 1 || pixelCount > MAX_PNG_PIXELS) {
    throw new Error(`${label} dimensions are invalid: ${image.width}x${image.height}`);
  }
  if (image.channels !== 3 && image.channels !== 4) {
    throw new Error(`${label} must contain RGB or RGBA pixels`);
  }
  if (!Buffer.isBuffer(image.pixels) || image.pixels.length !== pixelCount * image.channels) {
    throw new Error(`${label} decoded pixel length is invalid`);
  }
}

function boundedNumber(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function pixelRegionFor(
  image: Pick<DecodedPngImage, "width" | "height">,
  roi: NormalizedImageRegion | undefined
): PixelRegion {
  if (!roi) return { x: 0, y: 0, width: image.width, height: image.height };
  const x = boundedNumber("ROI x", roi.x, 0, 1);
  const y = boundedNumber("ROI y", roi.y, 0, 1);
  const width = boundedNumber("ROI width", roi.width, Number.MIN_VALUE, 1);
  const height = boundedNumber("ROI height", roi.height, Number.MIN_VALUE, 1);
  if (x + width > 1 + 1e-12 || y + height > 1 + 1e-12) {
    throw new Error("ROI must fit within the normalized image bounds");
  }

  // The small epsilon prevents an exact normalized boundary such as 0.1 + 0.2
  // from including a neighboring pixel solely because of floating-point rounding.
  const left = Math.min(image.width - 1, Math.floor(x * image.width + 1e-9));
  const top = Math.min(image.height - 1, Math.floor(y * image.height + 1e-9));
  const right = Math.max(
    left + 1,
    Math.min(image.width, Math.ceil(Math.min(1, x + width) * image.width - 1e-9))
  );
  const bottom = Math.max(
    top + 1,
    Math.min(image.height, Math.ceil(Math.min(1, y + height) * image.height - 1e-9))
  );
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function visibleChannel(image: DecodedPngImage, pixelOffset: number, channel: 0 | 1 | 2): number {
  const value = image.pixels[pixelOffset + channel];
  if (image.channels === 3) return value;
  return Math.round(value * image.pixels[pixelOffset + 3] / 255);
}

/**
 * Compare decoded screenshots over the same normalized region.
 *
 * Similar and materially different intentionally use separate thresholds. A result can be
 * neither, which prevents small animation/rendering noise from being promoted to evidence of
 * a changed view while still allowing strict restoration checks.
 */
export function compareDecodedPng(
  reference: DecodedPngImage,
  candidate: DecodedPngImage,
  options: PngComparisonOptions = {}
): PngComparisonEvidence {
  assertDecodedImage(reference, "Reference image");
  assertDecodedImage(candidate, "Candidate image");
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `Screenshot dimensions differ: ${reference.width}x${reference.height} versus ` +
      `${candidate.width}x${candidate.height}`
    );
  }

  const channelTolerance = boundedNumber(
    "Comparison channel tolerance",
    options.channelTolerance ?? 8,
    0,
    255
  );
  const minimumChangedPixelRatio = boundedNumber(
    "Minimum changed-pixel ratio",
    options.minimumChangedPixelRatio ?? 0.02,
    0,
    1
  );
  const minimumMeanAbsoluteError = boundedNumber(
    "Minimum mean absolute error",
    options.minimumMeanAbsoluteError ?? 2,
    0,
    255
  );
  if (minimumChangedPixelRatio === 0 && minimumMeanAbsoluteError === 0) {
    throw new Error("Material-difference thresholds cannot both be zero");
  }
  const maximumChangedPixelRatioForSimilarity = boundedNumber(
    "Maximum changed-pixel ratio for similarity",
    options.maximumChangedPixelRatioForSimilarity ?? 0.01,
    0,
    1
  );
  const maximumMeanAbsoluteErrorForSimilarity = boundedNumber(
    "Maximum mean absolute error for similarity",
    options.maximumMeanAbsoluteErrorForSimilarity ?? 1,
    0,
    255
  );
  const pixelRegion = pixelRegionFor(reference, options.roi);

  let comparedPixels = 0;
  let changedPixels = 0;
  let absoluteDifference = 0;
  let squaredDifference = 0;
  let maximumChannelDifference = 0;
  for (let y = pixelRegion.y; y < pixelRegion.y + pixelRegion.height; y += 1) {
    for (let x = pixelRegion.x; x < pixelRegion.x + pixelRegion.width; x += 1) {
      const referenceOffset = (y * reference.width + x) * reference.channels;
      const candidateOffset = (y * candidate.width + x) * candidate.channels;
      let pixelMaximum = 0;
      for (let channel = 0 as 0 | 1 | 2; channel < 3; channel += 1) {
        const delta = Math.abs(
          visibleChannel(reference, referenceOffset, channel) -
          visibleChannel(candidate, candidateOffset, channel)
        );
        absoluteDifference += delta;
        squaredDifference += delta * delta;
        pixelMaximum = Math.max(pixelMaximum, delta);
        maximumChannelDifference = Math.max(maximumChannelDifference, delta);
      }
      comparedPixels += 1;
      if (pixelMaximum > channelTolerance) changedPixels += 1;
    }
  }

  const channelSamples = comparedPixels * 3;
  const changedPixelRatio = changedPixels / comparedPixels;
  const meanAbsoluteError = absoluteDifference / channelSamples;
  const rootMeanSquareError = Math.sqrt(squaredDifference / channelSamples);
  return {
    width: reference.width,
    height: reference.height,
    pixelRegion,
    comparedPixels,
    changedPixels,
    changedPixelRatio: Number(changedPixelRatio.toFixed(6)),
    meanAbsoluteError: Number(meanAbsoluteError.toFixed(6)),
    rootMeanSquareError: Number(rootMeanSquareError.toFixed(6)),
    maximumChannelDifference,
    similarityScore: Number(Math.max(0, 1 - rootMeanSquareError / 255).toFixed(6)),
    materiallyDifferent:
      changedPixelRatio >= minimumChangedPixelRatio && meanAbsoluteError >= minimumMeanAbsoluteError,
    materiallySimilar:
      changedPixelRatio <= maximumChangedPixelRatioForSimilarity &&
      meanAbsoluteError <= maximumMeanAbsoluteErrorForSimilarity,
  };
}

export function comparePngImages(
  reference: Buffer,
  candidate: Buffer,
  options: PngComparisonOptions = {}
): PngComparisonEvidence {
  return compareDecodedPng(decodePng(reference), decodePng(candidate), options);
}

export function detectColorMarker(
  image: DecodedPngImage,
  options: ColorMarkerOptions
): ColorMarkerEvidence {
  assertDecodedImage(image, "Marker image");
  if (!Array.isArray(options.color) || options.color.length !== 3) {
    throw new Error("Marker color must contain exactly three RGB channels");
  }
  const markerChannel = (channel: number, index: number): number => {
    if (!Number.isInteger(channel)) {
      throw new Error(`Marker color channel ${index} must be an integer`);
    }
    return boundedNumber(`Marker color channel ${index}`, channel, 0, 255);
  };
  const color: [number, number, number] = [
    markerChannel(options.color[0], 0),
    markerChannel(options.color[1], 1),
    markerChannel(options.color[2], 2),
  ];
  const channelTolerance = boundedNumber(
    "Marker channel tolerance",
    options.channelTolerance ?? 24,
    0,
    255
  );
  const minimumMatchingPixels = options.minimumMatchingPixels ?? 16;
  if (!Number.isSafeInteger(minimumMatchingPixels) || minimumMatchingPixels < 1) {
    throw new Error("Minimum matching marker pixels must be a positive safe integer");
  }
  const minimumMatchRatio = boundedNumber(
    "Minimum marker match ratio",
    options.minimumMatchRatio ?? 0.001,
    0,
    1
  );
  const minimumAlpha = boundedNumber("Minimum marker alpha", options.minimumAlpha ?? 128, 0, 255);
  const pixelRegion = pixelRegionFor(image, options.roi);

  let matchingPixels = 0;
  let sumX = 0;
  let sumY = 0;
  let minimumX = image.width;
  let minimumY = image.height;
  let maximumX = -1;
  let maximumY = -1;
  for (let y = pixelRegion.y; y < pixelRegion.y + pixelRegion.height; y += 1) {
    for (let x = pixelRegion.x; x < pixelRegion.x + pixelRegion.width; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      const alpha = image.channels === 4 ? image.pixels[offset + 3] : 255;
      if (
        alpha >= minimumAlpha &&
        Math.abs(image.pixels[offset] - color[0]) <= channelTolerance &&
        Math.abs(image.pixels[offset + 1] - color[1]) <= channelTolerance &&
        Math.abs(image.pixels[offset + 2] - color[2]) <= channelTolerance
      ) {
        matchingPixels += 1;
        sumX += x;
        sumY += y;
        minimumX = Math.min(minimumX, x);
        minimumY = Math.min(minimumY, y);
        maximumX = Math.max(maximumX, x);
        maximumY = Math.max(maximumY, y);
      }
    }
  }

  const inspectedPixels = pixelRegion.width * pixelRegion.height;
  const matchingPixelRatio = matchingPixels / inspectedPixels;
  return {
    detected: matchingPixels >= minimumMatchingPixels && matchingPixelRatio >= minimumMatchRatio,
    inspectedPixels,
    matchingPixels,
    matchingPixelRatio: Number(matchingPixelRatio.toFixed(6)),
    pixelBounds: matchingPixels > 0
      ? {
          x: minimumX,
          y: minimumY,
          width: maximumX - minimumX + 1,
          height: maximumY - minimumY + 1,
        }
      : null,
    normalizedCentroid: matchingPixels > 0
      ? [
          Number(((sumX / matchingPixels + 0.5) / image.width).toFixed(6)),
          Number(((sumY / matchingPixels + 0.5) / image.height).toFixed(6)),
        ]
      : null,
  };
}

export function detectPngColorMarker(png: Buffer, options: ColorMarkerOptions): ColorMarkerEvidence {
  return detectColorMarker(decodePng(png), options);
}
