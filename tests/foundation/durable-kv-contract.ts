import { describe, expect, it } from "vitest";
import { encodeDurableKey, type DurableKvStore } from "../../src/foundation/durable-kv.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

export interface DurableKvContractRecord {
  generation: string;
  state: string;
}

export type DurableKvStoreFactory = (root: string) => DurableKvStore<DurableKvContractRecord>;

/** Behavioral minimum shared by every durable KV backend. */
export function durableKvStoreContract(
  label: string,
  createStore: DurableKvStoreFactory,
): void {
  describe(`${label} durable KV contract`, () => {
    const key = encodeDurableKey("observer", "runtime", "rt-123");

    it("supports create, read, and monotonic storage versions", async () => {
      await withTemporaryDirectory(async (root) => {
        const store = createStore(root);
        try {
          await expect(store.read(key)).resolves.toBeNull();
          await expect(store.put(key, { generation: "g1", state: "new" }, null)).resolves.toEqual({
            kind: "replaced",
            current: { value: { generation: "g1", state: "new" }, version: 1 },
          });
          await expect(store.put(key, { generation: "g2", state: "running" }, 1)).resolves.toEqual({
            kind: "replaced",
            current: { value: { generation: "g2", state: "running" }, version: 2 },
          });
          await expect(store.read(key)).resolves.toEqual({
            value: { generation: "g2", state: "running" },
            version: 2,
          });
        } finally {
          await store.close();
        }
      }, { prefix: "rfo-durable-contract-" });
    });

    it("preserves a two-writer CAS conflict", async () => {
      await withTemporaryDirectory(async (root) => {
        const first = createStore(root);
        const second = createStore(root);
        try {
          await first.put(key, { generation: "g1", state: "new" }, null);
          const results = await Promise.all([
            first.put(key, { generation: "g2-a", state: "running" }, 1),
            second.put(key, { generation: "g2-b", state: "running" }, 1),
          ]);
          expect(results.filter((result) => result.kind === "replaced")).toHaveLength(1);
          expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
        } finally {
          await first.close();
          await second.close();
        }
      }, { prefix: "rfo-durable-cas-contract-" });
    });

    it("removes only the expected version", async () => {
      await withTemporaryDirectory(async (root) => {
        const store = createStore(root);
        try {
          await expect(store.remove(key, 1)).resolves.toBe(false);
          await store.put(key, { generation: "g1", state: "new" }, null);
          await expect(store.remove(key, 2)).resolves.toBe(false);
          await expect(store.remove(key, 1)).resolves.toBe(true);
          await expect(store.read(key)).resolves.toBeNull();
        } finally {
          await store.close();
        }
      }, { prefix: "rfo-durable-remove-contract-" });
    });
  });
}
