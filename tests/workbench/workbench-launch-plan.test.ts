import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config.js";
import {
  buildCliEditorLaunchPlan,
  buildMcpEditorLaunchPlan,
  buildTargetBuildLaunchPlan,
  buildWorkbenchLaunchPlan,
  canonicalizeWorkbenchAddonDirectories,
  ensureWorkbenchManagedBuildProfile,
  toLifecycleTarget,
  WorkbenchLaunchPlanError,
  type WorkbenchManagedBuildProfile,
} from "../../src/workbench/launch-plan.js";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
} from "../../src/workbench/helper-addon.js";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";
import {
  WORKBENCH_OWNER_ARG_PREFIX,
  WORKBENCH_PROCESS_NAME,
} from "../../src/workbench/process-guard.js";
import { createFakeCompanionLaunch } from "./fake-companion.js";

const roots: string[] = [];
const OWNER_ARGUMENT = `${WORKBENCH_OWNER_ARG_PREFIX}owner-a`;

interface LaunchHarness {
  root: string;
  config: Pick<
    Config,
    | "workbenchPath"
    | "gamePath"
    | "workbenchAddonDirs"
    | "workbenchScriptAuthorizeAll"
  >;
  executablePath: string;
  gameRoot: string;
  baseAddonRoot: string;
  targetAddonRoot: string;
  projectPath: string;
  project: ReturnType<typeof canonicalizeGproj>;
  companion: ReturnType<typeof createFakeCompanionLaunch>;
  managedRoot: string;
  buildProfile: Readonly<WorkbenchManagedBuildProfile>;
  outputPath: string;
}

