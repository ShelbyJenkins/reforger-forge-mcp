import {
  existsSync,
  lstatSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ADDON_GUID, ADDON_ID, ADDON_VERSION, OBSERVER_BUILD_IDENTITY, PROTOCOL_VERSION, SHA256_PATTERN } from "../protocol/index.js";
import {
  ContentAddressedBundleError,
  createContentAddressedBundleManifestSchema,
  readContentAddressedBundleManifest,
  sha256ContentFile,
  stageContentAddressedBundle,
  verifyContentAddressedBundle,
  type ContentAddressedBundlePolicy,
} from "#companions/content-addressed-bundle";
import { ObserverError } from "./errors.js";
import {
  assertManagedPath,
  ensureCanonicalDirectory,
  listRegularFiles,
} from "./paths.js";

export const SOURCE_MANIFEST_NAME = ".reforger-forge-observer-source.json";

const sourceManifestSchema = createContentAddressedBundleManifestSchema({
  addonVersion: z.literal(ADDON_VERSION),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  addonId: z.literal(ADDON_ID),
  addonGuid: z.literal(ADDON_GUID),
  buildIdentity: z.literal(OBSERVER_BUILD_IDENTITY),
});

export type ObserverSourceManifest = z.infer<typeof sourceManifestSchema>;

export interface VerifiedBundle {
  sourceDirectory: string;
  manifest: ObserverSourceManifest;
}

export interface StagedAddon {
  bundleDigest: string;
  addonDirectory: string;
  addonSearchRoot: string;
  reused: boolean;
  manifest: ObserverSourceManifest;
}

export interface StagedCleanupResult {
  kind: "removed" | "not_installed" | "modified_files";
  removed: string[];
  modified: string[];
  unrelated: string[];
}

const observerBundlePolicy: ContentAddressedBundlePolicy<ObserverSourceManifest> = {
  displayName: "Observer",
  addonDirectoryName: ADDON_ID,
  manifestName: SOURCE_MANIFEST_NAME,
  manifestSchema: sourceManifestSchema,
};

function asObserverError(error: unknown): never {
  if (error instanceof ObserverError) throw error;
  if (error instanceof ContentAddressedBundleError) {
    const invalidPath = error.issue === "directory_unavailable" ||
      error.issue === "directory_not_directory" || error.issue === "unsafe_path";
    throw new ObserverError(
      invalidPath
        ? "INVALID_REQUEST"
        : error.mode === "staged" ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED",
      error.message
    );
  }
  throw error;
}

function verifyBundleDirectory(directoryPath: string, expectedDigest?: string, staged = false): VerifiedBundle {
  try {
    return verifyContentAddressedBundle(observerBundlePolicy, directoryPath, {
      mode: staged ? "staged" : "source",
      expectedDigest,
      allowStagedExtraFiles: staged,
    });
  } catch (error) {
    return asObserverError(error);
  }
}

export function verifySourceBundle(sourceDirectory: string): VerifiedBundle {
  return verifyBundleDirectory(sourceDirectory);
}

export class StagingManager {
  readonly addonsRoot: string;

  constructor(
    observerRoot: string,
    readonly sourceDirectory: string
  ) {
    const root = ensureCanonicalDirectory(observerRoot);
    this.addonsRoot = ensureCanonicalDirectory(join(root, "addons"));
    assertManagedPath(root, this.addonsRoot);
  }

  ensureStaged(): StagedAddon {
    const source = verifySourceBundle(this.sourceDirectory);
    try {
      return stageContentAddressedBundle(observerBundlePolicy, source, this.addonsRoot);
    } catch (error) {
      return asObserverError(error);
    }
  }

  verifyStaged(bundleDigest: string): StagedAddon {
    if (!SHA256_PATTERN.test(bundleDigest)) throw new ObserverError("INVALID_REQUEST", "Invalid observer bundle digest");
    const digestRoot = join(this.addonsRoot, bundleDigest);
    const addonDirectory = join(digestRoot, ADDON_ID);
    const verified = verifyBundleDirectory(addonDirectory, bundleDigest, true);
    return { bundleDigest, addonDirectory, addonSearchRoot: digestRoot, reused: true, manifest: verified.manifest };
  }

  cleanup(bundleDigest: string, activeDigests: ReadonlySet<string> = new Set()): StagedCleanupResult {
    if (!SHA256_PATTERN.test(bundleDigest)) throw new ObserverError("INVALID_REQUEST", "Invalid observer bundle digest");
    if (activeDigests.has(bundleDigest)) throw new ObserverError("STAGED_ADDON_CONFLICT", "A live session still references this staged addon");
    const digestRoot = join(this.addonsRoot, bundleDigest);
    const addonDirectory = join(digestRoot, ADDON_ID);
    if (!existsSync(addonDirectory)) return { kind: "not_installed", removed: [], modified: [], unrelated: [] };
    const manifestPath = join(addonDirectory, SOURCE_MANIFEST_NAME);
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) {
      throw new ObserverError("STAGED_ADDON_CONFLICT", "Staged addon has no trustworthy observer manifest; it was preserved");
    }
    let manifest: ObserverSourceManifest;
    try {
      manifest = readContentAddressedBundleManifest(observerBundlePolicy, manifestPath, "staged");
    } catch (error) {
      return asObserverError(error);
    }
    if (manifest.bundleDigest !== bundleDigest) throw new ObserverError("STAGED_ADDON_CONFLICT", "Staged manifest digest does not match its directory");
    const actualFiles = listRegularFiles(addonDirectory);
    const managed = new Set(manifest.files.map((file) => file.path));
    const unrelated = actualFiles.filter((file) => file !== SOURCE_MANIFEST_NAME && !managed.has(file));
    const modified: string[] = [];
    const removed: string[] = [];
    for (const file of manifest.files) {
      const target = join(addonDirectory, ...file.path.split("/"));
      if (!existsSync(target) || lstatSync(target).isSymbolicLink() || sha256ContentFile(target) !== file.sha256) {
        modified.push(file.path);
        continue;
      }
      unlinkSync(target);
      removed.push(file.path);
    }
    if (modified.length === 0) {
      unlinkSync(manifestPath);
      removed.push(SOURCE_MANIFEST_NAME);
    }
    const directories = [...new Set(manifest.files.map((file) => dirname(join(addonDirectory, ...file.path.split("/")))))]
      .sort((a, b) => b.length - a.length);
    for (const directory of directories) {
      try { rmdirSync(directory); } catch { /* preserve nonempty or unrelated directories */ }
    }
    try { rmdirSync(addonDirectory); } catch { /* preserved content remains */ }
    try { rmdirSync(digestRoot); } catch { /* preserved content remains */ }
    return { kind: modified.length || unrelated.length ? "modified_files" : "removed", removed, modified, unrelated };
  }
}
