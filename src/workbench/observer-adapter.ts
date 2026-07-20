import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import type {
  WorkbenchCallOptions,
  WorkbenchCaptureActivityLease,
  WorkbenchObserverSnapshot,
} from "./client.js";

const ADAPTER_PROTOCOL = "reforger-forge-workbench-observer/1";
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 32_000_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

const finite = z.number().finite();
const workbenchBoolean = z.union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => value === true || value === 1);
const vector3 = z.tuple([finite, finite, finite]);
const quaternion = z.tuple([finite, finite, finite, finite]).refine((value) => {
  const length = Math.hypot(...value);
  return length > 0 && Math.abs(length - 1) <= 0.01;
}, "orientation must be a normalized quaternion");

const viewSchema = z.union([
  z.object({ kind: z.literal("current") }).strict(),
  z.object({
    kind: z.literal("pose"),
    position: vector3,
    orientation: quaternion,
    fov: finite.min(1).max(179),
  }).strict(),
  z.object({
    kind: z.literal("lookAt"),
    position: vector3,
    target: vector3,
    fov: finite.min(1).max(179),
  }).strict().refine((value) => distance(value.position, value.target) > 0.0001, {
    message: "lookAt position and target must differ",
    path: ["target"],
  }),
]);

const submitSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/).optional(),
  view: viewSchema,
  settlePolls: z.number().int().min(0).max(120).default(3),
}).strict();

const pingResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  message: z.string(),
  adapterProtocol: z.literal(ADAPTER_PROTOCOL),
  projectFile: z.string(),
  worldIdentity: z.string(),
  activeJobId: z.string().optional().default(""),
  captureCurrent: workbenchBoolean,
  restorationApiAvailable: workbenchBoolean,
  cameraEditor: workbenchBoolean,
}).passthrough();

const jobResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  message: z.string(),
  adapterProtocol: z.literal(ADAPTER_PROTOCOL),
  jobId: z.string().default(""),
  leaseId: z.string().default(""),
  lifecycleGeneration: z.string().default(""),
  canonicalTarget: z.string().default(""),
  projectFile: z.string().default(""),
  worldIdentity: z.string().default(""),
  viewKind: z.enum(["current", "pose", "lookAt"]).optional(),
  state: z.string().default(""),
  terminalErrorCode: z.string().default(""),
  artifactLogicalPath: z.string().default(""),
  artifactPath: z.string().default(""),
  cameraMatrix0: z.string().default(""),
  cameraMatrix1: z.string().default(""),
  cameraMatrix2: z.string().default(""),
  cameraMatrix3: z.string().default(""),
  sequence: z.number().int().min(0).default(0),
  settlePolls: z.number().int().min(0).max(120).default(0),
  settledPolls: z.number().int().min(0).default(0),
  artifactBytes: z.number().int().min(0).default(0),
  ownerCameraId: z.number().int().default(0),
  actualFov: finite.default(0),
  nearPlane: finite.default(0),
  farPlane: finite.default(0),
  cameraLeaseHeld: workbenchBoolean.default(false),
  restorationConfirmed: workbenchBoolean.default(false),
}).passthrough();

const releaseResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  message: z.string(),
  adapterProtocol: z.literal(ADAPTER_PROTOCOL),
  jobId: z.string(),
  restorationConfirmed: workbenchBoolean,
  artifactRemoved: workbenchBoolean,
}).passthrough();

export type WorkbenchObserverView = z.infer<typeof viewSchema>;

export interface WorkbenchObserverSubmitInput {
  jobId?: string;
  view: WorkbenchObserverView;
  settlePolls?: number;
}

export interface WorkbenchObserverArtifact {
  format: "png";
  path: string;
  logicalPath: string;
  bytes: number;
  pngBytes: number;
  width: number;
  height: number;
  sha256: string;
  pngSha256: string;
  completedAt: string;
}

export interface WorkbenchObserverJobStatus {
  jobId: string;
  instanceId: string;
  lifecycleGeneration: string;
  canonicalTarget: string;
  worldIdentity: string;
  viewKind: "current" | "pose" | "lookAt";
  state: string;
  sequence: number;
  message: string;
  terminalErrorCode?: string;
  cameraLeaseHeld: boolean;
  restorationConfirmed: boolean;
  ownerCameraId: number;
  actualFov: number;
  actualCamera: {
    matrix: WorkbenchCameraMatrix;
    position: [number, number, number];
    verticalFov: number;
    nearPlane: number;
    farPlane: number;
  };
  artifact?: WorkbenchObserverArtifact;
}

export interface WorkbenchObserverInstance {
  instanceId: string;
  lifecycleGeneration: string;
  canonicalTarget: string;
  endpoint: { host: string; port: number };
  process: WorkbenchObserverSnapshot["process"];
  projectFile: string;
  worldIdentity: string;
  capabilities: string[];
  activeJobId: string | null;
  restorationApiAvailable: boolean;
  readinessMessage: string;
}

