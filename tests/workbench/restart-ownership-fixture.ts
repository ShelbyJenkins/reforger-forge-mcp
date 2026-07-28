import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { expect, vi, type Mock } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { WorkbenchClient, type WorkbenchClientDependencies, type WorkbenchErrorCode } from "../../src/workbench/client.js";
import type { WorkbenchNetApiCallOptions, WorkbenchNetApiPort } from "../../src/workbench/net-api-client.js";
import type { LifecycleStateDraft, WorkbenchLifecycleStateV3 } from "../../src/workbench/process-guard.js";
import type { CompanionReadinessOptions, WorkbenchCompanionIdentity } from "../../src/workbench/readiness.js";
import { createFakeLifecycleBackend, type FakeLifecycleBackend } from "./fake-lifecycle-backend.js";
import { createFakeCompanionLaunch, fakeCompanionProvider, WORKBENCH_HELPER_PING_RESPONSE } from "./fake-companion.js";
import { closeTrackedWorkbenchProcessGuards, WorkbenchProcessGuard } from "./tracked-process-guard.js";

const roots: string[] = [];

export class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  readonly kill = vi.fn(() => {
    throw new Error("ChildProcess.kill must never be used for Workbench lifecycle mutations");
  });

  constructor(pid: number) { super(); this.pid = pid; }

  unref(): void {}
}

