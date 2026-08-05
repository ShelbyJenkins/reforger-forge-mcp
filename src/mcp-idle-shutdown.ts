import { performance } from "node:perf_hooks";
import {
  MCP_IDLE_SHUTDOWN_MAX_MS,
  MCP_IDLE_SHUTDOWN_MIN_MS,
} from "./config.js";
import type { McpIdleSealProof } from "./mcp-host-admission.js";
import {
  type IdleShutdownInspectionOptions,
  type IdleShutdownReadiness,
  type McpIdleBlockerCode,
} from "./mcp-idle-readiness.js";
import {
  validateMcpHostIdentity,
  type McpHostIdentity,
} from "./mcp-host-identity.js";
import type { McpProtocolActivity } from "./mcp-activity-transport.js";

export const MCP_IDLE_READINESS_BUDGET_MS = 5_000;
export const MCP_IDLE_BLOCKED_RECHECK_MAX_MS = 30_000;

export interface ExternallyManagedMcpLifecycleDiagnostic {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly idleShutdownMs: number;
  readonly state: "externally_managed";
  readonly activeRequestCount: null;
  readonly lastActivityAt: null;
  readonly eligibleAt: null;
  readonly readinessComplete: null;
  readonly blockerCodes: readonly [];
}

export interface CliManagedMcpLifecycleDiagnostic {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly idleShutdownMs: number;
  readonly state: "monitoring" | "checking" | "blocked" | "shutdown_committed";
  readonly activeRequestCount: number;
  readonly lastActivityAt: string;
  readonly eligibleAt: string;
  readonly readinessComplete: boolean | null;
  readonly blockerCodes: readonly McpIdleBlockerCode[];
}

export type McpLifecycleDiagnostic =
  | ExternallyManagedMcpLifecycleDiagnostic
  | CliManagedMcpLifecycleDiagnostic;

export interface McpIdleReadinessPort {
  inspectIdleShutdownReadiness(
    options: IdleShutdownInspectionOptions,
  ): Promise<IdleShutdownReadiness>;
  trySealIdleAdmissions(proof: McpIdleSealProof | null | undefined): boolean;
}

export interface McpIdleShutdownTimer {
  unref?(): void;
}

export interface McpIdleShutdownControllerOptions {
  readonly hostIdentity: McpHostIdentity;
  readonly idleShutdownMs: number;
  readonly activity: McpProtocolActivity;
  readonly readiness: McpIdleReadinessPort;
  readonly shutdown: (reason: string) => Promise<void> | void;
  readonly nowTick?: () => number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => McpIdleShutdownTimer;
  readonly clearTimer?: (handle: McpIdleShutdownTimer) => void;
  readonly info?: (message: string) => void;
  readonly warn?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

function assertIdleShutdownMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < MCP_IDLE_SHUTDOWN_MIN_MS ||
      value > MCP_IDLE_SHUTDOWN_MAX_MS) {
    throw new TypeError(
      `MCP idle shutdown interval must be an integer from ${MCP_IDLE_SHUTDOWN_MIN_MS} through ${MCP_IDLE_SHUTDOWN_MAX_MS}.`
    );
  }
  return value;
}

function canonicalEligibleAt(lastActivityAt: string, idleShutdownMs: number): string {
  const milliseconds = Date.parse(lastActivityAt);
  if (!Number.isFinite(milliseconds)) throw new TypeError("MCP activity timestamp is invalid");
  return new Date(milliseconds + idleShutdownMs).toISOString();
}

function sortedBlockers(values: readonly McpIdleBlockerCode[]): readonly McpIdleBlockerCode[] {
  return Object.freeze([...new Set(values)].sort());
}

export function externallyManagedMcpLifecycleDiagnostic(
  hostIdentity: McpHostIdentity,
  idleShutdownMs: number,
): ExternallyManagedMcpLifecycleDiagnostic {
  const identity = validateMcpHostIdentity(hostIdentity);
  return Object.freeze({
    schemaVersion: 1,
    instanceId: identity.instanceId,
    idleShutdownMs: assertIdleShutdownMs(idleShutdownMs),
    state: "externally_managed",
    activeRequestCount: null,
    lastActivityAt: null,
    eligibleAt: null,
    readinessComplete: null,
    blockerCodes: Object.freeze([]) as readonly [],
  });
}

