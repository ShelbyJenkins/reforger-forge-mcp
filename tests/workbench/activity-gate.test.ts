import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Config } from "../../src/config.js";
import { McpHostAdmissionGate } from "../../src/mcp-host-admission.js";
import {
  WorkbenchActivityError,
  WorkbenchActivityGate,
  type CaptureActivityBinding,
  type WorkbenchActivityGateTiming,
} from "../../src/workbench/activity-gate.js";
import {
  WorkbenchClient,
  WorkbenchError,
} from "../../src/workbench/client.js";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";
import type {
  WorkbenchIdentity,
  WorkbenchLifecycleStateV3,
} from "../../src/workbench/process-guard.js";
import {
  companionLifecycleState,
  createFakeCompanionLaunch,
  fakeCompanionProvider,
} from "./fake-companion.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";
import {
  createFakeLifecycleBackend,
  type FakeLifecycleBackend,
} from "./fake-lifecycle-backend.js";

const roots: string[] = [];

class ManualTiming implements WorkbenchActivityGateTiming {
  private readonly timers: Array<{ callback: () => void; cleared: boolean }> = [];

  setTimeout(callback: () => void): unknown {
    const timer = { callback, cleared: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }

  fireNext(): void {
    const timer = this.timers.find((candidate) => !candidate.cleared);
    if (!timer) throw new Error("No pending activity-gate timeout");
    timer.cleared = true;
    timer.callback();
  }
}

const binding: CaptureActivityBinding = {
  generation: "generation-a",
  targetKey: "target-a",
  process: {
    pid: 42,
    executablePath: "C:\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
    creationTime: "133900000000000042",
  },
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function expectActivityCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected activity operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkbenchActivityError);
    expect((error as WorkbenchActivityError).code).toBe(code);
  }
}

