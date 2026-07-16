import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { ZodError } from "zod";
import { AGENT_VERSION, DEFAULT_LIMITS, MAX_PROTOCOL_MESSAGE_BYTES, PROTOCOL_VERSION } from "../protocol/index.js";
import { ArtifactStore } from "./artifacts.js";
import { ObserverControlApi } from "./control-api.js";
import { asObserverError, errorBody, ObserverError } from "./errors.js";
import { JobStore } from "./jobs.js";
import { observerLogger } from "./logger.js";
import { MailboxCoordinator } from "./mailbox-coordinator.js";
import { InstanceRegistry } from "./registry.js";
import { ObserverRuntimeApi } from "./runtime-api.js";

export interface ObserverAgentServerOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  enableControlHttp?: boolean;
  maxBodyBytes?: number;
  retentionIntervalMs?: number;
  retentionMaxAgeMs?: number;
  retentionMaxBytes?: number;
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
  private mailboxPollActive = false;
  private lastRetentionAt = 0;

  constructor(
    readonly agentInstanceId: string,
    readonly control: ObserverControlApi,
    readonly registry: InstanceRegistry,
    readonly jobs: JobStore,
    readonly artifacts: ArtifactStore,
    private readonly options: ObserverAgentServerOptions = {}
  ) {
    this.runtime = new ObserverRuntimeApi(control.sessions, registry, jobs, artifacts);
    this.mailbox = new MailboxCoordinator(control.sessions, registry, jobs, artifacts);
  }

  async start(): Promise<StartupDescriptor> {
    if (this.server) return this.descriptor!;
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
    this.sweepTimer = setInterval(() => {
      this.control.sessions.sweepExpired();
      this.jobs.sweepDeadlines();
      const now = Date.now();
      const retentionIntervalMs = this.options.retentionIntervalMs ?? 60_000;
      if (now - this.lastRetentionAt >= retentionIntervalMs) {
        this.lastRetentionAt = now;
        try {
          this.artifacts.applyRetention(
            this.options.retentionMaxAgeMs ?? 7 * 24 * 60 * 60 * 1_000,
            this.options.retentionMaxBytes ?? 512 * 1024 * 1024
          );
        } catch (error) {
          observerLogger.warn("artifact retention sweep failed", {
            errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
          });
        }
      }
      if (!this.mailboxPollActive) {
        this.mailboxPollActive = true;
        void this.mailbox.pollOnce()
          .catch((error) => observerLogger.warn("mailbox poll failed", { errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR" }))
          .finally(() => { this.mailboxPollActive = false; });
      }
    }, 1_000);
    this.sweepTimer.unref();
    return this.descriptor;
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    const server = this.server;
    this.server = null;
    this.descriptor = null;
    this.control.clearEndpoint();
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
    if (request.method === "GET" && url.pathname === "/v1/control/status") {
      json(response, 200, { ...this.control.diagnostics(), instances: this.registry.diagnostics(), jobs: this.jobs.diagnostics() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/control/instances") {
      json(response, 200, { instances: this.registry.diagnostics() });
      return;
    }
    if (request.method !== "POST") throw new ObserverError("INVALID_REQUEST", "Unexpected control method", 405);
    const body = await readJson(request, maxBodyBytes);
    if (url.pathname === "/v1/control/stage") {
      json(response, 200, this.control.ensureStaged());
    } else if (url.pathname === "/v1/control/prepare-launch") {
      json(response, 200, await this.control.prepareLaunch(body as never));
    } else if (url.pathname === "/v1/control/revoke") {
      json(response, 200, { revoked: this.control.revokeSession(String(body.sessionId ?? "")) });
    } else if (url.pathname === "/v1/control/jobs") {
      json(response, 200, this.jobs.submit(body as never));
    } else if (url.pathname === "/v1/control/cancel") {
      json(response, 200, this.jobs.cancel(String(body.sessionId ?? ""), String(body.jobId ?? "")));
    } else {
      throw new ObserverError("INVALID_REQUEST", "Observer control endpoint was not found", 404);
    }
  }
}
