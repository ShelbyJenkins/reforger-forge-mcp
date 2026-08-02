import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { asBinary, open } from "lmdb";
import { describe, expect, it } from "vitest";
import { encodeDurableKey, jsonDurableRecordCodec } from "../../src/foundation/durable-kv.js";
import { BoundedJsonStore } from "../../src/foundation/json-store.js";
import { LmdbDurableKvStore } from "../../src/foundation/lmdb-store.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { durableKvStoreContract } from "./durable-kv-contract.js";

interface TestRecord {
    generation: string;
    state: string;
}

function parseTestRecord(value: unknown): TestRecord {
    if (!value || typeof value !== "object") throw new Error("object required");
    const record = value as Partial<TestRecord>;
    if (typeof record.generation !== "string" || typeof record.state !== "string") {
        throw new Error("record fields are invalid");
    }
    return { generation: record.generation, state: record.state };
}

const key = encodeDurableKey("observer", "runtime", "rt-123");
const codec = jsonDurableRecordCodec(parseTestRecord);

function createStore(root: string, nowMs = 1_000): LmdbDurableKvStore<TestRecord> {
    return new LmdbDurableKvStore({
        storageRoot: root,
        schema: "test-record-v1",
        codec,
        generationOf: (value) => value.generation,
        nowMs: () => nowMs,
    });
}

function runCasWorker(root: string, generation: string): Promise<unknown> {
    const workerPath = fileURLToPath(new URL("./lmdb-store-worker.ts", import.meta.url));
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", workerPath, root, generation], {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let errorOutput = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { output += chunk; });
        child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`LMDB worker exited with ${code}: ${errorOutput}`));
                return;
            }
            try {
                resolve(JSON.parse(output.trim()));
            } catch (error) {
                reject(new Error(`LMDB worker returned invalid JSON: ${output}`, { cause: error }));
            }
        });
    });
}

function replaceRawValue(root: string, value: Uint8Array, version: number): Promise<void> {
    const database = open<unknown, Uint8Array>(`${root}/durable-kv-v1`, {
        encoding: "binary",
        keyEncoding: "binary",
        useVersions: true,
        maxDbs: 1,
        overlappingSync: false,
    });
    database.putSync(Buffer.from(key, "utf8"), asBinary(value), version);
    return database.close();
}

function writeRawAt(root: string, encodedKey: string, value: Uint8Array, version = 1): Promise<void> {
    const database = open<unknown, Uint8Array>(`${root}/durable-kv-v1`, {
        encoding: "binary",
        keyEncoding: "binary",
        useVersions: true,
        maxDbs: 1,
        overlappingSync: false,
    });
    database.putSync(Buffer.from(encodedKey, "utf8"), asBinary(value), version);
    return database.close();
}

durableKvStoreContract("LMDB", (root) => createStore(root));