afterEach(async () => {
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkbenchActivityGate", () => {
  it("holds shared admissions and projects managed/capture activity read-only", async () => {
    const admissions = new McpHostAdmissionGate();
    const gate = new WorkbenchActivityGate({ admissionGate: admissions });
    const inspect = () => gate.inspectIdleShutdownReadiness({
      deadlineTick: performance.now() + 1_000,
      signal: new AbortController().signal,
      probeGeneration: 1,
    });
    const work = deferred();
    const managed = gate.runManaged("test read", () => work.promise);
    expect(admissions.snapshot().activeTokens).toBe(1);
    await expect(inspect()).resolves.toMatchObject({ blockers: ["WORKBENCH_ACTIVITY"] });
    work.resolve();
    await managed;
    expect(admissions.snapshot().activeTokens).toBe(0);

    const lease = gate.acquireCapture(binding);
    expect(admissions.snapshot().activeTokens).toBe(1);
    await expect(inspect()).resolves.toMatchObject({ blockers: ["WORKBENCH_ACTIVITY"] });
    gate.releaseCapture(lease);
    await expect(inspect()).resolves.toMatchObject({ blockers: [] });
    expect(admissions.snapshot().activeTokens).toBe(0);
  });

  it("admits concurrent managed readers", async () => {
    const gate = new WorkbenchActivityGate();
    const release = deferred();
    const entered: string[] = [];
    const first = gate.runManaged("first reader", async () => {
      entered.push("first");
      await release.promise;
      return 1;
    });
    const second = gate.runManaged("second reader", async () => {
      entered.push("second");
      await release.promise;
      return 2;
    });

    await vi.waitFor(() => expect(entered).toEqual(["first", "second"]));
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  });

  it("records writer intent synchronously and blocks readers arriving behind it", async () => {
    const gate = new WorkbenchActivityGate();
    const releaseReader = deferred();
    const readerEntered = deferred();
    const reader = gate.runManaged("blocking reader", async () => {
      readerEntered.resolve();
      await releaseReader.promise;
    });
    await readerEntered.promise;

    const writerAction = vi.fn(async () => "written");
    const writer = gate.runLifecycle("restart", writerAction);
    await expect(gate.runManaged("late reader", async () => "late")).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
    expect(writerAction).not.toHaveBeenCalled();

    releaseReader.resolve();
    await reader;
    await expect(writer).resolves.toBe("written");
    expect(writerAction).toHaveBeenCalledOnce();
  });

  it("bounds writer admission while existing readers drain and removes timed-out intent", async () => {
    const timing = new ManualTiming();
    const gate = new WorkbenchActivityGate({ restoreTimeoutMs: 25, timing });
    const releaseReader = deferred();
    const readerEntered = deferred();
    const reader = gate.runManaged("blocking reader", async () => {
      readerEntered.resolve();
      await releaseReader.promise;
    });
    await readerEntered.promise;

    const writerAction = vi.fn(async () => undefined);
    const writer = gate.runLifecycle("shutdown", writerAction);
    const rejected = expect(writer).rejects.toMatchObject({ code: "LIFECYCLE_BUSY" });
    timing.fireNext();
    await rejected;
    expect(writerAction).not.toHaveBeenCalled();

    await expect(gate.runManaged("reader after timeout", async () => "admitted")).resolves.toBe(
      "admitted"
    );
    releaseReader.resolve();
    await reader;
    await expect(gate.runLifecycle("later writer", async () => "written")).resolves.toBe(
      "written"
    );
  });

  it("removes a cancelled writer and admits the next FIFO writer without starvation", async () => {
    const gate = new WorkbenchActivityGate();
    const releaseReader = deferred();
    const readerEntered = deferred();
    const reader = gate.runManaged("blocking reader", async () => {
      readerEntered.resolve();
      await releaseReader.promise;
    });
    await readerEntered.promise;

    const controller = new AbortController();
    const cancelledAction = vi.fn(async () => undefined);
    const cancelled = gate.runLifecycle("cancelled writer", cancelledAction, {
      signal: controller.signal,
    });
    const cancelledResult = expect(cancelled).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
    const order: string[] = [];
    const next = gate.runLifecycle("next writer", async () => {
      order.push("next");
      return "done";
    });

    controller.abort("caller stopped waiting");
    await cancelledResult;
    expect(cancelledAction).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    releaseReader.resolve();
    await reader;
    await expect(next).resolves.toBe("done");
    expect(order).toEqual(["next"]);
  });

  it("admits queued writers one at a time in FIFO order", async () => {
    const gate = new WorkbenchActivityGate();
    const releaseFirst = deferred();
    const firstEntered = deferred();
    const order: string[] = [];
    const first = gate.runLifecycle("first writer", async () => {
      order.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-exit");
    });
    await firstEntered.promise;
    const second = gate.runLifecycle("second writer", async () => {
      order.push("second");
    });
    const third = gate.runLifecycle("third writer", async () => {
      order.push("third");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-enter"]);
    releaseFirst.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first-enter", "first-exit", "second", "third"]);
  });

  it("allows only one capture activity lease", () => {
    const gate = new WorkbenchActivityGate({ createLeaseId: () => "capture-a" });
    const lease = gate.acquireCapture(binding);

    expectActivityCode(() => gate.acquireCapture(binding), "ACTIVE_CAPTURE");
    gate.releaseCapture(lease);
    expect(gate.acquireCapture(binding).id).toBe("capture-a");
  });

  it("requests restoration and permits lifecycle work only after release", async () => {
    const action = vi.fn(async () => "done");
    const gate = new WorkbenchActivityGate();
    const lease = gate.acquireCapture(binding);
    lease.signal.addEventListener("abort", () => gate.releaseCapture(lease), { once: true });

    await expect(gate.runLifecycle("restart", action)).resolves.toBe("done");

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({ code: "LIFECYCLE_REQUESTED" });
    expect(action).toHaveBeenCalledOnce();
  });

  it("refuses new capture while lifecycle work is pending or active", async () => {
    let finish!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const actionPromise = new Promise<void>((resolve) => { finish = resolve; });
    const gate = new WorkbenchActivityGate();
    const lifecycle = gate.runLifecycle("cleanup", async () => {
      entered();
      await actionPromise;
    });
    await enteredPromise;

    expectActivityCode(() => gate.acquireCapture(binding), "LIFECYCLE_BUSY");
    finish();
    await lifecycle;
  });

  it("bounds restoration waits and never invokes refused lifecycle work", async () => {
    const timing = new ManualTiming();
    const action = vi.fn(async () => undefined);
    const gate = new WorkbenchActivityGate({ restoreTimeoutMs: 25, timing });
    const lease = gate.acquireCapture(binding);
    const lifecycle = gate.runLifecycle("shutdown", action);
    const rejected = expect(lifecycle).rejects.toMatchObject({ code: "ACTIVE_CAPTURE" });

    expect(lease.signal.reason).toMatchObject({ code: "LIFECYCLE_REQUESTED" });
    timing.fireNext();
    await rejected;
    expect(action).not.toHaveBeenCalled();
  });

  it("releases an unprovable capture into a seal that admits only exact owned shutdown", async () => {
    const gate = new WorkbenchActivityGate();
    const lease = gate.acquireCapture(binding);
    const restartAction = vi.fn(async () => "restarted");
    const queuedRestart = gate.runLifecycle("restart", restartAction);

    expect(lease.signal.reason).toMatchObject({ code: "LIFECYCLE_REQUESTED" });
    gate.requireExactOwnerExit(lease);

    await expect(queuedRestart).rejects.toMatchObject({ code: "LIFECYCLE_BUSY" });
    await expect(gate.runLifecycle("launch", async () => "launched")).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
    await expect(gate.runManaged("ordinary NET call", async () => "called")).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
    expectActivityCode(() => gate.acquireCapture(binding), "LIFECYCLE_BUSY");
    expect(restartAction).not.toHaveBeenCalled();

    await expect(gate.runOwnedShutdown(async (requiredBinding) => {
      expect(requiredBinding).toEqual(binding);
      expect(requiredBinding).not.toBe(binding);
      return "stopped";
    })).resolves.toBe("stopped");
    await expect(gate.runManaged("post-shutdown work", async () => "admitted")).resolves.toBe("admitted");
    const later = gate.acquireCapture(binding);
    gate.releaseCapture(later);
  });

  it("retains the exact-owner-exit seal when owned shutdown fails", async () => {
    const gate = new WorkbenchActivityGate();
    const lease = gate.acquireCapture(binding);
    gate.requireExactOwnerExit(lease);

    await expect(gate.runOwnedShutdown(async () => {
      throw new Error("termination refused");
    })).rejects.toThrow("termination refused");
    await expect(gate.runLifecycle("restart", async () => undefined)).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
    await expect(gate.runOwnedShutdown(async () => "stopped")).resolves.toBe("stopped");
    await expect(gate.runLifecycle("recovery", async () => "recovered")).resolves.toBe("recovered");
  });

  it.each([
    ["generation", { ...binding, generation: "generation-b" }],
    ["canonical target", { ...binding, targetKey: "target-b" }],
  ])("invalidates status from an old %s", (_label, changed) => {
    const gate = new WorkbenchActivityGate();
    const lease = gate.acquireCapture(binding);
    const revision = gate.currentIdleRevision();

    expectActivityCode(() => gate.revalidateCapture(lease, changed), "CAPTURE_INVALIDATED");
    expect(lease.signal.reason).toMatchObject({ code: "IDENTITY_CHANGED" });
    expect(gate.currentIdleRevision()).toBeGreaterThan(revision);
  });

  it("keeps lifecycle mutation blocked after identity drift until restoration explicitly releases", async () => {
    const timing = new ManualTiming();
    const action = vi.fn(async () => undefined);
    const gate = new WorkbenchActivityGate({ restoreTimeoutMs: 25, timing });
    const lease = gate.acquireCapture(binding);

    expectActivityCode(() => gate.revalidateCapture(lease, {
      ...binding,
      generation: "generation-stale",
    }), "CAPTURE_INVALIDATED");
    const lifecycle = gate.runLifecycle("restart", action);
    const rejected = expect(lifecycle).rejects.toMatchObject({ code: "ACTIVE_CAPTURE" });

    timing.fireNext();
    await rejected;
    expect(action).not.toHaveBeenCalled();
    gate.releaseCapture(lease);
  });

  it("invalidates only the capture bound to an unexpectedly exiting exact child", () => {
    const gate = new WorkbenchActivityGate();
    const lease = gate.acquireCapture(binding);

    expect(gate.invalidateForUnexpectedExit({
      ...binding,
      process: { ...binding.process, creationTime: "133900000000000099" },
    })).toBe(false);
    expect(lease.signal.aborted).toBe(false);
    expect(gate.invalidateForUnexpectedExit(binding)).toBe(true);
    expect(lease.signal.reason).toMatchObject({ code: "WORKBENCH_EXITED" });
    expectActivityCode(() => gate.revalidateCapture(lease, binding), "CAPTURE_INVALIDATED");
  });
});

interface RunningHarness {
  root: string;
  projectPath: string;
  config: Config;
  backend: FakeLifecycleBackend;
  guard: WorkbenchProcessGuard;
  client: WorkbenchClient;
  workbench: WorkbenchIdentity;
  state: WorkbenchLifecycleStateV3;
}

async function createRunningHarness(activityGate?: WorkbenchActivityGate): Promise<RunningHarness> {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-activity-"));
  roots.push(root);
  const projectRoot = join(root, "projects");
  const modDirectory = join(projectRoot, "ExampleMod");
  const projectPath = join(modDirectory, "ExampleMod.gproj");
  const toolsRoot = join(root, "tools");
  const gameRoot = join(root, "game");
  const stateDir = join(root, "state");
  mkdirSync(modDirectory, { recursive: true });
  mkdirSync(toolsRoot, { recursive: true });
  mkdirSync(join(gameRoot, "addons"), { recursive: true });
  writeFileSync(projectPath, [
    "GameProject {",
    ' ID "ExampleMod"',
    ' GUID "1122334455667788"',
    "}",
    "",
  ].join("\n"));
  const config: Config = {
    workbenchPath: toolsRoot,
    gamePath: gameRoot,
    dataDir: join(root, "data"),
    patternsDir: join(root, "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    mcpIdleShutdownMs: 1_800_000,
  };
  const backend = createFakeLifecycleBackend();
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir,
    mutexName: `Global\\ReforgerForge.Activity.${root}`,
  });
  const companion = createFakeCompanionLaunch(root);
  const workbench: WorkbenchIdentity = {
    pid: 21_000,
    executablePath: join(toolsRoot, "ArmaReforgerWorkbenchSteamDiag.exe"),
    creationTime: "133900000000021000",
    ownerTokenArgument: guard.ownerArgument("observer-test"),
    launchedAtMs: 1_000,
  };
  const project = canonicalizeGproj(projectPath);
  let state!: WorkbenchLifecycleStateV3;
  await guard.withLifecycleLock(async (session) => {
    const claim = await session.validateAndClaim({
      endpoint: { host: config.workbenchHost, port: config.workbenchPort },
      target: { path: project.displayPath, comparisonKey: project.comparisonKey },
    });
    if (claim.kind === "refused") throw new Error(claim.message);
    backend.addWorkbench(workbench, workbench.ownerTokenArgument);
    state = await session.transition({
      generation: claim.state.generation,
      leaseId: claim.state.mcpOwner?.leaseId ?? null,
    }, {
      phase: "running",
      endpoint: claim.state.endpoint,
      target: claim.state.target,
      mcpOwner: claim.state.mcpOwner,
      workbench,
      companion: companionLifecycleState(companion),
      operation: null,
    });
  });
  const client = new WorkbenchClient(
    config.workbenchHost,
    config.workbenchPort,
    config,
    "activity-test",
    guard,
    { activityGate, companionProvider: fakeCompanionProvider(companion) }
  );
  vi.spyOn(client, "ping").mockResolvedValue(true);
  return { root, projectPath, config, backend, guard, client, workbench, state };
}

async function replaceRunningState(
  harness: RunningHarness,
  overrides: Partial<Pick<
    WorkbenchLifecycleStateV3,
    "phase" | "target" | "workbench" | "operation"
  >> = {}
): Promise<WorkbenchLifecycleStateV3> {
  return harness.guard.withLifecycleLock(async (session) => {
    const read = await session.readState();
    if (read.kind !== "valid") throw new Error("missing running lifecycle state");
    return session.transition({
      generation: read.state.generation,
      leaseId: read.state.mcpOwner?.leaseId ?? null,
    }, {
      phase: overrides.phase ?? "running",
      endpoint: read.state.endpoint,
      target: overrides.target === undefined ? read.state.target : overrides.target,
      mcpOwner: read.state.mcpOwner,
      workbench: overrides.workbench === undefined ? read.state.workbench : overrides.workbench,
      companion: read.state.companion,
      operation: overrides.operation === undefined ? null : overrides.operation,
    });
  });
}

describe("WorkbenchClient observer activity integration", () => {
  it("returns only a verified already-running exact-owned snapshot without launching", async () => {
    const harness = await createRunningHarness();
    const spawnProcess = vi.fn();
    const client = new WorkbenchClient(
      harness.config.workbenchHost,
      harness.config.workbenchPort,
      harness.config,
      "activity-test",
      harness.guard,
      {
        spawnProcess,
        companionProvider: fakeCompanionProvider(createFakeCompanionLaunch(harness.root)),
      }
    );
    vi.spyOn(client, "ping").mockResolvedValue(true);

    await expect(client.getRunningObserverSnapshot()).resolves.toMatchObject({
      generation: harness.state.generation,
      target: { path: canonicalizeGproj(harness.projectPath).displayPath },
      endpoint: { host: "127.0.0.1", port: 5775 },
      process: {
        pid: harness.workbench.pid,
        creationTime: harness.workbench.creationTime,
      },
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(1);
  });

  it.each([
    ["starting", "launch"],
    ["restarting", "restart"],
    ["stopping", "shutdown"],
  ] as const)("does not admit capture during durable %s lifecycle state", async (phase, kind) => {
    const harness = await createRunningHarness();
    await replaceRunningState(harness, {
      phase,
      operation: { kind, operationId: `${kind}-operation` },
    });

    await expect(harness.client.getRunningObserverSnapshot()).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
  });

  it("refuses a stale lifecycle generation and canonical target", async () => {
    const harness = await createRunningHarness();
    const initial = await harness.client.getRunningObserverSnapshot();
    const generationLease = harness.client.acquireCaptureActivity(initial);
    await replaceRunningState(harness);
    await expect(harness.client.revalidateCaptureActivity(generationLease)).rejects.toMatchObject({
      code: "CAPTURE_INVALIDATED",
    });

    const current = await harness.client.getRunningObserverSnapshot();
    expect(() => harness.client.acquireCaptureActivity(current)).toThrow(
      expect.objectContaining({ code: "ACTIVE_CAPTURE" })
    );
    // The adapter, not identity invalidation itself, releases only after its
    // bounded restoration attempt has converged.
    harness.client.releaseCaptureActivity(generationLease);
    const targetLease = harness.client.acquireCaptureActivity(current);
    const otherDirectory = join(harness.root, "projects", "OtherMod");
    const otherPath = join(otherDirectory, "OtherMod.gproj");
    mkdirSync(otherDirectory, { recursive: true });
    writeFileSync(otherPath, "project");
    const other = canonicalizeGproj(otherPath);
    await replaceRunningState(harness, {
      target: { path: other.displayPath, comparisonKey: other.comparisonKey },
    });
    await expect(harness.client.revalidateCaptureActivity(targetLease)).rejects.toMatchObject({
      code: "CAPTURE_INVALIDATED",
    });
    harness.client.releaseCaptureActivity(targetLease);
  });

  it.each([
    ["launch", (harness: RunningHarness) => harness.client.ensureRunning(harness.projectPath)],
    ["restart", (harness: RunningHarness) => harness.client.restartOwnedWorkbench()],
    ["shutdown", (harness: RunningHarness) => harness.client.shutdownOwnedWorkbench()],
  ])("refuses %s before mutex entry or termination when restoration times out", async (
    _kind,
    invoke
  ) => {
    const timing = new ManualTiming();
    const gate = new WorkbenchActivityGate({ restoreTimeoutMs: 10, timing });
    const harness = await createRunningHarness(gate);
    const snapshot = await harness.client.getRunningObserverSnapshot();
    const mutex = vi.spyOn(harness.backend, "withMachineMutex");
    mutex.mockClear();
    const lease = harness.client.acquireCaptureActivity(snapshot);

    const lifecycle = invoke(harness);
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    expect(mutex).not.toHaveBeenCalled();
    const rejected = expect(lifecycle).rejects.toMatchObject({ code: "ACTIVE_CAPTURE" });
    timing.fireNext();
    await rejected;

    expect(mutex).not.toHaveBeenCalled();
    expect(harness.backend.terminationCalls).toHaveLength(0);
  });

  it("lets exact lifecycle termination proceed after the adapter restores and releases", async () => {
    const harness = await createRunningHarness();
    const snapshot = await harness.client.getRunningObserverSnapshot();
    const lease = harness.client.acquireCaptureActivity(snapshot);
    lease.signal.addEventListener(
      "abort",
      () => harness.client.releaseCaptureActivity(lease),
      { once: true }
    );

    await expect(harness.client.shutdownOwnedWorkbench()).resolves.toMatchObject({
      stopped: true,
      previousPid: harness.workbench.pid,
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
  });

  it("exposes an exact-owner-exit seal that blocks restart but admits owned shutdown", async () => {
    const harness = await createRunningHarness();
    const snapshot = await harness.client.getRunningObserverSnapshot();
    const lease = harness.client.acquireCaptureActivity(snapshot);
    const mutex = vi.spyOn(harness.backend, "withMachineMutex");
    mutex.mockClear();

    harness.client.requireExactOwnerExit(lease);
    // Ordinary release is idempotent but cannot erase the stronger exit seal.
    harness.client.releaseCaptureActivity(lease);
    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
    expect(mutex).not.toHaveBeenCalled();
    expect(harness.backend.terminationCalls).toHaveLength(0);

    await expect(harness.client.shutdownOwnedWorkbench()).resolves.toMatchObject({
      stopped: true,
      previousPid: harness.workbench.pid,
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
  });

  it.each([
    ["generation", (value: CaptureActivityBinding): CaptureActivityBinding => ({
      ...value,
      generation: "sealed-stale-generation",
    })],
    ["process", (value: CaptureActivityBinding): CaptureActivityBinding => ({
      ...value,
      process: { ...value.process, creationTime: "133900000000099999" },
    })],
  ])("refuses exact-owner shutdown when the sealed %s does not match durable ownership", async (
    _label,
    change
  ) => {
    const gate = new WorkbenchActivityGate();
    const harness = await createRunningHarness(gate);
    const snapshot = await harness.client.getRunningObserverSnapshot();
    const sealed = change({
      generation: snapshot.generation,
      targetKey: snapshot.target.comparisonKey,
      process: {
        pid: snapshot.process.pid,
        executablePath: snapshot.process.executablePath,
        creationTime: snapshot.process.creationTime,
      },
    });
    const lease = gate.acquireCapture(sealed);
    harness.client.requireExactOwnerExit(lease);

    await expect(harness.client.shutdownOwnedWorkbench()).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    expect(harness.backend.terminationCalls).toHaveLength(0);
    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "LIFECYCLE_BUSY",
    });
  });

  it("invalidates a matching capture immediately when the exact child exits", async () => {
    const harness = await createRunningHarness();
    const executablePath = join(
      harness.config.workbenchPath!,
      "Workbench",
      "ArmaReforgerWorkbenchSteamDiag.exe"
    );
    mkdirSync(join(harness.config.workbenchPath!, "Workbench"), { recursive: true });
    writeFileSync(executablePath, "fake executable");
    const companion = createFakeCompanionLaunch(harness.root);
    const child = Object.assign(new EventEmitter(), {
      pid: 21_001,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      unref: vi.fn(),
    });
    const client = new WorkbenchClient(
      harness.config.workbenchHost,
      harness.config.workbenchPort,
      harness.config,
      "activity-owned-child-test",
      harness.guard,
      {
        companionProvider: fakeCompanionProvider(companion),
        spawnProcess: (command, args) => {
          const ownerArgument = args.find((argument) =>
            argument.startsWith("-reforgerForgeOwnerToken=")
          );
          if (!ownerArgument) throw new Error("test spawn omitted owner credential");
          harness.backend.addWorkbench({
            pid: child.pid,
            executablePath: command,
            creationTime: "133900000000021001",
          }, ownerArgument);
          return child as unknown as ChildProcess;
        },
        companionReadiness: async (options) => ({
          addonId: options.companion.addonId,
          addonGuid: options.companion.addonGuid,
          addonVersion: options.companion.addonVersion,
          protocolVersion: options.companion.protocolVersion,
          workbenchProtocol: options.companion.protocolVersion,
          buildIdentity: options.companion.buildIdentity,
          bundleDigest: options.companion.bundleDigest,
        }),
      }
    );
    vi.spyOn(client, "ping").mockResolvedValue(true);
    await client.restartOwnedWorkbench();
    const snapshot = await client.getRunningObserverSnapshot();
    const lease = client.acquireCaptureActivity(snapshot);

    harness.backend.processes.delete(child.pid);
    harness.backend.workbenchPids.delete(child.pid);
    child.emit("exit", 1, null);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({ code: "WORKBENCH_EXITED" });
    await expect(client.revalidateCaptureActivity(lease)).rejects.toMatchObject({
      code: "CAPTURE_INVALIDATED",
    });
    await vi.waitFor(async () => {
      const read = await harness.guard.readLifecycleState();
      expect(read.kind === "valid" ? read.state.phase : null).toBe("vacant");
    });
  });

  it("maps activity gate failures to stable public Workbench errors", async () => {
    const harness = await createRunningHarness();
    const snapshot = await harness.client.getRunningObserverSnapshot();
    harness.client.acquireCaptureActivity(snapshot);

    try {
      harness.client.acquireCaptureActivity(snapshot);
      throw new Error("expected second capture to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbenchError);
      expect((error as WorkbenchError).code).toBe("ACTIVE_CAPTURE");
    }
  });
});
