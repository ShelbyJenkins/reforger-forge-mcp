import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDisposableProject,
  workbenchResourceVirtualPath,
} from "../../scripts/run-workbench-observer-acceptance.js";

describe("createDisposableProject matrix resources", () => {
  it("stages the fixture dependency and generates isolated Matrix A/B worlds", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-matrix-project-"));
    try {
      const project = createDisposableProject(root, { stageMatrixFixture: true });
      expect(project.worldResource).toMatch(/^\{[A-F0-9]{16}\}Worlds\/ObserverMatrixA\.ent$/);
      expect(workbenchResourceVirtualPath(project.worldResource)).toBe("Worlds/ObserverMatrixA.ent");
      expect(project.alternateWorldResource).toMatch(/^\{[A-F0-9]{16}\}Worlds\/ObserverMatrixB\.ent$/);
      expect(existsSync(join(project.modDirectory, "Worlds", "ObserverMatrixA.ent"))).toBe(true);
      expect(existsSync(join(project.modDirectory, "Worlds", "ObserverMatrixB.ent"))).toBe(true);
      expect(existsSync(join(root, "ObserverMatrixFixture", "addon.gproj"))).toBe(true);
      expect(readFileSync(project.projectPath, "utf8")).toContain('"2C6B8D14F9A0473E"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the positive path on its original single ObserverAcceptance world", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-positive-project-"));
    try {
      const project = createDisposableProject(root);
      expect(project.worldResource).toMatch(/^\{[A-F0-9]{16}\}Worlds\/ObserverAcceptance\.ent$/);
      expect(project.alternateWorldResource).toBeNull();
      expect(existsSync(join(root, "ObserverMatrixFixture"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
