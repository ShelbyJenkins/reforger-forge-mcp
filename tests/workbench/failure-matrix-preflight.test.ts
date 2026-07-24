import { describe, expect, it } from "vitest";
import { runWorkbenchFailureMatrix } from "../../scripts/run-workbench-observer-acceptance.js";
import { SLICE_CASE } from "./failure-matrix-runner-fixture.js";

describe("runWorkbenchFailureMatrix preflight gates", () => {
  const configPath = "not-read-before-live-preflight.json";

  it("rejects unconfirmed full and partial runs before filesystem/process work", async () => {
    await expect(runWorkbenchFailureMatrix({ confirmed: false, configPath, environment: {} }))
      .rejects.toThrow(/--confirm-live-run/);
    await expect(runWorkbenchFailureMatrix({
      confirmed: false,
      configPath,
      environment: {},
      only: SLICE_CASE.id,
    })).rejects.toThrow(/--confirm-live-run/);
  });

  it("rejects a confirmed run missing the live environment gate", async () => {
    await expect(runWorkbenchFailureMatrix({ confirmed: true, configPath, environment: {} }))
      .rejects.toThrow(/RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE/);
  });

  it("rejects keep-profile without a selected partial case", async () => {
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      configPath,
      environment: { RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE: "1" },
      keepProfile: true,
    })).rejects.toThrow(/only with a single --only/);
  });

  it("rejects unknown and runtime IDs after authorization but before launch", async () => {
    const environment = { RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE: "1" };
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      configPath,
      environment,
      only: "workbench.unknown.before_lease.current",
    })).rejects.toThrow(/Unknown fault-matrix case/);
    await expect(runWorkbenchFailureMatrix({
      confirmed: true,
      configPath,
      environment,
      only: "runtime.cancel_capture.lease_acquired.pose",
    })).rejects.toThrow(/not a Workbench case/);
  });
});
