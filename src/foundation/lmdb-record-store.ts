import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { asBinary, open } from "lmdb";
import { decodeDurableKey, encodeDurableKey } from "./durable-kv.js";
import { isPathContained, resolveManagedPath } from "./managed-path.js";

/**
 * Synchronous, raw-bytes record store over a single LMDB environment.
 *
 * This is deliberately different from the async, envelope-based
 * `LmdbDurableKvStore`. That store is the right tool for single-record,
 * generation-checked CAS (the process guard, plan 92). This store is the tool
 * for high-frequency, fencing-sensitive, byte-parity-critical multi-record
 * families such as the owned-runtime lifecycle records:
 *
 * - **Synchronous** — every primitive runs inside the caller's
 *   machine-mutex/fencing transaction with no async rewrite, so lease-check
 *   ordering relative to I/O is preserved.
 * - **Raw-JSON values** — the stored value is the caller's exact serialized
 *   bytes (`JSON.stringify(value, null, 2) + "\n"`), so the stored byte length
 *   equals the pre-migration file size. Callers whose capacity/retention model
 *   is calibrated to serialized-JSON file bytes keep byte-for-byte parity.
 * - **No envelope** — the caller owns its own versioning, filename↔content
 *   binding, and generation checks; a storage envelope would be redundant and
 *   would break byte parity.
 *
 * Keys use the canonical durable-key namespace
 * `encodeDurableKey(...prefix, family, id)` so per-family prefix scans are
 * collision-safe (matched on decoded components, never a raw byte substring).
 */

const DEFAULT_DATABASE_DIRECTORY = "records-v1";
/** Fixed namespace prefix shared by every owned-runtime record key. */
const RECORD_KEY_PREFIX = ["observer", "owned-runtime"] as const;
/**
 * Backstop ceiling on the records a single `listIds`/`usage` scan will
 * materialize before it fails closed. A namespace larger than this cannot arise
 * from admitted writes — every caller enforces a far lower aggregate record cap
 * — so exceeding it signals a corrupt, oversized, or tampered environment whose
 * full materialization would defeat the caller's capacity bound. Callers pass
 * their own record cap as `maxScanRecords`; this default only guards callers
 * that do not (for example foundation tests).
 */
const DEFAULT_MAX_SCAN_RECORDS = 1_048_576;

export type LmdbRecordStoreErrorCode =
  | "CLOSED"
  | "INVALID_ROOT"
  | "INVALID_KEY"
  | "INVALID_OPTIONS"
  | "RECORD_TOO_LARGE"
  | "RECORD_EXISTS"
  | "SCAN_LIMIT_EXCEEDED";

export class LmdbRecordStoreError extends Error {
  constructor(
    public readonly code: LmdbRecordStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LmdbRecordStoreError";
  }
}

export interface LmdbRecordUsage {
  records: number;
  /** Σ stored value byteLength across the requested families (== old file sizes). */
  bytes: number;
  byId: Map<string, { id: string; family: string; bytes: number }>;
}

export type LmdbExistingRecordResult<T> =
  | { readonly kind: "missing" }
  | { readonly kind: "available"; readonly value: T };

export interface LmdbExistingRecord {
  readonly family: string;
  readonly id: string;
  /** Null means the value was not stored as LMDB binary data. */
  readonly bytes: Uint8Array | null;
}

export interface LmdbExistingRecordSnapshot {
  readonly records: readonly LmdbExistingRecord[];
  readonly usage: LmdbRecordUsage;
  /** False when an undecodable or structurally unexpected namespace key was observed. */
  readonly complete: boolean;
}