function createHarness(): LaunchHarness {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-plan-"));
  roots.push(root);
  const toolsRoot = join(root, "Arma Reforger Tools");
  const executablePath = join(toolsRoot, "Workbench", WORKBENCH_PROCESS_NAME);
  const gameRoot = join(root, "Arma Reforger");
  const baseAddonRoot = join(gameRoot, "addons");
  const targetAddonRoot = join(root, "projects", "addons");
  const projectDirectory = join(targetAddonRoot, "ExampleMod");
  const projectPath = join(projectDirectory, "ExampleMod.gproj");
  const managedRoot = join(root, "private-managed");
  const outputPath = join(root, "build-output");

  mkdirSync(dirname(executablePath), { recursive: true });
  mkdirSync(baseAddonRoot, { recursive: true });
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
  const buildProfile = ensureWorkbenchManagedBuildProfile(managedRoot, project);
  return {
    root,
    config: {
      workbenchPath: toolsRoot,
      gamePath: gameRoot,
      workbenchAddonDirs: [baseAddonRoot, baseAddonRoot],
      workbenchScriptAuthorizeAll: true,
    },
    executablePath: realpathSync.native(executablePath),
    gameRoot: realpathSync.native(gameRoot),
    baseAddonRoot: realpathSync.native(baseAddonRoot),
    targetAddonRoot: realpathSync.native(targetAddonRoot),
    projectPath: realpathSync.native(projectPath),
    project,
    companion,
    managedRoot: realpathSync.native(managedRoot),
    buildProfile,
    outputPath: realpathSync.native(outputPath),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("canonical Workbench launch-plan policy", () => {
  it("builds the visible detached MCP editor plan with exact helper readiness", () => {
    const harness = createHarness();
    const plan = buildMcpEditorLaunchPlan({
      kind: "mcp_editor",
      config: harness.config,
      project: harness.project,
      companion: harness.companion,
      endpoint: { host: "127.0.0.1", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
      managedRoot: harness.managedRoot,
    });

    expect(plan).toMatchObject({
      kind: "mcp_editor",
      window: "visible",
      process: "detached",
      executablePath: harness.executablePath,
      lifecycleTarget: {
        path: harness.projectPath,
        comparisonKey: harness.project.comparisonKey,
      },
      spawnOptions: {
        cwd: harness.gameRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        shell: false,
      },
      readiness: {
        kind: "companion_net_api",
        endpoint: { host: "127.0.0.1", port: 5775 },
        requireEndpointOwnership: true,
        pingFunction: "EMCP_WB_Ping",
        expected: {
          addonId: WORKBENCH_HELPER_ADDON_ID,
          addonGuid: WORKBENCH_HELPER_ADDON_GUID,
          bundleDigest: harness.companion.bundleDigest,
        },
      },
      lifetime: { kind: "return_after_ready", supervised: true },
    });
    expect(plan.argv).toEqual([
      "-addonsDir",
      `${harness.baseAddonRoot},${realpathSync.native(harness.companion.addonSearchRoot)}`,
      "-addons",
      WORKBENCH_HELPER_ADDON_GUID,
      "-profile",
      realpathSync.native(harness.companion.workbenchProfilePath),
      "-gproj",
      harness.projectPath,
      "-scriptAuthorizeAll",
      "-noThrow",
      OWNER_ARGUMENT,
    ]);
    expect(plan.argv.filter((arg) => arg.startsWith(WORKBENCH_OWNER_ARG_PREFIX))).toEqual([
      OWNER_ARGUMENT,
    ]);
  });

  it("builds the visible foreground CLI editor plan with World Editor lifetime policy", () => {
    const harness = createHarness();
    const plan = buildWorkbenchLaunchPlan({
      kind: "cli_editor",
      config: harness.config,
      project: harness.project,
      companion: harness.companion,
      endpoint: { host: "127.7.8.9", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
      managedRoot: harness.managedRoot,
    });

    expect(plan.kind).toBe("cli_editor");
    if (plan.kind !== "cli_editor") throw new Error("expected CLI editor plan");
    expect(plan.window).toBe("visible");
    expect(plan.process).toBe("foreground");
    expect(plan.spawnOptions).toEqual({
      cwd: dirname(harness.executablePath),
      detached: false,
      stdio: "ignore",
      windowsHide: false,
      shell: false,
    });
    expect(plan.lifetime).toEqual({ kind: "wait_for_exit_or_abort", supervised: true });
    expect(plan.argv).toEqual([
      "-addonsDir",
      [
        harness.baseAddonRoot,
        harness.targetAddonRoot,
        realpathSync.native(harness.companion.addonSearchRoot),
      ].join(","),
      "-profile",
      realpathSync.native(harness.companion.workbenchProfilePath),
      "-noThrow",
      "-scriptAuthorizeAll",
      "-addons",
      WORKBENCH_HELPER_ADDON_GUID,
      "-gproj",
      harness.projectPath,
      OWNER_ARGUMENT,
      "-wbModule=WorldEditor",
      "-run",
    ]);
  });

  it("builds a hidden target-only Resource Manager plan with no helper or NET capability", () => {
    const harness = createHarness();
    const plan = buildTargetBuildLaunchPlan({
      kind: "target_build",
      config: harness.config,
      project: harness.project,
      ownerArgument: OWNER_ARGUMENT,
      managedProfile: harness.buildProfile,
      outputPath: harness.outputPath,
      platform: "PC",
      timeoutMs: 300_000,
    });

    expect(plan).toMatchObject({
      kind: "target_build",
      window: "hidden",
      process: "foreground",
      helper: null,
      readiness: { kind: "none" },
      lifetime: {
        kind: "bounded_exit_and_output",
        timeoutMs: 300_000,
        absoluteDeadline: true,
      },
      targetAddon: {
        addonId: "ExampleMod",
        addonGuid: "1122334455667788",
      },
      spawnOptions: {
        cwd: dirname(harness.executablePath),
        detached: false,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      },
    });
    expect(plan.argv).toEqual([
      "-addonsDir",
      `${harness.baseAddonRoot},${harness.targetAddonRoot}`,
      "-profile",
      harness.buildProfile.profilePath,
      "-noThrow",
      "-scriptAuthorizeAll",
      "-gproj",
      harness.projectPath,
      "-gprojConfig",
      "PC",
      OWNER_ARGUMENT,
      "-wbModule=ResourceManager",
      "-builddata",
      "PC",
      harness.outputPath,
      "ExampleMod",
    ]);
    expect(plan.argv).not.toContain("-run");
    expect(plan.argv).not.toContain("-addons");
    expect(plan.argv).not.toContain(WORKBENCH_HELPER_ADDON_GUID);
    expect(plan.argv).not.toContain("-buildData");
    expect(plan.argv.slice(plan.argv.indexOf("-builddata"), plan.argv.length)).toEqual([
      "-builddata",
      "PC",
      harness.outputPath,
      "ExampleMod",
    ]);
    expect(plan.argv.filter((arg) => arg.startsWith(WORKBENCH_OWNER_ARG_PREFIX))).toEqual([
      OWNER_ARGUMENT,
    ]);
  });

  it("returns deeply immutable policy objects and the one lifecycle target projection", () => {
    const harness = createHarness();
    const plan = buildCliEditorLaunchPlan({
      kind: "cli_editor",
      config: harness.config,
      project: harness.project,
      companion: harness.companion,
      endpoint: { host: "127.0.0.1", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
      managedRoot: harness.managedRoot,
    });

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.argv)).toBe(true);
    expect(Object.isFrozen(plan.spawnOptions)).toBe(true);
    expect(Object.isFrozen(plan.project)).toBe(true);
    expect(Object.isFrozen(plan.lifecycleTarget)).toBe(true);
    expect(Object.isFrozen(plan.helper)).toBe(true);
    expect(Object.isFrozen(plan.readiness)).toBe(true);
    expect(Object.isFrozen(plan.readiness.expected)).toBe(true);
    expect(Object.isFrozen(plan.lifetime)).toBe(true);
    expect(toLifecycleTarget(harness.project)).toEqual(plan.lifecycleTarget);
  });
});

describe("launch-plan validation", () => {
  it("deduplicates canonical add-on roots and rejects missing, comma, and non-array inputs", () => {
    const harness = createHarness();
    expect(canonicalizeWorkbenchAddonDirectories([
      harness.baseAddonRoot,
      harness.baseAddonRoot,
    ])).toEqual([harness.baseAddonRoot]);
    expect(() => canonicalizeWorkbenchAddonDirectories([
      join(harness.root, "missing"),
    ])).toThrow(/accessible directory/);
    expect(() => canonicalizeWorkbenchAddonDirectories([
      `${harness.baseAddonRoot},archive`,
    ])).toThrow(/comma/);
    expect(() => canonicalizeWorkbenchAddonDirectories(
      harness.baseAddonRoot as unknown as string[]
    )).toThrow(/array/);
  });

  it("rejects malformed owners and non-numeric loopback editor endpoints", () => {
    const harness = createHarness();
    const base = {
      kind: "mcp_editor" as const,
      config: harness.config,
      project: harness.project,
      companion: harness.companion,
      managedRoot: harness.managedRoot,
    };
    for (const ownerArgument of ["owner-a", WORKBENCH_OWNER_ARG_PREFIX, `${OWNER_ARGUMENT} bad`]) {
      expect(() => buildMcpEditorLaunchPlan({
        ...base,
        endpoint: { host: "127.0.0.1", port: 5775 },
        ownerArgument,
      })).toThrow(WorkbenchLaunchPlanError);
    }
    expect(() => buildMcpEditorLaunchPlan({
      ...base,
      endpoint: { host: "localhost", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
    })).toThrow(/numeric loopback/);
  });

  it("rejects a duplicate helper identity exposed by another configured add-on root", () => {
    const harness = createHarness();
    const duplicateRoot = join(harness.root, "duplicate-addons");
    mkdirSync(join(duplicateRoot, WORKBENCH_HELPER_ADDON_ID), { recursive: true });
    expect(() => buildMcpEditorLaunchPlan({
      kind: "mcp_editor",
      config: { ...harness.config, workbenchAddonDirs: [duplicateRoot] },
      project: harness.project,
      companion: harness.companion,
      endpoint: { host: "127.0.0.1", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
      managedRoot: harness.managedRoot,
    })).toThrow(/second ReforgerForgeWorkbenchHelper/);
  });

  it("rejects helper profile and managed-root overlap with the target", () => {
    const harness = createHarness();
    const profileInTarget = join(harness.project.modDirectory, "profile");
    mkdirSync(profileInTarget, { recursive: true });
    expect(() => buildMcpEditorLaunchPlan({
      kind: "mcp_editor",
      config: harness.config,
      project: harness.project,
      companion: { ...harness.companion, workbenchProfilePath: profileInTarget },
      endpoint: { host: "127.0.0.1", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
    })).toThrow(/must not overlap the target project/);

    expect(() => ensureWorkbenchManagedBuildProfile(
      join(harness.project.modDirectory, "managed"),
      harness.project
    )).toThrow(/must not overlap the target project/);
  });

  it("rejects forged build profiles, overlapping output, and managed add-on roots", () => {
    const harness = createHarness();
    const outsideProfile = join(harness.root, "outside-profile");
    mkdirSync(outsideProfile, { recursive: true });
    expect(() => buildTargetBuildLaunchPlan({
      kind: "target_build",
      config: harness.config,
      project: harness.project,
      ownerArgument: OWNER_ARGUMENT,
      managedProfile: { ...harness.buildProfile, profilePath: outsideProfile },
      outputPath: harness.outputPath,
      platform: "PC",
      timeoutMs: 1_000,
    })).toThrow(/dedicated managed role/);

    const managedOutput = join(harness.buildProfile.roleRoot, "output");
    mkdirSync(managedOutput, { recursive: true });
    expect(() => buildTargetBuildLaunchPlan({
      kind: "target_build",
      config: harness.config,
      project: harness.project,
      ownerArgument: OWNER_ARGUMENT,
      managedProfile: harness.buildProfile,
      outputPath: managedOutput,
      platform: "PC",
      timeoutMs: 1_000,
    })).toThrow(/output must not overlap the managed root/);

    expect(() => buildTargetBuildLaunchPlan({
      kind: "target_build",
      config: { ...harness.config, workbenchAddonDirs: [harness.managedRoot] },
      project: harness.project,
      ownerArgument: OWNER_ARGUMENT,
      managedProfile: harness.buildProfile,
      outputPath: harness.outputPath,
      platform: "PC",
      timeoutMs: 1_000,
    })).toThrow(/must not include the private managed root/);

    const externalHelperSearchRoot = join(harness.root, "external-addons");
    mkdirSync(join(externalHelperSearchRoot, "ReforgerForgeWorkbenchHelper"), {
      recursive: true,
    });
    expect(() => buildTargetBuildLaunchPlan({
      kind: "target_build",
      config: { ...harness.config, workbenchAddonDirs: [externalHelperSearchRoot] },
      project: harness.project,
      ownerArgument: OWNER_ARGUMENT,
      managedProfile: harness.buildProfile,
      outputPath: harness.outputPath,
      platform: "PC",
      timeoutMs: 1_000,
    })).toThrow(/must not expose ReforgerForgeWorkbenchHelper/);
  });

  it("rejects cross-kind fields, policy overrides, unsupported platforms, and unbounded builds", () => {
    const harness = createHarness();
    const target = {
      kind: "target_build" as const,
      config: harness.config,
      project: harness.project,
      ownerArgument: OWNER_ARGUMENT,
      managedProfile: harness.buildProfile,
      outputPath: harness.outputPath,
      platform: "PC" as const,
      timeoutMs: 1_000,
    };
    expect(() => buildWorkbenchLaunchPlan({
      ...target,
      companion: harness.companion,
    } as unknown as Parameters<typeof buildWorkbenchLaunchPlan>[0])).toThrow(/companion policy override/);
    expect(() => buildWorkbenchLaunchPlan({
      kind: "cli_editor",
      config: harness.config,
      project: harness.project,
      companion: harness.companion,
      endpoint: { host: "127.0.0.1", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
      managedRoot: harness.managedRoot,
      windowsHide: true,
    } as unknown as Parameters<typeof buildWorkbenchLaunchPlan>[0])).toThrow(/windowsHide policy override/);
    expect(() => buildTargetBuildLaunchPlan({
      ...target,
      platform: "Console",
    } as unknown as Parameters<typeof buildTargetBuildLaunchPlan>[0])).toThrow(/only platform PC/);
    for (const timeoutMs of [0, -1, 3_600_001, Number.POSITIVE_INFINITY]) {
      expect(() => buildTargetBuildLaunchPlan({ ...target, timeoutMs })).toThrow(/timeoutMs/);
    }
  });

  it("enforces -noThrow as an invariant of managed editor launches", () => {
    const harness = createHarness();
    const plan = buildMcpEditorLaunchPlan({
      kind: "mcp_editor",
      config: harness.config,
      project: harness.project,
      companion: harness.companion,
      endpoint: { host: "127.0.0.1", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
      managedRoot: harness.managedRoot,
    });
    expect(plan.argv.filter((arg) => arg === "-noThrow")).toHaveLength(1);
  });
});
