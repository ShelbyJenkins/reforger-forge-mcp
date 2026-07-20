import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DurableRecordCodec } from "./durable-kv.js";
import { sha256Hex } from "./digest.js";
import { atomicWriteFile } from "./json-store.js";
import { LmdbDurableKvStore, type LmdbEnvironment } from "./lmdb-store.js";

export type LmdbCasInspection<T> =
  | { kind: "missing" }
  | { kind: "versioned"; value: T; generation: string }
  | { kind: "corrupt"; path: string; rawSha256: string; message: string };

export type LmdbCasResult<T> =
  | { kind: "replaced"; current: { value: T; generation: string } }
  | { kind: "conflict"; actualGeneration: string | null };

export type LmdbCasStoreErrorCode = "CORRUPT_RECORD" | "ARCHIVE_MISMATCH" | "ARCHIVE_CONFLICT";

export class LmdbCasStoreError extends Error {
  constructor(
    public readonly code: LmdbCasStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LmdbCasStoreError";
  }
}

export interface LmdbCasStoreOptions<T> {
  readonly storageRoot: string;
  readonly databaseDirectory?: string;
  /**
   * A shared {@link LmdbEnvironment} to open against. Several CAS stores over
   * distinct keys can pass the same environment so their single owner opens and
   * closes it exactly once. When omitted, the store owns its own environment.
   */
  readonly environment?: LmdbEnvironment;
  readonly key: string;
  /** Used only to build the synthetic display path and archive filename. */
  readonly recordLabel: string;
  readonly schema: string;
  readonly codec: DurableRecordCodec<T>;
  /** Domain generation stays separate from the LMDB storage version. */
  readonly generationOf: (value: T) => string;
  readonly corruptArchiveDir: string;
  readonly maxRecordBytes?: number;
  /**
   * Test-only injection seam invoked immediately before a write is attempted.
   * Returning an Error aborts the write; the error propagates to the caller
   * exactly as a real write failure would.
   */
  readonly beforeCompareAndSwap?: (args: {
    expectedGeneration: string | null;
    next: T;
  }) => Error | void;
  /**
   * Test-only injection seam invoked immediately after a write commits,
   * before `compareAndSwap` returns. Throwing simulates a crash that
   * happens after durable publication but before the caller observes it.
   */
  readonly afterCompareAndSwap?: (args: { generation: string; next: T }) => void;
}

/**
 * Process-guard-facing adapter over `LmdbDurableKvStore`. It presents the
 * process guard's expected CAS shape (missing/versioned/corrupt inspection,
 * generation-checked compare-and-swap, and file-based corrupt archival) so
 * lifecycle/spawn-journal call sites depend only on this narrow surface.
 */
export class LmdbCasStore<T> {
  private readonly store: LmdbDurableKvStore<T>;
  private readonly key: string;
  private readonly generationOf: (value: T) => string;
  private readonly corruptArchiveDir: string;
  private readonly syntheticPath: string;
  private readonly beforeCompareAndSwap: LmdbCasStoreOptions<T>["beforeCompareAndSwap"];
  private readonly afterCompareAndSwap: LmdbCasStoreOptions<T>["afterCompareAndSwap"];

  constructor(options: LmdbCasStoreOptions<T>) {
    this.store = new LmdbDurableKvStore({
      storageRoot: options.storageRoot,
      databaseDirectory: options.databaseDirectory,
      environment: options.environment,
      schema: options.schema,
      codec: options.codec,
      generationOf: options.generationOf,
      maxRecordBytes: options.maxRecordBytes,
    });
    this.key = options.key;
    this.generationOf = options.generationOf;
    this.corruptArchiveDir = options.corruptArchiveDir;
    this.syntheticPath = join(options.corruptArchiveDir, `${options.recordLabel}.json`);
    this.beforeCompareAndSwap = options.beforeCompareAndSwap;
    this.afterCompareAndSwap = options.afterCompareAndSwap;
    mkdirSync(this.corruptArchiveDir, { recursive: true, mode: 0o700 });
  }

  async inspect(): Promise<LmdbCasInspection<T>> {
    const inspected = await this.store.inspect(this.key);
    if (inspected.kind === "missing") return { kind: "missing" };
    if (inspected.kind === "valid") {
      return { kind: "versioned", value: inspected.value, generation: this.generationOf(inspected.value) };
    }
    return {
      kind: "corrupt",
      path: this.syntheticPath,
      rawSha256: inspected.rawSha256,
      message: inspected.message,
    };
  }

  async compareAndSwap(expected: string | null, next: T): Promise<LmdbCasResult<T>> {
    const current = await this.store.inspect(this.key);
    if (current.kind === "corrupt") {
      throw new LmdbCasStoreError(
        "CORRUPT_RECORD",
        `LMDB record is corrupt and cannot be replaced: ${current.message}`,
      );
    }
    const actualGeneration = current.kind === "missing" ? null : this.generationOf(current.value);
    if (actualGeneration !== expected) {
      return { kind: "conflict", actualGeneration };
    }
    const injected = this.beforeCompareAndSwap?.({ expectedGeneration: expected, next });
    if (injected) throw injected;
    const currentVersion = current.kind === "missing" ? null : current.version;
    const result = await this.store.put(this.key, next, currentVersion);
    if (result.kind === "conflict") {
      const fresh = await this.store.inspect(this.key);
      const freshGeneration = fresh.kind === "valid" ? this.generationOf(fresh.value) : null;
      return { kind: "conflict", actualGeneration: freshGeneration };
    }
    const generation = this.generationOf(next);
    this.afterCompareAndSwap?.({ generation, next });
    return { kind: "replaced", current: { value: next, generation } };
  }

  /** Archive raw corrupt bytes as an external evidence file, then remove the LMDB entry. */
  async archiveCorrupt(record: { kind: "corrupt" } & LmdbCasInspection<T>, archivePath: string): Promise<void> {
    const raw = await this.store.readRaw(this.key);
    if (!raw) {
      throw new LmdbCasStoreError("ARCHIVE_MISMATCH", "LMDB record disappeared before archival.");
    }
    if (sha256Hex(raw.bytes) !== record.rawSha256) {
      throw new LmdbCasStoreError("ARCHIVE_MISMATCH", "LMDB record changed before archival.");
    }
    atomicWriteFile({
      root: this.corruptArchiveDir,
      targetPath: archivePath,
      data: raw.bytes,
      maxBytes: Math.max(raw.bytes.length, 1),
      mode: 0o600,
      durable: true,
      exclusive: true,
    });
    const removed = await this.store.remove(this.key, raw.version);
    if (!removed) {
      throw new LmdbCasStoreError("ARCHIVE_CONFLICT", "LMDB record changed before archival removal.");
    }
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}
