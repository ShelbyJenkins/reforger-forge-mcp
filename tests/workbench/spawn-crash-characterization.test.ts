import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import {
  WorkbenchProcessGuard,
  type ExactProcessIdentity,
  type WorkbenchLifecycleStateV3,
} from "../../src/workbench/process-guard.js";
import {
  runWorkbenchIntent,
  type WorkbenchRunnerDependencies,
} from "../../src/workbench/runner.js";
import {
  createFakeCompanionLaunch,
  fakeCompanionProvider,
  WORKBENCH_HELPER_PING_RESPONSE,
} from "./fake-companion.js";
import { FakeLifecycleBackend } from "./fake-lifecycle-backend.js";

type SpawnCrashCut =
  | "before_spawn"
  | "after_spawn"
  | "after_exact_inspection"
  | "before_durable_publication"
  | "after_durable_publication";

const CRASH_CUTS: ReadonlyArray<{
  cut: SpawnCrashCut;
  processCreated: boolean;
  exactIdentityDurable: boolean;
  clientRecovery: "retry_launch" | "preserve_manual" | "cleanup_then_retry";
}> = [
  {
    cut: "before_spawn",
    processCreated: false,
    exactIdentityDurable: false,
    clientRecovery: "retry_launch",
  },
  {
    cut: "after_spawn",
    processCreated: true,
    exactIdentityDurable: false,
    clientRecovery: "preserve_manual",
  },
  {
    cut: "after_exact_inspection",
    processCreated: true,
    exactIdentityDurable: false,
    clientRecovery: "preserve_manual",
  },
  {
    cut: "before_durable_publication",
    processCreated: true,
    exactIdentityDurable: false,
    clientRecovery: "preserve_manual",
  },
  {
    cut: "after_durable_publication",
    processCreated: true,
    exactIdentityDurable: true,
    clientRecovery: "cleanup_then_retry",
  },
];

const roots: string[] = [];

class FakeCrashChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => {
    throw new Error("PID-only ChildProcess.kill is forbidden for Workbench recovery");
  });

  constructor(readonly pid: number) {
    super();
  }

  unref(): void {}
}

interface WorkbenchCrashHarness {
  root: string;
  stateDir: string;
  projectPath: string;
  executablePath: string;
  logRoot: string;
  config: Config;
  backend: FakeLifecycleBackend;
  guard: WorkbenchProcessGuard;
  companion: ReturnType<typeof createFakeCompanionLaunch>;
}

interface CapturedWorkbenchCut {
  cut: SpawnCrashCut;
  state: WorkbenchLifecycleStateV3;
  process: {
    identity: ExactProcessIdentity;
    ownerArgument: string;
  } | null;
  harness: WorkbenchCrashHarness;
}

function createHarness(label: string): WorkbenchCrashHarness {
  const root = mkdtempSync(join(tmpdir(), `rfo-f8-${label}-`));
  roots.push(root);
  const projectRoot = join(root, "projects");
  const modDirectory = join(projectRoot, "ExampleMod");
  const projectPath = join(modDirectory, "ExampleMod.gproj");
  const toolsRoot = join(root, "Arma Reforger Tools");
  const executablePath = join(
    toolsRoot,
    "Workbench",
    "ArmaReforgerWorkbenchSteamDiag.exe"
  );
  const gamePath = join(root, "Arma Reforger");
  const stateDir = join(root, "state");
  const logRoot = join(root, "logs");
  mkdirSync(modDirectory, { recursive: true });
  mkdirSync(join(toolsRoot, "Workbench"), { recursive: true });
  mkdirSync(join(gamePath, "addons"), { recursive: true });
  mkdirSync(logRoot, { recursive: true });
  writeFileSync(projectPath, "project\n");
  writeFileSync(executablePath, "fake Workbench\n");
  const config: Config = {
    workbenchPath: toolsRoot,
    projectPath: projectRoot,
    gamePath,
    dataDir: join(root, "data"),
    patternsDir: join(root, "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    workbenchNoThrow: true,
  };
  const backend = new FakeLifecycleBackend();
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir,
    mutexName: `Global\\ReforgerForge.F8.${label}.${root}`,
  });
  return {
    root,
    stateDir,
    projectPath,
    executablePath,
    logRoot,
    config,
    backend,
    guard,
    companion: createFakeCompanionLaunch(root),
  };
}

function readDurableState(harness: WorkbenchCrashHarness): WorkbenchLifecycleStateV3 {
  return JSON.parse(readFileSync(harness.guard.statePath, "utf8")) as WorkbenchLifecycleStateV3;
}

