import { describe, expect, it } from "vitest";
import {
  assertWorldRevision,
  legacyWorldFields,
  runtimeWorldRevision,
  sameWorldRevision,
  workbenchWorldIdentity,
  workbenchWorldRevision,
} from "../../src/observer/world-revision.js";

describe("opaque world revisions", () => {
  it("round-trips nullable runtime worlds exactly", () => {
    const revision = runtimeWorldRevision(null, 7);
    expect(legacyWorldFields(revision)).toEqual({ worldId: null, worldEpoch: 7 });
    expect(assertWorldRevision(revision)).toBe(revision);
  });

  it("uses composite Workbench identity and confines epoch-zero compatibility", () => {
    const revision = workbenchWorldRevision("project/subscene#4");
    expect(workbenchWorldIdentity(revision)).toBe("project/subscene#4");
    expect(legacyWorldFields(revision)).toEqual({ worldId: "project/subscene#4", worldEpoch: 0 });
    expect(sameWorldRevision(revision, workbenchWorldRevision("project/subscene#4"))).toBe(true);
    expect(sameWorldRevision(revision, workbenchWorldRevision("project/subscene#5"))).toBe(false);
  });

  it("rejects malformed or unsupported tokens", () => {
    expect(() => assertWorldRevision("wr0.runtime.bad")).toThrow();
    expect(() => assertWorldRevision("wr1.runtime.not-json")).toThrow();
  });
});

