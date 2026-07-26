import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkbenchAddonDependencyAuditError,
  WorkbenchAddonDependencyPreflightError,
  assertWorkbenchAddonDependenciesAvailable,
  auditWorkbenchAddonDependencies,
} from "../../src/workbench/addon-dependencies.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const TARGET_GUID = "AAAAAAAAAAAAAAAA";
const DEPENDENCY_B = "BBBBBBBBBBBBBBBB";
const DEPENDENCY_C = "CCCCCCCCCCCCCCCC";
const DEPENDENCY_D = "DDDDDDDDDDDDDDDD";
const DEPENDENCY_E = "EEEEEEEEEEEEEEEE";
const DEPENDENCY_F = "FFFFFFFFFFFFFFFF";

function writeProject(
  directory: string,
  filename: string,
  guid: string,
  dependencies: readonly string[]
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
  ].join("\n"));
  return path;
}

describe("Workbench add-on dependency audit", () => {
  it("discovers direct and one-child projects, follows transitives, and never walks deeper", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(
        join(root, "workspace", "Target"),
        "Target.gproj",
        TARGET_GUID,
        [DEPENDENCY_B]
      );
      const addonRoot = join(root, "addons");
      writeProject(addonRoot, "Direct.gproj", DEPENDENCY_B, [DEPENDENCY_C]);
      writeProject(
        join(addonRoot, "Child"),
        "Child.gproj",
        DEPENDENCY_C.toLowerCase(),
        [DEPENDENCY_D]
      );
      writeProject(
        join(addonRoot, "Nested", "TooDeep"),
        "TooDeep.gproj",
        DEPENDENCY_D,
        []
      );

      const audit = auditWorkbenchAddonDependencies({
        targetGprojPath: target,
        addonRoots: [addonRoot],
      });

      expect(audit).toEqual({
        targetGuid: TARGET_GUID,
        requiredGuids: [DEPENDENCY_B, DEPENDENCY_C, DEPENDENCY_D],
        resolvedGuids: [DEPENDENCY_B, DEPENDENCY_C],
        resolvedDependencies: [
          { guid: DEPENDENCY_B, addonRoot },
          { guid: DEPENDENCY_C, addonRoot },
        ],
        missingGuids: [DEPENDENCY_D],
        ambiguousGuids: [],
      });
    }, { prefix: "rfo-addon-deps-bounded-" });
  });

  it("traverses cycles once and deduplicates repeated roots and dependency declarations", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(
        join(root, "workspace", "Target"),
        "Target.gproj",
        TARGET_GUID,
        [DEPENDENCY_B, DEPENDENCY_B, DEPENDENCY_C]
      );
      const addonRoot = join(root, "addons");
      writeProject(
        join(addonRoot, "DependencyB"),
        "B.gproj",
        DEPENDENCY_B,
        [DEPENDENCY_C, TARGET_GUID]
      );
      writeProject(
        join(addonRoot, "DependencyC"),
        "C.gproj",
        DEPENDENCY_C,
        [DEPENDENCY_B]
      );

      const audit = auditWorkbenchAddonDependencies({
        targetGprojPath: target,
        addonRoots: [addonRoot, join(addonRoot, "."), addonRoot],
      });

      expect(audit.requiredGuids).toEqual([DEPENDENCY_B, DEPENDENCY_C]);
      expect(audit.resolvedGuids).toEqual([DEPENDENCY_B, DEPENDENCY_C]);
      expect(audit.missingGuids).toEqual([]);
      expect(audit.ambiguousGuids).toEqual([]);
    }, { prefix: "rfo-addon-deps-cycles-" });
  });

  it("reports only required ambiguous GUIDs and sorts every result deterministically", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(
        join(root, "workspace", "Target"),
        "Target.gproj",
        TARGET_GUID,
        [DEPENDENCY_E, DEPENDENCY_C, DEPENDENCY_B, DEPENDENCY_D]
      );
      const firstRoot = join(root, "first");
      const secondRoot = join(root, "second");
      writeProject(join(firstRoot, "B-One"), "B.gproj", DEPENDENCY_B, []);
      writeProject(join(secondRoot, "B-Two"), "B.gproj", DEPENDENCY_B, []);
      writeProject(join(firstRoot, "C-One"), "C.gproj", DEPENDENCY_C, []);
      writeProject(join(secondRoot, "C-Two"), "C.gproj", DEPENDENCY_C, []);
      writeProject(
        join(firstRoot, "D"),
        "D.gproj",
        DEPENDENCY_D,
        [DEPENDENCY_F]
      );
      // This unrelated duplicate must not make the traversed graph ambiguous.
      writeProject(join(firstRoot, "Unused-One"), "Unused.gproj", "1111111111111111", []);
      writeProject(join(secondRoot, "Unused-Two"), "Unused.gproj", "1111111111111111", []);

      const forward = auditWorkbenchAddonDependencies({
        targetGprojPath: target,
        addonRoots: [firstRoot, secondRoot, firstRoot],
      });
      const reverse = auditWorkbenchAddonDependencies({
        targetGprojPath: target,
        addonRoots: [secondRoot, firstRoot],
      });

      expect(forward).toEqual(reverse);
      expect(forward).toEqual({
        targetGuid: TARGET_GUID,
        requiredGuids: [
          DEPENDENCY_B,
          DEPENDENCY_C,
          DEPENDENCY_D,
          DEPENDENCY_E,
          DEPENDENCY_F,
        ],
        resolvedGuids: [DEPENDENCY_D],
        resolvedDependencies: [{ guid: DEPENDENCY_D, addonRoot: firstRoot }],
        missingGuids: [DEPENDENCY_E, DEPENDENCY_F],
        ambiguousGuids: [DEPENDENCY_B, DEPENDENCY_C],
      });
    }, { prefix: "rfo-addon-deps-deterministic-" });
  });

  it("rejects an invalid target while ignoring invalid unrelated candidates", async () => {
    await withTemporaryDirectory((root) => {
      const addonRoot = join(root, "addons");
      mkdirSync(addonRoot, { recursive: true });
      writeFileSync(join(addonRoot, "unrelated.gproj"), "not a GameProject");

      expect(() => auditWorkbenchAddonDependencies({
        targetGprojPath: join(root, "missing.gproj"),
        addonRoots: [addonRoot],
      })).toThrowError(WorkbenchAddonDependencyAuditError);

      try {
        auditWorkbenchAddonDependencies({
          targetGprojPath: join(root, "missing.gproj"),
          addonRoots: [addonRoot],
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_TARGET" });
      }
    }, { prefix: "rfo-addon-deps-invalid-" });
  });
});

