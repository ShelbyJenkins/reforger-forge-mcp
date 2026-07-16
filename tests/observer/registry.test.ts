import { afterEach, describe, expect, it } from "vitest";
import { InstanceRegistry } from "../../observer/agent/registry.js";
import { cleanup, createSessionFixture, FakeClock, graphicalRegistration, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

describe("observer instance registry", () => {
  it("authenticates registration, normalizes capabilities, and strips headless rendering", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
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

  it("refuses a second process for the same launch nonce", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    registry.register(graphicalRegistration(fixture.created), fixture.created.contract.sessionToken);
    expect(() => registry.register(graphicalRegistration(fixture.created, {
      instanceId: "instance-2",
      instanceNonce: "different_nonce_123456789012345678901234",
    }), fixture.created.contract.sessionToken)).toThrowError(expect.objectContaining({ code: "INSTANCE_CONFLICT" }));
  });

  it("rejects stale heartbeat sequences and deterministically marks liveness", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const clock = new FakeClock();
    const fixture = createSessionFixture(root, clock);
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

  it.each([
    { field: "buildIdentity", value: "2".repeat(64) },
    { field: "agentInstanceId", value: "different-agent" },
    { field: "runtimeKind", value: "listenServer" },
  ] as const)("rejects mismatched runtime attestation field $field", ({ field, value }) => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const registry = new InstanceRegistry(fixture.store, { clock: fixture.clock });
    expect(() => registry.register(graphicalRegistration(fixture.created, { [field]: value }), fixture.created.contract.sessionToken))
      .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });
});
