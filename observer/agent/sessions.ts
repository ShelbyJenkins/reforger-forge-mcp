import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  ADDON_VERSION,
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  SESSION_CONTRACT_NAME,
  SESSION_DIRECTORY_NAME,
  sessionContractSchema,
  type ObserverLimits,
  type ObserverTransport,
  type InstanceRegistration,
  type SessionContract,
} from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import { assertManagedPath, atomicWriteJson, ensureCanonicalDirectory, resolveEngineProfileDirectory } from "./paths.js";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const SESSION_TOMBSTONE_RETENTION_MS = 5 * 60_000;
export const DEFAULT_SESSION_MAX_RECORDS = 1_024;
export const DEFAULT_SESSION_MAX_BYTES = 8 * 1024 * 1024;

export interface SessionStoreOptions {
  terminalRetentionMs?: number;
  maxRecords?: number;
  maxEstimatedBytes?: number;
}

export interface SessionSweepResult {
  expiredSessionIds: string[];
  removedSessionIds: string[];
}

export interface SessionStoreStats {
  records: number;
  active: number;
  terminal: number;
  pinned: number;
  estimatedBytes: number;
  actualBytes: number;
  maxRecords: number;
  maxEstimatedBytes: number;
  terminalRetentionMs: number;
}

export interface CreateSessionInput {
  bundleDigest: string;
  stagedAddonPath: string;
  profilePath: string;
  agent: { host: "127.0.0.1" | "::1"; port: number; instanceId: string };
  buildIdentity: string;
  expectedRuntimeKind: InstanceRegistration["runtimeKind"];
  ttlMs: number;
  transportPreference: ObserverTransport[];
  limits?: Partial<ObserverLimits>;
  sessionId?: string;
  launchNonce?: string;
  /** Test/lab-only expansion. The MVP launcher leaves this false. */
  allowMultipleInstances?: boolean;
}

export interface SessionRecord {
  sessionId: string;
  launchNonce: string;
  tokenDigest: string;
  createdAt: number;
  expiresAt: number;
  bundleDigest: string;
  buildIdentity: string;
  expectedRuntimeKind: InstanceRegistration["runtimeKind"];
  agentInstanceId: string;
  stagedAddonPath: string;
  profilePath: string;
  transportPreference: ObserverTransport[];
  limits: ObserverLimits;
  registeredInstanceNonce: string | null;
  allowMultipleInstances: boolean;
  revokedAt: number | null;
}

export interface CreatedSession {
  contract: SessionContract;
  record: SessionRecord;
  contractPath: string;
}

export type AgentLeaseProbeResult = "same" | "different" | "absent" | "unverifiable";

