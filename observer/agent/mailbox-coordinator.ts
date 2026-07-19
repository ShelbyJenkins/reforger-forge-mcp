import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_LIMITS } from "../protocol/index.js";
import { ArtifactStore } from "./artifacts.js";
import { ObserverError } from "./errors.js";
import { JobStore } from "./jobs.js";
import { observerLogger } from "./logger.js";
import { MailboxTransport } from "./mailbox.js";
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
}

export interface MailboxSweepResult {
  removedTransportSessionIds: string[];
  removedQuarantineFiles: number;
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
}

export class MailboxCoordinator {
  private readonly transports = new Map<string, MailboxTransport>();
  private readonly rejectionAttempts = new Map<string, RetryRecord>();
  private readonly pollCursors = new Map<string, string>();
  private readonly quarantineIndex = new Map<string, Array<{ path: string; bytes: number; mtimeMs: number }>>();
  private readonly commandUsageBySession = new Map<string, { files: number; bytes: number }>();
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
  private dispositionSequence = 0;
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
    this.maxIngressPerPoll = this.boundedOption(options.maxIngressPerPoll, 256, 1, 4_096, "Mailbox ingress batch limit");
    this.maxRetryAttempts = this.boundedOption(options.maxRetryAttempts, 8, 1, 1_000, "Mailbox retry attempt limit");
    this.maxRetryAgeMs = this.boundedOption(options.maxRetryAgeMs, 30_000, 0, 24 * 60 * 60_000, "Mailbox retry age limit");
    this.maxTrackedRetries = this.boundedOption(options.maxTrackedRetries, 512, 1, 100_000, "Mailbox retry tracking limit");
    this.maxTransports = this.boundedOption(options.maxTransports, 1_024, 1, 100_000, "Mailbox transport limit");
    this.maxEstimatedBytes = this.boundedOption(
      options.maxEstimatedBytes,
      64 * 1024 * 1024,
      1_024,
      1024 * 1024 * 1024,
      "Mailbox aggregate store byte limit"
    );
    this.quarantineMaxRecords = this.boundedOption(options.quarantineMaxRecords, 128, 1, 100_000, "Mailbox quarantine record limit");
    this.quarantineMaxBytes = this.boundedOption(options.quarantineMaxBytes, 4 * 1024 * 1024, 1_024, 1024 * 1024 * 1024, "Mailbox quarantine byte limit");
    this.quarantineMaxAgeMs = this.boundedOption(options.quarantineMaxAgeMs, 24 * 60 * 60_000, 0, 30 * 24 * 60 * 60_000, "Mailbox quarantine age limit");
  }

  async pollOnce(): Promise<void> {
    for (const session of this.sessions.activeRecords()) {
      if (!session.transportPreference.includes("mailbox")) continue;
      try {
        let transport = this.transports.get(session.sessionId);
        if (!transport) {
          if (this.transports.size >= this.maxTransports) {
            throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox transport retention budget is exhausted", 503);
          }
          transport = new MailboxTransport(session.profilePath);
          const usage = transport.stats();
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
  }

  sweep(now = this.clock.now(), retainedSessionIds: ReadonlySet<string> = new Set()): MailboxSweepResult {
    const removedTransportSessionIds: string[] = [];
    let removedQuarantineFiles = 0;
    for (const [sessionId, transport] of this.transports) {
      const commandSweep = transport.sweepCommands(now);
      this.commandUsageBySession.set(sessionId, { files: commandSweep.files, bytes: commandSweep.bytes });
      removedQuarantineFiles += this.pruneQuarantine(transport.statusDirectory, now, 0);
      if (!this.sessions.isTerminal(sessionId, now) || retainedSessionIds.has(sessionId) || this.sessions.isPinned(sessionId, retainedSessionIds)) {
        continue;
      }
      this.transports.delete(sessionId);
      this.pollCursors.delete(sessionId);
      this.commandUsageBySession.delete(sessionId);
      this.quarantineIndex.delete(join(transport.statusDirectory, "quarantine"));
      for (const [path, retry] of this.rejectionAttempts) {
        if (retry.sessionId === sessionId) this.rejectionAttempts.delete(path);
      }
      removedTransportSessionIds.push(sessionId);
    }
    removedQuarantineFiles += this.pruneAggregateQuarantine(now, 0);
    return { removedTransportSessionIds, removedQuarantineFiles };
  }

  stats(): MailboxCoordinatorStats {
    let quarantineFiles = 0;
    let quarantineBytes = 0;
    let commandFiles = 0;
    let commandBytes = 0;
    for (const [sessionId, transport] of this.transports) {
      const quarantine = this.quarantineUsage(transport.statusDirectory);
      quarantineFiles += quarantine.files;
      quarantineBytes += quarantine.bytes;
      const commands = this.commandUsageBySession.get(sessionId) ?? { files: transport.stats().commandFiles, bytes: transport.stats().commandBytes };
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
    };
  }

  sessionIds(): Set<string> {
    return new Set(this.transports.keys());
  }

  private async consumeIngress(sessionId: string, statusDirectory: string): Promise<void> {
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
        if (!existsSync(path)) throw new ObserverError("ARTIFACT_INCOMPLETE", "Mailbox data file is missing");
        const info = lstatSync(path);
        if (info.isSymbolicLink() || !info.isFile()) throw new ObserverError("INVALID_REQUEST", "Mailbox ingress entry is not a regular file");
        if (info.size < 2 || info.size > DEFAULT_LIMITS.maxRequestBodyBytes) {
          throw new ObserverError("INVALID_REQUEST", "Mailbox ingress entry exceeds message bounds");
        }
        const kind = this.kind(entry.name);
        if (!kind) throw new ObserverError("INVALID_REQUEST", "Mailbox ingress filename is invalid");
        const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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
        unlinkSync(markerPath);
        this.rejectionAttempts.delete(markerPath);
        this.dispositionCounts.accepted += 1;
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
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
        this.rejectionAttempts.set(markerPath, retry);
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
        }
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
    const quarantine = ensureCanonicalDirectory(join(statusDirectory, "quarantine"));
    assertManagedPath(statusDirectory, quarantine);
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
    this.pruneQuarantine(statusDirectory, now, incomingBytes);
    this.pruneAggregateQuarantine(now, incomingBytes);
    if (this.estimatedStoreBytes() + incomingBytes > this.maxEstimatedBytes) {
      retainOriginal = false;
      incomingBytes = summaryBytes;
      this.pruneQuarantine(statusDirectory, now, incomingBytes);
      this.pruneAggregateQuarantine(now, incomingBytes);
    }
    if (this.estimatedStoreBytes() + incomingBytes > this.maxEstimatedBytes || incomingBytes > this.quarantineMaxBytes) {
      try { if (existsSync(markerPath) || this.isSymlink(markerPath)) unlinkSync(markerPath); } catch { /* exact-path best effort */ }
      try { if (existsSync(path) || this.isSymlink(path)) unlinkSync(path); } catch { /* exact-path best effort */ }
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
      if (existsSync(markerPath) || this.isSymlink(markerPath)) unlinkSync(markerPath);
      if (retainOriginal) {
        renameSync(path, target);
      } else {
        if (existsSync(path) || this.isSymlink(path)) unlinkSync(path);
        atomicWriteJson(quarantine, target, summary);
      }
      this.dispositionCounts.quarantined += 1;
      const retainedInfo = statSync(target);
      this.addQuarantineFile(target, retainedInfo.size, retainedInfo.mtimeMs);
    } catch (error) {
      // Quarantine is deliberately fail-safe for liveness: exact ingress files
      // are discarded if bounded evidence cannot be retained.
      try { if (existsSync(markerPath) || this.isSymlink(markerPath)) unlinkSync(markerPath); } catch { /* exact-path best effort */ }
      try { if (existsSync(path) || this.isSymlink(path)) unlinkSync(path); } catch { /* exact-path best effort */ }
      this.dispositionCounts.quarantineDropped += 1;
      observerLogger.warn("mailbox quarantine evidence dropped", {
        file: dataName,
        errorCode: error instanceof ObserverError ? error.code : "INTERNAL_ERROR",
      });
    }
    this.pruneQuarantine(statusDirectory, now, 0);
    this.pruneAggregateQuarantine(now, 0);
  }

  private pruneAggregateQuarantine(now: number, incomingBytes: number): number {
    const files = [...this.transports.values()].flatMap((transport) => {
      const quarantine = join(transport.statusDirectory, "quarantine");
      return existsSync(quarantine) ? this.quarantineFiles(quarantine) : [];
    }).sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    let total = this.estimatedStoreBytes();
    let removed = 0;
    for (const item of files) {
      if (total + incomingBytes <= this.maxEstimatedBytes && now - item.mtimeMs <= this.quarantineMaxAgeMs) break;
      unlinkSync(item.path);
      this.removeQuarantineFile(item.path);
      total -= item.bytes;
      removed += 1;
    }
    return removed;
  }

  private pruneQuarantine(statusDirectory: string, now: number, incomingBytes: number): number {
    const quarantine = join(statusDirectory, "quarantine");
    if (!existsSync(quarantine)) return 0;
    assertManagedPath(statusDirectory, quarantine);
    const files = [...this.quarantineFiles(quarantine)];
    let total = files.reduce((sum, item) => sum + item.bytes, 0);
    let count = files.length;
    let removed = 0;
    for (const item of files) {
      const expired = now - item.mtimeMs > this.quarantineMaxAgeMs;
      const overCount = count + (incomingBytes > 0 ? 1 : 0) > this.quarantineMaxRecords;
      const overBytes = total + incomingBytes > this.quarantineMaxBytes;
      if (!expired && !overCount && !overBytes) continue;
      unlinkSync(item.path);
      this.removeQuarantineFile(item.path);
      total -= item.bytes;
      count -= 1;
      removed += 1;
    }
    return removed;
  }

  private quarantineUsage(statusDirectory: string): { files: number; bytes: number } {
    const quarantine = join(statusDirectory, "quarantine");
    if (!existsSync(quarantine)) return { files: 0, bytes: 0 };
    const files = this.quarantineFiles(quarantine);
    return { files: files.length, bytes: files.reduce((total, item) => total + item.bytes, 0) };
  }

  private quarantineFiles(quarantine: string): Array<{ path: string; bytes: number; mtimeMs: number }> {
    const cached = this.quarantineIndex.get(quarantine);
    if (cached) return cached;
    const files: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
    for (const entry of readdirSync(quarantine, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const path = join(quarantine, entry.name);
      assertManagedPath(quarantine, path);
      const info = statSync(path);
      files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    this.quarantineIndex.set(quarantine, files);
    return files;
  }

  private addQuarantineFile(path: string, bytes: number, mtimeMs: number): void {
    const quarantine = dirname(path);
    const files = this.quarantineIndex.get(quarantine) ?? [];
    files.push({ path, bytes, mtimeMs });
    files.sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
    this.quarantineIndex.set(quarantine, files);
  }

  private removeQuarantineFile(path: string): void {
    const files = this.quarantineIndex.get(dirname(path));
    if (!files) return;
    const index = files.findIndex((item) => item.path === path);
    if (index >= 0) files.splice(index, 1);
  }

  private safeFileInfo(path: string): { size: number } | null {
    try {
      const info = lstatSync(path);
      return info.isFile() && !info.isSymbolicLink() ? { size: info.size } : null;
    } catch {
      return null;
    }
  }

  private estimatedStoreBytes(): number {
    const commandBytes = [...this.commandUsageBySession.values()].reduce((total, usage) => total + usage.bytes, 0);
    let quarantineBytes = 0;
    for (const transport of this.transports.values()) {
      quarantineBytes += this.quarantineUsage(transport.statusDirectory).bytes;
    }
    const metadataBytes = Buffer.byteLength(JSON.stringify({
      transports: [...this.transports.entries()].map(([sessionId, transport]) => ({ sessionId, profilePath: transport.profilePath })),
      retries: [...this.rejectionAttempts.entries()],
      cursors: [...this.pollCursors.entries()],
      dispositions: this.dispositionCounts,
    }), "utf8");
    return commandBytes + quarantineBytes + metadataBytes;
  }

  private admitTransport(
    sessionId: string,
    transport: MailboxTransport,
    importedCommandUsage: { files: number; bytes: number }
  ): void {
    this.transports.set(sessionId, transport);
    this.commandUsageBySession.set(sessionId, importedCommandUsage);
    try {
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
      this.quarantineIndex.delete(join(transport.statusDirectory, "quarantine"));
      throw error;
    }
  }

  private isSymlink(path: string): boolean {
    try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
  }

  private boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
      throw new ObserverError("INVALID_REQUEST", `${label} must be an integer from ${minimum} through ${maximum}`);
    }
    return selected;
  }
}
