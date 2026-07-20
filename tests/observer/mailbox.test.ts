import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MailboxTransport } from "../../observer/agent/mailbox.js";
import { MailboxCoordinator } from "../../observer/agent/mailbox-coordinator.js";
import { ArtifactStore } from "../../observer/agent/artifacts.js";
import { JobStore } from "../../observer/agent/jobs.js";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { atomicWriteFile } from "../../observer/agent/paths.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";
import { createObserverSessionFixture, graphicalRegistration, observerAddonSource } from "../support/observer-fixtures.js";

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
  timeoutMs = 5_000,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "rfo-mailbox-" }), timeoutMs);
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function enforceMethod(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Missing Enforce method: ${signature}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed Enforce method: ${signature}`);
}

describe("observer mailbox", () => {
  scopedIt("writes generated ordered commands and reads status in sequence order", (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("connects mailbox registration and command publication to the agent stores", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("accounts for exact pretty-printed command bytes before writing", (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("wraps an imported maximum command sequence without emitting a rejected 13-digit filename", (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("rejects imported command usage atomically when aggregate admission is over budget", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("rolls back transport admission when the command-usage index fails during commit", async (root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, { clock: fixture.clock });
    const commandUsage = (coordinator as unknown as {
      commandUsageBySession: Map<string, { files: number; bytes: number }>;
    }).commandUsageBySession;
    vi.spyOn(commandUsage, "set").mockImplementationOnce(() => {
      throw new Error("injected command usage admission failure");
    });

    await coordinator.pollOnce();

    expect(coordinator.sessionIds()).toEqual(new Set());
    expect(coordinator.stats()).toMatchObject({ transports: 0, commandFiles: 0, commandBytes: 0 });

    await coordinator.pollOnce();
    expect(coordinator.sessionIds()).toEqual(new Set([fixture.created.contract.sessionId]));
    expect(coordinator.stats().transports).toBe(1);
  });

  scopedIt("consumes restored ownership-loss status and the following heartbeat without quarantine", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("permanently rejects malformed ingress into bounded quarantine immediately", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("bounds transient retries by attempt count before quarantining", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("admits the newest retry through the shared bounded map before applying mailbox eviction policy", async (root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const first = "000000000001-status-missing-first.json";
    const second = "000000000002-status-missing-second.json";
    writeFileSync(join(mailbox.statusDirectory, `${first}.complete`), "ready");
    writeFileSync(join(mailbox.statusDirectory, `${second}.complete`), "ready");
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      maxRetryAttempts: 100,
      maxTrackedRetries: 1,
    });

    await coordinator.pollOnce();

    expect(existsSync(join(mailbox.statusDirectory, `${first}.complete`))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, `${second}.complete`))).toBe(true);
    expect(coordinator.stats()).toMatchObject({
      trackedRetries: 1,
      maxTrackedRetries: 1,
      transientRetries: 2,
      quarantined: 1,
    });
  });

  scopedIt("stores a bounded summary when rejected ingress exceeds the quarantine byte budget", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("drops forensic evidence when non-removable metadata leaves no aggregate byte budget", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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

  scopedIt("consumes valid ingress after more than one batch of poison while bounding forensic evidence", async (root) => {
    const fixture = createObserverSessionFixture({ root });
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
      quarantineMaxRecords: 4,
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
      quarantineMaxRecords: 4,
      quarantineMaxBytes: 64 * 1024,
    });
    expect(coordinator.stats().quarantineFiles).toBeLessThanOrEqual(4);
    expect(coordinator.stats().quarantineBytes).toBeLessThanOrEqual(64 * 1024);

    expect(coordinator.stats().transports).toBe(1);
    fixture.store.revoke(registration.sessionId);
    coordinator.sweep(fixture.clock.now(), new Set([registration.sessionId]));
    expect(coordinator.stats().transports).toBe(1);
    coordinator.sweep(fixture.clock.now());
    expect(coordinator.stats().transports).toBe(0);
  }, 20_000);

  scopedIt("isolates raced and busy command cleanup so unrelated transport retention continues", async (root) => {
    const fixture = createObserverSessionFixture({ root });
    const secondProfile = join(root, "profiles", "run-2");
    mkdirSync(secondProfile, { recursive: true });
    const second = fixture.store.create({
      bundleDigest: fixture.created.record.bundleDigest,
      stagedAddonPath: fixture.created.record.stagedAddonPath,
      profilePath: secondProfile,
      agent: { host: "127.0.0.1", port: 47831, instanceId: "agent-test-1" },
      buildIdentity: fixture.created.record.buildIdentity,
      expectedRuntimeKind: "client",
      ttlMs: 20 * 60 * 1_000,
      transportPreference: ["mailbox"],
    });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const busyName = "000000000001-capture-busy-job-1.json";
    const racedName = "000000000001-capture-raced-job-1.json";
    const removeFile = (path: string) => {
      if (path.endsWith(busyName)) throw errno("EBUSY");
      if (path.endsWith(racedName)) {
        if (existsSync(path)) unlinkSync(path);
        throw errno("ENOENT");
      }
      unlinkSync(path);
    };
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      removeFile,
    });
    await coordinator.pollOnce();
    const firstMailbox = new MailboxTransport(fixture.profilePath);
    const secondMailbox = new MailboxTransport(secondProfile);
    const expired = JSON.stringify({ deliveryLeaseExpiresAt: new Date(fixture.clock.now() - 1).toISOString() });
    const busyPath = join(firstMailbox.commandsDirectory, busyName);
    const racedPath = join(secondMailbox.commandsDirectory, racedName);
    writeFileSync(busyPath, expired);
    writeFileSync(racedPath, expired);
    fixture.store.revoke(fixture.created.contract.sessionId);
    fixture.store.revoke(second.contract.sessionId);

    const sweep = coordinator.sweep(fixture.clock.now());

    expect(sweep.removedTransportSessionIds).toEqual([second.contract.sessionId]);
    expect(sweep.retainedCleanupFailures).toBeGreaterThanOrEqual(1);
    expect(existsSync(busyPath)).toBe(true);
    expect(existsSync(racedPath)).toBe(false);
    expect(coordinator.sessionIds()).toEqual(new Set([fixture.created.contract.sessionId]));
    expect(coordinator.stats()).toMatchObject({
      transports: 1,
      cleanupFailures: 1,
      lastCleanupFailure: { operation: "expire_command", file: busyName, errorCode: "EBUSY" },
    });
  }, 10_000);

  scopedIt("does not reclaim a live writer paused before marker publication", async (root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      orphanIngressMaxAgeMs: 1_000,
    });
    await coordinator.pollOnce();
    const mailbox = new MailboxTransport(fixture.profilePath);
    const registration = graphicalRegistration(fixture.created, {
      selectedTransport: "mailbox",
      capabilities: ["render.capture", "transport.mailbox"],
    });
    const name = `000000000001-registration-${registration.sessionId}.json`;
    const dataPath = join(mailbox.statusDirectory, name);
    writeFileSync(dataPath, JSON.stringify({
      ...registration,
      sessionToken: fixture.created.contract.sessionToken,
    }));
    const pausedAt = new Date(fixture.clock.now() - 60_000);
    utimesSync(dataPath, pausedAt, pausedAt);

    // The data copy is old enough for cleanup, but its session still owns an
    // active writer. Neither polling nor an ordinary sweep may delete it.
    expect(coordinator.sweep(fixture.clock.now()).removedOrphanIngressFiles).toBe(0);
    await coordinator.pollOnce();
    expect(existsSync(dataPath)).toBe(true);

    // Resume the writer at its next instruction: publish the marker. The exact
    // payload is then consumed once, intact, and cannot be redelivered.
    writeFileSync(`${dataPath}.complete`, "ready");
    await coordinator.pollOnce();
    expect(registry.require(registration.sessionId, registration.instanceId).registration.instanceId)
      .toBe(registration.instanceId);
    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(`${dataPath}.complete`)).toBe(false);
    expect(coordinator.stats().accepted).toBe(1);
    await coordinator.pollOnce();
    expect(coordinator.stats().accepted).toBe(1);
  });

  scopedIt("reclaims more than the runtime egress cap only after writer authority is terminal", async (root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      orphanIngressMaxAgeMs: 1_000,
    });
    await coordinator.pollOnce();
    const mailbox = new MailboxTransport(fixture.profilePath);
    const old = new Date(fixture.clock.now() - 60_000);
    for (let sequence = 1; sequence <= 513; sequence += 1) {
      const suffix = sequence % 2 === 0 ? ".json.tmp" : ".json";
      const path = join(mailbox.statusDirectory, `${String(sequence).padStart(12, "0")}-status-orphan-${sequence}${suffix}`);
      writeFileSync(path, "{}");
      utimesSync(path, old, old);
    }
    const committedName = "000000000999-status-committed.json";
    const committedPath = join(mailbox.statusDirectory, committedName);
    writeFileSync(committedPath, "{}");
    writeFileSync(`${committedPath}.complete`, "ready");
    utimesSync(committedPath, old, old);

    fixture.store.revoke(fixture.created.contract.sessionId);

    const sweep = coordinator.sweep(fixture.clock.now());

    expect(sweep.removedOrphanIngressFiles).toBe(513);
    expect(readdirSync(mailbox.statusDirectory).filter((name) => name.endsWith(".json") || name.endsWith(".json.tmp")))
      .toEqual([committedName]);
    expect(existsSync(`${committedPath}.complete`)).toBe(true);
    expect(coordinator.stats()).toMatchObject({ orphanIngressRemoved: 513, cleanupFailures: 0 });
  });

  scopedIt("retains a busy quarantine file and refuses new evidence instead of exceeding its bound", async (root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    let quarantineBusy = false;
    const removeFile = (path: string) => {
      if (quarantineBusy && path.includes(`${join("status", "quarantine")}`)) throw errno("EBUSY");
      unlinkSync(path);
    };
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      quarantineMaxRecords: 1,
      removeFile,
    });
    const mailbox = new MailboxTransport(fixture.profilePath);
    const poison = (sequence: number) => {
      const name = `${String(sequence).padStart(12, "0")}-status-poison-${sequence}.json`;
      writeFileSync(join(mailbox.statusDirectory, name), "{not-json");
      writeFileSync(join(mailbox.statusDirectory, `${name}.complete`), "ready");
    };
    poison(1);
    await coordinator.pollOnce();
    quarantineBusy = true;
    poison(2);

    await coordinator.pollOnce();

    const quarantineDirectory = join(mailbox.statusDirectory, "quarantine");
    expect(readdirSync(quarantineDirectory)).toHaveLength(1);
    expect(coordinator.stats()).toMatchObject({
      quarantineFiles: 1,
      quarantineMaxRecords: 1,
      quarantineDropped: 1,
      cleanupFailures: 1,
      lastCleanupFailure: { operation: "prune_quarantine", errorCode: "EBUSY" },
    });
  });

  scopedIt("rescans quarantine disk state before reserving space for new evidence", async (root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const jobs = new JobStore(fixture.store, registry, fixture.clock);
    const artifacts = new ArtifactStore(join(root, "artifacts"), fixture.store, jobs);
    const mailbox = new MailboxTransport(fixture.profilePath);
    const quarantineDirectory = join(mailbox.statusDirectory, "quarantine");
    mkdirSync(quarantineDirectory);
    const racedName = "externally-retained-evidence.json";
    const racedPath = join(quarantineDirectory, racedName);
    const removeFile = (path: string) => {
      if (path === racedPath) throw errno("EBUSY");
      unlinkSync(path);
    };
    const coordinator = new MailboxCoordinator(fixture.store, registry, jobs, artifacts, {
      clock: fixture.clock,
      quarantineMaxRecords: 1,
      removeFile,
    });
    // Admit while the quarantine directory is empty, then race in an exact
    // on-disk entry. A trusted cached inventory would miss this file.
    await coordinator.pollOnce();
    writeFileSync(racedPath, "retained");
    const poisonName = "000000000001-status-raced-poison.json";
    writeFileSync(join(mailbox.statusDirectory, poisonName), "{not-json");
    writeFileSync(join(mailbox.statusDirectory, `${poisonName}.complete`), "ready");

    await coordinator.pollOnce();

    expect(readdirSync(quarantineDirectory)).toEqual([racedName]);
    expect(existsSync(join(mailbox.statusDirectory, poisonName))).toBe(false);
    expect(existsSync(join(mailbox.statusDirectory, `${poisonName}.complete`))).toBe(false);
    expect(coordinator.stats()).toMatchObject({
      quarantineFiles: 1,
      quarantineDropped: 1,
      cleanupFailures: 1,
      lastCleanupFailure: { operation: "prune_quarantine", file: racedName, errorCode: "EBUSY" },
    });
  });

  scopedIt("retains and accounts for a busy command temporary without allocating another", (root) => {
    const fixture = createObserverSessionFixture({ root });
    const initial = new MailboxTransport(fixture.profilePath);
    const temporaryName = ".00000000-0000-4000-8000-000000000001.tmp";
    const temporaryPath = join(initial.commandsDirectory, temporaryName);
    writeFileSync(temporaryPath, "incomplete");
    let busy = true;
    const mailbox = new MailboxTransport(fixture.profilePath, {
      removeFile: (path) => {
        if (busy && path === temporaryPath) throw errno("EBUSY");
        unlinkSync(path);
      },
    });
    const command = {
      protocolVersion: "1.0" as const,
      jobId: "job-after-temporary",
      idempotencyKey: "capture-after-temporary",
      instanceId: "instance-1",
      worldEpoch: 1,
      deadlineAt: new Date(fixture.clock.now() + 10_000).toISOString(),
      view: { kind: "current" as const },
      settleFrames: 0,
      performancePolicy: "evidence" as const,
      commandKind: "capture" as const,
      deliveryAttempt: 1,
      deliveryToken: "delivery_token_after_temporary_1234",
      deliveryLeaseExpiresAt: new Date(fixture.clock.now() + 5_000).toISOString(),
      wireView: { position: [], orientation: [], target: [], fov: "0" },
    };

    expect(mailbox.stats()).toMatchObject({ commandFiles: 1, commandUsageReliable: false });
    expect(() => mailbox.writeCommand(command)).toThrowError(expect.objectContaining({ code: "TRANSPORT_UNAVAILABLE" }));
    expect(readdirSync(mailbox.commandsDirectory)).toEqual([temporaryName]);

    busy = false;
    expect(mailbox.writeCommand(command)).toMatch(/000000000001-capture-job-after-temporary-1\.json$/);
    expect(readdirSync(mailbox.commandsDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(mailbox.stats()).toMatchObject({ commandFiles: 1, commandUsageReliable: true });
  });

  scopedIt("cleans an atomic-write temporary when final publication fails", (root) => {
    const occupiedTarget = join(root, "occupied.json");
    mkdirSync(occupiedTarget);

    expect(() => atomicWriteFile(root, occupiedTarget, "payload")).toThrow();

    expect(readdirSync(root)).toEqual(["occupied.json"]);
  });

  it("models locked-file fairness beyond one 256-entry Enforce work batch", () => {
    const source = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverMailboxTransport.c"), "utf8");
    const poll = enforceMethod(source, "override bool PollCommand()");
    const cap = Number(/MAX_COMMAND_FILES\s*=\s*(\d+)/.exec(source)?.[1]);
    expect(cap).toBe(256);
    expect(poll).toContain("inspected < MAX_COMMAND_FILES");
    expect(poll).toContain("m_RFO_CommandCursor = files[index]");
    expect(source).toContain("enum RFO_ObserverMailboxDisposition");
    expect(source).toContain("RETAINED_FOR_RETRY");
    expect(source).toContain("STORAGE_UNAVAILABLE");
    expect(poll).not.toContain("m_RFO_Initialized = false");
    expect(poll).toContain("RecordIngressDisposition");

    // Behavioral model of the source-verified sorted/cursor/capped loop. The
    // controlled V10 Workbench gate executes this case against compiled
    // Enforce; this fast model remains supplementary architecture coverage.
    let files = Array.from({ length: 300 }, (_, index) => `${String(index + 1).padStart(12, "0")}-capture-poison-${index + 1}.json`);
    const locked = files[0];
    const valid = "000000000301-capture-valid-1.json";
    files.push(valid);
    let cursor = "";
    let accepted = false;
    let lockHeld = true;
    let heartbeatPublications = 0;
    const quarantine: string[] = [];
    const retainEvidence = (name: string) => {
      if (!quarantine.includes(name)) quarantine.push(name);
      while (quarantine.length > 128) quarantine.shift();
    };
    const pollModel = () => {
      const snapshot = [...files].sort();
      const cursorIndex = cursor ? snapshot.indexOf(cursor) : -1;
      const start = cursorIndex >= 0 ? (cursorIndex + 1) % snapshot.length : 0;
      for (let offset = 0; offset < snapshot.length && offset < cap; offset += 1) {
        const name = snapshot[(start + offset) % snapshot.length];
        cursor = name;
        if (name === valid) {
          accepted = true;
          files = files.filter((candidate) => candidate !== name);
          return;
        }
        retainEvidence(name);
        if (name === locked && lockHeld) continue;
        files = files.filter((candidate) => candidate !== name);
      }
    };
    pollModel();
    heartbeatPublications += 1;
    expect(accepted).toBe(false);
    pollModel();
    heartbeatPublications += 1;
    expect(accepted).toBe(true);
    expect(files).toContain(locked);
    expect(quarantine.length).toBeLessThanOrEqual(128);
    expect(new Set(quarantine).size).toBe(quarantine.length);
    expect(heartbeatPublications).toBe(2);

    lockHeld = false;
    pollModel();
    heartbeatPublications += 1;
    expect(files).not.toContain(locked);
    expect(new Set(quarantine).size).toBe(quarantine.length);
    expect(heartbeatPublications).toBe(3);
  });

  it("supplements behavioral coverage with Enforce writer serialization and idempotent quarantine architecture checks", () => {
    const source = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverMailboxTransport.c"), "utf8");
    const writeOwned = enforceMethod(source, "protected bool WriteOwned(string kind, string data)");
    const reclaim = enforceMethod(source, "protected bool ReclaimOrphanStatusFiles()");
    const quarantine = enforceMethod(source, "protected RFO_ObserverMailboxDisposition QuarantineCommand(string name, string path, string reason, int length)");
    const trim = enforceMethod(source, "protected RFO_ObserverMailboxDisposition TrimQuarantine(int incomingBytes)");
    const deleteOrAbsent = enforceMethod(source, "protected RFO_ObserverMailboxDisposition DeleteOrAbsent(string path, string name, string directory, string extension)");
    const evidenceName = enforceMethod(source, "protected string NewQuarantineEvidenceName(string name)");
    const evidenceBytes = enforceMethod(source, "protected int QuarantineEvidenceBytes(string name)");

    expect(writeOwned.indexOf("ReclaimOrphanStatusFiles()")).toBeLessThan(writeOwned.indexOf("existingFiles.Count() >= MAX_STATUS_FILES"));
    expect(writeOwned).toContain("m_RFO_EgressHealthy = false");
    expect(reclaim).toContain("markerNames.Contains(dataName + \".complete\")");
    expect(reclaim).toContain("temporaryName.EndsWith(\".json.tmp\")");
    expect(quarantine).toContain("QuarantineEvidenceBytes(name)");
    expect(quarantine).toContain("RFO_ObserverMailboxDisposition.STORAGE_UNAVAILABLE");
    expect(trim).toContain("MAX_QUARANTINE_FILES");
    expect(trim).toContain("MAX_QUARANTINE_BYTES");
    expect(trim).toContain('FileIO.FindFiles(longNameFiles.Insert, QUARANTINE_DIRECTORY, ".rfoq")');
    expect(evidenceName).toContain('name.Substring(0, name.Length() - 5) + ".rfoq"');
    expect(evidenceBytes).toContain("candidateName.Length() == name.Length() + 13");
    expect(evidenceBytes).toContain("candidateName.Substring(13, name.Length()) == name");
    expect(evidenceBytes).not.toContain("EndsWith(suffix)");
    expect(evidenceBytes).toContain("if (!evidence)");
    expect(evidenceBytes).toContain("if (length <= 0 || length > 65536)");
    expect(evidenceBytes).toContain("envelope.LoadFromFile(evidencePath)");
    expect(evidenceBytes).toContain("return -3");
    expect(evidenceBytes).toContain("DeleteOrAbsent(evidencePath, candidateName, QUARANTINE_DIRECTORY, extension)");
    expect(evidenceBytes).toContain("envelope.sourceName != name");
    expect(deleteOrAbsent).toContain("if (BaseName(candidatePath) == name)");
    expect(deleteOrAbsent).toContain("RFO_ObserverMailboxDisposition.RETAINED_FOR_RETRY");
  });
});
