import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const GPROJ_EXTENSION = ".gproj";
const LEGACY_STANDALONE_DIRECTORY = "EnfusionMCP";
const LEGACY_STANDALONE_PROJECT = "EnfusionMCP.gproj";

export type ProjectIdentityErrorCode =
  | "TARGET_REQUIRED"
  | "AMBIGUOUS_TARGET"
  | "INVALID_TARGET"
  | "TARGET_CHANGED";

/**
 * A project-identity failure that lifecycle code can map to its public error
 * contract without parsing prose.
 */
export class ProjectIdentityError extends Error {
  readonly candidates: readonly string[];

  constructor(
    public readonly code: ProjectIdentityErrorCode,
    message: string,
    candidates: readonly string[] = []
  ) {
    super(message);
    this.name = "ProjectIdentityError";
    this.candidates = Object.freeze([...candidates]);
  }
}

/** Canonical identity of the exact project file and its containing mod. */
export interface CanonicalProjectIdentity {
  /** Native-realpath form used in user-facing responses and process arguments. */
  readonly displayPath: string;
  /** Stable comparison form. Windows paths are compared case-insensitively. */
  readonly comparisonKey: string;
  /** Native-realpath form of the directory containing the project file. */
  readonly modDirectory: string;
  /** Stable comparison form of the containing mod directory. */
  readonly modDirectoryKey: string;
}

export interface ResolveProjectIdentityOptions {
  /** Explicit caller target. When present, no fallback is attempted. */
  readonly gprojPath?: string | null;
  /** Previously verified lifecycle target, preferred over configured fallback. */
  readonly priorTarget?: CanonicalProjectIdentity | string | null;
  /** Configured addons/project root used for implicit target resolution. */
  readonly projectRoot?: string | null;
  /** Configured direct child folder name preferred within projectRoot. */
  readonly defaultMod?: string | null;
}

function comparisonKey(path: string): string {
  return path.toLowerCase();
}

function invalidTarget(message: string): ProjectIdentityError {
  return new ProjectIdentityError("INVALID_TARGET", message);
}

function targetRequired(): ProjectIdentityError {
  return new ProjectIdentityError(
    "TARGET_REQUIRED",
    "No unique Workbench project target could be resolved. Provide an explicit gprojPath."
  );
}

function stablePathSort(left: CanonicalProjectIdentity, right: CanonicalProjectIdentity): number {
  if (left.comparisonKey < right.comparisonKey) return -1;
  if (left.comparisonKey > right.comparisonKey) return 1;
  if (left.displayPath < right.displayPath) return -1;
  if (left.displayPath > right.displayPath) return 1;
  return 0;
}

/**
 * Resolve and validate one exact .gproj file.
 *
 * The returned display path is already absolute and link-resolved, so callers
 * must use it rather than the untrusted spelling supplied by the caller.
 */
export function canonicalizeGproj(gprojPath: string): CanonicalProjectIdentity {
  if (typeof gprojPath !== "string" || gprojPath.trim().length === 0) {
    throw new ProjectIdentityError(
      "TARGET_REQUIRED",
      "Workbench project target must be a nonempty .gproj path."
    );
  }

  const requestedPath = resolve(gprojPath.trim());
  let displayPath: string;
  try {
    displayPath = realpathSync.native(requestedPath);
  } catch {
    throw invalidTarget(`Workbench project target does not exist or cannot be resolved: ${requestedPath}`);
  }

  let projectStat;
  try {
    projectStat = statSync(displayPath);
  } catch {
    throw invalidTarget(`Workbench project target cannot be inspected: ${displayPath}`);
  }
  if (!projectStat.isFile()) {
    throw invalidTarget(`Workbench project target is not a regular file: ${displayPath}`);
  }
  if (extname(displayPath).toLowerCase() !== GPROJ_EXTENSION) {
    throw invalidTarget(`Workbench project target must have a .gproj extension: ${displayPath}`);
  }

  let modDirectory: string;
  try {
    modDirectory = realpathSync.native(dirname(displayPath));
  } catch {
    throw invalidTarget(`Workbench project directory cannot be resolved: ${dirname(displayPath)}`);
  }

  return {
    displayPath,
    comparisonKey: comparisonKey(displayPath),
    modDirectory,
    modDirectoryKey: comparisonKey(modDirectory),
  };
}

/**
 * Re-resolve an earlier identity immediately before lifecycle mutation.
 * A link retarget or other canonical-path change is refused instead of silently
 * switching the operation to a different project.
 */
export function revalidateProjectIdentity(
  expected: CanonicalProjectIdentity
): CanonicalProjectIdentity {
  const current = canonicalizeGproj(expected.displayPath);
  if (
    current.comparisonKey !== expected.comparisonKey ||
    current.modDirectoryKey !== expected.modDirectoryKey
  ) {
    throw new ProjectIdentityError(
      "TARGET_CHANGED",
      `Workbench project target changed during lifecycle preflight: ` +
        `${expected.displayPath} resolved to ${current.displayPath}`
    );
  }
  return current;
}

/** True when both values identify the same canonical project file. */
export function sameProjectIdentity(
  left: CanonicalProjectIdentity,
  right: CanonicalProjectIdentity
): boolean {
  return left.comparisonKey === right.comparisonKey;
}

