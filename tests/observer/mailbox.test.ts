import { existsSync, readdirSync, writeFileSync } from "node:fs";
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
    expect(mailbox.writeCommand(command)).toMatch(/000000000001-capture-job-1-1\.json$/);
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

  it("retries malformed ingress a bounded number of times and quarantines it", async () => {
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
    await coordinator.pollOnce();
    expect(existsSync(join(mailbox.statusDirectory, name))).toBe(true);
    await coordinator.pollOnce();
    expect(existsSync(join(mailbox.statusDirectory, name))).toBe(false);
    expect(readdirSync(join(mailbox.statusDirectory, "quarantine"))).toEqual(expect.arrayContaining([name, `${name}.complete`]));
  });
});
