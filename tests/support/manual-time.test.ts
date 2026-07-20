import { describe, expect, it, vi } from "vitest";
import { deadlineAfter, pollUntil } from "../../src/foundation/time.js";
import { ManualTime } from "./manual-time.js";

describe("ManualTime", () => {
  it("starts at a fixed instant and advances incrementally", async () => {
    const time = new ManualTime({ nowMs: 1_000 });
    expect(time.now()).toBe(1_000);
    await time.advanceBy(25);
    expect(time.now()).toBe(1_025);
  });

  it("releases sleepers at or after their deadline in stable order", async () => {
    const time = new ManualTime({ nowMs: 100 });
    const events: string[] = [];
    const first = time.sleep(10).then(() => events.push("first"));
    const second = time.sleep(10).then(() => events.push("second"));
    const early = time.sleep(5).then(() => events.push("early"));
    expect(time.pendingSleepCount).toBe(3);
    await time.advanceBy(5);
    expect(events).toEqual(["early"]);
    expect(time.pendingSleepCount).toBe(2);
    await time.advanceBy(5);
    await Promise.all([first, second, early]);
    expect(events).toEqual(["early", "first", "second"]);
  });

  it("runs exactly the next scheduled sleeper", async () => {
    const time = new ManualTime({ nowMs: 100 });
    let resolved = 0;
    void time.sleep(50).then(() => { resolved += 1; });
    void time.sleep(20).then(() => { resolved += 1; });
    await expect(time.runNextSleep()).resolves.toBe(true);
    expect(time.now()).toBe(120);
    expect(resolved).toBe(1);
    await time.runNextSleep();
    expect(time.now()).toBe(150);
    expect(resolved).toBe(2);
    await expect(time.runNextSleep()).resolves.toBe(false);
  });

  it("rejects invalid or backward movement", async () => {
    const time = new ManualTime({ nowMs: 100 });
    await expect(time.advanceBy(-1)).rejects.toThrow(RangeError);
    await expect(time.advanceBy(Number.NaN)).rejects.toThrow(RangeError);
    await expect(time.advanceTo(99)).rejects.toThrow(RangeError);
    await expect(time.advanceTo(Infinity)).rejects.toThrow(TypeError);
  });

  it("supports abort before and during a sleep and removes the pending entry", async () => {
    const before = new AbortController();
    const beforeReason = new Error("before");
    before.abort(beforeReason);
    const time = new ManualTime({ nowMs: 100 });
    await expect(time.sleep(10, { signal: before.signal })).rejects.toBe(beforeReason);
    expect(time.pendingSleepCount).toBe(0);

    const during = new AbortController();
    const duringReason = new Error("during");
    const pending = time.sleep(10, { signal: during.signal });
    expect(time.pendingSleepCount).toBe(1);
    during.abort(duringReason);
    await expect(pending).rejects.toBe(duringReason);
    expect(time.pendingSleepCount).toBe(0);
    await time.advanceBy(10);
    expect(time.pendingSleepCount).toBe(0);
  });

  it("does not allocate a wall-clock timer", async () => {
    const time = new ManualTime({ nowMs: 100 });
    const timer = vi.spyOn(globalThis, "setTimeout");
    const pending = time.sleep(50);
    expect(timer).not.toHaveBeenCalled();
    await time.advanceBy(50);
    await pending;
    timer.mockRestore();
  });

  it("drives the foundation poller without wall-clock timers", async () => {
    const time = new ManualTime({ nowMs: 0 });
    const probes: number[] = [];
    const pending = pollUntil({
      clock: time,
      sleeper: time,
      deadline: deadlineAfter(time, 25),
      intervalMs: 10,
      probe: async () => { probes.push(time.now()); return undefined; },
    });
    await Promise.resolve();
    expect(probes).toEqual([0]);
    await time.runNextSleep();
    expect(probes).toEqual([0, 10]);
    await time.runNextSleep();
    expect(probes).toEqual([0, 10, 20]);
    await time.runNextSleep();
    await expect(pending).resolves.toEqual({ kind: "expired" });
    expect(probes).toEqual([0, 10, 20]);
  });
});
