import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "../../../src/config.js";
import { generateGproj } from "../../../src/templates/gproj.js";
import { WorkbenchClient } from "../../../src/workbench/client.js";
import { WorkbenchHelperStager } from "../../../src/workbench/helper-addon.js";
import { WorkbenchProcessGuard } from "../../../src/workbench/process-guard.js";
import { canonicalizeGproj } from "../../../src/workbench/project-identity.js";

const runLive = process.env.RR_RUN_LIVE_WORKBENCH === "1";
const initialDwellMs = readDwellMs("RR_LIVE_INITIAL_DWELL_MS");
const restartedDwellMs = readDwellMs("RR_LIVE_RESTART_DWELL_MS");
const liveTestTimeoutMs = 300_000 + initialDwellMs + restartedDwellMs;

function readDwellMs(name: string): number {
  const value = Number(process.env[name] ?? "0");
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number of milliseconds`);
  }
  return value;
}

interface RepoLocalPaths {
  workbenchPath: string;
  gamePath: string;
  workbenchAddonDirs: string[];
}

function readRepoLocalPaths(): RepoLocalPaths {
  const configPath = fileURLToPath(
    new URL("../../../reforger-forge.config.json", import.meta.url)
  );
  if (!existsSync(configPath)) {
    throw new Error(
      "Live lifecycle acceptance requires the repository-local, gitignored " +
      "reforger-forge.config.json"
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot parse the repository-local live-test config: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Repository-local live-test config must be a JSON object");
  }

  const config = value as Record<string, unknown>;
  const workbenchPath = config.workbenchPath;
  const gamePath = config.gamePath;
  const workbenchAddonDirs = config.workbenchAddonDirs;
  if (typeof workbenchPath !== "string" || workbenchPath.length === 0) {
    throw new Error("Repository-local live-test config requires workbenchPath");
  }
  if (typeof gamePath !== "string" || gamePath.length === 0) {
    throw new Error("Repository-local live-test config requires gamePath");
  }
  if (
    !Array.isArray(workbenchAddonDirs) ||
    workbenchAddonDirs.length === 0 ||
    !workbenchAddonDirs.every(
      (entry): entry is string => typeof entry === "string" && entry.length > 0
    )
  ) {
    throw new Error(
      "Repository-local live-test config requires a non-empty workbenchAddonDirs string array"
    );
  }
  return { workbenchPath, gamePath, workbenchAddonDirs };
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
    expect(await client.ping()).toBe(true);
    const processes = await guard.listWorkbenchProcesses();
    expect(processes).toHaveLength(1);
    expect(processes[0].pid).toBe(expectedPid);
    const read = await guard.readLifecycleState();
    expect(read.kind).toBe("valid");
    if (read.kind !== "valid" || !read.state.workbench) {
      throw new Error("live lifecycle state lost its Workbench identity during dwell");
    }
    expect(read.state.phase).toBe("running");
    expect(read.state.workbench.pid).toBe(expectedPid);
    const endpointOwner = await guard.withLifecycleLock((session) =>
      session.verifyEndpointOwner(endpoint, read.state.workbench!)
    );
    expect(endpointOwner).toEqual({ kind: "owned", listenerPid: expectedPid });
  }
}

describe.runIf(runLive)("live exact-owner Workbench lifecycle acceptance", () => {
  it("launches, reuses, conflicts, restarts, and shuts down with an external companion", async () => {
    const localPaths = readRepoLocalPaths();
    const executablePath = join(
      localPaths.workbenchPath,
      "Workbench",
      "ArmaReforgerWorkbenchSteamDiag.exe"
    );
    expect(existsSync(executablePath), `missing live Workbench executable: ${executablePath}`).toBe(true);

    const root = mkdtempSync(join(tmpdir(), "reforger-forge-live-acceptance-"));
    const managedRoot = mkdtempSync(join(tmpdir(), "reforger-forge-live-helper-"));
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
      new URL("../../../scripts/windows/workbench-lifecycle.ps1", import.meta.url)
    );
    const guard = new WorkbenchProcessGuard({
      stateDir,
      helperPath,
      lockTimeoutMs: 20_000,
    });
    const config: Config = {
      workbenchPath: localPaths.workbenchPath,
      gamePath: localPaths.gamePath,
      projectPath: root,
      workbenchAddonDirs: [...localPaths.workbenchAddonDirs, root],
      workbenchScriptAuthorizeAll: true,
      dataDir: fileURLToPath(new URL("../../../data", import.meta.url)),
      patternsDir: fileURLToPath(new URL("../../../data/patterns", import.meta.url)),
      workbenchHost: "127.0.0.1",
      workbenchPort: 5775,
    };
    const client = new WorkbenchClient(
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
    try {
      expect(await guard.listWorkbenchProcesses()).toEqual([]);
      const canonical = canonicalizeGproj(firstProject);
      const initial = await guard.withLifecycleLock((session) => session.validateAndClaim({
        endpoint: { host: config.workbenchHost, port: config.workbenchPort },
        target: { path: canonical.displayPath, comparisonKey: canonical.comparisonKey },
      }));
      expect(initial.kind).toBe("claimed");
      if (initial.kind !== "claimed") throw new Error("could not create vacant live state");
      expect(initial.state.phase).toBe("vacant");

      const launched = await client.ensureRunning(firstProject);
      expect(launched.action).toBe("launched");
      expect(await client.ping()).toBe(true);
      let processes = await guard.listWorkbenchProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0].pid).toBe(launched.pid);
      let state = await guard.readLifecycleState();
      expect(state.kind).toBe("valid");
      if (state.kind !== "valid") throw new Error("live launch state is invalid");
      expect(state.state.phase).toBe("running");
      expect(state.state.target?.comparisonKey).toBe(canonical.comparisonKey);
      expect(state.state.workbench?.pid).toBe(launched.pid);
      expect(state.state.workbench?.ownerTokenArgument).toMatch(/^-reforgerForgeOwnerToken=/);
      expect(state.state.mcpOwner?.leaseId).toBeTruthy();
      expect(state.state.companion?.addonDirectory.startsWith(managedRoot)).toBe(true);
      expect(existsSync(join(firstMod, "Scripts", "WorkbenchGame", "EnfusionMCP"))).toBe(false);

      const reused = await client.ensureRunning(firstProject);
      expect(reused).toMatchObject({ action: "reused", pid: launched.pid });
      expect(await guard.listWorkbenchProcesses()).toHaveLength(1);

      await expect(client.ensureRunning(secondProject)).rejects.toMatchObject({
        code: "TARGET_CONFLICT",
      });
      expect((await guard.listWorkbenchProcesses())[0].pid).toBe(launched.pid);
      await observeOwnedWorkbench(
        client,
        guard,
        { host: config.workbenchHost, port: config.workbenchPort },
        launched.pid,
        initialDwellMs
      );

      const restarted = await client.restartOwnedWorkbench();
      expect(restarted.previousPid).toBe(launched.pid);
      expect(restarted.pid).not.toBe(launched.pid);
      expect(restarted.gprojPath.toLowerCase()).toBe(canonical.displayPath.toLowerCase());
      expect(await client.ping()).toBe(true);
      processes = await guard.listWorkbenchProcesses();
      expect(processes).toHaveLength(1);
      expect(processes[0].pid).toBe(restarted.pid);
      state = await guard.readLifecycleState();
      expect(state.kind).toBe("valid");
      if (state.kind !== "valid") throw new Error("live restart state is invalid");
      expect(state.state.phase).toBe("running");
      expect(state.state.workbench?.pid).toBe(restarted.pid);
      await observeOwnedWorkbench(
        client,
        guard,
        { host: config.workbenchHost, port: config.workbenchPort },
        restarted.pid,
        restartedDwellMs
      );

      const shutdown = await client.shutdownOwnedWorkbench();
      expect(shutdown).toMatchObject({ stopped: true, previousPid: restarted.pid });
      expect(await guard.listWorkbenchProcesses()).toEqual([]);
      expect(await client.ping()).toBe(false);

    } finally {
      try {
        await client.shutdownOwnedWorkbench();
      } catch (error) {
        console.warn("[live-lifecycle-acceptance] exact-owner cleanup refused", error);
      }
      const remaining = await guard.listWorkbenchProcesses();
      if (remaining.length === 0) {
        rmSync(root, { recursive: true, force: true });
        rmSync(managedRoot, { recursive: true, force: true });
      } else {
        throw new Error(
          `live lifecycle acceptance left Workbench running: ${remaining.map((item) => item.pid).join(", ")}`
        );
      }
    }
  }, liveTestTimeoutMs);
});
