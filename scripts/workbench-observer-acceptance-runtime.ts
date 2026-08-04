import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import {
  createObserverApplication,
  type ObserverApplication,
} from "../src/observer/application.js";
import { generateGproj } from "../src/templates/gproj.js";
import { WorkbenchClient } from "../src/workbench/client.js";
import type { WorkbenchClientDependencies } from "../src/workbench/session-controller.js";
import type { WorkbenchObserverAdapter } from "../src/workbench/observer-adapter.js";
import {
  WindowsLifecycleBackend,
  WorkbenchProcessGuard,
} from "../src/workbench/process-guard.js";
import {
  OperationalBaselineRecorder,
  operationalBaselineDirectoryIdentity,
  operationalBaselineLaunchArgumentIdentity,
  type OperationalBaselineLaunchArguments,
} from "./observer-live-acceptance-support.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT = resolve(
  dirname(SCRIPT_PATH),
  ".."
);

export const BASE_EVERON_WORLD = "{853E92315D1D9EFE}worlds/Eden/Eden.ent";
export const WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR = join(
  WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT,
  "tests",
  "fixtures",
  "workbench-observer-failure-matrix-addon"
);
/** Fixed GUID of tests/fixtures/workbench-observer-failure-matrix-addon/addon.gproj. */
export const WORKBENCH_MATRIX_FIXTURE_GUID = "2C6B8D14F9A0473E";
const WORKBENCH_MATRIX_FIXTURE_ADDON_DIR_NAME = "ObserverMatrixFixture";

export interface DisposableWorkbenchObserverProject {
  readonly modDirectory: string;
  readonly projectPath: string;
  readonly worldResource: string;
  readonly alternateWorldResource: string | null;
}

/** ResourceManager metadata lookup accepts the virtual path, not a GUID-qualified ResourceName. */
export function workbenchResourceVirtualPath(resourceName: string): string {
  const match = /^\{[A-F0-9]{16}\}(.+)$/.exec(resourceName);
  if (!match?.[1]) {
    throw new Error(`Workbench acceptance resource name is not GUID-qualified: ${resourceName}`);
  }
  return match[1];
}

function randomGuid(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  const entry = lstatSync(absolute);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${absolute}`);
  }
  return realpathSync.native(absolute);
}

function stageWorkbenchMatrixFixture(runDirectory: string): string {
  const fixtureDirectory = join(runDirectory, WORKBENCH_MATRIX_FIXTURE_ADDON_DIR_NAME);
  if (existsSync(fixtureDirectory)) {
    throw new Error(`Workbench matrix fixture destination already exists: ${fixtureDirectory}`);
  }
  const sourceIdentity = operationalBaselineDirectoryIdentity(
    WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR,
    [".c", ".gproj"]
  );
  cpSync(WORKBENCH_MATRIX_FIXTURE_TEMPLATE_DIR, fixtureDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const stagedIdentity = operationalBaselineDirectoryIdentity(
    fixtureDirectory,
    [".c", ".gproj"]
  );
  if (stagedIdentity.fileCount !== sourceIdentity.fileCount ||
      stagedIdentity.sha256 !== sourceIdentity.sha256) {
    rmSync(fixtureDirectory, { recursive: true, force: true });
    throw new Error("Staged Workbench matrix fixture does not match its attested source template");
  }
  return WORKBENCH_MATRIX_FIXTURE_GUID;
}

/** Build a fresh disposable project; matrix fixture staging is opt-in. */
export function createDisposableProject(
  runDirectory: string,
  options?: { readonly stageMatrixFixture?: boolean }
): DisposableWorkbenchObserverProject {
  const dependencies = options?.stageMatrixFixture
    ? [stageWorkbenchMatrixFixture(runDirectory)]
    : undefined;
  const modDirectory = join(runDirectory, "ObserverAcceptance");
  const worldsDirectory = join(modDirectory, "Worlds");
  mkdirSync(worldsDirectory, { recursive: true });
  const projectPath = join(modDirectory, "ObserverAcceptance.gproj");
  writeFileSync(projectPath, generateGproj({
    name: "ObserverAcceptance",
    title: "ReforgerForge Workbench observer acceptance",
    guid: randomGuid(),
    dependencies,
  }), { encoding: "utf8", flag: "wx" });
  const writeWorld = (name: string): string => {
    const worldGuid = randomGuid();
    const worldPath = join(worldsDirectory, `${name}.ent`);
    writeFileSync(worldPath, `SubScene {\n Parent "${BASE_EVERON_WORLD}"\n}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    writeFileSync(`${worldPath}.meta`, [
      "MetaFileClass {",
      ` Name "{${worldGuid}}Worlds/${name}.ent"`,
      " Configurations {",
      "  ENTResourceClass PC {",
      "  }",
      "  ENTResourceClass HEADLESS : PC {",
      "  }",
      " }",
      "}",
      "",
    ].join("\n"), { encoding: "utf8", flag: "wx" });
    return `{${worldGuid}}Worlds/${name}.ent`;
  };
  const worldResource = writeWorld(options?.stageMatrixFixture
    ? "ObserverMatrixA"
    : "ObserverAcceptance");
  const alternateWorldResource = options?.stageMatrixFixture
    ? writeWorld("ObserverMatrixB")
    : null;
  return {
    modDirectory,
    projectPath,
    worldResource,
    alternateWorldResource,
  };
}

