import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  ActivityTrackingTransport,
  McpProtocolActivity,
  TrackedMcpServer,
} from "../src/mcp-activity-transport.js";

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId = "session-fixture";
  readonly sent: Array<{ message: JSONRPCMessage; options?: TransportSendOptions }> = [];
  sendFailure: Error | null = null;
  sendBarrier: Promise<void> | null = null;
  onSend: ((message: JSONRPCMessage) => void) | null = null;
  started = false;
  closed = false;
  protocolVersion: string | null = null;

  async start(): Promise<void> { this.started = true; }
  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.sent.push({ message, options });
    this.onSend?.(message);
    if (this.sendBarrier) await this.sendBarrier;
    if (this.sendFailure) throw this.sendFailure;
  }
  setProtocolVersion(version: string): void { this.protocolVersion = version; }
  receive(message: JSONRPCMessage): void { this.onmessage?.(message); }
  fail(error: Error): void { this.onerror?.(error); }
}

function request(id: string | number, method = "tools/call"): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method, params: {} } as JSONRPCMessage;
}

function notification(method = "notifications/initialized"): JSONRPCMessage {
  return { jsonrpc: "2.0", method, params: {} } as JSONRPCMessage;
}

function cancellation(id: string | number): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: id },
  } as JSONRPCMessage;
}

function result(id: string | number): JSONRPCMessage {
  return { jsonrpc: "2.0", id, result: {} } as JSONRPCMessage;
}

