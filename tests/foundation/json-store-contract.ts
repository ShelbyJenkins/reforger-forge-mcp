import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedJsonMap,
  BoundedJsonStore,
  JsonStoreError,
  type BoundedJsonStoreOptions,
} from "../../src/foundation/json-store.js";

export interface JsonStoreContractRecord {
  generation: string;
  value: string;
}

export function parseJsonStoreContractRecord(input: unknown): JsonStoreContractRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("object required");
  const value = input as Partial<JsonStoreContractRecord>;
  if (typeof value.generation !== "string" || typeof value.value !== "string") {
    throw new Error("record fields are invalid");
  }
  return { generation: value.generation, value: value.value };
}

type BoundedStoreFactory = (
  options: BoundedJsonStoreOptions<JsonStoreContractRecord>
) => BoundedJsonStore<JsonStoreContractRecord>;

export type AtomicWriteContractAdapter = (
  root: string,
  targetPath: string,
  data: string | Uint8Array
) => void;

function contractRoots(prefix: string): { create: () => string } {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  return {
    create: () => {
      const root = mkdtempSync(join(tmpdir(), prefix));
      roots.push(root);
      return root;
    },
  };
}

/** Canonical read, corruption, containment, and replacement contract. */
export function boundedJsonStoreContract(
  label: string,
  createStore: BoundedStoreFactory = (options) => new BoundedJsonStore(options)
): void {
  describe(`${label} bounded JSON contract`, () => {
    const roots = contractRoots("json-store-contract-");

    it("bounds a read before invoking the schema parser", () => {
      const root = roots.create();
      let parseCalls = 0;
      const store = createStore({
        root,
        maxRecordBytes: 64,
        parse: (value) => {
          parseCalls += 1;
          return parseJsonStoreContractRecord(value);
        },
      });
      writeFileSync(join(root, "too-large.json"), "x".repeat(65));

      expect(() => store.read(join(root, "too-large.json"))).toThrow(
        expect.objectContaining<Partial<JsonStoreError>>({ code: "RECORD_TOO_LARGE" })
      );
      expect(parseCalls).toBe(0);
    });

    it("reports corrupt state with the digest of the rejected bytes", () => {
      const root = roots.create();
      const store = createStore({ root, maxRecordBytes: 1_024, parse: parseJsonStoreContractRecord });
      writeFileSync(join(root, "corrupt.json"), "{nope");

      const corrupt = store.inspect(join(root, "corrupt.json"));
      expect(corrupt).toMatchObject({ kind: "corrupt", byteLength: 5 });
      if (corrupt.kind === "corrupt") expect(corrupt.rawSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(() => store.read(join(root, "corrupt.json"))).toThrow(
        expect.objectContaining<Partial<JsonStoreError>>({ code: "CORRUPT_JSON" })
      );
    });

    it("rejects a record reached through an outside directory link", () => {
      const parent = roots.create();
      const root = join(parent, "managed");
      const outside = join(parent, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(join(outside, "record.json"), JSON.stringify({ generation: "g1", value: "outside" }));
      symlinkSync(outside, join(root, "escape"), "junction");
      const store = createStore({ root, maxRecordBytes: 1_024, parse: parseJsonStoreContractRecord });

      expect(() => store.read(join(root, "escape", "record.json"))).toThrow(
        expect.objectContaining<Partial<JsonStoreError>>({ code: "UNSAFE_PATH" })
      );
    });

    it("atomically replaces a complete record without retaining temporaries", () => {
      const root = roots.create();
      const path = join(root, "state.json");
      const store = createStore({ root, maxRecordBytes: 1_024, parse: parseJsonStoreContractRecord });
      store.write(path, { generation: "g1", value: "before" });
      store.write(path, { generation: "g2", value: "after" });

      expect(store.read(path)).toEqual({ generation: "g2", value: "after" });
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });
}

/** Count, aggregate-byte, per-record, and replacement contract for map stores. */
export function boundedJsonMapContract(label: string): void {
  describe(`${label} bounded in-memory contract`, () => {
    it("accounts for replacement without double-counting records or bytes", () => {
      const records = new BoundedJsonMap<string, { text: string }>({
        maxRecords: 2,
        maxEstimatedBytes: 8,
        estimateBytes: (_key, value) => value.text.length,
      });
      records.set("one", { text: "1234" });
      records.set("two", { text: "12" });
      records.set("one", { text: "12345" });
      expect(records.estimatedBytes()).toBe(7);
      expect(() => records.set("three", { text: "1" })).toThrow(
        expect.objectContaining<Partial<JsonStoreError>>({ code: "CAPACITY_EXCEEDED" })
      );
      expect(() => records.set("two", { text: "1234" })).toThrow(
        expect.objectContaining<Partial<JsonStoreError>>({ code: "CAPACITY_EXCEEDED" })
      );
    });
  });
}

/** Thin-adapter publication contract, shared by foundation and observer APIs. */
export function atomicWriteAdapterContract(
  label: string,
  write: AtomicWriteContractAdapter
): void {
  describe(`${label} atomic publication contract`, () => {
    const roots = contractRoots("atomic-write-contract-");

    it("replaces a complete target and leaves no unpublished temporary", () => {
      const root = roots.create();
      const path = join(root, "record.json");
      write(root, path, "before");
      write(root, path, "after");
      expect(readFileSync(path, "utf8")).toBe("after");
      expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("cleans its temporary when final publication fails", () => {
      const root = roots.create();
      const occupied = join(root, "occupied.json");
      mkdirSync(occupied);
      expect(() => write(root, occupied, "value")).toThrow();
      expect(readdirSync(root)).toEqual(["occupied.json"]);
    });

    it("rejects publication through an outside directory link", () => {
      const parent = roots.create();
      const root = join(parent, "managed");
      const outside = join(parent, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      symlinkSync(outside, join(root, "escape"), "junction");
      expect(() => write(root, join(root, "escape", "record.json"), "value")).toThrow();
      expect(readdirSync(outside)).toEqual([]);
    });
  });
}
