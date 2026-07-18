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
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX,
  closeObserverRuntimeLifecycle,
  OwnedRuntimeManager,
  type OwnedRuntimeExactIdentity,
  type OwnedRuntimeInspection,
  type OwnedRuntimeObserverGate,
  type OwnedRuntimeProcessBackend,
  type RuntimeStopPreflight,
} from "../../src/observer/owned-runtime-manager.js";
import type { ObserverLaunchInput, ObserverPreparedLaunch } from "../../src/observer/launch.js";

interface FakeProcess {
  identity: OwnedRuntimeExactIdentity;
  ownerArgument: string;
}

class FakeBackend implements OwnedRuntimeProcessBackend {
  readonly platform = "test" as const;
  readonly processes = new Map<number, FakeProcess>();
  readonly terminateCalls: Array<OwnedRuntimeExactIdentity & { ownerTokenArgument: string }> = [];
  inspectFailure: Error | null = null;
  currentCreation = "900001";
  currentUserSid = "S-1-5-21-test-owner";
  beforeTerminate: (() => void) | null = null;

  async withMachineMutex<T>(args: { action: () => Promise<T> }): Promise<T> {
    return args.action();
  }

  async inspectCurrentProcess(pid: number) {
    return {
      pid,
      executablePath: process.execPath,
      creationTimeFileTime: this.currentCreation,
      userSid: this.currentUserSid,
    };
  }

  async inspectProcess(pid: number, expectedOwnerTokenArgument?: string): Promise<OwnedRuntimeInspection | null> {
    if (this.inspectFailure) throw this.inspectFailure;
    const value = this.processes.get(pid);
    if (!value) return null;
    return {
      identity: { ...value.identity },
      ownerArgumentMatched: expectedOwnerTokenArgument === undefined
        ? null
        : value.ownerArgument === expectedOwnerTokenArgument,
    };
  }

  async verifyAndTerminate(expected: OwnedRuntimeExactIdentity & {
    ownerTokenArgument: string;
    launchedAtMs: number;
  }) {
    this.beforeTerminate?.();
    this.terminateCalls.push({ ...expected });
    const value = this.processes.get(expected.pid);
    if (!value) return { kind: "already_exited" as const };
    if (value.identity.executablePath !== expected.executablePath) {
      return { kind: "refused" as const, reason: "executable_mismatch" as const, message: "path changed" };
    }
    if (value.identity.creationTimeFileTime !== expected.creationTimeFileTime) {
      return { kind: "refused" as const, reason: "creation_time_mismatch" as const, message: "creation changed" };
    }
    if (value.ownerArgument !== expected.ownerTokenArgument) {
      return { kind: "refused" as const, reason: "token_mismatch" as const, message: "token changed" };
    }
    this.processes.delete(expected.pid);
    return { kind: "terminated" as const };
  }
}

class QueuedBackend extends FakeBackend {
  private mutexTail: Promise<void> = Promise.resolve();
  private firstEntry = true;
  private markFirstEntryBlocked!: () => void;
  private releaseFirstEntry!: () => void;
  readonly firstEntryBlocked: Promise<void>;
  private readonly firstEntryRelease: Promise<void>;

  constructor() {
    super();
    this.firstEntryBlocked = new Promise((resolve) => { this.markFirstEntryBlocked = resolve; });
    this.firstEntryRelease = new Promise((resolve) => { this.releaseFirstEntry = resolve; });
  }

  allowFirstEntry(): void {
    this.releaseFirstEntry();
  }

  override async withMachineMutex<T>(args: { action: () => Promise<T> }): Promise<T> {
    const prior = this.mutexTail;
    let releaseCurrent!: () => void;
    this.mutexTail = new Promise((resolve) => { releaseCurrent = resolve; });
    await prior;
    try {
      if (this.firstEntry) {
        this.firstEntry = false;
        this.markFirstEntryBlocked();
        await this.firstEntryRelease;
      }
      return await args.action();
    } finally {
      releaseCurrent();
    }
  }
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
  readonly released: string[] = [];
  readonly completed: string[] = [];
  preflights: RuntimeStopPreflight[] = [];
  completeFailures = 0;

  async reserveRuntimeStop(): Promise<RuntimeStopPreflight> {
    return this.preflights.shift() ?? {
      sessionKnown: true,
      ready: true,
      reserved: true,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
    };
  }

  async releaseRuntimeStop(sessionId: string): Promise<unknown> {
    this.released.push(sessionId);
    return { released: true };
  }

