import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePaths, inspectPaths } from "../../observer/agent/paths.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer path inspection", () => {
  it("does not create a missing root", async () => {
    await withTemporaryDirectory((parent) => {
      const root = join(parent, "missing");
      const inspection = inspectPaths(root);
      expect(inspection.readOnly).toBe(true);
      expect(inspection.entries.root.kind).toBe("missing");
      expect(existsSync(root)).toBe(false);
    }, { prefix: "rfo-inspect-" });
  });

  it("creates the managed layout only through ensurePaths", async () => {
    await withTemporaryDirectory((root) => {
      const paths = ensurePaths(join(root, "managed"));
      expect(inspectPaths(paths.root).entries.artifacts.kind).toBe("directory");
    }, { prefix: "rfo-ensure-" });
  });
});
