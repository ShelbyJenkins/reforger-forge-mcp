import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config.js";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import {
  buildTargetBuildLaunchPlan,
  ensureWorkbenchManagedBuildProfile,
  type TargetBuildLaunchPlan,
  type WorkbenchManagedBuildProfile,
} from "../../src/workbench/launch-plan.js";
import type {
  WorkbenchNetApiCallOptions,
  WorkbenchNetApiPort,
} from "../../src/workbench/net-api-client.js";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";
import {
  WORKBENCH_OWNER_ARG_PREFIX,
  WORKBENCH_PROCESS_NAME,
} from "../../src/workbench/process-guard.js";
import {
  createFakeCompanionLaunch,
  fakeCompanionProvider,
} from "./fake-companion.js";
import { createFakeLifecycleBackend } from "./fake-lifecycle-backend.js";

export interface RecordedNetApiCall {
  readonly apiFunc: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly options: Readonly<WorkbenchNetApiCallOptions> | undefined;
}

/** Test-only NET port that makes an accidental target-build call observable. */
export class RecordingWorkbenchNetApi implements WorkbenchNetApiPort {
  readonly calls: RecordedNetApiCall[] = [];

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options?: WorkbenchNetApiCallOptions
  ): Promise<T> {
    this.calls.push(Object.freeze({
      apiFunc,
      params: Object.freeze({ ...params }),
      options: options ? Object.freeze({ ...options }) : undefined,
    }));
    return { status: "ok" } as T;
  }
}

/** Deterministic absolute-deadline seam shared by Stage 3 contract tests. */
export class FakeWorkbenchClock {
  constructor(private currentMs = 10_000) {}

  now = (): number => this.currentMs;

  deadlineAfter(timeoutMs: number): number {
    return this.currentMs + timeoutMs;
  }

  remaining(deadlineMs: number): number {
    return Math.max(0, deadlineMs - this.currentMs);
  }

  advanceBy(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new TypeError("Fake clock advances must be finite and non-negative.");
    }
    this.currentMs += durationMs;
  }
}

export interface LifecycleTraceEntry {
  readonly event: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Redacted transition recorder: owner arguments and machine paths never enter it. */
export class LifecycleTraceRecorder {
  readonly entries: LifecycleTraceEntry[] = [];

  record(event: string, detail?: Record<string, unknown>): void {
    this.entries.push(Object.freeze({
      event,
      detail: detail ? Object.freeze({ ...detail }) : undefined,
    }));
  }
}

export class FakeWorkbenchChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  unref(): this {
    return this;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

export interface RecordedSpawn {
  readonly command: string;
  readonly argv: readonly string[];
  readonly options: Readonly<SpawnOptions>;
  readonly child: FakeWorkbenchChild;
}

export class FakeWorkbenchChildFactory {
  readonly spawns: RecordedSpawn[] = [];
  private nextPid = 31_000;

  constructor(private readonly trace: LifecycleTraceRecorder) {}

  spawn = (command: string, argv: string[], options: SpawnOptions): ChildProcess => {
    const child = new FakeWorkbenchChild(this.nextPid++);
    this.spawns.push(Object.freeze({
      command,
      argv: Object.freeze([...argv]),
      options: Object.freeze({ ...options }),
      child,
    }));
    this.trace.record("spawn", { pid: child.pid, plan: "target_build" });
    return child.asChildProcess();
  };
}

export interface WorkbenchPolicyOutputSnapshot {
  readonly root: string;
  readonly entries: readonly string[];
  readonly checkedAtMs: number;
}

/**
 * Test mirror of the planned synchronous final-spawn reservation seam. It
 * deliberately fails before the child factory can be invoked when occupied.
 */
export class FakeBuildOutputReservation {
  checks = 0;

  constructor(
    readonly root: string,
    private readonly clock: FakeWorkbenchClock,
    private readonly trace: LifecycleTraceRecorder
  ) {}

