import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createObserverApplication, type ObserverApplication } from "../../src/observer/application.js";
import type { ObserverChildDescriptor } from "../../src/observer/agent-client.js";
import {
  OwnedRuntimeManager,
  type OwnedRuntimeExactIdentity,
  type OwnedRuntimeInspection,
  type OwnedRuntimeLifecycleAuthority,
  type OwnedRuntimeLifecycleIdentity,
  type OwnedRuntimeObserverGate,
  type OwnedRuntimeProcessBackend,
  type RuntimeStopPreflight,
} from "../../src/observer/owned-runtime-manager.js";
import type { ObserverLaunchInput, ObserverPreparedLaunch } from "../../src/observer/launch.js";
import { observerAddonSource, repositoryRoot, temporaryDirectory } from "./helpers.js";

interface FixtureProcess {
  identity: OwnedRuntimeExactIdentity;
  ownerArgument: string;
}

class BoundaryBackend implements OwnedRuntimeProcessBackend {
  readonly platform = "test" as const;
  readonly processes = new Map<number, FixtureProcess>();

  async withMachineMutex<T>(args: { action: () => Promise<T> }): Promise<T> {
    return args.action();
  }

  async inspectCurrentProcess(pid: number) {
    return {
      pid,
      executablePath: process.execPath,
      creationTime: "900001",
      userSid: "S-1-5-21-private-child-boundary",
    };
  }

  async inspectProcess(pid: number, expectedOwnerTokenArgument?: string): Promise<OwnedRuntimeInspection | null> {
    const current = this.processes.get(pid);
    if (!current) return null;
    return {
      identity: { ...current.identity },
      ownerArgumentMatched: expectedOwnerTokenArgument === undefined
        ? null
        : current.ownerArgument === expectedOwnerTokenArgument,
    };
  }

  async verifyAndTerminate(expected: OwnedRuntimeExactIdentity & {
    ownerTokenArgument: string;
    launchedAtMs: number;
  }) {
    const current = this.processes.get(expected.pid);
    if (!current) return { kind: "already_exited" as const };
    if (current.identity.executablePath !== expected.executablePath) {
      return { kind: "refused" as const, reason: "executable_mismatch" as const, message: "path changed" };
    }
    if (current.identity.creationTime !== expected.creationTime) {
      return { kind: "refused" as const, reason: "creation_time_mismatch" as const, message: "creation changed" };
    }
    if (current.ownerArgument !== expected.ownerTokenArgument) {
      return { kind: "refused" as const, reason: "token_mismatch" as const, message: "owner changed" };
    }
    this.processes.delete(expected.pid);
    return { kind: "terminated" as const };
  }
}

class BoundaryChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly unref = () => undefined;

  constructor(readonly pid: number, private readonly onKill: () => void) {
    super();
  }

  kill(): boolean {
    this.onKill();
    this.signalCode = "SIGTERM";
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

type ReleaseFault = "none" | "before_delivery" | "after_application";

class FaultingApplicationGate implements OwnedRuntimeObserverGate {
  releaseAttempts = 0;

  constructor(
    private readonly application: ObserverApplication,
    private releaseFault: ReleaseFault = "none"
  ) {}

  retainRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string,
    authority: OwnedRuntimeLifecycleAuthority
  ) {
    return this.application.retainRuntimeLifecycle(sessionId, runtimeId, generation, authority);
  }

  async releaseRuntimeLifecycle(sessionId: string, runtimeId: string, generation: string) {
    this.releaseAttempts += 1;
    const fault = this.releaseFault;
    this.releaseFault = "none";
    if (fault === "before_delivery") throw new Error("fixture lost release before IPC delivery");
    const result = await this.application.releaseRuntimeLifecycle(sessionId, runtimeId, generation);
    if (fault === "after_application") throw new Error("fixture lost release response after application");
    return result;
  }

  reserveRuntimeStop(
    sessionId: string,
    proposedReservationId: string,
    exactRuntimeVacant?: boolean,
    lifecycle?: OwnedRuntimeLifecycleIdentity
  ): Promise<RuntimeStopPreflight> {
    return this.application.reserveRuntimeStop(
      sessionId,
      proposedReservationId,
      exactRuntimeVacant,
      lifecycle
    );
  }

  releaseRuntimeStop(
    sessionId: string,
    reservationId: string,
    lifecycle?: OwnedRuntimeLifecycleIdentity
  ) {
    return this.application.releaseRuntimeStop(sessionId, reservationId, lifecycle);
  }

  completeRuntimeStop(
    sessionId: string,
    reservationId?: string,
    exactRuntimeVacant?: boolean,
    lifecycle?: OwnedRuntimeLifecycleIdentity
  ) {
    return this.application.completeRuntimeStop(
      sessionId,
      reservationId,
      exactRuntimeVacant,
      lifecycle
    );
  }
}