export interface ContractRecoveryResult {
  kind: "none" | "expired_removed" | "orphan_archived";
  archivedPath?: string;
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function digestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseExistingContract(contractPath: string): SessionContract {
  if (lstatSync(contractPath).isSymbolicLink()) {
    throw new ObserverError("PROFILE_CONFLICT", "Observer profile contract is a symbolic link");
  }
  try {
    return sessionContractSchema.parse(JSON.parse(readFileSync(contractPath, "utf8")));
  } catch (error) {
    if (error instanceof ObserverError) throw error;
    throw new ObserverError("PROFILE_CONFLICT", "Observer profile contains an unrecognized session contract");
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly retentionPins = new Map<string, Set<string>>();
  readonly terminalRetentionMs: number;
  readonly maxRecords: number;
  readonly maxEstimatedBytes: number;

  constructor(private readonly clock: Clock = systemClock, options: SessionStoreOptions = {}) {
    this.terminalRetentionMs = this.boundedOption(
      options.terminalRetentionMs,
      SESSION_TOMBSTONE_RETENTION_MS,
      0,
      24 * 60 * 60_000,
      "Session terminal retention"
    );
    this.maxRecords = this.boundedOption(
      options.maxRecords,
      DEFAULT_SESSION_MAX_RECORDS,
      1,
      100_000,
      "Session record limit"
    );
    this.maxEstimatedBytes = this.boundedOption(
      options.maxEstimatedBytes,
      DEFAULT_SESSION_MAX_BYTES,
      1_024,
      1024 * 1024 * 1024,
      "Session store byte limit"
    );
  }

  async recoverProfileContract(
    profilePathInput: string,
    probe: (contract: SessionContract) => Promise<AgentLeaseProbeResult>
  ): Promise<ContractRecoveryResult> {
    const profilePath = ensureCanonicalDirectory(profilePathInput);
    const engineProfileDirectory = resolveEngineProfileDirectory(profilePath, { create: true });
    const observerPath = join(engineProfileDirectory, SESSION_DIRECTORY_NAME);
    assertManagedPath(engineProfileDirectory, observerPath);
    const observerDirectory = ensureCanonicalDirectory(observerPath);
    assertManagedPath(profilePath, observerDirectory);
    const contractPath = join(observerDirectory, SESSION_CONTRACT_NAME);
    assertManagedPath(profilePath, contractPath);
    if (!existsSync(contractPath)) return { kind: "none" };
    const existing = parseExistingContract(contractPath);
    if (Date.parse(existing.expiresAt) <= this.clock.now()) {
      unlinkSync(contractPath);
      return { kind: "expired_removed" };
    }
    const result = await probe(existing);
    if (result === "same") {
      throw new ObserverError("PROFILE_CONFLICT", `Observer profile is actively leased by exact agent ${existing.agent.instanceId}`, 409);
    }
    if (result === "unverifiable") {
      throw new ObserverError("PROFILE_CONFLICT", "Observer profile lease could not be verified and was preserved", 409);
    }
    const archiveRoot = ensureCanonicalDirectory(join(observerDirectory, "orphaned-contracts"));
    assertManagedPath(observerDirectory, archiveRoot);
    const archivedPath = join(archiveRoot, `${existing.sessionId}-${this.clock.now()}.json`);
    assertManagedPath(archiveRoot, archivedPath);
    renameSync(contractPath, archivedPath);
    return { kind: "orphan_archived", archivedPath };
  }

  create(input: CreateSessionInput): CreatedSession {
    const now = this.clock.now();
    if (!Number.isInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 24 * 60 * 60 * 1000) {
      throw new ObserverError("INVALID_REQUEST", "Session TTL must be between one second and 24 hours");
    }
    const profilePath = ensureCanonicalDirectory(input.profilePath);
    const engineProfileDirectory = resolveEngineProfileDirectory(profilePath, { create: true });
    const observerPath = join(engineProfileDirectory, SESSION_DIRECTORY_NAME);
    assertManagedPath(engineProfileDirectory, observerPath);
    const observerDirectory = ensureCanonicalDirectory(observerPath);
    assertManagedPath(profilePath, observerDirectory);
    ensureCanonicalDirectory(join(observerDirectory, "mailbox", "commands"));
    ensureCanonicalDirectory(join(observerDirectory, "mailbox", "status"));
    ensureCanonicalDirectory(join(observerDirectory, "captures"));
    const contractPath = join(observerDirectory, SESSION_CONTRACT_NAME);
    assertManagedPath(profilePath, contractPath);
    if (existsSync(contractPath)) {
      const existing = parseExistingContract(contractPath);
      if (Date.parse(existing.expiresAt) > now) {
        throw new ObserverError("PROFILE_CONFLICT", `Observer profile is already leased by session ${existing.sessionId}`);
      }
      unlinkSync(contractPath);
    }

    const sessionId = input.sessionId ?? `s-${randomUUID()}`;
    const launchNonce = input.launchNonce ?? secret();
    const sessionToken = secret();
    const limits: ObserverLimits = {
      maxPendingJobs: input.limits?.maxPendingJobs ?? DEFAULT_LIMITS.maxPendingJobs,
      maxCaptureRatePerMinute: input.limits?.maxCaptureRatePerMinute ?? DEFAULT_LIMITS.maxCaptureRatePerMinute,
      maxArtifactBytes: input.limits?.maxArtifactBytes ?? DEFAULT_LIMITS.maxArtifactBytes,
      minFov: input.limits?.minFov ?? DEFAULT_LIMITS.minFov,
      maxFov: input.limits?.maxFov ?? DEFAULT_LIMITS.maxFov,
      maxSettleFrames: input.limits?.maxSettleFrames ?? DEFAULT_LIMITS.maxSettleFrames,
      maxCaptureDistance: input.limits?.maxCaptureDistance ?? DEFAULT_LIMITS.maxCaptureDistance,
    };
    const expiresAt = now + input.ttlMs;
    const contract = sessionContractSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      addonVersion: ADDON_VERSION,
      bundleDigest: input.bundleDigest,
      buildIdentity: input.buildIdentity,
      expectedRuntimeKind: input.expectedRuntimeKind,
      sessionId,
      launchNonce,
      sessionToken,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      expiresAtUnix: Math.floor(expiresAt / 1000),
      agent: input.agent,
      transportPreference: [...new Set(input.transportPreference)],
      profileDirectoryName: SESSION_DIRECTORY_NAME,
      limits,
    });
    const record: SessionRecord = {
      sessionId,
      launchNonce,
      tokenDigest: digestToken(sessionToken),
      createdAt: now,
      expiresAt,
      bundleDigest: input.bundleDigest,
      buildIdentity: input.buildIdentity,
      expectedRuntimeKind: input.expectedRuntimeKind,
      agentInstanceId: input.agent.instanceId,
      stagedAddonPath: input.stagedAddonPath,
      profilePath,
      transportPreference: contract.transportPreference,
      limits,
      registeredInstanceNonce: null,
      allowMultipleInstances: input.allowMultipleInstances ?? false,
      revokedAt: null,
    };
    this.assertCapacity(record);
    atomicWriteJson(profilePath, contractPath, contract);
    this.sessions.set(sessionId, record);
    return { contract, record, contractPath };
  }

