import { existsSync, readdirSync } from "node:fs";
import { SHA256_PATTERN, TERMINAL_JOB_STATES } from "../protocol/index.js";
import type { ObserverApplication } from "./application.js";
import { ObserverError } from "./errors.js";
import { errorBody } from "./errors.js";
import type { JobRecord } from "./jobs.js";

export type ObserverApplicationOperationName =
  | "status" | "doctor" | "stage" | "prepareLaunch" | "revoke" | "instances"
  | "submitJob" | "jobStatus" | "cancelJob" | "readArtifact" | "runBegin"
  | "runStatus" | "runReserveCapture" | "runBindCapture" | "runFailCapture"
  | "runFinalize" | "runDiscard" | "assertJobReleaseAllowed" | "releaseJob"
  | "readWorkbenchArtifact" | "inspectWorkbenchArtifact" | "importWorkbenchArtifact"
  | "releaseWorkbenchArtifact" | "shutdown"
  | "runCompleteCapture" | "uninstall" | "runtimeLifecycleRetain" | "runtimeLifecycleRelease"
  | "runtimeStopPreflight" | "runtimeStopRelease" | "runtimeStopComplete";

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObserverError("INVALID_REQUEST", "Observer operation payload must be an object");
  return value as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length < 1 || value.length > 32_768) throw new ObserverError("INVALID_REQUEST", `${name} is required`);
  return value;
}

const TERMINAL_STATES = new Set<string>(TERMINAL_JOB_STATES);

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

function requiredGeneration(payload: Record<string, unknown>): string {
  const value = requiredString(payload, "generation");
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ObserverError("INVALID_REQUEST", "generation must be a SHA-256 lifecycle identity");
  return value;
}

function requiredAuthority(payload: Record<string, unknown>): Record<string, unknown> {
  const authority = payloadObject(payload.authority);
  const positive = (name: string): number => {
    const value = authority[name];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new ObserverError("INVALID_REQUEST", `authority.${name} must be a positive integer`);
    return value as number;
  };
  const runtimeKind = requiredString(authority, "runtimeKind");
  if (!["client", "listenServer", "dedicated", "testRunner"].includes(runtimeKind)) throw new ObserverError("INVALID_REQUEST", "authority.runtimeKind is invalid");
  return {
    preparedLaunchId: requiredString(authority, "preparedLaunchId"),
    profilePath: requiredString(authority, "profilePath"),
    runtimeKind,
    pid: positive("pid"),
    executablePath: requiredString(authority, "executablePath"),
    creationTimeFileTime: requiredString(authority, "creationTimeFileTime"),
    ownerTokenArgument: requiredString(authority, "ownerTokenArgument"),
    launchedAtMs: positive("launchedAtMs"),
  };
}

/** Serialized caller-proposed lease CAS retained as a separately testable kernel. */
export function claimRuntimeStopReservation(
  reservations: Map<string, string>, sessionId: string, proposedReservationId: string
): { reserved: boolean; reservationId?: string; created: boolean } {
  const current = reservations.get(sessionId);
  if (current) return current === proposedReservationId
    ? { reserved: true, reservationId: current, created: false }
    : { reserved: false, created: false };
  reservations.set(sessionId, proposedReservationId);
  return { reserved: true, reservationId: proposedReservationId, created: true };
}

export function releaseRuntimeStopReservation(reservations: Map<string, string>, sessionId: string, reservationId: string): boolean {
  if (reservations.get(sessionId) !== reservationId) return false;
  reservations.delete(sessionId);
  return true;
}

