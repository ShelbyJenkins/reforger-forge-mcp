import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  SESSION_DIRECTORY_NAME,
  jobStatusSchema,
  parseProtocolMessage,
  type JobStatus,
  type RuntimeCommandEnvelope,
} from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import {
  assertIdentifier,
  assertManagedPath,
  atomicWriteJson,
  ensureCanonicalDirectory,
  resolveEngineProfileDirectory,
} from "./paths.js";

const MAX_COMMAND_SEQUENCE = 999_999_999_999;

export interface MailboxCleanupFailure {
  operation: string;
  file: string;
  errorCode: string;
}

export interface MailboxTransportOptions {
  maxCommandFiles?: number;
  maxCommandBytes?: number;
  removeFile?: (path: string) => void;
  onCleanupFailure?: (failure: MailboxCleanupFailure) => void;
}

interface CommandInventory {
  files: Array<{ path: string; sequence: number; bytes: number }>;
  temporaryFiles: Array<{ path: string; bytes: number }>;
  reliable: boolean;
}

export class MailboxTransport {
  readonly commandsDirectory: string;
  readonly statusDirectory: string;
  private commandSequence = 0;
  private readonly publishedCommands = new Map<string, string>();
  readonly maxCommandFiles: number;
  readonly maxCommandBytes: number;
  private readonly removeFile: (path: string) => void;
  private readonly onCleanupFailure?: (failure: MailboxCleanupFailure) => void;
  private cleanupFailures = 0;
  private lastCleanupFailure: MailboxCleanupFailure | null = null;

  constructor(
    readonly profilePath: string,
    options: MailboxTransportOptions = {}
  ) {
    this.maxCommandFiles = this.boundedOption(options.maxCommandFiles, 256, 1, 4_096, "Mailbox command file limit");
    this.maxCommandBytes = this.boundedOption(options.maxCommandBytes, 8 * 1024 * 1024, 1_024, 256 * 1024 * 1024, "Mailbox command byte limit");
    this.removeFile = options.removeFile ?? unlinkSync;
    this.onCleanupFailure = options.onCleanupFailure;
    const engineProfileDirectory = resolveEngineProfileDirectory(profilePath, { requireExisting: true });
    const observerPath = join(engineProfileDirectory, SESSION_DIRECTORY_NAME);
    assertManagedPath(profilePath, observerPath);
    assertManagedPath(engineProfileDirectory, observerPath);
    const observer = ensureCanonicalDirectory(observerPath);
    assertManagedPath(profilePath, observer);
    const commandsPath = join(observer, "mailbox", "commands");
    const statusPath = join(observer, "mailbox", "status");
    assertManagedPath(profilePath, commandsPath);
    assertManagedPath(profilePath, statusPath);
    this.commandsDirectory = ensureCanonicalDirectory(commandsPath);
    this.statusDirectory = ensureCanonicalDirectory(statusPath);
    assertManagedPath(profilePath, this.commandsDirectory);
    assertManagedPath(profilePath, this.statusDirectory);
    this.reclaimAtomicWriteTemporaries();
    this.commandSequence = this.commandInventory().files.reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
  }

