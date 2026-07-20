/**
 * Small injectable wall-clock primitives for ordinary bounded waits.
 *
 * This module intentionally does not own domain timeout policy. Callers decide
 * whether an expired deadline is an error, a neutral result, or a retryable
 * condition.
 */
export interface Clock {
  now(): number;
}

export interface SleepOptions {
  readonly signal?: AbortSignal;
}

export interface Sleeper {
  sleep(durationMs: number, options?: SleepOptions): Promise<void>;
}

export interface Deadline {
  readonly atMs: number;
}

export type PollResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "expired" };

/** Node clamps larger delays, so accepting one would silently shorten a budget. */
export const MAX_TIMER_DURATION_MS = 0x7fffffff;

export const systemClock: Clock = Object.freeze({ now: Date.now });

function assertSafeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer millisecond timestamp.`);
  }
}

/** Validate a duration before it can reach a timer implementation. */
export function assertTimerDurationMs(
  durationMs: number,
  name = "Duration"
): number {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MAX_TIMER_DURATION_MS) {
    throw new RangeError(
      `${name} must be a safe integer from 0 through ${MAX_TIMER_DURATION_MS} milliseconds.`
    );
  }
  return durationMs;
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** Production sleeper with explicit timer and listener cleanup. */
export const systemSleeper: Sleeper = Object.freeze({
  sleep(durationMs: number, options: SleepOptions = {}): Promise<void> {
    assertTimerDurationMs(durationMs, "Sleep duration");
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: "resolved" | "rejected", reason?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (outcome === "resolved") resolvePromise();
        else rejectPromise(reason);
      };
      const onAbort = (): void => finish("rejected", abortReason(signal!));
      timer = setTimeout(() => finish("resolved"), durationMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Abort can happen between the initial check and listener registration.
      if (signal?.aborted) onAbort();
    });
  },
});

export function deadlineAt(atMs: number): Deadline {
  assertSafeTimestamp(atMs, "Deadline");
  return Object.freeze({ atMs });
}

export function deadlineAfter(clock: Clock, durationMs: number): Deadline {
  assertTimerDurationMs(durationMs, "Deadline duration");
  const now = clock.now();
  assertSafeTimestamp(now, "Clock value");
  const atMs = now + durationMs;
  assertSafeTimestamp(atMs, "Deadline");
  return deadlineAt(atMs);
}

export function deriveDeadline(
  clock: Clock,
  parent: Deadline,
  durationMs?: number
): Deadline {
  assertSafeTimestamp(parent.atMs, "Parent deadline");
  if (durationMs === undefined) return parent;
  assertTimerDurationMs(durationMs, "Child deadline duration");
  const now = clock.now();
  assertSafeTimestamp(now, "Clock value");
  const childAtMs = now + durationMs;
  assertSafeTimestamp(childAtMs, "Child deadline");
  return deadlineAt(Math.min(parent.atMs, childAtMs));
}

export function remainingMs(clock: Clock, deadline: Deadline): number {
  assertSafeTimestamp(deadline.atMs, "Deadline");
  const now = clock.now();
  assertSafeTimestamp(now, "Clock value");
  return Math.max(0, deadline.atMs - now);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Probe immediately, then sleep only while the absolute deadline still has
 * budget. `undefined` is the sole not-ready sentinel; all other values are
 * caller-defined successful values.
 */
export async function pollUntil<T>(options: {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly deadline: Deadline;
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly probe: () => Promise<T | undefined>;
}): Promise<PollResult<T>> {
  assertTimerDurationMs(options.intervalMs, "Poll interval");
  assertSafeTimestamp(options.deadline.atMs, "Deadline");
  let hasProbed = false;
  for (;;) {
    throwIfAborted(options.signal);
    // The first probe is intentionally immediate. Every later probe must be
    // preceded by a fresh absolute-budget check so a completed final sleep
    // cannot authorize one extra attempt at or after expiry.
    if (hasProbed && remainingMs(options.clock, options.deadline) === 0) {
      return { kind: "expired" };
    }
    const value = await options.probe();
    hasProbed = true;
    throwIfAborted(options.signal);
    if (value !== undefined) return { kind: "value", value };

    const remaining = remainingMs(options.clock, options.deadline);
    if (remaining === 0) return { kind: "expired" };
    await options.sleeper.sleep(Math.min(options.intervalMs, remaining), {
      signal: options.signal,
    });
  }
}
