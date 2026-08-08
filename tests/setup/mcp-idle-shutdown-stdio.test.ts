import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { createMcpHostIdentity } from "../../src/mcp-host-identity.js";
import type { McpIdleShutdownTimer } from "../../src/mcp-idle-shutdown.js";
import {
  MCP_TESTED_PROTOCOL_VERSION,
  runMcpStdioServer,
  type McpStdioLogger,
  type McpStdioSignalSource,
} from "../../src/mcp-stdio-server.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface TimerRecord extends McpIdleShutdownTimer {
  readonly callback: () => void;
  readonly dueAt: number;
  readonly unref: ReturnType<typeof vi.fn>;
  cancelled: boolean;
}

class ManualTimers {
  now = 0;
  readonly records: TimerRecord[] = [];

  readonly set = (callback: () => void, milliseconds: number): TimerRecord => {
    const record: TimerRecord = {
      callback,
      dueAt: this.now + milliseconds,
      unref: vi.fn(),
      cancelled: false,
    };
    this.records.push(record);
    return record;
  };

  readonly clear = (handle: McpIdleShutdownTimer): void => {
    (handle as TimerRecord).cancelled = true;
  };

  async advanceBy(milliseconds: number): Promise<void> {
    this.now += milliseconds;
    for (;;) {
      const due = this.records.find((record) =>
        !record.cancelled && record.dueAt <= this.now
      );
      if (!due) return;
      due.cancelled = true;
      due.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

class JsonLineOutput {
  readonly stream = new PassThrough();
  readonly messages: JSONRPCMessage[] = [];
  private buffer = "";

  constructor() {
    this.stream.setEncoding("utf8");
    this.stream.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) this.messages.push(JSON.parse(line) as JSONRPCMessage);
      }
    });
  }

  async response(id: string | number): Promise<JSONRPCMessage> {
    await vi.waitFor(() => {
      expect(this.messages.some((message) =>
        "id" in message && message.id === id
      )).toBe(true);
    }, { timeout: 15_000 });
    return this.messages.find((message) => "id" in message && message.id === id)!;
  }
}

class BackpressuredOutput extends Writable {
  readonly chunks: Buffer[] = [];
  private pendingWrite: ((error?: Error | null) => void) | null = null;

  constructor() {
    super({ highWaterMark: 1 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    this.pendingWrite = callback;
  }

  hasPendingWrite(): boolean {
    return this.pendingWrite !== null;
  }

  release(): void {
    const callback = this.pendingWrite;
    this.pendingWrite = null;
    callback?.();
  }
}

class StartFailingInput extends PassThrough {
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    if (event === "data") throw new Error("fixture transport start failed");
    return super.on(event, listener);
  }
}

function configuration(root: string, label: string): Config {
  const managedRoot = join(root, label, "observer");
  const profileRoot = join(managedRoot, "profiles");
  const evidenceRoot = join(root, label, "evidence");
  const supportingLogRoot = join(root, label, "logs");
  for (const path of [managedRoot, profileRoot, evidenceRoot, supportingLogRoot]) {
    mkdirSync(path, { recursive: true });
  }
  return {
    workbenchPath: root,
    gamePath: root,
    workbenchAddonDirs: [],
    dataDir: join(repositoryRoot, "data"),
    patternsDir: join(repositoryRoot, "data", "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    mcpIdleShutdownMs: 60_000,
    observer: {
      managedRoot,
      profileRoot,
      evidenceRoots: [evidenceRoot],
      supportingLogRoots: [supportingLogRoot],
      startupTimeoutMs: 10_000,
      requestTimeoutMs: 30_000,
      defaultCaptureTimeoutMs: 30_000,
      maxInlineImageBytes: 8 * 1024 * 1024,
      defaultLossyImageQuality: 75,
      minimumLossyImageQuality: 1,
      maximumLossyImageQuality: 100,
      retentionIntervalMs: 60_000,
      retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
      retentionMaxBytes: 512 * 1024 * 1024,
      sessionTtlMs: 20 * 60 * 1_000,
    },
  };
}

function logger(): McpStdioLogger & { readonly messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (message) => messages.push(`info:${message}`),
    warn: (message) => messages.push(`warn:${message}`),
    error: (message) => messages.push(`error:${message}`),
    debug: (message) => messages.push(`debug:${message}`),
  };
}

function send(input: PassThrough, message: JSONRPCMessage): void {
  input.write(`${JSON.stringify(message)}\n`);
}

function initialize(id: string): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: MCP_TESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "idle-shutdown-fixture", version: "1.0.0" },
    },
  } as JSONRPCMessage;
}

