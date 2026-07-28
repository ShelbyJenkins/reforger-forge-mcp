import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedRuntimeManager } from "../../src/observer/owned-runtime-manager.js";
import {
  FakeGate,
  cleanupOwnedRuntimeManagerFixtures,
  createFakeBackend,
  listRecordIds,
  makeHarness,
  openManagers,
  readRecord,
  recordExists,
  roots,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("failure evidence, recovery authority, and trust boundaries", () => {
  it("rejects expired and overlong managed starts before consumption or spawn", async () => {
    const expired = makeHarness();
    const prepared = await expired.prepare();
    expired.setClock(Date.parse(prepared.prepared.expiresAt));
    await expect(expired.startPrepared(prepared.id, "expired-start"))
      .rejects.toMatchObject({ code: "PREPARED_LAUNCH_EXPIRED" });
    expect(listRecordIds(expired.manager, "consumed")).toEqual([]);
    expect(expired.spawnCalls).toEqual([]);

    const oversized = makeHarness();
    const tooLong = await oversized.prepare(["x".repeat(32_760)]);
    await expect(oversized.startPrepared(tooLong.id, "oversized-start"))
      .rejects.toMatchObject({ code: "ARGUMENT_CONFLICT" });
    expect(listRecordIds(oversized.manager, "consumed")).toEqual([]);
    expect(oversized.spawnCalls).toEqual([]);

    const oversizedProfile = makeHarness();
    const profilePath = "p".repeat(32_769);
    await expect(oversizedProfile.manager.recordPreparedLaunch({
      runtimeKind: "listenServer",
      arguments: ["-window"],
      profilePath,
      sessionTtlMs: 60_000,
      transportPreference: ["rest", "mailbox"],
      forceUpdate: false,
      noFocus: false,
    }, {
      arguments: ["-window"],
      sessionId: "session-oversized-profile",
      expiresAt: new Date("2026-07-18T12:01:00.000Z").toISOString(),
      bundleDigest: "a".repeat(64),
      profilePath,
      warnings: [],
    })).rejects.toMatchObject({ code: "PREPARE_FAILED" });
    expect(oversizedProfile.spawnCalls).toEqual([]);
  });

  it("keeps durable non-success evidence when retained-child cleanup cannot be proved", async () => {
    const value = makeHarness({ spawnFailure: true, refuseKill: true });
    const prepared = await value.prepare();
    await expect(value.startPrepared(prepared.id, "stubborn-start"))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });
    expect(listRecordIds(value.manager, "runtimes")).toEqual([]);
    const pendingId = listRecordIds(value.manager, "pending-starts")[0];
    const pending = readRecord(value.manager, "pending-starts", pendingId);
    expect(pending).toMatchObject({ state: "cleanup_required", preparedLaunchId: prepared.id });
    await expect(value.startPrepared(prepared.id, "stubborn-start"))
      .rejects.toMatchObject({ code: "START_UNVERIFIABLE", details: { state: "cleanup_required" } });
  });

  it("fails closed when the executable is replaced in place after start", async () => {
    const value = makeHarness();
    const started = await value.start("replace-start");
    writeFileSync(value.executable, "different executable bytes");

    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "identity_mismatch",
      exactOwned: false,
      reason: expect.stringMatching(/replaced/),
    });
    await expect(value.stop(started.runtimeId, "replace-stop"))
      .rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.terminateCalls).toEqual([]);
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it("persists restoration authority before native termination and retries session completion", async () => {
    const value = makeHarness();
    const started = await value.start("proof-start");
    value.backend.beforeTerminate = () => {
      const proof = readRecord(value.manager, "restoration-proofs", started.runtimeId);
      expect(proof).toMatchObject({
        runtimeId: started.runtimeId,
        sessionId: started.sessionId,
        kind: "live_stop_reservation",
      });
    };
    value.gate.completeFailures = 1;
    await expect(value.stop(started.runtimeId, "proof-stop"))
      .rejects.toMatchObject({ code: "SESSION_COMPLETION_FAILED" });
    expect(value.backend.processes.has(started.pid)).toBe(false);
    expect(value.backend.terminateCalls).toHaveLength(1);
    expect(recordExists(value.manager, "stops", started.runtimeId)).toBe(true);
    expect(recordExists(value.manager, "stop-completions", started.runtimeId)).toBe(false);
    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "stopping",
      exactOwned: true,
      identityVacant: true,
      terminationComplete: true,
      observerCleanupPending: true,
    });

    // Simulate a legacy/racing tokenless vacancy receipt. The durable proof
    // remains the completion authority and must converge the observer lease.
    const proof = readRecord(value.manager, "restoration-proofs", started.runtimeId);
    const tokenlessStop = readRecord(value.manager, "stops", started.runtimeId);
    delete tokenlessStop.restorationReservationId;
    writeRecord(value.manager, "stops", started.runtimeId, JSON.stringify(tokenlessStop));

    const replay = await value.stop(started.runtimeId, "proof-stop");
    expect(replay).toMatchObject({
      state: "exited",
      identityVacant: true,
      terminationComplete: true,
      observerCleanupPending: false,
    });
    expect(value.backend.terminateCalls).toHaveLength(1);
    expect(value.gate.completedReservations).toEqual([proof.reservationId]);
    const stopped = readRecord(value.manager, "stops", started.runtimeId);
    expect(stopped).toMatchObject({
      sessionId: started.sessionId,
      restorationProofKind: "live_stop_reservation",
      identityVacant: true,
    });
  });

  it("retains the restoration seal when native termination may have occurred before an error", async () => {
    const value = makeHarness();
    const started = await value.start("late-error-start");
    value.backend.verifyAndTerminate = vi.fn(async () => {
      value.backend.processes.delete(started.pid);
      throw new Error("fixture helper disconnected after signalling");
    });

    await expect(value.stop(started.runtimeId, "late-error-stop"))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(recordExists(value.manager, "restoration-proofs", started.runtimeId)).toBe(true);
    expect(value.gate.released).toEqual([]);
    expect(recordExists(value.manager, "stops", started.runtimeId)).toBe(false);
    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "stopping",
      terminationComplete: false,
      observerCleanupPending: false,
    });
  });

  it("refuses recovery under a different installation or Windows owner", async () => {
    const value = makeHarness();
    const started = await value.start("owner-recovery-start");
    const otherInstall = join(value.root, "other-install");
    mkdirSync(otherInstall);
    const differentInstall = new OwnedRuntimeManager({
      managedRoot: value.root,
      gamePath: value.root,
      observerGate: new FakeGate(),
      backend: value.backend,
      executableResolver: () => value.executable,
      installationRoot: otherInstall,
    });
    openManagers.push(differentInstall);
    expect(await differentInstall.status(started.runtimeId)).toMatchObject({ state: "unverifiable", exactOwned: false });

    value.backend.currentUserSid = "S-1-5-21-different-owner";
    const differentOwner = new OwnedRuntimeManager({
      managedRoot: value.root,
      gamePath: value.root,
      observerGate: new FakeGate(),
      backend: value.backend,
      executableResolver: () => value.executable,
      installationRoot: process.cwd(),
    });
    openManagers.push(differentOwner);
    expect(await differentOwner.status(started.runtimeId)).toMatchObject({ state: "unverifiable", exactOwned: false });
  });

  it("rejects a linked managed root before creating lifecycle directories in the project", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-owned-runtime-link-"));
    roots.push(root);
    const project = join(root, "project");
    const outside = join(root, "outside");
    const linkedManagedRoot = join(outside, "managed");
    mkdirSync(project);
    mkdirSync(outside);
    symlinkSync(project, linkedManagedRoot, "junction");

    expect(() => new OwnedRuntimeManager({
      managedRoot: linkedManagedRoot,
      gamePath: root,
      observerGate: new FakeGate(),
      backend: createFakeBackend(),
      executableResolver: () => join(root, "unused.exe"),
      installationRoot: process.cwd(),
    })).toThrowError(expect.objectContaining({ code: "STORAGE_UNVERIFIABLE" }));
    expect(existsSync(join(project, "state"))).toBe(false);
  });

  });
});
