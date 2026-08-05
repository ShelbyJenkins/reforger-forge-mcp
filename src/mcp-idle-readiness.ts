import { performance } from "node:perf_hooks";
import {
  McpHostAdmissionGate,
  type McpAdmissionRevisionSnapshot,
  type McpAdmissionRevisionSource,
  type McpIdleSealProof,
} from "./mcp-host-admission.js";

export const MCP_IDLE_BLOCKER_CODES = Object.freeze([
  "EXTERNAL_ACTIVATION",
  "HOST_ADMISSION_ACTIVE",
  "INCOMPLETE_PROOF",
  "OBSERVER_CAPTURE",
  "OBSERVER_CHILD",
  "OBSERVER_RESTORATION",
  "OWNED_RUNTIME_LIVE",
  "OWNED_RUNTIME_PREPARATION",
  "OWNED_RUNTIME_RECOVERY",
  "OWNED_RUNTIME_START",
  "WORKBENCH_ACTIVITY",
  "WORKBENCH_OWNERSHIP",
  "WORKBENCH_RECOVERY",
] as const);

export type McpIdleBlockerCode = typeof MCP_IDLE_BLOCKER_CODES[number];

export interface IdleShutdownInspectionOptions {
  /** Absolute monotonic tick, normally `performance.now() + 5000`. */
  readonly deadlineTick: number;
  readonly signal: AbortSignal;
  readonly probeGeneration: number;
}

export interface McpIdleProviderReadiness {
  readonly complete: boolean;
  readonly blockers: readonly McpIdleBlockerCode[];
  /** Captured after this provider's inspection has settled. */
  readonly revision: number;
}

export interface McpIdleReadinessProvider extends McpAdmissionRevisionSource {
  inspectIdleShutdownReadiness(
    options: IdleShutdownInspectionOptions,
  ): Promise<McpIdleProviderReadiness>;
}

export interface IdleShutdownReadiness {
  readonly complete: boolean;
  readonly blockers: readonly McpIdleBlockerCode[];
  readonly probeGeneration: number;
  /** Opaque same-process proof; null unless the complete projection is idle. */
  readonly sealProof: McpIdleSealProof | null;
}

export interface McpIdleReadinessInspectorOptions {
  readonly admissionGate: McpHostAdmissionGate;
  readonly providers: readonly McpIdleReadinessProvider[];
  readonly nowTick?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly maximumProbeMs?: number;
}

const blockerSet = new Set<string>(MCP_IDLE_BLOCKER_CODES);
const MAX_BLOCKERS = MCP_IDLE_BLOCKER_CODES.length;

/** Small provider-side revision helper for state that may change in callbacks. */
export class McpIdleRevision implements McpAdmissionRevisionSource {
  private revision = 0;

  currentIdleRevision(): number {
    return this.revision;
  }

  bump(): number {
    if (this.revision === Number.MAX_SAFE_INTEGER) throw new Error("MCP idle provider revision exhausted");
    this.revision += 1;
    return this.revision;
  }
}

function incomplete(probeGeneration: number): IdleShutdownReadiness {
  return Object.freeze({
    complete: false,
    blockers: Object.freeze(["INCOMPLETE_PROOF"] as McpIdleBlockerCode[]),
    probeGeneration,
    sealProof: null,
  });
}

function normalizedBlockers(values: readonly McpIdleBlockerCode[]): McpIdleBlockerCode[] | null {
  const unique = new Set<McpIdleBlockerCode>();
  for (const value of values) {
    if (!blockerSet.has(value) || unique.size >= MAX_BLOCKERS) return null;
    unique.add(value);
  }
  return [...unique].sort();
}

/** Bounded aggregate proof with at most one unsettled physical provider scan. */
export class McpIdleReadinessInspector {
  private readonly admissionGate: McpHostAdmissionGate;
  private readonly providers: readonly McpIdleReadinessProvider[];
  private readonly nowTick: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly maximumProbeMs: number;
  private physicalProbe: Promise<void> | null = null;

