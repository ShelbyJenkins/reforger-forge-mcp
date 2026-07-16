import { randomUUID } from "node:crypto";

export type WorkbenchActivityErrorCode =
  | "ACTIVE_CAPTURE"
  | "LIFECYCLE_BUSY"
  | "CAPTURE_INVALIDATED";

export class WorkbenchActivityError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchActivityErrorCode
  ) {
    super(message);
    this.name = "WorkbenchActivityError";
  }
}

/** The durable identity a capture is allowed to observe. */
export interface CaptureActivityBinding {
  readonly generation: string;
  readonly targetKey: string;
  readonly process: {
    readonly pid: number;
    readonly executablePath: string;
    readonly creationTime: string;
  };
}

export interface CaptureCancellationReason {
  readonly code: "LIFECYCLE_REQUESTED" | "WORKBENCH_EXITED" | "IDENTITY_CHANGED";
  readonly message: string;
}

/**
 * An adapter-owned lease. The adapter must restore camera state before release.
 * Lifecycle cancellation is delivered through `signal`; it does not itself
 * claim that restoration completed.
 */
export interface CaptureActivityLease {
  readonly id: string;
  readonly binding: CaptureActivityBinding;
  readonly signal: AbortSignal;
}

export interface WorkbenchActivityGateTiming {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkbenchActivityGateOptions {
  /** Maximum time lifecycle work waits for capture restoration and release. */
  restoreTimeoutMs?: number;
  timing?: WorkbenchActivityGateTiming;
  createLeaseId?: () => string;
}

interface CaptureRecord {
  readonly lease: CaptureActivityLease;
  readonly abortController: AbortController;
  readonly releasedPromise: Promise<void>;
  resolveReleased(): void;
  released: boolean;
  invalidated: boolean;
}

const DEFAULT_RESTORE_TIMEOUT_MS = 5_000;

const defaultTiming: WorkbenchActivityGateTiming = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameBinding(left: CaptureActivityBinding, right: CaptureActivityBinding): boolean {
  return left.generation === right.generation &&
    left.targetKey === right.targetKey &&
    left.process.pid === right.process.pid &&
    left.process.creationTime === right.process.creationTime &&
    samePath(left.process.executablePath, right.process.executablePath);
}

function copyBinding(binding: CaptureActivityBinding): CaptureActivityBinding {
  return Object.freeze({
    generation: binding.generation,
    targetKey: binding.targetKey,
    process: Object.freeze({ ...binding.process }),
  });
}

/**
 * In-process arbitration between long-running camera capture and short,
 * machine-wide Workbench lifecycle mutations.
 *
 * Lifecycle intent is recorded synchronously, before waiting for restoration.
 * Callers then enter the machine-wide lifecycle coordinator only after this
 * gate grants admission, so the global mutex is never held by the wait.
 */
export class WorkbenchActivityGate {
  private readonly restoreTimeoutMs: number;
  private readonly timing: WorkbenchActivityGateTiming;
  private readonly createLeaseId: () => string;
  private readonly records = new WeakMap<CaptureActivityLease, CaptureRecord>();
  private activeCapture: CaptureRecord | null = null;
  private lifecycleRequests = 0;

  constructor(options: WorkbenchActivityGateOptions = {}) {
    const restoreTimeoutMs = options.restoreTimeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS;
    if (!Number.isFinite(restoreTimeoutMs) || restoreTimeoutMs < 0) {
      throw new TypeError("Workbench capture restoration timeout must be a finite non-negative number.");
    }
    this.restoreTimeoutMs = restoreTimeoutMs;
    this.timing = options.timing ?? defaultTiming;
    this.createLeaseId = options.createLeaseId ?? randomUUID;
  }

  acquireCapture(binding: CaptureActivityBinding): CaptureActivityLease {
    if (this.lifecycleRequests > 0) {
      throw new WorkbenchActivityError(
        "Workbench capture cannot start while a lifecycle mutation is pending or active.",
        "LIFECYCLE_BUSY"
      );
    }
    if (this.activeCapture) {
      throw new WorkbenchActivityError(
        `Workbench capture ${this.activeCapture.lease.id} already owns the camera activity lease.`,
        "ACTIVE_CAPTURE"
      );
    }

    const abortController = new AbortController();
    let resolveReleased!: () => void;
    const releasedPromise = new Promise<void>((resolve) => { resolveReleased = resolve; });
    const lease = Object.freeze({
      id: this.createLeaseId(),
      binding: copyBinding(binding),
      signal: abortController.signal,
    });
    const record: CaptureRecord = {
      lease,
      abortController,
      releasedPromise,
      resolveReleased,
      released: false,
      invalidated: false,
    };
    this.records.set(lease, record);
    this.activeCapture = record;
    return lease;
  }

