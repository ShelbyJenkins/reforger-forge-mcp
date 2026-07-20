import { randomUUID } from "node:crypto";
import {
  AbortableLeaseController,
  type AbortableLease,
  type AbortableLeaseTiming,
  type CancellationReason,
} from "../foundation/reservation-gate.js";

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

export interface CaptureCancellationReason extends CancellationReason<
  "LIFECYCLE_REQUESTED" | "WORKBENCH_EXITED" | "IDENTITY_CHANGED"
> {
}

/**
 * An adapter-owned lease. The adapter must restore camera state before release.
 * Lifecycle cancellation is delivered through `signal`; it does not itself
 * claim that restoration completed.
 */
export interface CaptureActivityLease extends AbortableLease<
  CaptureActivityBinding,
  CaptureCancellationReason
> {}

export interface WorkbenchActivityGateTiming extends AbortableLeaseTiming {}

export interface WorkbenchActivityGateOptions {
  /** Maximum default time lifecycle work waits for local admission. */
  restoreTimeoutMs?: number;
  timing?: WorkbenchActivityGateTiming;
  createLeaseId?: () => string;
}

export interface WorkbenchLifecycleAdmissionOptions {
  /** Override the default bound for queueing, reader drain, and capture restoration. */
  timeoutMs?: number;
  /** Cancel admission without interrupting lifecycle work after it has been admitted. */
  signal?: AbortSignal;
}

