import {
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  extname,
  join,
  resolve,
} from "node:path";
import { getProperty, parse } from "../formats/enfusion-text.js";
import { pathComparisonKey } from "../foundation/managed-path.js";

/** Shared Enfusion add-on GUID spelling. Workbench keeps its compatibility
 * audit while the game planner applies the stricter bounded policy. */
export const ADDON_GUID_PATTERN = /^[0-9A-F]{16}$/;

interface AddonProjectDescriptor {
  readonly gprojPath: string;
  readonly guid: string;
  readonly dependencies: readonly string[];
}

interface DiscoveredAddonProject {
  readonly gprojPath: string;
  readonly addonRoots: readonly string[];
}

interface AddonProjectCandidate {
  readonly descriptor: AddonProjectDescriptor;
  readonly addonRoots: readonly string[];
}

export interface WorkbenchAddonDependencyAuditOptions {
  /** Exact target project whose declared dependency graph is audited. */
  readonly targetGprojPath: string;
  /**
   * Effective Workbench add-on containers. Discovery is deliberately bounded
   * to .gproj files directly in each root and directly in one child directory.
   */
  readonly addonRoots: readonly string[];
}

/** One uniquely resolved dependency and the candidate root that supplied it. */
export interface WorkbenchAddonDependencyResolution {
  readonly guid: string;
  readonly addonRoot: string;
}

export interface WorkbenchAddonDependencyPreflightOptions
  extends WorkbenchAddonDependencyAuditOptions {
  /** Optional caller-specific status appended to a dependency refusal. */
  readonly launchStatus?: string;
}

export interface WorkbenchAddonDependencyAudit {
  readonly targetGuid: string;
  /** Every dependency GUID reached while traversing the resolvable graph. */
  readonly requiredGuids: readonly string[];
  /** GUIDs resolved to exactly one canonical .gproj. */
  readonly resolvedGuids: readonly string[];
  /** Candidate roots for the uniquely resolved GUIDs, ordered by GUID. */
  readonly resolvedDependencies: readonly WorkbenchAddonDependencyResolution[];
  /** GUIDs for which no valid .gproj was found. */
  readonly missingGuids: readonly string[];
  /** GUIDs represented by more than one distinct canonical .gproj. */
  readonly ambiguousGuids: readonly string[];
}

export class WorkbenchAddonDependencyAuditError extends Error {
  readonly code = "INVALID_TARGET" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkbenchAddonDependencyAuditError";
  }
}

export type WorkbenchAddonDependencyPreflightErrorCode =
  | "INVALID_TARGET"
  | "INVALID_CONFIG";

/**
 * Neutral dependency-preflight failure that lifecycle and runner entry points
 * can adapt to their own public error types without duplicating policy text.
 */
export class WorkbenchAddonDependencyPreflightError extends Error {
  constructor(
    message: string,
    readonly code: WorkbenchAddonDependencyPreflightErrorCode,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkbenchAddonDependencyPreflightError";
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function immutableSorted(values: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...values].sort(compareStrings));
}

function normalizeDependencies(values: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values) {
    const guid = value.toUpperCase();
    if (ADDON_GUID_PATTERN.test(guid)) normalized.add(guid);
  }
  return Object.freeze([...normalized]);
}

function readDescriptor(gprojPath: string): AddonProjectDescriptor | null {
  try {
    const canonical = realpathSync.native(resolve(gprojPath));
    if (extname(canonical).toLowerCase() !== ".gproj" ||
        !statSync(canonical).isFile()) {
      return null;
    }
    const document = parse(readFileSync(canonical, "utf8"));
    if (document.type !== "GameProject") return null;
    const guidValue = getProperty(document, "GUID");
    const guid = typeof guidValue === "string" ? guidValue.toUpperCase() : "";
    if (!ADDON_GUID_PATTERN.test(guid)) return null;
    const dependencies = document.children
      .filter((child) => child.type === "Dependencies")
      .flatMap((child) => child.values);
    return Object.freeze({
      gprojPath: canonical,
      guid,
      dependencies: normalizeDependencies(dependencies),
    });
  } catch {
    return null;
  }
}

