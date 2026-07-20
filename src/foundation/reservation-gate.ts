/** A structured reason delivered through AbortSignal.reason. */
export interface CancellationReason<Code extends string = string> {
  readonly code: Code;
  readonly message: string;
}

/**
 * Process-local lease whose cancellation requests cleanup but does not imply
 * that cleanup or restoration has completed.
 */
export interface AbortableLease<Binding, Reason extends CancellationReason> {
  readonly id: string;
  readonly binding: Binding;
  readonly signal: AbortSignal;
}

export interface AbortableLeaseTiming {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface AbortableLeaseRecord<Binding, Reason extends CancellationReason> {
  readonly lease: AbortableLease<Binding, Reason>;
  readonly controller: AbortController;
  readonly released: Promise<void>;
  resolveReleased(): void;
  isReleased: boolean;
  isInvalidated: boolean;
}

const defaultLeaseTiming: AbortableLeaseTiming = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns the lifecycle of one process-local abortable lease at a time.
 *
 * Cancellation and release are deliberately separate: callers cancel to ask
 * an adapter to restore state, then wait for the adapter to release its lease.
 */
export class AbortableLeaseController<Binding, Reason extends CancellationReason> {
  private readonly records = new WeakMap<
    AbortableLease<Binding, Reason>,
    AbortableLeaseRecord<Binding, Reason>
  >();
  private active: AbortableLeaseRecord<Binding, Reason> | null = null;

  get activeLease(): AbortableLease<Binding, Reason> | null {
    return this.active?.lease ?? null;
  }

  issue(id: string, binding: Binding): AbortableLease<Binding, Reason> {
    if (this.active) throw new Error(`Lease ${this.active.lease.id} is already active.`);
    if (!id) throw new TypeError("Lease id must not be empty.");
    const controller = new AbortController();
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
    const lease = Object.freeze({ id, binding, signal: controller.signal });
    const record: AbortableLeaseRecord<Binding, Reason> = {
      lease,
      controller,
      released,
      resolveReleased,
      isReleased: false,
      isInvalidated: false,
    };
    this.records.set(lease, record);
    this.active = record;
    return lease;
  }

  release(lease: AbortableLease<Binding, Reason>): void {
    const record = this.recordFor(lease);
    if (record.isReleased) return;
    record.isReleased = true;
    if (this.active === record) this.active = null;
    record.resolveReleased();
  }

  cancel(
    lease: AbortableLease<Binding, Reason>,
    reason: Reason,
    options: { invalidate?: boolean; release?: boolean } = {}
  ): void {
    const record = this.recordFor(lease);
    if (record.isReleased) return;
    if (!record.controller.signal.aborted) record.controller.abort(reason);
    if (options.invalidate !== false) record.isInvalidated = true;
    if (options.release === true) this.release(lease);
  }

  isActive(lease: AbortableLease<Binding, Reason>): boolean {
    const record = this.recordFor(lease);
    return !record.isReleased && !record.isInvalidated && this.active === record;
  }

  isReleased(lease: AbortableLease<Binding, Reason>): boolean {
    return this.recordFor(lease).isReleased;
  }

  async waitForRelease(
    lease: AbortableLease<Binding, Reason>,
    timeoutMs: number,
    timing: AbortableLeaseTiming = defaultLeaseTiming
  ): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError("Lease release timeout must be a finite non-negative number.");
    }
    const record = this.recordFor(lease);
    if (record.isReleased) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: unknown;
      const finish = (released: boolean): void => {
        if (settled) return;
        settled = true;
        if (released) timing.clearTimeout(timer);
        resolve(released);
      };
      timer = timing.setTimeout(() => finish(false), timeoutMs);
      void record.released.then(() => finish(true));
    });
  }

  private recordFor(
    lease: AbortableLease<Binding, Reason>
  ): AbortableLeaseRecord<Binding, Reason> {
    const record = this.records.get(lease);
    if (!record) throw new Error("Lease was not issued by this controller.");
    return record;
  }
}

