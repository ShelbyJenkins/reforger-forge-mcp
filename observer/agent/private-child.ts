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

function optionValues(argumentsArray: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argumentsArray.length; index += 1) {
    if (argumentsArray[index] === name && argumentsArray[index + 1] !== undefined) values.push(argumentsArray[index + 1]);
  }
  return values;
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

function requiredUuid(payload: Record<string, unknown>, name: string): string {
  const value = requiredString(payload, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ObserverError("INVALID_REQUEST", `${name} must be a version-4 UUID`);
  }
  return value.toLowerCase();
}

function requiredRuntimeId(payload: Record<string, unknown>, name = "runtimeId"): string {
  const value = requiredString(payload, name);
  if (!/^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ObserverError("INVALID_REQUEST", `${name} must be an owned runtime ID`);
  }
  return value.toLowerCase();
}

function requiredLifecycleGeneration(payload: Record<string, unknown>): string {
  const value = requiredString(payload, "generation");
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ObserverError("INVALID_REQUEST", "generation must be a SHA-256 lifecycle identity");
  }
  return value;
}

function requiredLifecycleAuthority(payload: Record<string, unknown>): Record<string, unknown> {
  const authority = objectPayload(payload.authority);
  const positiveInteger = (name: string): number => {
    const value = authority[name];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new ObserverError("INVALID_REQUEST", `authority.${name} must be a positive integer`);
    }
    return value as number;
  };
  const runtimeKind = requiredString(authority, "runtimeKind");
  if (!["client", "listenServer", "dedicated", "testRunner"].includes(runtimeKind)) {
    throw new ObserverError("INVALID_REQUEST", "authority.runtimeKind is invalid");
  }
  return {
    preparedLaunchId: requiredString(authority, "preparedLaunchId"),
    profilePath: requiredString(authority, "profilePath"),
    runtimeKind,
    pid: positiveInteger("pid"),
    executablePath: requiredString(authority, "executablePath"),
    creationTimeFileTime: requiredString(authority, "creationTimeFileTime"),
    ownerTokenArgument: requiredString(authority, "ownerTokenArgument"),
    launchedAtMs: positiveInteger("launchedAtMs"),
  };
}

/** Serialized caller-proposed lease CAS used by the private child and tests. */
export function claimRuntimeStopReservation(
  reservations: Map<string, string>,
  sessionId: string,
  proposedReservationId: string
): { reserved: boolean; reservationId?: string; created: boolean } {
  const current = reservations.get(sessionId);
  if (current) {
    return current === proposedReservationId
      ? { reserved: true, reservationId: current, created: false }
      : { reserved: false, created: false };
  }
  reservations.set(sessionId, proposedReservationId);
  return { reserved: true, reservationId: proposedReservationId, created: true };
}

/** Exact-generation release; a delayed foreign release cannot reopen capture. */
export function releaseRuntimeStopReservation(
  reservations: Map<string, string>,
  sessionId: string,
  reservationId: string
): boolean {
  if (reservations.get(sessionId) !== reservationId) return false;
  reservations.delete(sessionId);
  return true;
}

