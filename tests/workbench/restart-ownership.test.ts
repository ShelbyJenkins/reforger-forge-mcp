import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import {
  WorkbenchClient,
  WorkbenchError,
} from "../../src/workbench/client.js";
import { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";
import { FakeLifecycleBackend } from "./fake-lifecycle-backend.js";
import {
  createFakeCompanionLaunch,
  fakeCompanionProvider,
  WORKBENCH_HELPER_PING_RESPONSE,
} from "./fake-companion.js";

const roots: string[] = [];

class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  readonly kill = vi.fn(() => {
    throw new Error("ChildProcess.kill must never be used for Workbench lifecycle mutations");
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  unref(): void {}
}

interface Harness {
  root: string;
  modDirectory: string;
  projectPath: string;
  executablePath: string;
  config: Config;
  mutexName: string;
  backend: FakeLifecycleBackend;
  guard: WorkbenchProcessGuard;
  client: WorkbenchClient;
  children: FakeChild[];
  spawnOptions: SpawnOptions[];
  spawnArgs: string[][];
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-restart-"));
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
  mkdirSync(modDirectory, { recursive: true });
  mkdirSync(join(toolsRoot, "Workbench"), { recursive: true });
  mkdirSync(join(gamePath, "addons"), { recursive: true });
  writeFileSync(projectPath, "project");
  writeFileSync(executablePath, "fake executable");

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
  const mutexName = `Global\\ReforgerForge.Test.${root}`;
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir,
    mutexName,
  });
  const companion = createFakeCompanionLaunch(root);
  const children: FakeChild[] = [];
  const spawnOptions: SpawnOptions[] = [];
  const spawnArgs: string[][] = [];
  let nextPid = 12_000;
  const client = new WorkbenchClient(
    config.workbenchHost,
    config.workbenchPort,
    config,
    "test-client",
    guard,
    {
      companionProvider: fakeCompanionProvider(companion),
      spawnProcess: (command, args, options) => {
        spawnOptions.push(options);
        spawnArgs.push([...args]);
        const child = new FakeChild(nextPid++);
        const ownerArgument = args.find((arg) =>
          arg.startsWith("-reforgerForgeOwnerToken=")
        );
        if (!ownerArgument) throw new Error("test launch omitted owner token argument");
        backend.addWorkbench({
          pid: child.pid,
          executablePath: command,
          creationTime: String(133_900_000_000_100_000n + BigInt(child.pid)),
        }, ownerArgument);
        children.push(child);
        return child as unknown as ChildProcess;
      },
      launchTimeoutMs: 100,
      launchPollIntervalMs: 1,
    }
  );

  // Process ownership and state transitions remain real; only external TCP
  // readiness timing is removed from these hermetic lifecycle tests.
  (client as unknown as { isPortListening: () => Promise<boolean> }).isPortListening =
    vi.fn().mockResolvedValue(false);
  (client as unknown as {
    waitForCompanionReady: (
      child: ChildProcess,
      error: () => Error | null,
      companion: unknown
    ) => Promise<void>;
  }).waitForCompanionReady = vi.fn().mockResolvedValue(undefined);
  (client as unknown as { waitForPortRelease: () => Promise<void> }).waitForPortRelease =
    vi.fn().mockResolvedValue(undefined);

  return {
    root,
    modDirectory,
    projectPath,
    executablePath,
    config,
    mutexName,
    backend,
    guard,
    client,
    children,
    spawnOptions,
    spawnArgs,
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not receive a TCP port"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}

function addProject(harness: Harness, name: string): string {
  const directory = join(harness.root, "projects", name);
  const projectPath = join(directory, `${name}.gproj`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(projectPath, "project");
  return projectPath;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("exact owner-scoped Workbench restart", () => {
  it("refuses configured NET API calls before touching an unmanaged endpoint", async () => {
    const harness = createHarness();
    const rawCall = vi.spyOn(
      harness.client as unknown as { rawCall: (api: string) => Promise<Record<string, unknown>> },
      "rawCall"
    );

    await expect(harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true }))
      .rejects.toMatchObject({ code: "CONNECTION_REFUSED" });
    expect(rawCall).not.toHaveBeenCalled();
  });

  it("permits calls only after exact lifecycle, process, endpoint, and companion attestation", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    const rawCall = vi.spyOn(
      harness.client as unknown as { rawCall: (api: string) => Promise<Record<string, unknown>> },
      "rawCall"
    ).mockImplementation(async (api) => api === "EMCP_WB_Ping"
      ? WORKBENCH_HELPER_PING_RESPONSE
      : { status: "ok", count: 0 });

    await expect(harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true }))
      .resolves.toMatchObject({ status: "ok", count: 0 });
    expect(rawCall.mock.calls.map(([api]) => api)).toEqual([
      "EMCP_WB_Ping",
      "EMCP_WB_ListEntities",
    ]);
  });
  it("launches an explicit graphical Workbench lifecycle with a visible native viewport", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);

    expect(harness.spawnOptions).toHaveLength(1);
    expect(harness.spawnOptions[0]).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
  });

  it("restarts only the recorded exact process and never calls ChildProcess.kill", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    const restarted = await harness.client.restartOwnedWorkbench();

    expect(launched.action).toBe("launched");
    expect(restarted.previousPid).toBe(launched.pid);
    expect(restarted.pid).not.toBe(launched.pid);
    expect(restarted.gprojPath).toBe(harness.projectPath);
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.terminationCalls[0]).toMatchObject({
      pid: launched.pid,
      creationTime: String(133_900_000_000_100_000n + BigInt(launched.pid)),
    });
    expect(harness.children.every((child) => child.kill.mock.calls.length === 0)).toBe(true);
  });

  it("finishes companion and executable preflight before stopping a healthy process", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    unlinkSync(harness.executablePath);

    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
    });
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.children).toHaveLength(1);
  });

  it("restores running state when exact termination is refused", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    harness.backend.terminationResult = {
      kind: "refused",
      reason: "token_mismatch",
      message: "Owner token no longer matches.",
    };

    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("running");
      expect(read.state.operation).toBeNull();
      expect(read.state.workbench?.pid).toBe(harness.children[0].pid);
    }
    expect(harness.children).toHaveLength(1);
  });

  it("exactly stops and rolls back when the final transaction CAS fails", async () => {
    const harness = createHarness();
    let injected = false;
    harness.backend.replaceFailure = ({ next }) => {
      if (!injected && next.phase === "running" && next.workbench !== null &&
          next.companion !== null) {
        injected = true;
        return new Error("injected final CAS failure");
      }
      return null;
    };

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
    });
    expect(injected).toBe(true);
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("vacant");
      expect(read.state.workbench).toBeNull();
      expect(read.state.companion).not.toBeNull();
    }
  });

  it("terminates the exact failed launch before returning to vacant", async () => {
    const harness = createHarness();
    (harness.client as unknown as {
      waitForCompanionReady: () => Promise<void>;
    }).waitForCompanionReady = vi.fn().mockRejectedValue(new WorkbenchError(
      "injected readiness failure",
      "LAUNCH_FAILED"
    ));

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("vacant");
      expect(read.state.workbench).toBeNull();
      expect(read.state.companion).not.toBeNull();
    }
  });

  it("rolls back when a foreign endpoint answers ping while the spawned child stays alive", async () => {
    const harness = createHarness();
    harness.backend.endpointOwnershipResult = {
      kind: "refused",
      reason: "listener_pid_mismatch",
      message: "listener belongs to injected foreign PID 44004",
    };

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    expect(harness.children).toHaveLength(1);
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(1);
    expect(harness.backend.endpointOwnershipCalls[0].expected.pid).toBe(harness.children[0].pid);
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("vacant");
      expect(read.state.workbench).toBeNull();
      expect(read.state.companion).not.toBeNull();
    }
  });

  it("preserves the live failed-launch transaction when exact stop is refused", async () => {
    const harness = createHarness();
    (harness.client as unknown as {
      waitForCompanionReady: () => Promise<void>;
    }).waitForCompanionReady = vi.fn().mockRejectedValue(new WorkbenchError(
      "injected readiness failure",
      "LAUNCH_FAILED"
    ));
    harness.backend.terminationResult = {
      kind: "refused",
      reason: "access_denied",
      message: "injected exact-stop refusal",
    };

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(1);
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("starting");
      expect(read.state.workbench).not.toBeNull();
      expect(read.state.companion).not.toBeNull();
    }
  });

  it("shuts down exactly and makes a second shutdown a no-op", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    const shutdown = await harness.client.shutdownOwnedWorkbench();

    expect(shutdown).toMatchObject({ stopped: true, previousPid: launched.pid });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.children[0].kill).not.toHaveBeenCalled();

    const secondShutdown = await harness.client.shutdownOwnedWorkbench();
    expect(secondShutdown.stopped).toBe(false);
    expect(secondShutdown.previousPid).toBeNull();
    expect(harness.backend.terminationCalls).toHaveLength(1);
  });

  it("shuts down the exact owned process after its recorded .gproj is deleted", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    unlinkSync(harness.projectPath);

    const shutdown = await harness.client.shutdownOwnedWorkbench();

    expect(shutdown).toMatchObject({
      stopped: true,
      previousPid: launched.pid,
      gprojPath: harness.projectPath,
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.terminationCalls[0].pid).toBe(launched.pid);
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("vacant");
      expect(read.state.target?.path).toBe(harness.projectPath);
      expect(read.state.workbench).toBeNull();
    }
  });

  it("still revalidates the recorded .gproj before restart", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    unlinkSync(harness.projectPath);

    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "INVALID_TARGET",
    });
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.backend.workbenchPids.has(launched.pid)).toBe(true);
  });

  it("fails closed when this MCP has no exact running owner", async () => {
    const harness = createHarness();
    try {
      await harness.client.restartOwnedWorkbench();
      throw new Error("expected restart refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbenchError);
      expect((error as WorkbenchError).code).toBe("LAUNCH_FAILED");
      expect((error as Error).message).toMatch(/no exact owned Workbench/i);
    }
    expect(harness.backend.terminationCalls).toHaveLength(0);
  });

  it("re-proves the live owner token before reporting target reuse", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    harness.backend.ownerArguments.set(
      launched.pid,
      "-reforgerForgeOwnerToken=not-the-recorded-owner"
    );

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    expect(harness.children).toHaveLength(1);
    expect(harness.backend.terminationCalls).toHaveLength(0);
  });

  it("re-proves endpoint ownership before reusing a recorded running session", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(1);
    vi.spyOn(harness.client, "ping").mockResolvedValue(true);
    harness.backend.endpointOwnershipResult = {
      kind: "refused",
      reason: "listener_pid_mismatch",
      message: "listener moved to foreign PID 55100",
    };

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(2);
    expect(harness.backend.endpointOwnershipCalls[1].expected.pid).toBe(launched.pid);
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.backend.workbenchPids.has(launched.pid)).toBe(true);
  });

  it("re-proves endpoint ownership before recovering a starting session", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    await harness.guard.withLifecycleLock(async (session) => {
      const read = await session.readState();
      if (read.kind !== "valid") throw new Error("missing lifecycle state");
      const state = read.state;
      const mcpOwner = state.mcpOwner;
      if (!mcpOwner) throw new Error("missing lifecycle owner");
      await session.transition(
        { generation: state.generation, leaseId: mcpOwner.leaseId },
        {
          phase: "starting",
          endpoint: state.endpoint,
          target: state.target,
          mcpOwner,
          workbench: state.workbench,
          companion: state.companion,
          operation: { kind: "launch", operationId: "recovery-fixture" },
        }
      );
    });
    vi.spyOn(harness.client, "ping").mockResolvedValue(true);
    harness.backend.endpointOwnershipResult = {
      kind: "refused",
      reason: "listener_pid_mismatch",
      message: "foreign endpoint answered recovery ping",
    };

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(2);
    expect(harness.backend.endpointOwnershipCalls[1].expected.pid).toBe(launched.pid);
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.backend.workbenchPids.has(launched.pid)).toBe(true);
  });

  it("blocks every lifecycle mutation from a second live MCP lease", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    const contenderGuard = new WorkbenchProcessGuard({
      backend: harness.backend,
      stateDir: harness.guard.stateDir,
      mutexName: harness.mutexName,
    });
    const contender = new WorkbenchClient(
      harness.config.workbenchHost,
      harness.config.workbenchPort,
      harness.config,
      "contender",
      contenderGuard,
      {
        companionProvider: fakeCompanionProvider(createFakeCompanionLaunch(
          join(harness.root, "contender-helper")
        )),
      }
    );

    await expect(contender.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "OWNED_BY_OTHER_MCP",
    });
    await expect(contender.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "OWNED_BY_OTHER_MCP",
    });
    await expect(contender.shutdownOwnedWorkbench()).rejects.toMatchObject({
      code: "OWNED_BY_OTHER_MCP",
    });
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.children).toHaveLength(1);
  });

  it("deduplicates concurrent launches of the same canonical target", async () => {
    const harness = createHarness();
    let releaseReady!: () => void;
    let enteredReady!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredReady = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseReady = resolvePromise; });
    (harness.client as unknown as {
      waitForCompanionReady: () => Promise<void>;
    }).waitForCompanionReady = vi.fn(async () => {
      enteredReady();
      await blocked;
    });

    const first = harness.client.ensureRunning(harness.projectPath);
    await entered;
    const sameTargetSpelling = join(
      harness.modDirectory,
      ".",
      "ExampleMod.gproj"
    );
    const second = harness.client.ensureRunning(sameTargetSpelling);
    releaseReady();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(harness.children).toHaveLength(1);
  });

  it("refuses a different target while a launch is active", async () => {
    const harness = createHarness();
    const otherProject = addProject(harness, "OtherMod");
    let releaseReady!: () => void;
    let enteredReady!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredReady = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseReady = resolvePromise; });
    (harness.client as unknown as {
      waitForCompanionReady: () => Promise<void>;
    }).waitForCompanionReady = vi.fn(async () => {
      enteredReady();
      await blocked;
    });

    const launching = harness.client.ensureRunning(harness.projectPath);
    await entered;
    await expect(harness.client.ensureRunning(otherProject)).rejects.toMatchObject({
      code: "TARGET_CONFLICT",
    });
    releaseReady();
    await launching;

    expect(harness.children).toHaveLength(1);
  });

  it("refuses target B while restart A is paused after exact old-process exit", async () => {
    const harness = createHarness();
    const otherProject = addProject(harness, "OtherMod");
    await harness.client.ensureRunning(harness.projectPath);
    let releasePort!: () => void;
    let enteredPort!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredPort = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releasePort = resolvePromise; });
    (harness.client as unknown as {
      waitForPortRelease: () => Promise<void>;
    }).waitForPortRelease = vi.fn(async () => {
      enteredPort();
      await blocked;
    });

    const restarting = harness.client.restartOwnedWorkbench();
    await entered;
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    await expect(harness.client.ensureRunning(otherProject)).rejects.toMatchObject({
      code: "TARGET_CONFLICT",
    });
    releasePort();
    await restarting;

    expect(harness.children).toHaveLength(2);
  });

  it("deduplicates concurrent restarts of the same canonical target", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    let releasePort!: () => void;
    let enteredPort!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredPort = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releasePort = resolvePromise; });
    (harness.client as unknown as {
      waitForPortRelease: () => Promise<void>;
    }).waitForPortRelease = vi.fn(async () => {
      enteredPort();
      await blocked;
    });

    const first = harness.client.restartOwnedWorkbench();
    await entered;
    const second = harness.client.restartOwnedWorkbench();
    releasePort();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.children).toHaveLength(2);
  });

  it("invalidates cached state immediately and reconciles after an owned child exits", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    const child = harness.children[0];
    expect(harness.client.state.connected).toBe(true);
    const beforeExit = await harness.guard.readLifecycleState();
    expect(beforeExit.kind).toBe("valid");
    if (beforeExit.kind === "valid") {
      expect((harness.client as unknown as {
        ownedChild: { generation: string };
      }).ownedChild.generation).toBe(beforeExit.state.generation);
    }
    harness.backend.processes.delete(launched.pid);
    harness.backend.workbenchPids.delete(launched.pid);
    child.exitCode = 7;
    child.emit("exit", 7, null);

    expect(harness.client.state).toMatchObject({ connected: false, mode: "unknown" });
    await vi.waitFor(async () => {
      const read = await harness.guard.readLifecycleState();
      expect(read.kind).toBe("valid");
      if (read.kind === "valid") {
        expect(read.state.phase).toBe("vacant");
        expect(read.state.workbench).toBeNull();
      }
    });
  });

  it("reconciles an unexpected exact-child exit after the .gproj is deleted", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    const child = harness.children[0];
    unlinkSync(harness.projectPath);
    harness.backend.processes.delete(launched.pid);
    harness.backend.workbenchPids.delete(launched.pid);
    child.exitCode = 9;
    child.emit("exit", 9, null);

    await vi.waitFor(async () => {
      const read = await harness.guard.readLifecycleState();
      expect(read.kind).toBe("valid");
      if (read.kind === "valid") {
        expect(read.state.phase).toBe("vacant");
        expect(read.state.target?.path).toBe(harness.projectPath);
        expect(read.state.workbench).toBeNull();
      }
    });
  });

  it("ignores a stale old-child exit after a replacement is running", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    const oldChild = harness.children[0];
    const restarted = await harness.client.restartOwnedWorkbench();
    expect(harness.client.state.connected).toBe(true);

    oldChild.exitCode = 0;
    oldChild.emit("exit", 0, null);
    await Promise.resolve();

    expect(harness.client.state.connected).toBe(true);
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("running");
      expect(read.state.workbench?.pid).toBe(restarted.pid);
    }
  });

  it("waits until the NET API port is actually released", async () => {
    const server = createServer((socket) => socket.destroy());
    const port = await listen(server);
    const harness = createHarness();
    const client = new WorkbenchClient("127.0.0.1", port, {
      ...harness.config,
      workbenchPort: port,
    });

    let settled = false;
    const waiting = (client as unknown as { waitForPortRelease: () => Promise<void> })
      .waitForPortRelease()
      .then(() => { settled = true; });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(settled).toBe(false);

    await close(server);
    await expect(waiting).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});
