import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObserverError } from "../../observer/agent/errors.js";
import { StagingManager, verifySourceBundle } from "../../observer/agent/staging.js";
import { cleanup, observerAddonSource, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

describe("observer addon staging", () => {
  it("verifies source and reuses one content-addressed immutable copy", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const manager = new StagingManager(root, observerAddonSource);
    const first = manager.ensureStaged();
    const second = manager.ensureStaged();
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.bundleDigest).toBe(verifySourceBundle(observerAddonSource).manifest.bundleDigest);
    expect(second.addonDirectory.startsWith(root)).toBe(true);
  });

  it("fails closed when staged content is modified", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const manager = new StagingManager(root, observerAddonSource);
    const staged = manager.ensureStaged();
    writeFileSync(join(staged.addonDirectory, "addon.gproj"), "modified");
    expect(() => manager.ensureStaged()).toThrowError(expect.objectContaining<Partial<ObserverError>>({ code: "STAGED_ADDON_CONFLICT" }));
  });

  it("preserves modified and unrelated files during cleanup", () => {
    const root = temporaryDirectory();
    roots.push(root);
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

  it("refuses cleanup while an active session references the digest", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const manager = new StagingManager(root, observerAddonSource);
    const staged = manager.ensureStaged();
    expect(() => manager.cleanup(staged.bundleDigest, new Set([staged.bundleDigest]))).toThrowError(expect.objectContaining({ code: "STAGED_ADDON_CONFLICT" }));
  });
});
