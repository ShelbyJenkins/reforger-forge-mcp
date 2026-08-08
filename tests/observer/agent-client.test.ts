import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { ObserverAgentClient, redactChildLine } from "../../src/observer/agent-client.js";

const protocol = "rfo-observer-child-v1";

class TransportChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new PassThrough();
  hold = false;
  killCalls = 0;
  killResult = true;
  killExits = true;
  killError: Error | null = null;
  autoClose = true;
  transportClosed = false;
  sent: Array<Record<string, unknown>> = [];

  ready(): void {
    queueMicrotask(() => this.emit("message", {
      protocol,
      type: "ready",
      descriptor: { protocolVersion: "1.0", agentVersion: "0.1.0", agentInstanceId: "agent-1", host: "127.0.0.1", port: 49152 },
    }));
  }
  send(value: unknown, callback?: (error: Error | null) => void): boolean {
    const request = value as Record<string, unknown>;
    this.sent.push(request);
    callback?.(null);
    if (this.hold) return true;
    queueMicrotask(() => {
      this.emit("message", { protocol, type: "response", requestId: request.requestId, ok: true, result: { operation: request.operation } });
      if (request.operation === "shutdown") this.exit(0);
    });
    return true;
  }
  disconnect(): void { this.connected = false; }
  kill(): boolean {
    this.killCalls += 1;
    if (this.killError) throw this.killError;
    if (this.killResult && this.killExits) this.exit(1);
    return this.killResult;
  }
  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.connected = false;
    this.emit("exit", code, null);
    if (this.autoClose) this.closeTransport();
  }
  closeTransport(): void {
    if (this.transportClosed) return;
    this.transportClosed = true;
    this.emit("close", this.exitCode, this.signalCode);
  }
}

function client(child: TransportChild, count = { value: 0 }): ObserverAgentClient {
  const forkChild = (() => { count.value += 1; child.ready(); return child as unknown as ChildProcess; }) as typeof fork;
  return new ObserverAgentClient({ agentPath: "private-child.js", arguments: ["--root", "managed"], forkChild, startupTimeoutMs: 1_000, requestTimeoutMs: 1_000 });
}

