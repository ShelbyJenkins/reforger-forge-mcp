import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeGameAddonEvidenceDigest,
  resolveGameAddonPlan,
  revalidateGameAddonPlan,
  type ResolveGameAddonPlanOptions,
} from "../../src/launch/game-addon-plan.js";
import { GameLaunchPlanError } from "../../src/launch/game-launch-errors.js";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const TARGET_GUID = "AAAAAAAAAAAAAAAA";
const DEPENDENCY_B = "BBBBBBBBBBBBBBBB";
const DEPENDENCY_C = "CCCCCCCCCCCCCCCC";

function writeProject(
  directory: string,
  filename: string,
  guid: string,
  dependencies: readonly string[],
  suffix = "",
): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  writeFileSync(path, [
    "GameProject {",
    ` ID "${filename.replace(/\.gproj$/i, "")}"`,
    ` GUID "${guid}"`,
    " Dependencies {",
    ...dependencies.map((dependency) => `  "${dependency}"`),
    " }",
    suffix,
    "}",
    "",
  ].join("\n"));
  return path;
}

function fixtureOptions(
  root: string,
  target: string,
  configuredAddonRoots: readonly string[] = [],
): ResolveGameAddonPlanOptions {
  return {
    project: canonicalizeGproj(target),
    configuredAddonRoots,
    executablePath: join(root, "game", "ArmaReforgerSteamDiag.exe"),
    profilePath: join(root, "private", "profiles", "derived-v1", "a".repeat(32)),
    managedRoot: join(root, "private", "managed"),
    profileRoot: join(root, "private", "profiles"),
  };
}

function expectPlanError(operation: () => unknown, code: string): GameLaunchPlanError {
  try {
    operation();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(GameLaunchPlanError);
    expect(error).toMatchObject({ code });
    return error as GameLaunchPlanError;
  }
}