function readTargetDescriptor(gprojPath: string): AddonProjectDescriptor {
  if (typeof gprojPath !== "string" || gprojPath.trim().length === 0) {
    throw new WorkbenchAddonDependencyAuditError(
      "Workbench dependency audit requires one exact non-empty target .gproj."
    );
  }
  const descriptor = readDescriptor(gprojPath.trim());
  if (!descriptor) {
    throw new WorkbenchAddonDependencyAuditError(
      "Workbench dependency audit could not parse a regular GameProject .gproj with a valid GUID."
    );
  }
  return descriptor;
}

function directGprojFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() && extname(entry.name).toLowerCase() === ".gproj"
      )
      .map((entry) => join(directory, entry.name))
      .sort(compareStrings);
  } catch {
    return [];
  }
}

function canonicalAddonRoots(addonRoots: readonly string[]): string[] {
  const roots = new Map<string, string>();
  for (const root of addonRoots) {
    if (typeof root !== "string" || root.trim().length === 0) continue;
    try {
      const canonical = realpathSync.native(resolve(root.trim()));
      if (!statSync(canonical).isDirectory()) continue;
      roots.set(pathComparisonKey(canonical), canonical);
    } catch {
      // The caller's configuration validator owns root diagnostics. An
      // unavailable root simply cannot contribute dependency evidence here.
    }
  }
  return [...roots.values()].sort((left, right) => {
    const keyOrder = compareStrings(pathComparisonKey(left), pathComparisonKey(right));
    return keyOrder === 0 ? compareStrings(left, right) : keyOrder;
  });
}

/**
 * Discover candidate project manifests without recursively walking an
 * arbitrary configured tree. Workbench add-on containers conventionally hold
 * either a direct .gproj or one add-on directory containing that .gproj.
 */
function discoverCandidateGprojFiles(
  addonRoots: readonly string[]
): readonly DiscoveredAddonProject[] {
  const candidates = new Map<string, {
    gprojPath: string;
    addonRoots: string[];
  }>();
  const addCandidate = (path: string, addonRoot: string): void => {
    try {
      const descriptorPath = realpathSync.native(path);
      if (!statSync(descriptorPath).isFile()) return;
      const key = pathComparisonKey(descriptorPath);
      const existing = candidates.get(key);
      if (!existing) {
        candidates.set(key, {
          gprojPath: descriptorPath,
          addonRoots: [addonRoot],
        });
        return;
      }
      if (!existing.addonRoots.some((root) =>
        pathComparisonKey(root) === pathComparisonKey(addonRoot)
      )) {
        existing.addonRoots.push(addonRoot);
        existing.addonRoots.sort((left, right) => {
          const keyOrder = compareStrings(pathComparisonKey(left), pathComparisonKey(right));
          return keyOrder === 0 ? compareStrings(left, right) : keyOrder;
        });
      }
    } catch {
      // Workshop content can be replaced concurrently. A candidate that
      // disappears during this bounded scan contributes no resolution
      // evidence and will therefore surface as missing when required.
    }
  };
  for (const root of canonicalAddonRoots(addonRoots)) {
    for (const path of directGprojFiles(root)) {
      addCandidate(path, root);
    }

    let children: string[];
    try {
      children = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name))
        .sort(compareStrings);
    } catch {
      children = [];
    }
    for (const child of children) {
      for (const path of directGprojFiles(child)) {
        addCandidate(path, root);
      }
    }
  }
  return Object.freeze([...candidates.values()]
    .sort((left, right) => {
      const keyOrder = compareStrings(
        pathComparisonKey(left.gprojPath),
        pathComparisonKey(right.gprojPath)
      );
      return keyOrder === 0
        ? compareStrings(left.gprojPath, right.gprojPath)
        : keyOrder;
    })
    .map((candidate) => Object.freeze({
      gprojPath: candidate.gprojPath,
      addonRoots: Object.freeze([...candidate.addonRoots]),
    })));
}

/**
 * Audit one target's direct and transitive declared GUID dependencies against
 * the exact add-on roots that will be passed to Workbench.
 *
 * Unrelated duplicate GUIDs do not fail the audit. A GUID is ambiguous only
 * when the traversed dependency graph actually requires it.
 */
