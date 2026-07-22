import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  WorkbenchCallOptions,
  WorkbenchCaptureActivityLease,
  WorkbenchObserverSnapshot,
} from "../../src/workbench/client.js";
import {
  WorkbenchObserverAdapter,
  workbenchCameraMatrix,
  type WorkbenchObserverAdapterOptions,
  type WorkbenchObserverClient,
} from "../../src/workbench/observer-adapter.js";
import { WorkbenchObserverAcceptanceAdapter } from "../../scripts/workbench-observer-acceptance-adapter.js";
import { createOneShotWorkbenchPngArtifactHook } from "../../scripts/observer-workbench-failure-support.js";
import {
  companionLifecycleState,
  createFakeCompanionLaunch,
} from "./fake-companion.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

type ForbiddenProductionAdapterMethod = Extract<
  keyof WorkbenchObserverAdapter,
  | "armOneShotBeforeSubmitDelivery"
  | "armOneShotBeforeRelease"
  | "requireExactOwnerExit"
  | "confirmExactOwnerExit"
>;

type ForbiddenProductionAdapterOption = Extract<
  keyof WorkbenchObserverAdapterOptions,
  "beforeArtifactValidation" | "verifyIdempotentReleaseReplay"
>;

describe("Workbench observer production adapter boundary", () => {
  it("keeps repository acceptance controls out of the shipped public types", () => {
    expectTypeOf<ForbiddenProductionAdapterMethod>().toEqualTypeOf<never>();
    expectTypeOf<ForbiddenProductionAdapterOption>().toEqualTypeOf<never>();
  });

  it("keeps repository-only acceptance state out of the production implementation", () => {
    const productionSource = readFileSync(
      join(process.cwd(), "src", "workbench", "observer-adapter.ts"),
      "utf8"
    );
    for (const acceptanceOnlyIdentifier of [
      "armOneShotBeforeSubmitDelivery",
      "armOneShotBeforeRelease",
      "requireExactOwnerExit",
      "confirmExactOwnerExit",
      "exactOwnerExitRequired",
      "exactOwnerExitConfirmed",
      "artifactPreValidationInvoked",
      "beforeArtifactValidation",
      "verifyIdempotentReleaseReplay",
    ]) {
      expect(productionSource).not.toContain(acceptanceOnlyIdentifier);
    }
  });
});

