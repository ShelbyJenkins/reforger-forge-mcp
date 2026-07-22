import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import {
  WORKBENCH_ADAPTER_ERROR_CODES,
  WORKBENCH_ADAPTER_PROTOCOL,
  WORKBENCH_ADAPTER_STATE_VALUES,
  WORKBENCH_ADAPTER_TERMINAL_STATES,
} from "../observer/protocol/enforce-contract.js";
import type {
  WorkbenchCallOptions,
  WorkbenchCaptureActivityLease,
  WorkbenchObserverSnapshot,
} from "../src/workbench/client.js";
import { inspectWorkbenchObserverArtifactEnvelope } from "../src/workbench/observer-artifact-envelope.js";
import {
  WorkbenchObserverAdapter,
  WorkbenchObserverAdapterError,
  type WorkbenchObserverAdapterOptions,
  type WorkbenchObserverClient,
  type WorkbenchObserverInstance,
  type WorkbenchObserverJobStatus,
  type WorkbenchObserverRecoverInput,
  type WorkbenchObserverReleaseResult,
  type WorkbenchObserverSubmitInput,
} from "../src/workbench/observer-adapter.js";

const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const TERMINAL_STATES = new Set<string>(WORKBENCH_ADAPTER_TERMINAL_STATES);
const workbenchBoolean = z.union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => value === true || value === 1);
const finite = z.number().finite();

const releaseResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  message: z.string(),
  adapterProtocol: z.literal(WORKBENCH_ADAPTER_PROTOCOL),
  jobId: z.string(),
  restorationConfirmed: workbenchBoolean,
  artifactRemoved: workbenchBoolean,
}).passthrough();

const jobResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  message: z.string(),
  adapterProtocol: z.literal(WORKBENCH_ADAPTER_PROTOCOL),
  jobId: z.string(),
  leaseId: z.string(),
  lifecycleGeneration: z.string(),
  canonicalTarget: z.string(),
  projectFile: z.string().min(1),
  worldIdentity: z.string().default(""),
  viewKind: z.enum(["current", "pose", "lookAt"]).optional(),
  state: z.string(),
  sequence: z.number().int().min(0),
  terminalErrorCode: z.string().default(""),
  cameraMatrix0: z.string().default(""),
  cameraMatrix1: z.string().default(""),
  cameraMatrix2: z.string().default(""),
  cameraMatrix3: z.string().default(""),
  ownerCameraId: z.number().int().default(0),
  actualFov: finite.default(0),
  nearPlane: finite.default(0),
  farPlane: finite.default(0),
  cameraLeaseHeld: workbenchBoolean,
  restorationConfirmed: workbenchBoolean,
}).passthrough();

export interface WorkbenchObserverArtifactPreValidationContext {
  readonly jobId: string;
  readonly artifactPath: string;
  readonly artifactBytes: number;
  readonly cameraLeaseHeld: false;
  readonly restorationConfirmed: true;
}

export type WorkbenchObserverArtifactPreValidationHook = (
  context: WorkbenchObserverArtifactPreValidationContext
) => void;

export interface WorkbenchObserverBeforeSubmitDeliveryContext {
  readonly jobId: string;
  readonly instanceId: string;
  readonly lifecycleGeneration: string;
  readonly canonicalTarget: string;
  readonly process: Readonly<WorkbenchObserverSnapshot["process"]>;
}

export interface WorkbenchObserverBeforeSubmitDeliveryResult {
  readonly exactOwnerVacant: boolean;
}

export type WorkbenchObserverBeforeSubmitDeliveryHook = (
  context: WorkbenchObserverBeforeSubmitDeliveryContext
) => Promise<WorkbenchObserverBeforeSubmitDeliveryResult>;

export interface WorkbenchObserverBeforeReleaseContext extends
  WorkbenchObserverBeforeSubmitDeliveryContext {
  readonly restorationConfirmed: true;
  readonly cameraLeaseHeld: false;
}

export type WorkbenchObserverBeforeReleaseHook = (
  context: WorkbenchObserverBeforeReleaseContext
) => Promise<WorkbenchObserverBeforeSubmitDeliveryResult>;

