import { describe, expect, it } from "vitest";
import type { WorkbenchObserverRecoverInput, WorkbenchObserverSubmitInput } from "../../src/workbench/observer-adapter.js";
import { workbenchWorldRevision } from "../../src/observer/world-revision.js";
import {
  codedError,
  createWorkbenchHarness,
  managedWorkbenchArtifactMetadata,
  managedWorkbenchCaptureInput,
  managedWorkbenchCaptureRecord,
  png,
  respondWithRun,
  workbenchCaptureInput,
  workbenchInstance,
  workbenchJob,
} from "./application-diagnostics-fixture.js";

describe("observer MCP tools", () => {
  it("rejects stale Workbench expected-world binding before adapter submission", async () => {
    const { adapter, coordinator } = createWorkbenchHarness();
    await expect(coordinator.capture(workbenchCaptureInput("stale-workbench-world", {
      instanceId: "workbench-generation-1",
      expectedWorldRevision: workbenchWorldRevision("world-editor-previous"),
      asynchronous: true,
    }))).rejects.toMatchObject({ code: "WORLD_CHANGED" });
    expect(adapter.submit).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it("durably binds a managed run job before Workbench can retain camera state", async () => {
    const runId = "20260717T195900Z-a0b1c2d3";
    const { child, adapter, coordinator } = createWorkbenchHarness();
    const events: string[] = [];
    const bindings: Array<Record<string, unknown>> = [];
    child.responders.set("runReserveCapture", () => ({ runId, capture: {
      captureLabel: "prebound", state: "reserved", backend: null,
      jobId: null, artifactAvailable: false,
    } }));
    child.responders.set("runBindCapture", (payload) => {
      events.push("run-bind");
      bindings.push(payload);
      return { runId, capture: { state: "submitted", ...payload } };
    });
    adapter.submit.mockImplementation(async (input: WorkbenchObserverSubmitInput) => {
      events.push("adapter-submit");
      return workbenchJob("queued", 1, input.jobId!);
    });
    const result = await coordinator.capture(managedWorkbenchCaptureInput(runId, "prebound", {
      idempotencyKey: "prebound-key",
    }));

    expect(result).toMatchObject({ asynchronous: true, job: { backend: "workbench" } });
    const submittedJobId = (adapter.submit.mock.calls[0][0] as { jobId: string }).jobId;
    expect(submittedJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bindings[0]).toMatchObject({
      runId, captureLabel: "prebound", backend: "workbench", jobId: submittedJobId,
      instanceId: "workbench-generation-1", worldId: "world-editor-1", worldEpoch: 0,
    });
    expect(events.slice(0, 2)).toEqual(["run-bind", "adapter-submit"]);
    await coordinator.close();
  });

  it("submits an already-bound durable job when restart recovery proves it never reached Workbench", async () => {
    const runId = "20260717T195930Z-d0c1b2a3";
    const { child, adapter, coordinator } = createWorkbenchHarness();
    child.responders.set("runReserveCapture", () => ({
      runId,
      capture: managedWorkbenchCaptureRecord("restart-before-submit", {
        state: "submitted", jobId: "durable-job",
        expectedWorldId: "world-editor-1", expectedWorldEpoch: 0,
        artifactAvailable: false,
      }),
    }));
    adapter.recover.mockRejectedValue(codedError("JOB_NOT_FOUND", "no retained handler job"));
    const durableStatus = workbenchJob("queued", 1, "durable-job");
    adapter.submit.mockResolvedValue(durableStatus);
    adapter.status.mockResolvedValue(durableStatus);
    await expect(coordinator.capture(managedWorkbenchCaptureInput(runId, "restart-before-submit", {
      idempotencyKey: "restart-before-submit-key",
    }))).resolves.toMatchObject({ asynchronous: true,
      job: { jobId: "durable-job", state: "queued" } });
    expect(adapter.recover).toHaveBeenCalledWith({
      jobId: "durable-job", expectedInstanceId: "workbench-generation-1",
    });
    expect(adapter.submit).toHaveBeenCalledWith({
      jobId: "durable-job", view: { kind: "current" }, settlePolls: 0,
    });
    await coordinator.close();
  });

  it("recovers a durable run's Workbench association after coordinator restart and promotes its completed image", async () => {
    const runId = "20260717T200000Z-a1b2c3d4";
    const capture = managedWorkbenchCaptureRecord("editor-overview", {
      state: "submitted", expectedWorldId: "world-editor-1",
      expectedWorldEpoch: 0, artifactAvailable: false,
    });
    const { child, adapter, coordinator } = createWorkbenchHarness();
    respondWithRun(child, runId, () => [{ ...capture }]);
    child.responders.set("importWorkbenchArtifact", (payload) => {
      expect(payload).toMatchObject({ jobId: "wb-job-1", runId,
        captureLabel: "editor-overview" });
      expect(Buffer.isBuffer(payload.image)).toBe(true);
      capture.state = "completed";
      capture.artifactAvailable = true;
      return { imported: true };
    });
    const managedMetadata = managedWorkbenchArtifactMetadata({
      viewKind: "current", ownerCameraId: 4,
      actualCamera: workbenchJob("completed").actualCamera,
      actualFov: 70,
    });
    child.responders.set("inspectWorkbenchArtifact", () => ({
      available: capture.artifactAvailable, metadata: managedMetadata }));
    child.responders.set("readWorkbenchArtifact", () => ({
      imageBase64: png.toString("base64"), metadata: managedMetadata }));
    child.responders.set("releaseWorkbenchArtifact", () => ({ released: true }));
    adapter.complete();
    await expect(coordinator.runStatus(runId)).resolves.toMatchObject({
      runId,
      captures: [{
        captureLabel: "editor-overview", state: "completed", artifactAvailable: true,
      }],
    });
    expect(adapter.recover).toHaveBeenCalledWith({
      jobId: "wb-job-1", expectedInstanceId: "workbench-generation-1",
    });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.release).toHaveBeenCalledOnce();
    expect(child.operations).toEqual(expect.arrayContaining(["runStatus", "importWorkbenchArtifact"]));

    await expect(coordinator.jobStatus(undefined, "wb-job-1")).resolves.toMatchObject({
      state: "completed", ownerCameraId: 4, restorationConfirmed: true, actualFov: 70,
    });
    await expect(coordinator.readJob(undefined, "wb-job-1")).resolves.toMatchObject({
      image: png,
      job: { state: "completed", ownerCameraId: 4 },
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    expect(adapter.status).not.toHaveBeenCalled();

    await expect(coordinator.releaseJob(undefined, "wb-job-1")).resolves.toMatchObject({
      backend: "workbench", jobId: "wb-job-1",
      restorationConfirmed: true, managedArtifactReleased: true,
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    expect(adapter.release).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("retires each imported Workbench handler transaction so one managed run can capture sequential views", async () => {
    const runId = "20260717T200030Z-b2c3d4e5";
    const { child, adapter, coordinator } = createWorkbenchHarness();
    const captures = new Map<string, Record<string, unknown>>();
    child.responders.set("runReserveCapture", (payload) => {
      const label = String(payload.captureLabel);
      let capture = captures.get(label);
      if (!capture) {
        capture = {
          captureLabel: label, state: "reserved", backend: null,
          jobId: null, artifactAvailable: false,
        };
        captures.set(label, capture);
      }
      return { runId, capture: { ...capture } };
    });
    child.responders.set("runBindCapture", (payload) => {
      const capture = captures.get(String(payload.captureLabel));
      if (!capture) throw new Error("capture was not reserved");
      Object.assign(capture, payload, { state: "submitted", artifactAvailable: false });
      return { runId, capture: { ...capture } };
    });
    child.responders.set("importWorkbenchArtifact", (payload) => {
      const capture = captures.get(String(payload.captureLabel));
      if (!capture) throw new Error("capture was not bound");
      Object.assign(capture, { state: "completed", artifactAvailable: true });
      return { imported: true };
    });
    child.responders.set("inspectWorkbenchArtifact", (payload) => {
      const capture = [...captures.values()].find((entry) => entry.jobId === payload.jobId);
      return { available: capture?.artifactAvailable === true,
        metadata: managedWorkbenchArtifactMetadata() };
    });

    let activeJobId: string | null = null;
    const statusFor = (jobId: string, state: string) =>
      workbenchJob(state, state === "completed" ? 2 : 1, jobId);
    adapter.instances.mockImplementation(async () => [workbenchInstance()]);
    adapter.submit.mockImplementation(async (input: WorkbenchObserverSubmitInput) => {
      if (activeJobId) throw codedError("CAMERA_BUSY", "handler slot is occupied");
      if (!input.jobId) throw new Error("managed capture omitted its durable job ID");
      activeJobId = input.jobId;
      return statusFor(input.jobId, "queued");
    });
    adapter.recover.mockImplementation(async ({ jobId }: WorkbenchObserverRecoverInput) => {
      if (!activeJobId) throw codedError("JOB_NOT_FOUND", "handler job is absent");
      if (jobId !== activeJobId) throw codedError("JOB_NOT_FOUND", "handler job differs");
      return statusFor(activeJobId, "completed");
    });
    adapter.release.mockImplementation(async () => {
      if (!activeJobId) throw codedError("JOB_NOT_FOUND", "handler job is absent");
      const jobId = activeJobId;
      activeJobId = null;
      return { jobId, restorationConfirmed: true, artifactRemoved: true };
    });
    const capture = async (label: string): Promise<string> => {
      const submitted = await coordinator.capture(managedWorkbenchCaptureInput(runId, label));
      if (!submitted.asynchronous || typeof submitted.job.jobId !== "string") {
        throw new Error("managed Workbench capture returned no job ID");
      }
      await expect(coordinator.jobStatus(undefined, submitted.job.jobId)).resolves.toMatchObject({
        state: "completed", restorationConfirmed: true });
      expect(activeJobId).toBeNull();
      return submitted.job.jobId;
    };

    const firstJobId = await capture("initial-current");
    const retriedFirstJobId = await capture("initial-current");
    expect(retriedFirstJobId).toBe(firstJobId);
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.release).toHaveBeenCalledOnce();
    const secondJobId = await capture("explicit-pose");
    expect(secondJobId).not.toBe(firstJobId);
    expect(adapter.submit).toHaveBeenCalledTimes(2);
    expect(adapter.release).toHaveBeenCalledTimes(2);
    expect(child.operations.filter((operation) => operation === "importWorkbenchArtifact")).toHaveLength(2);
    await coordinator.close();
  });

  it("answers Workbench job status from an exact durable run binding after coordinator restart", async () => {
    const runId = "20260717T200045Z-a1b2c3d4";
    const { child, adapter, coordinator } = createWorkbenchHarness();
    respondWithRun(child, runId, [managedWorkbenchCaptureRecord("restart-status")]);
    adapter.recover.mockRejectedValue(codedError("JOB_NOT_FOUND", "handler retired"));
    await coordinator.runStatus(runId);
    await expect(coordinator.jobStatus(undefined, "wb-job-1")).resolves.toMatchObject({
      backend: "workbench", jobId: "wb-job-1", state: "completed", restorationConfirmed: true,
      recoveredFromManagedArtifact: true,
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("reuses the handler-only receipt while managed artifact release is retried", async () => {
    const runId = "20260717T200100Z-b1c2d3e4";
    const { child, adapter, coordinator } = createWorkbenchHarness();
    respondWithRun(child, runId, [managedWorkbenchCaptureRecord("release-order")], "finalized");
    let releaseAttempts = 0;
    const events: string[] = [];
    child.responders.set("releaseWorkbenchArtifact", () => {
      releaseAttempts += 1;
      events.push(`managed-${releaseAttempts}`);
      if (releaseAttempts === 1) {
        throw codedError("TRANSPORT_UNAVAILABLE", "managed release temporarily unavailable");
      }
      return { released: true };
    });
    adapter.complete();
    adapter.recover.mockImplementation(async () => {
      events.push("adapter-recover");
      return workbenchJob("completed", 2);
    });
    adapter.release.mockImplementation(async () => {
      events.push("adapter-release");
      return { jobId: "wb-job-1", restorationConfirmed: true, artifactRemoved: true };
    });
    await coordinator.runStatus(runId);
    expect(events).toEqual(["adapter-recover", "adapter-release"]);

    await expect(coordinator.releaseJob(undefined, "wb-job-1")).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(adapter.recover).toHaveBeenCalledOnce();
    expect(adapter.release).toHaveBeenCalledOnce();

    await expect(coordinator.releaseJob(undefined, "wb-job-1")).resolves.toMatchObject({
      backend: "workbench", jobId: "wb-job-1", managedArtifactReleased: true,
    });
    expect(events).toEqual(["adapter-recover", "adapter-release", "managed-1", "managed-2"]);
    expect(await coordinator.releaseJob(undefined, "wb-job-1")).toMatchObject({ managedArtifactReleased: true });
    expect(releaseAttempts).toBe(2);
    expect(adapter.release).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it.each(["finalize", "discard"] as const)(
    "%s consumes the run-level managed release proof without deleting or releasing twice",
    async (action) => {
      const runId = action === "finalize"
        ? "20260717T200130Z-c1d2e3f4"
        : "20260717T200140Z-d1e2f3a4";
      const capture = managedWorkbenchCaptureRecord("release-once");
      const { child, adapter, coordinator } = createWorkbenchHarness();
      respondWithRun(child, runId, [{ ...capture }]);
      let managedAvailable = true;
      child.responders.set("runFinalize", () => {
        managedAvailable = false;
        return {
          run: { runId, state: "finalized" },
          receipt: { runId, managedArtifactsReleased: true },
        };
      });
      child.responders.set("runDiscard", () => {
        managedAvailable = false;
        return { runId, discarded: true, releasedCaptureLabels: [capture.captureLabel] };
      });
      child.responders.set("inspectWorkbenchArtifact", () => ({
        available: managedAvailable,
        metadata: {},
      }));
      child.responders.set("releaseWorkbenchArtifact", () => {
        throw new Error("run cleanup already released this managed artifact");
      });

      adapter.complete();
      const result = action === "finalize"
        ? await coordinator.finalizeRun({ runId, releaseManagedArtifacts: true })
        : await coordinator.discardRun(runId);

      expect(result).not.toHaveProperty("workbenchReleaseWarnings");
      expect(managedAvailable).toBe(false);
      expect(child.operations.filter((operation) => operation === "releaseWorkbenchArtifact")).toHaveLength(0);
      expect(adapter.recover).toHaveBeenCalledOnce();
      expect(adapter.release).toHaveBeenCalledOnce();

      await expect(coordinator.releaseJob(undefined, "wb-job-1")).resolves.toMatchObject({
        backend: "workbench",
        jobId: "wb-job-1",
        restorationConfirmed: true,
        artifactRemoved: true,
        managedArtifactReleased: true,
      });
      expect(adapter.recover).toHaveBeenCalledOnce();
      expect(adapter.release).toHaveBeenCalledOnce();
      expect(child.operations.filter((operation) => operation === "releaseWorkbenchArtifact")).toHaveLength(0);
      await coordinator.close();
    }
  );

});
