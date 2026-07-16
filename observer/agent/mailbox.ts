import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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

export class MailboxTransport {
  readonly commandsDirectory: string;
  readonly statusDirectory: string;
  private commandSequence = 0;

  constructor(readonly profilePath: string) {
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
  }

  writeCommand(command: RuntimeCommandEnvelope): string {
    assertIdentifier(command.jobId, "Job ID");
    this.commandSequence += 1;
    const name = `${String(this.commandSequence).padStart(12, "0")}-${command.commandKind}-${command.jobId}-${command.deliveryAttempt}.json`;
    const path = join(this.commandsDirectory, name);
    atomicWriteJson(this.commandsDirectory, path, { sequence: this.commandSequence, ...command });
    return path;
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
}