interface LifecycleWaiter {
  readonly kind: string;
  readonly options: WorkbenchLifecycleAdmissionOptions;
  readonly admitted: Promise<void>;
  resolveAdmitted(): void;
  rejectAdmitted(error: WorkbenchActivityError): void;
  timer: unknown;
  abortListener: (() => void) | null;
  status: "pending" | "admitted" | "cancelled";
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
  private readonly captureLeases = new AbortableLeaseController<
    CaptureActivityBinding,
    CaptureCancellationReason
  >();
  private managedActivities = 0;
  private lifecycleRequests = 0;
  private lifecycleActive = false;
  private advancingLifecycleQueue = false;
  private readonly lifecycleQueue: LifecycleWaiter[] = [];

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
    const activeCapture = this.captureLeases.activeLease;
    if (activeCapture) {
      throw new WorkbenchActivityError(
        `Workbench capture ${activeCapture.id} already owns the camera activity lease.`,
        "ACTIVE_CAPTURE"
      );
    }
    return this.captureLeases.issue(
      this.createLeaseId(),
      copyBinding(binding)
    );
  }

  releaseCapture(lease: CaptureActivityLease): void {
    this.captureLeases.release(lease);
    this.advanceLifecycleQueue();
  }

  /** Assert that the lease remains active and bound to the current identity. */
  revalidateCapture(
    lease: CaptureActivityLease,
    currentBinding: CaptureActivityBinding
  ): void {
    if (!this.captureLeases.isActive(lease)) {
      throw new WorkbenchActivityError(
        `Workbench capture lease ${lease.id} is no longer active.`,
        "CAPTURE_INVALIDATED"
      );
    }
    if (!sameBinding(lease.binding, currentBinding)) {
      this.captureLeases.cancel(lease, {
        code: "IDENTITY_CHANGED",
        message:
          `Workbench capture lease ${lease.id} no longer matches its lifecycle generation, ` +
            "canonical target, or exact process identity.",
      });
      throw new WorkbenchActivityError(
        `Workbench capture lease ${lease.id} is stale for the current Workbench identity.`,
        "CAPTURE_INVALIDATED"
      );
    }
  }

  invalidateCapture(lease: CaptureActivityLease, message: string): void {
    if (this.captureLeases.isReleased(lease)) return;
    this.captureLeases.cancel(lease, { code: "IDENTITY_CHANGED", message });
  }

  /**
   * Fail and release a lease only when the exiting child is the exact process
   * and lifecycle identity captured by that lease.
   */
  invalidateForUnexpectedExit(binding: CaptureActivityBinding): boolean {
    const lease = this.captureLeases.activeLease;
    if (!lease || !sameBinding(lease.binding, binding)) return false;
    this.captureLeases.cancel(lease, {
      code: "WORKBENCH_EXITED",
      message:
        `Exact owned Workbench PID ${binding.process.pid} exited while capture ` +
        `${lease.id} was active.`,
    }, { release: true });
    this.advanceLifecycleQueue();
    return true;
  }

  /**
   * Hold a process-local read/activity lease for ordinary managed NET work.
   * The machine-wide mutex is deliberately not involved: lifecycle intent is
   * recorded synchronously and either side is admitted, never raced.
   */
  async runManaged<T>(description: string, action: () => Promise<T>): Promise<T> {
    if (this.lifecycleRequests > 0) {
      throw new WorkbenchActivityError(
        `Workbench ${description} cannot start while a lifecycle mutation is pending or active.`,
        "LIFECYCLE_BUSY"
      );
    }
    this.managedActivities += 1;
    try {
      return await action();
    } finally {
      this.managedActivities -= 1;
      if (this.managedActivities === 0) this.advanceLifecycleQueue();
    }
  }

  async runLifecycle<T>(
    kind: string,
    action: () => Promise<T>,
    options: WorkbenchLifecycleAdmissionOptions = {}
  ): Promise<T> {
    const waiter = this.enqueueLifecycle(kind, options);
    await waiter.admitted;
    try {
      return await action();
    } finally {
      this.lifecycleActive = false;
      this.lifecycleRequests -= 1;
      this.advanceLifecycleQueue();
    }
  }

  private enqueueLifecycle(
    kind: string,
    options: WorkbenchLifecycleAdmissionOptions
  ): LifecycleWaiter {
    const timeoutMs = options.timeoutMs ?? this.restoreTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("Workbench lifecycle admission timeout must be a finite non-negative number.");
    }

    let resolveAdmitted!: () => void;
    let rejectAdmitted!: (error: WorkbenchActivityError) => void;
    const admitted = new Promise<void>((resolve, reject) => {
      resolveAdmitted = resolve;
      rejectAdmitted = reject;
    });
    const waiter: LifecycleWaiter = {
      kind,
      options,
      admitted,
      resolveAdmitted,
      rejectAdmitted,
      timer: undefined,
      abortListener: null,
      status: "pending",
    };

    this.lifecycleRequests += 1;
    this.lifecycleQueue.push(waiter);
    waiter.timer = this.timing.setTimeout(
      () => this.cancelLifecycleWaiter(waiter, this.admissionTimeoutError(waiter, timeoutMs)),
      timeoutMs
    );
    if (options.signal) {
      waiter.abortListener = () => this.cancelLifecycleWaiter(
        waiter,
        new WorkbenchActivityError(
          `Workbench lifecycle ${kind} admission was cancelled.`,
          "LIFECYCLE_BUSY"
        )
      );
      options.signal.addEventListener("abort", waiter.abortListener, { once: true });
    }

    if (options.signal?.aborted) {
      waiter.abortListener?.();
    } else {
      this.advanceLifecycleQueue();
    }
    return waiter;
  }

  private advanceLifecycleQueue(): void {
    if (this.advancingLifecycleQueue || this.lifecycleActive) return;
    this.advancingLifecycleQueue = true;
    try {
      for (;;) {
        const waiter = this.lifecycleQueue[0];
        if (!waiter || this.lifecycleActive) return;
        if (waiter.status !== "pending") {
          this.lifecycleQueue.shift();
          continue;
        }
        if (waiter.options.signal?.aborted) {
          this.cancelLifecycleWaiter(
            waiter,
            new WorkbenchActivityError(
              `Workbench lifecycle ${waiter.kind} admission was cancelled.`,
              "LIFECYCLE_BUSY"
            ),
            false
          );
          continue;
        }
        if (this.managedActivities > 0) return;

        const capture = this.captureLeases.activeLease;
        if (capture) {
          if (!capture.signal.aborted) {
            this.captureLeases.cancel(capture, {
              code: "LIFECYCLE_REQUESTED",
              message:
                `Workbench lifecycle ${waiter.kind} requested cancellation and exact camera ` +
                `restoration for capture ${capture.id}.`,
            }, { invalidate: false });
          }
          // Abort handlers may synchronously restore and release the capture.
          if (this.captureLeases.activeLease) return;
        }

        this.lifecycleQueue.shift();
        waiter.status = "admitted";
        this.clearLifecycleWaiterResources(waiter);
        this.lifecycleActive = true;
        waiter.resolveAdmitted();
        return;
      }
    } finally {
      this.advancingLifecycleQueue = false;
    }
  }

  private cancelLifecycleWaiter(
    waiter: LifecycleWaiter,
    error: WorkbenchActivityError,
    advance = true
  ): void {
    if (waiter.status !== "pending") return;
    waiter.status = "cancelled";
    const index = this.lifecycleQueue.indexOf(waiter);
    if (index >= 0) this.lifecycleQueue.splice(index, 1);
    this.clearLifecycleWaiterResources(waiter);
    this.lifecycleRequests -= 1;
    waiter.rejectAdmitted(error);
    if (advance) this.advanceLifecycleQueue();
  }

  private clearLifecycleWaiterResources(waiter: LifecycleWaiter): void {
    if (waiter.timer !== undefined) {
      this.timing.clearTimeout(waiter.timer);
      waiter.timer = undefined;
    }
    if (waiter.abortListener && waiter.options.signal) {
      waiter.options.signal.removeEventListener("abort", waiter.abortListener);
      waiter.abortListener = null;
    }
  }

  private admissionTimeoutError(
    waiter: LifecycleWaiter,
    timeoutMs: number
  ): WorkbenchActivityError {
    const capture = this.captureLeases.activeLease;
    if (capture) {
      return new WorkbenchActivityError(
        `ACTIVE_CAPTURE: lifecycle ${waiter.kind} refused because capture ${capture.id} ` +
          `did not restore and release within ${timeoutMs}ms.`,
        "ACTIVE_CAPTURE"
      );
    }
    return new WorkbenchActivityError(
      `Workbench lifecycle ${waiter.kind} could not acquire its local write lease within ` +
        `${timeoutMs}ms.`,
      "LIFECYCLE_BUSY"
    );
  }

}
