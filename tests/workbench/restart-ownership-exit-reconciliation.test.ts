import { unlinkSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForVacancy } from "../../src/workbench/readiness.js";
import {
  cleanupRestartOwnershipFixtures, createRunningHarness, emitOwnedChildExit,
  expectEventuallyVacant, failFirstVacantTransition, readValidLifecycleState,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

describe("process-exit and endpoint-vacancy reconciliation", () => {
  it("invalidates cached state immediately and reconciles after an owned child exits", async () => {
    const { harness, launched } = await createRunningHarness();
    expect(harness.client.state.connected).toBe(true);
    const beforeExit = await readValidLifecycleState(harness);
    expect((harness.client as unknown as { ownedChild: { generation: string } })
      .ownedChild.generation).toBe(beforeExit.generation);
    emitOwnedChildExit(harness, launched.pid, 7);

    expect(harness.client.state).toMatchObject({ connected: false, mode: "unknown" });
    await expectEventuallyVacant(harness);
  });

  it("automatically retries exact child-exit reconciliation after the first durable CAS failure", async () => {
    const { harness, launched } = await createRunningHarness();
    const failure = failFirstVacantTransition(harness, "injected first exit-reconciliation CAS failure");
    emitOwnedChildExit(harness, launched.pid, 23);

    await vi.waitFor(() => expect(failure.triggered).toBe(true));
    await expectEventuallyVacant(harness);
  });

  it("does not let a delayed old-exit retry clobber a newer lifecycle generation", async () => {
    const { harness, launched } = await createRunningHarness();
    const failure = failFirstVacantTransition(harness, "injected first exit-reconciliation CAS failure");
    emitOwnedChildExit(harness, launched.pid, 31);
    await vi.waitFor(() => expect(failure.triggered).toBe(true));

    const replacement = await harness.client.ensureRunning(harness.projectPath);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 175));
    const state = await readValidLifecycleState(harness);
    expect(state.phase).toBe("running");
    expect(state.workbench?.pid).toBe(replacement.pid);
  });

  it("reconciles an unexpected exact-child exit after the .gproj is deleted", async () => {
    const { harness, launched } = await createRunningHarness();
    unlinkSync(harness.projectPath);
    emitOwnedChildExit(harness, launched.pid, 9);

    await expectEventuallyVacant(harness, (state) => {
      expect(state.target?.path).toBe(harness.projectPath);
    });
  });

  it("ignores a stale old-child exit after a replacement is running", async () => {
    const { harness, child: oldChild } = await createRunningHarness();
    const restarted = await harness.client.restartOwnedWorkbench();
    expect(harness.client.state.connected).toBe(true);

    oldChild.exitCode = 0;
    oldChild.emit("exit", 0, null);
    await Promise.resolve();

    expect(harness.client.state.connected).toBe(true);
    const state = await readValidLifecycleState(harness);
    expect(state.phase).toBe("running");
    expect(state.workbench?.pid).toBe(restarted.pid);
  });

  it("waits for native endpoint vacancy proof and fails closed on unverifiable probes", async () => {
    const verifyEndpointVacant = vi.fn()
      .mockResolvedValueOnce({ kind: "occupied", listenerPid: 9001, message: "still bound" })
      .mockResolvedValueOnce({ kind: "vacant" });
    const { harness } = await createRunningHarness({
      vacancyWait: (options) => waitForVacancy({
        ...options,
        verify: verifyEndpointVacant,
        pollIntervalMs: 0,
      }),
    });
    await expect(harness.client.restartOwnedWorkbench()).resolves.toMatchObject({
      previousPid: harness.children[0].pid,
    });
    expect(verifyEndpointVacant).toHaveBeenCalledTimes(2);

    const unverifiable = vi.fn().mockResolvedValue({
      kind: "unverifiable",
      reason: "access_denied",
      message: "TCP owner table access denied",
    });
    const { harness: unverifiableHarness } = await createRunningHarness({
      vacancyWait: (options) => waitForVacancy({
        ...options,
        verify: unverifiable,
      }),
    });
    await expect(unverifiableHarness.client.shutdownOwnedWorkbench())
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(unverifiable).toHaveBeenCalledTimes(1);
  });
});
