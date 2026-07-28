import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StagingManager } from "../../observer/agent/staging.js";
import { resolveProjectIdentity } from "../../src/workbench/project-identity.js";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer/Workbench isolation", () => {
  it("staging outside the addon leaves explicit canonical target resolution unchanged", async () => {
    await withTemporaryDirectory((root) => {
    const projectRoot = join(root, "projects");
    const target = join(projectRoot, "TargetAddon");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "TargetAddon.gproj"), "GameProject { ID TargetAddon }");
    const gprojPath = join(target, "TargetAddon.gproj");
    const before = resolveProjectIdentity({ gprojPath });
    const observerRoot = join(root, "observer-managed");
    const staged = new StagingManager(observerRoot, observerAddonSource).ensureStaged();
    const after = resolveProjectIdentity({ gprojPath });
    expect(after.comparisonKey).toBe(before.comparisonKey);
    expect(staged.addonDirectory.startsWith(projectRoot)).toBe(false);
    });
  });
});
