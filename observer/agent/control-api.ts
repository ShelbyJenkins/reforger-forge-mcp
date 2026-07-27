import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boundedOption } from "#foundation/bounded-option";
import { DEFAULT_LIMITS, TRANSPORTS, type ObserverTransport, type SessionContract } from "../protocol/index.js";
import { ObserverError, observerOptionError } from "./errors.js";
import { mergeLaunchArguments } from "./launch-arguments.js";
import {
  assertManagedPath,
  canonicalizeExistingDirectory,
  createObserverPaths,
  ensureCanonicalDirectory,
  isPathContained,
  type ObserverManagedPaths,
} from "./paths.js";
import {
  SESSION_TOMBSTONE_RETENTION_MS,
  SessionStore,
  type AgentLeaseProbeResult,
  type Clock,
  type SessionStoreOptions,
  systemClock,
} from "./sessions.js";
import { StagingManager, verifySourceBundle } from "./staging.js";

// The public MCP tool accepts at most 512 caller tokens. The host prepends one
// `-addonsDir <configured roots>` pair before this private API normalizes the
// launch, while the persisted prepared descriptor already allows the resulting
// 520-token normalized maximum.
const MAX_PREPARE_LAUNCH_ARGUMENTS = 512 + 2;

const prepareLaunchSchema = z.object({
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  arguments: z.array(z.string().max(32_768)).max(MAX_PREPARE_LAUNCH_ARGUMENTS),
  profilePath: z.string().min(1).max(32_768),
  sessionTtlMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).default(20 * 60 * 1000),
  transportPreference: z.array(z.enum(TRANSPORTS)).min(1).max(2).default(["rest", "mailbox"]),
  forceUpdate: z.boolean().default(true),
  noFocus: z.boolean().default(true),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export type PrepareLaunchRequest = z.input<typeof prepareLaunchSchema>;

export interface PreparedLaunch {
  arguments: string[];
  session: {
    sessionId: string;
    launchNonce: string;
    expiresAt: string;
    bundleDigest: string;
    profilePath: string;
    contractPath: string;
  };
  stagedAddon: {
    addonDirectory: string;
    addonSearchRoot: string;
    reused: boolean;
  };
}

export interface ObserverControlOptions {
  root?: string;
  profileRoot?: string;
  sourceDirectory?: string;
  clock?: Clock;
  agentInstanceId?: string;
  recoveryProbe?: (contract: SessionContract) => Promise<AgentLeaseProbeResult>;
  sessionStore?: SessionStoreOptions;
  preparedReceiptRetentionMs?: number;
  preparedMaxRecords?: number;
  preparedMaxEstimatedBytes?: number;
}

function packageRootFromModule(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let count = 0; count < 8; count += 1) {
    const candidate = join(current, "observer", "addon");
    try {
      verifySourceBundle(candidate);
      return current;
    } catch {
      current = dirname(current);
    }
  }
  throw new ObserverError("ADDON_STAGE_FAILED", "Could not locate the packaged observer addon source");
}

function comparisonPath(path: string): string {
  return path.toLowerCase();
}

export async function probeAgentLease(contract: SessionContract): Promise<AgentLeaseProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  timeout.unref();
  try {
    const host = contract.agent.host === "::1" ? "[::1]" : contract.agent.host;
    const response = await fetch(`http://${host}:${contract.agent.port}/v1/health`, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) return "unverifiable";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > 16 * 1024) {
        await reader.cancel();
        return "unverifiable";
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { agentInstanceId?: unknown; healthy?: unknown };
    if (value.healthy !== true || typeof value.agentInstanceId !== "string") return "unverifiable";
    return value.agentInstanceId === contract.agent.instanceId ? "same" : "different";
  } catch (error) {
    if (controller.signal.aborted) return "unverifiable";
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    return typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(code)
      ? "absent"
      : "unverifiable";
  } finally {
    clearTimeout(timeout);
  }
}

