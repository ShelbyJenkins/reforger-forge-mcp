import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workbenchCameraMatrix } from "../../src/workbench/observer-adapter.js";
import {
  LIVE_WORKBENCH_OBSERVER_ENVIRONMENT,
  assertCameraMatrixClose,
  assertLiveWorkbenchObserverAuthorized,
  quaternionFromWorkbenchMatrix,
} from "../../scripts/run-workbench-observer-acceptance.js";

describe("live Workbench observer acceptance contract", () => {
  it("requires independent environment and explicit-run confirmations", () => {
    expect(() => assertLiveWorkbenchObserverAuthorized(false, {
      [LIVE_WORKBENCH_OBSERVER_ENVIRONMENT]: "1",
    })).toThrow(/--confirm-live-run/);
    expect(() => assertLiveWorkbenchObserverAuthorized(true, {})).toThrow(
      new RegExp(LIVE_WORKBENCH_OBSERVER_ENVIRONMENT)
    );
    expect(() => assertLiveWorkbenchObserverAuthorized(true, {
      [LIVE_WORKBENCH_OBSERVER_ENVIRONMENT]: "1",
    })).not.toThrow();
  });

  it("derives a normalized pose quaternion from the captured Workbench matrix", () => {
    const baseline = workbenchCameraMatrix({
      kind: "pose",
      position: [123.5, 42, -9.25],
      orientation: [0.1825741858, -0.3651483717, 0.5477225575, 0.7302967433],
      fov: 63,
    });
    const orientation = quaternionFromWorkbenchMatrix(baseline);
    expect(Math.hypot(...orientation)).toBeCloseTo(1, 10);
    const roundTrip = workbenchCameraMatrix({
      kind: "pose",
      position: baseline[3],
      orientation,
      fov: 63,
    });
    expect(() => assertCameraMatrixClose(baseline, roundTrip, 1e-8)).not.toThrow();
  });

  it("rejects post-restoration camera drift", () => {
    const baseline = workbenchCameraMatrix({
      kind: "pose",
      position: [1, 2, 3],
      orientation: [0, 0, 0, 1],
      fov: 60,
    });
    const drifted = baseline.map((axis) => [...axis]) as typeof baseline;
    drifted[3][0] += 0.01;
    expect(() => assertCameraMatrixClose(baseline, drifted, 0.002)).toThrow(
      /Camera restoration mismatch/
    );
  });

  it("uses adapter no-auto-launch calls and exact-owner cleanup without a global kill path", () => {
    const source = readFileSync(
      resolve("scripts/run-workbench-observer-acceptance.ts"),
      "utf8"
    );
    expect(source).toContain("skipAutoLaunch: true");
    expect(source).toContain("await adapter.restoreAll()");
    expect(source).toContain("await client.shutdownOwnedWorkbench()");
    expect(source).toContain("summary.shutdownRecovery = await cleanupClient.shutdownOwnedWorkbench()");
    expect(source).toContain("same persisted exact-owner guard");
    expect(source).toContain("baseline.position[0] + 75");
    expect(source).toContain("Explicit pose rendered position differs");
    expect(source).toContain("Explicit pose rendered FOV differs");
    expect(source).toContain("baseline.position[0] - right[0] * 90");
    expect(source).toContain("Explicit look-at rendered FOV differs");
    expect(source).toContain("Post-look-at current capture");
    expect(source).toContain('spawn(command, [...argumentsArray, "-forceUpdate"], spawnOptions)');
    expect(source).not.toMatch(/taskkill|Stop-Process|KillProcess|\.kill\s*\(/i);
  });

  it("routes live screenshots through managed runs and exports only a standardized unreviewed bundle", () => {
    const source = readFileSync(
      resolve("scripts/run-workbench-observer-acceptance.ts"),
      "utf8"
    );
    expect(source).toContain("new ObserverCoordinator({");
    expect(source).toContain('"dist", "observer", "agent", "private-child.js"');
    expect(source).toContain("await coordinator.beginRun({");
    expect(source).toContain("await coordinator.capture({");
    expect(source).toContain("await coordinator.jobStatus(undefined, jobId)");
    expect(source).toContain("await coordinator.readJob(undefined, jobId)");
    expect(source).toContain("await coordinator.finalizeRun({");
    expect(source).toContain("bundle = validateFinalizedBundle(");
    expect(source).toContain("comparePngImages(initial.image, pose.image)");
    expect(source).toContain("if (!poseDifference.materiallyDifferent)");
    expect(source).toContain("comparePngImages(initial.image, lookAt.image)");
    expect(source).toContain("if (!lookAtDifference.materiallyDifferent)");
    expect(source).toContain('configurationId: "workbench-observer-live-acceptance-v3"');
    expect(source).toContain('imagesReviewed: false');
    expect(source).toContain('outcome: "Unreviewed"');
    expect(source).toContain('releaseManagedArtifacts: true');
    expect(source).not.toContain("await adapter.submit(");
    expect(source).not.toContain("adapter.readCompletedArtifact(");
    expect(source).not.toContain("writeFileSync(imagePath");
  });
});