export interface WorkbenchObserverReleaseReplayEvidence {
  readonly attempted: true;
  readonly identicalRequest: true;
  readonly equivalentAcknowledgement: true;
}

export interface WorkbenchObserverAcceptanceReleaseResult extends WorkbenchObserverReleaseResult {
  readonly idempotentReplay?: WorkbenchObserverReleaseReplayEvidence;
}

export interface WorkbenchObserverAcceptanceAdapterOptions extends WorkbenchObserverAdapterOptions {
  readonly beforeArtifactValidation?: WorkbenchObserverArtifactPreValidationHook;
  readonly verifyIdempotentReleaseReplay?: boolean;
}

export interface ExactOwnerExitWorkbenchObserverClient extends WorkbenchObserverClient {
  requireExactOwnerExit(lease: WorkbenchCaptureActivityLease): void;
}

interface AcceptanceLeaseRecord {
  readonly publicLease: WorkbenchCaptureActivityLease;
  readonly delegateLease: WorkbenchCaptureActivityLease;
  readonly snapshot: WorkbenchObserverSnapshot;
  readonly controller: AbortController;
  readonly forwardAbort: () => void;
  jobId: string | null;
  handlerLeaseId: string | null;
  publicGateReleased: boolean;
  exactOwnerExitRequired: boolean;
  exactOwnerExitConfirmed: boolean;
  beforeSubmitDeliveryFailure: Error | null;
  artifactPreValidationInvoked: boolean;
  artifactHookFailed: boolean;
  lastStatus: WorkbenchObserverJobStatus | null;
}

