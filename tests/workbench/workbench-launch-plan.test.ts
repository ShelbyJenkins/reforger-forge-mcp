import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config.js";
import {
  buildCliEditorLaunchPlan,
  buildMcpEditorLaunchPlan,
  buildMcpTargetResourceLaunchPlan,
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
import { canonicalizeResourceTarget } from "../../src/workbench/resource-target.js";
import {
  WORKBENCH_OWNER_ARG_PREFIX,
  WORKBENCH_PROCESS_NAME,
} from "../../src/workbench/process-guard.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { createFakeCompanionLaunch } from "./fake-companion.js";

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

function createHarness(root: string): LaunchHarness {
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

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "reforger-forge-plan-" }));
}

describe("canonical Workbench launch-plan policy", () => {
  scopedIt("builds the visible detached MCP editor plan with exact helper readiness", (root) => {
    const harness = createHarness(root);
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
        showWindow: "normal",
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
      [
        harness.baseAddonRoot,
        harness.targetAddonRoot,
        realpathSync.native(harness.companion.addonSearchRoot),
      ].join(","),
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

  scopedIt("binds a fresh MCP editor to one canonical .ent through the Workbench -load argument", (root) => {
    const harness = createHarness(root);
    const resourcePath = join(harness.project.modDirectory, "Worlds", "Target.ent");
    mkdirSync(dirname(resourcePath), { recursive: true });
    writeFileSync(resourcePath, "SubScene {}\n");
    writeFileSync(`${resourcePath}.meta`, "MetaFileClass {}\n");
    const resource = canonicalizeResourceTarget(resourcePath, harness.project);

    const plan = buildMcpTargetResourceLaunchPlan({
      kind: "mcp_target_resource",
      config: harness.config,
      project: harness.project,
      resource,
      companion: harness.companion,
      endpoint: { host: "127.0.0.1", port: 5775 },
      ownerArgument: OWNER_ARGUMENT,
      managedRoot: harness.managedRoot,
    });

    expect(plan.kind).toBe("mcp_target_resource");
    expect(plan.resource.displayPath).toBe(realpathSync.native(resourcePath));
    expect(plan.spawnOptions.showWindow).toBe("normal");
    expect(plan.argv).toEqual([
      "-addonsDir",
      [
        harness.baseAddonRoot,
        harness.targetAddonRoot,
        realpathSync.native(harness.companion.addonSearchRoot),
      ].join(","),
      "-addons",
      WORKBENCH_HELPER_ADDON_GUID,
      "-profile",
      realpathSync.native(harness.companion.workbenchProfilePath),
      "-gproj",
      harness.projectPath,
      "-scriptAuthorizeAll",
      "-noThrow",
      OWNER_ARGUMENT,
      "-wbModule=WorldEditor",
      "-run",
      "-load",
      realpathSync.native(resourcePath),
      "-reforgerForgeExplicitTarget",
      realpathSync.native(resourcePath),
    ]);
    expect(plan.argv).not.toContain("-forceSaveAll");
  });

  scopedIt("builds the visible foreground CLI editor plan with World Editor lifetime policy", (root) => {
    const harness = createHarness(root);
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
      showWindow: "normal",
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

  scopedIt("builds a hidden target-only Resource Manager plan with no helper or NET capability", (root) => {
    const harness = createHarness(root);
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
        showWindow: "normal",
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

  scopedIt("returns deeply immutable policy objects and the one lifecycle target projection", (root) => {
    const harness = createHarness(root);
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
  scopedIt("deduplicates canonical add-on roots and rejects missing, comma, and non-array inputs", (root) => {
    const harness = createHarness(root);
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

  scopedIt("rejects malformed owners and non-numeric loopback editor endpoints", (root) => {
    const harness = createHarness(root);
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

  scopedIt("rejects a duplicate helper identity exposed by another configured add-on root", (root) => {
    const harness = createHarness(root);
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

  scopedIt("rejects helper profile and managed-root overlap with the target", (root) => {
    const harness = createHarness(root);
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

  scopedIt("rejects forged build profiles, overlapping output, and managed add-on roots", (root) => {
    const harness = createHarness(root);
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

  scopedIt("rejects cross-kind fields, policy overrides, unsupported platforms, and unbounded builds", (root) => {
    const harness = createHarness(root);
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

  scopedIt("enforces -noThrow as an invariant of managed editor launches", (root) => {
    const harness = createHarness(root);
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
