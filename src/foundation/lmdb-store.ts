import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { asBinary, open } from "lmdb";
import {
  decodeDurableEnvelope,
  decodeDurableKey,
  encodeDurableEnvelope,
  encodeDurableKey,
  type DurableKvListEntry,
  type DurableKvListPage,
  type DurableKvNamespaceStats,
  type DurableKvPutResult,
  type DurableKvRecord,
  type DurableKvStore,
  type DurableRecordCodec,
  type DurableRecordEnvelope,
} from "./durable-kv.js";
import { sha256Hex } from "./digest.js";
import { isPathContained, resolveManagedPath } from "./managed-path.js";

const DEFAULT_DATABASE_DIRECTORY = "durable-kv-v1";
const DEFAULT_MAX_RECORD_BYTES = 1_048_576;
const MAX_LMDB_KEY_BYTES = 1_978;

export type LmdbStoreErrorCode =
  | "CLOSED"
  | "INVALID_ROOT"
  | "INVALID_KEY"
  | "INVALID_OPTIONS"
  | "RECORD_TOO_LARGE"
  | "CORRUPT_RECORD";

export class LmdbStoreError extends Error {
  constructor(
    public readonly code: LmdbStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LmdbStoreError";
  }
}

export interface LmdbDurableKvStoreOptions<T> {
  /** Existing private root. It must not itself be a symbolic link. */
  readonly storageRoot: string;
  /** One safe directory name beneath storageRoot, not an arbitrary path. */
  readonly databaseDirectory?: string;
  /**
   * A shared {@link LmdbEnvironment} to open against instead of owning one.
   * When provided, this store is a typed view over an environment owned and
   * closed by the caller, so several record schemas can share one environment
   * without opening it more than once. When omitted, the store opens and owns
   * its own environment (the standalone default).
   */
  readonly environment?: LmdbEnvironment;
  /** Envelope schema accepted by this store. */
  readonly schema: string;
  readonly codec: DurableRecordCodec<T>;
  /** Domain generation remains separate from LMDB's numeric storage version. */
  readonly generationOf: (value: T) => string;
  readonly nowMs?: () => number;
  readonly maxRecordBytes?: number;
}

interface LmdbRangeEntry {
  key: Uint8Array;
  value: unknown;
  version?: number;
}

interface LmdbRangeOptions {
  start?: Uint8Array;
  end?: Uint8Array;
  versions?: boolean;
  snapshot?: boolean;
}

interface LmdbBinaryDatabase {
  getEntry(key: Uint8Array): { value: unknown; version?: number } | undefined;
  putSync(key: Uint8Array, value: unknown, version: number): void;
  removeSync(key: Uint8Array, ifVersion?: number): boolean;
  getRange(options: LmdbRangeOptions): Iterable<LmdbRangeEntry>;
  transaction<T>(action: () => T): Promise<T>;
  close(): Promise<void>;
}

export type LmdbExistingInspection<T> =
  | { readonly kind: "missing" }
  | { readonly kind: "available"; readonly value: T };

