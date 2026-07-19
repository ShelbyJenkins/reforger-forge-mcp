import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDON_VERSION, OBSERVER_BUILD_IDENTITY, PROTOCOL_VERSION, type InstanceRegistration } from "../../observer/protocol/index.js";
import { type Clock, SessionStore, type SessionStoreOptions } from "../../observer/agent/sessions.js";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const observerAddonSource = join(repositoryRoot, "observer", "addon");
export const testBundleDigest = "1".repeat(64);

export function temporaryDirectory(prefix = "rfo-test-"): string {
  const path = join(tmpdir(), `${prefix}${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  return path;
}

export function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export class FakeClock implements Clock {
  constructor(public value = Date.parse("2026-07-16T20:00:00.000Z")) {}
  now(): number { return this.value; }
  advance(milliseconds: number): void { this.value += milliseconds; }
}

export function createSessionFixture(root: string, clock = new FakeClock(), options: SessionStoreOptions = {}) {
  const store = new SessionStore(clock, options);
  const profilePath = join(root, "profiles", "run-1");
  mkdirSync(profilePath, { recursive: true });
  const created = store.create({
    bundleDigest: testBundleDigest,
    stagedAddonPath: join(root, "addons", testBundleDigest, "ReforgerForgeObserver"),
    profilePath,
    agent: { host: "127.0.0.1", port: 47831, instanceId: "agent-test-1" },
    buildIdentity: OBSERVER_BUILD_IDENTITY,
    expectedRuntimeKind: "client",
    ttlMs: 20 * 60 * 1000,
    transportPreference: ["rest", "mailbox"],
  });
  return { store, created, profilePath, clock };
}

export function graphicalRegistration(created: ReturnType<SessionStore["create"]>, overrides: Partial<InstanceRegistration> = {}): InstanceRegistration {
  return {
    protocolVersion: PROTOCOL_VERSION,
    addonVersion: ADDON_VERSION,
    bundleDigest: created.contract.bundleDigest,
    buildIdentity: created.contract.buildIdentity,
    agentInstanceId: created.contract.agent.instanceId,
    sessionId: created.contract.sessionId,
    launchNonce: created.contract.launchNonce,
    instanceId: "instance-1",
    instanceNonce: "instance_nonce_123456789012345678901234",
    processId: 1234,
    runtimeKind: "client",
    capabilities: ["render.capture", "camera.runtime", "world.query", "transport.rest"],
    selectedTransport: "rest",
    headless: false,
    worldId: "world-1",
    worldEpoch: 1,
    registeredAt: new Date(clockFromCreated(created)).toISOString(),
    ...overrides,
  };
}

function clockFromCreated(created: ReturnType<SessionStore["create"]>): number {
  return Date.parse(created.contract.createdAt);
}
