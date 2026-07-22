import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, fork } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ObserverAgentClient, redactChildLine } from "../../src/observer/agent-client.js";

const protocol = "rfo-observer-child-v1";

class TransportChild extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new PassThrough();
  hold = false;
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
  kill(): boolean { this.exit(1); return true; }
  exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.connected = false;
    this.emit("exit", code, null);
  }
}

function client(child: TransportChild, count = { value: 0 }): ObserverAgentClient {
  const forkChild = (() => { count.value += 1; child.ready(); return child as unknown as ChildProcess; }) as typeof fork;
  return new ObserverAgentClient({ agentPath: "private-child.js", arguments: ["--root", "managed"], forkChild, startupTimeoutMs: 1_000, requestTimeoutMs: 1_000 });
}

describe("ObserverAgentClient", () => {
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
});
