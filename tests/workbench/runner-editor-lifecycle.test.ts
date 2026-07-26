import type { SpawnOptions } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
} from "../../src/workbench/helper-addon.js";
import {
  addAttributedLog,
  cleanupRunnerHarnesses,
  closeRunnerChild,
  createHarness,
  createOwnedRunnerChild,
  exitAfterReadinessProbe,
  runEditor,
  type RunnerChild,
  waitForLifecyclePhase,
} from "./runner-fixture.js";

afterEach(cleanupRunnerHarnesses);

describe("standalone Workbench lifecycle runner", () => {
  it("runs a visible foreground editor under exact ownership and returns a bounded receipt", async () => {
    const harness = createHarness();
    const childSupervisor = new ChildSupervisor();
    let observedArgs: readonly string[] = [];
    let observedOptions: SpawnOptions | undefined;
    const readiness = exitAfterReadinessProbe();
    const receipt = await runEditor(harness, (command, args, options) => {
      expect(command).toBe(harness.executablePath);
      observedArgs = args;
      observedOptions = options;
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: 21_001,
        logName: "editor-run",
      });
      readiness.onExit(() => closeRunnerChild(harness, child, 0));
      return child;
    }, { childSupervisor, companionProbe: readiness.companionProbe });

    expect(observedOptions).toMatchObject({
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    });
    expect(observedArgs.filter((arg) => arg === "-addonsDir")).toHaveLength(1);
    const addonArgument = observedArgs[observedArgs.indexOf("-addonsDir") + 1];
    expect(addonArgument.split(",")).toEqual([
      harness.addonRoot,
      join(harness.root, "addons"),
      harness.companion.addonSearchRoot,
    ]);
    expect(observedArgs.slice(observedArgs.indexOf("-addons"), observedArgs.indexOf("-addons") + 2))
      .toEqual([
        "-addons",
        WORKBENCH_HELPER_ADDON_GUID,
      ]);
    expect(observedArgs.slice(observedArgs.indexOf("-profile"), observedArgs.indexOf("-profile") + 2))
      .toEqual([
        "-profile",
        harness.companion.workbenchProfilePath,
      ]);
    expect(observedArgs).toContain("-scriptAuthorizeAll");
    expect(observedArgs).toContain("-wbModule=WorldEditor");
    expect(observedArgs).toContain("-run");
    expect(receipt).toMatchObject({
      intent: "editor",
      pid: 21_001,
      target: harness.projectPath,
      lifecycleGeneration: expect.any(String),
      endpointOwnership: "verified",
      companionIdentity: {
        addonId: WORKBENCH_HELPER_ADDON_ID,
        addonGuid: WORKBENCH_HELPER_ADDON_GUID,
        addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
        protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
        workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
        buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
        bundleDigest: harness.companion.bundleDigest,
      },
      logDirectory: join(harness.logRoot, "editor-run"),
      exitStatus: { reason: "exited", exitCode: 0, signal: null, timedOut: false },
    });
    expect(JSON.stringify(receipt)).not.toContain("reforgerForgeOwnerToken");
    expect(childSupervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: {
        version: 3,
        phase: "vacant",
        target: { path: harness.projectPath },
        workbench: null,
        operation: null,
        companion: {
          addonId: WORKBENCH_HELPER_ADDON_ID,
          buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
        },
      },
    });
  });

  it("releases the machine mutex during foreground lifetime while durable state stays busy", async () => {
    const harness = createHarness();
    let child!: RunnerChild;
    let ownerArgument = "";
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolvePromise) => { spawned = resolvePromise; });
    const run = runEditor(harness, (command, args) => {
      ({ child, ownerArgument } = createOwnedRunnerChild(harness, command, args, {
        pid: 21_002,
      }));
      spawned();
      return child;
    });
    await didSpawn;

    const busyState = await waitForLifecyclePhase(harness, "running");
    expect(busyState.kind).toBe("valid");
    expect(busyState.state.phase).toBe("running");
    expect(busyState.state.workbench?.pid).toBe(child.pid);
    expect(busyState.state.target?.path).toBe(harness.projectPath);
    expect(busyState.state.companion?.buildIdentity).toBe(WORKBENCH_HELPER_BUILD_IDENTITY);
    expect(busyState.state.mcpOwner).not.toBeNull();

    let contenderEntered = false;
    const contender = harness.guard.withLifecycleLock(async () => {
      contenderEntered = true;
      return harness.guard.readLifecycleState();
    });
    const observedByContender = await contender;
    expect(contenderEntered).toBe(true);
    expect(observedByContender).toMatchObject({
      kind: "valid",
      state: { phase: "running", workbench: { pid: child.pid } },
    });

    addAttributedLog(harness.logRoot, "guarded-editor", ownerArgument);
    closeRunnerChild(harness, child, 0);
    await run;
    expect(harness.backend.maxConcurrent).toBe(1);
  });

  it("releases the machine mutex during readiness after publishing exact starting ownership", async () => {
    const harness = createHarness();
    let child!: RunnerChild;
    let ownerArgument = "";
    let readinessEntered!: () => void;
    let releaseReadiness!: () => void;
    const didEnterReadiness = new Promise<void>((resolve) => { readinessEntered = resolve; });
    const readinessRelease = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    const originalVerify = harness.backend.verifyEndpointOwner.bind(harness.backend);
    harness.backend.verifyEndpointOwner = vi.fn(async (endpoint, expected) => {
      readinessEntered();
      await readinessRelease;
      return originalVerify(endpoint, expected);
    });

    const run = runEditor(harness, (command, args) => {
      ({ child, ownerArgument } = createOwnedRunnerChild(harness, command, args, {
        pid: 21_102,
      }));
      return child;
    });

    await didEnterReadiness;
    const observedByContender = await harness.guard.withLifecycleLock(() =>
      harness.guard.readLifecycleState()
    );
    expect(observedByContender).toMatchObject({
      kind: "valid",
      state: {
        phase: "starting",
        workbench: { pid: child.pid, creationTime: "133900000000021102" },
        operation: { kind: "launch" },
      },
    });

    releaseReadiness();
    await waitForLifecyclePhase(harness, "running");
    addAttributedLog(harness.logRoot, "readiness-editor", ownerArgument);
    closeRunnerChild(harness, child, 0);
    await expect(run).resolves.toMatchObject({ pid: child.pid, intent: "editor" });
  });

  it("exact-terminates the child before reporting ambiguous endpoint ownership", async () => {
    const harness = createHarness();
    harness.backend.endpointOwnershipResult = {
      kind: "refused",
      reason: "listener_pid_mismatch",
      message: "another process owns the endpoint",
    };
    await expect(runEditor(harness, (command, args) =>
      createOwnedRunnerChild(harness, command, args, { pid: 21_006 }).child
    ))
      .rejects.toMatchObject({ code: "ENDPOINT_UNVERIFIABLE" });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
  });

  it("requires the exact companion Ping identity and binds no successful receipt to a mismatch", async () => {
    const harness = createHarness();
    await expect(runEditor(
      harness,
      (command, args) =>
        createOwnedRunnerChild(harness, command, args, { pid: 21_007 }).child,
      {
        companionProbe: vi.fn(async () => ({
          status: "ok",
          helperAddonId: WORKBENCH_HELPER_ADDON_ID,
          helperAddonGuid: WORKBENCH_HELPER_ADDON_GUID,
          helperAddonVersion: WORKBENCH_HELPER_ADDON_VERSION,
          helperProtocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
          workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
          helperBuildIdentity: "wrong-build",
        })),
      }
    ))
      .rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("does not treat a ChildProcess error as close or release ownership while the exact child is live", async () => {
    const harness = createHarness();
    harness.backend.terminationResult = {
      kind: "refused",
      reason: "creation_time_mismatch",
      message: "identity became uncertain",
    };
    let child!: RunnerChild;
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolvePromise) => { spawned = resolvePromise; });
    const run = runEditor(harness, (command, args) => {
      child = createOwnedRunnerChild(harness, command, args, { pid: 21_008 }).child;
      spawned();
      return child;
    });
    await didSpawn;
    await waitForLifecyclePhase(harness, "running");
    child.fail("simulated live-child error");
    while (harness.backend.terminationCalls.length === 0) {
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
      state: { phase: "stopping", workbench: { pid: child.pid } },
    });

    closeRunnerChild(harness, child, 1);
    await expect(run).rejects.toMatchObject({ code: "TERMINATION_REFUSED" });
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("captures exact identity and terminates when a spawned child errors before readiness", async () => {
    const harness = createHarness();
    await expect(runEditor(harness, (command, args) => {
      const child = createOwnedRunnerChild(harness, command, args, { pid: 21_009 }).child;
      queueMicrotask(() => child.fail("error before companion readiness"));
      return child;
    }))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("refuses a pre-existing Workbench before spawn", async () => {
    const harness = createHarness();
    harness.backend.addWorkbench({
      pid: 19_999,
      executablePath: harness.executablePath,
      creationTime: "133900000000019999",
    });
    const spawnProcess = vi.fn();

    await expect(runEditor(harness, spawnProcess)).rejects.toMatchObject({
      code: "LIFECYCLE_CONFLICT",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("refuses an occupied endpoint before the foreground editor can spawn", async () => {
    const harness = createHarness();
    harness.backend.endpointVacancyResult = {
      kind: "occupied",
      listenerPid: 42_426,
      message: "foreign listener owns the endpoint",
    };
    const spawnProcess = vi.fn();

    await expect(runEditor(harness, spawnProcess)).rejects.toMatchObject({
      code: "ENDPOINT_UNVERIFIABLE",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(harness.backend.endpointVacancyCalls).toHaveLength(1);
    expect(await harness.guard.readLifecycleState()).toMatchObject({ kind: "missing" });
  });

  it("rejects a custom companion provider whose managed paths overlap the target", async () => {
    const harness = createHarness();
    const overlappingRoot = join(harness.root, "addons", "ExampleMod", "managed-helper");
    const overlappingAddon = join(overlappingRoot, WORKBENCH_HELPER_ADDON_ID);
    const overlappingProfile = join(overlappingRoot, "profile");
    mkdirSync(overlappingAddon, { recursive: true });
    mkdirSync(overlappingProfile, { recursive: true });
    const spawnProcess = vi.fn();

    await expect(runEditor(harness, spawnProcess, {
      companionProvider: {
        ensureStaged: () => ({
          ...harness.companion,
          addonSearchRoot: overlappingRoot,
          addonDirectory: overlappingAddon,
          workbenchProfilePath: overlappingProfile,
        }),
      },
    })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("fails closed when the private token appears in more than one log directory", async () => {
    const harness = createHarness();
    const readiness = exitAfterReadinessProbe();
    await expect(runEditor(harness, (command, args) => {
      const { child, ownerArgument } = createOwnedRunnerChild(harness, command, args, {
        pid: 21_004,
      });
      addAttributedLog(harness.logRoot, "ambiguous-a", ownerArgument);
      addAttributedLog(harness.logRoot, "ambiguous-b", ownerArgument);
      readiness.onExit(() => closeRunnerChild(harness, child, 0));
      return child;
    }, { companionProbe: readiness.companionProbe }))
      .rejects.toMatchObject({ code: "LOG_ATTRIBUTION_FAILED" });
  });
});
