import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRestartOwnershipFixtures, createHarness, createRunningHarness, expectRejectedCode,
  refuseEndpointOwnership, republishLifecycleState, type Harness,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

describe("session vacancy and reuse qualification", () => {
  it("spawns only after native vacancy proof and distinguishes occupied from unverifiable", async () => {
    const cases = [
      {
        code: "UNOWNED_WORKBENCH",
        arrange: (harness: Harness) => {
          harness.backend.endpointVacancyResult = {
            kind: "occupied", listenerPid: 55_101, message: "foreign listener",
          };
        },
      },
      {
        code: "IDENTITY_UNVERIFIABLE",
        arrange: (harness: Harness) => {
          harness.backend.endpointVacancyResult = {
            kind: "unverifiable", reason: "timeout", message: "native endpoint probe timed out",
          };
        },
      },
      {
        code: "IDENTITY_UNVERIFIABLE",
        arrange: (harness: Harness) => {
          harness.backend.verifyEndpointVacant = vi.fn()
            .mockRejectedValue(new Error("native vacancy helper returned invalid JSON"));
        },
      },
    ] as const;
    for (const testCase of cases) {
      const harness = createHarness();
      testCase.arrange(harness);
      await expectRejectedCode(harness.client.ensureRunning(harness.projectPath), testCase.code);
      expect(harness.children).toHaveLength(0);
    }
  });

  it("re-proves the live owner token before reporting target reuse", async () => {
    const { harness, launched } = await createRunningHarness();
    harness.backend.ownerArguments.set(
      launched.pid,
      "-reforgerForgeOwnerToken=not-the-recorded-owner"
    );

    await expectRejectedCode(harness.client.ensureRunning(harness.projectPath), "IDENTITY_UNVERIFIABLE");
    expect(harness.children).toHaveLength(1);
    expect(harness.backend.terminationCalls).toHaveLength(0);
  });

  it.each([
    {
      name: "re-proves endpoint ownership before reusing a recorded running session",
      recoverStarting: false,
      message: "listener moved to foreign PID 55100",
    },
    {
      name: "re-proves endpoint ownership before recovering a starting session",
      recoverStarting: true,
      message: "foreign endpoint answered recovery ping",
    },
  ])("$name", async ({ recoverStarting, message }) => {
    const { harness, launched } = await createRunningHarness();
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(1);
    if (recoverStarting) await republishLifecycleState(harness, {
      phase: "starting",
      operation: { kind: "launch", operationId: "recovery-fixture" },
    });
    const ping = vi.spyOn(harness.client, "ping").mockResolvedValue(true);
    refuseEndpointOwnership(harness, message);

    await expectRejectedCode(harness.client.ensureRunning(harness.projectPath), "IDENTITY_UNVERIFIABLE");
    expect(harness.backend.endpointOwnershipCalls).toHaveLength(2);
    expect(harness.backend.endpointOwnershipCalls[1].expected.pid).toBe(launched.pid);
    expect(ping).not.toHaveBeenCalled();
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.backend.workbenchPids.has(launched.pid)).toBe(true);
  });
});
