import { describe, expect, it } from "vitest";
import { CaptureError } from "../../src/observer/capture-contract.js";
import { normalizeCaptureRequest } from "../../src/observer/capture-request.js";
import { runtimeWorldRevision } from "../../src/observer/world-revision.js";

const base = {
  idempotencyKey: "request-key",
  view: { kind: "pose" as const, position: [-0, 1, 2] as [number, number, number], orientation: [0, 0, 0, 1] as [number, number, number, number], fov: 60 },
  timeoutMs: 1_000,
};

describe("capture request normalization", () => {
  it("canonicalizes negative zero and omitted policy defaults", () => {
    const normalized = normalizeCaptureRequest(base);
    expect(normalized.view).toMatchObject({ position: [0, 1, 2] });
    expect(normalized.performancePolicy).toBe("evidence");
    expect(normalized.fingerprint).toHaveLength(64);
    expect(normalizeCaptureRequest({ ...base, view: { ...base.view, position: [0, 1, 2] } }).fingerprint).toBe(normalized.fingerprint);
  });

  it("requires legacy world identity to include its epoch", () => {
    expect(() => normalizeCaptureRequest({ ...base, expectedWorldId: "world" })).not.toThrow();
    expect(normalizeCaptureRequest({ ...base, expectedWorldId: "world", expectedWorldEpoch: 3 }).expectedWorldRevision)
      .toBe(runtimeWorldRevision("world", 3));
  });

  it("rejects opaque/legacy world conflicts and blocked performance policy", () => {
    const opaque = runtimeWorldRevision("world", 4);
    expect(() => normalizeCaptureRequest({ ...base, expectedWorldRevision: opaque, expectedWorldId: "world", expectedWorldEpoch: 3 }))
      .toThrowError(CaptureError);
    expect(() => normalizeCaptureRequest({ ...base, performancePolicy: "performance" })).toThrowError(CaptureError);
  });
});