export interface WorkbenchObserverAdapterOptions {
  handlerTimeoutMs?: number;
  maxArtifactBytes?: number;
  maxPixels?: number;
  createJobId?: () => string;
  /** Must be stable for a job ID so a fresh MCP process can recover the
   *  handler transaction from its durable job association. */
  createLeaseId?: (jobId: string) => string;
}

export interface WorkbenchObserverRecoverInput {
  jobId: string;
  /** Durable lifecycle/target binding recorded when the run capture was submitted. */
  expectedInstanceId?: string;
}

export interface WorkbenchObserverClient {
  call<T = Record<string, unknown>>(
    apiFunc: string,
    params?: Record<string, unknown>,
    options?: WorkbenchCallOptions
  ): Promise<T>;
  getRunningObserverSnapshot(): Promise<WorkbenchObserverSnapshot>;
  acquireCaptureActivity(snapshot: WorkbenchObserverSnapshot): WorkbenchCaptureActivityLease;
  revalidateCaptureActivity(lease: WorkbenchCaptureActivityLease): Promise<WorkbenchObserverSnapshot>;
  releaseCaptureActivity(lease: WorkbenchCaptureActivityLease): void;
}

export type WorkbenchObserverAdapterErrorCode =
  | "INVALID_REQUEST"
  | "HANDLER_UNAVAILABLE"
  | "HANDLER_REJECTED"
  | "CAPABILITY_UNAVAILABLE"
  | "JOB_NOT_FOUND"
  | "STALE_LIFECYCLE"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_TOO_LARGE"
  | "CAMERA_BUSY"
  | "RESTORATION_UNCONFIRMED";

export class WorkbenchObserverAdapterError extends Error {
  constructor(
    public readonly code: WorkbenchObserverAdapterErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkbenchObserverAdapterError";
  }
}

interface AdapterJobRecord {
  readonly jobId: string;
  readonly instanceId: string;
  readonly snapshot: WorkbenchObserverSnapshot;
  readonly activityLease: WorkbenchCaptureActivityLease;
  readonly viewKind: "current" | "pose" | "lookAt";
  handlerLeaseId: string | null;
  lastStatus: WorkbenchObserverJobStatus | null;
  gateReleased: boolean;
  released: boolean;
  ready: Promise<void>;
  markReady(): void;
  abortListener(): void;
}

export type WorkbenchCameraMatrix = [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];

function distance(left: readonly number[], right: readonly number[]): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function normalizePath(value: string): string {
  const absolute = resolve(value);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function instanceId(snapshot: WorkbenchObserverSnapshot): string {
  const target = createHash("sha256").update(snapshot.target.comparisonKey).digest("hex").slice(0, 16);
  return `workbench-${snapshot.generation}-${target}`;
}

function recoverableHandlerLeaseId(jobId: string): string {
  // jobId is already a random, bounded identifier. Deriving the handler lease
  // from it makes the binding reproducible after an MCP restart while the
  // lifecycle generation and canonical target remain independently enforced.
  return `wb-observer-${jobId}`;
}

function vectorToString(value: readonly number[]): string {
  return value.map((entry) => Object.is(entry, -0) ? "0" : entry.toString()).join(" ");
}

function decimalWireValue(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
    throw new WorkbenchObserverAdapterError("INVALID_REQUEST", "Workbench wire value is not a bounded finite number");
  }
  const fixed = (Object.is(value, -0) ? 0 : value).toFixed(9).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function vectorFromString(value: string): [number, number, number] {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((entry) => !Number.isFinite(entry))) {
    throw new WorkbenchObserverAdapterError("HANDLER_UNAVAILABLE", "Workbench observer returned an invalid camera matrix");
  }
  return [parts[0], parts[1], parts[2]];
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function normalize(value: [number, number, number]): [number, number, number] {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length <= 0.000001) {
    throw new WorkbenchObserverAdapterError("INVALID_REQUEST", "Camera basis contains a degenerate vector");
  }
  return [value[0] / length, value[1] / length, value[2] / length];
}

function cross(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

/** Enfusion transform rows are right, up, forward, translation. */
export function workbenchCameraMatrix(view: Exclude<WorkbenchObserverView, { kind: "current" }>): WorkbenchCameraMatrix {
  if (view.kind === "lookAt") {
    const forward = normalize([
      view.target[0] - view.position[0],
      view.target[1] - view.position[1],
      view.target[2] - view.position[2],
    ]);
    const preferredUp: [number, number, number] = Math.abs(forward[1]) > 0.999
      ? [0, 0, 1]
      : [0, 1, 0];
    const right = normalize(cross(preferredUp, forward));
    const up = normalize(cross(forward, right));
    return [right, up, forward, [view.position[0], view.position[1], view.position[2]]];
  }

  let [x, y, z, w] = view.orientation;
  const length = Math.hypot(x, y, z, w);
  x /= length;
  y /= length;
  z /= length;
  w /= length;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    [view.position[0], view.position[1], view.position[2]],
  ];
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return result;
}

export class WorkbenchObserverAdapter {
  private readonly handlerTimeoutMs: number;
  private readonly maxArtifactBytes: number;
  private readonly maxPixels: number;
  private readonly createJobId: () => string;
  private readonly createLeaseId: (jobId: string) => string;
  private readonly jobs = new Map<string, AdapterJobRecord>();
  private readonly completedImages = new Map<string, Buffer>();

