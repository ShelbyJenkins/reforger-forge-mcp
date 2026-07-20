import { cpSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPackagedAddonInventory } from "../../scripts/lib/addon-inventory.mjs";
import { observerAddonSource } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

async function withClonedObserverAddon<T>(name: string, run: (addon: string) => T | Promise<T>): Promise<T> {
  return withTemporaryDirectory((root) => {
  const addon = join(root, name);
  cpSync(observerAddonSource, addon, { recursive: true });
    return run(addon);
  }, { prefix: "rfo-task0-packaged-inventory-" });
}

function verify(addon: string): void {
  verifyPackagedAddonInventory(addon, {
    manifestName: ".reforger-forge-observer-source.json",
    displayName: "Packaged observer add-on",
  });
}

describe("packaged observer add-on inventory", () => {
  it("accepts the canonical payload set", async () => {
    await withClonedObserverAddon("canonical", (addon) => verify(addon));
  });

  it("rejects an undeclared packaged addition", async () => {
    await withClonedObserverAddon("addition", (addon) => {
      writeFileSync(join(addon, "undeclared-package-file.txt"), "not declared", "utf8");
      expect(() => verify(addon)).toThrow("does not declare every packaged payload file exactly once");
    });
  });

  it("rejects a missing manifest-declared packaged file", async () => {
    await withClonedObserverAddon("removal", (addon) => {
      unlinkSync(join(addon, "addon.gproj"));
      expect(() => verify(addon)).toThrow("does not declare every packaged payload file exactly once");
    });
  });
});
