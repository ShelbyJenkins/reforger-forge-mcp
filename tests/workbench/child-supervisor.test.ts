import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import { McpHostAdmissionGate } from "../../src/mcp-host-admission.js";

function child(
  exitCode: number | null = null,
  signalCode: NodeJS.Signals | null = null,
  pid?: number
): ChildProcess {
  const value = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid?: number;
  };
  value.exitCode = exitCode;
  value.signalCode = signalCode;
  value.pid = pid;
  return value as unknown as ChildProcess;
}

describe("ChildSupervisor terminal reconciliation", () => {
  it("transfers one shared admission from child lifetime through exit reconciliation", async () => {
    const gate = new McpHostAdmissionGate();
    const supervisor = new ChildSupervisor({ admissionGate: gate });
    const process = child(null, null, 100);
    let finish!: () => void;
    const reconciliation = new Promise<void>((resolve) => { finish = resolve; });
    supervisor.supervise("owned-child", process, { onExit: () => reconciliation });
    expect(gate.snapshot().activeTokens).toBe(1);
    process.emit("exit", 0, null);
    expect(supervisor.counts()).toEqual({ active: 0, reconciling: 1, total: 1 });
    expect(gate.snapshot().activeTokens).toBe(1);
    await expect(supervisor.inspectIdleShutdownReadiness({
      deadlineTick: performance.now() + 1_000,
      signal: new AbortController().signal,
      probeGeneration: 1,
    })).resolves.toMatchObject({ blockers: ["WORKBENCH_RECOVERY"] });
    finish();
    await vi.waitFor(() => expect(supervisor.reconciliationSize).toBe(0));
    expect(gate.snapshot().activeTokens).toBe(0);
  });

  it("returns an exit handle that remains observable by late listeners", async () => {
    const supervisor = new ChildSupervisor();
    const process = child(null, null, 101);
    const handle = supervisor.supervise("workbench-a", process);

    expect(handle.child).toBe(process);
    expect(handle.terminalState).toBeNull();
    process.emit("exit", 0, "SIGTERM");

    const expected = { code: 0, signal: "SIGTERM" };
    await expect(handle.exit).resolves.toEqual(expected);
    await expect(handle.terminal).resolves.toEqual({ kind: "exit", exit: expected });
    expect(handle.terminalState).toEqual({ kind: "exit", exit: expected });
    const lateListener = vi.fn();
    await handle.terminal.then(lateListener);
    expect(lateListener).toHaveBeenCalledWith({ kind: "exit", exit: expected });
    expect(supervisor.size).toBe(0);
  });

  it("drains an error-only child that never received a PID or exit event", async () => {
    const gate = new McpHostAdmissionGate();
    const supervisor = new ChildSupervisor({ admissionGate: gate });
    const process = child();
    let finishReconciliation!: () => void;
    const reconciliation = new Promise<void>((resolve) => { finishReconciliation = resolve; });
    const handle = supervisor.supervise("failed-spawn", process, {
      onError: () => reconciliation,
    });
    const failure = new Error("spawn ENOENT");

    process.emit("error", failure);

    await expect(handle.terminal).resolves.toEqual({ kind: "error", error: failure });
    expect(supervisor.counts()).toEqual({ active: 0, reconciling: 0, total: 0 });
    expect(gate.snapshot().activeTokens).toBe(1);
    expect(process.listenerCount("error")).toBe(0);
    expect(process.listenerCount("exit")).toBe(0);
    finishReconciliation();
    await vi.waitFor(() => expect(gate.snapshot().activeTokens).toBe(0));
    process.emit("close", -2, null);
    expect(supervisor.counts().total).toBe(0);
  });

  it("observes error and exit independently while preserving the first terminal event", async () => {
    const supervisor = new ChildSupervisor();
    const process = child(null, null, 102);
    const handle = supervisor.supervise("workbench-a", process);
    const failure = new Error("spawn channel failed");

    process.emit("error", failure);
    await expect(handle.error).resolves.toBe(failure);
    await expect(handle.terminal).resolves.toEqual({ kind: "error", error: failure });
    expect(handle.terminalState).toEqual({ kind: "error", error: failure });
    expect(supervisor.size).toBe(1);

    process.emit("exit", 1, null);
    await expect(handle.exit).resolves.toEqual({ code: 1, signal: null });
    expect(handle.terminalState).toEqual({ kind: "error", error: failure });
    expect(supervisor.size).toBe(0);
  });

  it("publishes terminal state immediately for a child already known to have exited", async () => {
    const supervisor = new ChildSupervisor();
    const process = child(7);

    const handle = supervisor.supervise("workbench-a", process);

    expect(handle.terminalState).toEqual({
      kind: "exit",
      exit: { code: 7, signal: null },
    });
    await expect(handle.exit).resolves.toEqual({ code: 7, signal: null });
    await vi.waitFor(() => expect(supervisor.size).toBe(0));
  });

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
