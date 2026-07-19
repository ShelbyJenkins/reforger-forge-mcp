import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ChildSupervisor } from "../../src/workbench/child-supervisor.js";

function child(): ChildProcess {
  const value = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  value.exitCode = null;
  value.signalCode = null;
  return value as unknown as ChildProcess;
}

describe("ChildSupervisor terminal reconciliation", () => {
  it("automatically retries a failed exact-exit callback and drains retry state", async () => {
    const supervisor = new ChildSupervisor({
      reconciliationAttempts: 3,
      reconciliationRetryMs: 1,
    });
    const process = child();
    const errors: unknown[] = [];
    const reconcile = vi.fn()
      .mockRejectedValueOnce(new Error("first durable CAS failed"))
      .mockResolvedValue(undefined);

    supervisor.supervise("runtime-generation-a", process, {
      onExit: reconcile,
      onCallbackError: (error) => errors.push(error),
    });
    process.emit("exit", 17, null);

    expect(supervisor.size).toBe(0);
    expect(supervisor.reconciliationSize).toBe(1);
    expect(supervisor.counts()).toEqual({ active: 0, reconciling: 1, total: 1 });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(supervisor.reconciliationSize).toBe(0));
    expect(supervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
    expect(errors).toHaveLength(1);
    expect(reconcile).toHaveBeenLastCalledWith({ code: 17, signal: null });
  });

  it("cancels a stale retry when a newer child is supervised under the same key", async () => {
    const supervisor = new ChildSupervisor({
      reconciliationAttempts: 3,
      reconciliationRetryMs: 25,
    });
    const oldChild = child();
    const nextChild = child();
    const staleReconcile = vi.fn().mockRejectedValue(new Error("storage unavailable"));

    supervisor.supervise("owned-workbench", oldChild, { onExit: staleReconcile });
    oldChild.emit("exit", 1, null);
    await vi.waitFor(() => expect(staleReconcile).toHaveBeenCalledTimes(1));
    expect(supervisor.reconciliationSize).toBe(1);

    supervisor.supervise("owned-workbench", nextChild);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));

    expect(staleReconcile).toHaveBeenCalledTimes(1);
    expect(supervisor.reconciliationSize).toBe(0);
    expect(supervisor.size).toBe(1);
    expect(supervisor.counts()).toEqual({ active: 1, reconciling: 0, total: 1 });
  });
});
