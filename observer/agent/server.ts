import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { ZodError } from "zod";
import { boundedOption } from "#foundation/bounded-option";
import { AGENT_VERSION, DEFAULT_LIMITS, MAX_PROTOCOL_MESSAGE_BYTES, PROTOCOL_VERSION } from "../protocol/index.js";
import { ArtifactStore } from "./artifacts.js";
import { ObserverControlApi } from "./control-api.js";
import { asObserverError, errorBody, ObserverError, observerOptionError } from "./errors.js";
import { JobStore, type JobStoreDurableMutation } from "./jobs.js";
import { observerLogger } from "./logger.js";
import { MailboxCoordinator, type MailboxCoordinatorOptions, type MailboxSweepResult } from "./mailbox-coordinator.js";
import { InstanceRegistry, type RegistryDurableMutation } from "./registry.js";
import { ObserverRuntimeApi } from "./runtime-api.js";
import { ObserverRunStore } from "./runs.js";
import type { ObserverApplicationOperations, ObserverApplicationOperationName } from "./application-operations.js";
import {
  OwnedRuntimeAuthorityStore,
  type OwnedRuntimeRecoveryAuthority,
} from "./owned-runtime-authority.js";

export interface ObserverAgentServerOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  enableControlHttp?: boolean;
  maxBodyBytes?: number;
  retentionIntervalMs?: number;
  retentionMaxAgeMs?: number;
  retentionMaxBytes?: number;
  sweepIntervalMs?: number;
  mailbox?: MailboxCoordinatorOptions;
  clock?: { now(): number };
}

export interface ObserverApplicationSweepResult {
  at: string;
  expiredJobIds: string[];
  jobs: ReturnType<JobStore["sweep"]>;
  sessions: ReturnType<ObserverControlApi["sessions"]["sweep"]>;
  instances: ReturnType<InstanceRegistry["sweep"]>;
  mailbox: MailboxSweepResult;
  removedPreparedReceiptKeys: string[];
  retentionApplied: boolean;
}

export interface StartupDescriptor {
  protocolVersion: typeof PROTOCOL_VERSION;
  agentVersion: typeof AGENT_VERSION;
  agentInstanceId: string;
  host: "127.0.0.1" | "::1";
  port: number;
  controlHttpEnabled: boolean;
  controlToken?: string;
}

interface OwnedRuntimeLifecyclePin {
  runtimeId: string;
  sessionId: string;
  generation: string;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function constantTimeToken(left: string, right: string): boolean {
  const a = tokenDigest(left);
  const b = tokenDigest(right);
  return timingSafeEqual(a, b);
}

function bearer(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]{1,512})$/.exec(authorization);
  return match?.[1] ?? null;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const data = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(data.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (!contentType || !/^application\/json(?:;|$)/i.test(contentType)) {
    throw new ObserverError("INVALID_REQUEST", "Observer endpoints require application/json", 415);
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new ObserverError("INVALID_REQUEST", "Request body exceeds the observer limit", 413);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.length;
    if (total > maxBytes) throw new ObserverError("INVALID_REQUEST", "Request body exceeds the observer limit", 413);
    chunks.push(data);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    throw new ObserverError("INVALID_REQUEST", "Request body is not a JSON object");
  }
}

function runtimeCredential(request: IncomingMessage, body: Record<string, unknown>): string {
  const headerToken = bearer(request);
  const bodyToken = typeof body.sessionToken === "string" ? body.sessionToken : null;
  const token = headerToken ?? bodyToken;
  if (!token) throw new ObserverError("UNAUTHORIZED", "Runtime credential is required", 401);
  delete body.sessionToken;
  return token;
}

export class ObserverAgentServer {
  private server: Server | null = null;
  private descriptor: StartupDescriptor | null = null;
  private readonly runtime: ObserverRuntimeApi;
  private readonly mailbox: MailboxCoordinator;
  private sweepTimer: NodeJS.Timeout | null = null;
  private mailboxPollPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private lastRetentionAt = 0;
  private lastSweep: ObserverApplicationSweepResult | null = null;
  private readonly ownedRuntimeLifecyclePins = new Map<string, OwnedRuntimeLifecyclePin>();
  private readonly ownedRuntimeAuthorities: OwnedRuntimeAuthorityStore;
  private controlOperations: Pick<ObserverApplicationOperations, "execute"> | null = null;

