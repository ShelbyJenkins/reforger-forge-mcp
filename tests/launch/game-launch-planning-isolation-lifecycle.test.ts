import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  createCanonicalGameLaunchIsolatedPlanner,
  type IsolatedGameLaunchPlanningRequest,
} from "../../src/launch/game-launch-planning-isolation.js";

class FakePlanningWorker extends EventEmitter {
  terminateCalls = 0;

  constructor(private readonly terminateImplementation: () => Promise<number>) {
    super();
  }

  unref(): void {
    // The fake owns no event-loop handle.
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.terminateImplementation();
  }
}

function planningRequest(deadlineAtMs: number): IsolatedGameLaunchPlanningRequest {
  return {
    application: {
      managedRoot: "C:\\fixture\\managed",
      profileRoot: "C:\\fixture\\profiles",
    },
    input: {
      action: "start",
      runtimeKind: "listenServer",
      arguments: [],
      waitForInstanceMs: 0,
      sessionTtlMs: 60_000,
      forceUpdate: true,
      noFocus: true,
    },
    configuredAddonRoots: [],
    executableSource: {
      kind: "executablePath",
      executablePath: "C:\\fixture\\ArmaReforgerSteamDiag.exe",
    },
    executableMaximumBytes: 1024 * 1024,
    deadlineAtMs,
  };
}

describe("isolated game-launch planning worker lifecycle", () => {
  it("does not let worker construction extend the absolute deadline", async () => {
    let now = 1_000;
    let worker!: FakePlanningWorker;
    worker = new FakePlanningWorker(async () => {
      queueMicrotask(() => worker.emit("exit", 1));
      return 1;
    });
    const plan = createCanonicalGameLaunchIsolatedPlanner(() => {
      now = 1_101;
      return worker as unknown as Worker;
    });
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const outcome = plan(planningRequest(1_100), new AbortController().signal).then(
        () => null,
        (error: unknown) => error,
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(worker.terminateCalls).toBe(1);
      await expect(outcome).resolves.toMatchObject({ code: "PLANNING_TIMEOUT" });
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not settle a terminate rejection until physical worker exit is observed", async () => {
    const worker = new FakePlanningWorker(async () => {
      throw new Error("fixture terminate rejection");
    });
    const plan = createCanonicalGameLaunchIsolatedPlanner(() =>
      worker as unknown as Worker);
    const cancellation = new AbortController();
    let settled = false;
    const outcome = plan(planningRequest(Date.now() + 5_000), cancellation.signal).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    cancellation.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(worker.terminateCalls).toBe(1);
    expect(settled).toBe(false);

    worker.emit("exit", 1);
    await expect(outcome).resolves.toMatchObject({ code: "CANCELLED" });
    expect(settled).toBe(true);
  });
});
