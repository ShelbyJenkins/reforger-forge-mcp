import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function isPathContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function ensureCanonicalDirectory(directoryPath: string, mode = 0o700): string {
  const absolute = resolve(directoryPath);
  mkdirSync(absolute, { recursive: true, mode });
  const canonical = realpathSync.native(absolute);
  if (!statSync(canonical).isDirectory()) {
    throw new ObserverError("INVALID_REQUEST", `Managed path is not a directory: ${canonical}`);
  }
  return canonical;
}

export function canonicalizeExistingDirectory(directoryPath: string, label = "Directory"): string {
  const absolute = resolve(directoryPath);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    throw new ObserverError("INVALID_REQUEST", `${label} does not exist or cannot be resolved: ${absolute}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new ObserverError("INVALID_REQUEST", `${label} is not a directory: ${canonical}`);
  }
  return canonical;
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
  const root = canonicalizeExistingDirectory(rootPath, "Managed root");
  const candidate = resolve(candidatePath);
  if (!isPathContained(pathKey(root), pathKey(candidate))) {
    throw new ObserverError("INVALID_REQUEST", `Managed path escapes its root: ${candidate}`);
  }

  const rel = relative(root, candidate);
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const canonical = realpathSync.native(current);
    if (!isPathContained(pathKey(root), pathKey(canonical))) {
      throw new ObserverError("INVALID_REQUEST", `Managed path traverses a link outside its root: ${current}`);
    }
  }
  return candidate;
}

export function assertRegularManagedFile(root: string, filePath: string): string {
  const candidate = assertManagedPath(root, filePath);
  const entry = lstatSync(candidate);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ObserverError("INVALID_REQUEST", `Managed path is not a regular file: ${candidate}`);
  }
  const canonical = realpathSync.native(candidate);
  if (!isPathContained(pathKey(realpathSync.native(root)), pathKey(canonical))) {
    throw new ObserverError("INVALID_REQUEST", `Managed file resolves outside its root: ${candidate}`);
  }
  return canonical;
}

export function assertIdentifier(value: string, label = "Identifier"): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ObserverError("INVALID_REQUEST", `${label} is not a valid observer identifier`);
  }
  return value;
}

export function atomicWriteFile(root: string, targetPath: string, data: string | Uint8Array, mode = 0o600): void {
  const target = assertManagedPath(root, targetPath);
  const parent = ensureCanonicalDirectory(dirname(target));
  assertManagedPath(root, parent);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", mode);
    try {
      writeFileSync(descriptor, data);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  } catch (error) {
    // A failed write/close/rename must not leave a fresh UUID temporary behind.
    // Callers that own durable bounded stores also inventory old temporaries so
    // a raced/busy cleanup failure is visible and prevents further allocation.
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // Preserve the operation's primary failure. The exact temporary remains
        // discoverable by the bounded store's next inventory pass.
      }
    }
    throw error;
  }
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

export function createObserverPaths(rootPath = defaultObserverRoot()): ObserverManagedPaths {
  const root = ensureCanonicalDirectory(rootPath);
  const paths = {
    root,
    addons: ensureCanonicalDirectory(join(root, "addons")),
    artifacts: ensureCanonicalDirectory(join(root, "artifacts")),
    runs: ensureCanonicalDirectory(join(root, "runs")),
    exportWork: ensureCanonicalDirectory(join(root, "export-work")),
    state: ensureCanonicalDirectory(join(root, "state")),
    logs: ensureCanonicalDirectory(join(root, "logs")),
    profiles: ensureCanonicalDirectory(join(root, "profiles")),
  };
  for (const path of Object.values(paths)) assertManagedPath(root, path);
  return paths;
}

export function createTemporaryObserverPaths(prefix = "rfo-test-"): ObserverManagedPaths {
  return createObserverPaths(join(tmpdir(), `${prefix}${randomUUID()}`));
}
