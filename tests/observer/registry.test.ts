import { describe, expect, it } from "vitest";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { createObserverSessionFixture, graphicalRegistration } from "../support/observer-fixtures.js";
import { ManualTime } from "../support/manual-time.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer instance registry", () => {
  it("authenticates registration, normalizes capabilities, and strips headless rendering", async () => {
    await withTemporaryDirectory((root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const registration = graphicalRegistration(fixture.created, {
      headless: true,
      runtimeKind: "dedicated",
      capabilities: ["render.capture", "camera.runtime", "world.query", "future.capability", "world.query"],
    });
    fixture.created.record.expectedRuntimeKind = "dedicated";
    const record = registry.register(registration, fixture.created.contract.sessionToken);
    expect(record.knownCapabilities).toEqual(["world.query"]);
    expect(record.unknownCapabilities).toEqual(["future.capability"]);
    expect(() => registry.select(registration.sessionId, ["render.capture"])).toThrowError(expect.objectContaining({ code: "NO_RENDER_ENDPOINT" }));
    });
  });

  it("keeps workbench-only capabilities diagnostic and non-routable for runtime instances", async () => {
    await withTemporaryDirectory((root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    const registration = graphicalRegistration(fixture.created, {
      capabilities: ["render.capture", "camera.editor", "transport.rest"],
    });
    const record = registry.register(registration, fixture.created.contract.sessionToken);
    expect(record.knownCapabilities).toEqual(["render.capture", "transport.rest"]);
    expect(record.unknownCapabilities).toEqual(["camera.editor"]);
    expect(() => registry.select(registration.sessionId, ["camera.editor"]))
      .toThrowError(expect.objectContaining({ code: "NO_RENDER_ENDPOINT" }));

    registry.heartbeat({
      protocolVersion: "1.0",
      sessionId: registration.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      sequence: 1,
      sentAt: new Date(fixture.clock.now()).toISOString(),
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      capabilities: ["render.capture", "camera.editor", "transport.rest"],
      transportHealthy: true,
    }, fixture.created.contract.sessionToken);
    expect(record.knownCapabilities).not.toContain("camera.editor");
    expect(record.unknownCapabilities).toContain("camera.editor");
    });
  });

  it("refuses a second process for the same launch nonce", async () => {
    await withTemporaryDirectory((root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    registry.register(graphicalRegistration(fixture.created), fixture.created.contract.sessionToken);
    expect(() => registry.register(graphicalRegistration(fixture.created, {
      instanceId: "instance-2",
      instanceNonce: "different_nonce_123456789012345678901234",
    }), fixture.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "INSTANCE_CONFLICT" }));
    });
  });

  it("rejects stale heartbeat sequences and deterministically marks liveness", async () => {
    await withTemporaryDirectory((root) => {
    const clock = new ManualTime();
    const fixture = createObserverSessionFixture({ root, clock });
    const registry = new InstanceRegistry(fixture.store, { clock, staleAfterMs: 10_000 });
    const registration = graphicalRegistration(fixture.created);
    registry.register(registration, fixture.created.contract.sessionToken);
    const heartbeat = {
      protocolVersion: "1.0",
      sessionId: registration.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      sequence: 1,
      sentAt: new Date(clock.now()).toISOString(),
      worldId: registration.worldId,
      worldEpoch: 1,
      capabilities: registration.capabilities,
      transportHealthy: true,
    };
    registry.heartbeat(heartbeat, fixture.created.contract.sessionToken);
    expect(() => registry.heartbeat(heartbeat, fixture.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    clock.advance(10_001);
    expect(() => registry.select(registration.sessionId, ["render.capture"])).toThrowError(expect.objectContaining({ code: "NO_RENDER_ENDPOINT" }));
    });
  });

  it("rejects an over-budget heartbeat without partially mutating the instance", async () => {
    await withTemporaryDirectory((root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, {
      clock: fixture.clock,
      maxRecords: 4,
      maxEstimatedBytes: 4 * 1_024,
    });
    const registration = graphicalRegistration(fixture.created);
    const record = registry.register(registration, fixture.created.contract.sessionToken);
    const originalCapabilities = [...record.knownCapabilities];
    const oversizedCapabilities = Array.from({ length: 64 }, (_, index) =>
      `future-${String(index).padStart(2, "0")}-${"x".repeat(53)}`
    );
    expect(() => registry.heartbeat({
      protocolVersion: "1.0",
      sessionId: registration.sessionId,
      instanceId: registration.instanceId,
      instanceNonce: registration.instanceNonce,
      sequence: 1,
      sentAt: new Date(fixture.clock.now()).toISOString(),
      worldId: "changed-world",
      worldEpoch: 2,
      capabilities: oversizedCapabilities,
      transportHealthy: false,
    }, fixture.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "TRANSPORT_UNAVAILABLE" }));
    expect(record).toMatchObject({
      lastHeartbeatSequence: -1,
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      transportHealthy: true,
    });
    expect(record.knownCapabilities).toEqual(originalCapabilities);
    });
  });

  it("does not bind a session nonce when registry admission fails", async () => {
    await withTemporaryDirectory((root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, {
      clock: fixture.clock,
      maxRecords: 4,
      maxEstimatedBytes: 4 * 1_024,
    });
    const oversizedCapabilities = Array.from({ length: 64 }, (_, index) =>
      `future-${String(index).padStart(2, "0")}-${"x".repeat(53)}`
    );
    expect(() => registry.register(graphicalRegistration(fixture.created, {
      instanceNonce: "rejected_nonce_123456789012345678901234",
      capabilities: oversizedCapabilities,
    }), fixture.created.contract.sessionToken)).toThrowError(expect.objectContaining({
      code: "TRANSPORT_UNAVAILABLE",
    }));
    expect(fixture.created.record.registeredInstanceNonce).toBeNull();
    expect(registry.stats().records).toBe(0);

    const retry = registry.register(graphicalRegistration(fixture.created, {
      instanceNonce: "accepted_nonce_123456789012345678901234",
    }), fixture.created.contract.sessionToken);
    expect(retry.registration.instanceNonce).toBe("accepted_nonce_123456789012345678901234");
    expect(fixture.created.record.registeredInstanceNonce).toBe(retry.registration.instanceNonce);
    });
  });

  it.each([
    { field: "buildIdentity", value: "2".repeat(64) },
    { field: "agentInstanceId", value: "different-agent" },
    { field: "runtimeKind", value: "listenServer" },
  ] as const)("rejects mismatched runtime attestation field $field", async ({ field, value }) => {
    await withTemporaryDirectory((root) => {
    const fixture = createObserverSessionFixture({ root });
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    expect(() => registry.register(graphicalRegistration(fixture.created, { [field]: value }), fixture.created.contract.sessionToken))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    });
  });
});