  constructor(options: McpIdleReadinessInspectorOptions) {
    this.admissionGate = options.admissionGate;
    this.providers = Object.freeze([...options.providers]);
    this.nowTick = options.nowTick ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.maximumProbeMs = options.maximumProbeMs ?? 5_000;
    if (!Number.isFinite(this.maximumProbeMs) || this.maximumProbeMs <= 0 || this.maximumProbeMs > 5_000) {
      throw new TypeError("MCP idle readiness maximum probe duration must be within 1 through 5000ms.");
    }
  }

  async inspectIdleShutdownReadiness(
    options: IdleShutdownInspectionOptions,
  ): Promise<IdleShutdownReadiness> {
    if (!Number.isFinite(options.deadlineTick) || !Number.isSafeInteger(options.probeGeneration) ||
        options.probeGeneration < 0) {
      return incomplete(options.probeGeneration);
    }
    const effectiveDeadline = Math.min(options.deadlineTick, this.nowTick() + this.maximumProbeMs);
    if (options.signal.aborted || effectiveDeadline <= this.nowTick()) return incomplete(options.probeGeneration);
    // An uncancellable late scan remains the sole physical probe until it
    // settles. Reporting incomplete here avoids accumulating race losers.
    if (this.physicalProbe) return incomplete(options.probeGeneration);

    const controller = new AbortController();
    let resolveInterrupted!: () => void;
    const interrupted = new Promise<null>((resolve) => {
      resolveInterrupted = () => resolve(null);
    });
    const abort = (): void => {
      controller.abort(options.signal.reason);
      resolveInterrupted();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const providerOptions: IdleShutdownInspectionOptions = Object.freeze({
      deadlineTick: effectiveDeadline,
      signal: controller.signal,
      probeGeneration: options.probeGeneration,
    });
    let resolvePhysical!: () => void;
    this.physicalProbe = new Promise<void>((resolve) => { resolvePhysical = resolve; });

    const scan = Promise.all(this.providers.map((provider) =>
      provider.inspectIdleShutdownReadiness(providerOptions).then((result) => ({ provider, result })),
    ));
    void scan.then(resolvePhysical, resolvePhysical).finally(() => {
      this.physicalProbe = null;
    });

    let timer: unknown;
    const timedOut = new Promise<null>((resolve) => {
      timer = this.setTimer(() => {
        controller.abort(new Error("MCP idle readiness deadline expired"));
        resolve(null);
      }, Math.max(0, effectiveDeadline - this.nowTick()));
    });

    let settled: Awaited<typeof scan> | null;
    try {
      settled = await Promise.race([scan, timedOut, interrupted]);
    } catch {
      settled = null;
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
      options.signal.removeEventListener("abort", abort);
    }
    if (settled === null || controller.signal.aborted || this.nowTick() > effectiveDeadline) {
      return incomplete(options.probeGeneration);
    }

    const providerSnapshots: McpAdmissionRevisionSnapshot[] = [];
    const blockers: McpIdleBlockerCode[] = [];
    let complete = true;
    for (const { provider, result } of settled) {
      const normalized = normalizedBlockers(result.blockers);
      if (!normalized || !Number.isSafeInteger(result.revision) || result.revision < 0) {
        complete = false;
        continue;
      }
      if (!result.complete) complete = false;
      blockers.push(...normalized);
      providerSnapshots.push({ source: provider, revision: result.revision });
    }
    const gate = this.admissionGate.snapshot();
    if (gate.activeTokens !== 0 || gate.state !== "open") blockers.push("HOST_ADMISSION_ACTIVE");
    if (!complete) blockers.push("INCOMPLETE_PROOF");
    const normalized = normalizedBlockers(blockers) ?? ["INCOMPLETE_PROOF"];
    const sealProof = complete && normalized.length === 0 && providerSnapshots.length === this.providers.length
      ? this.admissionGate.issueIdleSealProof(providerSnapshots)
      : null;
    return Object.freeze({
      complete,
      blockers: Object.freeze(normalized),
      probeGeneration: options.probeGeneration,
      sealProof,
    });
  }
}