  writeCommand(command: RuntimeCommandEnvelope, aggregateRemainingBytes = Number.MAX_SAFE_INTEGER): string {
    assertIdentifier(command.jobId, "Job ID");
    const publicationKey = `${command.commandKind}\0${command.jobId}\0${command.deliveryToken}`;
    const existing = this.publishedCommands.get(publicationKey);
    if (existing && existsSync(existing)) return existing;
    this.sweepCommands(Date.now());
    const allocation = this.nextCommandAllocation(command);
    const payload = { sequence: allocation.sequence, ...command };
    const encodedBytes = Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const usage = this.commandUsage();
    if (!usage.reliable) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox command retention usage cannot be proven", 503);
    }
    if (usage.files >= this.maxCommandFiles || usage.bytes + encodedBytes > this.maxCommandBytes || encodedBytes > aggregateRemainingBytes) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox command retention budget is exhausted", 503);
    }
    this.commandSequence = allocation.sequence;
    atomicWriteJson(this.commandsDirectory, allocation.path, payload);
    this.publishedCommands.set(publicationKey, allocation.path);
    return allocation.path;
  }

  sweepCommands(now = Date.now()): { removed: string[]; files: number; bytes: number; usageReliable: boolean; retainedFailures: number } {
    const removed: string[] = [];
    let retainedFailures = 0;
    const before = this.commandInventory();
    for (const item of before.temporaryFiles) {
      const disposition = this.disposeFile(item.path, "reclaim_command_temporary");
      if (disposition === "retained") retainedFailures += 1;
      else removed.push(item.path);
    }
    for (const item of before.files) {
      let expired = false;
      try {
        const value = JSON.parse(readFileSync(item.path, "utf8")) as Record<string, unknown>;
        const lease = typeof value.deliveryLeaseExpiresAt === "string" ? Date.parse(value.deliveryLeaseExpiresAt) : Number.NaN;
        expired = !Number.isFinite(lease) || lease <= now;
      } catch {
        // The agent is the sole command writer. A malformed retained command
        // cannot become valid and must not consume the bounded queue forever.
        expired = true;
      }
      if (!expired) continue;
      const disposition = this.disposeFile(item.path, "expire_command");
      if (disposition === "retained") retainedFailures += 1;
      else removed.push(item.path);
    }
    for (const [key, path] of this.publishedCommands) {
      if (!existsSync(path)) this.publishedCommands.delete(key);
    }
    const usage = this.commandUsage();
    return {
      removed,
      files: usage.files,
      bytes: usage.bytes,
      usageReliable: before.reliable && usage.reliable,
      retainedFailures,
    };
  }

  stats(): {
    commandFiles: number;
    commandBytes: number;
    commandUsageReliable: boolean;
    cachedPublications: number;
    maxCommandFiles: number;
    maxCommandBytes: number;
    cleanupFailures: number;
    lastCleanupFailure: MailboxCleanupFailure | null;
  } {
    const usage = this.commandUsage();
    return {
      commandFiles: usage.files,
      commandBytes: usage.bytes,
      commandUsageReliable: usage.reliable,
      cachedPublications: this.publishedCommands.size,
      maxCommandFiles: this.maxCommandFiles,
      maxCommandBytes: this.maxCommandBytes,
      cleanupFailures: this.cleanupFailures,
      lastCleanupFailure: this.lastCleanupFailure,
    };
  }

  readStatuses(sessionId: string, instanceId: string): JobStatus[] {
    const files = readdirSync(this.statusDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^\d{12}-status-[A-Za-z0-9_.-]+\.json$/.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const statuses: JobStatus[] = [];
    for (const entry of files) {
      const path = join(this.statusDirectory, entry.name);
      assertManagedPath(this.statusDirectory, path);
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      const parsed = parseProtocolMessage(jobStatusSchema, value);
      if (!parsed.success) continue;
      if (parsed.data.sessionId !== sessionId || parsed.data.instanceId !== instanceId) continue;
      statuses.push(parsed.data);
    }
    return statuses.sort((a, b) => a.sequence - b.sequence);
  }

  acknowledgeStatus(jobId: string, sequence: number): boolean {
    assertIdentifier(jobId, "Job ID");
    for (const entry of readdirSync(this.statusDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{12}-status-[A-Za-z0-9_.-]+\.json$/.test(entry.name)) continue;
      const path = join(this.statusDirectory, entry.name);
      assertManagedPath(this.statusDirectory, path);
      try {
        const parsed = parseProtocolMessage(jobStatusSchema, JSON.parse(readFileSync(path, "utf8")));
        if (parsed.success && parsed.data.jobId === jobId && parsed.data.sequence === sequence) {
          unlinkSync(path);
          return true;
        }
      } catch { /* leave unrelated or malformed ingress untouched */ }
    }
    return false;
  }

  private commandInventory(): CommandInventory {
    const files: Array<{ path: string; sequence: number; bytes: number }> = [];
    const temporaryFiles: Array<{ path: string; bytes: number }> = [];
    let entries;
    try {
      entries = readdirSync(this.commandsDirectory, { withFileTypes: true });
    } catch (error) {
      if (this.isMissing(error)) return { files, temporaryFiles, reliable: true };
      this.recordCleanupFailure("scan_commands", this.commandsDirectory, error);
      return { files, temporaryFiles, reliable: false };
    }
    let reliable = true;
    for (const entry of entries) {
      const match = /^(\d{12})-(?:capture|cancel)-[A-Za-z0-9_.-]+-\d+\.json$/.exec(entry.name);
      const isAtomicTemporary = /^\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i.test(entry.name);
      if (!match && !isAtomicTemporary) continue;
      const path = join(this.commandsDirectory, entry.name);
      assertManagedPath(this.commandsDirectory, path);
      try {
        const info = lstatSync(path);
        if (entry.isSymbolicLink() || info.isSymbolicLink() || !entry.isFile() || !info.isFile()) {
          reliable = false;
          this.recordCleanupFailure(
            "inspect_command",
            path,
            Object.assign(new Error("unsafe command entry"), { code: "EUNSAFE" })
          );
          continue;
        }
        if (isAtomicTemporary) temporaryFiles.push({ path, bytes: info.size });
        else files.push({ path, sequence: Number(match![1]), bytes: info.size });
      } catch (error) {
        if (this.isMissing(error)) continue;
        reliable = false;
        this.recordCleanupFailure("inspect_command", path, error);
      }
    }
    return {
      files: files.sort((left, right) => left.sequence - right.sequence),
      temporaryFiles: temporaryFiles.sort((left, right) => left.path.localeCompare(right.path)),
      reliable,
    };
  }

  private commandUsage(): { files: number; bytes: number; reliable: boolean } {
    const inventory = this.commandInventory();
    return {
      files: inventory.files.length + inventory.temporaryFiles.length,
      bytes: [...inventory.files, ...inventory.temporaryFiles].reduce((total, item) => total + item.bytes, 0),
      // A retained uncommitted write is accounted for, but future allocation is
      // refused until its exact disposition succeeds. This prevents a failing
      // rename/delete cycle from accumulating a fresh temporary on every poll.
      reliable: inventory.reliable && inventory.temporaryFiles.length === 0,
    };
  }

  private reclaimAtomicWriteTemporaries(): void {
    const inventory = this.commandInventory();
    for (const item of inventory.temporaryFiles) {
      this.disposeFile(item.path, "reclaim_command_temporary");
    }
  }

  private disposeFile(path: string, operation: string): "removed" | "missing" | "retained" {
    try {
      this.removeFile(path);
      return "removed";
    } catch (error) {
      if (this.isMissing(error)) return "missing";
      this.recordCleanupFailure(operation, path, error);
      return "retained";
    }
  }

  private recordCleanupFailure(operation: string, path: string, error: unknown): void {
    const failure = {
      operation,
      file: path.split(/[\\/]/).pop() ?? "unknown",
      errorCode: (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN",
    };
    this.cleanupFailures += 1;
    this.lastCleanupFailure = failure;
    this.onCleanupFailure?.(failure);
  }

  private isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }

  private nextCommandAllocation(command: RuntimeCommandEnvelope): {
    sequence: number;
    path: string;
  } {
    let sequence = this.commandSequence;
    // Filenames are a fixed 12-digit wire contract consumed by Enforce. Wrap
    // inside that domain and skip occupied exact names so a retained maximum
    // sequence (including poison/imported state) can never create a 13-digit
    // command that the runtime will permanently reject.
    for (let attempt = 0; attempt <= this.maxCommandFiles; attempt += 1) {
      sequence = sequence >= MAX_COMMAND_SEQUENCE ? 1 : sequence + 1;
      const name = `${String(sequence).padStart(12, "0")}-${command.commandKind}-${command.jobId}-${command.deliveryAttempt}.json`;
      const path = join(this.commandsDirectory, name);
      assertManagedPath(this.commandsDirectory, path);
      if (!existsSync(path)) return { sequence, path };
    }
    throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox command sequence namespace is exhausted", 503);
  }

  private boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
      throw new ObserverError("INVALID_REQUEST", `${label} must be an integer from ${minimum} through ${maximum}`);
    }
    return selected;
  }
}
