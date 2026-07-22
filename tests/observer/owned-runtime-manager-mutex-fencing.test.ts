import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createDeadlineBackend,
  createHookedSerialBackend,
  makeHarness,
  readRecord,
  recordExists,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("mutex and lease fencing", () => {
  it("does not call the observer gate after mutex acquisition consumes the stop budget", async () => {
    const backend = createDeadlineBackend();
    const value = makeHarness({
      backend,
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const started = await value.start("deadline-mutex-start");
    const reserve = vi.spyOn(value.gate, "reserveRuntimeStop");
    backend.hangNextMutexAfterAction = true;

    const beganAt = Date.now();
    await expect(value.stop(started.runtimeId, "deadline-mutex-stop"))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(Date.now() - beganAt).toBeLessThan(1_000);
    expect(reserve).not.toHaveBeenCalled();
    expect(backend.terminateCalls).toEqual([]);
  });

  it("does not reserve or terminate after exact inspection consumes the stop budget", async () => {
    const backend = createDeadlineBackend();
    const value = makeHarness({
      backend,
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const started = await value.start("deadline-inspection-start");
    const reserve = vi.spyOn(value.gate, "reserveRuntimeStop");
    backend.hangNextInspection = true;

    const beganAt = Date.now();
    await expect(value.stop(started.runtimeId, "deadline-inspection-stop"))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(Date.now() - beganAt).toBeLessThan(1_000);
    expect(reserve).not.toHaveBeenCalled();
    expect(backend.terminateCalls).toEqual([]);
  });

  it("revalidates the durable restoration reservation after reacquiring the mutex", async () => {
    const backend = createHookedSerialBackend();
    const value = makeHarness({ backend });
    const started = await value.start("proof-race-start");
    backend.beforeAction = () => {
      if (!recordExists(value.manager, "restoration-proofs", started.runtimeId)) return;
      backend.beforeAction = null;
      const proof = readRecord(value.manager, "restoration-proofs", started.runtimeId);
      proof.reservationId = "00000000-0000-4000-8000-999999999999";
      writeRecord(value.manager, "restoration-proofs", started.runtimeId, JSON.stringify(proof));
    };

    await expect(value.stop(started.runtimeId, "proof-race-stop"))
      .rejects.toMatchObject({ code: "STORAGE_UNVERIFIABLE" });
    expect(backend.terminateCalls).toHaveLength(0);
    expect(backend.processes.has(started.pid)).toBe(true);
  });

  });
});