export interface LmdbRecordStoreOptions {
  /** Existing private directory; the env opens at storageRoot/databaseDirectory. */
  readonly storageRoot: string;
  /**
   * Canonical durable-key namespace for this store. The owned-runtime namespace
   * remains the default for existing callers; independent owners must select a
   * distinct prefix rather than sharing its record family names.
   */
  readonly keyPrefix?: readonly string[];
  readonly databaseDirectory?: string;
  readonly maxRecordBytes: number;
  /**
   * Upper bound on the records a single `listIds`/`usage` scan may materialize
   * before failing closed with `SCAN_LIMIT_EXCEEDED`. Defaults to
   * {@link DEFAULT_MAX_SCAN_RECORDS}; pass the caller's own aggregate record cap
   * so a namespace larger than any admissible state is rejected, not scanned.
   */
  readonly maxScanRecords?: number;
}

export interface LmdbExistingSnapshotOptions {
  /**
   * Keep the already-existing read-only environment open for later snapshots.
   * This never creates an environment and never enables writer operations.
   */
  readonly retainOpen?: boolean;
}

interface LmdbRangeEntry {
  key: Uint8Array;
  value: unknown;
}

interface LmdbRangeOptions {
  start?: Uint8Array;
  end?: Uint8Array;
  snapshot?: boolean;
}

interface LmdbBinaryDatabase {
  resetReadTxn(): void;
  doesExist(key: Uint8Array): boolean;
  getBinary(key: Uint8Array): Buffer | undefined;
  putSync(key: Uint8Array, value: unknown): void;
  removeSync(key: Uint8Array): boolean;
  getRange(options: LmdbRangeOptions): Iterable<LmdbRangeEntry>;
  transactionSync<T>(action: () => T): T;
  close(): Promise<void>;
}

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
 * only the final byte increments; the carry loop is defensive. Mirrors the
 * prefix machinery in `lmdb-store.ts`.
 */
function namespaceUpperBound(prefix: Uint8Array): Uint8Array {
  const upper = Uint8Array.from(prefix);
  for (let index = upper.length - 1; index >= 0; index -= 1) {
    if (upper[index] < 0xff) {
      upper[index] += 1;
      return upper.subarray(0, index + 1);
    }
  }
  return upper;
}

/**
 * Decode a range key and confirm it belongs to the namespace prefix, matching
 * on decoded components rather than a raw byte substring so a family such as
 * `owned-runtime\0runtimes` never matches `owned-runtime\0runtime-index`.
 */
function decodeMatchingKey(
  rawKey: Uint8Array,
  prefix: readonly string[],
): readonly string[] | null {
  const key = Buffer.from(rawKey).toString("utf8");
  let segments: readonly string[];
  try {
    segments = decodeDurableKey(key);
  } catch {
    return null;
  }
  return segmentsHavePrefix(segments, prefix) ? segments : null;
}

