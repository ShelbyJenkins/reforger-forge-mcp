import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { McpHostAdmissionGate } from "../src/mcp-host-admission.js";
import {
  MCP_IDLE_BLOCKER_CODES,
  McpIdleReadinessInspector,
  type IdleShutdownInspectionOptions,
  type McpIdleBlockerCode,
  type McpIdleProviderReadiness,
  type McpIdleReadinessProvider,
} from "../src/mcp-idle-readiness.js";

class Provider implements McpIdleReadinessProvider {
  revision = 0;
  calls = 0;

  constructor(
    private readonly inspect: (
      options: IdleShutdownInspectionOptions,
    ) => Promise<Omit<McpIdleProviderReadiness, "revision">>,
  ) {}

  currentIdleRevision(): number { return this.revision; }

  async inspectIdleShutdownReadiness(
    options: IdleShutdownInspectionOptions,
  ): Promise<McpIdleProviderReadiness> {
    this.calls += 1;
    const result = await this.inspect(options);
    return { ...result, revision: this.revision };
  }
}

function options(generation = 1, signal = new AbortController().signal): IdleShutdownInspectionOptions {
  return { deadlineTick: performance.now() + 1_000, signal, probeGeneration: generation };
}

describe("MCP idle readiness inspector", () => {
  it("bounds the current contract to blocker codes with implemented producers", () => {
    expect(MCP_IDLE_BLOCKER_CODES as readonly string[]).not.toContain("EXTERNAL_ACTIVATION");
  });

  it("threads a zero-seeded monotonic clock and a full future provider deadline", async () => {
    const gate = new McpHostAdmissionGate();
    let observedDeadline = -1;
    let observedNow = -1;
    const provider = new Provider(async (inspection) => {
      observedDeadline = inspection.deadlineTick;
      observedNow = inspection.nowTick?.() ?? -1;
      return { complete: true, blockers: [] };
    });
    const inspector = new McpIdleReadinessInspector({
      admissionGate: gate,
      providers: [provider],
      nowTick: () => 0,
    });

    const readiness = await inspector.inspectIdleShutdownReadiness({
      deadlineTick: 10_000,
      signal: new AbortController().signal,
      probeGeneration: 0,
    });

    expect(readiness.complete).toBe(true);
    expect(observedNow).toBe(0);
    expect(observedDeadline).toBe(5_000);
  });

  it("returns an opaque seal proof only for a complete blocker-free projection", async () => {
    const gate = new McpHostAdmissionGate();
    const provider = new Provider(async () => ({ complete: true, blockers: [] }));
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [provider] });
    const readiness = await inspector.inspectIdleShutdownReadiness(options());
    expect(readiness).toMatchObject({ complete: true, blockers: [], probeGeneration: 1 });
    expect(readiness.sealProof).not.toBeNull();
    expect(gate.trySealIdleAdmissions(readiness.sealProof)).toBe(true);
  });

  it("sorts and deduplicates fixed blocker codes without exposing provider details", async () => {
    const gate = new McpHostAdmissionGate();
    const blockers: McpIdleBlockerCode[] = [
      "OWNED_RUNTIME_LIVE",
      "OBSERVER_CAPTURE",
      "OWNED_RUNTIME_LIVE",
    ];
    const provider = new Provider(async () => ({ complete: true, blockers }));
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [provider] });
    const readiness = await inspector.inspectIdleShutdownReadiness(options());
    expect(readiness.blockers).toEqual(["OBSERVER_CAPTURE", "OWNED_RUNTIME_LIVE"]);
    expect(readiness.sealProof).toBeNull();
    expect(JSON.stringify(readiness)).not.toContain("provider");
  });

  it("preserves every diagnosed category when the bounded set is saturated by a duplicate", async () => {
    const gate = new McpHostAdmissionGate();
    const blockers: McpIdleBlockerCode[] = [
      ...MCP_IDLE_BLOCKER_CODES,
      MCP_IDLE_BLOCKER_CODES[0],
    ];
    const provider = new Provider(async () => ({ complete: true, blockers }));
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [provider] });

    const readiness = await inspector.inspectIdleShutdownReadiness(options());

    expect(readiness.complete).toBe(true);
    expect(readiness.blockers).toEqual([...MCP_IDLE_BLOCKER_CODES].sort());
    expect(readiness.blockers).not.toEqual(["INCOMPLETE_PROOF"]);
    expect(readiness.sealProof).toBeNull();
  });

  it("makes a concurrent host admission visible and refuses a proof", async () => {
    const gate = new McpHostAdmissionGate();
    const token = gate.acquire("active request");
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [] });
    const readiness = await inspector.inspectIdleShutdownReadiness(options());
    expect(readiness).toMatchObject({ complete: true, blockers: ["HOST_ADMISSION_ACTIVE"], sealProof: null });
    token.release();
  });

  it("makes disposer-authorized cleanup visible and refuses a proof", async () => {
    const gate = new McpHostAdmissionGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = gate.runPrivilegedCleanup(() => blocked);
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [] });

    const readiness = await inspector.inspectIdleShutdownReadiness(options());

    expect(readiness).toMatchObject({
      complete: true,
      blockers: ["HOST_ADMISSION_ACTIVE"],
      sealProof: null,
    });
    release();
    await cleanup;
  });

  it("revalidates provider revisions synchronously at seal", async () => {
    const gate = new McpHostAdmissionGate();
    const provider = new Provider(async () => ({ complete: true, blockers: [] }));
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [provider] });
    const readiness = await inspector.inspectIdleShutdownReadiness(options());
    provider.revision += 1;
    expect(gate.trySealIdleAdmissions(readiness.sealProof)).toBe(false);
    expect(gate.snapshot().state).toBe("open");
  });

  it("times out one physical scan and refuses overlapping race losers until it settles", async () => {
    const gate = new McpHostAdmissionGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const provider = new Provider(async () => {
      await blocked;
      return { complete: true, blockers: [] };
    });
    const inspector = new McpIdleReadinessInspector({
      admissionGate: gate,
      providers: [provider],
      maximumProbeMs: 10,
    });
    const first = await inspector.inspectIdleShutdownReadiness(options(1));
    expect(first).toMatchObject({ complete: false, blockers: ["INCOMPLETE_PROOF"], sealProof: null });
    const second = await inspector.inspectIdleShutdownReadiness(options(2));
    expect(second.complete).toBe(false);
    expect(provider.calls).toBe(1);
    release();
    await blocked;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await inspector.inspectIdleShutdownReadiness(options(3));
    expect(third.complete).toBe(true);
    expect(provider.calls).toBe(2);
  });

  it("fails closed for an already-aborted generation without invoking providers", async () => {
    const gate = new McpHostAdmissionGate();
    const provider = new Provider(async () => ({ complete: true, blockers: [] }));
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [provider] });
    const abort = new AbortController();
    abort.abort();
    const readiness = await inspector.inspectIdleShutdownReadiness(options(9, abort.signal));
    expect(readiness).toMatchObject({ complete: false, blockers: ["INCOMPLETE_PROOF"], probeGeneration: 9 });
    expect(provider.calls).toBe(0);
  });

  it("honors a caller abort while retaining the uncancellable physical scan", async () => {
    const gate = new McpHostAdmissionGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const provider = new Provider(async () => {
      await blocked;
      return { complete: true, blockers: [] };
    });
    const inspector = new McpIdleReadinessInspector({ admissionGate: gate, providers: [provider] });
    const abort = new AbortController();
    const inspection = inspector.inspectIdleShutdownReadiness(options(10, abort.signal));
    abort.abort();
    await expect(inspection).resolves.toMatchObject({
      complete: false,
      blockers: ["INCOMPLETE_PROOF"],
      probeGeneration: 10,
    });
    expect(provider.calls).toBe(1);
    await expect(inspector.inspectIdleShutdownReadiness(options(11))).resolves.toMatchObject({ complete: false });
    release();
    await blocked;
  });
});
