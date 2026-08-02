import { unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchError } from "../../src/workbench/client.js";
import {
  cleanupRestartOwnershipFixtures, createHarness, createRunningHarness, expectRejectedCode,
  readValidLifecycleState, readinessIdentity, refuseEndpointOwnership, refuseTermination, type Harness,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

function expectSupervision(harness: Harness, active: number): void {
  expect(harness.client.diagnosticSupervisedChildCounts()).toEqual({
    active, reconciling: 0, total: active,
  });
}

async function expectRolledBackLaunch(
  harness: Harness,
  code: "LAUNCH_FAILED" | "IDENTITY_UNVERIFIABLE",
): Promise<void> {
  await expectRejectedCode(harness.client.ensureRunning(harness.projectPath), code);
  expect(harness.backend.terminationCalls).toHaveLength(1);
  expect(harness.backend.workbenchPids.size).toBe(0);
  const state = await readValidLifecycleState(harness);
  expect(state.phase).toBe("vacant");
  expect(state.workbench).toBeNull();
  expect(state.companion).not.toBeNull();
}

describe("launch and replacement transactions", () => {
  it("launches an explicit graphical Workbench lifecycle with a visible native viewport", async () => {
    const { harness } = await createRunningHarness();

    expect(harness.spawnOptions).toHaveLength(1);
    expect(harness.spawnOptions[0]).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      showWindow: "normal",
    });
    expect(harness.backend.minimizeWindowCalls).toEqual([]);
  });

  it("restarts only the recorded exact process and never calls ChildProcess.kill", async () => {
    const { harness, launched } = await createRunningHarness();
    const restarted = await harness.client.restartOwnedWorkbench();

    expect(launched.action).toBe("launched");
    expect(restarted.previousPid).toBe(launched.pid);
    expect(restarted.pid).not.toBe(launched.pid);
    expect(restarted.gprojPath).toBe(harness.projectPath);
    expect(harness.spawnOptions).toHaveLength(2);
    expect(harness.spawnOptions.every((options) =>
      (options as { showWindow?: unknown }).showWindow === "normal"
    )).toBe(true);
    expect(harness.backend.minimizeWindowCalls).toEqual([]);
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.terminationCalls[0]).toMatchObject({
      pid: launched.pid,
      creationTime: String(133_900_000_000_100_000n + BigInt(launched.pid)),
    });
    expect(harness.children.every((child) => child.kill.mock.calls.length === 0)).toBe(true);
  });

  it("finishes companion and executable preflight before stopping a healthy process", async () => {
    const { harness } = await createRunningHarness();
    unlinkSync(harness.executablePath);

    await expectRejectedCode(harness.client.restartOwnedWorkbench(), "LAUNCH_FAILED");
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.children).toHaveLength(1);
  });

  it("restores running state when exact termination is refused", async () => {
    const { harness } = await createRunningHarness();
    refuseTermination(harness, "token_mismatch", "Owner token no longer matches.");

    await expectRejectedCode(harness.client.restartOwnedWorkbench(), "IDENTITY_UNVERIFIABLE");
    const state = await readValidLifecycleState(harness);
    expect(state.phase).toBe("running");
    expect(state.operation).toBeNull();
    expect(state.workbench?.pid).toBe(harness.children[0].pid);
    expect(harness.children).toHaveLength(1);
  });

  it("exactly stops and rolls back when the final transaction CAS fails", async () => {
    const harness = createHarness();
    let injected = false;
    harness.backend.replaceFailure = ({ next }) => {
      if (!injected && next.phase === "running" && next.workbench !== null &&
          next.companion !== null) {
        injected = true;
        return new Error("injected final CAS failure");
      }
      return null;
    };

    await expectRolledBackLaunch(harness, "LAUNCH_FAILED");
    expect(injected).toBe(true);
  });

  it("terminates the exact failed launch before returning to vacant", async () => {
    const harness = createHarness({
      companionReadiness: async () => {
        throw new WorkbenchError("injected readiness failure", "LAUNCH_FAILED");
      },
    });

    await expectRolledBackLaunch(harness, "LAUNCH_FAILED");
    expectSupervision(harness, 0);
  });

  it("drains old and failed replacement supervision before a later operation", async () => {
    let readinessAttempt = 0;
    const { harness, launched } = await createRunningHarness({
      companionReadiness: async (options) => {
        readinessAttempt += 1;
        if (readinessAttempt === 2) {
          throw new WorkbenchError("injected replacement readiness failure", "LAUNCH_FAILED");
        }
        return readinessIdentity(options);
      },
    });
    expectSupervision(harness, 1);

    await expectRejectedCode(harness.client.restartOwnedWorkbench(), "LAUNCH_FAILED");
    expect(harness.backend.terminationCalls.map((call) => call.pid)).toEqual([
      launched.pid,
      harness.children[1].pid,
    ]);
    expect(harness.backend.workbenchPids.size).toBe(0);
    expectSupervision(harness, 0);

    const relaunched = await harness.client.ensureRunning(harness.projectPath);
    expect(relaunched).toMatchObject({
      action: "launched",
      pid: harness.children[2].pid,
    });
    expectSupervision(harness, 1);
    await harness.client.shutdownOwnedWorkbench();
    expectSupervision(harness, 0);
  });

  it("rolls back when a foreign endpoint answers ping while the spawned child stays alive", async () => {
    const harness = createHarness();
    refuseEndpointOwnership(harness, "listener belongs to injected foreign PID 44004");

    await expectRolledBackLaunch(harness, "IDENTITY_UNVERIFIABLE");
    expect(harness.children).toHaveLength(1);
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(1);
    expect(harness.backend.endpointOwnershipCalls[0].expected.pid).toBe(harness.children[0].pid);
  });

  it("preserves the live failed-launch transaction when exact stop is refused", async () => {
    const harness = createHarness({
      companionReadiness: async () => {
        throw new WorkbenchError("injected readiness failure", "LAUNCH_FAILED");
      },
    });
    refuseTermination(harness, "access_denied", "injected exact-stop refusal");

    await expectRejectedCode(harness.client.ensureRunning(harness.projectPath), "RECOVERY_REQUIRED");
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(1);
    const state = await readValidLifecycleState(harness);
    expect(state.phase).toBe("starting");
    expect(state.workbench).not.toBeNull();
    expect(state.companion).not.toBeNull();
  });
});
