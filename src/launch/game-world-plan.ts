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
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Hex } from "../foundation/digest.js";
import {
  sameUsableFileIdentity,
  type BigIntFileIdentity,
} from "../foundation/file-identity.js";
import {
  isCanonicalPathContained,
  ManagedPathError,
  resolveManagedPath,
} from "../foundation/managed-path.js";
import {
  readWindowsFileThroughVerifiedHandle,
  WindowsSameHandleFileError,
  type WindowsSameHandleFileRead,
} from "../platform/windows/same-handle-file.js";
import type { CanonicalProjectIdentity } from "../workbench/project-identity.js";
import {
  revalidateProjectIdentity,
} from "../workbench/project-identity.js";
import {
  readResourceMeta,
  RESOURCE_META_MAXIMUM_BYTES,
  ResourceMetaError,
  type ResourceMetaFileEvidence,
} from "../workbench/resource-meta.js";
import {
  GameLaunchPlanError,
  type GameWorldDiagnosticCandidate,
  type GameWorldRegistrationStatus,
} from "./game-launch-errors.js";

export const GAME_WORLD_EVIDENCE_SCHEMA_VERSION = 2;
export const GAME_WORLD_PROJECT_MAXIMUM_BYTES = 4 * 1024 * 1024;
export const GAME_WORLD_FILE_MAXIMUM_BYTES = 64 * 1024 * 1024;

export interface GameWorldDiscoveryLimits {
  readonly maximumDepth: number;
  readonly maximumVisitedEntries: number;
  readonly maximumCandidates: number;
  readonly maximumMetadataBytes: number;
  readonly maximumDiagnosticCandidates: number;
}

export const DEFAULT_GAME_WORLD_DISCOVERY_LIMITS: GameWorldDiscoveryLimits = Object.freeze({
  maximumDepth: 16,
  maximumVisitedEntries: 10_000,
  maximumCandidates: 256,
  maximumMetadataBytes: 4 * 1024 * 1024,
  maximumDiagnosticCandidates: 16,
});

export interface GameWorldFileIdentity {
  readonly byteLength: number;
  readonly device: string;
  readonly inode: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
  readonly birthNanoseconds: string;
}

export interface GameWorldFileEvidence extends GameWorldFileIdentity {
  /** Complete FILE_ID_INFO volume identity; on non-Windows this equals device. */
  readonly volumeIdentity: string;
  /** Complete unsigned FILE_ID_INFO identifier; on non-Windows this equals inode. */
  readonly fileId: string;
  readonly sha256: string;
}

export interface GameWorldDirectoryEvidence extends GameWorldFileIdentity {
  readonly relativePath: string;
  readonly listingDigest: string;
}

export interface ExplicitGameWorldSelection {
  readonly kind: "explicit";
  readonly inputKind: "absolute" | "relative" | "formed";
  readonly suppliedGuid: string | null;
}

export interface DiscoveredGameWorldSelection {
  readonly kind: "discovered";
  readonly limits: GameWorldDiscoveryLimits;
  readonly visitedEntries: number;
  readonly verificationEntries: number;
  readonly candidateCount: number;
  readonly metadataBytes: number;
  readonly directories: readonly GameWorldDirectoryEvidence[];
}

export type GameWorldSelectionEvidence =
  | ExplicitGameWorldSelection
  | DiscoveredGameWorldSelection;

export interface GameWorldPlanSnapshot {
  readonly schemaVersion: typeof GAME_WORLD_EVIDENCE_SCHEMA_VERSION;
  readonly project: CanonicalProjectIdentity;
  readonly worldPath: string;
  readonly metaPath: string;
  readonly projectFile: GameWorldFileEvidence;
  readonly worldFile: GameWorldFileEvidence;
  readonly metaFile: ResourceMetaFileEvidence;
  readonly guid: string;
  readonly relativePath: string;
  readonly resourceReference: string;
  readonly selection: GameWorldSelectionEvidence;
  readonly worldEvidenceDigest: string;
}

export interface ResolveGameWorldPlanOptions {
  readonly project: CanonicalProjectIdentity;
  readonly world?: string | null;
  readonly discoveryLimits?: Partial<GameWorldDiscoveryLimits>;
  /** @internal Deterministic test seam; production composition never supplies it. */
  readonly testHooks?: GameWorldPlanTestHooks;
}

export type GameWorldPlanTestCheckpoint =
  | "before_file_open"
  | "after_directory_read"
  | "before_final_evidence_stat";

/** @internal Fault-injection checkpoints used to prove race refusals deterministically. */
export interface GameWorldPlanTestHooks {
  readonly checkpoint?: (checkpoint: GameWorldPlanTestCheckpoint, path: string) => void;
  readonly fileIdentity?: (
    path: string,
    identity: Readonly<BigIntFileIdentity>,
  ) => BigIntFileIdentity;
}

interface ResolvedWorldInput {
  readonly requestedPath: string;
  readonly inputKind: ExplicitGameWorldSelection["inputKind"];
  readonly suppliedGuid: string | null;
}

interface StableFileRead {
  readonly evidence: GameWorldFileEvidence;
}

