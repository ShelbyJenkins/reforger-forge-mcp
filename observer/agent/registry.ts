import {
  CAPABILITY_REGISTRY,
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

const RUNTIME_CAPABILITIES = new Set<string>(
  Object.entries(CAPABILITY_REGISTRY)
    .filter(([, definition]) => definition.backends.includes("runtime" as never))
    .map(([capability]) => capability)
);

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
  staleRetentionMs?: number;
  maxRecords?: number;
  maxEstimatedBytes?: number;
  clock?: Clock;
}

export interface RegistrySweepResult {
  removedInstanceKeys: string[];
}

export interface InstanceRegistryStats {
  records: number;
  stale: number;
  restorationObligations: number;
  estimatedBytes: number;
  maxRecords: number;
  maxEstimatedBytes: number;
  staleAfterMs: number;
  staleRetentionMs: number;
}

export class InstanceRegistry {
  private readonly instances = new Map<string, InstanceRecord>();
  private readonly clock: Clock;
  readonly staleAfterMs: number;
  readonly staleRetentionMs: number;
  readonly maxRecords: number;
  readonly maxEstimatedBytes: number;

  constructor(private readonly sessions: SessionStore, options: RegistryOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.staleAfterMs = this.boundedOption(options.staleAfterMs, 15_000, 1_000, 24 * 60 * 60_000, "Instance stale threshold");
    this.staleRetentionMs = this.boundedOption(options.staleRetentionMs, 5 * 60_000, 0, 24 * 60 * 60_000, "Stale instance retention");
    this.maxRecords = this.boundedOption(options.maxRecords, 4_096, 1, 100_000, "Instance record limit");
    this.maxEstimatedBytes = this.boundedOption(
      options.maxEstimatedBytes,
      16 * 1024 * 1024,
      1_024,
      1024 * 1024 * 1024,
      "Instance registry byte limit"
    );
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
    const mapKey = this.key(registration.sessionId, registration.instanceId);
    const existing = this.instances.get(mapKey);
    if (existing && existing.registration.instanceNonce !== registration.instanceNonce && !this.isStale(existing)) {
      throw new ObserverError("INSTANCE_CONFLICT", "A live instance already uses this observer instance ID", 409);
    }

    const unique = [...new Set(registration.capabilities)];
    const known = unique.filter((capability): capability is ObserverCapability => RUNTIME_CAPABILITIES.has(capability));
    const unknown = unique.filter((capability) => !RUNTIME_CAPABILITIES.has(capability));
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
    this.assertCapacity(mapKey, record, now);
    // Commit the cross-store session binding only after registry admission is
    // known to succeed. A rejected candidate must leave the launch nonce free
    // for a corrected registration retry.
    this.sessions.bindInstance(registration.sessionId, registration.instanceNonce);
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
    let knownCapabilities = unique.filter((capability): capability is ObserverCapability => RUNTIME_CAPABILITIES.has(capability));
    if (record.registration.headless) {
      knownCapabilities = knownCapabilities.filter((capability) => capability !== "render.capture" && capability !== "camera.runtime");
    }
    const next: InstanceRecord = {
      ...record,
      knownCapabilities,
      unknownCapabilities: unique.filter((capability) => !RUNTIME_CAPABILITIES.has(capability)),
      lastHeartbeatAtMs: this.clock.now(),
      lastHeartbeatSequence: heartbeat.sequence,
      worldId: heartbeat.worldId,
      worldEpoch: heartbeat.worldEpoch,
      activeJobId: heartbeat.activeJobId ?? null,
      cameraLeaseJobId: heartbeat.cameraLeaseJobId ?? null,
      transportHealthy: heartbeat.transportHealthy,
      lastErrorCode: heartbeat.lastErrorCode ?? null,
    };
    this.assertCapacity(this.key(heartbeat.sessionId, heartbeat.instanceId), next, next.lastHeartbeatAtMs, false);
    Object.assign(record, next);
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

  sessionIds(): Set<string> {
    return new Set([...this.instances.values()].map((record) => record.registration.sessionId));
  }

  /** Remove runtime-instance claims after the host proves the exact process vacant. */
  vacateSession(sessionId: string): number {
    let removed = 0;
    for (const [key, record] of this.instances) {
      if (record.registration.sessionId !== sessionId) continue;
      this.instances.delete(key);
      removed += 1;
    }
    return removed;
  }

  isStale(record: InstanceRecord): boolean {
    return this.clock.now() - record.lastHeartbeatAtMs > this.staleAfterMs;
  }

  sweep(
    now = this.clock.now(),
    pinnedSessionIds: ReadonlySet<string> = new Set(),
    authoritativeObligationJobIds?: ReadonlySet<string>
  ): RegistrySweepResult {
    const removedInstanceKeys: string[] = [];
    for (const [key, record] of this.instances) {
      const sessionId = record.registration.sessionId;
      const reportedObligationJobIds = [record.activeJobId, record.cameraLeaseJobId]
        .filter((jobId): jobId is string => jobId !== null);
      // Standalone registry users remain conservative. The composed agent
      // supplies JobStore's authoritative set so stale heartbeat fields cannot
      // retain a revoked session after its real obligation is terminal/gone.
      const restorationObligation = authoritativeObligationJobIds === undefined
        ? reportedObligationJobIds.length > 0
        : reportedObligationJobIds.some((jobId) => authoritativeObligationJobIds.has(jobId));
      if (restorationObligation || pinnedSessionIds.has(sessionId) || this.sessions.isPinned(sessionId, pinnedSessionIds)) continue;
      const sessionTerminal = this.sessions.isTerminal(sessionId, now);
      const staleBeyondRetention = now - record.lastHeartbeatAtMs > this.staleAfterMs + this.staleRetentionMs;
      if (!sessionTerminal && !staleBeyondRetention) continue;
      this.instances.delete(key);
      removedInstanceKeys.push(key);
    }
    return { removedInstanceKeys };
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

  stats(now = this.clock.now()): InstanceRegistryStats {
    const records = [...this.instances.values()];
    return {
      records: records.length,
      stale: records.filter((record) => now - record.lastHeartbeatAtMs > this.staleAfterMs).length,
      restorationObligations: records.filter((record) => record.activeJobId !== null || record.cameraLeaseJobId !== null).length,
      estimatedBytes: records.reduce((total, record) => total + this.recordBytes(record), 0),
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      staleAfterMs: this.staleAfterMs,
      staleRetentionMs: this.staleRetentionMs,
    };
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

  private assertCapacity(key: string, record: InstanceRecord, now: number, sweep = true): void {
    if (sweep) this.sweep(now);
    const replacing = this.instances.get(key);
    const nextRecords = this.instances.size + (replacing ? 0 : 1);
    const currentBytes = [...this.instances.values()].reduce((total, existing) => total + this.recordBytes(existing), 0);
    const nextBytes = currentBytes - (replacing ? this.recordBytes(replacing) : 0) + this.recordBytes(record);
    if (nextRecords > this.maxRecords || nextBytes > this.maxEstimatedBytes) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer instance registry retention budget is exhausted", 503);
    }
  }

  private recordBytes(record: InstanceRecord): number {
    return Buffer.byteLength(JSON.stringify(record), "utf8");
  }

  private boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
      throw new ObserverError("INVALID_REQUEST", `${label} must be an integer from ${minimum} through ${maximum}`);
    }
    return selected;
  }
}
