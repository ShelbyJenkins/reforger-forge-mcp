import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ERROR_REGISTRY,
  RUNTIME_ERROR_CODES,
  CAPABILITIES,
  CAPABILITY_REGISTRY,
  JOB_STATES,
  OBSERVER_ENFORCE_CONTRACT,
  OBSERVER_TERMINAL_STATES,
  PROTOCOL_VERSION,
  TERMINAL_JOB_STATES,
  WORKBENCH_ADAPTER_CAPABILITIES,
  WORKBENCH_ADAPTER_ERROR_CODES,
  WORKBENCH_ADAPTER_PROTOCOL,
  WORKBENCH_ADAPTER_STATE_VALUES,
  WORKBENCH_ADAPTER_TERMINAL_STATES,
  WORKBENCH_OBSERVER_ADAPTER_PROTOCOL,
  artifactManifestSchema,
  cameraLeaseStatusSchema,
  captureRequestSchema,
  heartbeatSchema,
  instanceRegistrationSchema,
  isRuntimeJobTransition,
  parseProtocolMessage,
  runtimeCommandEnvelopeSchema,
  sessionContractSchema,
  jobStatusSchema,
} from "../../observer/protocol/index.js";
import { redactForDiagnostics } from "../../observer/agent/logger.js";
import { WORKBENCH_HELPER_PROTOCOL_VERSION } from "../../src/workbench/helper-addon.js";
import { repositoryRoot } from "../support/observer-fixtures.js";

const examples = join(repositoryRoot, "observer", "protocol", "examples");

function targetValues(target: "game" | "workbench", prefix: string): string[] {
  return OBSERVER_ENFORCE_CONTRACT.targets[target].strings
    .filter((entry) => entry.field.startsWith(prefix))
    .map((entry) => entry.value);
}

