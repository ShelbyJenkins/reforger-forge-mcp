import { describe, expect, it } from "vitest";
import {
  MAX_TIMER_DURATION_MS,
  deadlineAfter,
  deriveDeadline,
  pollUntil,
  remainingMs,
  systemSleeper,
  type Clock,
  type Sleeper,
} from "../../src/foundation/time.js";

class FakeClock implements Clock {
  constructor(private value = 0) {}

  now(): number { return this.value; }
  advance(durationMs: number): void { this.value += durationMs; }
}

class FakeSleeper implements Sleeper {
  readonly delays: number[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly clock: FakeClock) {}

  async sleep(durationMs: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.delays.push(durationMs);
    this.signals.push(options.signal);
    if (options.signal?.aborted) throw options.signal.reason;
    this.clock.advance(durationMs);
  }
}

describe("foundation time", () => {
  it("returns immediate success without allocating a delay", async () => {
    const clock = new FakeClock(100);
    const sleeper = new FakeSleeper(clock);
    const result = await pollUntil({
      clock,
      sleeper,
      deadline: deadlineAfter(clock, 50),
      intervalMs: 10,
      probe: async () => false,
    });

    expect(result).toEqual({ kind: "value", value: false });
    expect(sleeper.delays).toEqual([]);
  });

  it("retries after bounded fake-clock delays and returns the caller-owned value", async () => {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    let probes = 0;
    const result = await pollUntil({
      clock,
      sleeper,
      deadline: deadlineAfter(clock, 30),
      intervalMs: 10,
      probe: async () => (++probes === 3 ? [] : undefined),
    });

    expect(result).toEqual({ kind: "value", value: [] });
    expect(probes).toBe(3);
    expect(sleeper.delays).toEqual([10, 10]);
  });

  it("expires without a final post-expiry probe and caps the final delay", async () => {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    let probes = 0;
    const result = await pollUntil({
      clock,
      sleeper,
      deadline: deadlineAfter(clock, 25),
      intervalMs: 10,
      probe: async () => { probes += 1; return undefined; },
    });

    expect(result).toEqual({ kind: "expired" });
    expect(probes).toBe(3);
    expect(sleeper.delays).toEqual([10, 10, 5]);
  });

  it("does not allocate a timer or make another probe when a probe consumes the last budget", async () => {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    let probes = 0;
    const result = await pollUntil({
      clock,
      sleeper,
      deadline: deadlineAfter(clock, 10),
      intervalMs: 5,
      probe: async () => {
        probes += 1;
        if (probes === 2) clock.advance(5);
        return undefined;
      },
    });

    expect(result).toEqual({ kind: "expired" });
    expect(probes).toBe(2);
    expect(sleeper.delays).toEqual([5]);
  });

  it("rejects invalid public durations before a sleeper is called", async () => {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    for (const duration of [-1, 1.5, Number.NaN, Infinity, MAX_TIMER_DURATION_MS + 1]) {
      expect(() => deadlineAfter(clock, duration)).toThrow(RangeError);
      await expect(pollUntil({
        clock,
        sleeper,
        deadline: deadlineAfter(clock, 1),
        intervalMs: duration,
        probe: async () => undefined,
      })).rejects.toBeInstanceOf(RangeError);
    }
    expect(sleeper.delays).toEqual([]);
  });

  it("derives only equal-or-shorter deadlines and never returns negative remaining budget", () => {
    const clock = new FakeClock(100);
    const parent = deadlineAfter(clock, 50);
    clock.advance(10);
    expect(deriveDeadline(clock, parent)).toBe(parent);
    expect(deriveDeadline(clock, parent, 100).atMs).toBe(150);
    expect(deriveDeadline(clock, parent, 20).atMs).toBe(130);
    clock.advance(100);
    expect(remainingMs(clock, parent)).toBe(0);
  });

  it("propagates a probe failure without scheduling a retry", async () => {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    const failure = new Error("probe failure");
    await expect(pollUntil({
      clock,
      sleeper,
      deadline: deadlineAfter(clock, 10),
      intervalMs: 1,
      probe: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(sleeper.delays).toEqual([]);
  });

  it("propagates an already-aborted signal without probing or allocating a timer", async () => {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(pollUntil({
      clock,
      sleeper,
      deadline: deadlineAfter(clock, 10),
      intervalMs: 1,
      signal: controller.signal,
      probe: async () => "unexpected",
    })).rejects.toBe(reason);
    expect(sleeper.delays).toEqual([]);
  });

  it("removes system-sleeper abort listeners and clears the timer when aborted during a delay", async () => {
    const controller = new AbortController();
    let listeners = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "abort") listeners += 1;
      return originalAdd(type, listener, options);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "abort") listeners -= 1;
      return originalRemove(type, listener, options);
    }) as typeof controller.signal.removeEventListener;

    const waiting = systemSleeper.sleep(10_000, { signal: controller.signal });
    expect(listeners).toBe(1);
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(listeners).toBe(0);
  });
});