  peek(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  isTerminal(sessionId: string, now = this.clock.now()): boolean {
    const record = this.sessions.get(sessionId);
    return !record || record.revokedAt !== null || record.expiresAt <= now;
  }

  pin(sessionId: string, owner: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(owner)) {
      throw new ObserverError("INVALID_REQUEST", "Session retention pin owner is invalid");
    }
    const owners = this.retentionPins.get(sessionId) ?? new Set<string>();
    owners.add(owner);
    this.retentionPins.set(sessionId, owners);
    return true;
  }

  unpin(sessionId: string, owner: string): boolean {
    const owners = this.retentionPins.get(sessionId);
    if (!owners || !owners.delete(owner)) return false;
    if (owners.size === 0) this.retentionPins.delete(sessionId);
    return true;
  }

  isPinned(sessionId: string, externallyPinned: ReadonlySet<string> = new Set()): boolean {
    return externallyPinned.has(sessionId) || (this.retentionPins.get(sessionId)?.size ?? 0) > 0;
  }

  get(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new ObserverError("SESSION_NOT_FOUND", "Observer session was not found", 404);
    if (record.revokedAt !== null) throw new ObserverError("SESSION_EXPIRED", "Observer session is revoked", 410);
    if (record.expiresAt <= this.clock.now()) throw new ObserverError("SESSION_EXPIRED", "Observer session has expired", 410);
    return record;
  }

  authorize(sessionId: string, token: string): SessionRecord {
    let record: SessionRecord;
    try {
      record = this.get(sessionId);
    } catch {
      throw new ObserverError("UNAUTHORIZED", "Runtime credential is invalid", 401);
    }
    if (!token || !equalDigest(record.tokenDigest, digestToken(token))) {
      throw new ObserverError("UNAUTHORIZED", "Runtime credential is invalid", 401);
    }
    return record;
  }

  bindInstance(sessionId: string, instanceNonce: string): void {
    const record = this.get(sessionId);
    if (record.allowMultipleInstances) return;
    if (record.registeredInstanceNonce && record.registeredInstanceNonce !== instanceNonce) {
      throw new ObserverError("INSTANCE_CONFLICT", "A different process-lifetime nonce is already registered for this launch", 409);
    }
    const next = { ...record, registeredInstanceNonce: instanceNonce };
    this.assertCapacity(next, false);
    record.registeredInstanceNonce = instanceNonce;
  }

  revoke(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    if (record.revokedAt === null) {
      const next = { ...record, revokedAt: this.clock.now() };
      this.assertCapacity(next, false);
      record.revokedAt = next.revokedAt;
    }
    // Revocation is cleanup, not launch preparation. If the exclusive launch
    // root was already removed, commit the in-memory revocation without
    // recreating any part of the engine profile mount.
    if (!existsSync(record.profilePath)) return true;
    try {
      const engineProfileDirectory = resolveEngineProfileDirectory(record.profilePath);
      const contractPath = join(engineProfileDirectory, SESSION_DIRECTORY_NAME, SESSION_CONTRACT_NAME);
      assertManagedPath(record.profilePath, contractPath);
      if (existsSync(contractPath)) {
        const existing = parseExistingContract(contractPath);
        if (existing.sessionId === record.sessionId && existing.launchNonce === record.launchNonce) unlinkSync(contractPath);
      }
    } catch {
      // revokedAt is the committed authority. A malformed/replaced contract is
      // preserved for forensic cleanup, but must not keep a completed runtime
      // stop reservation pinned forever. Repeated revoke calls may retry.
    }
    return true;
  }

