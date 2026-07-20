import { describe, expect, it, vi } from "vitest";
import type { ExactProcessBackend } from "../../src/foundation/exact-process-backend.js";
import {
  hasRecoverableExactIdentity,
  runRecoverableSpawn,
  type RecoverableSpawnRecord,
} from "../../src/foundation/recoverable-spawn.js";

interface TestIdentity {
  pid: number;
  executablePath: string;
  creationTime: string;
  ownerTokenArgument: string;
  launchedAtMs: number;
}

const identity: TestIdentity = {
  pid: 42,
  executablePath: "C:\\runtime.exe",
  creationTime: "133900000000000042",
  ownerTokenArgument: "-owner=test",
  launchedAtMs: 1_000,
};

const backend: ExactProcessBackend = {
  platform: "test",
  inspectCurrentProcess: vi.fn(),
  inspectProcess: vi.fn(),
  verifyAndTerminate: vi.fn(),
};

describe("runRecoverableSpawn", () => {
  it("durably orders every phase around exact inspection and publication", async () => {
    const phases: string[] = [];
    const records: Array<RecoverableSpawnRecord<TestIdentity, { kind: string }>> = [];
    let clock = 1_000;
    const publication = { runtimeId: "runtime-a" };

    const result = await runRecoverableSpawn<
      { pid: number },
      TestIdentity,
      { kind: string },
      { runtimeId: string }
    >({
      transactionId: "transaction-a",
      metadata: { kind: "runtime" },
      backend,
      now: () => clock++,
      journal: {
        persist: async (_previous, next) => {
          phases.push(`persist:${next.phase}`);
          records.push(next);
          return next;
        },
      },
      spawn: () => {
        phases.push("spawn");
        return { pid: 42 };
      },
      childPid: (child) => child.pid,
      awaitSpawn: async () => { phases.push("await_spawn"); },
      inspect: async (_child, suppliedBackend) => {
        expect(suppliedBackend).toBe(backend);
        phases.push("inspect");
        return identity;
      },
      beforePublish: async () => { phases.push("retain"); },
      publish: async () => {
        phases.push("publish");
        return publication;
      },
    });

    expect(phases).toEqual([
      "persist:pre_spawn",
      "spawn",
      "await_spawn",
      "persist:spawned_unverified",
      "inspect",
      "persist:identity_verified",
      "retain",
      "publish",
      "persist:published",
    ]);
    expect(result).toMatchObject({ identity, publication });
    expect(records.map((record) => record.phase)).toEqual([
      "pre_spawn",
      "spawned_unverified",
      "identity_verified",
      "published",
    ]);
    expect(hasRecoverableExactIdentity(records[1])).toBe(false);
    expect(hasRecoverableExactIdentity(records[2])).toBe(true);
  });

  it("checks the lease fence between every irreversible stage", async () => {
    let assertions = 0;
    const fence = {
      assertActive: vi.fn(() => {
        assertions += 1;
        if (assertions === 3) throw new Error("lease lost");
      }),
    };
    const persisted: string[] = [];

    await expect(runRecoverableSpawn({
      transactionId: "transaction-b",
      metadata: null,
      backend,
      fence,
      journal: {
        persist: async (_previous, next) => {
          persisted.push(next.phase);
          return next;
        },
      },
      spawn: () => ({ pid: 42 }),
      childPid: (child) => child.pid,
      inspect: async () => identity,
      beforePublish: async () => undefined,
      publish: async () => undefined,
    })).rejects.toThrow("lease lost");

    expect(persisted).toEqual(["pre_spawn", "spawned_unverified"]);
    expect(fence.assertActive).toHaveBeenCalledTimes(3);
  });

  it("awaits an asynchronous lifecycle fence before process creation", async () => {
    let releaseFence!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFence = resolve; });
    let fenceEntered!: () => void;
    const entered = new Promise<void>((resolve) => { fenceEntered = resolve; });
    let first = true;
    const spawn = vi.fn(() => ({ pid: 42 }));
    const run = runRecoverableSpawn({
      transactionId: "transaction-async-fence",
      metadata: null,
      backend,
      fence: {
        assertActive: () => {
          if (!first) return;
          first = false;
          fenceEntered();
          return blocked;
        },
      },
      journal: { persist: async (_previous, next) => next },
      spawn,
      childPid: (child) => child.pid,
      inspect: async () => identity,
      publish: async () => undefined,
    });

    await entered;
    expect(spawn).not.toHaveBeenCalled();
    releaseFence();
    await run;
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("refuses PID drift before publishing exact authority", async () => {
    await expect(runRecoverableSpawn({
      transactionId: "transaction-c",
      metadata: null,
      backend,
      journal: { persist: async (_previous, next) => next },
      spawn: () => ({ pid: 41 }),
      childPid: (child) => child.pid,
      inspect: async () => identity,
      publish: async () => undefined,
    })).rejects.toThrow("Exact inspection returned PID 42 for spawned PID 41");
  });
});
