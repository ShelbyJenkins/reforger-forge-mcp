import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKBENCH_HELPER_SOURCE_MANIFEST =
  ".reforger-forge-workbench-helper-source.json" as const;
export const WORKBENCH_HELPER_ADDON_ID = "ReforgerForgeWorkbenchHelper" as const;
export const WORKBENCH_HELPER_ADDON_GUID = "4D74249D90703F46" as const;
export const WORKBENCH_HELPER_ADDON_VERSION = "0.1.0" as const;
export const WORKBENCH_HELPER_PROTOCOL_VERSION = "2.0" as const;
/** Content identity of the helper payload, excluding only its generated identity source. */
export const WORKBENCH_HELPER_BUILD_IDENTITY =
  "1c23de814274c130d32b665a84e6be3ee1a69a5747759fdba54a684e998936b3" as const;
export const WORKBENCH_HELPER_HANDLER_FILES = [
  "EMCP_WB_Clipboard.c",
  "EMCP_WB_Components.c",
  "EMCP_WB_CreateEntity.c",
  "EMCP_WB_DeleteEntity.c",
  "EMCP_WB_EditorControl.c",
  "EMCP_WB_ExecuteAction.c",
  "EMCP_WB_GetCameraPos.c",
  "EMCP_WB_GetEntity.c",
  "EMCP_WB_GetState.c",
  "EMCP_WB_Layers.c",
  "EMCP_WB_ListEntities.c",
  "EMCP_WB_Localization.c",
  "EMCP_WB_ModifyEntity.c",
  "EMCP_WB_ObserverCancel.c",
  "EMCP_WB_ObserverCommon.c",
  "EMCP_WB_ObserverPing.c",
  "EMCP_WB_ObserverRelease.c",
  "EMCP_WB_ObserverStatus.c",
  "EMCP_WB_ObserverSubmit.c",
  "EMCP_WB_Ping.c",
  "EMCP_WB_Prefabs.c",
  "EMCP_WB_Reload.c",
  "EMCP_WB_Resources.c",
  "EMCP_WB_ScriptEditor.c",
  "EMCP_WB_SelectEntity.c",
  "EMCP_WB_Terrain.c",
] as const;
const WORKBENCH_HELPER_PAYLOAD_FILES = [
  "addon.gproj",
  ...WORKBENCH_HELPER_HANDLER_FILES.map((name) =>
    `Scripts/WorkbenchGame/EnfusionMCP/${name}`
  ),
  "Scripts/WorkbenchGame/EnfusionMCP/RFWB_HelperBuild.c",
] as const;
/** Workbench creates this cache beside addon.gproj after loading a staged add-on. */
const WORKBENCH_GENERATED_STAGED_FILES = new Set(["resourceDatabase.rdb"]);

export interface WorkbenchHelperDescriptor {
  readonly role: "workbench-helper";
  readonly addonId: typeof WORKBENCH_HELPER_ADDON_ID;
  readonly addonGuid: typeof WORKBENCH_HELPER_ADDON_GUID;
  readonly addonVersion: typeof WORKBENCH_HELPER_ADDON_VERSION;
  readonly protocolVersion: typeof WORKBENCH_HELPER_PROTOCOL_VERSION;
  readonly buildIdentity: typeof WORKBENCH_HELPER_BUILD_IDENTITY;
  readonly sourceManifestName: typeof WORKBENCH_HELPER_SOURCE_MANIFEST;
}

export const WORKBENCH_HELPER_DESCRIPTOR = Object.freeze({
  role: "workbench-helper",
  addonId: WORKBENCH_HELPER_ADDON_ID,
  addonGuid: WORKBENCH_HELPER_ADDON_GUID,
  addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
  protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
  buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
  sourceManifestName: WORKBENCH_HELPER_SOURCE_MANIFEST,
} satisfies WorkbenchHelperDescriptor);

export interface WorkbenchHelperManifestFile {
  readonly path: string;
  readonly sha256: string;
}

export interface WorkbenchHelperSourceManifest {
  readonly manifestVersion: 1;
  readonly role: "workbench-helper";
  readonly addonVersion: typeof WORKBENCH_HELPER_ADDON_VERSION;
  readonly protocolVersion: typeof WORKBENCH_HELPER_PROTOCOL_VERSION;
  readonly addonId: typeof WORKBENCH_HELPER_ADDON_ID;
  readonly addonGuid: typeof WORKBENCH_HELPER_ADDON_GUID;
  readonly buildIdentity: typeof WORKBENCH_HELPER_BUILD_IDENTITY;
  readonly bundleDigest: string;
  readonly files: readonly WorkbenchHelperManifestFile[];
}

export interface WorkbenchCompanionLaunch {
  readonly addonId: typeof WORKBENCH_HELPER_ADDON_ID;
  readonly addonGuid: typeof WORKBENCH_HELPER_ADDON_GUID;
  readonly addonVersion: typeof WORKBENCH_HELPER_ADDON_VERSION;
  readonly protocolVersion: typeof WORKBENCH_HELPER_PROTOCOL_VERSION;
  readonly buildIdentity: typeof WORKBENCH_HELPER_BUILD_IDENTITY;
  readonly bundleDigest: string;
  readonly addonDirectory: string;
  readonly addonSearchRoot: string;
  readonly workbenchProfilePath: string;
  readonly reused: boolean;
}