  async completeRuntimeStop(sessionId: string): Promise<unknown> {
    if (this.completeFailures > 0) {
      this.completeFailures -= 1;
      throw new Error("fixture completion failure");
    }
    this.completed.push(sessionId);
    return { completed: true, revoked: true };
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
} = {}): Harness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "rfo-owned-runtime-"));
  if (!options.root) roots.push(root);
  const executable = join(root, "ArmaReforgerSteamDiag.exe");
  if (!options.root) writeFileSync(executable, "fixture");
  const backend = options.backend ?? new FakeBackend();
  const gate = new FakeGate();
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
        identity: { pid: child.pid, executablePath: file, creationTimeFileTime: String(800000 + child.pid) },
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
    inspectionTimeoutMs: 500,
    terminationTimeoutMs: 500,
    lockTimeoutMs: 500,
  });
  const prepare = async (argumentsArray = ["-window", "-noSplash"], idempotencyKey?: string) => {
    const input: ObserverLaunchInput = {
      runtimeKind: "listenServer",
      arguments: argumentsArray,
      profilePath: join(root, "profiles", `profile-${id}`),
      sessionTtlMs: 60_000,
      transportPreference: ["rest", "mailbox"],
      forceUpdate: false,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
    const prepared: ObserverPreparedLaunch = {
      arguments: argumentsArray,
      sessionId: `session-${id}`,
      expiresAt: new Date(clock + 60_000).toISOString(),
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

  it("can reopen the largest public prepared-argument payload without poisoning later preparation", async () => {
    const value = makeHarness();
    const maximumToken = "x".repeat(32_768);
    const prepared = await value.prepare(Array.from({ length: 512 }, () => maximumToken));
    const descriptorPath = join(value.manager.storageRoot, "prepared", `${prepared.id}.json`);
    expect(statSync(descriptorPath).size).toBeGreaterThan(4 * 1024 * 1024);
    await expect(value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "maximum-payload" }))
      .rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });
    const later = await value.prepare(["-later"]);
    expect(later.id).not.toBe(prepared.id);
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
    if (process.platform !== "win32") expect(statSync(receiptPath).mode & 0o077).toBe(0);
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
    expect(pending).toMatchObject({ state: "cleanup_verified", preparedLaunchId: prepared.id });
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
    process.identity.creationTimeFileTime = "999999";
    expect((await value.manager.status(started.runtimeId)).state).toBe("identity_mismatch");
    process.identity.creationTimeFileTime = String(800000 + started.pid);
    process.ownerArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}changed`;
    expect((await value.manager.status(started.runtimeId)).state).toBe("identity_mismatch");
    process.ownerArgument = value.spawnCalls[0].arguments.at(-1)!;

    value.backend.inspectFailure = new Error("native inspection unavailable");
    expect((await value.manager.status(started.runtimeId)).state).toBe("unverifiable");
    value.backend.inspectFailure = null;
    value.backend.processes.delete(started.pid);
    expect((await value.manager.status(started.runtimeId)).state).toBe("exited");
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
      identity: { pid: 9999, executablePath: value.executable, creationTimeFileTime: "123456" },
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

  it("refuses PID reuse and leaves the replacement process untouched", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "reuse-start" });
    const replacement = value.backend.processes.get(started.pid)!;
    replacement.identity.creationTimeFileTime = "777777";
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

  it("refuses concurrent adoption while the prior exact MCP owner is still live", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.manager.start({ preparedLaunchId: prepared.id, idempotencyKey: "prior-owner-start" });
    value.backend.processes.set(process.pid, {
      identity: {
        pid: process.pid,
        executablePath: process.execPath,
        creationTimeFileTime: value.backend.currentCreation,
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

    const replay = await value.manager.stop({
      runtimeId: started.runtimeId,
      waitForRestorationMs: 0,
      idempotencyKey: "proof-stop",
    });
    expect(replay).toMatchObject({ state: "exited", identityVacant: true });
    expect(value.backend.terminateCalls).toHaveLength(1);
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
    })).rejects.toMatchObject({ code: "STOP_FAILED" });
    expect(existsSync(join(
      value.manager.storageRoot,
      "restoration-proofs",
      `${started.runtimeId}.json`
    ))).toBe(true);
    expect(value.gate.released).toEqual([]);
    expect(existsSync(join(value.manager.storageRoot, "stops", `${started.runtimeId}.json`))).toBe(false);
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
    symlinkSync(project, linkedManagedRoot, process.platform === "win32" ? "junction" : "dir");

    expect(() => new OwnedRuntimeManager({
      managedRoot: linkedManagedRoot,
      gamePath: root,
      projectPath: project,
      observerGate: new FakeGate(),
      backend: new FakeBackend(),
      executableResolver: () => join(root, "unused.exe"),
      installationRoot: process.cwd(),
    })).toThrowError(expect.objectContaining({ code: "STORAGE_UNVERIFIABLE" }));
    expect(existsSync(join(project, "state"))).toBe(false);
  });

  it("rejects a queued start once clean shutdown begins", async () => {
    const backend = new QueuedBackend();
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

  it("seals owned runtime restoration before closing the observer coordinator", async () => {
    const order: string[] = [];
    const result = await closeObserverRuntimeLifecycle({
      close: async () => {
        order.push("manager:start");
        await Promise.resolve();
        order.push("manager:sealed");
        return { sealedRuntimeIds: ["rt-fixture"] };
      },
    }, {
      close: async () => { order.push("coordinator:closed"); },
    });
    expect(result).toEqual({ sealedRuntimeIds: ["rt-fixture"] });
    expect(order).toEqual(["manager:start", "manager:sealed", "coordinator:closed"]);
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
