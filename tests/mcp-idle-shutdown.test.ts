import { describe, expect, it, vi } from "vitest";
import { McpProtocolActivity } from "../src/mcp-activity-transport.js";
import { McpHostAdmissionGate } from "../src/mcp-host-admission.js";
import { createMcpHostIdentity } from "../src/mcp-host-identity.js";
import {
  McpIdleShutdownController,
  externallyManagedMcpLifecycleDiagnostic,
  type McpIdleShutdownTimer,
} from "../src/mcp-idle-shutdown.js";
import type { IdleShutdownReadiness } from "../src/mcp-idle-readiness.js";

interface TimerRecord extends McpIdleShutdownTimer {
  readonly callback: () => void;
  readonly at: number;
  readonly unref: ReturnType<typeof vi.fn>;
  cancelled: boolean;
}

class ManualTimers {
  now = 0;
  readonly timers: TimerRecord[] = [];
  set = (callback: () => void, milliseconds: number): TimerRecord => {
    const timer: TimerRecord = {
      callback,
      at: this.now + milliseconds,
      unref: vi.fn(),
      cancelled: false,
    };
    this.timers.push(timer);
    return timer;
  };
  clear = (timer: McpIdleShutdownTimer): void => {
    (timer as TimerRecord).cancelled = true;
  };
  async advanceBy(milliseconds: number): Promise<void> {
    this.now += milliseconds;
    for (;;) {
      const due = this.timers.find((timer) => !timer.cancelled && timer.at <= this.now);
      if (!due) break;
      due.cancelled = true;
      due.callback();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
  activeCount(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

const hostIdentity = createMcpHostIdentity({
  clientLabel: "codex",
  instanceId: "00112233-4455-4677-8899-aabbccddeeff",
  startedAt: "2026-08-05T12:00:00.000Z",
});

function harness(
  inspect?: (gate: McpHostAdmissionGate, signal: AbortSignal) => Promise<IdleShutdownReadiness>,
  options: { readonly nowWall?: () => Date } = {},
) {
  const time = new ManualTimers();
  const activity = new McpProtocolActivity({
    nowTick: () => time.now,
    nowWall: options.nowWall ?? (() => new Date("2026-08-05T12:00:00.000Z")),
  });
  activity.start();
  const gate = new McpHostAdmissionGate();
  const shutdown = vi.fn(async () => undefined);
  const readiness = {
    inspectIdleShutdownReadiness: vi.fn(async ({ signal }: { signal: AbortSignal }) =>
      inspect
        ? inspect(gate, signal)
        : {
            complete: true,
            blockers: [],
            probeGeneration: 1,
            sealProof: gate.issueIdleSealProof([]),
          }),
    trySealIdleAdmissions: (proof: Parameters<McpHostAdmissionGate["trySealIdleAdmissions"]>[0]) =>
      gate.trySealIdleAdmissions(proof),
  };
  const controller = new McpIdleShutdownController({
    hostIdentity,
    idleShutdownMs: 60_000,
    activity,
    readiness,
    shutdown,
    nowTick: () => time.now,
    setTimer: time.set,
    clearTimer: time.clear,
  });
  return { time, activity, gate, shutdown, readiness, controller };
}

describe("MCP idle shutdown controller", () => {
  it("commits exactly once after the complete epoch/revision/admission proof", async () => {
    const value = harness();
    value.controller.start();
    expect(value.time.activeCount()).toBe(1);
    expect(value.time.timers[0]!.unref).toHaveBeenCalledOnce();

    await value.time.advanceBy(60_000);
    await vi.waitFor(() => expect(value.shutdown).toHaveBeenCalledOnce());
    expect(value.shutdown).toHaveBeenCalledWith("idle timeout");
    expect(value.gate.snapshot().state).toBe("sealed");
    expect(value.activity.snapshot().inboundDispatchSealed).toBe(true);
    expect(value.controller.diagnostic()).toMatchObject({
      state: "shutdown_committed",
      readinessComplete: true,
      activeRequestCount: 0,
    });
    await value.time.advanceBy(120_000);
    expect(value.shutdown).toHaveBeenCalledOnce();
  });

  it("retains inactivity and rechecks blocked or incomplete readiness without sealing", async () => {
    const value = harness(async () => ({
      complete: false,
      blockers: ["INCOMPLETE_PROOF"],
      probeGeneration: 1,
      sealProof: null,
    }));
    value.controller.start();
    await value.time.advanceBy(60_000);
    expect(value.shutdown).not.toHaveBeenCalled();
    expect(value.gate.snapshot().state).toBe("open");
    expect(value.activity.snapshot().inboundDispatchSealed).toBe(false);
    expect(value.controller.diagnostic()).toMatchObject({
      state: "blocked",
      readinessComplete: false,
      blockerCodes: ["INCOMPLETE_PROOF"],
    });
    expect(value.time.timers.find((timer) => !timer.cancelled)?.at).toBe(90_000);
  });

  it("discards a proof when activity arrives during the asynchronous scan", async () => {
    let finish!: (value: IdleShutdownReadiness) => void;
    const pending = new Promise<IdleShutdownReadiness>((resolve) => { finish = resolve; });
    const value = harness(async () => pending);
    value.controller.start();
    await value.time.advanceBy(60_000);
    expect(value.controller.diagnostic().state).toBe("checking");
    value.activity.receive({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    finish({
      complete: true,
      blockers: [],
      probeGeneration: 1,
      sealProof: value.gate.issueIdleSealProof([]),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(value.shutdown).not.toHaveBeenCalled();
    expect(value.controller.diagnostic().state).toBe("monitoring");
    expect(value.time.timers.find((timer) => !timer.cancelled)?.at).toBe(120_000);
  });

  it("gives activity at the deadline a full new interval", async () => {
    const value = harness();
    value.controller.start();
    value.time.now = 60_000;
    value.activity.receive({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    await value.time.advanceBy(0);
    expect(value.shutdown).not.toHaveBeenCalled();
    expect(value.time.timers.find((timer) => !timer.cancelled)?.at).toBe(120_000);

    await value.time.advanceBy(59_999);
    expect(value.shutdown).not.toHaveBeenCalled();
    await value.time.advanceBy(1);
    await vi.waitFor(() => expect(value.shutdown).toHaveBeenCalledOnce());
  });

  it("waits for an active application operation and then grants a full interval", async () => {
    const value = harness();
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const active = value.activity.runApplicationOperation(() => work);
    value.controller.start();

    await value.time.advanceBy(60_000);
    expect(value.shutdown).not.toHaveBeenCalled();
    expect(value.time.activeCount()).toBe(0);

    finish();
    await active;
    expect(value.time.timers.find((timer) => !timer.cancelled)?.at).toBe(120_000);
    await value.time.advanceBy(60_000);
    await vi.waitFor(() => expect(value.shutdown).toHaveBeenCalledOnce());
  });

  it("holds an outbound server request through the deadline until its client result", async () => {
    const value = harness();
    value.activity.beginSend({
      jsonrpc: "2.0",
      id: "server-request",
      method: "roots/list",
      params: {},
    }).complete(true);
    value.controller.start();

    await value.time.advanceBy(60_000);
    expect(value.shutdown).not.toHaveBeenCalled();
    expect(value.activity.snapshot().serverRequestCount).toBe(1);

    value.activity.receive({
      jsonrpc: "2.0",
      id: "server-request",
      result: { roots: [] },
    });
    expect(value.activity.snapshot().serverRequestCount).toBe(0);
    expect(value.time.timers.find((timer) => !timer.cancelled)?.at).toBe(120_000);
    await value.time.advanceBy(60_000);
    await vi.waitFor(() => expect(value.shutdown).toHaveBeenCalledOnce());
  });

  it("leaves both gates open when a proof becomes revision-stale or generation-mismatched", async () => {
    const value = harness(async (gate) => {
      const proof = gate.issueIdleSealProof([]);
      const token = gate.acquire("race");
      token.release();
      return { complete: true, blockers: [], probeGeneration: 1, sealProof: proof };
    });
    value.controller.start();
    await value.time.advanceBy(60_000);
    expect(value.shutdown).not.toHaveBeenCalled();
    expect(value.gate.snapshot().state).toBe("open");
    expect(value.activity.snapshot().inboundDispatchSealed).toBe(false);
    expect(value.controller.diagnostic()).toMatchObject({
      state: "blocked",
      blockerCodes: ["INCOMPLETE_PROOF"],
    });

    const staleGeneration = harness(async (gate) => ({
      complete: true,
      blockers: [],
      probeGeneration: 0,
      sealProof: gate.issueIdleSealProof([]),
    }));
    staleGeneration.controller.start();
    await staleGeneration.time.advanceBy(60_000);
    expect(staleGeneration.shutdown).not.toHaveBeenCalled();
    expect(staleGeneration.gate.snapshot().state).toBe("open");
    expect(staleGeneration.activity.snapshot().inboundDispatchSealed).toBe(false);
  });

  it("blocks a sticky indeterminate completion without invoking readiness", async () => {
    const turns: Array<() => void> = [];
    const time = new ManualTimers();
    const activity = new McpProtocolActivity({
      nowTick: () => time.now,
      scheduleTurn: (callback) => turns.push(callback),
    });
    activity.start();
    activity.receive({ jsonrpc: "2.0", id: "raw", method: "custom/raw", params: {} });
    turns[0]!();
    const inspect = vi.fn();
    const controller = new McpIdleShutdownController({
      hostIdentity,
      idleShutdownMs: 60_000,
      activity,
      readiness: { inspectIdleShutdownReadiness: inspect, trySealIdleAdmissions: () => false },
      shutdown: vi.fn(),
      nowTick: () => time.now,
      setTimer: time.set,
      clearTimer: time.clear,
    });
    controller.start();
    await time.advanceBy(60_000);
    expect(inspect).not.toHaveBeenCalled();
    expect(controller.diagnostic()).toMatchObject({
      state: "blocked",
      blockerCodes: ["REQUEST_COMPLETION_INDETERMINATE"],
    });
  });

  it("uses monotonic elapsed time and permanently cancels its single timer", async () => {
    const value = harness();
    value.controller.start();
    const before = value.controller.diagnostic();
    expect(before.lastActivityAt).toBe("2026-08-05T12:00:00.000Z");
    expect(before.eligibleAt).toBe("2026-08-05T12:01:00.000Z");
    value.controller.cancel("stdin EOF");
    expect(value.time.activeCount()).toBe(0);
    await value.time.advanceBy(600_000);
    expect(value.shutdown).not.toHaveBeenCalled();
  });

  it("ignores forward and backward wall-clock jumps for eligibility", async () => {
    for (const jumpedWall of [
      "2036-08-05T12:00:00.000Z",
      "2016-08-05T12:00:00.000Z",
    ]) {
      let wall = new Date("2026-08-05T12:00:00.000Z");
      const value = harness(undefined, { nowWall: () => wall });
      value.controller.start();
      wall = new Date(jumpedWall);
      await value.time.advanceBy(59_999);
      expect(value.shutdown, jumpedWall).not.toHaveBeenCalled();
      await value.time.advanceBy(1);
      await vi.waitFor(() => expect(value.shutdown).toHaveBeenCalledOnce());
    }
  });

  it("rejects disable-like and out-of-range programmatic intervals", () => {
    const base = harness();
    for (const idleShutdownMs of [0, -1, 59_999, 60_000.5, 86_400_001]) {
      expect(() => new McpIdleShutdownController({
        hostIdentity,
        idleShutdownMs,
        activity: base.activity,
        readiness: base.readiness,
        shutdown: vi.fn(),
      })).toThrow(/integer from 60000 through 86400000/);
    }
  });

  it("reports embedders without synthetic activity or eligibility", () => {
    expect(externallyManagedMcpLifecycleDiagnostic(hostIdentity, 1_800_000)).toEqual({
      schemaVersion: 1,
      instanceId: hostIdentity.instanceId,
      idleShutdownMs: 1_800_000,
      state: "externally_managed",
      activeRequestCount: null,
      lastActivityAt: null,
      eligibleAt: null,
      readinessComplete: null,
      blockerCodes: [],
    });
  });
});