export interface WorkbenchCompanionProvider {
  /**
   * Verify and stage the fixed helper bundle. When supplied, targetProjectPath
   * is checked for overlap before any managed directory is created.
   */
  ensureStaged(targetProjectPath?: string): WorkbenchCompanionLaunch;

  /**
   * Re-attest an already staged descriptor immediately before it is trusted.
   * Production providers must verify the exact manifest, payload hashes, and
   * managed path identities; the optional shape keeps narrow test doubles
   * lightweight.
   */
  verifyStaged?(
    companion: WorkbenchCompanionLaunch,
    targetProjectPath?: string
  ): WorkbenchCompanionLaunch;
  /** Re-verify the immutable packaged source and require its digest to remain exact. */
  verifySourceDigest?(expectedBundleDigest: string): string;
  status?(): WorkbenchCompanionManagedStatus;
  applyRetention?(options?: WorkbenchCompanionRetentionOptions): WorkbenchCompanionRetentionResult;
  uninstall?(): WorkbenchCompanionUninstallResult;
}

export interface WorkbenchCompanionRetentionOptions {
  readonly maxAgeMs?: number;
  readonly maxBytes?: number;
  readonly protectedDigests?: readonly string[];
  readonly nowMs?: number;
}

export interface WorkbenchCompanionManagedStatus {
  readonly installed: boolean;
  readonly managedRoot: string;
  readonly roleRoot: string;
  readonly currentBundleDigest: string;
  readonly stagedDigests: readonly string[];
  readonly managedBytes: number;
  readonly staleCaptureCount: number;
  readonly warnings: readonly string[];
}

export interface WorkbenchCompanionRetentionResult {
  readonly removedDigestRoots: readonly string[];
  readonly removedCaptureFiles: readonly string[];
  readonly removedTemporaryRoots: readonly string[];
  readonly reclaimedBytes: number;
  readonly remainingBytes: number;
}

export interface WorkbenchCompanionUninstallResult {
  readonly removed: boolean;
  readonly roleRoot: string;
}

export interface WorkbenchHelperStagerOptions {
  /** External MCP-managed root; never use a project or add-on directory. */
  readonly managedRoot: string;
  /** Package-source override for tests or an embedding host. */
  readonly sourceDirectory?: string;
  /** Optional target binding applied to every ensureStaged call. */
  readonly targetProjectPath?: string;
}

export type WorkbenchHelperStageErrorCode =
  | "WORKBENCH_HELPER_SOURCE_INVALID"
  | "WORKBENCH_HELPER_STAGE_CONFLICT"
  | "WORKBENCH_HELPER_PATH_UNSAFE";

export class WorkbenchHelperStageError extends Error {
  constructor(
    message: string,
    public readonly code: WorkbenchHelperStageErrorCode
  ) {
    super(message);
    this.name = "WorkbenchHelperStageError";
  }
}

interface VerifiedHelperBundle {
  readonly sourceDirectory: string;
  readonly manifest: WorkbenchHelperSourceManifest;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PAYLOAD_PATTERN = /^[A-Za-z0-9._/-]+$/;
const DEFAULT_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_MAX_BYTES = 512 * 1024 * 1024;
const TEMPORARY_STAGE_MAX_AGE_MS = 60 * 60 * 1_000;

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function defaultWorkbenchHelperSource(): string {
  return join(packageRoot(), "observer", "workbench-addon");
}

/** Share the observer v1 external managed root without importing its private agent build. */
export function defaultWorkbenchHelperManagedRoot(): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "ReforgerForge", "Observer", "v1");
  }
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, "reforger-forge", "observer", "v1");
  }
  return join(homedir(), ".local", "state", "reforger-forge", "observer", "v1");
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return isContained(left, right) || isContained(right, left);
}

/** Canonicalize all existing path segments without creating the requested path. */
function potentialCanonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  return resolve(canonicalExisting, relative(existing, absolute));
}

function canonicalDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(path));
  } catch {
    throw new WorkbenchHelperStageError(
      `${label} does not exist or cannot be resolved: ${resolve(path)}`,
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
  }
  if (!statSync(canonical).isDirectory()) {
    throw new WorkbenchHelperStageError(
      `${label} is not a directory: ${canonical}`,
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
  }
  return canonical;
}

function ensureCanonicalDirectory(path: string): string {
  mkdirSync(resolve(path), { recursive: true, mode: 0o700 });
  return canonicalDirectory(path, "Workbench helper managed directory");
}

function assertContainedPath(root: string, candidate: string): void {
  const canonicalRoot = canonicalDirectory(root, "Workbench helper managed root");
  const absolute = resolve(candidate);
  if (!isContained(canonicalRoot, absolute)) {
    throw new WorkbenchHelperStageError(
      `Workbench helper path escapes its managed root: ${absolute}`,
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
  }
  const rel = relative(canonicalRoot, absolute);
  let current = canonicalRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const canonical = realpathSync.native(current);
    if (!isContained(canonicalRoot, canonical)) {
      throw new WorkbenchHelperStageError(
        `Workbench helper path traverses a link outside its managed root: ${current}`,
        "WORKBENCH_HELPER_PATH_UNSAFE"
      );
    }
  }
}

function targetDirectory(targetProjectPath: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(targetProjectPath));
  } catch {
    throw new WorkbenchHelperStageError(
      `Workbench target does not exist or cannot be resolved: ${resolve(targetProjectPath)}`,
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
  }
  const info = statSync(canonical);
  if (info.isDirectory()) return canonical;
  if (info.isFile()) return dirname(canonical);
  throw new WorkbenchHelperStageError(
    `Workbench target is not a regular project file or directory: ${canonical}`,
    "WORKBENCH_HELPER_PATH_UNSAFE"
  );
}

