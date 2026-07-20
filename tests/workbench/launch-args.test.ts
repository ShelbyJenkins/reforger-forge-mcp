import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildWorkbenchLaunchArgs,
  WorkbenchError,
} from "../../src/workbench/client.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { createFakeCompanionLaunch } from "./fake-companion.js";

function createAddonRoots(root: string): { root: string; base: string; workshop: string } {
  const base = join(root, "Arma Reforger", "addons");
  const workshop = join(root, "My Games", "ArmaReforger", "addons");
  mkdirSync(base, { recursive: true });
  mkdirSync(workshop, { recursive: true });
  return { root, base, workshop };
}

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "reforger-forge-launch-" }));
}

describe("buildWorkbenchLaunchArgs", () => {
  scopedIt("emits one comma-separated addon argument and deduplicates roots", (root) => {
    const { base, workshop } = createAddonRoots(root);
    const gproj = join("C:\\mods", "Example Mod", "ExampleMod.gproj");

    const args = buildWorkbenchLaunchArgs(
      gproj,
      [base, workshop, base],
      true,
      true
    );

    expect(args).toEqual([
      "-addonsDir",
      `${base},${workshop}`,
      "-gproj",
      gproj,
      "-scriptAuthorizeAll",
      "-noThrow",
    ]);
    expect(args.filter((arg) => arg === "-addonsDir")).toHaveLength(1);
  });

  scopedIt("merges the managed companion root and activates its GUID and isolated profile", (root) => {
    const { base, workshop } = createAddonRoots(root);
    const companion = createFakeCompanionLaunch(root);
    const gproj = join(root, "ExampleMod", "ExampleMod.gproj");

    const args = buildWorkbenchLaunchArgs(
      gproj,
      [base, workshop, companion.addonSearchRoot],
      false,
      true,
      "-reforgerForgeOwnerToken=owner-a",
      companion
    );

    expect(args).toEqual([
      "-addonsDir",
      `${base},${workshop},${companion.addonSearchRoot}`,
      "-addons",
      companion.addonGuid,
      "-profile",
      companion.workbenchProfilePath,
      "-gproj",
      gproj,
      "-noThrow",
      "-reforgerForgeOwnerToken=owner-a",
    ]);
    expect(args.filter((arg) => arg === companion.addonSearchRoot)).toHaveLength(0);
  });

  it("omits addon and authorization flags when they are not configured", () => {
    const gproj = join("C:\\mods", "Example Mod", "ExampleMod.gproj");

    expect(buildWorkbenchLaunchArgs(gproj, undefined, false)).toEqual([
      "-gproj",
      gproj,
    ]);
  });

  it("can suppress modal assertion dialogs for automated sessions", () => {
    expect(buildWorkbenchLaunchArgs(null, undefined, false, true)).toEqual([
      "-noThrow",
    ]);
  });

  it("passes the random durable-owner token as one literal argument", () => {
    const ownerArgument = "-reforgerForgeOwnerToken=de305d54-75b4-431b-adb2-eb6b9e546014";

    expect(buildWorkbenchLaunchArgs(null, undefined, false, true, ownerArgument)).toEqual([
      "-noThrow",
      ownerArgument,
    ]);
  });

  scopedIt("rejects missing configured addon roots before launch", (root) => {
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

  scopedIt("rejects configured paths that are not directories", (root) => {
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
