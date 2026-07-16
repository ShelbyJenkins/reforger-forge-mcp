import { describe, it } from "vitest";
import {
  LIVE_WORKBENCH_OBSERVER_ENVIRONMENT,
  LIVE_WORKBENCH_OBSERVER_TEST_CONFIRMATION,
  runWorkbenchObserverAcceptance,
} from "../../../scripts/run-workbench-observer-acceptance.js";

const liveAuthorized =
  process.env[LIVE_WORKBENCH_OBSERVER_ENVIRONMENT] === "1" &&
  process.env[LIVE_WORKBENCH_OBSERVER_TEST_CONFIRMATION] === "1";

describe.runIf(liveAuthorized)("live Workbench observer capture and restoration", () => {
  it("retains current, displaced explicit-pose, and post-restoration screenshots", async () => {
    await runWorkbenchObserverAcceptance({
      confirmed: true,
      environment: process.env,
      artifactRoot: process.env.RFO_WORKBENCH_OBSERVER_ARTIFACT_ROOT,
      timeoutMs: process.env.RFO_WORKBENCH_OBSERVER_TIMEOUT_MS
        ? Number(process.env.RFO_WORKBENCH_OBSERVER_TIMEOUT_MS)
        : undefined,
    });
  }, 660_000);
});