function assertSafePayloadPath(path: unknown): path is string {
  if (typeof path !== "string" || !SAFE_PAYLOAD_PATTERN.test(path) ||
      path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function computeWorkbenchHelperBundleDigest(
  files: readonly WorkbenchHelperManifestFile[]
): string {
  const aggregate = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    aggregate.update(file.path, "utf8");
    aggregate.update("\0", "utf8");
    aggregate.update(file.sha256, "ascii");
    aggregate.update("\n", "utf8");
  }
  return aggregate.digest("hex");
}

function listPayloadFiles(root: string, conflict: boolean): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new WorkbenchHelperStageError(
          `Workbench helper bundle contains a symbolic link: ${rel}`,
          conflict ? "WORKBENCH_HELPER_STAGE_CONFLICT" : "WORKBENCH_HELPER_SOURCE_INVALID"
        );
      }
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files.push(rel);
      else {
        throw new WorkbenchHelperStageError(
          `Workbench helper bundle contains a non-regular entry: ${rel}`,
          conflict ? "WORKBENCH_HELPER_STAGE_CONFLICT" : "WORKBENCH_HELPER_SOURCE_INVALID"
        );
      }
    }
  };
  visit(root);
  return files;
}

function parseManifest(path: string, conflict: boolean): WorkbenchHelperSourceManifest {
  const code = conflict ? "WORKBENCH_HELPER_STAGE_CONFLICT" : "WORKBENCH_HELPER_SOURCE_INVALID";
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new WorkbenchHelperStageError(`Workbench helper manifest is missing or malformed: ${path}`, code);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkbenchHelperStageError("Workbench helper manifest root must be an object", code);
  }
  const record = value as Record<string, unknown>;
  if (record.manifestVersion !== 1 || record.role !== WORKBENCH_HELPER_DESCRIPTOR.role ||
      record.addonId !== WORKBENCH_HELPER_ADDON_ID ||
      record.addonGuid !== WORKBENCH_HELPER_ADDON_GUID ||
      record.addonVersion !== WORKBENCH_HELPER_ADDON_VERSION ||
      record.protocolVersion !== WORKBENCH_HELPER_PROTOCOL_VERSION ||
      record.buildIdentity !== WORKBENCH_HELPER_BUILD_IDENTITY ||
      typeof record.bundleDigest !== "string" || !SHA256_PATTERN.test(record.bundleDigest) ||
      !Array.isArray(record.files) || record.files.length === 0) {
    throw new WorkbenchHelperStageError(
      "Workbench helper manifest does not match the supported companion identity",
      code
    );
  }
  const files: WorkbenchHelperManifestFile[] = [];
  const seen = new Set<string>();
  for (const raw of record.files) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new WorkbenchHelperStageError("Workbench helper manifest contains an invalid file entry", code);
    }
    const entry = raw as Record<string, unknown>;
    if (!assertSafePayloadPath(entry.path) || typeof entry.sha256 !== "string" ||
        !SHA256_PATTERN.test(entry.sha256)) {
      throw new WorkbenchHelperStageError("Workbench helper manifest contains an unsafe file entry", code);
    }
    const key = entry.path.toLowerCase();
    if (seen.has(key) || entry.path === WORKBENCH_HELPER_SOURCE_MANIFEST) {
      throw new WorkbenchHelperStageError(
        `Workbench helper manifest repeats or manages a reserved path: ${entry.path}`,
        code
      );
    }
    seen.add(key);
    files.push({ path: entry.path, sha256: entry.sha256 });
  }
  const payloadPaths = files.map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
  const requiredPayloadPaths = [...WORKBENCH_HELPER_PAYLOAD_FILES]
    .sort((left, right) => left.localeCompare(right));
  if (payloadPaths.length !== requiredPayloadPaths.length ||
      payloadPaths.some((path, index) => path !== requiredPayloadPaths[index])) {
    throw new WorkbenchHelperStageError(
      "Workbench helper manifest does not contain the exact supported helper payload",
      code
    );
  }
  if (computeWorkbenchHelperBundleDigest(files) !== record.bundleDigest) {
    throw new WorkbenchHelperStageError("Workbench helper aggregate bundle digest is invalid", code);
  }
  return {
    manifestVersion: 1,
    role: "workbench-helper",
    addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
    protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
    addonId: WORKBENCH_HELPER_ADDON_ID,
    addonGuid: WORKBENCH_HELPER_ADDON_GUID,
    buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
    bundleDigest: record.bundleDigest,
    files,
  };
}

