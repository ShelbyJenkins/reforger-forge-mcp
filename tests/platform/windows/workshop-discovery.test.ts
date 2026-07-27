import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverStandardWorkshopAddonRoot } from "../../../src/platform/windows/workshop-discovery.js";
import { withTemporaryDirectory } from "../../support/temporary-directory.js";

function workshopAddonsPath(documentsRoot: string): string {
  return join(documentsRoot, "My Games", "ArmaReforger", "addons");
}

describe("standard Workshop add-on root discovery", () => {
  it("uses the OneDrive Documents convention when the add-on directory exists", async () => {
    await withTemporaryDirectory((root) => {
      const oneDriveRoot = join(root, "OneDrive");
      const candidate = workshopAddonsPath(join(oneDriveRoot, "Documents"));
      mkdirSync(candidate, { recursive: true });

      expect(discoverStandardWorkshopAddonRoot({ OneDrive: oneDriveRoot })).toBe(
        candidate
      );
    }, { prefix: "rfo-workshop-discovery-onedrive-" });
  });

  it("uses the profile OneDrive Documents convention when a child omits OneDrive", async () => {
    await withTemporaryDirectory((root) => {
      const homeDirectory = join(root, "home");
      const candidate = workshopAddonsPath(join(homeDirectory, "OneDrive", "Documents"));
      mkdirSync(candidate, { recursive: true });

      expect(discoverStandardWorkshopAddonRoot({}, () => homeDirectory)).toBe(
        candidate
      );
    }, { prefix: "rfo-workshop-discovery-profile-onedrive-" });
  });

  it("falls back to the home Documents convention when OneDrive is unset", async () => {
    await withTemporaryDirectory((root) => {
      const homeDirectory = join(root, "home");
      const candidate = workshopAddonsPath(join(homeDirectory, "Documents"));
      mkdirSync(candidate, { recursive: true });

      expect(discoverStandardWorkshopAddonRoot({}, () => homeDirectory)).toBe(
        candidate
      );
    }, { prefix: "rfo-workshop-discovery-home-" });
  });

  it("returns undefined when the conventional path is missing or is a regular file", async () => {
    await withTemporaryDirectory((root) => {
      const oneDriveRoot = join(root, "OneDrive");
      const candidate = workshopAddonsPath(join(oneDriveRoot, "Documents"));
      const homeDirectory = join(root, "home");

      expect(discoverStandardWorkshopAddonRoot({ OneDrive: oneDriveRoot }, () => homeDirectory))
        .toBeUndefined();

      mkdirSync(dirname(candidate), { recursive: true });
      writeFileSync(candidate, "not a directory", "utf8");
      expect(discoverStandardWorkshopAddonRoot({ OneDrive: oneDriveRoot }, () => homeDirectory))
        .toBeUndefined();
    }, { prefix: "rfo-workshop-discovery-missing-" });
  });
});