export function auditWorkbenchAddonDependencies(
  options: WorkbenchAddonDependencyAuditOptions
): WorkbenchAddonDependencyAudit {
  if (!options || typeof options !== "object" || !Array.isArray(options.addonRoots)) {
    throw new TypeError("Workbench dependency audit options are invalid.");
  }
  const target = readTargetDescriptor(options.targetGprojPath);
  const descriptorsByGuid = new Map<string, AddonProjectCandidate[]>();
  for (const candidate of discoverCandidateGprojFiles(options.addonRoots)) {
    const descriptor = readDescriptor(candidate.gprojPath);
    if (!descriptor) continue;
    const descriptors = descriptorsByGuid.get(descriptor.guid) ?? [];
    if (!descriptors.some((current) =>
      pathComparisonKey(current.descriptor.gprojPath) ===
        pathComparisonKey(descriptor.gprojPath)
    )) {
      descriptors.push({ descriptor, addonRoots: candidate.addonRoots });
      descriptors.sort((left, right) => {
        const keyOrder = compareStrings(
          pathComparisonKey(left.descriptor.gprojPath),
          pathComparisonKey(right.descriptor.gprojPath)
        );
        return keyOrder === 0
          ? compareStrings(left.descriptor.gprojPath, right.descriptor.gprojPath)
          : keyOrder;
      });
      descriptorsByGuid.set(descriptor.guid, descriptors);
    }
  }

  const required = new Set<string>();
  const resolved = new Set<string>();
  const resolvedDependencies = new Map<string, WorkbenchAddonDependencyResolution>();
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const visited = new Set<string>([target.guid]);
  const pending = [...target.dependencies];
  while (pending.length > 0) {
    const guid = pending.shift()!;
    if (visited.has(guid)) continue;
    visited.add(guid);
    required.add(guid);

    const candidates = descriptorsByGuid.get(guid) ?? [];
    if (candidates.length === 0) {
      missing.add(guid);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.add(guid);
      continue;
    }
    resolved.add(guid);
    resolvedDependencies.set(guid, Object.freeze({
      guid,
      addonRoot: candidates[0].addonRoots[0],
    }));
    pending.push(...candidates[0].descriptor.dependencies);
  }

  return Object.freeze({
    targetGuid: target.guid,
    requiredGuids: immutableSorted(required),
    resolvedGuids: immutableSorted(resolved),
    resolvedDependencies: Object.freeze(
      [...resolvedDependencies.values()].sort((left, right) =>
        compareStrings(left.guid, right.guid)
      )
    ),
    missingGuids: immutableSorted(missing),
    ambiguousGuids: immutableSorted(ambiguous),
  });
}

/**
 * Refuse a Workbench spawn when the effective add-on roots cannot uniquely
 * resolve every direct and transitive dependency of the exact target project.
 */
export function assertWorkbenchAddonDependenciesAvailable(
  options: WorkbenchAddonDependencyPreflightOptions
): void {
  let audit: WorkbenchAddonDependencyAudit;
  try {
    audit = auditWorkbenchAddonDependencies(options);
  } catch (error) {
    if (error instanceof WorkbenchAddonDependencyAuditError) {
      throw new WorkbenchAddonDependencyPreflightError(
        error.message,
        error.code,
        { cause: error }
      );
    }
    throw error;
  }

  if (audit.missingGuids.length === 0 && audit.ambiguousGuids.length === 0) return;

  const findings = [
    audit.missingGuids.length > 0
      ? `Missing dependency GUID(s): ${audit.missingGuids.join(", ")}.`
      : "",
    audit.ambiguousGuids.length > 0
      ? `Ambiguous dependency GUID(s): ${audit.ambiguousGuids.join(", ")}.`
      : "",
  ].filter((finding) => finding.length > 0);
  const recovery = [
    audit.missingGuids.length > 0
      ? "Add the add-on root containing each missing project to workbenchAddonDirs, " +
        "or pass --workbench-addon-dir <directory> once for each required root."
      : "",
    audit.ambiguousGuids.length > 0
      ? "Remove or disable duplicate projects, or configure the add-on roots so exactly " +
        "one .gproj provides each ambiguous GUID."
      : "",
  ].filter((instruction) => instruction.length > 0);
  throw new WorkbenchAddonDependencyPreflightError(
    [
      "Workbench cannot resolve every dependency declared by the target project.",
      ...findings,
      ...recovery,
      options.launchStatus ?? "",
    ].filter((sentence) => sentence.length > 0).join(" "),
    "INVALID_CONFIG"
  );
}
