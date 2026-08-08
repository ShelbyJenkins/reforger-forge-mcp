import { describe, expect, it, vi } from "vitest";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import {
  FakeChild,
  createChildBackedApplication,
  fakeWorkbenchAdapter,
} from "./application-diagnostics-fixture.js";

const quiescent = {
  quiescent: true,
  remainingJobIds: [],
  remainingAdmissionScopes: [],
  remainingActiveOperationIds: [],
  failures: [],
};

describe("Observer application phased shutdown", () => {
  it("orders quiescence before sealing and closes terminal services only after a safe seal", async () => {
    await withTemporaryDirectory(async (root) => {
      const child = new FakeChild();
      const adapter = fakeWorkbenchAdapter();
      const app = createChildBackedApplication(child, {
        managedRoot: root,
        gamePath: process.cwd(),
        workbenchAdapter: adapter,
      });
      const order: string[] = [];
      vi.spyOn(app.captureService, "quiesce").mockImplementation(async () => {
        order.push("capture:quiescent");
        return quiescent;
      });
      vi.spyOn(app.ownedRuntimeManager!, "close").mockImplementation(async () => {
        order.push("manager:sealed");
        return { applicationCloseSafe: true, sealedRuntimeIds: [], busyRuntimeIds: [], errorRuntimes: [] };
      });
      vi.spyOn(app.captureService, "close").mockImplementation(async () => {
        order.push("capture:closed");
      });
      adapter.restoreAll.mockImplementation(async () => { order.push("workbench:restored"); });
      vi.spyOn(app.agentClient, "close").mockImplementation(async () => {
        order.push("agent:closed");
      });

      const deadlineAtMs = Date.now() + 5_000;
      await expect(app.closeRuntimeLifecycle(deadlineAtMs)).resolves.toMatchObject({
        applicationCloseSafe: true,
      });
      expect(order).toEqual([
        "capture:quiescent",
        "manager:sealed",
        "capture:closed",
        "workbench:restored",
        "agent:closed",
      ]);
      expect(app.agentClient.close).toHaveBeenCalledWith(deadlineAtMs);
      expect(app.lifecycleState).toBe("closed");
    }, { prefix: "rfo-application-shutdown-order-" });
  });

  it("keeps the same private child alive after unsafe sealing and resumes on retry", async () => {
    await withTemporaryDirectory(async (root) => {
      const child = new FakeChild();
      const forkCount = { value: 0 };
      const app = createChildBackedApplication(child, {
        managedRoot: root,
        gamePath: process.cwd(),
      }, forkCount);
      await app.ensureSetup();
      vi.spyOn(app.captureService, "quiesce").mockResolvedValue(quiescent);
      const managerClose = vi.spyOn(app.ownedRuntimeManager!, "close")
        .mockResolvedValueOnce({
          applicationCloseSafe: false,
          sealedRuntimeIds: [],
          busyRuntimeIds: ["rt-blocked"],
          errorRuntimes: [],
        })
        .mockResolvedValueOnce({
          applicationCloseSafe: true,
          sealedRuntimeIds: ["rt-blocked"],
          busyRuntimeIds: [],
          errorRuntimes: [],
        });

      const firstDeadline = Date.now() + 2_000;
      await expect(app.closeRuntimeLifecycle(firstDeadline)).rejects.toMatchObject({
        code: "SHUTDOWN_SEAL_FAILED",
        details: expect.objectContaining({ busyRuntimeIds: ["rt-blocked"] }),
      });
      expect(app.lifecycleState).toBe("retryable_unsafe");
      expect(app.diagnosticPrivateChildCount()).toBe(1);
      expect(forkCount.value).toBe(1);
      await expect(app.status()).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });

      const retryDeadline = Date.now() + 3_000;
      await expect(app.closeRuntimeLifecycle(retryDeadline)).resolves.toMatchObject({
        applicationCloseSafe: true,
      });
      expect(managerClose.mock.calls).toEqual([[firstDeadline], [retryDeadline]]);
      expect(forkCount.value).toBe(1);
      expect(app.diagnosticPrivateChildCount()).toBe(0);
      expect(app.lifecycleState).toBe("closed");
    }, { prefix: "rfo-application-shutdown-retry-" });
  });

  it("coalesces concurrent attempts without reopening public admissions", async () => {
    await withTemporaryDirectory(async (root) => {
      const app = createChildBackedApplication(new FakeChild(), {
        managedRoot: root,
        gamePath: process.cwd(),
      });
      vi.spyOn(app.captureService, "quiesce").mockResolvedValue(quiescent);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const managerClose = vi.spyOn(app.ownedRuntimeManager!, "close").mockImplementation(async () => {
        await held;
        return { applicationCloseSafe: true, sealedRuntimeIds: [], busyRuntimeIds: [], errorRuntimes: [] };
      });
      const deadline = Date.now() + 5_000;
      const left = app.closeRuntimeLifecycle(deadline);
      const right = app.closeRuntimeLifecycle(deadline);
      await expect(app.beginRun({ title: "too late" })).rejects.toMatchObject({
        code: "TRANSPORT_UNAVAILABLE",
      });
      release();

      const [first, second] = await Promise.all([left, right]);
      expect(first).toEqual(second);
      expect(managerClose).toHaveBeenCalledOnce();
    }, { prefix: "rfo-application-shutdown-coalesce-" });
  });
});
