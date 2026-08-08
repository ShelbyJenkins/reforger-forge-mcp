import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  inspectWorkbenchLmdbExistingIsolated,
} from "../../src/workbench/existing-lmdb-reader.js";
import { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { createFakeLifecycleBackend } from "./fake-lifecycle-backend.js";

const failureWorkerUrl = new URL("./fixtures/existing-lmdb-reader-failure.ts", import.meta.url);

class RefusingReaderChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 41_041;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    return false;
  }

  unref(): void {
    // The fake owns no event-loop handle.
  }

  close(): void {
    this.signalCode = "SIGTERM";
    this.emit("close", null, "SIGTERM");
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

describe("crash-isolated existing Workbench LMDB reader", () => {
  it("does not create a missing state root", async () => {
    await withTemporaryDirectory(async (root) => {
      const missing = join(root, "missing-state");
      await expect(inspectWorkbenchLmdbExistingIsolated(missing)).resolves.toEqual({
        lifecycle: { kind: "missing" },
        journal: { kind: "missing" },
      });
      expect(existsSync(missing)).toBe(false);
    }, { prefix: "rfo-workbench-existing-isolated-missing-" });
  });

  it("reads through a fresh child while another process owns a live writer mapping", async () => {
    await withTemporaryDirectory(async (stateDir) => {
      const owner = new WorkbenchProcessGuard({
        stateDir,
        backend: createFakeLifecycleBackend(),
      });
      const reader = new WorkbenchProcessGuard({
        stateDir,
        backend: createFakeLifecycleBackend({
          pid: 9_002,
          executablePath: "C:\\node.exe",
          creationTime: "9002",
          userSid: "SID-A",
        }),
      });
      try {
        const claim = await owner.withLifecycleLock((session) => session.validateAndClaim({
          endpoint: { host: "127.0.0.1", port: 5775 },
          target: {
            path: "C:\\mods\\Fixture\\Fixture.gproj",
            comparisonKey: "c:\\mods\\fixture\\fixture.gproj",
          },
        }));
        expect(claim.kind).toBe("claimed");
        const dataPath = join(stateDir, "durable-kv-v1", "data.mdb");
        const before = statSync(dataPath);

        await expect(reader.readExistingStateSnapshot({ timeoutMs: 5_000 })).resolves.toMatchObject({
          lifecycle: { kind: "valid", state: { version: 3, phase: "vacant" } },
          journal: { kind: "missing" },
        });
        const after = statSync(dataPath);
        expect(after.size).toBe(before.size);
        expect(after.mtimeMs).toBe(before.mtimeMs);
      } finally {
        await reader.close();
        await owner.close();
      }
    }, { prefix: "rfo-workbench-existing-isolated-live-writer-" });
  }, 15_000);

  it("contains an abnormal reader exit instead of terminating the host", async () => {
    await expect(inspectWorkbenchLmdbExistingIsolated("exit", {
      workerUrl: failureWorkerUrl,
      timeoutMs: 2_000,
    })).rejects.toMatchObject({
      name: "WorkbenchExistingLmdbIsolationError",
      code: "WORKER_FAILED",
    });
  });

  it("projects a reader failure as stable malformed evidence", async () => {
    await withTemporaryDirectory(async (root) => {
      const stateDir = join(root, "state");
      mkdirSync(stateDir);
      writeFileSync(join(stateDir, "durable-kv-v1"), "not an environment", "utf8");
      const guard = new WorkbenchProcessGuard({
        stateDir,
        backend: createFakeLifecycleBackend(),
      });
      try {
        const first = await guard.readExistingStateSnapshot({ timeoutMs: 5_000 });
        expect(first).toMatchObject({
          lifecycle: { kind: "malformed", rawSha256: "unreadable" },
          journal: { kind: "malformed", rawSha256: "unreadable" },
        });
        // The same guard retains a hard worker/protocol failure, preventing a
        // native-failure respawn storm during later silent-idle probes.
        await expect(guard.readExistingStateSnapshot({ timeoutMs: 1 })).resolves.toEqual(first);
      } finally {
        await guard.close();
      }
    }, { prefix: "rfo-workbench-existing-isolated-refusal-" });
  });

  it("kills and refuses a reader that exceeds its absolute budget", async () => {
    const startedAt = performance.now();
    let workerPid: number | undefined;
    await expect(inspectWorkbenchLmdbExistingIsolated("hang", {
      workerUrl: failureWorkerUrl,
      timeoutMs: 100,
      observeSpawnedPid: (pid) => {
        workerPid = pid;
      },
    })).rejects.toMatchObject({
      name: "WorkbenchExistingLmdbIsolationError",
      code: "TIMEOUT",
    });
    expect(workerPid).toBeTypeOf("number");
    expect(processExists(workerPid!)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("observes worker close before reporting cancellation", async () => {
    const controller = new AbortController();
    let workerPid: number | undefined;
    const inspection = inspectWorkbenchLmdbExistingIsolated("hang", {
      workerUrl: failureWorkerUrl,
      signal: controller.signal,
      timeoutMs: 2_000,
      observeSpawnedPid: (pid) => {
        workerPid = pid;
      },
    });
    controller.abort();
    await expect(inspection).rejects.toMatchObject({
      name: "WorkbenchExistingLmdbIsolationError",
      code: "CANCELLED",
    });
    expect(workerPid).toBeTypeOf("number");
    expect(processExists(workerPid!)).toBe(false);
  });

  it("keeps strict cancellation pending after kill refusal until exact close", async () => {
    vi.useFakeTimers();
    try {
      const child = new RefusingReaderChild();
      const controller = new AbortController();
      let settled = false;
      const inspection = inspectWorkbenchLmdbExistingIsolated("strict-close", {
        signal: controller.signal,
        timeoutMs: 5_000,
        requireCloseBeforeSettlement: true,
        spawnProcess: (() => child as unknown as ChildProcess) as unknown as
          typeof import("node:child_process").spawn,
      }).then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.killCalls).toBe(2);
      expect(settled).toBe(false);

      child.close();
      await expect(inspection).resolves.toMatchObject({ code: "CANCELLED" });
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
