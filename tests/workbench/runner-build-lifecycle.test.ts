import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
} from "../../src/workbench/helper-addon.js";
import {
  cleanupRunnerHarnesses,
  closeRunnerChild,
  createBuildSpawner,
  createHarness,
  createOwnedRunnerChild,
  exitAfterDurablePublication,
  runBuild,
  writeResourceDatabase,
} from "./runner-fixture.js";

afterEach(cleanupRunnerHarnesses);

describe("standalone Workbench lifecycle runner", () => {
  it("terminates only the exact build child when its bounded timeout expires", async () => {
    const harness = createHarness();
    const observedArguments: Array<readonly string[]> = [];
    let spawnIndex = 0;
    const receipt = await runBuild(harness, (command, args, options) => {
      expect(options.windowsHide).toBe(true);
      observedArguments.push(args);
      const current = spawnIndex++;
      return createOwnedRunnerChild(harness, command, args, {
        pid: current === 0 ? 21_003 : 21_004,
        logName: current === 0 ? "build-preflight" : "timed-build",
      }).child;
    });

    expect(receipt.exitStatus).toMatchObject({
      reason: "timed_out",
      exitCode: null,
      signal: null,
      timedOut: true,
    });
    expect(receipt).toMatchObject({
      version: 3,
      intent: "build",
      pid: 21_004,
      processOwnership: "verified",
      output: null,
      validationFailure: null,
      endpointVacancy: "verified",
      preflight: {
        pid: 21_003,
        executablePath: harness.executablePath,
        creationTime: "133900000000021003",
        endpointOwnership: "verified",
        endpointVacancy: "verified",
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("reforgerForgeOwnerToken");
    expect(harness.backend.terminationCalls).toHaveLength(2);
    expect(harness.backend.terminationCalls[1]).toMatchObject({
      pid: 21_004,
      executablePath: harness.executablePath,
      creationTime: "133900000000021004",
    });
    expect(harness.backend.endpointVacancyCalls).toHaveLength(6);

    const [preflightArgs, buildArgs] = observedArguments;
    const preflightOwner = preflightArgs.findIndex((arg) => arg.startsWith("-reforgerForgeOwnerToken="));
    expect(preflightOwner).toBeGreaterThan(-1);
    expect(preflightOwner).toBeLessThan(preflightArgs.indexOf("-wbModule=ResourceManager"));
    expect(preflightArgs).toContain("-run");
    expect(preflightArgs).toContain(WORKBENCH_HELPER_ADDON_GUID);
    expect(preflightArgs[preflightArgs.indexOf("-addonsDir") + 1].split(",")).toEqual([
      harness.addonRoot,
      join(harness.root, "addons"),
      harness.companion.addonSearchRoot,
    ]);

    const buildOwner = buildArgs.findIndex((arg) => arg.startsWith("-reforgerForgeOwnerToken="));
    expect(buildOwner).toBeGreaterThan(-1);
    expect(buildOwner).toBeLessThan(buildArgs.indexOf("-wbModule=ResourceManager"));
    expect(buildArgs).not.toContain("-addons");
    expect(buildArgs).not.toContain("-run");
    expect(buildArgs).not.toContain("-buildData");
    expect(buildArgs).not.toContain("-build-data");
    expect(buildArgs.filter((arg) => arg === "-builddata")).toHaveLength(1);
    expect(buildArgs).not.toContain("-wbSilent");
    expect(buildArgs).not.toContain("-loadBuiltData");
    const buildModuleIndex = buildArgs.indexOf("-wbModule=ResourceManager");
    expect(buildArgs.slice(buildModuleIndex, buildModuleIndex + 2)).toEqual([
      "-wbModule=ResourceManager",
      "-builddata",
    ]);
    expect(buildArgs[buildArgs.indexOf("-addonsDir") + 1].split(",")).toEqual([
      harness.addonRoot,
      join(harness.root, "addons"),
    ]);
    expect(buildArgs.slice(buildArgs.indexOf("-profile"), buildArgs.indexOf("-profile") + 2))
      .toEqual([
        "-profile",
        join(harness.root, "managed", "workbench-build", "profile"),
      ]);
    expect(buildArgs).not.toContain(harness.companion.addonSearchRoot);
    expect(buildArgs).not.toContain(harness.companion.workbenchProfilePath);
    expect(buildArgs.slice(buildArgs.indexOf("-builddata"), buildArgs.indexOf("-builddata") + 4))
      .toEqual(["-builddata", "PC", harness.outputPath, "ExampleMod"]);
  });

  it("uses the documented installed-1.7 no-run argument form without claiming output", async () => {
    const harness = createHarness();
    let targetArguments: readonly string[] = [];
    const spawner = createBuildSpawner(harness, {
      pidBase: 21_020,
      buildExitCode: 1,
      onSpawn: (index, args) => {
        if (index === 1) targetArguments = args;
      },
    });

    await runBuild(harness, spawner.spawnProcess);

    const buildDataIndex = targetArguments.indexOf("-builddata");
    expect(buildDataIndex).toBeGreaterThan(-1);
    expect(targetArguments).not.toContain("-run");
    expect(targetArguments).not.toContain("-buildData");
    expect(targetArguments).not.toContain("-build-data");
    expect(targetArguments.filter((arg) => arg === "-builddata")).toHaveLength(1);
    expect(targetArguments.slice(buildDataIndex - 1, buildDataIndex + 4)).toEqual([
      "-wbModule=ResourceManager",
      "-builddata",
      "PC",
      harness.outputPath,
      "ExampleMod",
    ]);
    expect(targetArguments.slice(buildDataIndex, buildDataIndex + 4)).toEqual([
      "-builddata",
      "PC",
      harness.outputPath,
      "ExampleMod",
    ]);
    expect(targetArguments[buildDataIndex + 3]).not.toBe(WORKBENCH_HELPER_ADDON_ID);
    expect(targetArguments[buildDataIndex + 3]).not.toBe(WORKBENCH_HELPER_ADDON_GUID);
  });

  it("runs companion preflight and a distinct exact target build with fresh output proof", async () => {
    const harness = createHarness();
    const childSupervisor = new ChildSupervisor();
    const journalPhases: string[] = [];
    harness.backend.spawnJournalReplaceFailure = ({ next }) => {
      journalPhases.push(`${next.record.metadata.purpose}:${next.record.phase}`);
      return null;
    };
    const reattestationAbsence: boolean[] = [];
    harness.companionProvider.verifyStaged = vi.fn(() => {
      reattestationAbsence.push(harness.backend.workbenchPids.size === 0);
      return harness.companion;
    });
    let spawnIndex = 0;
    const onBuildExit = exitAfterDurablePublication(harness);
    const receipt = await runBuild(harness, (command, args) => {
      const current = spawnIndex++;
      if (current === 1) expect(harness.backend.workbenchPids.size).toBe(0);
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: current === 0 ? 21_030 : 21_031,
        logName: current === 0 ? "successful-preflight" : "successful-build",
      });
      if (current === 1) {
        onBuildExit(() => {
          writeResourceDatabase(harness.outputPath, "fresh database");
          writeFileSync(join(harness.outputPath, "ExampleMod", "data.bin"), "fresh data");
          closeRunnerChild(harness, child, 0);
        });
      }
      return child;
    }, { dependencies: { childSupervisor } });

    expect(spawnIndex).toBe(2);
    expect(receipt).toMatchObject({
      version: 3,
      intent: "build",
      pid: 21_031,
      executablePath: harness.executablePath,
      creationTime: "133900000000021031",
      target: harness.projectPath,
      targetAddon: {
        addonId: "ExampleMod",
        addonGuid: "1122334455667788",
        sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      processOwnership: "verified",
      endpointVacancy: "verified",
      preflight: {
        pid: 21_030,
        executablePath: harness.executablePath,
        creationTime: "133900000000021030",
        endpointOwnership: "verified",
        endpointVacancy: "verified",
        logDirectory: join(harness.logRoot, "successful-preflight"),
      },
      logDirectory: join(harness.logRoot, "successful-build"),
      output: {
        root: harness.outputPath,
        freshArtifactCount: 2,
        resourceDatabasePath: join(harness.outputPath, "ExampleMod", "resourceDatabase.rdb"),
        previousResourceDatabaseSha256: null,
        resourceDatabaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      validationFailure: null,
      exitStatus: { reason: "exited", exitCode: 0, timedOut: false },
    });
    expect(receipt.intent === "build" && receipt.output?.freshBytes).toBeGreaterThan(0);
    expect(journalPhases).toEqual([
      "runner_companion_preflight:pre_spawn",
      "runner_companion_preflight:spawned_unverified",
      "runner_companion_preflight:identity_verified",
      "runner_companion_preflight:published",
      "target_build:pre_spawn",
      "target_build:spawned_unverified",
      "target_build:identity_verified",
      "target_build:published",
    ]);
    expect(harness.backend.endpointVacancyCalls).toHaveLength(6);
    expect(reattestationAbsence.at(-1)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("reforgerForgeOwnerToken");
    expect(childSupervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("waits through one occupied socket-release probe after each build phase", async () => {
    const harness = createHarness();
    const laggedPhases = new Set<"preflight" | "target">();
    const spawner = createBuildSpawner(harness, {
      pidBase: 21_040,
      onBuildBeforeExit: () => {
        writeResourceDatabase(harness.outputPath, "fresh database");
      },
    });
    const verifyEndpointVacant = harness.backend.verifyEndpointVacant.bind(harness.backend);
    harness.backend.verifyEndpointVacant = vi.fn(async (endpoint) => {
      const result = await verifyEndpointVacant(endpoint);
      const phase = spawner.spawnCount() === 1
        ? "preflight" as const
        : spawner.spawnCount() === 2
          ? "target" as const
          : null;
      if (result.kind === "vacant" && phase && !laggedPhases.has(phase) &&
          harness.backend.workbenchPids.size === 0) {
        laggedPhases.add(phase);
        return {
          kind: "occupied" as const,
          listenerPid: phase === "preflight" ? 21_040 : 21_041,
          message: "socket release lags exact process absence by one probe",
        };
      }
      return result;
    });

    const receipt = await runBuild(harness, spawner.spawnProcess);

    expect(laggedPhases).toEqual(new Set(["preflight", "target"]));
    expect(harness.backend.endpointVacancyCalls).toHaveLength(8);
    expect(receipt).toMatchObject({
      version: 3,
      intent: "build",
      output: {
        resourceDatabasePath: join(harness.outputPath, "ExampleMod", "resourceDatabase.rdb"),
      },
      endpointVacancy: "verified",
    });
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("refuses an occupied endpoint before the companion preflight can spawn", async () => {
    const harness = createHarness();
    harness.backend.endpointVacancyResult = {
      kind: "occupied",
      listenerPid: 42_424,
      message: "another listener remains",
    };
    const spawner = createBuildSpawner(harness, { pidBase: 22_100 });

    await expect(runBuild(harness, spawner.spawnProcess)).rejects.toMatchObject({
      code: "ENDPOINT_UNVERIFIABLE",
    });

    expect(spawner.spawnCount()).toBe(0);
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.backend.endpointVacancyCalls).toHaveLength(1);
    expect(await harness.guard.readLifecycleState()).toMatchObject({ kind: "missing" });
  });

  it("maps a thrown native vacancy-helper failure and keeps build spawn count at zero", async () => {
    const harness = createHarness();
    harness.backend.verifyEndpointVacant = vi.fn().mockRejectedValue(
      new Error("native vacancy helper returned invalid JSON")
    );
    const spawner = createBuildSpawner(harness, { pidBase: 22_102 });

    await expect(runBuild(harness, spawner.spawnProcess)).rejects.toMatchObject({
      code: "ENDPOINT_UNVERIFIABLE",
    });

    expect(spawner.spawnCount()).toBe(0);
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(await harness.guard.readLifecycleState()).toMatchObject({ kind: "missing" });
  });

  it("refuses an endpoint that becomes occupied before the target build can spawn", async () => {
    const harness = createHarness();
    const originalVacancy = harness.backend.verifyEndpointVacant.bind(harness.backend);
    let vacancyIndex = 0;
    harness.backend.verifyEndpointVacant = vi.fn(async (endpoint) => {
      if (vacancyIndex++ < 3) return originalVacancy(endpoint);
      harness.backend.endpointVacancyCalls.push(endpoint);
      return {
        kind: "occupied" as const,
        listenerPid: 42_425,
        message: "listener appeared after target exit",
      };
    });
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_105,
      onBuildBeforeExit: () => {
        writeResourceDatabase(harness.outputPath, "complete database");
      },
    });

    await expect(runBuild(harness, spawner.spawnProcess)).rejects.toMatchObject({
      code: "ENDPOINT_UNVERIFIABLE",
    });

    expect(spawner.spawnCount()).toBe(1);
    expect(harness.backend.endpointVacancyCalls).toHaveLength(5);
    expect(harness.backend.workbenchPids.size).toBe(0);
  });

  it("revalidates target content between phases and refuses a mutated gproj before build spawn", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, { pidBase: 22_110 });
    harness.backend.replaceFailure = ({ next }) => {
      if (next.phase === "starting" && next.workbench === null && spawner.spawnCount() === 1) {
        writeFileSync(harness.projectPath, [
          "GameProject {",
          " ID MutatedMod",
          ' GUID "8877665544332211"',
          "}",
          "",
        ].join("\n"));
      }
      return null;
    };

    await expect(runBuild(harness, spawner.spawnProcess)).rejects.toMatchObject({
      code: "INVALID_TARGET",
    });

    expect(spawner.spawnCount()).toBe(1);
  });

  it("revalidates packaged companion source between phases and refuses digest mutation", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, { pidBase: 22_120 });
    let currentSourceDigest = harness.companion.bundleDigest;
    harness.companionProvider.verifySourceDigest = vi.fn(() => currentSourceDigest);
    harness.backend.replaceFailure = ({ next }) => {
      if (next.phase === "starting" && next.workbench === null && spawner.spawnCount() === 1) {
        currentSourceDigest = "b".repeat(64);
      }
      return null;
    };

    await expect(runBuild(harness, spawner.spawnProcess)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });

    expect(spawner.spawnCount()).toBe(1);
  });

  it("uses one absolute build deadline and never spawns the target after preflight consumes it", async () => {
    const harness = createHarness();
    const originalVacancy = harness.backend.verifyEndpointVacant.bind(harness.backend);
    harness.backend.verifyEndpointVacant = vi.fn(async (endpoint) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      return originalVacancy(endpoint);
    });
    const spawner = createBuildSpawner(harness, { pidBase: 22_200 });

    await expect(runBuild(harness, spawner.spawnProcess, {
      intent: { timeoutMs: 100 },
    })).rejects.toMatchObject({
      code: "BUILD_DEADLINE_EXCEEDED",
    });

    expect(spawner.spawnCount()).toBe(0);
  });

  it("does not spawn preflight when the build is already aborted", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();
    const spawnProcess = vi.fn();

    await expect(runBuild(harness, spawnProcess, {
      dependencies: { signal: controller.signal },
    })).rejects.toMatchObject({ code: "BUILD_ABORTED" });

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("returns output null without an attestation failure for a nonzero target exit", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_300,
      buildExitCode: 7,
    });

    const receipt = await runBuild(harness, spawner.spawnProcess);

    expect(receipt).toMatchObject({
      version: 3,
      output: null,
      validationFailure: null,
      exitStatus: { reason: "exited", exitCode: 7, timedOut: false },
    });
  });

});
