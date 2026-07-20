import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  canonicalizeGproj,
  ProjectIdentityError,
  resolveProjectIdentity,
  revalidateProjectIdentity,
  sameProjectIdentity,
  type CanonicalProjectIdentity,
} from "../../src/workbench/project-identity.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "reforger-forge-project-identity-" }));
}

function createProject(root: string, folder: string, filename = `${folder}.gproj`): string {
  const directory = folder ? join(root, folder) : root;
  mkdirSync(directory, { recursive: true });
  const projectPath = join(directory, filename);
  writeFileSync(projectPath, "GameProject {}\n", "utf8");
  return projectPath;
}

function captureProjectError(action: () => unknown): ProjectIdentityError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectIdentityError);
    return error as ProjectIdentityError;
  }
  throw new Error("Expected a ProjectIdentityError");
}

function expectedKey(path: string): string {
  return path.toLowerCase();
}

describe("canonical Workbench project identity", () => {
  scopedIt("trims, resolves, and canonicalizes a regular .gproj case-insensitively", (root) => {
    const projectPath = createProject(root, "Example Mod", "Example.GpRoJ");
    const relativePath = relative(process.cwd(), projectPath);

    const identity = canonicalizeGproj(`  ${relativePath}  `);
    const canonicalProject = realpathSync.native(projectPath);
    const canonicalMod = realpathSync.native(dirname(projectPath));

    expect(identity).toEqual({
      displayPath: canonicalProject,
      comparisonKey: expectedKey(canonicalProject),
      modDirectory: canonicalMod,
      modDirectoryKey: expectedKey(canonicalMod),
    });
  });

  scopedIt("uses native realpath identity through a linked mod directory", (root) => {
    const projectPath = createProject(root, "RealMod", "RealMod.gproj");
    const aliasDirectory = join(root, "AliasMod");
    symlinkSync(dirname(projectPath), aliasDirectory, "junction");

    const realIdentity = canonicalizeGproj(projectPath);
    const aliasIdentity = canonicalizeGproj(join(aliasDirectory, "RealMod.gproj"));

    expect(aliasIdentity).toEqual(realIdentity);
    expect(sameProjectIdentity(aliasIdentity, realIdentity)).toBe(true);
  });

  it("requires a nonempty explicit target", () => {
    const error = captureProjectError(() => canonicalizeGproj("   "));
    expect(error.code).toBe("TARGET_REQUIRED");
    expect(error.message).toContain("nonempty .gproj path");
  });

  scopedIt("rejects missing paths, directories, and non-.gproj files", (root) => {
    const directoryTarget = join(root, "Directory.gproj");
    mkdirSync(directoryTarget);
    const textTarget = join(root, "notes.txt");
    writeFileSync(textTarget, "not a project", "utf8");

    expect(captureProjectError(() => canonicalizeGproj(join(root, "missing.gproj"))).code)
      .toBe("INVALID_TARGET");
    expect(captureProjectError(() => canonicalizeGproj(directoryTarget)).message)
      .toContain("not a regular file");
    expect(captureProjectError(() => canonicalizeGproj(textTarget)).message)
      .toContain("must have a .gproj extension");
  });

  scopedIt("revalidates the exact canonical key and current file", (root) => {
    const projectPath = createProject(root, "Example");
    const identity = canonicalizeGproj(projectPath);

    expect(revalidateProjectIdentity(identity)).toEqual(identity);

    const alteredExpectation: CanonicalProjectIdentity = {
      ...identity,
      comparisonKey: `${identity.comparisonKey}.different`,
    };
    expect(captureProjectError(() => revalidateProjectIdentity(alteredExpectation)).code)
      .toBe("TARGET_CHANGED");

    unlinkSync(projectPath);
    expect(captureProjectError(() => revalidateProjectIdentity(identity)).code)
      .toBe("INVALID_TARGET");
  });
});

