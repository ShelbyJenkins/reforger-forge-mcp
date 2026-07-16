import { z } from "zod";
import {
  ADDON_VERSION,
  CAPABILITIES,
  DEFAULT_LIMITS,
  ERROR_CODES,
  IDENTIFIER_PATTERN,
  JOB_STATES,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  SESSION_DIRECTORY_NAME,
  SHA256_PATTERN,
  TERMINAL_JOB_STATES,
  TRANSPORTS,
  type ObserverErrorCode,
} from "./constants.js";

const finiteNumber = z.number().finite();
const vector3 = z.tuple([finiteNumber, finiteNumber, finiteNumber]);
const quaternion = z.tuple([finiteNumber, finiteNumber, finiteNumber, finiteNumber]);
const identifier = z.string().regex(IDENTIFIER_PATTERN);
const isoTimestamp = z.string().datetime({ offset: true });
const protocolVersion = z.string().regex(/^\d+\.\d+$/);
const bundleDigest = z.string().regex(SHA256_PATTERN);
const boundedString = z.string().max(512);

export const limitsSchema = z.object({
  maxPendingJobs: z.number().int().min(1).max(64),
  maxCaptureRatePerMinute: z.number().int().min(1).max(600),
  maxArtifactBytes: z.number().int().min(1024).max(DEFAULT_LIMITS.maxArtifactBytes),
  minFov: z.number().int().min(1).max(179),
  maxFov: z.number().int().min(1).max(179),
  maxSettleFrames: z.number().int().min(0).max(DEFAULT_LIMITS.maxSettleFrames),
  maxCaptureDistance: z.number().int().min(1).max(DEFAULT_LIMITS.maxCaptureDistance),
}).refine((value) => value.minFov < value.maxFov, {
  message: "minFov must be less than maxFov",
  path: ["minFov"],
});

export const sessionContractSchema = z.object({
  protocolVersion,
  addonVersion: z.string().min(1).max(32),
  bundleDigest,
  sessionId: identifier,
  launchNonce: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  sessionToken: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  createdAt: isoTimestamp,
  expiresAt: isoTimestamp,
  expiresAtUnix: z.number().int().positive().optional(),
  agent: z.object({
    host: z.enum(["127.0.0.1", "::1"]),
    port: z.number().int().min(1).max(65535),
    instanceId: identifier,
  }),
  buildIdentity: bundleDigest,
  expectedRuntimeKind: z.enum(["client", "listenServer", "dedicated", "workbench", "testRunner"]),
  transportPreference: z.array(z.enum(TRANSPORTS)).min(1).max(2),
  profileDirectoryName: z.literal(SESSION_DIRECTORY_NAME),
  limits: limitsSchema,
}).passthrough().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "expiresAt must be after createdAt" });
  }
});

export const instanceRegistrationSchema = z.object({
  protocolVersion,
  addonVersion: z.string().min(1).max(32),
  bundleDigest,
  buildIdentity: bundleDigest,
  agentInstanceId: identifier,
  sessionId: identifier,
  launchNonce: z.string().min(32).max(256),
  instanceId: identifier,
  instanceNonce: z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/),
  processId: z.number().int().positive().optional(),
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "workbench", "testRunner"]),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  selectedTransport: z.enum(TRANSPORTS),
  headless: z.boolean(),
  worldId: boundedString.min(1).nullable(),
  worldEpoch: z.number().int().nonnegative(),
  registeredAt: isoTimestamp,
}).passthrough();

export const heartbeatSchema = z.object({
  protocolVersion,
  sessionId: identifier,
  instanceId: identifier,
  instanceNonce: z.string().min(32).max(256),
  sequence: z.number().int().nonnegative(),
  sentAt: isoTimestamp,
  worldId: boundedString.min(1).nullable(),
  worldEpoch: z.number().int().nonnegative(),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  activeJobId: identifier.nullable().optional(),
  cameraLeaseJobId: identifier.nullable().optional(),
  transportHealthy: z.boolean(),
  lastErrorCode: z.enum(ERROR_CODES).nullable().optional(),
}).passthrough();

