import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObserverLaunchInput, ObserverPreparedLaunch } from "../../src/observer/launch.js";
import { createObserverApplication } from "../../observer/agent/application.js";
import { OBSERVER_BUILD_IDENTITY } from "../../observer/protocol/index.js";
import {
  graphicalRegistration,
  observerAddonSource,
  testBundleDigest,
} from "../support/observer-fixtures.js";
import { ManualTime } from "../support/manual-time.js";
import {
  AgentBackedGate,
  cleanupOwnedRuntimeManagerFixtures,
  createFakeBackend,
  makeHarness,
  openAgents,
  recordExists,
  removeRecord,
  roots,
  writeRecord,
} from "./owned-runtime-manager-fixture.js";

afterEach(cleanupOwnedRuntimeManagerFixtures);

describe("OwnedRuntimeManager", () => {
  describe("pre-spawn recovery and reconciliation", () => {
  it("sweeps completed clusters while preserving live ownership obligations", async () => {
    const unused = makeHarness({ receiptRetentionMs: 1_000 });
    const unusedPrepared = await unused.prepare(["-unused"]);
    unused.setClock(Date.parse(unusedPrepared.prepared.expiresAt) + 1_001);
    await expect(unused.manager.sweep()).resolves.toMatchObject({
      removedPreparedLaunchIds: [unusedPrepared.id],
      removedRuntimeIds: [],
    });

    const completed = makeHarness({ receiptRetentionMs: 1_000 });
    const prepared = await completed.prepare();
    const started = await completed.startPrepared(prepared.id, "retention-start");
    const stopped = await completed.stop(started.runtimeId, "retention-stop");
    completed.setClock(Date.parse(stopped.stoppedAt!) + 1_001);

    await expect(completed.manager.sweep()).resolves.toMatchObject({
      removedRuntimeIds: [started.runtimeId],
      removedPreparedLaunchIds: [prepared.id],
    });
    expect(completed.manager.diagnosticStorageStats()).toMatchObject({
      prepared: 0,
      activeOrRecoverableRuntimes: 0,
      completedRuntimes: 0,
    });

    const live = makeHarness({ receiptRetentionMs: 0 });
    const livePrepared = await live.prepare();
    const liveStarted = await live.startPrepared(livePrepared.id, "live-retention-start");
    live.setClock(Date.parse(livePrepared.prepared.expiresAt) + 60_000);
    await live.manager.sweep();
    expect(recordExists(live.manager, "runtimes", liveStarted.runtimeId)).toBe(true);
    expect(live.manager.diagnosticStorageStats().activeOrRecoverableRuntimes).toBe(1);
  });

  it("keeps a live exact runtime stoppable past session TTL across manager reconciliation", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-owned-runtime-agent-lease-"));
    roots.push(root);
    const executable = join(root, "ArmaReforgerSteamDiag.exe");
    writeFileSync(executable, "fixture");
    const clock = new ManualTime({ nowMs: Date.parse("2026-07-18T12:00:00.000Z") });
    const profileRoot = join(root, "agent-profiles");
    mkdirSync(profileRoot, { recursive: true });
    const agent = createObserverApplication({
      root: join(root, "agent-managed"),
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0 },
      registry: { staleAfterMs: 1_000, staleRetentionMs: 0 },
    });
    openAgents.push(agent);
    const profilePath = join(profileRoot, "runtime-profile");
    mkdirSync(profilePath, { recursive: true });
    const created = agent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
      profilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: agent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "listenServer",
      ttlMs: 1_000,
      transportPreference: ["rest", "mailbox"],
    });
    const registration = graphicalRegistration(created, {
      agentInstanceId: agent.control.agentInstanceId,
      runtimeKind: "listenServer",
    });
    agent.registry.register(registration, created.contract.sessionToken);
    const backend = createFakeBackend();
    const gate = new AgentBackedGate(agent);
    const value = makeHarness({
      root,
      backend,
      gate,
      preparedSessionId: created.record.sessionId,
      preparedExpiresAt: created.contract.expiresAt,
      preparedProfilePath: profilePath,
    });
    value.setExecutable(executable);
    const started = await value.start("agent-lease-start", ["-window"]);
    expect(agent.server.storeDiagnostics()).toMatchObject({
      sessions: { lifecycleLeased: 1 },
      ownedRuntimeLifecyclePins: { records: 1 },
    });

    clock.advance(1_000 + 5 * 60_000 + 1);
    value.setClock(clock.now());
    const retained = agent.server.sweep(clock.now());
    expect(retained.sessions.expiredSessionIds).toEqual([]);
    expect(retained.sessions.removedSessionIds).toEqual([]);
    expect(retained.instances.removedInstanceKeys).toEqual([]);
    expect(agent.control.sessions.get(created.record.sessionId)).toBeDefined();
    expect(agent.control.revokeSession(created.record.sessionId)).toBe(true);
    expect(() => agent.control.sessions.get(created.record.sessionId))
      .toThrow(expect.objectContaining({ code: "SESSION_EXPIRED" }));

    const recovered = makeHarness({ root, backend, gate });
    recovered.setClock(clock.now());
    recovered.setExecutable(executable);
    await expect(recovered.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "stale",
      exactOwned: true,
    });
    await expect(recovered.stop(started.runtimeId, "agent-lease-stop")).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
    expect(backend.processes.has(started.pid)).toBe(false);
    expect(agent.server.storeDiagnostics()).toMatchObject({
      ownedRuntimeLifecyclePins: { records: 0 },
    });

    const released = agent.server.sweep(clock.now());
    expect(released.sessions.removedSessionIds).toEqual([created.record.sessionId]);
    expect(released.instances.removedInstanceKeys).toHaveLength(1);

    const naturalProfilePath = join(profileRoot, "natural-exit-profile");
    mkdirSync(naturalProfilePath, { recursive: true });
    const naturalSession = agent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
      profilePath: naturalProfilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: agent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "listenServer",
      ttlMs: 1_000,
      transportPreference: ["rest"],
    });
    agent.registry.register(graphicalRegistration(naturalSession, {
      agentInstanceId: agent.control.agentInstanceId,
      runtimeKind: "listenServer",
      instanceId: "instance-natural-exit",
      instanceNonce: "instance_nonce_natural_exit_123456789",
    }), naturalSession.contract.sessionToken);
    const naturalInput: ObserverLaunchInput = {
      runtimeKind: "listenServer",
      arguments: ["-window"],
      profilePath: naturalProfilePath,
      sessionTtlMs: 1_000,
      transportPreference: ["rest"],
      forceUpdate: false,
    };
    const naturalPrepared: ObserverPreparedLaunch = {
      arguments: ["-window"],
      sessionId: naturalSession.record.sessionId,
      expiresAt: naturalSession.contract.expiresAt,
      bundleDigest: naturalSession.contract.bundleDigest,
      profilePath: naturalProfilePath,
      warnings: [],
    };
    value.setClock(clock.now());
    const naturalPreparedId = await value.manager.recordPreparedLaunch(naturalInput, naturalPrepared);
    const naturalRuntime = await value.startPrepared(naturalPreparedId, "agent-natural-exit-start");
    clock.advance(1_001);
    value.setClock(clock.now());
    expect(agent.server.sweep(clock.now()).sessions.expiredSessionIds).toEqual([]);
    backend.processes.delete(naturalRuntime.pid);
    const naturalChild = value.spawnCalls.at(-1)!.child;
    naturalChild.exitCode = 0;
    naturalChild.emit("exit", 0, null);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const diagnostics = agent.server.storeDiagnostics() as {
        ownedRuntimeLifecyclePins: { records: number };
      };
      if (diagnostics.ownedRuntimeLifecyclePins.records === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(agent.server.storeDiagnostics()).toMatchObject({
      ownedRuntimeLifecyclePins: { records: 0 },
    });
    const naturalReleased = agent.server.sweep(clock.now());
    expect(naturalReleased.sessions.removedSessionIds).toEqual([naturalSession.record.sessionId]);
    expect(naturalReleased.instances.removedInstanceKeys).toHaveLength(1);
    await agent.server.close();
  });

  it("reconstructs an expired exact session and camera-restoration obligation after agent loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-owned-runtime-crash-recovery-"));
    roots.push(root);
    const executable = join(root, "ArmaReforgerSteamDiag.exe");
    writeFileSync(executable, "fixture");
    const clock = new ManualTime({ nowMs: Date.parse("2026-07-18T12:00:00.000Z") });
    const agentRoot = join(root, "agent-managed");
    const profileRoot = join(root, "agent-profiles");
    const profilePath = join(profileRoot, "runtime-profile");
    const stagedAddonPath = join(agentRoot, "addons", testBundleDigest, "ReforgerForgeObserver");
    mkdirSync(profilePath, { recursive: true });
    mkdirSync(stagedAddonPath, { recursive: true });
    const firstAgent = createObserverApplication({
      root: agentRoot,
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0 },
      registry: { staleAfterMs: 1_000, staleRetentionMs: 0 },
      jobs: { terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 },
    });
    openAgents.push(firstAgent);
    const created = firstAgent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath,
      profilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: firstAgent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "listenServer",
      ttlMs: 1_000,
      transportPreference: ["rest", "mailbox"],
    });
    const registration = graphicalRegistration(created, {
      agentInstanceId: firstAgent.control.agentInstanceId,
      runtimeKind: "listenServer",
    });
    firstAgent.registry.register(registration, created.contract.sessionToken);
    const backend = createFakeBackend();
    const first = makeHarness({
      root,
      backend,
      gate: new AgentBackedGate(firstAgent),
      receiptRetentionMs: 0,
      preparedSessionId: created.record.sessionId,
      preparedExpiresAt: created.contract.expiresAt,
      preparedProfilePath: profilePath,
    });
    first.setExecutable(executable);
    const started = await first.start("crash-recovery-start", ["-window"]);

    const job = firstAgent.jobs.submit({
      sessionId: created.record.sessionId,
      instanceId: registration.instanceId,
      idempotencyKey: "crash-camera-job",
      deadlineAt: new Date(clock.now() + 900).toISOString(),
      view: { kind: "lookAt", position: [0, 1, 0], target: [1, 1, 0], fov: 60 },
    });
    const command = firstAgent.jobs.nextCommand(
      created.record.sessionId,
      registration.instanceId,
      registration.instanceNonce
    )!;
    const status = (
      sequence: number,
      state: string,
      cameraLease: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ) => ({
      protocolVersion: "1.0",
      sessionId: created.record.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      jobId: job.request.jobId,
      sequence,
      state,
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      timestamp: new Date(clock.now()).toISOString(),
      cameraLease,
      ...extra,
    });
    firstAgent.jobs.update(status(1, "accepted", {
      held: false,
      restorationConfirmed: false,
    }, { deliveryToken: command.deliveryToken }), created.contract.sessionToken);
    firstAgent.jobs.update(status(2, "acquiringCamera", {
      held: true,
      leaseId: "lease-crash",
      observerCameraId: 42,
    }), created.contract.sessionToken);
    firstAgent.jobs.update(status(3, "restoring", {
      held: false,
      restorationConfirmed: false,
    }), created.contract.sessionToken);

    // Simulate an unclean private-child loss by abandoning the first composed
    // agent without its close/seal path, then pass beyond both TTL and normal
    // zero-retention tombstones before constructing the replacement.
    clock.advance(2_000);
    first.setClock(clock.now());
    const replacementAgent = createObserverApplication({
      root: agentRoot,
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0 },
      registry: { staleAfterMs: 1_000, staleRetentionMs: 0 },
      jobs: { terminalJobRetentionMs: 1, idempotencyReceiptRetentionMs: 1 },
    });
    openAgents.push(replacementAgent);
    const recovered = makeHarness({
      root,
      backend,
      gate: new AgentBackedGate(replacementAgent),
      receiptRetentionMs: 0,
    });
    recovered.setClock(clock.now());
    recovered.setExecutable(executable);

    await expect(recovered.manager.status(started.runtimeId)).resolves.toMatchObject({
      state: "stale",
      exactOwned: true,
    });
    expect(replacementAgent.server.storeDiagnostics()).toMatchObject({
      sessions: { records: 1, lifecycleLeased: 1 },
      jobs: { jobs: 1, restorationObligations: 1 },
      instances: { records: 1 },
      ownedRuntimeAuthorities: { records: 1, retained: 1 },
    });
    await expect(recovered.stop(started.runtimeId, "crash-recovery-stop")).rejects.toMatchObject({
      code: "CAMERA_BUSY",
      details: { restorationPendingJobIds: [job.request.jobId] },
    });

    replacementAgent.jobs.update(status(4, "restoring", {
      held: false,
      restorationConfirmed: true,
    }), created.contract.sessionToken);
    replacementAgent.jobs.update(status(5, "failed", {
      held: false,
      restorationConfirmed: true,
    }, { errorCode: "CAMERA_BUSY" }), created.contract.sessionToken);
    await expect(recovered.stop(started.runtimeId, "crash-recovery-stop")).resolves.toMatchObject({
      state: "exited",
      terminationComplete: true,
      observerCleanupPending: false,
    });
    await recovered.manager.sweep(clock.now());
    replacementAgent.server.sweep(clock.now());
    expect(recovered.manager.diagnosticStorageStats()).toMatchObject({
      records: 0,
      activeOrRecoverableRuntimes: 0,
    });
    expect(replacementAgent.server.storeDiagnostics()).toMatchObject({
      sessions: { records: 0, lifecycleLeased: 0 },
      ownedRuntimeLifecyclePins: { records: 0 },
      ownedRuntimeAuthorities: { records: 0, retained: 0 },
    });
    await replacementAgent.server.close();
  });

  it("resumes partial terminal cleanup and preserves descriptors referenced by broken live links", async () => {
    const completed = makeHarness({ receiptRetentionMs: 0 });
    const prepared = await completed.prepare();
    const started = await completed.startPrepared(prepared.id, "partial-cleanup-start");
    await completed.stop(started.runtimeId, "partial-cleanup-stop");
    removeRecord(completed.manager, "runtimes", started.runtimeId);
    removeRecord(completed.manager, "stops", started.runtimeId);
    await expect(completed.manager.sweep()).resolves.toMatchObject({
      removedRuntimeIds: [started.runtimeId],
      removedPreparedLaunchIds: [prepared.id],
    });
    expect(recordExists(completed.manager, "stop-completions", started.runtimeId)).toBe(false);

    const live = makeHarness({ receiptRetentionMs: 0 });
    const livePrepared = await live.prepare();
    const liveStarted = await live.startPrepared(livePrepared.id, "broken-link-start");
    removeRecord(live.manager, "consumed", livePrepared.id);
    live.setClock(Date.parse(livePrepared.prepared.expiresAt) + 1);
    await live.manager.sweep();
    expect(recordExists(live.manager, "prepared", livePrepared.id)).toBe(true);
    expect(recordExists(live.manager, "runtimes", liveStarted.runtimeId)).toBe(true);
  });

  it("scopes a corrupt live forward receipt to its consumed preparation", async () => {
    const value = makeHarness({ receiptRetentionMs: 0 });
    const livePrepared = await value.prepare(["-live-corrupt"]);
    const live = await value.startPrepared(livePrepared.id, "corrupt-forward-live");
    const unused = await value.prepare(["-unrelated-unused"]);

    removeRecord(value.manager, "pending-starts", live.runtimeId);
    writeRecord(value.manager, "runtimes", live.runtimeId, "{\n");
    value.setClock(Math.max(
      Date.parse(livePrepared.prepared.expiresAt),
      Date.parse(unused.prepared.expiresAt)
    ) + 1);

    await expect(value.manager.sweep()).resolves.toMatchObject({
      removedPreparedLaunchIds: [unused.id],
    });
    expect(recordExists(value.manager, "prepared", unused.id)).toBe(false);
    expect(recordExists(value.manager, "prepared", livePrepared.id)).toBe(true);
    expect(recordExists(value.manager, "consumed", livePrepared.id)).toBe(true);
    expect(recordExists(value.manager, "runtimes", live.runtimeId)).toBe(true);
  });

  it("keeps the terminal cleanup trigger when an idempotency unlink fails", async () => {
    const value = makeHarness({ receiptRetentionMs: 0 });
    const started = await value.start("retryable-unlink-start");
    await value.stop(started.runtimeId, "retryable-unlink-stop");

    const manager = value.manager as unknown as {
      unlinkOwnedFile(target: string): void;
    };
    const unlinkOwnedFile = manager.unlinkOwnedFile.bind(value.manager);
    let failIdempotencyUnlink = true;
    manager.unlinkOwnedFile = (target) => {
      if (failIdempotencyUnlink && target.includes(`${join("", "idempotency")}`)) {
        throw Object.assign(new Error("fixture unlink failure"), { code: "EPERM" });
      }
      unlinkOwnedFile(target);
    };

    await expect(value.manager.sweep()).resolves.toMatchObject({ removedRuntimeIds: [] });
    expect(recordExists(value.manager, "stop-completions", started.runtimeId)).toBe(true);

    failIdempotencyUnlink = false;
    await expect(value.manager.sweep()).resolves.toMatchObject({
      removedRuntimeIds: [started.runtimeId],
    });
    expect(recordExists(value.manager, "stop-completions", started.runtimeId)).toBe(false);
  });

  });
});
