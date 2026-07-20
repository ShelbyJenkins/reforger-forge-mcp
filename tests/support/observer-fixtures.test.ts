import { describe, expect, it } from "vitest";
import { instanceRegistrationSchema } from "../../observer/protocol/index.js";
import { ManualTime } from "./manual-time.js";
import { createObserverSessionFixture, graphicalRegistration, testBundleDigest } from "./observer-fixtures.js";
import { withTemporaryDirectory } from "./temporary-directory.js";

describe("observer fixtures", () => {
  it("creates a schema-valid registration from session defaults", async () => {
    await withTemporaryDirectory((root) => {
      const clock = new ManualTime({ nowMs: 1_700_000_000_000 });
      const fixture = createObserverSessionFixture({ root, clock });
      const registration = graphicalRegistration(fixture.created);
      expect(instanceRegistrationSchema.parse(registration)).toEqual(registration);
      expect(registration.bundleDigest).toBe(testBundleDigest);
      expect(registration.sessionId).toBe(fixture.created.contract.sessionId);
      expect(registration.launchNonce).toBe(fixture.created.contract.launchNonce);
      expect(registration.registeredAt).toBe(fixture.created.contract.createdAt);
    });
  });

  it("preserves representative registration overrides exactly", async () => {
    await withTemporaryDirectory((root) => {
      const fixture = createObserverSessionFixture({ root, clock: new ManualTime() });
      const registration = graphicalRegistration(fixture.created, {
        capabilities: ["world.query"],
        runtimeKind: "testRunner",
        registeredAt: "2026-07-20T00:00:00.000Z",
      });
      expect(registration.capabilities).toEqual(["world.query"]);
      expect(registration.runtimeKind).toBe("testRunner");
      expect(registration.registeredAt).toBe("2026-07-20T00:00:00.000Z");
      expect(instanceRegistrationSchema.parse(registration)).toEqual(registration);
    });
  });
});