  sweep(now = this.clock.now(), externallyPinned: ReadonlySet<string> = new Set()): SessionSweepResult {
    const expiredSessionIds: string[] = [];
    for (const record of this.sessions.values()) {
      if (record.revokedAt === null && record.expiresAt <= now) {
        try {
          this.revoke(record.sessionId);
        } catch {
          // Revocation state is committed before contract cleanup. A malformed
          // or replaced contract is preserved for review without stopping the
          // remaining expiry sweep.
        }
        expiredSessionIds.push(record.sessionId);
      }
    }
    const removedSessionIds: string[] = [];
    for (const record of this.sessions.values()) {
      const terminalAt = record.revokedAt;
      if (terminalAt === null || now - terminalAt < this.terminalRetentionMs || this.isPinned(record.sessionId, externallyPinned)) {
        continue;
      }
      this.sessions.delete(record.sessionId);
      this.retentionPins.delete(record.sessionId);
      removedSessionIds.push(record.sessionId);
    }
    return { expiredSessionIds, removedSessionIds };
  }

  sweepExpired(): string[] {
    return this.sweep().expiredSessionIds;
  }

  activeBundleDigests(): Set<string> {
    const result = new Set<string>();
    for (const record of this.sessions.values()) {
      if (record.revokedAt === null && record.expiresAt > this.clock.now()) result.add(record.bundleDigest);
    }
    return result;
  }

  diagnostics(): Array<Omit<SessionRecord, "tokenDigest">> {
    return [...this.sessions.values()].map(({ tokenDigest: _secret, ...record }) => ({ ...record }));
  }

  activeRecords(): SessionRecord[] {
    return [...this.sessions.values()].filter((record) => record.revokedAt === null && record.expiresAt > this.clock.now());
  }

  stats(now = this.clock.now()): SessionStoreStats {
    const records = [...this.sessions.values()];
    const active = records.filter((record) => record.revokedAt === null && record.expiresAt > now).length;
    return {
      records: records.length,
      active,
      terminal: records.length - active,
      pinned: [...this.retentionPins.values()].filter((owners) => owners.size > 0).length,
      estimatedBytes: records.reduce((total, record) => total + this.budgetedRecordBytes(record), 0),
      actualBytes: records.reduce((total, record) => total + this.recordBytes(record), 0),
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      terminalRetentionMs: this.terminalRetentionMs,
    };
  }

  private assertCapacity(record: SessionRecord, sweep = true): void {
    // Admission cannot see the application-level evidence/run pins supplied
    // to the coordinated sweep. Never perform an unpinned retention mutation
    // from this local capacity check.
    void sweep;
    const replacing = this.sessions.get(record.sessionId);
    const nextRecords = this.sessions.size + (replacing ? 0 : 1);
    const currentBytes = [...this.sessions.values()].reduce((total, existing) => total + this.budgetedRecordBytes(existing), 0);
    const nextBytes = currentBytes - (replacing ? this.budgetedRecordBytes(replacing) : 0) + this.budgetedRecordBytes(record);
    if (nextRecords > this.maxRecords || nextBytes > this.maxEstimatedBytes) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer session store retention budget is exhausted", 503);
    }
  }

  private recordBytes(record: SessionRecord): number {
    return Buffer.byteLength(JSON.stringify(record), "utf8");
  }

  private budgetedRecordBytes(record: SessionRecord): number {
    // Charge the worst possible mutable shape at admission. Binding and
    // revocation can then never fail merely because null fields grew during
    // mandatory lifecycle cleanup.
    return this.recordBytes({
      ...record,
      registeredInstanceNonce: "x".repeat(256),
      revokedAt: Number.MAX_SAFE_INTEGER,
    });
  }

  private boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
      throw new ObserverError("INVALID_REQUEST", `${label} must be an integer from ${minimum} through ${maximum}`);
    }
    return selected;
  }
}