describe("LMDB durable KV store", () => {
    it("opens lazily and reports missing state", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            await expect(store.read(key)).resolves.toBeNull();
            expect(await store.close()).toBeUndefined();
            await store.close();
        }, { prefix: "rfo-lmdb-missing-" });
    });

    it("persists an envelope and increments storage versions", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            const first = await store.put(key, { generation: "g1", state: "new" }, null);
            expect(first).toEqual({ kind: "replaced", current: { value: { generation: "g1", state: "new" }, version: 1 } });
            await expect(store.read(key)).resolves.toEqual({
                value: { generation: "g1", state: "new" },
                version: 1,
            });

            const second = await store.put(key, { generation: "g2", state: "running" }, 1);
            expect(second).toEqual({ kind: "replaced", current: { value: { generation: "g2", state: "running" }, version: 2 } });
            await store.close();

            const reopened = createStore(root, 2_000);
            await expect(reopened.read(key)).resolves.toEqual({
                value: { generation: "g2", state: "running" },
                version: 2,
            });
            await reopened.close();
        }, { prefix: "rfo-lmdb-persist-" });
    });

    it("rechecks a cooperative commit fence inside put and remove transactions", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            const leaseLoss = Object.assign(new Error("fixture mutex lease lost"), {
                code: "RECOVERY_REQUIRED",
            });
            let checks = 0;
            const loseAtCommit = (): void => {
                checks += 1;
                if (checks === 2) throw leaseLoss;
            };

            await expect(store.put(
                key,
                { generation: "g1", state: "new" },
                null,
                loseAtCommit,
            )).rejects.toBe(leaseLoss);
            await expect(store.read(key)).resolves.toBeNull();

            await store.put(key, { generation: "g1", state: "new" }, null);
            checks = 0;
            await expect(store.remove(key, 1, loseAtCommit)).rejects.toBe(leaseLoss);
            await expect(store.read(key)).resolves.toMatchObject({
                value: { generation: "g1", state: "new" },
                version: 1,
            });
            await store.close();
        }, { prefix: "rfo-lmdb-fence-" });
    });

    it("allows exactly one of two same-version writers", async () => {
        await withTemporaryDirectory(async (root) => {
            const first = createStore(root);
            const second = createStore(root);
            await first.put(key, { generation: "g1", state: "new" }, null);

            const results = await Promise.all([
                first.put(key, { generation: "g2-a", state: "running" }, 1),
                second.put(key, { generation: "g2-b", state: "running" }, 1),
            ]);
            expect(results.filter((result) => result.kind === "replaced")).toHaveLength(1);
            expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
            await first.close();
            await second.close();
        }, { prefix: "rfo-lmdb-cas-" });
    });

    it("allows exactly one same-version writer across two Node processes", async () => {
        await withTemporaryDirectory(async (root) => {
            const seed = createStore(root);
            await seed.put(key, { generation: "g1", state: "new" }, null);
            await seed.close();

            const results = await Promise.all([
                runCasWorker(root, "g2-process-a"),
                runCasWorker(root, "g2-process-b"),
            ]);
            expect(results.filter((result) => (result as { kind: string }).kind === "replaced")).toHaveLength(1);
            expect(results.filter((result) => (result as { kind: string }).kind === "conflict")).toHaveLength(1);
        }, { prefix: "rfo-lmdb-process-cas-" });
    });

    it("maps missing and stale removal to false", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            await expect(store.remove(key, 1)).resolves.toBe(false);
            await store.put(key, { generation: "g1", state: "new" }, null);
            await expect(store.remove(key, 2)).resolves.toBe(false);
            await expect(store.remove(key, 1)).resolves.toBe(true);
            await expect(store.read(key)).resolves.toBeNull();
            await store.close();
        }, { prefix: "rfo-lmdb-remove-" });
    });

    it("rejects unsafe keys, oversized records, and use after close", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = new LmdbDurableKvStore({
                storageRoot: root,
                schema: "test-record-v1",
                codec,
                generationOf: (value) => value.generation,
                maxRecordBytes: 64,
            });
            await expect(store.read("not-a-v1-key")).rejects.toMatchObject({ code: "INVALID_KEY" });
            await expect(store.put(key, { generation: "g1", state: "x".repeat(200) }, null))
                .rejects.toMatchObject({ code: "RECORD_TOO_LARGE" });
            await store.close();
            await expect(store.read(key)).rejects.toMatchObject({ code: "CLOSED" });
        }, { prefix: "rfo-lmdb-errors-" });
    });

    it("fails closed for malformed and generation-mismatched stored bytes", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            await store.put(key, { generation: "g1", state: "new" }, null);
            await store.close();

            await replaceRawValue(root, new TextEncoder().encode("not json"), 1);
            const malformed = createStore(root);
            await expect(malformed.read(key)).rejects.toMatchObject({ code: "MALFORMED_BYTES" });
            await malformed.close();

            const mismatchedEnvelope = new TextEncoder().encode(JSON.stringify({
                version: 1,
                schema: "test-record-v1",
                generation: "wrong-generation",
                writtenAtMs: 1_000,
                value: Buffer.from(JSON.stringify({ generation: "g1", state: "new" }), "utf8").toString("base64"),
            }));
            await replaceRawValue(root, mismatchedEnvelope, 1);
            const mismatched = createStore(root);
            await expect(mismatched.read(key)).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
            await mismatched.close();
        }, { prefix: "rfo-lmdb-corrupt-" });
    });
});