function testCrc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function testPngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(testCrc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function png(width = 1, height = 1): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rowBytes = 1 + width * 3;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    pixels[row * rowBytes] = 0;
    for (let column = 0; column < width; column += 1) {
      const offset = row * rowBytes + 1 + column * 3;
      pixels[offset] = row * 31;
      pixels[offset + 1] = column * 47;
      pixels[offset + 2] = 127;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    testPngChunk("IHDR", header),
    testPngChunk("IDAT", deflateSync(pixels)),
    testPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

interface FakeOptions {
  cameraEditor?: boolean;
  captureCurrent?: boolean;
  restorationApiAvailable?: boolean;
  readinessMessage?: string;
  numericBooleans?: boolean;
  reportedBaseProject?: string;
  completeOnStatus?: boolean;
  failRevalidation?: boolean;
  loseFirstSubmitAcknowledgement?: boolean;
  loseFirstReleaseAcknowledgement?: boolean;
  corruptArtifact?: boolean;
  completedArtifactOverrides?: Record<string, unknown>;
  cancelResponseOverrides?: Record<string, unknown>;
  failFirstCancel?: boolean;
  releaseReplayOverrides?: Record<string, unknown>;
  releaseReplayError?: Error;
}

class FakeObserverClient implements WorkbenchObserverClient {
  readonly root: string;
  readonly project: string;
  readonly artifactDirectory: string;
  readonly calls: Array<{
    apiFunc: string;
    params: Record<string, unknown>;
    options: WorkbenchCallOptions;
  }> = [];
  readonly snapshot: WorkbenchObserverSnapshot;
  readonly releaseCaptureActivity = vi.fn();
  readonly requireExactOwnerExit = vi.fn();
  readonly acquireCaptureActivity = vi.fn((snapshot: WorkbenchObserverSnapshot) => {
    const controller = new AbortController();
    this.controller = controller;
    return {
      id: "activity-lease",
      binding: {
        generation: snapshot.generation,
        targetKey: snapshot.target.comparisonKey,
        process: {
          pid: snapshot.process.pid,
          executablePath: snapshot.process.executablePath,
          creationTime: snapshot.process.creationTime,
        },
      },
      signal: controller.signal,
    } satisfies WorkbenchCaptureActivityLease;
  });
  controller: AbortController | null = null;
  active: Record<string, unknown> | null = null;
  sequence = 2;
  failRevalidation: boolean;
  submitMutations = 0;
  lostSubmitAcknowledgement = false;
  releaseMutations = 0;
  releaseCalls = 0;
  failedFirstCancel = false;
  lostReleaseAcknowledgement = false;
  releaseReceipt: Record<string, unknown> | null = null;

  constructor(private readonly options: FakeOptions = {}, root: string) {
	this.failRevalidation = options.failRevalidation ?? false;
    this.root = root;
    const managedRoot = join(root, "managed-profile");
    const companion = createFakeCompanionLaunch(managedRoot);
    this.project = join(this.root, "Example", "Example.gproj");
    this.artifactDirectory = join(
      companion.workbenchProfilePath,
      "profile",
      "ReforgerForgeObserver",
      "workbench"
    );
    mkdirSync(join(this.root, "Example"), { recursive: true });
    mkdirSync(this.artifactDirectory, { recursive: true });
    writeFileSync(this.project, "GameProject {}", "utf8");
    this.snapshot = Object.freeze({
      generation: "generation-a",
      companion: Object.freeze(companionLifecycleState(companion)),
      target: Object.freeze({ path: this.project, comparisonKey: this.project.toLowerCase() }),
      endpoint: Object.freeze({ host: "127.0.0.1", port: 5775 }),
      process: Object.freeze({
        pid: 4040,
        executablePath: "C:\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
        creationTime: "123456",
        launchedAtMs: 1_000,
      }),
    });
  }

  async getRunningObserverSnapshot(): Promise<WorkbenchObserverSnapshot> {
    return this.snapshot;
  }

  async revalidateCaptureActivity(): Promise<WorkbenchObserverSnapshot> {
    if (this.failRevalidation) {
      throw Object.assign(new Error("old generation"), { code: "CAPTURE_INVALIDATED" });
    }
    return this.snapshot;
  }

  async call<T>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    this.calls.push({ apiFunc, params, options });
    if (apiFunc === "EMCP_WB_ObserverPing") {
      return {
        status: "ok",
        message: this.options.readinessMessage ?? "full camera APIs available",
        adapterProtocol: "reforger-forge-workbench-observer/1",
        projectFile: this.options.reportedBaseProject ?? this.project,
        worldIdentity: `${this.project}|world-a|0|false`,
        activeJobId: this.active?.jobId ?? "",
        captureCurrent: this.wireBoolean(this.options.captureCurrent ?? true),
        restorationApiAvailable: this.wireBoolean(this.options.restorationApiAvailable ?? true),
        cameraEditor: this.wireBoolean(this.options.cameraEditor ?? false),
      } as T;
    }
    if (apiFunc === "EMCP_WB_ObserverSubmit") {
      if (!this.active) {
        this.active = { ...params };
        this.submitMutations += 1;
      }
      if (this.options.loseFirstSubmitAcknowledgement && !this.lostSubmitAcknowledgement) {
        this.lostSubmitAcknowledgement = true;
        throw new Error("submit response was lost after delivery");
      }
      return this.jobResponse("settling", false, true) as T;
    }
    if (apiFunc === "EMCP_WB_ObserverStatus") {
      if (!this.options.completeOnStatus) return this.jobResponse("settling", false, true) as T;
      const path = join(this.artifactDirectory, `${String(params.jobId)}.png`);
      const bytes = png(2, 2);
      if (this.options.corruptArtifact) bytes[bytes.length - 1] ^= 0xff;
      writeFileSync(path, bytes);
      return this.jobResponse("completed", true, false, {
        artifactLogicalPath: `$profile:ReforgerForgeObserver/workbench/${String(params.jobId)}.png`,
        artifactPath: path,
        artifactBytes: bytes.length,
        ...this.options.completedArtifactOverrides,
      }) as T;
    }
    if (apiFunc === "EMCP_WB_ObserverCancel") {
      if (this.options.failFirstCancel && !this.failedFirstCancel) {
        this.failedFirstCancel = true;
        throw new Error("first cancel transport failed");
      }
      return this.jobResponse("cancelled", true, false, {
        terminalErrorCode: "CANCELLED",
        ...this.options.cancelResponseOverrides,
      }) as T;
    }
    if (apiFunc === "EMCP_WB_ObserverRelease") {
      this.releaseCalls += 1;
      if (!this.releaseReceipt) {
        this.releaseMutations += 1;
        this.releaseReceipt = {
          status: "ok",
          message: "released",
          adapterProtocol: "reforger-forge-workbench-observer/1",
          jobId: params.jobId,
          restorationConfirmed: this.wireBoolean(true),
          artifactRemoved: this.wireBoolean(true),
        };
        this.active = null;
      }
      if (this.options.loseFirstReleaseAcknowledgement && !this.lostReleaseAcknowledgement) {
        this.lostReleaseAcknowledgement = true;
        throw new Error("release response was lost after delivery");
      }
      if (this.releaseCalls > 1 && this.options.releaseReplayError) {
        throw this.options.releaseReplayError;
      }
      return this.releaseCalls > 1 && this.options.releaseReplayOverrides
        ? { ...this.releaseReceipt, ...this.options.releaseReplayOverrides } as T
        : this.releaseReceipt as T;
    }
    throw new Error(`unexpected handler ${apiFunc}`);
  }

  private jobResponse(
    state: string,
    restorationConfirmed: boolean,
    cameraLeaseHeld: boolean,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    if (!this.active) throw new Error("no active fake handler job");
    return {
      status: "ok",
      message: state,
      adapterProtocol: "reforger-forge-workbench-observer/1",
      jobId: this.active.jobId,
      leaseId: this.active.leaseId,
      lifecycleGeneration: this.active.lifecycleGeneration,
      canonicalTarget: this.active.canonicalTarget,
      projectFile: this.project,
      worldIdentity: `${this.project}|world-a|0|false`,
      viewKind: this.active.viewKind,
      state,
      terminalErrorCode: "",
      artifactLogicalPath: "",
      artifactPath: "",
      cameraMatrix0: "1 0 0",
      cameraMatrix1: "0 1 0",
      cameraMatrix2: "0 0 1",
      cameraMatrix3: "1 2 3",
      sequence: this.sequence++,
      settlePolls: this.active.settlePolls,
      settledPolls: 1,
      artifactBytes: 0,
      ownerCameraId: 7,
      actualFov: Number(this.active.fovText),
      nearPlane: 0.1,
      farPlane: 2_000,
      cameraLeaseHeld: this.wireBoolean(cameraLeaseHeld),
      restorationConfirmed: this.wireBoolean(restorationConfirmed),
      ...overrides,
    };
  }

  private wireBoolean(value: boolean): boolean | number {
    return this.options.numericBooleans ? Number(value) : value;
  }
}

function fakeClient(root: string, options: FakeOptions = {}): FakeObserverClient {
  return new FakeObserverClient(options, root);
}

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "reforger-forge-wb-observer-" }));
}

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

    const submitted = await adapter.submit({ view: { kind: "current" }, settlePolls: 2 });
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

  scopedIt("cancels a restored completed job through the real handler until artifact release", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true });
    const adapter = new WorkbenchObserverAcceptanceAdapter(client, { createJobId: () => "terminal-cancel" });

    await adapter.submit({ view: { kind: "current" } });
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

    await adapter.submit({ view: { kind: "current" } });
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

    await adapter.submit({ view: { kind: "current" } });
    await adapter.status("terminal-cancel-unproven");
    await expect(adapter.cancel("terminal-cancel-unproven")).rejects.toMatchObject({
      code: "RESTORATION_UNCONFIRMED",
    });
  });

  scopedIt("rejects a corrupt native PNG after releasing the already-restored lifecycle gate", async (root) => {
    const client = fakeClient(root, { completeOnStatus: true, corruptArtifact: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "corrupt-png" });

    await adapter.submit({ view: { kind: "current" } });
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

    await adapter.submit({ view: { kind: "current" } });
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

    await adapter.submit({ view: { kind: "current" } });
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

    await adapter.submit({ view: { kind: "current" } });
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
    await expect(adapter.submit({ view: { kind: "current" } })).resolves.toMatchObject({
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
