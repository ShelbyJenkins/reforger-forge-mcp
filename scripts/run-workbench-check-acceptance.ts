import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config.js";
import { ensureWorkbenchManagedBuildProfile } from "../src/workbench/managed-build-profile.js";
import { buildTargetCheckLaunchPlan } from "../src/workbench/launch-plan.js";
import { canonicalizeGproj } from "../src/workbench/project-identity.js";
import { WorkbenchProcessGuard } from "../src/workbench/process-guard.js";
import { runWorkbenchIntent, type WorkbenchCheckReceipt } from "../src/workbench/runner.js";
import { receiptExitCode } from "../src/workbench/runner-cli.js";
import { WorkbenchSessionController } from "../src/workbench/session-controller.js";
import {
  assertSteamClientReady,
  assertWorkbenchStateOwnerReady,
} from "../src/workbench/runner-prerequisites.js";

const LIVE_ENVIRONMENT = "RFO_RUN_LIVE_WORKBENCH_CHECK_ACCEPTANCE";

function snapshotTree(root: string): Readonly<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        snapshot[relative(root, path).replaceAll("\\", "/")] =
          createHash("sha256").update(readFileSync(path)).digest("hex");
      }
    }
  };
  visit(root);
  return Object.freeze(snapshot);
}

async function observeCheck(
  guard: WorkbenchProcessGuard,
  run: Promise<WorkbenchCheckReceipt>
): Promise<{
  receipt: WorkbenchCheckReceipt;
  visibleWindows: number;
  observedWindows: number;
  windowEvidence: readonly Record<string, unknown>[];
}> {
  let settled = false;
  let visibleWindows = 0;
  let observedWindows = 0;
  const windowEvidence = new Map<string, Record<string, unknown>>();
  void run.finally(() => { settled = true; }).catch(() => undefined);
  while (!settled) {
    const lifecycle = await guard.readLifecycleState();
    if (lifecycle.kind === "valid" && lifecycle.state.workbench) {
      try {
        const windows = await guard.inspectExactWindows(lifecycle.state.workbench);
        observedWindows += windows.length;
        visibleWindows += windows.filter((window) => window.visible).length;
        for (const window of windows) {
          windowEvidence.set(`${window.handle}:${window.className}:${window.title}`, { ...window });
        }
      } catch (error) {
        // Lifecycle publication and native process exit are separate observations.
        // Ignore only the narrow race where the exact attested process has exited;
        // an inspection failure for a still-live identity remains fail-closed.
        if (await guard.inspectOwnedWorkbench(lifecycle.state.workbench) === "live") {
          throw error;
        }
      }
    }
    await delay(10);
  }
  return {
    receipt: await run,
    visibleWindows,
    observedWindows,
    windowEvidence: [...windowEvidence.values()],
  };
}

function configurationArguments(argv: readonly string[]): string[] {
  const configIndex = argv.indexOf("--config");
  if (configIndex < 0) return [];
  const path = argv[configIndex + 1];
  if (!path || argv.length !== 3 || argv[2] !== "--confirm-live-run") {
    throw new Error("Usage: --config <path> --confirm-live-run");
  }
  return ["--config", isAbsolute(path) ? path : resolve(path)];
}

