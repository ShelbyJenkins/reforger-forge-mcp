import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../protocol/index.js";
import { ArtifactStore } from "./artifacts.js";
import { ObserverError } from "./errors.js";
import { JobStore } from "./jobs.js";
import { observerLogger } from "./logger.js";
import { MailboxTransport } from "./mailbox.js";
import { assertManagedPath, ensureCanonicalDirectory } from "./paths.js";
import { InstanceRegistry } from "./registry.js";
import { SessionStore } from "./sessions.js";

type MailboxMessageKind = "registration" | "heartbeat" | "status" | "artifact";

export class MailboxCoordinator {
  private readonly transports = new Map<string, MailboxTransport>();
  private readonly rejectionAttempts = new Map<string, number>();
  private static readonly MAX_REJECTION_TRACKING = 512;
  private static readonly MAX_RETRIES = 3;

  constructor(
    private readonly sessions: SessionStore,
    private readonly registry: InstanceRegistry,
    private readonly jobs: JobStore,
    private readonly artifacts: ArtifactStore
  ) {}

  async pollOnce(): Promise<void> {
    for (const session of this.sessions.activeRecords()) {
      if (!session.transportPreference.includes("mailbox")) continue;
      const transport = this.transports.get(session.sessionId) ?? new MailboxTransport(session.profilePath);
      this.transports.set(session.sessionId, transport);
      await this.consumeIngress(session.sessionId, transport.statusDirectory);
      this.publishCommands(session.sessionId, transport);
    }
  }

  private async consumeIngress(sessionId: string, statusDirectory: string): Promise<void> {
    const entries = readdirSync(statusDirectory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".complete"))
      .sort((a, b) => this.eventSequence(a.name) - this.eventSequence(b.name) || a.name.localeCompare(b.name))
      .slice(0, 256);
    for (const entry of entries) {
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
        if (info.size < 2 || info.size > DEFAULT_LIMITS.maxRequestBodyBytes) throw new ObserverError("INVALID_REQUEST", "Mailbox ingress entry exceeds message bounds");
        const kind = this.kind(entry.name);
        if (!kind) throw new ObserverError("INVALID_REQUEST", "Mailbox ingress filename is invalid");
        const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        if (body.sessionId !== sessionId || typeof body.sessionToken !== "string") throw new ObserverError("UNAUTHORIZED", "Mailbox message session identity is invalid", 401);
        const token = body.sessionToken;
        delete body.sessionToken;
        if (kind === "registration") this.registry.register(body, token);
        else if (kind === "heartbeat") this.registry.heartbeat(body, token);
        else if (kind === "status") this.jobs.update(body, token);
        else await this.artifacts.intake(body, token);
        unlinkSync(path);
        unlinkSync(markerPath);
        this.rejectionAttempts.delete(markerPath);
      } catch (error) {
        const attempts = (this.rejectionAttempts.get(markerPath) ?? 0) + 1;
        this.rejectionAttempts.delete(markerPath);
        this.rejectionAttempts.set(markerPath, attempts);
        observerLogger.warn("mailbox ingress rejected", {
          sessionId,
          file: dataName,
          attempts,
          errorCode: error instanceof ObserverError ? error.code : "INVALID_REQUEST",
        });
        if (attempts >= MailboxCoordinator.MAX_RETRIES) {
          this.quarantine(statusDirectory, dataName, path, markerPath);
          this.rejectionAttempts.delete(markerPath);
        }
        while (this.rejectionAttempts.size > MailboxCoordinator.MAX_REJECTION_TRACKING) {
          const oldest = this.rejectionAttempts.keys().next().value as string | undefined;
          if (!oldest) break;
          this.rejectionAttempts.delete(oldest);
        }
      }
    }
  }

  private publishCommands(sessionId: string, transport: MailboxTransport): void {
    for (const instance of this.registry.forSession(sessionId)) {
      if (instance.registration.selectedTransport !== "mailbox" || this.registry.isStale(instance)) continue;
      try {
        const command = this.jobs.nextCommand(sessionId, instance.registration.instanceId, instance.registration.instanceNonce);
        if (command) transport.writeCommand(command);
      } catch (error) {
        if (!(error instanceof ObserverError) || !["INSTANCE_STALE", "INSTANCE_NOT_FOUND"].includes(error.code)) throw error;
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

  private quarantine(statusDirectory: string, dataName: string, path: string, markerPath: string): void {
    const quarantine = ensureCanonicalDirectory(join(statusDirectory, "quarantine"));
    assertManagedPath(statusDirectory, quarantine);
    const safeName = /^\d{12}-[A-Za-z0-9_.-]+$/.test(dataName)
      ? dataName
      : `invalid-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
    const target = join(quarantine, safeName);
    const targetMarker = `${target}.complete`;
    assertManagedPath(quarantine, target);
    assertManagedPath(quarantine, targetMarker);
    try {
      if (existsSync(path)) renameSync(path, target);
      if (existsSync(markerPath)) renameSync(markerPath, targetMarker);
    } catch {
      // If quarantine itself fails, remove neither entry. It will be retried on
      // a later bounded polling pass rather than risking unrelated files.
    }
  }
}
