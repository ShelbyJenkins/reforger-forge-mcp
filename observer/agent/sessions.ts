import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { boundedOption } from "#foundation/bounded-option";
import { BoundedJsonMap, BoundedJsonStore } from "#foundation/json-store";
import {
  ADDON_VERSION,
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  SESSION_CONTRACT_NAME,
  SESSION_DIRECTORY_NAME,
  sessionContractSchema,
  limitsSchema,
  type ObserverLimits,
  type ObserverTransport,
  type InstanceRegistration,
  type SessionContract,
} from "../protocol/index.js";
import { ObserverError, observerOptionError } from "./errors.js";
import { assertManagedPath, ensureCanonicalDirectory, resolveEngineProfileDirectory } from "./paths.js";

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
  lifecycleLeased: number;
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

const durableSessionRecordSchema = z.object({
  sessionId: z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/),
  launchNonce: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  buildIdentity: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRuntimeKind: z.enum(["client", "listenServer", "dedicated", "workbench", "testRunner"]),
  agentInstanceId: z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/),
  stagedAddonPath: z.string().min(1).max(32_768),
  profilePath: z.string().min(1).max(32_768),
  transportPreference: z.array(z.enum(["rest", "mailbox"])).min(1).max(2),
  limits: limitsSchema,
  registeredInstanceNonce: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/).nullable(),
  allowMultipleInstances: z.boolean(),
  revokedAt: z.number().int().nonnegative().nullable(),
});

const MAX_SESSION_CONTRACT_BYTES = 1024 * 1024;

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
  try {
    const contract = new BoundedJsonStore({
      root: dirname(contractPath),
      minRecordBytes: 2,
      maxRecordBytes: MAX_SESSION_CONTRACT_BYTES,
      parse: (value) => sessionContractSchema.parse(value),
    }).read(contractPath);
    if (!contract) throw new Error("session contract is missing");
    return contract;
  } catch (error) {
    if (error instanceof ObserverError) throw error;
    throw new ObserverError("PROFILE_CONFLICT", "Observer profile contains an unrecognized session contract");
  }
}

export class SessionStore {
  private readonly sessions: BoundedJsonMap<string, SessionRecord>;
  private readonly retentionPins = new Map<string, Set<string>>();
  private readonly lifecycleLeases = new Map<string, Set<string>>();
  readonly terminalRetentionMs: number;
  readonly maxRecords: number;
  readonly maxEstimatedBytes: number;

  constructor(private readonly clock: Clock = systemClock, options: SessionStoreOptions = {}) {
    this.terminalRetentionMs = boundedOption(
      options.terminalRetentionMs,
      SESSION_TOMBSTONE_RETENTION_MS,
      0,
      24 * 60 * 60_000,
      "Session terminal retention",
      observerOptionError
    );
    this.maxRecords = boundedOption(
      options.maxRecords,
      DEFAULT_SESSION_MAX_RECORDS,
      1,
      100_000,
      "Session record limit",
      observerOptionError
    );
    this.maxEstimatedBytes = boundedOption(
      options.maxEstimatedBytes,
      DEFAULT_SESSION_MAX_BYTES,
      1_024,
      1024 * 1024 * 1024,
      "Session store byte limit",
      observerOptionError
    );
    this.sessions = new BoundedJsonMap({
      maxRecords: this.maxRecords,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (_sessionId, record) => this.budgetedRecordBytes(record),
      capacityError: () => new ObserverError(
        "TRANSPORT_UNAVAILABLE",
        "Observer session store retention budget is exhausted",
        503
      ),
    });
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
    new BoundedJsonStore({
      root: observerDirectory,
      minRecordBytes: 2,
      maxRecordBytes: MAX_SESSION_CONTRACT_BYTES,
      parse: (value) => sessionContractSchema.parse(value),
    }).write(contractPath, contract);
    this.sessions.set(sessionId, record);
    return { contract, record, contractPath };
  }