describe("ObserverAgentClient", () => {
  it("projects idle, starting, pending, sole-ready, and extra-child states without lazy startup", async () => {
    const child = new TransportChild();
    const count = { value: 0 };
    const transport = client(child, count);
    const inspect = () => transport.inspectIdleShutdownReadiness({
      deadlineTick: performance.now() + 1_000,
      signal: new AbortController().signal,
      probeGeneration: 1,
    });
    await expect(inspect()).resolves.toMatchObject({ complete: true, blockers: [] });
    expect(count.value).toBe(0);
    await transport.ensureStarted();
    await expect(inspect()).resolves.toMatchObject({ blockers: [] });
    child.hold = true;
    const pending = transport.request("held");
    await Promise.resolve();
    await expect(inspect()).resolves.toMatchObject({ blockers: ["OBSERVER_CHILD"] });
    const extra = new TransportChild();
    (transport as unknown as { liveChildren: Set<ChildProcess> }).liveChildren.add(extra as unknown as ChildProcess);
    await expect(inspect()).resolves.toMatchObject({ blockers: ["OBSERVER_CHILD"] });
    (transport as unknown as { liveChildren: Set<ChildProcess> }).liveChildren.delete(extra as unknown as ChildProcess);
    child.exit(0);
    await expect(pending).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    await transport.close();
  });

  it("deduplicates concurrent lazy startup and closes the exact child", async () => {
    const child = new TransportChild();
    const count = { value: 0 };
    const transport = client(child, count);
    const [left, right] = await Promise.all([transport.ensureStarted(), transport.ensureStarted()]);
    expect(left).toEqual(right);
    expect(count.value).toBe(1);
    expect(transport.diagnosticPrivateChildCount()).toBe(1);
    await transport.close();
    expect(child.sent.some((request) => request.operation === "shutdown")).toBe(true);
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
  });

  it("never autostarts requestIfReady and cleans an aborted pending request", async () => {
    const child = new TransportChild();
    const count = { value: 0 };
    const transport = client(child, count);
    await expect(transport.requestIfReady("doctor")).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    expect(count.value).toBe(0);
    await transport.ensureStarted();
    child.hold = true;
    const controller = new AbortController();
    const pending = transport.request("held", {}, { signal: controller.signal, deadlineAtMs: Date.now() + 1_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    child.hold = false;
    await transport.close();
  });

  it("rejects pending work on exact-child exit and redacts credentials", async () => {
    const child = new TransportChild();
    const transport = client(child);
    await transport.ensureStarted();
    child.hold = true;
    const pending = transport.request("held");
    child.exit(9);
    await expect(pending).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    expect(redactChildLine("Authorization: Bearer abc.def launchNonce=secret")).not.toMatch(/abc\.def|secret$/);
    await transport.close();
  });

  it("caps both lazy startup and requests at the shared absolute deadline", async () => {
    const stalledStartup = new TransportChild();
    let startupDeadline: number | undefined = Date.now() + 50;
    const startupFork = (() => stalledStartup as unknown as ChildProcess) as typeof fork;
    const starting = new ObserverAgentClient({
      agentPath: "private-child.js",
      forkChild: startupFork,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      requestDeadlineAtMs: () => startupDeadline,
    });
    const startupBegan = Date.now();
    await expect(starting.ensureStarted()).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(Date.now() - startupBegan).toBeLessThan(500);
    startupDeadline = undefined;
    await starting.close();

    const child = new TransportChild();
    let requestDeadline: number | undefined;
    const forkChild = (() => {
      child.ready();
      return child as unknown as ChildProcess;
    }) as typeof fork;
    const transport = new ObserverAgentClient({
      agentPath: "private-child.js",
      forkChild,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      requestDeadlineAtMs: () => requestDeadline,
    });
    await transport.ensureStarted();
    child.hold = true;
    requestDeadline = Date.now() + 50;
    const requestBegan = Date.now();
    await expect(transport.request("held")).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(Date.now() - requestBegan).toBeLessThan(500);
    requestDeadline = undefined;
    child.hold = false;
    await transport.close();
  });

  it("keeps shutdown unsafe when escalation is not accepted", async () => {
    const child = new TransportChild();
    const transport = client(child);
    await transport.ensureStarted();
    child.hold = true;
    child.killResult = false;

    await expect(transport.close(Date.now() + 100)).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(child.killCalls).toBe(1);
    expect(transport.diagnosticPrivateChildCount()).toBe(1);
    expect(transport.state).toBe("closing");

    child.hold = false;
    child.killResult = true;
    await expect(transport.close(Date.now() + 500)).resolves.toBeUndefined();
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
  });

  it("does not publish clean close until both exit and stdio closure are observed", async () => {
    const child = new TransportChild();
    const transport = client(child);
    await transport.ensureStarted();
    child.hold = true;
    child.autoClose = false;

    const closing = transport.close(Date.now() + 500);
    await vi.waitFor(() => expect(child.killCalls).toBe(1));
    expect(child.exitCode).toBe(1);
    expect(transport.diagnosticPrivateChildCount()).toBe(1);
    expect(transport.state).toBe("closing");

    child.closeTransport();
    await expect(closing).resolves.toBeUndefined();
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
    expect(transport.state).toBe("closed");
  });

  it("waits for delayed exit and close after escalation is accepted", async () => {
    const child = new TransportChild();
    const transport = client(child);
    await transport.ensureStarted();
    child.hold = true;
    child.killExits = false;

    const closing = transport.close(Date.now() + 500);
    await vi.waitFor(() => expect(child.killCalls).toBe(1));
    expect(transport.diagnosticPrivateChildCount()).toBe(1);
    expect(transport.state).toBe("closing");

    child.exit(1);
    await expect(closing).resolves.toBeUndefined();
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
    expect(transport.state).toBe("closed");
  });

  it("keeps shutdown unsafe when accepted escalation yields no termination evidence", async () => {
    const child = new TransportChild();
    const transport = client(child);
    await transport.ensureStarted();
    child.hold = true;
    child.killExits = false;

    await expect(transport.close(Date.now() + 100)).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(child.killCalls).toBe(1);
    expect(transport.diagnosticPrivateChildCount()).toBe(1);
    expect(transport.state).toBe("closing");

    child.exit(1);
    await expect(transport.close(Date.now() + 500)).resolves.toBeUndefined();
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
  });

  it("keeps shutdown unsafe when escalation throws", async () => {
    const child = new TransportChild();
    const transport = client(child);
    await transport.ensureStarted();
    child.hold = true;
    child.killError = new Error("fixture kill failure");

    await expect(transport.close(Date.now() + 100)).rejects.toMatchObject({
      code: "TRANSPORT_UNAVAILABLE",
    });
    expect(child.killCalls).toBe(1);
    expect(transport.diagnosticPrivateChildCount()).toBe(1);
    expect(transport.state).toBe("closing");

    child.killError = null;
    child.killExits = true;
    await expect(transport.close(Date.now() + 500)).resolves.toBeUndefined();
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
  });

  it("emergency termination rejects pending IPC and kills the tracked child exactly once", async () => {
    const child = new TransportChild();
    const transport = client(child);
    await transport.ensureStarted();
    child.hold = true;
    const pending = transport.request("held-during-emergency");

    transport.emergencyTerminatePrivateChildren();
    transport.emergencyTerminatePrivateChildren();

    await expect(pending).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    expect(child.killCalls).toBe(1);
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
  });

  it("emergency termination kills a private child that never completed its ready handshake", async () => {
    const child = new TransportChild();
    const forkChild = (() => child as unknown as ChildProcess) as typeof fork;
    const transport = new ObserverAgentClient({
      agentPath: "private-child.js",
      forkChild,
      startupTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
    });
    const starting = transport.ensureStarted();

    transport.emergencyTerminatePrivateChildren();

    await expect(starting).rejects.toMatchObject({ code: "TRANSPORT_UNAVAILABLE" });
    expect(child.killCalls).toBe(1);
    expect(transport.diagnosticPrivateChildCount()).toBe(0);
  });
});
