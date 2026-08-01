import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  OperationalBaselineRecorder,
  analyzePngMaterial,
  buildOperationalBaselineArtifact,
  compareDecodedPng,
  comparePngImages,
  decodePng,
  detectColorMarker,
  detectPngColorMarker,
  findBlockingProcesses,
  operationalBaselineDirectoryIdentity,
  operationalBaselineEnvironment,
  operationalBaselineLaunchArgumentIdentity,
  operationalBaselineProcedureSha256,
  operationalBaselineSource,
  waitForOperationalBaselineProcessVacancy,
  type AcceptanceSupervisedProcessCounts,
  type OperationalBaselineEnvironment,
  type OperationalBaselineWorkload,
} from "../../scripts/observer-live-acceptance-support.js";

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(12 + body.length);
  result.writeUInt32BE(body.length, 0);
  typeBytes.copy(result, 4);
  body.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, body])), 8 + body.length);
  return result;
}

function pixelPng(
  width: number,
  height: number,
  channels: 3 | 4,
  pixelAt: (x: number, y: number) => readonly number[]
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const rows = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * channels);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * channels;
      const values = pixelAt(x, y);
      for (let channel = 0; channel < channels; channel += 1) {
        rows[pixel + channel] = values[channel] ?? (channel === 3 ? 255 : 0);
      }
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function rgbPng(varied: boolean): Buffer {
  return pixelPng(64, 64, 3, (x, y) => varied
    ? [(x * 4) & 0xff, (y * 4) & 0xff, ((x + y) * 2) & 0xff]
    : [0, 0, 0]);
}

function gradientPixel(x: number, y: number): readonly [number, number, number] {
  return [(x * 3) & 0xff, (y * 3) & 0xff, ((x + y) * 2) & 0xff];
}

function testWorkload(backend: "workbench" | "runtime"): OperationalBaselineWorkload {
  return {
    procedureRevision: backend === "workbench"
      ? "workbench-observer-live-acceptance-v4"
      : "runtime-observer-acceptance-v2",
    runtimeKind: backend === "workbench" ? "workbench" : "listenServer",
    overallTimeoutMs: 300_000,
    worldResource: "{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent",
    fixture: backend === "workbench" ? {
      kind: "disposable_workbench_world",
      id: "ObserverAcceptance",
      guid: null,
      sourceFileCount: 3,
      sourceSha256: "f".repeat(64),
    } : null,
    capture: {
      labels: ["initial-current"],
      settleFrames: 3,
      performancePolicy: "evidence",
      asynchronous: backend === "workbench",
      configurationSha256: "e".repeat(64),
    },
    launchArguments: operationalBaselineLaunchArgumentIdentity(["-noThrow"]),
  };
}

function testEnvironment(backend: "workbench" | "runtime"): OperationalBaselineEnvironment {
  const executable = backend === "workbench"
    ? "ArmaReforgerWorkbenchSteamDiag.exe"
    : "ArmaReforgerSteamDiag.exe";
  return operationalBaselineEnvironment({
    ...(backend === "workbench"
      ? { workbenchExecutable: executable }
      : { gameExecutable: executable }),
    inspectVersion: () => ({
      executable,
      version: "1.7.0.54",
      fileVersion: "1.7.0.54",
      discovery: "windows_file_metadata",
    }),
  });
}

