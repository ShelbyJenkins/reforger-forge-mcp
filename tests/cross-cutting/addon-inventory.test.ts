import { cpSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPackagedAddonInventory } from "../../scripts/lib/addon-inventory.mjs";
import { cleanup, observerAddonSource, temporaryDirectory } from "../observer/helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

function cloneObserverAddon(name: string): string {
  const root = temporaryDirectory("rfo-task0-packaged-inventory-");
  roots.push(root);
  const addon = join(root, name);
  cpSync(observerAddonSource, addon, { recursive: true });
  return addon;
}

function verify(addon: string): void {
  verifyPackagedAddonInventory(addon, {
    manifestName: ".reforger-forge-observer-source.json",
    displayName: "Packaged observer add-on",
  });
}

describe("packaged observer add-on inventory", () => {
  it("accepts the canonical payload set", () => {
    verify(cloneObserverAddon("canonical"));
  });

  it("rejects an undeclared packaged addition", () => {
    const addon = cloneObserverAddon("addition");
    writeFileSync(join(addon, "undeclared-package-file.txt"), "not declared", "utf8");
    expect(() => verify(addon)).toThrow("does not declare every packaged payload file exactly once");
  });

  it("rejects a missing manifest-declared packaged file", () => {
    const addon = cloneObserverAddon("removal");
    unlinkSync(join(addon, "addon.gproj"));
    expect(() => verify(addon)).toThrow("does not declare every packaged payload file exactly once");
  });
});
