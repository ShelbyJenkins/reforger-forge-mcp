import { createHash } from "node:crypto";
import { assertWorldRevision, type WorldRevision } from "./world-revision.js";
import { CaptureError, type CaptureInput, type CanonicalCaptureRequest, type CaptureView } from "./capture-contract.js";

function number(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new CaptureError("INVALID_REQUEST", `${label} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function view(input: CaptureView): CaptureView {
  if (input.kind === "current") return { kind: "current" };
  if (input.kind === "pose") {
    return {
      kind: "pose",
      position: input.position.map((v) => number(v, "view position")) as [number, number, number],
      orientation: input.orientation.map((v) => number(v, "view orientation")) as [number, number, number, number],
      fov: number(input.fov, "view fov"),
    };
  }
  return {
    kind: "lookAt",
    position: input.position.map((v) => number(v, "view position")) as [number, number, number],
    target: input.target.map((v) => number(v, "view target")) as [number, number, number],
    fov: number(input.fov, "view fov"),
  };
}

function boundedString(value: string | undefined, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > max) throw new CaptureError("INVALID_REQUEST", `${label} is invalid`);
  return value;
}

export interface ExpectedWorldBindingInput {
  expectedWorldRevision?: unknown;
}

export function resolveExpectedWorldRevision(input: ExpectedWorldBindingInput): WorldRevision {
  try {
    return assertWorldRevision(input.expectedWorldRevision, "expectedWorldRevision");
  } catch {
    throw new CaptureError(
      "INVALID_REQUEST",
      "observer_capture requires the expectedWorldRevision from the immediately preceding observer_instances result"
    );
  }
}

/** Normalize all semantic input before routing or idempotency lookup. */
export function normalizeCaptureRequest(input: CaptureInput, defaultTimeoutMs = 30_000): CanonicalCaptureRequest {
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) {
    throw new CaptureError("INVALID_REQUEST", "idempotencyKey is required and must be bounded");
  }
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 5 * 60_000) {
    throw new CaptureError("INVALID_REQUEST", "timeoutMs must be from 1000 through 300000 milliseconds");
  }
  if (input.performancePolicy === "performance") {
    throw new CaptureError("PERFORMANCE_POLICY_BLOCKED", "Performance capture requires an external measurement coordinator");
  }
  const settleFrames = input.settleFrames ?? 0;
  if (!Number.isSafeInteger(settleFrames) || settleFrames < 0 || settleFrames > 120) {
    throw new CaptureError("INVALID_REQUEST", "settleFrames is outside the supported range");
  }
  const runId = boundedString(input.runId, "runId", 128);
  const captureLabel = boundedString(input.captureLabel, "captureLabel", 128);
  if ((runId === undefined) !== (captureLabel === undefined)) {
    throw new CaptureError("INVALID_REQUEST", "runId and captureLabel must be supplied together");
  }
  const expectedWorldRevision = resolveExpectedWorldRevision(input);
  const normalized: Omit<CanonicalCaptureRequest, "fingerprint"> = {
    ...(input.sessionId !== undefined ? { sessionId: boundedString(input.sessionId, "sessionId", 96) } : {}),
    ...(input.instanceId !== undefined ? { instanceId: boundedString(input.instanceId, "instanceId", 96) } : {}),
    view: view(input.view),
    settleFrames,
    performancePolicy: input.performancePolicy ?? "evidence",
    timeoutMs,
    expectedWorldRevision,
    ...(runId ? { runId } : {}),
    ...(captureLabel ? { captureLabel } : {}),
    ...(input.purpose !== undefined ? { purpose: boundedString(input.purpose, "purpose", 512) } : {}),
    asynchronous: input.asynchronous === true,
  };
  const canonical = JSON.stringify(normalized);
  return { ...normalized, fingerprint: createHash("sha256").update(canonical, "utf8").digest("hex") };
}

export function idempotencyScope(input: Pick<CaptureInput, "idempotencyKey" | "sessionId" | "instanceId">): string {
  const scope = JSON.stringify({
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId ?? null,
  });
  return createHash("sha256").update(scope, "utf8").digest("hex");
}

export function canonicalRequestJson(input: CanonicalCaptureRequest): string {
  const { fingerprint: _fingerprint, ...request } = input;
  return JSON.stringify(request);
}
