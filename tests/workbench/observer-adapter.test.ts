import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkbenchCallOptions,
  WorkbenchCaptureActivityLease,
  WorkbenchObserverSnapshot,
} from "../../src/workbench/client.js";
import {
  WorkbenchObserverAdapter,
  workbenchCameraMatrix,
  type WorkbenchObserverClient,
} from "../../src/workbench/observer-adapter.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  numericBooleans?: boolean;
  reportedBaseProject?: string;
  completeOnStatus?: boolean;
  failRevalidation?: boolean;
  loseFirstSubmitAcknowledgement?: boolean;
  loseFirstReleaseAcknowledgement?: boolean;
  corruptArtifact?: boolean;
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
  lostReleaseAcknowledgement = false;
  releaseReceipt: Record<string, unknown> | null = null;

  constructor(private readonly options: FakeOptions = {}) {
	this.failRevalidation = options.failRevalidation ?? false;
    this.root = mkdtempSync(join(tmpdir(), "reforger-forge-wb-observer-"));
    roots.push(this.root);
    this.project = join(this.root, "Example", "Example.gproj");
    this.artifactDirectory = join(this.root, "profile", "ReforgerForgeObserver", "workbench");
    mkdirSync(join(this.root, "Example"), { recursive: true });
    mkdirSync(this.artifactDirectory, { recursive: true });
    writeFileSync(this.project, "GameProject {}", "utf8");
    this.snapshot = Object.freeze({
      generation: "generation-a",
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
        message: "full camera APIs available",
        adapterProtocol: "reforger-forge-workbench-observer/1",
        projectFile: this.options.reportedBaseProject ?? this.project,
        worldIdentity: `${this.project}|world-a|0|false`,
        activeJobId: this.active?.jobId ?? "",
        captureCurrent: this.wireBoolean(true),
        restorationApiAvailable: this.wireBoolean(true),
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
      }) as T;
    }
    if (apiFunc === "EMCP_WB_ObserverCancel") {
      return this.jobResponse("cancelled", true, false, { terminalErrorCode: "CANCELLED" }) as T;
    }
    if (apiFunc === "EMCP_WB_ObserverRelease") {
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
      return this.releaseReceipt as T;
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

  it("captures current view through the exact owned client, validates the native PNG, and releases the gate", async () => {
    const client = new FakeObserverClient({ completeOnStatus: true });
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

  it("rejects a corrupt native PNG after releasing the already-restored lifecycle gate", async () => {
    const client = new FakeObserverClient({ completeOnStatus: true, corruptArtifact: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "corrupt-png" });

    await adapter.submit({ view: { kind: "current" } });
    await expect(adapter.status("corrupt-png")).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    expect(client.releaseCaptureActivity).toHaveBeenCalledTimes(1);
    await expect(adapter.release("corrupt-png")).resolves.toMatchObject({
      restorationConfirmed: true,
    });
  });

  it("normalizes Enforce numeric boolean responses at the adapter boundary", async () => {
    const client = new FakeObserverClient({
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

  it("recovers a lost submit acknowledgement by replaying the exact idempotent command once", async () => {
    const client = new FakeObserverClient({ loseFirstSubmitAcknowledgement: true });
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

  it("refuses public release while camera state is held and replays a lost terminal release acknowledgement", async () => {
    const client = new FakeObserverClient({ loseFirstReleaseAcknowledgement: true });
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

  it("graceful restoreAll cancels active jobs and exactly releases restored handler transactions", async () => {
    const client = new FakeObserverClient();
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "shutdown-job" });
    await adapter.submit({ view: { kind: "current" } });

    await expect(adapter.restoreAll()).resolves.toBeUndefined();

    expect(client.calls.map((call) => call.apiFunc)).toEqual(expect.arrayContaining([
      "EMCP_WB_ObserverCancel",
      "EMCP_WB_ObserverRelease",
    ]));
    expect(client.releaseMutations).toBe(1);
  });

  it("graceful restoreAll releases a completed gate-released handler job", async () => {
    const client = new FakeObserverClient({ completeOnStatus: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "completed-shutdown-job" });
    await adapter.submit({ view: { kind: "current" } });
    await adapter.status("completed-shutdown-job");

    await expect(adapter.restoreAll()).resolves.toBeUndefined();

    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toHaveLength(0);
    expect(client.calls.filter((call) => call.apiFunc === "EMCP_WB_ObserverRelease")).toHaveLength(1);
    expect(client.releaseMutations).toBe(1);
  });

  it("refuses camera.editor views until exact restoration was proven in that Workbench process", async () => {
    const client = new FakeObserverClient({ cameraEditor: false });
    const adapter = new WorkbenchObserverAdapter(client);

    await expect(adapter.submit({
      view: { kind: "pose", position: [1, 2, 3], orientation: [0, 0, 0, 1], fov: 60 },
    })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(client.acquireCaptureActivity).not.toHaveBeenCalled();
  });

  it("binds explicit camera jobs to generation and target and restores on lifecycle cancellation", async () => {
    const client = new FakeObserverClient({ cameraEditor: true });
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

  it("rejects an old lifecycle generation and requests handler restoration", async () => {
    const client = new FakeObserverClient({ cameraEditor: true });
    const adapter = new WorkbenchObserverAdapter(client, { createJobId: () => "stale-job" });
    await adapter.submit({ view: { kind: "current" } });
    client.failRevalidation = true;

    await expect(adapter.status("stale-job")).rejects.toMatchObject({ code: "STALE_LIFECYCLE" });
    expect(client.calls.some((call) => call.apiFunc === "EMCP_WB_ObserverCancel")).toBe(true);
  });

  it("records exact process exit as terminal invalidation without claiming restoration", async () => {
    const client = new FakeObserverClient({ cameraEditor: true });
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

  it("reports only capabilities returned by the dedicated ping handler", async () => {
    const adapter = new WorkbenchObserverAdapter(new FakeObserverClient({ cameraEditor: false }));
    await expect(adapter.instances()).resolves.toEqual([
      expect.objectContaining({
        lifecycleGeneration: "generation-a",
        capabilities: ["render.capture"],
        restorationApiAvailable: true,
      }),
    ]);
  });
});