function installPhaseHooks(args: {
  harness: WorkbenchCrashHarness;
  cut: SpawnCrashCut;
  pid: number;
}): {
  spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>;
  captured: () => CapturedWorkbenchCut;
} {
  const { harness, cut, pid } = args;
  let captured: CapturedWorkbenchCut | null = null;
  let child: FakeCrashChild | null = null;
  let ownerArgument = "";
  const capture = (): void => {
    const processIdentity = child ? harness.backend.processes.get(child.pid) ?? null : null;
    captured = {
      cut,
      state: readDurableState(harness),
      process: processIdentity
        ? { identity: { ...processIdentity }, ownerArgument }
        : null,
      harness,
    };
  };
  const originalInspect = harness.guard.inspectSpawnedWorkbench.bind(harness.guard);
  if (cut === "after_exact_inspection") {
    vi.spyOn(harness.guard, "inspectSpawnedWorkbench").mockImplementation(async (inspection) => {
      await originalInspect(inspection);
      capture();
      throw new Error("F8 injected crash after exact inspection");
    });
  }
  if (cut === "before_durable_publication" || cut === "after_durable_publication") {
    const originalReplace = harness.backend.replaceState.bind(harness.backend);
    let injected = false;
    harness.backend.replaceState = vi.fn(async (replacement) => {
      if (!injected && replacement.next.phase === "starting" && replacement.next.workbench) {
        injected = true;
        if (cut === "after_durable_publication") await originalReplace(replacement);
        capture();
        throw new Error(`F8 injected crash ${cut.replaceAll("_", " ")}`);
      }
      await originalReplace(replacement);
    });
  }
  const spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]> =
    (command, launchArguments) => {
      ownerArgument = launchArguments.find((argument) =>
        argument.startsWith("-reforgerForgeOwnerToken=")
      ) ?? "";
      if (!ownerArgument) throw new Error("F8 fixture launch omitted its owner argument");
      if (cut === "before_spawn") {
        capture();
        throw new Error("F8 injected crash before spawn");
      }
      child = new FakeCrashChild(pid);
      harness.backend.addWorkbench({
        pid,
        executablePath: command,
        creationTime: String(133_900_000_000_000_000n + BigInt(pid)),
      }, ownerArgument);
      if (cut === "after_spawn") {
        capture();
        throw new Error("F8 injected crash after spawn");
      }
      return child as unknown as ChildProcess;
    };
  return {
    spawnProcess,
    captured: () => {
      if (!captured) throw new Error(`F8 cut ${cut} was not reached`);
      return captured;
    },
  };
}

async function captureClientCut(cut: SpawnCrashCut): Promise<CapturedWorkbenchCut> {
  const harness = createHarness(`client-${cut}`);
  const hooks = installPhaseHooks({ harness, cut, pid: 31_000 + CRASH_CUTS.findIndex((row) => row.cut === cut) });
  const client = new WorkbenchClient(
    harness.config.workbenchHost,
    harness.config.workbenchPort,
    harness.config,
    "f8-client",
    harness.guard,
    {
      companionProvider: fakeCompanionProvider(harness.companion),
      spawnProcess: hooks.spawnProcess,
      launchTimeoutMs: 20,
      launchPollIntervalMs: 1,
    }
  );
  (client as unknown as {
    waitForCompanionReady: () => Promise<void>;
  }).waitForCompanionReady = vi.fn().mockResolvedValue(undefined);
  await expect(client.ensureRunning(harness.projectPath)).rejects.toBeDefined();
  return hooks.captured();
}

async function captureRunnerCut(cut: SpawnCrashCut): Promise<CapturedWorkbenchCut> {
  const harness = createHarness(`runner-${cut}`);
  const hooks = installPhaseHooks({ harness, cut, pid: 32_000 + CRASH_CUTS.findIndex((row) => row.cut === cut) });
  await expect(runWorkbenchIntent(harness.config, {
    kind: "editor",
    gprojPath: harness.projectPath,
    foreground: true,
  }, {
    processGuard: harness.guard,
    companionProvider: fakeCompanionProvider(harness.companion),
    spawnProcess: hooks.spawnProcess,
    logRoot: harness.logRoot,
    endpointProbeTimeoutMs: 10,
    endpointPollMs: 1,
    companionProbe: vi.fn(async () => WORKBENCH_HELPER_PING_RESPONSE),
    logAttributionTimeoutMs: 10,
    logPollMs: 1,
    terminationTimeoutMs: 5,
    recoveryTimeoutMs: 10,
  })).rejects.toBeDefined();
  return hooks.captured();
}