interface BoundaryHarness {
  root: string;
  managedRoot: string;
  profileRoot: string;
  executable: string;
  application: ObserverApplication;
  gate: FaultingApplicationGate;
  backend: BoundaryBackend;
  manager: OwnedRuntimeManager;
  prepare(cycle: string, sessionTtlMs?: number): Promise<{
    input: ObserverLaunchInput;
    preparedLaunchId: string;
    sessionId: string;
    contractPath: string;
  }>;
}

const roots: string[] = [];
const applications: ObserverApplication[] = [];

afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map((application) => application.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeBoundaryHarness(
  releaseFault: ReleaseFault = "none",
  sessionTerminalRetentionMs = 0
): BoundaryHarness {
  const root = temporaryDirectory("rfo-private-child-owned-");
  roots.push(root);
  const managedRoot = join(root, "observer-managed");
  const profileRoot = join(root, "profiles");
  const runtimeManagedRoot = join(root, "runtime-managed");
  const executable = join(root, "game", "ArmaReforgerSteamDiag.exe");
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(executable, "private child boundary fixture\n");
  const application = createObserverApplication({
    agentPath: join(repositoryRoot, "tests", "observer", "fixtures", "private-child-entry.mjs"),
    managedRoot,
    profileRoot,
    sourceAddon: observerAddonSource,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    privateChildSweepIntervalMs: 100,
    privateChildSessionTerminalRetentionMs: sessionTerminalRetentionMs,
  });
  applications.push(application);
  const gate = new FaultingApplicationGate(application, releaseFault);
  const backend = new BoundaryBackend();
  let pid = 51_000;
  let id = 1;
  const spawnProcess = ((file: string, args: readonly string[]) => {
    const childPid = pid++;
    const ownerArgument = args.find((argument) => argument.startsWith("-reforgerForgeOwnerToken=")) ?? "";
    const child = new BoundaryChild(childPid, () => backend.processes.delete(childPid));
    backend.processes.set(childPid, {
      identity: {
        pid: childPid,
        executablePath: file,
        creationTime: String(800_000 + childPid),
      },
      ownerArgument,
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  const manager = new OwnedRuntimeManager({
    managedRoot: runtimeManagedRoot,
    gamePath: dirname(executable),
    observerGate: gate,
    backend,
    spawnProcess,
    executableResolver: () => executable,
    installationRoot: process.cwd(),
    ownerToken: () => `owner_${String(id).padStart(58, "0")}`,
    randomId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
    receiptRetentionMs: 0,
    // This integration fixture exercises private-child recovery across real
    // IPC and filesystem syncs. Keep its lifecycle budget independent of
    // parallel-suite load; deadline behavior has dedicated unit coverage.
    inspectionTimeoutMs: 5_000,
    terminationTimeoutMs: 5_000,
    lockTimeoutMs: 5_000,
  });

  return {
    root,
    managedRoot,
    profileRoot,
    executable,
    application,
    gate,
    backend,
    manager,
    async prepare(cycle: string, sessionTtlMs = 1_000) {
      const input: ObserverLaunchInput = {
        runtimeKind: "listenServer",
        arguments: ["-window", `-${cycle}`],
        profilePath: join(profileRoot, cycle),
        sessionTtlMs,
        transportPreference: ["rest"],
        forceUpdate: false,
      };
      const raw = await application.prepareLaunch(input as unknown as Record<string, unknown>);
      const session = raw.session as Record<string, unknown>;
      const prepared: ObserverPreparedLaunch = {
        arguments: raw.arguments as string[],
        sessionId: String(session.sessionId),
        expiresAt: String(session.expiresAt),
        bundleDigest: String(session.bundleDigest),
        profilePath: String(session.profilePath),
        warnings: [],
      };
      const preparedLaunchId = await manager.recordPreparedLaunch(input, prepared);
      return {
        input,
        preparedLaunchId,
        sessionId: prepared.sessionId,
        contractPath: String(session.contractPath),
      };
    },
  };
}

async function postJson(base: string, path: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  expect(response.status, JSON.stringify(payload)).toBe(200);
  return payload;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for private-child recovery evidence");
}

function authorityPath(value: BoundaryHarness, runtimeId: string): string {
  return join(
    value.managedRoot,
    "state",
    "owned-runtime-authorities-v1",
    `${runtimeId}.json`
  );
}

function pendingRecord(value: BoundaryHarness): { path: string; record: Record<string, unknown> } {
  const root = join(value.manager.storageRoot, "pending-starts");
  const name = readdirSync(root).find((entry) => entry.endsWith(".json"));
  if (!name) throw new Error("Expected a pending start receipt");
  const path = join(root, name);
  return { path, record: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> };
}

async function forceUnexpectedPrivateChildLoss(application: ObserverApplication): Promise<void> {
  const internals = application as unknown as { child: ChildProcess | null };
  const child = internals.child;
  if (!child) throw new Error("Expected a ready private observer child");
  child.kill("SIGKILL");
  await waitFor(() => internals.child === null);
}

async function registerGraphicalRuntime(
  descriptor: ObserverChildDescriptor,
  contract: Record<string, unknown>,
  instanceId: string,
  instanceNonce: string
): Promise<string> {
  const agent = contract.agent as Record<string, unknown>;
  const base = `http://${descriptor.host}:${descriptor.port}`;
  await postJson(base, "/v1/runtime/register", String(contract.sessionToken), {
    protocolVersion: "1.0",
    addonVersion: "0.1.0",
    bundleDigest: contract.bundleDigest,
    buildIdentity: contract.buildIdentity,
    agentInstanceId: agent.instanceId,
    sessionId: contract.sessionId,
    launchNonce: contract.launchNonce,
    instanceId,
    instanceNonce,
    processId: 42_000,
    runtimeKind: "listenServer",
    capabilities: ["render.capture", "camera.runtime", "world.query", "transport.rest"],
    selectedTransport: "rest",
    headless: false,
    worldId: "world-private-child",
    worldEpoch: 1,
    registeredAt: new Date().toISOString(),
  });
  return base;
}

async function putCameraJobIntoRestoring(
  value: BoundaryHarness,
  descriptor: ObserverChildDescriptor,
  contract: Record<string, unknown>,
  cycle: number
): Promise<{ jobId: string; instanceId: string; instanceNonce: string }> {
  const instanceId = `runtime-private-child-${cycle}`;
  const instanceNonce = `runtime_nonce_private_child_${String(cycle).padStart(32, "0")}`;
  const base = await registerGraphicalRuntime(descriptor, contract, instanceId, instanceNonce);
  const capture = await value.application.capture({
    sessionId: String(contract.sessionId),
    instanceId,
    idempotencyKey: `camera-private-child-${cycle}`,
    view: { kind: "lookAt", position: [0, 1, 0], target: [1, 1, 0], fov: 60 },
    asynchronous: true,
    timeoutMs: 1_000,
  });
  if (!capture.asynchronous) throw new Error("Expected asynchronous camera fixture job");
  const jobId = String(capture.job.jobId);
  const commandResponse = await postJson(base, "/v1/runtime/commands", String(contract.sessionToken), {
    sessionId: contract.sessionId,
    instanceId,
    instanceNonce,
  });
  const command = commandResponse.command as Record<string, unknown>;
  const status = (sequence: number, state: string, cameraLease: Record<string, unknown>, extra = {}) => ({
    protocolVersion: "1.0",
    sessionId: contract.sessionId,
    instanceId,
    instanceNonce,
    jobId,
    sequence,
    state,
    worldId: "world-private-child",
    worldEpoch: 1,
    timestamp: new Date().toISOString(),
    cameraLease,
    ...extra,
  });
  await postJson(base, "/v1/runtime/status", String(contract.sessionToken), status(1, "accepted", {
    held: false,
    restorationConfirmed: false,
  }, { deliveryToken: command.deliveryToken }));
  await postJson(base, "/v1/runtime/status", String(contract.sessionToken), status(2, "acquiringCamera", {
    held: true,
    leaseId: `lease-private-child-${cycle}`,
    observerCameraId: 42,
  }));
  await postJson(base, "/v1/runtime/status", String(contract.sessionToken), status(3, "restoring", {
    held: false,
    restorationConfirmed: false,
  }));
  return { jobId, instanceId, instanceNonce };
}

describe("actual private-child owned-runtime recovery boundary", () => {
  it("reconstructs exact camera obligations after repeated unexpected child replacement without authority growth", async () => {
    const value = makeBoundaryHarness();
    const authorityBounds: Array<{ records: number; bytes: number }> = [];

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const prepared = await value.prepare(`cycle-${cycle}`, 3_000);
      const started = await value.manager.start({
        preparedLaunchId: prepared.preparedLaunchId,
        idempotencyKey: `start-private-child-${cycle}`,
      });
      const firstDescriptor = await value.application.ensureStarted();
      const contract = JSON.parse(readFileSync(prepared.contractPath, "utf8")) as Record<string, unknown>;
      const camera = await putCameraJobIntoRestoring(value, firstDescriptor, contract, cycle);

      await forceUnexpectedPrivateChildLoss(value.application);
      await new Promise((resolve) => setTimeout(resolve, 3_100));

      await expect(value.manager.status(started.runtimeId)).resolves.toMatchObject({
        runtimeId: started.runtimeId,
        sessionId: prepared.sessionId,
        state: "stale",
        exactOwned: true,
      });
      const replacementStatus = await value.application.status();
      expect(replacementStatus.jobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          jobId: camera.jobId,
          state: "restoring",
          cameraLease: expect.objectContaining({
            everHeld: true,
            restorationConfirmed: false,
          }),
        }),
      ]));
      await expect(value.manager.stop({
        runtimeId: started.runtimeId,
        waitForRestorationMs: 0,
        idempotencyKey: `stop-private-child-${cycle}`,
      })).rejects.toMatchObject({
        code: "CAMERA_BUSY",
        details: { restorationPendingJobIds: [camera.jobId] },
      });

      const replacementDescriptor = await value.application.ensureStarted();
      const replacementBase = `http://${replacementDescriptor.host}:${replacementDescriptor.port}`;
      const status = (sequence: number, state: string, extra: Record<string, unknown> = {}) => ({
        protocolVersion: "1.0",
        sessionId: contract.sessionId,
        instanceId: camera.instanceId,
        instanceNonce: camera.instanceNonce,
        jobId: camera.jobId,
        sequence,
        state,
        worldId: "world-private-child",
        worldEpoch: 1,
        timestamp: new Date().toISOString(),
        cameraLease: { held: false, restorationConfirmed: true },
        ...extra,
      });
      await postJson(replacementBase, "/v1/runtime/status", String(contract.sessionToken), status(4, "restoring"));
      await postJson(replacementBase, "/v1/runtime/status", String(contract.sessionToken), status(5, "failed", {
        errorCode: "CAMERA_BUSY",
      }));
      await expect(value.manager.stop({
        runtimeId: started.runtimeId,
        waitForRestorationMs: 0,
        idempotencyKey: `stop-private-child-${cycle}`,
      })).resolves.toMatchObject({
        runtimeId: started.runtimeId,
        state: "exited",
        terminationComplete: true,
        observerCleanupPending: false,
      });

      await value.manager.sweep();
      await waitFor(() => !existsSync(authorityPath(value, started.runtimeId)));
      const authorityRoot = dirname(authorityPath(value, started.runtimeId));
      const names = readdirSync(authorityRoot).filter((name) => name.endsWith(".json"));
      authorityBounds.push({
        records: names.length,
        bytes: names.reduce((total, name) => total + statSync(join(authorityRoot, name)).size, 0),
      });
      expect(value.manager.diagnosticStorageStats()).toMatchObject({
        records: 0,
        activeOrRecoverableRuntimes: 0,
      });
    }

    expect(authorityBounds).toEqual([
      { records: 0, bytes: 0 },
      { records: 0, bytes: 0 },
      { records: 0, bytes: 0 },
    ]);
  }, 30_000);

  it("keeps release-required authority pinned past retention when release is lost before delivery", async () => {
    // The child durably acknowledges release before its IPC reply. Keep that
    // terminal proof for one second so the assertion cannot race the fixture's
    // otherwise immediate 100 ms terminal sweep.
    const value = makeBoundaryHarness("before_delivery", 1_000);
    const prepared = await value.prepare("release-before-delivery");
    const managerInternals = value.manager as unknown as {
      atomicWrite(root: string, target: string, record: unknown, exclusive: boolean, durable?: boolean): void;
    };
    const atomicWrite = managerInternals.atomicWrite.bind(value.manager);
    managerInternals.atomicWrite = (root, target, record, exclusive, durable) => {
      if (dirname(target) === join(value.manager.storageRoot, "runtimes")) {
        throw new Error("fixture runtime publication failure");
      }
      atomicWrite(root, target, record, exclusive, durable);
    };

    await expect(value.manager.start({
      preparedLaunchId: prepared.preparedLaunchId,
      idempotencyKey: "release-before-delivery",
    })).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    const pending = pendingRecord(value);
    const runtimeId = String(pending.record.runtimeId);
    expect(pending.record).toMatchObject({ state: "release_required" });
    expect(JSON.parse(readFileSync(authorityPath(value, runtimeId), "utf8"))).toMatchObject({
      state: "retained",
      stopReservationId: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const retainedStatus = await value.application.status();
    expect(retainedStatus.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: prepared.sessionId }),
    ]));
    expect(JSON.parse(readFileSync(authorityPath(value, runtimeId), "utf8"))).toMatchObject({
      state: "retained",
    });

    await expect(value.manager.start({
      preparedLaunchId: prepared.preparedLaunchId,
      idempotencyKey: "release-before-delivery",
    })).rejects.toMatchObject({ code: "START_UNVERIFIABLE" });
    expect(JSON.parse(readFileSync(pending.path, "utf8"))).toMatchObject({
      state: "release_acknowledged",
    });
    expect(JSON.parse(readFileSync(authorityPath(value, runtimeId), "utf8"))).toMatchObject({
      state: "release_acknowledged",
    });

    await value.manager.sweep();
    await waitFor(() => !existsSync(authorityPath(value, runtimeId)));
    await waitFor(async () => {
      const status = await value.application.status();
      return !(status.sessions as Array<Record<string, unknown>>)
        .some((session) => session.sessionId === prepared.sessionId);
    });
    expect(value.manager.diagnosticStorageStats()).toMatchObject({
      records: 0,
      activeOrRecoverableRuntimes: 0,
    });
  }, 20_000);

  it("replays the exact generation idempotently when release applied but its response was lost", async () => {
    const value = makeBoundaryHarness("after_application");
    const prepared = await value.prepare("release-response-lost");
    const managerInternals = value.manager as unknown as {
      atomicWrite(root: string, target: string, record: unknown, exclusive: boolean, durable?: boolean): void;
    };
    const atomicWrite = managerInternals.atomicWrite.bind(value.manager);
    managerInternals.atomicWrite = (root, target, record, exclusive, durable) => {
      if (dirname(target) === join(value.manager.storageRoot, "runtimes")) {
        throw new Error("fixture runtime publication failure");
      }
      atomicWrite(root, target, record, exclusive, durable);
    };

    await expect(value.manager.start({
      preparedLaunchId: prepared.preparedLaunchId,
      idempotencyKey: "release-response-lost",
    })).rejects.toMatchObject({ code: "SPAWN_FAILED" });
    const pending = pendingRecord(value);
    const runtimeId = String(pending.record.runtimeId);
    expect(pending.record).toMatchObject({ state: "release_required" });
    expect(JSON.parse(readFileSync(authorityPath(value, runtimeId), "utf8"))).toMatchObject({
      state: "release_acknowledged",
      authority: {
        runtimeId,
        sessionId: prepared.sessionId,
        generation: pending.record.lifecycleGeneration,
      },
    });

    await expect(value.manager.start({
      preparedLaunchId: prepared.preparedLaunchId,
      idempotencyKey: "release-response-lost",
    })).rejects.toMatchObject({ code: "START_UNVERIFIABLE" });
    expect(value.gate.releaseAttempts).toBe(2);
    expect(JSON.parse(readFileSync(pending.path, "utf8"))).toMatchObject({
      state: "release_acknowledged",
      lifecycleGeneration: pending.record.lifecycleGeneration,
    });
  }, 15_000);
});
