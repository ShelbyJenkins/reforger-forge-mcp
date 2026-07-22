import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStopPreflight } from "../../src/observer/owned-runtime-manager.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createFakeBackend,
  createSerialBackend,
  makeHarness,
  readRecord,
  recordExists,
  runtimeStopPreflight,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("restoration gating", () => {
  it("waits for terminal restoration when requested", async () => {
    const value = makeHarness();
    const started = await value.start("wait-start");
    value.gate.preflights.push(runtimeStopPreflight({
      ready: false, reserved: false,
      activeJobIds: ["restoring"],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: ["restoring"],
    }));
    const stopped = await value.stop(started.runtimeId, "wait-stop", 1_000);
    expect(stopped.identityVacant).toBe(true);
  });

  it("retains the exact observer lease after a pre-signal refusal and recovers with the same key", async () => {
    const value = makeHarness();
    const started = await value.start("reservation-cas-start");
    value.backend.refuseTermination = true;
    const release = vi.spyOn(value.gate, "releaseRuntimeStop").mockImplementation(
      async () => ({ released: true })
    );

    await expect(value.stop(started.runtimeId, "reservation-cas-stop"))
      .rejects.toMatchObject({ code: "TERMINATION_REFUSED" });
    expect(release).not.toHaveBeenCalled();
    const proof = readRecord(value.manager, "restoration-proofs", started.runtimeId);
    expect(proof).toMatchObject({
      kind: "live_stop_reservation",
      stopIdempotencyHash: createHash("sha256").update("reservation-cas-stop").digest("hex"),
    });
    expect(value.backend.processes.has(started.pid)).toBe(true);

    value.backend.refuseTermination = false;
    await expect(value.stop(started.runtimeId, "reservation-cas-stop"))
      .resolves.toMatchObject({ termination: "terminated", identityVacant: true });
    expect(value.gate.completedReservations.at(-1)).toBe(proof.reservationId);
  });

  it("adopts the same deterministic observer lease after ambiguous proof publication", async () => {
    const backend = createFakeBackend();
    const value = makeHarness({ backend });
    const started = await value.start("ambiguous-proof-start");
    const proposals: string[] = [];
    let incumbent: string | null = null;
    value.gate.reserveRuntimeStop = vi.fn(async (_sessionId, proposedReservationId) => {
      proposals.push(proposedReservationId);
      incumbent ??= proposedReservationId;
      if (proposals.length === 1) backend.mutexFailures = 2;
      return runtimeStopPreflight({
        ready: incumbent === proposedReservationId,
        reserved: incumbent === proposedReservationId,
        ...(incumbent === proposedReservationId ? { reservationId: proposedReservationId } : {}),
      });
    });

    await expect(value.stop(started.runtimeId, "ambiguous-proof-stop"))
      .rejects.toMatchObject({ code: "STOP_FAILED" });
    expect(backend.processes.has(started.pid)).toBe(true);

    await expect(value.stop(started.runtimeId, "ambiguous-proof-stop"))
      .resolves.toMatchObject({ termination: "terminated", identityVacant: true });
    expect(proposals).toHaveLength(2);
    expect(new Set(proposals).size).toBe(1);
    expect(value.gate.completedReservations.at(-1)).toBe(incumbent);
  });

  it("switches to exact-vacancy completion when the process exits during restoration wait", async () => {
    const value = makeHarness();
    const started = await value.start("restoration-exit-start");
    const vacancyArguments: boolean[] = [];
    value.gate.reserveRuntimeStop = vi.fn(async (_sessionId, proposedReservationId, exactRuntimeVacant = false) => {
      vacancyArguments.push(exactRuntimeVacant);
      if (!exactRuntimeVacant) {
        value.backend.processes.delete(started.pid);
        return runtimeStopPreflight({
          ready: false, reserved: false,
          activeJobIds: ["job-restoring"],
          restorationPendingJobIds: ["job-restoring"],
        });
      }
      return runtimeStopPreflight({
        reservationId: proposedReservationId,
      });
    });

    await expect(value.stop(started.runtimeId, "restoration-exit-stop", 1_000))
      .resolves.toMatchObject({ termination: "already_exited", identityVacant: true });
    expect(vacancyArguments).toEqual([false, true]);
    expect(value.backend.terminateCalls).toEqual([]);
    expect(value.gate.completedExactVacancies).toEqual([true]);
  });

  it("does not hold the machine mutex while waiting for restoration readiness", async () => {
    const backend = createSerialBackend();
    const value = makeHarness({ backend });
    const started = await value.start("unlocked-wait-start");
    let releasePreflight!: () => void;
    const preflightRelease = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let preflightCalled!: () => void;
    const didCallPreflight = new Promise<void>((resolve) => { preflightCalled = resolve; });
    value.gate.reserveRuntimeStop = vi.fn(async (_sessionId, proposedReservationId) => {
      preflightCalled();
      await preflightRelease;
      return runtimeStopPreflight({
        reservationId: proposedReservationId,
      });
    });

    const stopping = value.stop(started.runtimeId, "unlocked-wait-stop", 1_000);
    await didCallPreflight;
    let contenderEntered = false;
    await expect(Promise.race([
      backend.withMachineMutex({ name: "contender", timeoutMs: 1_000, action: async () => { contenderEntered = true; } })
        .then(() => "entered" as const),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ])).resolves.toBe("entered");
    expect(contenderEntered).toBe(true);

    releasePreflight();
    await expect(stopping).resolves.toMatchObject({ state: "exited", identityVacant: true });
  });

  it("does not hold the machine mutex while observer stop completion is pending", async () => {
    const backend = createSerialBackend();
    const value = makeHarness({ backend });
    const started = await value.start("unlocked-completion-start");
    let acknowledgeCompletion!: () => void;
    const completionAcknowledgement = new Promise<void>((resolve) => { acknowledgeCompletion = resolve; });
    let completionCalled!: () => void;
    const didCallCompletion = new Promise<void>((resolve) => { completionCalled = resolve; });
    value.gate.completeRuntimeStop = vi.fn(async () => {
      completionCalled();
      await completionAcknowledgement;
      return { completed: true, revoked: true };
    });

    const stopping = value.stop(started.runtimeId, "unlocked-completion-stop");
    await didCallCompletion;
    expect(recordExists(value.manager, "stops", started.runtimeId)).toBe(true);
    expect(recordExists(value.manager, "stop-completions", started.runtimeId)).toBe(false);
    await expect(Promise.race([
      backend.withMachineMutex({ name: "contender", timeoutMs: 1_000, action: async () => "entered" as const }),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ])).resolves.toBe("entered");

    acknowledgeCompletion();
    await expect(stopping).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
  });

  it("bounds a never-settling restoration gate even when no restoration wait was requested", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const started = await value.start("deadline-restoration-start");
    value.gate.reserveRuntimeStop = vi.fn(
      async () => new Promise<RuntimeStopPreflight>(() => undefined)
    );

    const beganAt = Date.now();
    await expect(value.stop(started.runtimeId, "deadline-restoration-stop")).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        runtimeId: started.runtimeId,
        state: "stopping",
        wallDeadlineExpired: true,
      },
    });
    expect(Date.now() - beganAt).toBeLessThan(1_000);
    expect(value.backend.terminateCalls).toEqual([]);
    expect(value.backend.processes.has(started.pid)).toBe(true);

    const attemptHash = createHash("sha256")
      .update("deadline-restoration-stop")
      .digest("hex");
    expect(readRecord(value.manager, "idempotency", `stop-${attemptHash}`)).toMatchObject({
      action: "stop",
      runtimeId: started.runtimeId,
      state: "starting",
    });
  });

  it("returns recovery-required with exact vacancy evidence when observer completion never settles", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const started = await value.start("deadline-completion-start");
    let markCompletionEntered!: () => void;
    const completionEntered = new Promise<void>((resolve) => { markCompletionEntered = resolve; });
    value.gate.completeRuntimeStop = vi.fn(async () => {
      markCompletionEntered();
      return new Promise<unknown>(() => undefined);
    });

    vi.useFakeTimers();
    try {
      const beganAt = Date.now();
      const stopping = value.stop(started.runtimeId, "deadline-completion-stop");
      const rejection = expect(stopping).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await completionEntered;
      await vi.advanceTimersByTimeAsync(300);
      await rejection;

      expect(Date.now() - beganAt).toBe(300);
      expect(value.backend.processes.has(started.pid)).toBe(false);
      expect(recordExists(value.manager, "stops", started.runtimeId)).toBe(true);
      expect(recordExists(value.manager, "stop-completions", started.runtimeId)).toBe(false);
      await expect(value.manager.status(started.runtimeId)).resolves.toMatchObject({
        state: "stopping",
        identityVacant: true,
        terminationComplete: true,
        observerCleanupPending: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  });
});