  constructor(
    readonly agentInstanceId: string,
    readonly control: ObserverControlApi,
    readonly registry: InstanceRegistry,
    readonly jobs: JobStore,
    readonly artifacts: ArtifactStore,
    readonly runs: ObserverRunStore,
    private readonly options: ObserverAgentServerOptions = {}
  ) {
    this.runtime = new ObserverRuntimeApi(control.sessions, registry, jobs, artifacts);
    this.mailbox = new MailboxCoordinator(control.sessions, registry, jobs, artifacts, options.mailbox);
    this.ownedRuntimeAuthorities = new OwnedRuntimeAuthorityStore(
      control.paths.state,
      () => options.clock?.now() ?? Date.now(),
      {
        maxRecords: control.sessions.maxRecords,
        releaseRetentionMs: control.sessions.terminalRetentionMs,
      }
    );
    this.jobs.setDurableMutationHook((mutation) => {
      this.persistOwnedRuntimeLifecycleSnapshot(mutation.sessionId, mutation, undefined);
    });
    this.registry.setDurableMutationHook((mutation) => {
      this.persistOwnedRuntimeLifecycleSnapshot(mutation.sessionId, undefined, mutation);
    });
  }

  setControlOperations(operations: Pick<ObserverApplicationOperations, "execute">): void {
    if (this.controlOperations) throw new ObserverError("INVALID_REQUEST", "Observer control operations are already configured", 409);
    this.controlOperations = operations;
  }

