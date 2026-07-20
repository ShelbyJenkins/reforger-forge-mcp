import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensurePaths, inspectPaths } from "../../observer/agent/paths.js";
import { cleanup, temporaryDirectory } from "./helpers.js";

describe("observer path inspection", () => {
  it("does not create a missing root", () => {
    const root = join(temporaryDirectory("rfo-inspect-"), "missing");
    try {
      const inspection = inspectPaths(root);
      expect(inspection.readOnly).toBe(true);
      expect(inspection.entries.root.kind).toBe("missing");
      expect(existsSync(root)).toBe(false);
    } finally { cleanup(root.slice(0, root.lastIndexOf("\\"))); }
  });

  it("creates the managed layout only through ensurePaths", () => {
    const root = temporaryDirectory("rfo-ensure-");
    try {
      const paths = ensurePaths(join(root, "managed"));
      expect(inspectPaths(paths.root).entries.artifacts.kind).toBe("directory");
    } finally { cleanup(root); }
  });
});

