import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupOwnedRuntimeManagerFixtures,
  makeHarness,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager host identity", () => {
  it("uses one validated injected host UUID without weakening standalone defaults", () => {
    const exactHost = "00112233-4455-4677-8899-aabbccddeeff";
    expect(makeHarness({ managerInstanceId: exactHost }).manager.managerInstanceId)
      .toBe(exactHost);

    const standalone = makeHarness().manager.managerInstanceId;
    expect(standalone).toMatch(/^[0-9a-f-]{36}$/i);
    expect(standalone).not.toBe(exactHost);
  });

  it("rejects an invalid injected manager UUID", () => {
    expect(() => makeHarness({ managerInstanceId: "caller-controlled" }))
      .toThrow(/manager instance ID must be a UUID/i);
  });
});
