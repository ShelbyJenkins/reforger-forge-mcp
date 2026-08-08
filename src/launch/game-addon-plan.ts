import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { BigIntStats, Dirent } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { getProperty, parse } from "../formats/enfusion-text.js";
import { sha256Hex } from "../foundation/digest.js";
import {
  sameUsableFileIdentity,
  type BigIntFileIdentity,
} from "../foundation/file-identity.js";
import {
  canonicalPathComparisonKey,
  canonicalizePotentialPath,
  isPathContained,
} from "../foundation/managed-path.js";
import {
  readWindowsFileThroughVerifiedHandle,
  WindowsSameHandleFileError,
  type WindowsSameHandleFileRead,
} from "../platform/windows/same-handle-file.js";
import {
  ADDON_GUID_PATTERN,
} from "../workbench/addon-dependencies.js";
import type { CanonicalProjectIdentity } from "../workbench/project-identity.js";
import { revalidateProjectIdentity } from "../workbench/project-identity.js";
import { GameLaunchPlanError, type GameLaunchPlanErrorCode } from "./game-launch-errors.js";

export const GAME_ADDON_EVIDENCE_SCHEMA_VERSION = 2;
export const GAME_ADDON_MANIFEST_MAXIMUM_BYTES = 4 * 1024 * 1024;

export interface GameAddonScanLimits {
  readonly maximumRoots: number;
  readonly maximumVisitedEntries: number;
  readonly maximumCandidates: number;
  readonly maximumManifestBytes: number;
  readonly maximumTotalManifestBytes: number;
}

export const DEFAULT_GAME_ADDON_SCAN_LIMITS: GameAddonScanLimits = Object.freeze({
  maximumRoots: 128,
  maximumVisitedEntries: 20_000,
  maximumCandidates: 2_048,
  maximumManifestBytes: GAME_ADDON_MANIFEST_MAXIMUM_BYTES,
  maximumTotalManifestBytes: 64 * 1024 * 1024,
});

export type GameAddonRootProvenance =
  | "configured"
  | "target_parent"
  | "installation_addons"
  | "profile_addons"
  | "dependency_container";

export interface GameAddonFileIdentity {
  readonly byteLength: number;
  readonly device: string;
  readonly inode: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
  readonly birthNanoseconds: string;
}

export interface GameAddonManifestEvidence extends GameAddonFileIdentity {
  /** Complete FILE_ID_INFO volume identity; on non-Windows this equals device. */
  readonly volumeIdentity: string;
  /** Complete unsigned FILE_ID_INFO identifier; on non-Windows this equals inode. */
  readonly fileId: string;
  readonly gprojPath: string;
  readonly comparisonKey: string;
  readonly guid: string;
  readonly dependencies: readonly string[];
  readonly providerRoots: readonly string[];
  readonly sha256: string;
}

export interface GameAddonDirectoryEvidence extends GameAddonFileIdentity {
  readonly path: string;
  readonly listingDigest: string;
}

export interface GameAddonRootEvidence {
  readonly path: string;
  readonly comparisonKey: string;
  readonly provenance: readonly GameAddonRootProvenance[];
  readonly prospectiveImplicit: boolean;
  readonly exists: boolean;
  readonly emitted: boolean;
  readonly visitedEntries: number;
  readonly verificationEntries: number;
  readonly candidateCount: number;
  readonly directories: readonly GameAddonDirectoryEvidence[];
}

export interface GameAddonDependencyResolution {
  readonly guid: string;
  readonly gprojPath: string;
  readonly addonRoot: string;
  readonly dependencies: readonly string[];
}

export type GameAddonFinding =
  | { readonly kind: "malformed_declared_guid"; readonly manifestPath: string; readonly dependencyIndex: number }
  | { readonly kind: "manifest_unreadable"; readonly manifestPath: string }
  | { readonly kind: "manifest_malformed"; readonly manifestPath: string }
  | { readonly kind: "manifest_oversize"; readonly manifestPath: string; readonly maximumBytes: number }
  | { readonly kind: "root_unreadable"; readonly rootPath: string; readonly provenance: GameAddonRootProvenance }
  | { readonly kind: "root_conflict"; readonly rootPath: string; readonly privateRoot: string }
  | { readonly kind: "scan_truncated"; readonly limit: keyof GameAddonScanLimits; readonly maximum: number }
  | { readonly kind: "scan_unstable"; readonly path: string }
  | { readonly kind: "dependency_missing"; readonly guid: string }
  | { readonly kind: "dependency_ambiguous"; readonly guid: string; readonly providerCount: number }
  | { readonly kind: "target_provider_collision"; readonly guid: string; readonly providerCount: number };

export interface GameAddonPlanSnapshot {
  readonly schemaVersion: typeof GAME_ADDON_EVIDENCE_SCHEMA_VERSION;
  readonly project: CanonicalProjectIdentity;
  readonly executablePath: string;
  readonly profilePath: string;
  readonly managedRoot: string;
  readonly profileRoot: string;
  readonly configuredAddonRoots: readonly string[];
  readonly limits: GameAddonScanLimits;
  readonly targetGuid: string;
  /** The only GUID initially selected through `-addons`. */
  readonly addonGuids: readonly [string];
  readonly dependencyGuids: readonly string[];
  readonly resolvedDependencies: readonly GameAddonDependencyResolution[];
  readonly emittedAddonRoots: readonly string[];
  readonly implicitAddonRoots: readonly string[];
  readonly roots: readonly GameAddonRootEvidence[];
  readonly manifests: readonly GameAddonManifestEvidence[];
  readonly targetProviderPaths: readonly string[];
  readonly visitedEntries: number;
  readonly verificationEntries: number;
  readonly candidateCount: number;
  readonly totalManifestBytes: number;
  readonly addonEvidenceDigest: string;
}

export interface ResolveGameAddonPlanOptions {
  readonly project: CanonicalProjectIdentity;
  readonly configuredAddonRoots?: readonly string[];
  readonly executablePath: string;
  readonly profilePath: string;
  readonly managedRoot: string;
  readonly profileRoot: string;
  readonly scanLimits?: Partial<GameAddonScanLimits>;
  /** @internal Deterministic test seam; production composition never supplies it. */
  readonly testHooks?: GameAddonPlanTestHooks;
}