/** Whether `segments` begins with every component of `prefix`, in order. */
function segmentsHavePrefix(segments: readonly string[], prefix: readonly string[]): boolean {
  if (segments.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (segments[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * Smallest key byte sequence that sorts strictly after every key sharing the
 * given byte prefix. Durable key segment bytes never reach 0xFF, so in practice
 * only the final byte increments; the carry loop is defensive.
 */
function namespaceUpperBound(prefix: Uint8Array): Uint8Array {
  const upper = Uint8Array.from(prefix);
  for (let index = upper.length - 1; index >= 0; index -= 1) {
    if (upper[index] < 0xff) {
      upper[index] += 1;
      return upper.subarray(0, index + 1);
    }
  }
  // An all-0xFF prefix has no finite successor; the per-entry decoded-prefix
  // guard then bounds the scan instead of this range end.
  return upper;
}

/**
 * Decode a range key and confirm it belongs to the namespace prefix. Matching
 * on decoded components rather than a raw byte substring makes a prefix such as
 * `observer\0runtime` refuse to match `observer\0runtime-index`.
 */
function matchNamespaceKey(rawKey: Uint8Array, prefix: readonly string[]): string | null {
  const key = Buffer.from(rawKey).toString("utf8");
  let segments: readonly string[];
  try {
    segments = decodeDurableKey(key);
  } catch {
    // A key outside our canonical namespace cannot belong to this prefix.
    return null;
  }
  return segmentsHavePrefix(segments, prefix) ? key : null;
}

function assertSafeDatabaseDirectory(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)) {
    throw new LmdbStoreError(
      "INVALID_OPTIONS",
      "LMDB databaseDirectory must be one lowercase safe directory name.",
    );
  }
  return value;
}

function assertExistingPrivateDirectory(path: string, label: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new LmdbStoreError("INVALID_ROOT", `${label} does not exist: ${path}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LmdbStoreError("INVALID_ROOT", `${label} must be a non-linked directory: ${path}`);
  }
  try {
    return realpathSync.native(path);
  } catch (error) {
    throw new LmdbStoreError("INVALID_ROOT", `${label} could not be resolved: ${path}`, { cause: error });
  }
}

function openEnvironmentDirectory(storageRoot: string, databaseDirectory: string): string {
  const root = resolve(storageRoot);
  const canonicalRoot = assertExistingPrivateDirectory(root, "LMDB storage root");
  const candidate = resolveManagedPath(root, join(root, databaseDirectory), "no-links");
  try {
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new LmdbStoreError("INVALID_ROOT", `Could not create LMDB environment: ${candidate}`, { cause: error });
  }
  const canonicalEnvironment = assertExistingPrivateDirectory(candidate, "LMDB environment");
  if (!isPathContained(canonicalRoot, canonicalEnvironment)) {
    throw new LmdbStoreError("INVALID_ROOT", "LMDB environment escapes the configured storage root.");
  }
  return canonicalEnvironment;
}

/**
 * Resolve an already-existing LMDB environment without creating any path.
 * A missing root, environment directory, or data file is exact absence. Other
 * filesystem failures and linked/private-root violations fail closed.
 */
function existingEnvironmentDirectory(
  storageRoot: string,
  databaseDirectory: string,
): LmdbExistingInspection<string> {
  const root = resolve(storageRoot);
  try {
    lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new LmdbStoreError("INVALID_ROOT", `Could not inspect LMDB storage root: ${root}`, { cause: error });
  }
  const canonicalRoot = assertExistingPrivateDirectory(root, "LMDB storage root");
  const candidate = resolveManagedPath(root, join(root, databaseDirectory), "no-links");
  try {
    lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new LmdbStoreError("INVALID_ROOT", `Could not inspect LMDB environment: ${candidate}`, { cause: error });
  }
  const canonicalEnvironment = assertExistingPrivateDirectory(candidate, "LMDB environment");
  if (!isPathContained(canonicalRoot, canonicalEnvironment)) {
    throw new LmdbStoreError("INVALID_ROOT", "LMDB environment escapes the configured storage root.");
  }
  const dataPath = join(canonicalEnvironment, "data.mdb");
  try {
    const data = lstatSync(dataPath);
    if (data.isSymbolicLink() || !data.isFile()) {
      throw new LmdbStoreError("INVALID_ROOT", `LMDB data file must be a non-linked regular file: ${dataPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    if (error instanceof LmdbStoreError) throw error;
    throw new LmdbStoreError("INVALID_ROOT", `Could not inspect LMDB data file: ${dataPath}`, { cause: error });
  }
  return { kind: "available", value: canonicalEnvironment };
}

function keyBytes(key: string): Uint8Array {
  try {
    const decoded = decodeDurableKey(key);
    if (encodeDurableKey(...decoded) !== key) throw new Error("non-canonical key");
  } catch (error) {
    throw new LmdbStoreError("INVALID_KEY", "LMDB keys must use the canonical durable-key namespace.", {
      cause: error,
    });
  }
  const bytes = Buffer.from(key, "utf8");
  if (bytes.byteLength > MAX_LMDB_KEY_BYTES) {
    throw new LmdbStoreError("INVALID_KEY", `LMDB key exceeds the ${MAX_LMDB_KEY_BYTES}-byte limit.`);
  }
  return bytes;
}

function assertRecordLimit(value: Uint8Array, maxRecordBytes: number): void {
  if (value.byteLength > maxRecordBytes) {
    throw new LmdbStoreError(
      "RECORD_TOO_LARGE",
      `LMDB record exceeds its ${maxRecordBytes}-byte limit.`,
    );
  }
}

function assertTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LmdbStoreError("INVALID_OPTIONS", "LMDB envelope timestamp must be a non-negative safe integer.");
  }
  return value;
}

export type LmdbInspection<T> =
  | { kind: "missing" }
  | { kind: "valid"; value: T; version: number }
  | { kind: "corrupt"; version: number; rawSha256: string; message: string };

function entryVersion(entry: { version?: number }): number {
  const version = entry.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new LmdbStoreError("CORRUPT_RECORD", "LMDB record has no valid storage version.");
  }
  return version;
}