describe("MCP protocol activity transport", () => {
  it("preserves ID direction, type, duplicates, forwarding, and cancellation counts", async () => {
    let tick = 10;
    const turns: Array<() => void> = [];
    const activity = new McpProtocolActivity({
      nowTick: () => tick,
      nowWall: () => new Date("2026-08-05T12:00:00.000Z"),
      scheduleTurn: (callback) => turns.push(callback),
    });
    const raw = new FakeTransport();
    const transport = new ActivityTrackingTransport(raw, activity);
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();

    expect(activity.snapshot()).toMatchObject({ started: true, activityEpoch: 1 });
    const numeric = request(0);
    const empty = request("");
    raw.receive(numeric);
    raw.receive(numeric);
    raw.receive(empty);
    expect(received).toEqual([numeric, numeric, empty]);
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 3,
      dispatchTurnCount: 3,
    });

    raw.receive(cancellation(0));
    expect(activity.snapshot().protocolResponseCount).toBe(2);
    await transport.send(result(0), { relatedRequestId: 0 });
    expect(raw.sent[0]).toEqual({ message: result(0), options: { relatedRequestId: 0 } });
    expect(activity.snapshot().protocolResponseCount).toBe(1);
    await transport.send(result(""));
    expect(activity.snapshot().protocolResponseCount).toBe(0);

    raw.receive(cancellation("not-active"));
    expect(activity.snapshot().protocolResponseCount).toBe(0);

    turns.splice(0).forEach((turn) => turn());
    expect(activity.snapshot()).toMatchObject({
      dispatchTurnCount: 0,
      requestCompletionIndeterminate: false,
    });
    tick += 1;
    raw.receive(notification());
    expect(activity.snapshot().lastActivityTick).toBe(11);
  });

  it("holds send settlement, refreshes client-response completion, and releases failures", async () => {
    let resolveSend!: () => void;
    const barrier = new Promise<void>((resolve) => { resolveSend = resolve; });
    let tick = 1;
    const activity = new McpProtocolActivity({
      nowTick: () => tick,
      nowWall: () => new Date("2026-08-05T12:00:00.000Z"),
      scheduleTurn: () => undefined,
    });
    const raw = new FakeTransport();
    const transport = new ActivityTrackingTransport(raw, activity);
    await transport.start();
    raw.receive(request("slow"));
    raw.sendBarrier = barrier;
    tick = 20;
    const pending = transport.send(result("slow"));
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 1,
      sendSettlementCount: 1,
      lastActivityTick: 1,
    });
    resolveSend();
    await pending;
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 0,
      sendSettlementCount: 0,
      lastActivityTick: 20,
    });

    raw.sendBarrier = null;
    raw.receive(request("failed"));
    const epoch = activity.snapshot().activityEpoch;
    raw.sendFailure = new Error("backpressure failed");
    await expect(transport.send(result("failed"))).rejects.toThrow("backpressure failed");
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 0,
      sendSettlementCount: 0,
      activityEpoch: epoch,
    });
  });

  it("tracks server requests separately and clears failed cancellation uncertainty on response", async () => {
    const activity = new McpProtocolActivity({ scheduleTurn: () => undefined });
    const raw = new FakeTransport();
    const transport = new ActivityTrackingTransport(raw, activity);
    await transport.start();

    await transport.send(request(0, "sampling/createMessage"));
    await transport.send(request("0", "roots/list"));
    expect(activity.snapshot().serverRequestCount).toBe(2);
    raw.receive(result(0));
    expect(activity.snapshot().serverRequestCount).toBe(1);

    raw.sendFailure = new Error("cancel send failed");
    await expect(transport.send(cancellation("0"))).rejects.toThrow("cancel send failed");
    expect(activity.snapshot()).toMatchObject({
      serverRequestCount: 1,
      requestCompletionIndeterminate: true,
    });
    raw.sendFailure = null;
    raw.receive(result("0"));
    expect(activity.snapshot()).toMatchObject({
      serverRequestCount: 0,
      requestCompletionIndeterminate: false,
    });

    await transport.send(request("cancelled", "roots/list"));
    await transport.send(cancellation("cancelled"));
    expect(activity.snapshot()).toMatchObject({
      serverRequestCount: 0,
      requestCompletionIndeterminate: false,
    });

    raw.sendFailure = new Error("initial request send failed");
    await expect(transport.send(request("never-sent"))).rejects.toThrow("initial request send failed");
    expect(activity.snapshot().serverRequestCount).toBe(0);
  });

  it("does not refresh activity for unrelated outbound notifications", async () => {
    let tick = 5;
    const activity = new McpProtocolActivity({ nowTick: () => tick });
    const raw = new FakeTransport();
    const transport = new ActivityTrackingTransport(raw, activity);
    await transport.start();
    const epoch = activity.snapshot().activityEpoch;
    tick = 100;

    await transport.send(notification("notifications/message"));
    expect(activity.snapshot()).toMatchObject({ activityEpoch: epoch, lastActivityTick: 5 });
  });

  it("classifies initialize, ping, and discovery responses before the end-turn fallback", async () => {
    const turns: Array<() => void> = [];
    const activity = new McpProtocolActivity({ scheduleTurn: (callback) => turns.push(callback) });
    const raw = new FakeTransport();
    const transport = new ActivityTrackingTransport(raw, activity);
    await transport.start();

    for (const [index, method] of [
      "initialize",
      "ping",
      "tools/list",
      "resources/list",
      "prompts/list",
    ].entries()) {
      raw.receive(request(index, method));
      await transport.send(result(index));
    }
    turns.splice(0).forEach((turn) => turn());
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 0,
      dispatchTurnCount: 0,
      requestCompletionIndeterminate: false,
    });

    const sdkTurns: Array<() => void> = [];
    const sdkActivity = new McpProtocolActivity({
      scheduleTurn: (callback) => sdkTurns.push(callback),
    });
    const sdkRaw = new FakeTransport();
    const sdkTransport = new ActivityTrackingTransport(sdkRaw, sdkActivity);
    const sdkServer = new TrackedMcpServer({ name: "fixture", version: "1" }, sdkActivity);
    await sdkServer.connect(sdkTransport);
    sdkRaw.receive(request("unknown", "custom/unknown"));
    await vi.waitFor(() => expect(sdkRaw.sent).toHaveLength(1));
    sdkTurns.splice(0).forEach((turn) => turn());
    expect(sdkActivity.snapshot()).toMatchObject({
      protocolResponseCount: 0,
      dispatchTurnCount: 0,
      requestCompletionIndeterminate: false,
    });
    await sdkServer.close();
  });

  it("forwards protocol identity, decoder errors, reentrant traffic, and close", async () => {
    let tick = 1;
    const activity = new McpProtocolActivity({ nowTick: () => tick });
    const raw = new FakeTransport();
    const closed = vi.fn();
    const failed = vi.fn();
    const transport = new ActivityTrackingTransport(raw, activity);
    transport.onclose = closed;
    transport.onerror = failed;
    await transport.start();
    expect(transport.sessionId).toBe("session-fixture");
    transport.setProtocolVersion("2025-11-25");
    expect(raw.protocolVersion).toBe("2025-11-25");

    const decoderError = new Error("malformed JSON line");
    const epoch = activity.snapshot().activityEpoch;
    raw.fail(decoderError);
    expect(failed).toHaveBeenCalledWith(decoderError);
    expect(activity.snapshot().activityEpoch).toBe(epoch);

    tick = 2;
    raw.onSend = () => raw.receive(notification("notifications/progress"));
    await transport.send(notification("notifications/message"));
    expect(activity.snapshot().lastActivityTick).toBe(2);

    await transport.close();
    expect(raw.closed).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(activity.snapshot()).toMatchObject({ closed: true, inboundDispatchSealed: true });
  });

  it("fails closed for unclassified dispatch and drops messages after the synchronous seal", async () => {
    const turns: Array<() => void> = [];
    const activity = new McpProtocolActivity({ scheduleTurn: (callback) => turns.push(callback) });
    const raw = new FakeTransport();
    const transport = new ActivityTrackingTransport(raw, activity);
    const handler = vi.fn();
    transport.onmessage = handler;
    await transport.start();
    raw.receive(request("unknown", "custom/untracked"));
    turns[0]!();
    expect(activity.snapshot().requestCompletionIndeterminate).toBe(true);

    const clean = new McpProtocolActivity();
    clean.start();
    expect(clean.canSealInboundDispatch(clean.snapshot().activityEpoch)).toBe(true);
    expect(clean.sealInboundDispatch()).toBe(true);
    expect(clean.receive(notification())).toBe(false);
  });

  it("forwards onmessage before an eager scheduler can release the dispatch turn", async () => {
    const events: string[] = [];
    const activity = new McpProtocolActivity({
      scheduleTurn: (callback) => {
        events.push("scheduled");
        callback();
      },
    });
    const raw = new FakeTransport();
    const transport = new ActivityTrackingTransport(raw, activity);
    let operation: Promise<void> | undefined;
    transport.onmessage = () => {
      events.push("forwarded");
      expect(activity.snapshot().dispatchTurnCount).toBe(1);
      operation = activity.runApplicationOperation(() => undefined, "eager");
    };
    await transport.start();

    raw.receive(request("eager"));

    expect(events).toEqual(["forwarded", "scheduled"]);
    expect(activity.snapshot()).toMatchObject({
      dispatchTurnCount: 0,
      requestCompletionIndeterminate: false,
    });
    await operation;
  });
});