function verifyCompiledHelperIdentity(directory: string, conflict: boolean): void {
  const code = conflict ? "WORKBENCH_HELPER_STAGE_CONFLICT" : "WORKBENCH_HELPER_SOURCE_INVALID";
  const gproj = readFileSync(join(directory, "addon.gproj"), "utf8");
  const build = readFileSync(
    join(directory, "Scripts", "WorkbenchGame", "EnfusionMCP", "RFWB_HelperBuild.c"),
    "utf8"
  );
  const ping = readFileSync(
    join(directory, "Scripts", "WorkbenchGame", "EnfusionMCP", "EMCP_WB_Ping.c"),
    "utf8"
  );
  const requiredDeclarations = [
    [gproj, `ID ${WORKBENCH_HELPER_ADDON_ID}`],
    [gproj, `GUID "${WORKBENCH_HELPER_ADDON_GUID}"`],
    [build, `ADDON_ID = "${WORKBENCH_HELPER_ADDON_ID}"`],
    [build, `ADDON_GUID = "${WORKBENCH_HELPER_ADDON_GUID}"`],
    [build, `ADDON_VERSION = "${WORKBENCH_HELPER_ADDON_VERSION}"`],
    [build, `PROTOCOL_VERSION = "${WORKBENCH_HELPER_PROTOCOL_VERSION}"`],
    [build, `IDENTITY = "${WORKBENCH_HELPER_BUILD_IDENTITY}"`],
    [ping, "resp.helperAddonId = RFWB_HelperBuild.ADDON_ID"],
    [ping, "resp.helperAddonGuid = RFWB_HelperBuild.ADDON_GUID"],
    [ping, "resp.helperAddonVersion = RFWB_HelperBuild.ADDON_VERSION"],
    [ping, "resp.helperProtocolVersion = RFWB_HelperBuild.PROTOCOL_VERSION"],
    [ping, "resp.helperBuildIdentity = RFWB_HelperBuild.IDENTITY"],
  ] as const;
  if (requiredDeclarations.some(([source, declaration]) => !source.includes(declaration))) {
    throw new WorkbenchHelperStageError(
      "Workbench helper compiled identity does not match its fixed package descriptor",
      code
    );
  }
}

export function verifyWorkbenchHelperSource(sourceDirectory: string): VerifiedHelperBundle {
  return verifyBundleDirectory(sourceDirectory, false);
}

function verifyBundleDirectory(
  directoryPath: string,
  conflict: boolean,
  expectedDigest?: string,
  allowGeneratedStagedFiles = false
): VerifiedHelperBundle {
  const code = conflict ? "WORKBENCH_HELPER_STAGE_CONFLICT" : "WORKBENCH_HELPER_SOURCE_INVALID";
  let directory: string;
  try {
    directory = realpathSync.native(resolve(directoryPath));
  } catch {
    throw new WorkbenchHelperStageError(
      `Workbench helper ${conflict ? "staged bundle" : "source"} is unavailable: ${resolve(directoryPath)}`,
      code
    );
  }
  if (!statSync(directory).isDirectory()) {
    throw new WorkbenchHelperStageError(`Workbench helper bundle is not a directory: ${directory}`, code);
  }
  const manifestPath = join(directory, WORKBENCH_HELPER_SOURCE_MANIFEST);
  if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink() ||
      !lstatSync(manifestPath).isFile()) {
    throw new WorkbenchHelperStageError(`Workbench helper manifest is unavailable: ${manifestPath}`, code);
  }
  const manifest = parseManifest(manifestPath, conflict);
  if (expectedDigest && manifest.bundleDigest !== expectedDigest) {
    throw new WorkbenchHelperStageError(
      "Staged Workbench helper digest does not match its content-addressed directory",
      "WORKBENCH_HELPER_STAGE_CONFLICT"
    );
  }
  const actual = listPayloadFiles(directory, conflict)
    .filter((path) => path !== WORKBENCH_HELPER_SOURCE_MANIFEST)
    .filter((path) =>
      !(allowGeneratedStagedFiles && WORKBENCH_GENERATED_STAGED_FILES.has(path)))
    .sort((left, right) => left.localeCompare(right));
  const expected = manifest.files.map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new WorkbenchHelperStageError(
      "Workbench helper payload is incomplete or contains unexpected files",
      code
    );
  }
  for (const file of manifest.files) {
    const payload = join(directory, ...file.path.split("/"));
    if (lstatSync(payload).isSymbolicLink() || !lstatSync(payload).isFile() ||
        sha256File(payload) !== file.sha256) {
      throw new WorkbenchHelperStageError(`Workbench helper payload hash mismatch: ${file.path}`, code);
    }
  }
  verifyCompiledHelperIdentity(directory, conflict);
  return { sourceDirectory: directory, manifest };
}

interface ManagedEntryUsage {
  readonly path: string;
  readonly bytes: number;
  readonly modifiedAtMs: number;
}