describe("LMDB namespace list and stats", () => {
    const family = ["observer", "owned-runtime", "runtimes"] as const;
    const memberKey = (id: string): string => encodeDurableKey(...family, id);

    it("reports an empty namespace as empty", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            try {
                await expect(store.list([...family], 10)).resolves.toEqual({ entries: [], truncated: false });
                await expect(store.stats([...family])).resolves.toEqual({ count: 0, totalValueBytes: 0 });
            } finally {
                await store.close();
            }
        }, { prefix: "rfo-lmdb-ns-empty-" });
    });

    it("lists every valid record with its value and storage version", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            try {
                await store.put(memberKey("rt-1"), { generation: "g1", state: "one" }, null);
                await store.put(memberKey("rt-2"), { generation: "g2", state: "two" }, null);
                await store.put(memberKey("rt-2"), { generation: "g3", state: "two-b" }, 1);

                const page = await store.list([...family], 10);
                expect(page.truncated).toBe(false);
                const byKey = new Map(page.entries.map((entry) => [entry.key, entry]));
                expect(byKey.get(memberKey("rt-1"))).toMatchObject({
                    kind: "valid",
                    value: { generation: "g1", state: "one" },
                    version: 1,
                });
                expect(byKey.get(memberKey("rt-2"))).toMatchObject({
                    kind: "valid",
                    value: { generation: "g3", state: "two-b" },
                    version: 2,
                });
            } finally {
                await store.close();
            }
        }, { prefix: "rfo-lmdb-ns-list-" });
    });

    it("matches decoded components so a sibling prefix cannot leak in", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            try {
                await store.put(encodeDurableKey("observer", "runtime", "rt-1"), { generation: "g1", state: "a" }, null);
                await store.put(
                    encodeDurableKey("observer", "runtime-index", "idx-1"),
                    { generation: "g2", state: "b" },
                    null,
                );

                const runtime = await store.list(["observer", "runtime"], 10);
                expect(runtime.entries.map((entry) => entry.key)).toEqual([
                    encodeDurableKey("observer", "runtime", "rt-1"),
                ]);

                const index = await store.list(["observer", "runtime-index"], 10);
                expect(index.entries.map((entry) => entry.key)).toEqual([
                    encodeDurableKey("observer", "runtime-index", "idx-1"),
                ]);

                await expect(store.stats(["observer", "runtime"])).resolves.toMatchObject({ count: 1 });
            } finally {
                await store.close();
            }
        }, { prefix: "rfo-lmdb-ns-collision-" });
    });

    it("bounds a listing by its limit and flags truncation", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            try {
                for (let index = 0; index < 5; index += 1) {
                    await store.put(memberKey(`rt-${index}`), { generation: `g${index}`, state: "x" }, null);
                }

                const bounded = await store.list([...family], 2);
                expect(bounded.entries).toHaveLength(2);
                expect(bounded.truncated).toBe(true);

                const exact = await store.list([...family], 5);
                expect(exact.entries).toHaveLength(5);
                expect(exact.truncated).toBe(false);

                const roomy = await store.list([...family], 50);
                expect(roomy.entries).toHaveLength(5);
                expect(roomy.truncated).toBe(false);
                await expect(store.stats([...family])).resolves.toMatchObject({ count: 5 });
            } finally {
                await store.close();
            }
        }, { prefix: "rfo-lmdb-ns-limit-" });
    });

    it("surfaces a corrupt sibling without hiding the valid records or the count", async () => {
        await withTemporaryDirectory(async (root) => {
            const seed = createStore(root);
            await seed.put(memberKey("rt-1"), { generation: "g1", state: "one" }, null);
            await seed.put(memberKey("rt-2"), { generation: "g2", state: "two" }, null);
            await seed.close();

            await writeRawAt(root, memberKey("rt-bad"), new TextEncoder().encode("not an envelope"));

            const store = createStore(root);
            try {
                const page = await store.list([...family], 10);
                expect(page.truncated).toBe(false);
                expect(page.entries).toHaveLength(3);
                const valid = page.entries.filter((entry) => entry.kind === "valid");
                const corrupt = page.entries.filter((entry) => entry.kind === "corrupt");
                expect(valid).toHaveLength(2);
                expect(corrupt).toHaveLength(1);
                const bad = corrupt[0];
                expect(bad.key).toBe(memberKey("rt-bad"));
                if (bad.kind === "corrupt") {
                    expect(bad.rawSha256).toMatch(/^[a-f0-9]{64}$/);
                    expect(bad.valueBytes).toBeGreaterThan(0);
                }

                // The corrupt record must still count toward the namespace budget.
                await expect(store.stats([...family])).resolves.toMatchObject({ count: 3 });
            } finally {
                await store.close();
            }
        }, { prefix: "rfo-lmdb-ns-corrupt-" });
    });

    it("accounts stored bytes consistently and parities a BoundedJsonStore's record count", async () => {
        await withTemporaryDirectory(async (root) => {
            const records = [
                { id: "rt-1", value: { generation: "g1", state: "one" } },
                { id: "rt-2", value: { generation: "g2", state: "two" } },
                { id: "rt-3", value: { generation: "g3", state: "three" } },
            ];
            const store = createStore(root);
            try {
                for (const record of records) {
                    await store.put(memberKey(record.id), record.value, null);
                }

                const page = await store.list([...family], 100);
                const stats = await store.stats([...family]);

                // stats must agree with an untruncated listing over the same view.
                expect(page.truncated).toBe(false);
                expect(stats.count).toBe(page.entries.length);
                const listedBytes = page.entries.reduce((total, entry) => total + entry.valueBytes, 0);
                expect(stats.totalValueBytes).toBe(listedBytes);
                expect(stats.totalValueBytes).toBeGreaterThan(0);

                // Count parity against the filesystem store this retention policy
                // is ported from. Stored byte totals differ by encoding (LMDB
                // stores a versioned envelope; the JSON store stores a
                // pretty-printed file), so only the record count is a like-for-like
                // admission signal.
                const jsonRoot = join(root, "json-fixture");
                mkdirSync(jsonRoot);
                const jsonStore = new BoundedJsonStore<TestRecord>({
                    root: jsonRoot,
                    maxRecordBytes: 4_096,
                    parse: parseTestRecord,
                });
                for (const record of records) {
                    jsonStore.write(join(jsonRoot, `${record.id}.json`), record.value);
                }
                expect(jsonStore.usage().records).toBe(stats.count);
            } finally {
                await store.close();
            }
        }, { prefix: "rfo-lmdb-ns-parity-" });
    });

    it("rejects an empty prefix and a non-positive limit", async () => {
        await withTemporaryDirectory(async (root) => {
            const store = createStore(root);
            try {
                await expect(store.list([], 10)).rejects.toMatchObject({ code: "INVALID_KEY" });
                await expect(store.stats([])).rejects.toMatchObject({ code: "INVALID_KEY" });
                await expect(store.list([...family], 0)).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
            } finally {
                await store.close();
            }
        }, { prefix: "rfo-lmdb-ns-invalid-" });
    });
});