describe("TrackedMcpServer application callbacks", () => {
  it("accounts a handler admitted after its client request was already cancelled", async () => {
    const turns: Array<() => void> = [];
    const activity = new McpProtocolActivity({ scheduleTurn: (callback) => turns.push(callback) });
    activity.start();
    const server = new TrackedMcpServer({ name: "fixture", version: "1" }, activity);
    let observed = false;
    const tool = server.registerTool("late", { inputSchema: {} }, async () => {
      observed = activity.snapshot().applicationOperationCount === 1;
      return { content: [] };
    });

    activity.receive(request("cancel-first"));
    activity.receive(cancellation("cancel-first"));
    await (tool.handler as unknown as (
      args: Record<string, never>,
      extra: { requestId: string },
    ) => Promise<unknown>)({}, { requestId: "cancel-first" });
    turns.splice(0).forEach((turn) => turn());
    expect(observed).toBe(true);
    expect(activity.snapshot()).toMatchObject({
      activeRequestCount: 0,
      requestCompletionIndeterminate: false,
    });
  });

  it("retains application activity through cancellation and handler settlement", async () => {
    const turns: Array<() => void> = [];
    const activity = new McpProtocolActivity({ scheduleTurn: (callback) => turns.push(callback) });
    activity.start();
    const server = new TrackedMcpServer({ name: "fixture", version: "1" }, activity);
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const registered = server.registerTool("slow", { inputSchema: {} }, async () => {
      await work;
      return { content: [{ type: "text", text: "done" }] };
    });
    activity.receive(request("tool-request"));
    const handler = registered.handler as unknown as (
      args: Record<string, never>,
      extra: { requestId: string },
    ) => Promise<unknown>;
    const pending = handler({}, { requestId: "tool-request" });
    turns[0]!();
    activity.receive(cancellation("tool-request"));
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 0,
      applicationOperationCount: 1,
      requestCompletionIndeterminate: false,
    });
    const epoch = activity.snapshot().activityEpoch;
    finish();
    await pending;
    expect(activity.snapshot()).toMatchObject({ applicationOperationCount: 0 });
    expect(activity.snapshot().activityEpoch).toBeGreaterThan(epoch);
  });

  it("retains resource and prompt work that ignores cancellation", async () => {
    const turns: Array<() => void> = [];
    const activity = new McpProtocolActivity({ scheduleTurn: (callback) => turns.push(callback) });
    activity.start();
    const server = new TrackedMcpServer({ name: "fixture", version: "1" }, activity);

    let finishResource!: () => void;
    const resourceWork = new Promise<void>((resolve) => { finishResource = resolve; });
    const resource = server.registerResource("slow", "fixture://slow", {}, async (uri) => {
      await resourceWork;
      return { contents: [{ uri: uri.href, text: "done" }] };
    });
    activity.receive(request("resource", "resources/read"));
    const pendingResource = resource.readCallback(
      new URL("fixture://slow"),
      { requestId: "resource" } as never,
    );
    turns.shift()!();
    activity.receive(cancellation("resource"));
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 0,
      applicationOperationCount: 1,
    });
    finishResource();
    await pendingResource;

    let finishPrompt!: () => void;
    const promptWork = new Promise<void>((resolve) => { finishPrompt = resolve; });
    const prompt = server.registerPrompt("slow", {}, async () => {
      await promptWork;
      return { messages: [] };
    });
    activity.receive(request("prompt", "prompts/get"));
    const pendingPrompt = (prompt.callback as unknown as (
      extra: { requestId: string },
    ) => Promise<unknown>)({ requestId: "prompt" });
    turns.shift()!();
    activity.receive(cancellation("prompt"));
    expect(activity.snapshot()).toMatchObject({
      protocolResponseCount: 0,
      applicationOperationCount: 1,
      requestCompletionIndeterminate: false,
    });
    finishPrompt();
    await pendingPrompt;
    expect(activity.snapshot().applicationOperationCount).toBe(0);
  });

  it("wraps callback replacements and resource-template completion", async () => {
    const activity = new McpProtocolActivity({ scheduleTurn: () => undefined });
    activity.start();
    const server = new TrackedMcpServer({ name: "fixture", version: "1" }, activity);
    const tool = server.registerTool("replaceable", { inputSchema: {} }, async () => ({ content: [] }));
    let observed = false;
    tool.update({
      callback: async () => {
        observed = activity.snapshot().applicationOperationCount === 1;
        return { content: [] };
      },
    });
    const handler = tool.handler as unknown as (
      args: Record<string, never>,
      extra: { requestId: number },
    ) => Promise<unknown>;
    await handler({}, { requestId: 7 });
    expect(observed).toBe(true);
  });

  it("accounts resource, template list/completion/read, prompt, and replacement callbacks", async () => {
    const activity = new McpProtocolActivity({ scheduleTurn: () => undefined });
    activity.start();
    const server = new TrackedMcpServer({ name: "fixture", version: "1" }, activity);
    const observed: string[] = [];
    const mark = (name: string): void => {
      expect(activity.snapshot().applicationOperationCount, name).toBe(1);
      observed.push(name);
    };

    const resource = server.registerResource(
      "static",
      "fixture://static",
      {},
      async (uri) => {
        mark("resource");
        return { contents: [{ uri: uri.href, text: "static" }] };
      },
    );
    await resource.readCallback(new URL("fixture://static"), {} as never);
    resource.update({
      callback: async (uri) => {
        mark("resource-update");
        return { contents: [{ uri: uri.href, text: "updated" }] };
      },
    });
    await resource.readCallback(new URL("fixture://static"), {} as never);

    const template = new ResourceTemplate("fixture://items/{name}", {
      list: async () => {
        mark("template-list");
        return { resources: [] };
      },
      complete: {
        name: async (value) => {
          mark("template-complete");
          return [value];
        },
      },
    });
    const templated = server.registerResource(
      "templated",
      template,
      {},
      async (uri) => {
        mark("template-read");
        return { contents: [{ uri: uri.href, text: "templated" }] };
      },
    );
    await templated.resourceTemplate.listCallback!({} as never);
    await templated.resourceTemplate.completeCallback("name")!("first");
    await templated.readCallback(
      new URL("fixture://items/first"),
      { name: "first" },
      {} as never,
    );

    templated.update({
      template: new ResourceTemplate("fixture://items/{name}", {
        list: async () => {
          mark("template-list-update");
          return { resources: [] };
        },
        complete: {
          name: async (value) => {
            mark("template-complete-update");
            return [value];
          },
        },
      }),
      callback: async (uri) => {
        mark("template-read-update");
        return { contents: [{ uri: uri.href, text: "updated" }] };
      },
    });
    await templated.resourceTemplate.listCallback!({} as never);
    await templated.resourceTemplate.completeCallback("name")!("second");
    await templated.readCallback(
      new URL("fixture://items/second"),
      { name: "second" },
      {} as never,
    );

    const prompt = server.registerPrompt("fixture-prompt", {}, async () => {
      mark("prompt");
      return { messages: [] };
    });
    await (prompt.callback as unknown as (extra: unknown) => Promise<unknown>)({});
    prompt.update({
      callback: async () => {
        mark("prompt-update");
        return { messages: [] };
      },
    });
    await (prompt.callback as unknown as (extra: unknown) => Promise<unknown>)({});

    expect(observed).toEqual([
      "resource",
      "resource-update",
      "template-list",
      "template-complete",
      "template-read",
      "template-list-update",
      "template-complete-update",
      "template-read-update",
      "prompt",
      "prompt-update",
    ]);
    expect(activity.snapshot().applicationOperationCount).toBe(0);
  });
});
