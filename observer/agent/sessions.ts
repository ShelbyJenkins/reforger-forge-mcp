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

  constructor(private readonly clock: Clock = systemClock) {}

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
    atomicWriteJson(profilePath, contractPath, contract);
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
    this.sessions.set(sessionId, record);
    return { contract, record, contractPath };
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
    record.registeredInstanceNonce = instanceNonce;
  }

  revoke(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    if (record.revokedAt === null) record.revokedAt = this.clock.now();
    // Revocation is cleanup, not launch preparation. If the exclusive launch
    // root was already removed, commit the in-memory revocation without
    // recreating any part of the engine profile mount.
    if (!existsSync(record.profilePath)) return true;
    const engineProfileDirectory = resolveEngineProfileDirectory(record.profilePath);
    const contractPath = join(engineProfileDirectory, SESSION_DIRECTORY_NAME, SESSION_CONTRACT_NAME);
    assertManagedPath(record.profilePath, contractPath);
    if (existsSync(contractPath)) {
      const existing = parseExistingContract(contractPath);
      if (existing.sessionId === record.sessionId && existing.launchNonce === record.launchNonce) unlinkSync(contractPath);
    }
    return true;
  }

  sweepExpired(): string[] {
    const expired: string[] = [];
    for (const record of this.sessions.values()) {
      if (record.revokedAt === null && record.expiresAt <= this.clock.now()) {
        try {
          this.revoke(record.sessionId);
        } catch {
          // Revocation state is committed before contract cleanup. A malformed
          // or replaced contract is preserved for review without stopping the
          // remaining expiry sweep.
        }
        expired.push(record.sessionId);
      }
    }
    return expired;
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
}