  constructor(
    private readonly client: WorkbenchObserverClient,
    options: WorkbenchObserverAdapterOptions = {}
  ) {
    this.handlerTimeoutMs = positiveInteger(options.handlerTimeoutMs, DEFAULT_HANDLER_TIMEOUT_MS, "Workbench observer handler timeout");
    this.maxArtifactBytes = positiveInteger(options.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, "Workbench observer artifact limit");
    this.maxPixels = positiveInteger(options.maxPixels, DEFAULT_MAX_PIXELS, "Workbench observer pixel limit");
    this.createJobId = options.createJobId ?? (() => randomUUID());
    this.createLeaseId = options.createLeaseId ?? recoverableHandlerLeaseId;
  }

  async instances(): Promise<WorkbenchObserverInstance[]> {
    const snapshot = await this.client.getRunningObserverSnapshot();
    const ping = await this.pingSnapshot();
    const capabilities: string[] = [];
    if (ping.captureCurrent) capabilities.push("render.capture");
    if (ping.cameraEditor) capabilities.push("camera.editor");
    return [{
      instanceId: instanceId(snapshot),
      lifecycleGeneration: snapshot.generation,
      canonicalTarget: snapshot.target.path,
      endpoint: { ...snapshot.endpoint },
      process: snapshot.process,
      // Workbench.GetCurrentGameProjectFile() reports the base game's settings
      // project, while the lifecycle guard is authoritative for the launched
      // mod .gproj target exposed publicly here.
      projectFile: snapshot.target.path,
      worldIdentity: ping.worldIdentity,
      capabilities,
      activeJobId: ping.activeJobId || null,
      restorationApiAvailable: ping.restorationApiAvailable,
      readinessMessage: ping.message,
    }];
  }

  async ping(): Promise<WorkbenchObserverInstance> {
    const instances = await this.instances();
    return instances[0];
  }

