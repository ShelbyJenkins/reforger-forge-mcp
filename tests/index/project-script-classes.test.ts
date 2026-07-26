import { mkdirSync, writeFileSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findImplicitSiblingProjects,
  indexDeclaredProjectClasses,
} from "../../src/index/project-script-classes.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function writeProject(
  container: string,
  name: string,
  guid: string,
  dependencies: string[],
  className: string
): string {
  const root = join(container, name);
  mkdirSync(join(root, "Scripts", "Game"), { recursive: true });
  writeFileSync(join(root, `${name}.gproj`), [
    "GameProject {",
    ` ID "${name}"`,
    ` GUID "${guid}"`,
    " Dependencies {",
    ...dependencies.map((dependency) => `  "${dependency}"`),
    " }",
    "}",
  ].join("\n"));
  writeFileSync(
    join(root, "Scripts", "Game", `${className}.c`),
    `class ${className} {}\n`
  );
  return root;
}

describe("indexDeclaredProjectClasses", () => {
  it("resolves dependencies from immediate sibling project directories", async () => {
    await withTemporaryDirectory((container) => {
      const dependencyGuid = "BBBBBBBBBBBBBBBB";
      writeProject(
        container,
        "Dependency",
        dependencyGuid,
        ["58D0FB3206B6F859"],
        "DEPENDENCY_Class"
      );
      const target = writeProject(
        container,
        "Target",
        "AAAAAAAAAAAAAAAA",
        ["58D0FB3206B6F859", dependencyGuid],
        "TARGET_Class"
      );

      const classes = indexDeclaredProjectClasses({
        targetProjectPath: target,
      });

      expect(classes.has("target_class")).toBe(true);
      expect(classes.has("dependency_class")).toBe(true);
    }, { prefix: "rfo-project-siblings-" });
  });

  it("follows transitive GUID dependencies without indexing undeclared siblings", async () => {
    await withTemporaryDirectory((container) => {
      const transitiveGuid = "CCCCCCCCCCCCCCCC";
      const dependencyGuid = "BBBBBBBBBBBBBBBB";
      writeProject(
        container,
        "Transitive",
        transitiveGuid,
        ["58D0FB3206B6F859"],
        "TRANSITIVE_Class"
      );
      writeProject(
        container,
        "Dependency",
        dependencyGuid,
        ["58D0FB3206B6F859", transitiveGuid],
        "DEPENDENCY_Class"
      );
      writeProject(
        container,
        "Undeclared",
        "DDDDDDDDDDDDDDDD",
        ["58D0FB3206B6F859"],
        "UNDECLARED_Class"
      );
      const target = writeProject(
        container,
        "Target",
        "AAAAAAAAAAAAAAAA",
        ["58D0FB3206B6F859", dependencyGuid],
        "TARGET_Class"
      );

      const classes = indexDeclaredProjectClasses({
        targetProjectPath: target,
        searchRoots: [container],
      });

      expect(classes.has("target_class")).toBe(true);
      expect(classes.has("dependency_class")).toBe(true);
      expect(classes.has("transitive_class")).toBe(true);
      expect(classes.has("undeclared_class")).toBe(false);
    }, { prefix: "rfo-project-classes-" });
  });

  it("skips implicit sibling discovery when the target parent is a filesystem root", () => {
    const filesystemRoot = parse(resolve(import.meta.dirname)).root;
    const shallowTarget = join(filesystemRoot, "ShallowProject");

    expect(findImplicitSiblingProjects(shallowTarget)).toEqual([]);
  });
});
