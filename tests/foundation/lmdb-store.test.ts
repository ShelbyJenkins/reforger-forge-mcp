import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { asBinary, open } from "lmdb";
import { describe, expect, it } from "vitest";
import { encodeDurableKey, jsonDurableRecordCodec } from "../../src/foundation/durable-kv.js";
import { LmdbDurableKvStore } from "../../src/foundation/lmdb-store.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { durableKvStoreContract } from "./durable-kv-contract.js";

interface TestRecord {
    generation: string;
    state: string;
}

const key = encodeDurableKey("observer", "runtime", "rt-123");
const codec = jsonDurableRecordCodec((value: unknown): TestRecord => {
    if (!value || typeof value !== "object") throw new Error("object required");
    const record = value as Partial<TestRecord>;
    if (typeof record.generation !== "string" || typeof record.state !== "string") {
        throw new Error("record fields are invalid");
    }
    return { generation: record.generation, state: record.state };
});

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
