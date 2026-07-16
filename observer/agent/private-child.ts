import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SHA256_PATTERN, TERMINAL_JOB_STATES } from "../protocol/index.js";
import { createObserverAgent, type CreateObserverAgentOptions } from "./index.js";
import { errorBody, ObserverError } from "./errors.js";
import type { JobRecord } from "./jobs.js";

const CHILD_PROTOCOL = "rfo-observer-child-v1" as const;
const TERMINAL_STATES = new Set<string>(TERMINAL_JOB_STATES);

interface ChildRequest {
  protocol: typeof CHILD_PROTOCOL;
  type: "request";
  requestId: string;
  operation: string;
  payload?: unknown;
}

function option(argumentsArray: string[], name: string): string | undefined {
  const index = argumentsArray.indexOf(name);
  return index >= 0 ? argumentsArray[index + 1] : undefined;
}

function boundedIntegerOption(argumentsArray: string[], name: string, minimum: number, maximum: number): number | undefined {
  const value = option(argumentsArray, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ObserverError("INVALID_REQUEST", `${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function objectPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObserverError("INVALID_REQUEST", "Private observer operation requires an object payload");
  }
  return value as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length < 1 || value.length > 32_768) {
    throw new ObserverError("INVALID_REQUEST", `${name} is required`);
  }
  return value;
}

function serializeJob(record: JobRecord): Record<string, unknown> {
  return {
    jobId: record.request.jobId,
    sessionId: record.sessionId,
    instanceId: record.selectedInstanceId,
    state: record.state,
    worldId: record.worldId,
    worldEpoch: record.worldEpoch,
    view: record.request.view,
    settleFrames: record.request.settleFrames,
    performancePolicy: record.request.performancePolicy,
    deadlineAt: record.request.deadlineAt,
    cancellationRequested: record.cancellationRequestedAt !== null,
    cameraLease: { ...record.cameraLease },
    terminalErrorCode: record.terminalErrorCode,
    terminalMessage: record.terminalMessage,
    artifact: record.artifact
      ? {
          artifactId: record.artifact.artifactId,
          screenshotIssuedAt: record.artifact.screenshotIssuedAt,
          completedAt: record.artifact.completedAt,
          actualCamera: record.artifact.actualCamera,
          actualFov: record.artifact.actualFov,
          contaminated: record.artifact.contaminated,
          warnings: record.artifact.warnings,
          retained: record.artifactPath !== null && existsSync(record.artifactPath),
        }
      : null,
  };
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new ObserverError("TRANSPORT_UNAVAILABLE", "Private observer parent channel is closed", 503));
      return;
    }
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

export function uninstallManagedObserver(agent: ReturnType<typeof createObserverAgent>): Record<string, unknown> {
  const jobs = agent.jobs.diagnostics();
  for (const job of jobs) {
    if (typeof job.sessionId !== "string" || typeof job.jobId !== "string" ||
        (typeof job.state === "string" && TERMINAL_STATES.has(job.state))) continue;
    try { agent.jobs.cancel(job.sessionId, job.jobId); } catch { /* bounded best effort before revocation */ }
  }
  const nonterminal = agent.jobs.diagnostics().filter((job) =>
    typeof job.state !== "string" || !TERMINAL_STATES.has(job.state)
  );
  if (nonterminal.length > 0) {
    throw new ObserverError(
      "CAMERA_BUSY",
      `Managed uninstall requested cancellation but ${nonterminal.length} observer job(s) still require terminal restoration; sessions and staged addons were preserved`,
      409
    );
  }
  const busyInstances = agent.registry.diagnostics().filter((instance) =>
    instance.activeJobId !== null || instance.cameraLeaseJobId !== null
  );
  if (busyInstances.length > 0) {
    throw new ObserverError(
      "CAMERA_BUSY",
      `Managed uninstall found ${busyInstances.length} runtime instance(s) still reporting observer activity; sessions and staged addons were preserved`,
      409
    );
  }
  const sessions = agent.control.sessions.diagnostics();
  const activeSessions = agent.control.sessions.activeRecords();
  for (const session of activeSessions) agent.control.revokeSession(session.sessionId);
  const digests = new Set(
    sessions.map((session) => session.bundleDigest).filter((digest) => SHA256_PATTERN.test(digest))
  );
  for (const entry of readdirSync(agent.control.paths.addons, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && SHA256_PATTERN.test(entry.name)) digests.add(entry.name);
  }
  const cleanup = [...digests].sort().map((bundleDigest) => {
    try {
      return { bundleDigest, ...agent.control.cleanupStaged(bundleDigest) };
    } catch (error) {
      const failure = errorBody(error).error;
      return { bundleDigest, kind: "preserved", errorCode: failure.code, message: failure.message };
    }
  });
  return { revokedSessions: activeSessions.length, cleanup };
}

export async function runPrivateObserverChild(argumentsArray: string[]): Promise<void> {
  if (!process.send || !process.connected) {
    throw new ObserverError("TRANSPORT_UNAVAILABLE", "Private observer agent requires an inherited Node IPC channel", 503);
  }

  const options: CreateObserverAgentOptions = {
    root: option(argumentsArray, "--root"),
    profileRoot: option(argumentsArray, "--profile-root"),
    sourceDirectory: option(argumentsArray, "--source-addon"),
    host: "127.0.0.1",
    port: 0,
    enableControlHttp: false,
    retentionIntervalMs: boundedIntegerOption(argumentsArray, "--retention-interval-ms", 1_000, 24 * 60 * 60_000),
    retentionMaxAgeMs: boundedIntegerOption(argumentsArray, "--retention-max-age-ms", 1_000, 5 * 365 * 24 * 60 * 60_000),
    retentionMaxBytes: boundedIntegerOption(argumentsArray, "--retention-max-bytes", 1_024 * 1_024, 64 * 1024 * 1024 * 1024),
  };
  const agent = createObserverAgent(options);
  const descriptor = await agent.server.start();
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await agent.server.close().catch(() => undefined);
    if (process.connected) process.disconnect();
  };

  const operation = async (name: string, payloadInput: unknown): Promise<unknown> => {
    const payload = payloadInput === undefined ? {} : objectPayload(payloadInput);
    if (name === "status" || name === "doctor") {
      const diagnostics = agent.control.diagnostics();
      const sessions = agent.control.sessions.diagnostics().map(({
        launchNonce: _launchNonce,
        registeredInstanceNonce: _instanceNonce,
        ...session
      }) => session);
      return {
        ...diagnostics,
        sessions,
        agentInstanceId: descriptor.agentInstanceId,
        agentVersion: descriptor.agentVersion,
        protocolVersion: descriptor.protocolVersion,
        instances: agent.registry.diagnostics(),
        jobs: agent.jobs.diagnostics().map(({ artifactPath: _path, ...job }) => job),
      };
    }
    if (name === "stage") return agent.control.ensureStaged();
    if (name === "prepareLaunch") return agent.control.prepareLaunch(payload as never);
    if (name === "revoke") {
      return { revoked: agent.control.revokeSession(requiredString(payload, "sessionId")) };
    }
    if (name === "instances") return { instances: agent.registry.diagnostics() };
    if (name === "submitJob") return serializeJob(agent.jobs.submit(payload as never));
    if (name === "jobStatus") {
      return serializeJob(agent.jobs.require(requiredString(payload, "sessionId"), requiredString(payload, "jobId")));
    }
    if (name === "cancelJob") {
      return serializeJob(agent.jobs.cancel(requiredString(payload, "sessionId"), requiredString(payload, "jobId")));
    }
    if (name === "readArtifact") {
      const sessionId = requiredString(payload, "sessionId");
      const jobId = requiredString(payload, "jobId");
      const maxBytes = payload.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) {
        throw new ObserverError("INVALID_REQUEST", "maxBytes must be a positive integer");
      }
      const artifact = agent.artifacts.read(sessionId, jobId);
      if (artifact.image.length > (maxBytes as number)) {
        throw new ObserverError(
          "ARTIFACT_TOO_LARGE",
          `Validated PNG is ${artifact.image.length} bytes; the MCP inline limit is ${maxBytes} bytes`,
          413
        );
      }
      return { imageBase64: artifact.image.toString("base64"), metadata: artifact.metadata };
    }
    if (name === "releaseJob") {
      return agent.artifacts.release(requiredString(payload, "sessionId"), requiredString(payload, "jobId"));
    }
    if (name === "uninstall") return uninstallManagedObserver(agent);
    if (name === "shutdown") return { stopping: true };
    throw new ObserverError("INVALID_REQUEST", `Unknown private observer operation: ${name}`, 404);
  };

  let requestQueue = Promise.resolve();
  process.on("message", (value: unknown) => {
    requestQueue = requestQueue.then(async () => {
      if (!value || typeof value !== "object") return;
      const request = value as Partial<ChildRequest>;
      if (request.protocol !== CHILD_PROTOCOL || request.type !== "request" ||
          typeof request.requestId !== "string" || request.requestId.length > 96 ||
          typeof request.operation !== "string" || request.operation.length > 64) return;
      try {
        const result = await operation(request.operation, request.payload);
        await send({ protocol: CHILD_PROTOCOL, type: "response", requestId: request.requestId, ok: true, result });
      } catch (error) {
        await send({
          protocol: CHILD_PROTOCOL,
          type: "response",
          requestId: request.requestId,
          ok: false,
          error: errorBody(error).error,
        }).catch(() => undefined);
      }
      if (request.operation === "shutdown") await close();
    }).catch(() => undefined);
  });

  process.once("disconnect", () => void close());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await send({
    protocol: CHILD_PROTOCOL,
    type: "ready",
    childInstanceId: randomUUID(),
    descriptor: {
      protocolVersion: descriptor.protocolVersion,
      agentVersion: descriptor.agentVersion,
      agentInstanceId: descriptor.agentInstanceId,
      host: descriptor.host,
      port: descriptor.port,
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrivateObserverChild(process.argv.slice(2)).catch(async (error) => {
    await send({ protocol: CHILD_PROTOCOL, type: "fatal", error: errorBody(error).error }).catch(() => undefined);
    process.exitCode = 1;
  });
}
