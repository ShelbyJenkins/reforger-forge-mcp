import { performance } from "node:perf_hooks";
import {
  McpServer,
  ResourceTemplate,
  type CompleteResourceTemplateCallback,
  type ListResourcesCallback,
  type PromptCallback,
  type ReadResourceCallback,
  type ReadResourceTemplateCallback,
  type RegisteredPrompt,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type RegisteredTool,
  type ResourceMetadata,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import type {
  AnySchema,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  Implementation,
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";

const MAX_DIAGNOSTIC_ACTIVE_COUNT = 1_000_000;

export type McpActivityEventKind = "activity" | "state" | "closed";
export type McpActivityListener = (kind: McpActivityEventKind) => void;
export type McpTurnScheduler = (callback: () => void) => unknown;

export interface McpProtocolActivitySnapshot {
  readonly started: boolean;
  readonly closed: boolean;
  readonly inboundDispatchSealed: boolean;
  readonly activityEpoch: number;
  readonly lastActivityTick: number;
  readonly lastActivityAt: string;
  readonly protocolResponseCount: number;
  readonly applicationOperationCount: number;
  readonly serverRequestCount: number;
  readonly sendSettlementCount: number;
  readonly dispatchTurnCount: number;
  readonly requestCompletionIndeterminate: boolean;
  readonly activeRequestCount: number;
}

export interface McpProtocolActivityOptions {
  readonly nowTick?: () => number;
  readonly nowWall?: () => Date;
  readonly scheduleTurn?: McpTurnScheduler;
}

interface ClientRequestSlot {
  readonly key: string;
  classified: boolean;
  responseReserved: boolean;
  dispatchActive: boolean;
}

interface ServerRequestSlot {
  readonly key: string;
  cancellationReserved: boolean;
  indeterminate: boolean;
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function requestId(value: unknown): RequestId | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & {
  readonly method: string;
  readonly id: RequestId;
} {
  return "method" in message && typeof message.method === "string" &&
    "id" in message && requestId(message.id) !== null;
}

function isResponse(message: JSONRPCMessage): message is JSONRPCMessage & {
  readonly id: RequestId;
} {
  return !("method" in message) && "id" in message && requestId(message.id) !== null;
}

function cancellationRequestId(message: JSONRPCMessage): RequestId | null {
  if (!("method" in message) || message.method !== "notifications/cancelled" ||
      !("params" in message) || !message.params || typeof message.params !== "object") {
    return null;
  }
  return requestId((message.params as Record<string, unknown>).requestId);
}

function safeWallIso(nowWall: () => Date): string {
  const value = nowWall();
  const milliseconds = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) throw new TypeError("MCP activity wall clock returned an invalid date");
  return new Date(milliseconds).toISOString();
}

function saturatedTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total = Math.min(MAX_DIAGNOSTIC_ACTIVE_COUNT, total + value);
  }
  return total;
}

/** Process-local protocol/application ledger. It retains counts, never request details. */
export class McpProtocolActivity {
  private readonly nowTick: () => number;
  private readonly nowWall: () => Date;
  private readonly scheduleTurn: McpTurnScheduler;
  private readonly listeners = new Set<McpActivityListener>();
  private readonly clientRequests = new Map<string, ClientRequestSlot[]>();
  private readonly serverRequests = new Map<string, ServerRequestSlot[]>();
  private readonly dispatchSlots = new Set<ClientRequestSlot>();
  private started = false;
  private closed = false;
  private inboundDispatchSealed = false;
  private activityEpoch = 0;
  private lastActivityTick = 0;
  private lastActivityAt = new Date(0).toISOString();
  private applicationOperations = 0;
  private sendSettlements = 0;
  private stickyDispatchIndeterminate = false;

  constructor(options: McpProtocolActivityOptions = {}) {
    this.nowTick = options.nowTick ?? (() => performance.now());
    this.nowWall = options.nowWall ?? (() => new Date());
    this.scheduleTurn = options.scheduleTurn ?? ((callback) => setImmediate(callback));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshActivity();
  }