/** Validate and normalize exactly one explicit configuration before creating run state. */
export function loadAcceptanceBaseConfig(configPath: string): Config {
  const local = loadConfig(["--config", configPath]);
  const workbenchPath = canonicalDirectory(local.workbenchPath, "Workbench tools directory");
  const gamePath = canonicalDirectory(local.gamePath, "Arma Reforger game directory");
  const configuredRoots = (local.workbenchAddonDirs ?? []).map((path, index) =>
    canonicalDirectory(path, `Workbench addon root ${index + 1}`));
  const host = local.workbenchHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Live Workbench observer acceptance requires a loopback NET API endpoint");
  }
  return {
    ...local,
    workbenchPath,
    gamePath,
    workbenchAddonDirs: configuredRoots,
  };
}

/** Constrain a validated explicit configuration to one native acceptance run. */
export function acceptanceConfig(
  configPath: string,
  projectRoot: string,
  managedRoot: string,
  baseConfig: Config = loadAcceptanceBaseConfig(configPath)
): Config {
  return {
    ...baseConfig,
    workbenchAddonDirs: [...(baseConfig.workbenchAddonDirs ?? []), projectRoot],
    workbenchScriptAuthorizeAll: false,
    observer: {
      ...baseConfig.observer!,
      managedRoot,
      profileRoot: join(managedRoot, "profiles"),
    },
  };
}

function firstRegularExecutable(candidates: string[]): string | undefined {
  return candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    const entry = lstatSync(candidate);
    return entry.isFile() && !entry.isSymbolicLink();
  });
}

