import { describe, expect, it, vi } from "vitest";
import {
  AbortableLeaseController,
  DurableReservationGate,
  ReservationCancelledError,
  type DurableReservationGateTiming,
} from "../../src/foundation/reservation-gate.js";

describe("AbortableLeaseController", () => {
  it("keeps cancellation separate from restoration release", async () => {
    const leases = new AbortableLeaseController<
      { generation: string },
      { code: "STOP"; message: string }
    >();
    const lease = leases.issue("lease-a", { generation: "g1" });

    leases.cancel(lease, { code: "STOP", message: "restore first" });

    expect(lease.signal.reason).toEqual({ code: "STOP", message: "restore first" });
    expect(leases.activeLease).toBe(lease);
    expect(leases.isActive(lease)).toBe(false);
    leases.release(lease);
    await expect(leases.waitForRelease(lease, 0)).resolves.toBe(true);
    expect(leases.activeLease).toBeNull();
  });

  it("rejects leases issued by another controller", () => {
    const first = new AbortableLeaseController<{}, { code: "STOP"; message: string }>();
    const second = new AbortableLeaseController<{}, { code: "STOP"; message: string }>();
    const lease = first.issue("lease-a", {});
    expect(() => second.release(lease)).toThrow("not issued by this controller");
  });
});

class ManualReservationTiming implements DurableReservationGateTiming {
  nowMs = 1_000;
  readonly waits: number[] = [];

  now(): number {
    return this.nowMs;
  }

  async wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    this.waits.push(milliseconds);
    this.nowMs += milliseconds;
  }
}

describe("DurableReservationGate", () => {
  it("still makes one idempotent attempt for a zero-wait reservation", async () => {
    const timing = new ManualReservationTiming();
    const gate = new DurableReservationGate(timing);
    await expect(gate.acquire({
      // Simulate scheduling advancing just beyond a caller's zero-wait bound.
      deadlineMs: timing.now() - 1,
      retryIntervalMs: 10,
      cancellationReason: { code: "CANCELLED", message: "cancelled" },
      attempt: async () => ({ kind: "acquired", value: "already-ready" }),
      onDeadline: () => new Error("deadline"),
    })).resolves.toBe("already-ready");
  });

  it("retries one deterministic reservation until durable acquisition", async () => {
    const timing = new ManualReservationTiming();
    const attempt = vi.fn(async ({ attempt: attemptNumber }: { attempt: number }) =>
      attemptNumber === 2
        ? { kind: "acquired" as const, value: "reservation-a" }
        : { kind: "retry" as const, pending: `pending-${attemptNumber}` });
    const gate = new DurableReservationGate(timing);

    await expect(gate.acquire({
      deadlineMs: 1_100,
      retryIntervalMs: 10,
      cancellationReason: { code: "CANCELLED", message: "cancelled" },
      attempt,
      onDeadline: () => new Error("deadline"),
    })).resolves.toBe("reservation-a");

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(timing.waits).toEqual([10, 10]);
  });

  it("reports the last pending result at the wall deadline", async () => {
    const timing = new ManualReservationTiming();
    const gate = new DurableReservationGate(timing);
    await expect(gate.acquire({
      deadlineMs: 1_015,
      retryIntervalMs: 10,
      cancellationReason: { code: "CANCELLED", message: "cancelled" },
      attempt: async () => ({ kind: "retry", pending: { active: true } }),
      onDeadline: (pending) => new Error(`busy:${pending?.active === true}`),
    })).rejects.toThrow("busy:true");
    expect(timing.waits).toEqual([10, 5]);
  });

  it("returns a typed cancellation reason after an uncertain attempt", async () => {
    const timing = new ManualReservationTiming();
    const controller = new AbortController();
    const gate = new DurableReservationGate(timing);
    const promise = gate.acquire({
      deadlineMs: 1_100,
      retryIntervalMs: 10,
      signal: controller.signal,
      cancellationReason: (signal) => ({
        code: "CALLER_CANCELLED" as const,
        message: String(signal.reason),
      }),
      attempt: async () => {
        controller.abort("stop requested");
        return { kind: "retry" };
      },
      onDeadline: () => new Error("deadline"),
    });

    await expect(promise).rejects.toMatchObject({
      name: "ReservationCancelledError",
      reason: { code: "CALLER_CANCELLED", message: "stop requested" },
    });
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ReservationCancelledError);
    });
  });
});
