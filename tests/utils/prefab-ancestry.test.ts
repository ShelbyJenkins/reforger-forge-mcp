import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../../src/config.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import {
  stripGuid,
  parseParentPath,
  parseComponents,
  parseTopLevelComponents,
  walkChain,
  mergeAncestryComponents,
  type AncestorLevel,
} from "../../src/utils/prefab-ancestry.js";

/** Build the subset of PAC1 needed by ancestry tests using real absolute offsets. */
function buildAncestryPak(files: Array<{ path: string; content: string }>): Buffer {
  interface TreeFile {
    name: string;
    offset: number;
    length: number;
  }
  interface TreeDir {
    name: string;
    children: Map<string, TreeDir | TreeFile>;
  }

  const headLen = 0x1c;
  const dataStart = 12 + 8 + headLen + 8;
  const dataChunks: Buffer[] = [];
  let offset = dataStart;
  const root: TreeDir = { name: "", children: new Map() };

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf-8");
    const parts = file.path.split("/");
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let child = dir.children.get(part);
      if (!child || !("children" in child)) {
        child = { name: part, children: new Map() };
        dir.children.set(part, child);
      }
      dir = child as TreeDir;
    }
    dir.children.set(fileName, { name: fileName, offset, length: raw.length });
    dataChunks.push(raw);
    offset += raw.length;
  }

  function serializeEntry(entry: TreeDir | TreeFile): Buffer {
    const name = Buffer.from(entry.name, "utf-8");
    const header = Buffer.from(["children" in entry ? 0 : 1, name.length]);
    if ("children" in entry) {
      const count = Buffer.alloc(4);
      count.writeUInt32LE(entry.children.size);
      return Buffer.concat([
        header,
        name,
        count,
        ...Array.from(entry.children.values(), serializeEntry),
      ]);
    }

    const meta = Buffer.alloc(24);
    meta.writeUInt32LE(entry.offset, 0);
    meta.writeUInt32LE(entry.length, 4);
    meta.writeUInt32LE(entry.length, 8);
    return Buffer.concat([header, name, meta]);
  }

  const data = Buffer.concat(dataChunks);
  const fileTree = serializeEntry(root);
  const totalPayload = 4 + 8 + headLen + 8 + data.length + 8 + fileTree.length;
  const pak = Buffer.alloc(8 + totalPayload);
  let pos = 0;
  pak.write("FORM", pos, 4, "ascii"); pos += 4;
  pak.writeUInt32BE(totalPayload, pos); pos += 4;
  pak.write("PAC1", pos, 4, "ascii"); pos += 4;
  pak.write("HEAD", pos, 4, "ascii"); pos += 4;
  pak.writeUInt32BE(headLen, pos); pos += 4 + headLen;
  pak.write("DATA", pos, 4, "ascii"); pos += 4;
  pak.writeUInt32BE(data.length, pos); pos += 4;
  data.copy(pak, pos); pos += data.length;
  pak.write("FILE", pos, 4, "ascii"); pos += 4;
  pak.writeUInt32BE(fileTree.length, pos); pos += 4;
  fileTree.copy(pak, pos);
  return pak;
}

describe("stripGuid", () => {
  it("removes leading GUID prefix", () => {
    expect(stripGuid("{AABBCCDD11223344}Prefabs/Foo.et")).toBe("Prefabs/Foo.et");
  });

  it("returns path unchanged when no GUID prefix", () => {
    expect(stripGuid("Prefabs/Foo.et")).toBe("Prefabs/Foo.et");
  });

  it("does not strip malformed short GUID prefix", () => {
    expect(stripGuid("{AABB}Prefabs/Foo.et")).toBe("{AABB}Prefabs/Foo.et");
  });
});