interface ReleaseReceipt {
  readonly request: Readonly<Record<string, unknown>>;
  readonly options: WorkbenchCallOptions | undefined;
  readonly response: unknown;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function instanceId(snapshot: WorkbenchObserverSnapshot): string {
  const target = createHash("sha256").update(snapshot.target.comparisonKey).digest("hex").slice(0, 16);
  return `workbench-${snapshot.generation}-${target}`;
}

function vectorFromString(value: string): [number, number, number] {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new WorkbenchObserverAdapterError(
      WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_UNAVAILABLE,
      "Workbench observer returned an invalid camera matrix"
    );
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

function harnessError(
  code: ConstructorParameters<typeof WorkbenchObserverAdapterError>[0],
  message: string
): WorkbenchObserverAdapterError {
  return new WorkbenchObserverAdapterError(code, message);
}

class AcceptanceWorkbenchObserverClient implements WorkbenchObserverClient {
  private readonly leases = new WeakMap<WorkbenchCaptureActivityLease, AcceptanceLeaseRecord>();
  private readonly activeLeases = new Set<AcceptanceLeaseRecord>();
  private readonly jobs = new Map<string, AcceptanceLeaseRecord>();
  private readonly releaseReceipts = new Map<string, ReleaseReceipt>();
  private readonly handlerTimeoutMs: () => number;
  private readonly maxArtifactBytes: number;
  private readonly beforeArtifactValidation: WorkbenchObserverArtifactPreValidationHook | undefined;
  private readonly verifyIdempotentReleaseReplay: boolean;
  private beforeSubmitDelivery: WorkbenchObserverBeforeSubmitDeliveryHook | null = null;
  private beforeSubmitDeliveryArmed = false;
  private beforeRelease: {
    readonly jobId: string;
    readonly hook: WorkbenchObserverBeforeReleaseHook;
  } | null = null;
  private beforeReleaseArmed = false;

  constructor(
    private readonly delegate: ExactOwnerExitWorkbenchObserverClient,
    options: WorkbenchObserverAcceptanceAdapterOptions
  ) {
    const handlerTimeout = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.handlerTimeoutMs = typeof handlerTimeout === "function"
      ? handlerTimeout
      : () => handlerTimeout;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.beforeArtifactValidation = options.beforeArtifactValidation;
    this.verifyIdempotentReleaseReplay = options.verifyIdempotentReleaseReplay === true;
  }

  async getRunningObserverSnapshot(): Promise<WorkbenchObserverSnapshot> {
    return this.delegate.getRunningObserverSnapshot();
  }

  acquireCaptureActivity(snapshot: WorkbenchObserverSnapshot): WorkbenchCaptureActivityLease {
    const delegateLease = this.delegate.acquireCaptureActivity(snapshot);
    const controller = new AbortController();
    const forwardAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(delegateLease.signal.reason);
    };
    if (delegateLease.signal.aborted) forwardAbort();
    else delegateLease.signal.addEventListener("abort", forwardAbort, { once: true });
    const publicLease = Object.freeze({
      id: delegateLease.id,
      binding: delegateLease.binding,
      signal: controller.signal,
    });
    const record: AcceptanceLeaseRecord = {
      publicLease,
      delegateLease,
      snapshot,
      controller,
      forwardAbort,
      jobId: null,
      handlerLeaseId: null,
      publicGateReleased: false,
      exactOwnerExitRequired: false,
      exactOwnerExitConfirmed: false,
      beforeSubmitDeliveryFailure: null,
      artifactPreValidationInvoked: false,
      artifactHookFailed: false,
      lastStatus: null,
    };
    this.leases.set(publicLease, record);
    this.activeLeases.add(record);
    return publicLease;
  }

  async revalidateCaptureActivity(lease: WorkbenchCaptureActivityLease): Promise<WorkbenchObserverSnapshot> {
    return this.delegate.revalidateCaptureActivity(this.requireLease(lease).delegateLease);
  }

  releaseCaptureActivity(lease: WorkbenchCaptureActivityLease): void {
    const record = this.requireLease(lease);
    if (record.publicGateReleased) return;
    record.publicGateReleased = true;
    record.delegateLease.signal.removeEventListener("abort", record.forwardAbort);
    this.delegate.releaseCaptureActivity(record.delegateLease);
  }

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options?: WorkbenchCallOptions
  ): Promise<T> {
    const record = apiFunc === "EMCP_WB_ObserverPing" ? null : this.associate(params);
    if (record?.exactOwnerExitRequired && !record.exactOwnerExitConfirmed) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.RESTORATION_UNCONFIRMED,
        "Workbench handler I/O is sealed until exact owner vacancy is proven"
      );
    }
    if (apiFunc === "EMCP_WB_ObserverSubmit" && record) {
      await this.runBeforeSubmitDelivery(record);
    }
    if (apiFunc === "EMCP_WB_ObserverRelease" && record) {
      const synthetic = await this.runBeforeRelease(record);
      if (synthetic) return synthetic as T;
    }

    const actualParams = apiFunc === "EMCP_WB_ObserverRelease" && this.verifyIdempotentReleaseReplay
      ? Object.freeze({ ...params })
      : params;
    const response = await this.delegate.call<unknown>(apiFunc, actualParams, options);
    if (apiFunc === "EMCP_WB_ObserverRelease" && record && this.verifyIdempotentReleaseReplay) {
      this.releaseReceipts.set(record.jobId!, { request: actualParams, options, response });
    }
    if (record) this.runArtifactPreValidation(record, response);
    return response as T;
  }

  armOneShotBeforeSubmitDelivery(hook: WorkbenchObserverBeforeSubmitDeliveryHook): void {
    if (typeof hook !== "function") {
      throw new TypeError("Workbench before-submit delivery hook must be a function");
    }
    if (this.beforeSubmitDeliveryArmed) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.INVALID_REQUEST,
        "Workbench before-submit delivery hook may be armed only once"
      );
    }
    this.beforeSubmitDeliveryArmed = true;
    this.beforeSubmitDelivery = hook;
  }

  armOneShotBeforeRelease(jobId: string, hook: WorkbenchObserverBeforeReleaseHook): void {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(jobId) || typeof hook !== "function") {
      throw new TypeError("Workbench before-release hook requires a bounded job ID and function");
    }
    if (this.beforeReleaseArmed) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.INVALID_REQUEST,
        "Workbench before-release hook may be armed only once"
      );
    }
    this.beforeReleaseArmed = true;
    this.beforeRelease = { jobId, hook };
  }

  requireExactOwnerExit(jobId: string): void {
    const record = this.requireJob(jobId);
    if (record.exactOwnerExitRequired) return;
    if (record.publicGateReleased) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.INVALID_REQUEST,
        `Workbench observer job ${jobId} no longer owns an active capture activity lease`
      );
    }
    try {
      this.delegate.requireExactOwnerExit(record.delegateLease);
    } catch (error) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.RESTORATION_UNCONFIRMED,
        error instanceof Error ? error.message : String(error)
      );
    }
    record.exactOwnerExitRequired = true;
  }

  confirmExactOwnerExit(jobId: string, exactOwnerVacant: boolean): WorkbenchObserverJobStatus {
    const record = this.requireJob(jobId);
    if (!record.exactOwnerExitRequired) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.INVALID_REQUEST,
        `Workbench observer job ${jobId} does not require exact owner exit`
      );
    }
    if (!exactOwnerVacant) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.RESTORATION_UNCONFIRMED,
        `Workbench observer job ${jobId} cannot converge before exact owner vacancy is proven`
      );
    }
    if (!record.lastStatus) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.INVALID_REQUEST,
        `Workbench observer job ${jobId} has no public status to converge`
      );
    }
    this.confirmExactOwnerExitRecord(record);
    if (!TERMINAL_STATES.has(record.lastStatus.state)) {
      const { artifact: _artifact, ...previous } = record.lastStatus;
      record.lastStatus = {
        ...previous,
        state: WORKBENCH_ADAPTER_STATE_VALUES.FAILED,
        sequence: previous.sequence + 1,
        message: "The exact owned Workbench process exited during observer capture",
        terminalErrorCode: WORKBENCH_ADAPTER_ERROR_CODES.WORKBENCH_EXITED,
        cameraLeaseHeld: false,
        restorationConfirmed: false,
      };
    }
    return record.lastStatus;
  }

  rememberStatus(status: WorkbenchObserverJobStatus): void {
    const record = this.jobs.get(status.jobId);
    if (record) record.lastStatus = status;
  }

  takeArtifactHookFailure(jobId: string): boolean {
    const record = this.jobs.get(jobId);
    if (!record?.artifactHookFailed) return false;
    record.artifactHookFailed = false;
    return true;
  }

  completedStatus(jobId: string): WorkbenchObserverJobStatus | null {
    return this.jobs.get(jobId)?.lastStatus ?? null;
  }

  async cancelRestoredTerminal(jobId: string): Promise<WorkbenchObserverJobStatus> {
    const record = this.requireJob(jobId);
    const previous = record.lastStatus;
    if (!previous || previous.state !== WORKBENCH_ADAPTER_STATE_VALUES.COMPLETED ||
        previous.cameraLeaseHeld || !previous.restorationConfirmed) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.INVALID_REQUEST,
        `Workbench observer job ${jobId} is not a restored completed terminal`
      );
    }
    const raw = await this.delegate.call<unknown>(
      "EMCP_WB_ObserverCancel",
      this.boundRequest(record),
      this.callOptions()
    );
    const parsed = jobResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_UNAVAILABLE,
        "Workbench observer terminal Cancel returned an invalid response"
      );
    }
    if (parsed.data.status !== "ok") {
      throw harnessError(WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_REJECTED, parsed.data.message);
    }
    this.assertResponseBinding(record, parsed.data);
    if (parsed.data.state !== WORKBENCH_ADAPTER_STATE_VALUES.CANCELLED ||
        parsed.data.cameraLeaseHeld || !parsed.data.restorationConfirmed) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.RESTORATION_UNCONFIRMED,
        "Workbench observer terminal Cancel did not prove a cancelled, restored camera state"
      );
    }
    const { artifact: _artifact, terminalErrorCode: _terminalErrorCode, ...baseline } = previous;
    const status: WorkbenchObserverJobStatus = {
      ...baseline,
      worldIdentity: parsed.data.worldIdentity || previous.worldIdentity,
      viewKind: parsed.data.viewKind ?? previous.viewKind,
      state: parsed.data.state,
      sequence: parsed.data.sequence,
      message: parsed.data.message,
      ...(parsed.data.terminalErrorCode ? { terminalErrorCode: parsed.data.terminalErrorCode } : {}),
      cameraLeaseHeld: parsed.data.cameraLeaseHeld,
      restorationConfirmed: parsed.data.restorationConfirmed,
      ownerCameraId: parsed.data.ownerCameraId,
      actualFov: parsed.data.actualFov,
      actualCamera: {
        matrix: [
          vectorFromString(parsed.data.cameraMatrix0),
          vectorFromString(parsed.data.cameraMatrix1),
          vectorFromString(parsed.data.cameraMatrix2),
          vectorFromString(parsed.data.cameraMatrix3),
        ],
        position: vectorFromString(parsed.data.cameraMatrix3),
        verticalFov: parsed.data.actualFov,
        nearPlane: parsed.data.nearPlane,
        farPlane: parsed.data.farPlane,
      },
    };
    record.lastStatus = status;
    return status;
  }

  async replayRelease(jobId: string): Promise<WorkbenchObserverReleaseReplayEvidence> {
    const receipt = this.releaseReceipts.get(jobId);
    if (!receipt) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_UNAVAILABLE,
        "Workbench observer release replay has no retained real request"
      );
    }
    try {
      const first = releaseResponseSchema.safeParse(receipt.response);
      const replayRaw = await this.delegate.call<unknown>(
        "EMCP_WB_ObserverRelease",
        receipt.request,
        receipt.options
      );
      const replay = releaseResponseSchema.safeParse(replayRaw);
      if (!first.success || !replay.success) {
        throw harnessError(
          WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_UNAVAILABLE,
          "Workbench observer idempotent release replay returned an invalid response"
        );
      }
      if (replay.data.status !== "ok") {
        throw harnessError(
          WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_REJECTED,
          "Workbench observer idempotent release replay was refused"
        );
      }
      if (first.data.jobId !== jobId || replay.data.jobId !== jobId ||
          replay.data.restorationConfirmed !== first.data.restorationConfirmed ||
          replay.data.artifactRemoved !== first.data.artifactRemoved) {
        throw harnessError(
          WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_REJECTED,
          "Workbench observer idempotent release replay did not return an equivalent acknowledgement"
        );
      }
      return Object.freeze({
        attempted: true,
        identicalRequest: true,
        equivalentAcknowledgement: true,
      });
    } catch (error) {
      if (error instanceof WorkbenchObserverAdapterError) throw error;
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_UNAVAILABLE,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  forgetJob(jobId: string): void {
    const record = this.jobs.get(jobId);
    if (record) this.activeLeases.delete(record);
    this.jobs.delete(jobId);
    this.releaseReceipts.delete(jobId);
  }

  forgetAll(): void {
    this.activeLeases.clear();
    this.jobs.clear();
    this.releaseReceipts.clear();
  }

  private requireLease(lease: WorkbenchCaptureActivityLease): AcceptanceLeaseRecord {
    const record = this.leases.get(lease);
    if (!record) throw new Error("Workbench acceptance lease was not issued by this client");
    return record;
  }

  private requireJob(jobId: string): AcceptanceLeaseRecord {
    const record = this.jobs.get(jobId);
    if (!record) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.JOB_NOT_FOUND,
        `Workbench observer job ${jobId} is not retained by the acceptance harness`
      );
    }
    return record;
  }

  private associate(params: Record<string, unknown>): AcceptanceLeaseRecord | null {
    const jobId = typeof params.jobId === "string" ? params.jobId : null;
    const generation = typeof params.lifecycleGeneration === "string" ? params.lifecycleGeneration : null;
    const canonicalTarget = typeof params.canonicalTarget === "string" ? params.canonicalTarget : null;
    if (!jobId || !generation || !canonicalTarget) return null;
    const existing = this.jobs.get(jobId);
    if (existing) {
      this.assertRequestBinding(existing, params);
      return existing;
    }
    const candidates = [...this.activeLeases].filter((record) =>
      record.jobId === null && !record.publicGateReleased &&
      record.snapshot.generation === generation &&
      samePath(record.snapshot.target.path, canonicalTarget)
    );
    if (candidates.length !== 1) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.STALE_LIFECYCLE,
        "Workbench acceptance call could not be bound to one exact capture activity lease"
      );
    }
    const record = candidates[0]!;
    record.jobId = jobId;
    record.handlerLeaseId = typeof params.leaseId === "string" ? params.leaseId : null;
    this.jobs.set(jobId, record);
    this.assertRequestBinding(record, params);
    return record;
  }

  private assertRequestBinding(record: AcceptanceLeaseRecord, params: Record<string, unknown>): void {
    if (params.jobId !== record.jobId ||
        params.lifecycleGeneration !== record.snapshot.generation ||
        typeof params.canonicalTarget !== "string" ||
        !samePath(params.canonicalTarget, record.snapshot.target.path) ||
        (record.handlerLeaseId !== null && params.leaseId !== record.handlerLeaseId)) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.STALE_LIFECYCLE,
        "Workbench acceptance call is bound to a different job, lifecycle, or target"
      );
    }
  }

  private assertResponseBinding(
    record: AcceptanceLeaseRecord,
    response: z.infer<typeof jobResponseSchema>
  ): void {
    if (response.jobId !== record.jobId || response.leaseId !== record.handlerLeaseId ||
        response.lifecycleGeneration !== record.snapshot.generation ||
        !samePath(response.canonicalTarget, record.snapshot.target.path)) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.STALE_LIFECYCLE,
        "Workbench acceptance response is bound to a different job, lifecycle, or target"
      );
    }
  }

  private async runBeforeSubmitDelivery(record: AcceptanceLeaseRecord): Promise<void> {
    if (record.beforeSubmitDeliveryFailure) throw record.beforeSubmitDeliveryFailure;
    const hook = this.beforeSubmitDelivery;
    if (!hook) return;
    this.beforeSubmitDelivery = null;
    try {
      const proof = await hook(this.context(record));
      if (!proof.exactOwnerVacant) {
        if (record.exactOwnerExitRequired) {
          throw harnessError(
            WORKBENCH_ADAPTER_ERROR_CODES.RESTORATION_UNCONFIRMED,
            "Owner shutdown before Workbench Submit did not prove exact process vacancy"
          );
        }
        return;
      }
      if (!record.exactOwnerExitRequired) {
        throw harnessError(
          WORKBENCH_ADAPTER_ERROR_CODES.INVALID_REQUEST,
          "Exact Workbench vacancy was reported before the matching job established an owner-exit seal"
        );
      }
      this.confirmExactOwnerExitRecord(record);
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.WORKBENCH_EXITED,
        "The exact owned Workbench process exited before observer Submit delivery"
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      record.beforeSubmitDeliveryFailure = failure;
      throw failure;
    }
  }

  private async runBeforeRelease(record: AcceptanceLeaseRecord): Promise<Record<string, unknown> | null> {
    const armed = this.beforeRelease?.jobId === record.jobId ? this.beforeRelease : null;
    if (!armed) return null;
    this.beforeRelease = null;
    if (!record.publicGateReleased) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.RESTORATION_UNCONFIRMED,
        "Workbench before-release owner shutdown requires a released camera activity gate"
      );
    }
    const proof = await armed.hook(Object.freeze({
      ...this.context(record),
      restorationConfirmed: true,
      cameraLeaseHeld: false,
    }));
    if (!proof.exactOwnerVacant) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.RESTORATION_UNCONFIRMED,
        "Owner shutdown before Workbench Release did not prove exact process vacancy"
      );
    }
    return {
      status: "ok",
      message: "The exact owned Workbench process exited after restoration and before handler Release",
      adapterProtocol: WORKBENCH_ADAPTER_PROTOCOL,
      jobId: record.jobId,
      restorationConfirmed: true,
      artifactRemoved: false,
    };
  }

  private runArtifactPreValidation(record: AcceptanceLeaseRecord, response: unknown): void {
    if (!this.beforeArtifactValidation || record.artifactPreValidationInvoked ||
        !response || typeof response !== "object") return;
    const candidate = response as Record<string, unknown>;
    const restored = candidate.restorationConfirmed === true || candidate.restorationConfirmed === 1;
    const cameraHeld = candidate.cameraLeaseHeld === true || candidate.cameraLeaseHeld === 1;
    if (candidate.status !== "ok" || candidate.state !== WORKBENCH_ADAPTER_STATE_VALUES.COMPLETED ||
        !restored || cameraHeld || candidate.jobId !== record.jobId ||
        typeof candidate.artifactLogicalPath !== "string" ||
        typeof candidate.artifactPath !== "string" ||
        typeof candidate.artifactBytes !== "number") return;
    const inspection = inspectWorkbenchObserverArtifactEnvelope({
      jobId: record.jobId!,
      profilePath: record.snapshot.companion.profilePath,
      artifactLogicalPath: candidate.artifactLogicalPath,
      artifactPath: candidate.artifactPath,
      artifactBytes: candidate.artifactBytes,
      maxArtifactBytes: this.maxArtifactBytes,
    });
    if (!inspection.ok) return;
    record.artifactPreValidationInvoked = true;
    try {
      this.beforeArtifactValidation(Object.freeze({
        jobId: record.jobId!,
        artifactPath: inspection.canonicalPath,
        artifactBytes: candidate.artifactBytes,
        cameraLeaseHeld: false,
        restorationConfirmed: true,
      }));
    } catch {
      record.artifactHookFailed = true;
    }
  }

  private confirmExactOwnerExitRecord(record: AcceptanceLeaseRecord): void {
    if (record.exactOwnerExitConfirmed) return;
    record.exactOwnerExitConfirmed = true;
    if (!record.controller.signal.aborted) {
      record.controller.abort(Object.freeze({
        code: WORKBENCH_ADAPTER_ERROR_CODES.WORKBENCH_EXITED,
        message: `Exact owned Workbench PID ${record.snapshot.process.pid} exited`,
      }));
    }
  }

  private context(record: AcceptanceLeaseRecord): WorkbenchObserverBeforeSubmitDeliveryContext {
    return Object.freeze({
      jobId: record.jobId!,
      instanceId: instanceId(record.snapshot),
      lifecycleGeneration: record.snapshot.generation,
      canonicalTarget: record.snapshot.target.path,
      process: Object.freeze({ ...record.snapshot.process }),
    });
  }

  private boundRequest(record: AcceptanceLeaseRecord): Readonly<Record<string, unknown>> {
    if (!record.jobId || !record.handlerLeaseId) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.HANDLER_UNAVAILABLE,
        "Workbench acceptance job has no retained handler lease"
      );
    }
    return Object.freeze({
      jobId: record.jobId,
      leaseId: record.handlerLeaseId,
      lifecycleGeneration: record.snapshot.generation,
      canonicalTarget: record.snapshot.target.path,
    });
  }

  private callOptions(): WorkbenchCallOptions {
    return {
      skipAutoLaunch: true,
      timeout: positiveInteger(this.handlerTimeoutMs(), "Workbench observer handler timeout"),
    };
  }
}