  subscribe(listener: McpActivityListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): McpProtocolActivitySnapshot {
    const protocolResponseCount = this.countSlots(this.clientRequests);
    const serverRequestCount = this.countSlots(this.serverRequests);
    const requestCompletionIndeterminate = this.stickyDispatchIndeterminate ||
      [...this.serverRequests.values()].some((slots) => slots.some((slot) => slot.indeterminate));
    return Object.freeze({
      started: this.started,
      closed: this.closed,
      inboundDispatchSealed: this.inboundDispatchSealed,
      activityEpoch: this.activityEpoch,
      lastActivityTick: this.lastActivityTick,
      lastActivityAt: this.lastActivityAt,
      protocolResponseCount,
      applicationOperationCount: this.applicationOperations,
      serverRequestCount,
      sendSettlementCount: this.sendSettlements,
      dispatchTurnCount: this.dispatchSlots.size,
      requestCompletionIndeterminate,
      activeRequestCount: saturatedTotal([
        protocolResponseCount,
        this.applicationOperations,
        serverRequestCount,
        this.sendSettlements,
        this.dispatchSlots.size,
      ]),
    });
  }

  canSealInboundDispatch(activityEpoch: number): boolean {
    const snapshot = this.snapshot();
    return snapshot.started && !snapshot.closed && !snapshot.inboundDispatchSealed &&
      snapshot.activityEpoch === activityEpoch && snapshot.activeRequestCount === 0 &&
      !snapshot.requestCompletionIndeterminate;
  }

  /** Call only after all aggregate checks; this synchronous operation cannot throw. */
  sealInboundDispatch(): boolean {
    if (this.closed || this.inboundDispatchSealed) return false;
    this.inboundDispatchSealed = true;
    this.emit("state");
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inboundDispatchSealed = true;
    this.clientRequests.clear();
    this.serverRequests.clear();
    this.dispatchSlots.clear();
    this.applicationOperations = 0;
    this.sendSettlements = 0;
    this.stickyDispatchIndeterminate = false;
    this.emit("closed");
  }

  receive(message: JSONRPCMessage, forward?: () => void): boolean {
    if (this.closed || this.inboundDispatchSealed) return false;
    this.refreshActivity();
    let dispatchSlot: ClientRequestSlot | null = null;
    if (isRequest(message)) {
      const slot: ClientRequestSlot = {
        key: requestKey(message.id),
        classified: false,
        responseReserved: false,
        dispatchActive: true,
      };
      dispatchSlot = slot;
      this.pushSlot(this.clientRequests, slot.key, slot);
      this.dispatchSlots.add(slot);
      this.emit("state");
    } else if (isResponse(message)) {
      this.retireServerRequest(message.id);
    } else {
      const cancelledId = cancellationRequestId(message);
      if (cancelledId !== null) this.cancelClientRequest(cancelledId);
    }
    try {
      forward?.();
    } finally {
      if (dispatchSlot) this.scheduleDispatchTurnRelease(dispatchSlot);
    }
    return true;
  }

  beginSend(message: JSONRPCMessage): {
    readonly complete: (succeeded: boolean) => void;
  } {
    this.sendSettlements += 1;
    let clientResponse: ClientRequestSlot | null = null;
    let serverRequest: ServerRequestSlot | null = null;
    let serverCancellation: ServerRequestSlot | null = null;

    if (isRequest(message)) {
      serverRequest = {
        key: requestKey(message.id),
        cancellationReserved: false,
        indeterminate: false,
      };
      this.pushSlot(this.serverRequests, serverRequest.key, serverRequest);
    } else if (isResponse(message)) {
      clientResponse = this.reserveClientResponse(message.id);
    } else {
      const cancelledId = cancellationRequestId(message);
      if (cancelledId !== null) serverCancellation = this.reserveServerCancellation(cancelledId);
    }
    this.emit("state");

    let completed = false;
    return Object.freeze({
      complete: (succeeded: boolean): void => {
        if (completed) return;
        completed = true;
        this.sendSettlements = Math.max(0, this.sendSettlements - 1);
        if (clientResponse) {
          this.removeSlot(this.clientRequests, clientResponse.key, clientResponse);
          if (succeeded) this.refreshActivity();
          else this.emit("state");
          return;
        }
        if (serverRequest && !succeeded) {
          this.removeSlot(this.serverRequests, serverRequest.key, serverRequest);
        }
        if (serverCancellation) {
          serverCancellation.cancellationReserved = false;
          if (succeeded) {
            this.removeSlot(this.serverRequests, serverCancellation.key, serverCancellation);
            this.refreshActivity();
            return;
          }
          serverCancellation.indeterminate = true;
        }
        this.emit("state");
      },
    });
  }

  runApplicationOperation<T>(
    action: () => T | Promise<T>,
    id?: RequestId,
  ): Promise<T> {
    this.classifyApplicationDispatch(id);
    this.applicationOperations += 1;
    this.emit("state");
    let result: T | Promise<T>;
    try {
      result = action();
    } catch (error) {
      this.finishApplicationOperation();
      throw error;
    }
    return Promise.resolve(result).finally(() => this.finishApplicationOperation());
  }