function managedTreeUsage(root: string): ManagedEntryUsage {
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new WorkbenchHelperStageError(
      `Managed Workbench helper entry is not a regular directory: ${root}`,
      "WORKBENCH_HELPER_STAGE_CONFLICT"
    );
  }
  let bytes = 0;
  let modifiedAtMs = rootInfo.mtimeMs;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new WorkbenchHelperStageError(
          `Managed Workbench helper tree contains a symbolic link: ${path}`,
          "WORKBENCH_HELPER_STAGE_CONFLICT"
        );
      }
      modifiedAtMs = Math.max(modifiedAtMs, info.mtimeMs);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) bytes += info.size;
      else {
        throw new WorkbenchHelperStageError(
          `Managed Workbench helper tree contains a non-regular entry: ${path}`,
          "WORKBENCH_HELPER_STAGE_CONFLICT"
        );
      }
    }
  };
  visit(root);
  return { path: root, bytes, modifiedAtMs };
}

function boundedRetentionInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new WorkbenchHelperStageError(
      `${label} must be a positive safe integer`,
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
  }
  return selected;
}

export class WorkbenchHelperStager implements WorkbenchCompanionProvider {
  readonly managedRoot: string;
  readonly sourceDirectory: string;
  readonly targetProjectPath?: string;

  constructor(options: WorkbenchHelperStagerOptions) {
    if (!options || typeof options.managedRoot !== "string" || options.managedRoot.trim().length === 0) {
      throw new WorkbenchHelperStageError(
        "Workbench helper managed root must be a nonempty path",
        "WORKBENCH_HELPER_PATH_UNSAFE"
      );
    }
    this.managedRoot = resolve(options.managedRoot);
    this.sourceDirectory = resolve(options.sourceDirectory ?? defaultWorkbenchHelperSource());
    this.targetProjectPath = options.targetProjectPath;
  }