/**
 * Repository-only Workbench fault-matrix adapter. Acceptance transitions live
 * here so the shipped observer adapter has no harness branches or mutable hook
 * state.
 */
export class WorkbenchObserverAcceptanceAdapter {
  private readonly client: AcceptanceWorkbenchObserverClient;
  private readonly adapter: WorkbenchObserverAdapter;
  private readonly verifyIdempotentReleaseReplay: boolean;

  constructor(
    client: ExactOwnerExitWorkbenchObserverClient,
    options: WorkbenchObserverAcceptanceAdapterOptions = {}
  ) {
    this.client = new AcceptanceWorkbenchObserverClient(client, options);
    this.adapter = new WorkbenchObserverAdapter(this.client, options);
    this.verifyIdempotentReleaseReplay = options.verifyIdempotentReleaseReplay === true;
  }

  instances(): Promise<WorkbenchObserverInstance[]> {
    return this.adapter.instances();
  }

  ping(): Promise<WorkbenchObserverInstance> {
    return this.adapter.ping();
  }

  async submit(input: WorkbenchObserverSubmitInput): Promise<WorkbenchObserverJobStatus> {
    const status = await this.adapter.submit(input);
    this.client.rememberStatus(status);
    await this.throwArtifactHookFailure(status.jobId);
    return status;
  }

