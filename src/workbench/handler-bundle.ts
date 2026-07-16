import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  accessSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalProjectIdentity } from "./project-identity.js";

export const HANDLER_FOLDER = "EnfusionMCP";
export const HANDLER_MANIFEST_NAME = ".reforger-forge-handler-bundle.json";
export const HANDLER_MANIFEST_VERSION = 3;
const TRANSACTION_RECORD_NAME = "transaction.json";
export const REQUIRED_HANDLER_FILES = [
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
  "EMCP_WB_Ping.c",
  "EMCP_WB_Prefabs.c",
  "EMCP_WB_Reload.c",
  "EMCP_WB_Resources.c",
  "EMCP_WB_ScriptEditor.c",
  "EMCP_WB_SelectEntity.c",
  "EMCP_WB_Terrain.c",
] as const;

export type HandlerBundleErrorCode =
  | "HANDLER_BUNDLE_MISSING"
  | "HANDLER_BUNDLE_INVALID"
  | "HANDLER_TARGET_UNSAFE"
  | "HANDLER_MANIFEST_INVALID"
  | "HANDLER_CONFLICT"
  | "HANDLER_TRANSACTION_INVALID";

export class HandlerBundleError extends Error {
  constructor(
    message: string,
    public readonly code: HandlerBundleErrorCode
  ) {
    super(message);
    this.name = "HandlerBundleError";
  }
}

export interface HandlerManifestFile {
  path: string;
  sha256: string;
}

export interface HandlerManifest {
  version: 3;
  generation: string;
  bundleGeneration: string;
  canonicalProject: string;
  canonicalProjectKey: string;
  modDirectory: string;
  files: HandlerManifestFile[];
  createdDirectories: string[];
}

export interface HandlerTransactionRecord {
  version: 1;
  id: string;
  phase: "prepared" | "applied";
  canonicalProject: string;
  canonicalProjectKey: string;
  modDirectory: string;
  handlerDirectory: string;
  backupPath: string;
  originalManifest: boolean;
  originalFiles: string[];
  oldManagedFiles: string[];
  newManagedFiles: string[];
  createdDirectories: string[];
  manifest: HandlerManifest;
}

export interface PreparedHandlerTransaction {
  record: HandlerTransactionRecord;
  bundledDirectory: string;
}

export interface HandlerCleanupResult {
  kind: "removed" | "not_installed" | "modified_files";
  handlerDirectory: string;
  removed: string[];
  modified: string[];
  unrelated: string[];
}

export interface HandlerBundleManagerOptions {
  stateDir: string;
  bundleDir?: string;
  /** Test/embedding override. Production uses the exact supported handler set. */
  requiredFiles?: readonly string[];
}

interface BundleDescription {
  directory: string;
  generation: string;
  files: HandlerManifestFile[];
}

interface LegacyManifestV2 {
  version: 2;
  files: string[];
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function assertContainedFilesystemPath(root: string, candidate: string): void {
  const canonicalRoot = realpathSync.native(resolve(root));
  if (!isContained(canonicalRoot, candidate)) {
    throw new HandlerBundleError(
      `Managed handler path escapes the canonical mod directory: ${candidate}`,
      "HANDLER_TARGET_UNSAFE"
    );
  }
  const rel = relative(canonicalRoot, resolve(candidate));
  let current = canonicalRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const canonical = realpathSync.native(current);
    if (!isContained(canonicalRoot, canonical)) {
      throw new HandlerBundleError(
        `Managed handler path traverses a junction or symlink outside the mod directory: ${current}`,
        "HANDLER_TARGET_UNSAFE"
      );
    }
  }
}

function assertRegularManagedFile(path: string): void {
  if (!existsSync(path)) return;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new HandlerBundleError(
      `Managed handler path is not a regular file: ${path}`,
      "HANDLER_TARGET_UNSAFE"
    );
  }
}

