import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundedOption } from "../../src/foundation/bounded-option.js";
import {
  BoundedJsonStore,
  JsonStoreError,
} from "../../src/foundation/json-store.js";
import {
  boundedJsonMapContract,
  boundedJsonStoreContract,
  parseJsonStoreContractRecord,
} from "./json-store-contract.js";

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

boundedJsonMapContract("BoundedJsonMap");
boundedJsonStoreContract("BoundedJsonStore");

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