export function workbenchEnvironmentExecutables(config: Config): {
  readonly workbenchExecutable?: string;
  readonly gameExecutable?: string;
} {
  return {
    workbenchExecutable: firstRegularExecutable([
      join(config.workbenchPath, "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
      join(config.workbenchPath, "ArmaReforgerWorkbenchSteamDiag.exe"),
    ]),
    gameExecutable: firstRegularExecutable([
      join(config.gamePath, "ArmaReforgerSteamDiag.exe"),
      join(config.gamePath, "ArmaReforgerDiag.exe"),
      join(config.gamePath, "ArmaReforgerSteam.exe"),
      join(config.gamePath, "ArmaReforger.exe"),
    ]),
  };
}

export type WorkbenchObserverAcceptanceAdapter = Pick<WorkbenchObserverAdapter,
  "instances" |
  "ping" |
  "submit" |
  "recover" |
  "status" |
  "cancel" |
  "release" |
  "readCompletedArtifact" |
  "restoreAll"
>;

export interface WorkbenchObserverAcceptanceProcessCounts {
  readonly active: number;
  readonly reconciling: number;
  readonly total: number;
}

export function workbenchObserverAcceptanceLaunchArguments(
  argumentsArray: readonly string[],
  additionalLaunchArguments: readonly string[] = []
): string[] {
  const displayOverride = [...argumentsArray, ...additionalLaunchArguments].find((token) =>
    ["-window", "-screenwidth", "-screenheight"].includes(
      token.split("=", 1)[0].toLowerCase(),
    ),
  );
  if (displayOverride) {
    throw new Error(
      `Workbench Observer acceptance does not permit forced window sizing; ${displayOverride} is not accepted`,
    );
  }
  const actualArguments = [...argumentsArray, "-forceUpdate"];
  actualArguments.push(...additionalLaunchArguments);
  return actualArguments;
}

export function combineWorkbenchObserverAcceptanceProcessCounts(
  primary: WorkbenchObserverAcceptanceProcessCounts,
  recovery: WorkbenchObserverAcceptanceProcessCounts | null,
  observerPrivateChildren: number
): WorkbenchObserverAcceptanceProcessCounts {
  const recoveryCounts = recovery ?? { active: 0, reconciling: 0, total: 0 };
  return {
    active: primary.active + recoveryCounts.active + observerPrivateChildren,
    reconciling: primary.reconciling + recoveryCounts.reconciling,
    total: primary.total + recoveryCounts.total + observerPrivateChildren,
  };
}

export interface WorkbenchObserverAcceptanceRuntimeOptions<
  Adapter extends WorkbenchObserverAcceptanceAdapter = WorkbenchObserverAcceptanceAdapter
> {
  readonly configPath: string;
  readonly runDirectory: string;
  readonly clientIdPrefix: string;
  readonly stageMatrixFixture?: boolean;
  readonly additionalLaunchArguments?: readonly string[];
  readonly launchTimeoutMs?: WorkbenchClientDependencies["launchTimeoutMs"];
  readonly lifecycleDeadlineAtMs?: WorkbenchClientDependencies["lifecycleDeadlineAtMs"];
  readonly requestDeadlineAtMs?: WorkbenchClientDependencies["requestDeadlineAtMs"];
  readonly launchPollIntervalMs?: number;
  readonly lockTimeoutMs?: number | (() => number);
  readonly helperTimeoutMs?: number | (() => number);
  readonly operationDeadlineAtMs?: () => number | undefined;
  readonly netApi?: WorkbenchClientDependencies["netApi"];
  readonly createNetApi?: (input: {
    readonly host: string;
    readonly port: number;
    readonly clientId: string;
  }) => NonNullable<WorkbenchClientDependencies["netApi"]>;
  readonly applicationRequestDeadlineAtMs?: () => number | undefined;
  readonly createAdapter: (
    client: WorkbenchClient
  ) => Adapter;
}

/**
 * Repository-only composition root shared by native Workbench observer runs.
 * It owns construction and process accounting; each run retains its explicit
 * state-machine and cleanup policy.
 */
export class WorkbenchObserverAcceptanceRuntime<
  Adapter extends WorkbenchObserverAcceptanceAdapter = WorkbenchObserverAcceptanceAdapter
> {
  readonly projectRoot: string;
  readonly managedRoot: string;
  readonly evidenceRoot: string;
  readonly project: DisposableWorkbenchObserverProject;
  readonly config: Config;
  readonly lifecycleBackend: WindowsLifecycleBackend;
  readonly guard: WorkbenchProcessGuard;
  readonly netApi: NonNullable<WorkbenchClientDependencies["netApi"]> | null;
  readonly client: WorkbenchClient;
  readonly adapter: Adapter;
  readonly application: ObserverApplication;
  readonly baseline: OperationalBaselineRecorder;

  private recoveryClient: WorkbenchClient | null = null;
  private observedLaunchArguments = operationalBaselineLaunchArgumentIdentity([], false);

  constructor(options: WorkbenchObserverAcceptanceRuntimeOptions<Adapter>) {
    this.projectRoot = join(options.runDirectory, "project");
    this.managedRoot = join(options.runDirectory, "observer-managed");
    this.evidenceRoot = join(options.runDirectory, "evidence");
    const baseConfig = loadAcceptanceBaseConfig(options.configPath);
    this.config = acceptanceConfig(
      options.configPath,
      this.projectRoot,
      this.managedRoot,
      baseConfig
    );
    const helperPath = join(
      WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT,
      "scripts",
      "windows",
      "workbench-lifecycle.ps1"
    );
    const observerAgentPath = join(
      WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT,
      "dist",
      "observer",
      "agent",
      "private-child.js"
    );
    const sourceAddon = join(
      WORKBENCH_OBSERVER_ACCEPTANCE_REPOSITORY_ROOT,
      "observer",
      "addon"
    );
    if (!existsSync(helperPath) || !lstatSync(helperPath).isFile()) {
      throw new Error(`Workbench lifecycle helper is missing: ${helperPath}`);
    }
    if (!existsSync(observerAgentPath) || !lstatSync(observerAgentPath).isFile()) {
      throw new Error(`Compiled observer agent is missing: ${observerAgentPath}`);
    }
    if (!existsSync(sourceAddon) || !lstatSync(sourceAddon).isDirectory()) {
      throw new Error(`Observer source addon is missing: ${sourceAddon}`);
    }

    mkdirSync(this.projectRoot, { recursive: true });
    mkdirSync(this.managedRoot, { recursive: true });
    mkdirSync(this.evidenceRoot, { recursive: true });

    this.project = createDisposableProject(this.projectRoot, {
      stageMatrixFixture: options.stageMatrixFixture,
    });
    this.lifecycleBackend = new WindowsLifecycleBackend(helperPath, {
      helperTimeoutMs: options.helperTimeoutMs,
      operationDeadlineAtMs: options.operationDeadlineAtMs,
    });
    this.guard = new WorkbenchProcessGuard({
      stateDir: join(options.runDirectory, "lifecycle"),
      backend: this.lifecycleBackend,
      lockTimeoutMs: options.lockTimeoutMs ?? 20_000,
      operationDeadlineAtMs: options.operationDeadlineAtMs,
    });

    const additionalLaunchArguments = [...(options.additionalLaunchArguments ?? [])];
    if (options.netApi && options.createNetApi) {
      throw new Error("Workbench acceptance runtime accepts either netApi or createNetApi, not both");
    }
    const clientId = `${options.clientIdPrefix}-${randomUUID()}`;
    const netApi = options.createNetApi?.({
      host: this.config.workbenchHost,
      port: this.config.workbenchPort,
      clientId: `${options.clientIdPrefix}-${randomUUID()}`,
    }) ?? options.netApi;
    this.netApi = netApi ?? null;
    this.client = new WorkbenchClient(
      this.config.workbenchHost,
      this.config.workbenchPort,
      this.config,
      clientId,
      this.guard,
      {
        ...(netApi ? { netApi } : {}),
        ...(options.launchTimeoutMs === undefined
          ? {}
          : { launchTimeoutMs: options.launchTimeoutMs }),
        ...(options.lifecycleDeadlineAtMs
          ? { lifecycleDeadlineAtMs: options.lifecycleDeadlineAtMs }
          : {}),
        ...(options.requestDeadlineAtMs
          ? { requestDeadlineAtMs: options.requestDeadlineAtMs }
          : {}),
        launchPollIntervalMs: options.launchPollIntervalMs ?? 1_000,
        spawnProcess: (command, argumentsArray, spawnOptions) => {
          const actualArguments = workbenchObserverAcceptanceLaunchArguments(
            argumentsArray,
            additionalLaunchArguments
          );
          this.observedLaunchArguments = operationalBaselineLaunchArgumentIdentity(actualArguments);
          return spawn(command, actualArguments, spawnOptions);
        },
      }
    );
    this.adapter = options.createAdapter(this.client);

    this.application = createObserverApplication({
      agentPath: observerAgentPath,
      managedRoot: this.managedRoot,
      profileRoot: join(this.managedRoot, "profiles"),
      sourceAddon,
      requestTimeoutMs: 60_000,
      ...(options.applicationRequestDeadlineAtMs
        ? { requestDeadlineAtMs: options.applicationRequestDeadlineAtMs }
        : {}),
      defaultCaptureTimeoutMs: 5 * 60_000,
      maxInlineImageBytes: 64 * 1024 * 1024,
      defaultLossyImageQuality: this.config.observer?.defaultLossyImageQuality,
      minimumLossyImageQuality: this.config.observer?.minimumLossyImageQuality,
      maximumLossyImageQuality: this.config.observer?.maximumLossyImageQuality,
      evidenceRoots: [this.evidenceRoot],
      workbenchAdapter: this.adapter,
    });
    this.baseline = new OperationalBaselineRecorder({
      backend: "workbench",
      readSupervisedProcessCounts: this.readProcessCounts,
    });
  }

  get launchArguments(): OperationalBaselineLaunchArguments {
    return this.observedLaunchArguments;
  }

  readonly readProcessCounts = (): WorkbenchObserverAcceptanceProcessCounts => {
    const primary = this.client.diagnosticSupervisedChildCounts();
    const recovery = this.recoveryClient?.diagnosticSupervisedChildCounts() ?? null;
    const observerPrivateChildren = this.application.diagnosticPrivateChildCount();
    return combineWorkbenchObserverAcceptanceProcessCounts(
      primary,
      recovery,
      observerPrivateChildren
    );
  };

  createRecoveryClient(clientIdPrefix: string): WorkbenchClient {
    const recovery = new WorkbenchClient(
      this.config.workbenchHost,
      this.config.workbenchPort,
      this.config,
      `${clientIdPrefix}-${randomUUID()}`,
      this.guard
    );
    this.recoveryClient = recovery;
    return recovery;
  }

  async close(): Promise<void> {
    await this.guard.close();
  }
}
