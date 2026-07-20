import { encodeDurableKey, jsonDurableRecordCodec } from "../../src/foundation/durable-kv.js";
import { LmdbDurableKvStore } from "../../src/foundation/lmdb-store.js";

interface TestRecord {
  generation: string;
  state: string;
}

const root = process.argv[2];
const generation = process.argv[3];
if (!root || !generation) throw new Error("LMDB worker requires a root and generation.");

const codec = jsonDurableRecordCodec((value: unknown): TestRecord => {
  if (!value || typeof value !== "object") throw new Error("object required");
  const record = value as Partial<TestRecord>;
  if (typeof record.generation !== "string" || typeof record.state !== "string") {
    throw new Error("record fields are invalid");
  }
  return { generation: record.generation, state: record.state };
});

const store = new LmdbDurableKvStore({
  storageRoot: root,
  schema: "test-record-v1",
  codec,
  generationOf: (value) => value.generation,
});

try {
  const result = await store.put(
    encodeDurableKey("observer", "runtime", "rt-123"),
    { generation, state: "child" },
    1,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await store.close();
}