  async submit(input: WorkbenchObserverSubmitInput): Promise<WorkbenchObserverJobStatus> {
    const parsed = submitSchema.safeParse(input);
    if (!parsed.success) {
      throw new WorkbenchObserverAdapterError("INVALID_REQUEST", parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    const snapshot = await this.client.getRunningObserverSnapshot();
    const ping = await this.pingSnapshot();
    if (!ping.captureCurrent) {
      throw new WorkbenchObserverAdapterError("CAPABILITY_UNAVAILABLE", ping.message || "Workbench current-view capture is unavailable");
    }
    if (parsed.data.view.kind !== "current" && !ping.cameraEditor) {
      throw new WorkbenchObserverAdapterError(
        "CAPABILITY_UNAVAILABLE",
        "camera.editor is not advertised until this exact Workbench process has completed an exact current-view restoration proof"
      );
    }

    const jobId = parsed.data.jobId ?? this.createJobId();
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(jobId) || this.jobs.has(jobId)) {
      throw new WorkbenchObserverAdapterError("INVALID_REQUEST", "Workbench observer job ID is invalid or already retained");
    }
    const handlerLeaseId = this.createLeaseId(jobId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(handlerLeaseId)) {
      throw new WorkbenchObserverAdapterError("INVALID_REQUEST", "Generated Workbench observer handler lease is invalid");
    }
    const activityLease = this.client.acquireCaptureActivity(snapshot);
    try {
      const current = await this.client.revalidateCaptureActivity(activityLease);
      if (current.generation !== snapshot.generation || current.target.comparisonKey !== snapshot.target.comparisonKey) {
        throw new WorkbenchObserverAdapterError("STALE_LIFECYCLE", "Workbench lifecycle changed before observer submission");
      }
    } catch (error) {
      this.client.releaseCaptureActivity(activityLease);
      throw this.mapError(error, "STALE_LIFECYCLE");
    }
    let markReady!: () => void;
    const ready = new Promise<void>((resolveReady) => { markReady = resolveReady; });
    const record: AdapterJobRecord = {
      jobId,
      instanceId: instanceId(snapshot),
      snapshot,
      activityLease,
      viewKind: parsed.data.view.kind,
      handlerLeaseId,
      lastStatus: null,
      gateReleased: false,
      released: false,
      ready,
      markReady,
      abortListener: () => { void this.cancelForLifecycle(record); },
    };
    this.jobs.set(jobId, record);
    activityLease.signal.addEventListener("abort", record.abortListener, { once: true });

    let deliveryUncertain = false;
    try {
      const matrix = parsed.data.view.kind === "current"
        ? [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] as WorkbenchCameraMatrix
        : workbenchCameraMatrix(parsed.data.view);
      const submitRequest = {
        jobId,
        leaseId: handlerLeaseId,
        lifecycleGeneration: snapshot.generation,
        canonicalTarget: snapshot.target.path,
        viewKind: parsed.data.view.kind,
        matrix0: vectorToString(matrix[0]),
        matrix1: vectorToString(matrix[1]),
        matrix2: vectorToString(matrix[2]),
        matrix3: vectorToString(matrix[3]),
        fovText: decimalWireValue(parsed.data.view.kind === "current" ? 0 : parsed.data.view.fov),
        settlePolls: parsed.data.settlePolls,
      };
      let response: z.infer<typeof jobResponseSchema>;
      try {
        response = await this.handlerJobCall("EMCP_WB_ObserverSubmit", submitRequest);
      } catch {
        deliveryUncertain = true;
        this.convergeAbort(record);
        if (record.gateReleased) {
          throw new WorkbenchObserverAdapterError("HANDLER_UNAVAILABLE", "Workbench exited before observer submit acknowledgement");
        }
        // Submit is idempotent for this exact command tuple. One bounded retry
        // recovers an acknowledgement lost after handler-side camera retention.
        response = await this.handlerJobCall("EMCP_WB_ObserverSubmit", submitRequest);
      }
      if (response.status !== "ok") {
        throw new WorkbenchObserverAdapterError("HANDLER_REJECTED", response.message);
      }
      // An ok response means the command may own camera state until all
      // acknowledgement bindings and the public status parse are proven.
      deliveryUncertain = true;
      this.assertResponseBinding(response, record);
      if (response.leaseId !== handlerLeaseId) {
        throw new WorkbenchObserverAdapterError("STALE_LIFECYCLE", "Workbench observer submit acknowledged a different handler lease");
      }
      record.lastStatus = this.publicStatus(record, response);
      deliveryUncertain = false;
      return record.lastStatus;
    } catch (error) {
      let safeToRelease = true;
      if (deliveryUncertain && !record.gateReleased) {
        safeToRelease = await this.recoverUnacknowledgedSubmit(record);
      }
      if (!safeToRelease) {
        throw new WorkbenchObserverAdapterError(
          "RESTORATION_UNCONFIRMED",
          `Workbench observer submit ${jobId} could not be acknowledged or proven restored; lifecycle mutation remains blocked`
        );
      }
      this.jobs.delete(jobId);
      this.releaseGate(record);
      throw this.mapError(error);
    } finally {
      record.markReady();
    }
  }

  async status(jobId: string): Promise<WorkbenchObserverJobStatus> {
    const record = this.requireJob(jobId);
    this.convergeAbort(record);
    if (record.gateReleased && record.lastStatus && TERMINAL_STATES.has(record.lastStatus.state)) {
      return record.lastStatus;
    }
    await this.revalidate(record);
    const response = await this.handlerJobCall("EMCP_WB_ObserverStatus", this.boundRequest(record));
    if (response.status !== "ok") {
      throw new WorkbenchObserverAdapterError("HANDLER_REJECTED", response.message);
    }
    this.assertResponseBinding(response, record);
    let status: WorkbenchObserverJobStatus;
    try {
      status = this.publicStatus(record, response);
    } catch (error) {
      // Artifact validation is downstream of handler-proven camera restoration.
      // Preserve the terminal status and release the lifecycle activity gate
      // even when the generated image is corrupt or otherwise unacceptable.
      if (TERMINAL_STATES.has(response.state) && !response.cameraLeaseHeld && response.restorationConfirmed) {
        record.lastStatus = this.publicStatus(record, response, false);
        this.releaseGate(record);
      }
      throw error;
    }
    record.lastStatus = status;
    if (TERMINAL_STATES.has(status.state) && !status.cameraLeaseHeld && status.restorationConfirmed) this.releaseGate(record);
    return status;
  }

  /**
   * Reattach this adapter to a handler transaction retained by the exact same
   * Workbench lifecycle. This does not adopt arbitrary jobs: the random job ID,
   * deterministic handler lease, lifecycle generation, canonical target, and
   * optional durable instance ID must all agree before a status is accepted.
   */
  async recover(input: WorkbenchObserverRecoverInput): Promise<WorkbenchObserverJobStatus> {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(input.jobId)) {
      throw new WorkbenchObserverAdapterError("INVALID_REQUEST", "Workbench observer recovery job ID is invalid");
    }
    const retained = this.jobs.get(input.jobId);
    if (retained) {
      if (input.expectedInstanceId && retained.instanceId !== input.expectedInstanceId) {
        throw new WorkbenchObserverAdapterError("STALE_LIFECYCLE", "Retained Workbench observer job belongs to a different lifecycle instance");
      }
      return this.status(input.jobId);
    }

    const snapshot = await this.client.getRunningObserverSnapshot();
    const recoveredInstanceId = instanceId(snapshot);
    if (input.expectedInstanceId && recoveredInstanceId !== input.expectedInstanceId) {
      throw new WorkbenchObserverAdapterError("STALE_LIFECYCLE", "Workbench observer job belongs to an old lifecycle generation or canonical target");
    }
    const ping = await this.pingSnapshot();
    if (ping.activeJobId !== input.jobId) {
      throw new WorkbenchObserverAdapterError("JOB_NOT_FOUND", `Workbench observer job ${input.jobId} is not retained by the current handler`);
    }
    const handlerLeaseId = this.createLeaseId(input.jobId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(handlerLeaseId)) {
      throw new WorkbenchObserverAdapterError("INVALID_REQUEST", "Recovered Workbench observer handler lease is invalid");
    }

    const activityLease = this.client.acquireCaptureActivity(snapshot);
    try {
      const current = await this.client.revalidateCaptureActivity(activityLease);
      if (current.generation !== snapshot.generation || current.target.comparisonKey !== snapshot.target.comparisonKey) {
        throw new WorkbenchObserverAdapterError("STALE_LIFECYCLE", "Workbench lifecycle changed during observer recovery");
      }
    } catch (error) {
      this.client.releaseCaptureActivity(activityLease);
      throw this.mapError(error, "STALE_LIFECYCLE");
    }

    const ready = Promise.resolve();
    const record: AdapterJobRecord = {
      jobId: input.jobId,
      instanceId: recoveredInstanceId,
      snapshot,
      activityLease,
      // Status responses always carry the retained view kind. Current is only
      // a non-mutating provisional value used if a broken handler omits it.
      viewKind: "current",
      handlerLeaseId,
      lastStatus: null,
      gateReleased: false,
      released: false,
      ready,
      markReady: () => undefined,
      abortListener: () => { void this.cancelForLifecycle(record); },
    };
    this.jobs.set(input.jobId, record);
    activityLease.signal.addEventListener("abort", record.abortListener, { once: true });

    // Keep the record and activity gate fail-closed if the handler call is
    // temporarily unavailable. A later recovery/status call can converge it;
    // dropping the record here could allow lifecycle mutation to overtake an
    // unproven camera lease.
    return this.status(input.jobId);
  }

