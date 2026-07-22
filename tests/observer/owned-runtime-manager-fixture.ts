import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import {
  OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX,
  OwnedRuntimeManager,
  type OwnedRuntimeLifecycleAuthority,
  type OwnedRuntimeInspection,
  type OwnedRuntimeObserverGate,
  type OwnedRuntimeProcessBackend,
  type OwnedRuntimePublicStatus,
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

interface FakeProcess extends FakeExactProcessRecord {}

export type FakeBackend = FakeExactProcessBackend<FakeProcess> & OwnedRuntimeProcessBackend & {
  terminateCalls: FakeExactProcessBackend<FakeProcess>["terminationCalls"];
  currentCreation: string;
  currentUserSid: string;
  refuseTermination: boolean;
};

export function createFakeBackend(): FakeBackend {
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
  backend.verifyAndTerminate = async (expected, timeoutMs?: number) => {
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

export type QueuedBackend = FakeBackend & {
  firstEntryBlocked: Promise<void>;
  allowFirstEntry(): void;
};

export function createQueuedBackend(): QueuedBackend {
  const backend = createFakeBackend() as QueuedBackend;
  let mutexTail: Promise<void> = Promise.resolve();
  let entryCount = 0;
  let markFirstEntryBlocked!: () => void;
  let releaseFirstEntry!: () => void;
  backend.firstEntryBlocked = new Promise<void>((resolve) => { markFirstEntryBlocked = resolve; });
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

export function createSerialBackend(): FakeBackend {
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

export type HookedSerialBackend = FakeBackend & {
  entryCount: number;
  beforeAction: ((entry: number) => void) | null;
};

export function createHookedSerialBackend(): HookedSerialBackend {
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

export type DeadlineBackend = FakeBackend & {
  hangNextMutexAfterAction: boolean;
  hangNextInspection: boolean;
  mutexEntries: number;
  inspectionCalls: number;
};

export function createDeadlineBackend(): DeadlineBackend {
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

export type LeaseLosingBackend = FakeBackend & {
  loseOnCurrentInspection: boolean;
  loseAfterTermination: boolean;
};

export function createLeaseLosingBackend(): LeaseLosingBackend {
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
  backend.verifyAndTerminate = async (expected, timeoutMs?: number) => {
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

export class FakeChild extends EventEmitter {
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

export class FakeGate implements OwnedRuntimeObserverGate {
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

export class AgentBackedGate extends FakeGate {
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

export interface Harness {
  root: string;
  executable: string;
  backend: FakeBackend;
  gate: FakeGate;
  manager: OwnedRuntimeManager;
  spawnCalls: Array<{ executable: string; arguments: string[]; options: Record<string, unknown>; child: FakeChild }>;
  setClock(value: number): void;
  setExecutable(value: string): void;
  prepare(argumentsArray?: string[], idempotencyKey?: string): Promise<{ id: string; prepared: ObserverPreparedLaunch }>;
  startPrepared(preparedLaunchId: string, idempotencyKey: string): Promise<OwnedRuntimePublicStatus>;
  start(idempotencyKey: string, argumentsArray?: string[], prepareIdempotencyKey?: string): Promise<OwnedRuntimePublicStatus>;
  stop(runtimeId: string, idempotencyKey: string, waitForRestorationMs?: number): Promise<OwnedRuntimePublicStatus>;
}

export const roots: string[] = [];
export const openManagers: OwnedRuntimeManager[] = [];
export const openAgents: Array<{ server: { close(): Promise<void> } }> = [];

export async function cleanupOwnedRuntimeManagerFixtures(): Promise<void> {
  // Release every manager's and in-process agent's LMDB environment before
  // removing its root: an open memory map blocks rmSync on Windows. (An agent
  // simulating "loss" is never closed by the test, so close it here.)
  for (const manager of openManagers.splice(0)) {
    await manager.closeStorageForTest().catch(() => undefined);
  }
  for (const agent of openAgents.splice(0)) {
    await agent.server.close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function listRecordIds(manager: OwnedRuntimeManager, family: string): string[] {
  return manager.recordStoreForTest().listIds(family);
}

export function recordExists(manager: OwnedRuntimeManager, family: string, id: string): boolean {
  return manager.recordStoreForTest().has(family, id);
}

export function removeRecord(manager: OwnedRuntimeManager, family: string, id: string): boolean {
  return manager.recordStoreForTest().remove(family, id);
}

export function writeRecord(manager: OwnedRuntimeManager, family: string, id: string, text: string): void {
  manager.recordStoreForTest().putRaw(family, id, Buffer.from(text, "utf8"), { exclusive: false });
}

export function readRecordText(manager: OwnedRuntimeManager, family: string, id: string): string {
  const raw = manager.recordStoreForTest().getRaw(family, id);
  if (raw === null) throw new Error(`Expected record ${family}/${id}`);
  return Buffer.from(raw).toString("utf8");
}

export function readRecord(manager: OwnedRuntimeManager, family: string, id: string): Record<string, unknown> {
  return JSON.parse(readRecordText(manager, family, id)) as Record<string, unknown>;
}

export function runtimeStopPreflight(
  overrides: Partial<RuntimeStopPreflight> = {}
): RuntimeStopPreflight {
  return {
    sessionKnown: true,
    ready: true,
    reserved: true,
    activeJobIds: [],
    cameraLeaseJobIds: [],
    restorationPendingJobIds: [],
    ...overrides,
  };
}

export function failRuntimePublication(manager: OwnedRuntimeManager): void {
  const writable = manager as unknown as {
    atomicWrite(root: string, target: string, record: unknown, exclusive: boolean, durable?: boolean): void;
  };
  const atomicWrite = writable.atomicWrite.bind(manager);
  writable.atomicWrite = (root, target, record, exclusive, durable) => {
    if (dirname(target) === join(manager.storageRoot, "runtimes") && target.endsWith(".json")) {
      throw new Error("fixture runtime publication failure");
    }
    atomicWrite(root, target, record, exclusive, durable);
  };
}

export function recordByteLength(manager: OwnedRuntimeManager, family: string, id: string): number {
  const raw = manager.recordStoreForTest().getRaw(family, id);
  return raw === null ? 0 : raw.byteLength;
}

export function makeHarness(options: {
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
  openManagers.push(manager);
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
  const startPrepared: Harness["startPrepared"] = (preparedLaunchId, idempotencyKey) =>
    manager.start({ preparedLaunchId, idempotencyKey });
  const start: Harness["start"] = async (idempotencyKey, argumentsArray, prepareIdempotencyKey) => {
    const prepared = await prepare(argumentsArray, prepareIdempotencyKey);
    return startPrepared(prepared.id, idempotencyKey);
  };
  const stop: Harness["stop"] = (runtimeId, idempotencyKey, waitForRestorationMs = 0) =>
    manager.stop({ runtimeId, idempotencyKey, waitForRestorationMs });
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
    startPrepared,
    start,
    stop,
  };
}
