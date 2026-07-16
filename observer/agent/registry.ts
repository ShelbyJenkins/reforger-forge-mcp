import {
  CAPABILITIES,
  PROTOCOL_MAJOR,
  heartbeatSchema,
  instanceRegistrationSchema,
  parseProtocolMessage,
  protocolMajor,
  type Heartbeat,
  type InstanceRegistration,
  type ObserverCapability,
} from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import { type Clock, SessionStore, systemClock } from "./sessions.js";

const KNOWN_CAPABILITIES = new Set<string>(CAPABILITIES);

export interface InstanceRecord {
  registration: InstanceRegistration;
  knownCapabilities: ObserverCapability[];
  unknownCapabilities: string[];
  registeredAtMs: number;
  lastHeartbeatAtMs: number;
  lastHeartbeatSequence: number;
  worldId: string | null;
  worldEpoch: number;
  activeJobId: string | null;
  cameraLeaseJobId: string | null;
  transportHealthy: boolean;
  lastErrorCode: string | null;
}

export interface RegistryOptions {
  staleAfterMs?: number;
  clock?: Clock;
}

export class InstanceRegistry {
  private readonly instances = new Map<string, InstanceRecord>();
  private readonly clock: Clock;
  readonly staleAfterMs: number;

  constructor(private readonly sessions: SessionStore, options: RegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
  }

  register(input: unknown, token: string): InstanceRecord {
    const parsed = parseProtocolMessage(instanceRegistrationSchema, input);
    if (!parsed.success) throw new ObserverError(parsed.error.code, parsed.error.message);
    const registration = parsed.data;
    const session = this.sessions.authorize(registration.sessionId, token);
    if (protocolMajor(registration.protocolVersion) !== PROTOCOL_MAJOR) throw new ObserverError("PROTOCOL_MISMATCH", "Runtime protocol major version is not supported");
    if (registration.launchNonce !== session.launchNonce || registration.bundleDigest !== session.bundleDigest ||
      registration.buildIdentity !== session.buildIdentity || registration.agentInstanceId !== session.agentInstanceId) {
      throw new ObserverError("UNAUTHORIZED", "Runtime launch identity does not match the observer session", 401);
    }
    if (registration.runtimeKind !== session.expectedRuntimeKind) {
      throw new ObserverError("UNAUTHORIZED", "Runtime kind does not match the prepared launch contract", 401);
    }
    if (!session.transportPreference.includes(registration.selectedTransport)) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Runtime selected a transport not allowed by the session");
    }
    const otherLiveInstance = this.forSession(registration.sessionId).find((record) =>
      record.registration.instanceId !== registration.instanceId && !this.isStale(record)
    );
    if (otherLiveInstance && !session.allowMultipleInstances) {
      throw new ObserverError("INSTANCE_CONFLICT", "This launch nonce already has an active runtime instance", 409);
    }
    this.sessions.bindInstance(registration.sessionId, registration.instanceNonce);
    const mapKey = this.key(registration.sessionId, registration.instanceId);
    const existing = this.instances.get(mapKey);
    if (existing && existing.registration.instanceNonce !== registration.instanceNonce && !this.isStale(existing)) {
      throw new ObserverError("INSTANCE_CONFLICT", "A live instance already uses this observer instance ID", 409);
    }

