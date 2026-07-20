/**
 * Backend-neutral contracts for durable internal key/value state.
 *
 * This module deliberately has no dependency on a database implementation.
 * In particular, a storage version is not a domain lifecycle generation.
 */
export interface DurableKvRecord<T> {
  readonly value: T;
  readonly version: number;
}

export type DurableKvPutResult<T> =
  | { readonly kind: "replaced"; readonly current: DurableKvRecord<T> }
  | { readonly kind: "conflict"; readonly actualVersion: number | null };

/** Count and aggregate stored-byte accounting for a namespace prefix. */
export interface DurableKvNamespaceStats {
  readonly count: number;
  /** Encoded envelope bytes actually occupying the store, not decoded bytes. */
  readonly totalValueBytes: number;
}

/**
 * One record encountered during a namespace scan. Corrupt siblings are reported
 * in place, mirroring single-record inspection, so a sweep can see the whole
 * namespace instead of aborting on the first bad record.
 */
export type DurableKvListEntry<T> =
  | {
      readonly kind: "valid";
      readonly key: string;
      readonly value: T;
      readonly version: number;
      readonly valueBytes: number;
    }
  | {
      readonly kind: "corrupt";
      readonly key: string;
      readonly version: number;
      readonly valueBytes: number;
      readonly rawSha256: string;
      readonly message: string;
    };

export interface DurableKvListPage<T> {
  readonly entries: ReadonlyArray<DurableKvListEntry<T>>;
  /** True when the namespace holds more matching records than `limit` returned. */
  readonly truncated: boolean;
}

export interface DurableKvStore<T> {
  read(key: string): Promise<DurableKvRecord<T> | null>;
  put(
    key: string,
    value: T,
    expectedVersion: number | null,
  ): Promise<DurableKvPutResult<T>>;
  remove(key: string, expectedVersion: number): Promise<boolean>;
  /**
   * Enumerate up to `limit` records whose key begins with the namespace
   * `prefix`, matched over decoded key components (never a raw substring).
   * A corrupt sibling is surfaced as a `corrupt` entry rather than aborting
   * the scan; `truncated` reports whether more records matched than returned.
   */
  list(prefix: readonly string[], limit: number): Promise<DurableKvListPage<T>>;
  /**
   * Count records and sum their stored value bytes for a namespace `prefix`
   * inside a single read snapshot, so a caller can enforce an aggregate budget
   * before admitting a new record. Corrupt records still contribute to both.
   */
  stats(prefix: readonly string[]): Promise<DurableKvNamespaceStats>;
  close(): Promise<void>;
}

export interface DurableRecordCodec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

export type DurableCodecErrorCode = "MALFORMED_BYTES" | "SCHEMA_INVALID";

export class DurableCodecError extends Error {
  constructor(
    public readonly code: DurableCodecErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DurableCodecError";
  }
}

/**
 * A small JSON value codec for database values. JSON is only the value
 * encoding here; it does not make the underlying durable store file-backed.
 */
export function jsonDurableRecordCodec<T>(
  parse: (value: unknown) => T,
): DurableRecordCodec<T> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();

  return {
    encode(value: T): Uint8Array {
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        throw new DurableCodecError("SCHEMA_INVALID", "Durable value could not be JSON encoded.", {
          cause: error,
        });
      }
      if (text === undefined) {
        throw new DurableCodecError("SCHEMA_INVALID", "Durable value must be JSON encodable.");
      }
      return encoder.encode(text);
    },

    decode(bytes: Uint8Array): T {
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(bytes));
      } catch (error) {
        throw new DurableCodecError("MALFORMED_BYTES", "Durable value is not valid UTF-8 JSON.", {
          cause: error,
        });
      }
      try {
        return parse(value);
      } catch (error) {
        throw new DurableCodecError("SCHEMA_INVALID", "Durable value failed schema validation.", {
          cause: error,
        });
      }
    },
  };
}

export const DURABLE_ENVELOPE_VERSION = 1 as const;

export interface DurableRecordEnvelope {
  readonly version: typeof DURABLE_ENVELOPE_VERSION;
  readonly schema: string;
  readonly generation: string;
  readonly writtenAtMs: number;
  readonly value: Uint8Array;
}

export type DurableEnvelopeErrorCode =
  | "MALFORMED_BYTES"
  | "UNSUPPORTED_VERSION"
  | "SCHEMA_INVALID";

export class DurableEnvelopeError extends Error {
  constructor(
    public readonly code: DurableEnvelopeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DurableEnvelopeError";
  }
}

interface DurableEnvelopeWire {
  version: number;
  schema: string;
  generation: string;
  writtenAtMs: number;
  value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEnvelopeText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DurableEnvelopeError("SCHEMA_INVALID", `Durable envelope ${name} must be non-empty text.`);
  }
}

function assertWrittenAtMs(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DurableEnvelopeError(
      "SCHEMA_INVALID",
      "Durable envelope writtenAtMs must be a non-negative safe integer.",
    );
  }
}