export function runtimeStopObligations(
  jobs: ReadonlyArray<Record<string, unknown>>,
  instances: ReadonlyArray<Record<string, unknown>>,
  authoritativeObligationJobIds: ReadonlySet<string>
): { activeJobIds: string[]; cameraLeaseJobIds: string[]; restorationPendingJobIds: string[] } {
  const jobId = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
  const instanceObligations = (field: "activeJobId" | "cameraLeaseJobId"): string[] => instances
    .map((instance) => jobId(instance[field]))
    .filter((value): value is string => value !== null && authoritativeObligationJobIds.has(value));
  const activeJobIds = [...new Set([
    ...jobs.filter((job) => typeof job.state !== "string" || !TERMINAL_STATES.has(job.state))
      .map((job) => jobId(job.jobId)).filter((value): value is string => value !== null),
    ...instanceObligations("activeJobId"),
  ])];
  const cameraLeaseJobIds = [...new Set([
    ...jobs.filter((job) => {
      const lease = job.cameraLease && typeof job.cameraLease === "object" ? job.cameraLease as Record<string, unknown> : null;
      return lease?.held === true;
    }).map((job) => jobId(job.jobId)).filter((value): value is string => value !== null),
    ...instanceObligations("cameraLeaseJobId"),
  ])];
  const restorationPendingJobIds = jobs.filter((job) => {
    const lease = job.cameraLease && typeof job.cameraLease === "object" ? job.cameraLease as Record<string, unknown> : null;
    return lease?.everHeld === true && lease.restorationConfirmed !== true && lease.vacancyDisposition !== "exact_runtime_vacant";
  }).map((job) => jobId(job.jobId)).filter((value): value is string => value !== null);
  return { activeJobIds, cameraLeaseJobIds, restorationPendingJobIds };
}

export function uninstallManagedObserver(application: Pick<ObserverApplication, "jobs" | "registry" | "control">): Record<string, unknown> {
  const jobs = application.jobs.diagnostics();
  for (const job of jobs) {
    if (typeof job.sessionId !== "string" || typeof job.jobId !== "string" || (typeof job.state === "string" && TERMINAL_STATES.has(job.state))) continue;
    try { application.jobs.cancel(job.sessionId, job.jobId); } catch { /* bounded best effort */ }
  }
  const nonterminal = application.jobs.diagnostics().filter((job) => typeof job.state !== "string" || !TERMINAL_STATES.has(job.state));
  if (nonterminal.length > 0) throw new ObserverError("CAMERA_BUSY", `Managed uninstall requested cancellation but ${nonterminal.length} observer job(s) still require terminal restoration; sessions and staged addons were preserved`, 409);
  const busy = application.registry.diagnostics().filter((instance) => instance.activeJobId !== null || instance.cameraLeaseJobId !== null);
  if (busy.length > 0) throw new ObserverError("CAMERA_BUSY", `Managed uninstall found ${busy.length} runtime instance(s) still reporting observer activity; sessions and staged addons were preserved`, 409);
  const sessions = application.control.sessions.diagnostics();
  const active = application.control.sessions.activeRecords();
  for (const session of active) application.control.revokeSession(session.sessionId);
  const digests = new Set(sessions.map((session) => session.bundleDigest).filter((digest) => SHA256_PATTERN.test(digest)));
  for (const entry of readdirSync(application.control.paths.addons, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && SHA256_PATTERN.test(entry.name)) digests.add(entry.name);
  }
  const cleanup = [...digests].sort().map((bundleDigest) => {
    try { return { bundleDigest, ...application.control.cleanupStaged(bundleDigest) }; }
    catch (error) {
      const failure = errorBody(error).error;
      return { bundleDigest, kind: "preserved", errorCode: failure.code, message: failure.message };
    }
  });
  return { revokedSessions: active.length, cleanup };
}

/** Remove durable paths and private protocol fields before a transport response. */
export function sanitizeObserverJob(value: Record<string, unknown>): Record<string, unknown> {
  const { artifactPath: _artifactPath, launchNonce: _launchNonce, registeredInstanceNonce: _registeredInstanceNonce, ...safe } = value;
  return safe;
}

function serializeJob(record: JobRecord): Record<string, unknown> {
  return sanitizeObserverJob({
    jobId: record.request.jobId,
    sessionId: record.sessionId,
    instanceId: record.selectedInstanceId,
    state: record.state,
    worldId: record.worldId,
    worldEpoch: record.worldEpoch,
    view: record.request.view,
    settleFrames: record.request.settleFrames,
    performancePolicy: record.request.performancePolicy,
    image: record.request.image,
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
  });
}

/** Shared sanitized domain dispatch used by private IPC and control adapters. */
export class ObserverApplicationOperations {
  constructor(private readonly application: ObserverApplication) {}

