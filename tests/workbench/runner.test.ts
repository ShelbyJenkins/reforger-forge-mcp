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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_ADDON_VERSION,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_PROTOCOL_VERSION,
  type WorkbenchCompanionLaunch,
  type WorkbenchCompanionProvider,
} from "../../src/workbench/helper-addon.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";
import {
  parseWorkbenchRunnerArguments,
  runWorkbenchIntent,
  type WorkbenchRunnerDependencies,
} from "../../src/workbench/runner.js";
import {
  createFakeLifecycleBackend,
  type FakeLifecycleBackend,
} from "./fake-lifecycle-backend.js";

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
    this.emit("exit", code, signal);
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
  writeFileSync(projectPath, [
    "GameProject {",
    " ID ExampleMod",
    ' GUID "1122334455667788"',
    "}",
    "",
  ].join("\n"));
  writeFileSync(executablePath, "fake Workbench");
  const config: Config = {
    workbenchPath: toolsRoot,
    projectPath: join(root, "addons"),
    gamePath: join(root, "Arma Reforger"),
    workbenchAddonDirs: [addonRoot, addonRoot],
    workbenchScriptAuthorizeAll: true,
    dataDir: join(root, "data"),
    patternsDir: join(root, "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
  const backend = createFakeLifecycleBackend();
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir: join(root, "state"),
    mutexName: `Global\\ReforgerForge.Runner.${root}`,
    beforeLifecycleReplace: (args) => backend.replaceFailure?.(args) ?? undefined,
    afterLifecycleReplace: (args) => backend.afterReplace?.(args),
    beforeSpawnJournalReplace: (args) => backend.spawnJournalReplaceFailure?.(args) ?? undefined,
    afterSpawnJournalReplace: (args) => backend.afterSpawnJournalReplace?.(args),
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
    verifyStaged: vi.fn((candidate) => candidate),
    verifySourceDigest: vi.fn((expected) => expected),
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
    managedRoot: join(harness.root, "managed"),
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
    recoveryTimeoutMs: 50,
    ...overrides,
  };
}

/**
 * Deterministic voluntary child exit for tests whose expected outcome depends
 * on Workbench surviving until readiness is proven. The exit is driven by the
 * readiness probe rather than a wall-clock timer, which would otherwise race
 * durable lifecycle publication and surface ENDPOINT_UNVERIFIABLE instead.
 */
function exitAfterReadinessProbe(): {
  companionProbe: NonNullable<WorkbenchRunnerDependencies["companionProbe"]>;
  onExit: (exit: () => void) => void;
} {
  let exit: (() => void) | null = null;
  return {
    onExit: (next) => { exit = next; },
    companionProbe: vi.fn(async () => {
      setTimeout(() => exit?.(), 1);
      return {
        status: "ok",
        helperAddonId: WORKBENCH_HELPER_ADDON_ID,
        helperAddonGuid: WORKBENCH_HELPER_ADDON_GUID,
        helperAddonVersion: WORKBENCH_HELPER_ADDON_VERSION,
        helperProtocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
        workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
        helperBuildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
      };
    }),
  };
}

/**
 * Deterministic voluntary exit for a build child, which has no readiness probe
 * to key off. The exit fires once the spawn journal records durable
 * publication, so it can never race exact-ownership establishment the way a
 * wall-clock timer does under parallel-suite load.
 */
function exitAfterDurablePublication(harness: RunnerHarness): (exit: () => void) => void {
  let pending: (() => void) | null = null;
  harness.backend.afterSpawnJournalReplace = ({ next }) => {
    if (next.record.phase !== "published" || !pending) return;
    const exit = pending;
    pending = null;
    setTimeout(exit, 0);
  };
  return (exit) => { pending = exit; };
}

