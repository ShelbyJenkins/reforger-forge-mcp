import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { generateGproj } from "../src/templates/gproj.js";
import { WorkbenchClient } from "../src/workbench/client.js";
import { WorkbenchHelperStager } from "../src/workbench/helper-addon.js";
import { resolveWorkbenchExecutablePath } from "../src/workbench/launch-plan.js";
import { WorkbenchProcessGuard } from "../src/workbench/process-guard.js";
import { canonicalizeGproj } from "../src/workbench/project-identity.js";

export const LIVE_WORKBENCH_LIFECYCLE_ENVIRONMENT =
  "RFO_RUN_LIVE_WORKBENCH_LIFECYCLE_ACCEPTANCE";

interface WorkbenchLifecycleAcceptanceOptions {
  readonly configPath: string;
  readonly confirmed: boolean;
  readonly initialDwellMs: number;
  readonly restartedDwellMs: number;
  readonly environment?: NodeJS.ProcessEnv;
}

interface ParsedWorkbenchLifecycleArguments {
  readonly help: boolean;
  readonly configPath?: string;
  readonly confirmed: boolean;
  readonly initialDwellMs: number;
  readonly restartedDwellMs: number;
}

function parseDwellMs(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 3_600_000) {
    throw new Error(`${option} must be an integer from 0 through 3600000 milliseconds`);
  }
  return parsed;
}

export function parseWorkbenchLifecycleArguments(
  argv: readonly string[]
): ParsedWorkbenchLifecycleArguments {
  const valueOptions = new Set([
    "--config",
    "--initial-dwell-ms",
    "--restart-dwell-ms",
  ]);
  const flagOptions = new Set(["--confirm-live-run", "--help"]);
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (flagOptions.has(option)) {
      if (flags.has(option)) {
        throw new Error(`${option} may be specified only once`);
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) {
      throw new Error(`Unknown lifecycle acceptance argument: ${option}`);
    }
    if (values.has(option)) {
      throw new Error(`${option} may be specified only once`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    values.set(option, value);
    index += 1;
  }

  const config = values.get("--config");
  return {
    help: flags.has("--help"),
    configPath: config
      ? (isAbsolute(config) ? config : resolve(process.cwd(), config))
      : undefined,
    confirmed: flags.has("--confirm-live-run"),
    initialDwellMs: parseDwellMs(
      values.get("--initial-dwell-ms") ?? "0",
      "--initial-dwell-ms"
    ),
    restartedDwellMs: parseDwellMs(
      values.get("--restart-dwell-ms") ?? "0",
      "--restart-dwell-ms"
    ),
  };
}

function assertLiveRunAuthorized(
  confirmed: boolean,
  environment: NodeJS.ProcessEnv
): void {
  if (!confirmed || environment[LIVE_WORKBENCH_LIFECYCLE_ENVIRONMENT] !== "1") {
    throw new Error(
      "Live Workbench lifecycle acceptance requires both " +
      `${LIVE_WORKBENCH_LIFECYCLE_ENVIRONMENT}=1 and --confirm-live-run`
    );
  }
}

async function observeOwnedWorkbench(
  client: WorkbenchClient,
  guard: WorkbenchProcessGuard,
  endpoint: { host: string; port: number },
  expectedPid: number,
  durationMs: number
): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await delay(Math.min(15_000, deadline - Date.now()));
    assert.equal(await client.ping(), true);
    const processes = await guard.listWorkbenchProcesses();
    assert.equal(processes.length, 1);
    assert.equal(processes[0].pid, expectedPid);
    const read = await guard.readLifecycleState();
    assert.equal(read.kind, "valid");
    if (read.kind !== "valid" || !read.state.workbench) {
      throw new Error("live lifecycle state lost its Workbench identity during dwell");
    }
    assert.equal(read.state.phase, "running");
    assert.equal(read.state.workbench.pid, expectedPid);
    const endpointOwner = await guard.withLifecycleLock((session) =>
      session.verifyEndpointOwner(endpoint, read.state.workbench!)
    );
    assert.deepEqual(endpointOwner, { kind: "owned", listenerPid: expectedPid });
  }
}

