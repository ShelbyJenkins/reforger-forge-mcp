import { describe, expect, it } from "vitest";
import {
  renderRedactedPublicJson,
  type PublicJsonRenderOptions,
} from "../../src/foundation/public-json.js";

const defaults: PublicJsonRenderOptions = {
  maximumDepth: 6,
  maximumBreadth: 24,
  maximumNodes: 128,
  maximumStringLength: 256,
  maximumCharacters: 512,
};

function render(value: unknown, options: Partial<PublicJsonRenderOptions> = {}) {
  return renderRedactedPublicJson(value, { ...defaults, ...options });
}

function parsed(result: ReturnType<typeof render>): unknown {
  expect(result.text).toBeDefined();
  return JSON.parse(result.text!);
}

describe("public diagnostic JSON rendering", () => {
  it("uses deterministic ordering and the configured circular marker", () => {
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    record.zebra = 3;
    record.alpha = 1;
    record.self = record;
    const array: unknown[] = [];
    array.push(array);

    const first = render({ record, array });
    const second = render({ record, array });
    expect(first).toEqual(second);
    expect(parsed(first)).toEqual({
      array: ["[public-json:circular]"],
      record: {
        alpha: 1,
        self: "[public-json:circular]",
        zebra: 3,
      },
    });
  });

  it("normalizes special primitives without relying on JSON.stringify", () => {
    const result = render({
      bigint: 42n,
      infinity: Infinity,
      nan: Number.NaN,
      negativeInfinity: -Infinity,
      text: "abcdefgh",
    }, { maximumStringLength: 3 });

    expect(parsed(result)).toEqual({
      bigint: "[public-json:bigint]",
      infinity: "[public-json:non-finite-number]",
      nan: "[public-json:non-finite-number]",
      negativeInfinity: "[public-json:non-finite-number]",
      text: "abc[public-json:string-limit]",
    });
  });

  it("uses complete markers for depth, breadth, and node limits", () => {
    const depth = render({ child: { leaf: true } }, { maximumDepth: 1 });
    expect(parsed(depth)).toEqual({ child: "[public-json:depth]" });

    const breadth = render({ zebra: 3, alpha: 1, middle: 2 }, { maximumBreadth: 2 });
    expect(parsed(breadth)).toEqual({
      "[public-json:breadth]": "[public-json:breadth]",
      alpha: 1,
    });

    const nodes = render({ first: {}, second: {} }, { maximumNodes: 2 });
    expect(parsed(nodes)).toEqual({
      first: {},
      second: "[public-json:node-limit]",
    });
  });

  it("returns a complete truncation value or omission for tiny character budgets", () => {
    const truncated = render({ detail: "x".repeat(256) }, { maximumCharacters: 40 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.fallback).toBe(false);
    expect(parsed(truncated)).toEqual({ details: "[public-json:truncated]" });

    const omitted = render({ detail: "x".repeat(256) }, { maximumCharacters: 2 });
    expect(omitted).toEqual({ text: undefined, truncated: false, fallback: false });
  });

  it("does not invoke accessors, toJSON methods, or unsupported values", () => {
    let accessorCalls = 0;
    let toJsonCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "danger", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must-not-read";
      },
      set() {
        accessorCalls += 1;
      },
    });
    const withToJson = {
      toJSON() {
        toJsonCalls += 1;
        return { leaked: true };
      },
    };

    const result = render({
      accessor,
      error: new Error("hidden"),
      functionValue: () => undefined,
      map: new Map([["key", "value"]]),
      set: new Set(["value"]),
      symbol: Symbol("hidden"),
      typed: new Uint8Array([1, 2]),
      undefinedValue: undefined,
      withToJson,
    });

    expect(accessorCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
    expect(parsed(result)).toEqual({
      accessor: { danger: "[public-json:accessor]" },
      error: "[public-json:unsupported]",
      functionValue: "[public-json:unsupported]",
      map: "[public-json:unsupported]",
      set: "[public-json:unsupported]",
      symbol: "[public-json:unsupported]",
      typed: "[public-json:unsupported]",
      undefinedValue: "[public-json:unsupported]",
      withToJson: { toJSON: "[public-json:unsupported]" },
    });
  });

  it("contains reflection failures locally and validates options", () => {
    const throwingProxy = new Proxy({}, {
      ownKeys() {
        throw new Error("must-not-surface");
      },
    });
    expect(parsed(render(throwingProxy))).toBe("[public-json:uninspectable]");

    const invalid = renderRedactedPublicJson("safe", {
      ...defaults,
      maximumDepth: 0,
    });
    expect(invalid.fallback).toBe(true);
    expect(parsed(invalid)).toEqual({ details: "[public-json:unavailable]" });
  });
});
