import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeWorkerInstance {
  terminateCalls: number;
  terminationCompleted: boolean;
  exitEmissions: number;
  completeTermination(): void;
  emitExit(): void;
}

type FakeWorkerListener = (...args: unknown[]) => void;

const workerState = vi.hoisted(() => ({
  instances: [] as FakeWorkerInstance[],
}));

vi.mock("node:worker_threads", () => ({
  Worker: class {
    private resolveTermination: ((value: number) => void) | undefined;
    private readonly listeners: Array<{
      event: string;
      listener: FakeWorkerListener;
      once: boolean;
    }> = [];
    readonly record: FakeWorkerInstance;

    constructor() {
      this.record = {
        terminateCalls: 0,
        terminationCompleted: false,
        exitEmissions: 0,
        completeTermination: () => {
          this.record.terminationCompleted = true;
          this.resolveTermination?.(1);
        },
        emitExit: () => {
          this.record.exitEmissions += 1;
          this.emit("exit", 1);
        },
      };
      workerState.instances.push(this.record);
    }

    unref(): void {}

    on(event: string, listener: FakeWorkerListener): this {
      this.listeners.push({ event, listener, once: false });
      return this;
    }

    once(event: string, listener: FakeWorkerListener): this {
      this.listeners.push({ event, listener, once: true });
      return this;
    }

    off(event: string, listener: FakeWorkerListener): this {
      for (let index = this.listeners.length - 1; index >= 0; index -= 1) {
        const candidate = this.listeners[index];
        if (candidate.event === event && candidate.listener === listener) {
          this.listeners.splice(index, 1);
        }
      }
      return this;
    }

    private emit(event: string, ...args: unknown[]): void {
      const matching = this.listeners.filter((candidate) => candidate.event === event);
      for (const candidate of matching) {
        if (candidate.once) this.off(candidate.event, candidate.listener);
        candidate.listener(...args);
      }
    }

    terminate(): Promise<number> {
      this.record.terminateCalls += 1;
      return new Promise<number>((resolve) => {
        this.resolveTermination = resolve;
      });
    }
  },
}));

import {
  revalidateGameLaunchPointOfUseIsolated,
} from "../../src/launch/game-launch-revalidation-isolation.js";

const DUMMY_EXECUTABLE_EVIDENCE = {
  schemaVersion: 1 as const,
  runtimeKind: "listenServer" as const,
  executablePath: "C:\\Games\\ArmaReforgerSteamDiag.exe",
  executableFile: {
    sha256: "a".repeat(64),
    size: "1",
    device: "1",
    inode: "1",
  },
  executableEvidenceDigest: "b".repeat(64),
};

beforeEach(() => {
  workerState.instances.length = 0;
});

describe("game-launch revalidation worker lifetime", () => {
  it("does not settle an expired operation until its worker termination completes", async () => {
    const pending = revalidateGameLaunchPointOfUseIsolated({
      phase: "post_spawn_executable",
      expectedExecutable: DUMMY_EXECUTABLE_EVIDENCE,
      executableMaximumBytes: 1024,
      deadlineAtMs: Date.now() + 20,
    });
    let rejected = false;
    void pending.catch(() => { rejected = true; });

    await vi.waitFor(() => {
      expect(workerState.instances).toHaveLength(1);
      expect(workerState.instances[0].terminateCalls).toBe(1);
    });
    await Promise.resolve();
    expect(rejected).toBe(false);

    workerState.instances[0].completeTermination();
    await Promise.resolve();
    expect(workerState.instances[0]).toMatchObject({
      terminationCompleted: true,
      exitEmissions: 0,
    });
    expect(rejected).toBe(false);

    workerState.instances[0].emitExit();
    await expect(pending).rejects.toMatchObject({ code: "PLANNING_TIMEOUT" });
    expect(rejected).toBe(true);
  });

  it("does not settle an aborted operation until its worker termination completes", async () => {
    const controller = new AbortController();
    const pending = revalidateGameLaunchPointOfUseIsolated({
      phase: "post_spawn_executable",
      expectedExecutable: DUMMY_EXECUTABLE_EVIDENCE,
      executableMaximumBytes: 1024,
      deadlineAtMs: Date.now() + 5_000,
    }, controller.signal);
    let rejected = false;
    void pending.catch(() => { rejected = true; });

    controller.abort();
    await vi.waitFor(() => {
      expect(workerState.instances).toHaveLength(1);
      expect(workerState.instances[0].terminateCalls).toBe(1);
    });
    await Promise.resolve();
    expect(rejected).toBe(false);

    workerState.instances[0].completeTermination();
    await Promise.resolve();
    expect(workerState.instances[0]).toMatchObject({
      terminationCompleted: true,
      exitEmissions: 0,
    });
    expect(rejected).toBe(false);

    workerState.instances[0].emitExit();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(rejected).toBe(true);
  });
});
