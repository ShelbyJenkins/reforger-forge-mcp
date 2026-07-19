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

export class MailboxTransport {
  readonly commandsDirectory: string;
  readonly statusDirectory: string;
  private commandSequence = 0;
  private readonly publishedCommands = new Map<string, string>();
  readonly maxCommandFiles: number;
  readonly maxCommandBytes: number;

  constructor(
    readonly profilePath: string,
    options: { maxCommandFiles?: number; maxCommandBytes?: number } = {}
  ) {
    this.maxCommandFiles = this.boundedOption(options.maxCommandFiles, 256, 1, 4_096, "Mailbox command file limit");
    this.maxCommandBytes = this.boundedOption(options.maxCommandBytes, 8 * 1024 * 1024, 1_024, 256 * 1024 * 1024, "Mailbox command byte limit");
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
    this.commandSequence = this.commandFiles().reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
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
    if (usage.files >= this.maxCommandFiles || usage.bytes + encodedBytes > this.maxCommandBytes || encodedBytes > aggregateRemainingBytes) {
      throw new ObserverError("TRANSPORT_UNAVAILABLE", "Mailbox command retention budget is exhausted", 503);
    }
    this.commandSequence = allocation.sequence;
    atomicWriteJson(this.commandsDirectory, allocation.path, payload);
    this.publishedCommands.set(publicationKey, allocation.path);
    return allocation.path;
  }

  sweepCommands(now = Date.now()): { removed: string[]; files: number; bytes: number } {
    const removed: string[] = [];
    for (const item of this.commandFiles()) {
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
      unlinkSync(item.path);
      removed.push(item.path);
    }
    for (const [key, path] of this.publishedCommands) {
      if (!existsSync(path)) this.publishedCommands.delete(key);
    }
    return { removed, ...this.commandUsage() };
  }

  stats(): { commandFiles: number; commandBytes: number; cachedPublications: number; maxCommandFiles: number; maxCommandBytes: number } {
    const usage = this.commandUsage();
    return {
      commandFiles: usage.files,
      commandBytes: usage.bytes,
      cachedPublications: this.publishedCommands.size,
      maxCommandFiles: this.maxCommandFiles,
      maxCommandBytes: this.maxCommandBytes,
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

  private commandFiles(): Array<{ path: string; sequence: number; bytes: number }> {
    const files: Array<{ path: string; sequence: number; bytes: number }> = [];
    for (const entry of readdirSync(this.commandsDirectory, { withFileTypes: true })) {
      const match = /^(\d{12})-(?:capture|cancel)-[A-Za-z0-9_.-]+-\d+\.json$/.exec(entry.name);
      if (!entry.isFile() || entry.isSymbolicLink() || !match) continue;
      const path = join(this.commandsDirectory, entry.name);
      assertManagedPath(this.commandsDirectory, path);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      files.push({ path, sequence: Number(match[1]), bytes: info.size });
    }
    return files.sort((left, right) => left.sequence - right.sequence);
  }

  private commandUsage(): { files: number; bytes: number } {
    const files = this.commandFiles();
    return { files: files.length, bytes: files.reduce((total, item) => total + item.bytes, 0) };
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
