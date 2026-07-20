import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalizeExistingDirectory,
  canonicalizePotentialPath,
  ensureCanonicalDirectory,
  ensureManagedDirectory,
  isPathContained,
  pathComparisonKey,
} from "../foundation/managed-path.js";
import {
  revalidateProjectIdentity,
  type CanonicalProjectIdentity,
} from "./project-identity.js";

const BUILD_ROLE_DIRECTORY = "workbench-build";

export interface WorkbenchManagedBuildProfile {
  readonly managedRoot: string;
  readonly roleRoot: string;
  readonly profilePath: string;
  readonly logRoot: string;
}

export class WorkbenchManagedBuildProfileError extends Error {
  constructor(
    message: string,
    public readonly code: "INVALID_CONFIG" | "PATH_OVERLAP"
  ) {
    super(message);
    this.name = "WorkbenchManagedBuildProfileError";
  }
}

function profileError(
  code: "INVALID_CONFIG" | "PATH_OVERLAP",
  message: string
): WorkbenchManagedBuildProfileError {
  return new WorkbenchManagedBuildProfileError(message, code);
}

function canonicalDirectory(path: string, label: string): string {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw profileError("INVALID_CONFIG", `${label} must be a non-empty directory path.`);
  }
  const absolute = resolve(path.trim());
  try {
    return canonicalizeExistingDirectory(absolute, label);
  } catch (error) {
    throw profileError(
      "INVALID_CONFIG",
      `${label} is not an accessible directory: ${absolute} ` +
        `(${error instanceof Error ? error.message : String(error)})`
    );
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
}

/**
 * Create the dedicated target-build profile without staging or referencing the
 * editor helper. The role is deliberately a sibling of `workbench-helper`.
 */
export function ensureWorkbenchManagedBuildProfile(
  managedRootPath: string,
  project: CanonicalProjectIdentity
): Readonly<WorkbenchManagedBuildProfile> {
  if (typeof managedRootPath !== "string" || managedRootPath.trim().length === 0) {
    throw profileError("INVALID_CONFIG", "Workbench managed root must be a non-empty path.");
  }
  const currentProject = revalidateProjectIdentity(project);
  let prospectiveRoot: string;
  try {
    prospectiveRoot = canonicalizePotentialPath(resolve(managedRootPath.trim()), {
      linkPolicy: "follow-existing",
      existingAncestor: "directory",
      label: "Workbench managed root",
    });
  } catch (error) {
    throw profileError(
      "INVALID_CONFIG",
      `Workbench managed root cannot be resolved safely: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (pathsOverlap(currentProject.modDirectory, prospectiveRoot)) {
    throw profileError("PATH_OVERLAP", "Workbench managed root must not overlap the target project.");
  }

  try {
    const managedRoot = ensureCanonicalDirectory(prospectiveRoot);
    const roleRoot = ensureManagedDirectory(
      managedRoot,
      join(managedRoot, BUILD_ROLE_DIRECTORY)
    );
    const profilePath = ensureManagedDirectory(managedRoot, join(roleRoot, "profile"));
    const logRoot = ensureManagedDirectory(managedRoot, join(profilePath, "logs"));
    return Object.freeze({ managedRoot, roleRoot, profilePath, logRoot });
  } catch (error) {
    throw profileError(
      "INVALID_CONFIG",
      `Workbench target-build profile could not be prepared: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Re-attest a previously prepared descriptor before it enters a launch plan. */
export function validateWorkbenchManagedBuildProfile(
  profile: WorkbenchManagedBuildProfile,
  project: CanonicalProjectIdentity
): Readonly<WorkbenchManagedBuildProfile> {
  if (!profile || typeof profile !== "object") {
    throw profileError("INVALID_CONFIG", "Target build requires a managed build profile.");
  }
  const managedRoot = canonicalDirectory(profile.managedRoot, "Workbench managed root");
  const roleRoot = canonicalDirectory(profile.roleRoot, "Workbench target-build role root");
  const profilePath = canonicalDirectory(profile.profilePath, "Workbench target-build profile");
  const logRoot = canonicalDirectory(profile.logRoot, "Workbench target-build log root");
  let expectedRole: string;
  let expectedProfile: string;
  let expectedLogs: string;
  try {
    expectedRole = realpathSync.native(join(managedRoot, BUILD_ROLE_DIRECTORY));
    expectedProfile = realpathSync.native(join(expectedRole, "profile"));
    expectedLogs = realpathSync.native(join(expectedProfile, "logs"));
  } catch (error) {
    throw profileError(
      "INVALID_CONFIG",
      `Target-build profile role is incomplete: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (pathComparisonKey(roleRoot) !== pathComparisonKey(expectedRole) ||
      pathComparisonKey(profilePath) !== pathComparisonKey(expectedProfile) ||
      pathComparisonKey(logRoot) !== pathComparisonKey(expectedLogs) ||
      !isPathContained(managedRoot, logRoot)) {
    throw profileError(
      "INVALID_CONFIG",
      "Target-build profile paths do not match the dedicated managed role."
    );
  }
  if (pathsOverlap(project.modDirectory, managedRoot)) {
    throw profileError("PATH_OVERLAP", "Workbench managed root must not overlap the target project.");
  }
  return Object.freeze({ managedRoot, roleRoot, profilePath, logRoot });
}