describe("safe implicit Workbench project resolution", () => {
  scopedIt("prefers and revalidates a prior lifecycle target", (root) => {
    const priorPath = createProject(root, "Prior");
    createProject(root, "Preferred");
    const prior = canonicalizeGproj(priorPath);

    const resolved = resolveProjectIdentity({
      priorTarget: prior,
      projectRoot: root,
      defaultMod: "Preferred",
    });

    expect(resolved).toEqual(prior);
  });

  scopedIt("uses a configured default only when it has one direct project", (root) => {
    const preferredPath = createProject(root, "Preferred", "Preferred.GPROJ");
    createProject(root, "Other");

    const resolved = resolveProjectIdentity({
      projectRoot: root,
      defaultMod: "Preferred",
    });

    expect(resolved.displayPath).toBe(realpathSync.native(preferredPath));
  });

  scopedIt("falls through an empty configured default to one unique root candidate", (root) => {
    mkdirSync(join(root, "EmptyDefault"));
    const onlyPath = createProject(root, "OnlyMod");

    const resolved = resolveProjectIdentity({
      projectRoot: root,
      defaultMod: "EmptyDefault",
    });

    expect(resolved.displayPath).toBe(realpathSync.native(onlyPath));
  });

  scopedIt("searches only the project root and its direct child directories", (root) => {
    const directPath = createProject(root, "DirectMod");
    createProject(root, join("Nested", "TooDeep"), "Ignored.gproj");

    expect(resolveProjectIdentity({ projectRoot: root }).displayPath)
      .toBe(realpathSync.native(directPath));
  });

  scopedIt("accepts one project directly in the configured root", (root) => {
    const projectPath = createProject(root, "", "RootProject.GpRoJ");

    expect(resolveProjectIdentity({ projectRoot: root }).displayPath)
      .toBe(realpathSync.native(projectPath));
  });

  scopedIt("deduplicates linked spellings of the same canonical candidate", (root) => {
    const projectPath = createProject(root, "RealMod");
    symlinkSync(
      dirname(projectPath),
      join(root, "AliasMod"),
      "junction"
    );

    const resolved = resolveProjectIdentity({ projectRoot: root });
    expect(resolved.displayPath).toBe(realpathSync.native(projectPath));
  });

  scopedIt("refuses ambiguity with a stable sorted candidate list", (root) => {
    const zuluPath = createProject(root, "Zulu");
    const alphaPath = createProject(root, "Alpha");

    const error = captureProjectError(() => resolveProjectIdentity({ projectRoot: root }));
    const expected = [
      realpathSync.native(alphaPath),
      realpathSync.native(zuluPath),
    ].sort((left, right) => {
      const leftKey = expectedKey(left);
      const rightKey = expectedKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

    expect(error.code).toBe("AMBIGUOUS_TARGET");
    expect(error.candidates).toEqual(expected);
    expect(error.message).toContain("Provide an explicit gprojPath");
    expect(error.message.indexOf(expected[0])).toBeLessThan(error.message.indexOf(expected[1]));
  });

  scopedIt("does not choose among multiple projects in the configured default", (root) => {
    createProject(root, "Preferred", "One.gproj");
    createProject(root, "Preferred", "Two.gproj");

    const error = captureProjectError(() => resolveProjectIdentity({
      projectRoot: root,
      defaultMod: "Preferred",
    }));

    expect(error.code).toBe("AMBIGUOUS_TARGET");
    expect(error.candidates).toHaveLength(2);
  });

  scopedIt("requires an explicit target when no candidate exists", (root) => {
    mkdirSync(join(root, "Empty"));

    const error = captureProjectError(() => resolveProjectIdentity({ projectRoot: root }));
    expect(error.code).toBe("TARGET_REQUIRED");
    expect(error.candidates).toEqual([]);
  });

  scopedIt("never selects the legacy standalone EnfusionMCP project", (root) => {
    createProject(root, "EnfusionMCP", "EnfusionMCP.gproj");

    expect(captureProjectError(() => resolveProjectIdentity({ projectRoot: root })).code)
      .toBe("TARGET_REQUIRED");
    expect(captureProjectError(() => resolveProjectIdentity({
      projectRoot: root,
      defaultMod: "EnfusionMCP",
    })).code).toBe("TARGET_REQUIRED");
  });

  scopedIt("rejects a defaultMod that is not one direct child folder name", (root) => {

    const error = captureProjectError(() => resolveProjectIdentity({
      projectRoot: root,
      defaultMod: join("nested", "mod"),
    }));
    expect(error.code).toBe("INVALID_TARGET");
    expect(error.message).toContain("one direct project folder");
  });

  scopedIt("an explicit target always bypasses fallback ambiguity", (root) => {
    const explicitPath = createProject(root, "Explicit");
    createProject(root, "Other");

    const resolved = resolveProjectIdentity({
      gprojPath: ` ${explicitPath} `,
      projectRoot: root,
    });
    expect(resolved.displayPath).toBe(realpathSync.native(explicitPath));
  });
});