export const currentViewSchema = z.object({ kind: z.literal("current") }).passthrough();
export const poseViewSchema = z.object({
  kind: z.literal("pose"),
  position: vector3,
  orientation: quaternion,
  fov: finiteNumber.min(1).max(179),
}).passthrough().refine((value) => {
  const length = Math.hypot(...value.orientation);
  return length > 0.000001 && Math.abs(length - 1) < 0.01;
}, { message: "orientation must be a normalized non-zero quaternion", path: ["orientation"] });
export const lookAtViewSchema = z.object({
  kind: z.literal("lookAt"),
  position: vector3,
  target: vector3,
  fov: finiteNumber.min(1).max(179),
}).passthrough().refine((value) => Math.hypot(
  value.target[0] - value.position[0],
  value.target[1] - value.position[1],
  value.target[2] - value.position[2]
) > 0.000001, { message: "lookAt position and target must differ", path: ["target"] });

export const captureRequestSchema = z.object({
  protocolVersion,
  jobId: identifier,
  idempotencyKey: z.string().min(1).max(128),
  instanceId: identifier.optional(),
  worldEpoch: z.number().int().nonnegative().optional(),
  deadlineAt: isoTimestamp,
  view: z.union([currentViewSchema, poseViewSchema, lookAtViewSchema]),
  settleFrames: z.number().int().min(0).max(DEFAULT_LIMITS.maxSettleFrames),
  performancePolicy: z.enum(["evidence", "instrumented", "performance"]),
}).passthrough();

const deliveryToken = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);
const decimalWireValue = z.string().min(1).max(32).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,9})?$/);

const runtimeWireViewSchema = z.object({
  position: z.array(decimalWireValue).max(3),
  orientation: z.array(decimalWireValue).max(4),
  target: z.array(decimalWireValue).max(3),
  fov: decimalWireValue,
}).strict();

function wireNumbersMatch(encoded: readonly string[], expected: readonly number[]): boolean {
  return encoded.length === expected.length && encoded.every((value, index) =>
    Math.abs(Number(value) - expected[index]) <= 1e-8
  );
}

/**
 * Commands retain the complete capture request at the top level for transport
 * compatibility, while the command kind and delivery lease make dispatch
 * explicit and safely redeliverable. Cancellation therefore identifies the
 * exact capture transaction it supersedes without introducing an unrelated
 * message shape.
 */
export const runtimeCommandEnvelopeSchema = captureRequestSchema.extend({
  commandKind: z.enum(["capture", "cancel"]),
  deliveryAttempt: z.number().int().positive(),
  deliveryToken,
  deliveryLeaseExpiresAt: isoTimestamp,
  cancellationRequestedAt: isoTimestamp.optional(),
  /** Canonical decimal strings for Enforce's token-type-strict JSON binder. */
  wireView: runtimeWireViewSchema,
}).superRefine((value, context) => {
  if (value.commandKind === "cancel" && !value.cancellationRequestedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cancellationRequestedAt"],
      message: "cancel command requires cancellationRequestedAt",
    });
  }
  const position = value.view.kind === "current" ? [] : value.view.position;
  const orientation = value.view.kind === "pose" ? value.view.orientation : [];
  const target = value.view.kind === "lookAt" ? value.view.target : [];
  const fov = value.view.kind === "current" ? 0 : value.view.fov;
  if (!wireNumbersMatch(value.wireView.position, position) ||
      !wireNumbersMatch(value.wireView.orientation, orientation) ||
      !wireNumbersMatch(value.wireView.target, target) ||
      Math.abs(Number(value.wireView.fov) - fov) > 1e-8) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["wireView"],
      message: "wireView must numerically match the validated capture view",
    });
  }
});

export const cameraLeaseStatusSchema = z.discriminatedUnion("held", [
  z.object({
    held: z.literal(true),
    leaseId: identifier,
    observerCameraId: z.union([identifier, z.number().int().nonnegative()]),
  }).passthrough(),
  z.object({
    held: z.literal(false),
    restorationConfirmed: z.boolean(),
  }).passthrough(),
]);

