import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertRegularManagedFile,
  canonicalizeExistingDirectory,
  ensureManagedDirectory,
  resolveManagedPath,
} from "./managed-path.js";
import { sha256Hex } from "./digest.js";

export type JsonStoreErrorCode =
  | "INVALID_BOUNDS"
  | "UNSAFE_PATH"
  | "NOT_REGULAR_FILE"
  | "RECORD_TOO_SMALL"
  | "RECORD_TOO_LARGE"
  | "CORRUPT_JSON"
  | "SCHEMA_INVALID"
  | "CAPACITY_EXCEEDED"
  | "CAS_CONFLICT"
  | "ATOMIC_WRITE_FAILED";

export class JsonStoreError extends Error {
  constructor(
    public readonly code: JsonStoreErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "JsonStoreError";
  }
}

export interface Missing {
  kind: "missing";
}

export interface Versioned<T> {
  kind: "versioned";
  value: T;
  generation: string;
  byteLength: number;
  sha256: string;
}

export interface CorruptJsonRecord {
  kind: "corrupt";
  path: string;
  byteLength: number;
  rawSha256: string;
  message: string;
}

export type BoundedJsonInspection<T> =
  | Missing
  | { kind: "valid"; value: T; byteLength: number; sha256: string }
  | CorruptJsonRecord;

export type JsonCasInspection<T> = Missing | Versioned<T> | CorruptJsonRecord;

export type CasResult<T> =
  | { kind: "replaced"; current: Versioned<T> }
  | { kind: "conflict"; actualGeneration: string | null };

export interface JsonCasPort<T> {
  read(): Promise<Versioned<T> | Missing>;
  compareAndSwap(expected: string | null, next: T): Promise<CasResult<T>>;
}

const MISSING: Missing = Object.freeze({ kind: "missing" });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertBound(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new JsonStoreError("INVALID_BOUNDS", `${label} must be a safe integer of at least ${minimum}`);
  }
}

interface BoundedBytes {
  kind: "bytes";
  bytes: Buffer;
  path: string;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  // Node exposes stable dev/ino pairs on supported filesystems. If a platform
  // cannot provide them, the before/after canonical-path checks still apply.
  return (left.dev === 0n && left.ino === 0n) || (right.dev === 0n && right.ino === 0n) ||
    (left.dev === right.dev && left.ino === right.ino);
}

function sameStableMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readBoundedBytes(
  root: string,
  targetPath: string,
  minimumBytes: number,
  maximumBytes: number
): BoundedBytes | Missing {
  let target: string;
  try {
    target = resolveManagedPath(root, targetPath, "link-safe");
  } catch (error) {
    throw new JsonStoreError("UNSAFE_PATH", errorMessage(error), { cause: error });
  }
  let initial;
  try {
    initial = lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return MISSING;
    throw error;
  }
  if (initial.isSymbolicLink()) {
    throw new JsonStoreError("UNSAFE_PATH", `JSON record is a symbolic link: ${target}`);
  }
  if (!initial.isFile()) {
    throw new JsonStoreError("NOT_REGULAR_FILE", `JSON record is not a regular file: ${target}`);
  }
  try {
    assertRegularManagedFile(root, target);
  } catch (error) {
    throw new JsonStoreError("UNSAFE_PATH", errorMessage(error), { cause: error });
  }

  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(target, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) {
      throw new JsonStoreError("NOT_REGULAR_FILE", `JSON record is not a regular file: ${target}`);
    }
    if (!sameFile(initial, opened)) {
      throw new JsonStoreError("UNSAFE_PATH", `JSON record changed identity while being opened: ${target}`);
    }
    if (opened.size < BigInt(minimumBytes)) {
      throw new JsonStoreError(
        "RECORD_TOO_SMALL",
        `JSON record is smaller than its ${minimumBytes}-byte minimum: ${target}`
      );
    }
    if (opened.size > BigInt(maximumBytes)) {
      throw new JsonStoreError(
        "RECORD_TOO_LARGE",
        `JSON record exceeds its ${maximumBytes}-byte limit: ${target}`
      );
    }
    // Re-check the directory entry after opening. This detects ordinary link
    // or replacement races without trusting a path-only preflight.
    const canonical = assertRegularManagedFile(root, target);
    const current = statSync(canonical, { bigint: true });
    if (!sameFile(opened, current)) {
      throw new JsonStoreError("UNSAFE_PATH", `JSON record changed identity while being opened: ${target}`);
    }
    const bytes = readFileSync(descriptor);
    if (BigInt(bytes.length) !== opened.size || bytes.length > maximumBytes) {
      throw new JsonStoreError("RECORD_TOO_LARGE", `JSON record changed size while being read: ${target}`);
    }
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameStableMetadata(opened, afterRead)) {
      throw new JsonStoreError("UNSAFE_PATH", `JSON record changed while being read: ${target}`);
    }
    const finalCanonical = assertRegularManagedFile(root, target);
    const finalEntry = statSync(finalCanonical, { bigint: true });
    if (!sameFile(opened, finalEntry)) {
      throw new JsonStoreError("UNSAFE_PATH", `JSON record changed identity while being read: ${target}`);
    }
    return { kind: "bytes", bytes, path: target };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new JsonStoreError("UNSAFE_PATH", `JSON record is a symbolic link: ${target}`, { cause: error });
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export interface AtomicWriteFileOptions {
  root: string;
  targetPath: string;
  data: string | Uint8Array;
  /** A hard publication bound; callers must choose it explicitly. */
  maxBytes: number;
  mode?: number;
  /** Create only; publication fails atomically if the target already exists. */
  exclusive?: boolean;
  /** Flush file contents before publication. */
  durable?: boolean;
}

/**
 * Publish complete bytes from a same-directory private temporary.
 * Replacement uses rename; exclusive creation uses an atomic hard-link publish
 * so a check-then-rename race cannot overwrite a concurrent creator.
 */
export function atomicWriteFile(options: AtomicWriteFileOptions): void {
  assertBound(options.maxBytes, 1, "Atomic write byte limit");
  const bytes = typeof options.data === "string" ? Buffer.from(options.data, "utf8") : Buffer.from(options.data);
  if (bytes.length > options.maxBytes) {
    throw new JsonStoreError(
      "RECORD_TOO_LARGE",
      `Atomic write exceeds its ${options.maxBytes}-byte limit`
    );
  }

  const root = canonicalizeExistingDirectory(options.root, "Managed root");
  let target: string;
  try {
    target = resolveManagedPath(root, options.targetPath, "link-safe");
  } catch (error) {
    throw new JsonStoreError("UNSAFE_PATH", errorMessage(error), { cause: error });
  }
  let parent: string;
  try {
    parent = ensureManagedDirectory(root, dirname(target));
  } catch (error) {
    throw new JsonStoreError("UNSAFE_PATH", errorMessage(error), { cause: error });
  }
  // Use the canonical parent for both names. A link-safe in-root alias may be
  // accepted, but publication itself never traverses that alias twice.
  target = join(parent, basename(target));
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", options.mode ?? 0o600);
    writeFileSync(descriptor, bytes);
    if (options.durable) fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (options.exclusive) {
      // Linking an already-complete inode is the portable create-new commit.
      linkSync(temporary, target);
      unlinkSync(temporary);
    } else {
      renameSync(temporary, target);
    }
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* preserve the primary failure */ }
    }
    try { unlinkSync(temporary); } catch { /* an unpublished temp may already be absent */ }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new JsonStoreError("CAS_CONFLICT", `Atomic create target already exists: ${target}`, { cause: error });
    }
    if (error instanceof JsonStoreError) throw error;
    throw new JsonStoreError("ATOMIC_WRITE_FAILED", `Atomic write failed: ${errorMessage(error)}`, { cause: error });
  }
}

