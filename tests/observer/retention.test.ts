import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createObserverAgent } from "../../observer/agent/index.js";
import { OBSERVER_BUILD_IDENTITY } from "../../observer/protocol/index.js";
import {
  cleanup,
  createSessionFixture,
  FakeClock,
  graphicalRegistration,
  observerAddonSource,
  temporaryDirectory,
  testBundleDigest,
} from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

describe("observer in-memory retention", () => {
  it("retains a session tombstone through its retry window and explicit recovery pin", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const clock = new FakeClock();
    const fixture = createSessionFixture(root, clock, {
      terminalRetentionMs: 100,
      maxRecords: 4,
      maxEstimatedBytes: 64 * 1024,
    });
    const sessionId = fixture.created.record.sessionId;
    expect(fixture.store.pin(sessionId, "recovery-test")).toBe(true);
    fixture.store.revoke(sessionId);
    clock.advance(101);

    expect(fixture.store.sweep(clock.now()).removedSessionIds).toEqual([]);
    expect(fixture.store.stats()).toMatchObject({ records: 1, terminal: 1, pinned: 1, maxRecords: 4 });
    expect(fixture.store.stats().estimatedBytes).toBeLessThanOrEqual(64 * 1024);

    expect(fixture.store.unpin(sessionId, "recovery-test")).toBe(true);
    expect(fixture.store.sweep(clock.now()).removedSessionIds).toEqual([sessionId]);
    expect(fixture.store.stats()).toMatchObject({ records: 0, pinned: 0 });
  });

  it("orders application sweeping so jobs and open runs pin session-owned instances", async () => {
    const root = temporaryDirectory("rfo-retention-");
    roots.push(root);
    const clock = new FakeClock();
    const profileRoot = join(root, "profiles");
    mkdirSync(profileRoot, { recursive: true });
    const agent = createObserverAgent({
      root: join(root, "managed"),
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: {
        terminalRetentionMs: 0,
        maxRecords: 8,
        maxEstimatedBytes: 256 * 1024,
      },
      registry: {
        staleAfterMs: 1_000,
        staleRetentionMs: 0,
        maxRecords: 8,
        maxEstimatedBytes: 256 * 1024,
      },
    });
    const profilePath = join(profileRoot, "retention-case");
    mkdirSync(profilePath, { recursive: true });
    const created = agent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
      profilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: agent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "client",
      ttlMs: 20 * 60_000,
      transportPreference: ["rest", "mailbox"],
    });
    const registration = graphicalRegistration(created, { agentInstanceId: agent.control.agentInstanceId });
    agent.registry.register(registration, created.contract.sessionToken);
    const job = agent.jobs.submit({
      sessionId: created.record.sessionId,
      idempotencyKey: "retention-job",
      deadlineAt: new Date(clock.now() + 30_000).toISOString(),
      view: { kind: "current" },
    });
    agent.control.revokeSession(created.record.sessionId);

    agent.server.sweep(clock.now());
    expect(agent.control.sessions.stats().records).toBe(1);
    expect(agent.registry.stats().records).toBe(1);

    const run = agent.runs.begin({ title: "Retention pin" });
    const runId = run.runId as string;
    agent.runs.reserveCapture({
      runId,
      captureLabel: "retained-capture",
      idempotencyKey: "retained-capture",
      requestedView: { kind: "current" },
      performancePolicy: "evidence",
    });
    agent.runs.bindCapture({
      runId,
      captureLabel: "retained-capture",
      backend: "runtime",
      sessionId: created.record.sessionId,
      jobId: job.request.jobId,
      instanceId: registration.instanceId,
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
    });
    agent.jobs.cancel(created.record.sessionId, job.request.jobId);
    agent.server.sweep(clock.now());
    expect(agent.control.sessions.stats().records).toBe(1);
    expect(agent.registry.stats().records).toBe(1);

    agent.runs.discard(runId);
    clock.advance(11 * 60_000);
    const finalSweep = agent.server.sweep(clock.now());
    expect(finalSweep.instances.removedInstanceKeys).toHaveLength(1);
    expect(finalSweep.sessions.removedSessionIds).toEqual([created.record.sessionId]);
    expect(agent.server.storeDiagnostics()).toMatchObject({
      sessions: { records: 0, maxRecords: 8 },
      instances: { records: 0, maxRecords: 8 },
      mailbox: { transports: 0 },
    });
    await agent.server.close();
    expect(agent.server.storeDiagnostics()).toMatchObject({ lastSweep: { retentionApplied: true } });
  });

  it("does not let stale heartbeat job IDs outlive the authoritative job obligation", async () => {
    const root = temporaryDirectory("rfo-stale-heartbeat-");
    roots.push(root);
    const clock = new FakeClock();
    const profileRoot = join(root, "profiles");
    mkdirSync(profileRoot, { recursive: true });
    const agent = createObserverAgent({
      root: join(root, "managed"),
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0 },
      registry: { staleAfterMs: 1_000, staleRetentionMs: 0 },
    });
    const profilePath = join(profileRoot, "stale-heartbeat-case");
    mkdirSync(profilePath, { recursive: true });
    const created = agent.control.sessions.create({
      bundleDigest: testBundleDigest,
      stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
      profilePath,
      agent: { host: "127.0.0.1", port: 47831, instanceId: agent.control.agentInstanceId },
      buildIdentity: OBSERVER_BUILD_IDENTITY,
      expectedRuntimeKind: "client",
      ttlMs: 20 * 60_000,
      transportPreference: ["rest"],
    });
    const registration = graphicalRegistration(created, { agentInstanceId: agent.control.agentInstanceId });
    agent.registry.register(registration, created.contract.sessionToken);
    const job = agent.jobs.submit({
      sessionId: created.record.sessionId,
      idempotencyKey: "stale-heartbeat-job",
      deadlineAt: new Date(clock.now() + 30_000).toISOString(),
      view: { kind: "current" },
    });
    agent.registry.heartbeat({
      protocolVersion: "1.0",
      sessionId: registration.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      sequence: 1,
      sentAt: new Date(clock.now()).toISOString(),
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      capabilities: registration.capabilities,
      activeJobId: job.request.jobId,
      cameraLeaseJobId: job.request.jobId,
      transportHealthy: true,
    }, created.contract.sessionToken);
    agent.jobs.cancel(created.record.sessionId, job.request.jobId);
    agent.control.revokeSession(created.record.sessionId);
    clock.advance(11 * 60_000);

    const swept = agent.server.sweep(clock.now());

    expect(swept.jobs.removedJobs).toContain(job.request.jobId);
    expect(swept.instances.removedInstanceKeys).toHaveLength(1);
    expect(swept.sessions.removedSessionIds).toContain(created.record.sessionId);
    expect(agent.server.storeDiagnostics()).toMatchObject({
      sessions: { records: 0 },
      instances: { records: 0 },
      jobs: { jobs: 0 },
    });
    await agent.server.close();
  });

  it("does not perform an uncoordinated retention sweep during session or job admission", async () => {
    const root = temporaryDirectory("rfo-admission-retention-");
    roots.push(root);
    const clock = new FakeClock();
    const profileRoot = join(root, "profiles");
    mkdirSync(profileRoot, { recursive: true });
    const agent = createObserverAgent({
      root: join(root, "managed"),
      profileRoot,
      sourceDirectory: observerAddonSource,
      clock,
      sessionStore: { terminalRetentionMs: 0, maxRecords: 8 },
      jobs: {
        terminalJobRetentionMs: 1,
        idempotencyReceiptRetentionMs: 1,
        maxRecords: 8,
      },
    });
    const makeSession = (name: string) => {
      const profilePath = join(profileRoot, name);
      mkdirSync(profilePath, { recursive: true });
      return agent.control.sessions.create({
        bundleDigest: testBundleDigest,
        stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
        profilePath,
        agent: { host: "127.0.0.1", port: 47831, instanceId: agent.control.agentInstanceId },
        buildIdentity: OBSERVER_BUILD_IDENTITY,
        expectedRuntimeKind: "client",
        ttlMs: 20 * 60_000,
        transportPreference: ["rest"],
      });
    };
    const first = makeSession("protected-first");
    const firstRegistration = graphicalRegistration(first, { agentInstanceId: agent.control.agentInstanceId });
    agent.registry.register(firstRegistration, first.contract.sessionToken);
    const protectedJob = agent.jobs.submit({
      sessionId: first.record.sessionId,
      idempotencyKey: "run-protected-job",
      deadlineAt: new Date(clock.now() + 30_000).toISOString(),
      view: { kind: "current" },
    });
    const runId = agent.runs.begin({ title: "Admission retention pin" }).runId as string;
    agent.runs.reserveCapture({
      runId,
      captureLabel: "protected",
      idempotencyKey: "run-protected-job",
      requestedView: { kind: "current" },
      performancePolicy: "evidence",
    });
    agent.runs.bindCapture({
      runId,
      captureLabel: "protected",
      backend: "runtime",
      sessionId: first.record.sessionId,
      jobId: protectedJob.request.jobId,
      instanceId: firstRegistration.instanceId,
      worldId: firstRegistration.worldId,
      worldEpoch: firstRegistration.worldEpoch,
    });
    agent.jobs.cancel(first.record.sessionId, protectedJob.request.jobId);
    agent.control.revokeSession(first.record.sessionId);
    clock.advance(11 * 60_000);

    const second = makeSession("second-admission");
    expect(agent.control.sessions.peek(first.record.sessionId)).toBeDefined();
    const secondRegistration = graphicalRegistration(second, {
      agentInstanceId: agent.control.agentInstanceId,
      instanceId: "instance-second",
      instanceNonce: "instance_nonce_second_1234567890123456",
    });
    agent.registry.register(secondRegistration, second.contract.sessionToken);
    agent.jobs.submit({
      sessionId: second.record.sessionId,
      idempotencyKey: "second-job",
      deadlineAt: new Date(clock.now() + 30_000).toISOString(),
      view: { kind: "current" },
    });
    expect(agent.jobs.require(first.record.sessionId, protectedJob.request.jobId)).toBe(protectedJob);

    await agent.server.close();
  });
});