function assertSafeDatabaseDirectory(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value)) {
    throw new LmdbRecordStoreError(
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
    throw new LmdbRecordStoreError("INVALID_ROOT", `${label} does not exist: ${path}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new LmdbRecordStoreError("INVALID_ROOT", `${label} must be a non-linked directory: ${path}`);
  }
  try {
    return realpathSync.native(path);
  } catch (error) {
    throw new LmdbRecordStoreError("INVALID_ROOT", `${label} could not be resolved: ${path}`, { cause: error });
  }
}

function openEnvironmentDirectory(storageRoot: string, databaseDirectory: string): string {
  const root = resolve(storageRoot);
  const canonicalRoot = assertExistingPrivateDirectory(root, "LMDB storage root");
  const candidate = resolveManagedPath(root, join(root, databaseDirectory), "no-links");
  try {
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new LmdbRecordStoreError("INVALID_ROOT", `Could not create LMDB environment: ${candidate}`, { cause: error });
  }
  const canonicalEnvironment = assertExistingPrivateDirectory(candidate, "LMDB environment");
  if (!isPathContained(canonicalRoot, canonicalEnvironment)) {
    throw new LmdbRecordStoreError("INVALID_ROOT", "LMDB environment escapes the configured storage root.");
  }
  return canonicalEnvironment;
}

function existingEnvironmentDirectory(
  storageRoot: string,
  databaseDirectory: string,
): LmdbExistingRecordResult<string> {
  const root = resolve(storageRoot);
  try {
    lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new LmdbRecordStoreError("INVALID_ROOT", `Could not inspect LMDB storage root: ${root}`, { cause: error });
  }
  const canonicalRoot = assertExistingPrivateDirectory(root, "LMDB storage root");
  const candidate = resolveManagedPath(root, join(root, databaseDirectory), "no-links");
  try {
    lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new LmdbRecordStoreError("INVALID_ROOT", `Could not inspect LMDB environment: ${candidate}`, { cause: error });
  }
  const canonicalEnvironment = assertExistingPrivateDirectory(candidate, "LMDB environment");
  if (!isPathContained(canonicalRoot, canonicalEnvironment)) {
    throw new LmdbRecordStoreError("INVALID_ROOT", "LMDB environment escapes the configured storage root.");
  }
  const dataPath = join(canonicalEnvironment, "data.mdb");
  try {
    const data = lstatSync(dataPath);
    if (data.isSymbolicLink() || !data.isFile()) {
      throw new LmdbRecordStoreError("INVALID_ROOT", `LMDB data file must be a non-linked regular file: ${dataPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    if (error instanceof LmdbRecordStoreError) throw error;
    throw new LmdbRecordStoreError("INVALID_ROOT", `Could not inspect LMDB data file: ${dataPath}`, { cause: error });
  }
  return { kind: "available", value: canonicalEnvironment };
}

function recordKey(keyPrefix: readonly string[], family: string, id: string): Uint8Array {
  let key: string;
  try {
    key = encodeDurableKey(...keyPrefix, family, id);
  } catch (error) {
    throw new LmdbRecordStoreError("INVALID_KEY", "Record family and id must be canonical durable-key segments.", {
      cause: error,
    });
  }
  return Buffer.from(key, "utf8");
}

export class LmdbRecordStore {
  private readonly storageRoot: string;
  private readonly keyPrefix: readonly string[];
  private readonly databaseDirectory: string;
  private readonly maxRecordBytes: number;
  private readonly maxScanRecords: number;
  private database: LmdbBinaryDatabase | null = null;
  private existingDatabase: LmdbBinaryDatabase | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: LmdbRecordStoreOptions) {
    this.storageRoot = options.storageRoot;
    this.keyPrefix = Object.freeze([...(options.keyPrefix ?? RECORD_KEY_PREFIX)]);
    try {
      // Validate the full namespace at construction, before any lazy open or
      // write. A record family/id pair is included because the durable-key
      // encoder validates individual segments, not an empty prefix alone.
      encodeDurableKey(...this.keyPrefix, "namespace", "probe");
    } catch (error) {
      throw new LmdbRecordStoreError(
        "INVALID_OPTIONS",
        "LMDB keyPrefix must contain canonical durable-key segments.",
        { cause: error },
      );
    }
    this.databaseDirectory = assertSafeDatabaseDirectory(
      options.databaseDirectory ?? DEFAULT_DATABASE_DIRECTORY,
    );
    this.maxRecordBytes = options.maxRecordBytes;
    if (!Number.isSafeInteger(this.maxRecordBytes) || this.maxRecordBytes < 1) {
      throw new LmdbRecordStoreError("INVALID_OPTIONS", "LMDB maxRecordBytes must be a positive safe integer.");
    }
    this.maxScanRecords = options.maxScanRecords ?? DEFAULT_MAX_SCAN_RECORDS;
    if (!Number.isSafeInteger(this.maxScanRecords) || this.maxScanRecords < 1) {
      throw new LmdbRecordStoreError("INVALID_OPTIONS", "LMDB maxScanRecords must be a positive safe integer.");
    }
  }

  /** Synchronous existence check (parity with a `existsSync(<family>/<id>.json)`). */
  has(family: string, id: string): boolean {
    return this.db().doesExist(recordKey(this.keyPrefix, family, id));
  }

  /** Exact stored bytes, or null when the record is absent. */
  getRaw(family: string, id: string): Uint8Array | null {
    const value = this.db().getBinary(recordKey(this.keyPrefix, family, id));
    return value === undefined ? null : new Uint8Array(value);
  }

  async hasExisting(family: string, id: string): Promise<LmdbExistingRecordResult<boolean>> {
    const key = recordKey(this.keyPrefix, family, id);
    return this.withExistingDatabase((database) => database.doesExist(key));
  }

  async getRawExisting(
    family: string,
    id: string,
  ): Promise<LmdbExistingRecordResult<Uint8Array | null>> {
    const key = recordKey(this.keyPrefix, family, id);
    return this.withExistingDatabase((database) => {
      const value = database.getBinary(key);
      return value === undefined ? null : new Uint8Array(value);
    });
  }

  /**
   * Store bytes verbatim under (family, id). With `exclusive`, the create is
   * atomic: throw `RECORD_EXISTS` if the key already exists, else write —
   * reproducing `foundationAtomicWriteFile({ exclusive: true })`'s conflict.
   */
  putRaw(family: string, id: string, bytes: Uint8Array, options: { exclusive: boolean }): void {
    if (bytes.byteLength > this.maxRecordBytes) {
      throw new LmdbRecordStoreError(
        "RECORD_TOO_LARGE",
        `LMDB record exceeds its ${this.maxRecordBytes}-byte limit.`,
      );
    }
    const key = recordKey(this.keyPrefix, family, id);
    const value = asBinary(bytes instanceof Buffer ? bytes : Buffer.from(bytes));
    const database = this.db();
    if (!options.exclusive) {
      database.putSync(key, value);
      return;
    }
    database.transactionSync(() => {
      if (database.doesExist(key)) {
        throw new LmdbRecordStoreError("RECORD_EXISTS", "LMDB record already exists.");
      }
      database.putSync(key, value);
    });
  }

  /** Remove a record. Removing a missing key is a no-op returning false. */
  remove(family: string, id: string): boolean {
    return this.db().removeSync(recordKey(this.keyPrefix, family, id));
  }

  /** Sorted ids present in a family namespace (single read snapshot). */
  listIds(family: string): string[] {
    const prefix = [...this.keyPrefix, family];
    const scan = this.namespaceScan(prefix);
    const ids: string[] = [];
    for (const entry of scan.database.getRange({ start: scan.start, end: scan.end, snapshot: true })) {
      const segments = decodeMatchingKey(entry.key, prefix);
      if (segments === null) continue;
      if (ids.length >= this.maxScanRecords) {
        throw new LmdbRecordStoreError(
          "SCAN_LIMIT_EXCEEDED",
          `LMDB family scan exceeded its ${this.maxScanRecords}-record bound.`,
        );
      }
      // segments === [...keyPrefix, family, id]
      ids.push(segments[prefix.length]);
    }
    return ids.sort();
  }

  async listIdsExisting(family: string): Promise<LmdbExistingRecordResult<string[]>> {
    const prefix = [...this.keyPrefix, family];
    return this.withExistingDatabase((database) => this.listIdsFrom(database, prefix));
  }

  /**
   * Σ records/bytes across the requested families, plus a per-record map keyed
   * by the encoded key. Corrupt values still count (parity with a corrupt file
   * that still occupies the namespace). Runs in one read snapshot.
   */
  usage(families: readonly string[]): LmdbRecordUsage {
    const wanted = new Set(families);
    const scan = this.namespaceScan(this.keyPrefix);
    let records = 0;
    let bytes = 0;
    const byId = new Map<string, { id: string; family: string; bytes: number }>();
    for (const entry of scan.database.getRange({ start: scan.start, end: scan.end, snapshot: true })) {
      const segments = decodeMatchingKey(entry.key, this.keyPrefix);
      if (segments === null || segments.length !== this.keyPrefix.length + 2) continue;
      const family = segments[this.keyPrefix.length];
      if (!wanted.has(family)) continue;
      if (records >= this.maxScanRecords) {
        throw new LmdbRecordStoreError(
          "SCAN_LIMIT_EXCEEDED",
          `LMDB usage scan exceeded its ${this.maxScanRecords}-record bound.`,
        );
      }
      const id = segments[this.keyPrefix.length + 1];
      const valueBytes = entry.value instanceof Uint8Array ? entry.value.byteLength : 0;
      records += 1;
      bytes += valueBytes;
      byId.set(Buffer.from(entry.key).toString("utf8"), { id, family, bytes: valueBytes });
    }
    return { records, bytes, byId };
  }

  async usageExisting(
    families: readonly string[],
  ): Promise<LmdbExistingRecordResult<LmdbRecordUsage>> {
    return this.withExistingDatabase((database) => this.usageFrom(database, families));
  }

  /**
   * One existing-only read snapshot for a bounded set of record families.
   * This is the idle-readiness inventory primitive: it never opens the writer
   * accessor and reports malformed/non-binary entries instead of mutating or
   * quarantining them.
   */
  async snapshotExisting(
    families: readonly string[],
    options: LmdbExistingSnapshotOptions = {},
  ): Promise<LmdbExistingRecordResult<LmdbExistingRecordSnapshot>> {
    const wanted = new Set(families);
    return this.withExistingDatabase((database) => {
      const range = this.namespaceRange(this.keyPrefix);
      const records: LmdbExistingRecord[] = [];
      const byId = new Map<string, { id: string; family: string; bytes: number }>();
      let bytes = 0;
      let complete = true;
      for (const entry of database.getRange({ start: range.start, end: range.end, snapshot: true })) {
        const segments = decodeMatchingKey(entry.key, this.keyPrefix);
        if (segments === null || segments.length !== this.keyPrefix.length + 2) {
          complete = false;
          continue;
        }
        const family = segments[this.keyPrefix.length];
        if (!wanted.has(family)) continue;
        if (records.length >= this.maxScanRecords) {
          throw new LmdbRecordStoreError(
            "SCAN_LIMIT_EXCEEDED",
            `LMDB snapshot exceeded its ${this.maxScanRecords}-record bound.`,
          );
        }
        const id = segments[this.keyPrefix.length + 1];
        const raw = entry.value instanceof Uint8Array ? new Uint8Array(entry.value) : null;
        const valueBytes = raw?.byteLength ?? 0;
        bytes += valueBytes;
        records.push({ family, id, bytes: raw });
        byId.set(Buffer.from(entry.key).toString("utf8"), { id, family, bytes: valueBytes });
      }
      records.sort((left, right) => left.family.localeCompare(right.family) || left.id.localeCompare(right.id));
      return {
        records,
        usage: { records: records.length, bytes, byId },
        complete,
      };
    }, options.retainOpen === true);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (!this.database && !this.existingDatabase) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    const databases = [...new Set([
      this.database,
      this.existingDatabase,
    ].filter((database): database is LmdbBinaryDatabase => database !== null))];
    this.closePromise = Promise.all(databases.map((database) => database.close())).then(() => undefined).finally(() => {
      this.database = null;
      this.existingDatabase = null;
    });
    return this.closePromise;
  }

  private db(): LmdbBinaryDatabase {
    if (this.closed) throw new LmdbRecordStoreError("CLOSED", "LMDB record store is closed.");
    if (this.database) return this.database;
    const environmentPath = openEnvironmentDirectory(this.storageRoot, this.databaseDirectory);
    try {
      this.database = open<unknown, Uint8Array>(environmentPath, {
        encoding: "binary",
        keyEncoding: "binary",
        maxDbs: 1,
        commitDelay: 0,
        noSync: false,
        noMetaSync: false,
        overlappingSync: false,
      }) as unknown as LmdbBinaryDatabase;
    } catch (error) {
      throw new LmdbRecordStoreError("INVALID_ROOT", `Could not open LMDB environment: ${environmentPath}`, {
        cause: error,
      });
    }
    return this.database;
  }

  private async withExistingDatabase<T>(
    action: (database: LmdbBinaryDatabase) => T,
    retainOpen = false,
  ): Promise<LmdbExistingRecordResult<T>> {
    if (this.closed) throw new LmdbRecordStoreError("CLOSED", "LMDB record store is closed.");
    if (this.database) return { kind: "available", value: action(this.database) };
    if (this.existingDatabase) {
      // lmdb intentionally reuses a read transaction through the current event
      // turn. A retained diagnostic reader must explicitly renew between
      // snapshots so commits from another process/handle become visible.
      this.existingDatabase.resetReadTxn();
      return { kind: "available", value: action(this.existingDatabase) };
    }
    const environment = existingEnvironmentDirectory(this.storageRoot, this.databaseDirectory);
    if (environment.kind === "missing") return environment;
    let database: LmdbBinaryDatabase;
    try {
      database = open<unknown, Uint8Array>(environment.value, {
        encoding: "binary",
        keyEncoding: "binary",
        maxDbs: 1,
        readOnly: true,
      }) as unknown as LmdbBinaryDatabase;
    } catch (error) {
      throw new LmdbRecordStoreError(
        "INVALID_ROOT",
        `Could not open existing LMDB environment: ${environment.value}`,
        { cause: error },
      );
    }
    if (retainOpen) {
      this.existingDatabase = database;
      return { kind: "available", value: action(database) };
    }
    try {
      return { kind: "available", value: action(database) };
    } finally {
      await database.close();
    }
  }

  private namespaceScan(prefix: readonly string[]): {
    database: LmdbBinaryDatabase;
    start: Uint8Array;
    end: Uint8Array;
  } {
    const range = this.namespaceRange(prefix);
    return { database: this.db(), ...range };
  }

  private namespaceRange(prefix: readonly string[]): { start: Uint8Array; end: Uint8Array } {
    let encoded: string;
    try {
      encoded = encodeDurableKey(...prefix);
    } catch (error) {
      throw new LmdbRecordStoreError(
        "INVALID_KEY",
        "LMDB namespace prefix must use the canonical durable-key namespace.",
        { cause: error },
      );
    }
    const start = Buffer.from(encoded, "utf8");
    return { start, end: namespaceUpperBound(start) };
  }

  private listIdsFrom(database: LmdbBinaryDatabase, prefix: readonly string[]): string[] {
    const range = this.namespaceRange(prefix);
    const ids: string[] = [];
    for (const entry of database.getRange({ start: range.start, end: range.end, snapshot: true })) {
      const segments = decodeMatchingKey(entry.key, prefix);
      if (segments === null) continue;
      if (ids.length >= this.maxScanRecords) {
        throw new LmdbRecordStoreError(
          "SCAN_LIMIT_EXCEEDED",
          `LMDB family scan exceeded its ${this.maxScanRecords}-record bound.`,
        );
      }
      ids.push(segments[prefix.length]);
    }
    return ids.sort();
  }

  private usageFrom(database: LmdbBinaryDatabase, families: readonly string[]): LmdbRecordUsage {
    const wanted = new Set(families);
    const range = this.namespaceRange(this.keyPrefix);
    let records = 0;
    let bytes = 0;
    const byId = new Map<string, { id: string; family: string; bytes: number }>();
    for (const entry of database.getRange({ start: range.start, end: range.end, snapshot: true })) {
      const segments = decodeMatchingKey(entry.key, this.keyPrefix);
      if (segments === null || segments.length !== this.keyPrefix.length + 2) continue;
      const family = segments[this.keyPrefix.length];
      if (!wanted.has(family)) continue;
      if (records >= this.maxScanRecords) {
        throw new LmdbRecordStoreError(
          "SCAN_LIMIT_EXCEEDED",
          `LMDB usage scan exceeded its ${this.maxScanRecords}-record bound.`,
        );
      }
      const id = segments[this.keyPrefix.length + 1];
      const valueBytes = entry.value instanceof Uint8Array ? entry.value.byteLength : 0;
      records += 1;
      bytes += valueBytes;
      byId.set(Buffer.from(entry.key).toString("utf8"), { id, family, bytes: valueBytes });
    }
    return { records, bytes, byId };
  }
}
