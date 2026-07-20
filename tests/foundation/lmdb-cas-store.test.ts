import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asBinary, open } from "lmdb";
import { describe, expect, it } from "vitest";
import { encodeDurableKey, jsonDurableRecordCodec } from "../../src/foundation/durable-kv.js";
import { LmdbCasStore } from "../../src/foundation/lmdb-cas-store.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

interface TestRecord {
  generation: string;
  state: string;
}

const key = encodeDurableKey("workbench", "lifecycle");
const codec = jsonDurableRecordCodec((value: unknown): TestRecord => {
  if (!value || typeof value !== "object") throw new Error("object required");
  const record = value as Partial<TestRecord>;
  if (typeof record.generation !== "string" || typeof record.state !== "string") {
    throw new Error("record fields are invalid");
  }
  return { generation: record.generation, state: record.state };
});

function createStore(root: string): LmdbCasStore<TestRecord> {
  return new LmdbCasStore({
    storageRoot: root,
    key,
    recordLabel: "lifecycle",
    schema: "test-cas-record-v1",
    codec,
    generationOf: (value) => value.generation,
    corruptArchiveDir: join(root, "corrupt"),
  });
}

function writeRawBytes(root: string, bytes: Uint8Array, version = 1): Promise<void> {
  const database = open<unknown, Uint8Array>(join(root, "durable-kv-v1"), {
    encoding: "binary",
    keyEncoding: "binary",
    useVersions: true,
    maxDbs: 1,
    overlappingSync: false,
  });
  database.putSync(Buffer.from(key, "utf8"), asBinary(bytes), version);
  return database.close();
}

describe("LmdbCasStore", () => {
  it("reports missing state and inspects a fresh write", async () => {
    await withTemporaryDirectory(async (root) => {
      const store = createStore(root);
      try {
        await expect(store.inspect()).resolves.toEqual({ kind: "missing" });

        const result = await store.compareAndSwap(null, { generation: "g1", state: "new" });
        expect(result).toEqual({
          kind: "replaced",
          current: { value: { generation: "g1", state: "new" }, generation: "g1" },
        });
        await expect(store.inspect()).resolves.toEqual({
          kind: "versioned",
          value: { generation: "g1", state: "new" },
          generation: "g1",
        });
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-lmdb-cas-missing-" });
  });

  it("replaces on a matching generation and conflicts on a stale one", async () => {
    await withTemporaryDirectory(async (root) => {
      const store = createStore(root);
      try {
        await store.compareAndSwap(null, { generation: "g1", state: "new" });

        const conflict = await store.compareAndSwap("stale", { generation: "g2", state: "running" });
        expect(conflict).toEqual({ kind: "conflict", actualGeneration: "g1" });

        const replaced = await store.compareAndSwap("g1", { generation: "g2", state: "running" });
        expect(replaced).toEqual({
          kind: "replaced",
          current: { value: { generation: "g2", state: "running" }, generation: "g2" },
        });
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-lmdb-cas-cas-" });
  });

  it("allows exactly one of two same-generation writers", async () => {
    await withTemporaryDirectory(async (root) => {
      const first = createStore(root);
      const second = createStore(root);
      try {
        await first.compareAndSwap(null, { generation: "g1", state: "new" });

        const results = await Promise.all([
          first.compareAndSwap("g1", { generation: "g2-a", state: "running" }),
          second.compareAndSwap("g1", { generation: "g2-b", state: "running" }),
        ]);
        expect(results.filter((result) => result.kind === "replaced")).toHaveLength(1);
        expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
      } finally {
        await first.close();
        await second.close();
      }
    }, { prefix: "rfo-lmdb-cas-race-" });
  });

  it("detects corrupt bytes and refuses to compare-and-swap over them", async () => {
    await withTemporaryDirectory(async (root) => {
      const store = createStore(root);
      try {
        await writeRawBytes(root, new TextEncoder().encode("{ malformed"));

        const inspected = await store.inspect();
        expect(inspected.kind).toBe("corrupt");
        if (inspected.kind !== "corrupt") return;
        expect(inspected.path).toBe(join(root, "corrupt", "lifecycle.json"));
        expect(inspected.rawSha256).toMatch(/^[a-f0-9]{64}$/);

        await expect(store.compareAndSwap(null, { generation: "g1", state: "new" }))
          .rejects.toMatchObject({ code: "CORRUPT_RECORD" });
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-lmdb-cas-corrupt-" });
  });

  it("archives corrupt bytes to a file and removes the record", async () => {
    await withTemporaryDirectory(async (root) => {
      const store = createStore(root);
      try {
        const rawBytes = new TextEncoder().encode("{ malformed");
        await writeRawBytes(root, rawBytes);

        const inspected = await store.inspect();
        expect(inspected.kind).toBe("corrupt");
        if (inspected.kind !== "corrupt") return;
        const archivePath = join(dirname(inspected.path), `malformed-${Date.now()}.json`);
        await store.archiveCorrupt(inspected, archivePath);

        expect(readFileSync(archivePath)).toEqual(Buffer.from(rawBytes));
        await expect(store.inspect()).resolves.toEqual({ kind: "missing" });
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-lmdb-cas-archive-" });
  });

  it("refuses archival when the record changed since inspection", async () => {
    await withTemporaryDirectory(async (root) => {
      await writeRawBytes(root, new TextEncoder().encode("{ malformed"));
      const inspecting = createStore(root);
      let inspected: Awaited<ReturnType<typeof inspecting.inspect>>;
      try {
        inspected = await inspecting.inspect();
      } finally {
        await inspecting.close();
      }
      expect(inspected.kind).toBe("corrupt");
      if (inspected.kind !== "corrupt") return;

      await writeRawBytes(root, new TextEncoder().encode("{ different malformed"), 2);
      const store = createStore(root);
      try {
        await expect(
          store.archiveCorrupt(inspected, join(root, "corrupt", "malformed-stale.json"))
        ).rejects.toMatchObject({ code: "ARCHIVE_MISMATCH" });
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-lmdb-cas-archive-stale-" });
  });

  it("aborts a write when beforeCompareAndSwap injects a failure", async () => {
    await withTemporaryDirectory(async (root) => {
      const injected = new Error("injected failure");
      const store = new LmdbCasStore<TestRecord>({
        storageRoot: root,
        key,
        recordLabel: "lifecycle",
        schema: "test-cas-record-v1",
        codec,
        generationOf: (value) => value.generation,
        corruptArchiveDir: join(root, "corrupt"),
        beforeCompareAndSwap: () => injected,
      });
      try {
        await expect(store.compareAndSwap(null, { generation: "g1", state: "new" }))
          .rejects.toBe(injected);
        await expect(store.inspect()).resolves.toEqual({ kind: "missing" });
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-lmdb-cas-before-hook-" });
  });

  it("commits the write before afterCompareAndSwap can throw", async () => {
    await withTemporaryDirectory(async (root) => {
      const store = new LmdbCasStore<TestRecord>({
        storageRoot: root,
        key,
        recordLabel: "lifecycle",
        schema: "test-cas-record-v1",
        codec,
        generationOf: (value) => value.generation,
        corruptArchiveDir: join(root, "corrupt"),
        afterCompareAndSwap: () => {
          throw new Error("crash after publish");
        },
      });
      try {
        await expect(store.compareAndSwap(null, { generation: "g1", state: "new" }))
          .rejects.toThrow("crash after publish");
        await expect(store.inspect()).resolves.toEqual({
          kind: "versioned",
          value: { generation: "g1", state: "new" },
          generation: "g1",
        });
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-lmdb-cas-after-hook-" });
  });
});