export type GameAddonPlanTestCheckpoint =
  | "after_directory_read"
  | "before_candidate_stat"
  | "before_manifest_open";

/** @internal Fault-injection checkpoints used to prove race refusals deterministically. */
export interface GameAddonPlanTestHooks {
  readonly checkpoint?: (checkpoint: GameAddonPlanTestCheckpoint, path: string) => void;
  readonly fileIdentity?: (
    path: string,
    identity: Readonly<BigIntFileIdentity>,
  ) => BigIntFileIdentity;
}

interface RootSeed {
  path: string;
  provenance: GameAddonRootProvenance[];
  prospectiveImplicit: boolean;
  required: boolean;
}

interface RootScan {
  seed: RootSeed;
  evidence: Omit<GameAddonRootEvidence, "emitted" | "provenance">;
  candidates: string[];
}

interface ManifestRead extends GameAddonManifestEvidence {
  providerRoots: string[];
}

interface ScanCounters {
  visitedEntries: number;
  verificationEntries: number;
  candidateCount: number;
  totalManifestBytes: number;
}

const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_OR_COMMA = /[,\0-\x1f\x7f]/u;

const FINDING_CODES: Record<GameAddonFinding["kind"], GameLaunchPlanErrorCode> = {
  malformed_declared_guid: "ADDON_DEPENDENCY_MALFORMED",
  manifest_unreadable: "ADDON_MANIFEST_UNREADABLE",
  manifest_malformed: "ADDON_MANIFEST_MALFORMED",
  manifest_oversize: "ADDON_MANIFEST_OVERSIZE",
  root_unreadable: "ADDON_ROOT_UNREADABLE",
  root_conflict: "ADDON_ROOT_CONFLICT",
  scan_truncated: "ADDON_SCAN_TRUNCATED",
  scan_unstable: "ADDON_SCAN_UNSTABLE",
  dependency_missing: "ADDON_DEPENDENCY_MISSING",
  dependency_ambiguous: "ADDON_DEPENDENCY_AMBIGUOUS",
  target_provider_collision: "ADDON_TARGET_COLLISION",
};

function safePath(value: string): string {
  return value.slice(0, 512).replace(/[\0\r\n]/g, "?");
}

