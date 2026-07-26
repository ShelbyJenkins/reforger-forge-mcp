import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asBinary, open } from "lmdb";
import {
  LifecycleGuardError,
  type WorkbenchIdentity,
} from "../../src/workbench/process-guard.js";
import { encodeDurableKey } from "../../src/foundation/durable-kv.js";
import { createFakeLifecycleBackend } from "./fake-lifecycle-backend.js";
import { companionLifecycleState, createFakeCompanionLaunch } from "./fake-companion.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";

const roots: string[] = [];

afterEach(async () => {
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "reforger-forge-lifecycle-"));
  roots.push(value);
  return value;
}

/** Inject raw bytes at the lifecycle LMDB key, mirroring corruption or a stale schema. */
async function writeRawLifecycleBytes(stateDir: string, bytes: Uint8Array): Promise<void> {
  const environmentPath = join(stateDir, "durable-kv-v1");
  mkdirSync(environmentPath, { recursive: true, mode: 0o700 });
  const database = open<unknown, Uint8Array>(environmentPath, {
    encoding: "binary",
    keyEncoding: "binary",
    useVersions: true,
    maxDbs: 1,
    overlappingSync: false,
  });
  database.putSync(Buffer.from(encodeDurableKey("workbench", "lifecycle"), "utf8"), asBinary(bytes), 1);
  await database.close();
}

function target(name = "A"): { path: string; comparisonKey: string } {
  return { path: `C:\\mods\\${name}\\${name}.gproj`, comparisonKey: `c:\\mods\\${name.toLowerCase()}\\${name.toLowerCase()}.gproj` };
}

