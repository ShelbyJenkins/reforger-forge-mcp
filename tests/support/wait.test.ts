import { describe, expect, it } from "vitest";
import { deadlineAfter } from "../../src/foundation/time.js";
import { ManualTime } from "./manual-time.js";
import { waitForValue } from "./wait.js";

describe("waitForValue", () => {
  it("preserves successful values and foundation expiry", async () => {
    const successTime = new ManualTime({ nowMs: 0 });
    await expect(waitForValue({
      clock: successTime,
      sleeper: successTime,
      deadline: deadlineAfter(successTime, 10),
      intervalMs: 5,
      probe: () => "ready",
    })).resolves.toEqual({ kind: "value", value: "ready" });

    const expiryTime = new ManualTime({ nowMs: 0 });
    const expired = waitForValue({
      clock: expiryTime,
      sleeper: expiryTime,
      deadline: deadlineAfter(expiryTime, 5),
      intervalMs: 5,
      probe: () => undefined,
    });
    await Promise.resolve();
    await expiryTime.runNextSleep();
    await expect(expired).resolves.toEqual({ kind: "expired" });
  });

  it("forwards probe failures and cancellation", async () => {
    const errorTime = new ManualTime({ nowMs: 0 });
    const failure = new Error("probe failure");
    await expect(waitForValue({
      clock: errorTime,
      sleeper: errorTime,
      deadline: deadlineAfter(errorTime, 10),
      intervalMs: 5,
      probe: () => { throw failure; },
    })).rejects.toBe(failure);

    const cancelTime = new ManualTime({ nowMs: 0 });
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(waitForValue({
      clock: cancelTime,
      sleeper: cancelTime,
      deadline: deadlineAfter(cancelTime, 10),
      intervalMs: 5,
      signal: controller.signal,
      probe: () => "unreachable",
    })).rejects.toBe(reason);

    const duringTime = new ManualTime({ nowMs: 0 });
    const duringController = new AbortController();
    const during = waitForValue({
      clock: duringTime,
      sleeper: duringTime,
      deadline: deadlineAfter(duringTime, 20),
      intervalMs: 10,
      signal: duringController.signal,
      probe: () => undefined,
    });
    await Promise.resolve();
    expect(duringTime.pendingSleepCount).toBe(1);
    const duringReason = new Error("cancelled during wait");
    duringController.abort(duringReason);
    await expect(during).rejects.toBe(duringReason);
    expect(duringTime.pendingSleepCount).toBe(0);
  });
});
