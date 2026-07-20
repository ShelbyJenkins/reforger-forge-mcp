import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  assertRegularManagedFile as foundationAssertRegularManagedFile,
  canonicalizeExistingDirectory as foundationCanonicalizeExistingDirectory,
  ensureCanonicalDirectory as foundationEnsureCanonicalDirectory,
  isPathContained as foundationIsPathContained,
  resolveManagedPath,
  inspectManagedPath,
  type ManagedPathInspection,
} from "#foundation/managed-path";
import { atomicWriteFile as foundationAtomicWriteFile } from "#foundation/json-store";
import { IDENTIFIER_PATTERN } from "../protocol/index.js";
import { ObserverError } from "./errors.js";

export interface ObserverManagedPaths {
  root: string;
  addons: string;
  artifacts: string;
  runs: string;
  exportWork: string;
  state: string;
  logs: string;
  profiles: string;
}

/**
 * Enfusion mounts `$profile:` beneath the directory supplied to `-profile`.
 * Keep that physical layout knowledge in one place so host-side files resolve
 * to the same paths the runtime sees.
 */
const ENGINE_PROFILE_MOUNT_DIRECTORY_NAME = "profile";

export interface EngineProfileDirectoryOptions {
  /** Create the engine mount directory as part of launch preparation. */
  create?: boolean;
  /** Require an already-prepared engine mount without creating it. */
  requireExisting?: boolean;
}

export function isPathContained(root: string, candidate: string): boolean {
  return foundationIsPathContained(root, candidate);
}

export interface ObserverPathInspection {
  readOnly: true;
  paths: ObserverManagedPaths;
  entries: Record<keyof ObserverManagedPaths, ManagedPathInspection>;
}

export function ensureCanonicalDirectory(directoryPath: string, mode = 0o700): string {
  try {
    return foundationEnsureCanonicalDirectory(directoryPath, mode);
  } catch (error) {
    throw new ObserverError(
      "INVALID_REQUEST",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function canonicalizeExistingDirectory(directoryPath: string, label = "Directory"): string {
  try {
    return foundationCanonicalizeExistingDirectory(directoryPath, label);
  } catch (error) {
    throw new ObserverError(
      "INVALID_REQUEST",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function resolveEngineProfileDirectory(
  launchProfilePath: string,
  options: EngineProfileDirectoryOptions = {}
): string {
  const launchProfile = canonicalizeExistingDirectory(launchProfilePath, "Launch profile root");
  const candidate = join(launchProfile, ENGINE_PROFILE_MOUNT_DIRECTORY_NAME);
  // Check every existing segment before mkdirSync can follow it. In
  // particular, an attacker-controlled `profile` symlink must never cause a
  // preparation write outside the exclusive launch root.
  assertManagedPath(launchProfile, candidate);
  if (options.create) {
    const canonical = ensureCanonicalDirectory(candidate);
    assertManagedPath(launchProfile, canonical);
    return canonical;
  }
  if (options.requireExisting) {
    const canonical = canonicalizeExistingDirectory(candidate, "Engine profile directory");
    assertManagedPath(launchProfile, canonical);
    return canonical;
  }
  return candidate;
}

export function assertManagedPath(rootPath: string, candidatePath: string): string {
  try {
    return resolveManagedPath(rootPath, candidatePath, "link-safe");
  } catch (error) {
    throw new ObserverError(
      "INVALID_REQUEST",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function assertRegularManagedFile(root: string, filePath: string): string {
  try {
    return foundationAssertRegularManagedFile(root, filePath);
  } catch (error) {
    throw new ObserverError(
      "INVALID_REQUEST",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function assertIdentifier(value: string, label = "Identifier"): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ObserverError("INVALID_REQUEST", `${label} is not a valid observer identifier`);
  }
  return value;
}

export function atomicWriteFile(root: string, targetPath: string, data: string | Uint8Array, mode = 0o600): void {
  foundationAtomicWriteFile({
    root,
    targetPath,
    data,
    // Every current observer payload has a tighter protocol/store-specific
    // bound. Keep a final hard ceiling here so the shared primitive is never
    // invoked with an unbounded publication.
    maxBytes: 1024 * 1024 * 1024,
    mode,
  });
}

export function atomicWriteJson(root: string, targetPath: string, value: unknown, mode = 0o600): void {
  atomicWriteFile(root, targetPath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function listRegularFiles(rootPath: string): string[] {
  const root = canonicalizeExistingDirectory(rootPath, "Bundle root");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new ObserverError("ADDON_STAGE_FAILED", `Bundle contains a symbolic link: ${relativePath}`);
      }
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files.push(relativePath);
      else throw new ObserverError("ADDON_STAGE_FAILED", `Bundle contains a non-regular entry: ${relativePath}`);
    }
  };
  visit(root);
  return files;
}

export function defaultObserverRoot(): string {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) return join(local, "ReforgerForge", "Observer", "v1");
  }
  const stateHome = process.env.XDG_STATE_HOME;
  return stateHome
    ? join(stateHome, "reforger-forge", "observer", "v1")
    : join(homedir(), ".local", "state", "reforger-forge", "observer", "v1");
}

export function ensurePaths(rootPath = defaultObserverRoot(), profileRoot?: string): ObserverManagedPaths {
  const root = ensureCanonicalDirectory(rootPath);
  const paths = {
    root,
    addons: ensureCanonicalDirectory(join(root, "addons")),
    artifacts: ensureCanonicalDirectory(join(root, "artifacts")),
    runs: ensureCanonicalDirectory(join(root, "runs")),
    exportWork: ensureCanonicalDirectory(join(root, "export-work")),
    state: ensureCanonicalDirectory(join(root, "state")),
    logs: ensureCanonicalDirectory(join(root, "logs")),
    profiles: ensureCanonicalDirectory(profileRoot ?? join(root, "profiles")),
  };
  for (const [name, path] of Object.entries(paths)) {
    // The approved engine profile root may intentionally be outside observer
    // storage; all other entries are private children of the managed root.
    if (name === "profiles" && !isPathContained(root, path)) continue;
    assertManagedPath(root, path);
  }
  return paths;
}

/**
 * Resolve the managed layout lexically and inspect entries without creating
 * directories, loading stores, resolving real paths, or traversing links.
 */
export function inspectPaths(rootPath = defaultObserverRoot(), profileRoot?: string): ObserverPathInspection {
  const root = resolve(rootPath);
  const paths: ObserverManagedPaths = {
    root,
    addons: join(root, "addons"),
    artifacts: join(root, "artifacts"),
    runs: join(root, "runs"),
    exportWork: join(root, "export-work"),
    state: join(root, "state"),
    logs: join(root, "logs"),
    profiles: resolve(profileRoot ?? join(root, "profiles")),
  };
  const entries = Object.fromEntries(
    Object.entries(paths).map(([key, path]) => [key, inspectManagedPath(path)])
  ) as Record<keyof ObserverManagedPaths, ManagedPathInspection>;
  return { readOnly: true, paths, entries };
}

/** Backwards-compatible mutating constructor. */
export function createObserverPaths(rootPath = defaultObserverRoot()): ObserverManagedPaths {
  return ensurePaths(rootPath);
}

export function createTemporaryObserverPaths(prefix = "rfo-test-"): ObserverManagedPaths {
  return createObserverPaths(join(tmpdir(), `${prefix}${randomUUID()}`));
}