export class ObserverControlApi {
  readonly paths: ObserverManagedPaths;
  readonly sessions: SessionStore;
  readonly staging: StagingManager;
  readonly controlToken = randomBytes(32).toString("base64url");
  readonly profileRoot: string;
  readonly agentInstanceId: string;
  private endpoint: { host: "127.0.0.1" | "::1"; port: number; instanceId: string } | null = null;
  private readonly recoveryProbe: (contract: SessionContract) => Promise<AgentLeaseProbeResult>;
  private readonly clock: Clock;
  private readonly preparedReceiptRetentionMs: number;
  private readonly preparedMaxRecords: number;
  private readonly preparedMaxEstimatedBytes: number;
  private readonly prepared = new Map<string, {
    fingerprint: string;
    result: PreparedLaunch;
    retainUntil: number;
  }>();

  constructor(options: ObserverControlOptions = {}) {
    this.paths = createObserverPaths(options.root);
    this.clock = options.clock ?? systemClock;
    this.preparedReceiptRetentionMs = boundedOption(
      options.preparedReceiptRetentionMs,
      SESSION_TOMBSTONE_RETENTION_MS,
      0,
      24 * 60 * 60_000,
      "Prepared launch receipt retention",
      observerOptionError
    );
    this.preparedMaxRecords = boundedOption(options.preparedMaxRecords, 1_024, 1, 100_000, "Prepared launch record limit", observerOptionError);
    this.preparedMaxEstimatedBytes = boundedOption(
      options.preparedMaxEstimatedBytes,
      32 * 1024 * 1024,
      1_024,
      1024 * 1024 * 1024,
      "Prepared launch store byte limit",
      observerOptionError
    );
    this.agentInstanceId = options.agentInstanceId ?? `agent-${randomBytes(16).toString("hex")}`;
    this.recoveryProbe = options.recoveryProbe ?? probeAgentLease;
    this.profileRoot = ensureCanonicalDirectory(options.profileRoot ?? this.paths.profiles);
    const packageRoot = options.sourceDirectory ? null : packageRootFromModule();
    const source = options.sourceDirectory ?? join(packageRoot!, "observer", "addon");
    this.sessions = new SessionStore(this.clock, options.sessionStore);
    this.staging = new StagingManager(this.paths.root, source);
  }

