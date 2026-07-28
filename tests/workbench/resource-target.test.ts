import { mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";
import {
  canonicalizeResourceTarget,
  ResourceTargetError,
  revalidateResourceTarget,
} from "../../src/workbench/resource-target.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function scopedIt(name: string, run: (root: string) => Promise<void> | void): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "reforger-forge-resource-target-" }));
}

function createProject(root: string): { readonly projectPath: string; readonly modDirectory: string } {
  const modDirectory = join(root, "Example Mod");
  mkdirSync(modDirectory, { recursive: true });
  const projectPath = join(modDirectory, "Example.gproj");
  writeFileSync(projectPath, "GameProject {}\n", "utf8");
  return { projectPath, modDirectory };
}

function createEntity(modDirectory: string, filename = "Worlds/Example.ent"): string {
  const resourcePath = join(modDirectory, filename);
  mkdirSync(join(resourcePath, ".."), { recursive: true });
  writeFileSync(resourcePath, "Entity {}\n", "utf8");
  writeFileSync(`${resourcePath}.meta`, "Meta {}\n", "utf8");
  return resourcePath;
}

function captureResourceError(action: () => unknown): ResourceTargetError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ResourceTargetError);
    return error as ResourceTargetError;
  }
  throw new Error("Expected a ResourceTargetError");
}

describe("canonical explicit Workbench resource target", () => {
  scopedIt("canonicalizes an existing .ent and required .meta below the selected project", (root) => {
    const { projectPath, modDirectory } = createProject(root);
    const resourcePath = createEntity(modDirectory);
    const target = canonicalizeResourceTarget(`  ${relative(process.cwd(), resourcePath)}  `, canonicalizeGproj(projectPath));

    expect(target.displayPath).toBe(realpathSync.native(resourcePath));
    expect(target.comparisonKey).toBe(realpathSync.native(resourcePath).toLowerCase());
    expect(target.metaPath).toBe(realpathSync.native(`${resourcePath}.meta`));
    expect(target.project.displayPath).toBe(realpathSync.native(projectPath));
  });

  it("requires a nonempty explicit resource path", () => {
    const error = captureResourceError(() => canonicalizeResourceTarget("  ", {} as never));
    expect(error.code).toBe("RESOURCE_REQUIRED");
    expect(error.message).toContain("nonempty .ent path");
  });

  scopedIt("rejects missing paths, non-entities, directories, and a missing sidecar", (root) => {
    const { projectPath, modDirectory } = createProject(root);
    const project = canonicalizeGproj(projectPath);
    const textPath = join(modDirectory, "notes.txt");
    writeFileSync(textPath, "notes", "utf8");
    const directoryPath = join(modDirectory, "Directory.ent");
    mkdirSync(directoryPath);
    const missingMeta = join(modDirectory, "Worlds", "MissingMeta.ent");
    mkdirSync(join(missingMeta, ".."), { recursive: true });
    writeFileSync(missingMeta, "Entity {}\n", "utf8");

    expect(captureResourceError(() => canonicalizeResourceTarget(join(modDirectory, "missing.ent"), project)).code)
      .toBe("INVALID_RESOURCE_TARGET");
    expect(captureResourceError(() => canonicalizeResourceTarget(textPath, project)).message)
      .toContain("must have a .ent extension");
    expect(captureResourceError(() => canonicalizeResourceTarget(directoryPath, project)).message)
      .toContain("not a regular file");
    expect(captureResourceError(() => canonicalizeResourceTarget(missingMeta, project)).message)
      .toContain("metadata does not exist");
  });

  scopedIt("refuses a resource or sidecar whose canonical path escapes the selected project", (root) => {
    const { projectPath, modDirectory } = createProject(root);
    const project = canonicalizeGproj(projectPath);
    const outside = join(root, "Outside.ent");
    writeFileSync(outside, "Entity {}\n", "utf8");
    writeFileSync(`${outside}.meta`, "Meta {}\n", "utf8");
    const resourceLink = join(modDirectory, "Worlds", "Outside.ent");
    mkdirSync(join(resourceLink, ".."), { recursive: true });
    symlinkSync(outside, resourceLink, "file");

    expect(captureResourceError(() => canonicalizeResourceTarget(resourceLink, project)).code)
      .toBe("RESOURCE_OUTSIDE_PROJECT");

    const inside = createEntity(modDirectory, "Worlds/Inside.ent");
    unlinkSync(`${inside}.meta`);
    symlinkSync(`${outside}.meta`, `${inside}.meta`, "file");
    expect(captureResourceError(() => canonicalizeResourceTarget(inside, project)).code)
      .toBe("RESOURCE_OUTSIDE_PROJECT");
  });

  scopedIt("revalidates the exact resource and sidecar identities", (root) => {
    const { projectPath, modDirectory } = createProject(root);
    const project = canonicalizeGproj(projectPath);
    const resourcePath = createEntity(modDirectory);
    const target = canonicalizeResourceTarget(resourcePath, project);

    expect(revalidateResourceTarget(target)).toEqual(target);

    const replacement = createEntity(modDirectory, "Worlds/Replacement.ent");
    unlinkSync(resourcePath);
    symlinkSync(replacement, resourcePath, "file");
    expect(captureResourceError(() => revalidateResourceTarget(target)).code)
      .toBe("RESOURCE_TARGET_CHANGED");

    unlinkSync(resourcePath);
    writeFileSync(resourcePath, "Entity {}\\n", "utf8");
    unlinkSync(`${resourcePath}.meta`);
    expect(captureResourceError(() => revalidateResourceTarget(target)).code)
      .toBe("RESOURCE_TARGET_CHANGED");
  });
});
