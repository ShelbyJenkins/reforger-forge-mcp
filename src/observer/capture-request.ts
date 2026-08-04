import { createHash } from "node:crypto";
import { assertWorldRevision, type WorldRevision } from "./world-revision.js";
import { CaptureError, type CaptureInput, type CanonicalCaptureIntent, type CanonicalCaptureRequest, type CaptureView } from "./capture-contract.js";
import {
  IMAGE_OUTPUT_FORMATS,
  type CanonicalImageOutputPolicy,
  type ImageOutputRequest,
} from "../foundation/image-output.js";

export interface ImagePolicyDefaults {
  lossyQuality: number;
  minimumLossyQuality: number;
  maximumLossyQuality: number;
  maximumWidth: number;
  maximumHeight: number;
  maximumPixels: number;
}

export const DEFAULT_IMAGE_POLICY_LIMITS = Object.freeze({
  lossyQuality: 75,
  minimumLossyQuality: 1,
  maximumLossyQuality: 100,
  maximumWidth: 16_384,
  maximumHeight: 16_384,
  maximumPixels: 32_000_000,
} satisfies ImagePolicyDefaults);

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

function normalizeImagePolicy(
  input: ImageOutputRequest | undefined,
  defaults: ImagePolicyDefaults,
): CanonicalImageOutputPolicy {
  const format = input?.format ?? "png";
  if (!IMAGE_OUTPUT_FORMATS.includes(format)) {
    throw new CaptureError("INVALID_REQUEST", "image.format must be png, jpeg, or webp");
  }
  const dimension = (value: number | undefined, label: string, maximum: number): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new CaptureError("INVALID_REQUEST", `${label} must be from 1 through ${maximum}`);
    }
    return value;
  };
  const maxWidth = dimension(input?.maxWidth, "image.maxWidth", defaults.maximumWidth);
  const maxHeight = dimension(input?.maxHeight, "image.maxHeight", defaults.maximumHeight);
  if (maxWidth !== undefined && maxHeight !== undefined && maxWidth * maxHeight > defaults.maximumPixels) {
    throw new CaptureError("INVALID_REQUEST", `image dimensions exceed the ${defaults.maximumPixels}-pixel request limit`);
  }
  if (format === "png" && input?.quality !== undefined) {
    throw new CaptureError("INVALID_REQUEST", "image.quality is valid only for jpeg or webp output");
  }
  const quality = format === "png" ? undefined : input?.quality ?? defaults.lossyQuality;
  if (quality !== undefined && (!Number.isSafeInteger(quality) ||
      quality < defaults.minimumLossyQuality || quality > defaults.maximumLossyQuality)) {
    throw new CaptureError(
      "INVALID_REQUEST",
      `image.quality must be from ${defaults.minimumLossyQuality} through ${defaults.maximumLossyQuality}`,
    );
  }
  return {
    format,
    ...(maxWidth === undefined ? {} : { maxWidth }),
    ...(maxHeight === undefined ? {} : { maxHeight }),
    ...(quality === undefined ? {} : { quality }),
  };
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

/** Normalize only caller intent; renderer binding is deliberately resolved later. */
export function normalizeCaptureIntent(
  input: CaptureInput,
  defaultTimeoutMs = 30_000,
  imageDefaults: ImagePolicyDefaults = DEFAULT_IMAGE_POLICY_LIMITS,
): CanonicalCaptureIntent {
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
  if (!runId && captureLabel) {
    throw new CaptureError("INVALID_REQUEST", "captureLabel requires an explicit or active run");
  }
  const selectionMode = input.selectionMode ??
    (input.expectedWorldRevision !== undefined || input.sessionId !== undefined || input.instanceId !== undefined
      ? "explicit"
      : "delegated");
  const normalized: Omit<CanonicalCaptureIntent, "fingerprint"> = {
    selectionMode,
    view: view(input.view ?? { kind: "current" }),
    settleFrames,
    performancePolicy: input.performancePolicy ?? "evidence",
    image: normalizeImagePolicy(input.image, imageDefaults),
    timeoutMs,
    ...(runId ? { runId } : {}),
    ...(captureLabel ? { captureLabel } : {}),
    ...(input.purpose !== undefined ? { purpose: boundedString(input.purpose, "purpose", 512) } : {}),
    asynchronous: input.asynchronous === true,
  };
  const canonical = JSON.stringify(normalized);
  return { ...normalized, fingerprint: createHash("sha256").update(canonical, "utf8").digest("hex") };
}

export interface ResolvedCaptureBinding {
  sessionId?: string;
  instanceId: string;
  expectedWorldRevision: WorldRevision;
}

export function materializeCaptureRequest(
  intent: CanonicalCaptureIntent,
  binding: ResolvedCaptureBinding,
  captureLabel = intent.captureLabel,
): CanonicalCaptureRequest {
  const normalized = {
    ...(binding.sessionId !== undefined ? { sessionId: boundedString(binding.sessionId, "sessionId", 96) } : {}),
    instanceId: boundedString(binding.instanceId, "instanceId", 96)!,
    view: intent.view,
    settleFrames: intent.settleFrames,
    performancePolicy: intent.performancePolicy,
    image: intent.image,
    timeoutMs: intent.timeoutMs,
    expectedWorldRevision: assertWorldRevision(binding.expectedWorldRevision, "expectedWorldRevision"),
    ...(intent.runId ? { runId: intent.runId } : {}),
    ...(captureLabel ? { captureLabel: boundedString(captureLabel, "captureLabel", 128) } : {}),
    ...(intent.purpose ? { purpose: intent.purpose } : {}),
    asynchronous: intent.asynchronous,
    selectionMode: intent.selectionMode,
    intentFingerprint: intent.fingerprint,
  };
  const canonical = JSON.stringify(normalized);
  return { ...normalized, fingerprint: createHash("sha256").update(canonical, "utf8").digest("hex") };
}

/** Compatibility helper for already-resolved internal callers and tests. */
export function normalizeCaptureRequest(
  input: CaptureInput,
  defaultTimeoutMs = 30_000,
  imageDefaults: ImagePolicyDefaults = DEFAULT_IMAGE_POLICY_LIMITS,
): CanonicalCaptureRequest {
  const intent = normalizeCaptureIntent(input, defaultTimeoutMs, imageDefaults);
  const expectedWorldRevision = resolveExpectedWorldRevision(input);
  if (!input.instanceId) throw new CaptureError("INVALID_REQUEST", "instanceId is required for a resolved capture request");
  return materializeCaptureRequest(intent, {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    instanceId: input.instanceId,
    expectedWorldRevision,
  });
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