  async recover(input: WorkbenchObserverRecoverInput): Promise<WorkbenchObserverJobStatus> {
    const status = await this.adapter.recover(input);
    this.client.rememberStatus(status);
    await this.throwArtifactHookFailure(status.jobId);
    return status;
  }

  async status(jobId: string): Promise<WorkbenchObserverJobStatus> {
    const retained = this.client.completedStatus(jobId);
    if (retained && TERMINAL_STATES.has(retained.state) &&
        retained.state !== WORKBENCH_ADAPTER_STATE_VALUES.COMPLETED) {
      return retained;
    }
    const status = await this.adapter.status(jobId);
    this.client.rememberStatus(status);
    await this.throwArtifactHookFailure(jobId);
    return status;
  }

  async cancel(jobId: string): Promise<WorkbenchObserverJobStatus> {
    const retained = this.client.completedStatus(jobId);
    if (retained && TERMINAL_STATES.has(retained.state) &&
        retained.state !== WORKBENCH_ADAPTER_STATE_VALUES.COMPLETED) {
      return retained;
    }
    const status = await this.adapter.cancel(jobId);
    this.client.rememberStatus(status);
    const cancelled = status.state === WORKBENCH_ADAPTER_STATE_VALUES.COMPLETED &&
      !status.cameraLeaseHeld && status.restorationConfirmed
      ? await this.client.cancelRestoredTerminal(jobId)
      : status;
    this.client.rememberStatus(cancelled);
    return cancelled;
  }