export const jobStatusSchema = z.object({
  protocolVersion,
  sessionId: identifier,
  instanceId: identifier,
  instanceNonce: z.string().min(32).max(256),
  jobId: identifier,
  sequence: z.number().int().nonnegative(),
  state: z.enum(JOB_STATES),
  worldId: boundedString.min(1).nullable(),
  worldEpoch: z.number().int().nonnegative(),
  timestamp: isoTimestamp,
  /** Required by JobStore; optional here so old messages receive a stable host error. */
  deliveryToken: deliveryToken.optional(),
  /** Required by JobStore; camera ownership is never inferred from `state`. */
  cameraLease: cameraLeaseStatusSchema.optional(),
  errorCode: z.enum(ERROR_CODES).optional(),
  message: boundedString.optional(),
}).passthrough().superRefine((value, context) => {
  if (value.state === "failed" && !value.errorCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["errorCode"], message: "failed status requires errorCode" });
  }
  if (!(TERMINAL_JOB_STATES as readonly string[]).includes(value.state) && value.errorCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["errorCode"], message: "nonterminal status cannot contain errorCode" });
  }
});

export const artifactManifestSchema = z.object({
  protocolVersion,
  sessionId: identifier,
  instanceId: identifier,
  instanceNonce: z.string().min(32).max(256),
  jobId: identifier,
  artifactId: identifier,
  relativeScreenshotFilename: z.string().regex(/^[A-Za-z0-9_-]{1,96}\.(bmp|png)$/i),
  screenshotIssuedAt: isoTimestamp,
  completedAt: isoTimestamp,
  expectedByteCount: z.number().int().positive().max(DEFAULT_LIMITS.maxArtifactBytes).optional(),
  worldId: boundedString.min(1).nullable(),
  worldEpoch: z.number().int().nonnegative(),
  actualCamera: z.object({
    matrix: z.array(finiteNumber).length(16).optional(),
    position: vector3.optional(),
    orientation: quaternion.optional(),
  }).passthrough(),
  actualFov: finiteNumber.min(1).max(179).optional(),
  requestedSettleFrames: z.number().int().min(0).max(DEFAULT_LIMITS.maxSettleFrames),
  actualSettleFrames: z.number().int().min(0).max(DEFAULT_LIMITS.maxSettleFrames),
  contaminated: z.boolean(),
  warnings: z.array(z.string().max(256)).max(16),
}).passthrough().superRefine((value, context) => {
  if (Date.parse(value.completedAt) < Date.parse(value.screenshotIssuedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["completedAt"], message: "completedAt must not precede screenshotIssuedAt" });
  }
  if (value.actualSettleFrames < value.requestedSettleFrames) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["actualSettleFrames"], message: "actualSettleFrames must cover requestedSettleFrames" });
  }
});

export const errorResponseSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: boundedString,
  }),
}).passthrough();

export type ProtocolParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: ObserverErrorCode; message: string; issues: Array<{ path: string; message: string }> } };

export function protocolMajor(version: string): number | null {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  return match ? Number(match[1]) : null;
}

export function parseProtocolMessage<T>(schema: z.ZodType<T>, value: unknown): ProtocolParseResult<T> {
  if (value && typeof value === "object" && "protocolVersion" in value) {
    const version = (value as { protocolVersion?: unknown }).protocolVersion;
    if (typeof version === "string" && protocolMajor(version) !== PROTOCOL_MAJOR) {
      return {
        success: false,
        error: { code: "PROTOCOL_MISMATCH", message: `Unsupported protocol major version: ${version}`, issues: [{ path: "protocolVersion", message: `expected ${PROTOCOL_MAJOR}.x` }] },
      };
    }
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    error: {
      code: "INVALID_REQUEST",
      message: "Protocol message validation failed",
      issues: parsed.error.issues.slice(0, 16).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
  };
}

export const knownCapabilitySchema = z.enum(CAPABILITIES);
export { identifier, bundleDigest, finiteNumber, isoTimestamp };