    const unique = [...new Set(registration.capabilities)];
    const known = unique.filter((capability): capability is ObserverCapability => KNOWN_CAPABILITIES.has(capability));
    const unknown = unique.filter((capability) => !KNOWN_CAPABILITIES.has(capability));
    if (registration.headless) {
      for (const forbidden of ["render.capture", "camera.runtime"] as const) {
        const index = known.indexOf(forbidden);
        if (index >= 0) known.splice(index, 1);
      }
    }
    const now = this.clock.now();
    const record: InstanceRecord = {
      registration: { ...registration, capabilities: unique },
      knownCapabilities: known,
      unknownCapabilities: unknown,
      registeredAtMs: now,
      lastHeartbeatAtMs: now,
      lastHeartbeatSequence: -1,
      worldId: registration.worldId,
      worldEpoch: registration.worldEpoch,
      activeJobId: null,
      cameraLeaseJobId: null,
      transportHealthy: true,
      lastErrorCode: null,
    };
    this.instances.set(mapKey, record);
    return record;
  }

  heartbeat(input: unknown, token: string): InstanceRecord {
    const parsed = parseProtocolMessage(heartbeatSchema, input);
    if (!parsed.success) throw new ObserverError(parsed.error.code, parsed.error.message);
    const heartbeat = parsed.data;
    this.sessions.authorize(heartbeat.sessionId, token);
    const record = this.require(heartbeat.sessionId, heartbeat.instanceId);
    if (record.registration.instanceNonce !== heartbeat.instanceNonce) throw new ObserverError("UNAUTHORIZED", "Heartbeat instance nonce is invalid", 401);
    if (heartbeat.sequence <= record.lastHeartbeatSequence) throw new ObserverError("INVALID_REQUEST", "Heartbeat sequence is stale or duplicated", 409);
    const sentAt = Date.parse(heartbeat.sentAt);
    if (sentAt > this.clock.now() + 60_000) throw new ObserverError("INVALID_REQUEST", "Heartbeat timestamp is too far in the future");
    const unique = [...new Set(heartbeat.capabilities)];
    record.knownCapabilities = unique.filter((capability): capability is ObserverCapability => KNOWN_CAPABILITIES.has(capability));
    if (record.registration.headless) record.knownCapabilities = record.knownCapabilities.filter((capability) => capability !== "render.capture" && capability !== "camera.runtime");
    record.unknownCapabilities = unique.filter((capability) => !KNOWN_CAPABILITIES.has(capability));
    record.lastHeartbeatAtMs = this.clock.now();
    record.lastHeartbeatSequence = heartbeat.sequence;
    record.worldId = heartbeat.worldId;
    record.worldEpoch = heartbeat.worldEpoch;
    record.activeJobId = heartbeat.activeJobId ?? null;
    record.cameraLeaseJobId = heartbeat.cameraLeaseJobId ?? null;
    record.transportHealthy = heartbeat.transportHealthy;
    record.lastErrorCode = heartbeat.lastErrorCode ?? null;
    return record;
  }

  select(sessionId: string, required: readonly ObserverCapability[], explicitInstanceId?: string): InstanceRecord {
    this.sessions.get(sessionId);
    if (explicitInstanceId) {
      const record = this.require(sessionId, explicitInstanceId);
      this.assertRoutable(record, required);
      return record;
    }
    const eligible = this.forSession(sessionId).filter((record) => {
      if (this.isStale(record) || !record.transportHealthy || record.registration.headless) return false;
      return required.every((capability) => record.knownCapabilities.includes(capability));
    });
    if (eligible.length === 0) throw new ObserverError("NO_RENDER_ENDPOINT", "No live runtime has the required observer capabilities", 404);
    if (eligible.length > 1) throw new ObserverError("INSTANCE_CONFLICT", "Multiple equally eligible renderer instances are live; specify instanceId", 409);
    return eligible[0];
  }

  require(sessionId: string, instanceId: string): InstanceRecord {
    const record = this.instances.get(this.key(sessionId, instanceId));
    if (!record) throw new ObserverError("INSTANCE_NOT_FOUND", "Observer runtime instance was not found", 404);
    return record;
  }

  forSession(sessionId: string): InstanceRecord[] {
    return [...this.instances.values()].filter((record) => record.registration.sessionId === sessionId);
  }

  isStale(record: InstanceRecord): boolean {
    return this.clock.now() - record.lastHeartbeatAtMs > this.staleAfterMs;
  }

  diagnostics(): Array<Record<string, unknown>> {
    return [...this.instances.values()].map((record) => ({
      sessionId: record.registration.sessionId,
      instanceId: record.registration.instanceId,
      runtimeKind: record.registration.runtimeKind,
      processId: record.registration.processId,
      headless: record.registration.headless,
      capabilities: record.knownCapabilities,
      unknownCapabilities: record.unknownCapabilities,
      selectedTransport: record.registration.selectedTransport,
      worldId: record.worldId,
      worldEpoch: record.worldEpoch,
      stale: this.isStale(record),
      lastHeartbeatAt: new Date(record.lastHeartbeatAtMs).toISOString(),
      activeJobId: record.activeJobId,
      cameraLeaseJobId: record.cameraLeaseJobId,
      transportHealthy: record.transportHealthy,
      lastErrorCode: record.lastErrorCode,
    }));
  }

  private assertRoutable(record: InstanceRecord, required: readonly ObserverCapability[]): void {
    if (this.isStale(record)) throw new ObserverError("INSTANCE_STALE", "Requested observer runtime instance is stale", 409);
    if (!record.transportHealthy) throw new ObserverError("TRANSPORT_UNAVAILABLE", "Requested observer runtime transport is unhealthy", 409);
    if (record.registration.headless) throw new ObserverError("NO_RENDER_ENDPOINT", "Headless runtimes cannot render captures", 409);
    const missing = required.filter((capability) => !record.knownCapabilities.includes(capability));
    if (missing.length) throw new ObserverError("CAPABILITY_UNAVAILABLE", `Requested runtime lacks capabilities: ${missing.join(", ")}`, 409);
  }

  private key(sessionId: string, instanceId: string): string {
    return `${sessionId}\0${instanceId}`;
  }
}
