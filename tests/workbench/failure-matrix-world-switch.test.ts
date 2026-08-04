import { describe, expect, it } from "vitest";
import {
  caseForId,
  OBSERVER_FAULT_MATRIX,
  type WorkbenchFaultMatrixCase,
} from "../../observer/protocol/fault-matrix.js";
import { waitForWorkbenchReplacementWorld } from "../../scripts/workbench-observer-live-matrix-case.js";
import { runWorkbenchMatrixCase } from "../../scripts/workbench-observer-matrix-case.js";
import { fakeHarness } from "./failure-matrix-runner-fixture.js";

describe("Workbench failure-matrix world replacement", () => {
  it("waits for raw Ping to publish a changed world identity without capture eligibility", async () => {
    let now = 1_000;
    let probes = 0;
    const worldId = await waitForWorkbenchReplacementWorld(
      async () => ({
        instanceId: "instance-1",
        worldIdentity: ++probes === 1 ? "world-1" : "world-2",
        capabilities: [],
      }),
      "world-1",
      "instance-1",
      2_000,
      {
        clock: { now: () => now },
        sleeper: { sleep: async (durationMs) => { now += durationMs; } },
        intervalMs: 25,
      }
    );

    expect(worldId).toBe("world-2");
    expect(probes).toBe(2);
  });

  it("confirms replacement after releasing the barrier and before a before-lease capture", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.replace_fixture_world.before_lease.current"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);

    await runWorkbenchMatrixCase(harness.input);

    const index = (call: string) => harness.calls.indexOf(call);
    expect(index("replaceWorld")).toBeLessThan(index("releaseBarrier:published:release"));
    expect(index("releaseBarrier:published:release")).toBeLessThan(
      index("releaseBarrier:callback-returned")
    );
    expect(index("releaseBarrier:callback-returned")).toBeLessThan(
      index("confirmReplacementWorld")
    );
    expect(index("confirmReplacementWorld")).toBeLessThan(index("capture:matrix-primary"));
  });

  it("accepts the replacement world's distinct, independently observable camera", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.replace_fixture_world.terminal_release.pose"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const jobStatus = harness.input.application.jobStatus;

    const entry = await runWorkbenchMatrixCase({
      ...harness.input,
      application: {
        ...harness.input.application,
        jobStatus: async (jobId) => {
          const status = await jobStatus(jobId);
          if (jobId !== "job-followup") return status;
          return {
            ...status,
            worldIdentity: "world-2",
            ownerCameraId: 19,
            actualCamera: {
              matrix: [
                [0, 1, 0],
                [-1, 0, 0],
                [0, 0, 1],
                [10, 20, 30],
              ],
              position: [10, 20, 30],
              verticalFov: 75,
              nearPlane: 0.2,
              farPlane: 3_000,
            },
          };
        },
      },
    });

    expect(entry).toMatchObject({
      result: "passed",
      worldRevision: "changed",
      camera: "restored",
    });
  });

  it("rejects a replacement follow-up that still reports the original world", async () => {
    const matrixCase = caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.replace_fixture_world.terminal_release.current"
    ) as WorkbenchFaultMatrixCase;
    const harness = fakeHarness(matrixCase);
    const jobStatus = harness.input.application.jobStatus;

    await expect(runWorkbenchMatrixCase({
      ...harness.input,
      application: {
        ...harness.input.application,
        jobStatus: async (jobId) => {
          const status = await jobStatus(jobId);
          return jobId === "job-followup"
            ? { ...status, worldIdentity: "world-1" }
            : status;
        },
      },
    })).rejects.toThrow(/replacement editor world identity/);
  });
});
