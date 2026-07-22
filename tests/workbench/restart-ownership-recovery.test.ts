import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleGuardError } from "../../src/workbench/process-guard.js";
import {
  addProject, cleanupRestartOwnershipFixtures, createBlockedLifecycleHarness, createRunningHarness,
  expectRejectedCode, readValidLifecycleState, refuseTermination, republishLifecycleState, type Harness,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

async function expectRecoveryState(
  harness: Harness,
  phase: "restarting" | "stopping",
  pid: number,
  operation?: "restart" | "shutdown",
): Promise<void> {
  const state = await readValidLifecycleState(harness);
  expect(state.phase).toBe(phase);
  if (operation) expect(state.operation?.kind).toBe(operation);
  expect(state.workbench?.pid).toBe(pid);
}

describe("restart and shutdown recovery", () => {
  it("preserves restarting recovery evidence when helper termination times out", async () => {
    const { harness, launched } = await createRunningHarness();
    refuseTermination(harness, "timeout", "TerminateProcess may have been issued before the helper timed out.");

    await expectRejectedCode(harness.client.restartOwnedWorkbench(), "RECOVERY_REQUIRED");
    await expectRecoveryState(harness, "restarting", launched.pid, "restart");
  });

  it("does not roll a pre-signal refusal over a raced restart generation", async () => {
    const { harness, launched } = await createRunningHarness();
    vi.spyOn(harness.backend, "verifyAndTerminate").mockImplementationOnce(async () => {
      await republishLifecycleState(harness);
      return {
        kind: "refused" as const,
        reason: "token_mismatch" as const,
        message: "proven pre-signal refusal after a raced generation change",
      };
    });

    await expectRejectedCode(harness.client.restartOwnedWorkbench(), "RECOVERY_REQUIRED");
    await expectRecoveryState(harness, "restarting", launched.pid);
  });

  it("preserves stopping recovery evidence when the termination helper fails", async () => {
    const { harness, launched } = await createRunningHarness();
    vi.spyOn(harness.backend, "verifyAndTerminate").mockRejectedValueOnce(
      new LifecycleGuardError("helper response was lost after signalling", "RECOVERY_REQUIRED")
    );

    await expectRejectedCode(harness.client.shutdownOwnedWorkbench(), "RECOVERY_REQUIRED");
    await expectRecoveryState(harness, "stopping", launched.pid, "shutdown");
  });

  it("derives exact termination and endpoint release from one lifecycle deadline", async () => {
    let lifecycleDeadline: number | undefined;
    let endpointDeadline = Number.POSITIVE_INFINITY;
    const { harness } = await createRunningHarness({
      lifecycleDeadlineAtMs: () => lifecycleDeadline,
      vacancyWait: async (options) => {
        endpointDeadline = options.deadlineMs;
      },
    });
    const termination = vi.spyOn(harness.backend, "verifyAndTerminate");
    lifecycleDeadline = Date.now() + 2_000;

    await expect(harness.client.shutdownOwnedWorkbench()).resolves.toMatchObject({
      stopped: true,
    });
    const terminationTimeout = termination.mock.calls[0]?.[1];
    expect(terminationTimeout).toBeGreaterThan(0);
    expect(terminationTimeout).toBeLessThanOrEqual(2_000);
    expect(endpointDeadline).toBeLessThanOrEqual(lifecycleDeadline);
  });

  it("refuses target B while restart A is paused after exact old-process exit", async () => {
    const { gate, harness } = createBlockedLifecycleHarness("vacancy");
    const otherProject = addProject(harness, "OtherMod");
    await harness.client.ensureRunning(harness.projectPath);

    const restarting = harness.client.restartOwnedWorkbench();
    await gate.entered;
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);
    const contenderRead = await harness.guard.withLifecycleLock((session) => session.readState());
    expect(contenderRead).toMatchObject({
      kind: "valid",
      state: {
        phase: "restarting",
        operation: { kind: "restart" },
        workbench: { pid: harness.children[0].pid },
      },
    });
    await expectRejectedCode(harness.client.ensureRunning(otherProject), "TARGET_CONFLICT");
    gate.release();
    await restarting;

    expect(harness.children).toHaveLength(2);
  });

  it("refuses a stale post-vacancy restart commit after generation interference", async () => {
    const { gate, harness } = createBlockedLifecycleHarness("vacancy");
    const launched = await harness.client.ensureRunning(harness.projectPath);

    const restarting = harness.client.restartOwnedWorkbench();
    await gate.entered;
    await republishLifecycleState(harness);
    gate.release();

    await expectRejectedCode(restarting, "RECOVERY_REQUIRED");
    expect(harness.children).toHaveLength(1);
    await expectRecoveryState(harness, "restarting", launched.pid);
  });

  it("deduplicates concurrent restarts of the same canonical target", async () => {
    const { gate, harness } = createBlockedLifecycleHarness("vacancy");
    await harness.client.ensureRunning(harness.projectPath);

    const first = harness.client.restartOwnedWorkbench();
    await gate.entered;
    const second = harness.client.restartOwnedWorkbench();
    gate.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.children).toHaveLength(2);
  });
});
