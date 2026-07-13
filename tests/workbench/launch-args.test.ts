import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkbenchLaunchArgs,
  WorkbenchError,
} from "../../src/workbench/client.js";

const tempRoots: string[] = [];

function createAddonRoots(): { base: string; workshop: string } {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-launch-"));
  tempRoots.push(root);

  const base = join(root, "Arma Reforger", "addons");
  const workshop = join(root, "My Games", "ArmaReforger", "addons");
  mkdirSync(base, { recursive: true });
  mkdirSync(workshop, { recursive: true });
  return { base, workshop };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("buildWorkbenchLaunchArgs", () => {
  it("emits one comma-separated addon argument and deduplicates roots", () => {
    const { base, workshop } = createAddonRoots();
    const gproj = join("C:\\mods", "Example Mod", "ExampleMod.gproj");

    const args = buildWorkbenchLaunchArgs(
      gproj,
      [base, workshop, base],
      true
    );

    expect(args).toEqual([
      "-addonsDir",
      `${base},${workshop}`,
      "-gproj",
      gproj,
      "-scriptAuthorizeAll",
    ]);
    expect(args.filter((arg) => arg === "-addonsDir")).toHaveLength(1);
  });

  it("omits addon and authorization flags when they are not configured", () => {
    const gproj = join("C:\\mods", "Example Mod", "ExampleMod.gproj");

    expect(buildWorkbenchLaunchArgs(gproj, undefined, false)).toEqual([
      "-gproj",
      gproj,
    ]);
  });

  it("rejects missing configured addon roots before launch", () => {
    const root = mkdtempSync(join(tmpdir(), "reforger-forge-launch-"));
    tempRoots.push(root);
    const missing = join(root, "missing-addon-root");

    try {
      buildWorkbenchLaunchArgs(null, [missing]);
      throw new Error("Expected buildWorkbenchLaunchArgs to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbenchError);
      expect((error as WorkbenchError).code).toBe("LAUNCH_FAILED");
      expect((error as Error).message).toContain(missing);
    }
  });

  it("rejects configured paths that are not directories", () => {
    const root = mkdtempSync(join(tmpdir(), "reforger-forge-launch-"));
    tempRoots.push(root);
    const filePath = join(root, "not-an-addon-directory");
    writeFileSync(filePath, "test");

    expect(() => buildWorkbenchLaunchArgs(null, [filePath])).toThrow(
      /not a directory/
    );
  });

  it("rejects a non-array addon directory setting", () => {
    expect(() =>
      buildWorkbenchLaunchArgs(
        null,
        "C:\\example\\addons" as unknown as string[]
      )
    ).toThrow(/array of paths/);
  });

  it.each(["", "   ", 42, null])(
    "rejects invalid addon directory entry %j",
    (entry) => {
      expect(() =>
        buildWorkbenchLaunchArgs(
          null,
          [entry] as unknown as string[]
        )
      ).toThrow(/non-empty paths/);
    }
  );

  it("rejects addon directory paths containing commas", () => {
    expect(() =>
      buildWorkbenchLaunchArgs(null, ["C:\\addons,archive"])
    ).toThrow(/cannot contain a comma/);
  });
});
