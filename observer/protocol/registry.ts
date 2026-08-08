export type ObserverBackend =
  | "protocol"
  | "runtime"
  | "workbench"
  | "owned-runtime"
  | "evidence"
  | "host";

export type PublicMessagePolicy = "bounded-diagnostic" | "fixed";

export interface ObserverErrorDefinition {
  /** Whether bounded backend diagnostic prose may be exposed to a public caller. */
  publicMessagePolicy: PublicMessagePolicy;
  /** Stable fallback, and the complete public message when policy is `fixed`. */
  publicMessage: string;
  retryable: boolean;
  backends: readonly ObserverBackend[];
}

/**
 * Canonical public observer error vocabulary. Protocol types, Zod schemas,
 * generated JSON schemas/docs, and MCP boundary validation all derive from
 * this registry. Backend-private errors must be translated before crossing a
 * public boundary.
 */
export const ERROR_REGISTRY = {
  PROTOCOL_MISMATCH: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer protocol versions are incompatible.", retryable: false, backends: ["protocol", "runtime", "host"],
  },
  SESSION_NOT_FOUND: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer session was not found.", retryable: false, backends: ["runtime", "host"],
  },
  SESSION_EXPIRED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer session has expired.", retryable: false, backends: ["runtime", "host"],
  },
  SESSION_MISMATCH: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer operation belongs to a different session.", retryable: false, backends: ["runtime", "workbench", "host"],
  },
  SESSION_UNVERIFIABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer session ownership could not be verified.", retryable: false, backends: ["owned-runtime"],
  },
  SESSION_COMPLETION_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer session cleanup could not be completed.", retryable: true, backends: ["owned-runtime"],
  },
  UNAUTHORIZED: {
    publicMessagePolicy: "fixed", publicMessage: "Observer request was not authorized.", retryable: false, backends: ["protocol", "runtime", "host"],
  },
  PROFILE_CONFLICT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer profile is already leased or unverifiable.", retryable: false, backends: ["runtime", "host"],
  },
  ADDON_STAGE_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer companion staging failed.", retryable: true, backends: ["host"],
  },
  STAGED_ADDON_CONFLICT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Staged observer companion identity conflicts with the requested build.", retryable: false, backends: ["host"],
  },
  ARGUMENT_CONFLICT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer launch arguments conflict with managed arguments.", retryable: false, backends: ["host", "owned-runtime"],
  },
  INSTANCE_NOT_FOUND: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer instance was not found.", retryable: true, backends: ["runtime", "host"],
  },
  INSTANCE_STALE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer instance heartbeat is stale.", retryable: true, backends: ["runtime", "host"],
  },
  INSTANCE_CONFLICT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer instance selection is conflicting.", retryable: false, backends: ["runtime", "host"],
  },
  STALE_INSTANCE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Selected renderer belongs to a stale lifecycle instance.", retryable: true, backends: ["workbench", "host"],
  },
  AMBIGUOUS_INSTANCE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "More than one compatible observer instance is available.", retryable: false, backends: ["workbench", "host"],
  },
  NO_RENDER_ENDPOINT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "No compatible renderer is available.", retryable: true, backends: ["runtime", "workbench", "host"],
  },
  CAPABILITY_UNAVAILABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "The selected backend cannot prove the requested capability.", retryable: false, backends: ["runtime", "workbench", "host"],
  },
  WORKBENCH_ADAPTER_UNAVAILABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Workbench observer adapter is unavailable.", retryable: true, backends: ["workbench", "host"],
  },
  HANDLER_UNAVAILABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Workbench observer handler is unavailable.", retryable: true, backends: ["workbench"],
  },
  HANDLER_REJECTED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Workbench observer handler rejected the request.", retryable: false, backends: ["workbench"],
  },
  STALE_LIFECYCLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Workbench observer belongs to a stale lifecycle.", retryable: true, backends: ["workbench"],
  },
  WORKBENCH_EXITED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Workbench exited during the observer transaction.", retryable: true, backends: ["workbench"],
  },
  JOB_NOT_FOUND: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer job was not found.", retryable: false, backends: ["runtime", "workbench", "host"],
  },
  JOB_RELEASED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer job has already been released.", retryable: false, backends: ["runtime", "workbench", "host"],
  },
  IDEMPOTENCY_CONFLICT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Idempotency key was reused with different input.", retryable: false, backends: ["runtime", "workbench", "owned-runtime", "evidence", "host"],
  },
  UNSUPPORTED_VIEW: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Requested capture view is not supported.", retryable: false, backends: ["runtime", "workbench"],
  },
  INVALID_REQUEST: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer request is invalid.", retryable: false, backends: ["protocol", "runtime", "workbench", "owned-runtime", "evidence", "host"],
  },
  WORLD_UNAVAILABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "No active world is available for this operation.", retryable: true, backends: ["runtime", "workbench"],
  },
  WORLD_CHANGED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Renderer world identity changed during capture.", retryable: true, backends: ["runtime", "workbench", "host"],
  },
  CAMERA_BUSY: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer camera is busy or awaiting restoration.", retryable: true, backends: ["runtime", "workbench", "owned-runtime", "host"],
  },
  CAMERA_OWNERSHIP_LOST: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer camera ownership was lost.", retryable: false, backends: ["runtime"],
  },
  RESTORATION_UNCONFIRMED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer camera restoration could not be confirmed.", retryable: false, backends: ["runtime", "workbench", "host"],
  },
  CAPTURE_REJECTED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer capture was rejected.", retryable: true, backends: ["runtime", "workbench", "host"],
  },
  CAPTURE_TIMEOUT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer capture exceeded its deadline.", retryable: true, backends: ["runtime", "workbench", "host"],
  },
  ARTIFACT_INCOMPLETE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer artifact is not complete.", retryable: true, backends: ["runtime", "workbench", "evidence", "host"],
  },
  ARTIFACT_INVALID: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer artifact failed validation.", retryable: false, backends: ["runtime", "workbench", "evidence", "host"],
  },
  ARTIFACT_TOO_LARGE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer artifact exceeds the configured size limit.", retryable: false, backends: ["runtime", "workbench", "evidence", "host"],
  },
  TRANSPORT_UNAVAILABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer transport is unavailable.", retryable: true, backends: ["runtime", "host"],
  },
  PERFORMANCE_POLICY_BLOCKED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Capture is incompatible with the selected performance policy.", retryable: false, backends: ["runtime", "workbench", "host"],
  },
  CANCELLED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer operation was cancelled.", retryable: true, backends: ["runtime", "workbench", "owned-runtime", "host"],
  },
  LIFECYCLE_CLOSING: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer lifecycle is shutting down.", retryable: true, backends: ["owned-runtime"],
  },
  IDENTITY_MISMATCH: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned process identity no longer matches its receipt.", retryable: false, backends: ["owned-runtime"],
  },
  IDENTITY_UNVERIFIABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned process identity could not be verified.", retryable: false, backends: ["owned-runtime"],
  },
  STORAGE_CONFLICT: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer lifecycle storage changed concurrently.", retryable: true, backends: ["owned-runtime"],
  },
  STORAGE_UNVERIFIABLE: {
    publicMessagePolicy: "fixed", publicMessage: "Observer lifecycle storage could not be verified.", retryable: false, backends: ["owned-runtime"],
  },
  STORE_CAPACITY_EXCEEDED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Observer lifecycle storage capacity is exhausted.", retryable: true, backends: ["owned-runtime"],
  },
  PREPARE_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Prepared runtime launch could not be recorded.", retryable: true, backends: ["owned-runtime"],
  },
  RETENTION_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned runtime retention could not be completed.", retryable: true, backends: ["owned-runtime"],
  },
  PREPARED_LAUNCH_CONSUMED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Prepared observer launch has already been consumed.", retryable: false, backends: ["owned-runtime"],
  },
  PREPARED_LAUNCH_EXPIRED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Prepared observer launch has expired.", retryable: false, backends: ["owned-runtime"],
  },
  PREPARED_LAUNCH_STALE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Prepared observer launch belongs to a stale lifecycle.", retryable: false, backends: ["owned-runtime"],
  },
  GAME_LAUNCH_PREDECESSOR_REQUIRED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "The current game-launch successor requires its exact predecessor runtime ID.", retryable: false, backends: ["owned-runtime"],
  },
  GAME_LAUNCH_PREDECESSOR_MISMATCH: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "The supplied predecessor is not the current game-launch chain tip.", retryable: false, backends: ["owned-runtime"],
  },
  GAME_LAUNCH_PREDECESSOR_NOT_STOPPED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "The game-launch predecessor has not completed exact stop and observer cleanup.", retryable: true, backends: ["owned-runtime"],
  },
  START_UNVERIFIABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned runtime start could not be verified.", retryable: false, backends: ["owned-runtime"],
  },
  START_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned runtime start failed.", retryable: true, backends: ["owned-runtime"],
  },
  STOP_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned runtime stop failed.", retryable: true, backends: ["owned-runtime"],
  },
  SHUTDOWN_SEAL_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned runtime shutdown sealing failed.", retryable: true, backends: ["owned-runtime"],
  },
  RUNTIME_NOT_FOUND: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned runtime receipt was not found.", retryable: false, backends: ["owned-runtime"],
  },
  SPAWN_FAILED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned process could not be started and verified.", retryable: true, backends: ["owned-runtime"],
  },
  RECOVERY_REQUIRED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Lifecycle recovery remains pending and requires a later retry.", retryable: true, backends: ["workbench", "owned-runtime"],
  },
  TERMINATION_REFUSED: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Exact owned-process termination was refused.", retryable: false, backends: ["owned-runtime"],
  },
  TERMINATION_UNVERIFIABLE: {
    publicMessagePolicy: "bounded-diagnostic", publicMessage: "Owned-process termination could not be verified.", retryable: true, backends: ["owned-runtime"],
  },
  INTERNAL_ERROR: {
    publicMessagePolicy: "fixed", publicMessage: "Observer operation failed.", retryable: true, backends: ["protocol", "runtime", "workbench", "owned-runtime", "evidence", "host"],
  },
} as const satisfies Record<string, ObserverErrorDefinition>;

