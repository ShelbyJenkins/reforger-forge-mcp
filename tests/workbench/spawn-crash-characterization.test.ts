import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import type {
  ExactProcessIdentity,
  WorkbenchLifecycleStateV3,
  WorkbenchSpawnRecord,
} from "../../src/workbench/process-guard.js";
import {
  runWorkbenchIntent,
  type WorkbenchRunnerDependencies,
} from "../../src/workbench/runner.js";
import { encodeDurableKey, jsonDurableRecordCodec } from "../../src/foundation/durable-kv.js";
import { LmdbCasStore } from "../../src/foundation/lmdb-cas-store.js";
import {
  createFakeCompanionLaunch,
  fakeCompanionProvider,
  WORKBENCH_HELPER_PING_RESPONSE,
} from "./fake-companion.js";
import {
  createFakeLifecycleBackend,
  type FakeLifecycleBackend,
} from "./fake-lifecycle-backend.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";

type SpawnCrashCut =
  | "before_spawn"
  | "after_spawn"
  | "after_exact_inspection"
  | "before_durable_publication"
  | "after_durable_publication";

const CRASH_CUTS: ReadonlyArray<{
  cut: SpawnCrashCut;
  processCreated: boolean;
  journalPhase: WorkbenchSpawnRecord["phase"];
  exactIdentityDurable: boolean;
  clientRecovery: "retry_launch" | "preserve_manual" | "cleanup_then_retry";
}> = [
  {
    cut: "before_spawn",
    processCreated: false,
    journalPhase: "pre_spawn",
    exactIdentityDurable: false,
    clientRecovery: "retry_launch",
  },
  {
    cut: "after_spawn",
    processCreated: true,
    journalPhase: "pre_spawn",
    exactIdentityDurable: false,
    clientRecovery: "preserve_manual",
  },
  {
    cut: "after_exact_inspection",
    processCreated: true,
    journalPhase: "spawned_unverified",
    exactIdentityDurable: false,
    clientRecovery: "preserve_manual",
  },
  {
    cut: "before_durable_publication",
    processCreated: true,
    journalPhase: "identity_verified",
    exactIdentityDurable: true,
    clientRecovery: "cleanup_then_retry",
  },
  {
    cut: "after_durable_publication",
    processCreated: true,
    journalPhase: "identity_verified",
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
  journal: { version: 3; generation: string; record: WorkbenchSpawnRecord };
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
  };
  const backend = createFakeLifecycleBackend();
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir,
    mutexName: `Global\\ReforgerForge.F8.${label}.${root}`,
    beforeLifecycleReplace: (args) => backend.replaceFailure?.(args) ?? undefined,
    afterLifecycleReplace: (args) => backend.afterReplace?.(args),
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

async function readDurableState(harness: WorkbenchCrashHarness): Promise<WorkbenchLifecycleStateV3> {
  const state = await harness.guard.readLifecycleState();
  if (state.kind !== "valid") {
    throw new Error(`F8 fixture expected a valid durable lifecycle state, got ${state.kind}`);
  }
  return state.state;
}

async function readDurableJournal(
  harness: WorkbenchCrashHarness
): Promise<{ version: 3; generation: string; record: WorkbenchSpawnRecord }> {
  const journal = await harness.guard.readSpawnJournal();
  if (journal.kind !== "valid") {
    throw new Error(`F8 fixture expected a valid durable spawn journal, got ${journal.kind}`);
  }
  return { version: 3, generation: journal.generation, record: journal.record };
}

function installPhaseHooks(args: {
  harness: WorkbenchCrashHarness;
  cut: SpawnCrashCut;
  pid: number;
}): {
  spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]>;
  captured: () => Promise<CapturedWorkbenchCut>;
} {
  const { harness, cut, pid } = args;
  let reached = false;
  let capturedProcess: CapturedWorkbenchCut["process"] = null;
  let child: FakeCrashChild | null = null;
  let ownerArgument = "";
  const markReached = (): void => {
    reached = true;
    const processIdentity = child ? harness.backend.processes.get(child.pid) ?? null : null;
    capturedProcess = processIdentity ? { identity: { ...processIdentity }, ownerArgument } : null;
  };
  const originalInspect = harness.guard.inspectSpawnedWorkbench.bind(harness.guard);
  if (cut === "after_exact_inspection") {
    vi.spyOn(harness.guard, "inspectSpawnedWorkbench").mockImplementation(async (inspection) => {
      await originalInspect(inspection);
      markReached();
      throw new Error("F8 injected crash after exact inspection");
    });
  }
  if (cut === "before_durable_publication" || cut === "after_durable_publication") {
    let injected = false;
    if (cut === "before_durable_publication") {
      harness.backend.replaceFailure = ({ next }) => {
        if (!injected && next.phase === "starting" && next.workbench) {
          injected = true;
          markReached();
          return new Error(`F8 injected crash ${cut.replaceAll("_", " ")}`);
        }
        return null;
      };
    } else {
      harness.backend.afterReplace = ({ next }) => {
        if (!injected && next.phase === "starting" && next.workbench) {
          injected = true;
          markReached();
          throw new Error(`F8 injected crash ${cut.replaceAll("_", " ")}`);
        }
      };
    }
  }
  const spawnProcess: NonNullable<WorkbenchRunnerDependencies["spawnProcess"]> =
    (command, launchArguments) => {
      ownerArgument = launchArguments.find((argument) =>
        argument.startsWith("-reforgerForgeOwnerToken=")
      ) ?? "";
      if (!ownerArgument) throw new Error("F8 fixture launch omitted its owner argument");
      if (cut === "before_spawn") {
        markReached();
        throw new Error("F8 injected crash before spawn");
      }
      child = new FakeCrashChild(pid);
      harness.backend.addWorkbench({
        pid,
        executablePath: command,
        creationTime: String(133_900_000_000_000_000n + BigInt(pid)),
      }, ownerArgument);
      if (cut === "after_spawn") {
        markReached();
        throw new Error("F8 injected crash after spawn");
      }
      return child as unknown as ChildProcess;
    };
  return {
    spawnProcess,
    captured: async () => {
      if (!reached) throw new Error(`F8 cut ${cut} was not reached`);
      return {
        cut,
        state: await readDurableState(harness),
        journal: await readDurableJournal(harness),
        process: capturedProcess,
        harness,
      };
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
    managedRoot: join(harness.root, "managed-helper"),
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

/** Seed a fresh LMDB environment with captured state, mirroring what a restarted MCP process finds on disk. */
async function seedReplacementStore(stateDir: string, captured: CapturedWorkbenchCut): Promise<void> {
  const corruptArchiveDir = join(stateDir, "corrupt");
  const lifecycleSeed = new LmdbCasStore<WorkbenchLifecycleStateV3>({
    storageRoot: stateDir,
    key: encodeDurableKey("workbench", "lifecycle"),
    recordLabel: "lifecycle",
    schema: "workbench-lifecycle-v3",
    codec: jsonDurableRecordCodec((value) => value as WorkbenchLifecycleStateV3),
    generationOf: (value) => value.generation,
    corruptArchiveDir,
  });
  await lifecycleSeed.compareAndSwap(null, captured.state);
  await lifecycleSeed.close();

  const journalSeed = new LmdbCasStore<{ version: 3; generation: string; record: WorkbenchSpawnRecord }>({
    storageRoot: stateDir,
    key: encodeDurableKey("workbench", "spawn-journal"),
    recordLabel: "spawn-journal",
    schema: "workbench-spawn-journal-v3",
    codec: jsonDurableRecordCodec(
      (value) => value as { version: 3; generation: string; record: WorkbenchSpawnRecord }
    ),
    generationOf: (value) => value.generation,
    corruptArchiveDir,
  });
  await journalSeed.compareAndSwap(null, captured.journal);
  await journalSeed.close();
}

async function createReplacement(captured: CapturedWorkbenchCut, label: string): Promise<{
  backend: FakeLifecycleBackend;
  guard: WorkbenchProcessGuard;
  stateDir: string;
}> {
  const stateDir = join(captured.harness.root, `replacement-${label}`);
  mkdirSync(stateDir, { recursive: true });
  await seedReplacementStore(stateDir, captured);
  const backend = createFakeLifecycleBackend({
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
      beforeLifecycleReplace: (args) => backend.replaceFailure?.(args) ?? undefined,
      afterLifecycleReplace: (args) => backend.afterReplace?.(args),
    }),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("F8 Workbench spawn crash characterization", () => {
  it.each(CRASH_CUTS)(
    "client cut $cut leaves only the authority published before the crash",
    async ({ cut, processCreated, journalPhase, exactIdentityDurable }) => {
      const captured = await captureClientCut(cut);
      expect(captured.state).toMatchObject({
        phase: "starting",
        operation: { kind: "launch" },
      });
      expect(captured.process !== null).toBe(processCreated);
      expect(captured.journal.record.phase).toBe(journalPhase);
      expect(captured.journal.record.identity !== null).toBe(exactIdentityDurable);
      expect(captured.state.workbench !== null).toBe(cut === "after_durable_publication");
      if (exactIdentityDurable) {
        expect(captured.journal.record.identity).toMatchObject(captured.process!.identity);
      }
    }
  );

  it.each(CRASH_CUTS)(
    "runner cut $cut leaves only the authority published before the crash",
    async ({ cut, processCreated, journalPhase, exactIdentityDurable }) => {
      const captured = await captureRunnerCut(cut);
      expect(captured.state).toMatchObject({
        phase: "starting",
        operation: { kind: "launch" },
      });
      expect(captured.process !== null).toBe(processCreated);
      expect(captured.journal.record.phase).toBe(journalPhase);
      expect(captured.journal.record.identity !== null).toBe(exactIdentityDurable);
      expect(captured.state.workbench !== null).toBe(cut === "after_durable_publication");
      if (exactIdentityDurable) {
        expect(captured.journal.record.identity).toMatchObject(captured.process!.identity);
      }
    }
  );

  it.each(CRASH_CUTS)(
    "client replacement maps $cut to $clientRecovery without PID-only cleanup",
    async ({ cut, clientRecovery }) => {
      const captured = await captureClientCut(cut);
      const replacement = await createReplacement(captured, `client-${cut}`);
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
      const replacement = await createReplacement(captured, `runner-${cut}`);
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