/**
 * Sole owner of one LMDB environment (`open()` once, `close()` once), shareable
 * by several typed {@link LmdbDurableKvStore} views over distinct namespaced
 * keys. Plan 90 mandates one environment per *managed store*, not one per record
 * type; injecting a single environment keeps that invariant even when several
 * record schemas coexist in the same environment — for example the workbench
 * lifecycle and spawn-journal records under one `WorkbenchProcessGuard`, which
 * must not open the environment twice.
 */
export class LmdbEnvironment {
  private readonly databaseDirectory: string;
  private database: LmdbBinaryDatabase | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly storageRoot: string,
    databaseDirectory: string = DEFAULT_DATABASE_DIRECTORY,
  ) {
    this.databaseDirectory = assertSafeDatabaseDirectory(databaseDirectory);
  }

  /** Lazily open (once) and return the shared binary database handle. */
  open(): LmdbBinaryDatabase {
    if (this.closed) throw new LmdbStoreError("CLOSED", "LMDB store is closed.");
    if (this.database) return this.database;
    const environmentPath = openEnvironmentDirectory(this.storageRoot, this.databaseDirectory);
    try {
      this.database = open<unknown, Uint8Array>(environmentPath, {
        encoding: "binary",
        keyEncoding: "binary",
        useVersions: true,
        maxDbs: 1,
        commitDelay: 0,
        noSync: false,
        noMetaSync: false,
        // Windows uses ordinary synchronous commits here. A separate durable
        // flush operation can be added only after callers require that claim.
        overlappingSync: false,
      });
    } catch (error) {
      throw new LmdbStoreError("INVALID_ROOT", `Could not open LMDB environment: ${environmentPath}`, {
        cause: error,
      });
    }
    return this.database;
  }

  /**
   * Run a synchronous read against existing storage only. An already-open
   * writer handle is reused; otherwise a temporary read-only handle is opened
   * and closed around the callback. No missing directory is materialized.
   */
  async inspectExisting<T>(
    action: (database: LmdbBinaryDatabase) => T,
  ): Promise<LmdbExistingInspection<T>> {
    if (this.closed) throw new LmdbStoreError("CLOSED", "LMDB store is closed.");
    if (this.database) return { kind: "available", value: action(this.database) };
    const environment = existingEnvironmentDirectory(this.storageRoot, this.databaseDirectory);
    if (environment.kind === "missing") return environment;
    let database: LmdbBinaryDatabase;
    try {
      database = open<unknown, Uint8Array>(environment.value, {
        encoding: "binary",
        keyEncoding: "binary",
        useVersions: true,
        maxDbs: 1,
        readOnly: true,
      });
    } catch (error) {
      throw new LmdbStoreError("INVALID_ROOT", `Could not open existing LMDB environment: ${environment.value}`, {
        cause: error,
      });
    }
    try {
      return { kind: "available", value: action(database) };
    } finally {
      await database.close();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (!this.database) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    const database = this.database;
    this.closePromise = database.close().finally(() => {
      this.database = null;
    });
    return this.closePromise;
  }
}

/**
 * LMDB-backed implementation of the narrow durable KV port.
 *
 * Reads are synchronous inside the LMDB read transaction, while public writes
 * remain asynchronous through lmdb-js transactions. The environment opens
 * lazily and is owned by this store instance; callers must close it explicitly.
 */
export class LmdbDurableKvStore<T> implements DurableKvStore<T> {
  private readonly databaseDirectory: string;
  private readonly maxRecordBytes: number;
  private readonly nowMs: () => number;
  private readonly environment: LmdbEnvironment;
  private readonly ownsEnvironment: boolean;

