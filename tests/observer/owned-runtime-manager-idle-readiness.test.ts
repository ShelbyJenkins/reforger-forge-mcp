import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedRuntimeManagerFixtures,
  makeHarness,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

const inspect = (manager: ReturnType<typeof makeHarness>["manager"]) =>
  manager.inspectIdleShutdownReadiness({
    deadlineTick: performance.now() + 2_000,
    signal: new AbortController().signal,
    probeGeneration: 1,
  });

describe("OwnedRuntimeManager idle readiness", () => {
  it("treats absent storage as exact absence without creating it", async () => {
    const value = makeHarness();
    expect(existsSync(value.manager.storageRoot)).toBe(false);
    await expect(inspect(value.manager)).resolves.toMatchObject({ complete: true, blockers: [] });
    expect(existsSync(value.manager.storageRoot)).toBe(false);
  });

  it("blocks an unexpired preparation and accepts the same provably unconsumed descriptor after expiry", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    await expect(inspect(value.manager)).resolves.toMatchObject({
      complete: true,
      blockers: ["OWNED_RUNTIME_PREPARATION"],
    });
    value.setClock(Date.parse(prepared.prepared.expiresAt) + 1);
    await expect(inspect(value.manager)).resolves.toMatchObject({ complete: true, blockers: [] });
  });

  it("reports an exact live runtime and permits terminal retained evidence", async () => {
    const value = makeHarness();
    const running = await value.start("idle-readiness-live");
    await expect(inspect(value.manager)).resolves.toMatchObject({
      complete: true,
      blockers: ["OWNED_RUNTIME_LIVE"],
    });
    await value.stop(running.runtimeId, "idle-readiness-stop");
    await vi.waitFor(async () => {
      const readiness = await inspect(value.manager);
      expect(readiness).toMatchObject({ complete: true, blockers: [] });
    });
  });

  it("skips a fully linked foreign-host inventory", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    await owner.prepare();
    const foreign = makeHarness({
      root: owner.root,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    await expect(inspect(foreign.manager)).resolves.toMatchObject({ complete: true, blockers: [] });
  });

  it("keeps a foreign runtime as a stable recovery blocker until exact stop completion", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const runtime = await owner.start("foreign-readiness-runtime");
    const foreign = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    foreign.setExecutable(owner.executable);
    await expect(inspect(foreign.manager)).resolves.toMatchObject({
      complete: true,
      blockers: ["OWNED_RUNTIME_RECOVERY"],
    });
    await foreign.stop(runtime.runtimeId, "foreign-readiness-stop");
    await expect(inspect(foreign.manager)).resolves.toMatchObject({ complete: true, blockers: [] });
  });

  it("does not make another Windows user's retained runtime an idle obligation", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    await owner.start("foreign-user-readiness-runtime");
    owner.backend.currentUserSid = "S-1-5-21-different-current-user";
    const foreign = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    foreign.setExecutable(owner.executable);

    await expect(inspect(foreign.manager)).resolves.toMatchObject({
      complete: true,
      blockers: [],
    });
    await expect(foreign.manager.inspectRuntimeHistory()).resolves.toMatchObject({
      complete: true,
      counts: { active_or_unresolved: 1 },
      historicalManagerInstances: 1,
    });
  });

  it("fails closed for malformed or unlinked inventory without repairing it", async () => {
    const value = makeHarness();
    value.manager.recordStoreForTest();
    writeRecord(value.manager, "prepared", "malformed", "{ definitely-not-json\n");
    await expect(inspect(value.manager)).resolves.toMatchObject({
      complete: false,
      blockers: ["INCOMPLETE_PROOF"],
    });
    expect(value.manager.recordStoreForTest().has("prepared", "malformed")).toBe(true);
  });
});
