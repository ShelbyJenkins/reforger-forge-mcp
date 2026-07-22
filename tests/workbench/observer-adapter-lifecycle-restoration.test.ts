import { describe, expect, vi } from "vitest";
import { WorkbenchObserverAdapter } from "../../src/workbench/observer-adapter.js";
import { WorkbenchObserverAcceptanceAdapter } from "../../scripts/workbench-observer-acceptance-adapter.js";
import {
  fakeClient,
  scopedIt,
} from "./observer-adapter-fixture.js";

describe("Workbench observer adapter", () => {
  scopedIt("marks one retained job for exact owner exit without claiming ordinary gate release", async (root) => {
    const client = fakeClient(root);
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, { createJobId: () => "exit-required-job" });
    await adapter.submit({ view: { kind: "current" } });
    const activityLease = client.acquireCaptureActivity.mock.results[0]!.value;

    adapter.requireExactOwnerExit("exit-required-job");
    adapter.requireExactOwnerExit("exit-required-job");

    expect(client.requireExactOwnerExit).toHaveBeenCalledOnce();
    expect(client.requireExactOwnerExit).toHaveBeenCalledWith(activityLease);
    expect(client.releaseCaptureActivity).not.toHaveBeenCalled();
    expect(() => adapter.requireExactOwnerExit("unknown-job")).toThrow(
      expect.objectContaining({ code: "JOB_NOT_FOUND" })
    );
  });

  scopedIt("runs exact owner shutdown after lease creation but before Submit delivery", async (root) => {
    const client = fakeClient(root);
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "before-submit-exit",
    });
    const beforeSubmit = vi.fn(async (context: { readonly jobId: string }) => {
      adapter.requireExactOwnerExit(context.jobId);
      return { exactOwnerVacant: true } as const;
    });
    adapter.armOneShotBeforeSubmitDelivery(beforeSubmit);

    await expect(adapter.submit({ view: { kind: "current" } })).rejects.toMatchObject({
      code: "WORKBENCH_EXITED",
    });
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(client.requireExactOwnerExit).toHaveBeenCalledOnce();
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverSubmit")).toHaveLength(0);
    expect(client.releaseCaptureActivity).toHaveBeenCalledOnce();
  });

  scopedIt("does not bypass a failed before-submit hook on the bounded Submit retry", async (root) => {
    const client = fakeClient(root);
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "failed-before-submit",
    });
    const beforeSubmit = vi.fn(async () => {
      throw new Error("injected before-submit failure");
    });
    adapter.armOneShotBeforeSubmitDelivery(beforeSubmit);

    await expect(adapter.submit({ view: { kind: "current" } })).rejects.toThrow(
      "injected before-submit failure"
    );
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverSubmit"))
      .toHaveLength(0);
    expect(client.releaseCaptureActivity).toHaveBeenCalledOnce();
  });

  scopedIt("converges retained adapter state only after affirmative exact owner vacancy", async (root) => {
    const client = fakeClient(root);
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, { createJobId: () => "confirmed-exit-job" });
    await adapter.submit({ view: { kind: "current" } });

    expect(() => adapter.confirmExactOwnerExit("confirmed-exit-job", true)).toThrow(
      expect.objectContaining({ code: "INVALID_REQUEST" })
    );

    adapter.requireExactOwnerExit("confirmed-exit-job");
    expect(() => adapter.confirmExactOwnerExit("confirmed-exit-job", false)).toThrow(
      expect.objectContaining({ code: "RESTORATION_UNCONFIRMED" })
    );

    const terminal = adapter.confirmExactOwnerExit("confirmed-exit-job", true);
    expect(terminal).toMatchObject({
      state: "failed",
      terminalErrorCode: "WORKBENCH_EXITED",
      cameraLeaseHeld: false,
      restorationConfirmed: false,
    });
    expect(adapter.confirmExactOwnerExit("confirmed-exit-job", true)).toEqual(terminal);
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toHaveLength(0);
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease")).toHaveLength(0);
    await expect(adapter.release("confirmed-exit-job")).resolves.toEqual({
      jobId: "confirmed-exit-job",
      restorationConfirmed: false,
      artifactRemoved: false,
    });
    expect(client.releaseCaptureActivity).toHaveBeenCalledOnce();
    expect(() => adapter.readCompletedArtifact("confirmed-exit-job")).toThrow(
      expect.objectContaining({ code: "JOB_NOT_FOUND" })
    );
    await expect(adapter.restoreAll()).resolves.toBeUndefined();
  });

  scopedIt("graceful restoreAll releases a completed gate-released handler job", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "completed-shutdown-job" });
    await adapter.submit({ view: { kind: "current" } });
    await adapter.status("completed-shutdown-job");

    await expect(adapter.restoreAll()).resolves.toBeUndefined();

    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toHaveLength(0);
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease")).toHaveLength(1);
    expect(client.releaseMutations).toBe(1);
  });

  scopedIt("refuses camera.editor views until exact restoration was proven in that Workbench process", async (root) => {
    const client = fakeClient(root, { cameraEditor: false });
    const adapter = new WorkbenchObserverAdapter(client);

    await expect(adapter.submit({
      view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
    })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(client.acquireCaptureActivity).not.toHaveBeenCalled();
  });

  scopedIt("binds explicit camera jobs to generation and target and restores on lifecycle cancellation", async (root) => {
    const client = fakeClient(root, { cameraEditor: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "pose-job" });
    await adapter.submit({
      view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 55 },
    });

    const submitCall = client.calls.find((call) => call.apiFunc === "EMCP_WB_ObserverSubmit");
    expect(submitCall?.params).toMatchObject({
      lifecycleGeneration: "generation-a",
      canonicalTarget: client.project,
      matrix0: "1 0 0",
      matrix1: "0 1 0",
      matrix2: "0 0 1",
      matrix3: "1 2 3",
      fovText: "55",
    });

    client.controller?.abort({ code: "LIFECYCLE_REQUESTED" });
    await vi.waitFor(() => {
      expect(client.calls.some((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toBe(true);
      expect(client.releaseCaptureActivity).toHaveBeenCalledTimes(1);
    });
  });

  scopedIt("rejects an old lifecycle generation and requests handler restoration", async (root) => {
    const client = fakeClient(root, { cameraEditor: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "stale-job" });
    await adapter.submit({ view: { kind: "current" } });
    client.failRevalidation = true;

    await expect(adapter.status("stale-job")).rejects.toMatchObject({ code: "STALE_LIFECYCLE" });
    expect(client.calls.some((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toBe(true);
  });

  scopedIt("records exact process exit as terminal invalidation without claiming restoration", async (root) => {
    const client = fakeClient(root, { cameraEditor: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "exit-job" });
    await adapter.submit({ view: { kind: "current" } });

    client.controller?.abort({
      code: "WORKBENCH_EXITED",
      message: "Exact owned Workbench PID 4040 exited",
    });
    await vi.waitFor(async () => {
      await expect(adapter.status("exit-job")).resolves.toMatchObject({
        state: "failed",
        terminalErrorCode: "WORKBENCH_EXITED",
        cameraLeaseHeld: false,
        restorationConfirmed: false,
      });
    });
    await expect(adapter.cancel("exit-job")).resolves.toMatchObject({
      terminalErrorCode: "WORKBENCH_EXITED",
    });
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toHaveLength(0);
  });

  scopedIt("reports only capabilities returned by the dedicated ping handler", async (root) => {
    const adapter = new WorkbenchObserverAdapter(fakeClient(root, { cameraEditor: false }));
    await expect(adapter.instances()).resolves.toEqual([
      expect.objectContaining({
        lifecycleGeneration: "generation-a",
        capabilities: ["render.capture"],
        restorationApiAvailable: true,
      }),
    ]);
  });

  scopedIt("fails closed before acquiring a lifecycle lease when projection capture is unavailable", async (root) => {
    const diagnostic = "The active editor projection is asymmetric or unsupported";
    const client = fakeClient(root, {
      captureCurrent: false,
      restorationApiAvailable: false,
      readinessMessage: diagnostic,
    });
    const adapter = new WorkbenchObserverAdapter(client);

    await expect(adapter.instances()).resolves.toEqual([
      expect.objectContaining({
        capabilities: [],
        restorationApiAvailable: false,
        readinessMessage: diagnostic,
      }),
    ]);
    await expect(adapter.submit({ view: { kind: "current" } })).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(client.acquireCaptureActivity).not.toHaveBeenCalled();
    expect(client.calls.some((call) => call.apiFunc === "EMCP_WB_ObserverSubmit")).toBe(false);
  });
});

