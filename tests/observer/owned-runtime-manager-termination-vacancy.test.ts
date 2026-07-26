import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX } from "../../src/observer/owned-runtime-manager.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  createLeaseLosingBackend,
  listRecordIds,
  makeHarness,
  recordExists,
  runtimeStopPreflight,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("termination and vacancy", () => {
  it("distinguishes running, stale, exited, identity mismatch, and unverifiable states", async () => {
    const value = makeHarness();
    const prepared = await value.prepare();
    const started = await value.startPrepared(prepared.id, "states");
    expect((await value.manager.status(started.runtimeId)).state).toBe("running");

    value.setClock(Date.parse(prepared.prepared.expiresAt) + 1);
    expect((await value.manager.status(started.runtimeId)).state).toBe("stale");
    value.setClock(Date.parse(prepared.prepared.expiresAt) - 1);

    const process = value.backend.processes.get(started.pid)!;
    process.identity.creationTime = "999999";
    expect((await value.manager.status(started.runtimeId)).state).toBe("identity_mismatch");
    process.identity.creationTime = String(800000 + started.pid);
    process.ownerArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}changed`;
    expect((await value.manager.status(started.runtimeId)).state).toBe("identity_mismatch");
    process.ownerArgument = value.spawnCalls[0].arguments.at(-1)!;

    value.backend.inspectFailure = new Error("native inspection unavailable");
    expect((await value.manager.status(started.runtimeId)).state).toBe("unverifiable");
    value.backend.inspectFailure = null;
    value.backend.processes.delete(started.pid);
    expect((await value.manager.status(started.runtimeId)).state).toBe("exited");
    expect(recordExists(value.manager, "child-exits", started.runtimeId)).toBe(true);
    expect(value.gate.releasedLifecycles.at(-1)).toMatchObject({ runtimeId: started.runtimeId });
  });

  it("fails closed on configured executable path drift", async () => {
    const value = makeHarness();
    const started = await value.start("path-drift");
    const replacement = join(value.root, "ArmaReforgerSteam.exe");
    writeFileSync(replacement, "replacement");
    value.setExecutable(replacement);
    expect(await value.manager.status(started.runtimeId)).toMatchObject({
      state: "identity_mismatch",
      exactOwned: false,
    });
    await expect(value.stop(started.runtimeId, "path-drift-stop"))
      .rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.terminateCalls).toHaveLength(0);
  });

  it("refuses while a camera lease is active, then stops only the exact process after restoration", async () => {
    const value = makeHarness();
    const started = await value.start("camera-start");
    value.backend.processes.set(9999, {
      identity: { pid: 9999, executablePath: value.executable, creationTime: "123456" },
      ownerArgument: `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}unrelated`,
    });
    value.gate.preflights.push(runtimeStopPreflight({
      ready: false, reserved: false,
      activeJobIds: ["job-camera"],
      cameraLeaseJobIds: ["job-camera"],
      restorationPendingJobIds: ["job-camera"],
    }));
    await expect(value.stop(started.runtimeId, "camera-stop"))
      .rejects.toMatchObject({ code: "CAMERA_BUSY" });
    expect(value.backend.processes.has(started.pid)).toBe(true);
    expect(value.backend.terminateCalls).toHaveLength(0);
    value.gate.preflights.push(runtimeStopPreflight({
      ready: false, reserved: false,
      activeJobIds: ["job-camera"],
      cameraLeaseJobIds: ["job-camera"],
      restorationPendingJobIds: ["job-camera"],
    }));
    await expect(value.stop(started.runtimeId, "camera-stop-other"))
      .rejects.toMatchObject({ code: "CAMERA_BUSY" });
    expect(listRecordIds(value.manager, "idempotency")
      .filter((id) => id.startsWith("stop-"))).toEqual([]);

    const stopped = await value.stop(started.runtimeId, "camera-stop");
    expect(stopped).toMatchObject({ state: "exited", termination: "terminated", identityVacant: true });
    expect(value.backend.terminateCalls).toHaveLength(1);
    expect(value.backend.terminateCalls[0]).toMatchObject({ pid: started.pid });
    expect(value.backend.processes.has(9999)).toBe(true);
    expect(value.gate.completed).toEqual([started.sessionId]);
    const replay = await value.stop(started.runtimeId, "camera-stop");
    expect(replay).toMatchObject({ identityVacant: true, termination: "terminated" });
    expect(value.backend.terminateCalls).toHaveLength(1);
  });

  it("never reports stop success when a termination backend claims success but the exact process survives", async () => {
    const value = makeHarness();
    const started = await value.start("surviving-exact-process-start");
    value.backend.terminationResult = { kind: "terminated" };

    await expect(value.stop(started.runtimeId, "surviving-exact-process-stop"))
      .rejects.toMatchObject({
        code: "RECOVERY_REQUIRED",
        details: {
          runtimeId: started.runtimeId,
          state: "stopping",
        },
      });
    expect(value.backend.processes.has(started.pid)).toBe(true);
    expect(value.backend.terminateCalls).toHaveLength(1);
    expect(recordExists(value.manager, "stops", started.runtimeId)).toBe(false);
    await expect(value.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "stopping",
      terminationComplete: false,
      observerCleanupPending: false,
    });
  });

  it("does not publish vacancy after losing the mutex lease during exact termination", async () => {
    const backend = createLeaseLosingBackend();
    const value = makeHarness({ backend });
    const started = await value.start("lease-loss-stop-start", [], "lease-loss-stop-prepare");
    backend.loseAfterTermination = true;

    await expect(value.stop(started.runtimeId, "lease-loss-stop"))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(backend.terminateCalls).toHaveLength(1);
    expect(recordExists(value.manager, "stops", started.runtimeId)).toBe(false);
    await expect(value.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "stopping",
      terminationComplete: false,
    });

    await expect(value.stop(started.runtimeId, "lease-loss-stop")).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
  });

  });
});