describe("WorkbenchProcessGuard v3 lifecycle state", () => {
  it("creates a durable vacant record with an exact MCP lease", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });

    const result = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 },
      target: target(),
    }));

    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") return;
    expect(result.source).toBe("missing");
    expect(result.state.version).toBe(3);
    expect(result.state.phase).toBe("vacant");
    expect(result.state.mcpOwner?.instanceId).toBe(guard.mcpInstanceId);
    expect(result.state.mcpOwner?.leaseId).toBe(guard.leaseId);
    expect(result.state.mcpOwner?.creationTime).toBe(backend.current.creationTime);
    const persisted = await guard.readLifecycleState();
    expect(persisted.kind).toBe("valid");
    if (persisted.kind === "valid") expect(persisted.state.version).toBe(3);
    expect("lockPath" in guard).toBe(false);
  });

  it("refuses a live different MCP owner", async () => {
    const stateDir = root();
    const ownerBackend = createFakeLifecycleBackend({
      pid: 1101, executablePath: "C:\\node.exe", creationTime: "10001", userSid: "SID-A",
    });
    const contenderBackend = createFakeLifecycleBackend({
      pid: 2202, executablePath: "C:\\node.exe", creationTime: "20002", userSid: "SID-A",
    });
    contenderBackend.processes.set(ownerBackend.current.pid, ownerBackend.current);
    const owner = new WorkbenchProcessGuard({ stateDir, backend: ownerBackend });
    const contender = new WorkbenchProcessGuard({ stateDir, backend: contenderBackend });
    await owner.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    const result = await contender.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "refused", code: "OWNED_BY_OTHER_MCP" });
  });

  it("claims only after the prior exact MCP owner is absent", async () => {
    const stateDir = root();
    const first = new WorkbenchProcessGuard({ stateDir, backend: createFakeLifecycleBackend({
      pid: 1101, executablePath: "C:\\node.exe", creationTime: "10001", userSid: "SID-A",
    }) });
    await first.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));
    const replacementBackend = createFakeLifecycleBackend({
      pid: 2202, executablePath: "C:\\node.exe", creationTime: "20002", userSid: "SID-A",
    });
    const replacement = new WorkbenchProcessGuard({ stateDir, backend: replacementBackend });

    const result = await replacement.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "claimed", source: "dead_owner" });
    if (result.kind === "claimed") expect(result.state.mcpOwner?.pid).toBe(2202);
  });

  it("treats a reused MCP PID with another creation time as a dead prior owner", async () => {
    const stateDir = root();
    const ownerBackend = createFakeLifecycleBackend({
      pid: 77, executablePath: "C:\\node.exe", creationTime: "111", userSid: "SID-A",
    });
    const owner = new WorkbenchProcessGuard({ stateDir, backend: ownerBackend });
    await owner.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));
    const nextBackend = createFakeLifecycleBackend({
      pid: 88, executablePath: "C:\\node.exe", creationTime: "333", userSid: "SID-A",
    });
    nextBackend.processes.set(77, { pid: 77, executablePath: "C:\\node.exe", creationTime: "222" });
    const next = new WorkbenchProcessGuard({ stateDir, backend: nextBackend });

    const result = await next.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "claimed", source: "dead_owner" });
  });

  it("refuses endpoint and live-target mismatches without changing state", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const wb: WorkbenchIdentity = {
      pid: 3333,
      executablePath: "C:\\Workbench.exe",
      creationTime: "30003",
      ownerTokenArgument: guard.ownerArgument("token-a"),
      launchedAtMs: Date.now(),
    };
    await guard.withLifecycleLock(async (session) => {
      const claim = await session.validateAndClaim({
        endpoint: { host: "127.0.0.1", port: 5775 }, target: target("A"),
      });
      if (claim.kind !== "claimed") throw new Error("claim failed");
      await session.transition(
        { generation: claim.state.generation, leaseId: claim.state.mcpOwner!.leaseId },
        {
          ...claim.state,
          phase: "running",
          workbench: wb,
          companion: companionLifecycleState(createFakeCompanionLaunch(stateDir)),
          operation: null,
        }
      );
    });
    backend.addWorkbench(wb, wb.ownerTokenArgument);

    const endpoint = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 6000 }, target: target("A"),
    }));
    const project = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target("B"),
    }));
    expect(endpoint).toMatchObject({ kind: "refused", code: "ENDPOINT_CONFLICT" });
    expect(project).toMatchObject({ kind: "refused", code: "TARGET_CONFLICT" });
  });

  it("refuses a different Windows user even after the old owner dies", async () => {
    const stateDir = root();
    const owner = new WorkbenchProcessGuard({ stateDir, backend: createFakeLifecycleBackend({
      pid: 10, executablePath: "C:\\node.exe", creationTime: "10", userSid: "SID-A",
    }) });
    await owner.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));
    const other = new WorkbenchProcessGuard({ stateDir, backend: createFakeLifecycleBackend({
      pid: 20, executablePath: "C:\\node.exe", creationTime: "20", userSid: "SID-B",
    }) });

    const result = await other.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "refused", code: "USER_CONFLICT" });
  });

  it("generation-checks every state transition and rejects stale callbacks", async () => {
    const stateDir = root();
    const guard = new WorkbenchProcessGuard({ stateDir, backend: createFakeLifecycleBackend() });
    await guard.withLifecycleLock(async (session) => {
      const claim = await session.validateAndClaim({
        endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
      });
      if (claim.kind !== "claimed") throw new Error("claim failed");
      const expected = {
        generation: claim.state.generation,
        leaseId: claim.state.mcpOwner!.leaseId,
      };
      await session.transition(expected, { ...claim.state, phase: "starting", operation: {
        kind: "launch", operationId: "new-operation",
      } });
      await expect(session.transitionToVacant(expected)).rejects.toMatchObject({
        code: "GENERATION_MISMATCH",
      });
    });
  });

  it("serializes first spawn-journal phases and requires the exact lifecycle authority", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const authority = await guard.withLifecycleLock(async (session) => {
      const claim = await session.validateAndClaim({
        endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
      });
      if (claim.kind !== "claimed") throw new Error("claim failed");
      return session.transition(
        { generation: claim.state.generation, leaseId: claim.state.mcpOwner!.leaseId },
        {
          ...claim.state,
          phase: "starting",
          operation: { kind: "launch", operationId: "spawn-reservation" },
        }
      );
    });
    const preSpawn = (transactionId: string) => ({
      transactionId,
      phase: "pre_spawn" as const,
      pid: null,
      identity: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      metadata: {
        purpose: "client_launch" as const,
        lifecycleGeneration: authority.generation,
        targetKey: authority.target!.comparisonKey,
      },
    });

    const overlapping = await Promise.allSettled([
      guard.createSpawnJournal(authority).persist(null, preSpawn("transaction-a")),
      guard.createSpawnJournal(authority).persist(null, preSpawn("transaction-b")),
    ]);

    expect(overlapping.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(overlapping.filter((result) => result.status === "rejected")).toHaveLength(1);
    const durable = await guard.readSpawnJournal();
    expect(durable).toMatchObject({
      kind: "valid",
      record: { phase: "pre_spawn" },
    });

    await guard.withLifecycleLock(async (session) => session.transition(
      { generation: authority.generation, leaseId: authority.mcpOwner!.leaseId },
      {
        ...authority,
        operation: { kind: "launch", operationId: "replacement-reservation" },
      }
    ));
    await expect(
      guard.createSpawnJournal(authority).persist(null, preSpawn("stale-transaction"))
    ).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
  });

  it("retires only its exact pre_spawn journal generation", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const authority = await guard.withLifecycleLock(async (session) => {
      const claim = await session.validateAndClaim({
        endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
      });
      if (claim.kind !== "claimed") throw new Error("claim failed");
      return session.transition(
        { generation: claim.state.generation, leaseId: claim.state.mcpOwner!.leaseId },
        {
          ...claim.state,
          phase: "starting",
          operation: { kind: "launch", operationId: "spawn-retirement" },
        }
      );
    });
    const preSpawn = (transactionId: string) => ({
      transactionId,
      phase: "pre_spawn" as const,
      pid: null,
      identity: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      metadata: {
        purpose: "mcp_editor" as const,
        lifecycleGeneration: authority.generation,
        targetKey: authority.target!.comparisonKey,
      },
    });
    const first = guard.createSpawnJournal(authority);
    const firstRecord = await first.persist(null, preSpawn("transaction-a"));
    const replacement = guard.createSpawnJournal(authority);
    const replacementRecord = await replacement.persist(null, preSpawn("transaction-b"));

    await expect(first.discardPreSpawn!(firstRecord)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    await expect(guard.readSpawnJournal()).resolves.toMatchObject({
      kind: "valid",
      record: { transactionId: "transaction-b", phase: "pre_spawn" },
    });

    await replacement.discardPreSpawn!(replacementRecord);
    await expect(guard.readSpawnJournal()).resolves.toEqual({ kind: "missing" });
  });

  it("archives malformed state only after proving Workbench absence", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    await writeRawLifecycleBytes(stateDir, new TextEncoder().encode("{ malformed"));

    const result = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "claimed", source: "malformed" });
    expect(readdirSync(join(stateDir, "corrupt")).some((name) => name.startsWith("malformed-"))).toBe(true);
    expect((await guard.readLifecycleState()).kind).toBe("valid");
  });

  it("never adopts a live obsolete lifecycle marker", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    await writeRawLifecycleBytes(stateDir, new TextEncoder().encode(JSON.stringify({ version: 2, pid: 900 })));
    backend.addWorkbench({ pid: 900, executablePath: "C:\\Workbench.exe", creationTime: "900" });

    const result = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "refused", code: "STATE_INVALID" });
    expect((await guard.readLifecycleState()).kind).toBe("malformed");
  });

  it("captures a spawned process only when path and exact owner argument match", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const ownerArgument = guard.ownerArgument("capture-token");
    backend.addWorkbench({
      pid: 5150, executablePath: "C:\\Tools\\Workbench.exe", creationTime: "5150",
    }, ownerArgument);

    const identity = await guard.withLifecycleLock((session) => session.inspectSpawnedWorkbench({
      pid: 5150,
      executablePath: "C:\\Tools\\Workbench.exe",
      ownerTokenArgument: ownerArgument,
      launchedAtMs: 123,
    }));

    expect(identity).toEqual({
      pid: 5150,
      executablePath: "C:\\Tools\\Workbench.exe",
      creationTime: "5150",
      ownerTokenArgument: ownerArgument,
      launchedAtMs: 123,
    });
  });

  it("rejects a process inspection that returns a different PID", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const ownerArgument = guard.ownerArgument("wrong-pid-token");
    backend.inspectProcess = async () => ({
      identity: {
        pid: 5151,
        executablePath: "C:\\Tools\\Workbench.exe",
        creationTime: "5151",
      },
      ownerArgumentMatched: true,
    });

    await expect(guard.withLifecycleLock((session) => session.inspectSpawnedWorkbench({
      pid: 5150,
      executablePath: "C:\\Tools\\Workbench.exe",
      ownerTokenArgument: ownerArgument,
      launchedAtMs: 123,
    }))).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });
  });

  it("does not keep polling spawned identity after the shared absolute deadline", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    backend.inspectProcess = async () => {
      throw new Error("injected helper deadline");
    };
    const deadlineAtMs = Date.now() + 40;
    const guard = new WorkbenchProcessGuard({
      stateDir,
      backend,
      operationDeadlineAtMs: () => deadlineAtMs,
    });
    const startedAt = Date.now();

    await expect(guard.withLifecycleLock((session) => session.inspectSpawnedWorkbench({
      pid: 5150,
      executablePath: "C:\\Tools\\Workbench.exe",
      ownerTokenArgument: guard.ownerArgument("absolute-deadline-token"),
      launchedAtMs: 123,
    }))).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIABLE" });

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("binds a loopback listener to the exact sole owned Workbench", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const expected: WorkbenchIdentity = {
      pid: 5250,
      executablePath: "C:\\Tools\\Workbench.exe",
      creationTime: "5250",
      ownerTokenArgument: guard.ownerArgument("endpoint-token"),
      launchedAtMs: 1,
    };
    backend.addWorkbench(expected, expected.ownerTokenArgument);

    const result = await guard.withLifecycleLock((session) =>
      session.verifyEndpointOwner({ host: "127.0.0.1", port: 5775 }, expected)
    );

    expect(result).toEqual({ kind: "owned", listenerPid: expected.pid });
    expect(backend.endpointOwnershipCalls).toEqual([{
      endpoint: { host: "127.0.0.1", port: 5775 },
      expected,
    }]);
  });

  it("refuses a valid foreign endpoint response while the spawned child remains live", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const expected: WorkbenchIdentity = {
      pid: 5350,
      executablePath: "C:\\Tools\\Workbench.exe",
      creationTime: "5350",
      ownerTokenArgument: guard.ownerArgument("foreign-endpoint-token"),
      launchedAtMs: 1,
    };
    backend.addWorkbench(expected, expected.ownerTokenArgument);
    backend.endpointOwnershipResult = {
      kind: "refused",
      reason: "listener_pid_mismatch",
      message: "The listener belongs to foreign PID 9999.",
    };

    const result = await guard.withLifecycleLock((session) =>
      session.verifyEndpointOwner({ host: "127.0.0.1", port: 5775 }, expected)
    );

    expect(result).toMatchObject({
      kind: "refused",
      reason: "listener_pid_mismatch",
    });
    expect(backend.processes.has(expected.pid)).toBe(true);
  });

  it("refuses non-loopback automated lifecycle endpoints before claiming state", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });

    const result = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "192.0.2.10", port: 5775 },
      target: target(),
    }));

    expect(result).toMatchObject({ kind: "refused", code: "IDENTITY_UNVERIFIABLE" });
    expect((await guard.readLifecycleState()).kind).toBe("missing");
  });

  it("delegates termination as one exact handle-bound backend operation", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const expected: WorkbenchIdentity = {
      pid: 6060,
      executablePath: "C:\\Tools\\Workbench.exe",
      creationTime: "6060",
      ownerTokenArgument: guard.ownerArgument("terminate-token"),
      launchedAtMs: 1,
    };
    backend.addWorkbench(expected, expected.ownerTokenArgument);

    const result = await guard.withLifecycleLock((session) =>
      session.verifyAndTerminate(expected, 1000)
    );

    expect(result).toEqual({ kind: "terminated" });
    expect(backend.terminationCalls).toEqual([expected]);
    expect(backend.processes.has(expected.pid)).toBe(false);
  });

  it("fails closed on zero or unknown current-process creation time", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend({
      pid: 1, executablePath: "C:\\node.exe", creationTime: "0", userSid: "SID-A",
    });
    const guard = new WorkbenchProcessGuard({ stateDir, backend });

    await expect(guard.withLifecycleLock(async () => undefined)).rejects.toBeInstanceOf(LifecycleGuardError);
  });

  it("serializes simultaneous callbacks through the backend mutex", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    let releaseFirst!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    const first = guard.withLifecycleLock(async () => {
      firstEntered();
      await barrier;
    });
    await entered;
    let secondRan = false;
    const second = guard.withLifecycleLock(async () => { secondRan = true; });
    await Promise.resolve();
    expect(secondRan).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondRan).toBe(true);
    expect(backend.maxConcurrent).toBe(1);
  });

  it("evaluates a dynamic lifecycle-lock budget at each acquisition", async () => {
    const stateDir = root();
    const backend = createFakeLifecycleBackend();
    const timeouts: number[] = [];
    const withMachineMutex = backend.withMachineMutex.bind(backend);
    backend.withMachineMutex = async (request) => {
      timeouts.push(request.timeoutMs);
      return withMachineMutex(request);
    };
    let timeoutMs = 4_000;
    const guard = new WorkbenchProcessGuard({
      stateDir,
      backend,
      lockTimeoutMs: () => timeoutMs,
    });

    await guard.withLifecycleLock(async () => undefined);
    timeoutMs = 750;
    await guard.withLifecycleLock(async () => undefined);

    expect(timeouts).toEqual([4_000, 750]);
  });
});
