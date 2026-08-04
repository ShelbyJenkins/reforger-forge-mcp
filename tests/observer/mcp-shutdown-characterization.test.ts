import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createObserverApplication } from "../../src/observer/application.js";
import { observerAddonSource, repositoryRoot } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { FakeChild, createChildBackedApplication } from "./application-diagnostics-fixture.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("MCP shutdown characterization", () => {
  it("closes a no-Workbench, no-child, no-job application without starting a child", async () => {
    await withTemporaryDirectory(async (root) => {
      const app = createObserverApplication({ managedRoot: root });
      expect(app.diagnosticPrivateChildCount()).toBe(0);
      await expect(app.closeRuntimeLifecycle(Date.now() + 2_000)).resolves.toEqual({
        sealedRuntimeIds: [],
        busyRuntimeIds: [],
        errorRuntimes: [],
        applicationCloseSafe: true,
      });
      expect(app.diagnosticPrivateChildCount()).toBe(0);
    }, { prefix: "rfo-shutdown-no-work-" });
  });

  it("starts and then cleanly removes a real private child when no work exists", async () => {
    await withTemporaryDirectory(async (root) => {
      const app = createObserverApplication({
        agentPath: join(repositoryRoot, "tests", "observer", "fixtures", "private-child-entry.mjs"),
        managedRoot: root,
        sourceAddon: observerAddonSource,
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 10_000,
      });
      const descriptor = await app.ensureStarted();
      expect(descriptor.agentInstanceId).toBeTruthy();
      const pid = app.agentClient.childProcess?.pid;
      expect(pid).toEqual(expect.any(Number));
      expect(pidAlive(pid!)).toBe(true);

      await expect(app.closeRuntimeLifecycle(Date.now() + 10_000)).resolves.toMatchObject({
        applicationCloseSafe: true,
      });
      expect(app.diagnosticPrivateChildCount()).toBe(0);
      expect(pidAlive(pid!)).toBe(false);
    }, { prefix: "rfo-shutdown-started-child-" });
  }, 20_000);

  it("surfaces the exact busy runtime and retains the same child after an unsafe ordinary close", async () => {
    await withTemporaryDirectory(async (root) => {
      const child = new FakeChild();
      const forkCount = { value: 0 };
      const app = createChildBackedApplication(child, {
        managedRoot: root,
        gamePath: process.cwd(),
      }, forkCount);
      await app.ensureSetup();
      vi.spyOn(app.captureService, "quiesce").mockResolvedValue({
        quiescent: true,
        remainingJobIds: [],
        remainingAdmissionScopes: [],
        remainingActiveOperationIds: [],
        failures: [],
      });
      vi.spyOn(app.ownedRuntimeManager!, "close").mockResolvedValue({
        applicationCloseSafe: false,
        sealedRuntimeIds: [],
        busyRuntimeIds: ["rt-active-capture"],
        errorRuntimes: [{
          runtimeId: "rt-active-capture",
          reason: "activeJobIds=job-restoring cameraLeaseJobIds=job-restoring",
        }],
      });

      await expect(app.closeRuntimeLifecycle(Date.now() + 2_000)).rejects.toMatchObject({
        code: "SHUTDOWN_SEAL_FAILED",
        details: expect.objectContaining({
          applicationCloseSafe: false,
          busyRuntimeIds: ["rt-active-capture"],
          errorRuntimes: [expect.objectContaining({
            runtimeId: "rt-active-capture",
            reason: expect.stringContaining("cameraLeaseJobIds"),
          })],
        }),
      });
      expect(forkCount.value).toBe(1);
      expect(app.diagnosticPrivateChildCount()).toBe(1);
      expect(child.exitCode).toBeNull();
      app.emergencyTerminatePrivateChildren();
    }, { prefix: "rfo-shutdown-active-work-" });
  });
});