export interface BoundedJsonStoreOptions<T> {
  root: string;
  maxRecordBytes: number;
  minRecordBytes?: number;
  maxRecords?: number;
  maxTotalBytes?: number;
  mode?: number;
  durable?: boolean;
  parse: (value: unknown) => T;
  serialize?: (value: T) => string;
}

export interface BoundedJsonWriteOptions {
  exclusive?: boolean;
  /** Used only when a wider transaction already checked aggregate capacity. */
  capacityPreflighted?: boolean;
}

export interface BoundedJsonUsage {
  records: number;
  bytes: number;
  maxRecords: number;
  maxBytes: number;
  maxRecordBytes: number;
}

export interface BoundedJsonMapOptions<K, V> {
  maxRecords: number;
  maxEstimatedBytes: number;
  maxRecordEstimatedBytes?: number;
  estimateBytes?: (key: K, value: V) => number;
  capacityError?: () => Error;
}

/**
 * In-memory half of the bounded-store contract. Domain stores retain their
 * own sweep/pinning policy while sharing count, aggregate-byte, and per-record
 * admission. JSON measurement is recomputed so in-place domain mutations do
 * not leave a stale accounting cache.
 */
export class BoundedJsonMap<K, V> extends Map<K, V> {
  readonly maxRecords: number;
  readonly maxEstimatedBytes: number;
  readonly maxRecordEstimatedBytes: number;
  private readonly estimate: (key: K, value: V) => number;
  private readonly capacityError: () => Error;

  constructor(options: BoundedJsonMapOptions<K, V>) {
    super();
    this.maxRecords = options.maxRecords;
    this.maxEstimatedBytes = options.maxEstimatedBytes;
    this.maxRecordEstimatedBytes = options.maxRecordEstimatedBytes ?? options.maxEstimatedBytes;
    assertBound(this.maxRecords, 1, "Bounded JSON map record limit");
    assertBound(this.maxEstimatedBytes, 1, "Bounded JSON map byte limit");
    assertBound(this.maxRecordEstimatedBytes, 1, "Bounded JSON map record byte limit");
    if (this.maxRecordEstimatedBytes > this.maxEstimatedBytes) {
      throw new JsonStoreError("INVALID_BOUNDS", "Bounded JSON map record limit exceeds its aggregate byte limit");
    }
    this.estimate = options.estimateBytes ?? ((key, value) =>
      Buffer.byteLength(JSON.stringify([key, value]), "utf8"));
    this.capacityError = options.capacityError ?? (() =>
      new JsonStoreError("CAPACITY_EXCEEDED", "Bounded JSON map retention budget is exhausted"));
  }

  override set(key: K, value: V): this {
    this.assertCanSet(key, value);
    return super.set(key, value);
  }

  assertCanSet(key: K, value: V): void {
    const replacing = this.get(key);
    const recordBytes = this.measured(key, value);
    const nextRecords = this.size + (replacing === undefined && !this.has(key) ? 1 : 0);
    const nextBytes = this.estimatedBytes() -
      (replacing === undefined && !this.has(key) ? 0 : this.measured(key, replacing as V)) +
      recordBytes;
    if (nextRecords > this.maxRecords || recordBytes > this.maxRecordEstimatedBytes ||
        nextBytes > this.maxEstimatedBytes) {
      throw this.capacityError();
    }
  }

  estimatedBytes(): number {
    let total = 0;
    for (const [key, value] of this) total += this.measured(key, value);
    return total;
  }

  private measured(key: K, value: V): number {
    const bytes = this.estimate(key, value);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new JsonStoreError("INVALID_BOUNDS", "Bounded JSON map estimator returned an invalid byte count");
    }
    return bytes;
  }
}

