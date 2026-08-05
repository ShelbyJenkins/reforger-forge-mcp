import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { WorkbenchLifecycleExecution } from "../../src/workbench/lifecycle-execution.js";
import {
  WorkbenchSessionController,
} from "../../src/workbench/session-controller.js";
import type { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";
import {
  WorkbenchNetApiError,
  type WorkbenchNetApiCallOptions,
  type WorkbenchNetApiPort,
} from "../../src/workbench/net-api-client.js";

class StubNetApi implements WorkbenchNetApiPort {
  readonly calls: Array<{
    apiFunc: string;
    params: Record<string, unknown>;
    options: WorkbenchNetApiCallOptions | undefined;
  }> = [];

  constructor(
    private readonly response: Record<string, unknown> | Error
  ) {}

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options?: WorkbenchNetApiCallOptions
  ): Promise<T> {
    this.calls.push({ apiFunc, params, options });
    if (this.response instanceof Error) throw this.response;
    return this.response as T;
  }
}

describe("WorkbenchSessionController public contract", () => {
  it("projects exact current/foreign/legacy Workbench ownership without mutation", async () => {
    const current = "11111111-1111-4111-8111-111111111111";
    const foreign = "22222222-2222-4222-8222-222222222222";
    const workbench = {
      pid: 44,
      executablePath: "C:\\Workbench.exe",
      creationTime: "444",
      ownerTokenArgument: "-reforgerForgeOwnerToken=fixture",
      launchedAtMs: 1,
    };
    let owner = current;
    let legacyJournal = false;
    const inspectOwnedWorkbench = vi.fn(async () => "live" as const);
    const guard = {
      mcpInstanceId: current,
      readLifecycleStateExistingOnly: async () => ({
        kind: "valid" as const,
        state: {
          phase: "running",
          mcpOwner: { instanceId: owner },
          workbench,
          operation: null,
        },
      }),
      readSpawnJournalExistingOnly: async () => legacyJournal
        ? ({
            kind: "valid" as const,
            generation: "journal",
            record: {
              phase: "pre_spawn",
              metadata: {},
            },
          })
        : ({ kind: "missing" as const }),
      inspectOwnedWorkbench,
    } as unknown as WorkbenchProcessGuard;
    const controller = new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      undefined,
      "idle-readiness",
      guard,
      { netApi: new StubNetApi({}) },
    );
    const inspect = () => controller.inspectIdleShutdownReadiness({
      deadlineTick: performance.now() + 1_000,
      signal: new AbortController().signal,
      probeGeneration: 1,
    });

    await expect(inspect()).resolves.toMatchObject({ blockers: ["WORKBENCH_OWNERSHIP"] });
    owner = foreign;
    await expect(inspect()).resolves.toMatchObject({ complete: true, blockers: [] });
    expect(inspectOwnedWorkbench).toHaveBeenCalledTimes(1);
    legacyJournal = true;
    await expect(inspect()).resolves.toMatchObject({ blockers: ["WORKBENCH_RECOVERY"] });
  });

  it("keeps WorkbenchClient as the stable compatibility constructor", () => {
    expect(WorkbenchClient).toBe(WorkbenchSessionController);
  });

  it("delegates transport-only calls through the injected NET port and caches mode", async () => {
    const netApi = new StubNetApi({ status: "ok", mode: "edit", count: 2 });
    const controller = new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      undefined,
      "controller-contract",
      undefined,
      { netApi }
    );

    await expect(controller.call("EMCP_WB_ListEntities", { limit: 2 }, {
      timeout: 321,
      skipAutoLaunch: true,
    })).resolves.toMatchObject({ status: "ok", count: 2 });
    expect(netApi.calls).toEqual([{
      apiFunc: "EMCP_WB_ListEntities",
      params: { limit: 2 },
      options: { timeoutMs: 321 },
    }]);
    expect(controller.state).toMatchObject({ connected: true, mode: "edit" });
  });

  it("re-clamps a stale relative timeout at the final NET transport boundary", async () => {
    const netApi = new StubNetApi({ status: "ok" });
    let now = 1_000;
    const controller = new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      undefined,
      "controller-deadline-contract",
      undefined,
      {
        netApi,
        now: () => now,
        requestDeadlineAtMs: () => 1_300,
      }
    );

    now = 1_175;
    await controller.call("EMCP_WB_GetState", {}, {
      timeout: 500,
      skipAutoLaunch: true,
    });
    expect(netApi.calls.at(-1)?.options).toEqual({ timeoutMs: 125 });

    now = 1_300;
    await expect(controller.call("EMCP_WB_GetState", {}, {
      timeout: 500,
      skipAutoLaunch: true,
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(netApi.calls).toHaveLength(1);
  });

  it("maps transport failures without leaking them into lifecycle policy", async () => {
    const netApi = new StubNetApi(new WorkbenchNetApiError(
      "injected transport refusal",
      "connection_refused"
    ));
    const controller = new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      undefined,
      "controller-contract",
      undefined,
      { netApi }
    );

    await expect(controller.call("EMCP_WB_GetState", {}, {
      skipAutoLaunch: true,
    })).rejects.toMatchObject({ code: "CONNECTION_REFUSED" });
    expect(controller.state).toMatchObject({ connected: false, mode: "unknown" });
  });

  it("supports disabling qualification reuse and rejects invalid cache bounds", () => {
    expect(() => new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      undefined,
      "controller-contract",
      undefined,
      { qualificationIntervalMs: 0 }
    )).not.toThrow();
    expect(() => new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      undefined,
      "controller-contract",
      undefined,
      { qualificationIntervalMs: -1 }
    )).toThrow(/qualification interval/i);
  });

  it("disposes exit-control abort listeners and timers after ordinary child exit", async () => {
    vi.useFakeTimers();
    try {
      const childSupervisor = new ChildSupervisor();
      const execution = new WorkbenchLifecycleExecution({ childSupervisor });
      const control = new AbortController();
      const addListener = vi.spyOn(control.signal, "addEventListener");
      const removeListener = vi.spyOn(control.signal, "removeEventListener");

      for (let index = 0; index < 5; index += 1) {
        const child = Object.assign(new EventEmitter(), {
          pid: 31_000 + index,
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
        }) as unknown as ChildProcess;
        const handle = childSupervisor.supervise(`exit-control-${index}`, child);
        const completion = execution.waitForExitOrControl({
          child: handle,
          timeoutMs: 60_000,
          signal: control.signal,
        });
        child.emit("exit", 0, null);
        await expect(completion).resolves.toEqual({
          reason: "exited",
          exit: { code: 0, signal: null },
        });
      }

      expect(addListener).toHaveBeenCalledTimes(5);
      expect(removeListener).toHaveBeenCalledTimes(5);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
