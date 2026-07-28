import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
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
import {
  runWorkbenchIntent,
  type WorkbenchBuildIntent,
  type WorkbenchEditorIntent,
  type WorkbenchRunnerDependencies,
} from "../../src/workbench/runner.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";
import {
  createFakeLifecycleBackend,
  type FakeLifecycleBackend,
} from "./fake-lifecycle-backend.js";

const roots: string[] = [];

export class FakeRunnerChild extends EventEmitter {
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

export type RunnerSpawnProcess = NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>;
export type RunnerChild = FakeRunnerChild & ChildProcess;

export interface OwnedRunnerChild {
  child: RunnerChild;
  ownerArgument: string;
}

export interface RunnerHarness {
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

export function createHarness(): RunnerHarness {
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

export function editorIntent(harness: RunnerHarness): WorkbenchEditorIntent {
  return {
    kind: "editor",
    gprojPath: harness.projectPath,
    foreground: true,
  };
}

export function buildIntent(
  harness: RunnerHarness,
  overrides: Partial<Omit<WorkbenchBuildIntent, "kind">> = {}
): WorkbenchBuildIntent {
  return {
    kind: "build",
    gprojPath: harness.projectPath,
    platform: "PC",
    outputPath: harness.outputPath,
    timeoutMs: 1_000,
    ...overrides,
  };
}

function successfulCompanionProbePayload(): Record<string, unknown> {
  return {
    status: "ok",
    helperAddonId: WORKBENCH_HELPER_ADDON_ID,
    helperAddonGuid: WORKBENCH_HELPER_ADDON_GUID,
    helperAddonVersion: WORKBENCH_HELPER_ADDON_VERSION,
    helperProtocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
    workbenchProtocol: WORKBENCH_HELPER_PROTOCOL_VERSION,
    helperBuildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
  };
}

export function writeResourceDatabase(
  outputPath: string,
  contents: string,
  addonId = "ExampleMod"
): void {
  const artifactRoot = join(outputPath, addonId);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(join(artifactRoot, "resourceDatabase.rdb"), contents);
}

export function addAttributedLog(logRoot: string, name: string, ownerArgument: string): string {
  const directory = join(logRoot, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "console.log"), `command line: ${ownerArgument}\n`);
  return directory;
}

export function createOwnedRunnerChild(
  harness: RunnerHarness,
  command: string,
  args: readonly string[],
  options: {
    pid: number;
    creationTime?: string;
    logName?: string;
    logRoot?: string;
  }
): OwnedRunnerChild {
  const child = new FakeRunnerChild(options.pid) as RunnerChild;
  const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="));
  if (!ownerArgument) throw new Error("owner argument missing");
  harness.backend.addWorkbench({
    pid: child.pid,
    executablePath: command,
    creationTime: options.creationTime ??
      `1339000000000${String(child.pid).padStart(5, "0")}`,
  }, ownerArgument);
  if (options.logName) {
    addAttributedLog(options.logRoot ?? harness.logRoot, options.logName, ownerArgument);
  }
  return { child, ownerArgument };
}

export function closeRunnerChild(
  harness: RunnerHarness,
  child: FakeRunnerChild,
  exitCode: number,
  signal: NodeJS.Signals | null = null
): void {
  harness.backend.processes.delete(child.pid);
  harness.backend.workbenchPids.delete(child.pid);
  child.close(exitCode, signal);
}

export function runnerDependencies(
  harness: RunnerHarness,
  spawnProcess: RunnerSpawnProcess,
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
    companionProbe: vi.fn(async () => successfulCompanionProbePayload()),
    logAttributionTimeoutMs: 50,
    logPollMs: 1,
    terminationTimeoutMs: 5,
    recoveryTimeoutMs: 50,
    ...overrides,
  };
}

export function runBuild(
  harness: RunnerHarness,
  spawnProcess: RunnerSpawnProcess,
  options: {
    intent?: Partial<Omit<WorkbenchBuildIntent, "kind">>;
    dependencies?: Partial<WorkbenchRunnerDependencies>;
  } = {}
) {
  return runWorkbenchIntent(
    harness.config,
    buildIntent(harness, options.intent),
    runnerDependencies(harness, spawnProcess, options.dependencies)
  );
}

export function runEditor(
  harness: RunnerHarness,
  spawnProcess: RunnerSpawnProcess,
  dependencyOverrides: Partial<WorkbenchRunnerDependencies> = {}
) {
  return runWorkbenchIntent(
    harness.config,
    editorIntent(harness),
    runnerDependencies(harness, spawnProcess, dependencyOverrides)
  );
}

export async function waitForLifecyclePhase(
  harness: RunnerHarness,
  phase: "starting" | "running" | "stopping" | "vacant"
) {
  for (;;) {
    const read = await harness.guard.readLifecycleState();
    if (read.kind === "valid" && read.state.phase === phase) return read;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
}

/**
 * Deterministic voluntary child exit for tests whose expected outcome depends
 * on Workbench surviving until readiness is proven. The exit is driven by the
 * readiness probe rather than a wall-clock timer, which would otherwise race
 * durable lifecycle publication and surface ENDPOINT_UNVERIFIABLE instead.
 */
export function exitAfterReadinessProbe(): {
  companionProbe: NonNullable<WorkbenchRunnerDependencies["companionProbe"]>;
  onExit: (exit: () => void) => void;
} {
  let exit: (() => void) | null = null;
  return {
    onExit: (next) => { exit = next; },
    companionProbe: vi.fn(async () => {
      setTimeout(() => exit?.(), 1);
      return successfulCompanionProbePayload();
    }),
  };
}

/**
 * Deterministic voluntary exit for a build child, which has no readiness probe
 * to key off. The exit fires once the spawn journal records durable
 * publication, so it can never race exact-ownership establishment the way a
 * wall-clock timer does under parallel-suite load.
 */
export function exitAfterDurablePublication(harness: RunnerHarness): (exit: () => void) => void {
  let pending: (() => void) | null = null;
  harness.backend.afterSpawnJournalReplace = ({ next }) => {
    if (next.record.phase !== "published" || !pending) return;
    const exit = pending;
    pending = null;
    setTimeout(exit, 0);
  };
  return (exit) => { pending = exit; };
}

export function createBuildSpawner(
  harness: RunnerHarness,
  options: {
    logRoot?: string;
    buildLogRoot?: string;
    buildExitCode?: number;
    onSpawn?: (index: number, args: readonly string[]) => void;
    onBuildBeforeExit?: (args: readonly string[]) => void;
    pidBase?: number;
  } = {}
): {
  spawnProcess: RunnerSpawnProcess;
  spawnCount: () => number;
} {
  let count = 0;
  const pidBase = options.pidBase ?? 22_000;
  const onBuildExit = exitAfterDurablePublication(harness);
  return {
    spawnProcess: (command, args) => {
      const index = count++;
      options.onSpawn?.(index, args);
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: pidBase + index,
        logName: `build-${pidBase + index}`,
        logRoot: options.buildLogRoot ?? options.logRoot,
      });
      if (index === 0) {
        onBuildExit(() => {
          options.onBuildBeforeExit?.(args);
          closeRunnerChild(harness, child, options.buildExitCode ?? 0);
        });
      }
      return child;
    },
    spawnCount: () => count,
  };
}

export async function cleanupRunnerHarnesses(): Promise<void> {
  vi.restoreAllMocks();
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