describe("game add-on plan", () => {
  it("proves one target and its transitive graph while preserving configured root order", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(join(root, "workspace", "Target"), "Target.gproj", TARGET_GUID, [DEPENDENCY_B]);
      const first = join(root, "first-addons");
      const second = join(root, "second-addons");
      mkdirSync(first, { recursive: true });
      writeProject(join(second, "B"), "B.gproj", DEPENDENCY_B, [DEPENDENCY_C]);
      writeProject(join(first, "C"), "C.gproj", DEPENDENCY_C.toLowerCase(), []);

      const plan = resolveGameAddonPlan(fixtureOptions(root, target, [second, first, second]));

      expect(plan.targetGuid).toBe(TARGET_GUID);
      expect(plan.addonGuids).toEqual([TARGET_GUID]);
      expect(plan.dependencyGuids).toEqual([DEPENDENCY_B, DEPENDENCY_C]);
      expect(plan.resolvedDependencies.map(({ guid, addonRoot }) => ({ guid, addonRoot }))).toEqual([
        { guid: DEPENDENCY_B, addonRoot: second },
        { guid: DEPENDENCY_C, addonRoot: first },
      ]);
      expect(plan.emittedAddonRoots).toEqual([second, first, join(root, "workspace")]);
      expect(plan.implicitAddonRoots).toEqual([
        join(root, "game", "addons"),
        join(root, "private", "profiles", "derived-v1", "a".repeat(32), "profile", "addons"),
      ]);
      expect(plan.roots.filter((candidate) => candidate.prospectiveImplicit))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ exists: false, emitted: false, provenance: ["installation_addons"] }),
          expect.objectContaining({ exists: false, emitted: false, provenance: ["profile_addons"] }),
        ]));
      expect(revalidateGameAddonPlan(plan).addonEvidenceDigest).toBe(plan.addonEvidenceDigest);
      expect(computeGameAddonEvidenceDigest(plan)).toBe(plan.addonEvidenceDigest);
    }, { prefix: "rfo-game-addon-plan-success-" });
  });

  it("refuses missing, ambiguous, and malformed declared dependencies", async () => {
    await withTemporaryDirectory((root) => {
      const missingTarget = writeProject(join(root, "missing", "Target"), "Target.gproj", TARGET_GUID, [DEPENDENCY_B]);
      expectPlanError(() => resolveGameAddonPlan(fixtureOptions(root, missingTarget)), "ADDON_DEPENDENCY_MISSING");

      const ambiguousTarget = writeProject(join(root, "ambiguous", "Target"), "Target.gproj", TARGET_GUID, [DEPENDENCY_B]);
      const first = join(root, "ambiguous-one");
      const second = join(root, "ambiguous-two");
      writeProject(join(first, "B"), "B.gproj", DEPENDENCY_B, []);
      writeProject(join(second, "B"), "B.gproj", DEPENDENCY_B, []);
      expectPlanError(
        () => resolveGameAddonPlan(fixtureOptions(root, ambiguousTarget, [first, second])),
        "ADDON_DEPENDENCY_AMBIGUOUS",
      );

      const malformedTarget = writeProject(join(root, "malformed", "Target"), "Target.gproj", TARGET_GUID, ["not-a-guid"]);
      expectPlanError(
        () => resolveGameAddonPlan(fixtureOptions(root, malformedTarget)),
        "ADDON_DEPENDENCY_MALFORMED",
      );
    }, { prefix: "rfo-game-addon-plan-findings-" });
  });

  it("refuses another provider of the target GUID but ignores unrelated duplicates", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(join(root, "workspace", "Target"), "Target.gproj", TARGET_GUID, []);
      const addons = join(root, "addons");
      writeProject(join(addons, "UnusedOne"), "Unused.gproj", DEPENDENCY_B, []);
      writeProject(join(root, "other-addons", "UnusedTwo"), "Unused.gproj", DEPENDENCY_B, []);

      expect(resolveGameAddonPlan(fixtureOptions(root, target, [addons, join(root, "other-addons")])).targetGuid)
        .toBe(TARGET_GUID);

      writeProject(join(addons, "Collision"), "Collision.gproj", TARGET_GUID, []);
      expectPlanError(
        () => resolveGameAddonPlan(fixtureOptions(root, target, [addons])),
        "ADDON_TARGET_COLLISION",
      );
    }, { prefix: "rfo-game-addon-plan-target-" });
  });

  it("bounds manifests and candidate enumeration", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(join(root, "workspace", "Target"), "Target.gproj", TARGET_GUID, []);
      const addons = join(root, "addons");
      writeProject(join(addons, "B"), "B.gproj", DEPENDENCY_B, [], " // padding".repeat(64));

      expectPlanError(
        () => resolveGameAddonPlan({
          ...fixtureOptions(root, target, [addons]),
          scanLimits: { maximumManifestBytes: 64 },
        }),
        "ADDON_MANIFEST_OVERSIZE",
      );
      expectPlanError(
        () => resolveGameAddonPlan({
          ...fixtureOptions(root, target, [addons]),
          scanLimits: { maximumCandidates: 1 },
        }),
        "ADDON_SCAN_TRUNCATED",
      );
    }, { prefix: "rfo-game-addon-plan-bounds-" });
  });

  it("refuses private-root overlap and comma-delimited emitted roots", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(join(root, "workspace", "Target"), "Target.gproj", TARGET_GUID, []);
      const badRoot = join(root, "bad,addons");
      mkdirSync(badRoot, { recursive: true });
      expectPlanError(
        () => resolveGameAddonPlan(fixtureOptions(root, target, [badRoot])),
        "ADDON_ROOT_UNREADABLE",
      );
      expectPlanError(
        () => resolveGameAddonPlan({
          ...fixtureOptions(root, target),
          managedRoot: join(root, "workspace", "Target", "private"),
        }),
        "ADDON_ROOT_CONFLICT",
      );
    }, { prefix: "rfo-game-addon-plan-roots-" });
  });

  it("changes the complete digest and refuses revalidation when manifest bytes change", async () => {
    await withTemporaryDirectory((root) => {
      const targetDirectory = join(root, "workspace", "Target");
      const target = writeProject(targetDirectory, "Target.gproj", TARGET_GUID, []);
      const plan = resolveGameAddonPlan(fixtureOptions(root, target));

      writeProject(targetDirectory, "Target.gproj", TARGET_GUID, [], " // identity-changing comment");

      const current = resolveGameAddonPlan(fixtureOptions(root, target));
      expect(current.emittedAddonRoots).toEqual(plan.emittedAddonRoots);
      expect(current.addonGuids).toEqual(plan.addonGuids);
      expect(current.addonEvidenceDigest).not.toBe(plan.addonEvidenceDigest);
      expectPlanError(() => revalidateGameAddonPlan(plan), "ADDON_CHANGED");
    }, { prefix: "rfo-game-addon-plan-revalidate-" });
  });

  it("rejects a tampered stored digest before touching the filesystem", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(join(root, "workspace", "Target"), "Target.gproj", TARGET_GUID, []);
      const plan = resolveGameAddonPlan(fixtureOptions(root, target));
      expectPlanError(
        () => revalidateGameAddonPlan({ ...plan, targetGuid: DEPENDENCY_B }),
        "ADDON_EVIDENCE_INVALID",
      );
    }, { prefix: "rfo-game-addon-plan-tamper-" });
  });
});
