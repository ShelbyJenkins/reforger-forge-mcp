import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WorkbenchObserverAdapter,
  workbenchCameraMatrix,
} from "../../src/workbench/observer-adapter.js";
import { WorkbenchObserverAcceptanceAdapter } from "../../scripts/workbench-observer-acceptance-adapter.js";
import { createOneShotWorkbenchPngArtifactHook } from "../../scripts/observer-workbench-failure-support.js";
import {
  fakeClient,
  scopedIt,
} from "./observer-adapter-fixture.js";

describe("Workbench observer adapter", () => {
  it("builds deterministic orthonormal pose and near-vertical look-at camera bases", () => {
    expect(workbenchCameraMatrix({
      kind: "pose",
      position: [10, 20, 30],
      orientation: [0, 0, 0, 1],
      fov: 60,
    })).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [10, 20, 30],
    ]);

    const matrix = workbenchCameraMatrix({
      kind: "lookAt",
      position: [0, 0, 0],
      target: [0, 100, 0],
      fov: 45,
    });
    for (const axis of matrix.slice(0, 3)) {
      expect(Math.hypot(...axis)).toBeCloseTo(1, 10);
    }
    expect(matrix[2]).toEqual([0, 1, 0]);
  });

  scopedIt("evaluates a dynamic handler timeout at each native dispatch", async (root) => {
    const client = fakeClient(root);
    let timeoutMs = 4_321;
    const adapter = new WorkbenchObserverAdapter(client, {
      handlerTimeoutMs: () => timeoutMs,
    });

    await adapter.ping();
    timeoutMs = 1_234;
    await adapter.ping();

    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverPing")
      .map((call) => call.options.timeout)).toEqual([4_321, 1_234]);
  });

  scopedIt("rejects an invalid static timeout at construction and a dynamic timeout at dispatch", async (root) => {
    const client = fakeClient(root);
    expect(() => new WorkbenchObserverAdapter(client, { handlerTimeoutMs: 0 }))
      .toThrow("Workbench observer handler timeout must be a positive integer");

    const dynamic = new WorkbenchObserverAdapter(client, { handlerTimeoutMs: () => 0 });
    await expect(dynamic.ping()).rejects.toThrow(
      "Workbench observer handler timeout must be a positive integer"
    );
  });

  scopedIt("captures current view through the exact owned client, validates the native PNG, and releases the gate", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "job-current" });

    const submitted = await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" }, settlePolls: 2 });
    expect(submitted).toMatchObject({
      jobId: "job-current",
      state: "settling",
      lifecycleGeneration: "generation-a",
      cameraLeaseHeld: true,
    });
    const completed = await adapter.status("job-current");
    expect(completed).toMatchObject({
      state: "completed",
      restorationConfirmed: true,
      artifact: { format: "png", width: 2, height: 2 },
    });
    expect(completed.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const converted = adapter.readCompletedArtifact("job-current");
    expect(converted.image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(converted.metadata).toMatchObject({ width: 2, height: 2 });
    expect(client.releaseCaptureActivity).toHaveBeenCalledTimes(1);
    expect(client.calls.every((call) => call.options.skipAutoLaunch === true)).toBe(true);
    expect(client.calls.some((call) => /ExecuteAction|Reload|Play|Save/.test(call.apiFunc))).toBe(false);
  });

  scopedIt("resizes and converts the validated Workbench PNG before retaining it", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "job-webp" });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`,
      view: { kind: "current" },
      image: { format: "webp", quality: 55, maxWidth: 1 },
    });
    expect(client.calls.find((call) => call.apiFunc === "EMCP_WB_ObserverSubmit")?.params)
      .toMatchObject({ maxWidth: 1, maxHeight: 0 });
    const completed = await adapter.status("job-webp");
    expect(completed.artifact).toMatchObject({
      format: "webp",
      mimeType: "image/webp",
      width: 1,
      height: 1,
      sourceWidth: 1,
      sourceHeight: 1,
      viewportWidth: 2,
      viewportHeight: 2,
    });
    const converted = adapter.readCompletedArtifact("job-webp");
    expect(converted.image.toString("ascii", 0, 4)).toBe("RIFF");
    expect(converted.image.toString("ascii", 8, 12)).toBe("WEBP");
    expect(converted.metadata).toMatchObject({
      format: "webp",
      mimeType: "image/webp",
      requestedImage: { format: "webp", quality: 55, maxWidth: 1 },
      resized: true,
      producerResized: true,
      transcoded: true,
    });
  });

  scopedIt("cancels a restored completed job through the real handler until artifact release", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, { createJobId: () => "terminal-cancel" });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } });
    await expect(adapter.status("terminal-cancel")).resolves.toMatchObject({
      state: "completed",
      cameraLeaseHeld: false,
      restorationConfirmed: true,
    });
    await expect(adapter.cancel("terminal-cancel")).resolves.toMatchObject({
      state: "cancelled",
      cameraLeaseHeld: false,
      restorationConfirmed: true,
    });
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toHaveLength(1);
    expect(() => adapter.readCompletedArtifact("terminal-cancel")).toThrow(/no completed retained image/);
  });

  scopedIt("keeps production cancellation idempotent after a restored terminal", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "production-terminal" });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } });
    await adapter.status("production-terminal");
    await expect(adapter.cancel("production-terminal")).resolves.toMatchObject({
      state: "completed",
      cameraLeaseHeld: false,
      restorationConfirmed: true,
    });
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toHaveLength(0);
  });

  scopedIt("fails closed when the acceptance terminal Cancel does not prove cancelled restoration", async (root) => {
    const client = fakeClient(root, {
      completeOnStatus: true,
      cancelResponseOverrides: { state: "failed", restorationConfirmed: false },
    });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "terminal-cancel-unproven",
    });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } });
    await adapter.status("terminal-cancel-unproven");
    await expect(adapter.cancel("terminal-cancel-unproven")).rejects.toMatchObject({
      code: "RESTORATION_UNCONFIRMED",
    });
  });

  scopedIt("rejects a corrupt native PNG after releasing the already-restored lifecycle gate", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true, corruptArtifact: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "corrupt-png" });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } });
    await expect(adapter.status("corrupt-png")).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(client.releaseCaptureActivity).toHaveBeenCalledTimes(1);
    await expect(adapter.release("corrupt-png")).resolves.toMatchObject({
      restorationConfirmed: true,
    });
  });

  scopedIt("runs a one-shot fixture mutation after restored-terminal preflight and immediately before PNG validation", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const mutate = createOneShotWorkbenchPngArtifactHook("crc_corruption");
    let mutationResult: ReturnType<typeof mutate> | undefined;
    const beforeArtifactValidation = vi.fn((context) => {
      expect(Object.isFrozen(context)).toBe(true);
      expect(readFileSync(context.artifactPath).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );
      mutationResult = mutate(context);
    });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "pre-validation-crc",
      beforeArtifactValidation,
    });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } });
    await expect(adapter.status("pre-validation-crc")).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });

    expect(beforeArtifactValidation).toHaveBeenCalledTimes(1);
    expect(beforeArtifactValidation).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "pre-validation-crc",
      artifactBytes: expect.any(Number),
      cameraLeaseHeld: false,
      restorationConfirmed: true,
    }));
    expect(mutationResult).toMatchObject({
      mutation: "crc_corruption",
      byteLengthChanged: false,
    });
    expect(client.releaseCaptureActivity).toHaveBeenCalledTimes(1);

    // The terminal status retained after validation failure does not run the
    // mutation callback a second time.
    await expect(adapter.status("pre-validation-crc")).resolves.toMatchObject({
      state: "completed",
      restorationConfirmed: true,
    });
    expect(beforeArtifactValidation).toHaveBeenCalledTimes(1);
  });

  scopedIt("does not expose an unbound artifact path to the pre-validation hook", async (root) => {
    const client = fakeClient(root, {
      completeOnStatus: true,
      completedArtifactOverrides: { artifactPath: join(root, "unbound.png") },
    });
    const beforeArtifactValidation = vi.fn();
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "unbound-artifact",
      beforeArtifactValidation,
    });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } });
    await expect(adapter.status("unbound-artifact")).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
    expect(beforeArtifactValidation).not.toHaveBeenCalled();
    expect(client.releaseCaptureActivity).toHaveBeenCalledTimes(1);
  });

  scopedIt("maps a pre-validation callback failure to a bounded artifact error after restoration", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const beforeArtifactValidation = vi.fn(() => {
      throw new Error("C:\\private-user\\artifact-path-sentinel.png");
    });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
      createJobId: () => "hook-failure",
      beforeArtifactValidation,
    });

    await adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } });
    let failure: unknown;
    try {
      await adapter.status("hook-failure");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "ARTIFACT_INVALID",
      message: "Workbench artifact pre-validation hook failed",
    });
    expect(String(failure)).not.toContain("private-user");
    expect(beforeArtifactValidation).toHaveBeenCalledTimes(1);
    expect(client.releaseCaptureActivity).toHaveBeenCalledTimes(1);
  });

  scopedIt("normalizes Enforce numeric boolean responses at the adapter boundary", async (root) => {
    const client = fakeClient(root, {
      cameraEditor: true,
      completeOnStatus: true,
      numericBooleans: true,
      reportedBaseProject: "D:\\Arma Reforger\\addons\\data\\ArmaReforger.gproj",
    });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "numeric-bools" });

    await expect(adapter.ping()).resolves.toMatchObject({
      capabilities: ["render.capture", "camera.editor"],
      projectFile: client.project,
      restorationApiAvailable: true,
      readinessMessage: "full camera APIs available",
    });
    await expect(adapter.submit({ expectedWorldIdentity: `${client.project}|world-a|0|false`, view: { kind: "current" } })).resolves.toMatchObject({
      cameraLeaseHeld: true,
      restorationConfirmed: false,
    });
    await expect(adapter.status("numeric-bools")).resolves.toMatchObject({
      cameraLeaseHeld: false,
      restorationConfirmed: true,
    });
    await expect(adapter.release("numeric-bools")).resolves.toMatchObject({
      restorationConfirmed: true,
      artifactRemoved: true,
    });
  });
});