export class ReservationCancelledError<Reason extends CancellationReason> extends Error {
  constructor(public readonly reason: Reason) {
    super(reason.message);
    this.name = "ReservationCancelledError";
  }
}

export type DurableReservationAttempt<Value, Pending = unknown> =
  | { readonly kind: "acquired"; readonly value: Value }
  | { readonly kind: "retry"; readonly pending?: Pending; readonly delayMs?: number };

export interface DurableReservationGateTiming {
  now(): number;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

const defaultReservationTiming: DurableReservationGateTiming = {
  now: Date.now,
  wait: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

export interface DurableReservationOptions<Value, Pending, Reason extends CancellationReason> {
  /** Absolute wall-clock deadline. */
  readonly deadlineMs: number;
  readonly retryIntervalMs: number;
  readonly signal?: AbortSignal;
  readonly cancellationReason: Reason | ((signal: AbortSignal) => Reason);
  readonly attempt: (context: {
    readonly attempt: number;
    readonly remainingMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<DurableReservationAttempt<Value, Pending>>;
  readonly onDeadline: (pending: Pending | undefined) => Error;
}

/**
 * Deadline-bounded retry driver for a deterministic, idempotent durable
 * reservation. The caller owns proof validation and channel-error policy;
 * this class owns cancellation, wall-deadline accounting, and bounded waits.
 */
export class DurableReservationGate {
  constructor(private readonly timing: DurableReservationGateTiming = defaultReservationTiming) {}

  async acquire<Value, Pending = unknown, Reason extends CancellationReason = CancellationReason>(
    options: DurableReservationOptions<Value, Pending, Reason>
  ): Promise<Value> {
    if (!Number.isFinite(options.deadlineMs)) {
      throw new TypeError("Reservation deadline must be finite.");
    }
    if (!Number.isFinite(options.retryIntervalMs) || options.retryIntervalMs <= 0) {
      throw new TypeError("Reservation retry interval must be a finite positive number.");
    }
    let attempt = 0;
    let pending: Pending | undefined;
    for (;;) {
      this.throwIfCancelled(options.signal, options.cancellationReason);
      const remainingMs = options.deadlineMs - this.timing.now();
      // A zero-wait reservation still receives one idempotent attempt. This
      // preserves the useful distinction between "do not poll" and "do not
      // ask": callers can acquire an already-ready durable reservation even
      // when scheduling advanced the clock just past the nominal deadline.
      if (remainingMs < 0 && attempt > 0) throw options.onDeadline(pending);
      const result = await options.attempt({
        attempt,
        remainingMs: Math.max(0, remainingMs),
        signal: options.signal,
      });
      attempt += 1;
      this.throwIfCancelled(options.signal, options.cancellationReason);
      if (result.kind === "acquired") return result.value;
      pending = result.pending;
      const afterAttemptRemaining = options.deadlineMs - this.timing.now();
      if (afterAttemptRemaining <= 0) throw options.onDeadline(pending);
      const requestedDelay = result.delayMs ?? options.retryIntervalMs;
      if (!Number.isFinite(requestedDelay) || requestedDelay <= 0) {
        throw new TypeError("Reservation retry delay must be a finite positive number.");
      }
      try {
        await this.timing.wait(Math.min(requestedDelay, afterAttemptRemaining), options.signal);
      } catch (error) {
        this.throwIfCancelled(options.signal, options.cancellationReason);
        throw new Error("Reservation wait failed before its deadline.", { cause: error });
      }
    }
  }

  private throwIfCancelled<Reason extends CancellationReason>(
    signal: AbortSignal | undefined,
    reason: Reason | ((signal: AbortSignal) => Reason)
  ): void {
    if (!signal?.aborted) return;
    throw new ReservationCancelledError(
      typeof reason === "function" ? reason(signal) : reason
    );
  }
}
