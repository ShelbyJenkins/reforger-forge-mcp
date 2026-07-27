import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupOwnedRuntimeManagerFixtures,
  listRecordIds,
  makeHarness,
  readRecord,
  recordByteLength,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("descriptor persistence and capacity budgets", () => {
  it("persists the maximum normalized descriptor produced from 512 launch tokens", async () => {
    const value = makeHarness();
    const normalizedArguments = Array.from({ length: 520 }, (_, index) => `-fixture-${index}`);

    const started = await value.start("max-normalized-arguments", normalizedArguments);

    expect(started.state).toBe("running");
    expect(value.spawnCalls[0].arguments.slice(0, -1)).toEqual(normalizedArguments);
  });

  it("reopens a command-line-boundary payload without poisoning later preparation", async () => {
    const value = makeHarness();
    const windowsCommandLineMaxUtf16Units = 32_767;
    const prepared = await value.prepare(["x".repeat(windowsCommandLineMaxUtf16Units)]);
    expect(recordByteLength(value.manager, "prepared", prepared.id)).toBeGreaterThan(windowsCommandLineMaxUtf16Units);
    await expect(value.startPrepared(prepared.id, "boundary-payload"))
      .rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });
    const later = await value.prepare(["-later"]);
    expect(later.id).not.toBe(prepared.id);
  });

  it("round-trips the maximum-escape launch-boundary aggregate at every descriptor bound", async () => {
    const windowsCommandLineMaxUtf16Units = 32_767;
    const normalizedArgumentMaxCount = 520;
    const worstCaseEscapedUnit = "\u0001";
    const unitsPerArgument = Math.floor(
      windowsCommandLineMaxUtf16Units / normalizedArgumentMaxCount
    );
    const remainder = windowsCommandLineMaxUtf16Units % normalizedArgumentMaxCount;
    const argumentsArray = Array.from(
      { length: normalizedArgumentMaxCount },
      (_, index) => worstCaseEscapedUnit.repeat(unitsPerArgument + (index < remainder ? 1 : 0))
    );
    const value = makeHarness({
      preparedProfilePath: worstCaseEscapedUnit.repeat(32_768),
      preparedSessionId: worstCaseEscapedUnit.repeat(96),
    });

    const prepared = await value.prepare(argumentsArray, "maximum-escape-descriptor");
    expect(recordByteLength(value.manager, "prepared", prepared.id)).toBeGreaterThan(390_000);

    // Reusing the exact session takes the indexed replay path, which reopens,
    // parses, and fingerprints the bounded descriptor before returning its id.
    const replay = await value.prepare(argumentsArray, "maximum-escape-descriptor");
    expect(replay.id).toBe(prepared.id);
  });

  it("applies the derived prepared-descriptor bound before publishing either record", async () => {
    const value = makeHarness();
    const windowsCommandLineMaxUtf16Units = 32_767;
    const jsonWorstCaseBoundaryToken = "\0".repeat(windowsCommandLineMaxUtf16Units);

    await expect(value.prepare(Array.from({ length: 3 }, () => jsonWorstCaseBoundaryToken)))
      .rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(listRecordIds(value.manager, "prepared")).toEqual([]);
    expect(listRecordIds(value.manager, "prepared-index")).toEqual([]);
    await expect(value.prepare(["-later"])).resolves.toBeDefined();
  });

  it("uses a direct session index and isolates an unrelated corrupt prepared descriptor", async () => {
    const value = makeHarness();
    const first = await value.prepare(["-indexed"]);
    writeRecord(value.manager, "prepared", "pl-ffffffff-ffff-4fff-8fff-ffffffffffff", "{\n");

    const replay = await value.manager.recordPreparedLaunch({
      runtimeKind: "listenServer",
      arguments: ["-indexed"],
      profilePath: first.prepared.profilePath,
      sessionTtlMs: 60_000,
      transportPreference: ["rest", "mailbox"],
      forceUpdate: false,
      noFocus: false,
    }, {
      arguments: ["-indexed"],
      sessionId: first.prepared.sessionId,
      expiresAt: first.prepared.expiresAt,
      bundleDigest: first.prepared.bundleDigest,
      profilePath: first.prepared.profilePath,
      warnings: [],
    });
    const later = await value.prepare(["-later"]);

    expect(replay).toBe(first.id);
    expect(later.id).not.toBe(first.id);
    expect(listRecordIds(value.manager, "prepared-index")).toHaveLength(2);
  });

  it("enforces per-record, aggregate-byte, and record-count budgets with diagnostics", async () => {
    const perRecord = makeHarness({ maxRecordBytes: 1_024, maxStoreBytes: 4_096 });
    await expect(perRecord.prepare(["x".repeat(2_000)]))
      .rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(perRecord.manager.diagnosticStorageStats()).toMatchObject({ records: 0, maxRecordBytes: 1_024 });

    const aggregate = makeHarness({ maxRecordBytes: 4_096, maxStoreBytes: 4_096 });
    await expect(aggregate.prepare(["x".repeat(1_400)])).resolves.toBeDefined();
    await expect(aggregate.prepare(["y".repeat(1_400)]))
      .rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(aggregate.manager.diagnosticStorageStats().bytes).toBeLessThanOrEqual(4_096);

    const countBound = makeHarness({ maxStoreRecords: 8 });
    for (let index = 0; index < 8; index += 1) {
      writeRecord(countBound.manager, "prepared", `forensic-${index}`, "{}\n");
    }
    await expect(countBound.prepare()).rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(countBound.manager.diagnosticStorageStats()).toMatchObject({ records: 8, maxRecords: 8 });
  });

  it("reserves the complete recovery lifecycle before spawn at a tight record bound", async () => {
    const insufficient = makeHarness({ maxStoreRecords: 8 });
    await expect(insufficient.start("tight-start"))
      .rejects.toMatchObject({ code: "STORE_CAPACITY_EXCEEDED" });
    expect(insufficient.spawnCalls).toEqual([]);
    expect(listRecordIds(insufficient.manager, "consumed")).toEqual([]);
    expect(listRecordIds(insufficient.manager, "pending-starts")).toEqual([]);
    expect(listRecordIds(insufficient.manager, "idempotency")).toEqual([]);

    // This case exercises storage reservation, not deadline handling. Leave
    // enough wall-clock headroom for filesystem syncs when the full suite is
    // running in parallel on a loaded Windows host.
    const sufficient = makeHarness({ maxStoreRecords: 11, terminationTimeoutMs: 5_000 });
    const started = await sufficient.start("reserved-start");
    // At the exact 6-record + 5-record recovery bound, best-effort receipt
    // replacements must not borrow the fsynced temporary-file slot. A crash
    // could otherwise consume mandatory recovery headroom for the retention
    // window.
    const tightStartAttempt = readRecord(
      sufficient.manager,
      "idempotency",
      `start-${createHash("sha256").update("reserved-start").digest("hex")}`
    );
    expect(tightStartAttempt.state).toBe("starting");
    expect(sufficient.manager.diagnosticStorageStats()).toMatchObject({
      records: 6,
      reservedMutationRecords: 5,
    });
    await expect(sufficient.stop(started.runtimeId, "reserved-stop"))
      .resolves.toMatchObject({ terminationComplete: true, observerCleanupPending: false });
    const stats = sufficient.manager.diagnosticStorageStats();
    expect(stats.records).toBeLessThanOrEqual(11);
    expect(stats.reservedMutationRecords).toBe(0);
  });

  });
});
