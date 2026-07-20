import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { asBinary, open } from "lmdb";
import {
  decodeDurableEnvelope,
  decodeDurableKey,
  encodeDurableEnvelope,
  encodeDurableKey,
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
  /** Envelope schema accepted by this store. */
  readonly schema: string;
  readonly codec: DurableRecordCodec<T>;
  /** Domain generation remains separate from LMDB's numeric storage version. */
  readonly generationOf: (value: T) => string;
  readonly nowMs?: () => number;
  readonly maxRecordBytes?: number;
}

interface LmdbBinaryDatabase {
  getEntry(key: Uint8Array): { value: unknown; version?: number } | undefined;
  putSync(key: Uint8Array, value: unknown, version: number): void;
  removeSync(key: Uint8Array, ifVersion?: number): boolean;
  transaction<T>(action: () => T): Promise<T>;
  close(): Promise<void>;
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
  private database: LmdbBinaryDatabase | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

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
  ): Promise<DurableKvPutResult<T>> {
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
      throw new LmdbStoreError("INVALID_OPTIONS", "Expected LMDB storage version must be null or positive.");
    }
    const encoded = this.encodeStoredValue(value);
    const bytes = keyBytes(key);
    const database = this.openDatabase();
    return database.transaction(() => {
      const existing = database.getEntry(bytes);
      const actualVersion = existing ? entryVersion(existing) : null;
      if (actualVersion !== expectedVersion) {
        return { kind: "conflict", actualVersion } as const;
      }
      const nextVersion = actualVersion === null ? 1 : actualVersion + 1;
      database.putSync(bytes, asBinary(encoded), nextVersion);
      return {
        kind: "replaced",
        current: { value, version: nextVersion },
      } as const;
    });
  }

  async remove(key: string, expectedVersion: number): Promise<boolean> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new LmdbStoreError("INVALID_OPTIONS", "Expected LMDB storage version must be positive.");
    }
    const bytes = keyBytes(key);
    const database = this.openDatabase();
    return database.transaction(() => {
      const existing = database.getEntry(bytes);
      if (!existing || entryVersion(existing) !== expectedVersion) return false;
      return database.removeSync(bytes, expectedVersion);
    });
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

  private openDatabase(): LmdbBinaryDatabase {
    if (this.closed) throw new LmdbStoreError("CLOSED", "LMDB store is closed.");
    if (this.database) return this.database;
    const environmentPath = openEnvironmentDirectory(
      this.options.storageRoot,
      this.databaseDirectory,
    );
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