export function runtimeStopObligations(
  jobs: ReadonlyArray<Record<string, unknown>>,
  instances: ReadonlyArray<Record<string, unknown>>,
  authoritativeObligationJobIds: ReadonlySet<string>
): {
  activeJobIds: string[];
  cameraLeaseJobIds: string[];
  restorationPendingJobIds: string[];
} {
  const jobId = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  const instanceObligations = (field: "activeJobId" | "cameraLeaseJobId"): string[] =>
    instances.map((instance) => jobId(instance[field]))
      .filter((value): value is string => value !== null && authoritativeObligationJobIds.has(value));
  const activeJobIds = [...new Set([
    ...jobs.filter((job) => typeof job.state !== "string" || !TERMINAL_STATES.has(job.state))
      .map((job) => jobId(job.jobId))
      .filter((value): value is string => value !== null),
    ...instanceObligations("activeJobId"),
  ])];
  const cameraLeaseJobIds = [...new Set([
    ...jobs.filter((job) => {
      const lease = job.cameraLease && typeof job.cameraLease === "object"
        ? job.cameraLease as Record<string, unknown>
        : null;
      return lease?.held === true;
    }).map((job) => jobId(job.jobId))
      .filter((value): value is string => value !== null),
    ...instanceObligations("cameraLeaseJobId"),
  ])];
  const restorationPendingJobIds = jobs.filter((job) => {
    const lease = job.cameraLease && typeof job.cameraLease === "object"
      ? job.cameraLease as Record<string, unknown>
      : null;
    return lease?.everHeld === true && lease.restorationConfirmed !== true &&
      lease.vacancyDisposition !== "exact_runtime_vacant";
  }).map((job) => jobId(job.jobId))
    .filter((value): value is string => value !== null);
  return { activeJobIds, cameraLeaseJobIds, restorationPendingJobIds };
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
    evidenceRoots: optionValues(argumentsArray, "--evidence-root"),
    supportingLogRoots: optionValues(argumentsArray, "--supporting-log-root"),
    host: "127.0.0.1",
    port: 0,
    enableControlHttp: false,
    retentionIntervalMs: boundedIntegerOption(argumentsArray, "--retention-interval-ms", 1_000, 24 * 60 * 60_000),
    retentionMaxAgeMs: boundedIntegerOption(argumentsArray, "--retention-max-age-ms", 1_000, 5 * 365 * 24 * 60 * 60_000),
    retentionMaxBytes: boundedIntegerOption(argumentsArray, "--retention-max-bytes", 1_024 * 1_024, 64 * 1024 * 1024 * 1024),
    sweepIntervalMs: boundedIntegerOption(argumentsArray, "--sweep-interval-ms", 100, 60_000),
    sessionStore: {
      terminalRetentionMs: boundedIntegerOption(
        argumentsArray,
        "--session-terminal-retention-ms",
        0,
        24 * 60 * 60_000
      ),
    },
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
        managedStorage: agent.server.managedStorageDiagnostics(),
      };
    }
    if (name === "stage") return agent.control.ensureStaged();
    if (name === "prepareLaunch") return agent.control.prepareLaunch(payload as never);
    if (name === "revoke") {
      return { revoked: agent.control.revokeSession(requiredString(payload, "sessionId")) };
    }
    if (name === "instances") return { instances: agent.registry.diagnostics() };
    if (name === "runtimeLifecycleRetain") {
      return agent.server.retainOwnedRuntimeLifecycle(
        requiredString(payload, "sessionId"),
        requiredRuntimeId(payload),
        requiredLifecycleGeneration(payload),
        requiredLifecycleAuthority(payload) as never
      );
    }
    if (name === "runtimeLifecycleRelease") {
      return agent.server.releaseOwnedRuntimeLifecycle(
        requiredString(payload, "sessionId"),
        requiredRuntimeId(payload),
        requiredLifecycleGeneration(payload)
      );
    }
    if (name === "runtimeStopPreflight") {
      const sessionId = requiredString(payload, "sessionId");
      const runtimeId = requiredRuntimeId(payload);
      const generation = requiredLifecycleGeneration(payload);
      const proposedReservationId = requiredUuid(payload, "reservationId");
      if (payload.exactRuntimeVacant !== undefined &&
          typeof payload.exactRuntimeVacant !== "boolean") {
        throw new ObserverError("INVALID_REQUEST", "exactRuntimeVacant must be boolean");
      }
      const exactRuntimeVacant = payload.exactRuntimeVacant === true;
      const existingReservationId = agent.server.ownedRuntimeStopReservation(
        sessionId,
        runtimeId,
        generation
      );
      if (existingReservationId) {
        const claim = agent.server.claimOwnedRuntimeStopReservation(
          sessionId,
          runtimeId,
          generation,
          proposedReservationId
        );
        return {
          sessionKnown: true,
          ready: true,
          reserved: claim.reserved,
          activeJobIds: [],
          cameraLeaseJobIds: [],
          restorationPendingJobIds: [],
          ...(claim.reservationId ? { reservationId: claim.reservationId } : {}),
          ...(!claim.reserved ? { reason: "runtime_stop_reserved" } : {}),
        };
      }
      const sessionKnown = agent.control.sessions.diagnostics().some((session) =>
        session.sessionId === sessionId
      );
      const jobs = agent.jobs.diagnostics(sessionId);
      const instances = agent.registry.diagnostics().filter((instance) =>
        instance.sessionId === sessionId
      );
      const {
        activeJobIds,
        cameraLeaseJobIds,
        restorationPendingJobIds,
      } = runtimeStopObligations(jobs, instances, agent.jobs.obligationJobIds());
      const ready = sessionKnown && (exactRuntimeVacant || (
        activeJobIds.length === 0 && cameraLeaseJobIds.length === 0 &&
        restorationPendingJobIds.length === 0
      ));
      let claim: ReturnType<typeof claimRuntimeStopReservation> | null = null;
      if (ready) {
        claim = agent.server.claimOwnedRuntimeStopReservation(
          sessionId,
          runtimeId,
          generation,
          proposedReservationId
        );
      }
      return {
        sessionKnown,
        ready,
        reserved: claim?.reserved === true,
        activeJobIds,
        cameraLeaseJobIds,
        restorationPendingJobIds,
        ...(claim?.reservationId ? { reservationId: claim.reservationId } : {}),
        ...(!sessionKnown ? { reason: "observer_session_unknown" } : {}),
      };
    }
    if (name === "runtimeStopRelease") {
      const sessionId = requiredString(payload, "sessionId");
      const runtimeId = requiredRuntimeId(payload);
      const generation = requiredLifecycleGeneration(payload);
      const reservationId = requiredUuid(payload, "reservationId");
      const released = agent.server.releaseOwnedRuntimeStopReservation(
        sessionId,
        runtimeId,
        generation,
        reservationId
      );
      return {
        released,
      };
    }
    if (name === "runtimeStopComplete") {
      const sessionId = requiredString(payload, "sessionId");
      const runtimeId = requiredRuntimeId(payload);
      const generation = requiredLifecycleGeneration(payload);
      if (payload.exactRuntimeVacant !== undefined &&
          typeof payload.exactRuntimeVacant !== "boolean") {
        throw new ObserverError("INVALID_REQUEST", "exactRuntimeVacant must be boolean");
      }
      const exactRuntimeVacant = payload.exactRuntimeVacant === true;
      const reservationId = typeof payload.reservationId === "string"
        ? requiredUuid(payload, "reservationId")
        : null;
      const currentReservationId = agent.server.ownedRuntimeStopReservation(
        sessionId,
        runtimeId,
        generation
      );
      if (currentReservationId && currentReservationId !== reservationId) {
        throw new ObserverError(
          "SESSION_MISMATCH",
          "Observer runtime stop completion reservation is stale",
          409
        );
      }
      // Validate the exact lifecycle generation before mutating jobs,
      // instances, or session state. An absent pin is an idempotent legacy or
      // natural-exit completion; a mismatched live pin is always refused.
      agent.server.assertOwnedRuntimeLifecycle(sessionId, runtimeId, generation);
      const vacancyDisposedJobIds = exactRuntimeVacant
        ? agent.jobs.vacateSession(sessionId)
        : [];
      const vacancyRemovedInstances = exactRuntimeVacant
        ? agent.registry.vacateSession(sessionId)
        : 0;
      const revoked = agent.control.revokeSession(sessionId);
      const lifecycle = agent.server.releaseOwnedRuntimeLifecycle(
        sessionId,
        runtimeId,
        generation
      );
      return {
        completed: true,
        revoked,
        lifecycleReleased: lifecycle.released,
        vacancyDisposedJobIds,
        vacancyRemovedInstances,
      };
    }
    if (name === "submitJob") {
      const sessionId = requiredString(payload, "sessionId");
      if (agent.server.hasOwnedRuntimeStopReservation(sessionId)) {
        throw new ObserverError(
          "CAMERA_BUSY",
          "Observer runtime stop has sealed this session against new capture jobs",
          409
        );
      }
      return serializeJob(agent.jobs.submit(payload as never));
    }
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
          `Validated PNG is ${artifact.image.length} bytes; finalize its managed run instead of reading it above the ${maxBytes}-byte inline limit`,
          413
        );
      }
      return { imageBase64: artifact.image.toString("base64"), metadata: artifact.metadata };
    }
    if (name === "readWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      const maxBytes = payload.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) {
        throw new ObserverError("INVALID_REQUEST", "maxBytes must be a positive integer");
      }
      const ref = agent.artifacts.workbenchRef(jobId);
      const artifact = agent.artifacts.readRef(ref);
      if (artifact.image.length > (maxBytes as number)) {
        throw new ObserverError(
          "ARTIFACT_TOO_LARGE",
          `Validated PNG is ${artifact.image.length} bytes; finalize its managed run instead of reading it inline`,
          413
        );
      }
      return { imageBase64: artifact.image.toString("base64"), metadata: artifact.metadata };
    }
    if (name === "inspectWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      try {
        const artifact = agent.artifacts.readRef(agent.artifacts.workbenchRef(jobId));
        return { available: true, metadata: artifact.metadata };
      } catch (error) {
        if (error instanceof ObserverError && error.code === "ARTIFACT_INCOMPLETE") {
          return { available: false };
        }
        throw error;
      }
    }
    if (name === "importWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      const image = payload.image;
      if (!Buffer.isBuffer(image) || image.length < 1 || image.length > 64 * 1024 * 1024) {
        throw new ObserverError("ARTIFACT_TOO_LARGE", "Workbench artifact payload is invalid or exceeds the managed import limit", 413);
      }
      const metadata = objectPayload(payload.metadata);
      const ref = agent.artifacts.importArtifact({ backend: "workbench", jobId, image, metadata });
      if (typeof payload.runId === "string" && typeof payload.captureLabel === "string") {
        agent.runs.attachImportedArtifact(payload.runId, payload.captureLabel, ref);
      }
      return { imported: true, artifact: ref };
    }
    if (name === "runBegin") return agent.runs.begin(payload as never);
    if (name === "runStatus") return agent.runs.status(requiredString(payload, "runId"));
    if (name === "runReserveCapture") return agent.runs.reserveCapture(payload as never);
    if (name === "runBindCapture") return agent.runs.bindCapture(payload as never);
    if (name === "runFailCapture") {
      return agent.runs.failCapture(
        requiredString(payload, "runId"),
        requiredString(payload, "captureLabel"),
        requiredString(payload, "code"),
        requiredString(payload, "message")
      );
    }
    if (name === "runFinalize") return agent.runs.finalize(payload as never);
    if (name === "runDiscard") return agent.runs.discard(requiredString(payload, "runId"));
    if (name === "assertJobReleaseAllowed") {
      const backend = payload.backend;
      if (backend !== "runtime" && backend !== "workbench") throw new ObserverError("INVALID_REQUEST", "Observer backend is invalid");
      agent.runs.assertJobReleaseAllowed(backend, requiredString(payload, "jobId"), typeof payload.sessionId === "string" ? payload.sessionId : undefined);
      return { allowed: true };
    }
    if (name === "releaseWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      agent.runs.assertJobReleaseAllowed("workbench", jobId);
      try {
        return agent.artifacts.releaseRef(agent.artifacts.workbenchRef(jobId));
      } catch (error) {
        if (error instanceof ObserverError && ["INVALID_REQUEST", "ARTIFACT_INCOMPLETE"].includes(error.code)) {
          return { released: false };
        }
        throw error;
      }
    }
    if (name === "releaseJob") {
      const sessionId = requiredString(payload, "sessionId");
      const jobId = requiredString(payload, "jobId");
      agent.runs.assertJobReleaseAllowed("runtime", jobId, sessionId);
      return agent.artifacts.release(sessionId, jobId);
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