/** CLI-only actor that turns a complete Commit 14 proof into one shutdown call. */
export class McpIdleShutdownController {
  private readonly hostIdentity: McpHostIdentity;
  private readonly idleShutdownMs: number;
  private readonly activity: McpProtocolActivity;
  private readonly readiness: McpIdleReadinessPort;
  private readonly shutdown: (reason: string) => Promise<void> | void;
  private readonly nowTick: () => number;
  private readonly setTimer: NonNullable<McpIdleShutdownControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<McpIdleShutdownControllerOptions["clearTimer"]>;
  private readonly info: (message: string) => void;
  private readonly warn: (message: string) => void;
  private readonly debug: (message: string) => void;
  private readonly unsubscribeActivity: () => void;
  private timer: McpIdleShutdownTimer | null = null;
  private probe: { readonly generation: number; readonly controller: AbortController } | null = null;
  private probeGeneration = 0;
  private started = false;
  private cancelled = false;
  private state: CliManagedMcpLifecycleDiagnostic["state"] = "monitoring";
  private readinessComplete: boolean | null = null;
  private blockerCodes: readonly McpIdleBlockerCode[] = Object.freeze([]);
  private lastLoggedBlockers = "";

  constructor(options: McpIdleShutdownControllerOptions) {
    this.hostIdentity = validateMcpHostIdentity(options.hostIdentity);
    this.idleShutdownMs = assertIdleShutdownMs(options.idleShutdownMs);
    this.activity = options.activity;
    this.readiness = options.readiness;
    this.shutdown = options.shutdown;
    this.nowTick = options.nowTick ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.info = options.info ?? (() => undefined);
    this.warn = options.warn ?? (() => undefined);
    this.debug = options.debug ?? (() => undefined);
    this.unsubscribeActivity = this.activity.subscribe((kind) => this.onActivityEvent(kind));
  }

  start(): void {
    if (this.started || this.cancelled) return;
    if (!this.activity.snapshot().started) {
      throw new Error("MCP idle shutdown controller cannot start before the transport activity clock");
    }
    this.started = true;
    this.scheduleFromActivity();
  }

  cancel(reason = "external shutdown"): void {
    if (this.cancelled || this.state === "shutdown_committed") return;
    this.cancelled = true;
    this.clearScheduledTimer();
    this.probe?.controller.abort(new Error(`MCP idle shutdown cancelled: ${reason}`));
    this.probe = null;
    this.unsubscribeActivity();
  }

  diagnostic(): CliManagedMcpLifecycleDiagnostic {
    const snapshot = this.activity.snapshot();
    return Object.freeze({
      schemaVersion: 1,
      instanceId: this.hostIdentity.instanceId,
      idleShutdownMs: this.idleShutdownMs,
      state: this.state,
      activeRequestCount: snapshot.activeRequestCount,
      lastActivityAt: snapshot.lastActivityAt,
      eligibleAt: canonicalEligibleAt(snapshot.lastActivityAt, this.idleShutdownMs),
      readinessComplete: this.readinessComplete,
      blockerCodes: this.blockerCodes,
    });
  }

  /** Synchronous aggregate linearization used only after a complete pure proof. */
  tryCommitIdleShutdown(
    proof: McpIdleSealProof | null | undefined,
    activityEpoch: number,
  ): boolean {
    if (this.cancelled || this.state === "shutdown_committed" || !proof) return false;
    const snapshot = this.activity.snapshot();
    if (snapshot.activityEpoch !== activityEpoch || snapshot.activeRequestCount !== 0 ||
        snapshot.requestCompletionIndeterminate ||
        this.nowTick() < snapshot.lastActivityTick + this.idleShutdownMs ||
        !this.activity.canSealInboundDispatch(activityEpoch)) {
      return false;
    }
    if (!this.readiness.trySealIdleAdmissions(proof)) return false;
    // No callback can interleave in this synchronous turn after the host seal.
    this.activity.sealInboundDispatch();
    return true;
  }

  private onActivityEvent(kind: "activity" | "state" | "closed"): void {
    if (kind === "closed") {
      this.cancel("transport closed");
      return;
    }
    if (!this.started || this.cancelled || this.state === "shutdown_committed") return;
    if (kind === "activity") {
      this.probe?.controller.abort(new Error("MCP protocol activity superseded idle readiness"));
      this.state = "monitoring";
      this.readinessComplete = null;
      this.blockerCodes = Object.freeze([]);
      this.scheduleFromActivity();
      return;
    }
    const snapshot = this.activity.snapshot();
    if (this.timer === null && this.probe === null && snapshot.activeRequestCount === 0) {
      this.scheduleAt(snapshot.lastActivityTick + this.idleShutdownMs);
    }
  }

  private scheduleFromActivity(): void {
    const snapshot = this.activity.snapshot();
    this.scheduleAt(snapshot.lastActivityTick + this.idleShutdownMs);
  }

