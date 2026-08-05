import {
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeGameWorldEvidenceDigest,
  revalidateGameWorldPlan,
  resolveGameWorldPlan,
  type GameWorldPlanSnapshot,
} from "../../src/launch/game-world-plan.js";
import { GameLaunchPlanError } from "../../src/launch/game-launch-errors.js";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";
import { RESOURCE_META_MAXIMUM_BYTES } from "../../src/workbench/resource-meta.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const GUID = "A1B2C3D4E5F60718";

function scopedIt(name: string, run: (root: string) => Promise<void> | void): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "reforger-forge-game-world-" }));
}

function projectAt(root: string): {
  readonly projectPath: string;
  readonly modDirectory: string;
} {
  const modDirectory = join(root, "Example Mod");
  mkdirSync(modDirectory, { recursive: true });
  const projectPath = join(modDirectory, "Example.gproj");
  writeFileSync(projectPath, "GameProject { ID \"0123456789ABCDEF\" }\n", "utf8");
  return { projectPath, modDirectory };
}

function worldAt(
  modDirectory: string,
  relativePath = "Worlds/Example.ent",
  guid = GUID,
  registered = true,
): string {
  const worldPath = join(modDirectory, relativePath);
  mkdirSync(resolve(worldPath, ".."), { recursive: true });
  writeFileSync(worldPath, `SubScene {\n Name \"${relativePath}\"\n}\n`, "utf8");
  if (registered) {
    writeFileSync(
      `${worldPath}.meta`,
      `MetaFileClass {\n Name \"{${guid}}Worlds/StoredBeforeRename.ent\"\n}\n`,
      "utf8",
    );
  }
  return worldPath;
}

function capture(action: () => unknown): GameLaunchPlanError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GameLaunchPlanError);
    return error as GameLaunchPlanError;
  }
  throw new Error("Expected GameLaunchPlanError");
}

