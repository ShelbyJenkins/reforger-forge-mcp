import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  type WorkbenchCompanionLaunch,
  type WorkbenchCompanionProvider,
} from "../../src/workbench/helper-addon.js";
import { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";
import {
  parseWorkbenchRunnerArguments,
  runWorkbenchIntent,
  type WorkbenchRunnerDependencies,
} from "../../src/workbench/runner.js";
import { FakeLifecycleBackend } from "./fake-lifecycle-backend.js";

const roots: string[] = [];

class FakeRunnerChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(readonly pid: number) {
    super();
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }

  fail(message: string): void {
    this.emit("error", new Error(message));
  }
}

interface RunnerHarness {
  root: string;
  projectPath: string;
  executablePath: string;
  addonRoot: string;
  companion: WorkbenchCompanionLaunch;
  companionProvider: WorkbenchCompanionProvider;
  logRoot: string;
  outputPath: string;
  config: Config;
  backend: FakeLifecycleBackend;
  guard: WorkbenchProcessGuard;
}

function createHarness(): RunnerHarness {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-runner-"));
  roots.push(root);
  const projectDirectory = join(root, "addons", "ExampleMod");
  const projectPath = join(projectDirectory, "ExampleMod.gproj");
  const toolsRoot = join(root, "Arma Reforger Tools");
  const workbenchDirectory = join(toolsRoot, "Workbench");
  const executablePath = join(workbenchDirectory, "ArmaReforgerWorkbenchSteamDiag.exe");
  const addonRoot = join(root, "workshop", "ArmaReforger", "addons");
  const companionSearchRoot = join(root, "managed", "workbench-helper", "addons", "digest");
  const companionAddonDirectory = join(companionSearchRoot, WORKBENCH_HELPER_ADDON_ID);
  const companionProfile = join(root, "managed", "workbench-helper", "profile");
  const logRoot = join(root, "logs");
  const outputPath = join(root, "build", "PC");
  mkdirSync(projectDirectory, { recursive: true });
  mkdirSync(workbenchDirectory, { recursive: true });
  mkdirSync(addonRoot, { recursive: true });
  mkdirSync(companionAddonDirectory, { recursive: true });
  mkdirSync(companionProfile, { recursive: true });
  mkdirSync(logRoot, { recursive: true });
  writeFileSync(projectPath, "project");
  writeFileSync(executablePath, "fake Workbench");
  const config: Config = {
    workbenchPath: toolsRoot,
    projectPath: join(root, "addons"),
    gamePath: join(root, "Arma Reforger"),
    workbenchAddonDirs: [addonRoot, addonRoot],
    workbenchScriptAuthorizeAll: true,
    workbenchNoThrow: true,
    dataDir: join(root, "data"),
    patternsDir: join(root, "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
  const backend = new FakeLifecycleBackend();
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir: join(root, "state"),
    mutexName: `Global\\ReforgerForge.Runner.${root}`,
  });
  const companion: WorkbenchCompanionLaunch = {
    addonId: WORKBENCH_HELPER_ADDON_ID,
    addonGuid: WORKBENCH_HELPER_ADDON_GUID,
    addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
    protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
    buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
    bundleDigest: "a".repeat(64),
    addonDirectory: companionAddonDirectory,
    addonSearchRoot: companionSearchRoot,
    workbenchProfilePath: companionProfile,
    reused: false,
  };
  const companionProvider: WorkbenchCompanionProvider = {
    ensureStaged: vi.fn(() => companion),
  };
  return {
    root,
    projectPath,
    executablePath,
    addonRoot,
    companion,
    companionProvider,
    logRoot,
    outputPath,
    config,
    backend,
    guard,
  };
}

function addAttributedLog(logRoot: string, name: string, ownerArgument: string): string {
  const directory = join(logRoot, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "console.log"), `command line: ${ownerArgument}\n`);
  return directory;
}

