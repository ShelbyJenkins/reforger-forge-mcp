import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExactProcessIdentity } from "../../src/foundation/identity.js";
import type { WorkbenchLifecycleExecutionPort } from "../../src/workbench/lifecycle-execution.js";
import {
  canonicalizeGproj,
  type CanonicalProjectIdentity,
} from "../../src/workbench/project-identity.js";
import type {
  WorkbenchIdentity,
  WorkbenchLifecycleStateV3,
  WorkbenchSpawnRecord,
} from "../../src/workbench/process-guard.js";
import {
  WorkbenchSessionController,
  type WorkbenchClientDependencies,
} from "../../src/workbench/session-controller.js";
import {
  createFakeLifecycleBackend,
  type FakeLifecycleBackend,
} from "./fake-lifecycle-backend.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";

const roots: string[] = [];

interface InterruptedBuildFixture {
  readonly root: string;
  readonly stateDir: string;
  readonly mutexName: string;
  readonly priorTarget: CanonicalProjectIdentity;
  readonly requestedTarget: CanonicalProjectIdentity;
  readonly priorMcp: ExactProcessIdentity & { userSid: string };
  readonly stopping: WorkbenchLifecycleStateV3;
  readonly journal: WorkbenchSpawnRecord;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createProject(root: string, name: string): CanonicalProjectIdentity {
  const directory = join(root, "projects", name);
  const gprojPath = join(directory, `${name}.gproj`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(gprojPath, "GameProject {}\n");
  return canonicalizeGproj(gprojPath);
}

async function seedInterruptedBuild(label: string): Promise<InterruptedBuildFixture> {
  const root = mkdtempSync(join(tmpdir(), `rfo-wb-build-shutdown-${label}-`));
  roots.push(root);
  const stateDir = join(root, "state");
  const mutexName = `Global\\ReforgerForge.WbBuildShutdown.${label}.${randomUUID()}`;
  const priorTarget = createProject(root, "TestContent");
  const requestedTarget = createProject(root, "Core");
  const priorMcp = {
    pid: 41_013,
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    creationTime: "133900000000041013",
    userSid: "S-1-5-21-wb-build-shutdown",
  };
  const priorBackend = createFakeLifecycleBackend(priorMcp);
  const priorGuard = new WorkbenchProcessGuard({
    stateDir,
    mutexName,
    backend: priorBackend,
  });
  const claim = await priorGuard.withLifecycleLock((session) =>
    session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 },
      target: {
        path: priorTarget.displayPath,
        comparisonKey: priorTarget.comparisonKey,
      },
    })
  );
  if (claim.kind === "refused") {
    throw new Error(`Interrupted-build fixture could not claim lifecycle: ${claim.message}`);
  }
  const reserved = claim.state;
  const starting = await priorGuard.withLifecycleLock((session) =>
    session.transition({
      generation: reserved.generation,
      leaseId: reserved.mcpOwner?.leaseId ?? null,
    }, {
      phase: "starting",
      endpoint: reserved.endpoint,
      target: reserved.target,
      mcpOwner: reserved.mcpOwner,
      workbench: null,
      companion: null,
      operation: {
        kind: "launch",
        operationId: randomUUID(),
      },
    })
  );
  const now = Date.now();
  const journal: WorkbenchSpawnRecord = {
    transactionId: randomUUID(),
    phase: "pre_spawn",
    pid: null,
    identity: null,
    createdAtMs: now,
    updatedAtMs: now,
    metadata: {
      purpose: "target_build",
      lifecycleGeneration: starting.generation,
      targetKey: priorTarget.comparisonKey,
    },
  };
  await priorGuard.createSpawnJournal(starting).persist(null, journal);
  const stopping = await priorGuard.withLifecycleLock((session) =>
    session.transition({
      generation: starting.generation,
      leaseId: starting.mcpOwner?.leaseId ?? null,
    }, {
      phase: "stopping",
      endpoint: starting.endpoint,
      target: starting.target,
      mcpOwner: starting.mcpOwner,
      workbench: null,
      companion: null,
      operation: {
        kind: "shutdown",
        operationId: randomUUID(),
      },
    })
  );
  await priorGuard.close();
  return {
    root,
    stateDir,
    mutexName,
    priorTarget,
    requestedTarget,
    priorMcp,
    stopping,
    journal,
  };
}

