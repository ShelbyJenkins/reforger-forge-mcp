import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ADDON_GUID, ADDON_ID, ADDON_VERSION, OBSERVER_BUILD_IDENTITY, PROTOCOL_VERSION, SHA256_PATTERN } from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import {
  assertManagedPath,
  assertRegularManagedFile,
  atomicWriteJson,
  canonicalizeExistingDirectory,
  ensureCanonicalDirectory,
  listRegularFiles,
} from "./paths.js";

export const SOURCE_MANIFEST_NAME = ".reforger-forge-observer-source.json";

const sourceManifestSchema = z.object({
  manifestVersion: z.literal(1),
  addonVersion: z.string().min(1).max(32),
  protocolVersion: z.string().regex(/^\d+\.\d+$/),
  addonId: z.literal(ADDON_ID),
  addonGuid: z.literal(ADDON_GUID),
  buildIdentity: z.literal(OBSERVER_BUILD_IDENTITY),
  bundleDigest: z.string().regex(SHA256_PATTERN),
  files: z.array(z.object({
    path: z.string().regex(/^[A-Za-z0-9._/-]+$/).refine((value) => !value.startsWith("/") && !value.includes("..")),
    sha256: z.string().regex(SHA256_PATTERN),
  })).min(1),
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

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function computeBundleDigest(files: readonly { path: string; sha256: string }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.sha256, "ascii");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

function parseManifest(path: string, conflict: boolean): ObserverSourceManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ObserverError(conflict ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", `Observer manifest is missing or malformed: ${path}`);
  }
  const parsed = sourceManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ObserverError(conflict ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", "Observer manifest does not match version 1");
  }
  const duplicate = new Set<string>();
  for (const file of parsed.data.files) {
    if (duplicate.has(file.path)) {
      throw new ObserverError(conflict ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", `Observer manifest repeats a payload path: ${file.path}`);
    }
    duplicate.add(file.path);
  }
  if (computeBundleDigest(parsed.data.files) !== parsed.data.bundleDigest) {
    throw new ObserverError(conflict ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", "Observer aggregate bundle digest does not match its file manifest");
  }
  return parsed.data;
}

function verifyBundleDirectory(directoryPath: string, expectedDigest?: string, staged = false): VerifiedBundle {
  const directory = canonicalizeExistingDirectory(directoryPath, staged ? "Staged addon" : "Observer package source");
  const manifestPath = join(directory, SOURCE_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new ObserverError(staged ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", `Observer source manifest is missing: ${manifestPath}`);
  }
  assertRegularManagedFile(directory, manifestPath);
  const manifest = parseManifest(manifestPath, staged);
  if (expectedDigest && manifest.bundleDigest !== expectedDigest) {
    throw new ObserverError("STAGED_ADDON_CONFLICT", "Staged addon digest does not match its content-addressed directory");
  }
  if (manifest.addonVersion !== ADDON_VERSION || manifest.protocolVersion !== PROTOCOL_VERSION) {
    throw new ObserverError(staged ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", "Observer package version is not supported by this agent");
  }

  const actualFiles = listRegularFiles(directory).filter((path) => path !== SOURCE_MANIFEST_NAME).sort();
  const expectedFiles = manifest.files.map((file) => file.path).sort();
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    throw new ObserverError(staged ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", "Observer payload file set is incomplete or contains unexpected files");
  }
  for (const file of manifest.files) {
    const payloadPath = join(directory, ...file.path.split("/"));
    assertRegularManagedFile(directory, payloadPath);
    if (sha256File(payloadPath) !== file.sha256) {
      throw new ObserverError(staged ? "STAGED_ADDON_CONFLICT" : "ADDON_STAGE_FAILED", `Observer payload hash mismatch: ${file.path}`);
    }
  }
  return { sourceDirectory: directory, manifest };
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
    const digestRoot = join(this.addonsRoot, source.manifest.bundleDigest);
    const addonDirectory = join(digestRoot, ADDON_ID);
    assertManagedPath(this.addonsRoot, addonDirectory);

    if (existsSync(addonDirectory)) {
      const verified = verifyBundleDirectory(addonDirectory, source.manifest.bundleDigest, true);
      return { bundleDigest: verified.manifest.bundleDigest, addonDirectory, addonSearchRoot: digestRoot, reused: true, manifest: verified.manifest };
    }
    if (existsSync(digestRoot)) {
      throw new ObserverError("STAGED_ADDON_CONFLICT", `Digest directory exists without a valid observer addon: ${digestRoot}`);
    }

    const temporaryRoot = join(this.addonsRoot, `.${source.manifest.bundleDigest}.${randomUUID()}.tmp`);
    const temporaryAddon = join(temporaryRoot, ADDON_ID);
    try {
      mkdirSync(temporaryAddon, { recursive: true, mode: 0o700 });
      for (const file of source.manifest.files) {
        const sourcePath = join(source.sourceDirectory, ...file.path.split("/"));
        const targetPath = join(temporaryAddon, ...file.path.split("/"));
        assertManagedPath(temporaryRoot, targetPath);
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        copyFileSync(sourcePath, targetPath);
      }
      atomicWriteJson(temporaryAddon, join(temporaryAddon, SOURCE_MANIFEST_NAME), source.manifest);
      verifyBundleDirectory(temporaryAddon, source.manifest.bundleDigest, true);
      try {
        renameSync(temporaryRoot, digestRoot);
      } catch (error) {
        if (!existsSync(addonDirectory)) throw error;
        verifyBundleDirectory(addonDirectory, source.manifest.bundleDigest, true);
        rmSync(temporaryRoot, { recursive: true, force: true });
        return { bundleDigest: source.manifest.bundleDigest, addonDirectory, addonSearchRoot: digestRoot, reused: true, manifest: source.manifest };
      }
      return { bundleDigest: source.manifest.bundleDigest, addonDirectory, addonSearchRoot: digestRoot, reused: false, manifest: source.manifest };
    } catch (error) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      if (error instanceof ObserverError) throw error;
      throw new ObserverError("ADDON_STAGE_FAILED", `Could not stage observer addon: ${error instanceof Error ? error.message : String(error)}`);
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
    const manifest = parseManifest(manifestPath, true);
    if (manifest.bundleDigest !== bundleDigest) throw new ObserverError("STAGED_ADDON_CONFLICT", "Staged manifest digest does not match its directory");
    const actualFiles = listRegularFiles(addonDirectory);
    const managed = new Set(manifest.files.map((file) => file.path));
    const unrelated = actualFiles.filter((file) => file !== SOURCE_MANIFEST_NAME && !managed.has(file));
    const modified: string[] = [];
    const removed: string[] = [];
    for (const file of manifest.files) {
      const target = join(addonDirectory, ...file.path.split("/"));
      if (!existsSync(target) || lstatSync(target).isSymbolicLink() || sha256File(target) !== file.sha256) {
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
