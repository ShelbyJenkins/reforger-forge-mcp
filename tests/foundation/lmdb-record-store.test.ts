import { describe, expect, it } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LmdbRecordStore,
  LmdbRecordStoreError,
} from "../../src/foundation/lmdb-record-store.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const FAMILIES = ["runtimes", "pending-starts", "idempotency", "prepared", "prepared-index"] as const;

function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function withStore<T>(
  run: (store: LmdbRecordStore, root: string) => Promise<T> | T,
  maxRecordBytes = 1_048_576,
): Promise<T> {
  return withTemporaryDirectory(async (root) => {
    const store = new LmdbRecordStore({ storageRoot: root, maxRecordBytes });
    try {
      return await run(store, root);
    } finally {
      await store.close();
    }
  }, { prefix: "rfo-record-store-" });
}

describe("LmdbRecordStore", () => {
  it("returns exact absence without creating a missing owned-runtime root", async () => {
    await withTemporaryDirectory(async (root) => {
      const missingRoot = join(root, "state", "owned-runtimes-v1");
      const store = new LmdbRecordStore({ storageRoot: missingRoot, maxRecordBytes: 4_096 });
      await expect(store.snapshotExisting(FAMILIES, { retainOpen: true })).resolves.toEqual({ kind: "missing" });
      await expect(store.hasExisting("runtimes", "rt-1")).resolves.toEqual({ kind: "missing" });
      expect(existsSync(missingRoot)).toBe(false);
      await store.close();
    }, { prefix: "rfo-record-existing-absent-" });
  });

  it("takes one existing-only inventory through open and temporary read-only handles", async () => {
    await withTemporaryDirectory(async (root) => {
      const writer = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096 });
      const runtime = serialize({ runtimeId: "rt-1", state: "running" });
      writer.putRaw("runtimes", "rt-1", runtime, { exclusive: true });
      await expect(writer.snapshotExisting(FAMILIES)).resolves.toMatchObject({
        kind: "available",
        value: { complete: true, usage: { records: 1, bytes: runtime.byteLength } },
      });
      await writer.close();
      const dataPath = join(root, "records-v1", "data.mdb");
      const before = statSync(dataPath).mtimeMs;
      const reader = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096 });
      const snapshot = await reader.snapshotExisting(FAMILIES);
      expect(snapshot).toMatchObject({
        kind: "available",
        value: {
          complete: true,
          records: [{ family: "runtimes", id: "rt-1" }],
        },
      });
      await expect(reader.getRawExisting("runtimes", "rt-1")).resolves.toMatchObject({ kind: "available" });
      await reader.close();
      expect(statSync(dataPath).mtimeMs).toBe(before);
    }, { prefix: "rfo-record-existing-readonly-" });
  });

  it("retains an existing read-only environment and observes later committed snapshots", async () => {
    await withTemporaryDirectory(async (root) => {
      const writer = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096 });
      const reader = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096 });
      try {
        writer.putRaw("runtimes", "rt-1", serialize({ runtimeId: "rt-1" }), { exclusive: true });
        await expect(reader.snapshotExisting(FAMILIES, { retainOpen: true })).resolves.toMatchObject({
          kind: "available",
          value: { records: [{ family: "runtimes", id: "rt-1" }] },
        });

        writer.putRaw("runtimes", "rt-2", serialize({ runtimeId: "rt-2" }), { exclusive: true });
        const refreshed = await reader.snapshotExisting(FAMILIES, { retainOpen: true });
        expect(refreshed.kind).toBe("available");
        if (refreshed.kind === "available") {
          expect(refreshed.value.records.map(({ id }) => id)).toEqual(["rt-1", "rt-2"]);
        }
      } finally {
        await Promise.all([reader.close(), writer.close()]);
      }
    }, { prefix: "rfo-record-existing-retained-" });
  });

  it("round-trips exact bytes with byte parity against serialized JSON", async () => {
    await withStore((store) => {
      const bytes = serialize({ runtimeId: "rt-1", state: "running" });
      store.putRaw("runtimes", "rt-abc", bytes, { exclusive: true });
      const read = store.getRaw("runtimes", "rt-abc");
      expect(read).not.toBeNull();
      expect(Buffer.from(read!)).toEqual(bytes);
      expect(read!.byteLength).toBe(bytes.byteLength);
      expect(store.has("runtimes", "rt-abc")).toBe(true);
      expect(store.getRaw("runtimes", "rt-missing")).toBeNull();
      expect(store.has("runtimes", "rt-missing")).toBe(false);
    });
  });

  it("fails an exclusive create when the key already exists, and replaces otherwise", async () => {
    await withStore((store) => {
      store.putRaw("runtimes", "rt-1", serialize({ v: 1 }), { exclusive: true });
      expect(() => store.putRaw("runtimes", "rt-1", serialize({ v: 2 }), { exclusive: true }))
        .toThrowError(LmdbRecordStoreError);
      try {
        store.putRaw("runtimes", "rt-1", serialize({ v: 2 }), { exclusive: true });
      } catch (error) {
        expect((error as LmdbRecordStoreError).code).toBe("RECORD_EXISTS");
      }
      // The failed exclusive create left the original untouched.
      expect(Buffer.from(store.getRaw("runtimes", "rt-1")!).toString("utf8")).toContain("\"v\": 1");
      // A non-exclusive write replaces in place.
      store.putRaw("runtimes", "rt-1", serialize({ v: 3 }), { exclusive: false });
      expect(Buffer.from(store.getRaw("runtimes", "rt-1")!).toString("utf8")).toContain("\"v\": 3");
    });
  });

  it("removes records and reports whether a key was present", async () => {
    await withStore((store) => {
      store.putRaw("stops", "rt-1", serialize({ v: 1 }), { exclusive: true });
      expect(store.remove("stops", "rt-1")).toBe(true);
      expect(store.has("stops", "rt-1")).toBe(false);
      expect(store.remove("stops", "rt-1")).toBe(false);
    });
  });

  it("isolates per-family listIds and resists sibling-family collisions", async () => {
    await withStore((store) => {
      // A runtimeId appears as a basename in several families.
      store.putRaw("runtimes", "rt-1", serialize({ a: 1 }), { exclusive: true });
      store.putRaw("runtimes", "rt-2", serialize({ a: 2 }), { exclusive: true });
      store.putRaw("pending-starts", "rt-1", serialize({ b: 1 }), { exclusive: true });
      store.putRaw("prepared-index", "rt-1", serialize({ c: 1 }), { exclusive: true });
      expect(store.listIds("runtimes")).toEqual(["rt-1", "rt-2"]);
      expect(store.listIds("pending-starts")).toEqual(["rt-1"]);
      expect(store.listIds("prepared-index")).toEqual(["rt-1"]);
      expect(store.listIds("idempotency")).toEqual([]);
    });
  });

  it("isolates independent owners that use the same record family", async () => {
    await withTemporaryDirectory(async (root) => {
      const ownedRuntime = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096 });
      const runs = new LmdbRecordStore({
        storageRoot: root,
        keyPrefix: ["observer", "runs"],
        maxRecordBytes: 4_096,
      });
      try {
        ownedRuntime.putRaw("run", "20260720t010203z-deadbeef", serialize({ owner: "runtime" }), { exclusive: true });
        runs.putRaw("run", "20260720t010203z-deadbeef", serialize({ owner: "runs" }), { exclusive: true });
        expect(Buffer.from(ownedRuntime.getRaw("run", "20260720t010203z-deadbeef")!).toString("utf8"))
          .toContain("runtime");
        expect(Buffer.from(runs.getRaw("run", "20260720t010203z-deadbeef")!).toString("utf8"))
          .toContain("runs");
        expect(ownedRuntime.usage(["run"]).records).toBe(1);
        expect(runs.usage(["run"]).records).toBe(1);
      } finally {
        await Promise.all([ownedRuntime.close(), runs.close()]);
      }
    }, { prefix: "rfo-record-store-" });
  });

  it("sums usage bytes equal to the total stored bytes and counts corrupt values", async () => {
    await withStore((store) => {
      const a = serialize({ runtimeId: "rt-1" });
      const b = serialize({ runtimeId: "rt-2", extra: "x".repeat(50) });
      const corrupt = Buffer.from("{ not json", "utf8");
      store.putRaw("runtimes", "rt-1", a, { exclusive: true });
      store.putRaw("pending-starts", "rt-2", b, { exclusive: true });
      store.putRaw("idempotency", "start-abc", corrupt, { exclusive: true });

      const usage = store.usage(FAMILIES);
      expect(usage.records).toBe(3);
      expect(usage.bytes).toBe(a.byteLength + b.byteLength + corrupt.byteLength);
      // Corrupt value is never parsed but still counts in usage and listIds.
      expect(store.listIds("idempotency")).toEqual(["start-abc"]);
      const perId = [...usage.byId.values()].sort((left, right) => left.id.localeCompare(right.id));
      expect(perId).toEqual([
        { id: "rt-1", family: "runtimes", bytes: a.byteLength },
        { id: "rt-2", family: "pending-starts", bytes: b.byteLength },
        { id: "start-abc", family: "idempotency", bytes: corrupt.byteLength },
      ]);
    });
  });

  it("scopes usage to the requested families only", async () => {
    await withStore((store) => {
      store.putRaw("runtimes", "rt-1", serialize({ a: 1 }), { exclusive: true });
      store.putRaw("idempotency", "start-1", serialize({ b: 1 }), { exclusive: true });
      const usage = store.usage(["runtimes"]);
      expect(usage.records).toBe(1);
      expect([...usage.byId.values()].map((entry) => entry.family)).toEqual(["runtimes"]);
    });
  });

  it("rejects a record that exceeds maxRecordBytes", async () => {
    await withStore((store) => {
      expect(() => store.putRaw("runtimes", "rt-1", Buffer.alloc(64), { exclusive: true }))
        .toThrowError(/exceeds its 32-byte limit/);
    }, 32);
  });

  it("rejects a non-canonical family or id segment", async () => {
    await withStore((store) => {
      expect(() => store.putRaw("Runtimes", "rt-1", serialize({}), { exclusive: true }))
        .toThrowError(LmdbRecordStoreError);
      expect(() => store.has("runtimes", "rt/1")).toThrowError(LmdbRecordStoreError);
    });
  });

  it("fails listIds and usage closed once a scan exceeds the record bound", async () => {
    await withTemporaryDirectory(async (root) => {
      const store = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096, maxScanRecords: 2 });
      try {
        store.putRaw("runtimes", "rt-1", serialize({ v: 1 }), { exclusive: true });
        store.putRaw("runtimes", "rt-2", serialize({ v: 2 }), { exclusive: true });
        // Exactly at the bound still materializes.
        expect(store.listIds("runtimes")).toEqual(["rt-1", "rt-2"]);
        expect(store.usage(["runtimes"]).records).toBe(2);
        // One record past the bound fails closed instead of materializing.
        store.putRaw("runtimes", "rt-3", serialize({ v: 3 }), { exclusive: true });
        expect(() => store.listIds("runtimes")).toThrowError(/exceeded its 2-record bound/);
        try {
          store.usage(["runtimes"]);
        } catch (error) {
          expect((error as LmdbRecordStoreError).code).toBe("SCAN_LIMIT_EXCEEDED");
        }
        expect(() => store.usage(["runtimes"])).toThrowError(LmdbRecordStoreError);
      } finally {
        await store.close();
      }
    }, { prefix: "rfo-record-store-" });
  });

  it("rejects a non-positive maxScanRecords", async () => {
    await withTemporaryDirectory((root) => {
      expect(() => new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096, maxScanRecords: 0 }))
        .toThrowError(/maxScanRecords/);
    }, { prefix: "rfo-record-store-" });
  });

  it("persists across a close and reopen on the same root", async () => {
    await withTemporaryDirectory(async (root) => {
      const first = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096 });
      first.putRaw("runtimes", "rt-1", serialize({ v: 1 }), { exclusive: true });
      await first.close();
      expect(() => first.has("runtimes", "rt-1")).toThrowError(/closed/);

      const second = new LmdbRecordStore({ storageRoot: root, maxRecordBytes: 4_096 });
      expect(store2Read(second)).toContain("\"v\": 1");
      await second.close();
    }, { prefix: "rfo-record-store-" });
  });
});

function store2Read(store: LmdbRecordStore): string {
  const raw = store.getRaw("runtimes", "rt-1");
  return raw === null ? "" : Buffer.from(raw).toString("utf8");
}