async function seedLiveUnpublishedBuild(
  label: string
): Promise<InterruptedBuildFixture & { readonly unpublished: WorkbenchIdentity }> {
  const root = mkdtempSync(join(tmpdir(), `rfo-wb-build-shutdown-${label}-`));
  roots.push(root);
  const stateDir = join(root, "state");
  const mutexName = `Global\\ReforgerForge.WbBuildShutdown.${label}.${randomUUID()}`;
  const priorTarget = createProject(root, "TestContent");
  const requestedTarget = createProject(root, "Core");
  const priorMcp = {
    pid: 41_113,
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    creationTime: "133900000000041113",
    userSid: "S-1-5-21-wb-build-shutdown",
  };
  const priorGuard = new WorkbenchProcessGuard({
    stateDir,
    mutexName,
    backend: createFakeLifecycleBackend(priorMcp),
  });
  const claim = await priorGuard.withLifecycleLock((session) =>
    session.validateAndClaim({
      endpoint: { host: "127.0.0.1", port: 5775 },
      target: {
        path: priorTarget.displayPath,
        comparisonKey: priorTarget.comparisonKey,
      },
    })
  );
  if (claim.kind === "refused") {
    throw new Error(`Live-unpublished fixture could not claim lifecycle: ${claim.message}`);
  }
  const unpublished: WorkbenchIdentity = {
    pid: 43_113,
    executablePath:
      "C:\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
    creationTime: "133900000000043113",
    ownerTokenArgument: "-reforgerForgeOwnerToken=live-unpublished",
    launchedAtMs: Date.now(),
  };
  const starting = await priorGuard.withLifecycleLock((session) =>
    session.transition({
      generation: claim.state.generation,
      leaseId: claim.state.mcpOwner?.leaseId ?? null,
    }, {
      phase: "starting",
      endpoint: claim.state.endpoint,
      target: claim.state.target,
      mcpOwner: claim.state.mcpOwner,
      workbench: unpublished,
      companion: null,
      operation: { kind: "launch", operationId: randomUUID() },
    })
  );
  const now = Date.now();
  const journal: WorkbenchSpawnRecord = {
    transactionId: randomUUID(),
    phase: "published",
    pid: unpublished.pid,
    identity: unpublished,
    createdAtMs: now,
    updatedAtMs: now,
    metadata: {
      purpose: "target_build",
      lifecycleGeneration: starting.generation,
      targetKey: priorTarget.comparisonKey,
    },
  };
  await priorGuard.createSpawnJournal(starting).persist(null, journal);
  const stopping = await priorGuard.withLifecycleLock((session) =>
    session.transition({
      generation: starting.generation,
      leaseId: starting.mcpOwner?.leaseId ?? null,
    }, {
      phase: "stopping",
      endpoint: starting.endpoint,
      target: starting.target,
      mcpOwner: starting.mcpOwner,
      workbench: null,
      companion: null,
      operation: { kind: "shutdown", operationId: randomUUID() },
    })
  );
  await priorGuard.close();
  return {
    root,
    stateDir,
    mutexName,
    priorTarget,
    requestedTarget,
    priorMcp,
    stopping,
    journal,
    unpublished,
  };
}

const immediateVacancyCheck: NonNullable<WorkbenchClientDependencies["vacancyWait"]> =
  async ({ verify, endpoint }) => {
    const result = await verify({ ...endpoint });
    if (result.kind === "vacant") return;
    throw new Error(
      result.kind === "occupied"
        ? `listener PID ${result.listenerPid}: ${result.message}`
        : `${result.reason}: ${result.message}`
    );
  };

function createReplacement(
  fixture: InterruptedBuildFixture,
  configure?: (backend: FakeLifecycleBackend) => void
): {
  readonly backend: FakeLifecycleBackend;
  readonly guard: WorkbenchProcessGuard;
  readonly client: WorkbenchSessionController;
  readonly execution: WorkbenchLifecycleExecutionPort;
} {
  const backend = createFakeLifecycleBackend({
    pid: 42_013,
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    creationTime: "133900000000042013",
    userSid: fixture.priorMcp.userSid,
  });
  configure?.(backend);
  const guard = new WorkbenchProcessGuard({
    stateDir: fixture.stateDir,
    mutexName: fixture.mutexName,
    backend,
  });
  const execution = WorkbenchSessionController.composeLifecycleExecution({
    processGuard: guard,
  });
  const client = new WorkbenchSessionController(
    "127.0.0.1",
    5775,
    undefined,
    "wb-build-shutdown-replacement",
    guard,
    {
      lifecycleExecution: execution,
      vacancyWait: immediateVacancyCheck,
    }
  );
  return { backend, guard, client, execution };
}

async function readState(guard: WorkbenchProcessGuard): Promise<WorkbenchLifecycleStateV3> {
  const read = await guard.readLifecycleState();
  if (read.kind !== "valid") {
    throw new Error(`Expected valid lifecycle state, got ${read.kind}`);
  }
  return read.state;
}

