import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { redactText } from "#foundation/redact";
import type { McpHostAdmissionGate } from "../mcp-host-admission.js";
import type {
  IdleShutdownInspectionOptions,
  McpIdleProviderReadiness,
  McpIdleReadinessProvider,
} from "../mcp-idle-readiness.js";
import { logger } from "../utils/logger.js";
import { canonicalPublicObserverErrorCode } from "./public-contract.js";
import { ObserverApplicationError } from "./errors.js";

const CHILD_PROTOCOL = "rfo-observer-child-v1" as const;

export interface ObserverChildDescriptor {
  protocolVersion: string;
  agentVersion: string;
  agentInstanceId: string;
  host: "127.0.0.1" | "::1";
  port: number;
  controlHttpEnabled?: boolean;
  controlToken?: string;
}

export interface ObserverAgentClientRequestOptions {
  /** Absolute wall-clock deadline. */
  deadlineAtMs?: number;
  signal?: AbortSignal;
  /** Compatibility shortcut for callers that still provide a relative bound. */
  timeoutMs?: number;
  allowClosing?: boolean;
}

export interface ObserverAgentClientOptions {
  agentPath: string;
  arguments?: readonly string[];
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Optional absolute cap shared by startup and every ordinary request. */
  requestDeadlineAtMs?: () => number | undefined;
  forkChild?: typeof fork;
  admissionGate?: McpHostAdmissionGate;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
  signal?: AbortSignal;
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError(`${label} is invalid`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function redactChildLine(value: string): string {
  return redactText(value, { profile: "diagnostic", maxLength: 1_024 });
}

function abortError(): ObserverApplicationError {
  return new ObserverApplicationError("CANCELLED", "Observer request was cancelled");
}

/** Fork/request lifecycle only. No observer domain policy belongs here. */
export class ObserverAgentClient implements McpIdleReadinessProvider {
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly requestDeadlineAtMs: (() => number | undefined) | undefined;
  private readonly spawnChild: typeof fork;
  private readonly argumentsArray: string[];
  private readonly admissionGate: McpHostAdmissionGate | undefined;
  private readonly liveChildren = new Set<ChildProcess>();
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcess | null = null;
  private descriptor: ObserverChildDescriptor | null = null;
  private startPromise: Promise<ObserverChildDescriptor> | null = null;
  private rejectStartup: ((error: Error) => void) | null = null;
  private closed = false;
  private closing = false;
  private emergencyTerminated = false;
  private closePromise: Promise<void> | null = null;
  private idleRevision = 0;

  constructor(private readonly options: ObserverAgentClientOptions) {
    this.startupTimeoutMs = bounded(options.startupTimeoutMs, 10_000, 1_000, 60_000, "Observer startup timeout");
    this.requestTimeoutMs = bounded(options.requestTimeoutMs, 30_000, 1_000, 5 * 60_000, "Observer request timeout");
    this.requestDeadlineAtMs = options.requestDeadlineAtMs;
    this.spawnChild = options.forkChild ?? fork;
    this.argumentsArray = [...(options.arguments ?? [])];
    this.admissionGate = options.admissionGate;
  }

  diagnosticPrivateChildCount(): number { return this.liveChildren.size; }
  /** Narrow compatibility hook for host recovery tests; transport still owns the child. */
  get childProcess(): ChildProcess | null { return this.child; }
  get descriptorValue(): ObserverChildDescriptor | null { return this.descriptor; }
  get state(): "closed" | "closing" | "starting" | "ready" | "idle" { return this.closed ? "closed" : this.closing ? "closing" : this.startPromise ? "starting" : this.descriptor ? "ready" : "idle"; }

  async ensureStarted(deadlineAtMs?: number): Promise<ObserverChildDescriptor> {
    if (this.admissionGate) {
      return this.admissionGate.run("observer private child startup", () =>
        this.ensureStartedInternal(deadlineAtMs));
    }
    return this.ensureStartedInternal(deadlineAtMs);
  }

  private async ensureStartedInternal(deadlineAtMs?: number): Promise<ObserverChildDescriptor> {
    if (this.closed || this.closing) throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Observer agent is shutting down");
    const hardDeadline = this.hardDeadline();
    const deadline = deadlineAtMs === undefined
      ? hardDeadline
      : hardDeadline === undefined ? deadlineAtMs : Math.min(deadlineAtMs, hardDeadline);
    const remaining = deadline === undefined ? this.startupTimeoutMs : deadline - Date.now();
    if (remaining <= 0) {
      throw new ObserverApplicationError(
        "TRANSPORT_UNAVAILABLE",
        "Private observer agent startup deadline expired"
      );
    }
    if (this.child?.connected && this.descriptor) return this.descriptor;
    if (this.startPromise) return this.waitForStartup(this.startPromise, deadline);
    const child = this.spawnChild(this.options.agentPath, this.argumentsArray, {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
      env: { ...process.env },
      serialization: "advanced",
    });
    this.bumpIdleRevision();
    this.liveChildren.add(child);
    this.child = child;
    this.descriptor = null;
    this.attachChild(child);
    this.startPromise = new Promise<ObserverChildDescriptor>((resolve, reject) => {
      this.rejectStartup = reject;
      const timer = setTimeout(() => {
        if (this.child === child && !this.descriptor) {
          reject(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Private observer agent did not become ready before the startup deadline"));
          // Do not decrement live-child accounting here. The exit event is the
          // only authoritative proof that the child is gone.
          child.kill();
        }
      }, Math.min(this.startupTimeoutMs, remaining));
      timer.unref();
      const ready = (message: unknown): void => {
        if (!isRecord(message) || message.protocol !== CHILD_PROTOCOL || message.type !== "ready") return;
        try {
          const descriptor = this.parseDescriptor(message.descriptor);
          clearTimeout(timer);
          child.off("message", ready);
          this.bumpIdleRevision();
          this.descriptor = descriptor;
          this.rejectStartup = null;
          resolve(descriptor);
        } catch (error) {
          clearTimeout(timer);
          child.off("message", ready);
          reject(error instanceof Error ? error : new Error(String(error)));
          child.kill();
        }
      };
      child.on("message", ready);
    }).finally(() => { this.startPromise = null; });
    return this.waitForStartup(this.startPromise, deadline);
  }

  /** Send only to the currently ready child; never starts or replaces one. */
  async requestIfReady(
    operation: string,
    payload: Record<string, unknown> = {},
    options: ObserverAgentClientRequestOptions = {}
  ): Promise<unknown> {
    if (this.admissionGate) {
      return this.admissionGate.run("observer ready-child request", () =>
        this.requestIfReadyInternal(operation, payload, options));
    }
    return this.requestIfReadyInternal(operation, payload, options);
  }

  private async requestIfReadyInternal(
    operation: string,
    payload: Record<string, unknown>,
    options: ObserverAgentClientRequestOptions,
  ): Promise<unknown> {
    if (this.closed || this.closing) throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Observer agent is unavailable");
    const child = this.child;
    if (!child?.connected || !this.descriptor) throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Private observer agent is not ready");
    return this.sendRequest(child, operation, payload, {
      ...options,
      deadlineAtMs: this.requestDeadline(options),
    });
  }

  async request(
    operation: string,
    payload: Record<string, unknown> = {},
    options: ObserverAgentClientRequestOptions = {}
  ): Promise<unknown> {
    if (this.admissionGate && !options.allowClosing) {
      return this.admissionGate.run("observer private child request", () =>
        this.requestInternal(operation, payload, options));
    }
    return this.requestInternal(operation, payload, options);
  }

  private async requestInternal(
    operation: string,
    payload: Record<string, unknown>,
    options: ObserverAgentClientRequestOptions,
  ): Promise<unknown> {
    if (!options.allowClosing && (this.closed || this.closing)) throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Observer agent is unavailable");
    const deadlineAtMs = this.requestDeadline(options);
    if (!options.allowClosing) await this.ensureStartedInternal(deadlineAtMs);
    const child = this.child;
    if (!child?.connected) throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Private observer agent is unavailable");
    return this.sendRequest(child, operation, payload, { ...options, deadlineAtMs });
  }

  async close(): Promise<void> {
    if (this.admissionGate) {
      return this.admissionGate.runPrivilegedCleanup(() => this.closeInternal());
    }
    return this.closeInternal();
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.bumpIdleRevision();
    this.closing = true;
    this.closePromise = (async () => {
      const child = this.child;
      if (!child) return;
      try {
        if (child.connected && this.descriptor) {
          await this.request("shutdown", {}, { timeoutMs: 2_000, allowClosing: true }).catch(() => undefined);
        } else if (child.connected) child.disconnect();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          const timer = setTimeout(() => {
            child.removeListener("exit", exited);
            if (child.connected) child.disconnect();
            child.kill();
            resolve();
          }, 2_000);
          timer.unref();
          const exited = (): void => { clearTimeout(timer); resolve(); };
          child.once("exit", exited);
        });
      } finally {
        this.bumpIdleRevision();
        this.child = null;
        this.descriptor = null;
        this.rejectAll(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Observer agent stopped"));
      }
    })().finally(() => {
      this.bumpIdleRevision();
      this.closed = true;
      this.closing = false;
    });
    return this.closePromise;
  }

  /**
   * CLI crash-path only. This synchronously severs every disposable private
   * child tracked by this client, including a child still in its ready
   * handshake. It deliberately publishes no clean observer/runtime state.
   */
  emergencyTerminatePrivateChildren(): void {
    if (this.emergencyTerminated) return;
    this.bumpIdleRevision();
    this.emergencyTerminated = true;
    this.closing = true;
    const error = new ObserverApplicationError(
      "TRANSPORT_UNAVAILABLE",
      "Observer agent was terminated by the MCP emergency shutdown path",
    );
    this.rejectStartup?.(error);
    this.rejectStartup = null;
    this.rejectAll(error);
    for (const child of [...this.liveChildren]) {
      try { if (child.connected) child.disconnect(); } catch { /* crash-path best effort */ }
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } catch { /* crash-path best effort */ }
    }
    this.child = null;
    this.descriptor = null;
  }

  private attachChild(child: ChildProcess): void {
    let stderrBuffer = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-8_192);
      for (;;) {
        const newline = stderrBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stderrBuffer.slice(0, newline).trim();
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line) logger.warn(`observer child: ${redactChildLine(line)}`);
      }
    });
    child.on("message", (message: unknown) => this.onMessage(message));
    child.once("error", (error) => {
      this.bumpIdleRevision();
      if (child.pid === undefined) this.liveChildren.delete(child);
      if (this.child !== child) return;
      this.rejectStartup?.(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", redactText(`Private observer agent failed: ${error.message}`, { profile: "diagnostic", maxLength: 1_024 })));
      this.descriptor = null;
      this.rejectAll(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Private observer agent became unavailable"));
      child.kill();
    });
    child.once("exit", (code, signal) => {
      this.bumpIdleRevision();
      this.liveChildren.delete(child);
      if (this.child !== child) return;
      if (stderrBuffer.trim()) logger.warn(`observer child: ${redactChildLine(stderrBuffer.trim())}`);
      this.child = null;
      this.descriptor = null;
      const detail = code === 0 || this.closing ? "Private observer agent stopped" : `Private observer agent exited (${code ?? signal ?? "unknown"})`;
      const error = new ObserverApplicationError("TRANSPORT_UNAVAILABLE", detail);
      this.rejectStartup?.(error);
      this.rejectStartup = null;
      this.rejectAll(error);
    });
  }

  private onMessage(message: unknown): void {
    if (!isRecord(message) || message.protocol !== CHILD_PROTOCOL) return;
    if (message.type === "fatal") {
      const error = isRecord(message.error) ? message.error : {};
      this.rejectStartup?.(new ObserverApplicationError(
        canonicalPublicObserverErrorCode(error.code, "TRANSPORT_UNAVAILABLE"),
        typeof error.message === "string" ? redactChildLine(error.message) : "Private observer agent failed during startup"
      ));
      this.rejectStartup = null;
      this.child?.kill();
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.bumpIdleRevision();
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
    if (message.ok === true) pending.resolve(message.result);
    else {
      const error = isRecord(message.error) ? message.error : {};
      pending.reject(new ObserverApplicationError(
        canonicalPublicObserverErrorCode(error.code),
        typeof error.message === "string" ? redactChildLine(error.message) : "Observer operation failed"
      ));
    }
  }

  private sendRequest(child: ChildProcess, operation: string, payload: Record<string, unknown>, options: ObserverAgentClientRequestOptions): Promise<unknown> {
    if (!child.connected) return Promise.reject(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Private observer agent is unavailable"));
    const deadlineAtMs = options.deadlineAtMs ?? Date.now() + (options.timeoutMs ?? this.requestTimeoutMs);
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) return Promise.reject(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", `Observer ${operation} request deadline expired`));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let abort: (() => void) | undefined;
      const finish = (error?: Error, result?: unknown): void => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.bumpIdleRevision();
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", `Observer ${operation} request timed out`)), remaining);
      timer.unref();
      abort = () => finish(abortError());
      const pending: PendingRequest = { resolve, reject, timer, abort, signal: options.signal };
      this.bumpIdleRevision();
      this.pending.set(requestId, pending);
      if (options.signal) {
        if (options.signal.aborted) return finish(abortError());
        options.signal.addEventListener("abort", abort, { once: true });
      }
      child.send({ protocol: CHILD_PROTOCOL, type: "request", requestId, operation, payload }, (error) => {
        if (error) finish(new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Could not send a private observer request"));
      });
    });
  }

  private hardDeadline(): number | undefined {
    const deadline = this.requestDeadlineAtMs?.();
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= 0)) {
      throw new TypeError("Observer absolute request deadline is invalid");
    }
    return deadline;
  }

  private requestDeadline(options: ObserverAgentClientRequestOptions): number {
    const now = Date.now();
    const requested = options.deadlineAtMs ?? now + (options.timeoutMs ?? this.requestTimeoutMs);
    const hard = this.hardDeadline();
    return hard === undefined ? requested : Math.min(requested, hard);
  }

  private async waitForStartup(
    started: Promise<ObserverChildDescriptor>,
    deadlineAtMs: number | undefined
  ): Promise<ObserverChildDescriptor> {
    if (deadlineAtMs === undefined) return started;
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) {
      throw new ObserverApplicationError(
        "TRANSPORT_UNAVAILABLE",
        "Private observer agent startup deadline expired"
      );
    }
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ObserverApplicationError(
          "TRANSPORT_UNAVAILABLE",
          "Private observer agent did not become ready before the absolute request deadline"
        )), remaining);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private parseDescriptor(value: unknown): ObserverChildDescriptor {
    if (!isRecord(value) || typeof value.protocolVersion !== "string" || !/^1\.\d+$/.test(value.protocolVersion) ||
        typeof value.agentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.agentVersion) ||
        typeof value.agentInstanceId !== "string" || value.agentInstanceId.length < 1 || value.agentInstanceId.length > 96 ||
        (value.host !== "127.0.0.1" && value.host !== "::1") ||
        !Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) {
      throw new ObserverApplicationError("TRANSPORT_UNAVAILABLE", "Private observer agent returned an invalid startup descriptor");
    }
    return value as unknown as ObserverChildDescriptor;
  }

  private rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.abort && pending.signal) pending.signal.removeEventListener("abort", pending.abort);
      pending.reject(error);
      this.bumpIdleRevision();
      this.pending.delete(requestId);
    }
  }

  currentIdleRevision(): number {
    return this.idleRevision;
  }

  async inspectIdleShutdownReadiness(
    options: IdleShutdownInspectionOptions,
  ): Promise<McpIdleProviderReadiness> {
    const currentIsSoleReady = this.liveChildren.size === 1 &&
      this.child !== null && this.liveChildren.has(this.child) &&
      this.child.connected && this.descriptor !== null && !this.startPromise && !this.closing;
    const childBlocks = this.startPromise !== null || this.closing || this.pending.size > 0 ||
      (this.liveChildren.size > 0 && !currentIsSoleReady);
    const expired = options.signal.aborted || performance.now() > options.deadlineTick;
    return {
      complete: !expired,
      blockers: childBlocks ? ["OBSERVER_CHILD"] : [],
      revision: this.idleRevision,
    };
  }

  private bumpIdleRevision(): void {
    if (this.idleRevision === Number.MAX_SAFE_INTEGER) throw new Error("Observer agent idle revision exhausted");
    this.idleRevision += 1;
  }
}

export {
  ObserverApplicationError,
  ObserverApplicationError as ObserverCoordinatorError,
} from "./errors.js";
