import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX } from "../../src/observer/owned-runtime-manager.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createLeaseLosingBackend,
  failRuntimePublication,
  listRecordIds,
  makeHarness,
  readRecord,
  recordExists,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("spawn and receipt publication", () => {
  it("spawns exact structured arguments visibly without a shell and publishes a complete restrictive receipt", async () => {
    const value = makeHarness();
    const argumentsArray = ["-window", "-screenWidth", "1280"];
    const prepared = await value.prepare(argumentsArray, "prepare-1");
    argumentsArray.push("-mutated-after-recording");

    const started = await value.startPrepared(prepared.id, "start-1");

    expect(started).toMatchObject({ state: "running", exactOwned: true, runtimeKind: "listenServer" });
    expect(value.spawnCalls).toHaveLength(1);
    const call = value.spawnCalls[0];
    expect(call.executable).toBe(value.executable);
    expect(call.arguments.slice(0, -1)).toEqual(["-window", "-screenWidth", "1280"]);
    expect(call.arguments.filter((argument) => argument.startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX))).toHaveLength(1);
    expect(call.options).toMatchObject({
      cwd: value.root,
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: false,
    });
    const receipt = readRecord(value.manager, "runtimes", started.runtimeId);
    expect(receipt).toMatchObject({
      version: 1,
      runtimeId: started.runtimeId,
      sessionId: started.sessionId,
      preparedLaunchId: prepared.id,
      pid: started.pid,
      executablePath: value.executable,
      profilePath: prepared.prepared.profilePath,
      runtimeKind: "listenServer",
      mcpOwner: {
        installationId: expect.stringMatching(/^[a-f0-9]{64}$/),
        userSid: "S-1-5-21-test-owner",
      },
    });
    expect(receipt.creationTimeFileTime).toMatch(/^\d+$/);
    expect(receipt.ownerTokenArgument).toBe(call.arguments.at(-1));
    expect(receipt.argvSha256).toBe(createHash("sha256").update(JSON.stringify(call.arguments)).digest("hex"));
    expect(started).not.toHaveProperty("ownerTokenArgument");
  });

  it("resolves the executable for the prepared dedicated runtime kind", async () => {
    const value = makeHarness();
    const prepared = await value.prepare([], "dedicated-prepare", "dedicated");

    await value.startPrepared(prepared.id, "dedicated-start");

    expect(value.resolvedRuntimeKinds).toEqual(["dedicated"]);
  });

  it("guards only graphical launches whose prepared arguments request no-focus startup", async () => {
    const value = makeHarness();
    const guarded = await value.prepare(["-noFocus"], "guarded-prepare", "listenServer");
    const unguarded = await value.prepare(["-forceUpdate"], "unguarded-prepare", "client");
    const dedicated = await value.prepare(["-noFocus"], "dedicated-prepare", "dedicated");

    const guardedRuntime = await value.startPrepared(guarded.id, "guarded-start");
    await value.startPrepared(unguarded.id, "unguarded-start");
    await value.startPrepared(dedicated.id, "dedicated-start");

    expect(value.foregroundProtectionPids).toEqual([guardedRuntime.pid]);
  });

  it("refuses ownership publication and cleans up when startup focus protection fails", async () => {
    const value = makeHarness({
      preserveForegroundDuringStartup: async () => {
        throw new Error("focus guard failed");
      },
    });
    const prepared = await value.prepare(["-noFocus"], "focus-failure-prepare");

    await expect(value.startPrepared(prepared.id, "focus-failure-start"))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });

    expect(value.spawnCalls[0].child.killed).toBe(true);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
  });

  it("fences start before spawn and ownership publication when the mutex lease is lost", async () => {
    const backend = createLeaseLosingBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare([], "lease-loss-start-prepare");
    backend.loseOnCurrentInspection = true;

    await expect(value.startPrepared(prepared.id, "lease-loss-start"))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.spawnCalls).toHaveLength(0);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
  });

  it("removes naturally exited children and reconciles exact exit evidence durably", async () => {
    const value = makeHarness();
    const started = await value.start("natural-exit-start");
    expect(value.manager.diagnosticSupervisedChildCount()).toBe(1);
    expect(value.manager.diagnosticSupervisedChildCounts()).toEqual({
      active: 1,
      reconciling: 0,
      total: 1,
    });
    const child = value.spawnCalls[0].child;
    value.backend.processes.delete(started.pid);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect(value.manager.diagnosticSupervisedChildCount()).toBe(0);

    for (let attempt = 0; attempt < 50 && !recordExists(value.manager, "child-exits", started.runtimeId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(readRecord(value.manager, "child-exits", started.runtimeId)).toMatchObject({
      runtimeId: started.runtimeId,
      sessionId: started.sessionId,
      pid: started.pid,
      exitCode: 0,
    });
    for (let attempt = 0; attempt < 50 && value.gate.releasedLifecycles.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(value.gate.releasedLifecycles).toEqual([
      expect.objectContaining({ runtimeId: started.runtimeId, sessionId: started.sessionId }),
    ]);
    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "exited",
      exactOwned: true,
      reason: expect.stringMatching(/Direct child exit/),
    });
  });

  it("makes prepared launches one-shot while replaying exact start idempotency", async () => {
    const value = makeHarness();
    const first = await value.prepare();
    const second = await value.prepare(["-window", "-server", "world"]);
    const started = await value.startPrepared(first.id, "start-key");
    const replay = await value.startPrepared(first.id, "start-key");
    expect(replay.runtimeId).toBe(started.runtimeId);
    expect(value.spawnCalls).toHaveLength(1);
    await expect(value.startPrepared(first.id, "different-key"))
      .rejects.toMatchObject({ code: "PREPARED_LAUNCH_CONSUMED" });
    await expect(value.startPrepared(second.id, "start-key"))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects preexisting owner arguments and publishes no successful receipt after spawn failure", async () => {
    const conflict = makeHarness();
    const launcherNeutral = await conflict.prepare([`${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}foreign`]);
    expect(launcherNeutral.prepared.arguments).toEqual([`${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}foreign`]);
    await expect(conflict.startPrepared(launcherNeutral.id, "owner-conflict"))
      .rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });

    const failed = makeHarness({ spawnFailure: true });
    const prepared = await failed.prepare();
    await expect(failed.startPrepared(prepared.id, "failed-start"))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(listRecordIds(failed.manager, "runtimes")).toEqual([]);
    expect(failed.spawnCalls[0].child.killed).toBe(true);
    const pending = readRecord(
      failed.manager,
      "pending-starts",
      listRecordIds(failed.manager, "pending-starts")[0]
    );
    expect(pending).toMatchObject({ state: "release_acknowledged", preparedLaunchId: prepared.id });
  });

  it("releases the exact lifecycle pin when start fails after pin acquisition but before publication", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    failRuntimePublication(value.manager);

    await expect(value.startPrepared(prepared.id, "post-pin-publication-failure"))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(value.gate.retainedLifecycles).toHaveLength(1);
    expect(value.gate.releasedLifecycles).toEqual(value.gate.retainedLifecycles);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
  });

  it("retains an unpublished exact lifecycle until a same-key retry proves child vacancy", async () => {
    const value = makeHarness({ refuseKill: true });
    const prepared = await value.prepare();
    failRuntimePublication(value.manager);

    await expect(value.startPrepared(prepared.id, "uncertain-post-pin-publication"))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    const pendingId = listRecordIds(value.manager, "pending-starts")[0];
    expect(readRecord(value.manager, "pending-starts", pendingId)).toMatchObject({
      state: "cleanup_required",
      lifecycleGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
      launchedAtMs: expect.any(Number),
      pid: value.spawnCalls[0].child.pid,
    });
    expect(value.gate.retainedLifecycles).toHaveLength(1);
    expect(value.gate.releasedLifecycles).toEqual([]);
    expect(value.backend.processes.has(value.spawnCalls[0].child.pid)).toBe(true);

    await expect(value.startPrepared(prepared.id, "uncertain-post-pin-publication")).rejects.toMatchObject({
      code: "START_UNVERIFIABLE",
      details: { state: "release_required", pid: value.spawnCalls[0].child.pid },
    });
    expect(value.backend.processes.has(value.spawnCalls[0].child.pid)).toBe(false);
    expect(value.gate.releasedLifecycles).toEqual(value.gate.retainedLifecycles);
    expect(readRecord(value.manager, "pending-starts", pendingId)).toMatchObject({ state: "release_acknowledged" });
  });

  it("keeps durable unpublished-exit cleanup retryable when lifecycle release IPC fails", async () => {
    const value = makeHarness({ refuseKill: true });
    const prepared = await value.prepare();
    failRuntimePublication(value.manager);

    await expect(value.startPrepared(prepared.id, "unpublished-natural-exit"))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(value.gate.releasedLifecycles).toEqual([]);

    const child = value.spawnCalls[0].child;
    const pendingId = listRecordIds(value.manager, "pending-starts")[0];
    value.gate.releaseLifecycleFailures = 1;
    value.backend.processes.delete(child.pid);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (readRecord(value.manager, "pending-starts", pendingId).state === "release_required" &&
          value.gate.releaseLifecycleAttempts === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(value.gate.releaseLifecycleAttempts).toBe(1);
    expect(value.gate.releasedLifecycles).toEqual([]);
    expect(readRecord(value.manager, "pending-starts", pendingId)).toMatchObject({
      state: "release_required",
      pid: child.pid,
    });
    await expect(value.startPrepared(prepared.id, "unpublished-natural-exit")).rejects.toMatchObject({
      code: "START_UNVERIFIABLE",
      details: { state: "release_required", pid: child.pid },
    });
    expect(value.gate.releasedLifecycles).toEqual(value.gate.retainedLifecycles);
    expect(readRecord(value.manager, "pending-starts", pendingId)).toMatchObject({
      state: "release_acknowledged",
    });
  });

  });
});
