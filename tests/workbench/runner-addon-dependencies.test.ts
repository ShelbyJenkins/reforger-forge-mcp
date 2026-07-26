import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRunnerHarnesses,
  createBuildSpawner,
  createHarness,
  runBuild,
} from "./runner-fixture.js";

const MISSING_FIRST = "64B73652C12170E6";
const MISSING_SECOND = "64C912EF952E1075";
const LOCAL_DEPENDENCY = "BBBBBBBBBBBBBBBB";

afterEach(cleanupRunnerHarnesses);

function writeTarget(
  path: string,
  dependencies: readonly string[]
): void {
  writeFileSync(path, [
    "GameProject {",
    ' ID "ExampleMod"',
    ' GUID "1122334455667788"',
    " Dependencies {",
    ...dependencies.map((guid) => `  "${guid}"`),
    " }",
    "}",
    "",
  ].join("\n"));
}

describe("Workbench runner add-on dependency preflight", () => {
  it("reports every missing GUID and recovery configuration before spawning Workbench", async () => {
    const harness = createHarness();
    writeTarget(harness.projectPath, [MISSING_SECOND, MISSING_FIRST]);
    const spawnProcess = vi.fn();

    const error = await runBuild(harness, spawnProcess).then(
      () => null,
      (failure: unknown) => failure
    );

    expect(error).toMatchObject({ code: "INVALID_CONFIG" });
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`Missing dependency GUID(s): ${MISSING_FIRST}, ${MISSING_SECOND}.`);
    expect(message).toContain("workbenchAddonDirs");
    expect(message).toContain("--workbench-addon-dir <directory>");
    expect(message).toContain("No Workbench process was launched.");
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(harness.backend.workbenchPids.size).toBe(0);
  });

  it("accepts a uniquely resolved dependency in the target's sibling add-on container", async () => {
    const harness = createHarness();
    writeTarget(harness.projectPath, [LOCAL_DEPENDENCY]);
    const dependencyDirectory = join(harness.root, "addons", "Dependency");
    mkdirSync(dependencyDirectory, { recursive: true });
    writeFileSync(join(dependencyDirectory, "Dependency.gproj"), [
      "GameProject {",
      ' ID "Dependency"',
      ` GUID "${LOCAL_DEPENDENCY}"`,
      "}",
      "",
    ].join("\n"));
    const spawner = createBuildSpawner(harness, { pidBase: 24_012 });

    await expect(runBuild(harness, spawner.spawnProcess)).resolves.toMatchObject({
      intent: "build",
    });
    expect(spawner.spawnCount()).toBe(1);
  });

  it("directs ambiguous GUIDs toward duplicate removal rather than another root", async () => {
    const harness = createHarness();
    writeTarget(harness.projectPath, [LOCAL_DEPENDENCY]);
    for (const name of ["DuplicateOne", "DuplicateTwo"]) {
      const directory = join(harness.root, "addons", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${name}.gproj`), [
        "GameProject {",
        ` ID "${name}"`,
        ` GUID "${LOCAL_DEPENDENCY}"`,
        "}",
        "",
      ].join("\n"));
    }
    const spawnProcess = vi.fn();

    const error = await runBuild(harness, spawnProcess).then(
      () => null,
      (failure: unknown) => failure
    );

    expect(error).toMatchObject({ code: "INVALID_CONFIG" });
    const message = (error as Error).message;
    expect(message).toContain(`Ambiguous dependency GUID(s): ${LOCAL_DEPENDENCY}.`);
    expect(message).toContain("Remove or disable duplicate projects");
    expect(message).not.toContain("Add the add-on root");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("re-audits dependencies at the durable pre-spawn cut", async () => {
    const harness = createHarness();
    writeTarget(harness.projectPath, [LOCAL_DEPENDENCY]);
    const dependencyDirectory = join(harness.root, "addons", "Dependency");
    const dependencyPath = join(dependencyDirectory, "Dependency.gproj");
    mkdirSync(dependencyDirectory, { recursive: true });
    writeFileSync(dependencyPath, [
      "GameProject {",
      ' ID "Dependency"',
      ` GUID "${LOCAL_DEPENDENCY}"`,
      "}",
      "",
    ].join("\n"));
    let removed = false;
    harness.backend.afterReplace = ({ next }) => {
      if (!removed && next.phase === "starting") {
        removed = true;
        unlinkSync(dependencyPath);
      }
    };
    const spawnProcess = vi.fn();

    const error = await runBuild(harness, spawnProcess).then(
      () => null,
      (failure: unknown) => failure
    );

    expect(removed).toBe(true);
    expect(error).toMatchObject({ code: "INVALID_CONFIG" });
    expect((error as Error).message).toContain(
      `Missing dependency GUID(s): ${LOCAL_DEPENDENCY}.`
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
