import { existsSync, lstatSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { boundedOption } from "#foundation/bounded-option";
import { BoundedJsonMap, BoundedJsonStore } from "#foundation/json-store";
import { DEFAULT_LIMITS } from "../protocol/index.js";
import { ArtifactStore } from "./artifacts.js";
import { ObserverError, observerOptionError } from "./errors.js";
import { JobStore } from "./jobs.js";
import { observerLogger } from "./logger.js";
import { MailboxTransport, type MailboxCleanupFailure } from "./mailbox.js";
import { assertManagedPath, atomicWriteJson, ensureCanonicalDirectory } from "./paths.js";
import { InstanceRegistry } from "./registry.js";
import { type Clock, SessionStore, systemClock } from "./sessions.js";

type MailboxMessageKind = "registration" | "heartbeat" | "status" | "artifact";

interface RetryRecord {
  attempts: number;
  firstSeenAt: number;
  sessionId: string;
  statusDirectory: string;
  dataName: string;
}

interface CleanupSweep {
  removed: number;
  retainedFailures: number;
  reliable: boolean;
}

interface AggregateCleanupSweep extends CleanupSweep {
  estimatedBytes: number;
}

interface QuarantineInventory {
  files: Array<{ path: string; bytes: number; mtimeMs: number }>;
  reliable: boolean;
}

function parseIngressObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mailbox ingress must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export interface MailboxCoordinatorOptions {
  clock?: Clock;
  maxIngressPerPoll?: number;
  maxRetryAttempts?: number;
  maxRetryAgeMs?: number;
  maxTrackedRetries?: number;
  maxTransports?: number;
  maxEstimatedBytes?: number;
  quarantineMaxRecords?: number;
  quarantineMaxBytes?: number;
  quarantineMaxAgeMs?: number;
  orphanIngressMaxAgeMs?: number;
  removeFile?: (path: string) => void;
}

export interface MailboxSweepResult {
  removedTransportSessionIds: string[];
  removedQuarantineFiles: number;
  removedOrphanIngressFiles: number;
  retainedCleanupFailures: number;
}

export interface MailboxCoordinatorStats {
  transports: number;
  maxTransports: number;
  estimatedBytes: number;
  maxEstimatedBytes: number;
  trackedRetries: number;
  maxTrackedRetries: number;
  accepted: number;
  permanentRejected: number;
  transientRetries: number;
  quarantined: number;
  quarantineDropped: number;
  quarantineFiles: number;
  quarantineBytes: number;
  quarantineMaxRecords: number;
  quarantineMaxBytes: number;
  quarantineMaxAgeMs: number;
  commandFiles: number;
  commandBytes: number;
  commandUsageReliable: boolean;
  orphanIngressRemoved: number;
  cleanupFailures: number;
  lastCleanupFailure: MailboxCleanupFailure | null;
}

export class MailboxCoordinator {
  private readonly transports: BoundedJsonMap<string, MailboxTransport>;
  private readonly rejectionAttempts: BoundedJsonMap<string, RetryRecord>;
  private readonly pollCursors: BoundedJsonMap<string, string>;
  private readonly commandUsageBySession: BoundedJsonMap<string, { files: number; bytes: number }>;
  private quarantineInventoryScope: Map<string, QuarantineInventory> | null = null;
  private readonly clock: Clock;
  private readonly maxIngressPerPoll: number;
  private readonly maxRetryAttempts: number;
  private readonly maxRetryAgeMs: number;
  private readonly maxTrackedRetries: number;
  private readonly maxTransports: number;
  private readonly maxEstimatedBytes: number;
  private readonly quarantineMaxRecords: number;
  private readonly quarantineMaxBytes: number;
  private readonly quarantineMaxAgeMs: number;
  private readonly orphanIngressMaxAgeMs: number;
  private readonly removeFile: (path: string) => void;
  private dispositionSequence = 0;
  private orphanIngressRemoved = 0;
  private cleanupFailures = 0;
  private lastCleanupFailure: MailboxCleanupFailure | null = null;
  private dispositionCounts = {
    accepted: 0,
    permanentRejected: 0,
    transientRetries: 0,
    quarantined: 0,
    quarantineDropped: 0,
  };

  constructor(
    private readonly sessions: SessionStore,
    private readonly registry: InstanceRegistry,
    private readonly jobs: JobStore,
    private readonly artifacts: ArtifactStore,
    options: MailboxCoordinatorOptions = {}
  ) {
    this.clock = options.clock ?? systemClock;
    this.maxIngressPerPoll = boundedOption(options.maxIngressPerPoll, 256, 1, 4_096, "Mailbox ingress batch limit", observerOptionError);
    this.maxRetryAttempts = boundedOption(options.maxRetryAttempts, 8, 1, 1_000, "Mailbox retry attempt limit", observerOptionError);
    this.maxRetryAgeMs = boundedOption(options.maxRetryAgeMs, 30_000, 0, 24 * 60 * 60_000, "Mailbox retry age limit", observerOptionError);
    this.maxTrackedRetries = boundedOption(options.maxTrackedRetries, 512, 1, 100_000, "Mailbox retry tracking limit", observerOptionError);
    this.maxTransports = boundedOption(options.maxTransports, 1_024, 1, 100_000, "Mailbox transport limit", observerOptionError);
    this.maxEstimatedBytes = boundedOption(
      options.maxEstimatedBytes,
      64 * 1024 * 1024,
      1_024,
      1024 * 1024 * 1024,
      "Mailbox aggregate store byte limit",
      observerOptionError
    );
    this.quarantineMaxRecords = boundedOption(options.quarantineMaxRecords, 128, 1, 100_000, "Mailbox quarantine record limit", observerOptionError);
    this.quarantineMaxBytes = boundedOption(options.quarantineMaxBytes, 4 * 1024 * 1024, 1_024, 1024 * 1024 * 1024, "Mailbox quarantine byte limit", observerOptionError);
    this.quarantineMaxAgeMs = boundedOption(options.quarantineMaxAgeMs, 24 * 60 * 60_000, 0, 30 * 24 * 60 * 60_000, "Mailbox quarantine age limit", observerOptionError);
    this.orphanIngressMaxAgeMs = boundedOption(options.orphanIngressMaxAgeMs, 30_000, 0, 24 * 60 * 60_000, "Mailbox orphan ingress age limit", observerOptionError);
    this.removeFile = options.removeFile ?? unlinkSync;
    const capacityError = () => new ObserverError(
      "TRANSPORT_UNAVAILABLE",
      "Mailbox in-memory retention budget is exhausted",
      503
    );
    this.transports = new BoundedJsonMap({
      maxRecords: this.maxTransports,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (sessionId, transport) => Buffer.byteLength(JSON.stringify({
        sessionId,
        profilePath: transport.profilePath,
      }), "utf8"),
      capacityError,
    });
    this.rejectionAttempts = new BoundedJsonMap({
      maxRecords: this.maxTrackedRetries,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (path, retry) => Buffer.byteLength(JSON.stringify([path, retry]), "utf8"),
      capacityError,
    });
    this.pollCursors = new BoundedJsonMap({
      maxRecords: this.maxTransports,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (sessionId, cursor) => Buffer.byteLength(JSON.stringify([sessionId, cursor]), "utf8"),
      capacityError,
    });
    this.commandUsageBySession = new BoundedJsonMap({
      maxRecords: this.maxTransports,
      maxEstimatedBytes: this.maxEstimatedBytes,
      estimateBytes: (sessionId, usage) => Buffer.byteLength(JSON.stringify([sessionId, usage]), "utf8"),
      capacityError,
    });
  }

  async pollOnce(): Promise<void> {
    const previousScope = this.quarantineInventoryScope;
    this.quarantineInventoryScope = new Map();
    try {
      for (const session of this.sessions.activeRecords()) {
        if (!session.transportPreference.includes("mailbox")) continue;
        try {
          let transport = this.transports.get(session.sessionId);
          if (!transport) {
            if (this.transports.size >= this.maxTransports) {
              throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox transport retention budget is exhausted", 503);
            }
            transport = new MailboxTransport(session.profilePath, {
              removeFile: this.removeFile,
              onCleanupFailure: (failure) => this.recordCleanupFailure(failure),
            });
            const usage = transport.stats();
            if (!usage.commandUsageReliable) {
              throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox command retention usage cannot be proven", 503);
            }
            this.admitTransport(session.sessionId, transport, {
              files: usage.commandFiles,
              bytes: usage.commandBytes,
            });
          }
          await this.consumeIngress(session.sessionId, transport.statusDirectory);
          this.publishCommands(session.sessionId, transport);
        } catch (error) {
          observerLogger.warn("mailbox session poll failed", {
            sessionId: session.sessionId,
            errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
          });
        }
      }
    } finally {
      this.quarantineInventoryScope = previousScope;
    }
  }

  sweep(now = this.clock.now(), retainedSessionIds: ReadonlySet<string> = new Set()): MailboxSweepResult {
    const previousScope = this.quarantineInventoryScope;
    this.quarantineInventoryScope = new Map();
    try {
      const removedTransportSessionIds: string[] = [];
      let removedQuarantineFiles = 0;
      let removedOrphanIngressFiles = 0;
      let retainedCleanupFailures = 0;
      for (const [sessionId, transport] of this.transports) {
        let cleanupBlocked = false;
        const writerIsDurablyInactive = this.sessions.isTerminal(sessionId, now) &&
          !retainedSessionIds.has(sessionId) &&
          !this.sessions.isPinned(sessionId, retainedSessionIds);
        try {
          const commandSweep = transport.sweepCommands(now);
          this.commandUsageBySession.set(sessionId, { files: commandSweep.files, bytes: commandSweep.bytes });
          if (!commandSweep.usageReliable || commandSweep.retainedFailures > 0) {
            cleanupBlocked = true;
            retainedCleanupFailures += commandSweep.retainedFailures + (commandSweep.usageReliable ? 0 : 1);
          }
        } catch (error) {
          cleanupBlocked = true;
          retainedCleanupFailures += 1;
          this.recordCleanupError("sweep_commands", sessionId, error);
        }
        // Runtime publication is data -> marker and Enforce has no atomic
        // rename. A markerless data file may therefore belong to a live writer
        // paused immediately before marker publication. Runtime-side writes
        // reclaim their own prior crash remnants while serialized; the host may
        // reclaim only after durable session authority proves the writer is no
        // longer active.
        if (writerIsDurablyInactive) {
          try {
            const orphanSweep = this.pruneOrphanIngress(transport.statusDirectory, now);
            removedOrphanIngressFiles += orphanSweep.removed;
            if (!orphanSweep.reliable || orphanSweep.retainedFailures > 0) {
              cleanupBlocked = true;
              retainedCleanupFailures += orphanSweep.retainedFailures + (orphanSweep.reliable ? 0 : 1);
            }
          } catch (error) {
            cleanupBlocked = true;
            retainedCleanupFailures += 1;
            this.recordCleanupError("sweep_orphan_ingress", sessionId, error);
          }
        }
        try {
          const quarantineSweep = this.pruneQuarantine(transport.statusDirectory, now, 0);
          removedQuarantineFiles += quarantineSweep.removed;
          if (!quarantineSweep.reliable || quarantineSweep.retainedFailures > 0) {
            cleanupBlocked = true;
            retainedCleanupFailures += quarantineSweep.retainedFailures + (quarantineSweep.reliable ? 0 : 1);
          }
        } catch (error) {
          cleanupBlocked = true;
          retainedCleanupFailures += 1;
          this.recordCleanupError("sweep_quarantine", sessionId, error);
        }
        if (!writerIsDurablyInactive) continue;
        // A busy or uninspectable exact file keeps only its own transport pinned
        // for a later retry. It cannot abort or pin unrelated session cleanup.
        if (cleanupBlocked) continue;
        this.transports.delete(sessionId);
        this.pollCursors.delete(sessionId);
        this.commandUsageBySession.delete(sessionId);
        for (const [path, retry] of this.rejectionAttempts) {
          if (retry.sessionId === sessionId) this.rejectionAttempts.delete(path);
        }
        removedTransportSessionIds.push(sessionId);
      }
      try {
        const aggregate = this.pruneAggregateQuarantine(now, 0);
        removedQuarantineFiles += aggregate.removed;
        retainedCleanupFailures += aggregate.retainedFailures + (aggregate.reliable ? 0 : 1);
      } catch (error) {
        retainedCleanupFailures += 1;
        this.recordCleanupError("sweep_aggregate_quarantine", "aggregate", error);
      }
      return { removedTransportSessionIds, removedQuarantineFiles, removedOrphanIngressFiles, retainedCleanupFailures };
    } finally {
      this.quarantineInventoryScope = previousScope;
    }
  }

  stats(): MailboxCoordinatorStats {
    let quarantineFiles = 0;
    let quarantineBytes = 0;
    let commandFiles = 0;
    let commandBytes = 0;
    let commandUsageReliable = true;
    for (const [sessionId, transport] of this.transports) {
      const quarantine = this.quarantineUsage(transport.statusDirectory);
      quarantineFiles += quarantine.files;
      quarantineBytes += quarantine.bytes;
      const transportStats = transport.stats();
      commandUsageReliable = commandUsageReliable && transportStats.commandUsageReliable && quarantine.reliable;
      const commands = this.commandUsageBySession.get(sessionId) ?? { files: transportStats.commandFiles, bytes: transportStats.commandBytes };
      commandFiles += commands.files;
      commandBytes += commands.bytes;
    }
    return {
      transports: this.transports.size,
      maxTransports: this.maxTransports,
      estimatedBytes: this.estimatedStoreBytes(),
      maxEstimatedBytes: this.maxEstimatedBytes,
      trackedRetries: this.rejectionAttempts.size,
      maxTrackedRetries: this.maxTrackedRetries,
      ...this.dispositionCounts,
      quarantineFiles,
      quarantineBytes,
      quarantineMaxRecords: this.quarantineMaxRecords,
      quarantineMaxBytes: this.quarantineMaxBytes,
      quarantineMaxAgeMs: this.quarantineMaxAgeMs,
      commandFiles,
      commandBytes,
      commandUsageReliable,
      orphanIngressRemoved: this.orphanIngressRemoved,
      cleanupFailures: this.cleanupFailures,
      lastCleanupFailure: this.lastCleanupFailure,
    };
  }

  sessionIds(): Set<string> {
    return new Set(this.transports.keys());
  }

  private async consumeIngress(sessionId: string, statusDirectory: string): Promise<void> {
    // Do not reclaim markerless runtime output here. Even an old data file can
    // belong to a live writer paused before its completion marker. The runtime
    // serializes reclamation with its next publication; terminal-session sweep
    // is the only host-side reclamation path.
    const entries = readdirSync(statusDirectory, { withFileTypes: true })
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".complete"))
      .sort((a, b) => this.eventSequence(a.name) - this.eventSequence(b.name) || a.name.localeCompare(b.name));
    const cursor = this.pollCursors.get(sessionId);
    const cursorIndex = cursor ? entries.findIndex((entry) => entry.name === cursor) : -1;
    const ordered = cursorIndex >= 0
      ? [...entries.slice(cursorIndex + 1), ...entries.slice(0, cursorIndex + 1)]
      : entries;
    for (const entry of ordered.slice(0, this.maxIngressPerPoll)) {
      this.pollCursors.set(sessionId, entry.name);
      const markerPath = join(statusDirectory, entry.name);
      const dataName = entry.name.slice(0, -".complete".length);
      const path = join(statusDirectory, dataName);
      try {
        assertManagedPath(statusDirectory, markerPath);
        assertManagedPath(statusDirectory, path);
        const markerInfo = lstatSync(markerPath);
        if (entry.isSymbolicLink() || markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.size > 64) {
          throw new ObserverError("INVALID_REQUEST", "Mailbox completion marker is invalid");
        }
        const kind = this.kind(entry.name);
        if (!kind) throw new ObserverError("INVALID_REQUEST", "Mailbox ingress filename is invalid");
        const body = new BoundedJsonStore({
          root: statusDirectory,
          minRecordBytes: 2,
          maxRecordBytes: DEFAULT_LIMITS.maxRequestBodyBytes,
          parse: parseIngressObject,
        }).read(path);
        if (!body) throw new ObserverError("ARTIFACT_INCOMPLETE", "Mailbox data file is missing");
        if (body.sessionId !== sessionId || typeof body.sessionToken !== "string") {
          throw new ObserverError("UNAUTHORIZED", "Mailbox message session identity is invalid", 401);
        }
        const token = body.sessionToken;
        delete body.sessionToken;
        if (kind === "registration") this.registry.register(body, token);
        else if (kind === "heartbeat") this.registry.heartbeat(body, token);
        else if (kind === "status") this.jobs.update(body, token);
        else await this.artifacts.intake(body, token);
        // Remove the completion marker first. If data cleanup is interrupted,
        // the accepted message cannot be delivered a second time.
        if (!this.disposeFile(markerPath, "accept_marker")) {
          throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox acceptance marker cleanup is busy", 503);
        }
        this.rejectionAttempts.delete(markerPath);
        this.dispositionCounts.accepted += 1;
        if (!this.disposeFile(path, "accept_data")) {
          // Marker deletion is the acceptance commit. Residual data is cleanup
          // evidence, never another message eligible for delivery.
          this.quarantine(statusDirectory, dataName, path, markerPath, "ACCEPTED_CLEANUP", this.clock.now());
        }
      } catch (error) {
        const normalized = error instanceof ObserverError
          ? error
          : new ObserverError("INVALID_REQUEST", "Mailbox ingress could not be processed");
        if (!this.isTransient(error)) {
          this.dispositionCounts.permanentRejected += 1;
          this.quarantine(statusDirectory, dataName, path, markerPath, normalized.code, this.clock.now());
          this.rejectionAttempts.delete(markerPath);
          continue;
        }
        const now = this.clock.now();
        const previous = this.rejectionAttempts.get(markerPath);
        const retry: RetryRecord = {
          attempts: (previous?.attempts ?? 0) + 1,
          firstSeenAt: previous?.firstSeenAt ?? now,
          sessionId,
          statusDirectory,
          dataName,
        };
        this.rejectionAttempts.delete(markerPath);
        this.dispositionCounts.transientRetries += 1;
        observerLogger.warn("mailbox ingress retry scheduled", {
          sessionId,
          file: dataName,
          attempts: retry.attempts,
          ageMs: now - retry.firstSeenAt,
          errorCode: normalized.code,
        });
        if (retry.attempts >= this.maxRetryAttempts || now - retry.firstSeenAt >= this.maxRetryAgeMs) {
          this.quarantine(statusDirectory, dataName, path, markerPath, normalized.code, now);
          this.rejectionAttempts.delete(markerPath);
          continue;
        }
        if (!this.retainRetry(markerPath, retry, now)) continue;
        this.enforceRetryTrackingBound(now);
      }
    }
  }

  private publishCommands(sessionId: string, transport: MailboxTransport): void {
    for (const instance of this.registry.forSession(sessionId)) {
      if (instance.registration.selectedTransport !== "mailbox" || this.registry.isStale(instance)) continue;
      try {
        const command = this.jobs.nextCommand(sessionId, instance.registration.instanceId, instance.registration.instanceNonce);
        if (command) {
          const remaining = Math.max(0, this.maxEstimatedBytes - this.estimatedStoreBytes());
          transport.writeCommand(command, remaining);
          const usage = transport.stats();
          this.commandUsageBySession.set(sessionId, { files: usage.commandFiles, bytes: usage.commandBytes });
        }
      } catch (error) {
        if (!(error instanceof ObserverError) || !["INSTANCE_STALE", "INSTANCE_NOT_FOUND"].includes(error.code)) throw error;
      }
    }
  }

  private isTransient(error: unknown): boolean {
    if (error instanceof ObserverError) {
      return ["ARTIFACT_INCOMPLETE", "TRANSPORT_UNAVAILABLE", "INSTANCE_NOT_FOUND", "CAMERA_BUSY", "INTERNAL_ERROR"].includes(error.code);
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    return typeof code === "string" && ["EBUSY", "EACCES", "EPERM", "ENOENT", "EMFILE", "ENFILE"].includes(code);
  }

  private enforceRetryTrackingBound(now: number): void {
    while (this.rejectionAttempts.size > this.maxTrackedRetries || this.estimatedStoreBytes() > this.maxEstimatedBytes) {
      const oldest = this.rejectionAttempts.entries().next().value as [string, RetryRecord] | undefined;
      if (!oldest) break;
      const [markerPath, retry] = oldest;
      const path = join(retry.statusDirectory, retry.dataName);
      this.quarantine(retry.statusDirectory, retry.dataName, path, markerPath, "RETRY_TRACKING_LIMIT", now);
      this.rejectionAttempts.delete(markerPath);
    }
  }

  private retainRetry(markerPath: string, retry: RetryRecord, now: number): boolean {
    for (;;) {
      try {
        this.rejectionAttempts.set(markerPath, retry);
        return true;
      } catch (error) {
        if (!(error instanceof ObserverError) || error.code !== "TRANSPORT_UNAVAILABLE") throw error;
        const oldest = this.rejectionAttempts.entries().next().value as [string, RetryRecord] | undefined;
        if (!oldest) {
          this.quarantine(
            retry.statusDirectory,
            retry.dataName,
            join(retry.statusDirectory, retry.dataName),
            markerPath,
            "RETRY_TRACKING_LIMIT",
            now
          );
          return false;
        }
        const [oldestMarkerPath, oldestRetry] = oldest;
        this.quarantine(
          oldestRetry.statusDirectory,
          oldestRetry.dataName,
          join(oldestRetry.statusDirectory, oldestRetry.dataName),
          oldestMarkerPath,
          "RETRY_TRACKING_LIMIT",
          now
        );
        this.rejectionAttempts.delete(oldestMarkerPath);
      }
    }
  }

  private kind(name: string): MailboxMessageKind | null {
    const match = /^\d{12}-(registration|heartbeat|status|artifact)-/.exec(name);
    return (match?.[1] as MailboxMessageKind | undefined) ?? null;
  }

  private eventSequence(name: string): number {
    const match = /^(\d{12})-/.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  }

  private quarantine(
    statusDirectory: string,
    dataName: string,
    path: string,
    markerPath: string,
    errorCode: string,
    now: number
  ): void {
    let quarantine: string;
    try {
      quarantine = ensureCanonicalDirectory(join(statusDirectory, "quarantine"));
      assertManagedPath(statusDirectory, quarantine);
    } catch (error) {
      this.recordCleanupError("prepare_quarantine", dataName, error);
      this.disposeFile(markerPath, "drop_marker_without_quarantine");
      this.disposeFile(path, "drop_data_without_quarantine");
      this.dispositionCounts.quarantineDropped += 1;
      return;
    }
    this.dispositionSequence += 1;
    const sourceInfo = this.safeFileInfo(path);
    const safeCode = errorCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "REJECTED";
    const safeSource = basename(dataName).replace(/[^A-Za-z0-9_.-]/g, "_").slice(-96) || "invalid.json";
    const summary = {
      disposition: "permanent_rejection",
      errorCode: safeCode,
      sourceName: safeSource,
      sourceBytes: sourceInfo?.size ?? null,
      quarantinedAt: new Date(now).toISOString(),
    };
    const summaryBytes = Buffer.byteLength(`${JSON.stringify(summary, null, 2)}\n`, "utf8");
    let retainOriginal = sourceInfo !== null && sourceInfo.size <= DEFAULT_LIMITS.maxRequestBodyBytes &&
      sourceInfo.size <= this.quarantineMaxBytes && sourceInfo.size <= this.maxEstimatedBytes;
    let incomingBytes = retainOriginal ? sourceInfo!.size : summaryBytes;
    let localPrune = this.pruneQuarantine(statusDirectory, now, incomingBytes);
    let aggregatePrune = this.pruneAggregateQuarantine(now, incomingBytes);
    let estimatedBytes = aggregatePrune.estimatedBytes;
    let retentionReliable = localPrune.reliable && aggregatePrune.reliable &&
      localPrune.retainedFailures === 0 && aggregatePrune.retainedFailures === 0;
    if (retainOriginal && estimatedBytes + incomingBytes > this.maxEstimatedBytes) {
      retainOriginal = false;
      incomingBytes = summaryBytes;
      localPrune = this.pruneQuarantine(statusDirectory, now, incomingBytes);
      aggregatePrune = this.pruneAggregateQuarantine(now, incomingBytes);
      estimatedBytes = aggregatePrune.estimatedBytes;
      retentionReliable = retentionReliable && localPrune.reliable && aggregatePrune.reliable &&
        localPrune.retainedFailures === 0 && aggregatePrune.retainedFailures === 0;
    }
    if (!retentionReliable || estimatedBytes + incomingBytes > this.maxEstimatedBytes || incomingBytes > this.quarantineMaxBytes) {
      this.disposeFile(markerPath, "drop_over_budget_marker");
      this.disposeFile(path, "drop_over_budget_data");
      this.dispositionCounts.quarantineDropped += 1;
      return;
    }
    const target = join(
      quarantine,
      `${String(now).padStart(13, "0")}-${String(this.dispositionSequence).padStart(8, "0")}-${safeCode}-${safeSource}`
    );
    assertManagedPath(quarantine, target);
    try {
      // The marker is only a commit signal and carries no forensic payload.
      // Delete it first so a partial quarantine operation cannot redeliver.
      if (!this.disposeFile(markerPath, "quarantine_marker")) {
        this.dispositionCounts.quarantineDropped += 1;
        return;
      }
      if (retainOriginal) {
        renameSync(path, target);
      } else {
        if (!this.disposeFile(path, "quarantine_source")) {
          this.dispositionCounts.quarantineDropped += 1;
          return;
        }
        atomicWriteJson(quarantine, target, summary);
      }
      // Inspect the exact published target before declaring retention. The
      // poll/sweep-scoped inventory is updated for this mutation and is
      // invalidated on any later cleanup failure.
      const retainedInfo = lstatSync(target);
      if (retainedInfo.isSymbolicLink() || !retainedInfo.isFile()) {
        throw Object.assign(new Error("unsafe published quarantine entry"), { code: "EUNSAFE" });
      }
      this.addScopedQuarantineFile(target, retainedInfo.size, retainedInfo.mtimeMs);
      const localUsage = this.quarantineUsage(statusDirectory);
      const aggregateUsage = this.estimatedStoreBytes();
      if (!localUsage.reliable || localUsage.files > this.quarantineMaxRecords ||
          localUsage.bytes > this.quarantineMaxBytes || aggregateUsage > this.maxEstimatedBytes) {
        throw Object.assign(new Error("published quarantine entry exceeded a verified bound"), { code: "EBOUNDS" });
      }
      this.dispositionCounts.quarantined += 1;
    } catch (error) {
      // Quarantine is deliberately fail-safe for liveness: exact ingress files
      // are discarded if bounded evidence cannot be retained.
      this.disposeFile(markerPath, "quarantine_failure_marker");
      this.disposeFile(path, "quarantine_failure_data");
      this.disposeFile(target, "quarantine_failure_target");
      this.invalidateScopedQuarantineFile(target);
      this.dispositionCounts.quarantineDropped += 1;
      this.recordCleanupError("retain_quarantine", dataName, error);
      observerLogger.warn("mailbox quarantine evidence dropped", {
        file: dataName,
        errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
      });
    }
  }

  private pruneAggregateQuarantine(now: number, incomingBytes: number): AggregateCleanupSweep {
    let reliable = true;
    let quarantineBytes = 0;
    const files = [...this.transports.values()].flatMap((transport) => {
      const quarantine = join(transport.statusDirectory, "quarantine");
      const inventory = this.quarantineFiles(quarantine);
      reliable = reliable && inventory.reliable;
      quarantineBytes += inventory.files.reduce((total, item) => total + item.bytes, 0);
      return inventory.files;
    }).sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    let commandBytes = 0;
    for (const [sessionId, transport] of this.transports) {
      const transportStats = transport.stats();
      reliable = reliable && transportStats.commandUsageReliable;
      commandBytes += (this.commandUsageBySession.get(sessionId) ?? {
        files: transportStats.commandFiles,
        bytes: transportStats.commandBytes,
      }).bytes;
    }
    const metadataBytes = this.metadataBytes();
    let total = commandBytes + quarantineBytes + metadataBytes;
    let removed = 0;
    let retainedFailures = 0;
    for (const item of files) {
      if (total + incomingBytes <= this.maxEstimatedBytes && now - item.mtimeMs <= this.quarantineMaxAgeMs) break;
      if (this.disposeFile(item.path, "prune_aggregate_quarantine")) {
        total -= item.bytes;
        removed += 1;
      } else {
        retainedFailures += 1;
      }
    }
    return {
      removed,
      retainedFailures,
      reliable,
      estimatedBytes: reliable ? total : Math.max(total, this.maxEstimatedBytes + 1),
    };
  }

  private pruneQuarantine(statusDirectory: string, now: number, incomingBytes: number): CleanupSweep {
    const quarantine = join(statusDirectory, "quarantine");
    assertManagedPath(statusDirectory, quarantine);
    const inventory = this.quarantineFiles(quarantine);
    const files = inventory.files;
    let total = files.reduce((sum, item) => sum + item.bytes, 0);
    let count = files.length;
    let removed = 0;
    let retainedFailures = 0;
    for (const item of files) {
      const expired = now - item.mtimeMs > this.quarantineMaxAgeMs;
      const overCount = count + (incomingBytes > 0 ? 1 : 0) > this.quarantineMaxRecords;
      const overBytes = total + incomingBytes > this.quarantineMaxBytes;
      if (!expired && !overCount && !overBytes) continue;
      if (this.disposeFile(item.path, "prune_quarantine")) {
        total -= item.bytes;
        count -= 1;
        removed += 1;
      } else {
        retainedFailures += 1;
      }
    }
    return { removed, retainedFailures, reliable: inventory.reliable };
  }

  private quarantineUsage(statusDirectory: string): { files: number; bytes: number; reliable: boolean } {
    const quarantine = join(statusDirectory, "quarantine");
    const inventory = this.quarantineFiles(quarantine);
    return {
      files: inventory.files.length,
      bytes: inventory.files.reduce((total, item) => total + item.bytes, 0),
      reliable: inventory.reliable,
    };
  }

  private quarantineFiles(quarantine: string): QuarantineInventory {
    const cached = this.quarantineInventoryScope?.get(quarantine);
    if (cached) return { files: [...cached.files], reliable: cached.reliable };
    const files: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
    let entries;
    try {
      entries = readdirSync(quarantine, { withFileTypes: true });
    } catch (error) {
      if (this.isMissing(error)) return { files, reliable: true };
      this.recordCleanupError("scan_quarantine", quarantine, error);
      return { files, reliable: false };
    }
    let reliable = true;
    for (const entry of entries) {
      const path = join(quarantine, entry.name);
      assertManagedPath(quarantine, path);
      try {
        const info = lstatSync(path);
        if (entry.isSymbolicLink() || info.isSymbolicLink() || !entry.isFile() || !info.isFile()) {
          reliable = false;
          this.recordCleanupError("inspect_quarantine", path, Object.assign(new Error("unsafe quarantine entry"), { code: "EUNSAFE" }));
          continue;
        }
        files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
      } catch (error) {
        if (this.isMissing(error)) continue;
        reliable = false;
        this.recordCleanupError("inspect_quarantine", path, error);
      }
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    const inventory = { files, reliable };
    if (reliable) this.quarantineInventoryScope?.set(quarantine, inventory);
    return { files: [...files], reliable };
  }

  private safeFileInfo(path: string): { size: number } | null {
    try {
      const info = lstatSync(path);
      return info.isFile() && !info.isSymbolicLink() ? { size: info.size } : null;
    } catch {
      return null;
    }
  }

  private pruneOrphanIngress(statusDirectory: string, now: number): CleanupSweep {
    let entries;
    try {
      entries = readdirSync(statusDirectory, { withFileTypes: true });
    } catch (error) {
      if (this.isMissing(error)) return { removed: 0, retainedFailures: 0, reliable: true };
      this.recordCleanupError("scan_orphan_ingress", statusDirectory, error);
      return { removed: 0, retainedFailures: 0, reliable: false };
    }
    const names = new Set(entries.map((entry) => entry.name));
    let removed = 0;
    let retainedFailures = 0;
    let reliable = true;
    for (const entry of entries) {
      const isTemporary = /^\d{12}-(?:registration|heartbeat|status|artifact)-[A-Za-z0-9_.-]+\.json\.tmp$/.test(entry.name);
      const isMarkerlessData = /^\d{12}-(?:registration|heartbeat|status|artifact)-[A-Za-z0-9_.-]+\.json$/.test(entry.name) &&
        !names.has(`${entry.name}.complete`);
      if (!isTemporary && !isMarkerlessData) continue;
      const path = join(statusDirectory, entry.name);
      assertManagedPath(statusDirectory, path);
      let info;
      try {
        info = lstatSync(path);
      } catch (error) {
        if (this.isMissing(error)) {
          removed += 1;
          continue;
        }
        reliable = false;
        this.recordCleanupError("inspect_orphan_ingress", path, error);
        continue;
      }
      if (now - info.mtimeMs < this.orphanIngressMaxAgeMs) continue;
      if (this.disposeFile(path, "prune_orphan_ingress")) {
        removed += 1;
        this.orphanIngressRemoved += 1;
      } else {
        retainedFailures += 1;
      }
    }
    return { removed, retainedFailures, reliable };
  }

  private disposeFile(path: string, operation: string): boolean {
    try {
      this.removeFile(path);
      this.removeScopedQuarantineFile(path);
      return true;
    } catch (error) {
      if (this.isMissing(error)) {
        this.removeScopedQuarantineFile(path);
        return true;
      }
      this.invalidateScopedQuarantineFile(path);
      this.recordCleanupError(operation, path, error);
      return false;
    }
  }

  private addScopedQuarantineFile(path: string, bytes: number, mtimeMs: number): void {
    const inventory = this.quarantineInventoryScope?.get(dirname(path));
    if (!inventory) return;
    inventory.files = inventory.files.filter((item) => item.path !== path);
    inventory.files.push({ path, bytes, mtimeMs });
    inventory.files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
  }

  private removeScopedQuarantineFile(path: string): void {
    const inventory = this.quarantineInventoryScope?.get(dirname(path));
    if (!inventory) return;
    inventory.files = inventory.files.filter((item) => item.path !== path);
  }

  private invalidateScopedQuarantineFile(path: string): void {
    this.quarantineInventoryScope?.delete(dirname(path));
  }

  private recordCleanupFailure(failure: MailboxCleanupFailure): void {
    this.cleanupFailures += 1;
    this.lastCleanupFailure = failure;
    observerLogger.warn("mailbox cleanup retained busy entry", { ...failure });
  }

  private recordCleanupError(operation: string, path: string, error: unknown): void {
    this.recordCleanupFailure({
      operation,
      file: basename(path) || "unknown",
      errorCode: (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN",
    });
  }

  private isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }

  private estimatedStoreBytes(): number {
    const commandBytes = [...this.commandUsageBySession.values()].reduce((total, usage) => total + usage.bytes, 0);
    let quarantineBytes = 0;
    let reliable = true;
    for (const transport of this.transports.values()) {
      const usage = this.quarantineUsage(transport.statusDirectory);
      quarantineBytes += usage.bytes;
      reliable = reliable && usage.reliable && transport.stats().commandUsageReliable;
    }
    const metadataBytes = this.metadataBytes();
    const knownBytes = commandBytes + quarantineBytes + metadataBytes;
    return reliable ? knownBytes : Math.max(knownBytes, this.maxEstimatedBytes + 1);
  }

  private metadataBytes(): number {
    return Buffer.byteLength(JSON.stringify({
      transports: [...this.transports.entries()].map(([sessionId, transport]) => ({ sessionId, profilePath: transport.profilePath })),
      retries: [...this.rejectionAttempts.entries()],
      cursors: [...this.pollCursors.entries()],
      dispositions: this.dispositionCounts,
    }), "utf8");
  }

  private admitTransport(
    sessionId: string,
    transport: MailboxTransport,
    importedCommandUsage: { files: number; bytes: number }
  ): void {
    try {
      // Preflight both independently bounded indexes before publishing either
      // side of the admission. Keep the mutations inside the same rollback
      // boundary as defense against injected failures or future estimators
      // whose result can change between preflight and commit.
      this.transports.assertCanSet(sessionId, transport);
      this.commandUsageBySession.assertCanSet(sessionId, importedCommandUsage);
      this.transports.set(sessionId, transport);
      this.commandUsageBySession.set(sessionId, importedCommandUsage);
      if (this.estimatedStoreBytes() > this.maxEstimatedBytes) {
        throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox aggregate retention byte budget is exhausted", 503);
      }
    } catch (error) {
      // Roll back every in-memory index populated while measuring imported
      // command/quarantine usage. Pre-existing disk state is preserved so a
      // later configuration change can retry admission safely.
      this.transports.delete(sessionId);
      this.commandUsageBySession.delete(sessionId);
      this.pollCursors.delete(sessionId);
      throw error;
    }
  }

}
