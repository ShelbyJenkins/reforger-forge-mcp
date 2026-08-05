import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ResourceMetaError,
  tryReadResourceMetaGuid,
} from "../../src/workbench/resource-meta.js";

describe("wb_entity_duplicate metadata compatibility", () => {
  it("uses the shared tolerant adapter instead of a private GUID regex", () => {
    const source = readFileSync(resolve("src/tools/wb-entity-duplicate.ts"), "utf8");
    expect(source).toContain("tryReadResourceMetaGuid(absDestPath + \".meta\")");
    expect(source).not.toContain("function readMetaGuid");
    expect(source).not.toContain("Name\\s+");
  });

  it("keeps typed metadata failures from becoming duplicate-tool failures", () => {
    expect(() => tryReadResourceMetaGuid(resolve("missing-sidecar.meta"))).not.toThrow();
    expect(tryReadResourceMetaGuid(resolve("missing-sidecar.meta"))).toBeNull();
    expect(ResourceMetaError).toBeTypeOf("function");
  });
});
