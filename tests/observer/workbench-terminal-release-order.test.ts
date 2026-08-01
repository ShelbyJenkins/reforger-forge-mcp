import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type {
  CaptureArtifact,
  CaptureRunPort,
  CompletedRunCapture,
} from "../../src/observer/capture-contract.js";
import { CaptureService } from "../../src/observer/capture-service.js";
import { WorkbenchCaptureBackend } from "../../src/observer/workbench-capture-backend.js";
import { workbenchWorldRevision } from "../../src/observer/world-revision.js";
import type {
  WorkbenchCallOptions,
  WorkbenchCaptureActivityLease,
  WorkbenchObserverSnapshot,
} from "../../src/workbench/client.js";
import type { WorkbenchObserverClient } from "../../src/workbench/observer-adapter.js";
import { WorkbenchObserverAcceptanceAdapter } from "../../scripts/workbench-observer-acceptance-adapter.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import {
  companionLifecycleState,
  createFakeCompanionLaunch,
} from "../workbench/fake-companion.js";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function validPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.from([
    0, 255, 0, 0, 0, 255, 0,
    0, 0, 0, 255, 255, 255, 255,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

class TerminalReleaseClient implements WorkbenchObserverClient {
  readonly calls: string[] = [];
  readonly snapshot: WorkbenchObserverSnapshot;
  private readonly artifactDirectory: string;
  private active: Record<string, unknown> | null = null;
  private sequence = 1;

  constructor(root: string) {
    const companion = createFakeCompanionLaunch(join(root, "managed"));
    const project = join(root, "project", "TerminalRelease.gproj");
    this.artifactDirectory = join(
      companion.workbenchProfilePath,
      "profile",
      "ReforgerForgeObserver",
      "workbench"
    );
    mkdirSync(join(root, "project"), { recursive: true });
    mkdirSync(this.artifactDirectory, { recursive: true });
    writeFileSync(project, "GameProject {}", "utf8");
    this.snapshot = Object.freeze({
      generation: "terminal-release-generation",
      companion: Object.freeze(companionLifecycleState(companion)),
      target: Object.freeze({ path: project, comparisonKey: project.toLowerCase() }),
      endpoint: Object.freeze({ host: "127.0.0.1", port: 5775 }),
      process: Object.freeze({
        pid: 4242,
        executablePath: "C:\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
        creationTime: "123456",
        launchedAtMs: 1_000,
      }),
    });
  }

  async getRunningObserverSnapshot(): Promise<WorkbenchObserverSnapshot> {
    return this.snapshot;
  }

  acquireCaptureActivity(snapshot: WorkbenchObserverSnapshot): WorkbenchCaptureActivityLease {
    return {
      id: "terminal-release-activity",
      binding: {
        generation: snapshot.generation,
        targetKey: snapshot.target.comparisonKey,
        process: {
          pid: snapshot.process.pid,
          executablePath: snapshot.process.executablePath,
          creationTime: snapshot.process.creationTime,
        },
      },
      signal: new AbortController().signal,
    };
  }

  async revalidateCaptureActivity(): Promise<WorkbenchObserverSnapshot> {
    return this.snapshot;
  }

  releaseCaptureActivity(): void {}
  requireExactOwnerExit(): void {}

  async call<T>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    _options: WorkbenchCallOptions = {}
  ): Promise<T> {
    this.calls.push(apiFunc);
    if (apiFunc === "EMCP_WB_ObserverPing") {
      return {
        status: "ok",
        message: "fixture ready",
        adapterProtocol: "reforger-forge-workbench-observer/1",
        projectFile: this.snapshot.target.path,
        worldIdentity: `${this.snapshot.target.path}|world-a|0|false`,
        activeJobId: this.active?.jobId ?? "",
        captureCurrent: true,
        restorationApiAvailable: true,
        cameraEditor: true,
      } as T;
    }
    if (apiFunc === "EMCP_WB_ObserverSubmit") {
      this.active = { ...params };
      return this.jobResponse("settling", false, true) as T;
    }
    if (apiFunc === "EMCP_WB_ObserverStatus") {
      const image = validPng();
      const artifactPath = join(this.artifactDirectory, `${String(params.jobId)}.png`);
      writeFileSync(artifactPath, image);
      return this.jobResponse("completed", true, false, {
        artifactLogicalPath: `$profile:ReforgerForgeObserver/workbench/${String(params.jobId)}.png`,
        artifactPath,
        artifactBytes: image.length,
      }) as T;
    }
    if (apiFunc === "EMCP_WB_ObserverRelease") {
      throw new Error("terminal-release seam allowed a handler Release call");
    }
    throw new Error(`unexpected Workbench handler ${apiFunc}`);
  }

  private jobResponse(
    state: "settling" | "completed",
    restorationConfirmed: boolean,
    cameraLeaseHeld: boolean,
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    if (!this.active) throw new Error("no active Workbench job");
    return {
      status: "ok",
      message: state,
      adapterProtocol: "reforger-forge-workbench-observer/1",
      jobId: this.active.jobId,
      leaseId: this.active.leaseId,
      lifecycleGeneration: this.active.lifecycleGeneration,
      canonicalTarget: this.active.canonicalTarget,
      projectFile: this.snapshot.target.path,
      worldIdentity: `${this.snapshot.target.path}|world-a|0|false`,
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
      settledPolls: 3,
      artifactBytes: 0,
      ownerCameraId: 7,
      requestedMaxWidth: this.active.maxWidth,
      requestedMaxHeight: this.active.maxHeight,
      sourceWidth: state === "completed" ? 2 : 0,
      sourceHeight: state === "completed" ? 2 : 0,
      outputWidth: state === "completed" ? 2 : 0,
      outputHeight: state === "completed" ? 2 : 0,
      actualFov: 60,
      nearPlane: 0.1,
      farPlane: 2_000,
      cameraLeaseHeld,
      restorationConfirmed,
      ...overrides,
    };
  }
}

describe("Workbench terminal-release owner shutdown ordering", () => {
  it("promotes the managed artifact before exact shutdown and skips handler Release", () =>
    withTemporaryDirectory(async (root) => {
      const client = new TerminalReleaseClient(root);
      const adapter = new WorkbenchObserverAcceptanceAdapter(client, {
        createJobId: () => "terminal-release-job",
      });
      let promoted: CaptureArtifact | null = null;
      const events: string[] = [];
      const runPort: CaptureRunPort = {
        async reserve(input) {
          events.push("reserve");
          return { runId: input.runId, captureLabel: input.captureLabel, jobId: input.jobId };
        },
        async bind() { events.push("bind"); },
        async complete(input: CompletedRunCapture) {
          events.push("promote");
          promoted = { image: Buffer.from(input.artifact.image), metadata: { ...input.artifact.metadata } };
        },
        async fail() { events.push("fail"); },
        async assertReleaseAllowed() { events.push("release-preflight"); },
        async readManagedArtifact() {
          events.push("read-managed");
          if (!promoted) throw new Error("managed artifact was not promoted");
          return promoted;
        },
      };
      const service = new CaptureService({
        backends: [new WorkbenchCaptureBackend(adapter)],
        runPort,
        createJobId: () => "terminal-release-job",
        defaultTimeoutMs: 5_000,
      });

      try {
        const [instance] = await adapter.instances();
        const submitted = await service.capture({
          runId: "20260719T120000Z-a1b2c3d4",
          captureLabel: "terminal-release",
          instanceId: instance!.instanceId,
          idempotencyKey: "terminal-release-order",
          view: { kind: "current" },
          asynchronous: true,
          timeoutMs: 5_000,
          expectedWorldRevision: workbenchWorldRevision(instance!.worldIdentity),
        });
        expect(submitted.job).toMatchObject({ state: "settling" });
        const jobId = submitted.job.jobId;
        await expect(adapter.status(jobId)).resolves.toMatchObject({
          state: "completed",
          cameraLeaseHeld: false,
          restorationConfirmed: true,
        });

        adapter.armOneShotBeforeRelease(jobId, async (context) => {
          events.push("exact-shutdown");
          expect(context).toMatchObject({
            jobId,
            instanceId: instance!.instanceId,
            lifecycleGeneration: client.snapshot.generation,
            canonicalTarget: client.snapshot.target.path,
            restorationConfirmed: true,
            cameraLeaseHeld: false,
          });
          return { exactOwnerVacant: true };
        });

        const completed = await service.status(undefined, jobId);
        expect(completed).toMatchObject({
          state: "completed",
          restorationConfirmed: true,
          handlerRelease: { restorationConfirmed: true, artifactRemoved: false },
        });
        expect(events.indexOf("promote")).toBeGreaterThanOrEqual(0);
        expect(events.indexOf("promote")).toBeLessThan(events.indexOf("exact-shutdown"));
        expect(client.calls).not.toContain("EMCP_WB_ObserverRelease");

        const retained = await service.read(undefined, jobId);
        expect(retained.job.state).toBe("completed");
        expect(retained.image.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        );
        expect(events).toContain("read-managed");
      } finally {
        await service.close();
      }
    }, { prefix: "reforger-forge-terminal-release-" }));
});
