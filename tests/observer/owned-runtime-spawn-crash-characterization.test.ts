import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObserverLaunchInput, ObserverPreparedLaunch } from "../../src/observer/launch.js";
import {
  OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX,
  OWNED_RUNTIME_RECORD_DIRECTORIES,
  OwnedRuntimeManager,
  type OwnedRuntimeExactIdentity,
  type OwnedRuntimeInspection,
  type OwnedRuntimeObserverGate,
  type OwnedRuntimeProcessBackend,
  type RuntimeStopPreflight,
} from "../../src/observer/owned-runtime-manager.js";
import { LmdbRecordStore } from "../../src/foundation/lmdb-record-store.js";

type OwnedSpawnCrashCut =
  | "before_spawn"
  | "after_spawn"
  | "after_exact_inspection"
  | "before_durable_publication"
  | "after_durable_publication";

const OWNED_CRASH_CUTS: ReadonlyArray<{
  cut: OwnedSpawnCrashCut;
  pendingState: "pre_spawn" | "spawned_unverified" | "identity_verified";
  processCreated: boolean;
  lifecycleRetained: boolean;
  runtimePublished: boolean;
  recovery: "preserve_manual" | "cleanup_only" | "resume_owned";
}> = [
  {
    cut: "before_spawn",
    pendingState: "pre_spawn",
    processCreated: false,
    lifecycleRetained: false,
    runtimePublished: false,
    recovery: "preserve_manual",
  },
  {
    cut: "after_spawn",
    pendingState: "spawned_unverified",
    processCreated: true,
    lifecycleRetained: false,
    runtimePublished: false,
    recovery: "preserve_manual",
  },
  {
    cut: "after_exact_inspection",
    pendingState: "spawned_unverified",
    processCreated: true,
    lifecycleRetained: false,
    runtimePublished: false,
    recovery: "preserve_manual",
  },
  {
    cut: "before_durable_publication",
    pendingState: "identity_verified",
    processCreated: true,
    lifecycleRetained: true,
    runtimePublished: false,
    recovery: "cleanup_only",
  },
  {
    cut: "after_durable_publication",
    pendingState: "identity_verified",
    processCreated: true,
    lifecycleRetained: true,
    runtimePublished: true,
    recovery: "resume_owned",
  },
];

interface FakeOwnedProcess {
  identity: OwnedRuntimeExactIdentity;
  ownerArgument: string;
}

class CrashBackend implements OwnedRuntimeProcessBackend {
  readonly platform = "test" as const;
  readonly processes = new Map<number, FakeOwnedProcess>();
  readonly terminationCalls: Array<OwnedRuntimeExactIdentity & {
    ownerTokenArgument: string;
    launchedAtMs: number;
  }> = [];

  async withMachineMutex<T>(args: { action: () => Promise<T> }): Promise<T> {
    return args.action();
  }

  async inspectCurrentProcess(pid: number) {
    return {
      pid,
      executablePath: process.execPath,
      creationTime: "900001",
      userSid: "S-1-5-21-f8-owner",
    };
  }

  async inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<OwnedRuntimeInspection | null> {
    const processRecord = this.processes.get(pid);
    if (!processRecord) return null;
    return {
      identity: { ...processRecord.identity },
      ownerArgumentMatched: expectedOwnerTokenArgument === undefined
        ? null
        : processRecord.ownerArgument === expectedOwnerTokenArgument,
    };
  }

  async verifyAndTerminate(expected: OwnedRuntimeExactIdentity & {
    ownerTokenArgument: string;
    launchedAtMs: number;
  }) {
    this.terminationCalls.push({ ...expected });
    const processRecord = this.processes.get(expected.pid);
    if (!processRecord) return { kind: "already_exited" as const };
    if (processRecord.identity.executablePath !== expected.executablePath) {
      return {
        kind: "refused" as const,
        reason: "executable_mismatch" as const,
        message: "fixture path mismatch",
      };
    }
    if (processRecord.identity.creationTime !== expected.creationTime) {
      return {
        kind: "refused" as const,
        reason: "creation_time_mismatch" as const,
        message: "fixture creation mismatch",
      };
    }
    if (processRecord.ownerArgument !== expected.ownerTokenArgument) {
      return {
        kind: "refused" as const,
        reason: "token_mismatch" as const,
        message: "fixture owner-token mismatch",
      };
    }
    this.processes.delete(expected.pid);
    return { kind: "terminated" as const };
  }
}

class CrashGate implements OwnedRuntimeObserverGate {
  readonly retained: Array<{ sessionId: string; runtimeId: string; generation: string }> = [];
  readonly released: Array<{ sessionId: string; runtimeId: string; generation: string }> = [];

