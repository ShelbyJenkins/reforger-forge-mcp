import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CanonicalProjectIdentity } from "./project-identity.js";

const WORLD_EXTENSION = ".ent";
const PREFAB_EXTENSION = ".et";
const SUPPORTED_TARGET_EXTENSIONS = new Set([WORLD_EXTENSION, PREFAB_EXTENSION]);
const METADATA_SUFFIX = ".meta";

export type ResourceTargetErrorCode =
  | "RESOURCE_REQUIRED"
  | "INVALID_RESOURCE_TARGET"
  | "RESOURCE_OUTSIDE_PROJECT"
  | "RESOURCE_TARGET_CHANGED";

/**
 * A resource-target failure with a stable code for the explicit-save
 * transaction.  Callers must not infer target identity from its message.
 */
export class ResourceTargetError extends Error {
  constructor(
    public readonly code: ResourceTargetErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ResourceTargetError";
  }
}

/**
 * Canonical identity of one explicit World Editor resource and its required
 * sidecar metadata. Target-bound sessions support worlds (.ent) and project
 * prefabs (.et); the latter is needed for a Workbench-authoritative prefab
 * save rather than a generic "current document" save.
 * Every path is native-realpath form, never the caller's spelling.
 */
export interface CanonicalResourceTarget {
  readonly displayPath: string;
  readonly comparisonKey: string;
  readonly metaPath: string;
  readonly metaComparisonKey: string;
  readonly project: CanonicalProjectIdentity;
}

function comparisonKey(path: string): string {
  return path.toLowerCase();
}

function invalidResource(message: string): ResourceTargetError {
  return new ResourceTargetError("INVALID_RESOURCE_TARGET", message);
}

function changedResource(message: string): ResourceTargetError {
  return new ResourceTargetError("RESOURCE_TARGET_CHANGED", message);
}

function isContainedBy(path: string, directory: string): boolean {
  const child = relative(directory, path);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function resolveRegularFile(requestedPath: string, label: string, baseDirectory?: string): string {
  const absolutePath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(baseDirectory ?? ".", requestedPath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(absolutePath);
  } catch {
    throw invalidResource(`${label} does not exist or cannot be resolved: ${absolutePath}`);
  }

  try {
    if (!statSync(canonicalPath).isFile()) {
      throw invalidResource(`${label} is not a regular file: ${canonicalPath}`);
    }
  } catch (error) {
    if (error instanceof ResourceTargetError) throw error;
    throw invalidResource(`${label} cannot be inspected: ${canonicalPath}`);
  }
  return canonicalPath;
}

function resolveCanonicalResourceTarget(
  resourcePath: string,
  project: CanonicalProjectIdentity
): CanonicalResourceTarget {
  // Target-bound launch paths are project-relative. Resolving them from the
  // MCP host's working directory made a valid target in a non-default project
  // appear to be missing beneath the repository root.
  const displayPath = resolveRegularFile(
    resourcePath,
    "Workbench resource target",
    project.modDirectory
  );
  const extension = extname(displayPath).toLowerCase();
  if (!SUPPORTED_TARGET_EXTENSIONS.has(extension)) {
    throw invalidResource(
      `Workbench resource target must have a .ent or .et extension: ${displayPath}`
    );
  }
  if (!isContainedBy(displayPath, project.modDirectory)) {
    throw new ResourceTargetError(
      "RESOURCE_OUTSIDE_PROJECT",
      `Workbench resource target must be inside the selected project directory: ${displayPath}`
    );
  }

  const metaPath = resolveRegularFile(`${displayPath}${METADATA_SUFFIX}`, "Workbench resource metadata");
  if (!isContainedBy(metaPath, project.modDirectory)) {
    throw new ResourceTargetError(
      "RESOURCE_OUTSIDE_PROJECT",
      `Workbench resource metadata must be inside the selected project directory: ${metaPath}`
    );
  }

  return {
    displayPath,
    comparisonKey: comparisonKey(displayPath),
    metaPath,
    metaComparisonKey: comparisonKey(metaPath),
    project,
  };
}

/**
 * Resolve one explicit, existing editable Workbench resource. The resource and its
 * `<resource>.meta` sidecar must both be regular files below the canonical
 * directory of the already-selected project.
 */
export function canonicalizeResourceTarget(
  resourcePath: string,
  project: CanonicalProjectIdentity
): CanonicalResourceTarget {
  if (typeof resourcePath !== "string" || resourcePath.trim().length === 0) {
    throw new ResourceTargetError(
      "RESOURCE_REQUIRED",
      "Workbench resource target must be a nonempty .ent or .et path."
    );
  }
  return resolveCanonicalResourceTarget(resourcePath.trim(), project);
}

/**
 * Re-resolve an earlier explicit target immediately before a native save.
 * Any canonical resource or sidecar path change is refused instead of writing
 * through a link that was retargeted after preflight.
 */
export function revalidateResourceTarget(
  expected: CanonicalResourceTarget,
  project: CanonicalProjectIdentity = expected.project
): CanonicalResourceTarget {
  let current: CanonicalResourceTarget;
  try {
    current = canonicalizeResourceTarget(expected.displayPath, project);
  } catch (error) {
    if (error instanceof ResourceTargetError) {
      throw changedResource(
        `Workbench entity resource target changed during save preflight: ${expected.displayPath} (${error.message})`
      );
    }
    throw error;
  }

  if (
    current.comparisonKey !== expected.comparisonKey ||
    current.metaComparisonKey !== expected.metaComparisonKey ||
    current.project.comparisonKey !== expected.project.comparisonKey ||
    current.project.modDirectoryKey !== expected.project.modDirectoryKey
  ) {
    throw changedResource(
      `Workbench entity resource target changed during save preflight: ${expected.displayPath} resolved to ${current.displayPath}`
    );
  }
  return current;
}
