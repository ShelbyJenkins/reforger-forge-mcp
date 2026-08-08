import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseResourceMetaGuid,
  readResourceMeta,
  readResourceMetaGuid,
  ResourceMetaError,
  tryReadResourceMetaGuid,
} from "../../src/workbench/resource-meta.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const fixture = resolve("tests/fixtures/workbench-resource-meta/RegisteredWorld.ent.meta");

function capture(action: () => unknown): ResourceMetaError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ResourceMetaError);
    return error as ResourceMetaError;
  }
  throw new Error("Expected ResourceMetaError");
}

describe("Workbench resource metadata", () => {
  it("parses only the top-level resource Name field and normalizes its GUID", () => {
    const record = readResourceMeta(fixture);

    expect(record.guid).toBe("A1B2C3D4E5F60718");
    expect(record.evidence.byteLength).toBeGreaterThan(0);
    expect(record.evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.evidence)).toBe(true);
  });

  it("treats the stored path as informational after a Workbench-managed rename", () => {
    expect(readResourceMetaGuid(fixture)).toBe("A1B2C3D4E5F60718");
  });

  it("never falls back to an unrelated GUID-looking token", () => {
    expect(() => parseResourceMetaGuid(`MetaFileClass {\n Other "{0123456789ABCDEF}Worlds/Fake.ent"\n}\n`))
      .toThrowError(ResourceMetaError);
    expect(() => parseResourceMetaGuid(`MetaFileClass {\n Name "Worlds/{0123456789ABCDEF}/Fake.ent"\n}\n`))
      .toThrowError(ResourceMetaError);
  });

  it("distinguishes missing, unreadable, oversize, and malformed sidecars", async () => {
    await withTemporaryDirectory((root) => {
      const missing = join(root, "Missing.ent.meta");
      expect(capture(() => readResourceMeta(missing)).code).toBe("MISSING");

      const unreadable = join(root, "Directory.ent.meta");
      mkdirSync(unreadable);
      expect(capture(() => readResourceMeta(unreadable)).code).toBe("UNREADABLE");

      const oversize = join(root, "Large.ent.meta");
      writeFileSync(oversize, "x".repeat(33), "utf8");
      expect(capture(() => readResourceMeta(oversize, { maximumBytes: 32 })).code).toBe("OVERSIZE");

      const malformed = join(root, "Malformed.ent.meta");
      writeFileSync(malformed, `MetaFileClass {\n Name "{NOT-A-GUID}Worlds/Test.ent"\n}\n`, "utf8");
      expect(capture(() => readResourceMeta(malformed)).code).toBe("MALFORMED");
    });
  });

  it("offers a deliberately tolerant adapter for compatibility callers", () => {
    expect(tryReadResourceMetaGuid(fixture)).toBe("A1B2C3D4E5F60718");
    expect(tryReadResourceMetaGuid(resolve("tests/fixtures/does-not-exist.meta"))).toBeNull();
  });
});