function canonicalizeDirectory(directoryPath: string, label: string): string {
  const absolutePath = resolve(directoryPath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(absolutePath);
  } catch {
    throw invalidTarget(`${label} does not exist or cannot be resolved: ${absolutePath}`);
  }

  try {
    if (!statSync(canonicalPath).isDirectory()) {
      throw invalidTarget(`${label} is not a directory: ${canonicalPath}`);
    }
  } catch (error) {
    if (error instanceof ProjectIdentityError) throw error;
    throw invalidTarget(`${label} cannot be inspected: ${canonicalPath}`);
  }
  return canonicalPath;
}

function isLegacyStandaloneCandidate(candidatePath: string, projectRoot: string): boolean {
  const expected = join(
    projectRoot,
    LEGACY_STANDALONE_DIRECTORY,
    LEGACY_STANDALONE_PROJECT
  );
  return comparisonKey(resolve(candidatePath)) === comparisonKey(resolve(expected));
}

function deduplicateCandidates(
  candidates: readonly CanonicalProjectIdentity[]
): CanonicalProjectIdentity[] {
  const byKey = new Map<string, CanonicalProjectIdentity>();
  for (const candidate of candidates) {
    if (!byKey.has(candidate.comparisonKey)) byKey.set(candidate.comparisonKey, candidate);
  }
  return [...byKey.values()].sort(stablePathSort);
}

function listDirectProjects(
  directoryPath: string,
  projectRoot: string
): CanonicalProjectIdentity[] {
  let entries;
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    throw invalidTarget(`Cannot inspect Workbench project directory: ${directoryPath}`);
  }

  const candidates: CanonicalProjectIdentity[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (extname(entry.name).toLowerCase() !== GPROJ_EXTENSION) continue;
    const candidatePath = join(directoryPath, entry.name);
    if (isLegacyStandaloneCandidate(candidatePath, projectRoot)) continue;
    candidates.push(canonicalizeGproj(candidatePath));
  }
  return deduplicateCandidates(candidates);
}

function tryResolveDefaultDirectory(projectRoot: string, defaultMod: string): string | null {
  const trimmed = defaultMod.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    basename(trimmed) !== trimmed
  ) {
    throw invalidTarget(`Configured defaultMod must name one direct project folder: ${defaultMod}`);
  }

  const lexicalPath = join(projectRoot, trimmed);
  try {
    const canonicalPath = realpathSync.native(lexicalPath);
    return statSync(canonicalPath).isDirectory() ? canonicalPath : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw invalidTarget(`Configured defaultMod directory cannot be inspected: ${lexicalPath}`);
  }
}

function listProjectRootCandidates(projectRoot: string): CanonicalProjectIdentity[] {
  const candidates = listDirectProjects(projectRoot, projectRoot);
  let entries;
  try {
    entries = readdirSync(projectRoot, { withFileTypes: true });
  } catch {
    throw invalidTarget(`Cannot inspect Workbench project root: ${projectRoot}`);
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const lexicalChild = join(projectRoot, entry.name);
    if (
      comparisonKey(lexicalChild) ===
      comparisonKey(join(projectRoot, LEGACY_STANDALONE_DIRECTORY))
    ) {
      continue;
    }

    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(lexicalChild).isDirectory();
      } catch {
        throw invalidTarget(`Workbench project child cannot be inspected: ${lexicalChild}`);
      }
    }
    if (!isDirectory) continue;

    const canonicalChild = canonicalizeDirectory(lexicalChild, "Workbench project child");
    candidates.push(...listDirectProjects(canonicalChild, projectRoot));
  }

  return deduplicateCandidates(candidates);
}

function ambiguousTarget(candidates: readonly CanonicalProjectIdentity[]): ProjectIdentityError {
  const displayPaths = candidates.map((candidate) => candidate.displayPath);
  return new ProjectIdentityError(
    "AMBIGUOUS_TARGET",
    "Multiple Workbench project targets are available. Provide an explicit gprojPath:\n" +
      displayPaths.map((path) => `  - ${path}`).join("\n"),
    displayPaths
  );
}

/**
 * Resolve a lifecycle target without ever choosing an arbitrary first project.
 *
 * Order: explicit target, prior verified lifecycle target, unique configured
 * default, then one unique candidate in the project root or its direct child
 * directories. The legacy standalone EnfusionMCP addon is never a fallback.
 */
export function resolveProjectIdentity(
  options: ResolveProjectIdentityOptions
): CanonicalProjectIdentity {
  if (options.gprojPath !== undefined && options.gprojPath !== null) {
    return canonicalizeGproj(options.gprojPath);
  }

  if (options.priorTarget !== undefined && options.priorTarget !== null) {
    return typeof options.priorTarget === "string"
      ? canonicalizeGproj(options.priorTarget)
      : revalidateProjectIdentity(options.priorTarget);
  }

  const rootInput = options.projectRoot?.trim();
  if (!rootInput) throw targetRequired();
  const projectRoot = canonicalizeDirectory(rootInput, "Workbench project root");

  const defaultMod = options.defaultMod?.trim();
  if (defaultMod) {
    const defaultDirectory = tryResolveDefaultDirectory(projectRoot, defaultMod);
    if (defaultDirectory) {
      const defaultCandidates = listDirectProjects(defaultDirectory, projectRoot);
      if (defaultCandidates.length === 1) return defaultCandidates[0];
    }
  }

  const candidates = listProjectRootCandidates(projectRoot);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw ambiguousTarget(candidates);
  throw targetRequired();
}