/** Bounded, link-safe JSON records rooted in one private managed directory. */
export class BoundedJsonStore<T> {
  readonly root: string;
  readonly maxRecordBytes: number;
  readonly minRecordBytes: number;
  readonly maxRecords: number;
  readonly maxTotalBytes: number;
  private readonly mode: number;
  private readonly durable: boolean;
  private readonly parseValue: (value: unknown) => T;
  private readonly serializeValue: (value: T) => string;

  constructor(options: BoundedJsonStoreOptions<T>) {
    this.root = canonicalizeExistingDirectory(options.root, "JSON store root");
    this.maxRecordBytes = options.maxRecordBytes;
    this.minRecordBytes = options.minRecordBytes ?? 1;
    this.maxRecords = options.maxRecords ?? Number.MAX_SAFE_INTEGER;
    this.maxTotalBytes = options.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;
    assertBound(this.minRecordBytes, 0, "JSON record minimum");
    assertBound(this.maxRecordBytes, Math.max(1, this.minRecordBytes), "JSON record byte limit");
    assertBound(this.maxRecords, 1, "JSON store record limit");
    assertBound(this.maxTotalBytes, 1, "JSON store byte limit");
    if (this.maxRecordBytes > this.maxTotalBytes) {
      throw new JsonStoreError("INVALID_BOUNDS", "JSON record byte limit exceeds its store byte limit");
    }
    this.mode = options.mode ?? 0o600;
    this.durable = options.durable ?? false;
    this.parseValue = options.parse;
    this.serializeValue = options.serialize ?? ((value) => `${JSON.stringify(value, null, 2)}\n`);
  }

  inspect(targetPath: string): BoundedJsonInspection<T> {
    const bounded = readBoundedBytes(
      this.root,
      targetPath,
      this.minRecordBytes,
      this.maxRecordBytes
    );
    if (bounded.kind === "missing") return bounded;
    const digest = sha256Hex(bounded.bytes);
    let decoded: unknown;
    try {
      decoded = JSON.parse(bounded.bytes.toString("utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      return {
        kind: "corrupt",
        path: bounded.path,
        byteLength: bounded.bytes.length,
        rawSha256: digest,
        message: `JSON record is not valid JSON: ${errorMessage(error)}`,
      };
    }
    try {
      return {
        kind: "valid",
        value: this.parseValue(decoded),
        byteLength: bounded.bytes.length,
        sha256: digest,
      };
    } catch (error) {
      return {
        kind: "corrupt",
        path: bounded.path,
        byteLength: bounded.bytes.length,
        rawSha256: digest,
        message: `JSON record does not satisfy its schema: ${errorMessage(error)}`,
      };
    }
  }

  read(targetPath: string): T | null {
    const inspected = this.inspect(targetPath);
    if (inspected.kind === "missing") return null;
    if (inspected.kind === "corrupt") {
      throw new JsonStoreError("CORRUPT_JSON", inspected.message);
    }
    return inspected.value;
  }

  encode(value: T): { value: T; text: string; bytes: Buffer; sha256: string } {
    let text: string;
    try {
      text = this.serializeValue(value);
    } catch (error) {
      throw new JsonStoreError("SCHEMA_INVALID", `JSON record cannot be serialized: ${errorMessage(error)}`, { cause: error });
    }
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length < this.minRecordBytes || bytes.length > this.maxRecordBytes) {
      throw new JsonStoreError(
        bytes.length > this.maxRecordBytes ? "RECORD_TOO_LARGE" : "RECORD_TOO_SMALL",
        `JSON record size ${bytes.length} is outside ${this.minRecordBytes} through ${this.maxRecordBytes}`
      );
    }
    let parsed: T;
    try {
      parsed = this.parseValue(JSON.parse(text));
    } catch (error) {
      throw new JsonStoreError("SCHEMA_INVALID", `JSON record does not satisfy its schema: ${errorMessage(error)}`, { cause: error });
    }
    return { value: parsed, text, bytes, sha256: sha256Hex(bytes) };
  }

