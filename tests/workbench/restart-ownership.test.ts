import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import {
  WorkbenchClient,
  WorkbenchError,
  type WorkbenchClientDependencies,
} from "../../src/workbench/client.js";
import type {
  WorkbenchNetApiCallOptions,
  WorkbenchNetApiPort,
} from "../../src/workbench/net-api-client.js";
import {
  waitForVacancy,
  type CompanionReadinessOptions,
  type WorkbenchCompanionIdentity,
} from "../../src/workbench/readiness.js";
import { LifecycleGuardError } from "../../src/workbench/process-guard.js";
import {
  createFakeLifecycleBackend,
  type FakeLifecycleBackend,
} from "./fake-lifecycle-backend.js";
import {
  createFakeCompanionLaunch,
  fakeCompanionProvider,
  WORKBENCH_HELPER_PING_RESPONSE,
} from "./fake-companion.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";

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
  companionProvider: ReturnType<typeof fakeCompanionProvider>;
  verifyStaged: ReturnType<typeof vi.fn>;
  netApiCall: Mock<TestNetApiCall>;
  children: FakeChild[];
  spawnOptions: SpawnOptions[];
  spawnArgs: string[][];
}

type TestNetApiCall = (
  apiFunc: string,
  params?: Record<string, unknown>,
  options?: WorkbenchNetApiCallOptions
) => Promise<Record<string, unknown>>;

interface HarnessOptions {
  companionReadiness?: NonNullable<WorkbenchClientDependencies["companionReadiness"]>;
  vacancyWait?: NonNullable<WorkbenchClientDependencies["vacancyWait"]>;
  lifecycleDeadlineAtMs?: NonNullable<WorkbenchClientDependencies["lifecycleDeadlineAtMs"]>;
  requestDeadlineAtMs?: NonNullable<WorkbenchClientDependencies["requestDeadlineAtMs"]>;
  now?: NonNullable<WorkbenchClientDependencies["now"]>;
}

function createHarness(options: HarnessOptions = {}): Harness {
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
  };
  const backend = createFakeLifecycleBackend();
  const mutexName = `Global\\ReforgerForge.Test.${root}`;
  const guard = new WorkbenchProcessGuard({
    backend,
    stateDir,
    mutexName,
    beforeLifecycleReplace: (args) => backend.replaceFailure?.(args) ?? undefined,
    afterLifecycleReplace: (args) => backend.afterReplace?.(args),
  });
  const companion = createFakeCompanionLaunch(root);
  const companionProvider = fakeCompanionProvider(companion);
  const verifyStaged = vi.fn(companionProvider.verifyStaged!.bind(companionProvider));
  companionProvider.verifyStaged = verifyStaged;
  const children: FakeChild[] = [];
  const spawnOptions: SpawnOptions[] = [];
  const spawnArgs: string[][] = [];
  let nextPid = 12_000;
  const netApiCall = vi.fn<TestNetApiCall>(async (apiFunc) => apiFunc === "EMCP_WB_Ping"
    ? WORKBENCH_HELPER_PING_RESPONSE
    : { status: "ok" });
  const netApi: WorkbenchNetApiPort = {
    call: netApiCall as WorkbenchNetApiPort["call"],
  };
  const client = new WorkbenchClient(
    config.workbenchHost,
    config.workbenchPort,
    config,
    "test-client",
    guard,
    {
      companionProvider,
      netApi,
      companionReadiness: options.companionReadiness,
      vacancyWait: options.vacancyWait,
      lifecycleDeadlineAtMs: options.lifecycleDeadlineAtMs,
      requestDeadlineAtMs: options.requestDeadlineAtMs,
      now: options.now,
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
    companionProvider,
    verifyStaged,
    netApiCall,
    children,
    spawnOptions,
    spawnArgs,
  };
}

