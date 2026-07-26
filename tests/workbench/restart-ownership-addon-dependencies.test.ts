import {
  mkdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchSessionController } from "../../src/workbench/session-controller.js";
import {
  cleanupRestartOwnershipFixtures,
  createHarness,
  readValidLifecycleState,
} from "./restart-ownership-fixture.js";

const TARGET_GUID = "1122334455667788";
const DEPENDENCY_GUID = "E62D3489FAA8E058";

function writeProject(
  gprojPath: string,
  id: string,
  guid: string,
  dependencies: readonly string[] = []
): void {
  writeFileSync(gprojPath, [
    "GameProject {",
    ` ID "${id}"`,
    ` GUID "${guid}"`,
    " Dependencies {",
    ...dependencies.map((dependency) => `  "${dependency}"`),
    " }",
    "}",
    "",
  ].join("\n"));
}

function prepareResolvedDependency(
  harness: ReturnType<typeof createHarness>
): { readonly root: string; readonly projectPath: string } {
  const root = join(harness.root, "configured-addons");
  const projectDirectory = join(root, "OnePointZeroOne");
  const projectPath = join(projectDirectory, "OnePointZeroOne.gproj");
  mkdirSync(projectDirectory, { recursive: true });
  writeProject(projectPath, "OnePointZeroOne", DEPENDENCY_GUID);
  harness.config.workbenchAddonDirs = [root];
  return { root, projectPath };
}

async function rejectedLaunch(
  promise: Promise<unknown>
): Promise<Error & { readonly code?: string }> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error & { readonly code?: string };
}

afterEach(cleanupRestartOwnershipFixtures);

describe("owner-scoped editor add-on dependency preflight", () => {
  it("names missing GUIDs and configuration recovery before any native spawn", async () => {
    const harness = createHarness();
    writeProject(
      harness.projectPath,
      "ExampleMod",
      TARGET_GUID,
      [DEPENDENCY_GUID]
    );

    const error = await rejectedLaunch(
      harness.client.ensureRunning(harness.projectPath)
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain(
      `Missing dependency GUID(s): ${DEPENDENCY_GUID}.`
    );
    expect(error.message).toContain("workbenchAddonDirs");
    expect(error.message).toContain("--workbench-addon-dir <directory>");
    expect(error.message).toContain("No Workbench process was launched.");
    expect(harness.children).toHaveLength(0);
    expect(harness.backend.workbenchPids.size).toBe(0);
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(await harness.guard.readSpawnJournal()).toMatchObject({ kind: "missing" });
    expect(await readValidLifecycleState(harness)).toMatchObject({
      phase: "vacant",
      workbench: null,
      operation: null,
    });
  });

  it("launches when the declared dependency resolves uniquely in a configured root", async () => {
    const harness = createHarness();
    writeProject(
      harness.projectPath,
      "ExampleMod",
      TARGET_GUID,
      [DEPENDENCY_GUID]
    );
    const dependency = prepareResolvedDependency(harness);

    await expect(
      harness.client.ensureRunning(harness.projectPath)
    ).resolves.toMatchObject({ action: "launched" });

    expect(harness.children).toHaveLength(1);
    const addonsDirIndex = harness.spawnArgs[0].indexOf("-addonsDir");
    expect(addonsDirIndex).toBeGreaterThanOrEqual(0);
    expect(harness.spawnArgs[0][addonsDirIndex + 1].split(",")).toContain(
      realpathSync.native(dependency.root)
    );

    await harness.client.shutdownOwnedWorkbench();
    expect(await readValidLifecycleState(harness)).toMatchObject({
      phase: "vacant",
      workbench: null,
      operation: null,
    });
  });

  it("re-audits after durable pre_spawn and safely permits a later retry", async () => {
    const harness = createHarness();
    writeProject(
      harness.projectPath,
      "ExampleMod",
      TARGET_GUID,
      [DEPENDENCY_GUID]
    );
    const dependency = prepareResolvedDependency(harness);
    let removed = false;
    harness.backend.afterReplace = ({ next }) => {
      if (!removed && next.phase === "starting" && next.operation?.kind === "launch") {
        removed = true;
        unlinkSync(dependency.projectPath);
      }
    };

    const error = await rejectedLaunch(
      harness.client.ensureRunning(harness.projectPath)
    );

    expect(removed).toBe(true);
    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain(
      `Missing dependency GUID(s): ${DEPENDENCY_GUID}.`
    );
    expect(harness.children).toHaveLength(0);
    expect(harness.backend.workbenchPids.size).toBe(0);
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(await readValidLifecycleState(harness)).toMatchObject({
      phase: "vacant",
      workbench: null,
      operation: null,
    });
    expect(await harness.guard.readSpawnJournal()).toMatchObject({ kind: "missing" });
    await expect(
      WorkbenchSessionController.assertStandaloneEntryReady(
        harness.client.lifecycleExecution
      )
    ).resolves.toBeUndefined();

    harness.backend.afterReplace = null;
    writeProject(
      dependency.projectPath,
      "OnePointZeroOne",
      DEPENDENCY_GUID
    );
    await expect(
      harness.client.ensureRunning(harness.projectPath)
    ).resolves.toMatchObject({ action: "launched" });
    expect(harness.children).toHaveLength(1);
    await harness.client.shutdownOwnedWorkbench();
  });

  it("refuses restart before signalling a healthy editor when a dependency disappears", async () => {
    const harness = createHarness();
    writeProject(
      harness.projectPath,
      "ExampleMod",
      TARGET_GUID,
      [DEPENDENCY_GUID]
    );
    const dependency = prepareResolvedDependency(harness);
    const launched = await harness.client.ensureRunning(harness.projectPath);
    unlinkSync(dependency.projectPath);

    const error = await rejectedLaunch(
      harness.client.restartOwnedWorkbench()
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain(
      `Missing dependency GUID(s): ${DEPENDENCY_GUID}.`
    );
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.children).toHaveLength(1);
    expect(harness.backend.workbenchPids).toEqual(new Set([launched.pid]));
    expect(await readValidLifecycleState(harness)).toMatchObject({
      phase: "running",
      workbench: { pid: launched.pid },
      operation: null,
    });

    writeProject(
      dependency.projectPath,
      "OnePointZeroOne",
      DEPENDENCY_GUID
    );
    await harness.client.shutdownOwnedWorkbench();
  });
});
