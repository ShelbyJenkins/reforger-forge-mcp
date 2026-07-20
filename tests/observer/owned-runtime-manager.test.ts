import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX,
  closeObserverRuntimeLifecycle,
  OwnedRuntimeManager,
  type OwnedRuntimeLifecycleAuthority,
  type OwnedRuntimeExactIdentity,
  type OwnedRuntimeInspection,
  type OwnedRuntimeObserverGate,
  type OwnedRuntimeProcessBackend,
  type RuntimeStopPreflight,
} from "../../src/observer/owned-runtime-manager.js";
import { LifecycleGuardError } from "../../src/workbench/process-guard.js";
import type { MachineMutexLeaseLoss } from "../../src/foundation/machine-mutex.js";
import {
  createFakeExactProcessBackend,
  type FakeExactProcessBackend,
  type FakeExactProcessRecord,
} from "../foundation/fake-exact-process-backend.js";
import type { ObserverLaunchInput, ObserverPreparedLaunch } from "../../src/observer/launch.js";
import { createObserverApplication } from "../../observer/agent/application.js";
import { runtimeStopObligations } from "../../observer/agent/private-child.js";
import { OBSERVER_BUILD_IDENTITY } from "../../observer/protocol/index.js";
import {
  FakeClock,
  graphicalRegistration,
  observerAddonSource,
  testBundleDigest,
} from "./helpers.js";

interface FakeProcess extends FakeExactProcessRecord {}

type FakeBackend = FakeExactProcessBackend<FakeProcess> & OwnedRuntimeProcessBackend & {
  readonly terminateCalls: FakeExactProcessBackend<FakeProcess>["terminationCalls"];
  currentCreation: string;
  currentUserSid: string;
  refuseTermination: boolean;
};

function createFakeBackend(): FakeBackend {
  const backend = createFakeExactProcessBackend<FakeProcess>() as FakeBackend;
  backend.terminateCalls = backend.terminationCalls;
  backend.currentCreation = "900001";
  backend.currentUserSid = "S-1-5-21-test-owner";
  backend.refuseTermination = false;
  backend.inspectCurrentProcess = async (pid) => ({
    pid,
    executablePath: process.execPath,
    creationTime: backend.currentCreation,
    userSid: backend.currentUserSid,
  });
  const verifyExactAndTerminate = backend.verifyAndTerminate.bind(backend);
  backend.verifyAndTerminate = async (expected, timeoutMs) => {
    const previous = backend.terminationResult;
    if (backend.refuseTermination) {
      backend.terminationResult = {
        kind: "refused",
        reason: "access_denied",
        message: "fixture refusal",
      };
    }
    try {
      return await verifyExactAndTerminate(expected, timeoutMs);
    } finally {
      backend.terminationResult = previous;
    }
  };
  return backend;
}

type QueuedBackend = FakeBackend & {
  readonly firstEntryBlocked: Promise<void>;
  allowFirstEntry(): void;
};

function createQueuedBackend(): QueuedBackend {
  const backend = createFakeBackend() as QueuedBackend;
  let mutexTail: Promise<void> = Promise.resolve();
  let entryCount = 0;
  let markFirstEntryBlocked!: () => void;
  let releaseFirstEntry!: () => void;
  backend.firstEntryBlocked = new Promise((resolve) => { markFirstEntryBlocked = resolve; });
  const firstEntryRelease = new Promise<void>((resolve) => { releaseFirstEntry = resolve; });
  backend.allowFirstEntry = () => releaseFirstEntry();
  backend.withMachineMutex = async (args) => {
    const prior = mutexTail;
    let releaseCurrent!: () => void;
    mutexTail = new Promise((resolve) => { releaseCurrent = resolve; });
    await prior;
    try {
      entryCount += 1;
      // Preparation now owns a short direct-index transaction. Block the
      // following start transaction, which is the race this fixture models.
      if (entryCount === 2) {
        markFirstEntryBlocked();
        await firstEntryRelease;
      }
      return await args.action();
    } finally {
      releaseCurrent();
    }
  };
  return backend;
}

function createSerialBackend(): FakeBackend {
  const backend = createFakeBackend();
  let mutexTail: Promise<void> = Promise.resolve();
  backend.withMachineMutex = async (args) => {
    const prior = mutexTail;
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    mutexTail = prior.then(() => current);
    await prior;
    try {
      return await args.action();
    } finally {
      releaseCurrent();
    }
  };
  return backend;
}

type HookedSerialBackend = FakeBackend & {
  entryCount: number;
  beforeAction: ((entry: number) => void) | null;
};

function createHookedSerialBackend(): HookedSerialBackend {
  const backend = createSerialBackend() as HookedSerialBackend;
  backend.entryCount = 0;
  backend.beforeAction = null;
  const withSerialMutex = backend.withMachineMutex.bind(backend);
  backend.withMachineMutex = (args) => withSerialMutex({
    ...args,
    action: async () => {
      backend.entryCount += 1;
      backend.beforeAction?.(backend.entryCount);
      return args.action();
    },
  });
  return backend;
}

type DeadlineBackend = FakeBackend & {
  hangNextMutexAfterAction: boolean;
  hangNextInspection: boolean;
  mutexEntries: number;
  inspectionCalls: number;
};

function createDeadlineBackend(): DeadlineBackend {
  const backend = createFakeBackend() as DeadlineBackend;
  backend.hangNextMutexAfterAction = false;
  backend.hangNextInspection = false;
  backend.mutexEntries = 0;
  backend.inspectionCalls = 0;
  backend.withMachineMutex = async (args) => {
    backend.mutexEntries += 1;
    const result = await args.action();
    if (backend.hangNextMutexAfterAction) {
      backend.hangNextMutexAfterAction = false;
      await new Promise<void>(() => undefined);
    }
    return result;
  };
  const inspectExactProcess = backend.inspectProcess.bind(backend);
  backend.inspectProcess = async (pid, expectedOwnerTokenArgument) => {
    backend.inspectionCalls += 1;
    if (backend.hangNextInspection) {
      backend.hangNextInspection = false;
      return new Promise<OwnedRuntimeInspection | null>(() => undefined);
    }
    return inspectExactProcess(pid, expectedOwnerTokenArgument);
  };
  return backend;
}

type LeaseLosingBackend = FakeBackend & {
  loseOnCurrentInspection: boolean;
  loseAfterTermination: boolean;
};

function createLeaseLosingBackend(): LeaseLosingBackend {
  const backend = createFakeBackend() as LeaseLosingBackend;
  backend.loseOnCurrentInspection = false;
  backend.loseAfterTermination = false;
  let activeLeaseLoss: ((error: MachineMutexLeaseLoss) => void) | null = null;
  backend.withMachineMutex = async (args) => {
    const prior = activeLeaseLoss;
    activeLeaseLoss = args.onLeaseLost ?? null;
    try {
      return await args.action();
    } finally {
      activeLeaseLoss = prior;
    }
  };
  const inspectCurrent = backend.inspectCurrentProcess.bind(backend);
  backend.inspectCurrentProcess = async (pid) => {
    const result = await inspectCurrent(pid);
    if (backend.loseOnCurrentInspection && activeLeaseLoss) {
      backend.loseOnCurrentInspection = false;
      activeLeaseLoss(new LifecycleGuardError(
        "fixture lifecycle mutex holder exited",
        "RECOVERY_REQUIRED"
      ));
    }
    return result;
  };
  const verifyExactAndTerminate = backend.verifyAndTerminate.bind(backend);
  backend.verifyAndTerminate = async (expected, timeoutMs) => {
    const result = await verifyExactAndTerminate(expected, timeoutMs);
    if (backend.loseAfterTermination && activeLeaseLoss) {
      backend.loseAfterTermination = false;
      activeLeaseLoss(new LifecycleGuardError(
        "fixture lifecycle mutex holder exited during termination",
        "RECOVERY_REQUIRED"
      ));
    }
    return result;
  };
  return backend;
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  unref = vi.fn();

  constructor(readonly pid: number, private readonly refuseKill = false) {
    super();
  }

  kill(): boolean {
    if (this.refuseKill) return false;
    this.killed = true;
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

class FakeGate implements OwnedRuntimeObserverGate {
  readonly retainedLifecycles: Array<{ sessionId: string; runtimeId: string; generation: string }> = [];
  readonly releasedLifecycles: Array<{ sessionId: string; runtimeId: string; generation: string }> = [];
  readonly released: string[] = [];
  readonly releasedReservations: string[] = [];
  readonly completed: string[] = [];
  readonly completedReservations: Array<string | undefined> = [];
  readonly completedExactVacancies: boolean[] = [];
  preflights: RuntimeStopPreflight[] = [];
  completeFailures = 0;
  releaseLifecycleFailures = 0;
  releaseLifecycleAttempts = 0;

  async retainRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string,
    _authority: OwnedRuntimeLifecycleAuthority
  ): Promise<unknown> {
    const existing = this.retainedLifecycles.find((entry) => entry.runtimeId === runtimeId);
    if (!existing) this.retainedLifecycles.push({ sessionId, runtimeId, generation });
    return { retained: true, alreadyRetained: existing !== undefined, generation };
  }

  async releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string): Promise<unknown> {
    this.releaseLifecycleAttempts += 1;
    if (this.releaseLifecycleFailures > 0) {
      this.releaseLifecycleFailures -= 1;
      throw new Error("fixture lifecycle release unavailable");
    }
    const existing = this.releasedLifecycles.find((entry) =>
      entry.sessionId === sessionId && entry.runtimeId === runtimeId && entry.generation === generation
    );
    if (!existing) this.releasedLifecycles.push({ sessionId, runtimeId, generation });
    return {
      released: existing === undefined,
      alreadyReleased: existing !== undefined,
      generation,
    };
  }

  async reserveRuntimeStop(
    _sessionId: string,
    proposedReservationId: string
  ): Promise<RuntimeStopPreflight> {
    const result: RuntimeStopPreflight = this.preflights.shift() ?? {
      sessionKnown: true,
      ready: true,
      reserved: true,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
    };
    return result.reserved && !result.reservationId
      ? { ...result, reservationId: proposedReservationId }
      : result;
  }

  async releaseRuntimeStop(sessionId: string, reservationId: string): Promise<unknown> {
    this.released.push(sessionId);
    this.releasedReservations.push(reservationId);
    return { released: true };
  }

  async completeRuntimeStop(
    sessionId: string,
    reservationId?: string,
    exactRuntimeVacant = false,
    _lifecycle?: { runtimeId: string; generation: string }
  ): Promise<unknown> {
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      throw new Error("fixture completion failure");
    }
    this.completed.push(sessionId);
    this.completedReservations.push(reservationId);
    this.completedExactVacancies.push(exactRuntimeVacant);
    return { completed: true, revoked: true };
  }
}

class AgentBackedGate extends FakeGate {
  constructor(private readonly agent: ReturnType<typeof createObserverApplication>) {
    super();
  }