export interface Harness {
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

type TestNetApiCall = (apiFunc: string, params?: Record<string, unknown>,
  options?: WorkbenchNetApiCallOptions) => Promise<Record<string, unknown>>;

export interface HarnessOptions {
  companionReadiness?: NonNullable<WorkbenchClientDependencies["companionReadiness"]>;
  vacancyWait?: NonNullable<WorkbenchClientDependencies["vacancyWait"]>;
  lifecycleDeadlineAtMs?: NonNullable<WorkbenchClientDependencies["lifecycleDeadlineAtMs"]>;
  requestDeadlineAtMs?: NonNullable<WorkbenchClientDependencies["requestDeadlineAtMs"]>;
  now?: NonNullable<WorkbenchClientDependencies["now"]>;
}

export interface AsyncGate {
  readonly entered: Promise<void>;
  block(): Promise<void>;
  release(): void;
}

export interface FailureProbe { triggered: boolean }

export interface RunningHarness {
  readonly harness: Harness;
  readonly launched: Awaited<ReturnType<WorkbenchClient["ensureRunning"]>>;
  readonly child: FakeChild;
}

function fixtureProjectDocument(name: string): string {
  const guid = createHash("sha256")
    .update(`reforger-forge-restart-fixture:${name}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
  return [
    "GameProject {",
    ` ID "${name}"`,
    ` GUID "${guid}"`,
    "}",
    "",
  ].join("\n");
}

export function createAsyncGate(): AsyncGate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, async block() { enter(); await released; } };
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-restart-"));
  roots.push(root);
  const projectRoot = join(root, "projects");
  const modDirectory = join(projectRoot, "ExampleMod");
  const projectPath = join(modDirectory, "ExampleMod.gproj");
  const toolsRoot = join(root, "Arma Reforger Tools");
  const executablePath = join(toolsRoot, "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe");
  const gamePath = join(root, "Arma Reforger");
  const stateDir = join(root, "state");
  mkdirSync(modDirectory, { recursive: true });
  mkdirSync(join(toolsRoot, "Workbench"), { recursive: true });
  mkdirSync(join(gamePath, "addons"), { recursive: true });
  writeFileSync(projectPath, fixtureProjectDocument("ExampleMod"));
  writeFileSync(executablePath, "fake executable");

  const config: Config = {
    workbenchPath: toolsRoot,
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
  const netApi: WorkbenchNetApiPort = { call: netApiCall as WorkbenchNetApiPort["call"] };
  const client = new WorkbenchClient(
    config.workbenchHost, config.workbenchPort, config, "test-client", guard, {
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
        const ownerArgument = args.find((arg) => arg.startsWith("-reforgerForgeOwnerToken="));
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
    },
  );

  return {
    root, modDirectory, projectPath, executablePath, config, mutexName, backend, guard, client,
    companionProvider, verifyStaged, netApiCall, children, spawnOptions, spawnArgs,
  };
}

export async function createRunningHarness(options: HarnessOptions = {}): Promise<RunningHarness> {
  const harness = createHarness(options);
  const launched = await harness.client.ensureRunning(harness.projectPath);
  return { harness, launched, child: harness.children[0] };
}

export function addProject(harness: Harness, name: string): string {
  const directory = join(harness.root, "projects", name);
  const projectPath = join(directory, `${name}.gproj`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(projectPath, fixtureProjectDocument(name));
  return projectPath;
}

export function readinessIdentity(options: CompanionReadinessOptions): WorkbenchCompanionIdentity {
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

export function createBlockedLifecycleHarness(kind: "readiness" | "vacancy") {
  const gate = createAsyncGate();
  const harness = kind === "readiness"
    ? createHarness({ companionReadiness: async (options) => {
      await gate.block();
      return readinessIdentity(options);
    } })
    : createHarness({ vacancyWait: () => gate.block() });
  return { gate, harness };
}

export async function expectRejectedCode(
  promise: Promise<unknown>,
  code: WorkbenchErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

export async function readValidLifecycleState(harness: Harness): Promise<WorkbenchLifecycleStateV3> {
  const read = await harness.guard.readLifecycleState();
  expect(read.kind).toBe("valid");
  if (read.kind !== "valid") throw new Error("missing valid lifecycle state");
  return read.state;
}

export async function expectEventuallyVacant(
  harness: Harness,
  assertState?: (state: WorkbenchLifecycleStateV3) => void,
): Promise<void> {
  await vi.waitFor(async () => {
    const state = await readValidLifecycleState(harness);
    expect(state.phase).toBe("vacant");
    assertState?.(state);
    expect(state.workbench).toBeNull();
  });
}

export function failFirstVacantTransition(harness: Harness, message: string): FailureProbe {
  const probe = { triggered: false };
  harness.backend.replaceFailure = ({ next }) => {
    if (probe.triggered || next.phase !== "vacant") return null;
    probe.triggered = true;
    return new Error(message);
  };
  return probe;
}

export async function republishLifecycleState(
  harness: Harness,
  changes: Partial<LifecycleStateDraft> |
    ((state: WorkbenchLifecycleStateV3) => Partial<LifecycleStateDraft>) = {},
): Promise<void> {
  await harness.guard.withLifecycleLock(async (session) => {
    const read = await session.readState();
    if (read.kind !== "valid") throw new Error("missing lifecycle reservation");
    const state = read.state;
    const owner = state.mcpOwner;
    if (!owner) throw new Error("missing lifecycle reservation");
    const overrides = typeof changes === "function" ? changes(state) : changes;
    await session.transition(
      { generation: state.generation, leaseId: owner.leaseId },
      {
        phase: state.phase,
        endpoint: state.endpoint,
        target: state.target,
        mcpOwner: state.mcpOwner,
        workbench: state.workbench,
        companion: state.companion,
        operation: state.operation,
        ...overrides,
      },
    );
  });
}

export function emitOwnedChildExit(harness: Harness, pid: number, exitCode: number): void {
  harness.backend.processes.delete(pid);
  harness.backend.workbenchPids.delete(pid);
  const child = harness.children.find((candidate) => candidate.pid === pid);
  if (!child) throw new Error(`missing child ${pid}`);
  child.exitCode = exitCode;
  child.emit("exit", exitCode, null);
}

export function refuseEndpointOwnership(harness: Harness, message: string): void {
  harness.backend.endpointOwnershipResult = {
    kind: "refused", reason: "listener_pid_mismatch", message,
  };
}

export function refuseTermination(
  harness: Harness,
  reason: "access_denied" | "timeout" | "token_mismatch",
  message: string,
): void {
  harness.backend.terminationResult = { kind: "refused", reason, message };
}

export function createSiblingGuard(harness: Harness): WorkbenchProcessGuard {
  return new WorkbenchProcessGuard({
    backend: harness.backend, stateDir: harness.guard.stateDir, mutexName: harness.mutexName,
  });
}

export function createContenderClient(harness: Harness): WorkbenchClient {
  return new WorkbenchClient(
    harness.config.workbenchHost, harness.config.workbenchPort, harness.config, "contender",
    createSiblingGuard(harness),
    { companionProvider: fakeCompanionProvider(createFakeCompanionLaunch(join(harness.root, "contender-helper"))) },
  );
}

export async function cleanupRestartOwnershipFixtures(): Promise<void> {
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}