  private scheduleAt(deadlineTick: number): void {
    if (!this.started || this.cancelled || this.state === "shutdown_committed") return;
    this.clearScheduledTimer();
    const delay = Math.max(0, deadlineTick - this.nowTick());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.evaluate().catch((error) => {
        this.warn(`MCP idle readiness check failed closed: ${error instanceof Error ? error.message : String(error)}`);
        this.enterBlocked(false, ["INCOMPLETE_PROOF"]);
      });
    }, delay);
    this.timer.unref?.();
  }

  private clearScheduledTimer(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private async evaluate(): Promise<void> {
    if (this.cancelled || this.state === "shutdown_committed" || this.probe) return;
    const initial = this.activity.snapshot();
    const eligibleTick = initial.lastActivityTick + this.idleShutdownMs;
    if (this.nowTick() < eligibleTick) {
      this.scheduleAt(eligibleTick);
      return;
    }
    if (initial.requestCompletionIndeterminate) {
      this.enterBlocked(false, ["REQUEST_COMPLETION_INDETERMINATE"]);
      return;
    }
    if (initial.activeRequestCount !== 0) return;

    if (this.probeGeneration === Number.MAX_SAFE_INTEGER) {
      this.enterBlocked(false, ["INCOMPLETE_PROOF"]);
      return;
    }
    const activityEpoch = initial.activityEpoch;
    const controller = new AbortController();
    const generation = ++this.probeGeneration;
    const activeProbe = Object.freeze({ generation, controller });
    this.probe = activeProbe;
    this.state = "checking";
    this.readinessComplete = null;
    this.blockerCodes = Object.freeze([]);
    this.debug(`MCP idle readiness probe ${generation} started.`);

    let readiness: IdleShutdownReadiness;
    try {
      readiness = await this.readiness.inspectIdleShutdownReadiness({
        deadlineTick: this.nowTick() + MCP_IDLE_READINESS_BUDGET_MS,
        signal: controller.signal,
        probeGeneration: generation,
      });
    } catch {
      readiness = {
        complete: false,
        blockers: ["INCOMPLETE_PROOF"],
        probeGeneration: generation,
        sealProof: null,
      };
    } finally {
      if (this.probe === activeProbe) this.probe = null;
    }
    if (this.cancelled || controller.signal.aborted) return;

    const current = this.activity.snapshot();
    if (current.activityEpoch !== activityEpoch) {
      this.state = "monitoring";
      this.readinessComplete = null;
      this.blockerCodes = Object.freeze([]);
      this.scheduleFromActivity();
      return;
    }
    if (readiness.probeGeneration !== generation || !readiness.complete ||
        readiness.blockers.length > 0 || !readiness.sealProof) {
      this.enterBlocked(readiness.complete, readiness.blockers.length > 0
        ? readiness.blockers
        : ["INCOMPLETE_PROOF"]);
      return;
    }
    if (!this.tryCommitIdleShutdown(readiness.sealProof, activityEpoch)) {
      const afterCommit = this.activity.snapshot();
      if (afterCommit.activityEpoch !== activityEpoch) {
        this.state = "monitoring";
        this.readinessComplete = null;
        this.blockerCodes = Object.freeze([]);
        this.scheduleFromActivity();
      } else {
        this.enterBlocked(false, ["INCOMPLETE_PROOF"]);
      }
      return;
    }

    this.clearScheduledTimer();
    this.state = "shutdown_committed";
    this.readinessComplete = true;
    this.blockerCodes = Object.freeze([]);
    this.unsubscribeActivity();
    this.info(`MCP idle shutdown committed for instance ${this.hostIdentity.instanceId}.`);
    try {
      await this.shutdown("idle timeout");
    } catch (error) {
      this.warn(`MCP idle shutdown orchestration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private enterBlocked(
    complete: boolean,
    blockers: readonly McpIdleBlockerCode[],
  ): void {
    if (this.cancelled || this.state === "shutdown_committed") return;
    this.state = "blocked";
    this.readinessComplete = complete;
    this.blockerCodes = sortedBlockers(blockers);
    const signature = this.blockerCodes.join(",");
    if (signature !== this.lastLoggedBlockers) {
      this.lastLoggedBlockers = signature;
      this.info(`MCP idle shutdown blocked: ${signature || "INCOMPLETE_PROOF"}.`);
    } else {
      this.debug(`MCP idle shutdown remains blocked: ${signature || "INCOMPLETE_PROOF"}.`);
    }
    this.scheduleAt(this.nowTick() + Math.min(this.idleShutdownMs, MCP_IDLE_BLOCKED_RECHECK_MAX_MS));
  }
}
