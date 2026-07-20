import { describe, expectTypeOf, it } from "vitest";
import type { ERROR_REGISTRY } from "../../observer/protocol/registry.js";
import type { CaptureErrorCode } from "../../src/observer/capture-contract.js";

describe("capture error-code type ownership", () => {
  it("is exactly the canonical protocol registry key set", () => {
    expectTypeOf<CaptureErrorCode>().toEqualTypeOf<keyof typeof ERROR_REGISTRY>();
  });
});