describe("Workbench add-on dependency preflight", () => {
  it("reports sorted missing GUIDs with shared configuration guidance and launch status", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(
        join(root, "workspace", "Target"),
        "Target.gproj",
        TARGET_GUID,
        [DEPENDENCY_C, DEPENDENCY_B]
      );

      expect(() => assertWorkbenchAddonDependenciesAvailable({
        targetGprojPath: target,
        addonRoots: [],
        launchStatus: "No Workbench process was launched.",
      })).toThrowError(WorkbenchAddonDependencyPreflightError);

      try {
        assertWorkbenchAddonDependenciesAvailable({
          targetGprojPath: target,
          addonRoots: [],
          launchStatus: "No Workbench process was launched.",
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_CONFIG" });
        expect((error as Error).message).toContain(
          `Missing dependency GUID(s): ${DEPENDENCY_B}, ${DEPENDENCY_C}.`
        );
        expect((error as Error).message).toContain("workbenchAddonDirs");
        expect((error as Error).message).toContain(
          "--workbench-addon-dir <directory>"
        );
        expect((error as Error).message).toContain(
          "No Workbench process was launched."
        );
      }
    }, { prefix: "rfo-addon-deps-preflight-missing-" });
  });

  it("uses duplicate-removal guidance for ambiguous required GUIDs", async () => {
    await withTemporaryDirectory((root) => {
      const target = writeProject(
        join(root, "workspace", "Target"),
        "Target.gproj",
        TARGET_GUID,
        [DEPENDENCY_B]
      );
      const firstRoot = join(root, "first");
      const secondRoot = join(root, "second");
      writeProject(join(firstRoot, "Dependency"), "B.gproj", DEPENDENCY_B, []);
      writeProject(join(secondRoot, "Dependency"), "B.gproj", DEPENDENCY_B, []);

      try {
        assertWorkbenchAddonDependenciesAvailable({
          targetGprojPath: target,
          addonRoots: [firstRoot, secondRoot],
        });
        expect.unreachable("ambiguous dependency preflight should fail");
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_CONFIG" });
        expect((error as Error).message).toContain(
          `Ambiguous dependency GUID(s): ${DEPENDENCY_B}.`
        );
        expect((error as Error).message).toContain(
          "Remove or disable duplicate projects"
        );
        expect((error as Error).message).not.toContain("Add the add-on root");
      }
    }, { prefix: "rfo-addon-deps-preflight-ambiguous-" });
  });

  it("adapts an invalid target audit into a neutral preflight error", async () => {
    await withTemporaryDirectory((root) => {
      try {
        assertWorkbenchAddonDependenciesAvailable({
          targetGprojPath: join(root, "missing.gproj"),
          addonRoots: [],
        });
        expect.unreachable("invalid target preflight should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(WorkbenchAddonDependencyPreflightError);
        expect(error).toMatchObject({
          code: "INVALID_TARGET",
          cause: expect.any(WorkbenchAddonDependencyAuditError),
        });
      }
    }, { prefix: "rfo-addon-deps-preflight-invalid-" });
  });
});