describe.runIf(process.platform === "win32")("CLI stdio idle auto-shutdown composition", () => {
  it("stops only the silent host, including its idle private child, while another host has unsettled protocol work", async () => {
    await withTemporaryDirectory(async (root) => {
      const previousLocalAppData = process.env.LOCALAPPDATA;
      process.env.LOCALAPPDATA = join(root, "localappdata");
      mkdirSync(process.env.LOCALAPPDATA, { recursive: true });

      const idleTimers = new ManualTimers();
      const activeTimers = new ManualTimers();
      const wallOrigin = Date.now() - Math.floor(Math.min(idleTimers.now, activeTimers.now));
      const idleInput = new PassThrough();
      const activeInput = new PassThrough();
      const idleOutput = new JsonLineOutput();
      const activeOutput = new BackpressuredOutput();
      const idleSignals = new EventEmitter() as McpStdioSignalSource & EventEmitter;
      const activeSignals = new EventEmitter() as McpStdioSignalSource & EventEmitter;
      const idleLogger = logger();
      const activeLogger = logger();
      const idleExit = vi.fn();
      const activeExit = vi.fn();

      try {
        await Promise.all([
          runMcpStdioServer({
            config: configuration(root, "idle"),
            hostIdentity: createMcpHostIdentity({
              clientLabel: "idle-fixture",
              instanceId: "11111111-1111-4111-8111-111111111111",
            }),
            stdin: idleInput,
            stdout: idleOutput.stream,
            signals: idleSignals,
            logger: idleLogger,
            nowTick: () => idleTimers.now,
            nowWall: () => new Date(wallOrigin + idleTimers.now),
            setTimer: idleTimers.set,
            clearTimer: idleTimers.clear,
            exit: idleExit,
            setExitCode: vi.fn(),
          }),
          runMcpStdioServer({
            config: configuration(root, "active"),
            hostIdentity: createMcpHostIdentity({
              clientLabel: "active-fixture",
              instanceId: "22222222-2222-4222-8222-222222222222",
            }),
            stdin: activeInput,
            stdout: activeOutput,
            signals: activeSignals,
            logger: activeLogger,
            nowTick: () => activeTimers.now,
            nowWall: () => new Date(wallOrigin + activeTimers.now),
            setTimer: activeTimers.set,
            clearTimer: activeTimers.clear,
            exit: activeExit,
            setExitCode: vi.fn(),
          }),
        ]);

        send(idleInput, initialize("idle-init"));
        const initialized = await idleOutput.response("idle-init");
        expect(initialized).toHaveProperty(
          "result.protocolVersion",
          MCP_TESTED_PROTOCOL_VERSION,
        );
        send(idleInput, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        } as JSONRPCMessage);
        send(idleInput, {
          jsonrpc: "2.0",
          id: "diagnose",
          method: "tools/call",
          params: { name: "wb_diagnose", arguments: {} },
        } as JSONRPCMessage);
        const diagnosis = JSON.stringify(await idleOutput.response("diagnose"));
        expect(diagnosis.match(/11111111-1111-4111-8111-111111111111/g)).toHaveLength(2);
        expect(diagnosis).toContain("**Mode:** monitoring");
        expect(diagnosis).toContain("**Idle shutdown:** 60000 ms");

        send(idleInput, {
          jsonrpc: "2.0",
          id: "observer-instances",
          method: "tools/call",
          params: {
            name: "observer_instances",
            arguments: {},
          },
        } as JSONRPCMessage);
        const observerInstances = await idleOutput.response("observer-instances");
        const renderedInstances = JSON.stringify(observerInstances);
        expect(observerInstances).toHaveProperty("result");
        expect(renderedInstances).toContain("Observer instance inventory");
        expect(renderedInstances).not.toContain("runtime observer unavailable");

        send(activeInput, initialize("active-init"));
        await vi.waitFor(() => expect(activeOutput.hasPendingWrite()).toBe(true));

        await Promise.all([
          idleTimers.advanceBy(60_000),
          activeTimers.advanceBy(60_000),
        ]);
        await vi.waitFor(() => {
          expect(idleLogger.messages).toContain(
            "info:ReforgerForge MCP server stopped (idle timeout)"
          );
        }, { timeout: 15_000 });

        expect(idleExit).not.toHaveBeenCalled();
        expect(activeExit).not.toHaveBeenCalled();
        expect(activeLogger.messages).not.toContain(
          "info:ReforgerForge MCP server stopped (idle timeout)"
        );
        expect(activeOutput.hasPendingWrite()).toBe(true);

        activeOutput.release();
        activeSignals.emit("SIGTERM");
        activeInput.end();
        await vi.waitFor(() => {
          expect(activeLogger.messages).toContain(
            "info:ReforgerForge MCP server stopped (SIGTERM)"
          );
        }, { timeout: 15_000 });
        expect(activeLogger.messages.filter((message) =>
          message.includes("ReforgerForge MCP server stopped")
        )).toHaveLength(1);
      } finally {
        activeOutput.release();
        idleSignals.emit("SIGTERM");
        activeSignals.emit("SIGTERM");
        idleInput.destroy();
        activeInput.destroy();
        idleOutput.stream.destroy();
        activeOutput.destroy();
        if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = previousLocalAppData;
      }
    }, { prefix: "rfo-mcp-idle-stdio-" });
  }, 30_000);

  it("treats startup-time stdin EOF as immediate coalesced shutdown", async () => {
    await withTemporaryDirectory(async (root) => {
      const previousLocalAppData = process.env.LOCALAPPDATA;
      process.env.LOCALAPPDATA = join(root, "localappdata");
      mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
      const timers = new ManualTimers();
      const input = new PassThrough();
      const output = new JsonLineOutput();
      const signals = new EventEmitter() as McpStdioSignalSource & EventEmitter;
      const messages = logger();
      const exit = vi.fn();
      input.end();

      try {
        await runMcpStdioServer({
          config: configuration(root, "eof"),
          hostIdentity: createMcpHostIdentity({
            clientLabel: "eof-fixture",
            instanceId: "33333333-3333-4333-8333-333333333333",
          }),
          stdin: input,
          stdout: output.stream,
          signals,
          logger: messages,
          nowTick: () => timers.now,
          nowWall: () => new Date(),
          setTimer: timers.set,
          clearTimer: timers.clear,
          exit,
          setExitCode: vi.fn(),
        });
        await vi.waitFor(() => {
          expect(messages.messages).toContain(
            "info:ReforgerForge MCP server stopped (stdin EOF)"
          );
        });
        expect(messages.messages.some((message) =>
          message.includes("idle shutdown committed")
        )).toBe(false);
        expect(exit).not.toHaveBeenCalled();
        expect(timers.records.every((record) => record.cancelled)).toBe(true);
      } finally {
        signals.emit("SIGTERM");
        input.destroy();
        output.stream.destroy();
        if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = previousLocalAppData;
      }
    }, { prefix: "rfo-mcp-eof-stdio-" });
  }, 15_000);

  it("cleans up through the immediate path when transport startup fails", async () => {
    await withTemporaryDirectory(async (root) => {
      const input = new StartFailingInput();
      const output = new JsonLineOutput();
      const signals = new EventEmitter() as McpStdioSignalSource & EventEmitter;
      const timers = new ManualTimers();
      const messages = logger();
      const exit = vi.fn();
      const setExitCode = vi.fn();

      try {
        await expect(runMcpStdioServer({
          config: configuration(root, "startup-failure"),
          hostIdentity: createMcpHostIdentity({
            clientLabel: "startup-failure-fixture",
            instanceId: "44444444-4444-4444-8444-444444444444",
          }),
          stdin: input,
          stdout: output.stream,
          signals,
          logger: messages,
          nowTick: () => timers.now,
          nowWall: () => new Date(),
          setTimer: timers.set,
          clearTimer: timers.clear,
          exit,
          setExitCode,
        })).rejects.toThrow("fixture transport start failed");
        expect(messages.messages).toContain(
          "info:ReforgerForge MCP server stopped (startup failure)"
        );
        expect(signals.listenerCount("SIGINT")).toBe(0);
        expect(signals.listenerCount("SIGTERM")).toBe(0);
        expect(exit).not.toHaveBeenCalled();
        expect(setExitCode).not.toHaveBeenCalled();
        expect(timers.records.every((record) => record.cancelled)).toBe(true);
      } finally {
        signals.emit("SIGTERM");
        input.destroy();
        output.stream.destroy();
      }
    }, { prefix: "rfo-mcp-start-failure-" });
  }, 15_000);
});
