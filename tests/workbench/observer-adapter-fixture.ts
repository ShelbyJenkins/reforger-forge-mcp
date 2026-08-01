import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { it, vi } from "vitest";
import type {
  WorkbenchCallOptions,
  WorkbenchCaptureActivityLease,
  WorkbenchObserverSnapshot,
} from "../../src/workbench/client.js";
import type { WorkbenchObserverClient } from "../../src/workbench/observer-adapter.js";
import {
  companionLifecycleState,
  createFakeCompanionLaunch,
} from "./fake-companion.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

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

export function png(width = 1, height = 1): Buffer {
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

export interface FakeOptions {
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

export class FakeObserverClient implements WorkbenchObserverClient {
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
      const dimensions = this.captureDimensions();
      const bytes = png(dimensions.width, dimensions.height);
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
    const dimensions = this.captureDimensions();
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
      requestedMaxWidth: this.active.maxWidth,
      requestedMaxHeight: this.active.maxHeight,
      sourceWidth: state === "completed" ? 2 : 0,
      sourceHeight: state === "completed" ? 2 : 0,
      outputWidth: state === "completed" ? dimensions.width : 0,
      outputHeight: state === "completed" ? dimensions.height : 0,
      actualFov: Number(this.active.fovText),
      nearPlane: 0.1,
      farPlane: 2_000,
      cameraLeaseHeld: this.wireBoolean(cameraLeaseHeld),
      restorationConfirmed: this.wireBoolean(restorationConfirmed),
      ...overrides,
    };
  }

  private captureDimensions(): { width: number; height: number } {
    let width = 2;
    let height = 2;
    const maxWidth = Number(this.active?.maxWidth) || 0;
    const maxHeight = Number(this.active?.maxHeight) || 0;
    if (maxWidth > 0 && width > maxWidth) {
      height = Math.max(1, Math.floor(height * maxWidth / width));
      width = maxWidth;
    }
    if (maxHeight > 0 && height > maxHeight) {
      width = Math.max(1, Math.floor(width * maxHeight / height));
      height = maxHeight;
    }
    return { width, height };
  }

  private wireBoolean(value: boolean): boolean | number {
    return this.options.numericBooleans ? Number(value) : value;
  }
}

export function fakeClient(root: string, options: FakeOptions = {}): FakeObserverClient {
  return new FakeObserverClient(options, root);
}

export function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "reforger-forge-wb-observer-" }));
}