describe("registered project-world planning", () => {
  scopedIt("resolves absolute, project-relative, and formed inputs to one canonical reference", (root) => {
    const { projectPath, modDirectory } = projectAt(root);
    const worldPath = worldAt(modDirectory, "Worlds/Nested/Renamed.ent", GUID.toLowerCase());
    const project = canonicalizeGproj(projectPath);
    const expected = `{${GUID}}Worlds/Nested/Renamed.ent`;

    const absolute = resolveGameWorldPlan({ project, world: worldPath });
    const relativePlan = resolveGameWorldPlan(project, "Worlds/Nested/Renamed.ent");
    const formed = resolveGameWorldPlan(project, `{${GUID.toLowerCase()}}Worlds/Nested/Renamed.ent`);

    for (const plan of [absolute, relativePlan, formed]) {
      expect(plan.resourceReference).toBe(expected);
      expect(plan.guid).toBe(GUID);
      expect(plan.relativePath).toBe("Worlds/Nested/Renamed.ent");
      expect(plan.worldPath).toBe(resolve(worldPath));
      expect(plan.metaPath).toBe(resolve(`${worldPath}.meta`));
      expect(plan.worldEvidenceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.project)).toBe(true);
      expect(Object.isFrozen(plan.selection)).toBe(true);
    }
    expect(absolute.selection).toMatchObject({ kind: "explicit", inputKind: "absolute" });
    expect(relativePlan.selection).toMatchObject({ kind: "explicit", inputKind: "relative" });
    expect(formed.selection).toMatchObject({ kind: "explicit", inputKind: "formed", suppliedGuid: GUID });
  });

  scopedIt("rejects a formed GUID mismatch and malformed metadata without GUID fallback", (root) => {
    const { projectPath, modDirectory } = projectAt(root);
    const worldPath = worldAt(modDirectory);
    const project = canonicalizeGproj(projectPath);

    expect(capture(() => resolveGameWorldPlan(project, "{1111111111111111}Worlds/Example.ent")).code)
      .toBe("WORLD_GUID_MISMATCH");

    writeFileSync(
      `${worldPath}.meta`,
      `MetaFileClass {\n Other \"{${GUID}}Worlds/NotTheName.ent\"\n}\n`,
      "utf8",
    );
    expect(capture(() => resolveGameWorldPlan(project, worldPath)).code)
      .toBe("WORLD_METADATA_MALFORMED");

    writeFileSync(`${worldPath}.meta`, Buffer.alloc(RESOURCE_META_MAXIMUM_BYTES + 1, 0x20));
    expect(capture(() => resolveGameWorldPlan(project, worldPath)).code)
      .toBe("WORLD_METADATA_OVERSIZE");
  });

  scopedIt("rejects outside files and linked world or metadata paths", (root) => {
    const { projectPath, modDirectory } = projectAt(root);
    const project = canonicalizeGproj(projectPath);
    const outside = worldAt(root, "Outside.ent");
    expect(capture(() => resolveGameWorldPlan(project, outside)).code).toBe("WORLD_OUTSIDE_PROJECT");

    const linkedWorld = join(modDirectory, "Worlds", "Linked.ent");
    mkdirSync(resolve(linkedWorld, ".."), { recursive: true });
    symlinkSync(outside, linkedWorld, "file");
    expect(capture(() => resolveGameWorldPlan(project, linkedWorld)).code).toBe("WORLD_OUTSIDE_PROJECT");

    const inside = worldAt(modDirectory, "Worlds/Inside.ent");
    unlinkSync(`${inside}.meta`);
    symlinkSync(`${outside}.meta`, `${inside}.meta`, "file");
    expect(capture(() => resolveGameWorldPlan(project, inside)).code).toBe("WORLD_OUTSIDE_PROJECT");
  });

  scopedIt("discovers one registered world and refuses zero or one unregistered world", (root) => {
    const first = projectAt(join(root, "first"));
    const firstProject = canonicalizeGproj(first.projectPath);
    expect(capture(() => resolveGameWorldPlan({ project: firstProject })).code).toBe("WORLD_NOT_FOUND");
    mkdirSync(join(first.modDirectory, "Worlds"));
    expect(capture(() => resolveGameWorldPlan({ project: firstProject })).code).toBe("WORLD_REQUIRED");

    const second = projectAt(join(root, "second"));
    const unregistered = worldAt(second.modDirectory, "Worlds/Lone.ent", GUID, false);
    const unregisteredError = capture(() => resolveGameWorldPlan({ project: canonicalizeGproj(second.projectPath) }));
    expect(unregisteredError.code).toBe("WORLD_UNREGISTERED");
    expect(unregisteredError.remedy).toEqual({
      kind: "register_world",
      projectPath: resolve(second.projectPath),
      worldPath: resolve(unregistered),
    });

    writeFileSync(
      `${unregistered}.meta`,
      `MetaFileClass {\n Name \"{${GUID}}Worlds/Lone.ent\"\n}\n`,
      "utf8",
    );
    const selected = resolveGameWorldPlan({ project: canonicalizeGproj(second.projectPath) });
    expect(selected.resourceReference).toBe(`{${GUID}}Worlds/Lone.ent`);
    expect(selected.selection).toMatchObject({ kind: "discovered", candidateCount: 1 });
  });

  scopedIt("reports registered plus unregistered ambiguity with a bounded deterministic list", (root) => {
    const { projectPath, modDirectory } = projectAt(root);
    worldAt(modDirectory, "Worlds/Zulu.ent", GUID, false);
    worldAt(modDirectory, "Worlds/Alpha.ent", "1111111111111111", true);

    const error = capture(() => resolveGameWorldPlan({
      project: canonicalizeGproj(projectPath),
      discoveryLimits: { maximumDiagnosticCandidates: 1 },
    }));
    expect(error.code).toBe("WORLD_AMBIGUOUS");
    expect(error.candidates).toEqual([{ path: "Worlds/Alpha.ent", status: "registered" }]);
  });

  scopedIt("fails closed at depth, visited-entry, candidate, and metadata-byte caps", (root) => {
    const depthProject = projectAt(join(root, "depth"));
    worldAt(depthProject.modDirectory, "Worlds/One/Two/Deep.ent");
    expect(capture(() => resolveGameWorldPlan({
      project: canonicalizeGproj(depthProject.projectPath),
      discoveryLimits: { maximumDepth: 1 },
    })).code).toBe("WORLD_SCAN_TRUNCATED");

    const entryProject = projectAt(join(root, "entry"));
    worldAt(entryProject.modDirectory);
    expect(capture(() => resolveGameWorldPlan({
      project: canonicalizeGproj(entryProject.projectPath),
      discoveryLimits: { maximumVisitedEntries: 1 },
    })).code).toBe("WORLD_SCAN_TRUNCATED");

    const candidateProject = projectAt(join(root, "candidate"));
    worldAt(candidateProject.modDirectory, "Worlds/One.ent", GUID, false);
    worldAt(candidateProject.modDirectory, "Worlds/Two.ent", GUID, false);
    expect(capture(() => resolveGameWorldPlan({
      project: canonicalizeGproj(candidateProject.projectPath),
      discoveryLimits: { maximumCandidates: 1 },
    })).code).toBe("WORLD_SCAN_TRUNCATED");

    const metadataProject = projectAt(join(root, "metadata"));
    worldAt(metadataProject.modDirectory);
    expect(capture(() => resolveGameWorldPlan({
      project: canonicalizeGproj(metadataProject.projectPath),
      discoveryLimits: { maximumMetadataBytes: 1 },
    })).code).toBe("WORLD_SCAN_TRUNCATED");
  });

  scopedIt("validates the stored digest before re-reading and rejects changed project, world, or metadata evidence", (root) => {
    const make = (name: string): { plan: GameWorldPlanSnapshot; projectPath: string; worldPath: string } => {
      const created = projectAt(join(root, name));
      const worldPath = worldAt(created.modDirectory);
      return {
        plan: resolveGameWorldPlan(canonicalizeGproj(created.projectPath), worldPath),
        projectPath: created.projectPath,
        worldPath,
      };
    };

    const unchanged = make("unchanged");
    expect(revalidateGameWorldPlan(unchanged.plan).worldEvidenceDigest)
      .toBe(unchanged.plan.worldEvidenceDigest);

    const tampered = { ...unchanged.plan, relativePath: "Worlds/Tampered.ent" };
    expect(capture(() => revalidateGameWorldPlan(tampered)).code).toBe("WORLD_EVIDENCE_INVALID");

    const changedProject = make("project");
    const projectDigest = changedProject.plan.worldEvidenceDigest;
    writeFileSync(changedProject.projectPath, "GameProject { ID \"FFFFFFFFFFFFFFFF\" }\n", "utf8");
    expect(capture(() => revalidateGameWorldPlan(changedProject.plan)).code).toBe("WORLD_CHANGED");
    expect(resolveGameWorldPlan(canonicalizeGproj(changedProject.projectPath), changedProject.worldPath).worldEvidenceDigest)
      .not.toBe(projectDigest);

    const changedWorld = make("world");
    const worldDigest = changedWorld.plan.worldEvidenceDigest;
    writeFileSync(changedWorld.worldPath, "SubScene { Changed 1 }\n", "utf8");
    expect(capture(() => revalidateGameWorldPlan(changedWorld.plan)).code).toBe("WORLD_CHANGED");
    expect(resolveGameWorldPlan(canonicalizeGproj(changedWorld.projectPath), changedWorld.worldPath).worldEvidenceDigest)
      .not.toBe(worldDigest);

    const changedMeta = make("meta");
    const metaDigest = changedMeta.plan.worldEvidenceDigest;
    const replacement = `${changedMeta.worldPath}.replacement`;
    writeFileSync(
      replacement,
      `MetaFileClass {\n Name \"{${GUID}}Worlds/StoredAfterRewrite.ent\"\n}\n`,
      "utf8",
    );
    unlinkSync(`${changedMeta.worldPath}.meta`);
    renameSync(replacement, `${changedMeta.worldPath}.meta`);
    expect(capture(() => revalidateGameWorldPlan(changedMeta.plan)).code).toBe("WORLD_CHANGED");
    const replacementPlan = resolveGameWorldPlan(canonicalizeGproj(changedMeta.projectPath), changedMeta.worldPath);
    expect(replacementPlan.resourceReference).toBe(changedMeta.plan.resourceReference);
    expect(replacementPlan.worldEvidenceDigest).not.toBe(metaDigest);
  });

  scopedIt("repeats discovery so a later ambiguity cannot retain the original selection", (root) => {
    const { projectPath, modDirectory } = projectAt(root);
    worldAt(modDirectory, "Worlds/Only.ent");
    const plan = resolveGameWorldPlan({ project: canonicalizeGproj(projectPath) });

    worldAt(modDirectory, "Worlds/AddedLater.ent", "1111111111111111");
    const error = capture(() => revalidateGameWorldPlan(plan));
    expect(error.code).toBe("WORLD_CHANGED");
    expect(error.cause).toBeInstanceOf(GameLaunchPlanError);
  });

  it("keeps a fixed-field evidence digest stable for a synthetic proof fixture", () => {
    const identity = {
      byteLength: 7,
      device: "1",
      inode: "2",
      modifiedNanoseconds: "3",
      changedNanoseconds: "4",
      birthNanoseconds: "5",
      sha256: "a".repeat(64),
    } as const;
    const fields = {
      schemaVersion: 1 as const,
      project: {
        displayPath: "C:\\Mods\\Example\\Example.gproj",
        comparisonKey: "c:\\mods\\example\\example.gproj",
        modDirectory: "C:\\Mods\\Example",
        modDirectoryKey: "c:\\mods\\example",
      },
      worldPath: "C:\\Mods\\Example\\Worlds\\Example.ent",
      metaPath: "C:\\Mods\\Example\\Worlds\\Example.ent.meta",
      projectFile: identity,
      worldFile: identity,
      metaFile: identity,
      guid: GUID,
      relativePath: "Worlds/Example.ent",
      resourceReference: `{${GUID}}Worlds/Example.ent`,
      selection: { kind: "explicit" as const, inputKind: "relative" as const, suppliedGuid: null },
    };
    expect(computeGameWorldEvidenceDigest(fields)).toBe("9210602250e40f795378a71bf745b08d70cf79bd979fa4255b3cff0025d1ec34");
    expect(computeGameWorldEvidenceDigest({ ...fields, worldFile: { ...identity, inode: "9" } }))
      .not.toBe(computeGameWorldEvidenceDigest(fields));
  });

  scopedIt("uses current path separators even when metadata retains an old path", (root) => {
    const { projectPath, modDirectory } = projectAt(root);
    const path = worldAt(modDirectory, "Worlds/Current/Now.ent");
    const result = resolveGameWorldPlan(canonicalizeGproj(projectPath), path);
    expect(result.resourceReference).toBe(`{${GUID}}Worlds/Current/Now.ent`);
    expect(result.relativePath).not.toContain("\\");
    expect(relative(modDirectory, path)).not.toBe("");
  });
});