describe("observer protocol", () => {
  it.each([
    ["session-contract.json", sessionContractSchema],
    ["graphical-instance.json", instanceRegistrationSchema],
    ["headless-instance.json", instanceRegistrationSchema],
    ["look-at-capture.json", captureRequestSchema],
    ["completed-capture.json", artifactManifestSchema],
  ])("validates %s", (name, schema) => {
    expect(schema.safeParse(JSON.parse(readFileSync(join(examples, name), "utf8"))).success).toBe(true);
  });

  it("returns a stable protocol mismatch instead of raw validation prose", () => {
    const value = JSON.parse(readFileSync(join(examples, "session-contract.json"), "utf8"));
    value.protocolVersion = "2.0";
    const parsed = parseProtocolMessage(sessionContractSchema, value);
    expect(parsed).toMatchObject({ success: false, error: { code: "PROTOCOL_MISMATCH" } });
  });

  it("tolerates compatible unknown optional fields", () => {
    const value = JSON.parse(readFileSync(join(examples, "session-contract.json"), "utf8"));
    value.futureOptional = { enabled: true };
    expect(sessionContractSchema.parse(value).futureOptional).toEqual({ enabled: true });
  });

  it("keeps session policy limits on the integer JSON wire shape required by the runtime", () => {
    const value = JSON.parse(readFileSync(join(examples, "session-contract.json"), "utf8"));
    value.limits.minFov = 10.5;
    expect(sessionContractSchema.safeParse(value).success).toBe(false);
    value.limits.minFov = 10;
    value.limits.maxCaptureDistance = 99999.5;
    expect(sessionContractSchema.safeParse(value).success).toBe(false);
  });

  it("rejects non-finite view numbers and degenerate look vectors", () => {
    const value = JSON.parse(readFileSync(join(examples, "look-at-capture.json"), "utf8"));
    value.view.target = [...value.view.position];
    expect(captureRequestSchema.safeParse(value).success).toBe(false);
    value.view.target = [Number.POSITIVE_INFINITY, 0, 0];
    expect(captureRequestSchema.safeParse(value).success).toBe(false);
  });

  it("defines capture and cancellation delivery envelopes with opaque leases", () => {
    const request = JSON.parse(readFileSync(join(examples, "look-at-capture.json"), "utf8"));
    const delivery = {
      ...request,
      commandKind: "capture",
      deliveryAttempt: 1,
      deliveryToken: "opaque_delivery_token_1234567890",
      deliveryLeaseExpiresAt: "2026-07-16T20:00:05.000Z",
      wireView: {
        position: request.view.position.map(String),
        orientation: [],
        target: request.view.target.map(String),
        fov: String(request.view.fov),
      },
    };
    expect(runtimeCommandEnvelopeSchema.safeParse(delivery).success).toBe(true);
    expect(runtimeCommandEnvelopeSchema.safeParse({ ...delivery, commandKind: "cancel" }).success).toBe(false);
    expect(runtimeCommandEnvelopeSchema.safeParse({
      ...delivery,
      commandKind: "cancel",
      cancellationRequestedAt: "2026-07-16T20:00:01.000Z",
    }).success).toBe(true);
    expect(runtimeCommandEnvelopeSchema.safeParse({ ...delivery, deliveryAttempt: 0 }).success).toBe(false);
    expect(runtimeCommandEnvelopeSchema.safeParse({
      ...delivery,
      wireView: { ...delivery.wireView, fov: "66" },
    }).success).toBe(false);
  });

  it("requires explicit, internally consistent camera lease evidence", () => {
    expect(cameraLeaseStatusSchema.safeParse({ held: true, leaseId: "lease-1", observerCameraId: 42 }).success).toBe(true);
    expect(cameraLeaseStatusSchema.safeParse({ held: true, leaseId: "lease-1" }).success).toBe(false);
    expect(cameraLeaseStatusSchema.safeParse({ held: false, restorationConfirmed: true }).success).toBe(true);
    expect(cameraLeaseStatusSchema.safeParse({ held: false }).success).toBe(false);
  });

  it("publishes an explicit transition graph instead of numeric state ordering", () => {
    expect(JOB_STATES).toContain("dispatched");
    expect(isRuntimeJobTransition("dispatched", "accepted")).toBe(true);
    expect(isRuntimeJobTransition("queued", "capturing")).toBe(false);
    expect(isRuntimeJobTransition("accepted", "awaitingArtifact")).toBe(false);
    expect(isRuntimeJobTransition("restoring", "restoring")).toBe(true);
  });

  it("keeps the stable error vocabulary unique", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toContain("WORLD_CHANGED");
    expect(ERROR_CODES).toContain("CAMERA_OWNERSHIP_LOST");
    expect(ERROR_CODES).toContain("STAGED_ADDON_CONFLICT");
  });

  it("restricts runtime-originated status errors to the registry's runtime backend", () => {
    const heartbeat = {
      protocolVersion: "1.0",
      sessionId: "session-1",
      instanceId: "instance-1",
      instanceNonce: "instance_nonce_123456789012345678901234",
      sequence: 1,
      sentAt: "2026-07-18T12:00:00.000Z",
      worldId: null,
      worldEpoch: 0,
      capabilities: ["render.capture"],
      transportHealthy: false,
      lastErrorCode: "CAMERA_BUSY",
    };
    const failedStatus = {
      protocolVersion: "1.0",
      sessionId: "session-1",
      instanceId: "instance-1",
      instanceNonce: heartbeat.instanceNonce,
      jobId: "job-1",
      sequence: 2,
      state: "failed",
      worldId: null,
      worldEpoch: 0,
      timestamp: "2026-07-18T12:00:01.000Z",
      deliveryToken: "delivery_token_1234567890",
      cameraLease: { held: false, restorationConfirmed: true },
      errorCode: "CAMERA_BUSY",
    };
    expect(heartbeatSchema.safeParse(heartbeat).success).toBe(true);
    expect(jobStatusSchema.safeParse(failedStatus).success).toBe(true);
    expect(heartbeatSchema.safeParse({
      ...heartbeat,
      lastErrorCode: "STORAGE_UNVERIFIABLE",
    }).success).toBe(false);
    expect(jobStatusSchema.safeParse({
      ...failedStatus,
      errorCode: "STORAGE_UNVERIFIABLE",
    }).success).toBe(false);
    expect(RUNTIME_ERROR_CODES.every((code) =>
      ERROR_REGISTRY[code].backends.includes("runtime" as never))).toBe(true);
  });

  it("registers metadata for every public code and only proven capabilities", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_REGISTRY[code].backends.length).toBeGreaterThan(0);
      expect(ERROR_REGISTRY[code].publicMessage.length).toBeGreaterThan(0);
      expect(["bounded-diagnostic", "fixed"]).toContain(ERROR_REGISTRY[code].publicMessagePolicy);
      expect(typeof ERROR_REGISTRY[code].retryable).toBe("boolean");
    }
    expect(CAPABILITIES).toContain("camera.editor");
    expect(CAPABILITIES).not.toContain("entity.resolve" as (typeof CAPABILITIES)[number]);
    expect(CAPABILITIES).not.toContain("server.coordinate" as (typeof CAPABILITIES)[number]);
    expect(CAPABILITY_REGISTRY["camera.editor"].backends).toEqual(["workbench"]);
    expect(CAPABILITY_REGISTRY["camera.runtime"].backends).toEqual(["runtime"]);
    expect(ERROR_REGISTRY.CAMERA_BUSY.backends).toContain("owned-runtime");
  });

  it("keeps the runtime, adapter, and helper-bundle protocol identities independent", () => {
    const identities = OBSERVER_ENFORCE_CONTRACT.identities;

    expect(identities.runtimeObserver).toBe(PROTOCOL_VERSION);
    expect(identities.workbenchAdapter).toBe(WORKBENCH_OBSERVER_ADAPTER_PROTOCOL);
    expect(identities.workbenchAdapter).toBe(WORKBENCH_ADAPTER_PROTOCOL);
    expect(identities.workbenchHelperBundle).toBe(WORKBENCH_HELPER_PROTOCOL_VERSION);
    expect(new Set(Object.values(identities)).size).toBe(3);
    expect(targetValues("game", "RUNTIME_PROTOCOL_")).toEqual([PROTOCOL_VERSION]);
    expect(targetValues("workbench", "ADAPTER_PROTOCOL")).toEqual([
      WORKBENCH_OBSERVER_ADAPTER_PROTOCOL,
    ]);
  });

  it("derives target-specific state, error, and capability membership from canonical vocabularies", () => {
    const runtimeErrors = Object.entries(ERROR_REGISTRY)
      .filter(([, definition]) => definition.backends.includes("runtime" as never))
      .map(([code]) => code);
    const workbenchErrors = Object.entries(ERROR_REGISTRY)
      .filter(([, definition]) => definition.backends.includes("workbench" as never))
      .map(([code]) => code);
    const runtimeCapabilities = Object.entries(CAPABILITY_REGISTRY)
      .filter(([, definition]) => definition.backends.includes("runtime" as never))
      .map(([capability]) => capability);
    const workbenchCapabilities = Object.entries(CAPABILITY_REGISTRY)
      .filter(([, definition]) => definition.backends.includes("workbench" as never))
      .map(([capability]) => capability);
    // The Workbench response surface is a deliberate subset of the canonical
    // job order plus every canonical terminal state. Keep this expectation
    // derived so a spelling change cannot be hidden by a second copied list.
    const workbenchResponseStateIndexes = new Set([2, 7, 8, 9, 10]);
    const workbenchResponseStates = JOB_STATES.filter((state, index) =>
      workbenchResponseStateIndexes.has(index) || TERMINAL_JOB_STATES.includes(state as never)
    );

    expect(targetValues("game", "STATE_")).toEqual(JOB_STATES);
    expect(targetValues("workbench", "STATE_")).toEqual(workbenchResponseStates);
    expect(OBSERVER_ENFORCE_CONTRACT.terminalStates).toEqual(TERMINAL_JOB_STATES);
    expect(OBSERVER_TERMINAL_STATES).toEqual(TERMINAL_JOB_STATES);
    expect(WORKBENCH_ADAPTER_TERMINAL_STATES).toEqual(TERMINAL_JOB_STATES);
    expect(targetValues("game", "ERROR_")).toEqual(runtimeErrors);
    expect(targetValues("workbench", "ERROR_")).toEqual(workbenchErrors);
    expect(targetValues("game", "CAP_")).toEqual(runtimeCapabilities);
    expect(targetValues("workbench", "CAP_")).toEqual(workbenchCapabilities);
    expect(Object.values(WORKBENCH_ADAPTER_ERROR_CODES)).toEqual(workbenchErrors);
    expect(Object.values(WORKBENCH_ADAPTER_CAPABILITIES)).toEqual(workbenchCapabilities);
    expect(Object.values(WORKBENCH_ADAPTER_STATE_VALUES)).toEqual(workbenchResponseStates);
  });

  it("redacts contract bodies, nonce credentials, bearer headers, and named token values from diagnostics", () => {
    expect(redactForDiagnostics({
      contract: { sessionId: "must-not-appear", publicMetadata: "also-hidden" },
      launchNonce: "launch-secret",
      instanceNonce: "instance-secret",
      sessionToken: "secret",
      header: "Bearer abc.def",
    })).toEqual({
      contract: "[REDACTED]",
      launchNonce: "[REDACTED]",
      instanceNonce: "[REDACTED]",
      sessionToken: "[REDACTED]",
      header: "Bearer [REDACTED]",
    });
  });
});