  releaseCapture(lease: CaptureActivityLease): void {
    const record = this.recordFor(lease);
    if (record.released) return;
    record.released = true;
    if (this.activeCapture === record) this.activeCapture = null;
    record.resolveReleased();
  }

  /** Assert that the lease remains active and bound to the current identity. */
  revalidateCapture(
    lease: CaptureActivityLease,
    currentBinding: CaptureActivityBinding
  ): void {
    const record = this.recordFor(lease);
    if (record.released || record.invalidated || this.activeCapture !== record) {
      throw new WorkbenchActivityError(
        `Workbench capture lease ${lease.id} is no longer active.`,
        "CAPTURE_INVALIDATED"
      );
    }
    if (!sameBinding(record.lease.binding, currentBinding)) {
      this.invalidateRecord(record, {
        code: "IDENTITY_CHANGED",
        message:
          `Workbench capture lease ${lease.id} no longer matches its lifecycle generation, ` +
          "canonical target, or exact process identity.",
      }, false);
      throw new WorkbenchActivityError(
        `Workbench capture lease ${lease.id} is stale for the current Workbench identity.`,
        "CAPTURE_INVALIDATED"
      );
    }
  }

  invalidateCapture(lease: CaptureActivityLease, message: string): void {
    const record = this.recordFor(lease);
    if (record.released) return;
    this.invalidateRecord(record, { code: "IDENTITY_CHANGED", message }, false);
  }

  /**
   * Fail and release a lease only when the exiting child is the exact process
   * and lifecycle identity captured by that lease.
   */
  invalidateForUnexpectedExit(binding: CaptureActivityBinding): boolean {
    const record = this.activeCapture;
    if (!record || !sameBinding(record.lease.binding, binding)) return false;
    this.invalidateRecord(record, {
      code: "WORKBENCH_EXITED",
      message:
        `Exact owned Workbench PID ${binding.process.pid} exited while capture ` +
        `${record.lease.id} was active.`,
    }, true);
    return true;
  }

  async runLifecycle<T>(kind: string, action: () => Promise<T>): Promise<T> {
    this.lifecycleRequests += 1;
    try {
      const capture = this.activeCapture;
      if (capture) {
        if (!capture.abortController.signal.aborted) {
          capture.abortController.abort({
            code: "LIFECYCLE_REQUESTED",
            message:
              `Workbench lifecycle ${kind} requested cancellation and exact camera restoration ` +
              `for capture ${capture.lease.id}.`,
          } satisfies CaptureCancellationReason);
        }
        const restored = await this.waitForRelease(capture);
        if (!restored) {
          throw new WorkbenchActivityError(
            `ACTIVE_CAPTURE: lifecycle ${kind} refused because capture ${capture.lease.id} ` +
              `did not restore and release within ${this.restoreTimeoutMs}ms.`,
            "ACTIVE_CAPTURE"
          );
        }
      }
      return await action();
    } finally {
      this.lifecycleRequests -= 1;
    }
  }

  private recordFor(lease: CaptureActivityLease): CaptureRecord {
    const record = this.records.get(lease);
    if (!record) {
      throw new WorkbenchActivityError(
        "Capture activity lease was not issued by this Workbench activity gate.",
        "CAPTURE_INVALIDATED"
      );
    }
    return record;
  }

  private invalidateRecord(
    record: CaptureRecord,
    reason: CaptureCancellationReason,
    releaseForExactProcessExit: boolean
  ): void {
    if (!record.abortController.signal.aborted) record.abortController.abort(reason);
    record.invalidated = true;
    // Identity/generation drift can still leave camera state installed in a
    // live editor. Keep lifecycle admission blocked until the adapter proves
    // restoration and explicitly releases. Exact process exit is different:
    // the camera/world no longer exists, so that exact lease can be released.
    if (releaseForExactProcessExit) this.releaseCapture(record.lease);
  }

  private waitForRelease(record: CaptureRecord): Promise<boolean> {
    if (record.released) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: unknown;
      const finish = (released: boolean): void => {
        if (settled) return;
        settled = true;
        if (released) this.timing.clearTimeout(timer);
        resolve(released);
      };
      timer = this.timing.setTimeout(() => finish(false), this.restoreTimeoutMs);
      void record.releasedPromise.then(() => finish(true));
    });
  }
}
