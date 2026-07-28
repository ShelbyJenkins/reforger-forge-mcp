import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workbenchCameraMatrix } from "../../src/workbench/observer-adapter.js";
import {
  LIVE_WORKBENCH_OBSERVER_ENVIRONMENT,
  assertCameraMatrixClose,
  assertLiveWorkbenchObserverAuthorized,
  quaternionFromWorkbenchMatrix,
  waitForCaptureCapability,
  workbenchCaptureCapabilityProbeWaitMs,
} from "../../scripts/run-workbench-observer-acceptance.js";
import type { ObserverApplication } from "../../src/observer/application.js";

function readWorkbenchAcceptanceSources(): string {
  return [
    "scripts/run-workbench-observer-acceptance.ts",
    "scripts/workbench-observer-acceptance-runtime.ts",
  ].map((path) => readFileSync(resolve(path), "utf8")).join("\n");
}

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

  it("gives a normal Workbench capability inventory enough time to answer", async () => {
    expect(workbenchCaptureCapabilityProbeWaitMs(60_000, 0)).toBe(15_000);
    expect(workbenchCaptureCapabilityProbeWaitMs(4_201, 0)).toBe(4_201);
    expect(workbenchCaptureCapabilityProbeWaitMs(999, 0)).toBeNull();

    const observedWaits: number[] = [];
    const application = {
      instances: async ({ waitMs }: { waitMs?: number }) => {
        observedWaits.push(waitMs ?? 0);
        return {
          instances: (waitMs ?? 0) >= 4_201
            ? [{ backend: "workbench", capabilities: ["render.capture"] }]
            : [],
          warnings: [],
          timedOut: false,
        };
      },
    } as unknown as ObserverApplication;

    await expect(waitForCaptureCapability(application, Date.now() + 60_000))
      .resolves.toMatchObject({ backend: "workbench" });
    expect(observedWaits).toEqual([15_000]);
  });

  it("uses adapter no-auto-launch calls and exact-owner cleanup without a global kill path", () => {
    const source = readWorkbenchAcceptanceSources();
    expect(source).toContain("skipAutoLaunch: true");
    expect(source).toContain("() => adapter.restoreAll()");
    expect(source).toContain("const result = await client.shutdownOwnedWorkbench()");
    expect(source).toContain("() => cleanupClient.shutdownOwnedWorkbench()");
    expect(source).toContain("same persisted exact-owner guard");
    expect(source).toContain("baselineCamera.position[0] + 75");
    expect(source).toContain("Explicit pose rendered position differs");
    expect(source).toContain("Explicit pose rendered FOV differs");
    expect(source).toContain("baselineCamera.position[0] - right[0] * 90");
    expect(source).toContain("Explicit look-at rendered FOV differs");
    expect(source).toContain("Post-look-at current capture");
    expect(source).toContain('const actualArguments = [...argumentsArray, "-forceUpdate"]');
    expect(source).toContain("operationalBaselineLaunchArgumentIdentity(actualArguments)");
    expect(source).toContain('procedureRevision: "workbench-observer-live-acceptance-v3"');
    expect(source).toContain("labels: [...WORKBENCH_CAPTURE_LABELS]");
    expect(source).toContain("worldResource: BASE_EVERON_WORLD");
    expect(source).toContain('"WorkbenchObserverAdapter.ping(EMCP_WB_Ping)"');
    expect(source).toContain('baseline.sampleProcessCounts("rest.beforeLaunch")');
    expect(source).toContain('baseline.sampleProcessCounts("rest.afterShutdown")');
    expect(source).toContain('"supervised_exit_settle"');
    expect(source).toContain('error.name = "SupervisedProcessVacancyTimeoutError"');
    const exitSettleIndex = source.indexOf('"supervised_exit_settle"');
    const restAfterShutdownIndex = source.indexOf(
      'baseline.sampleProcessCounts("rest.afterShutdown")'
    );
    expect(exitSettleIndex).toBeGreaterThan(-1);
    expect(restAfterShutdownIndex).toBeGreaterThan(exitSettleIndex);
    expect(source).toContain("writeOperationalBaselineArtifact(validationRoot, artifact)");
    expect(source).toContain('join(artifactRoot, "validation")');
    expect(source).not.toContain('join(REPOSITORY_ROOT, "docs", "validation")');
    expect(source).not.toMatch(/taskkill|Stop-Process|KillProcess|\.kill\s*\(/i);
  });

  it("routes live screenshots through managed runs and exports only a standardized unreviewed bundle", () => {
    const source = readWorkbenchAcceptanceSources();
    expect(source).toContain("createObserverApplication({");
    expect(source).toMatch(/"dist",\s*"observer",\s*"agent",\s*"private-child\.js"/);
    expect(source).toContain("await application.beginRun({");
    expect(source).toContain("await application.capture({");
    expect(source).toContain("await application.jobStatus(undefined, jobId)");
    expect(source).toContain("await application.readJob(undefined, jobId)");
    expect(source).toContain("await application.finalizeRun({");
    expect(source).toContain('"ObserverApplication.close"');
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
