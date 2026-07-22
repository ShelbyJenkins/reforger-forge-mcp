import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeObserverRuntimeLifecycle } from "../../src/observer/owned-runtime-manager.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createQueuedBackend,
  makeHarness,
  recordExists,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("shutdown sealing and inventory integrity", () => {
  it("rejects a queued start once clean shutdown begins", async () => {
    const backend = createQueuedBackend();
    const value = makeHarness({ backend });
    const startPromise = value.start("shutdown-race-start");
    await backend.firstEntryBlocked;

    const closePromise = value.manager.close();
    backend.allowFirstEntry();

    await expect(startPromise).rejects.toMatchObject({ code: "LIFECYCLE_CLOSING" });
    await expect(closePromise).resolves.toMatchObject({ sealedRuntimeIds: [] });
    expect(value.spawnCalls).toEqual([]);
  });

  it("bounds lifecycle release within the aggregate shutdown deadline", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 5_000,
      terminationTimeoutMs: 5_000,
      lockTimeoutMs: 5_000,
    });
    const started = await value.start("deadline-close-start");
    await value.stop(started.runtimeId, "deadline-close-stop");
    let markReleaseEntered!: () => void;
    const releaseEntered = new Promise<void>((resolve) => { markReleaseEntered = resolve; });
    value.gate.releaseRuntimeLifecycle = vi.fn(async () => {
      markReleaseEntered();
      return new Promise<unknown>(() => undefined);
    });

    vi.useFakeTimers();
    try {
      const beganAt = Date.now();
      const closing = value.manager.close() as Promise<{
        applicationCloseSafe: boolean;
        errorRuntimes: Array<{ runtimeId: string; reason: string }>;
      }>;
      await releaseEntered;
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await closing;
      const runtimeError = result.errorRuntimes.find((entry) => entry.runtimeId === started.runtimeId);

      expect(Date.now() - beganAt).toBe(5_000);
      expect(result.applicationCloseSafe).toBe(false);
      expect(runtimeError?.reason).toContain("aggregate wall-clock deadline");
      expect(value.gate.releaseRuntimeLifecycle).toHaveBeenCalledTimes(1);
      expect(recordExists(value.manager, "stop-completions", started.runtimeId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports one bounded inventory remainder after the aggregate shutdown deadline", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 5_000,
      terminationTimeoutMs: 5_000,
      lockTimeoutMs: 5_000,
    });
    const runtimeIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const started = await value.start(
        `deadline-inventory-start-${index}`,
        [`-deadline-inventory-${index}`]
      );
      runtimeIds.push(started.runtimeId);
      await value.stop(started.runtimeId, `deadline-inventory-stop-${index}`);
    }
    const releaseRuntimeLifecycle = value.gate.releaseRuntimeLifecycle.bind(value.gate);
    let wallNow = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    value.gate.releaseRuntimeLifecycle = vi.fn(async (
      sessionId: string,
      runtimeId: string,
      generation: string
    ) => {
      const acknowledgement = await releaseRuntimeLifecycle(sessionId, runtimeId, generation);
      // Deterministically consume the aggregate shutdown budget after one
      // inspected runtime; setup timing and scheduler load are irrelevant.
      wallNow += 5_000;
      return acknowledgement;
    });

    try {
      const beganAt = Date.now();
      const result = await value.manager.close() as {
        errorRuntimes: Array<{ runtimeId: string; reason: string }>;
        applicationCloseSafe: boolean;
      };
      const inventoryErrors = result.errorRuntimes.filter((entry) => entry.runtimeId === "inventory");

      expect(Date.now() - beganAt).toBe(5_000);
      expect(result.applicationCloseSafe).toBe(false);
      expect(inventoryErrors).toHaveLength(1);
      expect(inventoryErrors[0].reason).toContain("5 runtime(s) were not inspected");
      expect(result.errorRuntimes).toEqual(inventoryErrors);
      expect(value.gate.releaseRuntimeLifecycle).toHaveBeenCalledTimes(1);
      expect(runtimeIds).toHaveLength(6);
    } finally {
      wallClock.mockRestore();
    }
  }, 15_000);

  it("guards the test-only record-store seam against non-test callers", () => {
    const value = makeHarness();
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    try {
      // Simulate a production process (no test runner markers): the seam must
      // fail closed rather than hand out unmediated record-store mutation.
      delete process.env.VITEST;
      delete process.env.NODE_ENV;
      expect(() => value.manager.recordStoreForTest()).toThrowError(/test-only seam/);
    } finally {
      if (savedVitest === undefined) delete process.env.VITEST; else process.env.VITEST = savedVitest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it("keeps coordinator shutdown unsafe when the runtime receipt directory disappears", async () => {
    const value = makeHarness();
    const started = await value.start("missing-inventory-start");
    // Under LMDB there is no separate on-disk receipt directory to delete; the
    // equivalent tamper is a receipt store that cannot be inventoried. Faulting
    // the inventory read through the record-store seam must keep shutdown unsafe.
    vi.spyOn(value.manager.recordStoreForTest(), "listIds").mockImplementation((family: string) => {
      if (family === "runtimes") throw new Error("fixture receipt store unavailable");
      return [];
    });

    await expect(value.manager.close()).resolves.toMatchObject({
      sealedRuntimeIds: [],
      busyRuntimeIds: [],
      errorRuntimes: [expect.objectContaining({
        runtimeId: "inventory",
        reason: expect.stringContaining("receipt directory is missing"),
      })],
      applicationCloseSafe: false,
    });
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it("keeps coordinator shutdown unsafe for a corrupt runtime inventory entry", async () => {
    const value = makeHarness();
    const started = await value.start("non-file-inventory");
    // The file-layout analog (a symlink/directory where a receipt file belonged)
    // cannot exist under LMDB; the faithful port is a corrupt receipt record.
    // Sealing must isolate it as an unverifiable runtime and never reserve it.
    writeRecord(value.manager, "runtimes", started.runtimeId, "{\n");
    const reserve = vi.spyOn(value.gate, "reserveRuntimeStop");

    await expect(value.manager.close()).resolves.toMatchObject({
      sealedRuntimeIds: [],
      busyRuntimeIds: [],
      errorRuntimes: [expect.objectContaining({
        runtimeId: started.runtimeId,
        reason: expect.stringContaining("is invalid"),
      })],
      applicationCloseSafe: false,
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it("cross-binds runtime filenames and isolates shutdown sealing across corrupt receipts", async () => {
    const value = makeHarness();
    const first = await value.start("binding-first", ["-first"]);
    const second = await value.start("binding-second", ["-second"]);
    writeRecord(value.manager, "runtimes", first.runtimeId, "{\n");

    expect(await value.manager.status(first.runtimeId)).toMatchObject({ state: "unverifiable", exactOwned: false });
    const result = await value.manager.close();
    expect(result).toMatchObject({
      sealedRuntimeIds: [second.runtimeId],
      errorRuntimes: [expect.objectContaining({ runtimeId: first.runtimeId })],
    });
  });

  it("does not let a cross-bound completion receipt consume live-runtime recovery reserve", async () => {
    const value = makeHarness();
    const started = await value.start("completion-binding-start");
    expect(value.manager.diagnosticStorageStats().reservedMutationRecords).toBe(5);
    writeRecord(value.manager, "stop-completions", started.runtimeId, JSON.stringify({
      version: 1,
      runtimeId: "rt-ffffffff-ffff-4fff-8fff-ffffffffffff",
      sessionId: started.sessionId,
      preparedLaunchId: started.preparedLaunchId,
      completedAt: "2026-07-18T12:00:00.000Z",
      observerCompleted: true,
      sessionRevoked: true,
    }));

    expect(value.manager.diagnosticStorageStats().reservedMutationRecords).toBe(5);
  });

  it("seals owned runtime restoration before closing the observer application", async () => {
    const order: string[] = [];
    const result = await closeObserverRuntimeLifecycle({
      close: async () => {
        order.push("manager:start");
        await Promise.resolve();
        order.push("manager:sealed");
        return { sealedRuntimeIds: ["rt-fixture"], applicationCloseSafe: true };
      },
    }, {
      close: async () => { order.push("coordinator:closed"); },
    });
      expect(result).toEqual({ sealedRuntimeIds: ["rt-fixture"], applicationCloseSafe: true });
    expect(order).toEqual(["manager:start", "manager:sealed", "coordinator:closed"]);
  });

  it("keeps the observer application alive when shutdown sealing is incomplete", async () => {
    const coordinatorClose = vi.fn(async () => undefined);
    await expect(closeObserverRuntimeLifecycle({
      close: async () => ({
        sealedRuntimeIds: [],
        busyRuntimeIds: ["rt-ffffffff-ffff-4fff-8fff-ffffffffffff"],
        applicationCloseSafe: false,
      }),
    }, {
      close: coordinatorClose,
    })).rejects.toMatchObject({ code: "SHUTDOWN_SEAL_FAILED" });
    expect(coordinatorClose).not.toHaveBeenCalled();
  });

  it("contains no name-based, command-shell, process-tree, or PID-only production termination path", () => {
    const source = [
      "src/observer/owned-runtime-manager.ts",
      "src/tools/observer-runtime.ts",
    ].map((path) => readFileSync(join(process.cwd(), path), "utf8")).join("\n");
    expect(source).not.toMatch(/taskkill|Stop-Process|GetProcessesByName|process\.kill\s*\(|shell:\s*true|\/T\b/i);
    expect(source).toContain("this.backend.verifyAndTerminate");
    expect(source).toContain("No PID lookup occurs here");
  });
  });
});
