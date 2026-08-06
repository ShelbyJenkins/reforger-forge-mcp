import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boundedOption, type BoundedOptionErrorFactory } from "../foundation/bounded-option.js";
import {
  canonicalizeExistingDirectory,
  canonicalizePotentialPath,
  ensureCanonicalDirectory as ensureFoundationDirectory,
  isPathContained,
  pathComparisonKey,
  resolveManagedPath,
} from "../foundation/managed-path.js";
import {
  ContentAddressedBundleError,
  computeContentAddressedBundleDigest,
  createContentAddressedBundleManifestSchema,
  stageContentAddressedBundle,
  verifyContentAddressedBundle,
  type ContentAddressedBundlePolicy,
} from "../companions/content-addressed-bundle.js";
import {
  WORKBENCH_HELPER_HANDLER_FILES as generatedWorkbenchHelperHandlerFiles,
  WORKBENCH_HELPER_PAYLOAD_FILES,
} from "./helper-addon-payload.generated.js";

export const WORKBENCH_HELPER_SOURCE_MANIFEST =
  ".reforger-forge-workbench-helper-source.json" as const;
export const WORKBENCH_HELPER_ADDON_ID = "ReforgerForgeWorkbenchHelper" as const;
export const WORKBENCH_HELPER_ADDON_GUID = "4D74249D90703F46" as const;
export const WORKBENCH_HELPER_ADDON_VERSION = "0.1.0" as const;
export const WORKBENCH_HELPER_PROTOCOL_VERSION = "2.0" as const;
/** Content identity of the helper payload, excluding only its generated identity source. */
export const WORKBENCH_HELPER_BUILD_IDENTITY =
  "d1be66f8dbf3f23d80dfac833bc0b3aeaeccf9de7f0525850b78985a117b0fb7" as const;
export const WORKBENCH_HELPER_HANDLER_FILES = generatedWorkbenchHelperHandlerFiles;
/**
 * Workbench writes these local derived files beside addon.gproj after loading a
 * staged add-on. They are not helper payload and must be accepted only for an
 * already staged, hash-verified bundle.
 */
const WORKBENCH_GENERATED_STAGED_FILES = new Set([
  "resourceDatabase.rdb",
  "UserMaps.desc",
]);

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

export type WorkbenchCurrentCompanion =
  | Readonly<{
      kind: "available";
      companion: Readonly<WorkbenchCompanionLaunch>;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: "current_bundle_not_staged";
    }>;

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
  /**
   * Re-attest the current packaged bundle only when it is already present in
   * the managed layout. This operation is strictly read-only: it must not
   * stage, repair, retain, remove, or create any path.
   */
  readCurrentStaged?(targetProjectPath?: string): WorkbenchCurrentCompanion;
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
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "ReforgerForge", "Observer", "v1");
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
}

/** Canonicalize all existing path segments without creating the requested path. */
function potentialCanonicalPath(path: string): string {
  return canonicalizePotentialPath(path, {
    linkPolicy: "follow-existing",
    existingAncestor: "any",
    label: "Workbench helper path",
  });
}

