import { cpSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObserverError } from "../../observer/agent/errors.js";
import { StagingManager, verifySourceBundle } from "../../observer/agent/staging.js";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer addon staging", () => {
  it("verifies source and reuses one content-addressed immutable copy", async () => {
    await withTemporaryDirectory((root) => {
    const manager = new StagingManager(root, observerAddonSource);
    const first = manager.ensureStaged();
    const second = manager.ensureStaged();
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.bundleDigest).toBe(verifySourceBundle(observerAddonSource).manifest.bundleDigest);
    expect(second.addonDirectory.startsWith(root)).toBe(true);
    });
  });

  it("fails closed when staged content is modified", async () => {
    await withTemporaryDirectory((root) => {
    const manager = new StagingManager(root, observerAddonSource);
    const staged = manager.ensureStaged();
    writeFileSync(join(staged.addonDirectory, "addon.gproj"), "modified");
    expect(() => manager.ensureStaged()).toThrowError(expect.objectContaining<Partial<ObserverError>>({ code: "STAGED_ADDON_CONFLICT" }));
    });
  });

  it("rejects undeclared source additions and manifest-declared source removals", async () => {
    await withTemporaryDirectory((root) => {
    const added = join(root, "added");
    cpSync(observerAddonSource, added, { recursive: true });
    writeFileSync(join(added, "undeclared-source-file.txt"), "not in the source manifest", "utf8");
    expect(() => verifySourceBundle(added)).toThrowError(expect.objectContaining<Partial<ObserverError>>({
      code: "ADDON_STAGE_FAILED",
    }));

    const removed = join(root, "removed");
    cpSync(observerAddonSource, removed, { recursive: true });
    unlinkSync(join(removed, "addon.gproj"));
    expect(() => verifySourceBundle(removed)).toThrowError(expect.objectContaining<Partial<ObserverError>>({
      code: "ADDON_STAGE_FAILED",
    }));
    });
  });

  it("preserves modified and unrelated files during cleanup", async () => {
    await withTemporaryDirectory((root) => {
    const manager = new StagingManager(root, observerAddonSource);
    const staged = manager.ensureStaged();
    const modified = join(staged.addonDirectory, "addon.gproj");
    const unrelated = join(staged.addonDirectory, "notes.txt");
    writeFileSync(modified, `${readFileSync(modified, "utf8")}\nuser change`);
    writeFileSync(unrelated, "keep me");
    const result = manager.cleanup(staged.bundleDigest);
    expect(result.kind).toBe("modified_files");
    expect(result.modified).toContain("addon.gproj");
    expect(result.unrelated).toContain("notes.txt");
    expect(existsSync(modified)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    });
  });

  it("refuses cleanup while an active session references the digest", async () => {
    await withTemporaryDirectory((root) => {
    const manager = new StagingManager(root, observerAddonSource);
    const staged = manager.ensureStaged();
    expect(() => manager.cleanup(staged.bundleDigest, new Set([staged.bundleDigest]))).toThrowError(expect.objectContaining({ code: "STAGED_ADDON_CONFLICT" }));
    });
  });
});