function addProject(harness: Harness, name: string): string {
  const directory = join(harness.root, "projects", name);
  const projectPath = join(directory, `${name}.gproj`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(projectPath, "project");
  return projectPath;
}

function readinessIdentity(
  options: CompanionReadinessOptions
): WorkbenchCompanionIdentity {
  return {
    addonId: options.companion.addonId,
    addonGuid: options.companion.addonGuid,
    addonVersion: options.companion.addonVersion,
    protocolVersion: options.companion.protocolVersion,
    workbenchProtocol: options.companion.protocolVersion,
    buildIdentity: options.companion.buildIdentity,
    bundleDigest: options.companion.bundleDigest,
  };
}

afterEach(async () => {
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("exact owner-scoped Workbench restart", () => {
  it("refuses configured NET API calls before touching an unmanaged endpoint", async () => {
    const harness = createHarness();

    await expect(harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true }))
      .rejects.toMatchObject({ code: "CONNECTION_REFUSED" });
    expect(harness.netApiCall).not.toHaveBeenCalled();
  });

  it("permits calls only after exact lifecycle, process, endpoint, and companion attestation", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    harness.netApiCall.mockClear();
    harness.netApiCall.mockImplementation(async (api) => api === "EMCP_WB_Ping"
      ? WORKBENCH_HELPER_PING_RESPONSE
      : { status: "ok", count: 0 });

    await expect(harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true }))
      .resolves.toMatchObject({ status: "ok", count: 0 });
    expect(harness.netApiCall.mock.calls.map(([api]) => api)).toEqual([
      "EMCP_WB_Ping",
      "EMCP_WB_ListEntities",
    ]);
  });

  it("recomputes the NET timeout after managed-authority prechecks consume budget", async () => {
    let now = 1_000;
    let requestDeadlineAtMs: number | undefined;
    const harness = createHarness({
      now: () => now,
      requestDeadlineAtMs: () => requestDeadlineAtMs,
    });
    await harness.client.ensureRunning(harness.projectPath);
    harness.netApiCall.mockClear();
    requestDeadlineAtMs = 1_100;
    harness.netApiCall.mockImplementation(async (api) => {
      if (api === "EMCP_WB_Ping") {
        now = 1_080;
        return WORKBENCH_HELPER_PING_RESPONSE;
      }
      return { status: "ok", count: 0 };
    });

    await expect(harness.client.call("EMCP_WB_ListEntities", {}, {
      timeout: 500,
      skipAutoLaunch: true,
    })).resolves.toMatchObject({ status: "ok", count: 0 });

    const targetCall = harness.netApiCall.mock.calls.find(
      ([api]) => api === "EMCP_WB_ListEntities"
    );
    expect(targetCall?.[2]).toEqual({ timeoutMs: 20 });
  });

  it("shares immutable companion attestation across two consumers of one facade/controller", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    const launchAttestations = harness.verifyStaged.mock.calls.length;
    const toolConsumer = harness.client;
    const observerConsumer = harness.client;
    expect(toolConsumer).toBe(observerConsumer);
    harness.netApiCall.mockImplementation(async (api) => api === "EMCP_WB_Ping"
      ? WORKBENCH_HELPER_PING_RESPONSE
      : { status: "ok" });

    await toolConsumer.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    await observerConsumer.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(1);

    await harness.guard.withLifecycleLock(async (session) => {
      const read = await session.readState();
      if (read.kind !== "valid" || !read.state.mcpOwner) throw new Error("missing running state");
      await session.transition(
        { generation: read.state.generation, leaseId: read.state.mcpOwner.leaseId },
        {
          phase: read.state.phase,
          endpoint: read.state.endpoint,
          target: read.state.target,
          mcpOwner: read.state.mcpOwner,
          workbench: read.state.workbench,
          companion: read.state.companion,
          operation: read.state.operation,
        }
      );
    });
    await harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(2);
  });

  it("invalidates immutable attestation when the recorded bundle digest changes", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    const launchAttestations = harness.verifyStaged.mock.calls.length;
    harness.netApiCall.mockImplementation(async (api) => api === "EMCP_WB_Ping"
      ? WORKBENCH_HELPER_PING_RESPONSE
      : { status: "ok" });

    await harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(1);

    await harness.guard.withLifecycleLock(async (session) => {
      const read = await session.readState();
      if (read.kind !== "valid" || !read.state.mcpOwner || !read.state.companion) {
        throw new Error("missing running companion state");
      }
      await session.transition(
        { generation: read.state.generation, leaseId: read.state.mcpOwner.leaseId },
        {
          phase: read.state.phase,
          endpoint: read.state.endpoint,
          target: read.state.target,
          mcpOwner: read.state.mcpOwner,
          workbench: read.state.workbench,
          companion: {
            ...read.state.companion,
            bundleDigest: "b".repeat(64),
          },
          operation: read.state.operation,
        }
      );
    });

    await harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(2);
    expect(harness.verifyStaged.mock.calls.at(-1)?.[0]).toMatchObject({
      bundleDigest: "b".repeat(64),
    });
  });

  it("does not cache a failed process or endpoint qualification", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    const launchAttestations = harness.verifyStaged.mock.calls.length;
    harness.backend.endpointOwnershipResult = {
      kind: "refused",
      reason: "listener_pid_mismatch",
      message: "listener temporarily belongs to another process",
    };

    await expect(harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true }))
      .rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    harness.backend.endpointOwnershipResult = null;
    await expect(harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true }))
      .resolves.toMatchObject({ status: "ok" });

    expect(harness.verifyStaged.mock.calls.length - launchAttestations).toBe(2);
  });

  it("runs companion staging and retention outside the machine mutex", async () => {
    const harness = createHarness();
    harness.companionProvider.status = () => ({
      installed: true,
      managedRoot: join(harness.root, "managed-helper"),
      roleRoot: join(harness.root, "managed-helper"),
      currentBundleDigest: "a".repeat(64),
      stagedDigests: ["a".repeat(64)],
      managedBytes: 0,
      staleCaptureCount: 0,
      warnings: [],
    });
    harness.companionProvider.applyRetention = () => ({
      removedDigestRoots: [],
      removedCaptureFiles: [],
      removedTemporaryRoots: [],
      reclaimedBytes: 0,
      remainingBytes: 0,
    });
    const originalMutex = harness.backend.withMachineMutex.bind(harness.backend);
    let mutexDepth = 0;
    harness.backend.withMachineMutex = async (args) => originalMutex({
      ...args,
      action: async () => {
        mutexDepth += 1;
        try {
          return await args.action();
        } finally {
          mutexDepth -= 1;
        }
      },
    });
    const ensureStaged = harness.companionProvider.ensureStaged.bind(
      harness.companionProvider
    );
    const applyRetention = harness.companionProvider.applyRetention!.bind(
      harness.companionProvider
    );
    harness.companionProvider.ensureStaged = vi.fn((target) => {
      expect(mutexDepth).toBe(0);
      return ensureStaged(target);
    });
    harness.companionProvider.applyRetention = vi.fn((options) => {
      expect(mutexDepth).toBe(0);
      return applyRetention(options);
    });

    await expect(harness.client.ensureManagedCompanion(harness.projectPath))
      .resolves.toMatchObject({ action: "staged" });
    await expect(harness.client.applyManagedCompanionRetention())
      .resolves.toMatchObject({ removedDigestRoots: [] });
    expect(harness.companionProvider.ensureStaged).toHaveBeenCalledTimes(1);
    expect(harness.companionProvider.applyRetention).toHaveBeenCalledTimes(2);
    expect(mutexDepth).toBe(0);
  });

  it("publishes a durable reservation before uninstalling from a missing lifecycle", async () => {
    const harness = createHarness();
    const contenderGuard = new WorkbenchProcessGuard({
      backend: harness.backend,
      stateDir: harness.guard.stateDir,
      mutexName: harness.mutexName,
    });
    let contenderAttempt: ReturnType<typeof contenderGuard.withLifecycleLock> | null = null;
    let reservedBeforeUninstall: {
      phase: string;
      workbench: unknown;
      operation: { kind: string } | null;
    } | null = null;
    harness.backend.afterReplace = ({ next }) => {
      if (next.phase === "starting" && next.workbench === null && next.operation?.kind === "recovery") {
        reservedBeforeUninstall = {
          phase: next.phase,
          workbench: next.workbench,
          operation: next.operation,
        };
      }
    };
    harness.companionProvider.uninstall = vi.fn(() => {
      expect(reservedBeforeUninstall).toMatchObject({
        phase: "starting",
        workbench: null,
        operation: { kind: "recovery" },
      });
      contenderAttempt = contenderGuard.withLifecycleLock((session) =>
        session.validateAndClaim({
          endpoint: {
            host: harness.config.workbenchHost,
            port: harness.config.workbenchPort,
          },
          target: null,
        })
      );
      return { removed: true, roleRoot: join(harness.root, "managed-helper") };
    });

    await expect(harness.client.uninstallManagedCompanion()).resolves.toMatchObject({
      removed: true,
    });
    await expect(contenderAttempt).resolves.toMatchObject({
      kind: "refused",
      code: "OWNED_BY_OTHER_MCP",
    });
    const read = await harness.guard.readLifecycleState();
    expect(read).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, companion: null, operation: null },
    });
  });

  it("releases the machine mutex while an ordinary managed NET request is blocked", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    let enteredCall!: () => void;
    let releaseCall!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredCall = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseCall = resolvePromise; });
    harness.netApiCall.mockImplementation(async (api) => {
      if (api === "EMCP_WB_Ping") return WORKBENCH_HELPER_PING_RESPONSE;
      enteredCall();
      await blocked;
      return { status: "ok", count: 1 };
    });

    const request = harness.client.call("EMCP_WB_ListEntities", {}, { skipAutoLaunch: true });
    await entered;
    const contenderRead = await harness.guard.withLifecycleLock((session) => session.readState());
    expect(contenderRead).toMatchObject({ kind: "valid", state: { phase: "running" } });
    const previousPid = harness.children[0].pid;
    const restarting = harness.client.restartOwnedWorkbench();
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(harness.backend.terminationCalls).toHaveLength(0);

    releaseCall();
    await expect(request).resolves.toMatchObject({ status: "ok", count: 1 });
    await expect(restarting).resolves.toMatchObject({ previousPid });
    expect(harness.children).toHaveLength(2);
  });

  it("refuses stale local state publication when generation changes during an unlocked NET call", async () => {
    const harness = createHarness();
    await harness.client.ensureRunning(harness.projectPath);
    let enteredCall!: () => void;
    let releaseCall!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredCall = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseCall = resolvePromise; });
    harness.netApiCall.mockImplementation(async (api) => {
      if (api === "EMCP_WB_Ping") return WORKBENCH_HELPER_PING_RESPONSE;
      enteredCall();
      await blocked;
      return { status: "ok", mode: "edit" };
    });

    const request = harness.client.call("EMCP_WB_GetState", {}, { skipAutoLaunch: true });
    await entered;
    await harness.guard.withLifecycleLock(async (session) => {
      const read = await session.readState();
      if (read.kind !== "valid" || !read.state.mcpOwner) throw new Error("missing running state");
      await session.transition(
        { generation: read.state.generation, leaseId: read.state.mcpOwner.leaseId },
        {
          phase: read.state.phase,
          endpoint: read.state.endpoint,
          target: read.state.target,
          mcpOwner: read.state.mcpOwner,
          workbench: read.state.workbench,
          companion: read.state.companion,
          operation: read.state.operation,
        }
      );
    });
    let releaseFinalMutex!: () => void;
    let finalMutexHeld!: () => void;
    const releaseMutex = new Promise<void>((resolve) => { releaseFinalMutex = resolve; });
    const mutexHeld = new Promise<void>((resolve) => { finalMutexHeld = resolve; });
    const holder = harness.guard.withLifecycleLock(async () => {
      finalMutexHeld();
      await releaseMutex;
    });
    await mutexHeld;
    releaseCall();
    const requestError = request.catch((error: unknown) => error);

    // The NET response is provisional until its lock-free exact-generation
    // check completes. A stale response invalidates the local cache immediately.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.client.state).toMatchObject({ connected: false, mode: "unknown" });
    releaseFinalMutex();
    await holder;

    await expect(requestError).resolves.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.client.state).toMatchObject({ connected: false, mode: "unknown" });
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
    const harness = createHarness({
      companionReadiness: async () => {
        throw new WorkbenchError("injected readiness failure", "LAUNCH_FAILED");
      },
    });

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    expect(harness.client.diagnosticSupervisedChildCounts()).toEqual({
      active: 0,
      reconciling: 0,
      total: 0,
    });
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("vacant");
      expect(read.state.workbench).toBeNull();
      expect(read.state.companion).not.toBeNull();
    }
  });

  it("drains old and failed replacement supervision before a later operation", async () => {
    let readinessAttempt = 0;
    const harness = createHarness({
      companionReadiness: async (options) => {
        readinessAttempt += 1;
        if (readinessAttempt === 2) {
          throw new WorkbenchError("injected replacement readiness failure", "LAUNCH_FAILED");
        }
        return readinessIdentity(options);
      },
    });
    const launched = await harness.client.ensureRunning(harness.projectPath);
    expect(harness.client.diagnosticSupervisedChildCounts()).toEqual({
      active: 1,
      reconciling: 0,
      total: 1,
    });

    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
    });
    expect(harness.backend.terminationCalls.map((call) => call.pid)).toEqual([
      launched.pid,
      harness.children[1].pid,
    ]);
    expect(harness.backend.workbenchPids.size).toBe(0);
    expect(harness.client.diagnosticSupervisedChildCounts()).toEqual({
      active: 0,
      reconciling: 0,
      total: 0,
    });

    const relaunched = await harness.client.ensureRunning(harness.projectPath);
    expect(relaunched).toMatchObject({
      action: "launched",
      pid: harness.children[2].pid,
    });
    expect(harness.client.diagnosticSupervisedChildCounts()).toEqual({
      active: 1,
      reconciling: 0,
      total: 1,
    });
    await harness.client.shutdownOwnedWorkbench();
    expect(harness.client.diagnosticSupervisedChildCounts()).toEqual({
      active: 0,
      reconciling: 0,
      total: 0,
    });
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
    const harness = createHarness({
      companionReadiness: async () => {
        throw new WorkbenchError("injected readiness failure", "LAUNCH_FAILED");
      },
    });
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

  it("spawns only after native vacancy proof and distinguishes occupied from unverifiable", async () => {
    const occupied = createHarness();
    occupied.backend.endpointVacancyResult = {
      kind: "occupied",
      listenerPid: 55_101,
      message: "foreign listener",
    };
    await expect(occupied.client.ensureRunning(occupied.projectPath)).rejects.toMatchObject({
      code: "UNOWNED_WORKBENCH",
    });
    expect(occupied.children).toHaveLength(0);

    const unverifiable = createHarness();
    unverifiable.backend.endpointVacancyResult = {
      kind: "unverifiable",
      reason: "timeout",
      message: "native endpoint probe timed out",
    };
    await expect(unverifiable.client.ensureRunning(unverifiable.projectPath)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    expect(unverifiable.children).toHaveLength(0);

    const helperFailure = createHarness();
    helperFailure.backend.verifyEndpointVacant = vi.fn().mockRejectedValue(
      new Error("native vacancy helper returned invalid JSON")
    );
    await expect(helperFailure.client.ensureRunning(helperFailure.projectPath)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
    });
    expect(helperFailure.children).toHaveLength(0);
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
    const ping = vi.spyOn(harness.client, "ping").mockResolvedValue(true);
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
    expect(ping).not.toHaveBeenCalled();
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
    const ping = vi.spyOn(harness.client, "ping").mockResolvedValue(true);
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
    expect(ping).not.toHaveBeenCalled();
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
    let releaseReady!: () => void;
    let enteredReady!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredReady = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseReady = resolvePromise; });
    const harness = createHarness({
      companionReadiness: async (options) => {
        enteredReady();
        await blocked;
        return readinessIdentity(options);
      },
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
    let releaseReady!: () => void;
    let enteredReady!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredReady = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseReady = resolvePromise; });
    const harness = createHarness({
      companionReadiness: async (options) => {
        enteredReady();
        await blocked;
        return readinessIdentity(options);
      },
    });
    const otherProject = addProject(harness, "OtherMod");

    const launching = harness.client.ensureRunning(harness.projectPath);
    await entered;
    await expect(harness.client.ensureRunning(otherProject)).rejects.toMatchObject({
      code: "TARGET_CONFLICT",
    });
    releaseReady();
    await launching;

    expect(harness.children).toHaveLength(1);
  });

  it("releases the machine mutex while companion readiness is pending", async () => {
    let releaseReady!: () => void;
    let enteredReady!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredReady = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseReady = resolvePromise; });
    const harness = createHarness({
      companionReadiness: async (options) => {
        enteredReady();
        await blocked;
        return readinessIdentity(options);
      },
    });

    const launching = harness.client.ensureRunning(harness.projectPath);
    await entered;
    const contenderRead = await harness.guard.withLifecycleLock((session) => session.readState());
    expect(contenderRead).toMatchObject({
      kind: "valid",
      state: {
        phase: "starting",
        operation: { kind: "launch" },
        workbench: { pid: harness.children[0].pid },
      },
    });
    releaseReady();
    await expect(launching).resolves.toMatchObject({ action: "launched" });
  });

  it("refuses a stale running commit after readiness loses its exact reservation", async () => {
    let releaseReady!: () => void;
    let enteredReady!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredReady = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releaseReady = resolvePromise; });
    const harness = createHarness({
      companionReadiness: async (options) => {
        enteredReady();
        await blocked;
        return readinessIdentity(options);
      },
    });

    const launching = harness.client.ensureRunning(harness.projectPath);
    await entered;
    await harness.guard.withLifecycleLock(async (session) => {
      const read = await session.readState();
      if (read.kind !== "valid" || !read.state.mcpOwner) throw new Error("missing launch reservation");
      await session.transition(
        { generation: read.state.generation, leaseId: read.state.mcpOwner.leaseId },
        {
          phase: read.state.phase,
          endpoint: read.state.endpoint,
          target: read.state.target,
          mcpOwner: read.state.mcpOwner,
          workbench: read.state.workbench,
          companion: read.state.companion,
          operation: read.state.operation,
        }
      );
    });
    releaseReady();

    await expect(launching).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") expect(read.state.phase).not.toBe("running");
  });

  it("preserves restarting recovery evidence when helper termination times out", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    harness.backend.terminationResult = {
      kind: "refused",
      reason: "timeout",
      message: "TerminateProcess may have been issued before the helper timed out.",
    };

    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("restarting");
      expect(read.state.operation?.kind).toBe("restart");
      expect(read.state.workbench?.pid).toBe(launched.pid);
    }
  });

  it("does not roll a pre-signal refusal over a raced restart generation", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    vi.spyOn(harness.backend, "verifyAndTerminate").mockImplementationOnce(async () => {
      await harness.guard.withLifecycleLock(async (session) => {
        const read = await session.readState();
        if (read.kind !== "valid" || !read.state.mcpOwner) throw new Error("missing restart reservation");
        await session.transition(
          { generation: read.state.generation, leaseId: read.state.mcpOwner.leaseId },
          {
            phase: read.state.phase,
            endpoint: read.state.endpoint,
            target: read.state.target,
            mcpOwner: read.state.mcpOwner,
            workbench: read.state.workbench,
            companion: read.state.companion,
            operation: read.state.operation,
          }
        );
      });
      return {
        kind: "refused" as const,
        reason: "token_mismatch" as const,
        message: "proven pre-signal refusal after a raced generation change",
      };
    });

    await expect(harness.client.restartOwnedWorkbench()).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("restarting");
      expect(read.state.workbench?.pid).toBe(launched.pid);
    }
  });

  it("preserves stopping recovery evidence when the termination helper fails", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    vi.spyOn(harness.backend, "verifyAndTerminate").mockRejectedValueOnce(
      new LifecycleGuardError("helper response was lost after signalling", "RECOVERY_REQUIRED")
    );

    await expect(harness.client.shutdownOwnedWorkbench()).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("stopping");
      expect(read.state.operation?.kind).toBe("shutdown");
      expect(read.state.workbench?.pid).toBe(launched.pid);
    }
  });

  it("derives exact termination and endpoint release from one lifecycle deadline", async () => {
    let lifecycleDeadline: number | undefined;
    let endpointDeadline = Number.POSITIVE_INFINITY;
    const harness = createHarness({
      lifecycleDeadlineAtMs: () => lifecycleDeadline,
      vacancyWait: async (options) => {
        endpointDeadline = options.deadlineMs;
      },
    });
    await harness.client.ensureRunning(harness.projectPath);
    const termination = vi.spyOn(harness.backend, "verifyAndTerminate");
    lifecycleDeadline = Date.now() + 2_000;

    await expect(harness.client.shutdownOwnedWorkbench()).resolves.toMatchObject({
      stopped: true,
    });
    const terminationTimeout = termination.mock.calls[0]?.[1];
    expect(terminationTimeout).toBeGreaterThan(0);
    expect(terminationTimeout).toBeLessThanOrEqual(2_000);
    expect(endpointDeadline).toBeLessThanOrEqual(lifecycleDeadline);
  });

  it("refuses target B while restart A is paused after exact old-process exit", async () => {
    let releasePort!: () => void;
    let enteredPort!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredPort = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releasePort = resolvePromise; });
    const harness = createHarness({
      vacancyWait: async () => {
        enteredPort();
        await blocked;
      },
    });
    const otherProject = addProject(harness, "OtherMod");
    await harness.client.ensureRunning(harness.projectPath);

    const restarting = harness.client.restartOwnedWorkbench();
    await entered;
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    const contenderRead = await harness.guard.withLifecycleLock((session) => session.readState());
    expect(contenderRead).toMatchObject({
      kind: "valid",
      state: {
        phase: "restarting",
        operation: { kind: "restart" },
        workbench: { pid: harness.children[0].pid },
      },
    });
    await expect(harness.client.ensureRunning(otherProject)).rejects.toMatchObject({
      code: "TARGET_CONFLICT",
    });
    releasePort();
    await restarting;

    expect(harness.children).toHaveLength(2);
  });

  it("refuses a stale post-vacancy restart commit after generation interference", async () => {
    let releasePort!: () => void;
    let enteredPort!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredPort = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releasePort = resolvePromise; });
    const harness = createHarness({
      vacancyWait: async () => {
        enteredPort();
        await blocked;
      },
    });
    const launched = await harness.client.ensureRunning(harness.projectPath);

    const restarting = harness.client.restartOwnedWorkbench();
    await entered;
    await harness.guard.withLifecycleLock(async (session) => {
      const read = await session.readState();
      if (read.kind !== "valid" || !read.state.mcpOwner) throw new Error("missing restart reservation");
      await session.transition(
        { generation: read.state.generation, leaseId: read.state.mcpOwner.leaseId },
        {
          phase: read.state.phase,
          endpoint: read.state.endpoint,
          target: read.state.target,
          mcpOwner: read.state.mcpOwner,
          workbench: read.state.workbench,
          companion: read.state.companion,
          operation: read.state.operation,
        }
      );
    });
    releasePort();

    await expect(restarting).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(harness.children).toHaveLength(1);
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("restarting");
      expect(read.state.workbench?.pid).toBe(launched.pid);
    }
  });

  it("deduplicates concurrent restarts of the same canonical target", async () => {
    let releasePort!: () => void;
    let enteredPort!: () => void;
    const entered = new Promise<void>((resolvePromise) => { enteredPort = resolvePromise; });
    const blocked = new Promise<void>((resolvePromise) => { releasePort = resolvePromise; });
    const harness = createHarness({
      vacancyWait: async () => {
        enteredPort();
        await blocked;
      },
    });
    await harness.client.ensureRunning(harness.projectPath);

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

  it("automatically retries exact child-exit reconciliation after the first durable CAS failure", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    const child = harness.children[0];
    let failedOnce = false;
    harness.backend.replaceFailure = ({ next }) => {
      if (!failedOnce && next.phase === "vacant") {
        failedOnce = true;
        return new Error("injected first exit-reconciliation CAS failure");
      }
      return null;
    };
    harness.backend.processes.delete(launched.pid);
    harness.backend.workbenchPids.delete(launched.pid);
    child.exitCode = 23;
    child.emit("exit", 23, null);

    await vi.waitFor(() => expect(failedOnce).toBe(true));
    await vi.waitFor(async () => {
      const read = await harness.guard.readLifecycleState();
      expect(read.kind === "valid" ? read.state.phase : null).toBe("vacant");
      expect(read.kind === "valid" ? read.state.workbench : undefined).toBeNull();
    });
  });

  it("does not let a delayed old-exit retry clobber a newer lifecycle generation", async () => {
    const harness = createHarness();
    const launched = await harness.client.ensureRunning(harness.projectPath);
    const oldChild = harness.children[0];
    let failedOnce = false;
    harness.backend.replaceFailure = ({ next }) => {
      if (!failedOnce && next.phase === "vacant") {
        failedOnce = true;
        return new Error("injected first exit-reconciliation CAS failure");
      }
      return null;
    };
    harness.backend.processes.delete(launched.pid);
    harness.backend.workbenchPids.delete(launched.pid);
    oldChild.exitCode = 31;
    oldChild.emit("exit", 31, null);
    await vi.waitFor(() => expect(failedOnce).toBe(true));

    const replacement = await harness.client.ensureRunning(harness.projectPath);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 175));
    const read = await harness.guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.state.phase).toBe("running");
      expect(read.state.workbench?.pid).toBe(replacement.pid);
    }
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

  it("waits for native endpoint vacancy proof and fails closed on unverifiable probes", async () => {
    const verifyEndpointVacant = vi.fn()
      .mockResolvedValueOnce({ kind: "occupied", listenerPid: 9001, message: "still bound" })
      .mockResolvedValueOnce({ kind: "vacant" });
    const harness = createHarness({
      vacancyWait: (options) => waitForVacancy({
        ...options,
        verify: verifyEndpointVacant,
        pollIntervalMs: 0,
      }),
    });
    await harness.client.ensureRunning(harness.projectPath);
    await expect(harness.client.restartOwnedWorkbench()).resolves.toMatchObject({
      previousPid: harness.children[0].pid,
    });
    expect(verifyEndpointVacant).toHaveBeenCalledTimes(2);

    const unverifiable = vi.fn().mockResolvedValue({
      kind: "unverifiable",
      reason: "access_denied",
      message: "TCP owner table access denied",
    });
    const unverifiableHarness = createHarness({
      vacancyWait: (options) => waitForVacancy({
        ...options,
        verify: unverifiable,
      }),
    });
    await unverifiableHarness.client.ensureRunning(unverifiableHarness.projectPath);
    await expect(unverifiableHarness.client.shutdownOwnedWorkbench())
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(unverifiable).toHaveBeenCalledTimes(1);
  });
});