describe("owner-scoped wb_build shutdown recovery", () => {
  it("reclaims an exact-vacant pre_spawn shutdown and retargets before running the build", async () => {
    const fixture = await seedInterruptedBuild("recover");
    const replacement = createReplacement(fixture);
    const action = vi.fn(async (
      execution: WorkbenchLifecycleExecutionPort,
      signal: AbortSignal
    ) => {
      expect(execution).toBe(replacement.execution);
      expect(signal.aborted).toBe(false);
      const admitted = await readState(replacement.guard);
      expect(admitted).toMatchObject({
        phase: "vacant",
        target: {
          comparisonKey: fixture.requestedTarget.comparisonKey,
        },
        mcpOwner: {
          pid: replacement.backend.current.pid,
          creationTime: replacement.backend.current.creationTime,
          instanceId: replacement.guard.mcpInstanceId,
          leaseId: replacement.guard.leaseId,
        },
        workbench: null,
        operation: null,
      });
      await execution.assertSpawnJournalReplaceable();
      const reservation = await execution.reserve({
        endpoint: { host: "127.0.0.1", port: 5775 },
        target: {
          path: fixture.requestedTarget.displayPath,
          comparisonKey: fixture.requestedTarget.comparisonKey,
        },
        companion: null,
      });
      const replacementJournal: WorkbenchSpawnRecord = {
        transactionId: randomUUID(),
        phase: "pre_spawn",
        pid: null,
        identity: null,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        metadata: {
          purpose: "target_build",
          lifecycleGeneration: reservation.generation,
          targetKey: fixture.requestedTarget.comparisonKey,
        },
      };
      await replacement.guard.createSpawnJournal(reservation).persist(
        null,
        replacementJournal
      );
      await execution.vacate(reservation, {
        endpoint: reservation.endpoint,
        target: reservation.target,
        companion: reservation.companion,
      });
      return "built";
    });

    await expect(replacement.client.runOwnerScopedTargetBuild(
      fixture.requestedTarget.displayPath,
      action
    )).resolves.toBe("built");

    expect(action).toHaveBeenCalledOnce();
    expect(replacement.backend.endpointVacancyCalls).toEqual([
      { host: "127.0.0.1", port: 5775 },
      { host: "127.0.0.1", port: 5775 },
    ]);
    expect(await readState(replacement.guard)).toMatchObject({
      phase: "vacant",
      target: {
        path: fixture.requestedTarget.displayPath,
        comparisonKey: fixture.requestedTarget.comparisonKey,
      },
      mcpOwner: {
        pid: replacement.backend.current.pid,
        instanceId: replacement.guard.mcpInstanceId,
        leaseId: replacement.guard.leaseId,
      },
      workbench: null,
      operation: null,
    });
    expect(await replacement.guard.readSpawnJournal()).toMatchObject({
      kind: "valid",
      record: {
        transactionId: expect.not.stringMatching(fixture.journal.transactionId),
        phase: "pre_spawn",
        metadata: {
          targetKey: fixture.requestedTarget.comparisonKey,
        },
      },
    });
  });

  it("does not claim or run while the prior exact MCP owner is still live", async () => {
    const fixture = await seedInterruptedBuild("live-owner");
    const replacement = createReplacement(fixture, (backend) => {
      backend.processes.set(fixture.priorMcp.pid, fixture.priorMcp);
    });
    const action = vi.fn(async () => "built");

    await expect(replacement.client.runOwnerScopedTargetBuild(
      fixture.requestedTarget.displayPath,
      action
    )).rejects.toMatchObject({ code: "OWNED_BY_OTHER_MCP" });

    expect(action).not.toHaveBeenCalled();
    expect(replacement.backend.endpointVacancyCalls).toEqual([]);
    expect(await readState(replacement.guard)).toMatchObject({
      generation: fixture.stopping.generation,
      phase: "stopping",
      target: {
        comparisonKey: fixture.priorTarget.comparisonKey,
      },
      mcpOwner: {
        pid: fixture.priorMcp.pid,
        instanceId: fixture.stopping.mcpOwner?.instanceId,
        leaseId: fixture.stopping.mcpOwner?.leaseId,
      },
      workbench: null,
      operation: {
        kind: "shutdown",
        operationId: fixture.stopping.operation?.operationId,
      },
    });
  });

  it("preserves pre_spawn recovery evidence when any Workbench process exists", async () => {
    const fixture = await seedInterruptedBuild("workbench-live");
    const replacement = createReplacement(fixture, (backend) => {
      backend.addWorkbench({
        pid: 43_013,
        executablePath: "C:\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
        creationTime: "133900000000043013",
      }, "-reforgerForgeOwnerToken=unpublished");
    });
    const action = vi.fn(async () => "built");

    await expect(replacement.client.runOwnerScopedTargetBuild(
      fixture.requestedTarget.displayPath,
      action
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(action).not.toHaveBeenCalled();
    expect(replacement.backend.terminationCalls).toEqual([]);
    expect(replacement.backend.endpointVacancyCalls).toEqual([]);
    expect(await readState(replacement.guard)).toMatchObject({
      phase: "stopping",
      target: {
        comparisonKey: fixture.priorTarget.comparisonKey,
      },
      mcpOwner: {
        pid: replacement.backend.current.pid,
        instanceId: replacement.guard.mcpInstanceId,
        leaseId: replacement.guard.leaseId,
      },
      workbench: null,
      operation: {
        kind: "shutdown",
        operationId: fixture.stopping.operation?.operationId,
      },
    });
    expect(await replacement.guard.readSpawnJournal()).toMatchObject({
      kind: "valid",
      record: {
        transactionId: fixture.journal.transactionId,
        phase: "pre_spawn",
      },
    });
  });

  it("never signals an exact live Workbench recorded only in a published journal", async () => {
    const fixture = await seedLiveUnpublishedBuild("published-live");
    const replacement = createReplacement(fixture, (backend) => {
      backend.addWorkbench(
        fixture.unpublished,
        fixture.unpublished.ownerTokenArgument
      );
    });
    const action = vi.fn(async () => "built");

    await expect(replacement.client.runOwnerScopedTargetBuild(
      fixture.requestedTarget.displayPath,
      action
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(action).not.toHaveBeenCalled();
    expect(replacement.backend.terminationCalls).toEqual([]);
    expect(await replacement.guard.readSpawnJournal()).toMatchObject({
      kind: "valid",
      record: {
        transactionId: fixture.journal.transactionId,
        phase: "published",
        identity: {
          pid: fixture.unpublished.pid,
          creationTime: fixture.unpublished.creationTime,
        },
      },
    });
  });

  it("preserves the busy lifecycle when endpoint vacancy cannot be proven", async () => {
    const fixture = await seedInterruptedBuild("endpoint-occupied");
    const replacement = createReplacement(fixture, (backend) => {
      backend.endpointVacancyResult = {
        kind: "occupied",
        listenerPid: 44_013,
        message: "A foreign listener owns the test endpoint.",
      };
    });
    const action = vi.fn(async () => "built");

    await expect(replacement.client.runOwnerScopedTargetBuild(
      fixture.requestedTarget.displayPath,
      action
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(action).not.toHaveBeenCalled();
    expect(replacement.backend.endpointVacancyCalls).toEqual([
      { host: "127.0.0.1", port: 5775 },
    ]);
    expect(await readState(replacement.guard)).toMatchObject({
      phase: "stopping",
      target: {
        comparisonKey: fixture.priorTarget.comparisonKey,
      },
      mcpOwner: {
        pid: replacement.backend.current.pid,
        instanceId: replacement.guard.mcpInstanceId,
        leaseId: replacement.guard.leaseId,
      },
      workbench: null,
      operation: {
        kind: "shutdown",
        operationId: fixture.stopping.operation?.operationId,
      },
    });
    expect(await replacement.guard.readSpawnJournal()).toMatchObject({
      kind: "valid",
      record: {
        transactionId: fixture.journal.transactionId,
        phase: "pre_spawn",
      },
    });
  });

  it("refuses a listener that appears between the initial wait and final locked proof", async () => {
    const fixture = await seedInterruptedBuild("endpoint-race");
    const replacement = createReplacement(fixture);
    let vacancyCalls = 0;
    replacement.backend.verifyEndpointVacant = async (endpoint) => {
      replacement.backend.endpointVacancyCalls.push(endpoint);
      vacancyCalls += 1;
      return vacancyCalls === 1
        ? { kind: "vacant" }
        : {
            kind: "occupied",
            listenerPid: 44_113,
            message: "A listener appeared after the initial vacancy wait.",
          };
    };
    const action = vi.fn(async () => "built");

    await expect(replacement.client.runOwnerScopedTargetBuild(
      fixture.requestedTarget.displayPath,
      action
    )).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(action).not.toHaveBeenCalled();
    expect(vacancyCalls).toBe(2);
    expect(await readState(replacement.guard)).toMatchObject({
      phase: "stopping",
      target: {
        comparisonKey: fixture.priorTarget.comparisonKey,
      },
      mcpOwner: {
        pid: replacement.backend.current.pid,
        instanceId: replacement.guard.mcpInstanceId,
        leaseId: replacement.guard.leaseId,
      },
      operation: { kind: "shutdown" },
    });
    expect(await replacement.guard.readSpawnJournal()).toMatchObject({
      kind: "valid",
      record: {
        transactionId: fixture.journal.transactionId,
        phase: "pre_spawn",
      },
    });
  });
});