  write(targetPath: string, value: T, options: BoundedJsonWriteOptions = {}): {
    value: T;
    byteLength: number;
    sha256: string;
  } {
    const encoded = this.encode(value);
    this.writeEncoded(targetPath, encoded.bytes, options);
    return { value: encoded.value, byteLength: encoded.bytes.length, sha256: encoded.sha256 };
  }

  /**
   * Prove aggregate admission for a future publication without mutating it.
   * CAS backends invoke this inside the same serialization boundary as their
   * generation check so helper-mediated writes cannot bypass store bounds.
   */
  assertWriteCapacity(targetPath: string, nextByteLength: number): void {
    assertBound(nextByteLength, 0, "JSON publication byte length");
    if (nextByteLength > this.maxRecordBytes) {
      throw new JsonStoreError(
        "RECORD_TOO_LARGE",
        `JSON record exceeds its ${this.maxRecordBytes}-byte limit`
      );
    }
    const target = resolveManagedPath(this.root, targetPath, "link-safe");
    const usage = this.usage();
    let priorBytes = 0;
    let replacing = false;
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new JsonStoreError("NOT_REGULAR_FILE", `JSON target is not a regular file: ${target}`);
      }
      priorBytes = info.size;
      replacing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const nextRecords = usage.records + (replacing ? 0 : 1);
    const nextBytes = usage.bytes - priorBytes + nextByteLength;
    if (nextRecords > this.maxRecords || nextBytes > this.maxTotalBytes) {
      throw new JsonStoreError("CAPACITY_EXCEEDED", "JSON store retention budget is exhausted");
    }
  }

  usage(): BoundedJsonUsage {
    let records = 0;
    let bytes = 0;
    for (const name of readdirSync(this.root)) {
      const info = lstatSync(join(this.root, name));
      if (info.isDirectory()) continue;
      // Unsafe/unrecognized entries still consume the finite namespace and
      // cannot be used to bypass aggregate admission accounting.
      records += 1;
      bytes += info.size;
    }
    return {
      records,
      bytes,
      maxRecords: this.maxRecords,
      maxBytes: this.maxTotalBytes,
      maxRecordBytes: this.maxRecordBytes,
    };
  }

  private writeEncoded(
    targetPath: string,
    bytes: Buffer,
    options: BoundedJsonWriteOptions
  ): void {
    const target = resolveManagedPath(this.root, targetPath, "link-safe");
    if (!options.capacityPreflighted) {
      this.assertWriteCapacity(target, bytes.length);
    }
    atomicWriteFile({
      root: this.root,
      targetPath: target,
      data: bytes,
      maxBytes: this.maxRecordBytes,
      mode: this.mode,
      durable: this.durable,
      exclusive: options.exclusive,
    });
  }
}

export interface JsonCasBackendRequest<T> {
  path: string;
  expectedGeneration: string | null;
  next: T;
  nextJson: string;
  inspectCurrent: () => JsonCasInspection<T>;
  assertCapacity: () => void;
  publishPlainNode: () => void;
}

export interface JsonArchiveBackendRequest {
  path: string;
  archivePath: string;
  expectedSha256: string;
  archivePlainNode: () => void;
}

export interface JsonCasMutationBackend {
  readonly atomicity: "process-local" | "helper-mediated-cross-process";
  compareAndSwap<T>(request: JsonCasBackendRequest<T>): Promise<{
    kind: "replaced";
  } | {
    kind: "conflict";
    actualGeneration: string | null;
  }>;
  archive(request: JsonArchiveBackendRequest): Promise<void>;
}

const pathLockTails = new Map<string, Promise<void>>();

async function withProcessPathLock<T>(path: string, action: () => Promise<T> | T): Promise<T> {
  const key = resolve(path).toLowerCase();
  const previous = pathLockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  const tail = previous.then(() => turn);
  pathLockTails.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (pathLockTails.get(key) === tail) pathLockTails.delete(key);
  }
}