  peek(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /** Owner-private snapshot used only by exact owned-runtime recovery. */
  durableSnapshot(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new ObserverError("SESSION_NOT_FOUND", "Observer session was not found", 404);
    return structuredClone(durableSessionRecordSchema.parse(record));
  }

  /**
   * Reconstruct an exact lifecycle lease from an owner-private durable
   * snapshot and the runtime's still-present activation contract. Expiry is
   * intentionally ignored here: the durable lease predates expiry. Explicit
   * revocation is never undone.
   */
  restoreLifecycle(recordInput: unknown, owner: string): boolean {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(owner)) {
      throw new ObserverError("INVALID_REQUEST", "Session retention pin owner is invalid");
    }
    const parsed = durableSessionRecordSchema.parse(recordInput);
    if (parsed.revokedAt !== null) return false;
    const profilePath = ensureCanonicalDirectory(parsed.profilePath);
    const stagedAddonPath = ensureCanonicalDirectory(parsed.stagedAddonPath);
    const engineProfileDirectory = resolveEngineProfileDirectory(profilePath, { requireExisting: true });
    const contractPath = join(engineProfileDirectory, SESSION_DIRECTORY_NAME, SESSION_CONTRACT_NAME);
    assertManagedPath(profilePath, contractPath);
    if (!existsSync(contractPath)) {
      throw new ObserverError(
        "SESSION_NOT_FOUND",
        "Durable observer lifecycle has no activation contract",
        404
      );
    }
    const contract = parseExistingContract(contractPath);
    if (contract.sessionId !== parsed.sessionId || contract.launchNonce !== parsed.launchNonce ||
        digestToken(contract.sessionToken) !== parsed.tokenDigest ||
        Date.parse(contract.createdAt) !== parsed.createdAt ||
        Date.parse(contract.expiresAt) !== parsed.expiresAt ||
        contract.bundleDigest !== parsed.bundleDigest ||
        contract.buildIdentity !== parsed.buildIdentity ||
        contract.expectedRuntimeKind !== parsed.expectedRuntimeKind ||
        contract.agent.instanceId !== parsed.agentInstanceId ||
        JSON.stringify(contract.transportPreference) !== JSON.stringify(parsed.transportPreference) ||
        JSON.stringify(contract.limits) !== JSON.stringify(parsed.limits)) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Durable observer lifecycle does not match its activation contract",
        409
      );
    }
    const record: SessionRecord = { ...parsed, profilePath, stagedAddonPath };
    const existing = this.sessions.get(record.sessionId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Recovered observer session conflicts with current in-memory state",
        409
      );
    }
    const owners = this.lifecycleLeases.get(record.sessionId);
    if (owners && owners.size > 0 && !owners.has(owner)) return false;
    if (!existing) {
      this.assertCapacity(record, false);
      this.sessions.set(record.sessionId, record);
    }
    if (!this.pin(record.sessionId, owner)) return false;
    const nextOwners = owners ?? new Set<string>();
    nextOwners.add(owner);
    this.lifecycleLeases.set(record.sessionId, nextOwners);
    return true;
  }

  isTerminal(sessionId: string, now = this.clock.now()): boolean {
    const record = this.sessions.get(sessionId);
    return !record || record.revokedAt !== null ||
      (record.expiresAt <= now && !this.isLifecycleLeased(sessionId));
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

  retainLifecycle(sessionId: string, owner: string): boolean {
    const record = this.sessions.get(sessionId);
    const alreadyRetained = this.lifecycleLeases.get(sessionId)?.has(owner) === true;
    if (alreadyRetained) {
      // Exact-owner retries repair the ordinary retention pin even after an
      // explicit revoke. They do not make the revoked session active again.
      return this.pin(sessionId, owner);
    }
    if ((this.lifecycleLeases.get(sessionId)?.size ?? 0) > 0) return false;
    if (!record || record.revokedAt !== null ||
        (record.expiresAt <= this.clock.now() && !this.isLifecycleLeased(sessionId))) {
      return false;
    }
    if (!this.pin(sessionId, owner)) return false;
    const owners = this.lifecycleLeases.get(sessionId) ?? new Set<string>();
    owners.add(owner);
    this.lifecycleLeases.set(sessionId, owners);
    return true;
  }

  releaseLifecycle(sessionId: string, owner: string): boolean {
    const owners = this.lifecycleLeases.get(sessionId);
    if (!owners || !owners.delete(owner)) return false;
    if (owners.size === 0) this.lifecycleLeases.delete(sessionId);
    this.unpin(sessionId, owner);
    return true;
  }

  isLifecycleLeased(sessionId: string): boolean {
    return (this.lifecycleLeases.get(sessionId)?.size ?? 0) > 0;
  }

  isPinned(sessionId: string, externallyPinned: ReadonlySet<string> = new Set()): boolean {
    return externallyPinned.has(sessionId) || (this.retentionPins.get(sessionId)?.size ?? 0) > 0;
  }

  get(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new ObserverError("SESSION_NOT_FOUND", "Observer session was not found", 404);
    if (record.revokedAt !== null) throw new ObserverError("SESSION_EXPIRED", "Observer session is revoked", 410);
    if (record.expiresAt <= this.clock.now() && !this.isLifecycleLeased(sessionId)) {
      throw new ObserverError("SESSION_EXPIRED", "Observer session has expired", 410);
    }
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
      if (record.revokedAt === null && record.expiresAt <= now && !this.isLifecycleLeased(record.sessionId)) {
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
      this.lifecycleLeases.delete(record.sessionId);
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
      if (this.isLifecycleLeased(record.sessionId) ||
          (record.revokedAt === null && record.expiresAt > this.clock.now())) {
        result.add(record.bundleDigest);
      }
    }
    return result;
  }

  diagnostics(): Array<Omit<SessionRecord, "tokenDigest">> {
    return [...this.sessions.values()].map(({ tokenDigest: _secret, ...record }) => ({ ...record }));
  }

  activeRecords(): SessionRecord[] {
    return [...this.sessions.values()].filter((record) => record.revokedAt === null &&
      (record.expiresAt > this.clock.now() || this.isLifecycleLeased(record.sessionId)));
  }

  stats(now = this.clock.now()): SessionStoreStats {
    const records = [...this.sessions.values()];
    const active = records.filter((record) => record.revokedAt === null &&
      (record.expiresAt > now || this.isLifecycleLeased(record.sessionId))).length;
    return {
      records: records.length,
      active,
      terminal: records.length - active,
      pinned: [...this.retentionPins.values()].filter((owners) => owners.size > 0).length,
      lifecycleLeased: [...this.lifecycleLeases.values()].filter((owners) => owners.size > 0).length,
      estimatedBytes: this.sessions.estimatedBytes(),
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
    this.sessions.assertCanSet(record.sessionId, record);
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

}
