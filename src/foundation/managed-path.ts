import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/**
 * `lexical` is the intentional trust boundary for user-owned project trees:
 * it prevents `..`/prefix escapes but permits links inside the tree.
 * `link-safe` is for private managed state and rejects any existing segment
 * whose canonical target leaves the canonical root. `no-links` is the
 * stricter private-root policy: it rejects every symbolic-link segment even
 * when that link resolves back inside the root.
 */
export type ManagedPathMode = "lexical" | "link-safe" | "no-links";

export type PotentialPathLinkPolicy = "follow-existing" | "no-links";

export interface CanonicalizePotentialPathOptions {
  /** Follow existing links for user-owned paths, or reject every linked segment for private state. */
  linkPolicy: PotentialPathLinkPolicy;
  /** Whether the nearest existing path may be any entry or must be a directory. */
  existingAncestor: "any" | "directory";
  label?: string;
}

export type ManagedPathErrorReason =
  | "root_missing"
  | "root_not_directory"
  | "outside_root"
  | "link_escape"
  | "not_regular_file";

export interface ManagedPathInspection {
  path: string;
  exists: boolean | null;
  symbolicLink: boolean | null;
  kind: "directory" | "file" | "other" | "missing" | "unreadable";
  errorCode?: string;
}

/** Read-only bounded entry inspection; never canonicalizes or creates a path. */
export function inspectManagedPath(path: string): ManagedPathInspection {
  const absolute = resolve(path);
  try {
    const entry = lstatSync(absolute);
    return {
      path: absolute,
      exists: true,
      symbolicLink: entry.isSymbolicLink(),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { path: absolute, exists: false, symbolicLink: false, kind: "missing" };
    return { path: absolute, exists: null, symbolicLink: null, kind: "unreadable", errorCode: typeof code === "string" ? code : "READ_FAILED" };
  }
}

export class ManagedPathError extends Error {
  constructor(
    public readonly reason: ManagedPathErrorReason,
    message: string
  ) {
    super(message);
    this.name = "ManagedPathError";
  }
}

/** Stable absolute spelling for path identity maps and equality checks. */
export function pathComparisonKey(path: string): string {
  const absolute = resolve(path);
  return absolute.toLowerCase();
}

/** Prefix-safe containment; unlike `startsWith`, sibling names cannot collide. */
export function isPathContained(root: string, candidate: string): boolean {
  const rel = relative(pathComparisonKey(root), pathComparisonKey(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function canonicalizeExistingDirectory(directoryPath: string, label = "Directory"): string {
  const absolute = resolve(directoryPath);
  let canonical: string;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    throw new ManagedPathError(
      "root_missing",
      `${label} does not exist or cannot be resolved: ${absolute}`
    );
  }
  if (!statSync(canonical).isDirectory()) {
    throw new ManagedPathError("root_not_directory", `${label} is not a directory: ${canonical}`);
  }
  return canonical;
}

/**
 * Canonicalize the existing prefix of a path without creating its missing tail.
 *
 * This is intentionally separate from managed-root containment: callers use it
 * before a prospective root exists, most commonly to compare configured roots
 * for overlap. The link policy is required so user-owned paths may preserve
 * their established link behavior while private storage can reject all links.
 */
export function canonicalizePotentialPath(
  path: string,
  options: CanonicalizePotentialPathOptions
): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      if (options.linkPolicy === "follow-existing" && options.existingAncestor === "any") {
        return absolute;
      }
      throw new ManagedPathError(
        "root_missing",
        `${options.label ?? "Potential path"} has no resolvable existing ancestor: ${absolute}`
      );
    }
    existing = parent;
  }

  if (options.linkPolicy === "no-links") {
    resolveManagedPath(parse(absolute).root, absolute, "no-links");
  }

  let canonicalExisting: string;
  try {
    canonicalExisting = realpathSync.native(existing);
  } catch {
    throw new ManagedPathError(
      "root_missing",
      `${options.label ?? "Potential path"} ancestor cannot be resolved: ${existing}`
    );
  }
  if (options.existingAncestor === "directory" && !statSync(canonicalExisting).isDirectory()) {
    throw new ManagedPathError(
      "root_not_directory",
      `${options.label ?? "Potential path"} ancestor is not a directory: ${canonicalExisting}`
    );
  }
  return resolve(canonicalExisting, relative(existing, absolute));
}

