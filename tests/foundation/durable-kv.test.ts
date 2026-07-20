import { describe, expect, it } from "vitest";
import {
  decodeDurableEnvelope,
  decodeDurableKey,
  DurableCodecError,
  DurableEnvelopeError,
  encodeDurableEnvelope,
  encodeDurableKey,
  jsonDurableRecordCodec,
  type DurableRecordEnvelope,
} from "../../src/foundation/durable-kv.js";

describe("durable key foundation contract", () => {
  it("round-trips versioned namespaced keys", () => {
    const key = encodeDurableKey("v1-observer", "runtime", "rt-123");

    expect(key).toMatch(/^v1\0/);
    expect(decodeDurableKey(key)).toEqual(["v1-observer", "runtime", "rt-123"]);
  });

  it("uses length prefixes so component boundaries cannot collide", () => {
    expect(encodeDurableKey("observer", "runtime", "ab"))
      .not.toBe(encodeDurableKey("observer", "runtime-ab"));
    expect(encodeDurableKey("observer", "runtime", "a", "bc"))
      .not.toBe(encodeDurableKey("observer", "runtime", "ab", "c"));
  });

  it("rejects separators and non-canonical case", () => {
    expect(() => encodeDurableKey("observer/runtime")).toThrow(RangeError);
    expect(() => encodeDurableKey("observer\\runtime")).toThrow(RangeError);
    expect(() => encodeDurableKey("observer\0runtime")).toThrow(RangeError);
    expect(() => encodeDurableKey("Observer")).toThrow(RangeError);
    expect(() => decodeDurableKey("v2\0observer")).toThrow(RangeError);
  });
});

describe("durable JSON value codec", () => {
  const codec = jsonDurableRecordCodec((value: unknown) => {
    if (!value || typeof value !== "object" || typeof (value as { value?: unknown }).value !== "string") {
      throw new Error("value field required");
    }
    return value as { value: string };
  });

  it("decodes JSON and applies the schema parser", () => {
    expect(codec.decode(codec.encode({ value: "ok" }))).toEqual({ value: "ok" });
    expect(() => codec.decode(new TextEncoder().encode("{bad"))).toThrow(
      expect.objectContaining<Partial<DurableCodecError>>({ code: "MALFORMED_BYTES" }),
    );
    expect(() => codec.decode(new TextEncoder().encode(JSON.stringify({ value: 1 })))).toThrow(
      expect.objectContaining<Partial<DurableCodecError>>({ code: "SCHEMA_INVALID" }),
    );
  });
});

describe("durable envelope contract", () => {
  const envelope: DurableRecordEnvelope = {
    version: 1,
    schema: "observer-runtime-v1",
    generation: "generation-1",
    writtenAtMs: 1_000,
    value: new TextEncoder().encode('{"state":"running"}'),
  };

  it("round-trips schema, generation, timestamp, and bytes", () => {
    const encoded = encodeDurableEnvelope(envelope);
    expect(decodeDurableEnvelope(encoded, { schema: envelope.schema })).toEqual(envelope);
  });

  it("rejects malformed, unknown-version, and wrong-schema envelopes", () => {
    expect(() => decodeDurableEnvelope(new TextEncoder().encode("not json"), {
      schema: envelope.schema,
    })).toThrow(expect.objectContaining<Partial<DurableEnvelopeError>>({ code: "MALFORMED_BYTES" }));

    const unknownVersion = JSON.stringify({ ...envelope, version: 2, value: "" });
    expect(() => decodeDurableEnvelope(new TextEncoder().encode(unknownVersion), {
      schema: envelope.schema,
    })).toThrow(expect.objectContaining<Partial<DurableEnvelopeError>>({ code: "UNSUPPORTED_VERSION" }));

    const wrongSchema = encodeDurableEnvelope({ ...envelope, schema: "other-v1" });
    expect(() => decodeDurableEnvelope(wrongSchema, { schema: envelope.schema })).toThrow(
      expect.objectContaining<Partial<DurableEnvelopeError>>({ code: "UNSUPPORTED_VERSION" }),
    );
  });
});