/**
 * Plain Node CAS is serialized across store instances in this process only.
 * It intentionally makes no cross-process claim; use the helper-mediated
 * backend when a machine mutex or native helper owns that guarantee.
 */
export class PlainNodeJsonCasBackend implements JsonCasMutationBackend {
  readonly atomicity = "process-local" as const;

  compareAndSwap<T>(request: JsonCasBackendRequest<T>): Promise<{
    kind: "replaced";
  } | {
    kind: "conflict";
    actualGeneration: string | null;
  }> {
    return withProcessPathLock(request.path, () => {
      const inspected = request.inspectCurrent();
      if (inspected.kind === "corrupt") {
        throw new JsonStoreError("CORRUPT_JSON", inspected.message);
      }
      const actualGeneration = inspected.kind === "missing" ? null : inspected.generation;
      if (actualGeneration !== request.expectedGeneration) {
        return { kind: "conflict" as const, actualGeneration };
      }
      request.assertCapacity();
      request.publishPlainNode();
      return { kind: "replaced" as const };
    });
  }

  archive(request: JsonArchiveBackendRequest): Promise<void> {
    return withProcessPathLock(request.path, () => request.archivePlainNode());
  }
}

export interface HelperMediatedJsonCasBackendOptions {
  compareAndSwap: (request: {
    path: string;
    expectedGeneration: string | null;
    nextJson: string;
  }) => Promise<void | { kind: "replaced" } | { kind: "conflict"; actualGeneration?: string | null }>;
  archive: (request: {
    path: string;
    archivePath: string;
    expectedSha256: string;
  }) => Promise<void>;
  isConflict?: (error: unknown) => boolean;
}

/** Mutation adapter for state whose CAS must remain inside a native helper. */
export class HelperMediatedJsonCasBackend implements JsonCasMutationBackend {
  readonly atomicity = "helper-mediated-cross-process" as const;

  constructor(private readonly options: HelperMediatedJsonCasBackendOptions) {}

  async compareAndSwap<T>(request: JsonCasBackendRequest<T>): Promise<{
    kind: "replaced";
  } | {
    kind: "conflict";
    actualGeneration: string | null;
  }> {
    const current = request.inspectCurrent();
    if (current.kind === "corrupt") {
      throw new JsonStoreError("CORRUPT_JSON", current.message);
    }
    const actualGeneration = current.kind === "missing" ? null : current.generation;
    if (actualGeneration !== request.expectedGeneration) {
      return { kind: "conflict", actualGeneration };
    }
    request.assertCapacity();
    try {
      const result = await this.options.compareAndSwap({
        path: request.path,
        expectedGeneration: request.expectedGeneration,
        nextJson: request.nextJson,
      });
      if (result?.kind === "conflict") {
        if (!Object.prototype.hasOwnProperty.call(result, "actualGeneration")) {
          return this.currentConflict(request);
        }
        return {
          kind: "conflict",
          actualGeneration: result.actualGeneration ?? null,
        };
      }
      return { kind: "replaced" };
    } catch (error) {
      if (this.options.isConflict?.(error)) {
        return this.currentConflict(request);
      }
      throw error;
    }
  }

  private currentConflict<T>(request: JsonCasBackendRequest<T>): {
    kind: "conflict";
    actualGeneration: string | null;
  } {
    const current = request.inspectCurrent();
    if (current.kind === "corrupt") {
      throw new JsonStoreError("CORRUPT_JSON", current.message);
    }
    return {
      kind: "conflict",
      actualGeneration: current.kind === "missing" ? null : current.generation,
    };
  }

  archive(request: JsonArchiveBackendRequest): Promise<void> {
    return this.options.archive({
      path: request.path,
      archivePath: request.archivePath,
      expectedSha256: request.expectedSha256,
    });
  }
}

export interface JsonCasStoreOptions<T> extends Omit<BoundedJsonStoreOptions<T>, "root"> {
  root: string;
  path: string;
  generationOf: (value: T) => string;
  backend: JsonCasMutationBackend;
}

