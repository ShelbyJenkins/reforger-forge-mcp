import { describe, expect } from "vitest";
import { WorkbenchObserverAdapter } from "../../src/workbench/observer-adapter.js";
import { WorkbenchObserverAcceptanceAdapter } from "../../scripts/workbench-observer-acceptance-adapter.js";
import {
  fakeClient,
  png,
  scopedIt,
} from "./observer-adapter-fixture.js";

describe("Workbench observer adapter", () => {
  scopedIt("recovers a lost submit acknowledgement by replaying the exact idempotent command once", async (root) => {
    const client = fakeClient(root, { loseFirstSubmitAcknowledgement: true });
    const adapter = new WorkbenchObserverAdapter(client, {
      createJobId: () => "ack-job",
      createLeaseId: () => "ack-lease",
    });

    await expect(adapter.submit({ view: { kind: "current" } })).resolves.toMatchObject({
      jobId: "ack-job",
      state: "settling",
    });
    const submits = client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverSubmit");
    expect(submits).toHaveLength(2);
    expect(submits[0].params).toEqual(submits[1].params);
    expect(submits[0].params).toMatchObject({ leaseId: "ack-lease" });
    expect(client.submitMutations).toBe(1);
  });

  scopedIt("recovers a retained handler transaction after an adapter restart with the durable lifecycle binding", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const original = new WorkbenchObserverAdapter(client, { createJobId: () => "restart-job" });
    const submitted = await original.submit({ view: { kind: "current" } });
    const submitCall = client.calls.find((call) => call.apiFunc === "EMCP_WB_ObserverSubmit");
    expect(submitCall?.params).toMatchObject({
      jobId: "restart-job",
      leaseId: "wb-observer-restart-job",
    });

    const restarted = new WorkbenchObserverAdapter(client);
    const recovered = await restarted.recover({
      jobId: "restart-job",
      expectedInstanceId: submitted.instanceId,
    });

    expect(recovered).toMatchObject({
      jobId: "restart-job",
      instanceId: submitted.instanceId,
      state: "completed",
      restorationConfirmed: true,
    });
    const statusCall = client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverStatus").at(-1);
    expect(statusCall?.params).toMatchObject({
      jobId: "restart-job",
      leaseId: "wb-observer-restart-job",
      lifecycleGeneration: "generation-a",
      canonicalTarget: client.project,
    });
    expect(restarted.readCompletedArtifact("restart-job").image).toEqual(png(2, 2));
    await expect(restarted.release("restart-job")).resolves.toMatchObject({
      jobId: "restart-job",
      restorationConfirmed: true,
    });
  });

  scopedIt("refuses restart recovery when the durable Workbench instance binding is stale", async (root) => {
    const client = fakeClient(root);
    const original = new WorkbenchObserverAdapter(client, { createJobId: () => "stale-restart-job" });
    await original.submit({ view: { kind: "current" } });

    const restarted = new WorkbenchObserverAdapter(client);
    await expect(restarted.recover({
      jobId: "stale-restart-job",
      expectedInstanceId: "workbench-old-generation-deadbeefdeadbeef",
    })).rejects.toMatchObject({ code: "STALE_LIFECYCLE" });
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverStatus")).toHaveLength(0);
  });

  scopedIt("refuses public release while camera state is held and replays a lost terminal release acknowledgement", async (root) => {
    const client = fakeClient(root, { loseFirstReleaseAcknowledgement: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "release-job" });
    await adapter.submit({ view: { kind: "current" } });

    await expect(adapter.release("release-job")).rejects.toMatchObject({ code: "CAMERA_BUSY" });
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease")).toHaveLength(0);
    await adapter.cancel("release-job");
    await expect(adapter.release("release-job")).rejects.toThrow("release response was lost after delivery");
    await expect(adapter.release("release-job")).resolves.toEqual({
      jobId: "release-job",
      restorationConfirmed: true,
      artifactRemoved: true,
    });
    expect(client.releaseMutations).toBe(1);
  });

  scopedIt("graceful restoreAll cancels active jobs and exactly releases restored handler transactions", async (root) => {
    const client = fakeClient(root);
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "shutdown-job" });
    await adapter.submit({ view: { kind: "current" } });

    await expect(adapter.restoreAll()).resolves.toBeUndefined();

    expect(client.calls.map((call) => call.apiFunc)).toEqual(expect.arrayContaining([
      "EMCP_WB_ObserverCancel",
      "EMCP_WB_ObserverRelease",
    ]));
    expect(client.releaseMutations).toBe(1);
  });

  scopedIt("retains acceptance facade state when restoreAll needs a retry", async (root) => {
    const client = fakeClient(root, { failFirstCancel: true });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "retry-shutdown-job",
    });
    await adapter.submit({ view: { kind: "current" } });

    await expect(adapter.restoreAll()).rejects.toThrow(
      "One or more Workbench observer camera leases could not be restored"
    );
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel"))
      .toHaveLength(1);
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease"))
      .toHaveLength(0);

    await expect(adapter.restoreAll()).resolves.toBeUndefined();
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel"))
      .toHaveLength(2);
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease"))
      .toHaveLength(1);
    expect(client.releaseCaptureActivity).toHaveBeenCalledOnce();
  });

  scopedIt("keeps terminal release replay disabled by default", async (root) => {
    const client = fakeClient(root);
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "ordinary-release" });
    await adapter.submit({ view: { kind: "current" } });
    await adapter.cancel("ordinary-release");

    await expect(adapter.release("ordinary-release")).resolves.toEqual({
      jobId: "ordinary-release",
      restorationConfirmed: true,
      artifactRemoved: true,
    });
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease"))
      .toHaveLength(1);
    expect(client.releaseMutations).toBe(1);
  });

  scopedIt("replays the identical real Release request once and reports equivalent acknowledgement evidence", async (root) => {
    const client = fakeClient(root, {
      releaseReplayOverrides: { message: "already released" },
    });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "duplicate-release",
      createLeaseId: () => "duplicate-release-lease",
      verifyIdempotentReleaseReplay: true,
    });
    await adapter.submit({ view: { kind: "current" } });
    await adapter.cancel("duplicate-release");

    await expect(adapter.release("duplicate-release")).resolves.toEqual({
      jobId: "duplicate-release",
      restorationConfirmed: true,
      artifactRemoved: true,
      idempotentReplay: {
        attempted: true,
        identicalRequest: true,
        equivalentAcknowledgement: true,
      },
    });
    const releases = client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease");
    expect(releases).toHaveLength(2);
    expect(releases[0]?.params).toBe(releases[1]?.params);
    expect(Object.isFrozen(releases[0]?.params)).toBe(true);
    expect(releases[0]?.params).toEqual({
      jobId: "duplicate-release",
      leaseId: "duplicate-release-lease",
      lifecycleGeneration: "generation-a",
      canonicalTarget: client.project,
    });
    expect(client.releaseMutations).toBe(1);
  });

  scopedIt("fails replay evidence on a non-equivalent acknowledgement but still retires the proven released job", async (root) => {
    const client = fakeClient(root, {
      completeOnStatus: true,
      releaseReplayOverrides: { artifactRemoved: false },
    });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "mismatched-release",
      verifyIdempotentReleaseReplay: true,
    });
    await adapter.submit({ view: { kind: "current" } });
    await adapter.status("mismatched-release");

    await expect(adapter.release("mismatched-release")).rejects.toMatchObject({
      code: "HANDLER_REJECTED",
      message: expect.stringMatching(/equivalent acknowledgement/),
    });
    const releases = client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease");
    expect(releases).toHaveLength(2);
    expect(releases[0]?.params).toBe(releases[1]?.params);
    expect(client.releaseMutations).toBe(1);
    await expect(adapter.release("mismatched-release")).rejects.toMatchObject({
      code: "JOB_NOT_FOUND",
    });
    expect(() => adapter.readCompletedArtifact("mismatched-release")).toThrowError(
      expect.objectContaining({ code: "JOB_NOT_FOUND" })
    );
  });

  scopedIt("does not synthesize a replay acknowledgement when the second real call fails", async (root) => {
    const client = fakeClient(root, {
      releaseReplayError: new Error("real replay transport failed"),
    });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "failed-release-replay",
      verifyIdempotentReleaseReplay: true,
    });
    await adapter.submit({ view: { kind: "current" } });
    await adapter.cancel("failed-release-replay");

    await expect(adapter.release("failed-release-replay")).rejects.toMatchObject({
      code: "HANDLER_UNAVAILABLE",
      message: "real replay transport failed",
    });
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease"))
      .toHaveLength(2);
    expect(client.releaseMutations).toBe(1);
    await expect(adapter.release("failed-release-replay")).rejects.toMatchObject({
      code: "JOB_NOT_FOUND",
    });
  });
});

