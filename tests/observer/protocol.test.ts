import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  JOB_STATES,
  artifactManifestSchema,
  cameraLeaseStatusSchema,
  captureRequestSchema,
  instanceRegistrationSchema,
  isRuntimeJobTransition,
  parseProtocolMessage,
  runtimeCommandEnvelopeSchema,
  sessionContractSchema,
} from "../../observer/protocol/index.js";
import { redactForDiagnostics } from "../../observer/agent/logger.js";
import { repositoryRoot } from "./helpers.js";

const examples = join(repositoryRoot, "observer", "protocol", "examples");

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

  it("accepts every failure code emitted by the runtime addon", () => {
    const runtimeService = readFileSync(join(
      repositoryRoot,
      "observer",
      "addon",
      "Scripts",
      "Game",
      "ReforgerForgeObserver",
      "RFO_ObserverService.c"
    ), "utf8");
    const emittedCodes = [
      ...runtimeService.matchAll(/RecordFailure\("([A-Z_]+)"/g),
      ...runtimeService.matchAll(/RejectCommand\([^,\r\n]+,\s*"([A-Z_]+)"/g),
      ...runtimeService.matchAll(/m_RFO_LastErrorCode\s*=\s*"([A-Z_]+)"/g),
      ...runtimeService.matchAll(/terminalErrorCode\s*=(?!=)\s*"([A-Z_]+)"/g),
    ].map((match) => match[1]);

    expect(emittedCodes.length).toBeGreaterThan(0);
    expect([...new Set(emittedCodes)].filter((code) => !ERROR_CODES.includes(
      code as (typeof ERROR_CODES)[number]
    ))).toEqual([]);
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
