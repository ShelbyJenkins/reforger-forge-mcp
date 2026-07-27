import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX,
  OwnedRuntimeManager,
  type OwnedRuntimeExactIdentity,
  type OwnedRuntimeInspection,
  type OwnedRuntimeLifecycleAuthority,
  type OwnedRuntimeObserverGate,
  type OwnedRuntimeProcessBackend,
  type OwnedRuntimeReceipt,
  type RuntimeStopPreflight,
} from "../../src/observer/owned-runtime-manager.js";
import type { ObserverLaunchInput, ObserverPreparedLaunch } from "../../src/observer/launch.js";
import type { SupervisedChildExit } from "../../src/foundation/child-supervisor.js";

interface FixtureProcess {
  identity: OwnedRuntimeExactIdentity;
  ownerArgument: string;
}

interface LifecycleCall {
  sessionId: string;
  runtimeId: string;
  generation: string;
}

class ExitBackend implements OwnedRuntimeProcessBackend {
  readonly platform = "test" as const;
  readonly processes = new Map<number, FixtureProcess>();
  mutexFailures = 0;
  injectedMutexFailures = 0;

  async withMachineMutex<T>(args: { action: () => Promise<T> }): Promise<T> {
    if (this.mutexFailures > 0) {
      this.mutexFailures -= 1;
      this.injectedMutexFailures += 1;
      throw new Error("injected durable lifecycle transaction failure");
    }
    return args.action();
  }

  async inspectCurrentProcess(pid: number) {
    return {
      pid,
      executablePath: process.execPath,
      creationTime: "910001",
      userSid: "S-1-5-21-exit-reconciliation-fixture",
    };
  }

  async inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<OwnedRuntimeInspection | null> {
    const current = this.processes.get(pid);
    if (!current) return null;
    return {
      identity: { ...current.identity },
      ownerArgumentMatched: expectedOwnerTokenArgument === undefined
        ? null
        : current.ownerArgument === expectedOwnerTokenArgument,
    };
  }

  async verifyAndTerminate() {
    return { kind: "already_exited" as const };
  }
}

class ExitGate implements OwnedRuntimeObserverGate {
  readonly retained: LifecycleCall[] = [];
  readonly released: LifecycleCall[] = [];

  async retainRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string,
    _authority: OwnedRuntimeLifecycleAuthority
  ): Promise<unknown> {
    const lifecycle = { sessionId, runtimeId, generation };
    const alreadyRetained = this.retained.some((candidate) => sameLifecycle(candidate, lifecycle));
    if (!alreadyRetained) this.retained.push(lifecycle);
    return { retained: true, alreadyRetained, generation };
  }

  async releaseRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): Promise<unknown> {
    const lifecycle = { sessionId, runtimeId, generation };
    const alreadyReleased = this.released.some((candidate) => sameLifecycle(candidate, lifecycle));
    if (!alreadyReleased) this.released.push(lifecycle);
    return { released: !alreadyReleased, alreadyReleased, generation };
  }

  async reserveRuntimeStop(): Promise<RuntimeStopPreflight> {
    throw new Error("stop is outside this exit-reconciliation fixture");
  }

  async releaseRuntimeStop(): Promise<unknown> {
    throw new Error("stop is outside this exit-reconciliation fixture");
  }

  async completeRuntimeStop(): Promise<unknown> {
    throw new Error("stop is outside this exit-reconciliation fixture");
  }
}

class ExitChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly unref = vi.fn();

  constructor(readonly pid: number) {
    super();
  }

  kill(): boolean {
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

interface InternalSupervisor {
  readonly size: number;
  readonly reconciliationSize: number;
  supervise(
    key: string,
    child: ChildProcess,
    callbacks: {
      onExit(exit: SupervisedChildExit): void | Promise<void>;
    }
  ): void;
}

interface InternalManager {
  readonly children: InternalSupervisor;
  reconcileChildExit(receipt: OwnedRuntimeReceipt, exit: SupervisedChildExit): Promise<void>;
}

interface ExitHarness {
  root: string;
  executable: string;
  manager: OwnedRuntimeManager;
  backend: ExitBackend;
  gate: ExitGate;
  children: ExitChild[];
  prepare(): Promise<string>;
}

const fixtureRoots: string[] = [];
const fixtureManagers: OwnedRuntimeManager[] = [];

afterEach(async () => {
  // Release the LMDB environment before rmSync (open memory maps block it on Windows).
  for (const manager of fixtureManagers.splice(0)) {
    await manager.closeStorageForTest().catch(() => undefined);
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function exitRecordText(manager: OwnedRuntimeManager, family: string, id: string): string {
  const raw = manager.recordStoreForTest().getRaw(family, id);
  if (raw === null) throw new Error(`Expected record ${family}/${id}`);
  return Buffer.from(raw).toString("utf8");
}

function exitRecordPresent(manager: OwnedRuntimeManager, family: string, id: string): boolean {
  return manager.recordStoreForTest().has(family, id);
}

function putExitRecord(manager: OwnedRuntimeManager, family: string, id: string, text: string): void {
  manager.recordStoreForTest().putRaw(family, id, Buffer.from(text, "utf8"), { exclusive: false });
}

function makeHarness(): ExitHarness {
  const root = mkdtempSync(join(tmpdir(), "rfo-owned-exit-retry-"));
  fixtureRoots.push(root);
  const executable = join(root, "ArmaReforgerSteamDiag.exe");
  writeFileSync(executable, "fixture executable\n");
  const backend = new ExitBackend();
  const gate = new ExitGate();
  const children: ExitChild[] = [];
  let nextPid = 6_100;
  let nextId = 1;
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const nextUuid = (): string =>
    `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const spawnProcess = ((file: string, args: readonly string[]) => {
    const child = new ExitChild(nextPid++);
    children.push(child);
    const ownerArgument = args.find((argument) =>
      argument.startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX)) ?? "";
    backend.processes.set(child.pid, {
      identity: {
        pid: child.pid,
        executablePath: file,
        creationTime: String(800_000 + child.pid),
      },
      ownerArgument,
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const manager = new OwnedRuntimeManager({
    managedRoot: root,
    gamePath: root,
    observerGate: gate,
    backend,
    spawnProcess,
    executableResolver: () => executable,
    installationRoot: root,
    clock: () => now,
    ownerToken: () => `owner_${String(nextId).padStart(58, "0")}`,
    randomId: nextUuid,
    inspectionTimeoutMs: 500,
    terminationTimeoutMs: 500,
    lockTimeoutMs: 500,
  });
  fixtureManagers.push(manager);
  return {
    root,
    executable,
    manager,
    backend,
    gate,
    children,
    prepare: async () => {
      const profilePath = join(root, "profiles", "exit-retry");
      const input: ObserverLaunchInput = {
        runtimeKind: "listenServer",
        arguments: ["-window", "-noSplash"],
        profilePath,
        sessionTtlMs: 60_000,
        transportPreference: ["rest", "mailbox"],
        forceUpdate: false,
        noFocus: false,
      };
      const prepared: ObserverPreparedLaunch = {
        arguments: input.arguments,
        sessionId: "session-exit-reconciliation",
        expiresAt: new Date(now + 60_000).toISOString(),
        bundleDigest: "a".repeat(64),
        profilePath,
        warnings: [],
      };
      return manager.recordPreparedLaunch(input, prepared);
    },
  };
}

function sameLifecycle(left: LifecycleCall, right: LifecycleCall): boolean {
  return left.sessionId === right.sessionId && left.runtimeId === right.runtimeId &&
    left.generation === right.generation;
}

function supervisor(manager: OwnedRuntimeManager): InternalSupervisor {
  return (manager as unknown as InternalManager).children;
}

function lifecycleGeneration(receipt: OwnedRuntimeReceipt): string {
  return createHash("sha256").update(JSON.stringify({
    runtimeId: receipt.runtimeId,
    sessionId: receipt.sessionId,
    preparedLaunchId: receipt.preparedLaunchId,
    pid: receipt.pid,
    executablePath: receipt.executablePath,
    creationTimeFileTime: receipt.creationTimeFileTime,
    ownerTokenArgument: receipt.ownerTokenArgument,
    launchedAtMs: receipt.launchedAtMs,
  })).digest("hex");
}

async function waitForReconciliationDrain(manager: OwnedRuntimeManager): Promise<void> {
  await vi.waitFor(() => {
    expect(supervisor(manager).size).toBe(0);
    expect(supervisor(manager).reconciliationSize).toBe(0);
  }, { timeout: 2_000, interval: 10 });
}

describe("OwnedRuntimeManager child-exit retry", () => {
  it("retries a failed durable exit transaction without a status poll", async () => {
    const value = makeHarness();
    const preparedLaunchId = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId,
      idempotencyKey: "automatic-exit-retry",
    });
    const status = vi.spyOn(value.manager, "status");
    const child = value.children[0];
    const retained = value.gate.retained[0];
    expect(retained).toMatchObject({
      runtimeId: started.runtimeId,
      sessionId: started.sessionId,
      generation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    value.backend.mutexFailures = 1;
    value.backend.processes.delete(started.pid);
    child.exit(0);

    expect(value.backend.injectedMutexFailures).toBe(1);
    expect(value.manager.diagnosticSupervisedChildCount()).toBe(0);
    expect(supervisor(value.manager).reconciliationSize).toBe(1);
    await vi.waitFor(() => expect(exitRecordPresent(value.manager, "child-exits", started.runtimeId)).toBe(true), {
      timeout: 2_000,
      interval: 10,
    });
    await vi.waitFor(() => expect(value.gate.released).toEqual([retained]), {
      timeout: 2_000,
      interval: 10,
    });
    await waitForReconciliationDrain(value.manager);

    expect(JSON.parse(exitRecordText(value.manager, "child-exits", started.runtimeId))).toMatchObject({
      runtimeId: started.runtimeId,
      sessionId: started.sessionId,
      pid: started.pid,
      executablePath: value.executable,
      creationTimeFileTime: String(800_000 + started.pid),
      exitCode: 0,
      signal: null,
    });
    expect(status).not.toHaveBeenCalled();
  });

  it("cancels a stale exit retry before a newer exact generation is supervised", async () => {
    const value = makeHarness();
    const preparedLaunchId = await value.prepare();
    const started = await value.manager.start({
      preparedLaunchId,
      idempotencyKey: "stale-exit-retry",
    });
    const oldChild = value.children[0];
    const oldReceipt = JSON.parse(exitRecordText(value.manager, "runtimes", started.runtimeId)) as OwnedRuntimeReceipt;
    const oldGeneration = lifecycleGeneration(oldReceipt);

    value.backend.mutexFailures = 1;
    value.backend.processes.delete(oldReceipt.pid);
    oldChild.exit(11);
    expect(value.backend.injectedMutexFailures).toBe(1);
    expect(supervisor(value.manager).reconciliationSize).toBe(1);

    const newChild = new ExitChild(oldReceipt.pid + 1_000);
    const newOwnerArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}${"n".repeat(48)}`;
    const newReceipt: OwnedRuntimeReceipt = {
      ...oldReceipt,
      pid: newChild.pid,
      creationTimeFileTime: String(900_000 + newChild.pid),
      ownerTokenArgument: newOwnerArgument,
      argvSha256: createHash("sha256").update(JSON.stringify([
        "-window",
        "-noSplash",
        newOwnerArgument,
      ])).digest("hex"),
      startedAt: new Date(oldReceipt.launchedAtMs + 1).toISOString(),
      launchedAtMs: oldReceipt.launchedAtMs + 1,
      mcpOwner: {
        ...oldReceipt.mcpOwner,
        pid: newChild.pid,
        creationTimeFileTime: String(900_000 + newChild.pid),
      },
    };
    putExitRecord(value.manager, "runtimes", started.runtimeId, `${JSON.stringify(newReceipt)}\n`);
    const newGeneration = lifecycleGeneration(newReceipt);
    expect(newGeneration).not.toBe(oldGeneration);
    await value.gate.retainRuntimeLifecycle(
      newReceipt.sessionId,
      newReceipt.runtimeId,
      newGeneration,
      {
        preparedLaunchId: newReceipt.preparedLaunchId,
        profilePath: newReceipt.profilePath,
        runtimeKind: newReceipt.runtimeKind,
        pid: newReceipt.pid,
        executablePath: newReceipt.executablePath,
        creationTimeFileTime: newReceipt.creationTimeFileTime,
        ownerTokenArgument: newReceipt.ownerTokenArgument,
        launchedAtMs: newReceipt.launchedAtMs,
      }
    );
    value.backend.processes.set(newChild.pid, {
      identity: {
        pid: newReceipt.pid,
        executablePath: newReceipt.executablePath,
        creationTime: newReceipt.creationTimeFileTime,
      },
      ownerArgument: newReceipt.ownerTokenArgument,
    });
    const internal = value.manager as unknown as InternalManager;
    internal.children.supervise(
      newReceipt.runtimeId,
      newChild as unknown as ChildProcess,
      { onExit: (exit) => internal.reconcileChildExit(newReceipt, exit) }
    );

    expect(supervisor(value.manager).reconciliationSize).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(value.gate.released).toEqual([]);
    expect(exitRecordPresent(value.manager, "child-exits", started.runtimeId)).toBe(false);

    value.backend.processes.delete(newChild.pid);
    newChild.exit(0);
    await vi.waitFor(() => expect(value.gate.released).toEqual([{
      sessionId: newReceipt.sessionId,
      runtimeId: newReceipt.runtimeId,
      generation: newGeneration,
    }]), { timeout: 2_000, interval: 10 });
    await waitForReconciliationDrain(value.manager);

    expect(JSON.parse(exitRecordText(value.manager, "child-exits", started.runtimeId))).toMatchObject({
      runtimeId: newReceipt.runtimeId,
      sessionId: newReceipt.sessionId,
      pid: newReceipt.pid,
      creationTimeFileTime: newReceipt.creationTimeFileTime,
      exitCode: 0,
    });
    expect(value.gate.released.some((entry) => entry.generation === oldGeneration)).toBe(false);
  });
});
