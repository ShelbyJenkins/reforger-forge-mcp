import {
  assertTimerDurationMs,
  type Clock,
  type SleepOptions,
  type Sleeper,
} from "../../src/foundation/time.js";

interface PendingSleep {
  readonly atMs: number;
  readonly sequence: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
}

const DEFAULT_NOW_MS = Date.parse("2026-07-16T20:00:00.000Z");

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be a safe integer millisecond timestamp.`);
  }
}

/** A deterministic Clock/Sleeper pair with no dependency on wall-clock timers. */
export class ManualTime implements Clock, Sleeper {
  private currentMs: number;
  private sequence = 0;
  private readonly sleepers: PendingSleep[] = [];

  constructor(options: { readonly nowMs?: number } = {}) {
    this.currentMs = options.nowMs ?? DEFAULT_NOW_MS;
    assertTimestamp(this.currentMs, "Manual time");
  }

  now(): number {
    return this.currentMs;
  }

  get pendingSleepCount(): number {
    return this.sleepers.length;
  }

  sleep(durationMs: number, options: SleepOptions = {}): Promise<void> {
    assertTimerDurationMs(durationMs, "Sleep duration");
    const atMs = this.currentMs + durationMs;
    assertTimestamp(atMs, "Sleep deadline");
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise<void>((resolve, reject) => {
      const pending: PendingSleep = {
        atMs,
        sequence: this.sequence++,
        resolve,
        reject,
        signal,
        settled: false,
      };
      const onAbort = (): void => {
        if (pending.settled) return;
        this.remove(pending);
        pending.settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(abortReason(signal!));
      };
      pending.onAbort = onAbort;
      this.insert(pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Abort can happen between the preflight check and listener setup.
      if (signal?.aborted) onAbort();
    });
  }

  async advanceBy(durationMs: number): Promise<void> {
    assertTimerDurationMs(durationMs, "Manual-time advance");
    await this.advanceTo(this.currentMs + durationMs);
  }

  /** Synchronous compatibility for tests that only assert state transitions. */
  advance(durationMs: number): void {
    assertTimerDurationMs(durationMs, "Manual-time advance");
    const targetMs = this.currentMs + durationMs;
    assertTimestamp(targetMs, "Manual-time target");
    this.moveTo(targetMs);
  }

  async advanceTo(targetMs: number): Promise<void> {
    assertTimestamp(targetMs, "Manual-time target");
    if (targetMs < this.currentMs) {
      throw new RangeError("Manual time cannot move backwards.");
    }
    this.moveTo(targetMs);
    await this.settleMicrotasks();
  }

  private moveTo(targetMs: number): void {
    this.currentMs = targetMs;
    const due = this.sleepers.filter((pending) => pending.atMs <= targetMs);
    for (const pending of due) this.resolve(pending);
  }

  async runNextSleep(): Promise<boolean> {
    const next = this.sleepers[0];
    if (!next) return false;
    await this.advanceTo(next.atMs);
    return true;
  }

  private insert(pending: PendingSleep): void {
    let index = this.sleepers.findIndex((candidate) =>
      candidate.atMs > pending.atMs ||
      (candidate.atMs === pending.atMs && candidate.sequence > pending.sequence));
    if (index === -1) index = this.sleepers.length;
    this.sleepers.splice(index, 0, pending);
  }

  private remove(pending: PendingSleep): void {
    const index = this.sleepers.indexOf(pending);
    if (index !== -1) this.sleepers.splice(index, 1);
  }

  private resolve(pending: PendingSleep): void {
    if (pending.settled) return;
    this.remove(pending);
    pending.settled = true;
    pending.signal?.removeEventListener("abort", pending.onAbort!);
    pending.resolve();
  }

  private async settleMicrotasks(): Promise<void> {
    // A sleeper normally resumes a poller, which awaits its probe once more
    // before scheduling the next operation. Two turns make advanceTo useful
    // to callers without pretending to control unrelated event-loop work.
    await Promise.resolve();
    await Promise.resolve();
  }
}