describe("parseParentPath", () => {
  it("parses entity class and parent with GUID prefix", () => {
    const content = `SCR_ChimeraCharacter : "{AABB112233445566}Prefabs/Base.et" {\n  ID "abc"\n}`;
    const result = parseParentPath(content);
    expect(result.entityClass).toBe("SCR_ChimeraCharacter");
    expect(result.parentPath).toBe("Prefabs/Base.et");
  });

  it("parses entity class and parent without GUID prefix", () => {
    const content = `Vehicle : "Prefabs/VehicleBase.et" {\n  ID "abc"\n}`;
    const result = parseParentPath(content);
    expect(result.entityClass).toBe("Vehicle");
    expect(result.parentPath).toBe("Prefabs/VehicleBase.et");
  });

  it("parses root entity with no parent", () => {
    const content = `GenericEntity {\n  ID "abc"\n}`;
    const result = parseParentPath(content);
    expect(result.entityClass).toBe("GenericEntity");
    expect(result.parentPath).toBeNull();
  });
});

describe("parseComponents", () => {
  it("returns empty map when no components block", () => {
    const content = `GenericEntity {\n  ID "abc"\n}`;
    expect(parseComponents(content).size).toBe(0);
  });

  it("parses a single component", () => {
    const content = `GenericEntity {\n  components {\n   MeshObject "{AABBCCDD11223344}" {\n    Object "foo.xob"\n   }\n  }\n}`;
    const comps = parseComponents(content);
    expect(comps.size).toBe(1);
    const comp = comps.get("AABBCCDD11223344");
    expect(comp).toBeDefined();
    expect(comp!.typeName).toBe("MeshObject");
    expect(comp!.guid).toBe("AABBCCDD11223344");
    expect(comp!.rawBody).toContain('Object "foo.xob"');
  });

  it("parses multiple components with distinct GUIDs", () => {
    const content = `GenericEntity {\n  components {\n   MeshObject "{AAAAAAAAAAAAAAAA}" {\n  }\n   RigidBody "{BBBBBBBBBBBBBBBB}" {\n  }\n  }\n}`;
    const comps = parseComponents(content);
    expect(comps.size).toBe(2);
    expect(comps.has("AAAAAAAAAAAAAAAA")).toBe(true);
    expect(comps.has("BBBBBBBBBBBBBBBB")).toBe(true);
  });
});

describe("parseTopLevelComponents", () => {
  it("does not promote nested containers into peer components", () => {
    const content = `GenericEntity {
  components {
   SCR_BaseGameMode "{AAAAAAAAAAAAAAAA}" {
    SCR_UIDescription "{BBBBBBBBBBBBBBBB}" {
     m_sTitle "Nested"
    }
   }
  }
}`;
    const components = parseTopLevelComponents(content);
    expect([...components.keys()]).toEqual(["AAAAAAAAAAAAAAAA"]);
    expect(components.get("AAAAAAAAAAAAAAAA")?.typeName).toBe("SCR_BaseGameMode");
  });
});

describe("mergeAncestryComponents", () => {
  function makeLevel(depth: number, components: Record<string, string>): AncestorLevel {
    const compMap = new Map(
      Object.entries(components).map(([guid, type]) => [
        guid,
        { guid, typeName: type, rawBody: "" },
      ])
    );
    return { path: `level${depth}.et`, depth, entityClass: "GenericEntity", components: compMap, rawContent: "" };
  }

  it("returns empty map for empty levels", () => {
    expect(mergeAncestryComponents([]).size).toBe(0);
  });

  it("returns all components from a single level", () => {
    const level = makeLevel(0, { AAAAAAAAAAAAAAAA: "MeshObject", BBBBBBBBBBBBBBBB: "RigidBody" });
    const merged = mergeAncestryComponents([level]);
    expect(merged.size).toBe(2);
    expect(merged.get("AAAAAAAAAAAAAAAA")!.comp.typeName).toBe("MeshObject");
  });

  it("child overrides parent for same GUID", () => {
    const parent = makeLevel(0, { AAAAAAAAAAAAAAAA: "MeshObject" });
    const child = makeLevel(1, { AAAAAAAAAAAAAAAA: "MeshObject" }); // same GUID, re-declared
    const merged = mergeAncestryComponents([parent, child]);
    expect(merged.size).toBe(1);
    expect(merged.get("AAAAAAAAAAAAAAAA")!.source.depth).toBe(1); // child wins
  });

  it("includes ancestor-only components not present in leaf", () => {
    const parent = makeLevel(0, { AAAAAAAAAAAAAAAA: "MeshObject" });
    const child = makeLevel(1, { BBBBBBBBBBBBBBBB: "RigidBody" }); // different GUID
    const merged = mergeAncestryComponents([parent, child]);
    expect(merged.size).toBe(2);
    expect(merged.has("AAAAAAAAAAAAAAAA")).toBe(true);
    expect(merged.has("BBBBBBBBBBBBBBBB")).toBe(true);
  });
});

