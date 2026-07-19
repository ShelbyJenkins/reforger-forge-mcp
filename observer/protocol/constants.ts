export const PROTOCOL_VERSION = "1.0" as const;
export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_MINOR = 0;
export const ADDON_VERSION = "0.1.0" as const;
export const AGENT_VERSION = "0.1.0" as const;
export const ADDON_ID = "ReforgerForgeObserver" as const;
export const ADDON_GUID = "7F3A91C2E40B6D58" as const;
/** Independent compiled release identity; deliberately not the recursive bundle digest. */
export const OBSERVER_BUILD_IDENTITY = "000cec19226673ce911c68dca027dca7449ff58a604fe0cef6509afbc4d7ec22" as const;
export const SESSION_DIRECTORY_NAME = "ReforgerForgeObserver" as const;
export const SESSION_CONTRACT_NAME = "session.json" as const;

export {
  CAPABILITIES,
  CAPABILITY_REGISTRY,
  ERROR_CODES,
  ERROR_REGISTRY,
  publicErrorMessage,
  type ObserverBackend,
  type ObserverCapability,
  type ObserverCapabilityDefinition,
  type ObserverErrorCode,
  type ObserverErrorDefinition,
  type PublicMessagePolicy,
} from "./registry.js";

export const TRANSPORTS = ["rest", "mailbox"] as const;
export type ObserverTransport = (typeof TRANSPORTS)[number];

export const JOB_STATES = [
  "queued",
  "dispatched",
  "accepted",
  "resolving",
  "preloading",
  "acquiringCamera",
  "positioning",
  "settling",
  "capturing",
  "awaitingArtifact",
  "restoring",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ObserverJobState = (typeof JOB_STATES)[number];
export const TERMINAL_JOB_STATES = ["completed", "failed", "cancelled"] as const;

/**
 * Runtime-reported transitions. `queued -> dispatched` and all transitions to
 * `completed` are host-owned, so they are deliberately absent here. A
 * `restoring -> restoring` report is allowed so a runtime can first report the
 * restoration attempt and then explicitly confirm that the camera was
 * restored. Terminal transitions are still subject to camera-lease evidence
 * checks in JobStore.
 */
export const RUNTIME_JOB_TRANSITIONS = Object.freeze({
  queued: [],
  dispatched: ["accepted", "failed", "cancelled"],
  accepted: ["resolving", "preloading", "acquiringCamera", "settling", "capturing", "failed", "cancelled"],
  resolving: ["preloading", "acquiringCamera", "capturing", "failed", "cancelled"],
  preloading: ["acquiringCamera", "settling", "capturing", "restoring", "failed", "cancelled"],
  acquiringCamera: ["positioning", "restoring", "failed", "cancelled"],
  positioning: ["preloading", "settling", "capturing", "restoring"],
  settling: ["capturing", "restoring"],
  capturing: ["awaitingArtifact", "restoring", "failed", "cancelled"],
  awaitingArtifact: ["restoring", "failed", "cancelled"],
  restoring: ["restoring", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} satisfies Readonly<Record<ObserverJobState, readonly ObserverJobState[]>>);

export function isRuntimeJobTransition(from: ObserverJobState, to: ObserverJobState): boolean {
  return (RUNTIME_JOB_TRANSITIONS[from] as readonly ObserverJobState[]).includes(to);
}

/** Duration of one command-delivery lease before a new attempt/token is issued. */
export const COMMAND_DELIVERY_LEASE_MS = 5_000;

export const DEFAULT_LIMITS = Object.freeze({
  maxPendingJobs: 4,
  maxCaptureRatePerMinute: 12,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxArtifactWidth: 16_384,
  maxArtifactHeight: 16_384,
  minFov: 10,
  maxFov: 120,
  maxSettleFrames: 30,
  maxCaptureDistance: 100_000,
  maxRequestBodyBytes: 256 * 1024,
});

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_PROTOCOL_MESSAGE_BYTES = 256 * 1024;