export function ensureCanonicalDirectory(directoryPath: string, mode = 0o700): string {
  const absolute = resolve(directoryPath);
  mkdirSync(absolute, { recursive: true, mode });
  return canonicalizeExistingDirectory(absolute, "Managed path");
}

function relativeToRootSpelling(
  rootAbsolute: string,
  rootCanonical: string,
  candidateAbsolute: string
): string {
  if (isPathContained(rootAbsolute, candidateAbsolute)) {
    return relative(rootAbsolute, candidateAbsolute);
  }
  if (isPathContained(rootCanonical, candidateAbsolute)) {
    return relative(rootCanonical, candidateAbsolute);
  }
  throw new ManagedPathError(
    "outside_root",
    `Managed path escapes its root: ${candidateAbsolute}`
  );
}

/**
 * Resolve a candidate beneath a root under an explicit trust policy.
 *
 * Link-safe resolution canonicalizes the root, checks every existing segment,
 * and returns a path spelled beneath that canonical root. Non-existing tail
 * segments are allowed so callers can validate a target before creating it.
 */
export function resolveManagedPath(
  rootPath: string,
  candidatePath: string,
  mode: ManagedPathMode
): string {
  const rootAbsolute = resolve(rootPath);
  const candidateAbsolute = resolve(candidatePath);
  if (mode === "lexical") {
    if (!isPathContained(rootAbsolute, candidateAbsolute)) {
      throw new ManagedPathError(
        "outside_root",
        `Managed path escapes its root: ${candidateAbsolute}`
      );
    }
    return candidateAbsolute;
  }

  const rootCanonical = canonicalizeExistingDirectory(rootAbsolute, "Managed root");
  const rel = relativeToRootSpelling(rootAbsolute, rootCanonical, candidateAbsolute);
  let current = rootCanonical;
  const segments = rel.split(sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (mode === "no-links") {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) {
        throw new ManagedPathError(
          "link_escape",
          `Managed path traverses a symbolic link: ${current}`
        );
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw new ManagedPathError(
          "root_not_directory",
          `Managed path traverses a non-directory: ${current}`
        );
      }
      // With every existing segment proven non-link, lexical containment is
      // canonical containment. Avoid realpath on each host ancestor; sandboxed
      // Windows environments may intentionally deny those unrelated lookups.
      continue;
    }
    const canonical = realpathSync.native(current);
    if (!isPathContained(rootCanonical, canonical)) {
      throw new ManagedPathError(
        "link_escape",
        `Managed path traverses a link outside its root: ${current}`
      );
    }
  }
  return resolve(rootCanonical, rel);
}

export function ensureManagedDirectory(
  rootPath: string,
  directoryPath: string,
  mode = 0o700
): string {
  const target = resolveManagedPath(rootPath, directoryPath, "link-safe");
  mkdirSync(target, { recursive: true, mode });
  const canonical = canonicalizeExistingDirectory(target, "Managed directory");
  const root = canonicalizeExistingDirectory(rootPath, "Managed root");
  if (!isPathContained(root, canonical)) {
    throw new ManagedPathError(
      "link_escape",
      `Managed directory resolves outside its root: ${target}`
    );
  }
  return canonical;
}

export function assertRegularManagedFile(rootPath: string, filePath: string): string {
  const candidate = resolveManagedPath(rootPath, filePath, "link-safe");
  const entry = lstatSync(candidate);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ManagedPathError(
      "not_regular_file",
      `Managed path is not a regular file: ${candidate}`
    );
  }
  const canonical = realpathSync.native(candidate);
  const root = canonicalizeExistingDirectory(rootPath, "Managed root");
  if (!isPathContained(root, canonical)) {
    throw new ManagedPathError(
      "link_escape",
      `Managed file resolves outside its root: ${candidate}`
    );
  }
  return canonical;
}
