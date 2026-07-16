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
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Config } from "../../src/config.js";
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
import {
  WorkbenchProcessGuard,
  type WorkbenchIdentity,
  type WorkbenchLifecycleStateV2,
} from "../../src/workbench/process-guard.js";
import { FakeLifecycleBackend } from "./fake-lifecycle-backend.js";

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

function expectActivityCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected activity operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkbenchActivityError);
    expect((error as WorkbenchActivityError).code).toBe(code);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkbenchActivityGate", () => {
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

  it.each([
    ["generation", { ...binding, generation: "generation-b" }],
    ["canonical target", { ...binding, targetKey: "target-b" }],
  ])("invalidates status from an old %s", (_label, changed) => {
    const gate = new WorkbenchActivityGate();
    const lease = gate.acquireCapture(binding);

    expectActivityCode(() => gate.revalidateCapture(lease, changed), "CAPTURE_INVALIDATED");
    expect(lease.signal.reason).toMatchObject({ code: "IDENTITY_CHANGED" });
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
  state: WorkbenchLifecycleStateV2;
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
  writeFileSync(projectPath, "project");
  const config: Config = {
    workbenchPath: toolsRoot,
    projectPath: projectRoot,
    gamePath: gameRoot,
    dataDir: join(root, "data"),
    patternsDir: join(root, "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
  const backend = new FakeLifecycleBackend();
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir,
    legacyStatePath: join(root, "legacy.json"),
    mutexName: `Global\\ReforgerForge.Activity.${root}`,
  });
  const workbench: WorkbenchIdentity = {
    pid: 21_000,
    executablePath: join(toolsRoot, "ArmaReforgerWorkbenchSteamDiag.exe"),
    creationTime: "133900000000021000",
    ownerTokenArgument: guard.ownerArgument("observer-test"),
    launchedAtMs: 1_000,
  };
  const project = canonicalizeGproj(projectPath);
  let state!: WorkbenchLifecycleStateV2;
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
      handler: null,
      operation: null,
    });
  });
  const client = new WorkbenchClient(
    config.workbenchHost,
    config.workbenchPort,
    config,
    "activity-test",
    guard,
    { activityGate }
  );
  return { root, projectPath, config, backend, guard, client, workbench, state };
}

async function replaceRunningState(
  harness: RunningHarness,
  overrides: Partial<Pick<
    WorkbenchLifecycleStateV2,
    "phase" | "target" | "workbench" | "operation"
  >> = {}
): Promise<WorkbenchLifecycleStateV2> {
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
      handler: read.state.handler,
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
      { spawnProcess }
    );

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
    ["cleaning", "cleanup"],
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
    ["cleanup", (harness: RunningHarness) =>
      harness.client.cleanupHandlerScripts(dirname(harness.projectPath))],
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

  it("invalidates a matching capture immediately when the exact child exits", async () => {
    const harness = await createRunningHarness();
    const snapshot = await harness.client.getRunningObserverSnapshot();
    const lease = harness.client.acquireCaptureActivity(snapshot);
    const child = new EventEmitter() as EventEmitter & { pid: number };
    child.pid = harness.workbench.pid;
    (harness.client as unknown as {
      attachOwnedChild(
        child: ChildProcess,
        identity: WorkbenchIdentity,
        generation: string,
        targetKey: string
      ): unknown;
    }).attachOwnedChild(
      child as unknown as ChildProcess,
      harness.workbench,
      snapshot.generation,
      snapshot.target.comparisonKey
    );

    harness.backend.processes.delete(harness.workbench.pid);
    harness.backend.workbenchPids.delete(harness.workbench.pid);
    child.emit("exit", 1, null);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({ code: "WORKBENCH_EXITED" });
    await expect(harness.client.revalidateCaptureActivity(lease)).rejects.toMatchObject({
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
