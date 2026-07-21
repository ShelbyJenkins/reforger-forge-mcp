import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("live observer acceptance CI isolation", () => {
  it("does not enable graphical runtime or Workbench acceptance in CI", () => {
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toContain("RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE");
    expect(ci).not.toContain("RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE");
    expect(ci).not.toContain("dev:observer:acceptance:runtime");
    expect(ci).not.toContain("dev:observer:acceptance:workbench");
  });
});