  async release(jobId: string): Promise<WorkbenchObserverAcceptanceReleaseResult> {
    const result = await this.adapter.release(jobId);
    try {
      if (!this.verifyIdempotentReleaseReplay) return result;
      const idempotentReplay = await this.client.replayRelease(jobId);
      return { ...result, idempotentReplay };
    } finally {
      this.client.forgetJob(jobId);
    }
  }

  readCompletedArtifact(jobId: string): { image: Buffer; metadata: Record<string, unknown> } {
    if (this.client.completedStatus(jobId)?.state !== WORKBENCH_ADAPTER_STATE_VALUES.COMPLETED) {
      throw harnessError(
        WORKBENCH_ADAPTER_ERROR_CODES.JOB_NOT_FOUND,
        `Workbench observer job ${jobId} has no completed retained image`
      );
    }
    return this.adapter.readCompletedArtifact(jobId);
  }

  async restoreAll(): Promise<void> {
    await this.adapter.restoreAll();
    this.client.forgetAll();
  }

  armOneShotBeforeSubmitDelivery(hook: WorkbenchObserverBeforeSubmitDeliveryHook): void {
    this.client.armOneShotBeforeSubmitDelivery(hook);
  }

  armOneShotBeforeRelease(jobId: string, hook: WorkbenchObserverBeforeReleaseHook): void {
    this.client.armOneShotBeforeRelease(jobId, hook);
  }

  requireExactOwnerExit(jobId: string): void {
    this.client.requireExactOwnerExit(jobId);
  }

  confirmExactOwnerExit(jobId: string, exactOwnerVacant: boolean): WorkbenchObserverJobStatus {
    return this.client.confirmExactOwnerExit(jobId, exactOwnerVacant);
  }

  private async throwArtifactHookFailure(jobId: string): Promise<void> {
    if (!this.client.takeArtifactHookFailure(jobId)) return;
    try {
      await this.cancel(jobId);
    } catch {
      // Camera restoration was already proved by the terminal response. Keep
      // the acceptance error bounded even if fixture cleanup is unavailable.
    }
    throw harnessError(
      WORKBENCH_ADAPTER_ERROR_CODES.ARTIFACT_INVALID,
      "Workbench artifact pre-validation hook failed"
    );
  }
}

export type WorkbenchObserverAcceptanceBackend = Pick<
  WorkbenchObserverAcceptanceAdapter,
  "instances" | "submit" | "recover" | "status" | "cancel" | "release" |
  "readCompletedArtifact" | "restoreAll"
>;