export type ObserverErrorCode = keyof typeof ERROR_REGISTRY;

export interface ObserverCapabilityDefinition {
  /** Backends with a concrete producer and conformance evidence for the claim. */
  backends: readonly ("runtime" | "workbench")[];
  proof: string;
}

/** Capabilities without a producer/conformance path must not appear here. */
export const CAPABILITY_REGISTRY = {
  "render.capture": {
    backends: ["runtime", "workbench"],
    proof: "Initialized native PNG capture with backend readiness checks.",
  },
  "camera.runtime": {
    backends: ["runtime"],
    proof: "Runtime camera lease, ownership, and exact restoration transaction.",
  },
  "camera.editor": {
    backends: ["workbench"],
    proof: "Per-lifecycle current-view transaction proves exact editor-camera restoration.",
  },
  "world.query": {
    backends: ["runtime"],
    proof: "Runtime reports nullable world identity and monotonic world epoch.",
  },
  "authority.server": {
    backends: ["runtime"],
    proof: "Runtime replication API proves active server authority.",
  },
  "transport.rest": {
    backends: ["runtime"],
    proof: "Runtime REST transport completed initialization.",
  },
  "transport.mailbox": {
    backends: ["runtime"],
    proof: "Runtime mailbox transport completed initialization and bounded disposition handling.",
  },
} as const satisfies Record<string, ObserverCapabilityDefinition>;

export type ObserverCapability = keyof typeof CAPABILITY_REGISTRY;

export const ERROR_CODES = Object.freeze(
  Object.keys(ERROR_REGISTRY) as ObserverErrorCode[]
) as readonly [ObserverErrorCode, ...ObserverErrorCode[]];

/** Error vocabulary that an engine-runtime heartbeat or job status may emit. */
export const RUNTIME_ERROR_CODES = Object.freeze(
  ERROR_CODES.filter((code) =>
    (ERROR_REGISTRY[code].backends as readonly ObserverBackend[]).includes("runtime"))
) as readonly [ObserverErrorCode, ...ObserverErrorCode[]];

export const CAPABILITIES = Object.freeze(
  Object.keys(CAPABILITY_REGISTRY) as ObserverCapability[]
) as readonly [ObserverCapability, ...ObserverCapability[]];

export function publicErrorMessage(code: ObserverErrorCode, diagnostic?: string): string {
  const definition = ERROR_REGISTRY[code];
  if (definition.publicMessagePolicy === "fixed") return definition.publicMessage;
  const bounded = diagnostic?.trim().slice(0, 512);
  return bounded || definition.publicMessage;
}
