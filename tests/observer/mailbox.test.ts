import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MailboxTransport } from "../../observer/agent/mailbox.js";
import { MailboxCoordinator } from "../../observer/agent/mailbox-coordinator.js";
import { ArtifactStore } from "../../observer/agent/artifacts.js";
import { JobStore } from "../../observer/agent/jobs.js";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { cleanup, createSessionFixture, graphicalRegistration, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

describe("observer mailbox", () => {
  it("writes generated ordered commands and reads status in sequence order", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const command = {
      protocolVersion: "1.0" as const,
      jobId: "job-1",
      idempotencyKey: "capture-1",
      deadlineAt: new Date(fixture.clock.now() + 10_000).toISOString(),
      view: { kind: "current" as const },
      settleFrames: 0,
      performancePolicy: "evidence" as const,
      commandKind: "capture" as const,
      deliveryAttempt: 1,
      deliveryToken: "delivery_token_1234567890",
      deliveryLeaseExpiresAt: new Date(fixture.clock.now() + 5_000).toISOString(),
      wireView: { position: [], orientation: [], target: [], fov: "0" },
    };
    const commandPath = mailbox.writeCommand(command);
    expect(commandPath).toMatch(/000000000001-capture-job-1-1\.json$/);
    expect(mailbox.writeCommand(command)).toBe(commandPath);
    expect(mailbox.stats()).toMatchObject({ commandFiles: 1, cachedPublications: 1 });
    const base = {
      protocolVersion: "1.0",
      sessionId: fixture.created.contract.sessionId,
      instanceId: "instance-1",
      instanceNonce: "instance_nonce_123456789012345678901234",
      jobId: "job-1",
      state: "accepted",
      worldId: "world-1",
      worldEpoch: 1,
      timestamp: new Date(fixture.clock.now()).toISOString(),
      cameraLease: { held: false, restorationConfirmed: false },
    };
    writeFileSync(join(mailbox.statusDirectory, "000000000003-status-job-1.json"), JSON.stringify({ ...base, sequence: 2 }));
    writeFileSync(join(mailbox.statusDirectory, "000000000002-status-job-1.json"), JSON.stringify({ ...base, sequence: 1 }));
    writeFileSync(join(mailbox.statusDirectory, "000000000004-status-job-1.json.tmp"), "incomplete");
    expect(mailbox.readStatuses(base.sessionId, base.instanceId).map((status) => status.sequence)).toEqual([1, 2]);
    expect(mailbox.acknowledgeStatus("job-1", 1)).toBe(true);
    expect(mailbox.acknowledgeStatus("job-1", 1)).toBe(false);
  });

  it("connects mailbox registration and command publication to the agent stores", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const registration = graphicalRegistration(fixture.created, {
      selectedTransport: "mailbox",
      capabilities: ["render.capture", "transport.mailbox"],
    });
    const registrationName = `000000000001-registration-${registration.sessionId}.json`;
    writeFileSync(join(mailbox.statusDirectory, registrationName), JSON.stringify({
      ...registration,
      sessionToken: fixture.created.contract.sessionToken,
    }));
    writeFileSync(join(mailbox.statusDirectory, `${registrationName}.complete`), "ready");
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts);
    await coordinator.pollOnce();
    expect(registry.diagnostics()).toMatchObject([{ instanceId: registration.instanceId, selectedTransport: "mailbox" }]);
    const job = jobs.submit({
      sessionId: registration.sessionId,
      idempotencyKey: "mailbox-capture",
      deadlineAt: new Date(fixture.clock.now() + 10_000).toISOString(),
      view: { kind: "current" },
    });
    await coordinator.pollOnce();
    expect(readdirSync(mailbox.commandsDirectory).some((name) => name.includes(`-capture-${job.request.jobId}-1.json`))).toBe(true);
  });

  it("accounts for exact pretty-printed command bytes before writing", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const command = {
      protocolVersion: "1.0" as const,
      jobId: `job-${"j".repeat(80)}`,
      idempotencyKey: "i".repeat(128),
      deadlineAt: new Date(fixture.clock.now() + 10_000).toISOString(),
      view: { kind: "pose" as const, position: [1, 2, 3] as [number, number, number], orientation: [0, 0, 0, 1] as [number, number, number, number], fov: 60 },
      settleFrames: 30,
      performancePolicy: "instrumented" as const,
      commandKind: "capture" as const,
      deliveryAttempt: 1,
      deliveryToken: "d".repeat(256),
      deliveryLeaseExpiresAt: new Date(fixture.clock.now() + 5_000).toISOString(),
      wireView: {
        position: ["1".repeat(32), "2".repeat(32), "3".repeat(32)],
        orientation: ["4".repeat(32), "5".repeat(32), "6".repeat(32), "7".repeat(32)],
        target: [],
        fov: "8".repeat(32),
      },
    };
    const exactBytes = Buffer.byteLength(`${JSON.stringify({ sequence: 1, ...command }, null, 2)}\n`);
    expect(exactBytes).toBeGreaterThan(1_024);
    const mailbox = new MailboxTransport(fixture.profilePath, { maxCommandBytes: exactBytes - 1 });
    expect(() => mailbox.writeCommand(command)).toThrowError(expect.objectContaining({ code: "TRANSPORT_UNAVAILABLE" }));
    expect(mailbox.stats().commandFiles).toBe(0);
  });

  it("wraps an imported maximum command sequence without emitting a rejected 13-digit filename", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const initial = new MailboxTransport(fixture.profilePath);
    writeFileSync(
      join(initial.commandsDirectory, "999999999999-capture-poison-1.json"),
      JSON.stringify({ deliveryLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
    );
    const mailbox = new MailboxTransport(fixture.profilePath);
    const command = {
      protocolVersion: "1.0" as const,
      jobId: "job-after-wrap",
      idempotencyKey: "capture-after-wrap",
      instanceId: "instance-1",
      worldEpoch: 1,
      deadlineAt: new Date(fixture.clock.now() + 10_000).toISOString(),
      view: { kind: "current" as const },
      settleFrames: 0,
      performancePolicy: "evidence" as const,
      commandKind: "capture" as const,
      deliveryAttempt: 1,
      deliveryToken: "delivery_token_after_wrap_1234",
      deliveryLeaseExpiresAt: new Date(fixture.clock.now() + 5_000).toISOString(),
      wireView: { position: [], orientation: [], target: [], fov: "0" },
    };

    const commandPath = mailbox.writeCommand(command);

    expect(commandPath).toMatch(/000000000001-capture-job-after-wrap-1\.json$/);
    expect(commandPath).not.toMatch(/\d{13}-capture-/);
    expect(JSON.parse(readFileSync(commandPath, "utf8"))).toMatchObject({ sequence: 1, jobId: command.jobId });
  });

  it("rejects imported command usage atomically when aggregate admission is over budget", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const retainedCommand = join(mailbox.commandsDirectory, "000000000001-capture-imported-job-1.json");
    writeFileSync(retainedCommand, JSON.stringify({
      deliveryLeaseExpiresAt: new Date(fixture.clock.now() + 60_000).toISOString(),
      padding: "x".repeat(2_048),
    }));
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      maxEstimatedBytes: 1_024,
    });

    await coordinator.pollOnce();

    expect(existsSync(retainedCommand)).toBe(true);
    expect(coordinator.stats()).toMatchObject({
      transports: 0,
      commandFiles: 0,
      commandBytes: 0,
      maxEstimatedBytes: 1_024,
    });
    expect(coordinator.stats().estimatedBytes).toBeLessThanOrEqual(1_024);

    unlinkSync(retainedCommand);
    await coordinator.pollOnce();
    expect(coordinator.stats()).toMatchObject({ transports: 1, commandFiles: 0, commandBytes: 0 });
    expect(coordinator.stats().estimatedBytes).toBeLessThanOrEqual(1_024);
  });

  it("consumes restored ownership-loss status and the following heartbeat without quarantine", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const registration = graphicalRegistration(fixture.created, {
      selectedTransport: "mailbox",
      capabilities: ["render.capture", "camera.runtime", "world.query", "transport.mailbox"],
    });
    registry.register(registration, fixture.created.contract.sessionToken);
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts);
    const job = jobs.submit({
      sessionId: registration.sessionId,
      idempotencyKey: "mailbox-ownership-loss",
      deadlineAt: new Date(fixture.clock.now() + 30_000).toISOString(),
      view: { kind: "lookAt", position: [0, 1, 0], target: [1, 1, 0], fov: 60 },
    });
    const command = jobs.nextCommand(registration.sessionId, registration.instanceId, registration.instanceNonce)!;
    const baseStatus = {
      protocolVersion: "1.0",
      sessionId: registration.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      jobId: job.request.jobId,
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      timestamp: new Date(fixture.clock.now()).toISOString(),
      deliveryToken: command.deliveryToken,
    };
    const heldCamera = { held: true, leaseId: `lease-${job.request.jobId}`, observerCameraId: 42 } as const;
    const restoredCamera = { held: false, restorationConfirmed: true } as const;
    const update = (sequence: number, state: string, cameraLease: typeof heldCamera | typeof restoredCamera | { held: false; restorationConfirmed: false }) => {
      jobs.update({ ...baseStatus, sequence, state, cameraLease }, fixture.created.contract.sessionToken);
    };
    update(0, "accepted", { held: false, restorationConfirmed: false });
    update(1, "acquiringCamera", heldCamera);
    update(2, "positioning", heldCamera);
    update(3, "capturing", heldCamera);
    update(4, "restoring", restoredCamera);

    const terminalName = `000000000006-status-${job.request.jobId}.json`;
    writeFileSync(join(mailbox.statusDirectory, terminalName), JSON.stringify({
      ...baseStatus,
      sequence: 5,
      state: "failed",
      cameraLease: restoredCamera,
      errorCode: "CAMERA_OWNERSHIP_LOST",
      message: "Observer camera ownership changed before screenshot issuance",
      sessionToken: fixture.created.contract.sessionToken,
    }));
    writeFileSync(join(mailbox.statusDirectory, `${terminalName}.complete`), "ready");

    const heartbeatName = `000000000007-heartbeat-${registration.instanceId}.json`;
    writeFileSync(join(mailbox.statusDirectory, heartbeatName), JSON.stringify({
      protocolVersion: "1.0",
      sessionId: registration.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      sequence: 48,
      sentAt: new Date(fixture.clock.now()).toISOString(),
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      capabilities: registration.capabilities,
      activeJobId: null,
      cameraLeaseJobId: null,
      transportHealthy: true,
      lastErrorCode: "CAMERA_OWNERSHIP_LOST",
      sessionToken: fixture.created.contract.sessionToken,
    }));
    writeFileSync(join(mailbox.statusDirectory, `${heartbeatName}.complete`), "ready");

    await coordinator.pollOnce();

    expect(job).toMatchObject({
      state: "failed",
      terminalErrorCode: "CAMERA_OWNERSHIP_LOST",
      cameraLease: { held: false, restorationConfirmed: true },
    });
    expect(registry.require(registration.sessionId, registration.instanceId)).toMatchObject({
      lastHeartbeatSequence: 48,
      activeJobId: null,
      cameraLeaseJobId: null,
      lastErrorCode: "CAMERA_OWNERSHIP_LOST",
    });
    expect(existsSync(join(mailbox.statusDirectory, terminalName))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, `${terminalName}.complete`))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, heartbeatName))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, `${heartbeatName}.complete`))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, "quarantine"))).toBe(false);
  });

  it("permanently rejects malformed ingress into bounded quarantine immediately", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const name = "000000000001-status-malformed.json";
    writeFileSync(join(mailbox.statusDirectory, name), "{not-json");
    writeFileSync(join(mailbox.statusDirectory, `${name}.complete`), "ready");
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts);
    await coordinator.pollOnce();
    expect(existsSync(join(mailbox.statusDirectory, name))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, `${name}.complete`))).toBe(false);
    expect(readdirSync(join(mailbox.statusDirectory, "quarantine"))).toHaveLength(1);
    expect(coordinator.stats()).toMatchObject({ permanentRejected: 1, quarantined: 1, trackedRetries: 0 });
  });

  it("bounds transient retries by attempt count before quarantining", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const name = "000000000001-status-missing.json";
    writeFileSync(join(mailbox.statusDirectory, `${name}.complete`), "ready");
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      maxRetryAttempts: 3,
    });
    await coordinator.pollOnce();
    await coordinator.pollOnce();
    expect(existsSync(join(mailbox.statusDirectory, `${name}.complete`))).toBe(true);
    await coordinator.pollOnce();
    expect(existsSync(join(mailbox.statusDirectory, `${name}.complete`))).toBe(false);
    expect(coordinator.stats()).toMatchObject({ transientRetries: 3, quarantined: 1, trackedRetries: 0 });
  });

  it("stores a bounded summary when rejected ingress exceeds the quarantine byte budget", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const name = "000000000001-status-large-poison.json";
    writeFileSync(join(mailbox.statusDirectory, name), "x".repeat(2_048));
    writeFileSync(join(mailbox.statusDirectory, `${name}.complete`), "ready");
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      quarantineMaxBytes: 1_024,
      maxEstimatedBytes: 8 * 1_024,
    });

    await coordinator.pollOnce();

    const quarantine = join(mailbox.statusDirectory, "quarantine");
    const files = readdirSync(quarantine);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(quarantine, files[0]), "utf8"))).toMatchObject({
      disposition: "permanent_rejection",
      sourceBytes: 2_048,
    });
    expect(coordinator.stats().quarantineBytes).toBeLessThanOrEqual(1_024);
    expect(coordinator.stats().estimatedBytes).toBeLessThanOrEqual(8 * 1_024);
  });

  it("drops forensic evidence when non-removable metadata leaves no aggregate byte budget", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      const name = `${String(sequence).padStart(12, "0")}-status-missing-${"x".repeat(40)}-${sequence}.json`;
      writeFileSync(join(mailbox.statusDirectory, `${name}.complete`), "ready");
    }
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      maxRetryAttempts: 100,
      maxTrackedRetries: 100,
      maxEstimatedBytes: 2 * 1_024,
    });

    await coordinator.pollOnce();

    expect(coordinator.stats().estimatedBytes).toBeLessThanOrEqual(2 * 1_024);
    expect(coordinator.stats().trackedRetries).toBeLessThan(20);
    expect(coordinator.stats().quarantineDropped).toBeGreaterThan(0);
  });

  it("consumes valid ingress after more than one batch of poison while bounding forensic evidence", async () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      const name = `${String(sequence).padStart(12, "0")}-status-poison-${sequence}.json`;
      writeFileSync(join(mailbox.statusDirectory, name), "{not-json");
      writeFileSync(join(mailbox.statusDirectory, `${name}.complete`), "ready");
    }
    const registration = graphicalRegistration(fixture.created, {
      selectedTransport: "mailbox",
      capabilities: ["render.capture", "transport.mailbox"],
    });
    const validName = `000000000301-registration-${registration.sessionId}.json`;
    writeFileSync(join(mailbox.statusDirectory, validName), JSON.stringify({
      ...registration,
      sessionToken: fixture.created.contract.sessionToken,
    }));
    writeFileSync(join(mailbox.statusDirectory, `${validName}.complete`), "ready");
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      maxIngressPerPoll: 256,
      quarantineMaxRecords: 32,
      quarantineMaxBytes: 64 * 1024,
    });

    await coordinator.pollOnce();
    expect(registry.stats().records).toBe(0);
    await coordinator.pollOnce();

    expect(registry.require(registration.sessionId, registration.instanceId).registration.instanceId)
      .toBe(registration.instanceId);
    expect(existsSync(join(mailbox.statusDirectory, validName))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, `${validName}.complete`))).toBe(false);
    expect(coordinator.stats()).toMatchObject({
      accepted: 1,
      permanentRejected: 300,
      trackedRetries: 0,
      quarantineMaxRecords: 32,
      quarantineMaxBytes: 64 * 1024,
    });
    expect(coordinator.stats().quarantineFiles).toBeLessThanOrEqual(32);
    expect(coordinator.stats().quarantineBytes).toBeLessThanOrEqual(64 * 1024);

    expect(coordinator.stats().transports).toBe(1);
    fixture.store.revoke(registration.sessionId);
    coordinator.sweep(fixture.clock.now(), new Set([registration.sessionId]));
    expect(coordinator.stats().transports).toBe(1);
    coordinator.sweep(fixture.clock.now());
    expect(coordinator.stats().transports).toBe(0);
  });
});