export async function runWorkbenchLifecycleAcceptance(
  options: WorkbenchLifecycleAcceptanceOptions
): Promise<void> {
  assertLiveRunAuthorized(options.confirmed, options.environment ?? process.env);

  // Validate the selected installation before creating disposable state.
  const baseConfig = loadConfig(["--config", options.configPath]);
  resolveWorkbenchExecutablePath(baseConfig);

  const root = mkdtempSync(join(tmpdir(), "reforger-forge-live-acceptance-"));
  let managedRoot: string | null = null;
  let guard: WorkbenchProcessGuard | null = null;
  let client: WorkbenchClient | null = null;
  try {
    managedRoot = mkdtempSync(join(tmpdir(), "reforger-forge-live-helper-"));
    const firstMod = join(root, "LifecycleA");
    const secondMod = join(root, "LifecycleB");
    mkdirSync(firstMod);
    mkdirSync(secondMod);
    const firstProject = join(firstMod, "LifecycleA.gproj");
    const secondProject = join(secondMod, "LifecycleB.gproj");
    writeFileSync(firstProject, generateGproj({
      name: "LifecycleA",
      title: "Reforger Forge lifecycle acceptance A",
      guid: "A11CE00000000001",
    }), "utf8");
    writeFileSync(secondProject, generateGproj({
      name: "LifecycleB",
      title: "Reforger Forge lifecycle acceptance B",
      guid: "A11CE00000000002",
    }), "utf8");

    const stateDir = join(root, "state");
    const helperPath = fileURLToPath(
      new URL("./windows/workbench-lifecycle.ps1", import.meta.url)
    );
    guard = new WorkbenchProcessGuard({
      stateDir,
      helperPath,
      lockTimeoutMs: 20_000,
    });
    const config: Config = {
      ...baseConfig,
      workbenchAddonDirs: [...(baseConfig.workbenchAddonDirs ?? []), root],
    };
    client = new WorkbenchClient(
      config.workbenchHost,
      config.workbenchPort,
      config,
      "live-lifecycle-acceptance",
      guard,
      {
        companionProvider: new WorkbenchHelperStager({ managedRoot }),
        launchTimeoutMs: 120_000,
        launchPollIntervalMs: 1_000,
      }
    );

    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
    const canonical = canonicalizeGproj(firstProject);
    const initial = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: config.workbenchHost, port: config.workbenchPort },
      target: { path: canonical.displayPath, comparisonKey: canonical.comparisonKey },
    }));
    assert.equal(initial.kind, "claimed");
    if (initial.kind !== "claimed") {
      throw new Error("could not create vacant live state");
    }
    assert.equal(initial.state.phase, "vacant");

    const launched = await client.ensureRunning(firstProject);
    assert.equal(launched.action, "launched");
    assert.equal(await client.ping(), true);
    let processes = await guard.listWorkbenchProcesses();
    assert.equal(processes.length, 1);
    assert.equal(processes[0].pid, launched.pid);
    let state = await guard.readLifecycleState();
    assert.equal(state.kind, "valid");
    if (state.kind !== "valid") {
      throw new Error("live launch state is invalid");
    }
    assert.equal(state.state.phase, "running");
    assert.equal(state.state.target?.comparisonKey, canonical.comparisonKey);
    assert.equal(state.state.workbench?.pid, launched.pid);
    assert.match(state.state.workbench?.ownerTokenArgument ?? "", /^-reforgerForgeOwnerToken=/);
    assert.ok(state.state.mcpOwner?.leaseId);
    assert.equal(state.state.companion?.addonDirectory.startsWith(managedRoot), true);
    assert.equal(
      existsSync(join(firstMod, "Scripts", "WorkbenchGame", "EnfusionMCP")),
      false
    );

    const reused = await client.ensureRunning(firstProject);
    assert.equal(reused.action, "reused");
    assert.equal(reused.pid, launched.pid);
    assert.equal((await guard.listWorkbenchProcesses()).length, 1);

    await assert.rejects(
      client.ensureRunning(secondProject),
      (error: unknown) =>
        Boolean(error && typeof error === "object" && "code" in error
          && error.code === "TARGET_CONFLICT")
    );
    assert.equal((await guard.listWorkbenchProcesses())[0].pid, launched.pid);
    await observeOwnedWorkbench(
      client,
      guard,
      { host: config.workbenchHost, port: config.workbenchPort },
      launched.pid,
      options.initialDwellMs
    );

    const restarted = await client.restartOwnedWorkbench();
    assert.equal(restarted.previousPid, launched.pid);
    assert.notEqual(restarted.pid, launched.pid);
    assert.equal(
      restarted.gprojPath.toLowerCase(),
      canonical.displayPath.toLowerCase()
    );
    assert.equal(await client.ping(), true);
    processes = await guard.listWorkbenchProcesses();
    assert.equal(processes.length, 1);
    assert.equal(processes[0].pid, restarted.pid);
    state = await guard.readLifecycleState();
    assert.equal(state.kind, "valid");
    if (state.kind !== "valid") {
      throw new Error("live restart state is invalid");
    }
    assert.equal(state.state.phase, "running");
    assert.equal(state.state.workbench?.pid, restarted.pid);
    await observeOwnedWorkbench(
      client,
      guard,
      { host: config.workbenchHost, port: config.workbenchPort },
      restarted.pid,
      options.restartedDwellMs
    );

    const shutdown = await client.shutdownOwnedWorkbench();
    assert.equal(shutdown.stopped, true);
    assert.equal(shutdown.previousPid, restarted.pid);
    assert.deepEqual(await guard.listWorkbenchProcesses(), []);
    assert.equal(await client.ping(), false);
  } finally {
    if (client) {
      try {
        await client.shutdownOwnedWorkbench();
      } catch (error) {
        console.warn("[live-lifecycle-acceptance] exact-owner cleanup refused", error);
      }
    }
    let remainingPids: number[] = [];
    if (guard) {
      try {
        remainingPids = (await guard.listWorkbenchProcesses()).map((item) => item.pid);
      } finally {
        await guard.close();
      }
    }
    if (remainingPids.length === 0) {
      rmSync(root, { recursive: true, force: true });
      if (managedRoot) rmSync(managedRoot, { recursive: true, force: true });
    } else {
      throw new Error(
        `live lifecycle acceptance left Workbench running: ${
          remainingPids.join(", ")
        }`
      );
    }
  }
}

function usage(): string {
  return [
    "Usage: npm run dev:workbench:acceptance:lifecycle -- --config <file> --confirm-live-run",
    "       [--initial-dwell-ms <0..3600000>] [--restart-dwell-ms <0..3600000>]",
    `Required environment confirmation: ${LIVE_WORKBENCH_LIFECYCLE_ENVIRONMENT}=1`,
  ].join("\n");
}

async function main(): Promise<void> {
  const parsed = parseWorkbenchLifecycleArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!parsed.configPath) {
    throw new Error("--config is required");
  }
  await runWorkbenchLifecycleAcceptance({
    configPath: parsed.configPath,
    confirmed: parsed.confirmed,
    initialDwellMs: parsed.initialDwellMs,
    restartedDwellMs: parsed.restartedDwellMs,
  });
  process.stdout.write("Workbench lifecycle acceptance passed with final process vacancy.\n");
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryPoint) {
  main().catch((error) => {
    process.stderr.write(
      `Workbench lifecycle acceptance failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  });
}
