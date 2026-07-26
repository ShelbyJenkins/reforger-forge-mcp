import { describe, expect, it } from "vitest";
import { parseResourceGuidIndex } from "../../src/index/resource-database.js";

interface RecordFixture {
  path: string;
  kind: 4 | 5 | 6 | 7 | 22;
  guid?: string;
}

function resourceDatabase(records: RecordFixture[], version = 7): Buffer {
  const headerBody = Buffer.alloc(16);
  headerBody.writeUInt32LE(version, 0);
  // Declared file size at bytes 16..23 is filled after concatenation.
  headerBody.writeUInt32LE(1, 12);

  const platform = Buffer.alloc(4 + 7 + 4);
  platform.writeUInt32LE(7, 0);
  platform.write("spruce\0", 4, "utf8");
  platform.writeUInt32LE(116_310, 11);

  const encodedRecords = records.map((record) => {
    const path = Buffer.from(`${record.path}\0`, "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(path.length);
    const metadata = Buffer.alloc(14);
    metadata[0] = record.kind;
    if (record.guid) {
      Buffer.from(record.guid, "hex").reverse().copy(metadata, 6);
    }
    const trailer = [6, 7, 22].includes(record.kind)
      ? Buffer.alloc(8)
      : Buffer.alloc(0);
    return Buffer.concat([header, path, metadata, trailer]);
  });

  const formHeader = Buffer.alloc(12);
  formHeader.write("FORM", 0, "ascii");
  formHeader.write("RDBC", 8, "ascii");
  const result = Buffer.concat([formHeader, headerBody, platform, ...encodedRecords]);
  result.writeUInt32BE(result.length - 8, 4);
  result.writeBigUInt64LE(BigInt(result.length), 16);
  return result;
}

describe("parseResourceGuidIndex", () => {
  it("extracts canonical resource paths and little-endian GUIDs", () => {
    const index = parseResourceGuidIndex(resourceDatabase([
      { path: "", kind: 5 },
      { path: "Prefabs/MP/Modes/Plain", kind: 5, guid: "10CC5F9A05F166F9" },
      {
        path: "Prefabs/MP/Modes/Plain/GameMode_Plain.et",
        kind: 6,
        guid: "1B76F75A3175E85C",
      },
      { path: "scripts/Game/Test.c", kind: 4 },
    ]));

    expect(index.version).toBe(7);
    expect(index.entries.get("Prefabs/MP/Modes/Plain/GameMode_Plain.et"))
      .toBe("1B76F75A3175E85C");
    expect(index.entries.has("scripts/Game/Test.c")).toBe(false);
  });

  it("fails closed for an unsupported database version", () => {
    expect(() => parseResourceGuidIndex(resourceDatabase([], 8)))
      .toThrow("Unsupported RDBC version 8");
  });
});