  async cancel(jobId: string): Promise<WorkbenchObserverJobStatus> {
    const record = this.requireJob(jobId);
    this.convergeAbort(record);
    if (record.gateReleased && record.lastStatus && TERMINAL_STATES.has(record.lastStatus.state)) {
      return record.lastStatus;
    }
    await this.revalidate(record);
    return this.cancelBound(record);
  }

  async release(jobId: string): Promise<{ jobId: string; restorationConfirmed: boolean; artifactRemoved: boolean }> {
    const record = this.requireJob(jobId);
    this.convergeAbort(record);
    if (record.lastStatus?.terminalErrorCode === "WORKBENCH_EXITED") {
      record.released = true;
      this.jobs.delete(jobId);
      this.completedImages.delete(jobId);
      this.releaseGate(record);
      return { jobId, restorationConfirmed: false, artifactRemoved: false };
    }
    const status = record.lastStatus;
    if (!status || !TERMINAL_STATES.has(status.state) || status.cameraLeaseHeld || !status.restorationConfirmed) {
      throw new WorkbenchObserverAdapterError(
        "CAMERA_BUSY",
        "Workbench observer release requires a terminal job with proven restoration; cancel the active job first"
      );
    }
    if (!record.gateReleased) await this.revalidate(record);
    if (!record.handlerLeaseId) {
      throw new WorkbenchObserverAdapterError("HANDLER_UNAVAILABLE", "Workbench observer handler lease is unavailable");
    }
    const raw = await this.client.call<unknown>("EMCP_WB_ObserverRelease", this.boundRequest(record), this.callOptions());
    const parsed = releaseResponseSchema.safeParse(raw);
    if (!parsed.success) throw new WorkbenchObserverAdapterError("HANDLER_UNAVAILABLE", "Workbench observer release returned an invalid response");
    if (parsed.data.status !== "ok") throw new WorkbenchObserverAdapterError("HANDLER_REJECTED", parsed.data.message);
    if (parsed.data.restorationConfirmed) {
      record.released = true;
      this.jobs.delete(jobId);
      this.completedImages.delete(jobId);
      this.releaseGate(record);
    } else {
      throw new WorkbenchObserverAdapterError("RESTORATION_UNCONFIRMED", parsed.data.message);
    }
    return {
      jobId,
      restorationConfirmed: parsed.data.restorationConfirmed,
      artifactRemoved: parsed.data.artifactRemoved,
    };
  }

  readCompletedArtifact(jobId: string): { image: Buffer; metadata: Record<string, unknown> } {
    const record = this.requireJob(jobId);
    const status = record.lastStatus;
    const image = this.completedImages.get(jobId);
    if (!status || status.state !== "completed" || !status.artifact || !image) {
      throw new WorkbenchObserverAdapterError("JOB_NOT_FOUND", `Workbench observer job ${jobId} has no completed retained image`);
    }
    return {
      image: Buffer.from(image),
      metadata: {
        width: status.artifact.width,
        height: status.artifact.height,
        contentSha256: status.artifact.pngSha256,
        sourceContentSha256: status.artifact.sha256,
        bytes: status.artifact.pngBytes,
        sourceBytes: status.artifact.bytes,
        completedAt: status.artifact.completedAt,
        actualCamera: status.actualCamera,
        actualFov: status.actualFov,
        contaminated: false,
        warnings: [],
      },
    };
  }

