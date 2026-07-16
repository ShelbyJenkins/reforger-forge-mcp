import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_LIMITS, TRANSPORTS, type ObserverTransport, type SessionContract } from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import { mergeLaunchArguments } from "./launch-arguments.js";
import {
  assertManagedPath,
  canonicalizeExistingDirectory,
  createObserverPaths,
  ensureCanonicalDirectory,
  isPathContained,
  type ObserverManagedPaths,
} from "./paths.js";
import { SessionStore, type AgentLeaseProbeResult, type Clock, systemClock } from "./sessions.js";
import { StagingManager, verifySourceBundle } from "./staging.js";

const prepareLaunchSchema = z.object({
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  arguments: z.array(z.string().max(32_768)).max(512),
  profilePath: z.string().min(1).max(32_768),
  sessionTtlMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).default(20 * 60 * 1000),
  transportPreference: z.array(z.enum(TRANSPORTS)).min(1).max(2).default(["rest", "mailbox"]),
  forceUpdate: z.boolean().default(false),
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
  return process.platform === "win32" ? path.toLowerCase() : path;
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
  private readonly prepared = new Map<string, { fingerprint: string; result: PreparedLaunch }>();

  constructor(options: ObserverControlOptions = {}) {
    this.paths = createObserverPaths(options.root);
    this.agentInstanceId = options.agentInstanceId ?? `agent-${randomBytes(16).toString("hex")}`;
    this.recoveryProbe = options.recoveryProbe ?? probeAgentLease;
    this.profileRoot = ensureCanonicalDirectory(options.profileRoot ?? this.paths.profiles);
    const packageRoot = options.sourceDirectory ? null : packageRootFromModule();
    const source = options.sourceDirectory ?? join(packageRoot!, "observer", "addon");
    this.sessions = new SessionStore(options.clock ?? systemClock);
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
      throw new ObserverError("PROFILE_CONFLICT", "Observer profile must be beneath the approved profile root");
    }
    assertManagedPath(root, lexical);
    const canonical = ensureCanonicalDirectory(lexical);
    assertManagedPath(root, canonical);
    return canonical;
  }

  async prepareLaunch(input: PrepareLaunchRequest): Promise<PreparedLaunch> {
    if (!this.endpoint) throw new ObserverError("TRANSPORT_UNAVAILABLE", "Observer agent endpoint is not listening", 503);
    const request = prepareLaunchSchema.parse(input);
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    if (request.idempotencyKey) {
      const existing = this.prepared.get(request.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ObserverError("ARGUMENT_CONFLICT", "Launch idempotency key was reused with different input", 409);
        return existing.result;
      }
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
    if (request.idempotencyKey) this.prepared.set(request.idempotencyKey, { fingerprint, result });
    return result;
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
      promises: {
        launchesProcesses: false,
        signalsProcesses: false,
        mutatesWorkbenchHandlers: false,
      },
    };
  }
}
