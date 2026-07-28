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

describe("exact Workbench project resolution", () => {
  scopedIt("prefers and revalidates a prior lifecycle target", (root) => {
    const priorPath = createProject(root, "Prior");
    const prior = canonicalizeGproj(priorPath);

    const resolved = resolveProjectIdentity({
      priorTarget: prior,
    });

    expect(resolved).toEqual(prior);
  });

  it("requires an explicit or prior verified target", () => {
    const error = captureProjectError(() => resolveProjectIdentity({}));
    expect(error.code).toBe("TARGET_REQUIRED");
    expect(error.candidates).toEqual([]);
  });

  scopedIt("an explicit target overrides a prior target", (root) => {
    const explicitPath = createProject(root, "Explicit");
    const priorPath = createProject(root, "Prior");

    const resolved = resolveProjectIdentity({
      gprojPath: ` ${explicitPath} `,
      priorTarget: priorPath,
    });
    expect(resolved.displayPath).toBe(realpathSync.native(explicitPath));
  });
});