  /** Restore every retained handler lease before owner-scoped shutdown/cleanup. */
  async restoreAll(): Promise<void> {
    const failures: Error[] = [];
    for (const record of [...this.jobs.values()]) {
      if (record.released) continue;
      try {
        this.convergeAbort(record);
        const exitReason = record.activityLease.signal.reason as { code?: unknown } | undefined;
        if (exitReason?.code === "WORKBENCH_EXITED") {
          record.released = true;
          this.jobs.delete(record.jobId);
          this.completedImages.delete(record.jobId);
          this.releaseGate(record);
          continue;
        }
        let status = record.lastStatus;
        if (!status || !TERMINAL_STATES.has(status.state) || status.cameraLeaseHeld || !status.restorationConfirmed) {
          status = await this.cancelBound(record);
        }
        if (status.cameraLeaseHeld || !status.restorationConfirmed) {
          throw new WorkbenchObserverAdapterError(
            "RESTORATION_UNCONFIRMED",
            `Workbench observer job ${record.jobId} could not prove restoration during shutdown`
          );
        }
        await this.release(record.jobId);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more Workbench observer camera leases could not be restored");
    }
  }

  private async pingSnapshot(): Promise<z.infer<typeof pingResponseSchema>> {
    const raw = await this.client.call<unknown>("EMCP_WB_ObserverPing", {}, this.callOptions());
    const parsed = pingResponseSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
        .join("; ");
      throw new WorkbenchObserverAdapterError(
        "HANDLER_UNAVAILABLE",
        `Workbench observer ping returned an invalid response (${issues})`
      );
    }
    if (parsed.data.status !== "ok") throw new WorkbenchObserverAdapterError("HANDLER_REJECTED", parsed.data.message);
    if (!parsed.data.projectFile) {
      throw new WorkbenchObserverAdapterError("HANDLER_UNAVAILABLE", "Workbench observer handler omitted its base game project identity");
    }
    return parsed.data;
  }

  private async recoverUnacknowledgedSubmit(record: AdapterJobRecord): Promise<boolean> {
    try {
      const status = await this.cancelBound(record);
      return !status.cameraLeaseHeld && status.restorationConfirmed;
    } catch {
      this.convergeAbort(record);
      if (record.gateReleased) return true;
      try {
        const ping = await this.pingSnapshot();
        // A different or empty active job proves this random lease did not
        // retain handler state. The matching job remains fail-closed so a
        // lifecycle operation cannot overtake unproven camera restoration.
        return ping.activeJobId !== record.jobId;
      } catch {
        return false;
      }
    }
  }

  private callOptions(): WorkbenchCallOptions {
    return { skipAutoLaunch: true, timeout: this.handlerTimeoutMs };
  }

  private boundRequest(record: AdapterJobRecord): Record<string, unknown> {
    return {
      jobId: record.jobId,
      leaseId: record.handlerLeaseId ?? "",
      lifecycleGeneration: record.snapshot.generation,
      canonicalTarget: record.snapshot.target.path,
    };
  }

  private async handlerJobCall(apiFunc: string, params: Record<string, unknown>): Promise<z.infer<typeof jobResponseSchema>> {
    const raw = await this.client.call<unknown>(apiFunc, params, this.callOptions());
    const parsed = jobResponseSchema.safeParse(raw);
    if (!parsed.success) throw new WorkbenchObserverAdapterError("HANDLER_UNAVAILABLE", `${apiFunc} returned an invalid response`);
    return parsed.data;
  }

  private assertResponseBinding(response: z.infer<typeof jobResponseSchema>, record: AdapterJobRecord): void {
    if (response.jobId !== record.jobId || response.lifecycleGeneration !== record.snapshot.generation ||
        !samePath(response.canonicalTarget, record.snapshot.target.path) || !response.projectFile) {
      throw new WorkbenchObserverAdapterError("STALE_LIFECYCLE", "Workbench observer response is bound to a different job, lifecycle generation, or canonical target");
    }
  }

  private publicStatus(
    record: AdapterJobRecord,
    response: z.infer<typeof jobResponseSchema>,
    validateArtifact = true
  ): WorkbenchObserverJobStatus {
    const result: WorkbenchObserverJobStatus = {
      jobId: record.jobId,
      instanceId: record.instanceId,
      lifecycleGeneration: record.snapshot.generation,
      canonicalTarget: record.snapshot.target.path,
      worldIdentity: response.worldIdentity,
      viewKind: response.viewKind ?? record.viewKind,
      state: response.state,
      sequence: response.sequence,
      message: response.message,
      ...(response.terminalErrorCode ? { terminalErrorCode: response.terminalErrorCode } : {}),
      cameraLeaseHeld: response.cameraLeaseHeld,
      restorationConfirmed: response.restorationConfirmed,
      ownerCameraId: response.ownerCameraId,
      actualFov: response.actualFov,
      actualCamera: {
        matrix: [
          vectorFromString(response.cameraMatrix0),
          vectorFromString(response.cameraMatrix1),
          vectorFromString(response.cameraMatrix2),
          vectorFromString(response.cameraMatrix3),
        ],
        position: vectorFromString(response.cameraMatrix3),
        verticalFov: response.actualFov,
        nearPlane: response.nearPlane,
        farPlane: response.farPlane,
      },
    };
    if (response.state === "completed" && validateArtifact) result.artifact = this.validateArtifact(record, response);
    if (response.terminalErrorCode === "RESTORATION_UNCONFIRMED") {
      result.terminalErrorCode = "RESTORATION_UNCONFIRMED";
    }
    return result;
  }

