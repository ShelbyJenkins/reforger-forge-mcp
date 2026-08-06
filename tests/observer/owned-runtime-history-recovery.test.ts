import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNED_RUNTIME_RECORD_DIRECTORIES,
  OwnedRuntimeManager,
} from "../../src/observer/owned-runtime-manager.js";
import {
  FakeGate,
  cleanupOwnedRuntimeManagerFixtures,
  createFakeBackend,
  listRecordIds,
  makeHarness,
  openManagers,
  readRecord,
  recordExists,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

function durableInventory(manager: OwnedRuntimeManager): Record<string, string[]> {
  return Object.fromEntries(OWNED_RUNTIME_RECORD_DIRECTORIES.map((family) => [
    family,
    listRecordIds(manager, family),
  ]));
}

async function observeChildExit(
  value: ReturnType<typeof makeHarness>,
  runtimeId: string,
  childIndex: number,
  removeExactProcess = true,
): Promise<void> {
  const child = value.spawnCalls[childIndex].child;
  if (removeExactProcess) value.backend.processes.delete(child.pid);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await vi.waitFor(() => {
    expect(recordExists(value.manager, "child-exits", runtimeId)).toBe(true);
  }, { timeout: 2_000, interval: 10 });
}

describe("OwnedRuntimeManager retained history recovery", () => {
  it("keeps a fully linked pending-only failed start from invalidating retained history", async () => {
    const owner = makeHarness({
      spawnFailure: true,
      managerInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const prepared = await owner.prepare();
    await expect(owner.startPrepared(prepared.id, "history-pending-only"))
      .rejects.toMatchObject({ code: "SPAWN_FAILED" });

    const replacement = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    replacement.setExecutable(owner.executable);
    await expect(replacement.manager.inspectRuntimeHistory()).resolves.toMatchObject({
      complete: true,
      runtimesScanned: 0,
      recoverableCount: 0,
      idleBlockers: [],
      issues: [],
    });
  });

  it("classifies without mutation and recovers child-exit-only history in bounded idempotent batches", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const first = await owner.start("history-first");
    const second = await owner.start("history-second");
    await observeChildExit(owner, first.runtimeId, 0);
    await observeChildExit(owner, second.runtimeId, 1);

    const beforeRead = durableInventory(owner.manager);
    const replacement = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    replacement.setExecutable(owner.executable);
    const history = await replacement.manager.inspectRuntimeHistory({ maxRuntimes: 1 });
    expect(history).toMatchObject({
      complete: true,
      runtimesScanned: 2,
      counts: { completed: 0, child_exit_only: 2, cleanup_pending: 0, indeterminate: 0 },
      recoverableCount: 2,
      historicalManagerInstances: 1,
      truncated: true,
      issues: [],
    });
    expect(history.recoverableRuntimeIds).toHaveLength(1);
    expect(durableInventory(owner.manager)).toEqual(beforeRead);

    const firstBatch = await replacement.manager.recoverRuntimeHistory({ maxRuntimes: 1 });
    expect(firstBatch.attemptedRuntimeIds).toEqual(history.recoverableRuntimeIds);
    expect(firstBatch.recoveredRuntimeIds).toEqual(history.recoverableRuntimeIds);
    expect(firstBatch.blocked).toEqual([]);
    expect(firstBatch.after).toMatchObject({
      complete: true,
      counts: { completed: 1, child_exit_only: 1 },
      recoverableCount: 1,
    });
    expect(owner.backend.terminateCalls).toEqual([]);

    const secondBatch = await replacement.manager.recoverRuntimeHistory({ maxRuntimes: 2 });
    expect(secondBatch.recoveredRuntimeIds).toHaveLength(1);
    expect(secondBatch.after).toMatchObject({
      complete: true,
      counts: { completed: 2, child_exit_only: 0, cleanup_pending: 0 },
      recoverableCount: 0,
    });
    expect(owner.backend.terminateCalls).toEqual([]);

    await expect(replacement.manager.recoverRuntimeHistory({ maxRuntimes: 2 })).resolves.toMatchObject({
      attemptedRuntimeIds: [],
      recoveredRuntimeIds: [],
      blocked: [],
    });
  });

  it("releases a retained existing-only reader before opening recovery storage", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const started = await owner.start("history-reader-to-writer");
    await observeChildExit(owner, started.runtimeId, 0);
    await owner.manager.closeStorageForTest();

    const replacement = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    replacement.setExecutable(owner.executable);

    await expect(replacement.manager.inspectRuntimeHistory()).resolves.toMatchObject({
      complete: true,
      counts: { child_exit_only: 1 },
      recoverableRuntimeIds: [started.runtimeId],
    });
    await expect(replacement.manager.recoverRuntimeHistory({ maxRuntimes: 1 })).resolves.toMatchObject({
      recoveredRuntimeIds: [started.runtimeId],
      blocked: [],
      after: {
        complete: true,
        counts: { completed: 1, child_exit_only: 0, cleanup_pending: 0 },
      },
    });
    expect(owner.backend.terminateCalls).toEqual([]);
  });

  it("refuses a contradictory live exact process without writing stop evidence or terminating it", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const started = await owner.start("history-live-conflict");
    await observeChildExit(owner, started.runtimeId, 0, false);
    const beforeRecovery = durableInventory(owner.manager);

    const replacement = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    replacement.setExecutable(owner.executable);
    const result = await replacement.manager.recoverRuntimeHistory({ maxRuntimes: 1 });
    expect(result).toMatchObject({
      attemptedRuntimeIds: [started.runtimeId],
      recoveredRuntimeIds: [],
      blocked: [{ runtimeId: started.runtimeId, code: "IDENTITY_UNVERIFIABLE" }],
    });
    expect(owner.backend.processes.has(started.pid)).toBe(true);
    expect(owner.backend.terminateCalls).toEqual([]);
    expect(durableInventory(owner.manager)).toEqual(beforeRecovery);
  });

  it("refuses historical adoption while the prior exact MCP owner remains live", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const started = await owner.start("history-prior-owner");
    await observeChildExit(owner, started.runtimeId, 0);
    const receipt = readRecord(owner.manager, "runtimes", started.runtimeId);
    const mcpOwner = receipt.mcpOwner as {
      pid: number;
      executablePath: string;
      creationTimeFileTime: string;
    };
    owner.backend.processes.set(mcpOwner.pid, {
      identity: {
        pid: mcpOwner.pid,
        executablePath: mcpOwner.executablePath,
        creationTime: mcpOwner.creationTimeFileTime,
      },
      ownerArgument: "",
    });

    const replacement = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    replacement.setExecutable(owner.executable);
    const result = await replacement.manager.recoverRuntimeHistory({ maxRuntimes: 1 });
    expect(result.blocked).toEqual([
      expect.objectContaining({
        runtimeId: started.runtimeId,
        code: "IDENTITY_UNVERIFIABLE",
        reason: expect.stringContaining("Prior exact MCP owner is still live"),
      }),
    ]);
    expect(owner.backend.terminateCalls).toEqual([]);
    expect(recordExists(owner.manager, "stops", started.runtimeId)).toBe(false);
  });

  it("completes cleanup-pending stop history without issuing another termination", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const started = await owner.start("history-cleanup-pending");
    owner.gate.completeFailures = 1;
    await expect(owner.stop(started.runtimeId, "history-cleanup-stop")).rejects.toMatchObject({
      code: "SESSION_COMPLETION_FAILED",
    });
    expect(recordExists(owner.manager, "stops", started.runtimeId)).toBe(true);
    expect(recordExists(owner.manager, "stop-completions", started.runtimeId)).toBe(false);
    const terminationCount = owner.backend.terminateCalls.length;

    const replacement = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    replacement.setExecutable(owner.executable);
    await expect(replacement.manager.inspectRuntimeHistory()).resolves.toMatchObject({
      complete: true,
      counts: { cleanup_pending: 1 },
      recoverableCount: 1,
    });
    const recovered = await replacement.manager.recoverRuntimeHistory({ maxRuntimes: 1 });
    expect(recovered.recoveredRuntimeIds).toEqual([started.runtimeId]);
    expect(recovered.after).toMatchObject({ counts: { completed: 1, cleanup_pending: 0 } });
    expect(owner.backend.terminateCalls).toHaveLength(terminationCount);
  });

  it("keeps malformed cross-bound history indeterminate and performs no recovery", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const started = await owner.start("history-cross-bound");
    await observeChildExit(owner, started.runtimeId, 0);
    const childExit = readRecord(owner.manager, "child-exits", started.runtimeId);
    writeRecord(owner.manager, "child-exits", started.runtimeId, `${JSON.stringify({
      ...childExit,
      sessionId: "another-session",
    })}\n`);

    const replacement = makeHarness({
      root: owner.root,
      backend: owner.backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    replacement.setExecutable(owner.executable);
    const history = await replacement.manager.inspectRuntimeHistory();
    expect(history).toMatchObject({
      complete: false,
      counts: { indeterminate: 1, child_exit_only: 0 },
      recoverableCount: 0,
      issues: expect.arrayContaining([expect.objectContaining({ runtimeId: started.runtimeId })]),
    });
    await expect(replacement.manager.recoverRuntimeHistory()).resolves.toMatchObject({
      attemptedRuntimeIds: [],
      recoveredRuntimeIds: [],
      blocked: [{ runtimeId: "inventory", code: "INCOMPLETE_PROOF" }],
    });
    expect(owner.backend.terminateCalls).toEqual([]);
    expect(recordExists(owner.manager, "stops", started.runtimeId)).toBe(false);
  });

  it("filters high-cardinality foreign history before per-runtime shutdown mutex work", async () => {
    const backend = createFakeBackend();
    let mutexEntries = 0;
    backend.withMachineMutex = async (args) => {
      mutexEntries += 1;
      return args.action();
    };
    const owner = makeHarness({
      backend,
      managerInstanceId: "11111111-1111-4111-8111-111111111111",
    });
    const runtimes = [];
    for (let index = 0; index < 20; index += 1) {
      runtimes.push(await owner.start(`foreign-history-${index}`));
    }
    for (let index = 0; index < runtimes.length; index += 1) {
      await observeChildExit(owner, runtimes[index].runtimeId, index);
    }
    mutexEntries = 0;

    const replacement = makeHarness({
      root: owner.root,
      backend,
      gate: owner.gate,
      managerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
    await expect(replacement.manager.close()).resolves.toMatchObject({
      applicationCloseSafe: true,
      sealedRuntimeIds: [],
      busyRuntimeIds: [],
      errorRuntimes: [],
    });
    expect(mutexEntries).toBe(2);
  }, 15_000);

  it("preserves installation authority for explicit history recovery", async () => {
    const owner = makeHarness({ managerInstanceId: "11111111-1111-4111-8111-111111111111" });
    const started = await owner.start("history-installation-authority");
    await observeChildExit(owner, started.runtimeId, 0);
    const otherInstallation = join(owner.root, "other-installation");
    mkdirSync(otherInstallation);
    const replacement = new OwnedRuntimeManager({
      managedRoot: owner.root,
      gamePath: owner.root,
      observerGate: new FakeGate(),
      backend: owner.backend,
      executableResolver: () => owner.executable,
      installationRoot: otherInstallation,
      inspectionTimeoutMs: 500,
      terminationTimeoutMs: 500,
      lockTimeoutMs: 500,
    });
    openManagers.push(replacement);

    const result = await replacement.recoverRuntimeHistory({ maxRuntimes: 1 });
    expect(result.blocked).toEqual([
      expect.objectContaining({
        runtimeId: started.runtimeId,
        code: "IDENTITY_UNVERIFIABLE",
        reason: expect.stringContaining("different MCP installation or Windows owner"),
      }),
    ]);
    expect(owner.backend.terminateCalls).toEqual([]);
    expect(recordExists(owner.manager, "stops", started.runtimeId)).toBe(false);
  });
});