  private finishApplicationOperation(): void {
    this.applicationOperations = Math.max(0, this.applicationOperations - 1);
    this.refreshActivity();
  }

  private classifyApplicationDispatch(id?: RequestId): void {
    const key = id === undefined ? null : requestKey(id);
    const candidate = [...this.dispatchSlots].find((slot) =>
      !slot.classified && (key === null || slot.key === key));
    if (candidate) candidate.classified = true;
  }

  private finishDispatchTurn(slot: ClientRequestSlot): void {
    if (!slot.dispatchActive) return;
    slot.dispatchActive = false;
    this.dispatchSlots.delete(slot);
    if (!slot.classified && this.hasSlot(this.clientRequests, slot.key, slot)) {
      this.stickyDispatchIndeterminate = true;
    }
    this.emit("state");
  }

  private scheduleDispatchTurnRelease(slot: ClientRequestSlot): void {
    try {
      this.scheduleTurn(() => this.finishDispatchTurn(slot));
    } catch {
      this.stickyDispatchIndeterminate = true;
      this.finishDispatchTurn(slot);
    }
  }

  private reserveClientResponse(id: RequestId): ClientRequestSlot | null {
    const slots = this.clientRequests.get(requestKey(id));
    const slot = slots?.find((candidate) => !candidate.responseReserved) ?? null;
    if (!slot) return null;
    slot.responseReserved = true;
    slot.classified = true;
    return slot;
  }

  private cancelClientRequest(id: RequestId): void {
    const key = requestKey(id);
    const slots = this.clientRequests.get(key);
    const slot = slots?.find((candidate) => !candidate.responseReserved) ?? null;
    if (!slot) return;
    slot.classified = true;
    this.removeSlot(this.clientRequests, key, slot);
    this.emit("state");
  }

  private reserveServerCancellation(id: RequestId): ServerRequestSlot | null {
    const slots = this.serverRequests.get(requestKey(id));
    const slot = slots?.find((candidate) => !candidate.cancellationReserved) ?? null;
    if (!slot) return null;
    slot.cancellationReserved = true;
    return slot;
  }

  private retireServerRequest(id: RequestId): void {
    const key = requestKey(id);
    const slot = this.serverRequests.get(key)?.[0];
    if (!slot) return;
    this.removeSlot(this.serverRequests, key, slot);
    this.emit("state");
  }

  private refreshActivity(): void {
    if (this.activityEpoch === Number.MAX_SAFE_INTEGER) {
      throw new Error("MCP protocol activity epoch exhausted");
    }
    const tick = this.nowTick();
    if (!Number.isFinite(tick)) throw new TypeError("MCP activity monotonic clock returned an invalid value");
    this.activityEpoch += 1;
    this.lastActivityTick = tick;
    this.lastActivityAt = safeWallIso(this.nowWall);
    this.emit("activity");
  }

  private emit(kind: McpActivityEventKind): void {
    for (const listener of [...this.listeners]) {
      try { listener(kind); } catch { /* activity observers cannot break protocol delivery */ }
    }
  }

  private pushSlot<T>(map: Map<string, T[]>, key: string, slot: T): void {
    const slots = map.get(key);
    if (slots) slots.push(slot);
    else map.set(key, [slot]);
  }

  private removeSlot<T>(map: Map<string, T[]>, key: string, slot: T): void {
    const slots = map.get(key);
    if (!slots) return;
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    if (slots.length === 0) map.delete(key);
  }

  private hasSlot<T>(map: Map<string, T[]>, key: string, slot: T): boolean {
    return map.get(key)?.includes(slot) === true;
  }

  private countSlots<T>(map: Map<string, T[]>): number {
    let total = 0;
    for (const slots of map.values()) total += slots.length;
    return total;
  }
}

/** Public Transport decorator; it never reads SDK protocol internals. */
export class ActivityTrackingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  constructor(
    private readonly transport: Transport,
    readonly activity: McpProtocolActivity,
    private readonly onTransportClose?: () => void,
  ) {}

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  async start(): Promise<void> {
    this.transport.onmessage = (message, extra) => {
      this.activity.receive(message, () => this.onmessage?.(message, extra));
    };
    this.transport.onerror = (error) => this.onerror?.(error);
    this.transport.onclose = () => {
      this.activity.close();
      try { this.onTransportClose?.(); } finally { this.onclose?.(); }
    };
    await this.transport.start();
    this.activity.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const settlement = this.activity.beginSend(message);
    let succeeded = false;
    try {
      await this.transport.send(message, options);
      succeeded = true;
    } finally {
      settlement.complete(succeeded);
    }
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } finally {
      this.activity.close();
    }
  }
}