function createBuildSpawner(
  harness: RunnerHarness,
  options: {
    logRoot?: string;
    preflightLogRoot?: string;
    buildLogRoot?: string;
    buildExitCode?: number;
    onSpawn?: (index: number, args: readonly string[]) => void;
    onBuildBeforeExit?: (args: readonly string[]) => void;
    pidBase?: number;
  } = {}
): {
  spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>;
  spawnCount: () => number;
} {
  let count = 0;
  const pidBase = options.pidBase ?? 22_000;
  const onBuildExit = exitAfterDurablePublication(harness);
  return {
    spawnProcess: (command, args) => {
      const index = count++;
      options.onSpawn?.(index, args);
      const child = new FakeRunnerChild(pidBase + index);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="));
      if (!ownerArgument) throw new Error("owner argument missing");
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: `1339000000000${String(child.pid).padStart(5, "0")}`,
      }, ownerArgument);
      addAttributedLog(
        index === 0
          ? options.preflightLogRoot ?? options.logRoot ?? harness.logRoot
          : options.buildLogRoot ?? options.logRoot ?? harness.logRoot,
        index === 0 ? `preflight-${pidBase}` : `build-${pidBase}`,
        ownerArgument
      );
      if (index === 1) {
        onBuildExit(() => {
          options.onBuildBeforeExit?.(args);
          harness.backend.processes.delete(child.pid);
          harness.backend.workbenchPids.delete(child.pid);
          child.close(options.buildExitCode ?? 0);
        });
      }
      return child as unknown as ChildProcess;
    },
    spawnCount: () => count,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Workbench lifecycle runner", () => {
  it("runs a visible foreground editor under exact ownership and returns a bounded receipt", async () => {
    const harness = createHarness();
    const childSupervisor = new ChildSupervisor();
    let observedArgs: readonly string[] = [];
    let observedOptions: SpawnOptions | undefined;
    const readiness = exitAfterReadinessProbe();
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
      addAttributedLog(harness.logRoot, "editor-run", ownerArgument);
      readiness.onExit(() => {
        harness.backend.processes.delete(child.pid);
        harness.backend.workbenchPids.delete(child.pid);
        child.close(0);
      });
      return child as unknown as ChildProcess;
    }, { childSupervisor, companionProbe: readiness.companionProbe });

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

    let busyState = await harness.guard.readLifecycleState();
    while (busyState.kind !== "valid" || busyState.state.phase !== "running") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      busyState = await harness.guard.readLifecycleState();
    }
    expect(busyState.kind).toBe("valid");
    if (busyState.kind !== "valid") throw new Error("runner did not record lifecycle state");
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
    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.close(0);
    await run;
    expect(harness.backend.maxConcurrent).toBe(1);
  });

  it("releases the machine mutex during readiness after publishing exact starting ownership", async () => {
    const harness = createHarness();
    let child!: FakeRunnerChild;
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

    const run = runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, runnerDependencies(harness, (command, args) => {
      child = new FakeRunnerChild(21_102);
      ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021102",
      }, ownerArgument);
      return child as unknown as ChildProcess;
    }));

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
    for (;;) {
      const state = await harness.guard.readLifecycleState();
      if (state.kind === "valid" && state.state.phase === "running") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
    }
    addAttributedLog(harness.logRoot, "readiness-editor", ownerArgument);
    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.close(0);
    await expect(run).resolves.toMatchObject({ pid: child.pid, intent: "editor" });
  });

  it("refuses a stale post-lifetime commit after lifecycle generation changes", async () => {
    const harness = createHarness();
    let child!: FakeRunnerChild;
    const run = runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, runnerDependencies(harness, (command, args) => {
      child = new FakeRunnerChild(21_202);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021202",
      }, ownerArgument);
      return child as unknown as ChildProcess;
    }));

    const runningState = await (async () => {
      for (;;) {
        const read = await harness.guard.readLifecycleState();
        if (read.kind === "valid" && read.state.phase === "running") return read.state;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      }
    })();
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

    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.close(0);
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

  it("terminates only the exact build child when its bounded timeout expires", async () => {
    const harness = createHarness();
    const observedArguments: Array<readonly string[]> = [];
    let spawnIndex = 0;
    const dependencies = runnerDependencies(harness, (command, args, options) => {
      expect(options.windowsHide).toBe(true);
      observedArguments.push(args);
      const current = spawnIndex++;
      const child = new FakeRunnerChild(current === 0 ? 21_003 : 21_004);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: current === 0 ? "133900000000021003" : "133900000000021004",
      }, ownerArgument);
      addAttributedLog(harness.logRoot, current === 0 ? "build-preflight" : "timed-build", ownerArgument);
      return child as unknown as ChildProcess;
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, dependencies);

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

    await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess));

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
    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, (command, args) => {
      const current = spawnIndex++;
      if (current === 1) expect(harness.backend.workbenchPids.size).toBe(0);
      const child = new FakeRunnerChild(current === 0 ? 21_030 : 21_031);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: current === 0 ? "133900000000021030" : "133900000000021031",
      }, ownerArgument);
      addAttributedLog(
        harness.logRoot,
        current === 0 ? "successful-preflight" : "successful-build",
        ownerArgument
      );
      if (current === 1) {
        onBuildExit(() => {
          const artifactRoot = join(harness.outputPath, "ExampleMod");
          mkdirSync(artifactRoot, { recursive: true });
          writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "fresh database");
          writeFileSync(join(artifactRoot, "data.bin"), "fresh data");
          harness.backend.processes.delete(child.pid);
          harness.backend.workbenchPids.delete(child.pid);
          child.close(0);
        });
      }
      return child as unknown as ChildProcess;
    }, { childSupervisor }));

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
        const artifactRoot = join(harness.outputPath, "ExampleMod");
        mkdirSync(artifactRoot, { recursive: true });
        writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "fresh database");
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

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess));

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

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess))).rejects.toMatchObject({
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

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess))).rejects.toMatchObject({
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
        const artifactRoot = join(harness.outputPath, "ExampleMod");
        mkdirSync(artifactRoot, { recursive: true });
        writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "complete database");
      },
    });

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess))).rejects.toMatchObject({
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

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess))).rejects.toMatchObject({
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

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess))).rejects.toMatchObject({
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

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 100,
    }, runnerDependencies(harness, spawner.spawnProcess))).rejects.toMatchObject({
      code: "BUILD_DEADLINE_EXCEEDED",
    });

    expect(spawner.spawnCount()).toBe(0);
  });

  it("does not spawn preflight when the build is already aborted", async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();
    const spawnProcess = vi.fn();

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawnProcess, {
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: "BUILD_ABORTED" });

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("returns output null without an attestation failure for a nonzero target exit", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_300,
      buildExitCode: 7,
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess));

    expect(receipt).toMatchObject({
      version: 3,
      output: null,
      validationFailure: null,
      exitStatus: { reason: "exited", exitCode: 7, timedOut: false },
    });
  });

  it("refuses a nonempty output root before spawning either Workbench phase", async () => {
    const harness = createHarness();
    const artifactRoot = join(harness.outputPath, "ExampleMod");
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "stale database");
    const spawnProcess = vi.fn();

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawnProcess))).rejects.toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects build output that overlaps the target mod or managed companion roots", async () => {
    const targetHarness = createHarness();
    const targetOutput = join(targetHarness.root, "addons", "ExampleMod", "build-output");
    await expect(runWorkbenchIntent(targetHarness.config, {
      kind: "build",
      gprojPath: targetHarness.projectPath,
      platform: "PC",
      outputPath: targetOutput,
      timeoutMs: 1_000,
    }, runnerDependencies(targetHarness, vi.fn()))).rejects.toMatchObject({ code: "INVALID_INTENT" });

    const managedHarness = createHarness();
    const managedOutput = join(managedHarness.companion.workbenchProfilePath, "build-output");
    await expect(runWorkbenchIntent(managedHarness.config, {
      kind: "build",
      gprojPath: managedHarness.projectPath,
      platform: "PC",
      outputPath: managedOutput,
      timeoutMs: 1_000,
    }, runnerDependencies(managedHarness, vi.fn()))).rejects.toMatchObject({ code: "INVALID_INTENT" });
  });

  it("rejects a filesystem alias whose canonical output overlaps the target mod", async () => {
    const harness = createHarness();
    const outputAlias = join(harness.root, "aliased-build-output");
    symlinkSync(join(harness.root, "addons", "ExampleMod"), outputAlias, "junction");

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: outputAlias,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, vi.fn()))).rejects.toMatchObject({ code: "INVALID_INTENT" });
  });

  it("revalidates output after lifecycle reservation and before companion preflight spawn", async () => {
    const harness = createHarness();
    harness.backend.afterReplace = ({ next }) => {
      if (next.phase === "starting" && next.workbench === null) {
        writeFileSync(join(harness.outputPath, "raced-after-reservation.txt"), "occupied");
      }
    };
    const spawnProcess = vi.fn();

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawnProcess))).rejects.toMatchObject({
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
      if (vacancyIndex++ === 3) {
        writeFileSync(join(harness.outputPath, "raced-during-final-endpoint-check.txt"), "occupied");
      }
      return result;
    });
    const spawner = createBuildSpawner(harness, { pidBase: 22_045 });

    await expect(runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess))).rejects.toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });

    expect(spawner.spawnCount()).toBe(1);
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("reserves a shared empty output immediately after the mutex and blocks loser preflight", async () => {
    const harness = createHarness();
    let spawnCount = 0;
    let releaseBuild!: () => void;
    const buildRelease = new Promise<void>((resolve) => { releaseBuild = resolve; });
    let targetSpawned!: () => void;
    const targetDidSpawn = new Promise<void>((resolve) => { targetSpawned = resolve; });
    const spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]> =
      (command, args) => {
        const index = spawnCount++;
        const child = new FakeRunnerChild(23_000 + index);
        const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
        harness.backend.addWorkbench({
          pid: child.pid,
          executablePath: command,
          creationTime: `1339000000000${String(child.pid).padStart(5, "0")}`,
        }, ownerArgument);
        addAttributedLog(harness.logRoot, `reservation-${index}`, ownerArgument);
        if (index === 1) {
          targetSpawned();
          void buildRelease.then(() => {
            const artifactRoot = join(harness.outputPath, "ExampleMod");
            mkdirSync(artifactRoot, { recursive: true });
            writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "reserved output");
            harness.backend.processes.delete(child.pid);
            harness.backend.workbenchPids.delete(child.pid);
            child.close(0);
          });
        }
        return child as unknown as ChildProcess;
      };
    const intent = {
      kind: "build" as const,
      gprojPath: harness.projectPath,
      platform: "PC" as const,
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    };
    const first = runWorkbenchIntent(harness.config, intent, runnerDependencies(harness, spawnProcess));
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
    const second = runWorkbenchIntent(harness.config, intent, runnerDependencies(harness, spawnProcess));

    await expect(second).rejects.toMatchObject({ code: "LIFECYCLE_CONFLICT" });
    expect(spawnCount).toBe(2);
    releaseBuild();
    await expect(first).resolves.toMatchObject({ intent: "build", output: expect.any(Object) });
  });

  it("returns a diagnostic receipt when exit zero produces no resource database", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, { pidBase: 22_400 });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess));

    expect(receipt).toMatchObject({
      version: 3,
      logDirectory: join(harness.logRoot, "build-22400"),
      output: null,
      validationFailure: {
        code: "OUTPUT_ATTESTATION_FAILED",
        message: expect.stringMatching(/exactly one regular resourceDatabase\.rdb/i),
      },
      exitStatus: { reason: "exited", exitCode: 0 },
    });
  });

  it("rejects a fresh zero-byte resource database as unattested output", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_500,
      onBuildBeforeExit: () => {
        const artifactRoot = join(harness.outputPath, "ExampleMod");
        mkdirSync(artifactRoot, { recursive: true });
        writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "");
      },
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess));

    expect(receipt.intent === "build" && receipt.output).toBeNull();
    expect(receipt.intent === "build" && receipt.validationFailure).toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });
  });

  it("rejects exit-zero output containing more than one resource database", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_550,
      onBuildBeforeExit: () => {
        for (const name of ["A", "B"]) {
          const artifactRoot = join(harness.outputPath, name);
          mkdirSync(artifactRoot, { recursive: true });
          writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), `database ${name}`);
        }
      },
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess));

    expect(receipt.intent === "build" && receipt.output).toBeNull();
    expect(receipt.intent === "build" && receipt.validationFailure?.message)
      .toMatch(/exactly one regular resourceDatabase\.rdb; found 2/i);
  });

  it("rejects a post-build output symlink and redacts its private token from the receipt", async () => {
    const harness = createHarness();
    const externalRoot = join(harness.root, "external-output");
    mkdirSync(externalRoot, { recursive: true });
    let privateOwnerArgument = "";
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_600,
      onBuildBeforeExit: (args) => {
        privateOwnerArgument = args.find((arg) =>
          arg.startsWith("-reforgerForgeOwnerToken="))!;
        symlinkSync(
          externalRoot,
          join(harness.outputPath, `${privateOwnerArgument}-escape`),
          "junction"
        );
      },
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess));

    expect(receipt.intent === "build" && receipt.output).toBeNull();
    expect(receipt.intent === "build" && receipt.validationFailure).toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });
    expect(privateOwnerArgument).not.toBe("");
    expect(JSON.stringify(receipt)).not.toContain(privateOwnerArgument);
    expect(JSON.stringify(receipt)).toContain("[redacted]");
  });

  it("attributes preflight and target build under their dedicated managed log roots", async () => {
    const harness = createHarness();
    const preflightLogRoot = join(harness.companion.workbenchProfilePath, "logs");
    const buildLogRoot = join(
      harness.root,
      "managed",
      "workbench-build",
      "profile",
      "logs"
    );
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_700,
      preflightLogRoot,
      buildLogRoot,
      onBuildBeforeExit: () => {
        const artifactRoot = join(harness.outputPath, "ExampleMod");
        mkdirSync(artifactRoot, { recursive: true });
        writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "managed build");
      },
    });

    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, spawner.spawnProcess, { logRoot: undefined }));

    expect(receipt).toMatchObject({
      version: 3,
      preflight: { logDirectory: join(preflightLogRoot, "preflight-22700") },
      logDirectory: join(buildLogRoot, "build-22700"),
      validationFailure: null,
    });
    expect(receipt.intent === "build" && receipt.output).not.toBeNull();
  });

  it("accepts consecutive deterministic builds only when each uses a distinct empty output root", async () => {
    const harness = createHarness();
    const receipts = [];
    for (let index = 0; index < 2; index += 1) {
      const outputPath = join(harness.root, "build", `run-${index}`, "PC");
      const spawner = createBuildSpawner(harness, {
        pidBase: 22_800 + index * 10,
        onBuildBeforeExit: () => {
          const artifactRoot = join(outputPath, "ExampleMod");
          mkdirSync(artifactRoot, { recursive: true });
          writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "deterministic database");
        },
      });
      receipts.push(await runWorkbenchIntent(harness.config, {
        kind: "build",
        gprojPath: harness.projectPath,
        platform: "PC",
        outputPath,
        timeoutMs: 1_000,
      }, runnerDependencies(harness, spawner.spawnProcess)));
    }

    expect(receipts.map((receipt) => receipt.intent === "build"
      ? receipt.output?.resourceDatabaseSha256
      : null)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(receipts[0].intent === "build" && receipts[1].intent === "build" &&
      receipts[0].output?.resourceDatabaseSha256)
      .toBe(receipts[1].intent === "build" ? receipts[1].output?.resourceDatabaseSha256 : null);
  });

  it("distinguishes sequential children by creation time even when Windows reuses the PID", async () => {
    const harness = createHarness();
    let spawnIndex = 0;
    const reusedPid = 22_900;
    const onBuildExit = exitAfterDurablePublication(harness);
    const receipt = await runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, (command, args) => {
      const current = spawnIndex++;
      const child = new FakeRunnerChild(reusedPid);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: reusedPid,
        executablePath: command,
        creationTime: current === 0 ? "133900000000022900" : "133900000000022901",
      }, ownerArgument);
      addAttributedLog(harness.logRoot, current === 0 ? "reused-preflight" : "reused-build", ownerArgument);
      if (current === 1) {
        onBuildExit(() => {
          const artifactRoot = join(harness.outputPath, "ExampleMod");
          mkdirSync(artifactRoot, { recursive: true });
          writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), "reused pid database");
          harness.backend.processes.delete(reusedPid);
          harness.backend.workbenchPids.delete(reusedPid);
          child.close(0);
        });
      }
      return child as unknown as ChildProcess;
    }));

    expect(receipt).toMatchObject({
      pid: reusedPid,
      creationTime: "133900000000022901",
      preflight: { pid: reusedPid, creationTime: "133900000000022900" },
    });
  });

  it("releases the mutex during exact-child recovery while durable state stays stopping", async () => {
    const harness = createHarness();
    let targetChild!: FakeRunnerChild;
    let spawnIndex = 0;
    const run = runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, (command, args) => {
      const current = spawnIndex++;
      const child = new FakeRunnerChild(current === 0 ? 21_005 : 21_015);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: current === 0 ? "133900000000021005" : "133900000000021015",
      }, ownerArgument);
      addAttributedLog(
        harness.logRoot,
        current === 0 ? "refusal-preflight" : "refusal-build",
        ownerArgument
      );
      if (current === 1) {
        targetChild = child;
        harness.backend.terminationResult = {
          kind: "refused",
          reason: "creation_time_mismatch",
          message: "identity changed",
        };
      }
      return child as unknown as ChildProcess;
    }));
    const rejection = run.then(
      () => { throw new Error("expected exact termination refusal"); },
      (error: unknown) => error
    );
    while (harness.backend.terminationCalls.length < 2) {
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

    harness.backend.processes.delete(targetChild.pid);
    harness.backend.workbenchPids.delete(targetChild.pid);
    targetChild.close(0);
    expect(await rejection).toMatchObject({ code: "TERMINATION_REFUSED" });
  });

  it("returns RECOVERY_REQUIRED within the hard recovery bound and preserves stopping identity", async () => {
    const harness = createHarness();
    let spawnIndex = 0;
    let targetPid = 0;
    let recoveryStartedAt = 0;
    harness.backend.beforeTerminate = () => {
      if (targetPid !== 0 && recoveryStartedAt === 0) {
        recoveryStartedAt = Date.now();
      }
    };
    const run = runWorkbenchIntent(harness.config, {
      kind: "build",
      gprojPath: harness.projectPath,
      platform: "PC",
      outputPath: harness.outputPath,
      timeoutMs: 1_000,
    }, runnerDependencies(harness, (command, args) => {
      const current = spawnIndex++;
      const child = new FakeRunnerChild(current === 0 ? 21_105 : 21_115);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: current === 0 ? "133900000000021105" : "133900000000021115",
      }, ownerArgument);
      addAttributedLog(harness.logRoot, `bounded-recovery-${current}`, ownerArgument);
      if (current === 1) {
        targetPid = child.pid;
        harness.backend.terminationResult = {
          kind: "refused",
          reason: "access_denied",
          message: "fixture refuses exact termination",
        };
      }
      return child as unknown as ChildProcess;
    }, { recoveryTimeoutMs: 100 }));

    while (harness.backend.terminationCalls.length < 2) {
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
      return harness.guard.readLifecycleState();
    });
    const observedByContender = await contender;
    expect(contenderEntered).toBe(true);
    expect(observedByContender).toMatchObject({
      kind: "valid",
      state: { phase: "stopping", workbench: { pid: child.pid } },
    });

    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.close(1);
    await expect(run).rejects.toMatchObject({ code: "TERMINATION_REFUSED" });
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

  it("refuses an occupied endpoint before the foreground editor can spawn", async () => {
    const harness = createHarness();
    harness.backend.endpointVacancyResult = {
      kind: "occupied",
      listenerPid: 42_426,
      message: "foreign listener owns the endpoint",
    };
    const spawnProcess = vi.fn();

    await expect(runWorkbenchIntent(harness.config, {
      kind: "editor",
      gprojPath: harness.projectPath,
      foreground: true,
    }, runnerDependencies(harness, spawnProcess))).rejects.toMatchObject({
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
    const readiness = exitAfterReadinessProbe();
    const dependencies = runnerDependencies(harness, (command, args) => {
      const child = new FakeRunnerChild(21_004);
      const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="))!;
      harness.backend.addWorkbench({
        pid: child.pid,
        executablePath: command,
        creationTime: "133900000000021004",
      }, ownerArgument);
      addAttributedLog(harness.logRoot, "ambiguous-a", ownerArgument);
      addAttributedLog(harness.logRoot, "ambiguous-b", ownerArgument);
      readiness.onExit(() => {
        harness.backend.processes.delete(child.pid);
        harness.backend.workbenchPids.delete(child.pid);
        child.close(0);
      });
      return child as unknown as ChildProcess;
    }, { companionProbe: readiness.companionProbe });

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
      "build", "--gproj", "Example.gproj", "--platform", "Console",
      "--output", "out", "--timeout-ms", "1000",
    ])).toThrow(/must be PC/i);
  });
});
