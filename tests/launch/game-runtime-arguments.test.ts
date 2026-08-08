import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGameRuntimeArguments,
  gameRuntimeWorldSelector,
} from "../../src/launch/game-runtime-arguments.js";
import { GameLaunchPlanError } from "../../src/launch/game-launch-errors.js";
import {
  assertCompositeLaunchArguments,
  deriveGameLaunchProfilePath,
} from "../../src/observer/launch-policy.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const TARGET_GUID = "AAAAAAAAAAAAAAAA";

describe("game runtime argument policy", () => {
  it.each([
    ["client", "-world"],
    ["listenServer", "-server"],
  ] as const)("maps %s to %s and selects only the target GUID", (runtimeKind, selector) => {
    const roots = ["C:\\mods-one", "D:\\mods-two"];
    const result = buildGameRuntimeArguments({
      runtimeKind,
      worldResourceReference: "{1111111111111111}Worlds/Test.ent",
      emittedAddonRoots: roots,
      targetAddonGuid: TARGET_GUID,
      extraArguments: ["-maxFPS", "60"],
    });

    expect(gameRuntimeWorldSelector(runtimeKind)).toBe(selector);
    expect(result).toEqual([
      "-noSplash",
      "-noThrow",
      "-disableCrashReporter",
      selector,
      "{1111111111111111}Worlds/Test.ent",
      "-addonsDir",
      roots.join(","),
      "-addons",
      TARGET_GUID,
      "-maxFPS",
      "60",
    ]);
    expect(result).not.toContain("-scenarioId");
    if (runtimeKind === "client") expect(result).not.toContain("-client");
  });

  it.each([
    "-profile", "-profile=value", "-logsDir", "-addonsDir=x", "-addons",
    "-addonDownloadDir=x", "-world", "-server=x", "-client", "-config=x",
    "-worldSystemsConfig", "-forceUpdate", "-noFocus", "-noSplash", "-noThrow",
    "-disableCrashReporter", "-window", "-screenWidth=1280", "-screenHeight",
    "-reforgerForgeOwnerToken", "-reforgerForgeOwnerToken=secret",
  ])("refuses composite-reserved token %s", (token) => {
    expect(() => assertCompositeLaunchArguments([token])).toThrowError(
      expect.objectContaining<Partial<GameLaunchPlanError>>({ code: "ARGUMENT_CONFLICT" }),
    );
  });

  it("rejects empty, control, per-token, and aggregate overflow", () => {
    expect(() => assertCompositeLaunchArguments([""])).toThrowError(GameLaunchPlanError);
    expect(() => assertCompositeLaunchArguments(["ok\nnot-ok"])).toThrowError(GameLaunchPlanError);
    expect(() => assertCompositeLaunchArguments(["x".repeat(8_193)])).toThrowError(GameLaunchPlanError);
    expect(() => assertCompositeLaunchArguments(Array.from({ length: 4 }, () => "x".repeat(8_000))))
      .toThrowError(GameLaunchPlanError);
  });

  it("derives one stable non-creating 32-hex project profile", async () => {
    await withTemporaryDirectory((root) => {
      const profileRoot = join(root, "profiles-not-created");
      const first = deriveGameLaunchProfilePath(profileRoot, "c:/mods/example/example.gproj");
      const second = deriveGameLaunchProfilePath(profileRoot, "c:/mods/example/example.gproj");
      const other = deriveGameLaunchProfilePath(profileRoot, "c:/mods/other/other.gproj");

      expect(first).toBe(second);
      expect(first).not.toBe(other);
      expect(first).toMatch(/[\\/]derived-v1[\\/][a-f0-9]{32}$/);
      expect(existsSync(profileRoot)).toBe(false);
    }, { prefix: "rfo-derived-game-profile-" });
  });
});