describe("live observer acceptance support", () => {
  it("records boundary timing and count-only process snapshots without thresholds", async () => {
    let wallMs = Date.parse("2026-07-19T06:00:00.000Z");
    let monotonicMs = 500;
    let counts: AcceptanceSupervisedProcessCounts = { active: 0, reconciling: 0, total: 0 };
    const recorder = new OperationalBaselineRecorder({
      backend: "workbench",
      readSupervisedProcessCounts: () => counts,
      clock: {
        wallNow: () => new Date(wallMs),
        monotonicNow: () => monotonicMs,
      },
    });

    recorder.sampleProcessCounts("rest.beforeLaunch");
    const result = await recorder.measure(
      "launch",
      "WorkbenchClient.ensureRunning",
      async () => {
        wallMs += 1_250;
        monotonicMs += 1_250.375;
        counts = { active: 1, reconciling: 0, total: 1 };
        return "running";
      },
      "running_confirmation"
    );
    expect(result).toBe("running");
    await recorder.measure(
      "managed_call",
      "WorkbenchObserverAdapter.ping(EMCP_WB_Ping)",
      async () => {
        wallMs += 10;
        monotonicMs += 10;
        return { status: "ok" };
      },
      "representative_net_api"
    );
    await recorder.measure(
      "capture",
      "ObserverApplication.capture/jobStatus/readJob(initial-current)",
      async () => {
        wallMs += 100;
        monotonicMs += 100;
        return { artifactAvailable: true };
      },
      "initial-current"
    );
    await recorder.measure(
      "shutdown",
      "ObserverApplication.close",
      async () => {
        wallMs += 5;
        monotonicMs += 5;
      },
      "observer_cleanup"
    );
    await recorder.measure(
      "shutdown",
      "WorkbenchClient.shutdownOwnedWorkbench",
      async () => {
        wallMs += 50;
        monotonicMs += 50;
        counts = { active: 0, reconciling: 0, total: 0 };
        return { stopped: true };
      },
      "termination",
      (shutdown) => ({ stopped: shutdown.stopped })
    );
    await recorder.measure(
      "shutdown",
      "waitForOperationalBaselineProcessVacancy",
      async () => ({
        vacant: true,
        timeoutMs: 5_000,
        pollIntervalMs: 25,
        polls: 1,
        waitedMs: 0,
        counts,
      }),
      "supervised_exit_settle",
      (evidence) => ({
        vacant: evidence.vacant,
        polls: evidence.polls,
        waitedMs: evidence.waitedMs,
        finalActive: evidence.counts.active,
        finalReconciling: evidence.counts.reconciling,
        finalTotal: evidence.counts.total,
      })
    );
    recorder.sampleProcessCounts("rest.afterShutdown");
    wallMs += 250;
    monotonicMs += 250;
    const artifact = recorder.artifact({
      result: "passed",
      environment: testEnvironment("workbench"),
      workload: testWorkload("workbench"),
      source: {
        harness: { path: "scripts/run-workbench-observer-acceptance.ts", sha256: "a".repeat(64) },
        recorder: { path: "scripts/observer-live-acceptance-support.ts", sha256: "d".repeat(64) },
        measured: [{ path: "src/workbench/client.ts", sha256: "e".repeat(64) }],
      },
      limitations: ["Descriptive baseline only; no thresholds are applied."],
    });

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      kind: "reforger_forge_workbench_operational_baseline",
      backend: "workbench",
      result: "passed",
      thresholds: null,
    });
    expect(artifact.measurements[0]).toMatchObject({
      boundary: "launch",
      operation: "WorkbenchClient.ensureRunning",
      phase: "running_confirmation",
      durationMs: 1250.375,
      outcome: "passed",
      processCountBefore: { active: 0, reconciling: 0, total: 0 },
      processCountAfter: { active: 1, reconciling: 0, total: 1 },
    });
    expect(artifact.processCounts.map((sample) => sample.label)).toEqual([
      "rest.beforeLaunch",
      "launch.running_confirmation.WorkbenchClient.ensureRunning.before",
      "launch.running_confirmation.WorkbenchClient.ensureRunning.after",
      "managed_call.representative_net_api.WorkbenchObserverAdapter.ping(EMCP_WB_Ping).before",
      "managed_call.representative_net_api.WorkbenchObserverAdapter.ping(EMCP_WB_Ping).after",
      "capture.initial-current.ObserverApplication.capture/jobStatus/readJob(initial-current).before",
      "capture.initial-current.ObserverApplication.capture/jobStatus/readJob(initial-current).after",
      "shutdown.observer_cleanup.ObserverApplication.close.before",
      "shutdown.observer_cleanup.ObserverApplication.close.after",
      "shutdown.termination.WorkbenchClient.shutdownOwnedWorkbench.before",
      "shutdown.termination.WorkbenchClient.shutdownOwnedWorkbench.after",
      "shutdown.supervised_exit_settle.waitForOperationalBaselineProcessVacancy.before",
      "shutdown.supervised_exit_settle.waitForOperationalBaselineProcessVacancy.after",
      "rest.afterShutdown",
    ]);
    const { schemaVersion: _schema, kind: _kind, thresholds: _thresholds, ...rebuilt } = artifact;
    expect(() => buildOperationalBaselineArtifact({
      ...rebuilt,
      environment: { ...rebuilt.environment, workbench: null },
    })).toThrow(/Workbench Windows file metadata/);
    expect(() => buildOperationalBaselineArtifact({
      ...rebuilt,
      measurements: rebuilt.measurements.filter((item) => item.boundary !== "capture"),
    })).toThrow(/capture availability/);
    expect(() => buildOperationalBaselineArtifact({
      ...rebuilt,
      measurements: rebuilt.measurements.filter((item) =>
        item.operation !== "waitForOperationalBaselineProcessVacancy"),
    })).toThrow(/supervised exit-settle vacancy evidence/);
    const observerPingMeasurements = rebuilt.measurements.map((item) =>
      item.operation === "WorkbenchObserverAdapter.ping(EMCP_WB_Ping)"
        ? { ...item, operation: "WorkbenchObserverAdapter.ping(EMCP_WB_ObserverPing)" }
        : item);
    expect(() => buildOperationalBaselineArtifact({
      ...rebuilt,
      measurements: observerPingMeasurements,
    })).not.toThrow();
    expect(() => buildOperationalBaselineArtifact({
      ...rebuilt,
      measurements: observerPingMeasurements.map((item) =>
        item.operation === "WorkbenchObserverAdapter.ping(EMCP_WB_ObserverPing)"
          ? { ...item, operation: "WorkbenchObserverAdapter.ping(unknown)" }
          : item),
    })).toThrow(/lifecycle\/NET API evidence/);
  });

  it("waits deterministically for delayed supervised-process vacancy", async () => {
    let monotonicMs = 0;
    const observations: AcceptanceSupervisedProcessCounts[] = [
      { active: 1, reconciling: 1, total: 2 },
      { active: 0, reconciling: 1, total: 1 },
      { active: 0, reconciling: 0, total: 0 },
    ];
    let readIndex = 0;

    await expect(waitForOperationalBaselineProcessVacancy(
      () => observations[Math.min(readIndex++, observations.length - 1)],
      {
        timeoutMs: 50,
        pollIntervalMs: 10,
        monotonicNow: () => monotonicMs,
        wait: async (milliseconds) => {
          monotonicMs += milliseconds;
        },
      }
    )).resolves.toEqual({
      vacant: true,
      timeoutMs: 50,
      pollIntervalMs: 10,
      polls: 3,
      waitedMs: 20,
      counts: { active: 0, reconciling: 0, total: 0 },
    });
  });

  it("returns bounded nonzero count diagnostics when vacancy times out", async () => {
    let monotonicMs = 0;
    const counts = { active: 1, reconciling: 1, total: 2 };

    await expect(waitForOperationalBaselineProcessVacancy(
      () => counts,
      {
        timeoutMs: 25,
        pollIntervalMs: 10,
        monotonicNow: () => monotonicMs,
        wait: async (milliseconds) => {
          monotonicMs += milliseconds;
        },
      }
    )).resolves.toEqual({
      vacant: false,
      timeoutMs: 25,
      pollIntervalMs: 10,
      polls: 4,
      waitedMs: 25,
      counts,
    });
  });

  it("classifies failed measurements and rejects a passed artifact that contains one", async () => {
    let wallMs = Date.parse("2026-07-19T06:10:00.000Z");
    let monotonicMs = 10;
    const recorder = new OperationalBaselineRecorder({
      backend: "runtime",
      readSupervisedProcessCounts: () => ({ active: 0, reconciling: 0, total: 0 }),
      clock: {
        wallNow: () => new Date(wallMs),
        monotonicNow: () => monotonicMs,
      },
    });
    await expect(recorder.measure("managed_call", "OwnedRuntimeManager.status", async () => {
      wallMs += 5;
      monotonicMs += 5;
      throw new TypeError("fixture failure");
    })).rejects.toThrow("fixture failure");
    expect(recorder.artifact({
      result: "failed",
      environment: operationalBaselineEnvironment(),
      workload: testWorkload("runtime"),
      source: {
        harness: { path: "scripts/run-runtime-observer-acceptance.ts", sha256: "b".repeat(64) },
        recorder: { path: "scripts/observer-live-acceptance-support.ts", sha256: "d".repeat(64) },
        measured: [{ path: "src/observer/owned-runtime-manager.ts", sha256: "e".repeat(64) }],
      },
      limitations: [],
      failureName: "TypeError",
    })).toMatchObject({
      result: "failed",
      failure: { name: "TypeError" },
      measurements: [{ outcome: "failed", errorName: "TypeError" }],
    });
    expect(() => recorder.artifact({
      result: "passed",
      environment: operationalBaselineEnvironment(),
      workload: testWorkload("runtime"),
      source: {
        harness: { path: "scripts/run-runtime-observer-acceptance.ts", sha256: "b".repeat(64) },
        recorder: { path: "scripts/observer-live-acceptance-support.ts", sha256: "d".repeat(64) },
        measured: [{ path: "src/observer/owned-runtime-manager.ts", sha256: "e".repeat(64) }],
      },
      limitations: [],
    })).toThrow(/passed operational baseline/);
  });

  it("requires distinct durable termination and observer-cleanup evidence for a passed runtime baseline", () => {
    const zero = { active: 0, reconciling: 0, total: 0 };
    const measurement = (
      boundary: "launch" | "managed_call" | "capture" | "shutdown",
      operation: string,
      phase: string,
      observations?: Record<string, string | number | boolean | null>
    ) => ({
      boundary,
      operation,
      phase,
      startedAt: "2026-07-19T06:20:00.000Z",
      finishedAt: "2026-07-19T06:20:00.001Z",
      durationMs: 1,
      outcome: "passed" as const,
      processCountBefore: zero,
      processCountAfter: zero,
      ...(observations ? { observations } : {}),
    });
    const input = {
      backend: "runtime" as const,
      result: "passed" as const,
      startedAt: "2026-07-19T06:20:00.000Z",
      finishedAt: "2026-07-19T06:20:01.000Z",
      durationMs: 1_000,
      environment: testEnvironment("runtime"),
      workload: testWorkload("runtime"),
      source: {
        harness: { path: "scripts/run-runtime-observer-acceptance.ts", sha256: "a".repeat(64) },
        recorder: { path: "scripts/observer-live-acceptance-support.ts", sha256: "b".repeat(64) },
        measured: [
          { path: "src/observer/application.ts", sha256: "c".repeat(64) },
          { path: "src/observer/owned-runtime-manager.ts", sha256: "d".repeat(64) },
        ],
      },
      measurements: [
        measurement("launch", "OwnedRuntimeManager.start/status(running)", "running_confirmation"),
        measurement("managed_call", "OwnedRuntimeManager.status", "representative_status_api"),
        measurement("capture", "ObserverApplication.capture(initial-current)", "initial-current"),
        measurement("shutdown", "OwnedRuntimeManager.stop", "termination", {
          terminationComplete: true,
          identityVacant: true,
        }),
        measurement("shutdown", "OwnedRuntimeManager.stop", "observer_cleanup", {
          observerCleanupPending: false,
        }),
        measurement("shutdown", "ObserverApplication.close", "observer_cleanup"),
        measurement(
          "shutdown",
          "waitForOperationalBaselineProcessVacancy",
          "supervised_exit_settle",
          { vacant: true, finalTotal: 0 }
        ),
      ],
      processCounts: [
        { label: "rest.beforeLaunch", at: "2026-07-19T06:20:00.000Z", ...zero },
        { label: "rest.afterShutdown", at: "2026-07-19T06:20:01.000Z", ...zero },
      ],
      limitations: [],
      failure: null,
    };

    const artifact = buildOperationalBaselineArtifact(input);
    expect(artifact.measurements.filter((item) =>
      item.operation === "OwnedRuntimeManager.stop").map((item) => item.phase)).toEqual([
      "termination",
      "observer_cleanup",
    ]);
    expect(() => buildOperationalBaselineArtifact({
      ...input,
      workload: { ...input.workload, runtimeKind: "client" },
    })).not.toThrow();
    expect(() => buildOperationalBaselineArtifact({
      ...input,
      measurements: input.measurements.filter((item) =>
        item.operation !== "OwnedRuntimeManager.stop" || item.phase !== "observer_cleanup"),
    })).toThrow(/lifecycle\/cleanup evidence/);
    expect(() => buildOperationalBaselineArtifact({
      ...input,
      measurements: input.measurements.map((item) => item.phase === "supervised_exit_settle"
        ? { ...item, observations: { vacant: true, finalTotal: 1 } }
        : item),
    })).toThrow(/supervised exit-settle vacancy evidence/);
    expect(() => buildOperationalBaselineArtifact({
      ...input,
      processCounts: [
        input.processCounts[0],
        { ...input.processCounts[1], active: 1, total: 1 },
      ],
    })).toThrow(/zero supervised processes/);
    expect(() => buildOperationalBaselineArtifact({
      ...input,
      environment: {
        ...input.environment,
        game: {
          executable: "ArmaReforgerSteamDiag.exe",
          version: null,
          fileVersion: null,
          discovery: "unavailable" as const,
        },
      },
    })).toThrow(/game Windows file metadata/);
  });

  it("keeps executable metadata path-free and rejects absolute harness identities", () => {
    const secretRoot = "C:\\Users\\private-user\\Steam\\Arma Reforger";
    const environment = operationalBaselineEnvironment({
      gameExecutable: `${secretRoot}\\ArmaReforgerSteamDiag.exe`,
      inspectVersion: () => ({
        executable: "ArmaReforgerSteamDiag.exe",
        version: "1.7.0.54",
        fileVersion: "1.7.0.54",
        discovery: "windows_file_metadata",
      }),
    });
    expect(environment.game).toMatchObject({
      executable: "ArmaReforgerSteamDiag.exe",
      version: "1.7.0.54",
    });
    expect(JSON.stringify(environment)).not.toContain("private-user");
    expect(environment).not.toHaveProperty("hostname");

    expect(() => buildOperationalBaselineArtifact({
      backend: "runtime",
      result: "passed",
      startedAt: "2026-07-19T06:00:00.000Z",
      finishedAt: "2026-07-19T06:00:01.000Z",
      durationMs: 1_000,
      environment,
      workload: testWorkload("runtime"),
      source: {
        harness: { path: `${secretRoot}\\harness.ts`, sha256: "c".repeat(64) },
        recorder: { path: "scripts/observer-live-acceptance-support.ts", sha256: "d".repeat(64) },
        measured: [{ path: "src/observer/owned-runtime-manager.ts", sha256: "e".repeat(64) }],
      },
      measurements: [],
      processCounts: [],
      limitations: [],
      failure: null,
    })).toThrow(/source identity/);
  });

  it("canonicalizes measured source hashes and rejects absolute, duplicate, or unsorted identities", () => {
    const testPath = fileURLToPath(import.meta.url);
    const repositoryRoot = resolve(dirname(testPath), "..", "..");
    const source = operationalBaselineSource(
      testPath,
      "tests/workbench/observer-live-acceptance-support.test.ts",
      repositoryRoot,
      ["src/workbench/client.ts", "src/observer/application.ts"],
      [{ path: "scripts/windows/**/*.ps1", directory: "scripts/windows", extension: ".ps1" }]
    );
    expect(source.measured.map((item) => item.path)).toEqual([
      "scripts/windows/**/*.ps1",
      "src/observer/application.ts",
      "src/workbench/client.ts",
    ]);
    expect(source.measured[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const base = {
      backend: "runtime" as const,
      result: "failed" as const,
      startedAt: "2026-07-19T06:30:00.000Z",
      finishedAt: "2026-07-19T06:30:01.000Z",
      durationMs: 1_000,
      environment: operationalBaselineEnvironment(),
      workload: testWorkload("runtime"),
      source,
      measurements: [],
      processCounts: [],
      limitations: [],
      failure: { name: "FixtureFailure" },
    };
    expect(() => buildOperationalBaselineArtifact({
      ...base,
      source: {
        ...source,
        measured: [{ path: "C:\\private\\application.ts", sha256: "a".repeat(64) }],
      },
    })).toThrow(/source identity/);
    expect(() => buildOperationalBaselineArtifact({
      ...base,
      source: {
        ...source,
        measured: [
          { path: "src/observer/application.ts", sha256: "a".repeat(64) },
          { path: "src/observer/application.ts", sha256: "b".repeat(64) },
        ],
      },
    })).toThrow(/duplicate path/);
    expect(() => buildOperationalBaselineArtifact({
      ...base,
      source: {
        ...source,
        measured: [...source.measured].reverse(),
      },
    })).toThrow(/canonical path order/);
  });

  it("keeps workload identity path-free, canonical, and schema-closed", () => {
    const world = "{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent";
    const first = operationalBaselineLaunchArgumentIdentity([
      "-addonsDir",
      "C:\\Users\\private-user\\fixture",
      "-reforgerForgeOwnerToken=first-secret",
      "-server",
      world,
    ]);
    const second = operationalBaselineLaunchArgumentIdentity([
      "-addonsDir",
      "D:\\different-machine\\fixture",
      "-reforgerForgeOwnerToken=second-secret",
      "-server",
      world,
    ]);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/private-user|first-secret|different-machine|second-secret/);
    expect(operationalBaselineLaunchArgumentIdentity([
      "-addonsDir", "D:\\different-machine\\fixture", "-server", "different-world",
    ]).sha256).not.toBe(first.sha256);
    const oneAddonRoot = operationalBaselineLaunchArgumentIdentity([
      "-addonsDir", "C:\\Users\\private-user\\addons",
    ]);
    const twoAddonRoots = operationalBaselineLaunchArgumentIdentity([
      "-addonsDir", "C:\\Users\\private-user\\addons,D:\\private\\more-addons",
    ]);
    expect(twoAddonRoots.count).toBe(oneAddonRoot.count);
    expect(twoAddonRoots.sha256).not.toBe(oneAddonRoot.sha256);
    expect(JSON.stringify(twoAddonRoots)).not.toMatch(/private-user|more-addons/);
    expect(operationalBaselineProcedureSha256({ pose: [1, 2, 3], policy: "evidence" }))
      .toBe(operationalBaselineProcedureSha256({ policy: "evidence", pose: [1, 2, 3] }));

    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const fixtureIdentity = operationalBaselineDirectoryIdentity(
      resolve(repositoryRoot, "scripts", "windows"),
      [".ps1"]
    );
    expect(fixtureIdentity).toMatchObject({ fileCount: 2 });
    expect(fixtureIdentity.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixtureIdentity).not.toHaveProperty("path");

    const base = {
      backend: "runtime" as const,
      result: "failed" as const,
      startedAt: "2026-07-19T06:40:00.000Z",
      finishedAt: "2026-07-19T06:40:01.000Z",
      durationMs: 1_000,
      environment: operationalBaselineEnvironment(),
      workload: testWorkload("runtime"),
      source: {
        harness: { path: "scripts/run-runtime-observer-acceptance.ts", sha256: "a".repeat(64) },
        recorder: { path: "scripts/observer-live-acceptance-support.ts", sha256: "b".repeat(64) },
        measured: [{ path: "src/**/*.ts", sha256: "c".repeat(64) }],
      },
      measurements: [],
      processCounts: [],
      limitations: [],
      failure: { name: "FixtureFailure" },
    };
    expect(() => buildOperationalBaselineArtifact({
      ...base,
      workload: { ...base.workload, privatePath: "C:\\Users\\private-user" } as typeof base.workload,
    })).toThrow(/unexpected or missing fields/);
    expect(() => buildOperationalBaselineArtifact({
      ...base,
      workload: { ...base.workload, worldResource: "C:\\private\\world.ent" },
    })).toThrow(/workload identity/);
  });

  it("filters and sorts only relevant engine/editor processes", () => {
    expect(findBlockingProcesses([
      { Id: "52", ProcessName: "ArmaReforgerWorkbench" },
      { Id: 8, ProcessName: "node" },
      { Id: 11, ProcessName: "ArmaReforgerSteamDiag" },
      { Id: -1, ProcessName: "ArmaReforger" },
    ])).toEqual([
      { id: 11, processName: "ArmaReforgerSteamDiag" },
      { id: 52, processName: "ArmaReforgerWorkbench" },
    ]);
  });

  it("independently validates screenshot structure and material variation", () => {
    const blank = analyzePngMaterial(rgbPng(false));
    expect(blank).toMatchObject({
      width: 64,
      height: 64,
      channels: 3,
      materiallyVaried: false,
      quantizedColorCount: 1,
    });

    const variedPng = rgbPng(true);
    const varied = analyzePngMaterial(variedPng);
    expect(varied.materiallyVaried).toBe(true);
    expect(varied.sha256).toBe(createHash("sha256").update(variedPng).digest("hex"));
    expect(varied.quantizedColorCount).toBeGreaterThanOrEqual(16);
  });

  it("rejects a PNG whose chunk CRC is corrupted", () => {
    const corrupted = Buffer.from(rgbPng(true));
    corrupted[corrupted.length - 5] ^= 0xff;
    expect(() => analyzePngMaterial(corrupted)).toThrow(/CRC is invalid/);
  });

  it("decodes screenshot pixels once for shared acceptance oracles", () => {
    const png = pixelPng(64, 64, 4, (x, y) => [x, y, x + y, 200]);
    const decoded = decodePng(png);
    expect(decoded).toMatchObject({
      width: 64,
      height: 64,
      channels: 4,
      sourceByteCount: png.length,
      sourceSha256: createHash("sha256").update(png).digest("hex"),
    });
    expect([...decoded.pixels.subarray(0, 8)]).toEqual([0, 0, 0, 200, 1, 0, 1, 200]);
  });

  it("distinguishes similar, materially changed, and out-of-ROI screenshots", () => {
    const baseline = pixelPng(64, 64, 3, gradientPixel);
    const quietNoise = pixelPng(64, 64, 3, (x, y) => gradientPixel(x, y).map(
      (channel) => Math.min(255, channel + 1)
    ));
    const displaced = pixelPng(64, 64, 3, (x, y) =>
      x >= 16 && x < 48 && y >= 16 && y < 48 ? [255, 0, 0] : gradientPixel(x, y)
    );

    expect(comparePngImages(baseline, quietNoise)).toMatchObject({
      materiallyDifferent: false,
      materiallySimilar: true,
      changedPixels: 0,
    });

    const fullFrame = comparePngImages(baseline, displaced);
    expect(fullFrame.materiallyDifferent).toBe(true);
    expect(fullFrame.materiallySimilar).toBe(false);
    expect(fullFrame.changedPixelRatio).toBeGreaterThan(0.24);
    expect(fullFrame.maximumChannelDifference).toBeGreaterThan(200);

    const unchangedLeftEdge = comparePngImages(baseline, displaced, {
      roi: { x: 0, y: 0, width: 0.25, height: 1 },
    });
    expect(unchangedLeftEdge).toMatchObject({
      comparedPixels: 1_024,
      changedPixels: 0,
      materiallyDifferent: false,
      materiallySimilar: true,
    });

    const changedCenter = compareDecodedPng(decodePng(baseline), decodePng(displaced), {
      roi: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    });
    expect(changedCenter.pixelRegion).toEqual({ x: 16, y: 16, width: 32, height: 32 });
    expect(changedCenter.materiallyDifferent).toBe(true);
    expect(changedCenter.changedPixelRatio).toBeGreaterThan(0.99);
  });

  it("rejects comparisons with incompatible dimensions or invalid normalized regions", () => {
    const square = decodePng(pixelPng(64, 64, 3, gradientPixel));
    const wide = decodePng(pixelPng(65, 64, 3, gradientPixel));
    expect(() => compareDecodedPng(square, wide)).toThrow(/dimensions differ/);
    expect(() => compareDecodedPng(square, square, {
      roi: { x: 0.8, y: 0, width: 0.3, height: 1 },
    })).toThrow(/fit within/);
  });

  it("detects a tolerant color marker only inside the requested ROI", () => {
    const png = pixelPng(64, 64, 4, (x, y) => {
      if (x >= 40 && x < 48 && y >= 8 && y < 16) return [250, 5, 5, 255];
      // A transparent target-colored block must not satisfy the marker oracle.
      if (x >= 8 && x < 16 && y >= 8 && y < 16) return [250, 5, 5, 0];
      return [10, 20, 30, 255];
    });
    const screenshot = decodePng(png);

    const marker = detectPngColorMarker(png, {
      color: [245, 10, 10],
      channelTolerance: 6,
      minimumMatchingPixels: 32,
      minimumMatchRatio: 0.01,
      roi: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
    });
    expect(marker).toEqual({
      detected: true,
      inspectedPixels: 1_024,
      matchingPixels: 64,
      matchingPixelRatio: 0.0625,
      pixelBounds: { x: 40, y: 8, width: 8, height: 8 },
      normalizedCentroid: [0.6875, 0.1875],
    });

    expect(detectColorMarker(screenshot, {
      color: [245, 10, 10],
      channelTolerance: 6,
      roi: { x: 0, y: 0, width: 0.5, height: 0.5 },
    })).toMatchObject({
      detected: false,
      matchingPixels: 0,
      pixelBounds: null,
      normalizedCentroid: null,
    });
  });
});