  override retainRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string,
    authority: OwnedRuntimeLifecycleAuthority
  ): Promise<unknown> {
    return Promise.resolve(this.agent.server.retainOwnedRuntimeLifecycle(
      sessionId,
      runtimeId,
      generation,
      authority
    ));
  }

  override releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string): Promise<unknown> {
    return Promise.resolve(this.agent.server.releaseOwnedRuntimeLifecycle(sessionId, runtimeId, generation));
  }

  override async reserveRuntimeStop(
    sessionId: string,
    proposedReservationId: string,
    exactRuntimeVacant = false,
    lifecycle?: { runtimeId: string; generation: string }
  ): Promise<RuntimeStopPreflight> {
    if (!lifecycle) throw new Error("fixture exact lifecycle is required");
    const existingReservationId = this.agent.server.ownedRuntimeStopReservation(
      sessionId,
      lifecycle.runtimeId,
      lifecycle.generation
    );
    if (existingReservationId) {
      const claim = this.agent.server.claimOwnedRuntimeStopReservation(
        sessionId,
        lifecycle.runtimeId,
        lifecycle.generation,
        proposedReservationId
      );
      return {
        sessionKnown: true,
        ready: true,
        reserved: claim.reserved,
        activeJobIds: [],
        cameraLeaseJobIds: [],
        restorationPendingJobIds: [],
        ...(claim.reservationId ? { reservationId: claim.reservationId } : {}),
      };
    }
    const known = this.agent.control.sessions.peek(sessionId) !== undefined;
    const obligations = runtimeStopObligations(
      this.agent.jobs.diagnostics(sessionId),
      this.agent.registry.diagnostics().filter((instance) => instance.sessionId === sessionId),
      this.agent.jobs.obligationJobIds()
    );
    const ready = known && (exactRuntimeVacant || Object.values(obligations).every((ids) => ids.length === 0));
    const claim = ready
      ? this.agent.server.claimOwnedRuntimeStopReservation(
        sessionId,
        lifecycle.runtimeId,
        lifecycle.generation,
        proposedReservationId
      )
      : null;
    return {
      sessionKnown: known,
      ready,
      reserved: claim?.reserved === true,
      ...obligations,
      ...(claim?.reservationId ? { reservationId: claim.reservationId } : {}),
    };
  }

  override async completeRuntimeStop(
    sessionId: string,
    _reservationId?: string,
    _exactRuntimeVacant = false,
    lifecycle?: { runtimeId: string; generation: string }
  ): Promise<unknown> {
    if (!lifecycle) throw new Error("fixture exact lifecycle is required");
    this.agent.server.assertOwnedRuntimeLifecycle(
      sessionId,
      lifecycle.runtimeId,
      lifecycle.generation
    );
    const revoked = this.agent.control.revokeSession(sessionId);
    const released = this.agent.server.releaseOwnedRuntimeLifecycle(
      sessionId,
      lifecycle.runtimeId,
      lifecycle.generation
    );
    return { completed: true, revoked, lifecycleReleased: released.released };
  }
}

