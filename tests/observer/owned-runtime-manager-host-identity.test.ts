import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupOwnedRuntimeManagerFixtures,
  makeHarness,
} from "./owned-runtime-manager-fixture.js";

const NON_NIL_UUID_PATTERN = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager host identity", () => {
  it("uses one validated injected host UUID without weakening standalone defaults", () => {
    const exactHost = "00112233-4455-4677-8899-aabbccddeeff";
    expect(makeHarness({ managerInstanceId: exactHost }).manager.managerInstanceId)
      .toBe(exactHost);

    const standalone = makeHarness().manager.managerInstanceId;
    expect(standalone).toMatch(NON_NIL_UUID_PATTERN);
    expect(standalone).not.toBe(exactHost);
  });

  it("rejects an invalid injected manager UUID", () => {
    expect(() => makeHarness({ managerInstanceId: "caller-controlled" }))
      .toThrow(/manager instance ID must be a non-nil UUID/i);
  });
});