function findingError(
  finding: GameAddonFinding,
  message: string,
  cause?: unknown,
): GameLaunchPlanError {
  return new GameLaunchPlanError(FINDING_CODES[finding.kind], message, {
    details: { finding },
    cause,
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameUsableFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs;
}

function sameOpenedFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
  path: string,
  testHooks: GameAddonPlanTestHooks | undefined,
): boolean {
  const leftIdentity = testHooks?.fileIdentity?.(path, { dev: left.dev, ino: left.ino }) ?? left;
  const rightIdentity = testHooks?.fileIdentity?.(path, { dev: right.dev, ino: right.ino }) ?? right;
  return sameUsableFileIdentity(leftIdentity, rightIdentity);
}

function identityFrom(value: BigIntStats): GameAddonFileIdentity {
  return {
    byteLength: Number(value.size),
    device: value.dev.toString(),
    inode: value.ino.toString(),
    modifiedNanoseconds: value.mtimeNs.toString(),
    changedNanoseconds: value.ctimeNs.toString(),
    birthNanoseconds: value.birthtimeNs.toString(),
  };
}

function windowsIdentityFrom(
  value: WindowsSameHandleFileRead,
): GameAddonFileIdentity & Pick<GameAddonManifestEvidence, "volumeIdentity" | "fileId"> {
  return {
    byteLength: value.byteLength,
    device: value.device,
    inode: value.inode,
    volumeIdentity: value.volumeIdentity,
    fileId: value.fileId,
    modifiedNanoseconds: value.modifiedNanoseconds,
    changedNanoseconds: value.changedNanoseconds,
    birthNanoseconds: value.birthNanoseconds,
  };
}

function validLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function resolveLimits(overrides: Partial<GameAddonScanLimits> | undefined): GameAddonScanLimits {
  const limits = { ...DEFAULT_GAME_ADDON_SCAN_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!validLimit(value)) {
      throw new TypeError(`Game add-on scan limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
}

function cloneProject(project: CanonicalProjectIdentity): CanonicalProjectIdentity {
  return Object.freeze({
    displayPath: project.displayPath,
    comparisonKey: project.comparisonKey,
    modDirectory: project.modDirectory,
    modDirectoryKey: project.modDirectoryKey,
  });
}

function assertCanonicalProject(project: CanonicalProjectIdentity): CanonicalProjectIdentity {
  try {
    const current = revalidateProjectIdentity(project);
    if (current.displayPath !== project.displayPath ||
        current.comparisonKey !== project.comparisonKey ||
        current.modDirectory !== project.modDirectory ||
        current.modDirectoryKey !== project.modDirectoryKey) {
      throw new GameLaunchPlanError(
        "ADDON_CHANGED",
        "Canonical game project identity changed before add-on resolution.",
      );
    }
    return current;
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw new GameLaunchPlanError(
      "ADDON_CHANGED",
      "Canonical game project could not be revalidated before add-on resolution.",
      { cause: error },
    );
  }
}

function prospectivePrivatePath(path: string, label: string): string {
  try {
    return canonicalizePotentialPath(path, {
      linkPolicy: "no-links",
      existingAncestor: "directory",
      label,
    });
  } catch (error) {
    throw new GameLaunchPlanError(
      "ADDON_ROOT_UNREADABLE",
      `${label} cannot be resolved without traversing links: ${safePath(resolve(path))}`,
      { cause: error },
    );
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
}

function assertNoPrivateOverlap(candidate: string, privateRoots: readonly string[]): void {
  for (const privateRoot of privateRoots) {
    if (!pathsOverlap(candidate, privateRoot)) continue;
    throw findingError(
      {
        kind: "root_conflict",
        rootPath: safePath(candidate),
        privateRoot: safePath(privateRoot),
      },
      `Game add-on root overlaps private observer storage: ${safePath(candidate)}`,
    );
  }
}

function appendRootSeed(
  roots: RootSeed[],
  inputPath: string,
  provenance: GameAddonRootProvenance,
  prospectiveImplicit: boolean,
  required: boolean,
  limits: GameAddonScanLimits,
): void {
  const absolute = resolve(inputPath);
  let canonical = absolute;
  try {
    const info = lstatSync(absolute, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw findingError(
        { kind: "root_unreadable", rootPath: safePath(absolute), provenance },
        `Game add-on root is not a regular non-link directory: ${safePath(absolute)}`,
      );
    }
    canonical = realpathSync.native(absolute);
    if (resolve(canonical) !== absolute) {
      throw findingError(
        { kind: "root_unreadable", rootPath: safePath(absolute), provenance },
        `Game add-on root changes spelling through a link or reparse point: ${safePath(absolute)}`,
      );
    }
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      canonical = prospectivePrivatePath(absolute, "Prospective implicit add-on root");
    } else {
      throw findingError(
        { kind: "root_unreadable", rootPath: safePath(absolute), provenance },
        `Game add-on root cannot be inspected: ${safePath(absolute)}`,
        error,
      );
    }
  }
  const key = canonicalPathComparisonKey(canonical);
  const existing = roots.find((root) => canonicalPathComparisonKey(root.path) === key);
  if (existing) {
    if (!existing.provenance.includes(provenance)) existing.provenance.push(provenance);
    existing.prospectiveImplicit &&= prospectiveImplicit;
    existing.required ||= required;
    return;
  }
  if (roots.length >= limits.maximumRoots) {
    throw findingError(
      { kind: "scan_truncated", limit: "maximumRoots", maximum: limits.maximumRoots },
      `Game add-on planning exceeded its ${limits.maximumRoots}-root limit.`,
    );
  }
  roots.push({ path: canonical, provenance: [provenance], prospectiveImplicit, required });
}

function entryKind(entry: Dirent): string {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "link";
  return "other";
}

function listingDigest(entries: readonly Dirent[]): string {
  return sha256Hex(JSON.stringify(entries.map((entry) => [entry.name, entryKind(entry)])));
}

function incrementEntry(
  counters: ScanCounters,
  field: "visitedEntries" | "verificationEntries",
  limits: GameAddonScanLimits,
): void {
  counters[field] += 1;
  if (counters[field] > limits.maximumVisitedEntries) {
    throw findingError(
      {
        kind: "scan_truncated",
        limit: "maximumVisitedEntries",
        maximum: limits.maximumVisitedEntries,
      },
      `Game add-on scan exceeded its ${limits.maximumVisitedEntries}-entry limit.`,
    );
  }
}

function readDirectory(
  path: string,
  counters: ScanCounters,
  field: "visitedEntries" | "verificationEntries",
  limits: GameAddonScanLimits,
): Dirent[] {
  let directory;
  try {
    directory = opendirSync(path);
  } catch (error) {
    throw findingError(
      { kind: "scan_unstable", path: safePath(path) },
      `Game add-on directory cannot be opened: ${safePath(path)}`,
      error,
    );
  }
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      incrementEntry(counters, field, limits);
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw findingError(
      { kind: "scan_unstable", path: safePath(path) },
      `Game add-on directory changed while it was read: ${safePath(path)}`,
      error,
    );
  } finally {
    try { directory.closeSync(); } catch { /* preserve the primary proof failure */ }
  }
  entries.sort((left, right) => compareStrings(left.name.toLowerCase(), right.name.toLowerCase()) ||
    compareStrings(left.name, right.name));
  return entries;
}

function scanOneDirectory(
  path: string,
  counters: ScanCounters,
  limits: GameAddonScanLimits,
  testHooks?: GameAddonPlanTestHooks,
): { evidence: GameAddonDirectoryEvidence; entries: readonly Dirent[] } {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    throw findingError(
      { kind: "scan_unstable", path: safePath(path) },
      `Game add-on directory cannot be inspected: ${safePath(path)}`,
      error,
    );
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw findingError(
      { kind: "scan_unstable", path: safePath(path) },
      `Game add-on scan refuses a linked or non-directory path: ${safePath(path)}`,
    );
  }
  const entries = readDirectory(path, counters, "visitedEntries", limits);
  testHooks?.checkpoint?.("after_directory_read", path);
  for (const entry of entries) {
    const candidate = join(path, entry.name);
    let current: BigIntStats;
    try {
      current = lstatSync(candidate, { bigint: true });
    } catch (error) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(candidate) },
        `Game add-on entry changed during inspection: ${safePath(candidate)}`,
        error,
      );
    }
    if (entry.isSymbolicLink() || current.isSymbolicLink()) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(candidate) },
        `Game add-on scan refuses a link or reparse entry: ${safePath(candidate)}`,
      );
    }
  }
  const digest = listingDigest(entries);
  const verification = readDirectory(path, counters, "verificationEntries", limits);
  let after: BigIntStats;
  try {
    after = lstatSync(path, { bigint: true });
  } catch (error) {
    throw findingError(
      { kind: "scan_unstable", path: safePath(path) },
      `Game add-on directory disappeared during verification: ${safePath(path)}`,
      error,
    );
  }
  if (!sameIdentity(before, after) || digest !== listingDigest(verification)) {
    throw findingError(
      { kind: "scan_unstable", path: safePath(path) },
      `Game add-on directory changed during inspection: ${safePath(path)}`,
    );
  }
  return {
    evidence: Object.freeze({ ...identityFrom(before), path, listingDigest: digest }),
    entries,
  };
}

function scanRoot(
  seed: RootSeed,
  counters: ScanCounters,
  limits: GameAddonScanLimits,
  testHooks?: GameAddonPlanTestHooks,
): RootScan {
  let rootInfo: BigIntStats;
  try {
    rootInfo = lstatSync(seed.path, { bigint: true });
  } catch (error) {
    if (!seed.required && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        seed,
        evidence: {
          path: seed.path,
          comparisonKey: canonicalPathComparisonKey(seed.path),
          prospectiveImplicit: seed.prospectiveImplicit,
          exists: false,
          visitedEntries: 0,
          verificationEntries: 0,
          candidateCount: 0,
          directories: Object.freeze([]),
        },
        candidates: [],
      };
    }
    throw findingError(
      {
        kind: "root_unreadable",
        rootPath: safePath(seed.path),
        provenance: seed.provenance[0],
      },
      `Game add-on root cannot be inspected: ${safePath(seed.path)}`,
      error,
    );
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw findingError(
      {
        kind: "root_unreadable",
        rootPath: safePath(seed.path),
        provenance: seed.provenance[0],
      },
      `Game add-on root is not a regular non-link directory: ${safePath(seed.path)}`,
    );
  }

  const visitedStart = counters.visitedEntries;
  const verificationStart = counters.verificationEntries;
  const candidateStart = counters.candidateCount;
  const candidates: string[] = [];
  const directories: GameAddonDirectoryEvidence[] = [];
  const root = scanOneDirectory(seed.path, counters, limits, testHooks);
  directories.push(root.evidence);
  for (const entry of root.entries) {
    const child = join(seed.path, entry.name);
    let info: BigIntStats;
    try {
      testHooks?.checkpoint?.("before_candidate_stat", child);
      info = lstatSync(child, { bigint: true });
    } catch (error) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(child) },
        `Game add-on entry changed after directory verification: ${safePath(child)}`,
        error,
      );
    }
    if (info.isFile() && extname(entry.name).toLowerCase() === ".gproj") {
      candidates.push(child);
      counters.candidateCount += 1;
    } else if (info.isDirectory()) {
      const nested = scanOneDirectory(child, counters, limits, testHooks);
      directories.push(nested.evidence);
      for (const nestedEntry of nested.entries) {
        const candidate = join(child, nestedEntry.name);
        let candidateInfo: BigIntStats;
        try {
          testHooks?.checkpoint?.("before_candidate_stat", candidate);
          candidateInfo = lstatSync(candidate, { bigint: true });
        } catch (error) {
          throw findingError(
            { kind: "scan_unstable", path: safePath(candidate) },
            `Game add-on candidate changed after directory verification: ${safePath(candidate)}`,
            error,
          );
        }
        if (candidateInfo.isFile() && extname(nestedEntry.name).toLowerCase() === ".gproj") {
          candidates.push(candidate);
          counters.candidateCount += 1;
        }
      }
    }
    if (counters.candidateCount > limits.maximumCandidates) {
      throw findingError(
        { kind: "scan_truncated", limit: "maximumCandidates", maximum: limits.maximumCandidates },
        `Game add-on scan exceeded its ${limits.maximumCandidates}-candidate limit.`,
      );
    }
  }
  directories.sort((left, right) => compareStrings(
    canonicalPathComparisonKey(left.path),
    canonicalPathComparisonKey(right.path),
  ));
  return {
    seed,
    evidence: {
      path: seed.path,
      comparisonKey: canonicalPathComparisonKey(seed.path),
      prospectiveImplicit: seed.prospectiveImplicit,
      exists: true,
      visitedEntries: counters.visitedEntries - visitedStart,
      verificationEntries: counters.verificationEntries - verificationStart,
      candidateCount: counters.candidateCount - candidateStart,
      directories: Object.freeze(directories),
    },
    candidates,
  };
}

function parsedManifest(
  absolute: string,
  canonical: string,
  providerRoot: string,
  counters: ScanCounters,
  bytes: Buffer,
  identity: GameAddonFileIdentity & Pick<GameAddonManifestEvidence, "volumeIdentity" | "fileId">,
  sha256: string,
): ManifestRead {
  let document;
  try {
    document = parse(bytes.toString("utf8"));
  } catch (error) {
    throw findingError(
      { kind: "manifest_malformed", manifestPath: safePath(absolute) },
      `Game add-on manifest is malformed: ${safePath(absolute)}`,
      error,
    );
  }
  const guidValue = getProperty(document, "GUID");
  const guid = typeof guidValue === "string" ? guidValue.toUpperCase() : "";
  if (document.type !== "GameProject" || !ADDON_GUID_PATTERN.test(guid)) {
    throw findingError(
      { kind: "manifest_malformed", manifestPath: safePath(absolute) },
      `Game add-on manifest is not a GameProject with a valid GUID: ${safePath(absolute)}`,
    );
  }
  const rawDependencies = document.children
    .filter((child) => child.type === "Dependencies")
    .flatMap((child) => child.values);
  const dependencies = new Set<string>();
  for (const [index, value] of rawDependencies.entries()) {
    const normalized = value.toUpperCase();
    if (!ADDON_GUID_PATTERN.test(normalized)) {
      throw findingError(
        {
          kind: "malformed_declared_guid",
          manifestPath: safePath(absolute),
          dependencyIndex: index,
        },
        `Game add-on manifest declares a malformed dependency GUID: ${safePath(absolute)}`,
      );
    }
    dependencies.add(normalized);
  }
  counters.totalManifestBytes += bytes.length;
  return {
    ...identity,
    gprojPath: canonical,
    comparisonKey: canonicalPathComparisonKey(canonical),
    guid,
    dependencies: Object.freeze([...dependencies].sort(compareStrings)),
    providerRoots: [providerRoot],
    sha256,
  };
}

function assertManifestAggregateLimit(
  counters: ScanCounters,
  limits: GameAddonScanLimits,
  byteLength: number,
): void {
  if (counters.totalManifestBytes + byteLength <= limits.maximumTotalManifestBytes) return;
  throw findingError(
    {
      kind: "scan_truncated",
      limit: "maximumTotalManifestBytes",
      maximum: limits.maximumTotalManifestBytes,
    },
    `Game add-on manifests exceed their ${limits.maximumTotalManifestBytes}-byte aggregate limit.`,
  );
}

function readManifest(
  requestedPath: string,
  providerRoot: string,
  counters: ScanCounters,
  limits: GameAddonScanLimits,
  testHooks?: GameAddonPlanTestHooks,
): ManifestRead {
  const absolute = resolve(requestedPath);
  let initial: BigIntStats;
  try {
    initial = lstatSync(absolute, { bigint: true });
  } catch (error) {
    throw findingError(
      { kind: "manifest_unreadable", manifestPath: safePath(absolute) },
      `Game add-on manifest cannot be inspected: ${safePath(absolute)}`,
      error,
    );
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw findingError(
      { kind: "manifest_unreadable", manifestPath: safePath(absolute) },
      `Game add-on manifest is not a regular non-link file: ${safePath(absolute)}`,
    );
  }
  if (initial.size > BigInt(limits.maximumManifestBytes)) {
    throw findingError(
      {
        kind: "manifest_oversize",
        manifestPath: safePath(absolute),
        maximumBytes: limits.maximumManifestBytes,
      },
      `Game add-on manifest exceeds its ${limits.maximumManifestBytes}-byte limit: ${safePath(absolute)}`,
    );
  }
  assertManifestAggregateLimit(counters, limits, Number(initial.size));

  let descriptor: number | undefined;
  try {
    testHooks?.checkpoint?.("before_manifest_open", absolute);
    if (process.platform === "win32") {
      const expectedPathIdentity = testHooks?.fileIdentity?.(
        absolute,
        { dev: initial.dev, ino: initial.ino },
      ) ?? initial;
      let read: WindowsSameHandleFileRead;
      try {
        read = readWindowsFileThroughVerifiedHandle({
          path: absolute,
          maximumBytes: limits.maximumManifestBytes,
          includeBytes: true,
          expectedPathIdentity,
          expectedByteLength: Number(initial.size),
          expectedModifiedNanoseconds: initial.mtimeNs.toString(),
          expectedChangedNanoseconds: initial.ctimeNs.toString(),
          expectedBirthNanoseconds: initial.birthtimeNs.toString(),
        });
      } catch (error) {
        if (error instanceof WindowsSameHandleFileError && error.code === "OVERSIZE") {
          throw findingError(
            {
              kind: "manifest_oversize",
              manifestPath: safePath(absolute),
              maximumBytes: limits.maximumManifestBytes,
            },
            `Game add-on manifest exceeds its ${limits.maximumManifestBytes}-byte limit: ${safePath(absolute)}`,
            error,
          );
        }
        if (error instanceof WindowsSameHandleFileError &&
            error.code !== "HELPER_UNAVAILABLE" && error.code !== "HELPER_TIMEOUT") {
          throw findingError(
            { kind: "scan_unstable", path: safePath(absolute) },
            `Game add-on manifest failed its same-handle Windows proof: ${safePath(absolute)}`,
            error,
          );
        }
        throw error;
      }
      if (read.bytes === undefined) {
        throw new WindowsSameHandleFileError(
          "MALFORMED_PROTOCOL",
          "Windows same-handle helper omitted requested manifest bytes.",
        );
      }
      assertManifestAggregateLimit(counters, limits, read.byteLength);
      return parsedManifest(
        absolute,
        read.finalPath,
        providerRoot,
        counters,
        read.bytes,
        windowsIdentityFrom(read),
        read.sha256,
      );
    }

    const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = openSync(absolute, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameOpenedFileIdentity(initial, opened, absolute, testHooks)) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(absolute) },
        `Game add-on manifest changed identity while being opened: ${safePath(absolute)}`,
      );
    }
    if (opened.size > BigInt(limits.maximumManifestBytes)) {
      throw findingError(
        {
          kind: "manifest_oversize",
          manifestPath: safePath(absolute),
          maximumBytes: limits.maximumManifestBytes,
        },
        `Game add-on manifest exceeds its ${limits.maximumManifestBytes}-byte limit: ${safePath(absolute)}`,
      );
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < bytes.length) {
      const count = readSync(descriptor, bytes, position, bytes.length - position, position);
      if (count === 0) break;
      position += count;
    }
    if (position !== bytes.length) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(absolute) },
        `Game add-on manifest changed size while being read: ${safePath(absolute)}`,
      );
    }
    const after = fstatSync(descriptor, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(absolute, { bigint: true });
    } catch (error) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(absolute) },
        `Game add-on manifest disappeared after it was read: ${safePath(absolute)}`,
        error,
      );
    }
    if (!sameIdentity(opened, after) || current.isSymbolicLink() || !sameIdentity(opened, current)) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(absolute) },
        `Game add-on manifest changed while being read: ${safePath(absolute)}`,
      );
    }
    let canonical: string;
    try {
      canonical = realpathSync.native(absolute);
    } catch (error) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(absolute) },
        `Game add-on manifest cannot be resolved after it was read: ${safePath(absolute)}`,
        error,
      );
    }
    if (resolve(canonical) !== absolute) {
      throw findingError(
        { kind: "scan_unstable", path: safePath(absolute) },
        `Game add-on manifest resolves through a link or reparse point: ${safePath(absolute)}`,
      );
    }
    assertManifestAggregateLimit(counters, limits, bytes.length);
    return parsedManifest(
      absolute,
      canonical,
      providerRoot,
      counters,
      bytes,
      {
        ...identityFrom(opened),
        volumeIdentity: opened.dev.toString(),
        fileId: opened.ino.toString(),
      },
      createHash("sha256").update(bytes).digest("hex"),
    );
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw findingError(
      { kind: "manifest_unreadable", manifestPath: safePath(absolute) },
      `Game add-on manifest cannot be read safely: ${safePath(absolute)}`,
      error,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function mergeManifestProvider(manifest: ManifestRead, providerRoot: string): void {
  if (manifest.providerRoots.some((root) =>
    canonicalPathComparisonKey(root) === canonicalPathComparisonKey(providerRoot))) return;
  manifest.providerRoots.push(providerRoot);
}

function fixedIdentity(value: GameAddonFileIdentity): readonly (number | string)[] {
  return [
    value.byteLength,
    value.device,
    value.inode,
    value.modifiedNanoseconds,
    value.changedNanoseconds,
    value.birthNanoseconds,
  ];
}

type DigestFields = Omit<GameAddonPlanSnapshot, "addonEvidenceDigest">;

/** Fixed-field canonical digest used by persisted launch evidence. */
export function computeGameAddonEvidenceDigest(value: DigestFields): string {
  const canonical = [
    "reforger-forge-game-addon-evidence",
    value.schemaVersion,
    [
      value.project.displayPath,
      value.project.comparisonKey,
      value.project.modDirectory,
      value.project.modDirectoryKey,
    ],
    value.executablePath,
    value.profilePath,
    value.managedRoot,
    value.profileRoot,
    value.configuredAddonRoots,
    [
      value.limits.maximumRoots,
      value.limits.maximumVisitedEntries,
      value.limits.maximumCandidates,
      value.limits.maximumManifestBytes,
      value.limits.maximumTotalManifestBytes,
    ],
    value.targetGuid,
    value.addonGuids,
    value.dependencyGuids,
    value.resolvedDependencies.map((dependency) => [
      dependency.guid,
      dependency.gprojPath,
      dependency.addonRoot,
      dependency.dependencies,
    ]),
    value.emittedAddonRoots,
    value.implicitAddonRoots,
    value.roots.map((root) => [
      root.path,
      root.comparisonKey,
      root.provenance,
      root.prospectiveImplicit,
      root.exists,
      root.emitted,
      root.visitedEntries,
      root.verificationEntries,
      root.candidateCount,
      root.directories.map((directory) => [
        directory.path,
        ...fixedIdentity(directory),
        directory.listingDigest,
      ]),
    ]),
    value.manifests.map((manifest) => [
      manifest.gprojPath,
      manifest.comparisonKey,
      manifest.guid,
      manifest.dependencies,
      manifest.providerRoots,
      ...fixedIdentity(manifest),
      manifest.volumeIdentity,
      manifest.fileId,
      manifest.sha256,
    ]),
    value.targetProviderPaths,
    value.visitedEntries,
    value.verificationEntries,
    value.candidateCount,
    value.totalManifestBytes,
  ];
  return sha256Hex(JSON.stringify(canonical));
}

function assertEmittableRoot(path: string): void {
  if (CONTROL_OR_COMMA.test(path)) {
    throw new GameLaunchPlanError(
      "ADDON_ROOT_UNREADABLE",
      `Game add-on root cannot be represented safely in -addonsDir: ${safePath(path)}`,
    );
  }
}

function freezeManifest(value: ManifestRead): GameAddonManifestEvidence {
  return Object.freeze({
    ...value,
    dependencies: Object.freeze([...value.dependencies]),
    providerRoots: Object.freeze([...value.providerRoots]),
  });
}

/** Resolve and freeze the exact add-on graph selected by `-addons <targetGuid>`. */
export function resolveGameAddonPlan(options: ResolveGameAddonPlanOptions): GameAddonPlanSnapshot {
  if (!options || typeof options !== "object" ||
      !Array.isArray(options.configuredAddonRoots ?? [])) {
    throw new TypeError("Game add-on planning options are invalid.");
  }
  const project = assertCanonicalProject(options.project);
  const limits = resolveLimits(options.scanLimits);
  if (!isAbsolute(options.executablePath) || !isAbsolute(options.profilePath) ||
      !isAbsolute(options.managedRoot) || !isAbsolute(options.profileRoot)) {
    throw new GameLaunchPlanError(
      "ADDON_ROOT_UNREADABLE",
      "Game add-on planning requires absolute executable and private-root paths.",
    );
  }
  const executablePath = resolve(options.executablePath);
  const profilePath = prospectivePrivatePath(options.profilePath, "Derived observer profile");
  const managedRoot = prospectivePrivatePath(options.managedRoot, "Observer managed root");
  const profileRoot = prospectivePrivatePath(options.profileRoot, "Observer profile root");
  if (!isPathContained(profileRoot, profilePath)) {
    throw new GameLaunchPlanError(
      "ADDON_ROOT_CONFLICT",
      "Derived observer profile is outside the configured observer profile root.",
    );
  }
  const privateRoots = Object.freeze([managedRoot, profileRoot]);
  const targetParent = realpathSync.native(dirname(project.modDirectory));
  assertNoPrivateOverlap(project.modDirectory, privateRoots);
  assertNoPrivateOverlap(targetParent, privateRoots);

  const seeds: RootSeed[] = [];
  const configuredAddonRoots: string[] = [];
  for (const root of options.configuredAddonRoots ?? []) {
    if (typeof root !== "string" || root.trim().length === 0) {
      throw new GameLaunchPlanError("ADDON_ROOT_UNREADABLE", "Configured game add-on roots must be nonempty paths.");
    }
    appendRootSeed(seeds, root.trim(), "configured", false, true, limits);
  }
  appendRootSeed(seeds, targetParent, "target_parent", false, true, limits);
  appendRootSeed(
    seeds,
    join(dirname(executablePath), "addons"),
    "installation_addons",
    true,
    false,
    limits,
  );
  const profileAddons = join(profilePath, "profile", "addons");
  appendRootSeed(seeds, profileAddons, "profile_addons", true, false, limits);
  for (const seed of seeds) {
    if (seed.provenance.includes("configured")) configuredAddonRoots.push(seed.path);
    if (!seed.prospectiveImplicit) assertNoPrivateOverlap(seed.path, privateRoots);
  }

  const counters: ScanCounters = {
    visitedEntries: 0,
    verificationEntries: 0,
    candidateCount: 0,
    totalManifestBytes: 0,
  };
  const scans = seeds.map((seed) => scanRoot(seed, counters, limits, options.testHooks));
  const manifestsByPath = new Map<string, ManifestRead>();
  const target = readManifest(project.displayPath, targetParent, counters, limits, options.testHooks);
  manifestsByPath.set(target.comparisonKey, target);
  for (const scan of scans) {
    for (const candidate of scan.candidates) {
      const key = canonicalPathComparisonKey(candidate);
      const existing = manifestsByPath.get(key);
      if (existing) {
        mergeManifestProvider(existing, scan.seed.path);
        continue;
      }
      const manifest = readManifest(candidate, scan.seed.path, counters, limits, options.testHooks);
      const canonicalExisting = manifestsByPath.get(manifest.comparisonKey);
      if (canonicalExisting) mergeManifestProvider(canonicalExisting, scan.seed.path);
      else manifestsByPath.set(manifest.comparisonKey, manifest);
    }
  }
  for (const manifest of manifestsByPath.values()) {
    manifest.providerRoots.sort((left, right) => {
      const leftIndex = seeds.findIndex((seed) =>
        canonicalPathComparisonKey(seed.path) === canonicalPathComparisonKey(left));
      const rightIndex = seeds.findIndex((seed) =>
        canonicalPathComparisonKey(seed.path) === canonicalPathComparisonKey(right));
      return leftIndex - rightIndex || compareStrings(
        canonicalPathComparisonKey(left),
        canonicalPathComparisonKey(right),
      );
    });
  }

  const providersByGuid = new Map<string, ManifestRead[]>();
  for (const manifest of manifestsByPath.values()) {
    const providers = providersByGuid.get(manifest.guid) ?? [];
    providers.push(manifest);
    providersByGuid.set(manifest.guid, providers);
  }
  for (const providers of providersByGuid.values()) {
    providers.sort((left, right) => compareStrings(left.comparisonKey, right.comparisonKey));
  }
  const targetProviders = providersByGuid.get(target.guid) ?? [];
  if (targetProviders.length !== 1 || targetProviders[0].comparisonKey !== project.comparisonKey) {
    throw findingError(
      {
        kind: "target_provider_collision",
        guid: target.guid,
        providerCount: targetProviders.length,
      },
      "The target add-on GUID does not resolve uniquely to the requested project.",
    );
  }

  const required = new Set<string>();
  const resolvedDependencies: GameAddonDependencyResolution[] = [];
  const visited = new Set<string>([target.guid]);
  const pending = [...target.dependencies];
  while (pending.length > 0) {
    const guid = pending.shift()!;
    if (visited.has(guid)) continue;
    visited.add(guid);
    required.add(guid);
    const providers = providersByGuid.get(guid) ?? [];
    if (providers.length === 0) {
      throw findingError(
        { kind: "dependency_missing", guid },
        `Declared game add-on dependency is missing: ${guid}`,
      );
    }
    if (providers.length > 1) {
      throw findingError(
        { kind: "dependency_ambiguous", guid, providerCount: providers.length },
        `Declared game add-on dependency is ambiguous: ${guid}`,
      );
    }
    const provider = providers[0];
    const addonRoot = provider.providerRoots[0];
    const seed = seeds.find((candidate) =>
      canonicalPathComparisonKey(candidate.path) === canonicalPathComparisonKey(addonRoot));
    if (!seed) {
      throw new GameLaunchPlanError("ADDON_EVIDENCE_INVALID", "Resolved add-on provider has no audited root.");
    }
    if (!seed.provenance.includes("dependency_container")) {
      seed.provenance.push("dependency_container");
    }
    resolvedDependencies.push(Object.freeze({
      guid,
      gprojPath: provider.gprojPath,
      addonRoot,
      dependencies: Object.freeze([...provider.dependencies]),
    }));
    pending.push(...provider.dependencies);
  }
  resolvedDependencies.sort((left, right) => compareStrings(left.guid, right.guid));

  const emittedAddonRoots: string[] = [];
  const implicitAddonRoots: string[] = [];
  for (const seed of seeds) {
    if (seed.provenance.includes("installation_addons") || seed.provenance.includes("profile_addons")) {
      implicitAddonRoots.push(seed.path);
    }
    const emit = seed.provenance.includes("configured") || seed.provenance.includes("target_parent") ||
      (seed.provenance.includes("dependency_container") && !seed.prospectiveImplicit);
    if (!emit) continue;
    assertNoPrivateOverlap(seed.path, privateRoots);
    assertEmittableRoot(seed.path);
    if (!emittedAddonRoots.some((root) =>
      canonicalPathComparisonKey(root) === canonicalPathComparisonKey(seed.path))) {
      emittedAddonRoots.push(seed.path);
    }
  }

  const roots = scans.map((scan) => Object.freeze({
    ...scan.evidence,
    provenance: Object.freeze([...scan.seed.provenance]),
    emitted: emittedAddonRoots.some((root) =>
      canonicalPathComparisonKey(root) === scan.evidence.comparisonKey),
  }));
  const manifests = [...manifestsByPath.values()]
    .sort((left, right) => compareStrings(left.comparisonKey, right.comparisonKey))
    .map(freezeManifest);
  const fields: DigestFields = {
    schemaVersion: GAME_ADDON_EVIDENCE_SCHEMA_VERSION,
    project: cloneProject(project),
    executablePath,
    profilePath,
    managedRoot,
    profileRoot,
    configuredAddonRoots: Object.freeze(configuredAddonRoots),
    limits,
    targetGuid: target.guid,
    addonGuids: Object.freeze([target.guid]) as readonly [string],
    dependencyGuids: Object.freeze([...required].sort(compareStrings)),
    resolvedDependencies: Object.freeze(resolvedDependencies),
    emittedAddonRoots: Object.freeze(emittedAddonRoots),
    implicitAddonRoots: Object.freeze(implicitAddonRoots),
    roots: Object.freeze(roots),
    manifests: Object.freeze(manifests),
    targetProviderPaths: Object.freeze(targetProviders.map((provider) => provider.gprojPath)),
    visitedEntries: counters.visitedEntries,
    verificationEntries: counters.verificationEntries,
    candidateCount: counters.candidateCount,
    totalManifestBytes: counters.totalManifestBytes,
  };
  return Object.freeze({
    ...fields,
    addonEvidenceDigest: computeGameAddonEvidenceDigest(fields),
  });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function validAbsoluteStrings(value: unknown, maximum = 128): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((entry) =>
    typeof entry === "string" && isAbsolute(entry) && !/[\0\r\n]/.test(entry));
}

function validFileIdentity(value: unknown): boolean {
  if (!plainRecord(value) || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) {
    return false;
  }
  for (const field of ["device", "inode", "modifiedNanoseconds", "changedNanoseconds", "birthNanoseconds"] as const) {
    if (typeof value[field] !== "string" || !/^\d+$/.test(value[field] as string)) return false;
  }
  return !/^0+$/.test(value.device as string) && !/^0+$/.test(value.inode as string);
}

function validDirectoryEvidence(value: unknown): boolean {
  return validFileIdentity(value) && plainRecord(value) &&
    typeof value.path === "string" && isAbsolute(value.path) &&
    typeof value.listingDigest === "string" && SHA256.test(value.listingDigest);
}

function validRootEvidence(value: unknown): boolean {
  return plainRecord(value) && typeof value.path === "string" && isAbsolute(value.path) &&
    value.comparisonKey === canonicalPathComparisonKey(value.path) &&
    Array.isArray(value.directories) && value.directories.every(validDirectoryEvidence);
}

function validManifestEvidence(value: unknown): boolean {
  return validFileIdentity(value) && plainRecord(value) &&
    typeof value.gprojPath === "string" && isAbsolute(value.gprojPath) &&
    value.comparisonKey === canonicalPathComparisonKey(value.gprojPath) &&
    typeof value.volumeIdentity === "string" && /^[1-9]\d*$/.test(value.volumeIdentity) &&
    typeof value.fileId === "string" && /^[1-9]\d*$/.test(value.fileId) &&
    typeof value.sha256 === "string" && SHA256.test(value.sha256) &&
    validAbsoluteStrings(value.providerRoots);
}

function assertSnapshot(value: unknown): asserts value is GameAddonPlanSnapshot {
  if (!plainRecord(value) || value.schemaVersion !== GAME_ADDON_EVIDENCE_SCHEMA_VERSION ||
      !plainRecord(value.project) || typeof value.project.displayPath !== "string" ||
      typeof value.project.comparisonKey !== "string" || typeof value.project.modDirectory !== "string" ||
      typeof value.project.modDirectoryKey !== "string" ||
      !isAbsolute(value.project.displayPath as string) || !isAbsolute(value.project.modDirectory as string) ||
      value.project.comparisonKey !== value.project.displayPath ||
      value.project.modDirectoryKey !== value.project.modDirectory ||
      typeof value.executablePath !== "string" || !isAbsolute(value.executablePath) ||
      typeof value.profilePath !== "string" || !isAbsolute(value.profilePath) ||
      typeof value.managedRoot !== "string" || !isAbsolute(value.managedRoot) ||
      typeof value.profileRoot !== "string" || !isAbsolute(value.profileRoot) ||
      !validAbsoluteStrings(value.configuredAddonRoots) || !plainRecord(value.limits) ||
      !validLimit(value.limits.maximumRoots) || !validLimit(value.limits.maximumVisitedEntries) ||
      !validLimit(value.limits.maximumCandidates) || !validLimit(value.limits.maximumManifestBytes) ||
      !validLimit(value.limits.maximumTotalManifestBytes) ||
      typeof value.targetGuid !== "string" || !ADDON_GUID_PATTERN.test(value.targetGuid) ||
      !Array.isArray(value.addonGuids) || value.addonGuids.length !== 1 || value.addonGuids[0] !== value.targetGuid ||
      !Array.isArray(value.dependencyGuids) || !value.dependencyGuids.every((guid) => typeof guid === "string" && ADDON_GUID_PATTERN.test(guid)) ||
      !validAbsoluteStrings(value.emittedAddonRoots) || !validAbsoluteStrings(value.implicitAddonRoots) ||
      !Array.isArray(value.roots) || value.roots.length > (value.limits.maximumRoots as number) ||
      !value.roots.every(validRootEvidence) ||
      !Array.isArray(value.manifests) || value.manifests.length > (value.limits.maximumCandidates as number) + 1 ||
      !value.manifests.every(validManifestEvidence) ||
      !Array.isArray(value.resolvedDependencies) || !validAbsoluteStrings(value.targetProviderPaths) ||
      !Number.isSafeInteger(value.visitedEntries) || (value.visitedEntries as number) < 0 ||
      !Number.isSafeInteger(value.verificationEntries) || (value.verificationEntries as number) < 0 ||
      !Number.isSafeInteger(value.candidateCount) || (value.candidateCount as number) < 0 ||
      !Number.isSafeInteger(value.totalManifestBytes) || (value.totalManifestBytes as number) < 0 ||
      typeof value.addonEvidenceDigest !== "string" || !SHA256.test(value.addonEvidenceDigest)) {
    throw new GameLaunchPlanError(
      "ADDON_EVIDENCE_INVALID",
      "Stored game add-on evidence does not satisfy its schema.",
    );
  }
}

/** Re-attest an original snapshot; never substitute retry-selected evidence. */
export function revalidateGameAddonPlan(snapshot: unknown): GameAddonPlanSnapshot {
  try {
    assertSnapshot(snapshot);
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw new GameLaunchPlanError(
      "ADDON_EVIDENCE_INVALID",
      "Stored game add-on evidence could not be inspected safely.",
      { cause: error },
    );
  }
  let digest: string;
  try {
    digest = computeGameAddonEvidenceDigest(snapshot);
  } catch (error) {
    throw new GameLaunchPlanError(
      "ADDON_EVIDENCE_INVALID",
      "Stored game add-on evidence could not be digested.",
      { cause: error },
    );
  }
  if (digest !== snapshot.addonEvidenceDigest) {
    throw new GameLaunchPlanError(
      "ADDON_EVIDENCE_INVALID",
      "Stored game add-on evidence digest does not match its proof fields.",
    );
  }
  let current: GameAddonPlanSnapshot;
  try {
    current = resolveGameAddonPlan({
      project: snapshot.project,
      configuredAddonRoots: snapshot.configuredAddonRoots,
      executablePath: snapshot.executablePath,
      profilePath: snapshot.profilePath,
      managedRoot: snapshot.managedRoot,
      profileRoot: snapshot.profileRoot,
      scanLimits: snapshot.limits,
    });
  } catch (error) {
    if (error instanceof GameLaunchPlanError && error.code === "ADDON_EVIDENCE_INVALID") throw error;
    throw new GameLaunchPlanError(
      "ADDON_CHANGED",
      "Game add-on evidence could not be revalidated against the original snapshot.",
      { cause: error },
    );
  }
  if (current.addonEvidenceDigest !== snapshot.addonEvidenceDigest) {
    throw new GameLaunchPlanError("ADDON_CHANGED", "Game add-on evidence changed after launch planning.");
  }
  return current;
}

/** Compatibility alias for callers that use planning terminology. */
export const planGameAddons = resolveGameAddonPlan;