  async start(): Promise<StartupDescriptor> {
    if (this.server) return this.descriptor!;
    if (this.closePromise) await this.closePromise;
    this.closePromise = null;
    const host = this.options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") throw new ObserverError("INVALID_REQUEST", "Observer agent may bind only to a loopback address");
    const port = this.options.port ?? 0;
    const maxBodyBytes = Math.min(this.options.maxBodyBytes ?? DEFAULT_LIMITS.maxRequestBodyBytes, MAX_PROTOCOL_MESSAGE_BYTES);
    const server = createServer((request, response) => {
      void this.handle(request, response, maxBodyBytes).catch((error) => {
        const normalized = error instanceof ZodError
          ? new ObserverError("INVALID_REQUEST", "Control request validation failed")
          : asObserverError(error);
        if (!response.headersSent) json(response, normalized.httpStatus, errorBody(normalized));
        else response.destroy();
      });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 2_000;
    server.maxHeadersCount = 32;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || (address.address !== "127.0.0.1" && address.address !== "::1")) {
      server.close();
      throw new ObserverError("INTERNAL_ERROR", "Observer server did not bind a loopback TCP address");
    }
    this.server = server;
    this.control.setEndpoint(host, address.port, this.agentInstanceId);
    this.descriptor = {
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      agentInstanceId: this.agentInstanceId,
      host,
      port: address.port,
      controlHttpEnabled: this.options.enableControlHttp ?? false,
      ...(this.options.enableControlHttp ? { controlToken: this.control.controlToken } : {}),
    };
    const sweepIntervalMs = boundedOption(this.options.sweepIntervalMs, 1_000, 100, 60_000, "Observer sweep interval", observerOptionError);
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep(Date.now());
      } catch (error) {
        observerLogger.warn("observer application sweep failed", {
          errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
        });
      }
      this.scheduleMailboxPoll();
    }, sweepIntervalMs);
    this.sweepTimer.unref();
    return this.descriptor;
  }

  sweep(now = Date.now(), forceRetention = false): ObserverApplicationSweepResult {
    const expiredJobIds = this.jobs.sweepDeadlines(now);
    const protectedJobIds = this.runs.protectedRuntimeJobIds();
    const jobs = this.jobs.sweep(now, { pinnedJobIds: protectedJobIds });
    const authoritativeObligationJobIds = this.jobs.obligationJobIds(protectedJobIds);
    const obligationSessionIds = this.obligationSessionIds(protectedJobIds, authoritativeObligationJobIds);

    // First mark expiry while every extant child store still pins its owner.
    // Then remove only obligation-free instances/transports and make a second
    // pass that can retire the now-unowned session tombstone.
    const firstPassPins = new Set([
      ...obligationSessionIds,
      ...this.control.preparedSessionIds(now),
      ...this.registry.sessionIds(),
      ...this.mailbox.sessionIds(),
    ]);
    const firstSessions = this.control.sessions.sweep(now, firstPassPins);
    const instances = this.registry.sweep(now, obligationSessionIds, authoritativeObligationJobIds);
    const mailbox = this.mailbox.sweep(now, obligationSessionIds);
    const finalPins = new Set([
      ...this.obligationSessionIds(protectedJobIds, authoritativeObligationJobIds),
      ...this.control.preparedSessionIds(now),
      ...this.registry.sessionIds(),
      ...this.mailbox.sessionIds(),
    ]);
    const finalSessions = this.control.sessions.sweep(now, finalPins);
    const removedPreparedReceiptKeys = this.control.sweepPrepared(now, finalPins);
    this.ownedRuntimeAuthorities.sweep(now);

    const retentionIntervalMs = boundedOption(
      this.options.retentionIntervalMs,
      60_000,
      1_000,
      24 * 60 * 60_000,
      "Observer retention interval",
      observerOptionError
    );
    const retentionApplied = forceRetention || now - this.lastRetentionAt >= retentionIntervalMs;
    if (retentionApplied) {
      this.lastRetentionAt = now;
      this.applyDiskRetention(now, finalPins);
    }
    const result: ObserverApplicationSweepResult = {
      at: new Date(now).toISOString(),
      expiredJobIds,
      jobs,
      sessions: {
        expiredSessionIds: [...new Set([...firstSessions.expiredSessionIds, ...finalSessions.expiredSessionIds])],
        removedSessionIds: [...new Set([...firstSessions.removedSessionIds, ...finalSessions.removedSessionIds])],
      },
      instances,
      mailbox,
      removedPreparedReceiptKeys,
      retentionApplied,
    };
    this.lastSweep = result;
    return result;
  }

  /**
   * Retain the complete observer-side lifecycle for one exact owned runtime.
   * The durable runtime receipt is the source of truth; this bounded map is
   * the live agent lease that prevents TTL retention from deleting the state
   * required by a later exact stop.
   */
  retainOwnedRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string,
    authorityInput: Omit<OwnedRuntimeRecoveryAuthority, "sessionId" | "runtimeId" | "generation">
  ): { retained: boolean; alreadyRetained: boolean; reconstructed: boolean; generation: string } {
    this.assertOwnedRuntimeLifecycleIdentity(sessionId, runtimeId, generation);
    const authority = this.ownedRuntimeAuthorities.validateAuthority({
      sessionId,
      runtimeId,
      generation,
      ...authorityInput,
    });
    const existing = this.ownedRuntimeLifecyclePins.get(runtimeId);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.generation !== generation) {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Owned runtime lifecycle pin belongs to another exact runtime generation",
          409
        );
      }
      if (!this.control.sessions.retainLifecycle(sessionId, this.ownedRuntimePinOwner(runtimeId))) {
        return { retained: false, alreadyRetained: true, reconstructed: false, generation };
      }
      return { retained: true, alreadyRetained: true, reconstructed: false, generation };
    }
    for (const pin of this.ownedRuntimeLifecyclePins.values()) {
      if (pin.sessionId === sessionId) {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Observer session is already retained by another owned runtime",
          409
        );
      }
    }
    if (this.ownedRuntimeLifecyclePins.size >= this.control.sessions.maxRecords) {
      throw new ObserverError(
        "TRANSPORT_UNAVAILABLE",
        "Owned runtime lifecycle pin capacity is exhausted",
        503
      );
    }
    const currentSession = this.control.sessions.peek(sessionId);
    let retained: ReturnType<OwnedRuntimeAuthorityStore["retain"]>;
    if (currentSession) {
      this.assertOwnedRuntimeSessionBinding(currentSession, authority);
      if (!this.control.sessions.retainLifecycle(sessionId, this.ownedRuntimePinOwner(runtimeId))) {
        return { retained: false, alreadyRetained: false, reconstructed: false, generation };
      }
      try {
        retained = this.ownedRuntimeAuthorities.retain(authority, {
          session: this.control.sessions.durableSnapshot(sessionId),
          jobs: this.jobs.durableSnapshot(sessionId),
          instances: this.registry.durableSnapshot(sessionId),
        });
      } catch (error) {
        this.control.sessions.releaseLifecycle(sessionId, this.ownedRuntimePinOwner(runtimeId));
        throw error;
      }
    } else {
      // The exact-generation durable record is read before any in-memory state
      // is created. A missing/corrupt/cross-bound record fails closed.
      retained = this.ownedRuntimeAuthorities.retain(authority, {
        session: null,
        jobs: [],
        instances: [],
      });
      if (!retained.record.session || retained.record.state !== "retained") {
        throw new ObserverError(
          "SESSION_UNVERIFIABLE",
          "Owned runtime recovery authority has no retained observer session",
          409
        );
      }
      if (!this.control.sessions.restoreLifecycle(
        retained.record.session,
        this.ownedRuntimePinOwner(runtimeId)
      )) {
        throw new ObserverError(
          "SESSION_UNVERIFIABLE",
          "Owned runtime recovery could not reconstruct its exact session lease",
          409
        );
      }
      this.assertOwnedRuntimeSessionBinding(
        this.control.sessions.durableSnapshot(sessionId),
        authority
      );
      this.registry.restoreDurable(sessionId, retained.record.instances);
      this.jobs.restoreDurable(sessionId, retained.record.jobs);
    }
    this.ownedRuntimeLifecyclePins.set(runtimeId, { runtimeId, sessionId, generation });
    return {
      retained: true,
      alreadyRetained: retained.alreadyRetained,
      reconstructed: currentSession === undefined,
      generation,
    };
  }

  assertOwnedRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): boolean {
    this.assertOwnedRuntimeLifecycleIdentity(sessionId, runtimeId, generation);
    const existing = this.ownedRuntimeLifecyclePins.get(runtimeId);
    if (!existing) {
      const durable = this.ownedRuntimeAuthorities.read(runtimeId);
      if (durable) {
        if (durable.authority.sessionId !== sessionId || durable.authority.generation !== generation) {
          throw new ObserverError(
            "SESSION_MISMATCH",
            "Owned runtime lifecycle belongs to another exact generation",
            409
          );
        }
        if (durable.state === "release_acknowledged") return false;
        throw new ObserverError(
          "SESSION_UNVERIFIABLE",
          "Owned runtime lifecycle must be reconstructed before mutation",
          409
        );
      }
      if ([...this.ownedRuntimeLifecyclePins.values()].some((pin) => pin.sessionId === sessionId)) {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Observer session is retained by another owned runtime lifecycle",
          409
        );
      }
      return false;
    }
    if (existing.sessionId !== sessionId || existing.generation !== generation) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Owned runtime lifecycle release belongs to another exact runtime generation",
        409
      );
    }
    return true;
  }

  releaseOwnedRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): { released: boolean; alreadyReleased: boolean; generation: string } {
    this.assertOwnedRuntimeLifecycleIdentity(sessionId, runtimeId, generation);
    const existing = this.ownedRuntimeLifecyclePins.get(runtimeId);
    if (existing && (existing.sessionId !== sessionId || existing.generation !== generation)) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Owned runtime lifecycle release belongs to another exact generation",
        409
      );
    }
    const acknowledgement = this.ownedRuntimeAuthorities.acknowledgeRelease(
      sessionId,
      runtimeId,
      generation
    );
    this.ownedRuntimeLifecyclePins.delete(runtimeId);
    this.control.sessions.releaseLifecycle(sessionId, this.ownedRuntimePinOwner(runtimeId));
    return acknowledgement;
  }

  claimOwnedRuntimeStopReservation(
    sessionId: string,
    runtimeId: string,
    generation: string,
    reservationId: string
  ): { reserved: boolean; reservationId?: string; created: boolean } {
    this.assertOwnedRuntimeLifecycle(sessionId, runtimeId, generation);
    return this.ownedRuntimeAuthorities.claimStopReservation(
      sessionId,
      runtimeId,
      generation,
      reservationId
    );
  }

  ownedRuntimeStopReservation(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): string | null {
    this.assertOwnedRuntimeLifecycle(sessionId, runtimeId, generation);
    return this.ownedRuntimeAuthorities.stopReservation(sessionId, runtimeId, generation);
  }

  releaseOwnedRuntimeStopReservation(
    sessionId: string,
    runtimeId: string,
    generation: string,
    reservationId: string
  ): boolean {
    this.assertOwnedRuntimeLifecycle(sessionId, runtimeId, generation);
    return this.ownedRuntimeAuthorities.releaseStopReservation(
      sessionId,
      runtimeId,
      generation,
      reservationId
    );
  }

  hasOwnedRuntimeStopReservation(sessionId: string): boolean {
    return this.ownedRuntimeAuthorities.hasStopReservation(sessionId);
  }

  storeDiagnostics(): Record<string, unknown> {
    return {
      sessions: this.control.sessions.stats(),
      instances: this.registry.stats(),
      jobs: this.jobs.stats(),
      mailbox: this.mailbox.stats(),
      preparedLaunches: this.control.preparedStats(),
      ownedRuntimeLifecyclePins: {
        records: this.ownedRuntimeLifecyclePins.size,
        maxRecords: this.control.sessions.maxRecords,
      },
      ownedRuntimeAuthorities: this.ownedRuntimeAuthorities.stats(),
      lastSweep: this.lastSweep,
    };
  }

  managedStorageDiagnostics(): Record<string, unknown> {
    return {
      artifacts: this.directoryUsage(this.control.paths.artifacts),
      runs: this.directoryUsage(this.control.paths.runs),
      profiles: this.directoryUsage(this.control.profileRoot),
      exportWork: this.directoryUsage(this.control.paths.exportWork),
      logs: this.directoryUsage(this.control.paths.logs),
      runStore: this.runs.diagnostics(),
      stores: this.storeDiagnostics(),
    };
  }

  private scheduleMailboxPoll(): void {
    if (this.mailboxPollPromise) return;
    this.mailboxPollPromise = this.mailbox.pollOnce()
      .catch((error) => observerLogger.warn("mailbox poll failed", {
        errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
      }))
      .finally(() => { this.mailboxPollPromise = null; });
  }

  private obligationSessionIds(
    protectedJobIds: ReadonlySet<string>,
    authoritativeObligationJobIds = this.jobs.obligationJobIds(protectedJobIds)
  ): Set<string> {
    const result = this.jobs.sessionPins(protectedJobIds);
    for (const sessionId of this.runs.protectedSessionIds()) result.add(sessionId);
    for (const job of this.jobs.diagnostics()) {
      const lease = job.cameraLease && typeof job.cameraLease === "object"
        ? job.cameraLease as Record<string, unknown>
        : null;
      if (typeof job.sessionId === "string" && lease?.everHeld === true &&
          lease.restorationConfirmed !== true &&
          lease.vacancyDisposition !== "exact_runtime_vacant") {
        result.add(job.sessionId);
      }
    }
    for (const instance of this.registry.diagnostics()) {
      const reportedJobIds = [instance.activeJobId, instance.cameraLeaseJobId]
        .filter((jobId): jobId is string => typeof jobId === "string");
      if (typeof instance.sessionId === "string" &&
          reportedJobIds.some((jobId) => authoritativeObligationJobIds.has(jobId))) {
        result.add(instance.sessionId);
      }
    }
    return result;
  }

  private persistOwnedRuntimeLifecycleSnapshot(
    sessionId: string,
    jobMutation?: JobStoreDurableMutation,
    registryMutation?: RegistryDurableMutation
  ): void {
    const authority = this.ownedRuntimeAuthorities.findRetainedBySession(sessionId);
    if (!authority || !this.ownedRuntimeLifecyclePins.has(authority.authority.runtimeId)) return;
    this.ownedRuntimeAuthorities.updateSnapshot(
      authority.authority.runtimeId,
      sessionId,
      {
        session: this.control.sessions.durableSnapshot(sessionId),
        jobs: this.jobs.durableSnapshot(sessionId, jobMutation),
        instances: this.registry.durableSnapshot(sessionId, registryMutation),
      }
    );
  }

  private applyDiskRetention(now: number, protectedSessionIds: ReadonlySet<string>): void {
    try {
      const maxAgeMs = this.options.retentionMaxAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
      const maxBytes = this.options.retentionMaxBytes ?? 512 * 1024 * 1024;
      this.runs.applyRetention(maxAgeMs);
      const auxiliaryBytes = this.sweepAuxiliaryStorage(maxAgeMs, maxBytes, now, protectedSessionIds) +
        this.directoryUsage(this.control.paths.runs).bytes;
      this.artifacts.applyRetention(
        maxAgeMs,
        Math.max(0, maxBytes - auxiliaryBytes),
        this.runs.protectedStoreKeys()
      );
    } catch (error) {
      observerLogger.warn("artifact retention sweep failed", {
        errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
      });
    }
  }

  private directoryUsage(root: string): { bytes: number; files: number; directories: number } {
    const result = { bytes: 0, files: 0, directories: 0 };
    if (!existsSync(root)) return result;
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          result.directories += 1;
          visit(path);
        } else if (entry.isFile()) {
          result.files += 1;
          result.bytes += statSync(path).size;
        }
      }
    };
    visit(root);
    return result;
  }

  private sweepAuxiliaryStorage(
    maxAgeMs: number,
    maxBytes: number,
    now: number,
    protectedSessionIds: ReadonlySet<string>
  ): number {
    const protectedProfiles = new Set(this.control.sessions.diagnostics().filter((record) =>
      record.revokedAt === null || protectedSessionIds.has(record.sessionId) || this.control.sessions.isPinned(record.sessionId)
    ).map((record) =>
      process.platform === "win32" ? record.profilePath.toLowerCase() : record.profilePath
    ));
    const candidates: Array<{ path: string; bytes: number; mtimeMs: number; protected: boolean }> = [];
    for (const [root, protectProfiles] of [
      [this.control.profileRoot, true],
      [this.control.paths.logs, false],
      [this.control.paths.exportWork, false],
    ] as const) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(root, entry.name);
        const info = lstatSync(path);
        if (!info.isDirectory() && !info.isFile()) continue;
        const key = process.platform === "win32" ? path.toLowerCase() : path;
        candidates.push({
          path,
          bytes: info.isDirectory() ? this.directoryUsage(path).bytes : info.size,
          mtimeMs: info.mtimeMs,
          protected: protectProfiles && [...protectedProfiles].some((active) => active === key || active.startsWith(`${key}${sep}`)),
        });
      }
    }
    candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let total = candidates.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of candidates) {
      if (item.protected) continue;
      if (now - item.mtimeMs <= maxAgeMs && total <= maxBytes) continue;
      const info = lstatSync(item.path);
      rmSync(item.path, { recursive: info.isDirectory(), force: false });
      total -= item.bytes;
    }
    return total;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const pendingMailboxPoll = this.mailboxPollPromise;
    if (pendingMailboxPoll) await pendingMailboxPoll;
    try {
      this.sweep(Date.now(), true);
    } catch (error) {
      observerLogger.warn("observer shutdown sweep failed", {
        errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
      });
    }
    const server = this.server;
    this.server = null;
    this.descriptor = null;
    this.control.clearEndpoint();
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  private assertOwnedRuntimeLifecycleIdentity(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): void {
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 96 ||
        !/^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runtimeId) ||
        !/^[a-f0-9]{64}$/.test(generation)) {
      throw new ObserverError("INVALID_REQUEST", "Owned runtime lifecycle pin identity is invalid");
    }
  }

  private assertOwnedRuntimeSessionBinding(
    session: { profilePath: string; expectedRuntimeKind: string },
    authority: OwnedRuntimeRecoveryAuthority
  ): void {
    const left = process.platform === "win32"
      ? resolve(session.profilePath).toLowerCase()
      : resolve(session.profilePath);
    const right = process.platform === "win32"
      ? resolve(authority.profilePath).toLowerCase()
      : resolve(authority.profilePath);
    if (left !== right || session.expectedRuntimeKind !== authority.runtimeKind) {
      throw new ObserverError(
        "SESSION_MISMATCH",
        "Owned runtime receipt does not match the recovered observer session profile and kind",
        409
      );
    }
  }

  private ownedRuntimePinOwner(runtimeId: string): string {
    return `owned-runtime:${runtimeId}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse, maxBodyBytes: number): Promise<void> {
    const remote = request.socket.remoteAddress;
    if (remote && remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      throw new ObserverError("UNAUTHORIZED", "Observer agent accepts loopback clients only", 403);
    }
    if (!request.url || request.url.length > 2048) throw new ObserverError("INVALID_REQUEST", "Request URL is invalid", 414);
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      json(response, 200, { protocolVersion: PROTOCOL_VERSION, agentVersion: AGENT_VERSION, agentInstanceId: this.agentInstanceId, healthy: true });
      return;
    }
    if (url.pathname.startsWith("/v1/control/")) {
      await this.handleControl(request, response, url, maxBodyBytes);
      return;
    }
    if (request.method !== "POST") throw new ObserverError("INVALID_REQUEST", "Unexpected observer method", 405);
    const body = await readJson(request, maxBodyBytes);
    const token = runtimeCredential(request, body);
    if (url.pathname === "/v1/runtime/register") {
      const record = this.runtime.register(body, token);
      json(response, 200, { accepted: true, instanceId: record.registration.instanceId, heartbeatIntervalMs: 5_000, staleAfterMs: this.registry.staleAfterMs });
    } else if (url.pathname === "/v1/runtime/heartbeat") {
      const record = this.runtime.heartbeat(body, token);
      json(response, 200, { accepted: true, sequence: record.lastHeartbeatSequence });
    } else if (url.pathname === "/v1/runtime/commands") {
      const sessionId = String(body.sessionId ?? "");
      const instanceId = String(body.instanceId ?? "");
      const instanceNonce = String(body.instanceNonce ?? "");
      const command = this.runtime.nextCommand(sessionId, instanceId, instanceNonce, token);
      json(response, 200, { command });
    } else if (url.pathname === "/v1/runtime/status") {
      const record = this.runtime.updateJob(body, token);
      json(response, 200, { accepted: true, jobId: record.request.jobId, state: record.state, sequence: record.statusSequence });
    } else if (url.pathname === "/v1/runtime/artifact") {
      const artifact = await this.runtime.announceArtifact(body, token);
      json(response, 200, { accepted: true, artifact });
    } else {
      throw new ObserverError("INVALID_REQUEST", "Observer runtime endpoint was not found", 404);
    }
  }

  private async handleControl(request: IncomingMessage, response: ServerResponse, url: URL, maxBodyBytes: number): Promise<void> {
    if (!this.options.enableControlHttp) throw new ObserverError("UNAUTHORIZED", "Loopback control HTTP is disabled", 403);
    const token = bearer(request);
    if (!token || !constantTimeToken(token, this.control.controlToken)) throw new ObserverError("UNAUTHORIZED", "Control credential is invalid", 401);
    const operations = this.controlOperations;
    if (!operations) throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer control operations are unavailable", 503);
    if (request.method === "GET" && url.pathname === "/v1/control/status") {
      json(response, 200, await operations.execute("status", {}));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/control/instances") {
      json(response, 200, await operations.execute("instances", {}));
      return;
    }
    if (request.method !== "POST") throw new ObserverError("INVALID_REQUEST", "Unexpected control method", 405);
    const body = await readJson(request, maxBodyBytes);
    const routes: Readonly<Record<string, ObserverApplicationOperationName>> = {
      "/v1/control/stage": "stage",
      "/v1/control/prepare-launch": "prepareLaunch",
      "/v1/control/revoke": "revoke",
      "/v1/control/jobs": "submitJob",
      "/v1/control/cancel": "cancelJob",
    };
    const operation = routes[url.pathname];
    if (!operation) throw new ObserverError("INVALID_REQUEST", "Observer control endpoint was not found", 404);
    json(response, 200, await operations.execute(operation, body));
  }
}