function runnerDependencies(
  harness: RunnerHarness,
  spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>,
  overrides: Partial<WorkbenchRunnerDependencies> = {}
): WorkbenchRunnerDependencies {
  return {
    processGuard: harness.guard,
    companionProvider: harness.companionProvider,
    logRoot: harness.logRoot,
    spawnProcess,
    endpointProbeTimeoutMs: 20,
    endpointPollMs: 1,
    companionProbe: vi.fn(async () => ({
      status: "ok",
      helperAddonId: WORKBENCH_HELPER_ADDON_ID,
      helperAddonGuid: WORKBENCH_HELPER_ADDON_GUID,
      helperAddonVersion: WORKBENCH_HELPER_ADDON_VERSION,
      helperProtocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
      workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
      helperBuildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
    })),
    logAttributionTimeoutMs: 50,
    logPollMs: 1,
    terminationTimeoutMs: 5,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Workbench lifecycle runner", () => {
  it("runs a visible foreground editor under exact ownership and returns a bounded receipt", async () => {
    const harness = createHarness();
    let observedArgs: readonly string[] = [];
    let observedOptions: SpawnOptions | undefined;
    const dependencies = runnerDependencies(harness, (command, args, options) => {
      expect(command).toBe(harness.executablePath);
      observedArgs = args;
      observedOptions = options;
      const child = new FakeRunnerChild(21_001);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="));
      if (!ownerArgument) throw new Error("owner argument missing");
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021001",
      }, ownerArgument);
      setTimeout(() => {
        addAttributedLog(harness.logRoot, "editor-run", ownerArgument);
        harness.backend.processes.delete(child.pid);
        harness.backend.workbenchPids.delete(child.pid);
        child.close(0);
      }, 5);
      return child as unknown as ChildProcess;
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, dependencies);

    expect(observedOptions).toMatchObject({
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    });
    expect(observedArgs.filter((arg) => arg === "-addonsDir")).toHaveLength(1);
    const addonArgument = observedArgs[observedArgs.indexOf("-addonsDir") + 1];
    expect(addonArgument.split(",")).toEqual([
      harness.addonRoot,
      harness.companion.addonSearchRoot,
    ]);
    expect(observedArgs.slice(observedArgs.indexOf("-addons"), observedArgs.indexOf("-addons") + 4))
      .toEqual([
        "-addons",
        WORKBENCH_HELPER_ADDON_GUID,
        "-profile",
        harness.companion.workbenchProfilePath,
      ]);
    expect(observedArgs).toContain("-scriptAuthorizeAll");
    expect(observedArgs).toContain("-wbModule=WorldEditor");
    expect(observedArgs).toContain("-run");
    expect(receipt).toMatchObject({
      version: 2,
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

  it("holds the shared machine mutex until the foreground child exits", async () => {
    const harness = createHarness();
    let child!: FakeRunnerChild;
    let ownerArgument = "";
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolvePromise) => { spawned = resolvePromise; });
    const run = runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, runnerDependencies(harness, (command, args) => {
      child = new FakeRunnerChild(21_002);
      ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021002",
      }, ownerArgument);
      spawned();
      return child as unknown as ChildProcess;
    }));
    await didSpawn;

    const busyState = await harness.guard.readLifecycleState();
    expect(busyState.kind).toBe("valid");
    if (busyState.kind !== "valid") throw new Error("runner did not record lifecycle state");
    expect(["starting", "running"]).toContain(busyState.state.phase);
    expect(busyState.state.target?.path).toBe(harness.projectPath);
    expect(busyState.state.companion?.buildIdentity).toBe(WORKBENCH_HELPER_BUILD_IDENTITY);
    expect(busyState.state.mcpOwner).not.toBeNull();

    let contenderEntered = false;
    const contender = harness.guard.withLifecycleLock(async () => {
      contenderEntered = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(contenderEntered).toBe(false);

    addAttributedLog(harness.logRoot, "guarded-editor", ownerArgument);
    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.close(0);
    await run;
    await contender;
    expect(contenderEntered).toBe(true);
    expect(harness.backend.maxConcurrent).toBe(1);
  });

  it("terminates only the exact build child when its bounded timeout expires", async () => {
    const harness = createHarness();
    const dependencies = runnerDependencies(harness, (command, args, options) => {
      expect(options.windowsHide).toBe(true);
      const child = new FakeRunnerChild(21_003);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021003",
      }, ownerArgument);
      addAttributedLog(harness.logRoot, "timed-build", ownerArgument);
      return child as unknown as ChildProcess;
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 10,
    }, dependencies);

    expect(receipt.exitStatus).toMatchObject({
      reason: "timed_out",
      exitCode: null,
      signal: null,
      timedOut: true,
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.terminationCalls[0]).toMatchObject({
      pid: 21_003,
      executablePath: harness.executablePath,
      creationTime: "133900000000021003",
    });
  });

  it("keeps the mutex and guardian alive when exact timeout termination is refused", async () => {
    const harness = createHarness();
    harness.backend.terminationResult = {
      kind: "refused",
      reason: "creation_time_mismatch",
      message: "identity changed",
    };
    let child!: FakeRunnerChild;
    const run = runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 5,
    }, runnerDependencies(harness, (command, args) => {
      child = new FakeRunnerChild(21_005);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021005",
      }, ownerArgument);
      return child as unknown as ChildProcess;
    }));
    const rejection = expect(run).rejects.toMatchObject({ code: "TERMINATION_REFUSED" });
    while (harness.backend.terminationCalls.length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }

    let contenderEntered = false;
    const contender = harness.guard.withLifecycleLock(async () => {
      contenderEntered = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(contenderEntered).toBe(false);

    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.close(0);
    await rejection;
    await contender;
    expect(contenderEntered).toBe(true);
  });

  it("exact-terminates the child before reporting ambiguous endpoint ownership", async () => {
    const harness = createHarness();
    harness.backend.endpointOwnershipResult = {
      kind: "refused",
      reason: "listener_pid_mismatch",
      message: "another process owns the endpoint",
    };
    const dependencies = runnerDependencies(harness, (command, args) => {
      const child = new FakeRunnerChild(21_006);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021006",
      }, ownerArgument);
      return child as unknown as ChildProcess;
    });

    await expect(runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, dependencies)).rejects.toMatchObject({ code: "ENDPOINT_UNVERIFIABLE" });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
  });

  it("requires the exact companion Ping identity and binds no successful receipt to a mismatch", async () => {
    const harness = createHarness();
    const dependencies = runnerDependencies(harness, (command, args) => {
      const child = new FakeRunnerChild(21_007);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021007",
      }, ownerArgument);
      return child as unknown as ChildProcess;
    }, {
      companionProbe: vi.fn(async () => ({
        status: "ok",
        helperAddonId: WORKBENCH_HELPER_ADDON_ID,
        helperAddonGuid: WORKBENCH_HELPER_ADDON_GUID,
        helperAddonVersion: WORKBENCH_HELPER_ADDON_VERSION,
        helperProtocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
        workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
        helperBuildIdentity: "wrong-build",
      })),
    });

    await expect(runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, dependencies)).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
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
    let child!: FakeRunnerChild;
    let spawned!: () => void;
    const didSpawn = new Promise<void>((resolvePromise) => { spawned = resolvePromise; });
    const run = runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, runnerDependencies(harness, (command, args) => {
      child = new FakeRunnerChild(21_008);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021008",
      }, ownerArgument);
      spawned();
      return child as unknown as ChildProcess;
    }));
    await didSpawn;
    for (;;) {
      const state = await harness.guard.readLifecycleState();
      if (state.kind === "valid" && state.state.phase === "running") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    child.fail("simulated live-child error");
    while (harness.backend.terminationCalls.length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }

    let contenderEntered = false;
    const contender = harness.guard.withLifecycleLock(async () => {
      contenderEntered = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(contenderEntered).toBe(false);

    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.close(1);
    await expect(run).rejects.toMatchObject({ code: "TERMINATION_REFUSED" });
    await contender;
    expect(contenderEntered).toBe(true);
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("captures exact identity and terminates when a spawned child errors before readiness", async () => {
    const harness = createHarness();
    const dependencies = runnerDependencies(harness, (command, args) => {
      const child = new FakeRunnerChild(21_009);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021009",
      }, ownerArgument);
      queueMicrotask(() => child.fail("error before companion readiness"));
      return child as unknown as ChildProcess;
    });

    await expect(runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, dependencies)).rejects.toMatchObject({ code: "SPAWN_FAILED" });
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

    await expect(runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, runnerDependencies(harness, spawnProcess))).rejects.toMatchObject({
      code: "LIFECYCLE_CONFLICT",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects a custom companion provider whose managed paths overlap the target", async () => {
    const harness = createHarness();
    const overlappingRoot = join(harness.root, "addons", "ExampleMod", "managed-helper");
    const overlappingAddon = join(overlappingRoot, WORKBENCH_HELPER_ADDON_ID);
    const overlappingProfile = join(overlappingRoot, "profile");
    mkdirSync(overlappingAddon, { recursive: true });
    mkdirSync(overlappingProfile, { recursive: true });
    const spawnProcess = vi.fn();

    await expect(runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, runnerDependencies(harness, spawnProcess, {
      companionProvider: {
        ensureStaged: () => ({
          ...harness.companion,
          addonSearchRoot: overlappingRoot,
          addonDirectory: overlappingAddon,
          workbenchProfilePath: overlappingProfile,
        }),
      },
    }))).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("fails closed when the private token appears in more than one log directory", async () => {
    const harness = createHarness();
    const dependencies = runnerDependencies(harness, (command, args) => {
      const child = new FakeRunnerChild(21_004);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021004",
      }, ownerArgument);
      setTimeout(() => {
        addAttributedLog(harness.logRoot, "ambiguous-a", ownerArgument);
        addAttributedLog(harness.logRoot, "ambiguous-b", ownerArgument);
        harness.backend.processes.delete(child.pid);
        harness.backend.workbenchPids.delete(child.pid);
        child.close(0);
      }, 5);
      return child as unknown as ChildProcess;
    });

    await expect(runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, dependencies)).rejects.toMatchObject({ code: "LOG_ATTRIBUTION_FAILED" });
  });
});