  private validateArtifact(
    record: AdapterJobRecord,
    response: z.infer<typeof jobResponseSchema>
  ): WorkbenchObserverArtifact {
    const expectedLogical = `$profile:ReforgerForgeObserver/workbench/${record.jobId}.png`;
    const expectedPhysical = resolve(
      record.snapshot.companion.profilePath,
      "profile",
      "ReforgerForgeObserver",
      "workbench",
      `${record.jobId}.png`
    );
    if (response.artifactLogicalPath !== expectedLogical || !isAbsolute(response.artifactPath) ||
        basename(response.artifactPath).toLowerCase() !== `${record.jobId.toLowerCase()}.png` ||
        !samePath(response.artifactPath, expectedPhysical)) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench returned an unexpected generated artifact path");
    }
    const captureDirectory = dirname(response.artifactPath);
    if (basename(captureDirectory).toLowerCase() !== "workbench" ||
        basename(dirname(captureDirectory)).toLowerCase() !== "reforgerforgeobserver") {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench artifact escaped the generated profile capture directory");
    }
    const info = lstatSync(response.artifactPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench artifact is not a regular file");
    }
    if (info.size <= 33 || info.size > this.maxArtifactBytes) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_TOO_LARGE", "Workbench artifact is empty or exceeds the reviewed size bound");
    }
    if (response.artifactBytes !== info.size) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench artifact length changed after stable completion");
    }
    const canonical = realpathSync.native(response.artifactPath);
    if (!samePath(canonical, response.artifactPath)) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench artifact path changed during canonicalization");
    }
    const bytes = readFileSync(canonical);
    const dimensions = this.validatePng(bytes);
    this.completedImages.set(record.jobId, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      format: "png",
      path: canonical,
      logicalPath: response.artifactLogicalPath,
      bytes: bytes.length,
      pngBytes: bytes.length,
      width: dimensions.width,
      height: dimensions.height,
      sha256: digest,
      pngSha256: digest,
      completedAt: info.mtime.toISOString(),
    };
  }

  private validatePng(bytes: Buffer): { width: number; height: number } {
    if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench artifact is not a PNG file");
    }
    let offset = PNG_SIGNATURE.length;
    let width = 0;
    let height = 0;
    let channels = 0;
    let sawHeader = false;
    let sawEnd = false;
    const imageData: Buffer[] = [];
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) {
        throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG contains a truncated chunk header");
      }
      const length = bytes.readUInt32BE(offset);
      const typeOffset = offset + 4;
      const dataOffset = typeOffset + 4;
      const dataEnd = dataOffset + length;
      const chunkEnd = dataEnd + 4;
      if (dataEnd < dataOffset || chunkEnd > bytes.length) {
        throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG contains a truncated or overflowing chunk");
      }
      const type = bytes.toString("ascii", typeOffset, dataOffset);
      if (!/^[A-Za-z]{4}$/.test(type) || bytes.readUInt32BE(dataEnd) !== crc32(bytes.subarray(typeOffset, dataEnd))) {
        throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG contains an invalid chunk type or checksum");
      }
      if (!sawHeader) {
        if (type !== "IHDR" || length !== 13) {
          throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG does not begin with one valid IHDR chunk");
        }
        width = bytes.readUInt32BE(dataOffset);
        height = bytes.readUInt32BE(dataOffset + 4);
        const bitDepth = bytes[dataOffset + 8];
        const colorType = bytes[dataOffset + 9];
        channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
        if (width <= 0 || height <= 0 || bitDepth !== 8 || channels === 0 ||
            bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0 || bytes[dataOffset + 12] !== 0) {
          throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG uses an unsupported image format");
        }
        const pixels = width * height;
        if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > this.maxPixels) {
          throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG dimensions exceed the reviewed pixel bound");
        }
        sawHeader = true;
      } else if (type === "IHDR") {
        throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG contains more than one IHDR chunk");
      } else if (type === "IDAT") {
        imageData.push(bytes.subarray(dataOffset, dataEnd));
      } else if (type === "IEND") {
        if (length !== 0 || imageData.length === 0 || chunkEnd !== bytes.length) {
          throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG has an invalid IEND or trailing data");
        }
        sawEnd = true;
      }
      offset = chunkEnd;
      if (sawEnd) break;
    }
    if (!sawHeader || !sawEnd || imageData.length === 0) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG is missing required chunks");
    }
    const scanlineBytes = 1 + width * channels;
    const expectedInflated = scanlineBytes * height;
    if (!Number.isSafeInteger(expectedInflated) || expectedInflated <= 0) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG scanline dimensions overflowed");
    }
    let inflated: Buffer;
    try {
      inflated = inflateSync(Buffer.concat(imageData), { maxOutputLength: expectedInflated });
    } catch {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG image data is not a valid bounded zlib stream");
    }
    if (inflated.length !== expectedInflated) {
      throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG image data length is inconsistent with its dimensions");
    }
    for (let row = 0; row < height; row += 1) {
      if (inflated[row * scanlineBytes] > 4) {
        throw new WorkbenchObserverAdapterError("ARTIFACT_INVALID", "Workbench PNG contains an invalid scanline filter");
      }
    }
    return { width, height };
  }

  private requireJob(jobId: string): AdapterJobRecord {
    const record = this.jobs.get(jobId);
    if (!record || record.released) throw new WorkbenchObserverAdapterError("JOB_NOT_FOUND", `Workbench observer job ${jobId} is not retained`);
    return record;
  }

  private async revalidate(record: AdapterJobRecord): Promise<void> {
    try {
      const current = await this.client.revalidateCaptureActivity(record.activityLease);
      if (current.generation !== record.snapshot.generation || current.target.comparisonKey !== record.snapshot.target.comparisonKey) {
        throw new WorkbenchObserverAdapterError("STALE_LIFECYCLE", "Workbench observer job belongs to an old lifecycle generation or canonical target");
      }
    } catch (error) {
      await this.cancelForLifecycle(record);
      throw this.mapError(error, "STALE_LIFECYCLE");
    }
  }

  private async cancelForLifecycle(record: AdapterJobRecord): Promise<void> {
    await record.ready;
    this.convergeAbort(record);
    if (record.lastStatus?.terminalErrorCode === "WORKBENCH_EXITED") return;
    if (record.released || record.gateReleased || !record.handlerLeaseId) return;
    try {
      await this.cancelBound(record, false);
    } catch {
      // The activity gate intentionally remains held. The requesting lifecycle
      // operation will refuse after its bounded restoration wait.
    }
  }

  private convergeAbort(record: AdapterJobRecord): void {
    if (!record.activityLease.signal.aborted) return;
    const reason = record.activityLease.signal.reason as { code?: unknown; message?: unknown } | undefined;
    if (reason?.code === "WORKBENCH_EXITED") {
      this.failForUnexpectedExit(record, typeof reason.message === "string" ? reason.message : undefined);
    }
  }

  private failForUnexpectedExit(record: AdapterJobRecord, detail?: string): void {
    if (record.released || record.lastStatus?.terminalErrorCode === "WORKBENCH_EXITED") return;
    const previous = record.lastStatus;
    if (!previous) {
      // Submission cannot have returned a public job yet. Its in-flight NET API
      // failure remains authoritative to that caller, but local gate bookkeeping
      // must still converge with the activity gate's exact-exit invalidation.
      this.releaseGate(record);
      return;
    }
    record.lastStatus = {
      ...previous,
      state: "failed",
      sequence: previous.sequence + 1,
      message: detail ?? "The exact owned Workbench process exited during observer capture",
      terminalErrorCode: "WORKBENCH_EXITED",
      cameraLeaseHeld: false,
      // Process exit destroys the camera/world; this is terminal invalidation,
      // not a claim that an exact restoration round trip was observed.
      restorationConfirmed: false,
    };
    this.releaseGate(record);
  }

  private async cancelBound(record: AdapterJobRecord, rethrow = true): Promise<WorkbenchObserverJobStatus> {
    try {
      const response = await this.handlerJobCall("EMCP_WB_ObserverCancel", this.boundRequest(record));
      if (response.status !== "ok") throw new WorkbenchObserverAdapterError("HANDLER_REJECTED", response.message);
      this.assertResponseBinding(response, record);
      const status = this.publicStatus(record, response);
      record.lastStatus = status;
      if (!status.cameraLeaseHeld && status.restorationConfirmed) this.releaseGate(record);
      if (!status.restorationConfirmed && status.terminalErrorCode === "RESTORATION_UNCONFIRMED") {
        throw new WorkbenchObserverAdapterError("RESTORATION_UNCONFIRMED", status.message);
      }
      return status;
    } catch (error) {
      if (rethrow) throw this.mapError(error);
      throw error;
    }
  }

  private releaseGate(record: AdapterJobRecord): void {
    if (record.gateReleased) return;
    record.gateReleased = true;
    record.activityLease.signal.removeEventListener("abort", record.abortListener);
    this.client.releaseCaptureActivity(record.activityLease);
  }

  private mapError(error: unknown, fallback: WorkbenchObserverAdapterErrorCode = "HANDLER_UNAVAILABLE"): Error {
    if (error instanceof WorkbenchObserverAdapterError) return error;
    if (error instanceof z.ZodError) return new WorkbenchObserverAdapterError("INVALID_REQUEST", error.message);
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate?.code === "CAPTURE_INVALIDATED" || candidate?.code === "LIFECYCLE_BUSY") {
      return new WorkbenchObserverAdapterError("STALE_LIFECYCLE", typeof candidate.message === "string" ? candidate.message : "Workbench lifecycle changed");
    }
    return new WorkbenchObserverAdapterError(fallback, error instanceof Error ? error.message : String(error));
  }
}