type AnyCallback = (...args: never[]) => unknown;

/** CLI composition server that accounts every repository application callback. */
export class TrackedMcpServer extends McpServer {
  constructor(
    serverInfo: Implementation,
    readonly activity: McpProtocolActivity,
    options?: ServerOptions,
  ) {
    super(serverInfo, options);
  }

  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: Parameters<McpServer["registerTool"]>[1]["annotations"];
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const registered = super.registerTool(name, config, this.wrapCallback(callback));
    const update = registered.update.bind(registered);
    registered.update = ((updates: Parameters<RegisteredTool["update"]>[0]) => {
      update({
        ...updates,
        ...(updates.callback ? { callback: this.wrapCallback(updates.callback) } : {}),
      });
    }) as RegisteredTool["update"];
    return registered;
  }

  override registerResource(
    name: string,
    uriOrTemplate: string,
    config: ResourceMetadata,
    callback: ReadResourceCallback,
  ): RegisteredResource;
  override registerResource(
    name: string,
    uriOrTemplate: ResourceTemplate,
    config: ResourceMetadata,
    callback: ReadResourceTemplateCallback,
  ): RegisteredResourceTemplate;
  override registerResource(
    name: string,
    uriOrTemplate: string | ResourceTemplate,
    config: ResourceMetadata,
    callback: ReadResourceCallback | ReadResourceTemplateCallback,
  ): RegisteredResource | RegisteredResourceTemplate {
    if (typeof uriOrTemplate === "string") {
      const registered = super.registerResource(
        name,
        uriOrTemplate,
        config,
        this.wrapCallback(callback as ReadResourceCallback),
      );
      const update = registered.update.bind(registered);
      registered.update = ((updates: Parameters<RegisteredResource["update"]>[0]) => {
        update({
          ...updates,
          ...(updates.callback ? { callback: this.wrapCallback(updates.callback) } : {}),
        });
      }) as RegisteredResource["update"];
      return registered;
    }

    const registered = super.registerResource(
      name,
      this.wrapResourceTemplate(uriOrTemplate),
      config,
      this.wrapCallback(callback as ReadResourceTemplateCallback),
    );
    const update = registered.update.bind(registered);
    registered.update = ((updates: Parameters<RegisteredResourceTemplate["update"]>[0]) => {
      update({
        ...updates,
        ...(updates.template ? { template: this.wrapResourceTemplate(updates.template) } : {}),
        ...(updates.callback ? { callback: this.wrapCallback(updates.callback) } : {}),
      });
    }) as RegisteredResourceTemplate["update"];
    return registered;
  }

  override registerPrompt<Args extends ZodRawShapeCompat>(
    name: string,
    config: {
      title?: string;
      description?: string;
      argsSchema?: Args;
    },
    callback: PromptCallback<Args>,
  ): RegisteredPrompt {
    const registered = super.registerPrompt(name, config, this.wrapCallback(callback));
    const update = registered.update.bind(registered);
    registered.update = ((updates: Parameters<RegisteredPrompt["update"]>[0]) => {
      update({
        ...updates,
        ...(updates.callback ? { callback: this.wrapCallback(updates.callback) } : {}),
      });
    }) as RegisteredPrompt["update"];
    return registered;
  }

  private wrapResourceTemplate(template: ResourceTemplate): ResourceTemplate {
    const complete: Record<string, CompleteResourceTemplateCallback> = {};
    for (const variable of template.uriTemplate.variableNames) {
      const callback = template.completeCallback(variable);
      if (callback) complete[variable] = this.wrapCallback(callback);
    }
    const list = template.listCallback;
    return new ResourceTemplate(template.uriTemplate, {
      list: list ? this.wrapCallback(list as ListResourcesCallback) : undefined,
      ...(Object.keys(complete).length > 0 ? { complete } : {}),
    });
  }

  private wrapCallback<T extends AnyCallback>(callback: T): T {
    const wrapped = (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
      const possibleExtra = args.at(-1) as { requestId?: unknown } | undefined;
      const id = requestId(possibleExtra?.requestId);
      return this.activity.runApplicationOperation(
        () => callback(...args) as ReturnType<T>,
        id === null ? undefined : id,
      ) as Promise<Awaited<ReturnType<T>>>;
    };
    return wrapped as T;
  }
}