  async execute(name: ObserverApplicationOperationName, input: unknown = {}): Promise<unknown> {
    const payload = payloadObject(input);
    const app = this.application;
    if (name === "status" || name === "doctor") {
      const diagnostics = app.control.diagnostics();
      const sessions = app.control.sessions.diagnostics().map(({
        launchNonce: _launchNonce,
        registeredInstanceNonce: _registeredInstanceNonce,
        ...session
      }) => session);
      return {
        ...diagnostics,
        sessions,
        agentInstanceId: app.agentInstanceId,
        instances: app.registry.diagnostics(),
        jobs: app.jobs.diagnostics().map(sanitizeObserverJob),
        managedStorage: app.server.managedStorageDiagnostics(),
        evidence: app.runs.evidenceDiagnostics(),
      };
    }
    if (name === "stage") return app.control.ensureStaged();
    if (name === "prepareLaunch") return app.control.prepareLaunch(payload as never);
    if (name === "revoke") return { revoked: app.control.revokeSession(requiredString(payload, "sessionId")) };
    if (name === "instances") return { instances: app.registry.diagnostics() };
    if (name === "runtimeLifecycleRetain") {
      return app.server.retainOwnedRuntimeLifecycle(
        requiredString(payload, "sessionId"), requiredRuntimeId(payload), requiredGeneration(payload), requiredAuthority(payload) as never
      );
    }
    if (name === "runtimeLifecycleRelease") {
      return app.server.releaseOwnedRuntimeLifecycle(requiredString(payload, "sessionId"), requiredRuntimeId(payload), requiredGeneration(payload));
    }
    if (name === "runtimeStopPreflight") {
      const sessionId = requiredString(payload, "sessionId");
      const runtimeId = requiredRuntimeId(payload);
      const generation = requiredGeneration(payload);
      const proposedReservationId = requiredUuid(payload, "reservationId");
      if (payload.exactRuntimeVacant !== undefined && typeof payload.exactRuntimeVacant !== "boolean") throw new ObserverError("INVALID_REQUEST", "exactRuntimeVacant must be boolean");
      const exactRuntimeVacant = payload.exactRuntimeVacant === true;
      const lifecycleRetained = app.server.assertOwnedRuntimeLifecycle(
        sessionId,
        runtimeId,
        generation
      );
      if (!lifecycleRetained) {
        if (!exactRuntimeVacant) {
          throw new ObserverError(
            "SESSION_MISMATCH",
            "Owned runtime lifecycle reservation lacks exact retained authority",
            409
          );
        }
        app.server.assertReleasedOwnedRuntimeLifecycle(
          sessionId,
          runtimeId,
          generation
        );
        const sessionKnown = app.control.sessions.diagnostics()
          .some((session) => session.sessionId === sessionId);
        const jobs = app.jobs.diagnostics(sessionId);
        const instances = app.registry.diagnostics()
          .filter((instance) => instance.sessionId === sessionId);
        return {
          sessionKnown,
          ready: true,
          reserved: false,
          reservationRequired: false,
          ...runtimeStopObligations(jobs, instances, app.jobs.obligationJobIds()),
          reason: "exact_runtime_vacancy_has_no_retained_lifecycle",
        };
      }
      const existing = app.server.ownedRuntimeStopReservation(sessionId, runtimeId, generation);
      if (existing) {
        const claim = app.server.claimOwnedRuntimeStopReservation(sessionId, runtimeId, generation, proposedReservationId);
        return {
          sessionKnown: true, ready: true, reserved: claim.reserved,
          activeJobIds: [], cameraLeaseJobIds: [], restorationPendingJobIds: [],
          ...(claim.reservationId ? { reservationId: claim.reservationId } : {}),
          ...(!claim.reserved ? { reason: "runtime_stop_reserved" } : {}),
        };
      }
      const sessionKnown = app.control.sessions.diagnostics().some((session) => session.sessionId === sessionId);
      const jobs = app.jobs.diagnostics(sessionId);
      const instances = app.registry.diagnostics().filter((instance) => instance.sessionId === sessionId);
      const obligations = runtimeStopObligations(jobs, instances, app.jobs.obligationJobIds());
      const ready = sessionKnown && (exactRuntimeVacant || (obligations.activeJobIds.length === 0 && obligations.cameraLeaseJobIds.length === 0 && obligations.restorationPendingJobIds.length === 0));
      const claim = ready ? app.server.claimOwnedRuntimeStopReservation(sessionId, runtimeId, generation, proposedReservationId) : null;
      return {
        sessionKnown, ready, reserved: claim?.reserved === true, ...obligations,
        ...(claim?.reservationId ? { reservationId: claim.reservationId } : {}),
        ...(!sessionKnown ? { reason: "observer_session_unknown" } : {}),
      };
    }
    if (name === "runtimeStopRelease") {
      const released = app.server.releaseOwnedRuntimeStopReservation(
        requiredString(payload, "sessionId"), requiredRuntimeId(payload), requiredGeneration(payload), requiredUuid(payload, "reservationId")
      );
      return { released };
    }
    if (name === "runtimeStopComplete") {
      const sessionId = requiredString(payload, "sessionId");
      const runtimeId = requiredRuntimeId(payload);
      const generation = requiredGeneration(payload);
      if (payload.exactRuntimeVacant !== undefined && typeof payload.exactRuntimeVacant !== "boolean") throw new ObserverError("INVALID_REQUEST", "exactRuntimeVacant must be boolean");
      const exactRuntimeVacant = payload.exactRuntimeVacant === true;
      const reservationId = typeof payload.reservationId === "string" ? requiredUuid(payload, "reservationId") : null;
      const lifecycleRetained = exactRuntimeVacant
        ? app.server.recoverOwnedRuntimeLifecycleForStopCompletion(
          sessionId,
          runtimeId,
          generation
        )
        : app.server.assertOwnedRuntimeLifecycle(
          sessionId,
          runtimeId,
          generation
        );
      if (!lifecycleRetained) {
        if (!exactRuntimeVacant) {
          throw new ObserverError(
            "SESSION_MISMATCH",
            "Released runtime lifecycle completion requires exact vacancy",
            409
          );
        }
        app.server.assertReleasedOwnedRuntimeLifecycle(
          sessionId,
          runtimeId,
          generation
        );
      }
      const current = lifecycleRetained
        ? app.server.ownedRuntimeStopReservation(sessionId, runtimeId, generation)
        : null;
      if (current && current !== reservationId) throw new ObserverError("SESSION_MISMATCH", "Observer runtime stop completion reservation is stale", 409);
      const vacancyDisposedJobIds = exactRuntimeVacant ? app.jobs.vacateSession(sessionId) : [];
      const vacancyRemovedInstances = exactRuntimeVacant ? app.registry.vacateSession(sessionId) : 0;
      const revoked = app.control.revokeSession(sessionId);
      const lifecycle = app.server.releaseOwnedRuntimeLifecycle(sessionId, runtimeId, generation);
      return { completed: true, revoked, lifecycleReleased: lifecycle.released, vacancyDisposedJobIds, vacancyRemovedInstances };
    }
    if (name === "submitJob") {
      const sessionId = requiredString(payload, "sessionId");
      if (app.server.hasOwnedRuntimeStopReservation(sessionId)) {
        throw new ObserverError("CAMERA_BUSY", "Observer runtime stop has sealed this session against new capture jobs", 409);
      }
      return serializeJob(app.jobs.submit(payload as never));
    }
    if (name === "jobStatus") return serializeJob(app.jobs.require(requiredString(payload, "sessionId"), requiredString(payload, "jobId")));
    if (name === "cancelJob") return serializeJob(app.jobs.cancel(requiredString(payload, "sessionId"), requiredString(payload, "jobId")));
    if (name === "readArtifact") {
      const sessionId = requiredString(payload, "sessionId");
      const jobId = requiredString(payload, "jobId");
      const maxBytes = payload.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) throw new ObserverError("INVALID_REQUEST", "maxBytes must be a positive integer");
      const artifact = app.artifacts.read(sessionId, jobId);
      if (artifact.image.length > (maxBytes as number)) {
        throw new ObserverError("ARTIFACT_TOO_LARGE", `Validated PNG is ${artifact.image.length} bytes; finalize its managed run instead of reading it above the ${maxBytes}-byte inline limit`, 413);
      }
      return { imageBase64: artifact.image.toString("base64"), metadata: artifact.metadata };
    }
    if (name === "readWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      const maxBytes = payload.maxBytes;
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) <= 0) throw new ObserverError("INVALID_REQUEST", "maxBytes must be a positive integer");
      const artifact = app.artifacts.readRef(app.artifacts.workbenchRef(jobId));
      if (artifact.image.length > (maxBytes as number)) throw new ObserverError("ARTIFACT_TOO_LARGE", "Validated PNG exceeds the requested inline limit", 413);
      return { imageBase64: artifact.image.toString("base64"), metadata: artifact.metadata };
    }
    if (name === "inspectWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      try {
        const artifact = app.artifacts.readRef(app.artifacts.workbenchRef(jobId));
        return { available: true, metadata: artifact.metadata };
      } catch (error) {
        if (error instanceof ObserverError && error.code === "ARTIFACT_INCOMPLETE") return { available: false };
        throw error;
      }
    }
    if (name === "importWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      const image = payload.image;
      if (!Buffer.isBuffer(image) || image.length < 1 || image.length > 64 * 1024 * 1024) throw new ObserverError("ARTIFACT_TOO_LARGE", "Workbench artifact payload is invalid or exceeds the managed import limit", 413);
      const metadata = payloadObject(payload.metadata);
      const ref = app.artifacts.importArtifact({ backend: "workbench", jobId, image, metadata });
      if (typeof payload.runId === "string" && typeof payload.captureLabel === "string") app.runs.attachImportedArtifact(payload.runId, payload.captureLabel, ref);
      return { imported: true, artifact: ref };
    }
    if (name === "runBegin") return app.runs.begin(payload as never);
    if (name === "runStatus") return app.runs.status(requiredString(payload, "runId"));
    if (name === "runReserveCapture") return app.runs.reserveCapture(payload as never);
    if (name === "runBindCapture") return app.runs.bindCapture(payload as never);
    if (name === "runFailCapture") return app.runs.failCapture(requiredString(payload, "runId"), requiredString(payload, "captureLabel"), requiredString(payload, "code"), requiredString(payload, "message"));
    if (name === "runCompleteCapture") {
      const runId = requiredString(payload, "runId");
      const captureLabel = requiredString(payload, "captureLabel");
      const binding = app.runs.captureEvidenceBinding(runId, captureLabel);
      const grant = binding.runtimeLogEvidenceGrant ?? (binding.backend === "runtime" && binding.sessionId
        ? app.server.createRuntimeLogEvidenceGrant(
          binding.runId,
          binding.captureLabel,
          binding.sessionId
        )
        : null);
      return app.runs.completeCapture(runId, captureLabel, grant ?? undefined);
    }
    if (name === "runFinalize") return app.runs.finalize(payload as never);
    if (name === "runDiscard") return app.runs.discard(requiredString(payload, "runId"));
    if (name === "assertJobReleaseAllowed") {
      const backend = payload.backend;
      if (backend !== "runtime" && backend !== "workbench") throw new ObserverError("INVALID_REQUEST", "Observer backend is invalid");
      app.runs.assertJobReleaseAllowed(backend, requiredString(payload, "jobId"), typeof payload.sessionId === "string" ? payload.sessionId : undefined);
      return { allowed: true };
    }
    if (name === "releaseWorkbenchArtifact") {
      const jobId = requiredString(payload, "jobId");
      app.runs.assertJobReleaseAllowed("workbench", jobId);
      try {
        return app.artifacts.releaseRef(app.artifacts.workbenchRef(jobId));
      } catch (error) {
        if (error instanceof ObserverError && ["INVALID_REQUEST", "ARTIFACT_INCOMPLETE"].includes(error.code)) return { released: false, alreadyAbsent: true };
        throw error;
      }
    }
    if (name === "releaseJob") {
      const sessionId = requiredString(payload, "sessionId");
      const jobId = requiredString(payload, "jobId");
      app.runs.assertJobReleaseAllowed("runtime", jobId, sessionId);
      const job = app.jobs.require(sessionId, jobId);
      const terminal = TERMINAL_STATES.has(job.state);
      const restored = job.cameraLease.everHeld !== true || job.cameraLease.restorationConfirmed === true || job.cameraLease.vacancyDisposition === "exact_runtime_vacant";
      if (!terminal || !restored) throw new ObserverError("CAMERA_BUSY", "Runtime artifact release requires terminal state with proven restoration", 409);
      return app.artifacts.release(sessionId, jobId);
    }
    if (name === "uninstall") return uninstallManagedObserver(app);
    if (name === "shutdown") return { stopping: true };
    throw new ObserverError("INVALID_REQUEST", `Unknown observer operation: ${name}`, 404);
  }
}

export function operationErrorBody(error: unknown): Record<string, unknown> {
  return errorBody(error) as unknown as Record<string, unknown>;
}
