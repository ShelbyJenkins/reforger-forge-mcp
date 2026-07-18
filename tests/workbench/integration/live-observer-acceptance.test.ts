import { existsSync, readFileSync } from "node:fs";
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
  it("retains current, explicit-pose, explicit-look-at, and post-restoration screenshots", async () => {
    const result = await runWorkbenchObserverAcceptance({
      confirmed: true,
      environment: process.env,
      artifactRoot: process.env.RFO_WORKBENCH_OBSERVER_ARTIFACT_ROOT,
      timeoutMs: process.env.RFO_WORKBENCH_OBSERVER_TIMEOUT_MS
        ? Number(process.env.RFO_WORKBENCH_OBSERVER_TIMEOUT_MS)
        : undefined,
    });
    if (!existsSync(result.manifestPath) || !existsSync(result.evidenceDirectory)) {
      throw new Error("Live Workbench acceptance returned no finalized evidence bundle");
    }
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Record<string, unknown>;
    const review = manifest.review as Record<string, unknown>;
    if (manifest.manifestVersion !== 1 || review.imagesReviewed !== false || review.outcome !== "Unreviewed") {
      throw new Error("Live Workbench acceptance bundle has the wrong automated-review contract");
    }
  }, 660_000);
});