  setEndpoint(host: "127.0.0.1" | "::1", port: number, instanceId = this.agentInstanceId): void {
    if (host !== "127.0.0.1" && host !== "::1") throw new ObserverError("INVALID_REQUEST", "Observer agent endpoint must be loopback");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ObserverError("INVALID_REQUEST", "Observer agent endpoint port is invalid");
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(instanceId)) throw new ObserverError("INVALID_REQUEST", "Observer agent instance ID is invalid");
    this.endpoint = { host, port, instanceId };
  }

  clearEndpoint(): void {
    this.endpoint = null;
  }

  ensureStaged() {
    return this.staging.ensureStaged();
  }

  private prepareProfile(requestedPath: string): string {
    const root = canonicalizeExistingDirectory(this.profileRoot, "Approved observer profile root");
    const lexical = resolve(requestedPath);
    if (!isPathContained(comparisonPath(root), comparisonPath(lexical))) {
      throw new ObserverError(
        "PROFILE_CONFLICT",
        `Observer profile must be beneath the approved profile root: ${root}. ` +
          'Call observer_setup with action="doctor" to inspect profileRoot.'
      );
    }
    assertManagedPath(root, lexical);
    const canonical = ensureCanonicalDirectory(lexical);
    assertManagedPath(root, canonical);
    return canonical;
  }

  async prepareLaunch(input: PrepareLaunchRequest): Promise<PreparedLaunch> {
    if (!this.endpoint) throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer agent endpoint is not listening", 503);
    const request = prepareLaunchSchema.parse(input);
    this.sweepPrepared(this.clock.now());
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    if (request.idempotencyKey) {
      const existing = this.prepared.get(request.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ObserverError("ARGUMENT_CONFLICT", "Launch idempotency key was reused with different input", 409);
        return existing.result;
      }
      this.assertPreparedCapacity(Buffer.byteLength(JSON.stringify(request), "utf8") + 4_096);
    }

    const staged = this.staging.ensureStaged();
    const profilePath = this.prepareProfile(request.profilePath);
    await this.sessions.recoverProfileContract(profilePath, this.recoveryProbe);
    const argumentsArray = mergeLaunchArguments({
      arguments: request.arguments,
      profilePath,
      addonSearchRoot: staged.addonSearchRoot,
      stagedAddonPath: staged.addonDirectory,
      forceUpdate: request.forceUpdate,
      noFocus: request.noFocus,
    });
    const created = this.sessions.create({
      bundleDigest: staged.bundleDigest,
      buildIdentity: staged.manifest.buildIdentity,
      expectedRuntimeKind: request.runtimeKind,
      stagedAddonPath: staged.addonDirectory,
      profilePath,
      agent: this.endpoint,
      ttlMs: request.sessionTtlMs,
      transportPreference: request.transportPreference as ObserverTransport[],
      limits: DEFAULT_LIMITS,
    });
    const result: PreparedLaunch = {
      arguments: argumentsArray,
      session: {
        sessionId: created.contract.sessionId,
        launchNonce: created.contract.launchNonce,
        expiresAt: created.contract.expiresAt,
        bundleDigest: created.contract.bundleDigest,
        profilePath,
        contractPath: created.contractPath,
      },
      stagedAddon: {
        addonDirectory: staged.addonDirectory,
        addonSearchRoot: staged.addonSearchRoot,
        reused: staged.reused,
      },
    };
    if (request.idempotencyKey) {
      const entry = {
        fingerprint,
        result,
        retainUntil: Date.parse(created.contract.expiresAt) + this.preparedReceiptRetentionMs,
      };
      try {
        this.assertPreparedCapacity(this.preparedEntryBytes(entry));
      } catch (error) {
        this.sessions.revoke(created.record.sessionId);
        throw error;
      }
      this.prepared.set(request.idempotencyKey, entry);
    }
    return result;
  }

  sweepPrepared(now = this.clock.now(), pinnedSessionIds: ReadonlySet<string> = new Set()): string[] {
    const removed: string[] = [];
    for (const [key, entry] of this.prepared) {
      if (entry.retainUntil > now || pinnedSessionIds.has(entry.result.session.sessionId) || this.sessions.isPinned(entry.result.session.sessionId)) {
        continue;
      }
      this.prepared.delete(key);
      removed.push(key);
    }
    return removed;
  }

  preparedStats(): Record<string, number> {
    return {
      records: this.prepared.size,
      estimatedBytes: [...this.prepared.values()].reduce((total, entry) => total + this.preparedEntryBytes(entry), 0),
      maxRecords: this.preparedMaxRecords,
      maxEstimatedBytes: this.preparedMaxEstimatedBytes,
      receiptRetentionMs: this.preparedReceiptRetentionMs,
    };
  }

  preparedSessionIds(now = this.clock.now()): Set<string> {
    return new Set([...this.prepared.values()]
      .filter((entry) => entry.retainUntil > now)
      .map((entry) => entry.result.session.sessionId));
  }

  revokeSession(sessionId: string): boolean {
    return this.sessions.revoke(sessionId);
  }

  cleanupStaged(bundleDigest: string) {
    return this.staging.cleanup(bundleDigest, this.sessions.activeBundleDigests());
  }

  diagnostics(): Record<string, unknown> {
    let sourceManifest: Record<string, unknown>;
    try {
      const verified = verifySourceBundle(this.staging.sourceDirectory);
      sourceManifest = { valid: true, bundleDigest: verified.manifest.bundleDigest, buildIdentity: verified.manifest.buildIdentity, addonVersion: verified.manifest.addonVersion };
    } catch (error) {
      sourceManifest = { valid: false, errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR" };
    }
    return {
      endpoint: this.endpoint,
      observerRoot: this.paths.root,
      profileRoot: this.profileRoot,
      sourceManifest,
      sessions: this.sessions.diagnostics(),
      preparedStore: this.preparedStats(),
      promises: {
        launchesProcesses: false,
        signalsProcesses: false,
        mutatesWorkbenchHandlers: false,
      },
    };
  }

  private assertPreparedCapacity(incomingBytes: number): void {
    const estimatedBytes = [...this.prepared.values()].reduce((total, entry) => total + this.preparedEntryBytes(entry), 0);
    if (this.prepared.size >= this.preparedMaxRecords || estimatedBytes + incomingBytes > this.preparedMaxEstimatedBytes) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Prepared launch receipt store retention budget is exhausted", 503);
    }
  }

  private preparedEntryBytes(entry: { fingerprint: string; result: PreparedLaunch; retainUntil: number }): number {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
  }

}
