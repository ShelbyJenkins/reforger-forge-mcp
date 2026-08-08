import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX,
  resolveRuntimeExecutableEvidenceFromSource,
} from "../../src/observer/owned-runtime-manager.js";
import { gameLaunchRevalidationDeadlineError } from
  "../../src/launch/game-launch-revalidation-isolation.js";
import { RuntimeFocusGuardError } from "../../src/platform/windows/runtime-focus-guard.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createLeaseLosingBackend,
  createSerialBackend,
  failRuntimePublication,
  listRecordIds,
  makeHarness,
  readRecord,
  recordExists,
} from "./owned-runtime-manager-fixture.js";

const WINDOWS_NATIVE_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 5_000;

afterEach(cleanupOwnedRuntimeManagerFixtures);

function waitForInjectedRevalidation(
  release: Promise<void> | null,
  deadlineAtMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(new Error("fixture revalidation lease was aborted"));
    const timer = setTimeout(
      () => finish(gameLaunchRevalidationDeadlineError()),
      Math.max(0, deadlineAtMs - Date.now()),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (release) void release.then(() => finish(), (error: unknown) =>
      finish(error instanceof Error ? error : new Error("fixture revalidation failed")));
  });
}

describe("OwnedRuntimeManager", { timeout: WINDOWS_NATIVE_TEST_TIMEOUT_MS }, () => {
  describe("spawn and receipt publication", () => {
  it("spawns exact structured arguments visibly without a shell and publishes a complete restrictive receipt", async () => {
    const value = makeHarness();
    const argumentsArray = ["-noSplash", "-server", "world"];
    const prepared = await value.prepare(argumentsArray, "prepare-1");
    argumentsArray.push("-mutated-after-recording");

    const started = await value.startPrepared(prepared.id, "start-1");

    expect(started).toMatchObject({ state: "running", exactOwned: true, runtimeKind: "listenServer" });
    expect(value.spawnCalls).toHaveLength(1);
    const call = value.spawnCalls[0];
    expect(call.executable).toBe(value.executable);
    expect(call.arguments.slice(0, -1)).toEqual(["-noSplash", "-server", "world"]);
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

  it("keeps primitive start responsive while baseline executable evidence runs in isolation", async () => {
    const value = makeHarness();
    const prepared = await value.prepare([], "responsive-baseline-prepare");

    const pending = value.startPrepared(prepared.id, "responsive-baseline-start");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(value.spawnCalls).toEqual([]);
    await expect(pending).resolves.toMatchObject({ state: "running", exactOwned: true });
    expect(value.spawnCalls).toHaveLength(1);
  });

  it("propagates one absolute deadline and byte cap through primitive baseline and post-spawn phases", async () => {
    const observed: Array<{
      phase: string;
      deadlineAtMs: number;
      executableMaximumBytes: number;
    }> = [];
    const value = makeHarness({
      pointOfUseRevalidator: async (request) => {
        observed.push({
          phase: request.phase,
          deadlineAtMs: request.deadlineAtMs,
          executableMaximumBytes: request.executableMaximumBytes,
        });
        if (request.phase === "baseline_executable") {
          return resolveRuntimeExecutableEvidenceFromSource(
            request.executableSource,
            request.runtimeKind,
            request.executableMaximumBytes,
          );
        }
        if (request.phase === "pre_spawn") {
          throw new Error("Primitive fixture unexpectedly requested game-launch revalidation");
        }
        return request.expectedExecutable;
      },
    });
    const prepared = await value.prepare([], "primitive-budget-prepare");
    const deadlineAtMs = Date.now() + 5_000;
    const executableMaximumBytes = 123_456;

    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "primitive-budget-start",
      revalidationDeadlineAtMs: deadlineAtMs,
      executableMaximumBytes,
    })).resolves.toMatchObject({ state: "running", exactOwned: true });

    expect(observed.map(({ phase }) => phase)).toEqual([
      "baseline_executable",
      "post_spawn_executable",
    ]);
    expect(observed.every((request) => request.deadlineAtMs === deadlineAtMs)).toBe(true);
    expect(observed.every((request) =>
      request.executableMaximumBytes === executableMaximumBytes)).toBe(true);
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
    expect(value.foregroundProtectionPreparations).toEqual([
      expect.objectContaining({
        executablePath: value.executable,
        ownerTokenArgument: expect.stringMatching(/^\-reforgerForgeOwnerToken=/),
      }),
    ]);
  });

  it("proves focus-hook readiness before spawn and completes against exact creation identity", async () => {
    let spawnCountAtPreparation = -1;
    let completedIdentity: { pid: number; creationTime: string } | null = null;
    const value = makeHarness({
      prepareForegroundDuringStartup: async () => {
        spawnCountAtPreparation = value.spawnCalls.length;
        return {
          bindTarget: async (targetPid) => { value.foregroundProtectionPids.push(targetPid); },
          complete: async (expected) => {
            completedIdentity = { pid: expected.pid, creationTime: expected.creationTime };
            return {
              targetPid: expected.pid,
              targetCreationTime: expected.creationTime,
              hookCount: 2,
              hooksUnhooked: true,
              callbackRooted: true,
              callbackReleased: true,
              protectedWindowCount: 1,
              styleVerifiedCount: 1,
              foregroundIntercepted: false,
              foregroundRestored: false,
              finalForegroundOwned: false,
            };
          },
          abort: async () => undefined,
        };
      },
    });
    const prepared = await value.prepare(["-noFocus"], "focus-order-prepare");

    const started = await value.startPrepared(prepared.id, "focus-order-start");

    expect(spawnCountAtPreparation).toBe(0);
    expect(completedIdentity).toEqual({
      pid: started.pid,
      creationTime: String(800000 + started.pid),
    });
  });

  it("refuses ownership publication and cleans up when startup focus protection fails", async () => {
    let aborted = false;
    const value = makeHarness({
      prepareForegroundDuringStartup: async () => ({
        bindTarget: async (targetPid) => { value.foregroundProtectionPids.push(targetPid); },
        complete: async () => { throw new RuntimeFocusGuardError("focus guard failed"); },
        abort: async () => { aborted = true; },
      }),
    });
    const prepared = await value.prepare(["-noFocus"], "focus-failure-prepare");

    await expect(value.startPrepared(prepared.id, "focus-failure-start"))
      .rejects.toMatchObject({ code: "FOCUS_PROTECTION_FAILED" });

    expect(value.spawnCalls[0].child.killed).toBe(true);
    expect(aborted).toBe(true);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
  });

  it("keeps exact stop authority when post-spawn revalidation exceeds its deadline", async () => {
    let entered!: () => void;
    const revalidationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const value = makeHarness({
      refuseKill: true,
      pointOfUseRevalidator: async (request, signal) => {
        if (request.phase === "baseline_executable") {
          return resolveRuntimeExecutableEvidenceFromSource(
            request.executableSource,
            request.runtimeKind,
            request.executableMaximumBytes,
          );
        }
        entered();
        await waitForInjectedRevalidation(null, request.deadlineAtMs, signal);
        throw new Error("unreachable fixture revalidation completion");
      },
    });
    const prepared = await value.prepare([], "post-spawn-timeout-prepare");
    const start = value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "post-spawn-timeout-start",
      revalidationDeadlineAtMs: Date.now() + 100,
      executableMaximumBytes: 1024 * 1024,
    });

    await revalidationEntered;
    let timerObserved = false;
    await new Promise<void>((resolve) => setTimeout(() => {
      timerObserved = true;
      resolve();
    }, 0));
    expect(timerObserved).toBe(true);
    await expect(start).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });

    expect(value.spawnCalls).toHaveLength(1);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
    const pendingId = listRecordIds(value.manager, "pending-starts")[0];
    expect(readRecord(value.manager, "pending-starts", pendingId)).toMatchObject({
      state: "cleanup_required",
      pid: value.spawnCalls[0].child.pid,
      lifecycleGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(value.manager.diagnosticSupervisedChildCount()).toBe(1);
  });

  it("retains the lifecycle mutex fence while isolated post-spawn revalidation is pending", async () => {
    let entered!: () => void;
    let release!: () => void;
    const revalidationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const revalidationRelease = new Promise<void>((resolve) => { release = resolve; });
    const value = makeHarness({
      backend: createSerialBackend(),
      pointOfUseRevalidator: async (request, signal) => {
        if (request.phase === "baseline_executable") {
          return resolveRuntimeExecutableEvidenceFromSource(
            request.executableSource,
            request.runtimeKind,
            request.executableMaximumBytes,
          );
        }
        entered();
        await waitForInjectedRevalidation(
          revalidationRelease,
          request.deadlineAtMs,
          signal,
        );
        return request.expectedExecutable;
      },
    });
    const prepared = await value.prepare([], "fenced-revalidation-prepare");
    const start = value.startPrepared(prepared.id, "fenced-revalidation-start");
    await revalidationEntered;

    let secondPreparationCompleted = false;
    const secondPreparation = value.prepare([], "fenced-revalidation-second")
      .then(() => { secondPreparationCompleted = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(secondPreparationCompleted).toBe(false);

    release();
    await expect(start).resolves.toMatchObject({ state: "running", exactOwned: true });
    await secondPreparation;
    expect(secondPreparationCompleted).toBe(true);
  });

  it("detects post-spawn same-path executable replacement before publication", async () => {
    const value = makeHarness({
      prepareForegroundDuringStartup: async () => ({
        bindTarget: async () => undefined,
        complete: async (expected) => {
          writeFileSync(value.executable, "replacement after process creation");
          return {
            targetPid: expected.pid,
            targetCreationTime: expected.creationTime,
            hookCount: 2,
            hooksUnhooked: true,
            callbackRooted: true,
            callbackReleased: true,
            protectedWindowCount: 1,
            styleVerifiedCount: 1,
            foregroundIntercepted: false,
            foregroundRestored: false,
            finalForegroundOwned: false,
          };
        },
        abort: async () => undefined,
      }),
    });
    const prepared = await value.prepare(["-noFocus"], "post-spawn-replace-prepare");

    await expect(value.startPrepared(prepared.id, "post-spawn-replace-start"))
      .rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });

    expect(value.spawnCalls).toHaveLength(1);
    expect(value.spawnCalls[0].child.killed).toBe(true);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
    const pendingId = listRecordIds(value.manager, "pending-starts")[0];
    expect(readRecord(value.manager, "pending-starts", pendingId)).toMatchObject({
      state: "release_acknowledged",
      lifecycleGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("refuses a pre-spawn hook-readiness failure without creating the target", async () => {
    const value = makeHarness({
      prepareForegroundDuringStartup: async () => {
        throw new RuntimeFocusGuardError("focus hooks were not ready");
      },
    });
    const prepared = await value.prepare(["-noFocus"], "focus-ready-failure-prepare");

    await expect(value.startPrepared(prepared.id, "focus-ready-failure-start"))
      .rejects.toMatchObject({ code: "FOCUS_PROTECTION_FAILED" });

    expect(value.spawnCalls).toEqual([]);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
  });

  it("rechecks the absolute evidence deadline at the final process-creation edge", async () => {
    let aborted = false;
    const value = makeHarness({
      pointOfUseRevalidator: async (request) => {
        if (request.phase !== "baseline_executable") {
          throw new Error("fixture unexpectedly reached post-spawn revalidation");
        }
        return resolveRuntimeExecutableEvidenceFromSource(
          request.executableSource,
          request.runtimeKind,
          request.executableMaximumBytes,
        );
      },
      prepareForegroundDuringStartup: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
        return {
          bindTarget: async () => undefined,
          complete: async () => { throw new Error("fixture must not complete focus protection"); },
          abort: async () => { aborted = true; },
        };
      },
    });
    const prepared = await value.prepare(["-noFocus"], "spawn-edge-deadline-prepare");

    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "spawn-edge-deadline-start",
      revalidationDeadlineAtMs: Date.now() + 25,
      executableMaximumBytes: 1024 * 1024,
    })).rejects.toMatchObject({ code: "PLANNING_TIMEOUT" });

    expect(value.spawnCalls).toHaveLength(0);
    expect(aborted).toBe(true);
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
    const pendingId = listRecordIds(value.manager, "pending-starts")[0];
    expect(readRecord(value.manager, "pending-starts", pendingId)).toMatchObject({
      state: "release_acknowledged",
      pid: null,
      lifecycleGeneration: null,
    });
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

  it("does not enter the spawn journal when the mutex lease is lost during foreground preparation", async () => {
    const backend = createLeaseLosingBackend();
    let preparationEntered!: () => void;
    let releasePreparation!: () => void;
    let guardAborted!: () => void;
    const entered = new Promise<void>((resolve) => { preparationEntered = resolve; });
    const release = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const aborted = new Promise<void>((resolve) => { guardAborted = resolve; });
    const value = makeHarness({
      backend,
      prepareForegroundDuringStartup: async () => {
        preparationEntered();
        await release;
        return {
          bindTarget: async () => undefined,
          complete: async () => { throw new Error("fixture must not complete focus protection"); },
          abort: async () => { guardAborted(); },
        };
      },
    });
    const prepared = await value.prepare(["-noFocus"], "foreground-lease-loss-prepare");

    const start = value.startPrepared(prepared.id, "foreground-lease-loss-start");
    await entered;
    backend.loseLease();
    releasePreparation();

    await expect(start).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    await aborted;
    expect(value.spawnCalls).toHaveLength(0);
    expect(listRecordIds(value.manager, "pending-starts")).toEqual([]);
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
    const second = await value.prepare(["-noSplash", "-server", "world"]);
    const started = await value.startPrepared(first.id, "start-key");
    const replay = await value.startPrepared(first.id, "start-key");
    expect(replay.runtimeId).toBe(started.runtimeId);
    expect(value.spawnCalls).toHaveLength(1);
    await expect(value.startPrepared(first.id, "different-key"))
      .rejects.toMatchObject({
        code: "PREPARED_LAUNCH_CONSUMED",
        details: { runtimeId: started.runtimeId },
      });
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
