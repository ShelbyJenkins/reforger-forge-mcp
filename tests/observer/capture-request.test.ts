import { describe, expect, it } from "vitest";
import { CaptureError } from "../../src/observer/capture-contract.js";
import { normalizeCaptureRequest, resolveExpectedWorldRevision } from "../../src/observer/capture-request.js";
import { runtimeWorldRevision } from "../../src/observer/world-revision.js";

const base = {
  idempotencyKey: "request-key",
  view: { kind: "pose" as const, position: [-0, 1, 2] as [number, number, number], orientation: [0, 0, 0, 1] as [number, number, number, number], fov: 60 },
  timeoutMs: 1_000,
  expectedWorldRevision: runtimeWorldRevision("world", 3),
};

describe("capture request normalization", () => {
  it("canonicalizes negative zero and omitted policy defaults", () => {
    const normalized = normalizeCaptureRequest(base);
    expect(normalized.view).toMatchObject({ position: [0, 1, 2] });
    expect(normalized.performancePolicy).toBe("evidence");
    expect(normalized.fingerprint).toHaveLength(64);
    expect(normalizeCaptureRequest({ ...base, view: { ...base.view, position: [0, 1, 2] } }).fingerprint).toBe(normalized.fingerprint);
  });

  it("requires and preserves the canonical world revision", () => {
    const revision = runtimeWorldRevision("world", 3);
    expect(normalizeCaptureRequest({ ...base, expectedWorldRevision: revision }).expectedWorldRevision)
      .toBe(revision);
    const noWorldRevision = runtimeWorldRevision(null, 0);
    expect(normalizeCaptureRequest({ ...base, expectedWorldRevision: noWorldRevision }).expectedWorldRevision)
      .toBe(noWorldRevision);
  });

  it("rejects absent and malformed canonical bindings", () => {
    expect(() => resolveExpectedWorldRevision({})).toThrowError(CaptureError);
    expect(() => resolveExpectedWorldRevision({ expectedWorldRevision: "wr1.runtime.invalid" }))
      .toThrowError(CaptureError);
  });

  it("rejects blocked performance policy", () => {
    expect(() => normalizeCaptureRequest({ ...base, performancePolicy: "performance" })).toThrowError(CaptureError);
  });
});