function createReplacement(captured: CapturedWorkbenchCut, label: string): {
  backend: FakeLifecycleBackend;
  guard: WorkbenchProcessGuard;
  stateDir: string;
} {
  const stateDir = join(captured.harness.root, `replacement-${label}`);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "lifecycle.json"), `${JSON.stringify(captured.state, null, 2)}\n`);
  const backend = new FakeLifecycleBackend({
    pid: 2_001,
    executablePath: process.execPath,
    creationTime: "133900000000002001",
    userSid: "S-1-5-21-test-user",
  });
  if (captured.process) {
    backend.addWorkbench(captured.process.identity, captured.process.ownerArgument);
  }
  return {
    backend,
    stateDir,
    guard: new WorkbenchProcessGuard({
      backend,
      stateDir,
      mutexName: `Global\\ReforgerForge.F8.Replacement.${label}.${captured.harness.root}`,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("F8 Workbench spawn crash characterization", () => {
  it.each(CRASH_CUTS)(
    "client cut $cut leaves only the authority published before the crash",
    async ({ cut, processCreated, exactIdentityDurable }) => {
      const captured = await captureClientCut(cut);
      expect(captured.state).toMatchObject({
        phase: "starting",
        operation: { kind: "launch" },
      });
      expect(captured.process !== null).toBe(processCreated);
      expect(captured.state.workbench !== null).toBe(exactIdentityDurable);
      if (exactIdentityDurable) {
        expect(captured.state.workbench).toMatchObject(captured.process!.identity);
      }
    }
  );

  it.each(CRASH_CUTS)(
    "runner cut $cut leaves only the authority published before the crash",
    async ({ cut, processCreated, exactIdentityDurable }) => {
      const captured = await captureRunnerCut(cut);
      expect(captured.state).toMatchObject({
        phase: "starting",
        operation: { kind: "launch" },
      });
      expect(captured.process !== null).toBe(processCreated);
      expect(captured.state.workbench !== null).toBe(exactIdentityDurable);
      if (exactIdentityDurable) {
        expect(captured.state.workbench).toMatchObject(captured.process!.identity);
      }
    }
  );

  it.each(CRASH_CUTS)(
    "client replacement maps $cut to $clientRecovery without PID-only cleanup",
    async ({ cut, clientRecovery }) => {
      const captured = await captureClientCut(cut);
      const replacement = createReplacement(captured, `client-${cut}`);
      const spawnProcess = vi.fn(() => {
        throw new Error("replacement launch intentionally stopped at spawn");
      });
      const client = new WorkbenchClient(
        captured.harness.config.workbenchHost,
        captured.harness.config.workbenchPort,
        captured.harness.config,
        "f8-replacement-client",
        replacement.guard,
        {
          companionProvider: fakeCompanionProvider(captured.harness.companion),
          spawnProcess,
          launchTimeoutMs: 20,
          launchPollIntervalMs: 1,
        }
      );
      vi.spyOn(client, "ping").mockResolvedValue(false);

      await expect(client.ensureRunning(captured.harness.projectPath)).rejects.toBeDefined();

      if (clientRecovery === "preserve_manual") {
        expect(spawnProcess).not.toHaveBeenCalled();
        expect(replacement.backend.terminationCalls).toEqual([]);
        expect(replacement.backend.workbenchPids).toHaveLength(1);
        expect(await replacement.guard.readLifecycleState()).toMatchObject({
          kind: "valid",
          state: { phase: "starting", workbench: null },
        });
      } else {
        expect(spawnProcess).toHaveBeenCalledTimes(1);
        if (clientRecovery === "cleanup_then_retry") {
          expect(replacement.backend.terminationCalls).toHaveLength(1);
          expect(replacement.backend.terminationCalls[0]).toMatchObject(captured.process!.identity);
        } else {
          expect(replacement.backend.terminationCalls).toEqual([]);
        }
        expect(replacement.backend.workbenchPids).toHaveLength(0);
      }
    }
  );

  it.each(CRASH_CUTS)(
    "standalone runner replacement preserves $cut for attended/MCP recovery",
    async ({ cut }) => {
      const captured = await captureRunnerCut(cut);
      const replacement = createReplacement(captured, `runner-${cut}`);
      const spawnProcess = vi.fn();
      await expect(runWorkbenchIntent(captured.harness.config, {
        kind: "editor",
        gprojPath: captured.harness.projectPath,
        foreground: true,
      }, {
        processGuard: replacement.guard,
        companionProvider: fakeCompanionProvider(captured.harness.companion),
        spawnProcess,
        logRoot: captured.harness.logRoot,
        endpointProbeTimeoutMs: 10,
        endpointPollMs: 1,
        companionProbe: vi.fn(async () => WORKBENCH_HELPER_PING_RESPONSE),
        logAttributionTimeoutMs: 10,
        logPollMs: 1,
        terminationTimeoutMs: 5,
        recoveryTimeoutMs: 10,
      })).rejects.toMatchObject({ code: "LIFECYCLE_CONFLICT" });
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(replacement.backend.terminationCalls).toEqual([]);
      if (captured.process) {
        expect(replacement.backend.workbenchPids).toHaveLength(1);
      }
    }
  );
});