/** Encode the stable wire envelope without exposing database-specific types. */
export function encodeDurableEnvelope(envelope: DurableRecordEnvelope): Uint8Array {
  if (envelope.version !== DURABLE_ENVELOPE_VERSION) {
    throw new DurableEnvelopeError("UNSUPPORTED_VERSION", "Durable envelope version is unsupported.");
  }
  assertEnvelopeText(envelope.schema, "schema");
  assertEnvelopeText(envelope.generation, "generation");
  assertWrittenAtMs(envelope.writtenAtMs);
  if (!(envelope.value instanceof Uint8Array)) {
    throw new DurableEnvelopeError("SCHEMA_INVALID", "Durable envelope value must be bytes.");
  }

  const wire: DurableEnvelopeWire = {
    version: envelope.version,
    schema: envelope.schema,
    generation: envelope.generation,
    writtenAtMs: envelope.writtenAtMs,
    value: Buffer.from(envelope.value).toString("base64"),
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

/**
 * Decode and validate an envelope. The expected schema is intentionally
 * supplied by the record owner so unknown schemas fail closed.
 */
export function decodeDurableEnvelope(
  bytes: Uint8Array,
  options: { readonly schema: string },
): DurableRecordEnvelope {
  assertEnvelopeText(options.schema, "expected schema");

  let wireValue: unknown;
  try {
    wireValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new DurableEnvelopeError("MALFORMED_BYTES", "Durable envelope is not valid UTF-8 JSON.", {
      cause: error,
    });
  }
  if (!isRecord(wireValue)) {
    throw new DurableEnvelopeError("SCHEMA_INVALID", "Durable envelope must be a JSON object.");
  }

  const wire = wireValue as Partial<DurableEnvelopeWire>;
  if (wire.version !== DURABLE_ENVELOPE_VERSION) {
    throw new DurableEnvelopeError("UNSUPPORTED_VERSION", "Durable envelope version is unsupported.");
  }
  assertEnvelopeText(wire.schema, "schema");
  if (wire.schema !== options.schema) {
    throw new DurableEnvelopeError(
      "UNSUPPORTED_VERSION",
      `Durable envelope schema is not supported: ${wire.schema}`,
    );
  }
  assertEnvelopeText(wire.generation, "generation");
  assertWrittenAtMs(wire.writtenAtMs);
  if (typeof wire.value !== "string") {
    throw new DurableEnvelopeError("SCHEMA_INVALID", "Durable envelope value must be base64 text.");
  }

  let value: Buffer;
  try {
    value = Buffer.from(wire.value, "base64");
    if (value.toString("base64") !== wire.value) throw new Error("non-canonical base64");
  } catch (error) {
    throw new DurableEnvelopeError("MALFORMED_BYTES", "Durable envelope value is not valid base64.", {
      cause: error,
    });
  }
  return {
    version: DURABLE_ENVELOPE_VERSION,
    schema: wire.schema,
    generation: wire.generation,
    writtenAtMs: wire.writtenAtMs,
    value: new Uint8Array(value),
  };
}

const DURABLE_KEY_VERSION = "v1";
const DURABLE_KEY_SEPARATOR = "\0";
const DURABLE_KEY_SEGMENT = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

function validateKeySegment(segment: string): void {
  if (!DURABLE_KEY_SEGMENT.test(segment)) {
    throw new RangeError(
      "Durable key segments must be lowercase ASCII identifiers without separators.",
    );
  }
}

/**
 * Encode namespaced key components with length prefixes. Lowercase canonical
 * segments make case-folding behavior explicit instead of platform-dependent.
 */
export function encodeDurableKey(...segments: readonly string[]): string {
  if (segments.length === 0) throw new RangeError("A durable key needs at least one segment.");
  for (const segment of segments) {
    if (typeof segment !== "string") throw new TypeError("Durable key segments must be strings.");
    validateKeySegment(segment);
  }
  return `${DURABLE_KEY_VERSION}${DURABLE_KEY_SEPARATOR}${segments
    .map((segment) => `${segment.length}:${segment}`)
    .join("")}`;
}

/** Decode only keys produced by encodeDurableKey. */
export function decodeDurableKey(key: string): readonly string[] {
  const prefix = `${DURABLE_KEY_VERSION}${DURABLE_KEY_SEPARATOR}`;
  if (!key.startsWith(prefix)) throw new RangeError("Durable key version is unsupported.");

  const segments: string[] = [];
  let offset = prefix.length;
  while (offset < key.length) {
    const separator = key.indexOf(":", offset);
    if (separator === -1) throw new RangeError("Durable key length prefix is malformed.");
    const lengthText = key.slice(offset, separator);
    if (!/^\d+$/u.test(lengthText)) throw new RangeError("Durable key length prefix is malformed.");
    const length = Number(lengthText);
    const start = separator + 1;
    const segment = key.slice(start, start + length);
    if (segment.length !== length) throw new RangeError("Durable key segment is truncated.");
    validateKeySegment(segment);
    segments.push(segment);
    offset = start + length;
  }
  if (segments.length === 0) throw new RangeError("A durable key needs at least one segment.");
  return segments;
}
