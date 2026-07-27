import type { SpawnOptions } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkbenchLifecycleExecution } from "../../src/workbench/lifecycle-execution.js";
import type { WorkbenchSpawnRecord } from "../../src/workbench/process-guard.js";
import {
  cleanupRunnerHarnesses,
  closeRunnerChild,
  createBuildSpawner,
  createHarness,
  createOwnedRunnerChild,
  exitAfterDurablePublication,
  runBuild,
  runEditor,
  type RunnerChild,
  type RunnerSpawnProcess,
  waitForLifecyclePhase,
  writeResourceDatabase,
} from "./runner-fixture.js";

afterEach(cleanupRunnerHarnesses);

describe("standalone Workbench lifecycle runner", () => {
  it("refuses a stale post-lifetime commit after lifecycle generation changes", async () => {
    const harness = createHarness();
    let child!: RunnerChild;
    const run = runEditor(harness, (command, args) => {
      child = createOwnedRunnerChild(harness, command, args, { pid: 21_202 }).child;
      return child;
    });

    const runningState = (await waitForLifecyclePhase(harness, "running")).state;
    const interfered = await harness.guard.withLifecycleLock(async (session) =>
      session.transition({
        generation: runningState.generation,
        leaseId: runningState.mcpOwner?.leaseId ?? null,
      }, {
        phase: "stopping",
        endpoint: runningState.endpoint,
        target: runningState.target,
        mcpOwner: runningState.mcpOwner,
        workbench: runningState.workbench,
        companion: runningState.companion,
        operation: { kind: "recovery", operationId: "interfering-recovery" },
      })
    );

    closeRunnerChild(harness, child, 0);
    await expect(run).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: {
        generation: interfered.generation,
        phase: "stopping",
        workbench: { pid: child.pid },
        operation: { kind: "recovery", operationId: "interfering-recovery" },
      },
    });
  });

  it("revalidates output after lifecycle reservation and before target-build spawn", async () => {
    const harness = createHarness();
    harness.backend.afterReplace = ({ next }) => {
      if (next.phase === "starting" && next.workbench === null) {
        writeFileSync(join(harness.outputPath, "raced-after-reservation.txt"), "occupied");
      }
    };
    const spawnProcess = vi.fn();

    await expect(runBuild(harness, spawnProcess)).rejects.toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("revalidates output after the final endpoint check and before target spawn", async () => {
    const harness = createHarness();
    const originalVacancy = harness.backend.verifyEndpointVacant.bind(harness.backend);
    let vacancyIndex = 0;
    harness.backend.verifyEndpointVacant = vi.fn(async (endpoint) => {
      const result = await originalVacancy(endpoint);
      if (vacancyIndex++ === 1) {
        writeFileSync(join(harness.outputPath, "raced-during-final-endpoint-check.txt"), "occupied");
      }
      return result;
    });
    const spawner = createBuildSpawner(harness, { pidBase: 22_045 });

    await expect(runBuild(harness, spawner.spawnProcess)).rejects.toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });

    expect(spawner.spawnCount()).toBe(0);
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("fails closed when a refused pre-spawn check cannot retire its exact journal", async () => {
    const harness = createHarness();
    const spawnProcess = vi.fn();
    const execution = new WorkbenchLifecycleExecution({
      processGuard: harness.guard,
      spawnProcess,
    });
    const endpoint = { host: "127.0.0.1", port: 5775 };
    const lifecycle = await execution.reserve({
      endpoint,
      target: {
        path: harness.projectPath,
        comparisonKey: harness.projectPath.toLowerCase(),
      },
      companion: null,
    });
    let durableRecord: WorkbenchSpawnRecord | null = null;
    vi.spyOn(harness.guard, "createSpawnJournal").mockImplementation((authority) => {
      expect(authority.generation).toBe(lifecycle.generation);
      return {
        persist: async (_previous, next) => {
          durableRecord = next;
          return next;
        },
        discardPreSpawn: async () => {
          throw new Error("injected exact journal retirement failure");
        },
      };
    });

    await expect(execution.spawnRecoverable({
      lifecycle,
      purpose: "target_build",
      executablePath: harness.executablePath,
      launchArguments: [],
      spawnOptions: { cwd: harness.root },
      ownerArgument: "-reforgerForgeOwnerToken=test",
      launchedAtMs: Date.now(),
      beforeSpawn: () => {
        throw new Error("dependency disappeared");
      },
    })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("journal retirement could not be proven"),
    });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(durableRecord).toMatchObject({
      phase: "pre_spawn",
      metadata: { purpose: "target_build" },
    });
  });

  it("minimizes the spawned window without activating when the plan requests it", async () => {
    const harness = createHarness();
    const ownerArgument = "-reforgerForgeOwnerToken=minimize-test";
    const execution = new WorkbenchLifecycleExecution({
      processGuard: harness.guard,
      spawnProcess: (command, args) =>
        createOwnedRunnerChild(harness, command, args, { pid: 24_001 }).child,
    });
    const lifecycle = await execution.reserve({
      endpoint: { host: "127.0.0.1", port: 5775 },
      target: {
        path: harness.projectPath,
        comparisonKey: harness.projectPath.toLowerCase(),
      },
      companion: null,
    });

    await execution.spawnRecoverable({
      lifecycle,
      purpose: "target_build",
      executablePath: harness.executablePath,
      launchArguments: [ownerArgument],
      spawnOptions: { cwd: harness.root, showWindow: "minimizedNoActivate" } as SpawnOptions,
      ownerArgument,
      launchedAtMs: Date.now(),
    });

    expect(harness.backend.minimizeWindowCalls).toEqual([{ pid: 24_001, timeoutMs: 120_000 }]);
  });

  it("does not minimize the window when the plan does not request it", async () => {
    const harness = createHarness();
    const ownerArgument = "-reforgerForgeOwnerToken=no-minimize-test";
    const execution = new WorkbenchLifecycleExecution({
      processGuard: harness.guard,
      spawnProcess: (command, args) =>
        createOwnedRunnerChild(harness, command, args, { pid: 24_002 }).child,
    });
    const lifecycle = await execution.reserve({
      endpoint: { host: "127.0.0.1", port: 5775 },
      target: {
        path: harness.projectPath,
        comparisonKey: harness.projectPath.toLowerCase(),
      },
      companion: null,
    });

    await execution.spawnRecoverable({
      lifecycle,
      purpose: "target_build",
      executablePath: harness.executablePath,
      launchArguments: [ownerArgument],
      spawnOptions: { cwd: harness.root, showWindow: "normal" } as SpawnOptions,
      ownerArgument,
      launchedAtMs: Date.now(),
    });

    expect(harness.backend.minimizeWindowCalls).toEqual([]);
  });

  it("does not fail the spawn transaction when the best-effort minimize call rejects", async () => {
    const harness = createHarness();
    harness.backend.minimizeWindow = async () => {
      throw new Error("injected minimize failure");
    };
    const ownerArgument = "-reforgerForgeOwnerToken=minimize-failure-test";
    const execution = new WorkbenchLifecycleExecution({
      processGuard: harness.guard,
      spawnProcess: (command, args) =>
        createOwnedRunnerChild(harness, command, args, { pid: 24_003 }).child,
    });
    const lifecycle = await execution.reserve({
      endpoint: { host: "127.0.0.1", port: 5775 },
      target: {
        path: harness.projectPath,
        comparisonKey: harness.projectPath.toLowerCase(),
      },
      companion: null,
    });

    await expect(execution.spawnRecoverable({
      lifecycle,
      purpose: "target_build",
      executablePath: harness.executablePath,
      launchArguments: [ownerArgument],
      spawnOptions: { cwd: harness.root, showWindow: "minimizedNoActivate" } as SpawnOptions,
      ownerArgument,
      launchedAtMs: Date.now(),
    })).resolves.toMatchObject({ identity: { pid: 24_003 } });
  });

  it("reserves a shared empty output immediately after the mutex and blocks a losing target build", async () => {
    const harness = createHarness();
    let spawnCount = 0;
    let releaseBuild!: () => void;
    const buildRelease = new Promise<void>((resolve) => { releaseBuild = resolve; });
    let targetSpawned!: () => void;
    const targetDidSpawn = new Promise<void>((resolve) => { targetSpawned = resolve; });
    const spawnProcess: RunnerSpawnProcess = (command, args) => {
      const index = spawnCount++;
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: 23_000 + index,
        logName: `reservation-${index}`,
      });
      if (index === 0) {
        targetSpawned();
        void buildRelease.then(() => {
          writeResourceDatabase(harness.outputPath, "reserved output");
          closeRunnerChild(harness, child, 0);
        });
      }
      return child;
    };
    const first = runBuild(harness, spawnProcess);
    await targetDidSpawn;
    for (;;) {
      const journal = await harness.guard.readSpawnJournal();
      if (journal.kind === "valid" &&
          journal.record.metadata.purpose === "target_build" &&
          (journal.record.phase === "identity_verified" || journal.record.phase === "published")) {
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    const second = runBuild(harness, spawnProcess);

    await expect(second).rejects.toMatchObject({ code: "LIFECYCLE_CONFLICT" });
    expect(spawnCount).toBe(1);
    releaseBuild();
    await expect(first).resolves.toMatchObject({ intent: "build", output: expect.any(Object) });
  });

  it("reports the exact target child creation time", async () => {
    const harness = createHarness();
    let spawnIndex = 0;
    const targetPid = 22_900;
    const onBuildExit = exitAfterDurablePublication(harness);
    const receipt = await runBuild(harness, (command, args) => {
      const current = spawnIndex++;
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: targetPid,
        creationTime: "133900000000022900",
        logName: "target-build",
      });
      if (current === 0) {
        onBuildExit(() => {
          writeResourceDatabase(harness.outputPath, "reused pid database");
          closeRunnerChild(harness, child, 0);
        });
      }
      return child;
    });

    expect(receipt).toMatchObject({
      pid: targetPid,
      creationTime: "133900000000022900",
    });
    expect(spawnIndex).toBe(1);
  });

  it("releases the mutex during exact-child recovery while durable state stays stopping", async () => {
    const harness = createHarness();
    let targetChild!: RunnerChild;
    const run = runBuild(harness, (command, args) => {
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: 21_015,
        logName: "refusal-build",
      });
      targetChild = child;
      harness.backend.terminationResult = {
        kind: "refused",
        reason: "creation_time_mismatch",
        message: "identity changed",
      };
      return child;
    });
    const rejection = run.then(
      () => { throw new Error("expected exact termination refusal"); },
      (error: unknown) => error
    );
    while (harness.backend.terminationCalls.length < 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }

    let contenderEntered = false;
    const contender = harness.guard.withLifecycleLock(async () => {
      contenderEntered = true;
      return harness.guard.readLifecycleState();
    });
    const observedByContender = await contender;
    expect(contenderEntered).toBe(true);
    expect(observedByContender).toMatchObject({
      kind: "valid",
      state: {
        phase: "stopping",
        workbench: { pid: targetChild.pid },
        operation: { kind: "shutdown" },
      },
    });

    closeRunnerChild(harness, targetChild, 0);
    expect(await rejection).toMatchObject({ code: "TERMINATION_REFUSED" });
  });

  it("returns RECOVERY_REQUIRED within the hard recovery bound and preserves stopping identity", async () => {
    const harness = createHarness();
    let targetPid = 0;
    let recoveryStartedAt = 0;
    harness.backend.beforeTerminate = () => {
      if (targetPid !== 0 && recoveryStartedAt === 0) {
        recoveryStartedAt = Date.now();
      }
    };
    const run = runBuild(harness, (command, args) => {
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: 21_115,
        logName: "bounded-recovery",
      });
      targetPid = child.pid;
      harness.backend.terminationResult = {
        kind: "refused",
        reason: "access_denied",
        message: "fixture refuses exact termination",
      };
      return child;
    }, { dependencies: { recoveryTimeoutMs: 100 } });

    while (harness.backend.terminationCalls.length < 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    const observedDuringRecovery = await harness.guard.withLifecycleLock(() =>
      harness.guard.readLifecycleState()
    );
    expect(observedDuringRecovery).toMatchObject({
      kind: "valid",
      state: {
        phase: "stopping",
        workbench: { pid: targetPid },
        operation: { kind: "shutdown" },
      },
    });
    await expect(run).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(Date.now() - recoveryStartedAt).toBeLessThan(500);
    expect(await harness.guard.readLifecycleState()).toMatchObject(observedDuringRecovery);
  });

});
