import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDON_VERSION,
  OBSERVER_BUILD_IDENTITY,
  PROTOCOL_VERSION,
  type InstanceRegistration,
} from "../../observer/protocol/index.js";
import { SessionStore, type SessionStoreOptions } from "../../observer/agent/sessions.js";
import { ManualTime } from "./manual-time.js";
import type { Clock } from "../../src/foundation/time.js";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const observerAddonSource = join(repositoryRoot, "observer", "addon");
export const testBundleDigest = "1".repeat(64);

export interface ObserverSessionFixtureOptions {
  readonly root: string;
  readonly clock?: Clock;
  readonly sessionOptions?: SessionStoreOptions;
}

export function createObserverSessionFixture(options: ObserverSessionFixtureOptions) {
  const clock = options.clock ?? new ManualTime();
  const store = new SessionStore(clock, options.sessionOptions);
  const profilePath = join(options.root, "profiles", "run-1");
  mkdirSync(profilePath, { recursive: true });
  const created = store.create({
    bundleDigest: testBundleDigest,
    stagedAddonPath: join(options.root, "addons", testBundleDigest, "ReforgerForgeObserver"),
    profilePath,
    agent: { host: "127.0.0.1", port: 47831, instanceId: "agent-test-1" },
    buildIdentity: OBSERVER_BUILD_IDENTITY,
    expectedRuntimeKind: "client",
    ttlMs: 20 * 60 * 1000,
    transportPreference: ["rest", "mailbox"],
  });
  return { store, created, profilePath, clock };
}

export function graphicalRegistration(
  created: ReturnType<SessionStore["create"]>,
  overrides: Partial<InstanceRegistration> = {},
): InstanceRegistration {
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
    registeredAt: created.contract.createdAt,
    ...overrides,
  };
}
