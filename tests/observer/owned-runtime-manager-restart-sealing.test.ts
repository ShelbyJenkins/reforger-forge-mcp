import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX } from "../../src/observer/owned-runtime-manager.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  makeHarness,
  runtimeStopPreflight,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("PID reuse and restart sealing", () => {
  it("refuses PID reuse and leaves the replacement process untouched", async () => {
    const value = makeHarness();
    const started = await value.start("reuse-start");
    const replacement = value.backend.processes.get(started.pid)!;
    replacement.identity.creationTime = "777777";
    replacement.ownerArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}replacement`;
    await expect(value.stop(started.runtimeId, "reuse-stop"))
      .rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.processes.get(started.pid)).toBe(replacement);
    expect(value.backend.terminateCalls).toHaveLength(0);
  });

  it("recovers an exact receipt after MCP restart and supports multiple independent runtimes", async () => {
    const value = makeHarness();
    const one = await value.start("multi-one", ["-noSplash", "-server", "one"]);
    const two = await value.start("multi-two", ["-noSplash", "-server", "two"]);
    expect(one.runtimeId).not.toBe(two.runtimeId);
    const sealed = await value.manager.close();
    expect(sealed).toMatchObject({ sealedRuntimeIds: expect.arrayContaining([one.runtimeId, two.runtimeId]) });
    expect(value.backend.processes.has(one.pid)).toBe(true);
    expect(value.backend.processes.has(two.pid)).toBe(true);

    const recovered = makeHarness({ root: value.root, backend: value.backend });
    recovered.setExecutable(value.executable);
    expect(await recovered.manager.status(one.runtimeId)).toMatchObject({ state: "running", exactOwned: true });
    recovered.gate.preflights.push(runtimeStopPreflight({
      sessionKnown: false, ready: false, reserved: false,
      reason: "observer_session_unknown",
    }));
    await recovered.stop(one.runtimeId, "recovered-stop");
    expect(value.backend.processes.has(one.pid)).toBe(false);
    expect(value.backend.processes.has(two.pid)).toBe(true);
    expect(await recovered.manager.status(two.runtimeId)).toMatchObject({ state: "running", exactOwned: true });
  });

  it("uses a durable restart seal without requiring a new child to re-retain the old session", async () => {
    const value = makeHarness();
    const started = await value.start("sealed-restart-start");
    await expect(value.manager.close()).resolves.toMatchObject({
      sealedRuntimeIds: [started.runtimeId],
      applicationCloseSafe: true,
    });

    const recovered = makeHarness({ root: value.root, backend: value.backend });
    recovered.setExecutable(value.executable);
    recovered.gate.retainRuntimeLifecycle = vi.fn(async () => {
      throw new Error("replacement private child has no old session");
    });
    recovered.gate.preflights.push(runtimeStopPreflight({
      sessionKnown: false, ready: false, reserved: false,
    }));

    await expect(recovered.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "running",
      exactOwned: true,
    });
    await expect(recovered.stop(started.runtimeId, "sealed-restart-stop"))
      .resolves.toMatchObject({ state: "exited", terminationComplete: true });
    expect(recovered.gate.retainRuntimeLifecycle).not.toHaveBeenCalled();
    expect(recovered.gate.preflights).toHaveLength(1);
    expect(value.backend.processes.has(started.pid)).toBe(false);
  });

  it("refuses concurrent adoption while the prior exact MCP owner is still live", async () => {
    const value = makeHarness();
    const started = await value.start("prior-owner-start");
    value.backend.processes.set(process.pid, {
      identity: {
        pid: process.pid,
        executablePath: process.execPath,
        creationTime: value.backend.currentCreation,
      },
      ownerArgument: "",
    });
    const concurrent = makeHarness({ root: value.root, backend: value.backend });
    expect(await concurrent.manager.status(started.runtimeId)).toMatchObject({
      state: "unverifiable",
      exactOwned: false,
      reason: expect.stringMatching(/Prior exact MCP owner is still live/),
    });
    await expect(concurrent.stop(started.runtimeId, "prior-owner-stop"))
      .rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  it("fails closed when restart recovery cannot prove the observer session", async () => {
    const value = makeHarness();
    const started = await value.start("unknown-session-start");
    value.gate.preflights.push(runtimeStopPreflight({
      sessionKnown: false, ready: false, reserved: false,
      reason: "observer_session_unknown",
    }));
    await expect(value.stop(started.runtimeId, "unknown-session-stop"))
      .rejects.toMatchObject({ code: "SESSION_UNVERIFIABLE" });
    expect(value.backend.processes.has(started.pid)).toBe(true);
  });

  });
});