  assertStillReservedAndSnapshot(): WorkbenchPolicyOutputSnapshot {
    this.checks += 1;
    const entries = Object.freeze([...readdirSync(this.root)].sort());
    this.trace.record("output_revalidated", { entryCount: entries.length });
    if (entries.length > 0) {
      throw new Error("Workbench build output reservation is no longer empty.");
    }
    return Object.freeze({
      root: this.root,
      entries,
      checkedAtMs: this.clock.now(),
    });
  }
}

export interface WorkbenchPolicyFixture {
  readonly root: string;
  readonly config: Config;
  readonly project: ReturnType<typeof canonicalizeGproj>;
  readonly projectPath: string;
  readonly managedRoot: string;
  readonly buildProfile: Readonly<WorkbenchManagedBuildProfile>;
  readonly outputPath: string;
  readonly companion: ReturnType<typeof createFakeCompanionLaunch>;
  readonly companionProvider: ReturnType<typeof fakeCompanionProvider>;
  readonly backend: ReturnType<typeof createFakeLifecycleBackend>;
  readonly netApi: RecordingWorkbenchNetApi;
  readonly clock: FakeWorkbenchClock;
  readonly trace: LifecycleTraceRecorder;
  readonly childFactory: FakeWorkbenchChildFactory;
  readonly supervisor: ChildSupervisor;
  readonly reservation: FakeBuildOutputReservation;
  targetPlan(timeoutMs?: number): TargetBuildLaunchPlan;
  cleanup(): void;
}

export function createWorkbenchPolicyFixture(): WorkbenchPolicyFixture {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-stage3-policy-"));
  const toolsRoot = join(root, "Arma Reforger Tools");
  const executablePath = join(toolsRoot, "Workbench", WORKBENCH_PROCESS_NAME);
  const gameRoot = join(root, "Arma Reforger");
  const gameAddonRoot = join(gameRoot, "addons");
  const targetAddonRoot = join(root, "target-addons");
  const projectDirectory = join(targetAddonRoot, "ExampleMod");
  const projectPath = join(projectDirectory, "ExampleMod.gproj");
  const managedRoot = join(root, "managed");
  const outputPath = join(root, "output");

  mkdirSync(dirname(executablePath), { recursive: true });
  mkdirSync(gameAddonRoot, { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });
  mkdirSync(outputPath, { recursive: true });
  writeFileSync(executablePath, "fake Workbench executable");
  writeFileSync(projectPath, [
    "GameProject {",
    " ID ExampleMod",
    ' GUID "1122334455667788"',
    "}",
    "",
  ].join("\n"));

  const project = canonicalizeGproj(projectPath);
  const companion = createFakeCompanionLaunch(managedRoot);
  const companionProvider = fakeCompanionProvider(companion);
  const buildProfile = ensureWorkbenchManagedBuildProfile(managedRoot, project);
  const config: Config = Object.freeze({
    workbenchPath: toolsRoot,
    gamePath: gameRoot,
    workbenchAddonDirs: [gameAddonRoot],
    workbenchScriptAuthorizeAll: true,
    dataDir: join(root, "data"),
    patternsDir: join(root, "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  });
  const clock = new FakeWorkbenchClock();
  const trace = new LifecycleTraceRecorder();
  const childFactory = new FakeWorkbenchChildFactory(trace);
  const supervisor = new ChildSupervisor({
    reconciliationAttempts: 2,
    reconciliationRetryMs: 0,
  });
  const reservation = new FakeBuildOutputReservation(outputPath, clock, trace);
  const fixture: WorkbenchPolicyFixture = {
    root,
    config,
    project,
    projectPath: realpathSync.native(projectPath),
    managedRoot: realpathSync.native(managedRoot),
    buildProfile,
    outputPath: realpathSync.native(outputPath),
    companion,
    companionProvider,
    backend: createFakeLifecycleBackend(),
    netApi: new RecordingWorkbenchNetApi(),
    clock,
    trace,
    childFactory,
    supervisor,
    reservation,
    targetPlan(timeoutMs = 300_000): TargetBuildLaunchPlan {
      return buildTargetBuildLaunchPlan({
        kind: "target_build",
        config,
        project,
        ownerArgument: `${WORKBENCH_OWNER_ARG_PREFIX}stage3-test-owner`,
        managedProfile: buildProfile,
        outputPath,
        platform: "PC",
        timeoutMs,
      });
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return fixture;
}

export interface HermeticTargetRunEvidence {
  readonly planKind: "target_build";
  readonly process: Readonly<{
    pid: number;
    executablePath: string;
  }>;
  readonly targetAddon: TargetBuildLaunchPlan["targetAddon"];
  readonly beforeOutput: WorkbenchPolicyOutputSnapshot;
  readonly exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Hermetic policy exerciser only. It proves ordering and leak invariants; it is
 * not a substitute for the evidence-gated real-Workbench target build.
 */
export async function exerciseHermeticTargetPlan(
  fixture: WorkbenchPolicyFixture,
  plan: TargetBuildLaunchPlan
): Promise<HermeticTargetRunEvidence> {
  if (plan.helper !== null || plan.readiness.kind !== "none") {
    throw new Error("Hermetic target execution refuses helper or NET readiness policy.");
  }
  const beforeOutput = fixture.reservation.assertStillReservedAndSnapshot();
  const child = fixture.childFactory.spawn(
    plan.executablePath,
    [...plan.argv],
    { ...plan.spawnOptions }
  ) as unknown as FakeWorkbenchChild;
  const handle = fixture.supervisor.supervise("stage3-target-build", child.asChildProcess());
  child.finish(0);
  const exit = await handle.exit;
  fixture.trace.record("exit", { pid: child.pid, code: exit.code });
  return Object.freeze({
    planKind: "target_build",
    process: Object.freeze({ pid: child.pid, executablePath: plan.executablePath }),
    targetAddon: plan.targetAddon,
    beforeOutput,
    exit: Object.freeze({ ...exit }),
  });
}
