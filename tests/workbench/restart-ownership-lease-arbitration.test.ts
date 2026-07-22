import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProject, cleanupRestartOwnershipFixtures, createBlockedLifecycleHarness, createContenderClient,
  createRunningHarness, expectRejectedCode, readValidLifecycleState, republishLifecycleState,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

describe("lease fencing and launch arbitration", () => {
  it("blocks every lifecycle mutation from a second live MCP lease", async () => {
    const { harness } = await createRunningHarness();
    const contender = createContenderClient(harness);

    await expectRejectedCode(contender.ensureRunning(harness.projectPath), "OWNED_BY_OTHER_MCP");
    await expectRejectedCode(contender.restartOwnedWorkbench(), "OWNED_BY_OTHER_MCP");
    await expectRejectedCode(contender.shutdownOwnedWorkbench(), "OWNED_BY_OTHER_MCP");
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.children).toHaveLength(1);
  });

  it("deduplicates concurrent launches of the same canonical target", async () => {
    const { gate, harness } = createBlockedLifecycleHarness("readiness");

    const first = harness.client.ensureRunning(harness.projectPath);
    await gate.entered;
    const sameTargetSpelling = join(harness.modDirectory, ".", "ExampleMod.gproj");
    const second = harness.client.ensureRunning(sameTargetSpelling);
    gate.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(harness.children).toHaveLength(1);
  });

  it("refuses a different target while a launch is active", async () => {
    const { gate, harness } = createBlockedLifecycleHarness("readiness");
    const otherProject = addProject(harness, "OtherMod");

    const launching = harness.client.ensureRunning(harness.projectPath);
    await gate.entered;
    await expectRejectedCode(harness.client.ensureRunning(otherProject), "TARGET_CONFLICT");
    gate.release();
    await launching;

    expect(harness.children).toHaveLength(1);
  });

  it("releases the machine mutex while companion readiness is pending", async () => {
    const { gate, harness } = createBlockedLifecycleHarness("readiness");

    const launching = harness.client.ensureRunning(harness.projectPath);
    await gate.entered;
    const contenderRead = await harness.guard.withLifecycleLock((session) => session.readState());
    expect(contenderRead).toMatchObject({
      kind: "valid",
      state: {
        phase: "starting",
        operation: { kind: "launch" },
        workbench: { pid: harness.children[0].pid },
      },
    });
    gate.release();
    await expect(launching).resolves.toMatchObject({ action: "launched" });
  });

  it("refuses a stale running commit after readiness loses its exact reservation", async () => {
    const { gate, harness } = createBlockedLifecycleHarness("readiness");

    const launching = harness.client.ensureRunning(harness.projectPath);
    await gate.entered;
    await republishLifecycleState(harness);
    gate.release();

    await expectRejectedCode(launching, "RECOVERY_REQUIRED");
    const state = await readValidLifecycleState(harness);
    expect(state.phase).not.toBe("running");
  });
});
