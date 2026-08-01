import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findLooseFile,
  normalizeGameResourcePath,
} from "../../src/utils/game-paths.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("game resource path containment", () => {
  it("normalizes one valid GUID prefix and Windows separators", () => {
    expect(normalizeGameResourcePath(
      "{657590C1EC9E27D3}Prefabs\\Groups\\Example.et"
    )).toBe("Prefabs/Groups/Example.et");
  });

  it.each([
    "../outside.et",
    "Prefabs/../../outside.et",
    "Prefabs/./Example.et",
    "Prefabs//Example.et",
    "/absolute/Example.et",
    "C:\\absolute\\Example.et",
    "C:drive-relative.et",
    "{BAD}Prefabs/Example.et",
    "{657590C1EC9E27D3}{0123456789ABCDEF}Prefabs/Example.et",
  ])("rejects an unsafe or non-normalized resource reference: %s", (reference) => {
    expect(() => normalizeGameResourcePath(reference)).toThrow();
  });

  it("finds contained direct and Data-prefixed files but refuses sibling traversal", async () => {
    await withTemporaryDirectory((root) => {
      const dataRoot = join(root, "data");
      const direct = join(dataRoot, "Prefabs", "Direct.et");
      const prefixed = join(dataRoot, "Data006", "Prefabs", "Prefixed.et");
      const outside = join(root, "outside.et");
      mkdirSync(join(dataRoot, "Prefabs"), { recursive: true });
      mkdirSync(join(dataRoot, "Data006", "Prefabs"), { recursive: true });
      writeFileSync(direct, "direct", "utf8");
      writeFileSync(prefixed, "prefixed", "utf8");
      writeFileSync(outside, "outside", "utf8");

      expect(findLooseFile(dataRoot, "Prefabs/Direct.et"))
        .toBe(realpathSync.native(direct));
      expect(findLooseFile(dataRoot, "Prefabs/Prefixed.et"))
        .toBe(realpathSync.native(prefixed));
      expect(findLooseFile(dataRoot, "../outside.et")).toBeNull();
      expect(findLooseFile(dataRoot, outside)).toBeNull();
    }, { prefix: "rfo-game-paths-" });
  });
});
