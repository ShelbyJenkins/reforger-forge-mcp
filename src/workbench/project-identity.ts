import { realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { canonicalPathComparisonKey } from "../foundation/managed-path.js";

const GPROJ_EXTENSION = ".gproj";

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
  /** Exact native-realpath comparison form, including case-sensitive Windows identity. */
  readonly comparisonKey: string;
  /** Native-realpath form of the directory containing the project file. */
  readonly modDirectory: string;
  /** Stable comparison form of the containing mod directory. */
  readonly modDirectoryKey: string;
}

export interface ResolveProjectIdentityOptions {
  /** Explicit caller target. When present, no fallback is attempted. */
  readonly gprojPath?: string | null;
  /** Previously verified lifecycle target. */
  readonly priorTarget?: CanonicalProjectIdentity | string | null;
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
    comparisonKey: canonicalPathComparisonKey(displayPath),
    modDirectory,
    modDirectoryKey: canonicalPathComparisonKey(modDirectory),
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

/**
 * Resolve a lifecycle target from an exact path or a previously verified
 * lifecycle target. Add-on search roots are never target selectors.
 *
 * Order: explicit target, then prior verified lifecycle target.
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

  throw targetRequired();
}