  ensureStaged(targetProjectPath = this.targetProjectPath): WorkbenchCompanionLaunch {
    const prospectiveManagedRoot = potentialCanonicalPath(this.managedRoot);
    const prospectiveSource = potentialCanonicalPath(this.sourceDirectory);
    if (pathsOverlap(prospectiveManagedRoot, prospectiveSource)) {
      throw new WorkbenchHelperStageError(
        "Workbench helper managed root must not overlap its immutable package source",
        "WORKBENCH_HELPER_PATH_UNSAFE"
      );
    }
    const targets = [...new Set([this.targetProjectPath, targetProjectPath].filter(
      (target): target is string => typeof target === "string" && target.length > 0
    ))];
    for (const target of targets) {
      const projectDirectory = targetDirectory(target);
      if (pathsOverlap(projectDirectory, prospectiveManagedRoot)) {
        throw new WorkbenchHelperStageError(
          "Workbench helper managed, staging, and profile roots must not overlap the target project",
          "WORKBENCH_HELPER_PATH_UNSAFE"
        );
      }
    }

    const source = verifyWorkbenchHelperSource(this.sourceDirectory);
    const managedRoot = ensureCanonicalDirectory(this.managedRoot);
    const roleRoot = ensureCanonicalDirectory(join(managedRoot, "workbench-helper"));
    assertContainedPath(managedRoot, roleRoot);
    const addonsRoot = ensureCanonicalDirectory(join(roleRoot, "addons"));
    assertContainedPath(roleRoot, addonsRoot);
    const profilePath = ensureCanonicalDirectory(join(roleRoot, "profile"));
    assertContainedPath(roleRoot, profilePath);

    const digestRoot = join(addonsRoot, source.manifest.bundleDigest);
    const addonDirectory = join(digestRoot, WORKBENCH_HELPER_ADDON_ID);
    assertContainedPath(addonsRoot, addonDirectory);
    if (existsSync(addonDirectory)) {
      verifyBundleDirectory(addonDirectory, true, source.manifest.bundleDigest, true);
      return this.launchDescriptor(source.manifest.bundleDigest, addonDirectory, digestRoot, profilePath, true);
    }
    if (existsSync(digestRoot)) {
      throw new WorkbenchHelperStageError(
        `Workbench helper digest directory exists without its verified add-on: ${digestRoot}`,
        "WORKBENCH_HELPER_STAGE_CONFLICT"
      );
    }

    const temporaryRoot = join(addonsRoot, `.${source.manifest.bundleDigest}.${randomUUID()}.tmp`);
    const temporaryAddon = join(temporaryRoot, WORKBENCH_HELPER_ADDON_ID);
    try {
      mkdirSync(temporaryAddon, { recursive: true, mode: 0o700 });
      for (const file of source.manifest.files) {
        const from = join(source.sourceDirectory, ...file.path.split("/"));
        const to = join(temporaryAddon, ...file.path.split("/"));
        assertContainedPath(temporaryRoot, to);
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        copyFileSync(from, to);
      }
      copyFileSync(
        join(source.sourceDirectory, WORKBENCH_HELPER_SOURCE_MANIFEST),
        join(temporaryAddon, WORKBENCH_HELPER_SOURCE_MANIFEST)
      );
      verifyBundleDirectory(temporaryAddon, true, source.manifest.bundleDigest);
      try {
        renameSync(temporaryRoot, digestRoot);
      } catch (error) {
        if (!existsSync(addonDirectory)) throw error;
        verifyBundleDirectory(addonDirectory, true, source.manifest.bundleDigest, true);
        rmSync(temporaryRoot, { recursive: true, force: true });
        return this.launchDescriptor(source.manifest.bundleDigest, addonDirectory, digestRoot, profilePath, true);
      }
      return this.launchDescriptor(source.manifest.bundleDigest, addonDirectory, digestRoot, profilePath, false);
    } catch (error) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      if (error instanceof WorkbenchHelperStageError) throw error;
      throw new WorkbenchHelperStageError(
        `Could not stage the Workbench helper add-on: ${error instanceof Error ? error.message : String(error)}`,
        "WORKBENCH_HELPER_STAGE_CONFLICT"
      );
    }
  }

  verifyStaged(
    companion: WorkbenchCompanionLaunch,
    targetProjectPath = this.targetProjectPath
  ): WorkbenchCompanionLaunch {
    if (companion.addonId !== WORKBENCH_HELPER_ADDON_ID ||
        companion.addonGuid !== WORKBENCH_HELPER_ADDON_GUID ||
        companion.addonVersion !== WORKBENCH_HELPER_ADDON_VERSION ||
        companion.protocolVersion !== WORKBENCH_HELPER_PROTOCOL_VERSION ||
        companion.buildIdentity !== WORKBENCH_HELPER_BUILD_IDENTITY ||
        !SHA256_PATTERN.test(companion.bundleDigest)) {
      throw new WorkbenchHelperStageError(
        "Workbench helper descriptor does not match the supported companion identity",
        "WORKBENCH_HELPER_STAGE_CONFLICT"
      );
    }

    const managedRoot = canonicalDirectory(this.managedRoot, "Workbench helper managed root");
    const roleRoot = canonicalDirectory(join(managedRoot, "workbench-helper"), "Workbench helper role root");
    const addonsRoot = canonicalDirectory(join(roleRoot, "addons"), "Workbench helper add-ons root");
    const expectedSearchRoot = canonicalDirectory(
      join(addonsRoot, companion.bundleDigest),
      "Workbench helper digest root"
    );
    const expectedAddonDirectory = canonicalDirectory(
      join(expectedSearchRoot, WORKBENCH_HELPER_ADDON_ID),
      "Workbench helper add-on directory"
    );
    const expectedProfile = canonicalDirectory(join(roleRoot, "profile"), "Workbench helper profile root");
    const actualSearchRoot = canonicalDirectory(companion.addonSearchRoot, "Recorded Workbench helper search root");
    const actualAddonDirectory = canonicalDirectory(companion.addonDirectory, "Recorded Workbench helper add-on directory");
    const actualProfile = canonicalDirectory(companion.workbenchProfilePath, "Recorded Workbench helper profile root");

    if (pathKey(actualSearchRoot) !== pathKey(expectedSearchRoot) ||
        pathKey(actualAddonDirectory) !== pathKey(expectedAddonDirectory) ||
        pathKey(actualProfile) !== pathKey(expectedProfile)) {
      throw new WorkbenchHelperStageError(
        "Recorded Workbench helper paths do not match the content-addressed managed layout",
        "WORKBENCH_HELPER_STAGE_CONFLICT"
      );
    }
    assertContainedPath(managedRoot, actualSearchRoot);
    assertContainedPath(managedRoot, actualAddonDirectory);
    assertContainedPath(managedRoot, actualProfile);
    if (targetProjectPath) {
      const projectDirectory = targetDirectory(targetProjectPath);
      if (pathsOverlap(projectDirectory, managedRoot)) {
        throw new WorkbenchHelperStageError(
          "Workbench helper managed, staging, and profile roots must not overlap the target project",
          "WORKBENCH_HELPER_PATH_UNSAFE"
        );
      }
    }
    verifyBundleDirectory(actualAddonDirectory, true, companion.bundleDigest, true);
    return this.launchDescriptor(
      companion.bundleDigest,
      actualAddonDirectory,
      actualSearchRoot,
      actualProfile,
      true
    );
  }

  verifySourceDigest(expectedBundleDigest: string): string {
    if (!SHA256_PATTERN.test(expectedBundleDigest)) {
      throw new WorkbenchHelperStageError(
        "Expected Workbench helper source digest is invalid",
        "WORKBENCH_HELPER_STAGE_CONFLICT"
      );
    }
    const currentBundleDigest = verifyWorkbenchHelperSource(this.sourceDirectory).manifest.bundleDigest;
    if (currentBundleDigest !== expectedBundleDigest) {
      throw new WorkbenchHelperStageError(
        "Packaged Workbench helper source changed after its managed companion was staged",
        "WORKBENCH_HELPER_STAGE_CONFLICT"
      );
    }
    return currentBundleDigest;
  }

  status(): WorkbenchCompanionManagedStatus {
    const currentBundleDigest = verifyWorkbenchHelperSource(this.sourceDirectory).manifest.bundleDigest;
    const rolePath = join(this.managedRoot, "workbench-helper");
    if (!existsSync(rolePath)) {
      return {
        installed: false,
        managedRoot: potentialCanonicalPath(this.managedRoot),
        roleRoot: potentialCanonicalPath(rolePath),
        currentBundleDigest,
        stagedDigests: [],
        managedBytes: 0,
        staleCaptureCount: 0,
        warnings: [],
      };
    }
    if (lstatSync(rolePath).isSymbolicLink()) {
      throw new WorkbenchHelperStageError(
        `Workbench helper role root must not be a symbolic link: ${rolePath}`,
        "WORKBENCH_HELPER_PATH_UNSAFE"
      );
    }
    const managedRoot = canonicalDirectory(this.managedRoot, "Workbench helper managed root");
    const roleRoot = canonicalDirectory(rolePath, "Workbench helper role root");
    assertContainedPath(managedRoot, roleRoot);
    const warnings: string[] = [];
    const stagedDigests: string[] = [];
    const addonsRoot = join(roleRoot, "addons");
    if (existsSync(addonsRoot)) {
      const canonicalAddons = canonicalDirectory(addonsRoot, "Workbench helper add-ons root");
      assertContainedPath(roleRoot, canonicalAddons);
      for (const entry of readdirSync(canonicalAddons, { withFileTypes: true })) {
        if (entry.isDirectory() && SHA256_PATTERN.test(entry.name)) stagedDigests.push(entry.name);
        else if (!/^\.[a-f0-9]{64}\.[A-Fa-f0-9-]+\.tmp$/.test(entry.name)) {
          warnings.push(`Unexpected managed add-on entry: ${entry.name}`);
        }
      }
    }
    const captureRoot = join(roleRoot, "profile", "profile", "ReforgerForgeObserver", "workbench");
    let staleCaptureCount = 0;
    if (existsSync(captureRoot)) {
      const canonicalCaptureRoot = canonicalDirectory(captureRoot, "Workbench helper capture root");
      assertContainedPath(roleRoot, canonicalCaptureRoot);
      for (const entry of readdirSync(canonicalCaptureRoot, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) staleCaptureCount += 1;
        else warnings.push(`Unexpected managed capture entry: ${entry.name}`);
      }
    }
    return {
      installed: true,
      managedRoot,
      roleRoot,
      currentBundleDigest,
      stagedDigests: stagedDigests.sort(),
      managedBytes: managedTreeUsage(roleRoot).bytes,
      staleCaptureCount,
      warnings,
    };
  }

  applyRetention(options: WorkbenchCompanionRetentionOptions = {}): WorkbenchCompanionRetentionResult {
    const maxAgeMs = boundedRetentionInteger(
      options.maxAgeMs,
      DEFAULT_RETENTION_MAX_AGE_MS,
      "Workbench helper retention maximum age"
    );
    const maxBytes = boundedRetentionInteger(
      options.maxBytes,
      DEFAULT_RETENTION_MAX_BYTES,
      "Workbench helper retention maximum bytes"
    );
    const nowMs = boundedRetentionInteger(options.nowMs, Date.now(), "Workbench helper retention clock");
    const protectedDigests = new Set(options.protectedDigests ?? []);
    for (const digest of protectedDigests) {
      if (!SHA256_PATTERN.test(digest)) {
        throw new WorkbenchHelperStageError(
          `Invalid protected Workbench helper digest: ${digest}`,
          "WORKBENCH_HELPER_PATH_UNSAFE"
        );
      }
    }
    const currentDigest = verifyWorkbenchHelperSource(this.sourceDirectory).manifest.bundleDigest;
    protectedDigests.add(currentDigest);
    const rolePath = join(this.managedRoot, "workbench-helper");
    if (!existsSync(rolePath)) {
      return {
        removedDigestRoots: [],
        removedCaptureFiles: [],
        removedTemporaryRoots: [],
        reclaimedBytes: 0,
        remainingBytes: 0,
      };
    }
    if (lstatSync(rolePath).isSymbolicLink()) {
      throw new WorkbenchHelperStageError(
        `Workbench helper role root must not be a symbolic link: ${rolePath}`,
        "WORKBENCH_HELPER_PATH_UNSAFE"
      );
    }
    const managedRoot = canonicalDirectory(this.managedRoot, "Workbench helper managed root");
    const roleRoot = canonicalDirectory(rolePath, "Workbench helper role root");
    assertContainedPath(managedRoot, roleRoot);
    let remainingBytes = managedTreeUsage(roleRoot).bytes;
    let reclaimedBytes = 0;
    const removedDigestRoots: string[] = [];
    const removedCaptureFiles: string[] = [];
    const removedTemporaryRoots: string[] = [];
    const candidates: Array<ManagedEntryUsage & { kind: "digest" | "capture" }> = [];

    const addonsRoot = join(roleRoot, "addons");
    if (existsSync(addonsRoot)) {
      const canonicalAddons = canonicalDirectory(addonsRoot, "Workbench helper add-ons root");
      assertContainedPath(roleRoot, canonicalAddons);
      for (const entry of readdirSync(canonicalAddons, { withFileTypes: true })) {
        const path = join(canonicalAddons, entry.name);
        if (SHA256_PATTERN.test(entry.name)) {
          if (!entry.isDirectory()) {
            throw new WorkbenchHelperStageError(
              `Managed Workbench helper digest entry is not a directory: ${path}`,
              "WORKBENCH_HELPER_STAGE_CONFLICT"
            );
          }
          const usage = managedTreeUsage(path);
          if (!protectedDigests.has(entry.name)) candidates.push({ ...usage, kind: "digest" });
          continue;
        }
        if (/^\.[a-f0-9]{64}\.[A-Fa-f0-9-]+\.tmp$/.test(entry.name)) {
          const usage = managedTreeUsage(path);
          if (nowMs - usage.modifiedAtMs >= TEMPORARY_STAGE_MAX_AGE_MS) {
            assertContainedPath(canonicalAddons, path);
            rmSync(path, { recursive: true, force: false });
            remainingBytes -= usage.bytes;
            reclaimedBytes += usage.bytes;
            removedTemporaryRoots.push(entry.name);
          }
          continue;
        }
        throw new WorkbenchHelperStageError(
          `Unexpected entry in managed Workbench helper add-ons root: ${entry.name}`,
          "WORKBENCH_HELPER_STAGE_CONFLICT"
        );
      }
    }

    const captureRoot = join(roleRoot, "profile", "profile", "ReforgerForgeObserver", "workbench");
    if (existsSync(captureRoot)) {
      const canonicalCaptureRoot = canonicalDirectory(captureRoot, "Workbench helper capture root");
      assertContainedPath(roleRoot, canonicalCaptureRoot);
      for (const entry of readdirSync(canonicalCaptureRoot, { withFileTypes: true })) {
        const path = join(canonicalCaptureRoot, entry.name);
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile() || !entry.name.toLowerCase().endsWith(".png")) {
          throw new WorkbenchHelperStageError(
            `Unexpected entry in managed Workbench helper capture root: ${entry.name}`,
            "WORKBENCH_HELPER_STAGE_CONFLICT"
          );
        }
        candidates.push({ path, bytes: info.size, modifiedAtMs: info.mtimeMs, kind: "capture" });
      }
    }

    candidates.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs || left.path.localeCompare(right.path));
    for (const candidate of candidates) {
      const expired = nowMs - candidate.modifiedAtMs >= maxAgeMs;
      if (!expired && remainingBytes <= maxBytes) continue;
      assertContainedPath(roleRoot, candidate.path);
      const info = lstatSync(candidate.path);
      if (info.isSymbolicLink()) {
        throw new WorkbenchHelperStageError(
          `Managed Workbench helper retention target changed identity: ${candidate.path}`,
          "WORKBENCH_HELPER_STAGE_CONFLICT"
        );
      }
      if (candidate.kind === "digest") {
        if (!info.isDirectory() || !SHA256_PATTERN.test(relative(addonsRoot, candidate.path))) {
          throw new WorkbenchHelperStageError(
            `Managed Workbench helper digest retention target is invalid: ${candidate.path}`,
            "WORKBENCH_HELPER_STAGE_CONFLICT"
          );
        }
        rmSync(candidate.path, { recursive: true, force: false });
        removedDigestRoots.push(candidate.path);
      } else {
        if (!info.isFile()) {
          throw new WorkbenchHelperStageError(
            `Managed Workbench helper capture retention target is invalid: ${candidate.path}`,
            "WORKBENCH_HELPER_STAGE_CONFLICT"
          );
        }
        rmSync(candidate.path, { force: false });
        removedCaptureFiles.push(candidate.path);
      }
      remainingBytes -= candidate.bytes;
      reclaimedBytes += candidate.bytes;
    }
    return {
      removedDigestRoots,
      removedCaptureFiles,
      removedTemporaryRoots,
      reclaimedBytes,
      remainingBytes: Math.max(0, remainingBytes),
    };
  }

  uninstall(): WorkbenchCompanionUninstallResult {
    const rolePath = join(this.managedRoot, "workbench-helper");
    if (!existsSync(rolePath)) return { removed: false, roleRoot: potentialCanonicalPath(rolePath) };
    const managedRoot = canonicalDirectory(this.managedRoot, "Workbench helper managed root");
    const roleRoot = canonicalDirectory(rolePath, "Workbench helper role root");
    assertContainedPath(managedRoot, roleRoot);
    if (pathKey(dirname(roleRoot)) !== pathKey(managedRoot) || lstatSync(rolePath).isSymbolicLink()) {
      throw new WorkbenchHelperStageError(
        `Refusing to remove a Workbench helper role root with an unexpected identity: ${rolePath}`,
        "WORKBENCH_HELPER_PATH_UNSAFE"
      );
    }
    rmSync(roleRoot, { recursive: true, force: false });
    return { removed: true, roleRoot };
  }

  private launchDescriptor(
    bundleDigest: string,
    addonDirectory: string,
    addonSearchRoot: string,
    workbenchProfilePath: string,
    reused: boolean
  ): WorkbenchCompanionLaunch {
    return Object.freeze({
      addonId: WORKBENCH_HELPER_ADDON_ID,
      addonGuid: WORKBENCH_HELPER_ADDON_GUID,
      addonVersion: WORKBENCH_HELPER_ADDON_VERSION,
      protocolVersion: WORKBENCH_HELPER_PROTOCOL_VERSION,
      buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
      bundleDigest,
      addonDirectory: realpathSync.native(addonDirectory),
      addonSearchRoot: realpathSync.native(addonSearchRoot),
      workbenchProfilePath: realpathSync.native(workbenchProfilePath),
      reused,
    });
  }
}