interface Harness {
  root: string;
  executable: string;
  backend: FakeBackend;
  gate: FakeGate;
  manager: OwnedRuntimeManager;
  spawnCalls: Array<{ executable: string; arguments: string[]; options: Record<string, unknown>; child: FakeChild }>;
  setClock(value: number): void;
  setExecutable(value: string): void;
  prepare(argumentsArray?: string[], idempotencyKey?: string): Promise<{ id: string; prepared: ObserverPreparedLaunch }>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHarness(options: {
  spawnFailure?: boolean;
  refuseKill?: boolean;
  advanceClock?: boolean;
  backend?: FakeBackend;
  root?: string;
  receiptRetentionMs?: number;
  maxStoreRecords?: number;
  maxStoreBytes?: number;
  maxRecordBytes?: number;
  inspectionTimeoutMs?: number;
  terminationTimeoutMs?: number;
  lockTimeoutMs?: number;
  gate?: FakeGate;
  preparedSessionId?: string;
  preparedExpiresAt?: string;
  preparedProfilePath?: string;
} = {}): Harness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "rfo-owned-runtime-"));
  if (!options.root) roots.push(root);
  const executable = join(root, "ArmaReforgerSteamDiag.exe");
  if (!options.root) writeFileSync(executable, "fixture");
  const backend = options.backend ?? createFakeBackend();
  const gate = options.gate ?? new FakeGate();
  const spawnCalls: Harness["spawnCalls"] = [];
  let pid = 4100;
  let clock = Date.parse("2026-07-18T12:00:00.000Z");
  let selectedExecutable = executable;
  let id = 1;
  const randomId = (): string => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`;
  const spawnProcess = ((file: string, args: readonly string[], spawnOptions: Record<string, unknown>) => {
    const child = new FakeChild(pid++, options.refuseKill);
    spawnCalls.push({ executable: file, arguments: [...args], options: spawnOptions, child });
    if (options.spawnFailure) {
      queueMicrotask(() => child.emit("error", new Error("fixture spawn failed")));
    } else {
      const ownerArgument = args.find((argument) => argument.startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX)) ?? "";
      backend.processes.set(child.pid, {
        identity: { pid: child.pid, executablePath: file, creationTime: String(800000 + child.pid) },
        ownerArgument,
      });
      queueMicrotask(() => child.emit("spawn"));
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const manager = new OwnedRuntimeManager({
    managedRoot: root,
    gamePath: root,
    observerGate: gate,
    backend,
    spawnProcess,
    executableResolver: () => selectedExecutable,
    installationRoot: process.cwd(),
    clock: () => options.advanceClock ? (clock += 100) : clock,
    ownerToken: () => `owner_${String(id).padStart(58, "0")}`,
    randomId,
    inspectionTimeoutMs: options.inspectionTimeoutMs ?? 500,
    terminationTimeoutMs: options.terminationTimeoutMs ?? 500,
    lockTimeoutMs: options.lockTimeoutMs ?? 500,
    ...(options.receiptRetentionMs === undefined ? {} : { receiptRetentionMs: options.receiptRetentionMs }),
    ...(options.maxStoreRecords === undefined ? {} : { maxStoreRecords: options.maxStoreRecords }),
    ...(options.maxStoreBytes === undefined ? {} : { maxStoreBytes: options.maxStoreBytes }),
    ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
  });
  const prepare = async (argumentsArray = ["-window", "-noSplash"], idempotencyKey?: string) => {
    const input: ObserverLaunchInput = {
      runtimeKind: "listenServer",
      arguments: argumentsArray,
      profilePath: options.preparedProfilePath ?? join(root, "profiles", `profile-${id}`),
      sessionTtlMs: 60_000,
      transportPreference: ["rest", "mailbox"],
      forceUpdate: false,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const prepared: ObserverPreparedLaunch = {
      arguments: argumentsArray,
      sessionId: options.preparedSessionId ?? `session-${id}`,
      expiresAt: options.preparedExpiresAt ?? new Date(clock + 60_000).toISOString(),
      bundleDigest: "a".repeat(64),
      profilePath: input.profilePath,
      warnings: [],
    };
    const preparedLaunchId = await manager.recordPreparedLaunch(input, prepared);
    return { id: preparedLaunchId, prepared: { ...prepared, preparedLaunchId } };
  };
  return {
    root,
    executable,
    backend,
    gate,
    manager,
    spawnCalls,
    setClock: (value) => { clock = value; },
    setExecutable: (value) => { selectedExecutable = value; },
    prepare,
  };
}

describe("OwnedRuntimeManager", () => {
  it("persists the maximum normalized descriptor produced from 512 launch tokens", async () => {
    const value = makeHarness();
    const normalizedArguments = Array.from({ length: 519 }, (_, index) => `-fixture-${index}`);

    const prepared = await value.prepare(normalizedArguments);
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "max-normalized-arguments",
    });

    expect(started.state).toBe("running");
    expect(value.spawnCalls[0].arguments.slice(0, -1)).toEqual(normalizedArguments);
  });

  it("reopens a command-line-boundary payload without poisoning later preparation", async () => {
    const value = makeHarness();
    const windowsCommandLineMaxUtf16Units = 32_767;
    const prepared = await value.prepare(["x".repeat(windowsCommandLineMaxUtf16Units)]);
    const descriptorPath = join(value.manager.storageRoot, "prepared", `${prepared.id}.json`);
    expect(statSync(descriptorPath).size).toBeGreaterThan(windowsCommandLineMaxUtf16Units);
    await expect(value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "boundary-payload" }))
      .rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });
    const later = await value.prepare(["-later"]);
    expect(later.id).not.toBe(prepared.id);
  });

  it("round-trips the maximum-escape launch-boundary aggregate at every descriptor bound", async () => {
    const windowsCommandLineMaxUtf16Units = 32_767;
    const normalizedArgumentMaxCount = 519;
    const worstCaseEscapedUnit = "\u0001";
    const unitsPerArgument = Math.floor(
      windowsCommandLineMaxUtf16Units / normalizedArgumentMaxCount
    );
    const remainder = windowsCommandLineMaxUtf16Units % normalizedArgumentMaxCount;
    const argumentsArray = Array.from(
      { length: normalizedArgumentMaxCount },
      (_, index) => worstCaseEscapedUnit.repeat(unitsPerArgument + (index < remainder ? 1 : 0))
    );
    const value = makeHarness({
      preparedProfilePath: worstCaseEscapedUnit.repeat(32_768),
      preparedSessionId: worstCaseEscapedUnit.repeat(96),
    });

    const prepared = await value.prepare(argumentsArray, "maximum-escape-descriptor");
    const descriptorPath = join(value.manager.storageRoot, "prepared", `${prepared.id}.json`);
    expect(statSync(descriptorPath).size).toBeGreaterThan(390_000);

    // Reusing the exact session takes the indexed replay path, which reopens,
    // parses, and fingerprints the bounded descriptor before returning its id.
    const replay = await value.prepare(argumentsArray, "maximum-escape-descriptor");
    expect(replay.id).toBe(prepared.id);
  });

  it("applies the derived prepared-descriptor bound before publishing either record", async () => {
    const value = makeHarness();
    const windowsCommandLineMaxUtf16Units = 32_767;
    const jsonWorstCaseBoundaryToken = "\0".repeat(windowsCommandLineMaxUtf16Units);

    await expect(value.prepare(Array.from({ length: 3 }, () => jsonWorstCaseBoundaryToken)))
      .rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(readdirSync(join(value.manager.storageRoot, "prepared"))).toEqual([]);
    expect(readdirSync(join(value.manager.storageRoot, "prepared-index"))).toEqual([]);
    await expect(value.prepare(["-later"])).resolves.toBeDefined();
  });

  it("uses a direct session index and isolates an unrelated corrupt prepared descriptor", async () => {
    const value = makeHarness();
    const first = await value.prepare(["-indexed"]);
    writeFileSync(
      join(
        value.manager.storageRoot,
        "prepared",
        "pl-ffffffff-ffff-4fff-8fff-ffffffffffff.json"
      ),
      "{\n"
    );

    const replay = await value.manager.recordPreparedLaunch({
      runtimeKind: "listenServer",
      arguments: ["-indexed"],
      profilePath: first.prepared.profilePath,
      sessionTtlMs: 60_000,
      transportPreference: ["rest", "mailbox"],
      forceUpdate: false,
    }, {
      arguments: ["-indexed"],
      sessionId: first.prepared.sessionId,
      expiresAt: first.prepared.expiresAt,
      bundleDigest: first.prepared.bundleDigest,
      profilePath: first.prepared.profilePath,
      warnings: [],
    });
    const later = await value.prepare(["-later"]);

    expect(replay).toBe(first.id);
    expect(later.id).not.toBe(first.id);
    expect(readdirSync(join(value.manager.storageRoot, "prepared-index"))).toHaveLength(2);
  });

  it("enforces per-record, aggregate-byte, and record-count budgets with diagnostics", async () => {
    const perRecord = makeHarness({ maxRecordBytes: 1_024, maxStoreBytes: 4_096 });
    await expect(perRecord.prepare(["x".repeat(2_000)]))
      .rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(perRecord.manager.diagnosticStorageStats()).toMatchObject({ records: 0, maxRecordBytes: 1_024 });

    const aggregate = makeHarness({ maxRecordBytes: 4_096, maxStoreBytes: 4_096 });
    await expect(aggregate.prepare(["x".repeat(1_400)])).resolves.toBeDefined();
    await expect(aggregate.prepare(["y".repeat(1_400)]))
      .rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(aggregate.manager.diagnosticStorageStats().bytes).toBeLessThanOrEqual(4_096);

    const countBound = makeHarness({ maxStoreRecords: 8 });
    countBound.manager.diagnosticStorageStats();
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(countBound.manager.storageRoot, "prepared", `forensic-${index}.json`), "{}\n");
    }
    await expect(countBound.prepare()).rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(countBound.manager.diagnosticStorageStats()).toMatchObject({ records: 8, maxRecords: 8 });
  });

  it("reserves the complete recovery lifecycle before spawn at a tight record bound", async () => {
    const insufficient = makeHarness({ maxStoreRecords: 8 });
    const prepared = await insufficient.prepare();
    await expect(insufficient.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "tight-start",
    })).rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(insufficient.spawnCalls).toEqual([]);
    expect(readdirSync(join(insufficient.manager.storageRoot, "consumed"))).toEqual([]);
    expect(readdirSync(join(insufficient.manager.storageRoot, "pending-starts"))).toEqual([]);
    expect(readdirSync(join(insufficient.manager.storageRoot, "idempotency"))).toEqual([]);

    // This case exercises storage reservation, not deadline handling. Leave
    // enough wall-clock headroom for filesystem syncs when the full suite is
    // running in parallel on a loaded Windows host.
    const sufficient = makeHarness({ maxStoreRecords: 11, terminationTimeoutMs: 5_000 });
    const sufficientPrepared = await sufficient.prepare();
    const started = await sufficient.manager.start({
      preparedLaunchId: sufficientPrepared.id,
      idempotencyKey: "reserved-start",
    });
    // At the exact 6-record + 5-record recovery bound, best-effort receipt
    // replacements must not borrow the fsynced temporary-file slot. A crash
    // could otherwise consume mandatory recovery headroom for the retention
    // window.
    const tightStartAttempt = JSON.parse(readFileSync(join(
      sufficient.manager.storageRoot,
      "idempotency",
      `start-${createHash("sha256").update("reserved-start").digest("hex")}.json`
    ), "utf8"));
    expect(tightStartAttempt.state).toBe("starting");
    expect(sufficient.manager.diagnosticStorageStats()).toMatchObject({
      records: 6,
      reservedMutationRecords: 5,
    });
    await expect(sufficient.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "reserved-stop",
    })).resolves.toMatchObject({ terminationComplete: true, observerCleanupPending: false });
    const stats = sufficient.manager.diagnosticStorageStats();
    expect(stats.records).toBeLessThanOrEqual(11);
    expect(stats.reservedMutationRecords).toBe(0);
  });

  it("sweeps completed clusters while preserving live ownership obligations", async () => {
    const unused = makeHarness({ receiptRetentionMs: 1_000 });
    const unusedPrepared = await unused.prepare(["-unused"]);
    unused.setClock(Date.parse(unusedPrepared.prepared.expiresAt) + 1_001);
    await expect(unused.manager.sweep()).resolves.toMatchObject({
      removedPreparedLaunchIds: [unusedPrepared.id],
      removedRuntimeIds: [],
    });

    const completed = makeHarness({ receiptRetentionMs: 1_000 });
    const prepared = await completed.prepare();
    const started = await completed.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "retention-start",
    });
    const stopped = await completed.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "retention-stop",
    });
    completed.setClock(Date.parse(stopped.stoppedAt!) + 1_001);

    await expect(completed.manager.sweep()).resolves.toMatchObject({
      removedRuntimeIds: [started.runtimeId],
      removedPreparedLaunchIds: [prepared.id],
    });
    expect(completed.manager.diagnosticStorageStats()).toMatchObject({
      prepared: 0,
      activeOrRecoverableRuntimes: 0,
      completedRuntimes: 0,
    });

    const live = makeHarness({ receiptRetentionMs: 0 });
    const livePrepared = await live.prepare();
    const liveStarted = await live.manager.start({
      preparedLaunchId: livePrepared.id,
      idempotencyKey: "live-retention-start",
    });
    live.setClock(Date.parse(livePrepared.prepared.expiresAt) + 60_000);
    await live.manager.sweep();
    expect(existsSync(join(live.manager.storageRoot, "runtimes", `${liveStarted.runtimeId}.json`))).toBe(true);
    expect(live.manager.diagnosticStorageStats().activeOrRecoverableRuntimes).toBe(1);
  });

  it("keeps a live exact runtime stoppable past session TTL across manager reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-owned-runtime-agent-lease-"));
    roots.push(root);
    const executable = join(root, "ArmaReforgerSteamDiag.exe");
    writeFileSync(executable, "fixture");
    const clock = new FakeClock(Date.parse("2026-07-18T12:00:00.000Z"));
    const profileRoot = join(root, "agent-profiles");
    mkdirSync(profileRoot, { recursive: true });
    const agent = createObserverApplication({
      root: join(root, "agent-managed"),
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0 },
      registry: { staleAfterMs: 1_000, staleRetentionMs: 0 },
    });
    const profilePath = join(profileRoot, "runtime-profile");
    mkdirSync(profilePath, { recursive: true });
    const created = agent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
      profilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: agent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "listenServer",
      ttlMs: 1_000,
      transportPreference: ["rest", "mailbox"],
    });
    const registration = graphicalRegistration(created, {
      agentInstanceId: agent.control.agentInstanceId,
      runtimeKind: "listenServer",
    });
    agent.registry.register(registration, created.contract.sessionToken);
    const backend = createFakeBackend();
    const gate = new AgentBackedGate(agent);
    const value = makeHarness({
      root,
      backend,
      gate,
      preparedSessionId: created.record.sessionId,
      preparedExpiresAt: created.contract.expiresAt,
      preparedProfilePath: profilePath,
    });
    value.setExecutable(executable);
    const prepared = await value.prepare(["-window"]); // prepare idempotency remains optional
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "agent-lease-start",
    });
    expect(agent.server.storeDiagnostics()).toMatchObject({
      sessions: { lifecycleLeased: 1 },
      ownedRuntimeLifecyclePins: { records: 1 },
    });

    clock.advance(1_000 + 5 * 60_000 + 1);
    value.setClock(clock.now());
    const retained = agent.server.sweep(clock.now());
    expect(retained.sessions.expiredSessionIds).toEqual([]);
    expect(retained.sessions.removedSessionIds).toEqual([]);
    expect(retained.instances.removedInstanceKeys).toEqual([]);
    expect(agent.control.sessions.get(created.record.sessionId)).toBeDefined();
    expect(agent.control.revokeSession(created.record.sessionId)).toBe(true);
    expect(() => agent.control.sessions.get(created.record.sessionId))
      .toThrow(expect.objectContaining({ code: "SESSION_EXPIRED" }));

    const recovered = makeHarness({ root, backend, gate });
    recovered.setClock(clock.now());
    recovered.setExecutable(executable);
    await expect(recovered.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "stale",
      exactOwned: true,
    });
    await expect(recovered.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "agent-lease-stop",
    })).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
    expect(backend.processes.has(started.pid)).toBe(false);
    expect(agent.server.storeDiagnostics()).toMatchObject({
      ownedRuntimeLifecyclePins: { records: 0 },
    });

    const released = agent.server.sweep(clock.now());
    expect(released.sessions.removedSessionIds).toEqual([created.record.sessionId]);
    expect(released.instances.removedInstanceKeys).toHaveLength(1);

    const naturalProfilePath = join(profileRoot, "natural-exit-profile");
    mkdirSync(naturalProfilePath, { recursive: true });
    const naturalSession = agent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
      profilePath: naturalProfilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: agent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "listenServer",
      ttlMs: 1_000,
      transportPreference: ["rest"],
    });
    agent.registry.register(graphicalRegistration(naturalSession, {
      agentInstanceId: agent.control.agentInstanceId,
      runtimeKind: "listenServer",
      instanceId: "instance-natural-exit",
      instanceNonce: "instance_nonce_natural_exit_123456789",
    }), naturalSession.contract.sessionToken);
    const naturalInput: ObserverLaunchInput = {
      runtimeKind: "listenServer",
      arguments: ["-window"],
      profilePath: naturalProfilePath,
      sessionTtlMs: 1_000,
      transportPreference: ["rest"],
      forceUpdate: false,
    };
    const naturalPrepared: ObserverPreparedLaunch = {
      arguments: ["-window"],
      sessionId: naturalSession.record.sessionId,
      expiresAt: naturalSession.contract.expiresAt,
      bundleDigest: naturalSession.contract.bundleDigest,
      profilePath: naturalProfilePath,
      warnings: [],
    };
    value.setClock(clock.now());
    const naturalPreparedId = await value.manager.recordPreparedLaunch(naturalInput, naturalPrepared);
    const naturalRuntime = await value.manager.start({
      preparedLaunchId: naturalPreparedId,
      idempotencyKey: "agent-natural-exit-start",
    });
    clock.advance(1_001);
    value.setClock(clock.now());
    expect(agent.server.sweep(clock.now()).sessions.expiredSessionIds).toEqual([]);
    backend.processes.delete(naturalRuntime.pid);
    const naturalChild = value.spawnCalls.at(-1)!.child;
    naturalChild.exitCode = 0;
    naturalChild.emit("exit", 0, null);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const diagnostics = agent.server.storeDiagnostics() as {
        ownedRuntimeLifecyclePins: { records: number };
      };
      if (diagnostics.ownedRuntimeLifecyclePins.records === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(agent.server.storeDiagnostics()).toMatchObject({
      ownedRuntimeLifecyclePins: { records: 0 },
    });
    const naturalReleased = agent.server.sweep(clock.now());
    expect(naturalReleased.sessions.removedSessionIds).toEqual([naturalSession.record.sessionId]);
    expect(naturalReleased.instances.removedInstanceKeys).toHaveLength(1);
    await agent.server.close();
  });

  it("reconstructs an expired exact session and camera-restoration obligation after agent loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-owned-runtime-crash-recovery-"));
    roots.push(root);
    const executable = join(root, "ArmaReforgerSteamDiag.exe");
    writeFileSync(executable, "fixture");
    const clock = new FakeClock(Date.parse("2026-07-18T12:00:00.000Z"));
    const agentRoot = join(root, "agent-managed");
    const profileRoot = join(root, "agent-profiles");
    const profilePath = join(profileRoot, "runtime-profile");
    const stagedAddonPath = join(agentRoot, "addons", testBundleDigest, "ReforgerForgeObserver");
    mkdirSync(profilePath, { recursive: true });
    mkdirSync(stagedAddonPath, { recursive: true });
    const firstAgent = createObserverApplication({
      root: agentRoot,
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0 },
      registry: { staleAfterMs: 1_000, staleRetentionMs: 0 },
      jobs: { terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 },
    });
    const created = firstAgent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath,
      profilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: firstAgent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "listenServer",
      ttlMs: 1_000,
      transportPreference: ["rest", "mailbox"],
    });
    const registration = graphicalRegistration(created, {
      agentInstanceId: firstAgent.control.agentInstanceId,
      runtimeKind: "listenServer",
    });
    firstAgent.registry.register(registration, created.contract.sessionToken);
    const backend = createFakeBackend();
    const first = makeHarness({
      root,
      backend,
      gate: new AgentBackedGate(firstAgent),
      receiptRetentionMs: 0,
      preparedSessionId: created.record.sessionId,
      preparedExpiresAt: created.contract.expiresAt,
      preparedProfilePath: profilePath,
    });
    first.setExecutable(executable);
    const prepared = await first.prepare(["-window"]);
    const started = await first.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "crash-recovery-start",
    });

    const job = firstAgent.jobs.submit({
      sessionId: created.record.sessionId,
      instanceId: registration.instanceId,
      idempotencyKey: "crash-camera-job",
      deadlineAt: new Date(clock.now() + 900).toISOString(),
      view: { kind: "lookAt", position: [0, 1, 0], target: [1, 1, 0], fov: 60 },
    });
    const command = firstAgent.jobs.nextCommand(
      created.record.sessionId,
      registration.instanceId,
      registration.instanceNonce
    )!;
    const status = (
      sequence: number,
      state: string,
      cameraLease: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ) => ({
      protocolVersion: "1.0",
      sessionId: created.record.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      jobId: job.request.jobId,
      sequence,
      state,
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      timestamp: new Date(clock.now()).toISOString(),
      cameraLease,
      ...extra,
    });
    firstAgent.jobs.update(status(1, "accepted", {
      held: false,
      restorationConfirmed: false,
    }, { deliveryToken: command.deliveryToken }), created.contract.sessionToken);
    firstAgent.jobs.update(status(2, "acquiringCamera", {
      held: true,
      leaseId: "lease-crash",
      observerCameraId: 42,
    }), created.contract.sessionToken);
    firstAgent.jobs.update(status(3, "restoring", {
      held: false,
      restorationConfirmed: false,
    }), created.contract.sessionToken);

    // Simulate an unclean private-child loss by abandoning the first composed
    // agent without its close/seal path, then pass beyond both TTL and normal
    // zero-retention tombstones before constructing the replacement.
    clock.advance(2_000);
    first.setClock(clock.now());
    const replacementAgent = createObserverApplication({
      root: agentRoot,
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0 },
      registry: { staleAfterMs: 1_000, staleRetentionMs: 0 },
      jobs: { terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 },
    });
    const recovered = makeHarness({
      root,
      backend,
      gate: new AgentBackedGate(replacementAgent),
      receiptRetentionMs: 0,
    });
    recovered.setClock(clock.now());
    recovered.setExecutable(executable);

    await expect(recovered.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "stale",
      exactOwned: true,
    });
    expect(replacementAgent.server.storeDiagnostics()).toMatchObject({
      sessions: { records: 1, lifecycleLeased: 1 },
      jobs: { jobs: 1, restorationObligations: 1 },
      instances: { records: 1 },
      ownedRuntimeAuthorities: { records: 1, retained: 1 },
    });
    await expect(recovered.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "crash-recovery-stop",
    })).rejects.toMatchObject({
      code: "CAMERA_BUSY",
      details: { restorationPendingJobIds: [job.request.jobId] },
    });

    replacementAgent.jobs.update(status(4, "restoring", {
      held: false,
      restorationConfirmed: true,
    }), created.contract.sessionToken);
    replacementAgent.jobs.update(status(5, "failed", {
      held: false,
      restorationConfirmed: true,
    }, { errorCode: "CAMERA_BUSY" }), created.contract.sessionToken);
    await expect(recovered.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "crash-recovery-stop",
    })).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
    await recovered.manager.sweep(clock.now());
    replacementAgent.server.sweep(clock.now());
    expect(recovered.manager.diagnosticStorageStats()).toMatchObject({
      records: 0,
      activeOrRecoverableRuntimes: 0,
    });
    expect(replacementAgent.server.storeDiagnostics()).toMatchObject({
      sessions: { records: 0, lifecycleLeased: 0 },
      ownedRuntimeLifecyclePins: { records: 0 },
      ownedRuntimeAuthorities: { records: 0, retained: 0 },
    });
    await replacementAgent.server.close();
  });

  it("resumes partial terminal cleanup and preserves descriptors referenced by broken live links", async () => {
    const completed = makeHarness({ receiptRetentionMs: 0 });
    const prepared = await completed.prepare();
    const started = await completed.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "partial-cleanup-start",
    });
    await completed.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "partial-cleanup-stop",
    });
    rmSync(join(completed.manager.storageRoot, "runtimes", `${started.runtimeId}.json`));
    rmSync(join(completed.manager.storageRoot, "stops", `${started.runtimeId}.json`));
    await expect(completed.manager.sweep()).resolves.toMatchObject({
      removedRuntimeIds: [started.runtimeId],
      removedPreparedLaunchIds: [prepared.id],
    });
    expect(existsSync(join(
      completed.manager.storageRoot,
      "stop-completions",
      `${started.runtimeId}.json`
    ))).toBe(false);

    const live = makeHarness({ receiptRetentionMs: 0 });
    const livePrepared = await live.prepare();
    const liveStarted = await live.manager.start({
      preparedLaunchId: livePrepared.id,
      idempotencyKey: "broken-link-start",
    });
    rmSync(join(live.manager.storageRoot, "consumed", `${livePrepared.id}.json`));
    live.setClock(Date.parse(livePrepared.prepared.expiresAt) + 1);
    await live.manager.sweep();
    expect(existsSync(join(live.manager.storageRoot, "prepared", `${livePrepared.id}.json`))).toBe(true);
    expect(existsSync(join(live.manager.storageRoot, "runtimes", `${liveStarted.runtimeId}.json`))).toBe(true);
  });

  it("scopes a corrupt live forward receipt to its consumed preparation", async () => {
    const value = makeHarness({ receiptRetentionMs: 0 });
    const livePrepared = await value.prepare(["-live-corrupt"]);
    const live = await value.manager.start({
      preparedLaunchId: livePrepared.id,
      idempotencyKey: "corrupt-forward-live",
    });
    const unused = await value.prepare(["-unrelated-unused"]);

    rmSync(join(value.manager.storageRoot, "pending-starts", `${live.runtimeId}.json`));
    writeFileSync(join(value.manager.storageRoot, "runtimes", `${live.runtimeId}.json`), "{\n");
    value.setClock(Math.max(
      Date.parse(livePrepared.prepared.expiresAt),
      Date.parse(unused.prepared.expiresAt)
    ) + 1);

    await expect(value.manager.sweep()).resolves.toMatchObject({
      removedPreparedLaunchIds: [unused.id],
    });
    expect(existsSync(join(value.manager.storageRoot, "prepared", `${unused.id}.json`))).toBe(false);
    expect(existsSync(join(value.manager.storageRoot, "prepared", `${livePrepared.id}.json`))).toBe(true);
    expect(existsSync(join(value.manager.storageRoot, "consumed", `${livePrepared.id}.json`))).toBe(true);
    expect(existsSync(join(value.manager.storageRoot, "runtimes", `${live.runtimeId}.json`))).toBe(true);
  });

  it("keeps the terminal cleanup trigger when an idempotency unlink fails", async () => {
    const value = makeHarness({ receiptRetentionMs: 0 });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "retryable-unlink-start",
    });
    await value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "retryable-unlink-stop",
    });

    const manager = value.manager as unknown as {
      unlinkOwnedFile(target: string): void;
    };
    const unlinkOwnedFile = manager.unlinkOwnedFile.bind(value.manager);
    let failIdempotencyUnlink = true;
    manager.unlinkOwnedFile = (target) => {
      if (failIdempotencyUnlink && target.includes(`${join("", "idempotency")}`)) {
        throw Object.assign(new Error("fixture unlink failure"), { code: "EPERM" });
      }
      unlinkOwnedFile(target);
    };

    await expect(value.manager.sweep()).resolves.toMatchObject({ removedRuntimeIds: [] });
    const completionPath = join(
      value.manager.storageRoot,
      "stop-completions",
      `${started.runtimeId}.json`
    );
    expect(existsSync(completionPath)).toBe(true);

    failIdempotencyUnlink = false;
    await expect(value.manager.sweep()).resolves.toMatchObject({
      removedRuntimeIds: [started.runtimeId],
    });
    expect(existsSync(completionPath)).toBe(false);
  });

  it("spawns exact structured arguments visibly without a shell and publishes a complete restrictive receipt", async () => {
    const value = makeHarness();
    const argumentsArray = ["-window", "-screenWidth", "1280"];
    const prepared = await value.prepare(argumentsArray, "prepare-1");
    argumentsArray.push("-mutated-after-recording");

    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "start-1" });

    expect(started).toMatchObject({ state: "running", exactOwned: true, runtimeKind: "listenServer" });
    expect(value.spawnCalls).toHaveLength(1);
    const call = value.spawnCalls[0];
    expect(call.executable).toBe(value.executable);
    expect(call.arguments.slice(0, -1)).toEqual(["-window", "-screenWidth", "1280"]);
    expect(call.arguments.filter((argument) => argument.startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX))).toHaveLength(1);
    expect(call.options).toMatchObject({
      cwd: value.root,
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: false,
    });
    const receiptPath = join(value.manager.storageRoot, "runtimes", `${started.runtimeId}.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
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

  it("fences start before spawn and ownership publication when the mutex lease is lost", async () => {
    const backend = createLeaseLosingBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare([], "lease-loss-start-prepare");
    backend.loseOnCurrentInspection = true;

    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "lease-loss-start",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.spawnCalls).toHaveLength(0);
    expect(readdirSync(join(value.manager.storageRoot, "runtimes"))).toEqual([]);
  });

  it("removes naturally exited children and reconciles exact exit evidence durably", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "natural-exit-start",
    });
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

    const exitPath = join(value.manager.storageRoot, "child-exits", `${started.runtimeId}.json`);
    for (let attempt = 0; attempt < 50 && !existsSync(exitPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(JSON.parse(readFileSync(exitPath, "utf8"))).toMatchObject({
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
    const second = await value.prepare(["-window", "-server", "world"]);
    const started = await value.manager.start({ preparedLaunchId: first.id, idempotencyKey: "start-key" });
    const replay = await value.manager.start({ preparedLaunchId: first.id, idempotencyKey: "start-key" });
    expect(replay.runtimeId).toBe(started.runtimeId);
    expect(value.spawnCalls).toHaveLength(1);
    await expect(value.manager.start({ preparedLaunchId: first.id, idempotencyKey: "different-key" }))
      .rejects.toMatchObject({ code: "PREPARED_LAUNCH_CONSUMED" });
    await expect(value.manager.start({ preparedLaunchId: second.id, idempotencyKey: "start-key" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects preexisting owner arguments and publishes no successful receipt after spawn failure", async () => {
    const conflict = makeHarness();
    const launcherNeutral = await conflict.prepare([`${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}foreign`]);
    expect(launcherNeutral.prepared.arguments).toEqual([`${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}foreign`]);
    await expect(conflict.manager.start({ preparedLaunchId: launcherNeutral.id, idempotencyKey: "owner-conflict" }))
      .rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });

    const failed = makeHarness({ spawnFailure: true });
    const prepared = await failed.prepare();
    await expect(failed.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "failed-start" }))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(readdirSync(join(failed.manager.storageRoot, "runtimes"))).toEqual([]);
    expect(failed.spawnCalls[0].child.killed).toBe(true);
    const pending = JSON.parse(readFileSync(join(
      failed.manager.storageRoot,
      "pending-starts",
      readdirSync(join(failed.manager.storageRoot, "pending-starts"))[0]
    ), "utf8"));
    expect(pending).toMatchObject({ state: "release_acknowledged", preparedLaunchId: prepared.id });
  });

  it("releases the exact lifecycle pin when start fails after pin acquisition but before publication", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const manager = value.manager as unknown as {
      atomicWrite(root: string, target: string, record: unknown, exclusive: boolean, durable?: boolean): void;
    };
    const atomicWrite = manager.atomicWrite.bind(value.manager);
    manager.atomicWrite = (root, target, record, exclusive, durable) => {
      if (dirname(target) === join(value.manager.storageRoot, "runtimes") && target.endsWith(".json")) {
        throw new Error("fixture runtime publication failure");
      }
      atomicWrite(root, target, record, exclusive, durable);
    };

    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "post-pin-publication-failure",
    })).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(value.gate.retainedLifecycles).toHaveLength(1);
    expect(value.gate.releasedLifecycles).toEqual(value.gate.retainedLifecycles);
    expect(readdirSync(join(value.manager.storageRoot, "runtimes"))).toEqual([]);
  });

  it("retains an unpublished exact lifecycle until a same-key retry proves child vacancy", async () => {
    const value = makeHarness({ refuseKill: true });
    const prepared = await value.prepare();
    const manager = value.manager as unknown as {
      atomicWrite(root: string, target: string, record: unknown, exclusive: boolean, durable?: boolean): void;
    };
    const atomicWrite = manager.atomicWrite.bind(value.manager);
    manager.atomicWrite = (root, target, record, exclusive, durable) => {
      if (dirname(target) === join(value.manager.storageRoot, "runtimes") && target.endsWith(".json")) {
        throw new Error("fixture runtime publication failure");
      }
      atomicWrite(root, target, record, exclusive, durable);
    };

    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "uncertain-post-pin-publication",
    })).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    const pendingName = readdirSync(join(value.manager.storageRoot, "pending-starts"))[0];
    const pendingPath = join(value.manager.storageRoot, "pending-starts", pendingName);
    expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toMatchObject({
      state: "cleanup_required",
      lifecycleGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
      launchedAtMs: expect.any(Number),
      pid: value.spawnCalls[0].child.pid,
    });
    expect(value.gate.retainedLifecycles).toHaveLength(1);
    expect(value.gate.releasedLifecycles).toEqual([]);
    expect(value.backend.processes.has(value.spawnCalls[0].child.pid)).toBe(true);

    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "uncertain-post-pin-publication",
    })).rejects.toMatchObject({
      code: "START_UNVERIFIABLE",
      details: { state: "release_required", pid: value.spawnCalls[0].child.pid },
    });
    expect(value.backend.processes.has(value.spawnCalls[0].child.pid)).toBe(false);
    expect(value.gate.releasedLifecycles).toEqual(value.gate.retainedLifecycles);
    expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toMatchObject({ state: "release_acknowledged" });
  });

  it("keeps durable unpublished-exit cleanup retryable when lifecycle release IPC fails", async () => {
    const value = makeHarness({ refuseKill: true });
    const prepared = await value.prepare();
    const manager = value.manager as unknown as {
      atomicWrite(root: string, target: string, record: unknown, exclusive: boolean, durable?: boolean): void;
    };
    const atomicWrite = manager.atomicWrite.bind(value.manager);
    manager.atomicWrite = (root, target, record, exclusive, durable) => {
      if (dirname(target) === join(value.manager.storageRoot, "runtimes") && target.endsWith(".json")) {
        throw new Error("fixture runtime publication failure");
      }
      atomicWrite(root, target, record, exclusive, durable);
    };

    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "unpublished-natural-exit",
    })).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(value.gate.releasedLifecycles).toEqual([]);

    const child = value.spawnCalls[0].child;
    const pendingName = readdirSync(join(value.manager.storageRoot, "pending-starts"))[0];
    const pendingPath = join(value.manager.storageRoot, "pending-starts", pendingName);
    value.gate.releaseLifecycleFailures = 1;
    value.backend.processes.delete(child.pid);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (JSON.parse(readFileSync(pendingPath, "utf8")).state === "release_required" &&
          value.gate.releaseLifecycleAttempts === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(value.gate.releaseLifecycleAttempts).toBe(1);
    expect(value.gate.releasedLifecycles).toEqual([]);
    expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toMatchObject({
      state: "release_required",
      pid: child.pid,
    });
    await expect(value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "unpublished-natural-exit",
    })).rejects.toMatchObject({
      code: "START_UNVERIFIABLE",
      details: { state: "release_required", pid: child.pid },
    });
    expect(value.gate.releasedLifecycles).toEqual(value.gate.retainedLifecycles);
    expect(JSON.parse(readFileSync(pendingPath, "utf8"))).toMatchObject({
      state: "release_acknowledged",
    });
  });

  it("distinguishes running, stale, exited, identity mismatch, and unverifiable states", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "states" });
    expect((await value.manager.status(started.runtimeId)).state).toBe("running");

    value.setClock(Date.parse(prepared.prepared.expiresAt) + 1);
    expect((await value.manager.status(started.runtimeId)).state).toBe("stale");
    value.setClock(Date.parse(prepared.prepared.expiresAt) - 1);

    const process = value.backend.processes.get(started.pid)!;
    process.identity.creationTime = "999999";
    expect((await value.manager.status(started.runtimeId)).state).toBe("identity_mismatch");
    process.identity.creationTime = String(800000 + started.pid);
    process.ownerArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}changed`;
    expect((await value.manager.status(started.runtimeId)).state).toBe("identity_mismatch");
    process.ownerArgument = value.spawnCalls[0].arguments.at(-1)!;

    value.backend.inspectFailure = new Error("native inspection unavailable");
    expect((await value.manager.status(started.runtimeId)).state).toBe("unverifiable");
    value.backend.inspectFailure = null;
    value.backend.processes.delete(started.pid);
    expect((await value.manager.status(started.runtimeId)).state).toBe("exited");
    expect(existsSync(join(
      value.manager.storageRoot,
      "child-exits",
      `${started.runtimeId}.json`
    ))).toBe(true);
    expect(value.gate.releasedLifecycles.at(-1)).toMatchObject({ runtimeId: started.runtimeId });
  });

  it("fails closed on configured executable path drift", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "path-drift" });
    const replacement = join(value.root, "ArmaReforgerSteam.exe");
    writeFileSync(replacement, "replacement");
    value.setExecutable(replacement);
    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "identity_mismatch",
      exactOwned: false,
    });
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "path-drift-stop",
    })).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.terminateCalls).toHaveLength(0);
  });

  it("refuses while a camera lease is active, then stops only the exact process after restoration", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "camera-start" });
    value.backend.processes.set(9999, {
      identity: { pid: 9999, executablePath: value.executable, creationTime: "123456" },
      ownerArgument: `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}unrelated`,
    });
    value.gate.preflights.push({
      sessionKnown: true,
      ready: false,
      reserved: false,
      activeJobIds: ["job-camera"],
      cameraLeaseJobIds: ["job-camera"],
      restorationPendingJobIds: ["job-camera"],
    });
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "camera-stop",
    })).rejects.toMatchObject({ code: "CAMERA_BUSY" });
    expect(value.backend.processes.has(started.pid)).toBe(true);
    expect(value.backend.terminateCalls).toHaveLength(0);
    value.gate.preflights.push({
      sessionKnown: true,
      ready: false,
      reserved: false,
      activeJobIds: ["job-camera"],
      cameraLeaseJobIds: ["job-camera"],
      restorationPendingJobIds: ["job-camera"],
    });
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "camera-stop-other",
    })).rejects.toMatchObject({ code: "CAMERA_BUSY" });
    expect(readdirSync(join(value.manager.storageRoot, "idempotency"))
      .filter((name) => name.startsWith("stop-"))).toEqual([]);

    const stopped = await value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "camera-stop",
    });
    expect(stopped).toMatchObject({ state: "exited", termination: "terminated", identityVacant: true });
    expect(value.backend.terminateCalls).toHaveLength(1);
    expect(value.backend.terminateCalls[0]).toMatchObject({ pid: started.pid });
    expect(value.backend.processes.has(9999)).toBe(true);
    expect(value.gate.completed).toEqual([started.sessionId]);
    const replay = await value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "camera-stop",
    });
    expect(replay).toMatchObject({ identityVacant: true, termination: "terminated" });
    expect(value.backend.terminateCalls).toHaveLength(1);
  });

  it("does not publish vacancy after losing the mutex lease during exact termination", async () => {
    const backend = createLeaseLosingBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare([], "lease-loss-stop-prepare");
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "lease-loss-stop-start",
    });
    backend.loseAfterTermination = true;

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "lease-loss-stop",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(backend.terminateCalls).toHaveLength(1);
    expect(existsSync(join(value.manager.storageRoot, "stops", `${started.runtimeId}.json`))).toBe(false);
    await expect(value.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "stopping",
      terminationComplete: false,
    });

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "lease-loss-stop",
    })).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
  });

  it("waits for terminal restoration when requested", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "wait-start" });
    value.gate.preflights.push({
      sessionKnown: true,
      ready: false,
      reserved: false,
      activeJobIds: ["restoring"],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: ["restoring"],
    });
    const stopped = await value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 1_000,
      idempotencyKey: "wait-stop",
    });
    expect(stopped.identityVacant).toBe(true);
  });

  it("retains the exact observer lease after a pre-signal refusal and recovers with the same key", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "reservation-cas-start",
    });
    value.backend.refuseTermination = true;
    const release = vi.spyOn(value.gate, "releaseRuntimeStop").mockImplementation(
      async () => ({ released: true })
    );

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "reservation-cas-stop",
    })).rejects.toMatchObject({ code: "TERMINATION_REFUSED" });
    expect(release).not.toHaveBeenCalled();
    const proofPath = join(
      value.manager.storageRoot,
      "restoration-proofs",
      `${started.runtimeId}.json`
    );
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    expect(proof).toMatchObject({
      kind: "live_stop_reservation",
      stopIdempotencyHash: createHash("sha256").update("reservation-cas-stop").digest("hex"),
    });
    expect(value.backend.processes.has(started.pid)).toBe(true);

    value.backend.refuseTermination = false;
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "reservation-cas-stop",
    })).resolves.toMatchObject({ termination: "terminated", identityVacant: true });
    expect(value.gate.completedReservations.at(-1)).toBe(proof.reservationId);
  });

  it("adopts the same deterministic observer lease after ambiguous proof publication", async () => {
    const backend = createFakeBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "ambiguous-proof-start",
    });
    const proposals: string[] = [];
    let incumbent: string | null = null;
    value.gate.reserveRuntimeStop = vi.fn(async (_sessionId, proposedReservationId) => {
      proposals.push(proposedReservationId);
      incumbent ??= proposedReservationId;
      if (proposals.length === 1) backend.mutexFailures = 2;
      return {
        sessionKnown: true,
        ready: incumbent === proposedReservationId,
        reserved: incumbent === proposedReservationId,
        activeJobIds: [],
        cameraLeaseJobIds: [],
        restorationPendingJobIds: [],
        ...(incumbent === proposedReservationId ? { reservationId: proposedReservationId } : {}),
      };
    });

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "ambiguous-proof-stop",
    })).rejects.toMatchObject({ code: "STOP_FAILED" });
    expect(backend.processes.has(started.pid)).toBe(true);

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "ambiguous-proof-stop",
    })).resolves.toMatchObject({ termination: "terminated", identityVacant: true });
    expect(proposals).toHaveLength(2);
    expect(new Set(proposals).size).toBe(1);
    expect(value.gate.completedReservations.at(-1)).toBe(incumbent);
  });

  it("switches to exact-vacancy completion when the process exits during restoration wait", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "restoration-exit-start",
    });
    const vacancyArguments: boolean[] = [];
    value.gate.reserveRuntimeStop = vi.fn(async (_sessionId, proposedReservationId, exactRuntimeVacant = false) => {
      vacancyArguments.push(exactRuntimeVacant);
      if (!exactRuntimeVacant) {
        value.backend.processes.delete(started.pid);
        return {
          sessionKnown: true,
          ready: false,
          reserved: false,
          activeJobIds: ["job-restoring"],
          cameraLeaseJobIds: [],
          restorationPendingJobIds: ["job-restoring"],
        };
      }
      return {
        sessionKnown: true,
        ready: true,
        reserved: true,
        activeJobIds: [],
        cameraLeaseJobIds: [],
        restorationPendingJobIds: [],
        reservationId: proposedReservationId,
      };
    });

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 1_000,
      idempotencyKey: "restoration-exit-stop",
    })).resolves.toMatchObject({ termination: "already_exited", identityVacant: true });
    expect(vacancyArguments).toEqual([false, true]);
    expect(value.backend.terminateCalls).toEqual([]);
    expect(value.gate.completedExactVacancies).toEqual([true]);
  });

  it("does not hold the machine mutex while waiting for restoration readiness", async () => {
    const backend = createSerialBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "unlocked-wait-start",
    });
    let releasePreflight!: () => void;
    const preflightRelease = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let preflightCalled!: () => void;
    const didCallPreflight = new Promise<void>((resolve) => { preflightCalled = resolve; });
    value.gate.reserveRuntimeStop = vi.fn(async (_sessionId, proposedReservationId) => {
      preflightCalled();
      await preflightRelease;
      return {
        sessionKnown: true,
        ready: true,
        reserved: true,
        activeJobIds: [],
        cameraLeaseJobIds: [],
        restorationPendingJobIds: [],
        reservationId: proposedReservationId,
      };
    });

    const stopping = value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 1_000,
      idempotencyKey: "unlocked-wait-stop",
    });
    await didCallPreflight;
    let contenderEntered = false;
    await expect(Promise.race([
      backend.withMachineMutex({ action: async () => { contenderEntered = true; } })
        .then(() => "entered" as const),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ])).resolves.toBe("entered");
    expect(contenderEntered).toBe(true);

    releasePreflight();
    await expect(stopping).resolves.toMatchObject({ state: "exited", identityVacant: true });
  });

  it("does not hold the machine mutex while observer stop completion is pending", async () => {
    const backend = createSerialBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "unlocked-completion-start",
    });
    let acknowledgeCompletion!: () => void;
    const completionAcknowledgement = new Promise<void>((resolve) => { acknowledgeCompletion = resolve; });
    let completionCalled!: () => void;
    const didCallCompletion = new Promise<void>((resolve) => { completionCalled = resolve; });
    value.gate.completeRuntimeStop = vi.fn(async () => {
      completionCalled();
      await completionAcknowledgement;
      return { completed: true, revoked: true };
    });

    const stopping = value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "unlocked-completion-stop",
    });
    await didCallCompletion;
    expect(existsSync(join(value.manager.storageRoot, "stops", `${started.runtimeId}.json`))).toBe(true);
    expect(existsSync(join(value.manager.storageRoot, "stop-completions", `${started.runtimeId}.json`))).toBe(false);
    await expect(Promise.race([
      backend.withMachineMutex({ action: async () => "entered" as const }),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
    ])).resolves.toBe("entered");

    acknowledgeCompletion();
    await expect(stopping).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
  });

  it("bounds a never-settling restoration gate even when no restoration wait was requested", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "deadline-restoration-start",
    });
    value.gate.reserveRuntimeStop = vi.fn(
      async () => new Promise<RuntimeStopPreflight>(() => undefined)
    );

    const beganAt = Date.now();
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "deadline-restoration-stop",
    })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: {
        runtimeId: started.runtimeId,
        state: "stopping",
        wallDeadlineExpired: true,
      },
    });
    expect(Date.now() - beganAt).toBeLessThan(1_000);
    expect(value.backend.terminateCalls).toEqual([]);
    expect(value.backend.processes.has(started.pid)).toBe(true);

    const attemptHash = createHash("sha256")
      .update("deadline-restoration-stop")
      .digest("hex");
    expect(JSON.parse(readFileSync(join(
      value.manager.storageRoot,
      "idempotency",
      `stop-${attemptHash}.json`
    ), "utf8"))).toMatchObject({
      action: "stop",
      runtimeId: started.runtimeId,
      state: "starting",
    });
  });

  it("returns recovery-required with exact vacancy evidence when observer completion never settles", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "deadline-completion-start",
    });
    let markCompletionEntered!: () => void;
    const completionEntered = new Promise<void>((resolve) => { markCompletionEntered = resolve; });
    value.gate.completeRuntimeStop = vi.fn(async () => {
      markCompletionEntered();
      return new Promise<unknown>(() => undefined);
    });

    vi.useFakeTimers();
    try {
      const beganAt = Date.now();
      const stopping = value.manager.stop({
        runtimeId: started.runtimeId,
        waitForRestorationMs: 0,
        idempotencyKey: "deadline-completion-stop",
      });
      const rejection = expect(stopping).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
      await completionEntered;
      await vi.advanceTimersByTimeAsync(300);
      await rejection;

      expect(Date.now() - beganAt).toBe(300);
      expect(value.backend.processes.has(started.pid)).toBe(false);
      expect(existsSync(join(
        value.manager.storageRoot,
        "stops",
        `${started.runtimeId}.json`
      ))).toBe(true);
      expect(existsSync(join(
        value.manager.storageRoot,
        "stop-completions",
        `${started.runtimeId}.json`
      ))).toBe(false);
      await expect(value.manager.status(started.runtimeId)).resolves.toMatchObject({
        state: "stopping",
        identityVacant: true,
        terminationComplete: true,
        observerCleanupPending: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call the observer gate after mutex acquisition consumes the stop budget", async () => {
    const backend = createDeadlineBackend();
    const value = makeHarness({
      backend,
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "deadline-mutex-start",
    });
    const reserve = vi.spyOn(value.gate, "reserveRuntimeStop");
    backend.hangNextMutexAfterAction = true;

    const beganAt = Date.now();
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "deadline-mutex-stop",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(Date.now() - beganAt).toBeLessThan(1_000);
    expect(reserve).not.toHaveBeenCalled();
    expect(backend.terminateCalls).toEqual([]);
  });

  it("does not reserve or terminate after exact inspection consumes the stop budget", async () => {
    const backend = createDeadlineBackend();
    const value = makeHarness({
      backend,
      inspectionTimeoutMs: 100,
      terminationTimeoutMs: 100,
      lockTimeoutMs: 100,
    });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "deadline-inspection-start",
    });
    const reserve = vi.spyOn(value.gate, "reserveRuntimeStop");
    backend.hangNextInspection = true;

    const beganAt = Date.now();
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "deadline-inspection-stop",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(Date.now() - beganAt).toBeLessThan(1_000);
    expect(reserve).not.toHaveBeenCalled();
    expect(backend.terminateCalls).toEqual([]);
  });

  it("revalidates the durable restoration reservation after reacquiring the mutex", async () => {
    const backend = createHookedSerialBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "proof-race-start",
    });
    backend.beforeAction = () => {
      const proofPath = join(
        value.manager.storageRoot,
        "restoration-proofs",
        `${started.runtimeId}.json`
      );
      if (!existsSync(proofPath)) return;
      backend.beforeAction = null;
      const proof = JSON.parse(readFileSync(proofPath, "utf8"));
      proof.reservationId = "00000000-0000-4000-8000-999999999999";
      writeFileSync(proofPath, JSON.stringify(proof));
    };

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "proof-race-stop",
    })).rejects.toMatchObject({ code: "STORAGE_UNVERIFIABLE" });
    expect(backend.terminateCalls).toHaveLength(0);
    expect(backend.processes.has(started.pid)).toBe(true);
  });

  it("refuses PID reuse and leaves the replacement process untouched", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "reuse-start" });
    const replacement = value.backend.processes.get(started.pid)!;
    replacement.identity.creationTime = "777777";
    replacement.ownerArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}replacement`;
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "reuse-stop",
    })).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.processes.get(started.pid)).toBe(replacement);
    expect(value.backend.terminateCalls).toHaveLength(0);
  });

  it("recovers an exact receipt after MCP restart and supports multiple independent runtimes", async () => {
    const value = makeHarness();
    const preparedOne = await value.prepare(["-window", "-server", "one"]);
    const preparedTwo = await value.prepare(["-window", "-server", "two"]);
    const one = await value.manager.start({ preparedLaunchId: preparedOne.id, idempotencyKey: "multi-one" });
    const two = await value.manager.start({ preparedLaunchId: preparedTwo.id, idempotencyKey: "multi-two" });
    expect(one.runtimeId).not.toBe(two.runtimeId);
    const sealed = await value.manager.close();
    expect(sealed).toMatchObject({ sealedRuntimeIds: expect.arrayContaining([one.runtimeId, two.runtimeId]) });
    expect(value.backend.processes.has(one.pid)).toBe(true);
    expect(value.backend.processes.has(two.pid)).toBe(true);

    const recovered = makeHarness({ root: value.root, backend: value.backend });
    recovered.setExecutable(value.executable);
    expect(await recovered.manager.status(one.runtimeId)).toMatchObject({ state: "running", exactOwned: true });
    recovered.gate.preflights.push({
      sessionKnown: false,
      ready: false,
      reserved: false,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
      reason: "observer_session_unknown",
    });
    await recovered.manager.stop({
      runtimeId: one.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "recovered-stop",
    });
    expect(value.backend.processes.has(one.pid)).toBe(false);
    expect(value.backend.processes.has(two.pid)).toBe(true);
    expect(await recovered.manager.status(two.runtimeId)).toMatchObject({ state: "running", exactOwned: true });
  });

  it("uses a durable restart seal without requiring a new child to re-retain the old session", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "sealed-restart-start",
    });
    await expect(value.manager.close()).resolves.toMatchObject({
      sealedRuntimeIds: [started.runtimeId],
      applicationCloseSafe: true,
    });

    const recovered = makeHarness({ root: value.root, backend: value.backend });
    recovered.setExecutable(value.executable);
    recovered.gate.retainRuntimeLifecycle = vi.fn(async () => {
      throw new Error("replacement private child has no old session");
    });
    recovered.gate.preflights.push({
      sessionKnown: false,
      ready: false,
      reserved: false,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
    });

    await expect(recovered.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "running",
      exactOwned: true,
    });
    await expect(recovered.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "sealed-restart-stop",
    })).resolves.toMatchObject({ state: "exited", terminationComplete: true });
    expect(recovered.gate.retainRuntimeLifecycle).not.toHaveBeenCalled();
    expect(recovered.gate.preflights).toHaveLength(1);
    expect(value.backend.processes.has(started.pid)).toBe(false);
  });

  it("refuses concurrent adoption while the prior exact MCP owner is still live", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "prior-owner-start" });
    value.backend.processes.set(process.pid, {
      identity: {
        pid: process.pid,
        executablePath: process.execPath,
        creationTime: value.backend.currentCreation,
      },
      ownerArgument: "",
    });
    const concurrent = makeHarness({ root: value.root, backend: value.backend });
    expect(await concurrent.manager.status(started.runtimeId)).toMatchObject({
      state: "unverifiable",
      exactOwned: false,
      reason: expect.stringMatching(/Prior exact MCP owner is still live/),
    });
    await expect(concurrent.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "prior-owner-stop",
    })).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it("fails closed when restart recovery cannot prove the observer session", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "unknown-session-start" });
    value.gate.preflights.push({
      sessionKnown: false,
      ready: false,
      reserved: false,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
      reason: "observer_session_unknown",
    });
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "unknown-session-stop",
    })).rejects.toMatchObject({ code: "SESSION_UNVERIFIABLE" });
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it("rejects expired and overlong managed starts before consumption or spawn", async () => {
    const expired = makeHarness();
    const prepared = await expired.prepare();
    expired.setClock(Date.parse(prepared.prepared.expiresAt));
    await expect(expired.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "expired-start" }))
      .rejects.toMatchObject({ code: "PREPARED_LAUNCH_EXPIRED" });
    expect(readdirSync(join(expired.manager.storageRoot, "consumed"))).toEqual([]);
    expect(expired.spawnCalls).toEqual([]);

    const oversized = makeHarness();
    const tooLong = await oversized.prepare(["x".repeat(32_760)]);
    await expect(oversized.manager.start({ preparedLaunchId: tooLong.id, idempotencyKey: "oversized-start" }))
      .rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });
    expect(readdirSync(join(oversized.manager.storageRoot, "consumed"))).toEqual([]);
    expect(oversized.spawnCalls).toEqual([]);

    const oversizedProfile = makeHarness();
    const profilePath = "p".repeat(32_769);
    await expect(oversizedProfile.manager.recordPreparedLaunch({
      runtimeKind: "listenServer",
      arguments: ["-window"],
      profilePath,
      sessionTtlMs: 60_000,
      transportPreference: ["rest", "mailbox"],
      forceUpdate: false,
    }, {
      arguments: ["-window"],
      sessionId: "session-oversized-profile",
      expiresAt: new Date("2026-07-18T12:01:00.000Z").toISOString(),
      bundleDigest: "a".repeat(64),
      profilePath,
      warnings: [],
    })).rejects.toMatchObject({ code: "PREPARE_FAILED" });
    expect(oversizedProfile.spawnCalls).toEqual([]);
  });

  it("keeps durable non-success evidence when retained-child cleanup cannot be proved", async () => {
    const value = makeHarness({ spawnFailure: true, refuseKill: true });
    const prepared = await value.prepare();
    await expect(value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "stubborn-start" }))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(readdirSync(join(value.manager.storageRoot, "runtimes"))).toEqual([]);
    const pendingName = readdirSync(join(value.manager.storageRoot, "pending-starts"))[0];
    const pending = JSON.parse(readFileSync(join(value.manager.storageRoot, "pending-starts", pendingName), "utf8"));
    expect(pending).toMatchObject({ state: "cleanup_required", preparedLaunchId: prepared.id });
    await expect(value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "stubborn-start" }))
      .rejects.toMatchObject({ code: "START_UNVERIFIABLE", details: { state: "cleanup_required" } });
  });

  it("fails closed when the executable is replaced in place after start", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "replace-start" });
    writeFileSync(value.executable, "different executable bytes");

    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "identity_mismatch",
      exactOwned: false,
      reason: expect.stringMatching(/replaced/),
    });
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "replace-stop",
    })).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.terminateCalls).toEqual([]);
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it("persists restoration authority before native termination and retries session completion", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "proof-start" });
    value.backend.beforeTerminate = () => {
      const proof = JSON.parse(readFileSync(join(
        value.manager.storageRoot,
        "restoration-proofs",
        `${started.runtimeId}.json`
      ), "utf8"));
      expect(proof).toMatchObject({
        runtimeId: started.runtimeId,
        sessionId: started.sessionId,
        kind: "live_stop_reservation",
      });
    };
    value.gate.completeFailures = 1;
    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "proof-stop",
    })).rejects.toMatchObject({ code: "SESSION_COMPLETION_FAILED" });
    expect(value.backend.processes.has(started.pid)).toBe(false);
    expect(value.backend.terminateCalls).toHaveLength(1);
    expect(existsSync(join(value.manager.storageRoot, "stops", `${started.runtimeId}.json`))).toBe(true);
    expect(existsSync(join(value.manager.storageRoot, "stop-completions", `${started.runtimeId}.json`))).toBe(false);
    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "stopping",
      exactOwned: true,
      identityVacant: true,
      terminationComplete: true,
      observerCleanupPending: true,
    });

    // Simulate a legacy/racing tokenless vacancy receipt. The durable proof
    // remains the completion authority and must converge the observer lease.
    const proof = JSON.parse(readFileSync(join(
      value.manager.storageRoot,
      "restoration-proofs",
      `${started.runtimeId}.json`
    ), "utf8"));
    const stopPath = join(value.manager.storageRoot, "stops", `${started.runtimeId}.json`);
    const tokenlessStop = JSON.parse(readFileSync(stopPath, "utf8"));
    delete tokenlessStop.restorationReservationId;
    writeFileSync(stopPath, JSON.stringify(tokenlessStop));

    const replay = await value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "proof-stop",
    });
    expect(replay).toMatchObject({
      state: "exited",
      identityVacant: true,
      terminationComplete: true,
      observerCleanupPending: false,
    });
    expect(value.backend.terminateCalls).toHaveLength(1);
    expect(value.gate.completedReservations).toEqual([proof.reservationId]);
    const stopped = JSON.parse(readFileSync(join(value.manager.storageRoot, "stops", `${started.runtimeId}.json`), "utf8"));
    expect(stopped).toMatchObject({
      sessionId: started.sessionId,
      restorationProofKind: "live_stop_reservation",
      identityVacant: true,
    });
  });

  it("retains the restoration seal when native termination may have occurred before an error", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "late-error-start" });
    value.backend.verifyAndTerminate = vi.fn(async () => {
      value.backend.processes.delete(started.pid);
      throw new Error("fixture helper disconnected after signalling");
    });

    await expect(value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "late-error-stop",
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(existsSync(join(
      value.manager.storageRoot,
      "restoration-proofs",
      `${started.runtimeId}.json`
    ))).toBe(true);
    expect(value.gate.released).toEqual([]);
    expect(existsSync(join(value.manager.storageRoot, "stops", `${started.runtimeId}.json`))).toBe(false);
    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "stopping",
      terminationComplete: false,
      observerCleanupPending: false,
    });
  });

  it("refuses recovery under a different installation or Windows owner", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "owner-recovery-start" });
    const otherInstall = join(value.root, "other-install");
    mkdirSync(otherInstall);
    const differentInstall = new OwnedRuntimeManager({
      managedRoot: value.root,
      gamePath: value.root,
      observerGate: new FakeGate(),
      backend: value.backend,
      executableResolver: () => value.executable,
      installationRoot: otherInstall,
    });
    expect(await differentInstall.status(started.runtimeId)).toMatchObject({ state: "unverifiable", exactOwned: false });

    value.backend.currentUserSid = "S-1-5-21-different-owner";
    const differentOwner = new OwnedRuntimeManager({
      managedRoot: value.root,
      gamePath: value.root,
      observerGate: new FakeGate(),
      backend: value.backend,
      executableResolver: () => value.executable,
      installationRoot: process.cwd(),
    });
    expect(await differentOwner.status(started.runtimeId)).toMatchObject({ state: "unverifiable", exactOwned: false });
  });

  it("rejects a linked managed root before creating lifecycle directories in the project", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-owned-runtime-link-"));
    roots.push(root);
    const project = join(root, "project");
    const outside = join(root, "outside");
    const linkedManagedRoot = join(outside, "managed");
    mkdirSync(project);
    mkdirSync(outside);
    symlinkSync(project, linkedManagedRoot, "junction");

    expect(() => new OwnedRuntimeManager({
      managedRoot: linkedManagedRoot,
      gamePath: root,
      projectPath: project,
      observerGate: new FakeGate(),
      backend: createFakeBackend(),
      executableResolver: () => join(root, "unused.exe"),
      installationRoot: process.cwd(),
    })).toThrowError(expect.objectContaining({ code: "STORAGE_UNVERIFIABLE" }));
    expect(existsSync(join(project, "state"))).toBe(false);
  });

  it("rejects a queued start once clean shutdown begins", async () => {
    const backend = createQueuedBackend();
    const value = makeHarness({ backend });
    const prepared = await value.prepare();
    const startPromise = value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "shutdown-race-start",
    });
    await backend.firstEntryBlocked;

    const closePromise = value.manager.close();
    backend.allowFirstEntry();

    await expect(startPromise).rejects.toMatchObject({ code: "LIFECYCLE_CLOSING" });
    await expect(closePromise).resolves.toMatchObject({ sealedRuntimeIds: [] });
    expect(value.spawnCalls).toEqual([]);
  });

  it("bounds lifecycle release within the aggregate shutdown deadline", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 5_000,
      terminationTimeoutMs: 5_000,
      lockTimeoutMs: 5_000,
    });
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "deadline-close-start",
    });
    await value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "deadline-close-stop",
    });
    let markReleaseEntered!: () => void;
    const releaseEntered = new Promise<void>((resolve) => { markReleaseEntered = resolve; });
    value.gate.releaseRuntimeLifecycle = vi.fn(async () => {
      markReleaseEntered();
      return new Promise<unknown>(() => undefined);
    });

    vi.useFakeTimers();
    try {
      const beganAt = Date.now();
      const closing = value.manager.close() as Promise<{
        applicationCloseSafe: boolean;
        errorRuntimes: Array<{ runtimeId: string; reason: string }>;
      }>;
      await releaseEntered;
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await closing;
      const runtimeError = result.errorRuntimes.find((entry) => entry.runtimeId === started.runtimeId);

      expect(Date.now() - beganAt).toBe(5_000);
      expect(result.applicationCloseSafe).toBe(false);
      expect(runtimeError?.reason).toContain("aggregate wall-clock deadline");
      expect(value.gate.releaseRuntimeLifecycle).toHaveBeenCalledTimes(1);
      expect(existsSync(join(
        value.manager.storageRoot,
        "stop-completions",
        `${started.runtimeId}.json`
      ))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports one bounded inventory remainder after the aggregate shutdown deadline", async () => {
    const value = makeHarness({
      inspectionTimeoutMs: 5_000,
      terminationTimeoutMs: 5_000,
      lockTimeoutMs: 5_000,
    });
    const runtimeIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const prepared = await value.prepare([`-deadline-inventory-${index}`]);
      const started = await value.manager.start({
        preparedLaunchId: prepared.id,
        idempotencyKey: `deadline-inventory-start-${index}`,
      });
      runtimeIds.push(started.runtimeId);
      await value.manager.stop({
        runtimeId: started.runtimeId,
        waitForRestorationMs: 0,
        idempotencyKey: `deadline-inventory-stop-${index}`,
      });
    }
    const releaseRuntimeLifecycle = value.gate.releaseRuntimeLifecycle.bind(value.gate);
    let wallNow = Date.now();
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    value.gate.releaseRuntimeLifecycle = vi.fn(async (
      sessionId: string,
      runtimeId: string,
      generation: string
    ) => {
      const acknowledgement = await releaseRuntimeLifecycle(sessionId, runtimeId, generation);
      // Deterministically consume the aggregate shutdown budget after one
      // inspected runtime; setup timing and scheduler load are irrelevant.
      wallNow += 5_000;
      return acknowledgement;
    });

    try {
      const beganAt = Date.now();
      const result = await value.manager.close() as {
        errorRuntimes: Array<{ runtimeId: string; reason: string }>;
        applicationCloseSafe: boolean;
      };
      const inventoryErrors = result.errorRuntimes.filter((entry) => entry.runtimeId === "inventory");

      expect(Date.now() - beganAt).toBe(5_000);
      expect(result.applicationCloseSafe).toBe(false);
      expect(inventoryErrors).toHaveLength(1);
      expect(inventoryErrors[0].reason).toContain("5 runtime(s) were not inspected");
      expect(result.errorRuntimes).toEqual(inventoryErrors);
      expect(value.gate.releaseRuntimeLifecycle).toHaveBeenCalledTimes(1);
      expect(runtimeIds).toHaveLength(6);
    } finally {
      wallClock.mockRestore();
    }
  }, 15_000);

  it("keeps coordinator shutdown unsafe when the runtime receipt directory disappears", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "missing-inventory-start",
    });
    rmSync(join(value.manager.storageRoot, "runtimes"), { recursive: true, force: true });

    await expect(value.manager.close()).resolves.toMatchObject({
      sealedRuntimeIds: [],
      busyRuntimeIds: [],
      errorRuntimes: [expect.objectContaining({
        runtimeId: "inventory",
        reason: expect.stringContaining("receipt directory is missing"),
      })],
      applicationCloseSafe: false,
    });
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it.each(["symbolic link", "directory"] as const)(
    "keeps coordinator shutdown unsafe for a %s runtime inventory entry",
    async (entryKind) => {
      const value = makeHarness();
      const prepared = await value.prepare();
      const started = await value.manager.start({
        preparedLaunchId: prepared.id,
        idempotencyKey: `non-file-inventory-${entryKind}`,
      });
      const receiptPath = join(
        value.manager.storageRoot,
        "runtimes",
        `${started.runtimeId}.json`
      );
      rmSync(receiptPath);
      if (entryKind === "symbolic link") {
        const target = join(value.root, "replacement-runtime-receipt.json");
        writeFileSync(target, "{}\n");
        symlinkSync(target, receiptPath, "file");
      } else {
        mkdirSync(receiptPath);
      }
      const reserve = vi.spyOn(value.gate, "reserveRuntimeStop");

      await expect(value.manager.close()).resolves.toMatchObject({
        sealedRuntimeIds: [],
        busyRuntimeIds: [],
        errorRuntimes: [expect.objectContaining({
          runtimeId: started.runtimeId,
          reason: expect.stringContaining("not a regular file"),
        })],
      applicationCloseSafe: false,
      });
      expect(reserve).not.toHaveBeenCalled();
      expect(value.backend.processes.has(started.pid)).toBe(true);
    }
  );

  it("cross-binds runtime filenames and isolates shutdown sealing across corrupt receipts", async () => {
    const value = makeHarness();
    const firstPrepared = await value.prepare(["-first"]);
    const secondPrepared = await value.prepare(["-second"]);
    const first = await value.manager.start({ preparedLaunchId: firstPrepared.id, idempotencyKey: "binding-first" });
    const second = await value.manager.start({ preparedLaunchId: secondPrepared.id, idempotencyKey: "binding-second" });
    writeFileSync(join(value.manager.storageRoot, "runtimes", `${first.runtimeId}.json`), "{\n");

    expect(await value.manager.status(first.runtimeId)).toMatchObject({ state: "unverifiable", exactOwned: false });
    const result = await value.manager.close();
    expect(result).toMatchObject({
      sealedRuntimeIds: [second.runtimeId],
      errorRuntimes: [expect.objectContaining({ runtimeId: first.runtimeId })],
    });
  });

  it("does not let a cross-bound completion receipt consume live-runtime recovery reserve", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId: prepared.id,
      idempotencyKey: "completion-binding-start",
    });
    expect(value.manager.diagnosticStorageStats().reservedMutationRecords).toBe(5);
    writeFileSync(join(
      value.manager.storageRoot,
      "stop-completions",
      `${started.runtimeId}.json`
    ), JSON.stringify({
      version: 1,
      runtimeId: "rt-ffffffff-ffff-4fff-8fff-ffffffffffff",
      sessionId: started.sessionId,
      preparedLaunchId: started.preparedLaunchId,
      completedAt: "2026-07-18T12:00:00.000Z",
      observerCompleted: true,
      sessionRevoked: true,
    }));

    expect(value.manager.diagnosticStorageStats().reservedMutationRecords).toBe(5);
  });

  it("seals owned runtime restoration before closing the observer application", async () => {
    const order: string[] = [];
    const result = await closeObserverRuntimeLifecycle({
      close: async () => {
        order.push("manager:start");
        await Promise.resolve();
        order.push("manager:sealed");
        return { sealedRuntimeIds: ["rt-fixture"], applicationCloseSafe: true };
      },
    }, {
      close: async () => { order.push("coordinator:closed"); },
    });
      expect(result).toEqual({ sealedRuntimeIds: ["rt-fixture"], applicationCloseSafe: true });
    expect(order).toEqual(["manager:start", "manager:sealed", "coordinator:closed"]);
  });

  it("keeps the observer application alive when shutdown sealing is incomplete", async () => {
    const coordinatorClose = vi.fn(async () => undefined);
    await expect(closeObserverRuntimeLifecycle({
      close: async () => ({
        sealedRuntimeIds: [],
        busyRuntimeIds: ["rt-ffffffff-ffff-4fff-8fff-ffffffffffff"],
        applicationCloseSafe: false,
      }),
    }, {
      close: coordinatorClose,
    })).rejects.toMatchObject({ code: "SHUTDOWN_SEAL_FAILED" });
    expect(coordinatorClose).not.toHaveBeenCalled();
  });

  it("contains no name-based, command-shell, process-tree, or PID-only production termination path", () => {
    const source = [
      "src/observer/owned-runtime-manager.ts",
      "src/tools/observer-runtime.ts",
    ].map((path) => readFileSync(join(process.cwd(), path), "utf8")).join("\n");
    expect(source).not.toMatch(/taskkill|Stop-Process|GetProcessesByName|process\.kill\s*\(|shell:\s*true|\/T\b/i);
    expect(source).toContain("this.backend.verifyAndTerminate");
    expect(source).toContain("No PID lookup occurs here");
  });
});