function isSafeManagedPath(path: string): boolean {
  if (!path || isAbsolute(path)) return false;
  const normalized = path.replace(/\\/g, "/");
  return !normalized.includes("/") &&
    normalized !== "." && normalized !== ".." &&
    normalized !== HANDLER_MANIFEST_NAME;
}

function parseJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
}

function writeJsonAtomically(path: string, value: unknown): void {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  // libuv maps rename to an atomic replace on Windows. Do not unlink the
  // durable record first: that would create a crash window with no manifest.
  renameSync(tempPath, path);
}

function validateManifest(value: unknown): HandlerManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<HandlerManifest>;
  if (record.version !== HANDLER_MANIFEST_VERSION ||
      typeof record.generation !== "string" || record.generation.length === 0 ||
      typeof record.bundleGeneration !== "string" || record.bundleGeneration.length === 0 ||
      typeof record.canonicalProject !== "string" || record.canonicalProject.length === 0 ||
      typeof record.canonicalProjectKey !== "string" || record.canonicalProjectKey.length === 0 ||
      typeof record.modDirectory !== "string" || record.modDirectory.length === 0 ||
      !Array.isArray(record.files) || !Array.isArray(record.createdDirectories)) {
    return null;
  }

  const files: HandlerManifestFile[] = [];
  const seen = new Set<string>();
  for (const entry of record.files) {
    if (!entry || typeof entry !== "object") return null;
    const candidate = entry as Partial<HandlerManifestFile>;
    if (typeof candidate.path !== "string" || !isSafeManagedPath(candidate.path) ||
        typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(candidate.sha256)) {
      return null;
    }
    const key = candidate.path.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    files.push({ path: candidate.path.replace(/\\/g, "/"), sha256: candidate.sha256.toLowerCase() });
  }

  const createdDirectories: string[] = [];
  for (const entry of record.createdDirectories) {
    if (typeof entry !== "string" || entry.length === 0 || !isAbsolute(entry)) return null;
    createdDirectories.push(resolve(entry));
  }

  return {
    version: HANDLER_MANIFEST_VERSION,
    generation: record.generation,
    bundleGeneration: record.bundleGeneration,
    canonicalProject: record.canonicalProject,
    canonicalProjectKey: record.canonicalProjectKey,
    modDirectory: resolve(record.modDirectory),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    createdDirectories,
  };
}

function validateLegacyManifest(value: unknown): LegacyManifestV2 | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<LegacyManifestV2>;
  if (record.version !== 2 || !Array.isArray(record.files)) return null;
  if (!record.files.every((entry) => typeof entry === "string" && isSafeManagedPath(entry))) return null;
  return { version: 2, files: [...new Set(record.files)].sort() };
}

function validateTransactionRecord(value: unknown): HandlerTransactionRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<HandlerTransactionRecord>;
  const manifest = validateManifest(record.manifest);
  if (record.version !== 1 ||
      typeof record.id !== "string" || record.id.length === 0 ||
      (record.phase !== "prepared" && record.phase !== "applied") ||
      typeof record.canonicalProject !== "string" ||
      typeof record.canonicalProjectKey !== "string" ||
      typeof record.modDirectory !== "string" ||
      typeof record.handlerDirectory !== "string" ||
      typeof record.backupPath !== "string" ||
      typeof record.originalManifest !== "boolean" ||
      !Array.isArray(record.originalFiles) ||
      !Array.isArray(record.oldManagedFiles) ||
      !Array.isArray(record.newManagedFiles) ||
      !Array.isArray(record.createdDirectories) ||
      !manifest) {
    return null;
  }
  const fileLists = [record.originalFiles, record.oldManagedFiles, record.newManagedFiles];
  if (fileLists.some((entries) => entries!.some((entry) => typeof entry !== "string" || !isSafeManagedPath(entry)))) {
    return null;
  }
  if (record.createdDirectories.some((entry) => typeof entry !== "string" || !isAbsolute(entry))) return null;
  return {
    version: 1,
    id: record.id,
    phase: record.phase,
    canonicalProject: record.canonicalProject,
    canonicalProjectKey: record.canonicalProjectKey,
    modDirectory: resolve(record.modDirectory),
    handlerDirectory: resolve(record.handlerDirectory),
    backupPath: resolve(record.backupPath),
    originalManifest: record.originalManifest,
    originalFiles: [...record.originalFiles],
    oldManagedFiles: [...record.oldManagedFiles],
    newManagedFiles: [...record.newManagedFiles],
    createdDirectories: record.createdDirectories.map((entry) => resolve(entry)),
    manifest,
  };
}

