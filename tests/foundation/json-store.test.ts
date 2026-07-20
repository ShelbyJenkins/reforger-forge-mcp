import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundedOption } from "../../src/foundation/bounded-option.js";
import { sha256Hex } from "../../src/foundation/digest.js";
import {
  BoundedJsonStore,
  HelperMediatedJsonCasBackend,
  JsonCasStore,
  JsonStoreError,
  PlainNodeJsonCasBackend,
  atomicWriteFile,
  type JsonCasMutationBackend,
} from "../../src/foundation/json-store.js";
import {
  boundedJsonMapContract,
  boundedJsonStoreContract,
  jsonCasBackendContract,
  parseJsonStoreContractRecord,
  type JsonStoreContractRecord,
} from "./json-store-contract.js";

type TestRecord = JsonStoreContractRecord;
const parseRecord = parseJsonStoreContractRecord;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "foundation-json-store-"));
  roots.push(root);
  return root;
}

function cas(root: string, backend: JsonCasMutationBackend = new PlainNodeJsonCasBackend()): JsonCasStore<TestRecord> {
  return new JsonCasStore({
    root,
    path: join(root, "state.json"),
    maxRecordBytes: 1_024,
    parse: parseRecord,
    generationOf: (record) => record.generation,
    backend,
    durable: true,
  });
}

function casAt(root: string, path: string, backend: JsonCasMutationBackend): JsonCasStore<TestRecord> {
  return new JsonCasStore({
    root,
    path,
    maxRecordBytes: 1_024,
    parse: parseRecord,
    generationOf: (record) => record.generation,
    backend,
    durable: true,
  });
}

function helperCasPair(root: string, path: string) {
  let tail = Promise.resolve();
  const serialized = <T>(action: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const backend = new HelperMediatedJsonCasBackend({
    compareAndSwap: (request) => serialized(() => {
      let actualGeneration: string | null = null;
      if (existsSync(request.path)) {
        actualGeneration = parseRecord(JSON.parse(readFileSync(request.path, "utf8"))).generation;
      }
      if (actualGeneration !== request.expectedGeneration) {
        return { kind: "conflict" as const, actualGeneration };
      }
      atomicWriteFile({
        root,
        targetPath: request.path,
        data: request.nextJson,
        maxBytes: 1_024,
        exclusive: request.expectedGeneration === null,
      });
      return { kind: "replaced" as const };
    }),
    archive: (request) => serialized(() => {
      if (sha256Hex(readFileSync(request.path)) !== request.expectedSha256) {
        throw new JsonStoreError("CAS_CONFLICT", "helper archive source changed");
      }
      renameSync(request.path, request.archivePath);
    }),
  });
  return {
    first: casAt(root, path, backend),
    second: casAt(root, path, backend),
  };
}

boundedJsonMapContract("BoundedJsonMap");
boundedJsonStoreContract("BoundedJsonStore");
jsonCasBackendContract("plain-Node backend", (root, path) => ({
  first: casAt(root, path, new PlainNodeJsonCasBackend()),
  second: casAt(root, path, new PlainNodeJsonCasBackend()),
}));
jsonCasBackendContract("helper-mediated backend", helperCasPair);

describe("boundedOption", () => {
  it("selects the fallback and rejects unsafe or out-of-range integers", () => {
    expect(boundedOption(undefined, 4, 1, 8, "limit")).toBe(4);
    expect(() => boundedOption(1.5, 4, 1, 8, "limit")).toThrow("integer from 1 through 8");
    expect(() => boundedOption(Number.MAX_VALUE, 4, 1, 8, "limit")).toThrow(RangeError);
  });

  it("lets a domain preserve its public error type without copying validation", () => {
    class DomainError extends Error { readonly code = "INVALID_REQUEST"; }
    expect(() => boundedOption(0, 4, 1, 8, "limit", ({ message }) => new DomainError(message)))
      .toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("BoundedJsonStore", () => {
  it("enforces aggregate count and byte admission", () => {
    const root = temporaryRoot();
    const store = new BoundedJsonStore({
      root,
      maxRecordBytes: 128,
      maxRecords: 1,
      maxTotalBytes: 128,
      parse: parseRecord,
    });
    store.write(join(root, "one.json"), { generation: "g1", value: "one" });
    expect(() => store.write(join(root, "two.json"), { generation: "g2", value: "two" }))
      .toThrow(expect.objectContaining<Partial<JsonStoreError>>({ code: "CAPACITY_EXCEEDED" }));
    expect(store.usage()).toMatchObject({ records: 1, maxRecords: 1 });
  });
});

describe("JsonCasStore backends", () => {
  it("delegates helper-mediated CAS and corrupt archival without a Node fallback", async () => {
    const root = temporaryRoot();
    const calls: Array<Record<string, unknown>> = [];
    const backend = new HelperMediatedJsonCasBackend({
      compareAndSwap: async (request) => {
        calls.push({ operation: "replace", ...request });
        if (request.expectedGeneration === "g1") {
          return { kind: "conflict" as const, actualGeneration: null };
        }
        writeFileSync(request.path, request.nextJson);
      },
      archive: async (request) => {
        calls.push({ operation: "archive", ...request });
        renameSync(request.path, request.archivePath);
      },
    });
    expect(backend.atomicity).toBe("helper-mediated-cross-process");
    const store = cas(root, backend);
    await store.compareAndSwap(null, { generation: "g1", value: "helper" });
    expect(calls[0]).toMatchObject({ operation: "replace", expectedGeneration: null });
    expect(await store.compareAndSwap("g1", { generation: "g2", value: "conflict" }))
      .toEqual({ kind: "conflict", actualGeneration: null });

    writeFileSync(join(root, "state.json"), "{malformed");
    const corrupt = await store.inspect();
    expect(corrupt.kind).toBe("corrupt");
    if (corrupt.kind !== "corrupt") return;
    const archivePath = join(root, "archive.json");
    await store.archiveCorrupt(corrupt, archivePath);
    expect(calls[2]).toMatchObject({
      operation: "archive",
      expectedSha256: corrupt.rawSha256,
    });
    expect(readFileSync(archivePath, "utf8")).toBe("{malformed");
  });

  it("enforces aggregate admission before a helper-mediated publication", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "retained-corrupt.json"), "retained");
    let helperCalls = 0;
    const backend = new HelperMediatedJsonCasBackend({
      compareAndSwap: async (request) => {
        helperCalls += 1;
        writeFileSync(request.path, request.nextJson);
      },
      archive: async () => undefined,
    });
    const store = new JsonCasStore({
      root,
      path: join(root, "state.json"),
      maxRecordBytes: 1_024,
      maxRecords: 1,
      maxTotalBytes: 2_048,
      parse: parseRecord,
      generationOf: (record) => record.generation,
      backend,
    });

    await expect(store.compareAndSwap(null, { generation: "g1", value: "next" }))
      .rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" } satisfies Partial<JsonStoreError>);
    expect(helperCalls).toBe(0);
    expect(readFileSync(join(root, "retained-corrupt.json"), "utf8")).toBe("retained");
  });
});