export class JsonCasStore<T> implements JsonCasPort<T> {
  readonly path: string;
  private readonly records: BoundedJsonStore<T>;
  private readonly generationOf: (value: T) => string;
  private readonly backend: JsonCasMutationBackend;

  constructor(options: JsonCasStoreOptions<T>) {
    this.records = new BoundedJsonStore(options);
    this.path = resolveManagedPath(this.records.root, options.path, "link-safe");
    this.generationOf = options.generationOf;
    this.backend = options.backend;
  }

  async inspect(): Promise<JsonCasInspection<T>> {
    const inspected = this.records.inspect(this.path);
    if (inspected.kind === "missing" || inspected.kind === "corrupt") return inspected;
    return this.versioned(inspected.value, inspected.byteLength, inspected.sha256);
  }

  async read(): Promise<Versioned<T> | Missing> {
    const inspected = await this.inspect();
    if (inspected.kind === "corrupt") {
      throw new JsonStoreError("CORRUPT_JSON", inspected.message);
    }
    return inspected;
  }

  async compareAndSwap(expected: string | null, nextInput: T): Promise<CasResult<T>> {
    const encoded = this.records.encode(nextInput);
    const nextGeneration = this.checkedGeneration(encoded.value);
    const result = await this.backend.compareAndSwap({
      path: this.path,
      expectedGeneration: expected,
      next: encoded.value,
      nextJson: encoded.text,
      inspectCurrent: () => {
        const inspected = this.records.inspect(this.path);
        if (inspected.kind === "missing" || inspected.kind === "corrupt") return inspected;
        return this.versioned(inspected.value, inspected.byteLength, inspected.sha256);
      },
      assertCapacity: () => {
        this.records.assertWriteCapacity(this.path, encoded.bytes.length);
      },
      publishPlainNode: () => {
        this.records.write(this.path, encoded.value, {
          exclusive: expected === null,
          capacityPreflighted: true,
        });
      },
    });
    if (result.kind === "conflict") return result;
    return {
      kind: "replaced",
      current: {
        kind: "versioned",
        value: encoded.value,
        generation: nextGeneration,
        byteLength: encoded.bytes.length,
        sha256: encoded.sha256,
      },
    };
  }

  async archiveCorrupt(record: CorruptJsonRecord, archivePath: string): Promise<void> {
    if (resolve(record.path) !== resolve(this.path)) {
      throw new JsonStoreError("UNSAFE_PATH", "Corrupt JSON record does not belong to this CAS store");
    }
    const archive = resolveManagedPath(this.records.root, archivePath, "link-safe");
    await this.backend.archive({
      path: this.path,
      archivePath: archive,
      expectedSha256: record.rawSha256,
      archivePlainNode: () => {
        const current = this.records.inspect(this.path);
        const actualSha = current.kind === "valid" ? current.sha256
          : current.kind === "corrupt" ? current.rawSha256
            : null;
        if (actualSha !== record.rawSha256) {
          throw new JsonStoreError("CAS_CONFLICT", "JSON record changed before archival");
        }
        if (existsSync(archive)) {
          throw new JsonStoreError("CAS_CONFLICT", `JSON archive target already exists: ${archive}`);
        }
        ensureManagedDirectory(this.records.root, dirname(archive));
        renameSync(this.path, archive);
      },
    });
  }

  private versioned(value: T, byteLength: number, digest: string): Versioned<T> {
    return {
      kind: "versioned",
      value,
      generation: this.checkedGeneration(value),
      byteLength,
      sha256: digest,
    };
  }

  private checkedGeneration(value: T): string {
    const generation = this.generationOf(value);
    if (typeof generation !== "string" || generation.length === 0 || generation.length > 512) {
      throw new JsonStoreError("SCHEMA_INVALID", "JSON record generation is invalid");
    }
    return generation;
  }
}
