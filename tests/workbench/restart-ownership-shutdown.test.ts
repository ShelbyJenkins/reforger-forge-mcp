import { unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchError } from "../../src/workbench/client.js";
import {
  cleanupRestartOwnershipFixtures, createHarness, createRunningHarness, expectRejectedCode,
  readValidLifecycleState,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

describe("shutdown ownership", () => {
  it("shuts down exactly and makes a second shutdown a no-op", async () => {
    const { harness, launched } = await createRunningHarness();
    const shutdown = await harness.client.shutdownOwnedWorkbench();

    expect(shutdown).toMatchObject({ stopped: true, previousPid: launched.pid });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.children[0].kill).not.toHaveBeenCalled();

    const secondShutdown = await harness.client.shutdownOwnedWorkbench();
    expect(secondShutdown.stopped).toBe(false);
    expect(secondShutdown.previousPid).toBeNull();
    expect(harness.backend.terminationCalls).toHaveLength(1);
  });

  it("shuts down the exact owned process after its recorded .gproj is deleted", async () => {
    const { harness, launched } = await createRunningHarness();
    unlinkSync(harness.projectPath);

    const shutdown = await harness.client.shutdownOwnedWorkbench();

    expect(shutdown).toMatchObject({
      stopped: true,
      previousPid: launched.pid,
      gprojPath: harness.projectPath,
    });
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.terminationCalls[0].pid).toBe(launched.pid);
    const state = await readValidLifecycleState(harness);
    expect(state.phase).toBe("vacant");
    expect(state.target?.path).toBe(harness.projectPath);
    expect(state.workbench).toBeNull();
  });

  it("still revalidates the recorded .gproj before restart", async () => {
    const { harness, launched } = await createRunningHarness();
    unlinkSync(harness.projectPath);

    await expectRejectedCode(harness.client.restartOwnedWorkbench(), "INVALID_TARGET");
    expect(harness.backend.terminationCalls).toHaveLength(0);
    expect(harness.backend.workbenchPids.has(launched.pid)).toBe(true);
  });

  it("fails closed when this MCP has no exact running owner", async () => {
    const harness = createHarness();
    try {
      await harness.client.restartOwnedWorkbench();
      throw new Error("expected restart refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbenchError);
      expect((error as WorkbenchError).code).toBe("LAUNCH_FAILED");
      expect((error as Error).message).toMatch(/no exact owned Workbench/i);
    }
    expect(harness.backend.terminationCalls).toHaveLength(0);
  });
});
