import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LifecycleGuardError,
  WorkbenchProcessGuard,
  type WorkbenchIdentity,
} from "../../src/workbench/process-guard.js";
import { FakeLifecycleBackend } from "./fake-lifecycle-backend.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "reforger-forge-lifecycle-"));
  roots.push(value);
  return value;
}

function target(name = "A"): { path: string; comparisonKey: string } {
  return { path: `C:\\mods\\${name}\\${name}.gproj`, comparisonKey: `c:\\mods\\${name.toLowerCase()}\\${name.toLowerCase()}.gproj` };
}

describe("WorkbenchProcessGuard v2 lifecycle state", () => {
  it("creates a durable vacant record with an exact MCP lease", async () => {
    const stateDir = root();
    const backend = new FakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });

    const result = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 },
      target: target(),
    }));

    expect(result.kind).toBe("claimed");
    if (result.kind !== "claimed") return;
    expect(result.source).toBe("missing");
    expect(result.state.version).toBe(2);
    expect(result.state.phase).toBe("vacant");
    expect(result.state.mcpOwner?.instanceId).toBe(guard.mcpInstanceId);
    expect(result.state.mcpOwner?.leaseId).toBe(guard.leaseId);
    expect(result.state.mcpOwner?.creationTime).toBe(backend.current.creationTime);
    expect(existsSync(guard.statePath)).toBe(true);
    expect(JSON.parse(readFileSync(guard.statePath, "utf8")).version).toBe(2);
    expect("lockPath" in guard).toBe(false);
  });

  it("refuses a live different MCP owner", async () => {
    const stateDir = root();
    const ownerBackend = new FakeLifecycleBackend({
      pid: 1101, executablePath: "C:\\node.exe", creationTime: "10001", userSid: "SID-A",
    });
    const contenderBackend = new FakeLifecycleBackend({
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
    const first = new WorkbenchProcessGuard({ stateDir, backend: new FakeLifecycleBackend({
      pid: 1101, executablePath: "C:\\node.exe", creationTime: "10001", userSid: "SID-A",
    }) });
    await first.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));
    const replacementBackend = new FakeLifecycleBackend({
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
    const ownerBackend = new FakeLifecycleBackend({
      pid: 77, executablePath: "C:\\node.exe", creationTime: "111", userSid: "SID-A",
    });
    const owner = new WorkbenchProcessGuard({ stateDir, backend: ownerBackend });
    await owner.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));
    const nextBackend = new FakeLifecycleBackend({
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
    const backend = new FakeLifecycleBackend();
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
        { ...claim.state, phase: "running", workbench: wb, operation: null }
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
    const owner = new WorkbenchProcessGuard({ stateDir, backend: new FakeLifecycleBackend({
      pid: 10, executablePath: "C:\\node.exe", creationTime: "10", userSid: "SID-A",
    }) });
    await owner.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));
    const other = new WorkbenchProcessGuard({ stateDir, backend: new FakeLifecycleBackend({
      pid: 20, executablePath: "C:\\node.exe", creationTime: "20", userSid: "SID-B",
    }) });

    const result = await other.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "refused", code: "USER_CONFLICT" });
  });

  it("generation-checks every state transition and rejects stale callbacks", async () => {
    const stateDir = root();
    const guard = new WorkbenchProcessGuard({ stateDir, backend: new FakeLifecycleBackend() });
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

  it("archives malformed state only after proving Workbench absence", async () => {
    const stateDir = root();
    const backend = new FakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    writeFileSync(guard.statePath, "{ malformed", "utf8");

    const result = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "claimed", source: "malformed" });
    expect(readdirSync(stateDir).some((name) => name.startsWith("malformed-"))).toBe(true);
    expect((await guard.readLifecycleState()).kind).toBe("valid");
  });

  it("never adopts a live version-1 marker", async () => {
    const stateDir = root();
    const backend = new FakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    writeFileSync(guard.statePath, JSON.stringify({ version: 1, pid: 900 }), "utf8");
    backend.addWorkbench({ pid: 900, executablePath: "C:\\Workbench.exe", creationTime: "900" });

    const result = await guard.withLifecycleLock((session) => session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 }, target: target(),
    }));

    expect(result).toMatchObject({ kind: "refused", code: "LEGACY_OWNER" });
    expect(JSON.parse(readFileSync(guard.statePath, "utf8")).version).toBe(1);
  });

  it("captures a spawned process only when path and exact owner argument match", async () => {
    const stateDir = root();
    const backend = new FakeLifecycleBackend();
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
    const backend = new FakeLifecycleBackend();
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

  it("delegates termination as one exact handle-bound backend operation", async () => {
    const stateDir = root();
    const backend = new FakeLifecycleBackend();
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
    const backend = new FakeLifecycleBackend({
      pid: 1, executablePath: "C:\\node.exe", creationTime: "0", userSid: "SID-A",
    });
    const guard = new WorkbenchProcessGuard({ stateDir, backend });

    await expect(guard.withLifecycleLock(async () => undefined)).rejects.toBeInstanceOf(LifecycleGuardError);
  });

  it("serializes simultaneous callbacks through the backend mutex", async () => {
    const stateDir = root();
    const backend = new FakeLifecycleBackend();
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
});