export class HandlerBundleManager {
  readonly bundleDir: string;
  readonly transactionsDir: string;

  constructor(private readonly options: HandlerBundleManagerOptions) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    this.bundleDir = options.bundleDir ??
      join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    this.transactionsDir = join(options.stateDir, "handler-transactions");
  }

  describeBundle(): BundleDescription {
    if (!existsSync(this.bundleDir)) {
      throw new HandlerBundleError(
        `Bundled Workbench handlers are missing at ${this.bundleDir}.`,
        "HANDLER_BUNDLE_MISSING"
      );
    }
    let entries;
    try {
      entries = readdirSync(this.bundleDir, { withFileTypes: true });
    } catch (error) {
      throw new HandlerBundleError(
        `Could not read bundled Workbench handlers at ${this.bundleDir}: ${error instanceof Error ? error.message : String(error)}`,
        "HANDLER_BUNDLE_INVALID"
      );
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".c"))
      .map((entry) => ({ path: entry.name, sha256: sha256File(join(this.bundleDir, entry.name)) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) {
      throw new HandlerBundleError(
        `Bundled Workbench handler directory ${this.bundleDir} contains no .c files.`,
        "HANDLER_BUNDLE_INVALID"
      );
    }
    const actualNames = files.map((entry) => entry.path);
    const requiredNames = [...(this.options.requiredFiles ?? REQUIRED_HANDLER_FILES)]
      .sort((a, b) => a.localeCompare(b));
    if (actualNames.length !== requiredNames.length ||
        actualNames.some((entry, index) => entry !== requiredNames[index])) {
      const actual = new Set(actualNames.map((entry) => entry.toLowerCase()));
      const required = new Set(requiredNames.map((entry) => entry.toLowerCase()));
      const missing = requiredNames.filter((entry) => !actual.has(entry.toLowerCase()));
      const unexpected = actualNames.filter((entry) => !required.has(entry.toLowerCase()));
      throw new HandlerBundleError(
        `Bundled Workbench handler set is incomplete or unsupported.` +
          `${missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : ""}` +
          `${unexpected.length > 0 ? ` Unexpected: ${unexpected.join(", ")}.` : ""}`,
        "HANDLER_BUNDLE_INVALID"
      );
    }
    const generation = createHash("sha256")
      .update(files.map((entry) => `${entry.path}\0${entry.sha256}\n`).join(""))
      .digest("hex");
    return { directory: this.bundleDir, generation, files };
  }

  preflight(project: CanonicalProjectIdentity): {
    modDirectory: string;
    handlerDirectory: string;
    bundle: BundleDescription;
    oldManifest: HandlerManifest | null;
  } {
    const bundle = this.describeBundle();
    const modDirectory = project.modDirectory;
    const handlerDirectory = resolve(modDirectory, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    assertContainedFilesystemPath(modDirectory, handlerDirectory);
    if (!isContained(modDirectory, handlerDirectory)) {
      throw new HandlerBundleError(
        `Handler target escapes the canonical mod directory: ${handlerDirectory}`,
        "HANDLER_TARGET_UNSAFE"
      );
    }
    if (!statSync(modDirectory).isDirectory()) {
      throw new HandlerBundleError(
        `Canonical mod directory is not a directory: ${modDirectory}`,
        "HANDLER_TARGET_UNSAFE"
      );
    }
    accessSync(modDirectory, constants.R_OK | constants.W_OK);
    if (existsSync(handlerDirectory)) {
      const canonicalHandler = realpathSync.native(handlerDirectory);
      if (!isContained(modDirectory, canonicalHandler)) {
        throw new HandlerBundleError(
          `Handler target resolves outside the canonical mod directory: ${handlerDirectory}`,
          "HANDLER_TARGET_UNSAFE"
        );
      }
      if (!statSync(canonicalHandler).isDirectory()) {
        throw new HandlerBundleError(
          `Handler target is not a directory: ${handlerDirectory}`,
          "HANDLER_TARGET_UNSAFE"
        );
      }
      accessSync(canonicalHandler, constants.R_OK | constants.W_OK);
    }
    const oldManifest = this.inspectExistingInstallation(
      project,
      modDirectory,
      handlerDirectory,
      bundle
    );
    return { modDirectory, handlerDirectory, bundle, oldManifest };
  }

  prepare(project: CanonicalProjectIdentity): PreparedHandlerTransaction {
    const { modDirectory, handlerDirectory, bundle, oldManifest } = this.preflight(project);
    const manifestPath = join(handlerDirectory, HANDLER_MANIFEST_NAME);

    const id = randomUUID();
    const backupPath = join(this.transactionsDir, id);
    const backupFilesDir = join(backupPath, "files");
    mkdirSync(backupFilesDir, { recursive: true });
    const oldManagedFiles = (oldManifest?.files ?? []).map((entry) => entry.path).sort();
    const originalFiles: string[] = [];
    try {
      for (const file of oldManagedFiles) {
        const source = join(handlerDirectory, file);
        if (!existsSync(source)) continue;
        const destination = join(backupFilesDir, file);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
        originalFiles.push(file);
      }
      if (existsSync(manifestPath)) copyFileSync(manifestPath, join(backupPath, HANDLER_MANIFEST_NAME));

      const candidateDirectories = [
        join(modDirectory, "Scripts"),
        join(modDirectory, "Scripts", "WorkbenchGame"),
        handlerDirectory,
      ];
      const createdDirectories = candidateDirectories.filter((path) => !existsSync(path));
      const inheritedCreated = oldManifest?.createdDirectories.filter((path) =>
        isContained(modDirectory, path)
      ) ?? [];
      const manifest: HandlerManifest = {
        version: HANDLER_MANIFEST_VERSION,
        generation: randomUUID(),
        bundleGeneration: bundle.generation,
        canonicalProject: project.displayPath,
        canonicalProjectKey: project.comparisonKey,
        modDirectory,
        files: bundle.files,
        createdDirectories: [...new Set([...inheritedCreated, ...createdDirectories])],
      };
      const record: HandlerTransactionRecord = {
        version: 1,
        id,
        phase: "prepared",
        canonicalProject: project.displayPath,
        canonicalProjectKey: project.comparisonKey,
        modDirectory,
        handlerDirectory,
        backupPath,
        originalManifest: existsSync(manifestPath),
        originalFiles,
        oldManagedFiles,
        newManagedFiles: bundle.files.map((entry) => entry.path),
        createdDirectories,
        manifest,
      };
      writeJsonAtomically(join(backupPath, TRANSACTION_RECORD_NAME), record);
      return { record, bundledDirectory: bundle.directory };
    } catch (error) {
      rmSync(backupPath, { recursive: true, force: true });
      if (error instanceof HandlerBundleError) throw error;
      throw new HandlerBundleError(
        `Could not snapshot the existing handler bundle: ${error instanceof Error ? error.message : String(error)}`,
        "HANDLER_TRANSACTION_INVALID"
      );
    }
  }

  private inspectExistingInstallation(
    project: CanonicalProjectIdentity,
    modDirectory: string,
    handlerDirectory: string,
    bundle: BundleDescription
  ): HandlerManifest | null {
    const manifestPath = join(handlerDirectory, HANDLER_MANIFEST_NAME);
    let oldManifest: HandlerManifest | null = null;
    if (existsSync(handlerDirectory)) {
      if (!existsSync(manifestPath)) {
        throw new HandlerBundleError(
          `Handler directory already exists without a valid Reforger Forge manifest: ${handlerDirectory}`,
          "HANDLER_CONFLICT"
        );
      }
      let rawManifest: unknown;
      try {
        rawManifest = parseJson(manifestPath);
      } catch (error) {
        throw new HandlerBundleError(
          `Handler manifest cannot be read as JSON: ${manifestPath} ` +
            `(${error instanceof Error ? error.message : String(error)})`,
          "HANDLER_MANIFEST_INVALID"
        );
      }
      oldManifest = validateManifest(rawManifest);
      if (!oldManifest) {
        const legacy = validateLegacyManifest(rawManifest);
        if (!legacy) {
          throw new HandlerBundleError(
            `Handler manifest is malformed or unsupported: ${manifestPath}`,
            "HANDLER_MANIFEST_INVALID"
          );
        }
        const bundleByName = new Map(bundle.files.map((entry) => [entry.path.toLowerCase(), entry]));
        const legacyFiles: HandlerManifestFile[] = [];
        for (const file of legacy.files) {
          const known = bundleByName.get(file.toLowerCase());
          const installedPath = join(handlerDirectory, file);
          if (!known || !existsSync(installedPath) || sha256File(installedPath) !== known.sha256) {
            throw new HandlerBundleError(
              `Legacy handler manifest cannot prove the installed file is repository-owned: ${file}`,
              "HANDLER_MANIFEST_INVALID"
            );
          }
          legacyFiles.push({ path: file, sha256: known.sha256 });
        }
        oldManifest = {
          version: HANDLER_MANIFEST_VERSION,
          generation: randomUUID(),
          bundleGeneration: bundle.generation,
          canonicalProject: project.displayPath,
          canonicalProjectKey: project.comparisonKey,
          modDirectory,
          files: legacyFiles,
          createdDirectories: [],
        };
      }
      if (oldManifest.canonicalProjectKey !== project.comparisonKey ||
          pathKey(oldManifest.modDirectory) !== pathKey(modDirectory)) {
        throw new HandlerBundleError(
          `Handler manifest belongs to a different canonical project or mod directory: ${manifestPath}`,
          "HANDLER_CONFLICT"
        );
      }
    }

    const oldManaged = new Set((oldManifest?.files ?? []).map((entry) => entry.path.toLowerCase()));
    for (const file of oldManifest?.files ?? []) {
      assertRegularManagedFile(join(handlerDirectory, file.path));
    }
    for (const file of bundle.files) {
      const target = join(handlerDirectory, file.path);
      assertRegularManagedFile(target);
      if (existsSync(target) && !oldManaged.has(file.path.toLowerCase())) {
        throw new HandlerBundleError(
          `Refusing to overwrite an unowned handler file: ${target}`,
          "HANDLER_CONFLICT"
        );
      }
    }
    return oldManifest;
  }

  apply(transaction: PreparedHandlerTransaction): HandlerTransactionRecord {
    const { record, bundledDirectory } = transaction;
    if (record.phase !== "prepared") {
      throw new HandlerBundleError(
        `Handler transaction ${record.id} is not in the prepared phase.`,
        "HANDLER_TRANSACTION_INVALID"
      );
    }
    assertContainedFilesystemPath(record.modDirectory, record.handlerDirectory);
    mkdirSync(record.handlerDirectory, { recursive: true });
    const incoming = new Set(record.newManagedFiles.map((entry) => entry.toLowerCase()));
    for (const oldFile of record.oldManagedFiles) {
      if (incoming.has(oldFile.toLowerCase())) continue;
      const target = join(record.handlerDirectory, oldFile);
      if (existsSync(target)) unlinkSync(target);
    }
    for (const file of record.newManagedFiles) {
      copyFileSync(join(bundledDirectory, file), join(record.handlerDirectory, file));
    }
    writeJsonAtomically(join(record.handlerDirectory, HANDLER_MANIFEST_NAME), record.manifest);
    const applied = { ...record, phase: "applied" as const };
    writeJsonAtomically(join(record.backupPath, TRANSACTION_RECORD_NAME), applied);
    transaction.record = applied;
    return applied;
  }

  commit(record: HandlerTransactionRecord): void {
    const checked = this.loadTransaction(record.backupPath);
    if (checked.id !== record.id || checked.phase !== "applied") {
      throw new HandlerBundleError(
        `Handler transaction ${record.id} cannot be committed from phase ${checked.phase}.`,
        "HANDLER_TRANSACTION_INVALID"
      );
    }
    rmSync(record.backupPath, { recursive: true, force: true });
  }

  abortPrepared(record: HandlerTransactionRecord): void {
    const checked = this.loadTransaction(record.backupPath);
    if (checked.id !== record.id || checked.phase !== "prepared") {
      throw new HandlerBundleError(
        `Handler transaction ${record.id} cannot be discarded from phase ${checked.phase}.`,
        "HANDLER_TRANSACTION_INVALID"
      );
    }
    rmSync(record.backupPath, { recursive: true, force: true });
  }

  loadTransaction(backupPath: string): HandlerTransactionRecord {
    const transactionPath = join(resolve(backupPath), TRANSACTION_RECORD_NAME);
    let parsed: unknown;
    try {
      parsed = parseJson(transactionPath);
    } catch (error) {
      throw new HandlerBundleError(
        `Could not read handler transaction ${transactionPath}: ${error instanceof Error ? error.message : String(error)}`,
        "HANDLER_TRANSACTION_INVALID"
      );
    }
    const record = validateTransactionRecord(parsed);
    if (!record || resolve(record.backupPath) !== resolve(backupPath) ||
        !isContained(this.transactionsDir, record.backupPath) ||
        !isContained(record.modDirectory, record.handlerDirectory)) {
      throw new HandlerBundleError(
        `Handler transaction record is malformed or unsafe: ${transactionPath}`,
        "HANDLER_TRANSACTION_INVALID"
      );
    }
    return record;
  }

  restore(recordOrBackupPath: HandlerTransactionRecord | string): HandlerTransactionRecord {
    const record = typeof recordOrBackupPath === "string"
      ? this.loadTransaction(recordOrBackupPath)
      : this.loadTransaction(recordOrBackupPath.backupPath);
    assertContainedFilesystemPath(record.modDirectory, record.handlerDirectory);
    const backupFilesDir = join(record.backupPath, "files");
    mkdirSync(record.handlerDirectory, { recursive: true });

    for (const file of record.newManagedFiles) {
      const target = join(record.handlerDirectory, file);
      if (existsSync(target)) unlinkSync(target);
    }
    for (const file of record.oldManagedFiles) {
      const target = join(record.handlerDirectory, file);
      if (existsSync(target)) unlinkSync(target);
    }
    for (const file of record.originalFiles) {
      const source = join(backupFilesDir, file);
      const target = join(record.handlerDirectory, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }

    const manifestPath = join(record.handlerDirectory, HANDLER_MANIFEST_NAME);
    const backupManifest = join(record.backupPath, HANDLER_MANIFEST_NAME);
    if (record.originalManifest) {
      copyFileSync(backupManifest, manifestPath);
    } else if (existsSync(manifestPath)) {
      unlinkSync(manifestPath);
    }

    for (const directory of [...record.createdDirectories].sort((a, b) => b.length - a.length)) {
      if (!isContained(record.modDirectory, directory) || !existsSync(directory)) continue;
      try {
        if (readdirSync(directory).length === 0) rmdirSync(directory);
      } catch {
        // Preserve a directory that now contains unrelated data.
      }
    }
    return record;
  }

  discardTransaction(recordOrBackupPath: HandlerTransactionRecord | string): void {
    const record = typeof recordOrBackupPath === "string"
      ? this.loadTransaction(recordOrBackupPath)
      : recordOrBackupPath;
    if (!isContained(this.transactionsDir, record.backupPath)) {
      throw new HandlerBundleError(
        `Handler transaction is outside the managed transaction directory: ${record.backupPath}`,
        "HANDLER_TRANSACTION_INVALID"
      );
    }
    rmSync(record.backupPath, { recursive: true, force: true });
  }

  rollback(recordOrBackupPath: HandlerTransactionRecord | string): void {
    const record = this.restore(recordOrBackupPath);
    this.discardTransaction(record);
  }

  readManifest(modDirectory: string): HandlerManifest | null {
    const handlerDirectory = resolve(modDirectory, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    assertContainedFilesystemPath(modDirectory, handlerDirectory);
    const manifestPath = join(handlerDirectory, HANDLER_MANIFEST_NAME);
    if (!existsSync(manifestPath)) return null;
    let value: unknown;
    try {
      value = parseJson(manifestPath);
    } catch (error) {
      throw new HandlerBundleError(
        `Handler manifest cannot be read as JSON: ${manifestPath} ` +
          `(${error instanceof Error ? error.message : String(error)})`,
        "HANDLER_MANIFEST_INVALID"
      );
    }
    const parsed = validateManifest(value);
    if (!parsed || pathKey(parsed.modDirectory) !== pathKey(modDirectory)) {
      throw new HandlerBundleError(
        `Handler manifest is malformed or belongs to another mod directory: ${manifestPath}`,
        "HANDLER_MANIFEST_INVALID"
      );
    }
    return parsed;
  }

  cleanup(target: string | CanonicalProjectIdentity): HandlerCleanupResult {
    const modDirectory = typeof target === "string" ? target : target.modDirectory;
    const expectedProjectKey = typeof target === "string" ? null : target.comparisonKey;
    const canonicalModDirectory = realpathSync.native(resolve(modDirectory));
    const handlerDirectory = resolve(canonicalModDirectory, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    assertContainedFilesystemPath(canonicalModDirectory, handlerDirectory);
    if (!existsSync(handlerDirectory)) {
      return { kind: "not_installed", handlerDirectory, removed: [], modified: [], unrelated: [] };
    }
    const manifest = this.readManifest(canonicalModDirectory);
    if (!manifest) {
      throw new HandlerBundleError(
        `Handler directory exists without a valid Reforger Forge manifest: ${handlerDirectory}`,
        "HANDLER_MANIFEST_INVALID"
      );
    }
    if (expectedProjectKey && manifest.canonicalProjectKey !== expectedProjectKey) {
      throw new HandlerBundleError(
        `Handler manifest belongs to a different canonical project: ${manifest.canonicalProject}`,
        "HANDLER_CONFLICT"
      );
    }

    const removed: string[] = [];
    const modified: string[] = [];
    const managed = new Set(manifest.files.map((entry) => entry.path.toLowerCase()));
    for (const entry of manifest.files) {
      const path = join(handlerDirectory, entry.path);
      if (!existsSync(path)) continue;
      const fileInfo = lstatSync(path);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        modified.push(entry.path);
        continue;
      }
      if (sha256File(path) !== entry.sha256) {
        modified.push(entry.path);
        continue;
      }
      unlinkSync(path);
      removed.push(entry.path);
    }
    const unrelated = readdirSync(handlerDirectory)
      .filter((entry) => entry !== HANDLER_MANIFEST_NAME && !managed.has(entry.toLowerCase()))
      .sort();

    if (modified.length > 0) {
      return {
        kind: "modified_files",
        handlerDirectory,
        removed: removed.sort(),
        modified: modified.sort(),
        unrelated,
      };
    }

    const manifestPath = join(handlerDirectory, HANDLER_MANIFEST_NAME);
    if (existsSync(manifestPath)) unlinkSync(manifestPath);
    for (const directory of [...manifest.createdDirectories].sort((a, b) => b.length - a.length)) {
      if (!isContained(canonicalModDirectory, directory) || !existsSync(directory)) continue;
      try {
        if (readdirSync(directory).length === 0) rmdirSync(directory);
      } catch {
        // Unrelated content keeps the directory in place.
      }
    }
    return {
      kind: "removed",
      handlerDirectory,
      removed: removed.sort(),
      modified: [],
      unrelated,
    };
  }
}
