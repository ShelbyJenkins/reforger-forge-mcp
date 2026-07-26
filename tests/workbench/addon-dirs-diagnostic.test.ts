import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SteamDiscoveryResult } from "../../src/platform/windows/steam-discovery.js";
import {
  checkAddonDirs,
  formatCheckAddonDirsReport,
  parseCheckAddonDirsArguments,
} from "../../src/workbench/addon-dirs-diagnostic.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const TARGET_GUID = "AAAAAAAAAAAAAAAA";
const BASE_GUID = "BBBBBBBBBBBBBBBB";
const WORKSHOP_GUID = "CCCCCCCCCCCCCCCC";
const MISSING_GUID = "DDDDDDDDDDDDDDDD";
const AMBIGUOUS_GUID = "EEEEEEEEEEEEEEEE";

function writeProject(
  directory: string,
  filename: string,
  guid: string,
  dependencies: readonly string[] = []
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
    "}",
    "",
  ].join("\n"), "utf8");
  return path;
}

function steamDiscovery(gamePath: string): SteamDiscoveryResult {
  return {
    status: "success",
    gamePath,
    workbenchCandidates: [],
    gameCandidates: [gamePath],
    steamRoots: [],
    libraryRoots: [],
    errors: [],
  };
}

describe("check-addon-dirs diagnostic", () => {
  it("reports resolved roots plus missing and ambiguous dependencies", async () => {
    await withTemporaryDirectory((root) => {
      const siblingRoot = join(root, "addons");
      const target = writeProject(
        join(siblingRoot, "Target"),
        "Target.gproj",
        TARGET_GUID,
        [AMBIGUOUS_GUID, MISSING_GUID, WORKSHOP_GUID, BASE_GUID]
      );
      const baseRoot = join(root, "game", "addons");
      const workshopRoot = join(root, "workshop-addons");
      writeProject(join(baseRoot, "Base"), "Base.gproj", BASE_GUID);
      writeProject(join(workshopRoot, "Workshop"), "Workshop.gproj", WORKSHOP_GUID);
      writeProject(join(workshopRoot, "Duplicate"), "WorkshopDuplicate.gproj", AMBIGUOUS_GUID);
      writeProject(join(siblingRoot, "Duplicate"), "SiblingDuplicate.gproj", AMBIGUOUS_GUID);

      const report = checkAddonDirs(target, {
        discoverSteam: () => steamDiscovery(join(root, "game")),
        discoverWorkshopAddonRoot: () => workshopRoot,
      });

      expect(report.addonRoots).toEqual([baseRoot, workshopRoot, siblingRoot]);
      expect(report.audit.resolvedDependencies).toEqual([
        { guid: BASE_GUID, addonRoot: baseRoot },
        { guid: WORKSHOP_GUID, addonRoot: workshopRoot },
      ]);
      expect(report.audit.missingGuids).toEqual([MISSING_GUID]);
      expect(report.audit.ambiguousGuids).toEqual([AMBIGUOUS_GUID]);
      expect(formatCheckAddonDirsReport(report)).toBe([
        `Target: Target (${TARGET_GUID})`,
        "Resolved:",
        `  ${BASE_GUID}  <- ${baseRoot}`,
        `  ${WORKSHOP_GUID}  <- ${workshopRoot}`,
        "Missing (not found in any candidate root):",
        `  ${MISSING_GUID}`,
        "Ambiguous (resolved by more than one candidate root):",
        `  ${AMBIGUOUS_GUID}`,
      ].join("\n"));
    }, { prefix: "rfo-check-addon-dirs-" });
  });

  it("parses one target path and rejects any additional command surface", async () => {
    await withTemporaryDirectory((root) => {
      const target = join(root, "addons", "Target", "Target.gproj");

      expect(parseCheckAddonDirsArguments([
        "check-addon-dirs",
        "--gproj",
        "addons/Target/Target.gproj",
      ], root)).toBe(target);
      expect(() => parseCheckAddonDirsArguments(["check-addon-dirs"], root)).toThrow(
        /requires --gproj <path>/
      );
      expect(() => parseCheckAddonDirsArguments([
        "check-addon-dirs",
        "--gproj",
        target,
        "--other",
      ], root)).toThrow(/accepts only --gproj <path>/);
    }, { prefix: "rfo-check-addon-dirs-args-" });
  });
});