async function main(): Promise<void> {
  const confirmed = process.argv.includes("--confirm-live-run");
  if (!confirmed || process.env[LIVE_ENVIRONMENT] !== "1") {
    throw new Error(
      `Live compile-check acceptance requires ${LIVE_ENVIRONMENT}=1 and --confirm-live-run.`
    );
  }
  const config = loadConfig(configurationArguments(process.argv.slice(2)));
  assertSteamClientReady();
  assertWorkbenchStateOwnerReady();

  const validPath = resolve("tests/fixtures/workbench-check-valid-addon/addon.gproj");
  const brokenPath = resolve("tests/fixtures/workbench-check-broken-addon/addon.gproj");
  const validRoot = resolve(validPath, "..");
  const brokenRoot = resolve(brokenPath, "..");
  const fixtureCachePaths = [
    join(validRoot, "resourceDatabase.rdb"),
    join(brokenRoot, "resourceDatabase.rdb"),
  ];
  for (const cachePath of fixtureCachePaths) rmSync(cachePath, { force: true });
  const beforeValid = snapshotTree(validRoot);
  const beforeBroken = snapshotTree(brokenRoot);
  const managedRoot = mkdtempSync(join(tmpdir(), "rfo-workbench-check-acceptance-"));
  const guard = new WorkbenchProcessGuard();
  const lifecycleExecution = WorkbenchSessionController.composeLifecycleExecution({
    processGuard: guard,
  });
  const controller = new WorkbenchSessionController(
    config.workbenchHost,
    config.workbenchPort,
    config,
    undefined,
    guard,
    { lifecycleExecution }
  );

  try {
    const common = {
      processGuard: guard,
      managedRoot,
      logAttributionTimeoutMs: 30_000,
      terminationTimeoutMs: 15_000,
      recoveryTimeoutMs: 15_000,
    };
    const runCheck = (gprojPath: string, configuration: string): Promise<WorkbenchCheckReceipt> =>
      controller.runOwnerScopedTargetCheck(
        gprojPath,
        (activeExecution, signal) => runWorkbenchIntent(config, {
          kind: "check",
          gprojPath,
          configuration,
          timeoutMs: 120_000,
        }, {
          ...common,
          processGuard: undefined,
          lifecycleExecution: activeExecution,
          runnerProcessGuard: guard,
          lifecycleEntry: "owner_scoped",
          signal,
        }) as Promise<WorkbenchCheckReceipt>
      );
    const valid = await observeCheck(guard, runCheck(validPath, "PC"));
    const broken = await observeCheck(guard, runCheck(brokenPath, "PC"));

    let absentConfigurationCode: string | null = null;
    const processesBeforeAbsent = await guard.listWorkbenchProcesses();
    try {
      await runCheck(validPath, "ABSENT");
    } catch (error) {
      absentConfigurationCode = error && typeof error === "object" &&
        typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : null;
    }
    const processesAfterAbsent = await guard.listWorkbenchProcesses();
    const generatedProjectCaches = fixtureCachePaths.filter((path) => existsSync(path));
    for (const cachePath of fixtureCachePaths) rmSync(cachePath, { force: true });

    assert.equal(valid.receipt.compilation.status, "compiled");
    assert.equal(receiptExitCode(valid.receipt), 0);
    assert.equal(broken.receipt.compilation.status, "failed");
    assert.equal(receiptExitCode(broken.receipt), 1);
    assert.equal(absentConfigurationCode, "INVALID_TARGET");
    assert.deepEqual(processesAfterAbsent, processesBeforeAbsent);
    assert.equal(valid.visibleWindows, 0, JSON.stringify(valid.windowEvidence, null, 2));
    assert.deepEqual(snapshotTree(validRoot), beforeValid);
    assert.deepEqual(snapshotTree(brokenRoot), beforeBroken);

    const validProject = canonicalizeGproj(validPath);
    const profile = ensureWorkbenchManagedBuildProfile(managedRoot, validProject);
    const ownerToken = guard.createOwnerToken();
    const characterizedPlan = buildTargetCheckLaunchPlan({
      kind: "target_check",
      config,
      project: validProject,
      ownerArgument: guard.ownerArgument(ownerToken),
      managedProfile: profile,
      configuration: "PC",
      timeoutMs: 120_000,
    });
    const argv = characterizedPlan.argv.map((argument) =>
      argument.startsWith("-reforgerForgeOwnerToken=")
        ? "-reforgerForgeOwnerToken=[redacted]"
        : argument
    );
    process.stdout.write(`${JSON.stringify({
      argv,
      windowPolicy: characterizedPlan.window,
      valid: {
        exitStatus: valid.receipt.exitStatus,
        compilation: valid.receipt.compilation,
        logDirectory: valid.receipt.logDirectory,
        observedWindows: valid.observedWindows,
        visibleWindows: valid.visibleWindows,
        windowEvidence: valid.windowEvidence,
      },
      broken: {
        exitStatus: broken.receipt.exitStatus,
        compilation: broken.receipt.compilation,
        logDirectory: broken.receipt.logDirectory,
        observedWindows: broken.observedWindows,
        visibleWindows: broken.visibleWindows,
        windowEvidence: broken.windowEvidence,
      },
      absentConfiguration: {
        configuration: "ABSENT",
        code: absentConfigurationCode,
        spawnCountDelta: processesAfterAbsent.length - processesBeforeAbsent.length,
      },
      fixtureSourcesUnchanged: true,
      buildArtifactsProduced: false,
      generatedProjectCaches: generatedProjectCaches.map((path) => relative(resolve("."), path)),
    }, null, 2)}\n`);
  } finally {
    await controller.closeOwnerScopedTargetOperations();
    await guard.close();
    for (const cachePath of fixtureCachePaths) rmSync(cachePath, { force: true });
    if (statSync(managedRoot).isDirectory()) rmSync(managedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