interface DiscoveryCandidate extends GameWorldDiagnosticCandidate {
  readonly absolutePath: string;
}

interface MutableDiscoveryState {
  readonly project: CanonicalProjectIdentity;
  readonly root: string;
  readonly limits: GameWorldDiscoveryLimits;
  readonly candidates: DiscoveryCandidate[];
  readonly directories: GameWorldDirectoryEvidence[];
  readonly testHooks: GameWorldPlanTestHooks | undefined;
  visitedEntries: number;
  verificationEntries: number;
  metadataBytes: number;
}

const FORMED_WORLD = /^\{([0-9A-Fa-f]{16})\}(.+)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GUID = /^[0-9A-F]{16}$/;

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
  testHooks: GameWorldPlanTestHooks | undefined,
): boolean {
  const leftIdentity = testHooks?.fileIdentity?.(path, { dev: left.dev, ino: left.ino }) ?? left;
  const rightIdentity = testHooks?.fileIdentity?.(path, { dev: right.dev, ino: right.ino }) ?? right;
  return sameUsableFileIdentity(leftIdentity, rightIdentity);
}

function identityFrom(stat: BigIntStats): GameWorldFileIdentity {
  return {
    byteLength: Number(stat.size),
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    modifiedNanoseconds: stat.mtimeNs.toString(),
    changedNanoseconds: stat.ctimeNs.toString(),
    birthNanoseconds: stat.birthtimeNs.toString(),
  };
}

function fileEvidenceFrom(stat: BigIntStats, sha256: string): GameWorldFileEvidence {
  return Object.freeze({
    ...identityFrom(stat),
    volumeIdentity: stat.dev.toString(),
    fileId: stat.ino.toString(),
    sha256,
  });
}

function windowsFileEvidenceFrom(read: WindowsSameHandleFileRead): GameWorldFileEvidence {
  return Object.freeze({
    byteLength: read.byteLength,
    device: read.device,
    inode: read.inode,
    volumeIdentity: read.volumeIdentity,
    fileId: read.fileId,
    modifiedNanoseconds: read.modifiedNanoseconds,
    changedNanoseconds: read.changedNanoseconds,
    birthNanoseconds: read.birthNanoseconds,
    sha256: read.sha256,
  });
}

function directoryEvidenceFrom(
  stat: BigIntStats,
  relativePath: string,
  listingDigest: string,
): GameWorldDirectoryEvidence {
  return Object.freeze({ ...identityFrom(stat), relativePath, listingDigest });
}

function normalizeRelativePath(value: string): string {
  return value.split(sep).join("/");
}

function validPositiveLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function discoveryLimits(
  overrides: Partial<GameWorldDiscoveryLimits> | undefined,
): GameWorldDiscoveryLimits {
  const result = {
    ...DEFAULT_GAME_WORLD_DISCOVERY_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!validPositiveLimit(value)) {
      throw new TypeError(`Game world discovery limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(result);
}

function changed(message: string, cause?: unknown): GameLaunchPlanError {
  return new GameLaunchPlanError("WORLD_CHANGED", message, { cause });
}

function unsafeWorld(message: string, cause?: unknown): GameLaunchPlanError {
  return new GameLaunchPlanError("WORLD_OUTSIDE_PROJECT", message, { cause });
}

function mapMetadataError(error: ResourceMetaError, metaPath: string): GameLaunchPlanError {
  const code = error.code === "MISSING"
    ? "WORLD_METADATA_MISSING"
    : error.code === "OVERSIZE"
      ? "WORLD_METADATA_OVERSIZE"
      : error.code === "MALFORMED"
        ? "WORLD_METADATA_MALFORMED"
        : "WORLD_METADATA_UNREADABLE";
  return new GameLaunchPlanError(code, error.message, {
    details: { metadataPath: metaPath },
    cause: error,
  });
}

function stableFileRead(
  path: string,
  maximumBytes: number,
  label: string,
  failureCode: "PROJECT_CHANGED" | "WORLD_INVALID" | "WORLD_CHANGED",
  testHooks?: GameWorldPlanTestHooks,
): StableFileRead {
  const failure = (message: string, cause?: unknown): GameLaunchPlanError =>
    new GameLaunchPlanError(failureCode, `${label} ${message}: ${path}`, { cause });
  let initial: BigIntStats;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    throw failure("does not exist or cannot be inspected", error);
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw failure("is not a regular non-link file");
  }
  if (initial.size > BigInt(maximumBytes)) {
    throw failure(`exceeds its ${maximumBytes}-byte evidence limit`);
  }

  testHooks?.checkpoint?.("before_file_open", path);
  if (process.platform === "win32") {
    const expectedPathIdentity = testHooks?.fileIdentity?.(
      path,
      { dev: initial.dev, ino: initial.ino },
    ) ?? initial;
    try {
      const read = readWindowsFileThroughVerifiedHandle({
        path,
        maximumBytes,
        includeBytes: false,
        expectedPathIdentity,
        expectedByteLength: Number(initial.size),
        expectedModifiedNanoseconds: initial.mtimeNs.toString(),
        expectedChangedNanoseconds: initial.ctimeNs.toString(),
        expectedBirthNanoseconds: initial.birthtimeNs.toString(),
      });
      return { evidence: windowsFileEvidenceFrom(read) };
    } catch (error) {
      if (error instanceof WindowsSameHandleFileError && error.code === "OVERSIZE") {
        throw failure(`exceeds its ${maximumBytes}-byte evidence limit`, error);
      }
      const reason = error instanceof WindowsSameHandleFileError
        ? `cannot establish a verified same-handle Windows boundary (${error.code})`
        : "cannot establish a verified same-handle Windows boundary";
      throw failure(reason, error);
    }
  }

  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameOpenedFileIdentity(initial, opened, path, testHooks)) {
      throw failure("changed identity while being opened");
    }
    if (opened.size > BigInt(maximumBytes)) {
      throw failure(`exceeds its ${maximumBytes}-byte evidence limit`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, maximumBytes));
    let position = 0;
    while (position < Number(opened.size)) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, Number(opened.size) - position),
        position,
      );
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (position !== Number(opened.size)) throw failure("changed size while being read");
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, after)) throw failure("changed while being read");
    const current = lstatSync(path, { bigint: true });
    if (current.isSymbolicLink() || !sameIdentity(opened, current)) {
      throw failure("changed identity while being read");
    }
    return { evidence: fileEvidenceFrom(opened, hash.digest("hex")) };
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw failure("cannot be read", error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertCanonicalProject(project: CanonicalProjectIdentity): CanonicalProjectIdentity {
  try {
    const current = revalidateProjectIdentity(project);
    if (current.displayPath !== project.displayPath ||
        current.comparisonKey !== project.comparisonKey ||
        current.modDirectory !== project.modDirectory ||
        current.modDirectoryKey !== project.modDirectoryKey) {
      throw new GameLaunchPlanError(
        "PROJECT_CHANGED",
        "Canonical game project identity changed before world resolution.",
      );
    }
    return current;
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw new GameLaunchPlanError(
      "PROJECT_CHANGED",
      "Canonical game project could not be revalidated before world resolution.",
      { cause: error },
    );
  }
}

function assertCanonicalContainedFile(
  project: CanonicalProjectIdentity,
  candidate: string,
  label: string,
): string {
  let noLinkPath: string;
  try {
    noLinkPath = resolveManagedPath(project.modDirectory, candidate, "no-links");
  } catch (error) {
    throw unsafeWorld(`${label} must be a non-link path inside the selected project: ${candidate}`, error);
  }
  let initial: BigIntStats;
  try {
    initial = lstatSync(noLinkPath, { bigint: true });
  } catch (error) {
    throw new GameLaunchPlanError(
      "WORLD_INVALID",
      `${label} does not exist or cannot be inspected: ${noLinkPath}`,
      { cause: error },
    );
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new GameLaunchPlanError(
      "WORLD_INVALID",
      `${label} is not a regular non-link file: ${noLinkPath}`,
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(noLinkPath);
  } catch (error) {
    throw new GameLaunchPlanError(
      "WORLD_INVALID",
      `${label} cannot be resolved: ${noLinkPath}`,
      { cause: error },
    );
  }
  if (!isCanonicalPathContained(project.modDirectory, canonical) ||
      resolve(canonical) !== resolve(noLinkPath)) {
    throw unsafeWorld(`${label} resolves outside the selected project: ${candidate}`);
  }
  return canonical;
}

function parseWorldInput(
  project: CanonicalProjectIdentity,
  input: string,
): ResolvedWorldInput {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new GameLaunchPlanError("WORLD_INVALID", "World input must be a nonempty .ent path or resource reference.");
  }
  const value = input.trim();
  const formed = FORMED_WORLD.exec(value);
  if (value.startsWith("{") && !formed) {
    throw new GameLaunchPlanError("WORLD_INVALID", "Formed world input must begin with exactly one 16-hex GUID.");
  }
  const pathPart = formed ? formed[2] : value;
  if (extname(pathPart).toLowerCase() !== ".ent") {
    throw new GameLaunchPlanError("WORLD_INVALID", "Game world input must identify a .ent resource.");
  }
  if (formed && isAbsolute(pathPart)) {
    throw new GameLaunchPlanError("WORLD_INVALID", "A formed world reference must contain a project-relative path.");
  }
  return {
    requestedPath: isAbsolute(pathPart) ? resolve(pathPart) : resolve(project.modDirectory, pathPart),
    inputKind: formed ? "formed" : isAbsolute(pathPart) ? "absolute" : "relative",
    suppliedGuid: formed ? formed[1].toUpperCase() : null,
  };
}

function postReadPathCheck(
  project: CanonicalProjectIdentity,
  path: string,
  label: string,
): void {
  const current = assertCanonicalContainedFile(project, path, label);
  if (current !== path) throw changed(`${label} canonical identity changed while evidence was read: ${path}`);
}

function metadataEvidenceMatchesStat(
  evidence: ResourceMetaFileEvidence,
  stat: BigIntStats,
): boolean {
  return evidence.byteLength === Number(stat.size) &&
    evidence.device === stat.dev.toString() &&
    evidence.inode === stat.ino.toString() &&
    evidence.modifiedNanoseconds === stat.mtimeNs.toString() &&
    evidence.changedNanoseconds === stat.ctimeNs.toString() &&
    evidence.birthNanoseconds === stat.birthtimeNs.toString();
}

function fileEvidenceMatchesStat(
  evidence: GameWorldFileEvidence,
  stat: BigIntStats,
): boolean {
  return evidence.byteLength === Number(stat.size) &&
    evidence.device === stat.dev.toString() &&
    evidence.inode === stat.ino.toString() &&
    evidence.modifiedNanoseconds === stat.mtimeNs.toString() &&
    evidence.changedNanoseconds === stat.ctimeNs.toString() &&
    evidence.birthNanoseconds === stat.birthtimeNs.toString();
}

function cloneProject(project: CanonicalProjectIdentity): CanonicalProjectIdentity {
  return Object.freeze({
    displayPath: project.displayPath,
    comparisonKey: project.comparisonKey,
    modDirectory: project.modDirectory,
    modDirectoryKey: project.modDirectoryKey,
  });
}

function fixedIdentity(value: GameWorldFileIdentity): readonly (number | string)[] {
  return [
    value.byteLength,
    value.device,
    value.inode,
    value.modifiedNanoseconds,
    value.changedNanoseconds,
    value.birthNanoseconds,
  ];
}

function fixedFile(value: GameWorldFileEvidence | ResourceMetaFileEvidence): readonly unknown[] {
  return [...fixedIdentity(value), value.volumeIdentity, value.fileId, value.sha256];
}

function fixedSelection(value: GameWorldSelectionEvidence): readonly unknown[] {
  if (value.kind === "explicit") {
    return ["explicit", value.inputKind, value.suppliedGuid];
  }
  return [
    "discovered",
    [
      value.limits.maximumDepth,
      value.limits.maximumVisitedEntries,
      value.limits.maximumCandidates,
      value.limits.maximumMetadataBytes,
      value.limits.maximumDiagnosticCandidates,
    ],
    value.visitedEntries,
    value.verificationEntries,
    value.candidateCount,
    value.metadataBytes,
    value.directories.map((directory) => [
      directory.relativePath,
      ...fixedIdentity(directory),
      directory.listingDigest,
    ]),
  ];
}

type DigestFields = Omit<GameWorldPlanSnapshot, "worldEvidenceDigest">;

/** Fixed-field canonical digest used by persisted launch evidence. */
export function computeGameWorldEvidenceDigest(value: DigestFields): string {
  const canonical = [
    "reforger-forge-game-world-evidence",
    value.schemaVersion,
    [
      value.project.displayPath,
      value.project.comparisonKey,
      value.project.modDirectory,
      value.project.modDirectoryKey,
    ],
    value.worldPath,
    value.metaPath,
    fixedFile(value.projectFile),
    fixedFile(value.worldFile),
    fixedFile(value.metaFile),
    value.guid,
    value.relativePath,
    value.resourceReference,
    fixedSelection(value.selection),
  ];
  return sha256Hex(JSON.stringify(canonical));
}

function freezeSelection(value: GameWorldSelectionEvidence): GameWorldSelectionEvidence {
  if (value.kind === "explicit") {
    return Object.freeze({
      kind: "explicit",
      inputKind: value.inputKind,
      suppliedGuid: value.suppliedGuid,
    });
  }
  return Object.freeze({
    kind: "discovered",
    limits: Object.freeze({ ...value.limits }),
    visitedEntries: value.visitedEntries,
    verificationEntries: value.verificationEntries,
    candidateCount: value.candidateCount,
    metadataBytes: value.metadataBytes,
    directories: Object.freeze(value.directories.map((directory) => Object.freeze({ ...directory }))),
  });
}

function buildSnapshot(
  project: CanonicalProjectIdentity,
  worldPath: string,
  selection: GameWorldSelectionEvidence,
  testHooks?: GameWorldPlanTestHooks,
): GameWorldPlanSnapshot {
  const canonicalWorld = assertCanonicalContainedFile(project, worldPath, "Game world");
  if (extname(canonicalWorld).toLowerCase() !== ".ent") {
    throw new GameLaunchPlanError("WORLD_INVALID", `Game world must have a .ent extension: ${canonicalWorld}`);
  }
  let metaCandidate: string;
  try {
    metaCandidate = resolveManagedPath(project.modDirectory, `${canonicalWorld}.meta`, "no-links");
  } catch (error) {
    throw unsafeWorld(`Game world metadata must be a non-link path inside the selected project: ${canonicalWorld}.meta`, error);
  }

  const projectFile = stableFileRead(
    project.displayPath,
    GAME_WORLD_PROJECT_MAXIMUM_BYTES,
    "Game project",
    "PROJECT_CHANGED",
    testHooks,
  ).evidence;
  const worldFile = stableFileRead(
    canonicalWorld,
    GAME_WORLD_FILE_MAXIMUM_BYTES,
    "Game world",
    "WORLD_CHANGED",
    testHooks,
  ).evidence;
  let meta;
  try {
    meta = readResourceMeta(metaCandidate);
  } catch (error) {
    if (error instanceof ResourceMetaError) throw mapMetadataError(error, metaCandidate);
    throw error;
  }
  const metaPath = assertCanonicalContainedFile(project, metaCandidate, "Game world metadata");
  postReadPathCheck(project, canonicalWorld, "Game world");
  postReadPathCheck(project, metaPath, "Game world metadata");
  let currentProject: BigIntStats;
  let currentWorld: BigIntStats;
  let currentMeta: BigIntStats;
  try {
    testHooks?.checkpoint?.("before_final_evidence_stat", canonicalWorld);
    currentProject = lstatSync(project.displayPath, { bigint: true });
    currentWorld = lstatSync(canonicalWorld, { bigint: true });
    currentMeta = lstatSync(metaPath, { bigint: true });
  } catch (error) {
    throw changed("Game project or world evidence could not be inspected after it was read.", error);
  }
  if (!fileEvidenceMatchesStat(projectFile, currentProject) ||
      !fileEvidenceMatchesStat(worldFile, currentWorld) ||
      !metadataEvidenceMatchesStat(meta.evidence, currentMeta)) {
    throw changed("Game project or world evidence changed after it was read.");
  }

  const relativePath = normalizeRelativePath(relative(project.modDirectory, canonicalWorld));
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
    throw unsafeWorld(`Game world is not a child of the selected project: ${canonicalWorld}`);
  }
  if (selection.kind === "explicit" && selection.suppliedGuid !== null &&
      selection.suppliedGuid !== meta.guid) {
    throw new GameLaunchPlanError(
      "WORLD_GUID_MISMATCH",
      `Formed world GUID does not match its resource metadata: ${canonicalWorld}`,
      { details: { suppliedGuid: selection.suppliedGuid, metadataGuid: meta.guid, relativePath } },
    );
  }
  const resourceReference = `{${meta.guid}}${relativePath}`;
  const stableSelection = selection.kind === "discovered"
    ? { ...selection, metadataBytes: meta.evidence.byteLength }
    : selection;
  const fields: DigestFields = {
    schemaVersion: GAME_WORLD_EVIDENCE_SCHEMA_VERSION,
    project: cloneProject(project),
    worldPath: canonicalWorld,
    metaPath,
    projectFile,
    worldFile,
    metaFile: meta.evidence,
    guid: meta.guid,
    relativePath,
    resourceReference,
    selection: freezeSelection(stableSelection),
  };
  return Object.freeze({
    ...fields,
    worldEvidenceDigest: computeGameWorldEvidenceDigest(fields),
  });
}

function entryKind(entry: Dirent): string {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "link";
  return "other";
}

function readDirectoryEntries(
  path: string,
  state: MutableDiscoveryState,
  counter: "visitedEntries" | "verificationEntries",
): Dirent[] {
  let directory;
  try {
    directory = opendirSync(path);
  } catch (error) {
    throw new GameLaunchPlanError(
      "WORLD_SCAN_UNSTABLE",
      `World discovery directory cannot be opened: ${path}`,
      { cause: error },
    );
  }
  const result: Dirent[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      state[counter] += 1;
      if (state[counter] > state.limits.maximumVisitedEntries) {
        throw new GameLaunchPlanError(
          "WORLD_SCAN_TRUNCATED",
          `World discovery exceeded its ${state.limits.maximumVisitedEntries}-entry limit.`,
          { details: { limit: "maximumVisitedEntries", maximum: state.limits.maximumVisitedEntries } },
        );
      }
      result.push(entry);
    }
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw new GameLaunchPlanError(
      "WORLD_SCAN_UNSTABLE",
      `World discovery directory changed while it was read: ${path}`,
      { cause: error },
    );
  } finally {
    try {
      directory.closeSync();
    } catch {
      // Preserve the primary typed refusal; a close failure has no safe
      // selection semantics and the next evidence check also fails closed.
    }
  }
  result.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "case" }));
  return result;
}

function listingDigest(entries: readonly Dirent[]): string {
  return sha256Hex(JSON.stringify(entries.map((entry) => [entry.name, entryKind(entry)])));
}

function registrationStatus(
  path: string,
  state: MutableDiscoveryState,
): GameWorldRegistrationStatus {
  const metaPath = `${path}.meta`;
  let info: BigIntStats;
  try {
    info = lstatSync(metaPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unregistered";
    return "metadata_unreadable";
  }
  if (info.isSymbolicLink() || !info.isFile()) return "metadata_unreadable";
  if (info.size > BigInt(RESOURCE_META_MAXIMUM_BYTES)) return "metadata_oversize";
  if (state.metadataBytes + Number(info.size) > state.limits.maximumMetadataBytes) {
    throw new GameLaunchPlanError(
      "WORLD_SCAN_TRUNCATED",
      `World discovery exceeded its ${state.limits.maximumMetadataBytes}-byte metadata limit.`,
      { details: { limit: "maximumMetadataBytes", maximum: state.limits.maximumMetadataBytes } },
    );
  }
  state.metadataBytes += Number(info.size);
  try {
    readResourceMeta(metaPath);
    return "registered";
  } catch (error) {
    if (!(error instanceof ResourceMetaError)) return "metadata_unreadable";
    if (error.code === "OVERSIZE") return "metadata_oversize";
    if (error.code === "MALFORMED") return "metadata_malformed";
    if (error.code === "MISSING") return "unregistered";
    return "metadata_unreadable";
  }
}

function scanDirectory(
  path: string,
  depth: number,
  state: MutableDiscoveryState,
): void {
  if (depth > state.limits.maximumDepth) {
    throw new GameLaunchPlanError(
      "WORLD_SCAN_TRUNCATED",
      `World discovery exceeded its recursion depth limit of ${state.limits.maximumDepth}.`,
      { details: { limit: "maximumDepth", maximum: state.limits.maximumDepth } },
    );
  }
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new GameLaunchPlanError("WORLD_SCAN_UNSTABLE", `World discovery directory cannot be inspected: ${path}`, { cause: error });
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw unsafeWorld(`World discovery refuses a linked or non-directory path: ${path}`);
  }
  const entries = readDirectoryEntries(path, state, "visitedEntries");
  const digest = listingDigest(entries);
  state.testHooks?.checkpoint?.("after_directory_read", path);

  for (const entry of entries) {
    const child = join(path, entry.name);
    let info: BigIntStats;
    try {
      info = lstatSync(child, { bigint: true });
    } catch (error) {
      throw new GameLaunchPlanError("WORLD_SCAN_UNSTABLE", `World discovery entry changed during inspection: ${child}`, { cause: error });
    }
    if (info.isSymbolicLink() || entry.isSymbolicLink()) {
      throw unsafeWorld(`World discovery refuses a symbolic-link or reparse entry: ${child}`);
    }
    if (info.isDirectory()) {
      scanDirectory(child, depth + 1, state);
      continue;
    }
    if (!info.isFile() || extname(entry.name).toLowerCase() !== ".ent") continue;
    state.candidates.push({
      absolutePath: child,
      path: normalizeRelativePath(relative(state.project.modDirectory, child)),
      status: registrationStatus(child, state),
    });
    if (state.candidates.length > state.limits.maximumCandidates) {
      throw new GameLaunchPlanError(
        "WORLD_SCAN_TRUNCATED",
        `World discovery exceeded its ${state.limits.maximumCandidates}-candidate limit.`,
        { details: { limit: "maximumCandidates", maximum: state.limits.maximumCandidates } },
      );
    }
  }

  let after: BigIntStats;
  try {
    after = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new GameLaunchPlanError("WORLD_SCAN_UNSTABLE", `World discovery directory disappeared during inspection: ${path}`, { cause: error });
  }
  const verification = readDirectoryEntries(path, state, "verificationEntries");
  let final: BigIntStats;
  try {
    final = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new GameLaunchPlanError(
      "WORLD_SCAN_UNSTABLE",
      `World discovery directory disappeared during verification: ${path}`,
      { cause: error },
    );
  }
  if (!sameIdentity(before, after) || !sameIdentity(before, final) ||
      digest !== listingDigest(verification)) {
    throw new GameLaunchPlanError(
      "WORLD_SCAN_UNSTABLE",
      `World discovery directory changed during inspection: ${path}`,
    );
  }
  state.directories.push(directoryEvidenceFrom(
    before,
    normalizeRelativePath(relative(state.root, path)) || ".",
    digest,
  ));
}

function metadataStatusError(candidate: DiscoveryCandidate): GameLaunchPlanError {
  const metaPath = `${candidate.absolutePath}.meta`;
  if (candidate.status === "metadata_oversize") {
    return new GameLaunchPlanError("WORLD_METADATA_OVERSIZE", `Game world metadata is oversize: ${metaPath}`);
  }
  if (candidate.status === "metadata_malformed") {
    return new GameLaunchPlanError("WORLD_METADATA_MALFORMED", `Game world metadata is malformed: ${metaPath}`);
  }
  return new GameLaunchPlanError("WORLD_METADATA_UNREADABLE", `Game world metadata is unreadable: ${metaPath}`);
}

function discoverWorld(
  project: CanonicalProjectIdentity,
  limits: GameWorldDiscoveryLimits,
  testHooks?: GameWorldPlanTestHooks,
): { readonly path: string; readonly selection: DiscoveredGameWorldSelection } {
  let root: string;
  try {
    root = resolveManagedPath(project.modDirectory, join(project.modDirectory, "Worlds"), "no-links");
  } catch (error) {
    if (error instanceof ManagedPathError && error.reason === "root_missing") {
      throw new GameLaunchPlanError("WORLD_NOT_FOUND", "The selected project has no Worlds directory. Provide an explicit registered .ent world.");
    }
    throw unsafeWorld("The project Worlds directory is not a safe non-link directory.", error);
  }
  try {
    const rootInfo = lstatSync(root, { bigint: true });
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw unsafeWorld(`The project Worlds path is not a regular non-link directory: ${root}`);
    }
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GameLaunchPlanError("WORLD_NOT_FOUND", "The selected project has no Worlds directory. Provide an explicit registered .ent world.");
    }
    throw new GameLaunchPlanError("WORLD_SCAN_UNSTABLE", `The project Worlds directory cannot be inspected: ${root}`, { cause: error });
  }

  const state: MutableDiscoveryState = {
    project,
    root,
    limits,
    candidates: [],
    directories: [],
    testHooks,
    visitedEntries: 0,
    verificationEntries: 0,
    metadataBytes: 0,
  };
  scanDirectory(root, 0, state);
  state.candidates.sort((left, right) => left.path.localeCompare(right.path, "en", { sensitivity: "case" }));
  state.directories.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en", { sensitivity: "case" }));

  if (state.candidates.length === 0) {
    throw new GameLaunchPlanError(
      "WORLD_REQUIRED",
      "No .ent world was found in the selected project. Provide an explicit registered world.",
    );
  }
  if (state.candidates.length > 1) {
    throw new GameLaunchPlanError(
      "WORLD_AMBIGUOUS",
      "More than one project world is available. Provide one exact .ent path or formed resource reference.",
      { candidates: state.candidates.slice(0, limits.maximumDiagnosticCandidates) },
    );
  }
  const candidate = state.candidates[0];
  if (candidate.status === "unregistered") {
    throw new GameLaunchPlanError(
      "WORLD_UNREGISTERED",
      `The only project world is not registered: ${candidate.absolutePath}`,
      {
        details: { worldPath: candidate.absolutePath },
        candidates: [candidate],
        remedy: {
          kind: "register_world",
          projectPath: project.displayPath,
          worldPath: candidate.absolutePath,
        },
      },
    );
  }
  if (candidate.status !== "registered") throw metadataStatusError(candidate);
  const selection: DiscoveredGameWorldSelection = {
    kind: "discovered",
    limits,
    visitedEntries: state.visitedEntries,
    verificationEntries: state.verificationEntries,
    candidateCount: state.candidates.length,
    metadataBytes: state.metadataBytes,
    directories: state.directories,
  };
  return { path: candidate.absolutePath, selection };
}

function resolveOptions(
  value: ResolveGameWorldPlanOptions | CanonicalProjectIdentity,
  world: string | null | undefined,
  overrides: Partial<GameWorldDiscoveryLimits> | undefined,
): ResolveGameWorldPlanOptions {
  if ("project" in value) return value;
  return { project: value, world, discoveryLimits: overrides };
}

export function resolveGameWorldPlan(options: ResolveGameWorldPlanOptions): GameWorldPlanSnapshot;
export function resolveGameWorldPlan(
  project: CanonicalProjectIdentity,
  world?: string | null,
  discoveryLimits?: Partial<GameWorldDiscoveryLimits>,
): GameWorldPlanSnapshot;
/** Resolve one exact registered project-contained world and capture its proof. */
export function resolveGameWorldPlan(
  value: ResolveGameWorldPlanOptions | CanonicalProjectIdentity,
  world?: string | null,
  overrides?: Partial<GameWorldDiscoveryLimits>,
): GameWorldPlanSnapshot {
  const options = resolveOptions(value, world, overrides);
  const project = assertCanonicalProject(options.project);
  if (options.world === undefined || options.world === null) {
    const discovered = discoverWorld(project, discoveryLimits(options.discoveryLimits), options.testHooks);
    return buildSnapshot(project, discovered.path, discovered.selection, options.testHooks);
  }
  const parsed = parseWorldInput(project, options.world);
  return buildSnapshot(project, parsed.requestedPath, {
    kind: "explicit",
    inputKind: parsed.inputKind,
    suppliedGuid: parsed.suppliedGuid,
  }, options.testHooks);
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

function validIdentity(value: unknown, shaRequired: boolean): boolean {
  if (!plainRecord(value) || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) return false;
  for (const field of ["device", "inode", "modifiedNanoseconds", "changedNanoseconds", "birthNanoseconds"] as const) {
    if (typeof value[field] !== "string" || !/^\d+$/.test(value[field] as string)) return false;
  }
  if (/^0+$/.test(value.device as string) || /^0+$/.test(value.inode as string)) return false;
  if (!shaRequired) return true;
  return typeof value.volumeIdentity === "string" && /^[1-9]\d*$/.test(value.volumeIdentity) &&
    typeof value.fileId === "string" && /^[1-9]\d*$/.test(value.fileId) &&
    typeof value.sha256 === "string" && SHA256.test(value.sha256);
}

function validProject(value: unknown): value is CanonicalProjectIdentity {
  return plainRecord(value) &&
    typeof value.displayPath === "string" && isAbsolute(value.displayPath) &&
    typeof value.comparisonKey === "string" && value.comparisonKey === value.displayPath &&
    typeof value.modDirectory === "string" && isAbsolute(value.modDirectory) &&
    typeof value.modDirectoryKey === "string" && value.modDirectoryKey === value.modDirectory;
}

function validLimits(value: unknown): value is GameWorldDiscoveryLimits {
  return plainRecord(value) &&
    validPositiveLimit(value.maximumDepth) &&
    validPositiveLimit(value.maximumVisitedEntries) &&
    validPositiveLimit(value.maximumCandidates) &&
    validPositiveLimit(value.maximumMetadataBytes) &&
    validPositiveLimit(value.maximumDiagnosticCandidates);
}

function validSelection(value: unknown): value is GameWorldSelectionEvidence {
  if (!plainRecord(value)) return false;
  if (value.kind === "explicit") {
    if (value.inputKind === "formed") {
      return typeof value.suppliedGuid === "string" && GUID.test(value.suppliedGuid);
    }
    return (value.inputKind === "absolute" || value.inputKind === "relative") && value.suppliedGuid === null;
  }
  if (value.kind !== "discovered" || !validLimits(value.limits) ||
      !Number.isSafeInteger(value.visitedEntries) || (value.visitedEntries as number) < 0 ||
      !Number.isSafeInteger(value.verificationEntries) || (value.verificationEntries as number) < 0 ||
      !Number.isSafeInteger(value.candidateCount) || (value.candidateCount as number) < 0 ||
      !Number.isSafeInteger(value.metadataBytes) || (value.metadataBytes as number) < 0 ||
      !Array.isArray(value.directories) || value.directories.length > (value.limits.maximumVisitedEntries as number) ||
      (value.visitedEntries as number) > (value.limits.maximumVisitedEntries as number) ||
      (value.verificationEntries as number) > (value.limits.maximumVisitedEntries as number) ||
      (value.candidateCount as number) !== 1 ||
      (value.candidateCount as number) > (value.limits.maximumCandidates as number) ||
      (value.metadataBytes as number) > (value.limits.maximumMetadataBytes as number)) return false;
  return value.directories.every((directory) =>
    validIdentity(directory, false) && plainRecord(directory) &&
    typeof directory.relativePath === "string" && directory.relativePath.length > 0 &&
    typeof directory.listingDigest === "string" && SHA256.test(directory.listingDigest));
}

function assertSnapshot(value: unknown): asserts value is GameWorldPlanSnapshot {
  if (!plainRecord(value) || value.schemaVersion !== GAME_WORLD_EVIDENCE_SCHEMA_VERSION ||
      !validProject(value.project) ||
      typeof value.worldPath !== "string" || !isAbsolute(value.worldPath) ||
      typeof value.metaPath !== "string" || !isAbsolute(value.metaPath) ||
      resolve(`${value.worldPath}.meta`) !== resolve(value.metaPath) ||
      !isCanonicalPathContained(value.project.modDirectory, value.worldPath) ||
      !isCanonicalPathContained(value.project.modDirectory, value.metaPath) ||
      !validIdentity(value.projectFile, true) ||
      !validIdentity(value.worldFile, true) ||
      !validIdentity(value.metaFile, true) ||
      typeof value.guid !== "string" || !GUID.test(value.guid) ||
      typeof value.relativePath !== "string" || value.relativePath.length === 0 || /\\/.test(value.relativePath) ||
      value.relativePath === ".." || value.relativePath.startsWith("../") || isAbsolute(value.relativePath) ||
      normalizeRelativePath(relative(value.project.modDirectory, value.worldPath)) !== value.relativePath ||
      typeof value.resourceReference !== "string" || value.resourceReference !== `{${value.guid}}${value.relativePath}` ||
      !validSelection(value.selection) ||
      typeof value.worldEvidenceDigest !== "string" || !SHA256.test(value.worldEvidenceDigest)) {
    throw new GameLaunchPlanError(
      "WORLD_EVIDENCE_INVALID",
      "Stored game world evidence does not satisfy its schema.",
    );
  }
}

/** Re-attest an original snapshot; never substitute newly selected evidence. */
export function revalidateGameWorldPlan(snapshot: unknown): GameWorldPlanSnapshot {
  try {
    assertSnapshot(snapshot);
  } catch (error) {
    if (error instanceof GameLaunchPlanError) throw error;
    throw new GameLaunchPlanError(
      "WORLD_EVIDENCE_INVALID",
      "Stored game world evidence could not be inspected safely.",
      { cause: error },
    );
  }
  let storedDigest: string;
  try {
    storedDigest = computeGameWorldEvidenceDigest(snapshot);
  } catch (error) {
    throw new GameLaunchPlanError(
      "WORLD_EVIDENCE_INVALID",
      "Stored game world evidence could not be digested.",
      { cause: error },
    );
  }
  if (storedDigest !== snapshot.worldEvidenceDigest) {
    throw new GameLaunchPlanError(
      "WORLD_EVIDENCE_INVALID",
      "Stored game world evidence digest does not match its proof fields.",
    );
  }

  let current: GameWorldPlanSnapshot;
  try {
    if (snapshot.selection.kind === "discovered") {
      current = resolveGameWorldPlan({
        project: snapshot.project,
        discoveryLimits: snapshot.selection.limits,
      });
    } else {
      current = buildSnapshot(
        assertCanonicalProject(snapshot.project),
        snapshot.worldPath,
        snapshot.selection,
      );
    }
  } catch (error) {
    if (error instanceof GameLaunchPlanError && error.code === "WORLD_EVIDENCE_INVALID") throw error;
    throw changed("Game world evidence could not be revalidated against the original snapshot.", error);
  }
  if (current.worldEvidenceDigest !== snapshot.worldEvidenceDigest) {
    throw changed("Game world evidence changed after launch planning.");
  }
  return current;
}

/** Compatibility alias for callers that use planning terminology. */
export const planGameWorld = resolveGameWorldPlan;