describe("standalone Workbench runner argument contract", () => {
  it("accepts only explicit foreground editor and bounded PC build intents", () => {
    expect(parseWorkbenchRunnerArguments([
      "editor", "--gproj", "Example.gproj", "--foreground",
    ])).toEqual({ kind: "editor", gprojPath: "Example.gproj", foreground: true });
    expect(parseWorkbenchRunnerArguments([
      "build", "--gproj", "Example.gproj", "--platform", "PC",
      "--output", "out", "--timeout-ms", "300000",
    ])).toEqual({
      kind: "build",
      gprojPath: "Example.gproj",
      platform: "PC",
      outputPath: "out",
      timeoutMs: 300_000,
    });
  });

  it("rejects detached, arbitrary-argument, unbounded, and non-PC modes", () => {
    expect(() => parseWorkbenchRunnerArguments([
      "editor", "--gproj", "Example.gproj",
    ])).toThrow(/foreground/i);
    expect(() => parseWorkbenchRunnerArguments([
      "editor", "--gproj", "Example.gproj", "--foreground", "--detached",
    ])).toThrow(/unsupported/i);
    expect(() => parseWorkbenchRunnerArguments([
      "build", "--gproj", "Example.gproj", "--platform", "PC", "--output", "out",
    ])).toThrow(/requires exactly/i);
    expect(() => parseWorkbenchRunnerArguments([
      "build", "--gproj", "Example.gproj", "--platform", "Linux",
      "--output", "out", "--timeout-ms", "1000",
    ])).toThrow(/must be PC/i);
  });
});
