import type { WorldRevision } from "./world-revision.js";
import type { ERROR_REGISTRY } from "../../observer/protocol/registry.js";
import type {
  CanonicalImageOutputPolicy,
  ImageOutputRequest,
} from "../foundation/image-output.js";

export type CaptureBackendKind = "runtime" | "workbench";
export type CaptureState = "queued" | "running" | "completed" | "failed" | "cancelled" | "released";

export type CaptureView =
  | { kind: "current" }
  | { kind: "pose"; position: [number, number, number]; orientation: [number, number, number, number]; fov: number }
  | { kind: "lookAt"; position: [number, number, number]; target: [number, number, number]; fov: number };

export interface ListInstancesInput {
  sessionId?: string;
  requiredCapabilities?: readonly string[];
  renderersOnly?: boolean;
}

export interface CaptureInstance {
  backend: CaptureBackendKind;
  instanceId: string;
  sessionId?: string;
  capabilities: readonly string[];
  worldRevision: WorldRevision;
  worldId: string | null;
  legacyWorldEpoch?: number;
  stale?: boolean;
  transportHealthy?: boolean;
  headless?: boolean;
  recoveryBinding: Readonly<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface BackendCallContext {
  deadlineAtMs: number;
  signal?: AbortSignal;
}

export interface BackendJobRef {
  backend: CaptureBackendKind;
  jobId: string;
  instanceId: string;
  worldRevision: WorldRevision;
  sessionId?: string;
  recoveryBinding: Readonly<Record<string, unknown>>;
}

export interface BackendSubmitInput {
  jobId: string;
  idempotencyKey: string;
  request: CanonicalCaptureRequest;
  instance: CaptureInstance;
}

export interface BackendJob {
  ref: BackendJobRef;
  state: CaptureState | string;
  message?: string;
  terminalErrorCode?: string;
  terminalMessage?: string;
  cameraLeaseHeld?: boolean;
  restorationConfirmed?: boolean;
  artifact?: CaptureArtifactMetadata;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CaptureArtifactMetadata {
  format?: "png" | string;
  width?: number | null;
  height?: number | null;
  contentSha256?: string | null;
  completedAt?: string | null;
  [key: string]: unknown;
}

export interface CaptureArtifact {
  image: Buffer;
  metadata: CaptureArtifactMetadata & Record<string, unknown>;
}

export interface BackendReleaseResult {
  restorationConfirmed: boolean;
  artifactRemoved: boolean;
  handlerAlreadyAbsent?: boolean;
  [key: string]: unknown;
}

export interface CaptureBackend {
  readonly kind: CaptureBackendKind;
  listInstances(input: ListInstancesInput, context: BackendCallContext): Promise<CaptureInstance[]>;
  submit(input: BackendSubmitInput, context: BackendCallContext): Promise<BackendJob>;
  status(ref: BackendJobRef, context: BackendCallContext): Promise<BackendJob>;
  cancel(ref: BackendJobRef, context: BackendCallContext): Promise<BackendJob>;
  read(ref: BackendJobRef, context: BackendCallContext): Promise<CaptureArtifact>;
  release(ref: BackendJobRef, context: BackendCallContext): Promise<BackendReleaseResult>;
}

export interface CanonicalCaptureIntent {
  selectionMode: "explicit" | "delegated";
  view: CaptureView;
  settleFrames: number;
  performancePolicy: "evidence" | "instrumented";
  image: CanonicalImageOutputPolicy;
  timeoutMs: number;
  runId?: string;
  captureLabel?: string;
  purpose?: string;
  asynchronous: boolean;
  /** Caller-controlled semantic identity before renderer resolution. */
  fingerprint: string;
}

export interface CanonicalCaptureRequest {
  sessionId?: string;
  instanceId: string;
  view: CaptureView;
  settleFrames: number;
  performancePolicy: "evidence" | "instrumented";
  image: CanonicalImageOutputPolicy;
  timeoutMs: number;
  expectedWorldRevision: WorldRevision;
  runId?: string;
  captureLabel?: string;
  purpose?: string;
  asynchronous: boolean;
  selectionMode: "explicit" | "delegated";
  intentFingerprint: string;
  /** Complete logical identity used for idempotency, excluding transport values. */
  fingerprint: string;
}

export interface CaptureInput {
  sessionId?: string;
  instanceId?: string;
  view?: CaptureView;
  settleFrames?: number;
  performancePolicy?: "evidence" | "instrumented" | "performance";
  image?: ImageOutputRequest;
  timeoutMs?: number;
  expectedWorldRevision?: WorldRevision;
  runId?: string;
  captureLabel?: string;
  purpose?: string;
  asynchronous?: boolean;
  idempotencyKey: string;
  selectionMode?: "explicit" | "delegated";
  signal?: AbortSignal;
}

export interface PublicCaptureJob {
  backend: CaptureBackendKind;
  jobId: string;
  instanceId: string;
  worldRevision: WorldRevision;
  worldId: string | null;
  worldEpoch: number;
  state: string;
  cameraLeaseHeld?: boolean;
  restorationConfirmed?: boolean;
  artifact?: CaptureArtifactMetadata;
  [key: string]: unknown;
}

export interface CaptureResultAsync {
  asynchronous: true;
  job: PublicCaptureJob;
}

export interface CaptureResultSync {
  asynchronous: false;
  job: PublicCaptureJob;
  image: Buffer;
  metadata: Record<string, unknown>;
  cleanup?: Record<string, unknown>;
  cleanupRequired?: boolean;
  cleanupWarning?: string;
}

export type CaptureResult = CaptureResultAsync | CaptureResultSync;

export interface RunCaptureReservation {
  runId: string;
  captureLabel?: string;
  purpose?: string;
  idempotencyKey: string;
  request: CanonicalCaptureRequest;
  jobId: string;
}

export interface ReservedRunCapture {
  runId: string;
  captureLabel: string;
  jobId?: string;
  backend?: CaptureBackendKind;
  instanceId?: string;
  worldRevision?: WorldRevision;
  state?: string;
  artifactAvailable?: boolean;
  [key: string]: unknown;
}

export interface BoundRunCapture {
  runId: string;
  captureLabel: string;
  ref: BackendJobRef;
  request?: CanonicalCaptureRequest;
  selectionDelegated?: boolean;
  retryCount?: number;
}

export interface CompletedRunCapture {
  runId: string;
  captureLabel: string;
  ref: BackendJobRef;
  artifact: CaptureArtifact;
  job: BackendJob;
}

export interface FailedRunCapture {
  runId: string;
  captureLabel: string;
  ref?: BackendJobRef;
  code: string;
  message: string;
}

export interface PublicCaptureJobRef {
  jobId: string;
  backend: CaptureBackendKind;
  sessionId?: string;
}

export interface CaptureRunPort {
  reserve(input: RunCaptureReservation): Promise<ReservedRunCapture>;
  bind(input: BoundRunCapture): Promise<void>;
  submitted?(input: BoundRunCapture): Promise<void>;
  reviseAdmission?(input: BoundRunCapture & { request: CanonicalCaptureRequest; retryCount: number }): Promise<void>;
  complete(input: CompletedRunCapture): Promise<void>;
  fail(input: FailedRunCapture): Promise<void>;
  assertReleaseAllowed(ref: PublicCaptureJobRef): Promise<void>;
  /** Read an artifact already promoted into the durable managed store. */
  readManagedArtifact?(ref: BackendJobRef, maxBytes: number): Promise<CaptureArtifact>;
  /** Release only the promoted managed artifact; backend restoration is separate. */
  releaseManagedArtifact?(ref: BackendJobRef): Promise<Record<string, unknown>>;
}

export type CaptureErrorCode = keyof typeof ERROR_REGISTRY;

export class CaptureError extends Error {
  constructor(
    public readonly code: CaptureErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export function isTerminalJob(job: Pick<BackendJob, "state">): boolean {
  return job.state === "completed" || job.state === "failed" || job.state === "cancelled" || job.state === "released";
}

export function hasRestorationObligation(job: Pick<BackendJob, "state" | "cameraLeaseHeld" | "restorationConfirmed">): boolean {
  return !isTerminalJob(job) || job.cameraLeaseHeld === true || job.restorationConfirmed === false;
}