  async retainRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string) {
    this.retained.push({ sessionId, runtimeId, generation });
    return { retained: true, generation };
  }

  async releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string) {
    this.released.push({ sessionId, runtimeId, generation });
    return { released: true, generation };
  }

  async reserveRuntimeStop(
    _sessionId: string,
    proposedReservationId: string
  ): Promise<RuntimeStopPreflight> {
    return {
      sessionKnown: true,
      ready: true,
      reserved: true,
      reservationId: proposedReservationId,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
    };
  }

  async releaseRuntimeStop() {
    return { released: true };
  }

  async completeRuntimeStop() {
    return { completed: true, revoked: true };
  }
}

class CrashChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly unref = vi.fn();

  constructor(
    readonly pid: number,
    private readonly onKill: () => void
  ) {
    super();
  }

  kill(): boolean {
    this.onKill();
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

interface OwnedCrashSnapshot {
  cut: OwnedSpawnCrashCut;
  managedRoot: string;
  executablePath: string;
  preparedLaunchId: string;
  idempotencyKey: string;
  runtimeId: string;
  pending: Record<string, unknown>;
  runtimePublished: boolean;
  lifecycleRetained: boolean;
  processes: FakeOwnedProcess[];
}

const roots: string[] = [];
const managersToClose: OwnedRuntimeManager[] = [];
const storesToClose: LmdbRecordStore[] = [];
const CLOCK_MS = Date.parse("2026-07-18T12:00:00.000Z");
const SNAPSHOT_MAX_RECORD_BYTES = 128 * 1024 * 1024;

function readStoreRecord(
  store: LmdbRecordStore,
  family: string,
  id: string,
): Record<string, unknown> {
  const raw = store.getRaw(family, id);
  if (raw === null) throw new Error(`Expected record ${family}/${id}`);
  return JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
}

async function captureOwnedCut(cut: OwnedSpawnCrashCut): Promise<OwnedCrashSnapshot> {
  const root = mkdtempSync(join(tmpdir(), `rfo-f8-owned-${cut}-`));
  const snapshotManagedRoot = mkdtempSync(join(tmpdir(), `rfo-f8-owned-snapshot-${cut}-`));
  roots.push(root, snapshotManagedRoot);
  const executablePath = join(root, "ArmaReforgerSteamDiag.exe");
  writeFileSync(executablePath, "owned runtime fixture\n");
  const backend = new CrashBackend();
  const gate = new CrashGate();
  let nextPid = 41_000;
  let nextId = 1;
  let manager!: OwnedRuntimeManager;
  let snapshot: OwnedCrashSnapshot | null = null;
  let preparedLaunchId = "";
  const idempotencyKey = `f8-${cut}`;

  const capture = (): void => {
    if (snapshot) throw new Error(`F8 owned-runtime cut ${cut} fired twice`);
    const store = manager.recordStoreForTest();
    const pendingIds = store.listIds("pending-starts");
    if (pendingIds.length !== 1) throw new Error("F8 snapshot expected one pending start");
    const pending = readStoreRecord(store, "pending-starts", pendingIds[0]);
    const runtimeId = String(pending.runtimeId);
    // Take a consistent logical copy of the durable records into an independent
    // record store at the snapshot managed root, reproducing a crash-time copy
    // of the storage tree. A physical file copy of the open LMDB environment is
    // neither consistent nor permitted while it is memory-mapped on Windows.
    const destStorageRoot = join(snapshotManagedRoot, "state", "owned-runtimes-v1");
    mkdirSync(destStorageRoot, { recursive: true });
    const dest = new LmdbRecordStore({
      storageRoot: destStorageRoot,
      maxRecordBytes: SNAPSHOT_MAX_RECORD_BYTES,
    });
    storesToClose.push(dest);
    for (const family of OWNED_RUNTIME_RECORD_DIRECTORIES) {
      for (const id of store.listIds(family)) {
        const raw = store.getRaw(family, id);
        if (raw) dest.putRaw(family, id, raw, { exclusive: false });
      }
    }
    snapshot = {
      cut,
      managedRoot: snapshotManagedRoot,
      executablePath,
      preparedLaunchId,
      idempotencyKey,
      runtimeId,
      pending,
      runtimePublished: store.listIds("runtimes").length === 1,
      lifecycleRetained: gate.retained.some((entry) => entry.runtimeId === runtimeId),
      processes: [...backend.processes.values()].map((entry) => ({
        identity: { ...entry.identity },
        ownerArgument: entry.ownerArgument,
      })),
    };
  };

  const spawnProcess = ((file: string, launchArguments: readonly string[]) => {
    if (cut === "before_spawn") {
      capture();
      throw new Error("F8 injected crash before owned-runtime spawn");
    }
    const pid = nextPid++;
    const ownerArgument = launchArguments.find((argument) =>
      argument.startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX)
    ) ?? "";
    const child = new CrashChild(pid, () => backend.processes.delete(pid));
    backend.processes.set(pid, {
      identity: {
        pid,
        executablePath: file,
        creationTime: String(800_000 + pid),
      },
      ownerArgument,
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  manager = new OwnedRuntimeManager({
    managedRoot: root,
    gamePath: root,
    observerGate: gate,
    backend,
    spawnProcess,
    executableResolver: () => executablePath,
    installationRoot: process.cwd(),
    clock: () => CLOCK_MS,
    ownerToken: () => "owner_".padEnd(64, "0"),
    randomId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    inspectionTimeoutMs: 200,
    terminationTimeoutMs: 200,
    lockTimeoutMs: 200,
  });
  managersToClose.push(manager);

  const managerInternals = manager as unknown as {
    awaitSpawn(child: ChildProcess): Promise<void>;
    updatePendingStart(
      root: string,
      pending: Record<string, unknown>,
      changes: Record<string, unknown>
    ): Record<string, unknown>;
    atomicWrite(
      root: string,
      target: string,
      record: unknown,
      exclusive: boolean,
      durable?: boolean
    ): void;
  };
  if (cut === "after_spawn") {
    const originalAwaitSpawn = managerInternals.awaitSpawn.bind(manager);
    managerInternals.awaitSpawn = async (child) => {
      await originalAwaitSpawn(child);
      capture();
      throw new Error("F8 injected crash after owned-runtime spawn");
    };
  }
  if (cut === "after_exact_inspection") {
    const originalUpdate = managerInternals.updatePendingStart.bind(manager);
    managerInternals.updatePendingStart = (storageRoot, pending, changes) => {
      if (changes.state === "identity_verified") {
        capture();
        throw new Error("F8 injected crash after owned-runtime exact inspection");
      }
      return originalUpdate(storageRoot, pending, changes);
    };
  }
  if (cut === "before_durable_publication" || cut === "after_durable_publication") {
    const originalAtomicWrite = managerInternals.atomicWrite.bind(manager);
    managerInternals.atomicWrite = (storageRoot, target, record, exclusive, durable) => {
      if (dirname(target) === join(manager.storageRoot, "runtimes")) {
        if (cut === "after_durable_publication") {
          originalAtomicWrite(storageRoot, target, record, exclusive, durable);
        }
        capture();
        throw new Error(`F8 injected crash ${cut.replaceAll("_", " ")}`);
      }
      originalAtomicWrite(storageRoot, target, record, exclusive, durable);
    };
  }

  const input: ObserverLaunchInput = {
    runtimeKind: "listenServer",
    arguments: ["-window", "-noSplash"],
    profilePath: join(root, "profiles", "f8"),
    sessionTtlMs: 60_000,
    transportPreference: ["rest", "mailbox"],
    forceUpdate: false,
    noFocus: false,
  };
  const prepared: ObserverPreparedLaunch = {
    arguments: [...input.arguments],
    sessionId: `session-${cut}`,
    expiresAt: new Date(CLOCK_MS + 60_000).toISOString(),
    bundleDigest: "a".repeat(64),
    profilePath: input.profilePath,
    warnings: [],
  };
  preparedLaunchId = await manager.recordPreparedLaunch(input, prepared);
  let startError: unknown;
  try {
    await manager.start({ preparedLaunchId, idempotencyKey });
  } catch (error) {
    startError = error;
  }
  if (!startError) throw new Error(`F8 owned-runtime cut ${cut} unexpectedly completed`);
  if (!snapshot) {
    throw new Error(
      `F8 owned-runtime cut ${cut} was not reached: ${startError instanceof Error
        ? startError.message
        : String(startError)}`
    );
  }
  return snapshot;
}

function createReplacement(snapshot: OwnedCrashSnapshot): {
  manager: OwnedRuntimeManager;
  backend: CrashBackend;
  gate: CrashGate;
} {
  const backend = new CrashBackend();
  for (const processRecord of snapshot.processes) {
    backend.processes.set(processRecord.identity.pid, {
      identity: { ...processRecord.identity },
      ownerArgument: processRecord.ownerArgument,
    });
  }
  const gate = new CrashGate();
  let id = 100;
  const manager = new OwnedRuntimeManager({
    managedRoot: snapshot.managedRoot,
    gamePath: dirname(snapshot.executablePath),
    observerGate: gate,
    backend,
    spawnProcess: vi.fn(() => {
      throw new Error("F8 recovery must not spawn a second runtime");
    }) as unknown as typeof import("node:child_process").spawn,
    executableResolver: () => snapshot.executablePath,
    installationRoot: process.cwd(),
    clock: () => CLOCK_MS,
    ownerToken: () => "replacement_".padEnd(64, "0"),
    randomId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
    inspectionTimeoutMs: 200,
    terminationTimeoutMs: 200,
    lockTimeoutMs: 200,
  });
  managersToClose.push(manager);
  return { backend, gate, manager };
}

function readSnapshotPending(
  replacement: { manager: OwnedRuntimeManager },
  snapshot: OwnedCrashSnapshot,
): Record<string, unknown> {
  return readStoreRecord(replacement.manager.recordStoreForTest(), "pending-starts", snapshot.runtimeId);
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Release every record-store environment before removing the roots: an open
  // LMDB memory map blocks rmSync on Windows.
  for (const store of storesToClose.splice(0)) await store.close().catch(() => undefined);
  for (const manager of managersToClose.splice(0)) await manager.closeStorageForTest().catch(() => undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("F8 owned-runtime spawn crash characterization", () => {
  it.each(OWNED_CRASH_CUTS)(
    "$cut durably exposes only its completed spawn-transaction phase",
    async ({ cut, pendingState, processCreated, lifecycleRetained, runtimePublished }) => {
      const snapshot = await captureOwnedCut(cut);
      expect(snapshot.pending).toMatchObject({
        state: pendingState,
        pid: processCreated ? expect.any(Number) : null,
      });
      expect(snapshot.processes.length > 0).toBe(processCreated);
      expect(snapshot.lifecycleRetained).toBe(lifecycleRetained);
      expect(snapshot.runtimePublished).toBe(runtimePublished);
      if (pendingState === "identity_verified") {
        expect(snapshot.pending).toMatchObject({
          creationTimeFileTime: expect.any(String),
          lifecycleGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } else {
        expect(snapshot.pending.lifecycleGeneration).toBeNull();
      }
    }
  );

  it.each(OWNED_CRASH_CUTS)(
    "$cut replacement performs $recovery recovery",
    async ({ cut, pendingState, recovery }) => {
      const snapshot = await captureOwnedCut(cut);
      const replacement = createReplacement(snapshot);
      const retry = replacement.manager.start({
        preparedLaunchId: snapshot.preparedLaunchId,
        idempotencyKey: snapshot.idempotencyKey,
      });

      if (recovery === "resume_owned") {
        await expect(retry).resolves.toMatchObject({
          runtimeId: snapshot.runtimeId,
          state: "running",
          exactOwned: true,
        });
        expect(replacement.backend.terminationCalls).toEqual([]);
        expect(replacement.backend.processes).toHaveLength(1);
        expect(replacement.gate.retained).toHaveLength(1);
        return;
      }

      await expect(retry).rejects.toMatchObject({ code: "START_UNVERIFIABLE" });
      expect(replacement.manager.recordStoreForTest().listIds("runtimes")).toEqual([]);
      if (recovery === "cleanup_only") {
        expect(replacement.backend.terminationCalls).toHaveLength(1);
        expect(replacement.backend.processes).toHaveLength(0);
        expect(replacement.gate.released).toHaveLength(1);
        expect(readSnapshotPending(replacement, snapshot)).toMatchObject({
          state: "release_acknowledged",
          lifecycleGeneration: snapshot.pending.lifecycleGeneration,
        });
      } else {
        expect(replacement.backend.terminationCalls).toEqual([]);
        expect(replacement.backend.processes).toHaveLength(snapshot.processes.length);
        expect(replacement.gate.released).toEqual([]);
        expect(readSnapshotPending(replacement, snapshot)).toMatchObject({ state: pendingState });
      }
    }
  );

  it("never terminates or adopts a merely similar process for verified-pending cleanup", async () => {
    const snapshot = await captureOwnedCut("before_durable_publication");
    const replacement = createReplacement(snapshot);
    const processRecord = replacement.backend.processes.values().next().value as FakeOwnedProcess;
    processRecord.ownerArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}similar_but_not_exact`;

    await expect(replacement.manager.start({
      preparedLaunchId: snapshot.preparedLaunchId,
      idempotencyKey: snapshot.idempotencyKey,
    })).rejects.toMatchObject({ code: "START_UNVERIFIABLE" });

    expect(replacement.backend.terminationCalls).toEqual([]);
    expect(replacement.backend.processes).toHaveLength(1);
    expect(replacement.gate.retained).toEqual([]);
  });
});