  constructor(private readonly options: LmdbDurableKvStoreOptions<T>) {
    this.databaseDirectory = assertSafeDatabaseDirectory(
      options.databaseDirectory ?? DEFAULT_DATABASE_DIRECTORY,
    );
    if (options.schema.length === 0) {
      throw new LmdbStoreError("INVALID_OPTIONS", "LMDB schema must be non-empty.");
    }
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1) {
      throw new LmdbStoreError("INVALID_OPTIONS", "LMDB maxRecordBytes must be a positive safe integer.");
    }
    this.nowMs = options.nowMs ?? Date.now;
    // Share a caller-owned environment when injected; otherwise own one. A
    // shared environment is closed by its provider, never by this typed view.
    this.environment = options.environment ?? new LmdbEnvironment(options.storageRoot, this.databaseDirectory);
    this.ownsEnvironment = options.environment === undefined;
  }

  async read(key: string): Promise<DurableKvRecord<T> | null> {
    const bytes = keyBytes(key);
    const entry = this.openDatabase().getEntry(bytes);
    if (!entry) return null;
    const version = entryVersion(entry);
    return { value: this.decodeStoredValue(entry.value), version };
  }

  /**
   * Non-throwing inspection used by callers that must distinguish missing,
   * valid, and corrupt state (for example to archive corrupt bytes) instead
   * of receiving a thrown `LmdbStoreError` for the corrupt case.
   */
  async inspect(key: string): Promise<LmdbInspection<T>> {
    const bytes = keyBytes(key);
    const entry = this.openDatabase().getEntry(bytes);
    if (!entry) return { kind: "missing" };
    const version = entryVersion(entry);
    const raw = entry.value;
    if (!(raw instanceof Uint8Array)) {
      return {
        kind: "corrupt",
        version,
        rawSha256: sha256Hex(new Uint8Array()),
        message: "LMDB record is not stored as binary bytes.",
      };
    }
    const rawBytes = new Uint8Array(raw);
    const rawSha256 = sha256Hex(rawBytes);
    try {
      return { kind: "valid", value: this.decodeStoredValue(rawBytes), version };
    } catch (error) {
      return {
        kind: "corrupt",
        version,
        rawSha256,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Read one record without creating a missing root or LMDB environment. */
  async inspectExisting(key: string): Promise<LmdbExistingInspection<LmdbInspection<T>>> {
    const bytes = keyBytes(key);
    return this.environment.inspectExisting((database) => this.inspectDatabaseEntry(database, bytes));
  }

  /**
   * Raw stored bytes and storage version without decoding. Used only by
   * callers that must archive corrupt bytes as external evidence before
   * removing the record (see `LmdbCasStore.archiveCorrupt`).
   */
  async readRaw(key: string): Promise<{ version: number; bytes: Uint8Array } | null> {
    const bytes = keyBytes(key);
    const entry = this.openDatabase().getEntry(bytes);
    if (!entry) return null;
    const version = entryVersion(entry);
    if (!(entry.value instanceof Uint8Array)) {
      throw new LmdbStoreError("CORRUPT_RECORD", "LMDB record is not stored as binary bytes.");
    }
    return { version, bytes: new Uint8Array(entry.value) };
  }

  async put(
    key: string,
    value: T,
    expectedVersion: number | null,
    assertCommitAllowed?: () => void,
  ): Promise<DurableKvPutResult<T>> {
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new LmdbStoreError("INVALID_OPTIONS", "Expected LMDB storage version must be null or positive.");
    }
    const encoded = this.encodeStoredValue(value);
    const bytes = keyBytes(key);
    const database = this.openDatabase();
    assertCommitAllowed?.();
    return database.transaction(() => {
      const existing = database.getEntry(bytes);
      const actualVersion = existing ? entryVersion(existing) : null;
      if (actualVersion !== expectedVersion) {
        return { kind: "conflict", actualVersion } as const;
      }
      // The transaction callback may run after the caller yielded. Re-check
      // cooperative authority at the final synchronous commit boundary so a
      // lost machine mutex can never publish a late write.
      assertCommitAllowed?.();
      const nextVersion = actualVersion === null ? 1 : actualVersion + 1;
      database.putSync(bytes, asBinary(encoded), nextVersion);
      return {
        kind: "replaced",
        current: { value, version: nextVersion },
      } as const;
    });
  }

  async remove(
    key: string,
    expectedVersion: number,
    assertCommitAllowed?: () => void,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new LmdbStoreError("INVALID_OPTIONS", "Expected LMDB storage version must be positive.");
    }
    const bytes = keyBytes(key);
    const database = this.openDatabase();
    assertCommitAllowed?.();
    return database.transaction(() => {
      const existing = database.getEntry(bytes);
      if (!existing || entryVersion(existing) !== expectedVersion) return false;
      assertCommitAllowed?.();
      return database.removeSync(bytes, expectedVersion);
    });
  }

  async list(prefix: readonly string[], limit: number): Promise<DurableKvListPage<T>> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new LmdbStoreError("INVALID_OPTIONS", "LMDB list limit must be a positive safe integer.");
    }
    const scan = this.namespaceScan(prefix);
    const entries: DurableKvListEntry<T>[] = [];
    let truncated = false;
    // `snapshot` pins one read view for the whole iteration so a concurrent
    // writer cannot tear the page; iteration is synchronous, so nothing else
    // in this process interleaves either.
    for (const entry of scan.database.getRange({
      start: scan.start,
      end: scan.end,
      versions: true,
      snapshot: true,
    })) {
      const key = matchNamespaceKey(entry.key, scan.prefix);
      if (key === null) continue;
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push(this.classifyListEntry(key, entry));
    }
    return { entries, truncated };
  }

  /** Namespace scan over existing storage only. */
  async listExisting(
    prefix: readonly string[],
    limit: number,
  ): Promise<LmdbExistingInspection<DurableKvListPage<T>>> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new LmdbStoreError("INVALID_OPTIONS", "LMDB list limit must be a positive safe integer.");
    }
    const range = this.namespaceRange(prefix);
    return this.environment.inspectExisting((database) => this.listDatabase(database, range, limit));
  }

  async stats(prefix: readonly string[]): Promise<DurableKvNamespaceStats> {
    const scan = this.namespaceScan(prefix);
    let count = 0;
    let totalValueBytes = 0;
    for (const entry of scan.database.getRange({
      start: scan.start,
      end: scan.end,
      snapshot: true,
    })) {
      if (matchNamespaceKey(entry.key, scan.prefix) === null) continue;
      count += 1;
      // Corrupt records still occupy the store, so they count toward both the
      // record total and the aggregate stored-byte budget.
      totalValueBytes += entry.value instanceof Uint8Array ? entry.value.byteLength : 0;
    }
    return { count, totalValueBytes };
  }

  /** Namespace usage over existing storage only. */
  async statsExisting(prefix: readonly string[]): Promise<LmdbExistingInspection<DurableKvNamespaceStats>> {
    const range = this.namespaceRange(prefix);
    return this.environment.inspectExisting((database) => this.statsDatabase(database, range));
  }

  async close(): Promise<void> {
    // Only release an environment this store opened; a shared, injected
    // environment is owned and closed by its provider.
    if (this.ownsEnvironment) return this.environment.close();
    return Promise.resolve();
  }

  private openDatabase(): LmdbBinaryDatabase {
    return this.environment.open();
  }

  private namespaceScan(prefix: readonly string[]): {
    database: LmdbBinaryDatabase;
    start: Uint8Array;
    end: Uint8Array;
    prefix: readonly string[];
  } {
    const range = this.namespaceRange(prefix);
    return { database: this.openDatabase(), ...range };
  }

  private namespaceRange(prefix: readonly string[]): {
    start: Uint8Array;
    end: Uint8Array;
    prefix: readonly string[];
  } {
    let encoded: string;
    try {
      encoded = encodeDurableKey(...prefix);
    } catch (error) {
      throw new LmdbStoreError(
        "INVALID_KEY",
        "LMDB namespace prefix must use the canonical durable-key namespace.",
        { cause: error },
      );
    }
    const start = Buffer.from(encoded, "utf8");
    return { start, end: namespaceUpperBound(start), prefix };
  }

  private inspectDatabaseEntry(database: LmdbBinaryDatabase, bytes: Uint8Array): LmdbInspection<T> {
    const entry = database.getEntry(bytes);
    if (!entry) return { kind: "missing" };
    const version = entryVersion(entry);
    const raw = entry.value;
    if (!(raw instanceof Uint8Array)) {
      return {
        kind: "corrupt",
        version,
        rawSha256: sha256Hex(new Uint8Array()),
        message: "LMDB record is not stored as binary bytes.",
      };
    }
    const rawBytes = new Uint8Array(raw);
    try {
      return { kind: "valid", value: this.decodeStoredValue(rawBytes), version };
    } catch (error) {
      return {
        kind: "corrupt",
        version,
        rawSha256: sha256Hex(rawBytes),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private listDatabase(
    database: LmdbBinaryDatabase,
    range: { start: Uint8Array; end: Uint8Array; prefix: readonly string[] },
    limit: number,
  ): DurableKvListPage<T> {
    const entries: DurableKvListEntry<T>[] = [];
    let truncated = false;
    for (const entry of database.getRange({
      start: range.start,
      end: range.end,
      versions: true,
      snapshot: true,
    })) {
      const key = matchNamespaceKey(entry.key, range.prefix);
      if (key === null) continue;
      if (entries.length >= limit) {
        truncated = true;
        break;
      }
      entries.push(this.classifyListEntry(key, entry));
    }
    return { entries, truncated };
  }

  private statsDatabase(
    database: LmdbBinaryDatabase,
    range: { start: Uint8Array; end: Uint8Array; prefix: readonly string[] },
  ): DurableKvNamespaceStats {
    let count = 0;
    let totalValueBytes = 0;
    for (const entry of database.getRange({
      start: range.start,
      end: range.end,
      snapshot: true,
    })) {
      if (matchNamespaceKey(entry.key, range.prefix) === null) continue;
      count += 1;
      totalValueBytes += entry.value instanceof Uint8Array ? entry.value.byteLength : 0;
    }
    return { count, totalValueBytes };
  }

  private classifyListEntry(key: string, entry: LmdbRangeEntry): DurableKvListEntry<T> {
    const raw = entry.value;
    const rawBytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array();
    const valueBytes = rawBytes.byteLength;
    let version: number;
    try {
      version = entryVersion(entry);
    } catch (error) {
      // A record without a usable storage version is corrupt at the storage
      // layer; surface it without a version instead of aborting the scan.
      return {
        kind: "corrupt",
        key,
        version: 0,
        valueBytes,
        rawSha256: sha256Hex(rawBytes),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!(raw instanceof Uint8Array)) {
      return {
        kind: "corrupt",
        key,
        version,
        valueBytes: 0,
        rawSha256: sha256Hex(new Uint8Array()),
        message: "LMDB record is not stored as binary bytes.",
      };
    }
    try {
      return { kind: "valid", key, value: this.decodeStoredValue(rawBytes), version, valueBytes };
    } catch (error) {
      return {
        kind: "corrupt",
        key,
        version,
        valueBytes,
        rawSha256: sha256Hex(rawBytes),
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private encodeStoredValue(value: T): Uint8Array {
    const domainBytes = this.options.codec.encode(value);
    const generation = this.options.generationOf(value);
    const envelope: DurableRecordEnvelope = {
      version: 1,
      schema: this.options.schema,
      generation,
      writtenAtMs: assertTimestamp(this.nowMs()),
      value: domainBytes,
    };
    const bytes = encodeDurableEnvelope(envelope);
    assertRecordLimit(bytes, this.maxRecordBytes);
    return bytes;
  }

  private decodeStoredValue(raw: unknown): T {
    if (!(raw instanceof Uint8Array)) {
      throw new LmdbStoreError("CORRUPT_RECORD", "LMDB record is not stored as binary bytes.");
    }
    assertRecordLimit(raw, this.maxRecordBytes);
    const envelope = decodeDurableEnvelope(new Uint8Array(raw), { schema: this.options.schema });
    const value = this.options.codec.decode(envelope.value);
    let generation: string;
    try {
      generation = this.options.generationOf(value);
    } catch (error) {
      throw new LmdbStoreError("CORRUPT_RECORD", "LMDB record generation could not be derived.", {
        cause: error,
      });
    }
    if (generation !== envelope.generation) {
      throw new LmdbStoreError("CORRUPT_RECORD", "LMDB envelope generation does not match its value.");
    }
    return value;
  }
}