describe("walkChain with real PAC1 absolute offsets", () => {
  const testDir = join(tmpdir(), `reforger-forge-ancestry-${process.pid}`);
  const gameDir = join(testDir, "game");
  const dataDir = join(gameDir, "addons", "data");
  const workshopDir = join(gameDir, "addons", "WCS_Armaments_fixture");
  const config: Config = {
    workbenchPath: "",
    gamePath: gameDir,
    dataDir: "",
    patternsDir: "",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };

  beforeAll(() => {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workshopDir, { recursive: true });

    writeFileSync(join(dataDir, "data007.pak"), buildAncestryPak([
      {
        path: "Prefabs/Vehicles/Core/Wheeled_Car_Base.et",
        content: 'Vehicle {\n components {\n  RigidBody "{AAAAAAAAAAAAAAAA}" {\n  }\n }\n}',
      },
      {
        path: "Prefabs/Vehicles/Wheeled/S1203/S1203_base.et",
        content: 'Vehicle : "{1111111111111111}Prefabs/Vehicles/Core/Wheeled_Car_Base.et" {\n components {\n  MeshObject "{BBBBBBBBBBBBBBBB}" {\n  }\n }\n}',
      },
      {
        path: "Prefabs/Vehicles/Wheeled/S105/S105_rally.et",
        content: 'Vehicle {\n components {\n  MeshObject "{CCCCCCCCCCCCCCCC}" {\n  }\n }\n}',
      },
      { path: "Sentinel/after_base.txt", content: "following entry bytes" },
    ]));

    writeFileSync(join(workshopDir, "data.pak"), buildAncestryPak([
      {
        path: "Prefabs/Vehicles/Wheeled/S105/S105_rally_wcs.et",
        content: 'Vehicle : "{2222222222222222}Prefabs/Vehicles/Wheeled/S105/S105_rally.et" {\r\n components {\r\n  RigidBody "{DDDDDDDDDDDDDDDD}" {\r\n  }\r\n }\r\n}',
      },
      {
        path: "Prefabs/Vehicles/Wheeled/S105/S105_rally_wcs_M134_M261.et",
        content: 'Vehicle : "{3333333333333333}Prefabs/Vehicles/Wheeled/S105/S105_rally_wcs.et" {\r\n components {\r\n  MeshObject "{EEEEEEEEEEEEEEEE}" {\r\n  }\r\n }\r\n}',
      },
      { path: "Sentinel/after_workshop.txt", content: "following workshop bytes" },
    ]));

    PakVirtualFS.invalidate();
  });

  afterAll(() => {
    PakVirtualFS.invalidate();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("resolves a base-game chain whose prefix was previously shifted by DATA start", () => {
    const result = walkChain("Prefabs/Vehicles/Wheeled/S1203/S1203_base.et", config);
    expect(result.warnings).toEqual([]);
    expect(result.levels.map((level) => level.path)).toEqual([
      "Prefabs/Vehicles/Core/Wheeled_Car_Base.et",
      "Prefabs/Vehicles/Wheeled/S1203/S1203_base.et",
    ]);
    expect(result.levels[1].rawContent).toMatch(/^Vehicle :/);
  });

  it("resolves a Workshop chain across nested and base-game PAKs", () => {
    const result = walkChain(
      "Prefabs/Vehicles/Wheeled/S105/S105_rally_wcs_M134_M261.et",
      config
    );
    expect(result.warnings).toEqual([]);
    expect(result.levels.map((level) => level.path)).toEqual([
      "Prefabs/Vehicles/Wheeled/S105/S105_rally.et",
      "Prefabs/Vehicles/Wheeled/S105/S105_rally_wcs.et",
      "Prefabs/Vehicles/Wheeled/S105/S105_rally_wcs_M134_M261.et",
    ]);
    expect(result.levels[2].entityClass).toBe("Vehicle");
  });
});