function canonicalDirectory(path: string, label: string): string {
  try {
    return canonicalizeExistingDirectory(path, label);
  } catch (error) {
    throw new WorkbenchHelperStageError(
      error instanceof Error ? error.message : String(error),
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
  }
}

function ensureCanonicalDirectory(path: string): string {
  try {
    return ensureFoundationDirectory(path, 0o700);
  } catch (error) {
    throw new WorkbenchHelperStageError(
      error instanceof Error ? error.message : String(error),
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
  }
}

function assertContainedPath(root: string, candidate: string): void {
  try {
    resolveManagedPath(root, candidate, "link-safe");
  } catch (error) {
    throw new WorkbenchHelperStageError(
      error instanceof Error ? error.message : String(error),
      "WORKBENCH_HELPER_PATH_UNSAFE"
    );
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

export function computeWorkbenchHelperBundleDigest(
  files: readonly WorkbenchHelperManifestFile[]
): string {
  return computeContentAddressedBundleDigest(files);
}

function verifyCompiledHelperIdentity(directory: string): void {
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
    [ping, "resp.workbenchProtocol = RFWB_HelperBuild.PROTOCOL_VERSION"],
    [ping, "resp.helperBuildIdentity = RFWB_HelperBuild.IDENTITY"],
  ] as const;
  if (requiredDeclarations.some(([source, declaration]) => !source.includes(declaration))) {
    throw new Error("compiled identity does not match its fixed package descriptor");
  }
}

const workbenchHelperManifestSchema = createContentAddressedBundleManifestSchema({
  role: z.literal(WORKBENCH_HELPER_DESCRIPTOR.role),
  addonVersion: z.literal(WORKBENCH_HELPER_ADDON_VERSION),
  protocolVersion: z.literal(WORKBENCH_HELPER_PROTOCOL_VERSION),
  addonId: z.literal(WORKBENCH_HELPER_ADDON_ID),
  addonGuid: z.literal(WORKBENCH_HELPER_ADDON_GUID),
  buildIdentity: z.literal(WORKBENCH_HELPER_BUILD_IDENTITY),
});

const workbenchHelperBundlePolicy: ContentAddressedBundlePolicy<WorkbenchHelperSourceManifest> = {
  displayName: "Workbench helper",
  addonDirectoryName: WORKBENCH_HELPER_ADDON_ID,
  manifestName: WORKBENCH_HELPER_SOURCE_MANIFEST,
  manifestSchema: workbenchHelperManifestSchema,
  requiredPayloadPaths: WORKBENCH_HELPER_PAYLOAD_FILES,
  allowedStagedExtraFiles: WORKBENCH_GENERATED_STAGED_FILES,
  validatePayload: (directory) => verifyCompiledHelperIdentity(directory),
};

function asWorkbenchHelperStageError(error: unknown): never {
  if (error instanceof WorkbenchHelperStageError) throw error;
  if (error instanceof ContentAddressedBundleError) {
    throw new WorkbenchHelperStageError(
      error.message,
      error.issue === "unsafe_path"
        ? "WORKBENCH_HELPER_PATH_UNSAFE"
        : error.mode === "staged"
          ? "WORKBENCH_HELPER_STAGE_CONFLICT"
          : "WORKBENCH_HELPER_SOURCE_INVALID"
    );
  }
  throw error;
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
  try {
    return verifyContentAddressedBundle(workbenchHelperBundlePolicy, directoryPath, {
      mode: conflict ? "staged" : "source",
      expectedDigest,
      allowStagedExtraFiles: allowGeneratedStagedFiles,
    });
  } catch (error) {
    return asWorkbenchHelperStageError(error);
  }
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

const retentionOptionError: BoundedOptionErrorFactory = ({ label }) =>
  new WorkbenchHelperStageError(
    `${label} must be a positive safe integer`,
    "WORKBENCH_HELPER_PATH_UNSAFE"
  );

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

    try {
      const staged = stageContentAddressedBundle(
        workbenchHelperBundlePolicy,
        source,
        addonsRoot
      );
      return this.launchDescriptor(
        staged.bundleDigest,
        staged.addonDirectory,
        staged.addonSearchRoot,
        profilePath,
        staged.reused
      );
    } catch (error) {
      return asWorkbenchHelperStageError(error);
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

    if (pathComparisonKey(actualSearchRoot) !== pathComparisonKey(expectedSearchRoot) ||
        pathComparisonKey(actualAddonDirectory) !== pathComparisonKey(expectedAddonDirectory) ||
        pathComparisonKey(actualProfile) !== pathComparisonKey(expectedProfile)) {
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

  readCurrentStaged(targetProjectPath = this.targetProjectPath): WorkbenchCurrentCompanion {
    const source = verifyWorkbenchHelperSource(this.sourceDirectory);
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
      if (pathsOverlap(targetDirectory(target), prospectiveManagedRoot)) {
        throw new WorkbenchHelperStageError(
          "Workbench helper managed, staging, and profile roots must not overlap the target project",
          "WORKBENCH_HELPER_PATH_UNSAFE"
        );
      }
    }

    const rolePath = join(this.managedRoot, "workbench-helper");
    const digestRoot = join(rolePath, "addons", source.manifest.bundleDigest);
    if (!existsSync(rolePath) || !existsSync(digestRoot)) {
      return Object.freeze({
        kind: "unavailable",
        reason: "current_bundle_not_staged",
      });
    }

    const companion = this.verifyStaged(this.launchDescriptor(
      source.manifest.bundleDigest,
      join(digestRoot, WORKBENCH_HELPER_ADDON_ID),
      digestRoot,
      join(rolePath, "profile"),
      true
    ), targetProjectPath);
    return Object.freeze({
      kind: "available",
      companion: Object.freeze(companion),
    });
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
    const maxAgeMs = boundedOption(
      options.maxAgeMs,
      DEFAULT_RETENTION_MAX_AGE_MS,
      1,
      Number.MAX_SAFE_INTEGER,
      "Workbench helper retention maximum age",
      retentionOptionError
    );
    const maxBytes = boundedOption(
      options.maxBytes,
      DEFAULT_RETENTION_MAX_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
      "Workbench helper retention maximum bytes",
      retentionOptionError
    );
    const nowMs = boundedOption(options.nowMs, Date.now(), 1, Number.MAX_SAFE_INTEGER, "Workbench helper retention clock", retentionOptionError);
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
    if (pathComparisonKey(dirname(roleRoot)) !== pathComparisonKey(managedRoot) ||
        lstatSync(rolePath).isSymbolicLink()) {
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
