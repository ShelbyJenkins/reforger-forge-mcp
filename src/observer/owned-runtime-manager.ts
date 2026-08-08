import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMcpInstanceId } from "../mcp-host-identity.js";
import type { McpHostAdmissionGate } from "../mcp-host-admission.js";
import type {
  IdleShutdownInspectionOptions,
  McpIdleBlockerCode,
  McpIdleProviderReadiness,
  McpIdleReadinessProvider,
} from "../mcp-idle-readiness.js";
import { z } from "zod";
import { redactText } from "../foundation/redact.js";
import type {
  ExactProcessBackend,
  ExactProcessInspection,
  ExactProcessTerminationResult,
} from "../foundation/exact-process-backend.js";
import type { ExactProcessIdentity } from "../foundation/identity.js";
import type {
  MachineMutex,
  MachineMutexLeaseLoss,
} from "../foundation/machine-mutex.js";
import {
  DurableReservationGate,
  ReservationCancelledError,
} from "../foundation/reservation-gate.js";
import {
  systemSleeper,
  type Sleeper,
} from "../foundation/time.js";
import {
  runRecoverableSpawn,
  type RecoverableSpawnRecord,
} from "../foundation/recoverable-spawn.js";
import {
  LmdbRecordStore,
  LmdbRecordStoreError,
} from "../foundation/lmdb-record-store.js";
import {
  assertRegularManagedFile,
  canonicalizeExistingDirectory,
  canonicalizePotentialPath,
  isPathContained,
  pathComparisonKey,
  resolveManagedPath,
} from "../foundation/managed-path.js";
import { createWindowsExactProcessBackend } from "../platform/windows/exact-process-backend.js";
import {
  prepareWindowsForegroundDuringRuntimeStartup,
  type RuntimeFocusGuardPreparation,
  type RuntimeFocusGuardTransaction,
} from "../platform/windows/runtime-focus-guard.js";
import {
  ChildSupervisor,
  type SupervisedChildCounts,
  type SupervisedChildExit,
} from "../foundation/child-supervisor.js";
import {
  computeGameAddonEvidenceDigest,
  type GameAddonPlanSnapshot,
} from "../launch/game-addon-plan.js";
import { GameLaunchPlanError } from "../launch/game-launch-errors.js";
import {
  GameLaunchRevalidationIsolationError,
  gameLaunchRevalidationDeadlineError,
  revalidateGameLaunchPointOfUseIsolated,
  type IsolatedGameLaunchRevalidationRequest,
} from "../launch/game-launch-revalidation-isolation.js";
import {
  computeGameWorldEvidenceDigest,
  type GameWorldPlanSnapshot,
} from "../launch/game-world-plan.js";
import type {
  ObserverLaunchInput,
  ObserverPreparedLaunch,
  ObserverPreparedLaunchRecorder,
} from "./launch.js";
import {
  deriveOwnedGameLaunchAttemptKey,
  OWNED_GAME_LAUNCH_ATTEMPT_ID_PREFIX,
} from "./game-launch-attempt.js";
import type { ObserverRemedyReason } from "./refusal-remedy.js";

export const OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX = "-reforgerForgeOwnerToken=";
export const OWNED_RUNTIME_LIFECYCLE_MUTEX = "Global\\ReforgerForge.ObserverRuntimeLifecycle.v1";

const STORAGE_VERSION = 1;
// A serialized lifecycle record is at minimum `{}\n`; anything shorter is a
// truncated/corrupt value. Preserves the prior BoundedJsonStore lower bound.
const LIFECYCLE_RECORD_MIN_BYTES = 2;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 20_000;
export const OWNED_RUNTIME_START_REVALIDATION_DEADLINE_MS = 60_000;
export const OWNED_RUNTIME_EXECUTABLE_MAXIMUM_BYTES = 1024 * 1024 * 1024;
const PROCESS_POLL_MS = 100;
const DEFAULT_LIFECYCLE_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_STORE_RECORDS = 16_384;
const DEFAULT_MAX_STORE_BYTES = 512 * 1024 * 1024;
const DEFAULT_HISTORY_MAX_RUNTIMES = 32;
const MAX_HISTORY_MAX_RUNTIMES = 128;
const DEFAULT_HISTORY_DEADLINE_MS = 60_000;
const MAX_HISTORY_DEADLINE_MS = 5 * 60_000;
const MAX_HISTORY_ISSUES = 32;
// Keep the historical shared ceiling for unrelated lifecycle record kinds.
// Prepared descriptors have the tighter, launch-derived bound below.
const MAX_CONFIGURABLE_RECORD_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = MAX_CONFIGURABLE_RECORD_BYTES;
const START_LIFECYCLE_RESERVE_RECORDS = 9;
const GAME_LAUNCH_START_LIFECYCLE_RESERVE_RECORDS = START_LIFECYCLE_RESERVE_RECORDS + 2;
const START_LIFECYCLE_RESERVE_BYTES = 2 * 1024 * 1024;
const CHILD_EXIT_RESERVE_BYTES = 256 * 1024;
const SMALL_LIFECYCLE_RESERVE_BYTES = 8 * 1024;
const WINDOWS_COMMAND_LINE_MAX_UTF16_UNITS = 32_767;
const WINDOWS_PATH_MAX_CHARS = 32_768;
const WINDOWS_SID_MAX_CHARS = 256;
const DECIMAL_IDENTITY_MAX_CHARS = 32;
const PREPARED_SESSION_ID_MAX_UTF16_UNITS = 96;
const PREPARED_ARGUMENT_MAX_COUNT = 527;
const JSON_STRING_MAX_UTF8_BYTES_PER_UTF16_UNIT = 6;
const PREPARED_ARGUMENT_JSON_OVERHEAD_MAX_BYTES = PREPARED_ARGUMENT_MAX_COUNT * 8;
const PREPARED_FIXED_JSON_ENVELOPE_MAX_BYTES = 4 * 1024;
// A launchable argument vector contributes at most 32,767 UTF-16 units. JSON
// can encode one UTF-16 unit as six UTF-8 bytes (for example, "\u0000"), and
// the separately persisted profile path and session id have bounded lengths.
// Each of the 527 pretty-printed array entries needs at most eight structural
// bytes; 4 KiB covers the remaining production-generated keys, fixed metadata,
// braces, indentation, and trailing newline:
//   (32,767 + 32,768 + 96) * 6 + 527 * 8 + 4,096 = 402,098 bytes.
const MAX_REALISTIC_PREPARED_DESCRIPTOR_BYTES =
  (WINDOWS_COMMAND_LINE_MAX_UTF16_UNITS + WINDOWS_PATH_MAX_CHARS +
    PREPARED_SESSION_ID_MAX_UTF16_UNITS) * JSON_STRING_MAX_UTF8_BYTES_PER_UTF16_UNIT +
  PREPARED_ARGUMENT_JSON_OVERHEAD_MAX_BYTES + PREPARED_FIXED_JSON_ENVELOPE_MAX_BYTES;
export const OWNED_RUNTIME_RECORD_DIRECTORIES = [
  "prepared",
  "prepared-index",
  "prepared-invalidations",
  "consumed",
  "pending-starts",
  "runtimes",
  "child-exits",
  "stops",
  "stop-completions",
  "restoration-proofs",
  "idempotency",
  "game-launch-chains",
] as const;
type OwnedRuntimeRecordDirectory = typeof OWNED_RUNTIME_RECORD_DIRECTORIES[number];
const preparedLaunchIdSchema = z.string().regex(/^pl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const runtimeIdSchema = z.string().regex(/^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const compositeAttemptIdSchema = z.string().regex(/^ga-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const fileTimeSchema = z.string().max(DECIMAL_IDENTITY_MAX_CHARS).regex(/^\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const decimalSchema = z.string().max(DECIMAL_IDENTITY_MAX_CHARS).regex(/^\d+$/);

export type OwnedRuntimeState =
  | "running"
  | "stopping"
  | "exited"
  | "identity_mismatch"
  | "unverifiable"
  | "stale";

/** @deprecated Use ExactProcessIdentity from foundation/identity. */
export type OwnedRuntimeExactIdentity = ExactProcessIdentity;

/** @deprecated Use ExactProcessInspection from foundation/exact-process-backend. */
export type OwnedRuntimeInspection = ExactProcessInspection;

/** @deprecated Use ExactProcessTerminationResult from foundation/exact-process-backend. */
export type OwnedRuntimeTerminateResult = ExactProcessTerminationResult;

/** Compatibility composition for callers that still provide one combined adapter. */
export interface OwnedRuntimeProcessBackend extends ExactProcessBackend, MachineMutex {}

function defaultOwnedRuntimeBackend(): OwnedRuntimeProcessBackend {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return createWindowsExactProcessBackend(
    join(packageRoot, "scripts", "windows", "workbench-lifecycle.ps1")
  );
}

function providesMachineMutex(value: ExactProcessBackend): value is ExactProcessBackend & MachineMutex {
  return "withMachineMutex" in value && typeof value.withMachineMutex === "function";
}

export interface RuntimeStopPreflight {
  sessionKnown: boolean;
  ready: boolean;
  reserved: boolean;
  /**
   * False only after exact vacancy has already released the child-side
   * lifecycle authority, leaving no live runtime for a reservation to seal.
   */
  reservationRequired?: boolean;
  activeJobIds: string[];
  cameraLeaseJobIds: string[];
  restorationPendingJobIds: string[];
  reservationId?: string;
  reason?: string;
}

/**
 * Exact immutable fields from the durable runtime receipt. The observer child
 * recomputes `generation` from this payload before it restores or mutates any
 * session state; a PID, profile path, or executable name alone is never
 * recovery authority.
 */
export interface OwnedRuntimeLifecycleAuthority {
  preparedLaunchId: string;
  profilePath: string;
  runtimeKind: ObserverLaunchInput["runtimeKind"];
  pid: number;
  executablePath: string;
  creationTimeFileTime: string;
  ownerTokenArgument: string;
  launchedAtMs: number;
}

export interface OwnedRuntimeLifecycleIdentity {
  runtimeId: string;
  generation: string;
}

export interface OwnedRuntimeObserverGate {
  retainRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string,
    authority: OwnedRuntimeLifecycleAuthority
  ): Promise<unknown>;
  releaseRuntimeLifecycle(
    sessionId: string,
    runtimeId: string,
    generation: string
  ): Promise<unknown>;
  reserveRuntimeStop(
    sessionId: string,
    proposedReservationId: string,
    exactRuntimeVacant?: boolean,
    lifecycle?: OwnedRuntimeLifecycleIdentity
  ): Promise<RuntimeStopPreflight>;
  releaseRuntimeStop(
    sessionId: string,
    reservationId: string,
    lifecycle?: OwnedRuntimeLifecycleIdentity
  ): Promise<unknown>;
  completeRuntimeStop(
    sessionId: string,
    reservationId?: string,
    exactRuntimeVacant?: boolean,
    lifecycle?: { runtimeId: string; generation: string }
  ): Promise<unknown>;
}

export interface OwnedRuntimeManagerOptions {
  managedRoot: string;
  gamePath: string;
  observerGate: OwnedRuntimeObserverGate;
  /** Trusted process-wide MCP identity; standalone managers retain a random default. */
  managerInstanceId?: string;
  backend?: ExactProcessBackend;
  /** Required when backend does not also implement the legacy combined adapter. */
  machineMutex?: MachineMutex;
  spawnProcess?: typeof nodeSpawn;
  /** Establishes Windows startup-focus hooks before a graphical process is spawned. */
  prepareForegroundDuringStartup?: (
    input: RuntimeFocusGuardPreparation
  ) => Promise<RuntimeFocusGuardTransaction>;
  /** Resolves the exact installed executable appropriate for the prepared runtime kind. */
  executableResolver?: (runtimeKind: ObserverLaunchInput["runtimeKind"]) => string;
  /**
   * @internal Isolated point-of-use revalidation seam for deterministic lifecycle tests.
   * Implementations own their absolute deadline and must not settle until all
   * physical work has stopped. The signal revokes lifecycle-lease authority.
   */
  pointOfUseRevalidator?: (
    request: IsolatedGameLaunchRevalidationRequest,
    signal: AbortSignal,
  ) => Promise<OwnedRuntimeExecutableEvidence>;
  clock?: () => number;
  /** Ordinary local-delay seam; durable deadlines and recovery remain local. */
  sleeper?: Sleeper;
  ownerToken?: () => string;
  randomId?: () => string;
  installationRoot?: string;
  inspectionTimeoutMs?: number;
  terminationTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Retention window for completed lifecycle clusters and expired, unused preparations. */
  receiptRetentionMs?: number;
  /** Hard bound across all durable lifecycle records, including corrupt regular files. */
  maxStoreRecords?: number;
  /** Hard aggregate byte bound across all durable lifecycle records. */
  maxStoreBytes?: number;
  /** Hard serialized byte bound for every individual durable record. */
  maxRecordBytes?: number;
  admissionGate?: McpHostAdmissionGate;
}

export interface OwnedRuntimeStorageStats {
  records: number;
  bytes: number;
  maxRecords: number;
  maxBytes: number;
  maxRecordBytes: number;
  receiptRetentionMs: number;
  prepared: number;
  activeOrRecoverableRuntimes: number;
  completedRuntimes: number;
  reservedMutationRecords: number;
  reservedMutationBytes: number;
}

export interface OwnedRuntimeSweepResult {
  removedPreparedLaunchIds: string[];
  removedRuntimeIds: string[];
  removedTemporaryFiles: number;
}

export interface OwnedRuntimeStartInput {
  preparedLaunchId: string;
  idempotencyKey: string;
  /** Absolute wall-clock deadline shared by pre-spawn and post-spawn revalidation. */
  revalidationDeadlineAtMs?: number;
  /** Executable byte ceiling shared by both point-of-use attestations. */
  executableMaximumBytes?: number;
}

export const OWNED_RUNTIME_EXECUTABLE_EVIDENCE_SCHEMA_VERSION = 1;

export interface OwnedRuntimeExecutableEvidence {
  readonly schemaVersion: typeof OWNED_RUNTIME_EXECUTABLE_EVIDENCE_SCHEMA_VERSION;
  readonly runtimeKind: ObserverLaunchInput["runtimeKind"];
  readonly executablePath: string;
  readonly executableFile: {
    readonly sha256: string;
    readonly size: string;
    readonly device: string;
    readonly inode: string;
  };
  readonly executableEvidenceDigest: string;
}

/** Serializable executable locator used by isolated game-launch planning. */
export type OwnedRuntimeExecutablePlanningSource =
  | { readonly kind: "gamePath"; readonly gamePath: string }
  | { readonly kind: "executablePath"; readonly executablePath: string };

export const OWNED_GAME_LAUNCH_PREPARATION_EVIDENCE_SCHEMA_VERSION = 2 as const;

export interface OwnedGameLaunchPreparationEvidence {
  readonly schemaVersion: typeof OWNED_GAME_LAUNCH_PREPARATION_EVIDENCE_SCHEMA_VERSION;
  readonly prepareKey: string;
  readonly projectComparisonKey: string;
  readonly world: GameWorldPlanSnapshot;
  readonly addons: GameAddonPlanSnapshot;
  readonly executable: OwnedRuntimeExecutableEvidence;
  readonly gameLaunchEvidenceDigest: string;
}

export interface PrepareInitialOwnedGameLaunchInput {
  readonly launchInput: ObserverLaunchInput;
  readonly evidence: OwnedGameLaunchPreparationEvidence;
  readonly afterRuntimeId?: string;
  readonly prepare: (attemptLaunchInput: ObserverLaunchInput) => Promise<ObserverPreparedLaunch>;
  /** Cleanup is terminal only when the observer returns `{ revoked: true }`. */
  readonly revokeSession: (sessionId: string) => Promise<unknown>;
}

export type OwnedGameLaunchAttemptState =
  | "reserved"
  | "revocation_pending"
  | "aborted"
  | "prepared"
  | "starting"
  | "running"
  | "terminal";

export interface OwnedGameLaunchChainPublicState {
  readonly schemaVersion: 1;
  readonly delivery: "owned";
  readonly compositeAttemptId: string;
  readonly generation: number;
  readonly state: OwnedGameLaunchAttemptState;
  readonly predecessorRuntimeId: string | null;
  readonly runtimeId?: string;
  readonly retry: { readonly afterRuntimeId: string | null };
  readonly successor:
    | { readonly eligible: false; readonly reason: "exact_stop_required" | "recovery_required" }
    | { readonly eligible: true; readonly afterRuntimeId: string };
}

export interface PreparedOwnedGameLaunch extends ObserverPreparedLaunch {
  readonly preparedLaunchId: string;
  readonly compositeAttemptId: string;
  readonly canonicalFingerprint: string;
  readonly chain: OwnedGameLaunchChainPublicState;
}

export interface OwnedRuntimeStopInput {
  runtimeId: string;
  waitForRestorationMs: number;
  idempotencyKey: string;
  signal?: AbortSignal;
  /** Internal aggregate fence used by bounded recovery batches. */
  deadlineAtMs?: number;
  /** Internal history-recovery fence: do not run unrelated age-based retention. */
  skipRetentionSweep?: boolean;
}

export type OwnedRuntimeHistoryDisposition =
  | "completed"
  | "child_exit_only"
  | "cleanup_pending"
  | "active_or_unresolved"
  | "indeterminate";

export interface OwnedRuntimeHistoryInspectionOptions {
  readonly maxRuntimes?: number;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface OwnedRuntimeHistoryIssue {
  readonly runtimeId: string;
  readonly reason: string;
}

export interface OwnedRuntimeHistoryInventory {
  readonly schemaVersion: 1;
  /** True only when the complete lifecycle namespace and classification were verified. */
  readonly complete: boolean;
  readonly recordsScanned: number;
  readonly runtimesScanned: number;
  readonly counts: Readonly<Record<OwnedRuntimeHistoryDisposition, number>>;
  readonly recoverableCount: number;
  readonly recoverableRuntimeIds: readonly string[];
  readonly historicalManagerInstances: number;
  readonly idleBlockers: readonly McpIdleBlockerCode[];
  /** True when more recoverable IDs exist than this bounded result returns. */
  readonly truncated: boolean;
  readonly issues: readonly OwnedRuntimeHistoryIssue[];
}

export interface OwnedRuntimeHistoryRecoveryBlock {
  readonly runtimeId: string;
  readonly code: string;
  readonly reason: string;
}

export interface OwnedRuntimeHistoryRecoveryResult {
  readonly schemaVersion: 1;
  readonly before: OwnedRuntimeHistoryInventory;
  readonly attemptedRuntimeIds: readonly string[];
  readonly recoveredRuntimeIds: readonly string[];
  readonly blocked: readonly OwnedRuntimeHistoryRecoveryBlock[];
  readonly after: OwnedRuntimeHistoryInventory | null;
  readonly deadlineExceeded: boolean;
}

interface NormalizedOwnedRuntimeHistoryOptions {
  readonly maxRuntimes: number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
}

export interface OwnedRuntimePublicStatus {
  runtimeId: string;
  sessionId: string;
  preparedLaunchId: string;
  state: OwnedRuntimeState;
  pid: number;
  runtimeKind: ObserverLaunchInput["runtimeKind"];
  startedAt: string;
  exactOwned: boolean;
  reason?: string;
  stoppedAt?: string;
  termination?: "terminated" | "already_exited";
  identityVacant?: boolean;
  terminationComplete?: boolean;
  observerCleanupPending?: boolean;
  compositeAttemptId?: string;
  chain?: OwnedGameLaunchChainPublicState;
}

export class OwnedRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly remedyReason?: ObserverRemedyReason
  ) {
    super(message);
    this.name = "OwnedRuntimeError";
  }
}

/** Exact proof that planning failed before descriptor consumption or spawn. */
export class OwnedRuntimePreconsumptionError extends OwnedRuntimeError {
  constructor(
    readonly planningError: GameLaunchPlanError,
    details: Record<string, unknown>,
  ) {
    super(
      "PREPARED_LAUNCH_INVALIDATED",
      "Prepared game launch evidence changed before runtime consumption",
      details,
    );
    this.name = "OwnedRuntimePreconsumptionError";
  }
}

const gameLaunchAttemptKeySchema = z.string().regex(
  /^mcp-game-launch-attempt-(?:prepare|record|start)-v1-[a-f0-9]{64}$/,
);
const canonicalGameLaunchPrepareKeySchema = z.string().regex(
  /^mcp-game-launch-prepare-v1-[a-f0-9]{64}$/,
);
const gameLaunchAttemptLinkSchema = z.object({
  schemaVersion: z.literal(1),
  delivery: z.literal("owned"),
  compositeAttemptId: compositeAttemptIdSchema,
  canonicalFingerprint: sha256Schema,
  profileKeyDigest: sha256Schema,
  generation: z.number().int().positive(),
  predecessorRuntimeId: runtimeIdSchema.nullable(),
  predecessorCompositeAttemptId: compositeAttemptIdSchema.nullable(),
  prepareKey: gameLaunchAttemptKeySchema,
  recordKey: gameLaunchAttemptKeySchema,
  startKey: gameLaunchAttemptKeySchema,
}).strict();
type GameLaunchAttemptLink = z.infer<typeof gameLaunchAttemptLinkSchema>;

const gameLaunchTerminalProofSchema = z.object({
  runtimeId: runtimeIdSchema,
  stoppedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  restorationProvedAt: z.string().datetime(),
  sessionRevoked: z.literal(true),
  proofDigest: sha256Schema,
}).strict();

const gameLaunchPreparationAbortSchema = z.object({
  sessionId: z.string().min(1).max(PREPARED_SESSION_ID_MAX_UTF16_UNITS),
  revokedAt: z.string().datetime(),
  sessionRevoked: z.literal(true),
}).strict();

const gameLaunchAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  delivery: z.literal("owned"),
  compositeAttemptId: compositeAttemptIdSchema,
  canonicalFingerprint: sha256Schema,
  generation: z.number().int().positive(),
  predecessorRuntimeId: runtimeIdSchema.nullable(),
  predecessorCompositeAttemptId: compositeAttemptIdSchema.nullable(),
  managerInstanceId: z.string().uuid(),
  state: z.enum([
    "reserved",
    "revocation_pending",
    "aborted",
    "prepared",
    "starting",
    "running",
    "terminal",
  ]),
  prepareKey: gameLaunchAttemptKeySchema,
  recordKey: gameLaunchAttemptKeySchema,
  startKey: gameLaunchAttemptKeySchema,
  preparedLaunchId: preparedLaunchIdSchema.nullable(),
  sessionId: z.string().min(1).max(PREPARED_SESSION_ID_MAX_UTF16_UNITS).nullable(),
  runtimeId: runtimeIdSchema.nullable(),
  // Optional only for schema-v1 chains written before pre-runtime abort proof
  // existed. New writes always publish an explicit null or proof object.
  preparationAbort: gameLaunchPreparationAbortSchema.nullable().optional(),
  terminal: gameLaunchTerminalProofSchema.nullable(),
  reservedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
type GameLaunchAttempt = z.infer<typeof gameLaunchAttemptSchema>;

const gameLaunchPreviousTipSchema = z.object({
  compositeAttemptId: compositeAttemptIdSchema,
  runtimeId: runtimeIdSchema,
  canonicalFingerprint: sha256Schema,
  generation: z.number().int().positive(),
  completedAt: z.string().datetime(),
  proofDigest: sha256Schema,
}).strict();

const gameLaunchChainSchema = z.object({
  schemaVersion: z.literal(1),
  delivery: z.literal("owned"),
  profileKey: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  profileKeyDigest: sha256Schema,
  profilePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  current: gameLaunchAttemptSchema,
  previous: gameLaunchPreviousTipSchema.nullable(),
  updatedAt: z.string().datetime(),
}).strict();
type GameLaunchChain = z.infer<typeof gameLaunchChainSchema>;

const preparedDescriptorSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  preparedLaunchId: preparedLaunchIdSchema,
  sessionId: z.string().min(1).max(PREPARED_SESSION_ID_MAX_UTF16_UNITS),
  // observer_prepare_launch accepts 512 input tokens. Normalization can append
  // eight required observer tokens, -forceUpdate, -noFocus, and the exceptional
  // five-token non-native window-size override.
  arguments: z.array(z.string().max(32_768)).max(PREPARED_ARGUMENT_MAX_COUNT),
  profilePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  expiresAt: z.string().datetime(),
  bundleDigest: sha256Schema,
  recordedAt: z.string().datetime(),
  managerInstanceId: z.string().uuid(),
  prepareIdempotencyHash: sha256Schema.optional(),
  gameLaunchEvidence: z.lazy(() => gameLaunchEvidenceSchema).optional(),
  gameLaunchAttempt: gameLaunchAttemptLinkSchema.optional(),
});
type PreparedDescriptor = z.infer<typeof preparedDescriptorSchema>;

const preparedSessionIndexSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  sessionId: z.string().min(1).max(96),
  preparedLaunchId: preparedLaunchIdSchema,
  descriptorFingerprint: sha256Schema,
  expiresAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
type PreparedSessionIndex = z.infer<typeof preparedSessionIndexSchema>;

const executableFileIdentitySchema = z.object({
  sha256: sha256Schema,
  size: decimalSchema,
  device: decimalSchema,
  inode: decimalSchema,
});
type ExecutableFileIdentity = z.infer<typeof executableFileIdentitySchema>;

const runtimeExecutableEvidenceSchema = z.object({
  schemaVersion: z.literal(OWNED_RUNTIME_EXECUTABLE_EVIDENCE_SCHEMA_VERSION),
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  executablePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  executableFile: executableFileIdentitySchema,
  executableEvidenceDigest: sha256Schema,
});

const gameLaunchEvidenceSchema = z.object({
  schemaVersion: z.literal(OWNED_GAME_LAUNCH_PREPARATION_EVIDENCE_SCHEMA_VERSION),
  prepareKey: z.union([canonicalGameLaunchPrepareKeySchema, gameLaunchAttemptKeySchema]),
  projectComparisonKey: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  world: z.object({}).passthrough(),
  addons: z.object({}).passthrough(),
  executable: runtimeExecutableEvidenceSchema,
  gameLaunchEvidenceDigest: sha256Schema,
});
const preparedInvalidationSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  preparedLaunchId: preparedLaunchIdSchema,
  sessionId: z.string().min(1).max(PREPARED_SESSION_ID_MAX_UTF16_UNITS),
  invalidatedAt: z.string().datetime(),
  planningCode: z.string().min(1).max(64),
  gameLaunchEvidenceDigest: sha256Schema,
  unconsumed: z.literal(true),
  managerInstanceId: z.string().uuid(),
});
type PreparedInvalidation = z.infer<typeof preparedInvalidationSchema>;

const mcpOwnerSchema = z.object({
  installationId: z.string().regex(/^[a-f0-9]{64}$/),
  managerInstanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  executablePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  creationTimeFileTime: fileTimeSchema,
  userSid: z.string().min(1).max(WINDOWS_SID_MAX_CHARS),
});

const runtimeReceiptSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  preparedLaunchId: preparedLaunchIdSchema,
  pid: z.number().int().positive(),
  executablePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  executableFile: executableFileIdentitySchema,
  creationTimeFileTime: fileTimeSchema,
  ownerTokenArgument: z.string().max(192).startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX),
  argvSha256: sha256Schema,
  profilePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  startedAt: z.string().datetime(),
  launchedAtMs: z.number().int().positive(),
  preparedExpiresAt: z.string().datetime(),
  mcpOwner: mcpOwnerSchema,
});
export type OwnedRuntimeReceipt = z.infer<typeof runtimeReceiptSchema>;

const stopReceiptSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  stoppedAt: z.string().datetime(),
  termination: z.enum(["terminated", "already_exited"]),
  identityVacant: z.literal(true),
  vacancyProof: z.enum(["pid_absent", "exact_identity_absent", "retained_handle_exit"]),
  stopIdempotencyHash: sha256Schema,
  restorationProofKind: z.enum([
    "process_already_exited",
    "live_stop_reservation",
    "exact_runtime_vacancy",
    "clean_shutdown_restoration_seal",
  ]),
  restorationProvedAt: z.string().datetime(),
  restorationReservationId: z.string().uuid().optional(),
  mcpActor: mcpOwnerSchema,
});
type StopReceipt = z.infer<typeof stopReceiptSchema>;

const stopCompletionSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  preparedLaunchId: preparedLaunchIdSchema,
  completedAt: z.string().datetime(),
  observerCompleted: z.literal(true),
  sessionRevoked: z.boolean(),
});
type StopCompletion = z.infer<typeof stopCompletionSchema>;

const childExitReceiptSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  pid: z.number().int().positive(),
  executablePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  creationTimeFileTime: fileTimeSchema,
  observedAt: z.string().datetime(),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(64).nullable(),
});
type ChildExitReceipt = z.infer<typeof childExitReceiptSchema>;

const restorationProofSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  managerInstanceId: z.string().uuid(),
  sealedAt: z.string().datetime(),
  kind: z.enum([
    "clean_shutdown_restoration_seal",
    "live_stop_reservation",
    "exact_runtime_vacancy",
  ]),
  reservationId: z.string().uuid().optional(),
  stopIdempotencyHash: sha256Schema.optional(),
  activeJobIds: z.tuple([]),
  cameraLeaseJobIds: z.tuple([]),
  restorationPendingJobIds: z.tuple([]),
});
type RestorationProof = z.infer<typeof restorationProofSchema>;

interface StopReservation {
  proof: RestorationProof;
}

interface StopCompletionAuthority {
  receipt: OwnedRuntimeReceipt;
  stopped: StopReceipt;
  restorationProof: RestorationProof | null;
  authorityFingerprint: string;
  reservationId?: string;
  idempotencyPath: string;
  keyHash: string;
  requestFingerprint: string;
}

interface StopCompletionAck {
  sessionRevoked: boolean;
}

interface OwnedRuntimeLeaseFence {
  /** Refuse any further irreversible work after the native mutex holder exits. */
  assertActive(): void;
  /** Synchronously aborted when the native mutex holder exits. */
  readonly signal: AbortSignal;
  /** Register one abort/deadline-owning physical read for lease-loss joining. */
  trackRevalidation<T>(operation: Promise<T>): Promise<T>;
}

interface OwnedRuntimeWallDeadline {
  expiresAtMs: number;
  code: "RECOVERY_REQUIRED" | "SHUTDOWN_SEAL_FAILED";
  message: string;
  details?: Record<string, unknown>;
}

type StopLockedResult =
  | { kind: "complete"; status: OwnedRuntimePublicStatus }
  | { kind: "observer_completion_required"; authority: StopCompletionAuthority };

const consumptionSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  preparedLaunchId: preparedLaunchIdSchema,
  runtimeId: runtimeIdSchema,
  idempotencyHash: sha256Schema,
  requestFingerprint: sha256Schema,
  consumedAt: z.string().datetime(),
});

const idempotencySchema = z.object({
  version: z.literal(STORAGE_VERSION),
  action: z.enum(["start", "stop"]),
  keyHash: sha256Schema,
  requestFingerprint: sha256Schema,
  runtimeId: runtimeIdSchema,
  state: z.enum(["starting", "succeeded"]),
  updatedAt: z.string().datetime(),
});

const pendingStartSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  preparedLaunchId: preparedLaunchIdSchema,
  state: z.enum([
    "pre_spawn",
    "spawned_unverified",
    "identity_verified",
    "cleanup_required",
    // Legacy v1 value written before release acknowledgement was separated.
    "cleanup_verified",
    "release_required",
    "release_acknowledged",
    "succeeded",
  ]),
  pid: z.number().int().positive().nullable(),
  creationTimeFileTime: fileTimeSchema.nullable(),
  executablePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  executableFile: executableFileIdentitySchema,
  ownerTokenArgument: z.string().max(192).startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX),
  argvSha256: sha256Schema,
  // Optional only for v1 pending receipts written before lifecycle leasing was
  // introduced. New identity-verified receipts always persist both fields.
  launchedAtMs: z.number().int().positive().optional(),
  lifecycleGeneration: sha256Schema.nullable().optional(),
  mcpOwner: mcpOwnerSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().max(512).optional(),
});
type PendingStart = z.infer<typeof pendingStartSchema>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalFingerprintFromPrepareKey(prepareKey: string): string {
  const parsed = canonicalGameLaunchPrepareKeySchema.safeParse(prepareKey);
  if (!parsed.success) {
    throw new OwnedRuntimeError(
      "INVALID_REQUEST",
      "Canonical game-launch evidence does not carry a baseline fingerprint",
    );
  }
  return prepareKey.slice(prepareKey.lastIndexOf("-") + 1);
}

type RuntimeLifecycleGenerationInput = Pick<OwnedRuntimeReceipt,
  | "runtimeId"
  | "sessionId"
  | "preparedLaunchId"
  | "pid"
  | "executablePath"
  | "creationTimeFileTime"
  | "ownerTokenArgument"
  | "launchedAtMs"
>;

function runtimeLifecycleGeneration(receipt: RuntimeLifecycleGenerationInput): string {
  return sha256(JSON.stringify({
    runtimeId: receipt.runtimeId,
    sessionId: receipt.sessionId,
    preparedLaunchId: receipt.preparedLaunchId,
    pid: receipt.pid,
    executablePath: receipt.executablePath,
    creationTimeFileTime: receipt.creationTimeFileTime,
    ownerTokenArgument: receipt.ownerTokenArgument,
    launchedAtMs: receipt.launchedAtMs,
  }));
}

function deterministicReservationId(...parts: string[]): string {
  const value = createHash("sha256").update(parts.join("\0"), "utf8").digest();
  value[6] = (value[6] & 0x0f) | 0x40;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = value.toString("hex", 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function inspectExecutableFile(
  filePath: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): ExecutableFileIdentity {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("Runtime executable byte limit must be a positive safe integer");
  }
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", "Configured runtime executable is not a regular file");
    }
    if (before.size > BigInt(maximumBytes)) {
      throw new GameLaunchPlanError(
        "EXECUTABLE_OVERSIZE",
        `Configured runtime executable exceeds its ${maximumBytes}-byte planning limit.`,
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      // Retain one sentinel byte so concurrent growth cannot turn the initial
      // size check into an unbounded read.
      const readLength = Math.min(buffer.length, maximumBytes - position + 1);
      const bytes = readSync(descriptor, buffer, 0, readLength, position);
      if (bytes === 0) break;
      position += bytes;
      if (position > maximumBytes) {
        throw new GameLaunchPlanError(
          "EXECUTABLE_OVERSIZE",
          `Configured runtime executable exceeds its ${maximumBytes}-byte planning limit.`,
        );
      }
      digest.update(buffer.subarray(0, bytes));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", "Configured runtime executable changed while its identity was inspected");
    }
    return executableFileIdentitySchema.parse({
      sha256: digest.digest("hex"),
      size: after.size.toString(),
      device: after.dev.toString(),
      inode: after.ino.toString(),
    });
  } finally {
    closeSync(descriptor);
  }
}

export function computeOwnedRuntimeExecutableEvidenceDigest(
  value: Omit<OwnedRuntimeExecutableEvidence, "executableEvidenceDigest">,
): string {
  return sha256(JSON.stringify([
    "reforger-forge-owned-runtime-executable-evidence",
    value.schemaVersion,
    value.runtimeKind,
    value.executablePath,
    [
      value.executableFile.sha256,
      value.executableFile.size,
      value.executableFile.device,
      value.executableFile.inode,
    ],
  ]));
}

/**
 * Resolve and attest an executable from a serializable source. Callers that
 * perform this work in an isolated worker can impose a planning-only byte cap
 * without weakening the later start-boundary revalidation.
 */
export function resolveRuntimeExecutableEvidenceFromSource(
  source: OwnedRuntimeExecutablePlanningSource,
  runtimeKind: ObserverLaunchInput["runtimeKind"],
  maximumBytes = Number.MAX_SAFE_INTEGER,
): OwnedRuntimeExecutableEvidence {
  try {
    const executablePath = source.kind === "gamePath"
      ? resolveRuntimeExecutable(source.gamePath, runtimeKind)
      : canonicalFile(source.executablePath, `${runtimeKind} runtime executable`);
    const fields: Omit<OwnedRuntimeExecutableEvidence, "executableEvidenceDigest"> = {
      schemaVersion: OWNED_RUNTIME_EXECUTABLE_EVIDENCE_SCHEMA_VERSION,
      runtimeKind,
      executablePath,
      executableFile: Object.freeze({ ...inspectExecutableFile(executablePath, maximumBytes) }),
    };
    return Object.freeze({
      ...fields,
      executableEvidenceDigest: computeOwnedRuntimeExecutableEvidenceDigest(fields),
    });
  } catch (error) {
    if (error instanceof OwnedRuntimeError || error instanceof GameLaunchPlanError) throw error;
    throw new OwnedRuntimeError(
      "IDENTITY_UNVERIFIABLE",
      "Configured runtime executable identity could not be verified",
    );
  }
}

export function computeOwnedGameLaunchEvidenceDigest(
  value: Omit<OwnedGameLaunchPreparationEvidence, "gameLaunchEvidenceDigest">,
): string {
  return sha256(JSON.stringify([
    "reforger-forge-owned-game-launch-evidence",
    value.schemaVersion,
    value.prepareKey,
    value.projectComparisonKey,
    value.world.schemaVersion,
    value.world.worldEvidenceDigest,
    value.addons.schemaVersion,
    value.addons.addonEvidenceDigest,
    value.executable.schemaVersion,
    value.executable.executableEvidenceDigest,
  ]));
}

function validatedGameLaunchEvidence(value: unknown): OwnedGameLaunchPreparationEvidence {
  try {
    const parsed = gameLaunchEvidenceSchema.parse(value);
    const world = parsed.world as unknown as GameWorldPlanSnapshot;
    const addons = parsed.addons as unknown as GameAddonPlanSnapshot;
    const executable = parsed.executable as OwnedRuntimeExecutableEvidence;
    if (computeGameWorldEvidenceDigest(world) !== world.worldEvidenceDigest ||
        computeGameAddonEvidenceDigest(addons) !== addons.addonEvidenceDigest ||
        computeOwnedRuntimeExecutableEvidenceDigest(executable) !== executable.executableEvidenceDigest ||
        parsed.projectComparisonKey !== world.project.comparisonKey ||
        parsed.projectComparisonKey !== addons.project.comparisonKey ||
        pathKey(addons.executablePath) !== pathKey(executable.executablePath)) {
      throw new Error("nested evidence digest mismatch");
    }
    const candidate: OwnedGameLaunchPreparationEvidence = {
      schemaVersion: OWNED_GAME_LAUNCH_PREPARATION_EVIDENCE_SCHEMA_VERSION,
      prepareKey: parsed.prepareKey,
      projectComparisonKey: parsed.projectComparisonKey,
      world,
      addons,
      executable,
      gameLaunchEvidenceDigest: parsed.gameLaunchEvidenceDigest,
    };
    if (computeOwnedGameLaunchEvidenceDigest(candidate) !== parsed.gameLaunchEvidenceDigest) {
      throw new Error("aggregate evidence digest mismatch");
    }
    return candidate;
  } catch (error) {
    throw new OwnedRuntimeError(
      "STORAGE_UNVERIFIABLE",
      "Prepared game-launch evidence does not satisfy its persisted digest contract",
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
}

function executableFilesMatch(left: ExecutableFileIdentity, right: ExecutableFileIdentity): boolean {
  return left.sha256 === right.sha256 && left.size === right.size &&
    left.device === right.device && left.inode === right.inode;
}

// Matches the quoting used by libuv/Node when windowsVerbatimArguments is false.
function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/u.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function assertWindowsCommandLineFits(executablePath: string, argumentsArray: readonly string[]): void {
  const lengthWithNull = [executablePath, ...argumentsArray]
    .map(quoteWindowsArgument)
    .join(" ").length + 1;
  if (lengthWithNull > WINDOWS_COMMAND_LINE_MAX_UTF16_UNITS) {
    throw new OwnedRuntimeError(
      "ARGUMENT_CONFLICT",
      "Prepared arguments exceed the Windows CreateProcess command-line limit",
      undefined,
      "command_line_overflow"
    );
  }
}

function pathKey(value: string): string {
  return pathComparisonKey(value);
}

function isContained(root: string, candidate: string): boolean {
  return isPathContained(root, candidate);
}

function assertNoLinkedDirectorySegments(directoryPath: string): void {
  const absolute = resolve(directoryPath);
  try {
    resolveManagedPath(parse(absolute).root, absolute, "no-links");
  } catch (error) {
    throw new OwnedRuntimeError(
      "STORAGE_UNVERIFIABLE",
      `Owned-runtime storage traverses a link or non-directory: ${absolute}`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function canonicalDirectory(directoryPath: string, create: boolean, rejectLinkedSegments = false): string {
  const absolute = resolve(directoryPath);
  if (rejectLinkedSegments) assertNoLinkedDirectorySegments(absolute);
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (rejectLinkedSegments) assertNoLinkedDirectorySegments(absolute);
  const supplied = lstatSync(absolute);
  if (supplied.isSymbolicLink() || !supplied.isDirectory()) {
    throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", `Owned-runtime storage is not a regular directory: ${absolute}`);
  }
  try {
    return canonicalizeExistingDirectory(absolute, "Owned-runtime storage");
  } catch (error) {
    throw new OwnedRuntimeError(
      "STORAGE_UNVERIFIABLE",
      error instanceof Error ? error.message : `Owned-runtime storage cannot be resolved: ${absolute}`
    );
  }
}

function canonicalDirectoryTarget(directoryPath: string, rejectLinkedSegments: boolean): string {
  try {
    return canonicalizePotentialPath(directoryPath, {
      linkPolicy: rejectLinkedSegments ? "no-links" : "follow-existing",
      existingAncestor: "directory",
      label: "Owned-runtime storage",
    });
  } catch (error) {
    throw new OwnedRuntimeError(
      "STORAGE_UNVERIFIABLE",
      error instanceof Error
        ? error.message
        : `Owned-runtime storage cannot be resolved: ${resolve(directoryPath)}`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function canonicalFile(filePath: string, label: string): string {
  const absolute = resolve(filePath);
  try {
    return assertRegularManagedFile(dirname(absolute), absolute);
  } catch {
    throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", `${label} is not a regular non-link file`);
  }
}

function assertNoOwnerArgument(argumentsArray: readonly string[]): void {
  const prefix = OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX.toLowerCase();
  const bare = prefix.slice(0, -1);
  if (argumentsArray.some((argument) => {
    const normalized = argument.toLowerCase();
    return normalized === bare || normalized.startsWith(prefix);
  })) {
    throw new OwnedRuntimeError(
      "ARGUMENT_CONFLICT",
      "Prepared launch arguments already contain an owner-token argument",
      undefined,
      "owner_token_injection"
    );
  }
}

function boundedIdempotencyKey(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\0\r\n]/.test(value)) {
    throw new OwnedRuntimeError("INVALID_REQUEST", "Idempotency key must contain 1 through 128 bounded characters");
  }
  return value;
}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

/** Resolve only allowlisted runtime names beneath the configured game installation. */
export function resolveRuntimeExecutable(
  gamePath: string,
  runtimeKind: ObserverLaunchInput["runtimeKind"]
): string {
  const gameRoot = canonicalDirectory(gamePath, false);
  const dedicated = runtimeKind === "dedicated";
  const names = dedicated
    ? [
      "ArmaReforgerServerSteamDiag.exe",
      "ArmaReforgerServerDiag.exe",
      "ArmaReforgerServerSteam.exe",
      "ArmaReforgerServer.exe",
    ]
    : [
      "ArmaReforgerSteamDiag.exe",
      "ArmaReforgerDiag.exe",
      "ArmaReforgerSteam.exe",
      "ArmaReforger.exe",
    ];
  for (const name of names) {
    const candidate = join(gameRoot, name);
    if (!existsSync(candidate)) continue;
    const executable = canonicalFile(
      candidate,
      `Configured Arma Reforger ${dedicated ? "dedicated-server" : "graphical"} executable`
    );
    if (!isContained(gameRoot, executable)) {
      throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", "Configured runtime executable escapes the game installation");
    }
    return executable;
  }
  throw new OwnedRuntimeError(
    "RUNTIME_NOT_FOUND",
    `No allowlisted ${dedicated ? "dedicated-server" : "graphical"} Arma Reforger executable exists beneath the configured game path`,
    undefined,
    "runtime_executable_missing"
  );
}

/** Compatibility export for graphical client/listen-server callers. */
export function resolveGraphicalRuntimeExecutable(gamePath: string): string {
  return resolveRuntimeExecutable(gamePath, "client");
}

export class OwnedRuntimeManager implements ObserverPreparedLaunchRecorder, McpIdleReadinessProvider {
  readonly managerInstanceId: string;
  readonly installationId: string;
  readonly storageRoot: string;
  private readonly backend: ExactProcessBackend;
  private readonly machineMutex: MachineMutex;
  private readonly durableReservations = new DurableReservationGate();
  private readonly spawnProcess: typeof nodeSpawn;
  private readonly prepareForegroundDuringStartup: (
    input: RuntimeFocusGuardPreparation
  ) => Promise<RuntimeFocusGuardTransaction>;
  private readonly clock: () => number;
  private readonly sleeper: Sleeper;
  private readonly createOwnerToken: () => string;
  private readonly createId: () => string;
  private readonly resolveExecutable: (runtimeKind: ObserverLaunchInput["runtimeKind"]) => string;
  private readonly pointOfUseRevalidator: (
    request: IsolatedGameLaunchRevalidationRequest,
    signal: AbortSignal,
  ) => Promise<OwnedRuntimeExecutableEvidence>;
  private readonly inspectionTimeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly receiptRetentionMs: number;
  private readonly maxStoreRecords: number;
  private readonly maxStoreBytes: number;
  private readonly maxRecordBytes: number;
  private readonly managedRoot: string;
  private readonly children: ChildSupervisor;
  private readonly admissionGate: McpHostAdmissionGate | undefined;
  private recordStoreInstance: LmdbRecordStore | null = null;
  private existingRecordReader: LmdbRecordStore | null = null;
  private existingSnapshotAccessTail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<Record<string, unknown>> | null = null;
  private idleRevision = 0;

  constructor(private readonly options: OwnedRuntimeManagerOptions) {
    this.managerInstanceId = options.managerInstanceId === undefined
      ? randomUUID()
      : parseMcpInstanceId(options.managerInstanceId, "Owned runtime manager instance ID");
    this.admissionGate = options.admissionGate;
    this.children = new ChildSupervisor({ admissionGate: options.admissionGate });
    this.backend = options.backend ?? defaultOwnedRuntimeBackend();
    const machineMutex = options.machineMutex ??
      (providesMachineMutex(this.backend) ? this.backend : null);
    if (!machineMutex) {
      throw new OwnedRuntimeError(
        "INVALID_REQUEST",
        "Owned runtime process backend requires a machine mutex adapter"
      );
    }
    this.machineMutex = machineMutex;
    this.spawnProcess = options.spawnProcess ?? nodeSpawn;
    this.prepareForegroundDuringStartup = options.prepareForegroundDuringStartup ??
      prepareWindowsForegroundDuringRuntimeStartup;
    this.clock = options.clock ?? Date.now;
    this.sleeper = options.sleeper ?? systemSleeper;
    this.createOwnerToken = options.ownerToken ?? (() => randomBytes(32).toString("base64url"));
    this.createId = options.randomId ?? randomUUID;
    this.resolveExecutable = options.executableResolver ??
      ((runtimeKind) => resolveRuntimeExecutable(options.gamePath, runtimeKind));
    this.pointOfUseRevalidator = options.pointOfUseRevalidator ??
      revalidateGameLaunchPointOfUseIsolated;
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
    this.terminationTimeoutMs = options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
    this.receiptRetentionMs = options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS;
    this.maxStoreRecords = options.maxStoreRecords ?? DEFAULT_MAX_STORE_RECORDS;
    this.maxStoreBytes = options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    for (const [label, value, minimum, maximum] of [
      ["inspection timeout", this.inspectionTimeoutMs, 100, 60_000],
      ["termination timeout", this.terminationTimeoutMs, 100, 5 * 60_000],
      ["lifecycle lock timeout", this.lockTimeoutMs, 100, 60_000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new OwnedRuntimeError("INVALID_REQUEST", `Owned runtime ${label} is invalid`);
      }
    }
    for (const [label, value, minimum, maximum] of [
      ["receipt retention", this.receiptRetentionMs, 0, 365 * 24 * 60 * 60_000],
      ["store record count", this.maxStoreRecords, 8, 1_000_000],
      ["store byte budget", this.maxStoreBytes, 4_096, 4 * 1024 * 1024 * 1024],
      ["record byte budget", this.maxRecordBytes, 1_024, MAX_CONFIGURABLE_RECORD_BYTES],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new OwnedRuntimeError("INVALID_REQUEST", `Owned runtime ${label} is invalid`);
      }
    }
    if (this.maxRecordBytes > this.maxStoreBytes) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "Owned runtime record byte budget exceeds the store budget");
    }
    const requestedManagedRoot = resolve(options.managedRoot);
    this.managedRoot = canonicalDirectoryTarget(requestedManagedRoot, true);
    this.storageRoot = join(this.managedRoot, "state", "owned-runtimes-v1");
    const installationRoot = canonicalDirectory(
      options.installationRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      false
    );
    this.installationId = sha256(pathKey(installationRoot));
  }

  /**
   * Resolve the configured runtime executable through the same final-file
   * identity boundary used by start. This read-only query creates no profile
   * or lifecycle storage.
   */
  resolveRuntimeExecutablePath(
    runtimeKind: ObserverLaunchInput["runtimeKind"],
  ): string {
    return canonicalFile(
      this.resolveExecutable(runtimeKind),
      `${runtimeKind} runtime executable`,
    );
  }

  /**
   * Capture only the serializable input needed for isolated launch planning.
   * The production resolver defers every filesystem lookup to the worker. An
   * injected resolver is expected to return a configured path without doing
   * filesystem traversal itself.
   */
  resolveRuntimeExecutablePlanningSource(
    runtimeKind: ObserverLaunchInput["runtimeKind"],
  ): OwnedRuntimeExecutablePlanningSource {
    try {
      return this.options.executableResolver === undefined
        ? Object.freeze({ kind: "gamePath", gamePath: this.options.gamePath })
        : Object.freeze({
            kind: "executablePath",
            executablePath: this.options.executableResolver(runtimeKind),
          });
    } catch (error) {
      if (error instanceof OwnedRuntimeError) throw error;
      throw new OwnedRuntimeError(
        "IDENTITY_UNVERIFIABLE",
        "Configured runtime executable identity could not be verified",
      );
    }
  }

  resolveRuntimeExecutableEvidence(
    runtimeKind: ObserverLaunchInput["runtimeKind"],
  ): OwnedRuntimeExecutableEvidence {
    return resolveRuntimeExecutableEvidenceFromSource(
      this.resolveRuntimeExecutablePlanningSource(runtimeKind),
      runtimeKind,
    );
  }

  private async withFencedMachineMutex<T>(
    action: (fence: OwnedRuntimeLeaseFence) => Promise<T>,
    deadline?: OwnedRuntimeWallDeadline
  ): Promise<T> {
    let leaseLoss: MachineMutexLeaseLoss | null = null;
    const leaseAbort = new AbortController();
    const inFlightRevalidation = new Set<Promise<void>>();
    const fence: OwnedRuntimeLeaseFence = {
      signal: leaseAbort.signal,
      trackRevalidation: <Result>(operation: Promise<Result>): Promise<Result> => {
        // The injected boundary contract guarantees that settlement means its
        // worker/helper has stopped. Keep a non-rejecting mirror solely for a
        // lease-loss drain; callers still receive the original typed outcome.
        const settlement = operation.then(() => undefined, () => undefined);
        inFlightRevalidation.add(settlement);
        void settlement.then(() => { inFlightRevalidation.delete(settlement); });
        return operation;
      },
      assertActive: () => {
        if (leaseLoss) {
          throw new OwnedRuntimeError(
            "RECOVERY_REQUIRED",
            "Owned-runtime lifecycle mutex lease was lost; durable state was preserved for recovery",
            { reason: leaseLoss.code ?? "MUTEX_LEASE_LOST" }
          );
        }
        if (deadline) this.remainingWallBudget(deadline);
      },
    };
    const acquire = async (remainingMs = this.lockTimeoutMs): Promise<T> =>
      this.machineMutex.withMachineMutex({
        name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
        timeoutMs: Math.min(this.lockTimeoutMs, remainingMs),
        onLeaseLost: (error) => {
          leaseLoss = error;
          leaseAbort.abort(error);
        },
        action: async () => {
          fence.assertActive();
          const result = await action(fence);
          fence.assertActive();
          return result;
        },
      });
    try {
      return await (deadline
        ? this.beforeWallDeadline(deadline, (remainingMs) => acquire(remainingMs))
        : acquire());
    } catch (error) {
      if (leaseLoss) {
        // WindowsExactProcessBackend may reject its holder race before the
        // protected async action settles. Do not publish that rejection until
        // every abort-owning revalidation boundary has joined its worker.
        while (inFlightRevalidation.size > 0) {
          await Promise.all([...inFlightRevalidation]);
        }
        fence.assertActive();
      }
      throw error;
    }
  }

  private remainingWallBudget(deadline: OwnedRuntimeWallDeadline): number {
    const remaining = Math.floor(deadline.expiresAtMs - Date.now());
    if (remaining <= 0) {
      throw new OwnedRuntimeError(deadline.code, deadline.message, {
        ...deadline.details,
        wallDeadlineExpired: true,
      });
    }
    return remaining;
  }

  /**
   * Start an uncancellable dependency only after proving budget remains and
   * bound the caller's wait. Callers must still fence local mutation after an
   * awaited dependency because the dependency may settle after this race.
   */
  private async beforeWallDeadline<T>(
    deadline: OwnedRuntimeWallDeadline,
    operation: (remainingMs: number) => Promise<T>
  ): Promise<T> {
    const remaining = this.remainingWallBudget(deadline);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(remaining),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new OwnedRuntimeError(
            deadline.code,
            deadline.message,
            { ...deadline.details, wallDeadlineExpired: true }
          )), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isWallDeadlineError(error: unknown): boolean {
    return error instanceof OwnedRuntimeError && error.details?.wallDeadlineExpired === true;
  }

  private async retainRuntimeLifecycle(
    receipt: OwnedRuntimeReceipt,
    deadline?: OwnedRuntimeWallDeadline
  ): Promise<void> {
    const generation = runtimeLifecycleGeneration(receipt);
    const request = () => this.options.observerGate.retainRuntimeLifecycle(
      receipt.sessionId,
      receipt.runtimeId,
      generation,
      this.runtimeLifecycleAuthority(receipt)
    );
    const response = deadline
      ? await this.beforeWallDeadline(deadline, () => request())
      : await request();
    const acknowledgement = response && typeof response === "object"
      ? response as Record<string, unknown>
      : null;
    if (acknowledgement?.retained !== true || acknowledgement.generation !== generation) {
      throw new OwnedRuntimeError(
        "SESSION_UNVERIFIABLE",
        "Observer session did not acknowledge the exact owned runtime lifecycle generation"
      );
    }
  }

  private async releaseRuntimeLifecycle(
    receipt: OwnedRuntimeReceipt,
    deadline?: OwnedRuntimeWallDeadline
  ): Promise<void> {
    await this.releaseRuntimeLifecycleIdentity(
      receipt.sessionId,
      receipt.runtimeId,
      runtimeLifecycleGeneration(receipt),
      deadline
    );
  }

  private async releaseRuntimeLifecycleIdentity(
    sessionId: string,
    runtimeId: string,
    generation: string,
    deadline?: OwnedRuntimeWallDeadline
  ): Promise<void> {
    const request = () => this.options.observerGate.releaseRuntimeLifecycle(
      sessionId,
      runtimeId,
      generation
    );
    const response = deadline
      ? await this.beforeWallDeadline(deadline, () => request())
      : await request();
    const acknowledgement = response && typeof response === "object"
      ? response as Record<string, unknown>
      : null;
    if (acknowledgement?.generation !== generation ||
        (acknowledgement.released !== true && acknowledgement.alreadyReleased !== true)) {
      throw new OwnedRuntimeError(
        "SESSION_UNVERIFIABLE",
        "Observer session did not acknowledge release of the exact runtime lifecycle generation"
      );
    }
  }

  private runtimeLifecycleAuthority(
    receipt: OwnedRuntimeReceipt
  ): OwnedRuntimeLifecycleAuthority {
    return {
      preparedLaunchId: receipt.preparedLaunchId,
      profilePath: receipt.profilePath,
      runtimeKind: receipt.runtimeKind,
      pid: receipt.pid,
      executablePath: receipt.executablePath,
      creationTimeFileTime: receipt.creationTimeFileTime,
      ownerTokenArgument: receipt.ownerTokenArgument,
      launchedAtMs: receipt.launchedAtMs,
    };
  }

  private pendingLifecycleAuthority(pending: PendingStart): {
    generation: string;
    identity: OwnedRuntimeExactIdentity & { ownerTokenArgument: string; launchedAtMs: number };
  } | null {
    if (!pending.lifecycleGeneration) return null;
    if (pending.pid === null || pending.creationTimeFileTime === null ||
        pending.launchedAtMs === undefined) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Pending lifecycle generation has no exact child identity"
      );
    }
    const generation = runtimeLifecycleGeneration({
      runtimeId: pending.runtimeId,
      sessionId: pending.sessionId,
      preparedLaunchId: pending.preparedLaunchId,
      pid: pending.pid,
      executablePath: pending.executablePath,
      creationTimeFileTime: pending.creationTimeFileTime,
      ownerTokenArgument: pending.ownerTokenArgument,
      launchedAtMs: pending.launchedAtMs,
    });
    if (generation !== pending.lifecycleGeneration) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Pending lifecycle generation does not match its exact child identity"
      );
    }
    return {
      generation,
      identity: {
        pid: pending.pid,
        executablePath: pending.executablePath,
        creationTime: pending.creationTimeFileTime,
        ownerTokenArgument: pending.ownerTokenArgument,
        launchedAtMs: pending.launchedAtMs,
      },
    };
  }

  private pendingIdentityDisposition(
    authority: NonNullable<ReturnType<OwnedRuntimeManager["pendingLifecycleAuthority"]>>,
    inspection: OwnedRuntimeInspection | null
  ): "same" | "absent" | "unverifiable" {
    if (!inspection) return "absent";
    if (inspection.identity.pid !== authority.identity.pid ||
        pathKey(inspection.identity.executablePath) !== pathKey(authority.identity.executablePath) ||
        inspection.identity.creationTime !== authority.identity.creationTime ||
        inspection.ownerArgumentMatched === false) {
      return "absent";
    }
    return inspection.ownerArgumentMatched === true ? "same" : "unverifiable";
  }

  private markPendingStartReleaseRequired(
    root: string,
    pending: PendingStart,
    generation: string
  ): PendingStart {
    const authority = this.pendingLifecycleAuthority(pending);
    if (!authority || authority.generation !== generation) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Pending cleanup release is not bound to its exact lifecycle generation"
      );
    }
    if (pending.state === "release_acknowledged" || pending.state === "release_required") {
      return pending;
    }
    const releaseRequired = this.updatePendingStart(root, pending, {
      state: "release_required",
    });
    this.children.forget(pending.runtimeId);
    return releaseRequired;
  }

  private async recoverPendingStartCleanup(
    root: string,
    pending: PendingStart,
    leaseFence: OwnedRuntimeLeaseFence
  ): Promise<PendingStart> {
    if (!["identity_verified", "cleanup_required", "cleanup_verified", "release_required", "release_acknowledged"]
      .includes(pending.state)) {
      return pending;
    }
    const authority = this.pendingLifecycleAuthority(pending);
    if (!authority) return pending;
    if (pending.state === "release_acknowledged" || pending.state === "release_required") {
      return pending;
    }
    if (pending.state === "cleanup_verified") {
      // Migrate an exact-generation v1 record. `cleanup_verified` was written
      // before release acknowledgement had its own durable commit.
      return this.markPendingStartReleaseRequired(root, pending, authority.generation);
    }

    let inspection: OwnedRuntimeInspection | null;
    try {
      inspection = await this.backend.inspectProcess(
        authority.identity.pid,
        authority.identity.ownerTokenArgument
      );
    } catch (error) {
      throw new OwnedRuntimeError(
        "START_UNVERIFIABLE",
        `Pending owned child cleanup cannot inspect the exact identity: ${this.message(error)}`,
        { state: pending.state, pid: pending.pid }
      );
    }
    leaseFence.assertActive();
    let disposition = this.pendingIdentityDisposition(authority, inspection);
    if (disposition === "absent") {
      return this.markPendingStartReleaseRequired(root, pending, authority.generation);
    }
    if (disposition === "unverifiable") {
      throw new OwnedRuntimeError(
        "START_UNVERIFIABLE",
        "Pending owned child command-line identity is unverifiable; its lifecycle lease was retained",
        { state: pending.state, pid: pending.pid }
      );
    }

    let terminationFailure: unknown = null;
    try {
      const result = await this.backend.verifyAndTerminate(
        authority.identity,
        this.terminationTimeoutMs
      );
      if (result.kind === "refused") terminationFailure = new Error(result.message);
    } catch (error) {
      // The helper may have failed after signalling. Only a fresh exact
      // inspection decides whether the lifecycle lease can be released.
      terminationFailure = error;
    }
    leaseFence.assertActive();
    try {
      inspection = await this.backend.inspectProcess(
        authority.identity.pid,
        authority.identity.ownerTokenArgument
      );
    } catch (error) {
      throw new OwnedRuntimeError(
        "START_UNVERIFIABLE",
        `Pending owned child cleanup outcome is unverifiable: ${this.message(error)}`,
        { state: pending.state, pid: pending.pid }
      );
    }
    leaseFence.assertActive();
    disposition = this.pendingIdentityDisposition(authority, inspection);
    if (disposition === "absent") {
      return this.markPendingStartReleaseRequired(root, pending, authority.generation);
    }
    throw new OwnedRuntimeError(
      "START_UNVERIFIABLE",
      disposition === "unverifiable"
        ? "Pending owned child cleanup left command-line identity unverifiable; its lifecycle lease was retained"
        : `Pending owned child is still live; its lifecycle lease was retained${terminationFailure ? `: ${this.message(terminationFailure)}` : ""}`,
      { state: pending.state, pid: pending.pid }
    );
  }

  private async reconcilePendingStartExit(
    expected: OwnedRuntimeReceipt
  ): Promise<void> {
    const reconciled = await this.withFencedMachineMutex(async (fence) => {
      const root = this.ensureStorage();
      const pending = this.readOptionalPendingStart(expected.runtimeId);
      if (!pending) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Exited unpublished child has no pending lifecycle receipt"
        );
      }
      const authority = this.pendingLifecycleAuthority(pending);
      if (!authority || authority.generation !== runtimeLifecycleGeneration(expected) ||
          pending.sessionId !== expected.sessionId || pending.pid !== expected.pid ||
          pathKey(pending.executablePath) !== pathKey(expected.executablePath) ||
          pending.creationTimeFileTime !== expected.creationTimeFileTime ||
          pending.ownerTokenArgument !== expected.ownerTokenArgument) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Exited unpublished child does not match its pending lifecycle generation"
        );
      }
      fence.assertActive();
      return this.markPendingStartReleaseRequired(root, pending, authority.generation);
    });
    await this.retryPendingStartLifecycleRelease(reconciled.runtimeId);
  }

  /**
   * Release IPC deliberately runs between two short machine-mutex
   * transactions. The first snapshots exact durable authority; the second
   * CASes `release_acknowledged`. A lost request or response leaves
   * `release_required` as the unsweepable retry head.
   */
  private async retryPendingStartLifecycleRelease(runtimeId: string): Promise<void> {
    const pending = await this.withFencedMachineMutex(async (fence) => {
      const root = this.ensureStorage();
      let current = this.readOptionalPendingStart(runtimeId);
      if (!current) return null;
      const authority = this.pendingLifecycleAuthority(current);
      if (!authority) return null;
      if (current.state === "cleanup_verified") {
        current = this.markPendingStartReleaseRequired(root, current, authority.generation);
      }
      fence.assertActive();
      return current.state === "release_required" ? current : null;
    });
    if (!pending) return;
    const authority = this.pendingLifecycleAuthority(pending);
    if (!authority) return;

    await this.releaseRuntimeLifecycleIdentity(
      pending.sessionId,
      pending.runtimeId,
      authority.generation
    );

    await this.withFencedMachineMutex(async (fence) => {
      const root = this.ensureStorage();
      const current = this.readOptionalPendingStart(runtimeId);
      if (!current) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Pending lifecycle release authority disappeared before acknowledgement"
        );
      }
      const currentAuthority = this.pendingLifecycleAuthority(current);
      if (!currentAuthority || currentAuthority.generation !== authority.generation ||
          current.sessionId !== pending.sessionId ||
          current.preparedLaunchId !== pending.preparedLaunchId) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Pending lifecycle generation changed before release acknowledgement"
        );
      }
      if (current.state === "release_acknowledged") return;
      if (current.state !== "release_required") {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Pending lifecycle release state changed before acknowledgement"
        );
      }
      fence.assertActive();
      this.updatePendingStart(root, current, { state: "release_acknowledged" });
    });
  }

  private async retryPendingStartLifecycleReleaseForKey(keyHash: string): Promise<void> {
    const runtimeId = await this.withFencedMachineMutex(async (fence) => {
      this.ensureStorage();
      const attempt = this.readOptionalParsed(
        this.idempotencyPath("start", keyHash),
        idempotencySchema,
        "start idempotency receipt"
      );
      fence.assertActive();
      return attempt?.action === "start" && attempt.keyHash === keyHash
        ? attempt.runtimeId
        : null;
    });
    if (runtimeId) await this.retryPendingStartLifecycleRelease(runtimeId);
  }

  private runtimeLifecycleIsTerminal(runtimeId: string): boolean {
    return this.readOptionalChildExitReceipt(runtimeId) !== null ||
      this.readOptionalStopCompletion(runtimeId) !== null;
  }

  private async reconcileRuntimeLifecycleLease(
    receipt: OwnedRuntimeReceipt,
    deadline?: OwnedRuntimeWallDeadline
  ): Promise<void> {
    if (this.runtimeLifecycleIsTerminal(receipt.runtimeId)) {
      await this.releaseRuntimeLifecycle(receipt, deadline);
      return;
    }
    // A durable restoration proof has already sealed capture for this exact
    // runtime generation. It is the restart authority when a replacement
    // private child cannot reconstruct the old in-memory session.
    if (this.readOptionalRestorationProof(receipt.runtimeId)) return;
    await this.retainRuntimeLifecycle(receipt, deadline);
  }

  async recordPreparedLaunch(
    input: ObserverLaunchInput,
    prepared: ObserverPreparedLaunch
  ): Promise<string> {
    return this.withAdmission("owned runtime preparation", () =>
      this.recordPreparedLaunchInternal(input, prepared));
  }

  private async recordPreparedLaunchInternal(
    input: ObserverLaunchInput,
    prepared: ObserverPreparedLaunch,
  ): Promise<string> {
    this.assertOpenForMutation();
    try {
      return await this.machineMutex.withMachineMutex({
        name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
        timeoutMs: this.lockTimeoutMs,
        action: async () => {
          this.assertOpenForMutation();
          return this.recordPreparedLaunchLocked(input, prepared);
        },
      });
    } catch (error) {
      throw this.normalizeError(error, "PREPARE_FAILED", "Prepared runtime launch could not be recorded");
    }
  }

  /**
   * Serialize one retryable, profile-fenced game-launch attempt across
   * MCP/private-child processes. `afterRuntimeId` is accepted only as proof of
   * the current, exactly stopped chain tip; it is never an idempotency token.
   */
  async prepareInitialOwnedGameLaunch(
    request: PrepareInitialOwnedGameLaunchInput,
  ): Promise<PreparedOwnedGameLaunch> {
    return this.withAdmission("owned game launch preparation", () =>
      this.prepareInitialOwnedGameLaunchInternal(request));
  }

  private async prepareInitialOwnedGameLaunchInternal(
    request: PrepareInitialOwnedGameLaunchInput,
  ): Promise<PreparedOwnedGameLaunch> {
    this.assertOpenForMutation();
    const evidence = validatedGameLaunchEvidence(request.evidence);
    const canonicalFingerprint = canonicalFingerprintFromPrepareKey(evidence.prepareKey);
    if (request.launchInput.idempotencyKey !== evidence.prepareKey ||
        request.launchInput.runtimeKind !== evidence.executable.runtimeKind ||
        pathKey(request.launchInput.profilePath) !== pathKey(evidence.addons.profilePath) ||
        pathKey(evidence.addons.managedRoot) !== pathKey(this.managedRoot)) {
      throw new OwnedRuntimeError(
        "INVALID_REQUEST",
        "Initial game-launch preparation input does not match its canonical evidence",
      );
    }
    if (request.afterRuntimeId !== undefined) runtimeIdSchema.parse(request.afterRuntimeId);
    try {
      return await this.withFencedMachineMutex(async (fence) => {
        this.assertOpenForMutation();
        this.ensureStorage();
        const profileKey = pathKey(request.launchInput.profilePath);
        const profileKeyDigest = sha256(profileKey);
        let chain = this.readOptionalGameLaunchChain(profileKey, profileKeyDigest);
        let reserved = false;
        if (!chain) {
          if (request.afterRuntimeId !== undefined) {
            throw new OwnedRuntimeError(
              "GAME_LAUNCH_PREDECESSOR_MISMATCH",
              "afterRuntimeId is not the current tip of this game-launch profile",
              { afterRuntimeId: request.afterRuntimeId },
            );
          }
          if (this.findPreparedGameLaunchForProfile(request.launchInput.profilePath, null)) {
            throw new OwnedRuntimeError(
              "RECOVERY_REQUIRED",
              "Retained baseline game-launch evidence has no profile attempt ledger and must be reconciled before launch",
            );
          }
          this.assertInitialGamePreparationHeadroom(
            this.storageRoot,
            request.launchInput,
            evidence,
          );
          chain = this.reserveGameLaunchAttempt(
            profileKey,
            profileKeyDigest,
            request.launchInput.profilePath,
            canonicalFingerprint,
            null,
            null,
            1,
          );
          this.atomicWrite(
            this.storageRoot,
            this.gameLaunchChainPath(profileKeyDigest),
            chain,
            true,
          );
          reserved = true;
        } else {
          chain = this.reconcileGameLaunchChainLocked(chain);
          const current = chain.current;
          if (request.afterRuntimeId === undefined) {
            if (current.predecessorRuntimeId !== null) {
              throw new OwnedRuntimeError(
                "GAME_LAUNCH_PREDECESSOR_REQUIRED",
                "This profile already has a successor chain; retry it with its exact afterRuntimeId",
                { afterRuntimeId: current.predecessorRuntimeId },
              );
            }
            if (current.canonicalFingerprint !== canonicalFingerprint) {
              throw new OwnedRuntimeError(
                "ARGUMENT_CONFLICT",
                "The initial game-launch attempt was retried with different canonical evidence",
              );
            }
          } else if (current.predecessorRuntimeId === request.afterRuntimeId) {
            if (current.canonicalFingerprint !== canonicalFingerprint) {
              throw new OwnedRuntimeError(
                "ARGUMENT_CONFLICT",
                "The successor attempt was retried with different canonical evidence",
                { afterRuntimeId: request.afterRuntimeId },
              );
            }
          } else {
            if (current.runtimeId !== request.afterRuntimeId) {
              throw new OwnedRuntimeError(
                "GAME_LAUNCH_PREDECESSOR_MISMATCH",
                "afterRuntimeId is not the current tip of this game-launch profile",
                {
                  afterRuntimeId: request.afterRuntimeId,
                  currentRuntimeId: current.runtimeId,
                },
              );
            }
            if (current.state !== "terminal" || !current.terminal) {
              throw new OwnedRuntimeError(
                "GAME_LAUNCH_PREDECESSOR_NOT_STOPPED",
                "The current game-launch runtime must complete exact stop, restoration, sealing, and revocation before a successor",
                { afterRuntimeId: request.afterRuntimeId, state: current.state },
              );
            }
            this.assertGameLaunchTerminalPredecessorProofLocked(chain);
            this.assertInitialGamePreparationHeadroom(
              this.storageRoot,
              request.launchInput,
              evidence,
            );
            const successor = this.reserveGameLaunchAttempt(
              profileKey,
              profileKeyDigest,
              request.launchInput.profilePath,
              canonicalFingerprint,
              current.runtimeId,
              current.compositeAttemptId,
              current.generation + 1,
              {
                compositeAttemptId: current.compositeAttemptId,
                runtimeId: current.runtimeId,
                canonicalFingerprint: current.canonicalFingerprint,
                generation: current.generation,
                completedAt: current.terminal.completedAt,
                proofDigest: current.terminal.proofDigest,
              },
            );
            this.writeGameLaunchChain(successor, false);
            chain = successor;
            reserved = true;
          }
        }

        if (!reserved) {
          let current = chain.current;
          if (current.managerInstanceId !== this.managerInstanceId) {
            throw new OwnedRuntimeError(
              ["reserved", "revocation_pending", "aborted"].includes(current.state)
                ? "RECOVERY_REQUIRED"
                : "PREPARED_LAUNCH_STALE",
              "Matching game-launch attempt belongs to another MCP lifecycle",
            );
          }

          if (current.state === "revocation_pending") {
            chain = await this.completeGameLaunchPreparationRevocationLocked(
              chain,
              request.revokeSession,
              fence,
            );
            current = chain.current;
          }

          if (current.state === "aborted") {
            this.assertGameLaunchPreparationAbortLocked(chain);
            if (current.predecessorRuntimeId !== null) {
              this.assertGameLaunchPreviousTipProofLocked(chain);
            }
            this.assertInitialGamePreparationHeadroom(
              this.storageRoot,
              request.launchInput,
              evidence,
            );
            chain = this.reserveGameLaunchAttempt(
              chain.profileKey,
              chain.profileKeyDigest,
              chain.profilePath,
              current.canonicalFingerprint,
              current.predecessorRuntimeId,
              current.predecessorCompositeAttemptId,
              current.generation,
              chain.previous,
            );
            this.writeGameLaunchChain(chain, false);
            reserved = true;
          } else if (current.state === "reserved") {
            // A failed or lost prepare response leaves the durable attempt key
            // authoritative. Re-enter the private child with that exact key so
            // it can replay an already-created session or safely create one.
            this.assertInitialGamePreparationHeadroom(
              this.storageRoot,
              request.launchInput,
              evidence,
            );
            reserved = true;
          } else if (!current.preparedLaunchId) {
            throw new OwnedRuntimeError(
              "RECOVERY_REQUIRED",
              "The current game-launch reservation has no recoverable prepared descriptor",
              { compositeAttemptId: current.compositeAttemptId, state: current.state },
            );
          } else {
            const existing = this.readPreparedDescriptor(current.preparedLaunchId);
            this.assertDescriptorMatchesGameLaunchAttempt(existing, chain);
            const invalidation = this.readOptionalPreparedInvalidation(
              existing.preparedLaunchId,
              existing,
            );
            if (invalidation) {
              throw new OwnedRuntimeError(
                "PREPARED_LAUNCH_INVALIDATED",
                "The retained game-launch attempt was invalidated and cannot be reused",
                { preparedLaunchId: existing.preparedLaunchId, sessionId: existing.sessionId },
              );
            }
            this.assertGameLaunchRetryRecoverable(existing, chain);
            return this.publicPreparedGameLaunch(existing, chain);
          }
        }

        const attempt = chain.current;
        const scopedEvidenceFields: Omit<OwnedGameLaunchPreparationEvidence, "gameLaunchEvidenceDigest"> = {
          ...evidence,
          prepareKey: attempt.prepareKey,
        };
        const scopedEvidence: OwnedGameLaunchPreparationEvidence = {
          ...scopedEvidenceFields,
          gameLaunchEvidenceDigest: computeOwnedGameLaunchEvidenceDigest(scopedEvidenceFields),
        };
        const attemptLaunchInput: ObserverLaunchInput = {
          ...request.launchInput,
          idempotencyKey: attempt.prepareKey,
        };
        let prepared: ObserverPreparedLaunch | null = null;
        try {
          prepared = await request.prepare(attemptLaunchInput);
          fence.assertActive();
          const preparedLaunchId = this.recordPreparedLaunchLocked(
            { ...attemptLaunchInput, idempotencyKey: attempt.recordKey },
            prepared,
            scopedEvidence,
            this.gameLaunchAttemptLink(chain),
          );
          chain = this.transitionGameLaunchAttempt(chain, {
            state: "prepared",
            preparedLaunchId,
            sessionId: prepared.sessionId,
          });
          this.writeGameLaunchChain(chain, false);
          return this.publicPreparedGameLaunch(
            this.readPreparedDescriptor(preparedLaunchId),
            chain,
          );
        } catch (error) {
          if (prepared) {
            // Lease loss releases the native mutex before this async callback
            // can settle. Do not inspect shared state or revoke a session after
            // mutation authority has been fenced away; another MCP may already
            // be recovering the same private-child preparation.
            fence.assertActive();
            let descriptorAbsent = false;
            try {
              const index = this.readOptionalPreparedSessionIndex(prepared.sessionId);
              descriptorAbsent = !index &&
                this.findPreparedDescriptorForSession(prepared.sessionId) === null;
            } catch {
              throw new OwnedRuntimeError(
                "RECOVERY_REQUIRED",
                "Game-launch descriptor state could not be proven after preparation failure",
              );
            }
            if (!descriptorAbsent) {
              throw new OwnedRuntimeError(
                "RECOVERY_REQUIRED",
                "Game-launch preparation may retain a durable descriptor and was not revoked",
              );
            }
            // Persist the external-cleanup obligation before revocation. A
            // crash after the observer commits revocation must never turn the
            // same attempt key back into permission to publish its cached,
            // now-revoked prepared response.
            chain = this.transitionGameLaunchAttempt(chain, {
              state: "revocation_pending",
              sessionId: prepared.sessionId,
            });
            this.writeGameLaunchChain(chain, false);
            chain = await this.completeGameLaunchPreparationRevocationLocked(
              chain,
              request.revokeSession,
              fence,
            );
          }
          throw error;
        }
      });
    } catch (error) {
      throw this.normalizeError(
        error,
        "PREPARE_FAILED",
        "Owned game launch could not be prepared",
      );
    }
  }

  private recordPreparedLaunchLocked(
    input: ObserverLaunchInput,
    prepared: ObserverPreparedLaunch,
    gameLaunchEvidence?: OwnedGameLaunchPreparationEvidence,
    gameLaunchAttempt?: GameLaunchAttemptLink,
  ): string {
    const root = this.ensureStorage();
    const descriptorFingerprint = this.preparedFingerprint({
      sessionId: prepared.sessionId,
      arguments: prepared.arguments,
      profilePath: prepared.profilePath,
      runtimeKind: input.runtimeKind,
      expiresAt: prepared.expiresAt,
      bundleDigest: prepared.bundleDigest,
      ...(gameLaunchEvidence ? { gameLaunchEvidence } : {}),
      ...(gameLaunchAttempt ? { gameLaunchAttempt } : {}),
    });
    const existingIndex = this.readOptionalPreparedSessionIndex(prepared.sessionId);
    if (existingIndex) {
      if (existingIndex.descriptorFingerprint !== descriptorFingerprint) {
        throw new OwnedRuntimeError(
          "ARGUMENT_CONFLICT",
          "Observer session was reused with a different prepared launch",
        );
      }
      const existing = this.readPreparedDescriptor(existingIndex.preparedLaunchId);
      if (existing.sessionId !== prepared.sessionId ||
          existingIndex.expiresAt !== existing.expiresAt ||
          this.preparedFingerprint(existing) !== descriptorFingerprint) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Prepared-launch session index does not match its descriptor",
        );
      }
      return existing.preparedLaunchId;
    }

    const preparedLaunchId = `pl-${this.createId()}`;
    const recordedAt = nowIso(this.clock);
    const descriptor = preparedDescriptorSchema.parse({
      version: STORAGE_VERSION,
      preparedLaunchId,
      sessionId: prepared.sessionId,
      arguments: [...prepared.arguments],
      profilePath: prepared.profilePath,
      runtimeKind: input.runtimeKind,
      expiresAt: prepared.expiresAt,
      bundleDigest: prepared.bundleDigest,
      recordedAt,
      managerInstanceId: this.managerInstanceId,
      ...(input.idempotencyKey
        ? { prepareIdempotencyHash: sha256(boundedIdempotencyKey(input.idempotencyKey)) }
        : {}),
      ...(gameLaunchEvidence ? { gameLaunchEvidence } : {}),
      ...(gameLaunchAttempt ? { gameLaunchAttempt } : {}),
    });
    this.assertPreparedDescriptorCapacity(descriptor);
    const index = preparedSessionIndexSchema.parse({
      version: STORAGE_VERSION,
      sessionId: prepared.sessionId,
      preparedLaunchId,
      descriptorFingerprint,
      expiresAt: prepared.expiresAt,
      updatedAt: recordedAt,
    });
    this.assertBatchCapacity(root, [
      { target: this.preparedPath(preparedLaunchId), value: descriptor, exclusive: true },
      { target: this.preparedSessionIndexPath(prepared.sessionId), value: index, exclusive: true },
    ]);
    this.atomicWrite(root, this.preparedPath(preparedLaunchId), descriptor, true, true);
    try {
      this.atomicWrite(root, this.preparedSessionIndexPath(prepared.sessionId), index, true, true);
    } catch (error) {
      this.unlinkOwnedFile(this.preparedPath(preparedLaunchId));
      throw error;
    }
    return preparedLaunchId;
  }

  private findPreparedGameLaunchForProfile(
    profilePath: string,
    prepareKey: string | null,
  ): PreparedDescriptor | null {
    let match: PreparedDescriptor | null = null;
    for (const name of this.recordFileNames("prepared")) {
      const preparedLaunchId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!preparedLaunchIdSchema.safeParse(preparedLaunchId).success) continue;
      const descriptor = this.readPreparedDescriptor(preparedLaunchId);
      if (pathKey(descriptor.profilePath) !== pathKey(profilePath)) continue;
      if (!descriptor.gameLaunchEvidence) continue;
      if (prepareKey !== null && descriptor.gameLaunchEvidence.prepareKey !== prepareKey) {
        throw new OwnedRuntimeError(
          "ARGUMENT_CONFLICT",
          "The derived project profile already retains a different baseline launch family",
        );
      }
      if (match) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "More than one retained preparation claims the same game-launch profile",
        );
      }
      match = descriptor;
    }
    return match;
  }

  /** Bounded proof used only before revoking a preparation that failed to record. */
  private findPreparedDescriptorForSession(sessionId: string): PreparedDescriptor | null {
    let match: PreparedDescriptor | null = null;
    for (const name of this.recordFileNames("prepared")) {
      const preparedLaunchId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!preparedLaunchIdSchema.safeParse(preparedLaunchId).success) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Prepared-launch storage contains a noncanonical descriptor identity",
        );
      }
      const descriptor = this.readPreparedDescriptor(preparedLaunchId);
      if (descriptor.sessionId !== sessionId) continue;
      if (match) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "More than one prepared descriptor claims the failed session",
        );
      }
      match = descriptor;
    }
    return match;
  }

  private publicPreparedDescriptor(descriptor: PreparedDescriptor): ObserverPreparedLaunch {
    return {
      arguments: [...descriptor.arguments],
      preparedLaunchId: descriptor.preparedLaunchId,
      sessionId: descriptor.sessionId,
      expiresAt: descriptor.expiresAt,
      bundleDigest: descriptor.bundleDigest,
      profilePath: descriptor.profilePath,
      warnings: [],
    };
  }

  private publicPreparedGameLaunch(
    descriptor: PreparedDescriptor,
    chain: GameLaunchChain,
  ): PreparedOwnedGameLaunch {
    this.assertDescriptorMatchesGameLaunchAttempt(descriptor, chain);
    return {
      ...this.publicPreparedDescriptor(descriptor),
      preparedLaunchId: descriptor.preparedLaunchId,
      compositeAttemptId: chain.current.compositeAttemptId,
      canonicalFingerprint: chain.current.canonicalFingerprint,
      chain: this.publicGameLaunchChain(chain),
    };
  }

  private assertGameLaunchRetryRecoverable(
    descriptor: PreparedDescriptor,
    chain: GameLaunchChain,
  ): void {
    if (Date.parse(descriptor.expiresAt) <= this.clock() && chain.current.state === "prepared") {
      throw new OwnedRuntimeError(
        "PREPARED_LAUNCH_EXPIRED",
        "The retained game-launch preparation expired before it was consumed and remains pinned for recovery",
      );
    }
    const consumption = this.readOptionalConsumption(descriptor.preparedLaunchId);
    const references = this.preparedRuntimeReferences();
    if (!consumption) {
      if (references.has(descriptor.preparedLaunchId)) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Retained game-launch runtime evidence has no matching consumption authority",
        );
      }
      return;
    }
    const runtime = this.readOptionalRuntimeReceipt(consumption.runtimeId);
    const pending = this.readOptionalPendingStart(consumption.runtimeId);
    if (runtime && runtime.preparedLaunchId !== descriptor.preparedLaunchId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Retained game-launch runtime evidence points at another preparation",
      );
    }
    if (pending && pending.preparedLaunchId !== descriptor.preparedLaunchId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Retained game-launch pending evidence points at another preparation",
      );
    }
    if (runtime && chain.current.runtimeId !== runtime.runtimeId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Retained game-launch runtime does not match the current profile attempt",
      );
    }
    if (pending && ["cleanup_verified", "release_required", "release_acknowledged"].includes(pending.state)) {
      throw new OwnedRuntimeError(
        "START_UNVERIFIABLE",
        "The retained baseline game-launch start terminated without a reusable runtime",
        { runtimeId: pending.runtimeId, state: pending.state },
      );
    }
    if (!runtime && !pending) {
      throw new OwnedRuntimeError(
        "START_UNVERIFIABLE",
        "The retained baseline game-launch preparation was consumed without recoverable runtime evidence",
        { runtimeId: consumption.runtimeId },
      );
    }
  }

  private reserveGameLaunchAttempt(
    profileKey: string,
    profileKeyDigest: string,
    profilePath: string,
    canonicalFingerprint: string,
    predecessorRuntimeId: string | null,
    predecessorCompositeAttemptId: string | null,
    generation: number,
    previous: z.infer<typeof gameLaunchPreviousTipSchema> | null = null,
  ): GameLaunchChain {
    const compositeAttemptId = `${OWNED_GAME_LAUNCH_ATTEMPT_ID_PREFIX}${this.createId()}`;
    const identity = { delivery: "owned" as const, compositeAttemptId, canonicalFingerprint };
    const timestamp = nowIso(this.clock);
    const current = gameLaunchAttemptSchema.parse({
      schemaVersion: 1,
      delivery: "owned",
      compositeAttemptId,
      canonicalFingerprint,
      generation,
      predecessorRuntimeId,
      predecessorCompositeAttemptId,
      managerInstanceId: this.managerInstanceId,
      state: "reserved",
      prepareKey: deriveOwnedGameLaunchAttemptKey("prepare", identity),
      recordKey: deriveOwnedGameLaunchAttemptKey("record", identity),
      startKey: deriveOwnedGameLaunchAttemptKey("start", identity),
      preparedLaunchId: null,
      sessionId: null,
      runtimeId: null,
      preparationAbort: null,
      terminal: null,
      reservedAt: timestamp,
      updatedAt: timestamp,
    });
    const chain = gameLaunchChainSchema.parse({
      schemaVersion: 1,
      delivery: "owned",
      profileKey,
      profileKeyDigest,
      profilePath,
      current,
      previous,
      updatedAt: timestamp,
    });
    this.assertGameLaunchChain(chain);
    return chain;
  }

  private gameLaunchAttemptLink(chain: GameLaunchChain): GameLaunchAttemptLink {
    const value = gameLaunchAttemptLinkSchema.parse({
      schemaVersion: 1,
      delivery: "owned",
      compositeAttemptId: chain.current.compositeAttemptId,
      canonicalFingerprint: chain.current.canonicalFingerprint,
      profileKeyDigest: chain.profileKeyDigest,
      generation: chain.current.generation,
      predecessorRuntimeId: chain.current.predecessorRuntimeId,
      predecessorCompositeAttemptId: chain.current.predecessorCompositeAttemptId,
      prepareKey: chain.current.prepareKey,
      recordKey: chain.current.recordKey,
      startKey: chain.current.startKey,
    });
    return value;
  }

  private transitionGameLaunchAttempt(
    chain: GameLaunchChain,
    patch: Partial<Pick<GameLaunchAttempt,
      | "state"
      | "preparedLaunchId"
      | "sessionId"
      | "runtimeId"
      | "preparationAbort"
      | "terminal"
    >>,
  ): GameLaunchChain {
    const updatedAt = nowIso(this.clock);
    const next = gameLaunchChainSchema.parse({
      ...chain,
      current: {
        ...chain.current,
        ...patch,
        updatedAt,
      },
      updatedAt,
    });
    this.assertGameLaunchChain(next);
    return next;
  }

  private assertGameLaunchPreparationHasNoDescriptorLocked(chain: GameLaunchChain): void {
    const attempt = chain.current;
    if (!attempt.sessionId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch preparation cleanup has no observer session identity",
      );
    }
    const indexed = this.readOptionalPreparedSessionIndex(attempt.sessionId);
    const bySession = this.findPreparedDescriptorForSession(attempt.sessionId);
    const byAttempt = this.findPreparedGameLaunchAttemptDescriptors(attempt.compositeAttemptId);
    if (indexed || bySession || byAttempt.length > 0) {
      throw new OwnedRuntimeError(
        "RECOVERY_REQUIRED",
        "Game-launch preparation cleanup cannot proceed while durable descriptor evidence remains",
        { compositeAttemptId: attempt.compositeAttemptId, sessionId: attempt.sessionId },
      );
    }
  }

  private async completeGameLaunchPreparationRevocationLocked(
    chain: GameLaunchChain,
    revokeSession: (sessionId: string) => Promise<unknown>,
    fence: OwnedRuntimeLeaseFence,
  ): Promise<GameLaunchChain> {
    this.assertGameLaunchChain(chain);
    const attempt = chain.current;
    if (attempt.state !== "revocation_pending" ||
        attempt.managerInstanceId !== this.managerInstanceId ||
        !attempt.sessionId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch preparation revocation does not match the active MCP lifecycle",
      );
    }
    this.assertGameLaunchPreparationHasNoDescriptorLocked(chain);

    let response: unknown;
    try {
      response = await revokeSession(attempt.sessionId);
    } catch {
      throw new OwnedRuntimeError(
        "RECOVERY_REQUIRED",
        "Game-launch preparation was not recorded, and session revocation could not be confirmed",
        { compositeAttemptId: attempt.compositeAttemptId, sessionId: attempt.sessionId },
      );
    }
    fence.assertActive();
    if (!z.object({ revoked: z.literal(true) }).passthrough().safeParse(response).success) {
      throw new OwnedRuntimeError(
        "RECOVERY_REQUIRED",
        "Observer did not prove that the unrecorded game-launch session was revoked",
        { compositeAttemptId: attempt.compositeAttemptId, sessionId: attempt.sessionId },
      );
    }

    const aborted = this.transitionGameLaunchAttempt(chain, {
      state: "aborted",
      preparationAbort: {
        sessionId: attempt.sessionId,
        revokedAt: nowIso(this.clock),
        sessionRevoked: true,
      },
    });
    this.writeGameLaunchChain(aborted, false);
    return aborted;
  }

  private assertGameLaunchPreparationAbortLocked(chain: GameLaunchChain): void {
    this.assertGameLaunchChain(chain);
    const attempt = chain.current;
    if (attempt.state !== "aborted" || !attempt.sessionId ||
        !attempt.preparationAbort || attempt.preparationAbort.sessionId !== attempt.sessionId ||
        attempt.preparationAbort.sessionRevoked !== true) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch preparation abort has no exact revoked-session proof",
      );
    }
    this.assertGameLaunchPreparationHasNoDescriptorLocked(chain);
  }

  private assertGameLaunchChain(chain: GameLaunchChain): void {
    if (sha256(chain.profileKey) !== chain.profileKeyDigest ||
        pathKey(chain.profilePath) !== chain.profileKey) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch profile chain does not match its canonical profile identity",
      );
    }
    const attempt = chain.current;
    const identity = {
      delivery: "owned" as const,
      compositeAttemptId: attempt.compositeAttemptId,
      canonicalFingerprint: attempt.canonicalFingerprint,
    };
    if (attempt.prepareKey !== deriveOwnedGameLaunchAttemptKey("prepare", identity) ||
        attempt.recordKey !== deriveOwnedGameLaunchAttemptKey("record", identity) ||
        attempt.startKey !== deriveOwnedGameLaunchAttemptKey("start", identity)) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch attempt keys do not match their fenced identity",
      );
    }
    const hasPredecessor = attempt.predecessorRuntimeId !== null ||
      attempt.predecessorCompositeAttemptId !== null;
    if ((attempt.predecessorRuntimeId === null) !==
          (attempt.predecessorCompositeAttemptId === null) ||
        (attempt.generation === 1) === hasPredecessor) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch attempt predecessor linkage is invalid",
      );
    }
    const hasPreparedDescriptor = attempt.preparedLaunchId !== null;
    const hasSession = attempt.sessionId !== null;
    const hasPrepared = hasPreparedDescriptor && hasSession;
    const hasRuntime = attempt.runtimeId !== null;
    const hasPreparationAbort = attempt.preparationAbort !== null &&
      attempt.preparationAbort !== undefined;
    const hasTerminal = attempt.terminal !== null;
    const validState = attempt.state === "reserved"
      ? !hasPreparedDescriptor && !hasSession && !hasRuntime && !hasPreparationAbort && !hasTerminal
      : attempt.state === "revocation_pending"
        ? !hasPreparedDescriptor && hasSession && !hasRuntime && !hasPreparationAbort && !hasTerminal
        : attempt.state === "aborted"
          ? !hasPreparedDescriptor && hasSession && !hasRuntime && hasPreparationAbort && !hasTerminal &&
            attempt.preparationAbort!.sessionId === attempt.sessionId &&
            attempt.preparationAbort!.sessionRevoked === true
          : attempt.state === "prepared"
            ? hasPrepared && !hasRuntime && !hasPreparationAbort && !hasTerminal
            : attempt.state === "starting" || attempt.state === "running"
              ? hasPrepared && hasRuntime && !hasPreparationAbort && !hasTerminal
              : hasPrepared && hasRuntime && !hasPreparationAbort && hasTerminal &&
                attempt.terminal!.runtimeId === attempt.runtimeId;
    if (!validState) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch attempt fields do not match its durable state",
      );
    }
    if (attempt.generation === 1) {
      if (chain.previous !== null) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Initial game-launch attempt has a predecessor tip");
      }
    } else if (!chain.previous ||
        chain.previous.compositeAttemptId !== attempt.predecessorCompositeAttemptId ||
        chain.previous.runtimeId !== attempt.predecessorRuntimeId ||
        chain.previous.generation + 1 !== attempt.generation) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Successor game-launch attempt does not match its retained predecessor tip",
      );
    }
  }

  private readOptionalGameLaunchChain(
    profileKey: string,
    profileKeyDigest = sha256(profileKey),
  ): GameLaunchChain | null {
    const chain = this.readOptionalParsed(
      this.gameLaunchChainPath(profileKeyDigest),
      gameLaunchChainSchema,
      "game-launch profile chain",
    );
    if (!chain) return null;
    if (chain.profileKey !== profileKey || chain.profileKeyDigest !== profileKeyDigest) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch profile chain does not match its record key",
      );
    }
    this.assertGameLaunchChain(chain);
    return chain;
  }

  private writeGameLaunchChain(chain: GameLaunchChain, exclusive: boolean): void {
    this.assertGameLaunchChain(chain);
    this.atomicWrite(
      this.ensureStorage(),
      this.gameLaunchChainPath(chain.profileKeyDigest),
      chain,
      exclusive,
    );
  }

  private findPreparedGameLaunchAttemptDescriptors(
    compositeAttemptId: string,
  ): PreparedDescriptor[] {
    const matches: PreparedDescriptor[] = [];
    for (const name of this.recordFileNames("prepared")) {
      const preparedLaunchId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!preparedLaunchIdSchema.safeParse(preparedLaunchId).success) continue;
      const descriptor = this.readPreparedDescriptor(preparedLaunchId);
      if (descriptor.gameLaunchAttempt?.compositeAttemptId === compositeAttemptId) {
        matches.push(descriptor);
      }
    }
    if (matches.length > 1) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "More than one prepared descriptor claims the same game-launch attempt",
      );
    }
    return matches;
  }

  private assertDescriptorMatchesGameLaunchAttempt(
    descriptor: PreparedDescriptor,
    chain: GameLaunchChain,
  ): void {
    const link = descriptor.gameLaunchAttempt;
    const evidence = descriptor.gameLaunchEvidence;
    const expected = this.gameLaunchAttemptLink(chain);
    if (!link || !evidence || JSON.stringify(link) !== JSON.stringify(expected) ||
        evidence.prepareKey !== chain.current.prepareKey ||
        pathKey(descriptor.profilePath) !== chain.profileKey ||
        descriptor.prepareIdempotencyHash !== sha256(chain.current.recordKey)) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Prepared descriptor does not match its game-launch attempt ledger",
      );
    }
  }

  private reconcileGameLaunchChainLocked(chain: GameLaunchChain): GameLaunchChain {
    this.assertGameLaunchChain(chain);
    let current = chain;
    for (;;) {
      const attempt = current.current;
      if (attempt.state === "reserved") {
        const descriptor = this.findPreparedGameLaunchAttemptDescriptors(attempt.compositeAttemptId)[0];
        if (!descriptor) return current;
        this.assertDescriptorMatchesGameLaunchAttempt(descriptor, current);
        current = this.transitionGameLaunchAttempt(current, {
          state: "prepared",
          preparedLaunchId: descriptor.preparedLaunchId,
          sessionId: descriptor.sessionId,
        });
        this.writeGameLaunchChain(current, false);
        continue;
      }
      if (!attempt.preparedLaunchId) return current;
      const descriptor = this.readPreparedDescriptor(attempt.preparedLaunchId);
      this.assertDescriptorMatchesGameLaunchAttempt(descriptor, current);
      if (attempt.state === "prepared") {
        const consumption = this.readOptionalConsumption(descriptor.preparedLaunchId);
        if (!consumption) return current;
        current = this.transitionGameLaunchAttempt(current, {
          state: "starting",
          runtimeId: consumption.runtimeId,
        });
        this.writeGameLaunchChain(current, false);
        continue;
      }
      if (attempt.state === "starting") {
        if (!attempt.runtimeId) return current;
        const runtime = this.readOptionalRuntimeReceipt(attempt.runtimeId);
        if (!runtime) return current;
        if (runtime.preparedLaunchId !== descriptor.preparedLaunchId) {
          throw new OwnedRuntimeError(
            "STORAGE_UNVERIFIABLE",
            "Game-launch starting attempt points at another runtime receipt",
          );
        }
        current = this.transitionGameLaunchAttempt(current, { state: "running" });
        this.writeGameLaunchChain(current, false);
        continue;
      }
      if (attempt.state === "running") {
        if (!attempt.runtimeId) return current;
        const completion = this.readOptionalStopCompletion(attempt.runtimeId);
        if (!completion || completion.sessionRevoked !== true) return current;
        const runtime = this.readRuntimeReceipt(attempt.runtimeId);
        const stopped = this.readOptionalStopReceipt(attempt.runtimeId);
        if (!stopped || stopped.sessionId !== runtime.sessionId ||
            completion.sessionId !== runtime.sessionId ||
            completion.preparedLaunchId !== runtime.preparedLaunchId) {
          throw new OwnedRuntimeError(
            "STORAGE_UNVERIFIABLE",
            "Game-launch stop completion does not match its current chain tip",
          );
        }
        const restoration = this.readOptionalRestorationProof(attempt.runtimeId);
        const proofDigest = sha256(JSON.stringify({ runtime, stopped, completion, restoration }));
        current = this.transitionGameLaunchAttempt(current, {
          state: "terminal",
          terminal: {
            runtimeId: attempt.runtimeId,
            stoppedAt: stopped.stoppedAt,
            completedAt: completion.completedAt,
            restorationProvedAt: stopped.restorationProvedAt,
            sessionRevoked: true,
            proofDigest,
          },
        });
        this.writeGameLaunchChain(current, false);
        continue;
      }
      return current;
    }
  }

  /**
   * Re-attest the complete terminal lifecycle before it can authorize another
   * process generation. The chain is an index, not standalone stop authority:
   * losing or contradicting any exact stop/restoration/revocation record must
   * pin the profile for recovery instead of turning missing evidence into
   * successor permission.
   */
  private assertGameLaunchTerminalPredecessorProofLocked(chain: GameLaunchChain): void {
    this.assertGameLaunchChain(chain);
    const attempt = chain.current;
    if (attempt.state !== "terminal" || !attempt.terminal || !attempt.runtimeId ||
        !attempt.preparedLaunchId || !attempt.sessionId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch predecessor has no complete terminal chain authority",
      );
    }

    const runtime = this.readRuntimeReceipt(attempt.runtimeId);
    if (runtime.preparedLaunchId !== attempt.preparedLaunchId ||
        runtime.sessionId !== attempt.sessionId ||
        pathKey(runtime.profilePath) !== chain.profileKey) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch predecessor runtime does not match its terminal chain",
      );
    }
    const stopped = this.readOptionalStopReceipt(attempt.runtimeId);
    const completion = this.readOptionalStopCompletion(attempt.runtimeId);
    if (!stopped || !completion || completion.sessionRevoked !== true ||
        stopped.runtimeId !== runtime.runtimeId || stopped.sessionId !== runtime.sessionId ||
        stopped.mcpActor.installationId !== runtime.mcpOwner.installationId ||
        stopped.mcpActor.userSid !== runtime.mcpOwner.userSid ||
        completion.runtimeId !== runtime.runtimeId || completion.sessionId !== runtime.sessionId ||
        completion.preparedLaunchId !== runtime.preparedLaunchId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch predecessor stop or revoked-session completion is missing or cross-bound",
      );
    }

    const restoration = this.readOptionalRestorationProof(attempt.runtimeId);
    // An already-vacant exact identity can legitimately have its restoration
    // authority carried entirely by the exact-vacancy stop receipt. Every
    // reservation/seal-backed stop must retain and re-attest its linked proof.
    const receiptOnlyExactVacancy = stopped.restorationProofKind === "exact_runtime_vacancy" &&
      stopped.restorationReservationId === undefined;
    if (!restoration && !receiptOnlyExactVacancy) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch predecessor restoration proof is missing",
      );
    }
    if (restoration && (restoration.runtimeId !== runtime.runtimeId ||
        restoration.sessionId !== runtime.sessionId ||
        restoration.managerInstanceId !== runtime.mcpOwner.managerInstanceId ||
        restoration.kind !== stopped.restorationProofKind ||
        restoration.sealedAt !== stopped.restorationProvedAt ||
        restoration.reservationId !== stopped.restorationReservationId ||
        (restoration.stopIdempotencyHash !== undefined &&
          restoration.stopIdempotencyHash !== stopped.stopIdempotencyHash))) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch predecessor restoration proof does not match its exact stop",
      );
    }

    const terminal = attempt.terminal;
    const proofDigest = sha256(JSON.stringify({ runtime, stopped, completion, restoration }));
    if (terminal.runtimeId !== runtime.runtimeId || terminal.stoppedAt !== stopped.stoppedAt ||
        terminal.completedAt !== completion.completedAt ||
        terminal.restorationProvedAt !== stopped.restorationProvedAt ||
        terminal.sessionRevoked !== true || terminal.proofDigest !== proofDigest) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch predecessor terminal digest does not match retained lifecycle proof",
      );
    }
  }

  /** Re-attest the terminal tip retained behind a pre-runtime successor abort. */
  private assertGameLaunchPreviousTipProofLocked(chain: GameLaunchChain): void {
    this.assertGameLaunchChain(chain);
    const attempt = chain.current;
    const previous = chain.previous;
    if (!previous || attempt.predecessorRuntimeId !== previous.runtimeId ||
        attempt.predecessorCompositeAttemptId !== previous.compositeAttemptId ||
        attempt.generation !== previous.generation + 1) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Aborted game-launch successor has no exact predecessor tip",
      );
    }

    const runtime = this.readRuntimeReceipt(previous.runtimeId);
    if (pathKey(runtime.profilePath) !== chain.profileKey) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Aborted game-launch successor predecessor belongs to another profile",
      );
    }
    const descriptor = this.readPreparedDescriptor(runtime.preparedLaunchId);
    const link = descriptor.gameLaunchAttempt;
    if (!link || descriptor.sessionId !== runtime.sessionId ||
        link.compositeAttemptId !== previous.compositeAttemptId ||
        link.canonicalFingerprint !== previous.canonicalFingerprint ||
        link.generation !== previous.generation ||
        link.profileKeyDigest !== chain.profileKeyDigest) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Aborted game-launch successor predecessor descriptor is missing or cross-bound",
      );
    }

    const stopped = this.readOptionalStopReceipt(previous.runtimeId);
    const completion = this.readOptionalStopCompletion(previous.runtimeId);
    if (!stopped || !completion || completion.sessionRevoked !== true ||
        stopped.runtimeId !== runtime.runtimeId || stopped.sessionId !== runtime.sessionId ||
        stopped.mcpActor.installationId !== runtime.mcpOwner.installationId ||
        stopped.mcpActor.userSid !== runtime.mcpOwner.userSid ||
        completion.runtimeId !== runtime.runtimeId || completion.sessionId !== runtime.sessionId ||
        completion.preparedLaunchId !== runtime.preparedLaunchId ||
        completion.completedAt !== previous.completedAt) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Aborted game-launch successor predecessor stop proof is missing or cross-bound",
      );
    }

    const restoration = this.readOptionalRestorationProof(previous.runtimeId);
    const receiptOnlyExactVacancy = stopped.restorationProofKind === "exact_runtime_vacancy" &&
      stopped.restorationReservationId === undefined;
    if (!restoration && !receiptOnlyExactVacancy) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Aborted game-launch successor predecessor restoration proof is missing",
      );
    }
    if (restoration && (restoration.runtimeId !== runtime.runtimeId ||
        restoration.sessionId !== runtime.sessionId ||
        restoration.managerInstanceId !== runtime.mcpOwner.managerInstanceId ||
        restoration.kind !== stopped.restorationProofKind ||
        restoration.sealedAt !== stopped.restorationProvedAt ||
        restoration.reservationId !== stopped.restorationReservationId ||
        (restoration.stopIdempotencyHash !== undefined &&
          restoration.stopIdempotencyHash !== stopped.stopIdempotencyHash))) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Aborted game-launch successor predecessor restoration proof does not match its exact stop",
      );
    }

    const proofDigest = sha256(JSON.stringify({ runtime, stopped, completion, restoration }));
    if (previous.proofDigest !== proofDigest) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Aborted game-launch successor predecessor digest does not match retained lifecycle proof",
      );
    }
  }

  private requireGameLaunchChainForDescriptorLocked(
    descriptor: PreparedDescriptor,
    keyHash?: string,
  ): GameLaunchChain | null {
    if (!descriptor.gameLaunchAttempt) return null;
    const chain = this.readOptionalGameLaunchChain(pathKey(descriptor.profilePath));
    if (!chain) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Game-launch descriptor has no profile attempt ledger");
    }
    const reconciled = this.reconcileGameLaunchChainLocked(chain);
    this.assertDescriptorMatchesGameLaunchAttempt(descriptor, reconciled);
    if (keyHash !== undefined && sha256(reconciled.current.startKey) !== keyHash) {
      throw new OwnedRuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "Game-launch start key does not match the fenced composite attempt",
      );
    }
    return reconciled;
  }

  private reconcileGameLaunchChainForRuntimeLocked(receipt: OwnedRuntimeReceipt): GameLaunchChain | null {
    const descriptor = this.readPreparedDescriptor(receipt.preparedLaunchId);
    if (!descriptor.gameLaunchAttempt) return null;
    const chain = this.requireGameLaunchChainForDescriptorLocked(descriptor);
    if (!chain || chain.current.runtimeId !== receipt.runtimeId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Runtime receipt does not match the current game-launch attempt",
      );
    }
    return chain;
  }

  private publicGameLaunchChain(chain: GameLaunchChain): OwnedGameLaunchChainPublicState {
    const attempt = chain.current;
    return {
      schemaVersion: 1,
      delivery: "owned",
      compositeAttemptId: attempt.compositeAttemptId,
      generation: attempt.generation,
      state: attempt.state,
      predecessorRuntimeId: attempt.predecessorRuntimeId,
      ...(attempt.runtimeId ? { runtimeId: attempt.runtimeId } : {}),
      retry: { afterRuntimeId: attempt.predecessorRuntimeId },
      successor: attempt.state === "terminal" && attempt.runtimeId
        ? { eligible: true, afterRuntimeId: attempt.runtimeId }
        : {
            eligible: false,
            reason: attempt.state === "running" ? "exact_stop_required" : "recovery_required",
          },
    };
  }

  async start(input: OwnedRuntimeStartInput): Promise<OwnedRuntimePublicStatus> {
    return this.withAdmission("owned runtime start", () => this.startInternal(input));
  }

  private async startInternal(input: OwnedRuntimeStartInput): Promise<OwnedRuntimePublicStatus> {
    this.assertOpenForMutation();
    preparedLaunchIdSchema.parse(input.preparedLaunchId);
    const revalidationDeadlineAtMs = input.revalidationDeadlineAtMs ??
      Date.now() + OWNED_RUNTIME_START_REVALIDATION_DEADLINE_MS;
    if (!Number.isSafeInteger(revalidationDeadlineAtMs) || revalidationDeadlineAtMs <= 0) {
      throw new OwnedRuntimeError(
        "INVALID_REQUEST",
        "Owned runtime start revalidation deadline is invalid",
      );
    }
    const executableMaximumBytes = input.executableMaximumBytes ??
      OWNED_RUNTIME_EXECUTABLE_MAXIMUM_BYTES;
    if (!Number.isSafeInteger(executableMaximumBytes) || executableMaximumBytes < 1) {
      throw new OwnedRuntimeError(
        "INVALID_REQUEST",
        "Owned runtime start executable byte limit is invalid",
      );
    }
    const keyHash = sha256(boundedIdempotencyKey(input.idempotencyKey));
    const requestFingerprint = sha256(JSON.stringify({ preparedLaunchId: input.preparedLaunchId }));
    try {
      return await this.withFencedMachineMutex((fence) =>
        this.startLocked(
          input.preparedLaunchId,
          keyHash,
          requestFingerprint,
          fence,
          revalidationDeadlineAtMs,
          executableMaximumBytes,
        ));
    } catch (error) {
      const normalized = this.normalizeError(error, "START_FAILED", "Owned runtime start failed");
      // A failed start may have durably proved exact child vacancy while
      // leaving observer lifecycle release outstanding. Retry that IPC after
      // the start transaction has relinquished the machine mutex. Preserve
      // the primary start outcome; `release_required` remains the durable
      // authority if this best-effort attempt also fails. Lease loss is the
      // exception: no new mutex transaction or lifecycle mutation is allowed
      // after authority has been revoked.
      if (normalized.code !== "RECOVERY_REQUIRED") {
        await this.retryPendingStartLifecycleReleaseForKey(keyHash).catch(() => undefined);
      }
      throw normalized;
    }
  }

  async status(runtimeId: string): Promise<OwnedRuntimePublicStatus> {
    return this.withAdmission("owned runtime status", () => this.statusInternal(runtimeId));
  }

  private async statusInternal(runtimeId: string): Promise<OwnedRuntimePublicStatus> {
    runtimeIdSchema.parse(runtimeId);
    try {
      const receipt = this.readRuntimeReceipt(runtimeId);
      if (this.runtimeLifecycleIsTerminal(runtimeId)) {
        await this.releaseRuntimeLifecycle(receipt);
        return await this.inspectReceipt(receipt);
      }
      await this.reconcileRuntimeLifecycleLease(receipt);
      const status = await this.inspectReceipt(receipt);
      if (status.state === "exited" && !this.readOptionalStopReceipt(runtimeId)) {
        const reconciled = await this.persistObservedNaturalExit(receipt);
        if (reconciled) await this.releaseRuntimeLifecycle(receipt);
      }
      return status;
    } catch (error) {
      if (error instanceof OwnedRuntimeError && error.code === "RUNTIME_NOT_FOUND") throw error;
      return {
        runtimeId,
        sessionId: "unknown",
        preparedLaunchId: "pl-00000000-0000-0000-0000-000000000000",
        state: "unverifiable",
        pid: 0,
        runtimeKind: "client",
        startedAt: new Date(0).toISOString(),
        exactOwned: false,
        reason: error instanceof Error ? error.message : "Lifecycle receipt is unverifiable",
      };
    }
  }

  /** Return the exact durable lifecycle identity for a currently owned runtime. */
  async lifecycleIdentity(runtimeId: string): Promise<OwnedRuntimeLifecycleIdentity> {
    return this.withAdmission("owned runtime lifecycle identity", () =>
      this.lifecycleIdentityInternal(runtimeId));
  }

  private async lifecycleIdentityInternal(runtimeId: string): Promise<OwnedRuntimeLifecycleIdentity> {
    runtimeIdSchema.parse(runtimeId);
    const receipt = this.readRuntimeReceipt(runtimeId);
    await this.reconcileRuntimeLifecycleLease(receipt);
    const status = await this.inspectReceipt(receipt);
    if (status.state !== "running" || status.exactOwned !== true) {
      throw new OwnedRuntimeError("LIFECYCLE_UNAVAILABLE", "Owned runtime lifecycle is not currently running and exact-owned");
    }
    return Object.freeze({
      runtimeId: receipt.runtimeId,
      generation: runtimeLifecycleGeneration(receipt),
    });
  }

  /** Bounded diagnostic used by lifecycle reconciliation tests and health output. */
  diagnosticSupervisedChildCount(): number {
    return this.children.counts().active;
  }

  /** Count-only lifecycle evidence; no PID, owner token, or process handle is exposed. */
  diagnosticSupervisedChildCounts(): SupervisedChildCounts {
    return this.children.counts();
  }

  currentIdleRevision(): number {
    return this.idleRevision;
  }

  /** Read-only, bounded classification of the complete retained lifecycle namespace. */
  async inspectRuntimeHistory(
    options: OwnedRuntimeHistoryInspectionOptions = {},
  ): Promise<OwnedRuntimeHistoryInventory> {
    const normalized = this.normalizeRuntimeHistoryOptions(options);
    return this.withAdmission(
      "owned runtime history inspection",
      () => this.inspectRuntimeHistoryInternal(normalized),
    );
  }

  /**
   * Explicitly complete semantic stop cleanup for exact process-vacant history.
   * This actor has no deletion path and cannot select a lifecycle lacking a
   * child-exit or exact stop receipt.
   */
  async recoverRuntimeHistory(
    options: OwnedRuntimeHistoryInspectionOptions = {},
  ): Promise<OwnedRuntimeHistoryRecoveryResult> {
    const normalized = this.normalizeRuntimeHistoryOptions(options);
    return this.withAdmission("owned runtime history recovery", async () => {
      this.assertOpenForMutation();
      const before = await this.inspectRuntimeHistoryInternal(normalized);
      const attemptedRuntimeIds: string[] = [];
      const recoveredRuntimeIds: string[] = [];
      const blocked: OwnedRuntimeHistoryRecoveryBlock[] = [];
      let mutationStoreReady = true;

      if (!before.complete) {
        blocked.push({
          runtimeId: "inventory",
          code: "INCOMPLETE_PROOF",
          reason: "The complete owned-runtime lifecycle namespace was not verified; recovery made no changes.",
        });
      } else {
        const firstRuntimeId = before.recoverableRuntimeIds[0];
        if (firstRuntimeId) {
          try {
            await this.prepareRuntimeHistoryMutationStore(firstRuntimeId);
          } catch (error) {
            mutationStoreReady = false;
            const normalizedError = this.normalizeError(
              error,
              "RECOVERY_REQUIRED",
              "Owned runtime history storage could not enter recovery mode",
            );
            blocked.push({
              runtimeId: "inventory",
              code: normalizedError.code.slice(0, 64),
              reason: this.message(normalizedError).slice(0, 512),
            });
          }
        }
      }

      if (before.complete && mutationStoreReady) {
        for (const runtimeId of before.recoverableRuntimeIds) {
          if (normalized.signal.aborted || Date.now() >= normalized.deadlineAtMs) break;
          attemptedRuntimeIds.push(runtimeId);
          try {
            await this.preflightRuntimeHistoryCandidate(runtimeId, normalized.deadlineAtMs);
            const status = await this.stopInternal({
              runtimeId,
              waitForRestorationMs: 0,
              idempotencyKey: `mcp-runtime-history-recovery-v1-${sha256(runtimeId)}`,
              signal: normalized.signal,
              deadlineAtMs: normalized.deadlineAtMs,
              skipRetentionSweep: true,
            });
            if (status.terminationComplete !== true || status.observerCleanupPending === true) {
              throw new OwnedRuntimeError(
                "RECOVERY_REQUIRED",
                "Runtime history did not reach durable observer stop completion",
              );
            }
            recoveredRuntimeIds.push(runtimeId);
          } catch (error) {
            const normalizedError = this.normalizeError(
              error,
              "RECOVERY_REQUIRED",
              "Owned runtime history recovery failed",
            );
            blocked.push({
              runtimeId,
              code: normalizedError.code.slice(0, 64),
              reason: this.message(normalizedError).slice(0, 512),
            });
          }
        }
      }

      let after: OwnedRuntimeHistoryInventory | null = null;
      if (!normalized.signal.aborted && Date.now() < normalized.deadlineAtMs) {
        try {
          after = await this.inspectRuntimeHistoryInternal(normalized);
        } catch {
          // The aggregate batch deadline is authoritative. Durable per-runtime
          // results remain retryable even when the final read-only view cannot
          // be completed inside that same budget.
        }
      }
      return {
        schemaVersion: 1,
        before,
        attemptedRuntimeIds,
        recoveredRuntimeIds,
        blocked,
        after,
        deadlineExceeded: normalized.signal.aborted || Date.now() >= normalized.deadlineAtMs,
      };
    });
  }

  private async preflightRuntimeHistoryCandidate(
    runtimeId: string,
    deadlineAtMs: number,
  ): Promise<void> {
    const wallDeadline: OwnedRuntimeWallDeadline = {
      expiresAtMs: deadlineAtMs,
      code: "RECOVERY_REQUIRED",
      message: "Owned runtime history recovery preflight exceeded its aggregate deadline",
      details: { runtimeId, state: "history_recovery_preflight" },
    };
    await this.withFencedMachineMutex(async (fence) => {
      const receipt = this.readRuntimeReceipt(runtimeId);
      fence.assertActive();
      const stopped = this.readOptionalStopReceipt(runtimeId);
      const completion = this.readOptionalStopCompletion(runtimeId);
      if (stopped) {
        if (completion) {
          throw new OwnedRuntimeError("INVALID_REQUEST", "Runtime history is already complete");
        }
        if (stopped.sessionId !== receipt.sessionId ||
            stopped.mcpActor.installationId !== receipt.mcpOwner.installationId ||
            stopped.mcpActor.userSid !== receipt.mcpOwner.userSid) {
          throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Cleanup-pending stop evidence is cross-bound");
        }
        const authorityFailure = await this.inspectRecoveryAuthority(receipt, wallDeadline);
        fence.assertActive();
        if (authorityFailure) {
          throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", authorityFailure);
        }
        return;
      }
      if (!this.readOptionalChildExitReceipt(runtimeId)) {
        throw new OwnedRuntimeError(
          "INVALID_REQUEST",
          "Runtime history has no exact process-vacancy disposition eligible for recovery",
        );
      }
      const status = await this.inspectReceipt(receipt, wallDeadline);
      fence.assertActive();
      if (status.state !== "exited" || status.exactOwned !== true) {
        throw new OwnedRuntimeError(
          "IDENTITY_UNVERIFIABLE",
          `Child-exit-only history is not exact-vacant: ${status.reason ?? status.state}`,
        );
      }
    }, wallDeadline);
  }

  private normalizeRuntimeHistoryOptions(
    options: OwnedRuntimeHistoryInspectionOptions,
  ): NormalizedOwnedRuntimeHistoryOptions {
    const maxRuntimes = options.maxRuntimes ?? DEFAULT_HISTORY_MAX_RUNTIMES;
    const deadlineMs = options.deadlineMs ?? DEFAULT_HISTORY_DEADLINE_MS;
    if (!Number.isSafeInteger(maxRuntimes) || maxRuntimes < 1 ||
        maxRuntimes > MAX_HISTORY_MAX_RUNTIMES) {
      throw new OwnedRuntimeError(
        "INVALID_REQUEST",
        `maxRuntimes must be from 1 through ${MAX_HISTORY_MAX_RUNTIMES}`,
      );
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 ||
        deadlineMs > MAX_HISTORY_DEADLINE_MS) {
      throw new OwnedRuntimeError(
        "INVALID_REQUEST",
        `deadlineMs must be from 100 through ${MAX_HISTORY_DEADLINE_MS}`,
      );
    }
    return {
      maxRuntimes,
      deadlineAtMs: Date.now() + deadlineMs,
      signal: options.signal ?? new AbortController().signal,
    };
  }

  private async inspectRuntimeHistoryInternal(
    options: NormalizedOwnedRuntimeHistoryOptions,
  ): Promise<OwnedRuntimeHistoryInventory> {
    if (options.signal.aborted) {
      throw new OwnedRuntimeError("CANCELLED", "Owned runtime history inspection was cancelled");
    }
    const wallDeadline: OwnedRuntimeWallDeadline = {
      expiresAtMs: options.deadlineAtMs,
      code: "RECOVERY_REQUIRED",
      message: "Owned runtime history inspection exceeded its aggregate wall-clock deadline",
      details: { state: "history_inspection" },
    };
    return this.withFencedMachineMutex(async (fence) => {
      fence.assertActive();
      const readiness = await this.inspectIdleShutdownReadiness({
        signal: options.signal,
        deadlineTick: performance.now() + Math.max(0, options.deadlineAtMs - Date.now()),
        probeGeneration: this.idleRevision,
      });
      fence.assertActive();

      const existing = await this.snapshotExistingOwnedRuntimeRecords();
      fence.assertActive();
      if (existing.kind === "missing") {
        return this.emptyRuntimeHistoryInventory(readiness);
      }

      const snapshot = existing.value;
      const runtimes = new Map<string, OwnedRuntimeReceipt>();
      const exits = new Map<string, ChildExitReceipt>();
      const stops = new Map<string, StopReceipt>();
      const completions = new Map<string, StopCompletion>();
      const restorations = new Map<string, RestorationProof>();
      const invalidRuntimeIds = new Set<string>();
      const issues: OwnedRuntimeHistoryIssue[] = [];
      const noteIssue = (runtimeId: string, reason: string): void => {
        invalidRuntimeIds.add(runtimeId);
        if (issues.length < MAX_HISTORY_ISSUES) {
          issues.push({ runtimeId, reason: reason.slice(0, 512) });
        }
      };
      const decode = (bytes: Uint8Array | null): unknown => {
        if (!bytes || bytes.byteLength < LIFECYCLE_RECORD_MIN_BYTES ||
            bytes.byteLength > this.maxRecordBytes) {
          throw new Error("record bytes are outside the lifecycle bound");
        }
        return JSON.parse(Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, ""));
      };

      for (const record of snapshot.records) {
        if (!["runtimes", "child-exits", "stops", "stop-completions", "restoration-proofs"]
          .includes(record.family)) continue;
        try {
          const value = decode(record.bytes);
          switch (record.family) {
            case "runtimes": {
              const parsed = runtimeReceiptSchema.parse(value);
              if (parsed.runtimeId !== record.id) throw new Error("runtime filename binding differs");
              runtimes.set(record.id, parsed);
              break;
            }
            case "child-exits": {
              const parsed = childExitReceiptSchema.parse(value);
              if (parsed.runtimeId !== record.id) throw new Error("child-exit filename binding differs");
              exits.set(record.id, parsed);
              break;
            }
            case "stops": {
              const parsed = stopReceiptSchema.parse(value);
              if (parsed.runtimeId !== record.id) throw new Error("stop filename binding differs");
              stops.set(record.id, parsed);
              break;
            }
            case "stop-completions": {
              const parsed = stopCompletionSchema.parse(value);
              if (parsed.runtimeId !== record.id) throw new Error("completion filename binding differs");
              completions.set(record.id, parsed);
              break;
            }
            case "restoration-proofs": {
              const parsed = restorationProofSchema.parse(value);
              if (parsed.runtimeId !== record.id) throw new Error("restoration filename binding differs");
              restorations.set(record.id, parsed);
              break;
            }
          }
        } catch (error) {
          noteIssue(record.id, `Lifecycle disposition is indeterminate: ${this.message(error)}`);
        }
      }

      const allRuntimeIds = [...new Set([
        ...runtimes.keys(),
        ...exits.keys(),
        ...stops.keys(),
        ...completions.keys(),
        ...restorations.keys(),
        ...invalidRuntimeIds,
      ])].sort();
      const counts: Record<OwnedRuntimeHistoryDisposition, number> = {
        completed: 0,
        child_exit_only: 0,
        cleanup_pending: 0,
        active_or_unresolved: 0,
        indeterminate: 0,
      };
      const recoverableRuntimeIds: string[] = [];
      const historicalManagers = new Set<string>();

      for (const runtimeId of allRuntimeIds) {
        if (invalidRuntimeIds.has(runtimeId)) {
          counts.indeterminate += 1;
          continue;
        }
        const receipt = runtimes.get(runtimeId);
        if (!receipt) {
          counts.indeterminate += 1;
          noteIssue(runtimeId, "Lifecycle disposition record has no matching runtime receipt.");
          continue;
        }
        if (receipt.mcpOwner.managerInstanceId !== this.managerInstanceId) {
          historicalManagers.add(receipt.mcpOwner.managerInstanceId);
        }
        const childExit = exits.get(runtimeId);
        const stopped = stops.get(runtimeId);
        const completion = completions.get(runtimeId);
        const restoration = restorations.get(runtimeId);
        let invalidReason: string | null = null;
        if (childExit && (childExit.sessionId !== receipt.sessionId || childExit.pid !== receipt.pid ||
            pathKey(childExit.executablePath) !== pathKey(receipt.executablePath) ||
            childExit.creationTimeFileTime !== receipt.creationTimeFileTime)) {
          invalidReason = "Child-exit evidence is cross-bound to the runtime receipt.";
        } else if (stopped && (stopped.sessionId !== receipt.sessionId ||
            stopped.mcpActor.installationId !== receipt.mcpOwner.installationId ||
            stopped.mcpActor.userSid !== receipt.mcpOwner.userSid)) {
          invalidReason = "Stop evidence is cross-bound to the runtime receipt.";
        } else if (completion && (!stopped || completion.sessionId !== receipt.sessionId ||
            completion.preparedLaunchId !== receipt.preparedLaunchId)) {
          invalidReason = "Stop completion is cross-bound or lacks exact stop evidence.";
        } else if (restoration && (restoration.sessionId !== receipt.sessionId ||
            restoration.managerInstanceId !== receipt.mcpOwner.managerInstanceId)) {
          invalidReason = "Restoration evidence is cross-bound to the runtime receipt.";
        }
        if (invalidReason) {
          counts.indeterminate += 1;
          noteIssue(runtimeId, invalidReason);
        } else if (stopped && completion) {
          counts.completed += 1;
        } else if (stopped) {
          counts.cleanup_pending += 1;
          recoverableRuntimeIds.push(runtimeId);
        } else if (childExit) {
          counts.child_exit_only += 1;
          recoverableRuntimeIds.push(runtimeId);
        } else {
          counts.active_or_unresolved += 1;
        }
      }

      if (!readiness.complete) {
        noteIssue("inventory", "The complete lifecycle namespace could not be verified by the idle-readiness probe.");
      }
      if (!snapshot.complete || snapshot.usage.records > this.maxStoreRecords ||
          snapshot.usage.bytes > this.maxStoreBytes) {
        noteIssue("inventory", "The lifecycle namespace exceeded or violated its bounded LMDB inventory contract.");
      }
      const deadlineExceeded = options.signal.aborted || Date.now() >= options.deadlineAtMs;
      if (deadlineExceeded) {
        noteIssue("inventory", "Lifecycle history classification exceeded its aggregate deadline or was cancelled.");
      }
      const returnedCandidates = recoverableRuntimeIds.slice(0, options.maxRuntimes);
      return {
        schemaVersion: 1,
        complete: readiness.complete && snapshot.complete &&
          snapshot.usage.records <= this.maxStoreRecords && snapshot.usage.bytes <= this.maxStoreBytes &&
          issues.length === 0 && !deadlineExceeded,
        recordsScanned: snapshot.usage.records,
        runtimesScanned: allRuntimeIds.length,
        counts,
        recoverableCount: recoverableRuntimeIds.length,
        recoverableRuntimeIds: returnedCandidates,
        historicalManagerInstances: historicalManagers.size,
        idleBlockers: readiness.blockers,
        truncated: recoverableRuntimeIds.length > returnedCandidates.length,
        issues,
      };
    }, wallDeadline);
  }

  private emptyRuntimeHistoryInventory(
    readiness: McpIdleProviderReadiness,
  ): OwnedRuntimeHistoryInventory {
    return {
      schemaVersion: 1,
      complete: readiness.complete,
      recordsScanned: 0,
      runtimesScanned: 0,
      counts: {
        completed: 0,
        child_exit_only: 0,
        cleanup_pending: 0,
        active_or_unresolved: 0,
        indeterminate: 0,
      },
      recoverableCount: 0,
      recoverableRuntimeIds: [],
      historicalManagerInstances: 0,
      idleBlockers: readiness.blockers,
      truncated: false,
      issues: [],
    };
  }

  /**
   * Validate the complete existing LMDB inventory without opening the creating
   * writer accessor, sweeping receipts, revoking sessions, or starting the
   * private observer child.
   */
  async inspectIdleShutdownReadiness(
    options: IdleShutdownInspectionOptions,
  ): Promise<McpIdleProviderReadiness> {
    const nowTick = options.nowTick ?? (() => performance.now());
    const blockers = new Set<McpIdleBlockerCode>();
    let complete = true;
    const childCounts = this.children.counts();
    if (childCounts.active > 0) blockers.add("OWNED_RUNTIME_LIVE");
    if (childCounts.reconciling > 0) blockers.add("OWNED_RUNTIME_RECOVERY");
    if (options.signal.aborted || nowTick() > options.deadlineTick) {
      return { complete: false, blockers: ["INCOMPLETE_PROOF"], revision: this.idleRevision };
    }

    let existing;
    try {
      existing = await this.snapshotExistingOwnedRuntimeRecords();
    } catch {
      return { complete: false, blockers: ["INCOMPLETE_PROOF"], revision: this.idleRevision };
    }
    if (existing.kind === "missing") {
      return {
        complete: !options.signal.aborted && nowTick() <= options.deadlineTick,
        blockers: [...blockers].sort(),
        revision: this.idleRevision,
      };
    }
    const snapshot = existing.value;
    if (!snapshot.complete || snapshot.usage.records > this.maxStoreRecords ||
        snapshot.usage.bytes > this.maxStoreBytes) {
      complete = false;
    }

    const prepared = new Map<string, PreparedDescriptor>();
    const indexes = new Map<string, PreparedSessionIndex>();
    const invalidations = new Map<string, PreparedInvalidation>();
    const consumptions = new Map<string, z.infer<typeof consumptionSchema>>();
    const pending = new Map<string, PendingStart>();
    const runtimes = new Map<string, OwnedRuntimeReceipt>();
    const exits = new Map<string, ChildExitReceipt>();
    const stops = new Map<string, StopReceipt>();
    const completions = new Map<string, StopCompletion>();
    const restorations = new Map<string, RestorationProof>();
    const idempotency = new Map<string, z.infer<typeof idempotencySchema>>();
    const gameLaunchChains = new Map<string, GameLaunchChain>();

    const decode = (bytes: Uint8Array | null): unknown => {
      if (!bytes || bytes.byteLength < LIFECYCLE_RECORD_MIN_BYTES || bytes.byteLength > this.maxRecordBytes) {
        throw new Error("invalid record bytes");
      }
      return JSON.parse(Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, ""));
    };
    try {
      for (const record of snapshot.records) {
        const value = decode(record.bytes);
        switch (record.family as OwnedRuntimeRecordDirectory) {
          case "prepared": {
            const parsed = preparedDescriptorSchema.parse(value);
            if (parsed.preparedLaunchId !== record.id ||
                (record.bytes?.byteLength ?? 0) > (parsed.gameLaunchEvidence
                  ? this.maxRecordBytes : this.preparedDescriptorMaxBytes())) throw new Error("prepared binding");
            if (parsed.gameLaunchEvidence) validatedGameLaunchEvidence(parsed.gameLaunchEvidence);
            prepared.set(record.id, parsed);
            break;
          }
          case "prepared-index": {
            const parsed = preparedSessionIndexSchema.parse(value);
            if (sha256(parsed.sessionId) !== record.id) throw new Error("index binding");
            indexes.set(record.id, parsed);
            break;
          }
          case "prepared-invalidations": {
            const parsed = preparedInvalidationSchema.parse(value);
            if (parsed.preparedLaunchId !== record.id) throw new Error("invalidation binding");
            invalidations.set(record.id, parsed);
            break;
          }
          case "consumed": {
            const parsed = consumptionSchema.parse(value);
            if (parsed.preparedLaunchId !== record.id) throw new Error("consumption binding");
            consumptions.set(record.id, parsed);
            break;
          }
          case "pending-starts": {
            const parsed = pendingStartSchema.parse(value);
            if (parsed.runtimeId !== record.id) throw new Error("pending binding");
            pending.set(record.id, parsed);
            break;
          }
          case "runtimes": {
            const parsed = runtimeReceiptSchema.parse(value);
            if (parsed.runtimeId !== record.id) throw new Error("runtime binding");
            runtimes.set(record.id, parsed);
            break;
          }
          case "child-exits": {
            const parsed = childExitReceiptSchema.parse(value);
            if (parsed.runtimeId !== record.id) throw new Error("child-exit binding");
            exits.set(record.id, parsed);
            break;
          }
          case "stops": {
            const parsed = stopReceiptSchema.parse(value);
            if (parsed.runtimeId !== record.id) throw new Error("stop binding");
            stops.set(record.id, parsed);
            break;
          }
          case "stop-completions": {
            const parsed = stopCompletionSchema.parse(value);
            if (parsed.runtimeId !== record.id) throw new Error("completion binding");
            completions.set(record.id, parsed);
            break;
          }
          case "restoration-proofs": {
            const parsed = restorationProofSchema.parse(value);
            if (parsed.runtimeId !== record.id) throw new Error("restoration binding");
            restorations.set(record.id, parsed);
            break;
          }
          case "idempotency": {
            const parsed = idempotencySchema.parse(value);
            if (`${parsed.action}-${parsed.keyHash}` !== record.id) throw new Error("idempotency binding");
            idempotency.set(record.id, parsed);
            break;
          }
          case "game-launch-chains": {
            const parsed = gameLaunchChainSchema.parse(value);
            this.assertGameLaunchChain(parsed);
            if (parsed.profileKeyDigest !== record.id) throw new Error("game-launch chain binding");
            gameLaunchChains.set(record.id, parsed);
            break;
          }
          default:
            throw new Error("unknown record family");
        }
      }

      for (const index of indexes.values()) {
        const descriptor = prepared.get(index.preparedLaunchId);
        if (!descriptor || descriptor.sessionId !== index.sessionId ||
            descriptor.expiresAt !== index.expiresAt ||
            this.preparedFingerprint(descriptor) !== index.descriptorFingerprint) throw new Error("unlinked index");
      }
      for (const invalidation of invalidations.values()) {
        const descriptor = prepared.get(invalidation.preparedLaunchId);
        if (!descriptor || invalidation.sessionId !== descriptor.sessionId ||
            invalidation.managerInstanceId !== descriptor.managerInstanceId ||
            !descriptor.gameLaunchEvidence || invalidation.gameLaunchEvidenceDigest !==
              descriptor.gameLaunchEvidence.gameLaunchEvidenceDigest) throw new Error("unlinked invalidation");
      }
      for (const consumption of consumptions.values()) {
        const descriptor = prepared.get(consumption.preparedLaunchId);
        const runtime = runtimes.get(consumption.runtimeId);
        const starting = pending.get(consumption.runtimeId);
        if (!descriptor || (!runtime && !starting)) throw new Error("unlinked consumption");
        if ((runtime && runtime.preparedLaunchId !== descriptor.preparedLaunchId) ||
            (starting && starting.preparedLaunchId !== descriptor.preparedLaunchId)) {
          throw new Error("mixed consumption");
        }
      }
      for (const runtime of runtimes.values()) {
        const descriptor = prepared.get(runtime.preparedLaunchId);
        const consumption = consumptions.get(runtime.preparedLaunchId);
        if (!descriptor || !consumption || consumption.runtimeId !== runtime.runtimeId ||
            descriptor.managerInstanceId !== runtime.mcpOwner.managerInstanceId ||
            descriptor.sessionId !== runtime.sessionId || descriptor.profilePath !== runtime.profilePath ||
            descriptor.runtimeKind !== runtime.runtimeKind || descriptor.expiresAt !== runtime.preparedExpiresAt ||
            sha256(JSON.stringify([...descriptor.arguments, runtime.ownerTokenArgument])) !== runtime.argvSha256) {
          throw new Error("unlinked runtime");
        }
      }
      for (const starting of pending.values()) {
        const descriptor = prepared.get(starting.preparedLaunchId);
        const consumption = consumptions.get(starting.preparedLaunchId);
        if (!descriptor || !consumption || consumption.runtimeId !== starting.runtimeId ||
            descriptor.managerInstanceId !== starting.mcpOwner.managerInstanceId ||
            descriptor.sessionId !== starting.sessionId) throw new Error("unlinked pending start");
      }
      for (const exit of exits.values()) {
        const runtime = runtimes.get(exit.runtimeId);
        const starting = pending.get(exit.runtimeId);
        if (!runtime && !starting) throw new Error("unlinked child exit");
        if (runtime && (exit.sessionId !== runtime.sessionId || exit.pid !== runtime.pid ||
            pathKey(exit.executablePath) !== pathKey(runtime.executablePath) ||
            exit.creationTimeFileTime !== runtime.creationTimeFileTime)) throw new Error("mixed child exit");
      }
      for (const stopped of stops.values()) {
        const runtime = runtimes.get(stopped.runtimeId);
        if (!runtime || stopped.sessionId !== runtime.sessionId ||
            stopped.mcpActor.installationId !== runtime.mcpOwner.installationId ||
            stopped.mcpActor.userSid !== runtime.mcpOwner.userSid) throw new Error("unlinked stop");
      }
      for (const completion of completions.values()) {
        const runtime = runtimes.get(completion.runtimeId);
        const stopped = stops.get(completion.runtimeId);
        if (!runtime || !stopped || completion.sessionId !== runtime.sessionId ||
            completion.preparedLaunchId !== runtime.preparedLaunchId ||
            stopped.sessionId !== completion.sessionId) throw new Error("unlinked completion");
      }
      for (const proof of restorations.values()) {
        const runtime = runtimes.get(proof.runtimeId);
        if (!runtime || proof.sessionId !== runtime.sessionId ||
            proof.managerInstanceId !== runtime.mcpOwner.managerInstanceId) throw new Error("unlinked restoration");
      }
      for (const attempt of idempotency.values()) {
        if (!runtimes.has(attempt.runtimeId) && !pending.has(attempt.runtimeId)) {
          throw new Error("unlinked idempotency");
        }
      }
      for (const chain of gameLaunchChains.values()) {
        const attempt = chain.current;
        if (["reserved", "revocation_pending", "aborted"].includes(attempt.state)) {
          const unexpectedDescriptor = [...prepared.values()].some((descriptor) =>
            descriptor.sessionId === attempt.sessionId ||
            descriptor.gameLaunchAttempt?.compositeAttemptId === attempt.compositeAttemptId
          );
          if (unexpectedDescriptor || (attempt.sessionId && indexes.has(sha256(attempt.sessionId)))) {
            throw new Error("pre-runtime game-launch attempt retains descriptor evidence");
          }
        }
        if (attempt.state === "aborted" && chain.previous) {
          const previous = chain.previous;
          const runtime = runtimes.get(previous.runtimeId);
          const descriptor = runtime ? prepared.get(runtime.preparedLaunchId) : undefined;
          const stopped = stops.get(previous.runtimeId);
          const completion = completions.get(previous.runtimeId);
          const restoration = restorations.get(previous.runtimeId);
          const link = descriptor?.gameLaunchAttempt;
          if (!runtime || !descriptor || !stopped || !completion ||
              completion.sessionRevoked !== true ||
              descriptor.sessionId !== runtime.sessionId || !link ||
              link.compositeAttemptId !== previous.compositeAttemptId ||
              link.canonicalFingerprint !== previous.canonicalFingerprint ||
              link.generation !== previous.generation ||
              link.profileKeyDigest !== chain.profileKeyDigest ||
              stopped.runtimeId !== runtime.runtimeId || stopped.sessionId !== runtime.sessionId ||
              completion.runtimeId !== runtime.runtimeId || completion.sessionId !== runtime.sessionId ||
              completion.preparedLaunchId !== runtime.preparedLaunchId ||
              completion.completedAt !== previous.completedAt) {
            throw new Error("aborted game-launch successor predecessor proof is incomplete");
          }
          const receiptOnlyExactVacancy = stopped.restorationProofKind === "exact_runtime_vacancy" &&
            stopped.restorationReservationId === undefined;
          if ((!restoration && !receiptOnlyExactVacancy) ||
              (restoration && (restoration.runtimeId !== runtime.runtimeId ||
                restoration.sessionId !== runtime.sessionId ||
                restoration.managerInstanceId !== runtime.mcpOwner.managerInstanceId ||
                restoration.kind !== stopped.restorationProofKind ||
                restoration.sealedAt !== stopped.restorationProvedAt ||
                restoration.reservationId !== stopped.restorationReservationId ||
                (restoration.stopIdempotencyHash !== undefined &&
                  restoration.stopIdempotencyHash !== stopped.stopIdempotencyHash)))) {
            throw new Error("aborted game-launch successor restoration proof is incomplete");
          }
          if (previous.proofDigest !==
              sha256(JSON.stringify({ runtime, stopped, completion, restoration }))) {
            throw new Error("aborted game-launch successor predecessor digest is invalid");
          }
        }
        if (attempt.preparedLaunchId) {
          const descriptor = prepared.get(attempt.preparedLaunchId);
          if (!descriptor || !descriptor.gameLaunchAttempt ||
              JSON.stringify(descriptor.gameLaunchAttempt) !==
                JSON.stringify(this.gameLaunchAttemptLink(chain))) {
            throw new Error("unlinked game-launch descriptor");
          }
        }
        if (attempt.runtimeId) {
          const runtime = runtimes.get(attempt.runtimeId);
          const starting = pending.get(attempt.runtimeId);
          if ((!runtime && !starting) ||
              (runtime && runtime.preparedLaunchId !== attempt.preparedLaunchId) ||
              (starting && starting.preparedLaunchId !== attempt.preparedLaunchId)) {
            throw new Error("unlinked game-launch runtime");
          }
        }
        if (attempt.state === "terminal") {
          const completion = attempt.runtimeId ? completions.get(attempt.runtimeId) : undefined;
          const stopped = attempt.runtimeId ? stops.get(attempt.runtimeId) : undefined;
          if (!completion || !stopped || completion.sessionRevoked !== true ||
              completion.completedAt !== attempt.terminal?.completedAt ||
              stopped.stoppedAt !== attempt.terminal?.stoppedAt) {
            throw new Error("unlinked terminal game-launch chain");
          }
        }
      }
    } catch {
      complete = false;
    }

    if (complete) {
      const now = this.clock();
      // Foreign history remains visible through observer_runtime history, but
      // it is an idle obligation only when this host could lawfully recover it.
      // A different installation or Windows user is deliberately outside this
      // manager's mutation authority and must not keep an unrelated host alive
      // forever merely because the evidence remains retained.
      const sameInstallationForeignRuntimes = [...runtimes.values()].filter((runtime) =>
        runtime.mcpOwner.managerInstanceId !== this.managerInstanceId &&
        runtime.mcpOwner.installationId === this.installationId &&
        !(stops.has(runtime.runtimeId) && completions.has(runtime.runtimeId))
      );
      if (sameInstallationForeignRuntimes.length > 0) {
        try {
          const currentOwner = await this.currentMcpOwner();
          if (sameInstallationForeignRuntimes.some((runtime) =>
            runtime.mcpOwner.userSid === currentOwner.userSid)) {
            blockers.add("OWNED_RUNTIME_RECOVERY");
          }
        } catch {
          complete = false;
        }
      }
      for (const descriptor of prepared.values()) {
        if (descriptor.managerInstanceId !== this.managerInstanceId) continue;
        const consumption = consumptions.get(descriptor.preparedLaunchId);
        if (!consumption) {
          const referenced = [...runtimes.values(), ...pending.values()]
            .some((value) => value.preparedLaunchId === descriptor.preparedLaunchId);
          if (referenced) {
            complete = false;
            break;
          }
          if (Date.parse(descriptor.expiresAt) > now) blockers.add("OWNED_RUNTIME_PREPARATION");
          continue;
        }
        const runtime = runtimes.get(consumption.runtimeId);
        const starting = pending.get(consumption.runtimeId);
        if (!runtime && !starting) {
          complete = false;
          break;
        }
        if (starting && starting.mcpOwner.managerInstanceId !== this.managerInstanceId) {
          complete = false;
          break;
        }
        if (runtime && runtime.mcpOwner.managerInstanceId !== this.managerInstanceId) {
          complete = false;
          break;
        }
        if (starting && !runtime) {
          const releaseComplete = starting.state === "release_acknowledged" ||
            (starting.state === "cleanup_verified" && !starting.lifecycleGeneration);
          if (!releaseComplete) {
            blockers.add(["pre_spawn", "spawned_unverified", "identity_verified"].includes(starting.state)
              ? "OWNED_RUNTIME_START" : "OWNED_RUNTIME_RECOVERY");
          }
          continue;
        }
        if (!runtime) continue;
        if (stops.has(runtime.runtimeId) && completions.has(runtime.runtimeId)) continue;
        if (exits.has(runtime.runtimeId) || stops.has(runtime.runtimeId) ||
            restorations.has(runtime.runtimeId)) {
          blockers.add("OWNED_RUNTIME_RECOVERY");
          continue;
        }
        try {
          const inspection = await this.backend.inspectProcess(runtime.pid, runtime.ownerTokenArgument);
          if (inspection && this.inspectionMatches(runtime, inspection)) blockers.add("OWNED_RUNTIME_LIVE");
          else blockers.add("OWNED_RUNTIME_RECOVERY");
        } catch {
          complete = false;
          break;
        }
      }
      for (const attempt of idempotency.values()) {
        const owner = runtimes.get(attempt.runtimeId)?.mcpOwner.managerInstanceId ??
          pending.get(attempt.runtimeId)?.mcpOwner.managerInstanceId;
        if (owner !== this.managerInstanceId || attempt.state !== "starting") continue;
        if (stops.has(attempt.runtimeId) && completions.has(attempt.runtimeId)) continue;
        blockers.add(attempt.action === "start" ? "OWNED_RUNTIME_START" : "OWNED_RUNTIME_RECOVERY");
      }
      for (const chain of gameLaunchChains.values()) {
        const attempt = chain.current;
        if (attempt.managerInstanceId !== this.managerInstanceId ||
            attempt.state === "terminal" || attempt.state === "aborted") continue;
        blockers.add(attempt.state === "revocation_pending"
          ? "OWNED_RUNTIME_RECOVERY"
          : attempt.state === "reserved" || attempt.state === "starting"
            ? "OWNED_RUNTIME_START"
            : attempt.state === "running"
              ? "OWNED_RUNTIME_LIVE"
              : "OWNED_RUNTIME_PREPARATION");
      }
    }

    if (!complete || options.signal.aborted || nowTick() > options.deadlineTick) {
      complete = false;
      blockers.add("INCOMPLETE_PROOF");
    }
    return {
      complete,
      blockers: [...blockers].sort(),
      revision: this.idleRevision,
    };
  }

  /** Explicit bounded retention hook for controlled shutdown and diagnostics. */
  async sweep(now = this.clock()): Promise<OwnedRuntimeSweepResult> {
    return this.withAdmission("owned runtime retention", () => this.sweepInternal(now));
  }

  private async sweepInternal(now: number): Promise<OwnedRuntimeSweepResult> {
    try {
      return await this.machineMutex.withMachineMutex({
        name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
        timeoutMs: this.lockTimeoutMs,
        action: async () => {
          this.ensureStorage();
          return this.sweepLocked(now);
        },
      });
    } catch (error) {
      throw this.normalizeError(error, "RETENTION_FAILED", "Owned runtime retention failed");
    }
  }

  /** Bounded public diagnostics; no receipt contents or owner tokens are exposed. */
  diagnosticStorageStats(): OwnedRuntimeStorageStats {
    const root = this.ensureStorage();
    return this.storageStats(root);
  }

  async stop(input: OwnedRuntimeStopInput): Promise<OwnedRuntimePublicStatus> {
    return this.withAdmission("owned runtime stop", () => this.stopInternal(input));
  }

  private async stopInternal(input: OwnedRuntimeStopInput): Promise<OwnedRuntimePublicStatus> {
    this.assertOpenForMutation();
    runtimeIdSchema.parse(input.runtimeId);
    boundedIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.waitForRestorationMs) || input.waitForRestorationMs < 0 ||
        input.waitForRestorationMs > 5 * 60_000) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "waitForRestorationMs must be from 0 through 300000");
    }
    if (input.deadlineAtMs !== undefined &&
        (!Number.isFinite(input.deadlineAtMs) || input.deadlineAtMs <= 0)) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "Owned runtime aggregate recovery deadline is invalid");
    }
    // One budget covers preparation, the requested restoration wait, exact
    // inspection/termination, observer completion, and the final CAS. Each
    // configured component contributes once; no sub-operation resets it.
    const wallDeadline: OwnedRuntimeWallDeadline = {
      expiresAtMs: Math.min(
        Date.now() + input.waitForRestorationMs +
          this.lockTimeoutMs + this.inspectionTimeoutMs + this.terminationTimeoutMs,
        input.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      ),
      code: "RECOVERY_REQUIRED",
      message: "Owned runtime stop exceeded its total wall-clock deadline; exact durable state was preserved for retry",
      details: { runtimeId: input.runtimeId, state: "stopping" },
    };
    const keyHash = sha256(input.idempotencyKey);
    const requestFingerprint = sha256(JSON.stringify({
      runtimeId: input.runtimeId,
      waitForRestorationMs: input.waitForRestorationMs,
    }));
    let preparedReservation: StopReservation | null = null;
    try {
      const preparation = await this.withFencedMachineMutex(
        (fence) => this.prepareStopLocked(
          input,
          keyHash,
          requestFingerprint,
          fence,
          wallDeadline
        ),
        wallDeadline
      );
      // Natural-exit reconciliation releases the lifecycle before a later
      // explicit stop. Its exact-generation release tombstone is bounded and
      // may already have been swept. Once preparation has re-proved exact
      // vacancy, idempotently recreate that authority before asking the agent
      // for the reservation-free stop preflight.
      if (preparation.allowUnknownVacantSession) {
        await this.releaseRuntimeLifecycle(preparation.receipt, wallDeadline);
      }
      // Camera/restoration readiness can legitimately take minutes. It is an
      // observer-side wait, not a machine-wide lifecycle mutation, so never
      // retain the global mutex while polling it.
      if (preparation.needsRestorationReservation) {
        // A valid durable restoration proof already seals the session, while
        // exact vacancy can safely use the existing unknown-session path.
        // Re-retention is mandatory only before a live, unsealed stop.
        if (!preparation.allowUnknownVacantSession &&
            !this.readOptionalRestorationProof(preparation.receipt.runtimeId)) {
          await this.reconcileRuntimeLifecycleLease(preparation.receipt, wallDeadline);
        }
        preparedReservation = await this.reserveStopWhenRestored(
          preparation.receipt,
          keyHash,
          preparation.proposedReservationId,
          input.waitForRestorationMs,
          input.signal,
          preparation.allowUnknownVacantSession,
          wallDeadline
        );
      }
      const transition = await this.withFencedMachineMutex((fence) =>
        this.stopLocked(
          input,
          keyHash,
          requestFingerprint,
          preparedReservation,
          fence,
          wallDeadline
        ), wallDeadline);
      if (transition.kind === "complete") return transition.status;

      // Observer session revocation is bounded IPC, not a machine lifecycle
      // mutation. Keep the global mutex free while it is pending, then CAS the
      // durable completion against the exact immutable authority.
      // Keep the exact retained authority through this completion request.
      // Releasing it first turns the hand-off into a sweepable tombstone, so a
      // private-child retention tick can erase the acknowledgement between
      // exact termination and observer completion. The child completes and
      // releases this same generation atomically; a lost completion response
      // remains retryable from the durable exact-vacancy receipt.
      const ack = await this.requestStopCompletionUnlocked(transition.authority, wallDeadline);
      return await this.withFencedMachineMutex(async (fence) => {
        fence.assertActive();
        return this.commitStopCompletionLocked(transition.authority, ack);
      }, wallDeadline);
    } catch (error) {
      // A persisted restoration proof is intentionally retained when the
      // final mutex cannot be acquired. Deleting it here can race a second
      // caller that is already revalidating the same stop transaction.
      await this.discardUncommittedStopAttempt(
        input.runtimeId,
        keyHash,
        requestFingerprint,
        wallDeadline
      ).catch(() => undefined);
      throw this.normalizeError(error, "STOP_FAILED", "Owned runtime stop failed");
    }
  }

  /**
   * Seal safely idle runtime sessions before the MCP's private observer agent
   * closes. This never signals a runtime. The durable proof is the only basis
   * on which a later MCP instance may stop a still-running exact receipt when
   * the old in-memory observer session no longer exists.
   */
  close(deadlineAtMs?: number): Promise<Record<string, unknown>> {
    return this.withPrivilegedCleanup(() => this.closeInternal(deadlineAtMs));
  }

  private closeInternal(deadlineAtMs?: number): Promise<Record<string, unknown>> {
    if (deadlineAtMs !== undefined && (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0)) {
      return Promise.reject(new OwnedRuntimeError("INVALID_REQUEST", "Owned runtime shutdown deadline is invalid"));
    }
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const attempt = this.closeOwnedRuntimes(deadlineAtMs);
    this.closePromise = attempt.then(async (result) => {
      if (result.applicationCloseSafe !== true) {
        this.closing = false;
        this.closePromise = null;
      } else {
        // A clean shutdown seal completed; release the LMDB environment. An
        // unsafe/retryable close deliberately keeps it open for the retry.
        await this.closeRecordStores();
      }
      return result;
    }, (error) => {
      this.closing = false;
      this.closePromise = null;
      throw error;
    });
    return this.closePromise;
  }

  /**
   * Test-only seam: the live record store, opened against the current storage
   * root. Recovery/injection tests use it to inspect, inject, or fault records
   * that used to be manipulated as `<family>/<id>.json` files.
   */
  recordStoreForTest(): LmdbRecordStore {
    this.assertTestSeam("recordStoreForTest");
    this.ensureStorage();
    return this.recordStore();
  }

  /**
   * Fail closed unless a test runner is active. The `*ForTest` seams ship in the
   * published build (tests are excluded from the type-check, not the artifact)
   * yet hand out unmediated record-store access that bypasses the manager's
   * mutex, schema, generation, and aggregate-capacity rules. This guard keeps
   * them unreachable in production while remaining transparent under Vitest.
   */
  private assertTestSeam(method: string): void {
    if (process.env.VITEST === undefined && process.env.NODE_ENV !== "test") {
      throw new Error(`${method} is a test-only seam and must not be called outside the test runner.`);
    }
  }

  /**
   * Test-only seam: release the record-store environment regardless of seal
   * state so `rmSync`/`withTemporaryDirectory` teardown succeeds on Windows,
   * where an open LMDB memory map blocks directory removal.
   */
  async closeStorageForTest(): Promise<void> {
    this.assertTestSeam("closeStorageForTest");
    await this.closeRecordStores();
  }

  private async closeOwnedRuntimes(deadlineAtMs?: number): Promise<Record<string, unknown>> {
    // Shutdown uses the configured lifecycle lock timeout as one aggregate
    // budget, including inventory, observer release/reservation IPC, sealing,
    // and the final inventory CAS. It is deliberately not reset per runtime.
    const wallDeadline: OwnedRuntimeWallDeadline = {
      expiresAtMs: Math.min(
        Date.now() + this.lockTimeoutMs,
        deadlineAtMs ?? Number.POSITIVE_INFINITY,
      ),
      code: "SHUTDOWN_SEAL_FAILED",
      message: "Owned runtime shutdown sealing exceeded its aggregate wall-clock deadline",
      details: { state: "shutdown_sealing" },
    };
    if (!existsSync(this.storageRoot) && this.children.size === 0) {
      // No durable storage and no live children: nothing to seal.
      return {
        sealedRuntimeIds: [],
        busyRuntimeIds: [],
        errorRuntimes: [],
        applicationCloseSafe: true,
      };
    }
    try {
      const inventory = await this.withFencedMachineMutex(async (fence) => {
          this.ensureStorage();
          fence.assertActive();
          let runtimeNames: string[];
          try {
            runtimeNames = this.recordFileNames("runtimes");
          } catch (error) {
            // The runtime receipt namespace could not be inventoried, so
            // shutdown safety cannot be proven. Report it as an inventory error
            // rather than declaring the coordinator safe to close.
            return { kind: "unverifiable" as const, reason: this.message(error) };
          }
          const ids: string[] = [];
          const errors: Array<{ runtimeId: string; reason: string }> = [];
          let scannedEntries = 0;
          for (const name of runtimeNames) {
            fence.assertActive();
            scannedEntries += 1;
            if (scannedEntries > this.maxStoreRecords) {
              throw new OwnedRuntimeError(
                "STORE_CAPACITY_EXCEEDED",
                "Owned runtime shutdown inventory exceeds its record bound"
              );
            }
            const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
            if (!runtimeIdSchema.safeParse(runtimeId).success) {
              errors.push({
                runtimeId: runtimeId || "inventory",
                reason: "Owned runtime receipt has a non-canonical runtime ID",
              });
              continue;
            }
            try {
              const receipt = this.readRuntimeReceipt(runtimeId);
              if (receipt.mcpOwner.managerInstanceId === this.managerInstanceId) ids.push(runtimeId);
            } catch (error) {
              errors.push({ runtimeId, reason: this.message(error).slice(0, 512) });
            }
          }
          return { kind: "ok" as const, runtimeIds: ids.sort(), errors };
        }, wallDeadline);
      if (inventory.kind === "unverifiable") {
        return {
          sealedRuntimeIds: [],
          busyRuntimeIds: [],
          errorRuntimes: [{
            runtimeId: "inventory",
            reason: `Owned runtime receipt directory is missing or unverifiable; shutdown safety cannot be proven: ${inventory.reason}`.slice(0, 512),
          }],
          applicationCloseSafe: false,
        };
      }
      const sealedRuntimeIds: string[] = [];
      const busyRuntimeIds: string[] = [];
      const errorRuntimes: Array<{ runtimeId: string; reason: string }> = [...inventory.errors];
      for (let runtimeIndex = 0; runtimeIndex < inventory.runtimeIds.length; runtimeIndex += 1) {
        const runtimeId = inventory.runtimeIds[runtimeIndex];
        if (Date.now() >= wallDeadline.expiresAtMs) {
          errorRuntimes.push({
            runtimeId: "inventory",
            reason: `Shutdown sealing aggregate deadline expired; ${inventory.runtimeIds.length - runtimeIndex} runtime(s) were not inspected`,
          });
          break;
        }
        try {
          const snapshot = await this.withFencedMachineMutex(async (fence) => {
              const receipt = this.readRuntimeReceipt(runtimeId);
              fence.assertActive();
              const stopped = this.readOptionalStopReceipt(runtimeId);
              if (stopped) {
                if (stopped.sessionId !== receipt.sessionId) {
                  throw new OwnedRuntimeError(
                    "STORAGE_UNVERIFIABLE",
                    "Shutdown found a cross-bound exact vacancy receipt"
                  );
                }
                return { receipt, existing: null, alreadyVacant: true };
              }
              const childExit = this.readOptionalChildExitReceipt(runtimeId);
              if (childExit) {
                if (childExit.sessionId !== receipt.sessionId ||
                    childExit.pid !== receipt.pid ||
                    pathKey(childExit.executablePath) !== pathKey(receipt.executablePath) ||
                    childExit.creationTimeFileTime !== receipt.creationTimeFileTime) {
                  throw new OwnedRuntimeError(
                    "STORAGE_UNVERIFIABLE",
                    "Shutdown found a cross-bound exact child-exit receipt"
                  );
                }
                return { receipt, existing: null, alreadyVacant: true };
              }
              const existing = this.readOptionalRestorationProof(runtimeId);
              return { receipt, existing, alreadyVacant: false };
            }, wallDeadline);
          if (!snapshot) continue;
          const { receipt, existing, alreadyVacant } = snapshot;
          if (alreadyVacant) {
            await this.releaseRuntimeLifecycle(receipt, wallDeadline);
            continue;
          }
          if (existing) {
            if (existing.sessionId !== receipt.sessionId ||
                existing.managerInstanceId !== this.managerInstanceId) {
              throw new OwnedRuntimeError(
                "STORAGE_UNVERIFIABLE",
                "Existing restoration proof is not bound to this lifecycle"
              );
            }
            sealedRuntimeIds.push(runtimeId);
            continue;
          }

          const status = await this.inspectReceipt(receipt, wallDeadline);
          const exactRuntimeVacant = status.state === "exited";
          if (!exactRuntimeVacant && status.state !== "running" && status.state !== "stale") {
            throw new OwnedRuntimeError(
              "IDENTITY_UNVERIFIABLE",
              `Shutdown cannot seal runtime in ${status.state} state`,
              { reason: status.reason }
            );
          }
          const proposedReservationId = deterministicReservationId(
            "owned-runtime-shutdown-seal",
            receipt.runtimeId,
            receipt.sessionId,
            receipt.mcpOwner.managerInstanceId
          );
          const preflight = await this.reserveShutdownLease(
            receipt,
            proposedReservationId,
            wallDeadline,
            exactRuntimeVacant
          );
          if (!preflight.sessionKnown || !preflight.ready || !preflight.reserved) {
            busyRuntimeIds.push(runtimeId);
            continue;
          }
          const reservationId = this.requireReservationId(preflight);
          if (reservationId !== proposedReservationId) {
            throw new OwnedRuntimeError(
              "SESSION_UNVERIFIABLE",
              "Observer shutdown lease did not echo the caller-proposed generation"
            );
          }
          await this.withFencedMachineMutex(async (fence) => {
              const root = this.ensureStorage();
              const current = this.readRuntimeReceipt(runtimeId);
              this.assertSameRuntimeLifecycle(receipt, current);
              fence.assertActive();
              const stopped = this.readOptionalStopReceipt(runtimeId);
              if (stopped) {
                if (stopped.sessionId !== receipt.sessionId) {
                  throw new OwnedRuntimeError(
                    "STORAGE_UNVERIFIABLE",
                    "Raced shutdown vacancy receipt is cross-bound"
                  );
                }
                return;
              }
              const raced = this.readOptionalRestorationProof(runtimeId);
              if (raced) {
                if (raced.sessionId !== receipt.sessionId ||
                    raced.managerInstanceId !== this.managerInstanceId) {
                  throw new OwnedRuntimeError(
                    "STORAGE_UNVERIFIABLE",
                    "Raced shutdown seal belongs to another lifecycle"
                  );
                }
                return;
              }
              const proof = restorationProofSchema.parse({
                version: STORAGE_VERSION,
                runtimeId,
                sessionId: receipt.sessionId,
                managerInstanceId: this.managerInstanceId,
                sealedAt: nowIso(this.clock),
                kind: exactRuntimeVacant
                  ? "exact_runtime_vacancy"
                  : "clean_shutdown_restoration_seal",
                reservationId,
                activeJobIds: [],
                cameraLeaseJobIds: [],
                restorationPendingJobIds: [],
              });
              this.atomicWrite(root, this.restorationProofPath(runtimeId), proof, true);
            }, wallDeadline);
          sealedRuntimeIds.push(runtimeId);
          // Deliberately retain the reservation until the coordinator closes
          // its private child, preventing a capture from racing the proof.
        } catch (error) {
          errorRuntimes.push({ runtimeId, reason: this.message(error).slice(0, 512) });
        }
      }
      const finalUnsafe = await this.withFencedMachineMutex(async (fence) => {
          const unsafe: Array<{ runtimeId: string; reason: string }> = [];
          for (const runtimeId of inventory.runtimeIds) {
            fence.assertActive();
            try {
              const receipt = this.readRuntimeReceipt(runtimeId);
              const stopped = this.readOptionalStopReceipt(runtimeId);
              if (stopped) {
                if (stopped.sessionId !== receipt.sessionId) {
                  throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop receipt is cross-bound");
                }
                continue;
              }
              const childExit = this.readOptionalChildExitReceipt(runtimeId);
              if (childExit) {
                if (childExit.sessionId !== receipt.sessionId || childExit.pid !== receipt.pid ||
                    pathKey(childExit.executablePath) !== pathKey(receipt.executablePath) ||
                    childExit.creationTimeFileTime !== receipt.creationTimeFileTime) {
                  throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Child-exit receipt is cross-bound");
                }
                continue;
              }
              const proof = this.readOptionalRestorationProof(runtimeId);
              if (proof && proof.sessionId === receipt.sessionId &&
                  proof.managerInstanceId === this.managerInstanceId) continue;
              unsafe.push({ runtimeId, reason: "Runtime has no durable shutdown disposition" });
            } catch (error) {
              unsafe.push({ runtimeId, reason: this.message(error).slice(0, 512) });
            }
          }
          return unsafe;
        }, wallDeadline).catch((error) => [{
        runtimeId: "inventory",
        reason: this.message(error).slice(0, 512),
      }]);
      const reportedErrors = new Set(errorRuntimes.map((entry) => entry.runtimeId));
      for (const entry of finalUnsafe) {
        if (!reportedErrors.has(entry.runtimeId)) errorRuntimes.push(entry);
      }
      return {
        sealedRuntimeIds,
        busyRuntimeIds,
        errorRuntimes,
        applicationCloseSafe: busyRuntimeIds.length === 0 && errorRuntimes.length === 0,
      };
    } catch (error) {
      throw this.normalizeError(error, "SHUTDOWN_SEAL_FAILED", "Owned runtime shutdown sealing failed");
    }
  }

  private async reserveShutdownLease(
    receipt: OwnedRuntimeReceipt,
    proposedReservationId: string,
    wallDeadline: OwnedRuntimeWallDeadline,
    exactRuntimeVacant: boolean
  ): Promise<RuntimeStopPreflight> {
    let lastError: unknown = new OwnedRuntimeError(
      "SHUTDOWN_SEAL_FAILED",
      "Observer shutdown lease preflight failed"
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let remaining: number;
      try {
        remaining = this.remainingWallBudget(wallDeadline);
      } catch (error) {
        lastError = error;
        break;
      }
      const attemptsLeft = 2 - attempt;
      const attemptDeadline: OwnedRuntimeWallDeadline = {
        ...wallDeadline,
        expiresAtMs: Math.min(
          wallDeadline.expiresAtMs,
          Date.now() + Math.max(1, Math.floor(remaining / attemptsLeft))
        ),
        message: "Observer shutdown lease preflight exceeded the remaining shutdown deadline",
      };
      try {
        return await this.beforeWallDeadline(attemptDeadline, () =>
          this.options.observerGate.reserveRuntimeStop(
            receipt.sessionId,
            proposedReservationId,
            exactRuntimeVacant,
            {
              runtimeId: receipt.runtimeId,
              generation: runtimeLifecycleGeneration(receipt),
            }
          ));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async revalidatePreparedGameLaunchLocked(
    root: string,
    descriptor: PreparedDescriptor,
    leaseFence: OwnedRuntimeLeaseFence,
    deadlineAtMs: number,
    executableMaximumBytes: number,
  ): Promise<{
    executablePath: string;
    executableFile: ExecutableFileIdentity;
    executableEvidence: OwnedRuntimeExecutableEvidence;
  }> {
    if (!descriptor.gameLaunchEvidence) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Game-launch revalidation requires retained preparation evidence",
      );
    }
    const evidence = validatedGameLaunchEvidence(descriptor.gameLaunchEvidence);
    let planningError: GameLaunchPlanError | null = null;
    let currentExecutable: OwnedRuntimeExecutableEvidence | null = null;
    try {
      const executableSource = this.resolveRuntimeExecutablePlanningSource(
        descriptor.runtimeKind,
      );
      currentExecutable = runtimeExecutableEvidenceSchema.parse(
        await leaseFence.trackRevalidation(this.pointOfUseRevalidator({
          phase: "pre_spawn",
          world: evidence.world,
          addons: evidence.addons,
          executableSource,
          expectedExecutable: evidence.executable,
          executableMaximumBytes,
          deadlineAtMs,
        }, leaseFence.signal)),
      ) as OwnedRuntimeExecutableEvidence;
      leaseFence.assertActive();
      if (Date.now() >= deadlineAtMs) throw gameLaunchRevalidationDeadlineError();
      if (currentExecutable.executablePath !== evidence.executable.executablePath ||
          currentExecutable.runtimeKind !== descriptor.runtimeKind ||
          computeOwnedRuntimeExecutableEvidenceDigest(currentExecutable) !==
            currentExecutable.executableEvidenceDigest ||
          currentExecutable.executableEvidenceDigest !== evidence.executable.executableEvidenceDigest) {
        throw new GameLaunchPlanError(
          "EXECUTABLE_CHANGED",
          "Configured runtime executable changed after game-launch planning.",
        );
      }
    } catch (error) {
      // Worker rejection is also an async continuation. Lease loss must win
      // before the error can authorize invalidation or any other mutation.
      leaseFence.assertActive();
      if (error instanceof OwnedRuntimeError && error.code === "RECOVERY_REQUIRED") throw error;
      planningError = error instanceof GameLaunchPlanError
        ? error
        : new GameLaunchPlanError(
            "EXECUTABLE_EVIDENCE_INVALID",
            "Game-launch point-of-use evidence could not be revalidated safely.",
            { cause: error },
          );
    }
    if (!planningError && currentExecutable) {
      return {
        executablePath: currentExecutable.executablePath,
        executableFile: currentExecutable.executableFile,
        executableEvidence: currentExecutable,
      };
    }
    planningError ??= new GameLaunchPlanError(
      "EXECUTABLE_EVIDENCE_INVALID",
      "Game-launch point-of-use executable evidence could not be produced safely.",
    );
    if (this.readOptionalConsumption(descriptor.preparedLaunchId) ||
        this.preparedRuntimeReferences().has(descriptor.preparedLaunchId)) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Prepared game launch changed after consumption or runtime evidence already existed",
      );
    }
    const invalidation = preparedInvalidationSchema.parse({
      version: STORAGE_VERSION,
      preparedLaunchId: descriptor.preparedLaunchId,
      sessionId: descriptor.sessionId,
      invalidatedAt: nowIso(this.clock),
      planningCode: planningError.code,
      gameLaunchEvidenceDigest: evidence.gameLaunchEvidenceDigest,
      unconsumed: true,
      managerInstanceId: this.managerInstanceId,
    });
    this.assertBatchCapacity(root, [{
      target: this.preparedInvalidationPath(descriptor.preparedLaunchId),
      value: invalidation,
      exclusive: true,
    }]);
    this.atomicWrite(
      root,
      this.preparedInvalidationPath(descriptor.preparedLaunchId),
      invalidation,
      true,
      true,
    );
    throw new OwnedRuntimePreconsumptionError(planningError, {
      preparedLaunchId: descriptor.preparedLaunchId,
      sessionId: descriptor.sessionId,
      invalidationRecorded: true,
      unconsumed: true,
    });
  }

  private async resolveBaselineExecutableLocked(
    runtimeKind: ObserverLaunchInput["runtimeKind"],
    leaseFence: OwnedRuntimeLeaseFence,
    deadlineAtMs: number,
    executableMaximumBytes: number,
  ): Promise<OwnedRuntimeExecutableEvidence> {
    try {
      const executableSource = this.resolveRuntimeExecutablePlanningSource(runtimeKind);
      const current = runtimeExecutableEvidenceSchema.parse(
        await leaseFence.trackRevalidation(this.pointOfUseRevalidator({
          phase: "baseline_executable",
          executableSource,
          runtimeKind,
          executableMaximumBytes,
          deadlineAtMs,
        }, leaseFence.signal)),
      ) as OwnedRuntimeExecutableEvidence;
      leaseFence.assertActive();
      if (Date.now() >= deadlineAtMs) throw gameLaunchRevalidationDeadlineError();
      if (current.runtimeKind !== runtimeKind ||
          computeOwnedRuntimeExecutableEvidenceDigest(current) !==
            current.executableEvidenceDigest) {
        throw new GameLaunchPlanError(
          "EXECUTABLE_EVIDENCE_INVALID",
          "Configured runtime executable returned invalid baseline evidence.",
        );
      }
      return current;
    } catch (error) {
      // A failed isolated read cannot be classified after the mutex lease is
      // gone; another manager may already own the lifecycle transaction.
      leaseFence.assertActive();
      if (error instanceof OwnedRuntimeError || error instanceof GameLaunchPlanError) throw error;
      if (error instanceof GameLaunchRevalidationIsolationError && error.kind === "ownedRuntime") {
        throw new OwnedRuntimeError(error.code, error.message, error.details);
      }
      throw new OwnedRuntimeError(
        "IDENTITY_UNVERIFIABLE",
        "Configured runtime executable baseline could not be resolved safely",
        error instanceof GameLaunchRevalidationIsolationError
          ? { isolationCode: error.code }
          : undefined,
      );
    }
  }

  private async revalidateSpawnedExecutableLocked(
    expected: OwnedRuntimeExecutableEvidence,
    leaseFence: OwnedRuntimeLeaseFence,
    deadlineAtMs: number,
    executableMaximumBytes: number,
  ): Promise<ExecutableFileIdentity> {
    try {
      const current = runtimeExecutableEvidenceSchema.parse(
        await leaseFence.trackRevalidation(this.pointOfUseRevalidator({
          phase: "post_spawn_executable",
          expectedExecutable: expected,
          executableMaximumBytes,
          deadlineAtMs,
        }, leaseFence.signal)),
      ) as OwnedRuntimeExecutableEvidence;
      leaseFence.assertActive();
      if (Date.now() >= deadlineAtMs) throw gameLaunchRevalidationDeadlineError();
      if (current.runtimeKind !== expected.runtimeKind ||
          current.executablePath !== expected.executablePath ||
          computeOwnedRuntimeExecutableEvidenceDigest(current) !==
            current.executableEvidenceDigest ||
          current.executableEvidenceDigest !== expected.executableEvidenceDigest ||
          !executableFilesMatch(current.executableFile, expected.executableFile)) {
        throw new GameLaunchPlanError(
          "EXECUTABLE_CHANGED",
          "Configured runtime executable was replaced during start.",
        );
      }
      return current.executableFile;
    } catch (error) {
      leaseFence.assertActive();
      if (error instanceof OwnedRuntimeError && error.code === "RECOVERY_REQUIRED") throw error;
      if (error instanceof GameLaunchPlanError && error.code === "EXECUTABLE_CHANGED") {
        throw new OwnedRuntimeError(
          "IDENTITY_MISMATCH",
          "Graphical runtime executable was replaced during start",
        );
      }
      const timedOut = error instanceof GameLaunchPlanError && error.code === "PLANNING_TIMEOUT";
      const isolatedFailure = error instanceof GameLaunchRevalidationIsolationError;
      throw new OwnedRuntimeError(
        "IDENTITY_UNVERIFIABLE",
        timedOut
          ? "Post-spawn executable revalidation exceeded its absolute deadline"
          : "Post-spawn executable identity could not be revalidated safely",
        {
          phase: "post_spawn_executable",
          timedOut,
          ...(isolatedFailure ? { isolationCode: error.code } : {}),
        },
      );
    }
  }

  private async startLocked(
    preparedLaunchId: string,
    keyHash: string,
    requestFingerprint: string,
    leaseFence: OwnedRuntimeLeaseFence,
    revalidationDeadlineAtMs: number,
    executableMaximumBytes: number,
  ): Promise<OwnedRuntimePublicStatus> {
    leaseFence.assertActive();
    this.assertOpenForMutation();
    const root = this.ensureStorage();
    this.sweepLocked(this.clock());
    const idempotencyPath = this.idempotencyPath("start", keyHash);
    const existingAttempt = this.readOptionalParsed(idempotencyPath, idempotencySchema, "start idempotency receipt");
    if (existingAttempt) {
      if (existingAttempt.action !== "start" || existingAttempt.keyHash !== keyHash) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Start idempotency receipt does not match its filename");
      }
      if (existingAttempt.requestFingerprint !== requestFingerprint) {
        throw new OwnedRuntimeError("IDEMPOTENCY_CONFLICT", "Start idempotency key was reused with different input");
      }
      const runtime = this.readOptionalRuntimeReceipt(existingAttempt.runtimeId);
      if (runtime) {
        if (runtime.preparedLaunchId !== preparedLaunchId) {
          throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Start idempotency receipt points at another prepared launch");
        }
        this.reconcileGameLaunchChainForRuntimeLocked(runtime);
        await this.reconcileRuntimeLifecycleLease(runtime);
        leaseFence.assertActive();
        return this.inspectReceipt(runtime);
      }
      let pending = this.readOptionalPendingStart(existingAttempt.runtimeId);
      if (pending && pending.preparedLaunchId !== preparedLaunchId) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Pending start receipt points at another prepared launch");
      }
      if (pending) {
        pending = await this.recoverPendingStartCleanup(root, pending, leaseFence);
        leaseFence.assertActive();
      }
      throw new OwnedRuntimeError(
        "START_UNVERIFIABLE",
        "A prior start attempt consumed this prepared launch but published no ownership receipt",
        pending ? { state: pending.state, pid: pending.pid } : undefined
      );
    }

    const descriptor = this.readPreparedDescriptor(preparedLaunchId);
    let gameLaunchChain: GameLaunchChain | null = null;
    const invalidation = this.readOptionalPreparedInvalidation(preparedLaunchId, descriptor);
    if (invalidation) {
      throw new OwnedRuntimeError(
        "PREPARED_LAUNCH_INVALIDATED",
        "Prepared game launch was invalidated before consumption and cannot be started",
        { preparedLaunchId, sessionId: invalidation.sessionId },
      );
    }
    if (descriptor.managerInstanceId !== this.managerInstanceId) {
      throw new OwnedRuntimeError("PREPARED_LAUNCH_STALE", "Prepared launch belongs to a prior MCP lifecycle instance");
    }
    if (Date.parse(descriptor.expiresAt) <= this.clock()) {
      throw new OwnedRuntimeError("PREPARED_LAUNCH_EXPIRED", "Prepared launch has expired");
    }
    assertNoOwnerArgument(descriptor.arguments);
    if (descriptor.arguments.some((argument) => argument.includes("\0"))) {
      throw new OwnedRuntimeError(
        "ARGUMENT_CONFLICT",
        "Prepared launch arguments cannot contain NUL characters",
        undefined,
        "nul_argument"
      );
    }
    // Reserve the complete ownership/recovery cluster before any consumption
    // receipt, spawn, or other irreversible action is attempted.
    this.assertStartLifecycleHeadroom(root, descriptor.gameLaunchEvidence !== undefined);

    const ownerNonce = this.createOwnerToken();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(ownerNonce)) {
      throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", "Generated runtime owner token is not a bounded cryptographic nonce");
    }
    const ownerTokenArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}${ownerNonce}`;
    const argumentsArray = [...descriptor.arguments, ownerTokenArgument];
    if (argumentsArray.filter((argument) =>
      argument.toLowerCase().startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX.toLowerCase())).length !== 1) {
      throw new OwnedRuntimeError(
        "ARGUMENT_CONFLICT",
        "Owned runtime start did not produce exactly one owner argument",
        undefined,
        "managed_arguments"
      );
    }
    const mcpOwner = await this.currentMcpOwner();
    leaseFence.assertActive();

    const consumptionPath = this.consumptionPath(preparedLaunchId);
    let executablePath: string;
    let executableFile: ExecutableFileIdentity;
    let executableEvidence: OwnedRuntimeExecutableEvidence;
    if (descriptor.gameLaunchEvidence) {
      ({ executablePath, executableFile, executableEvidence } =
        await this.revalidatePreparedGameLaunchLocked(
          root,
          descriptor,
          leaseFence,
          revalidationDeadlineAtMs,
          executableMaximumBytes,
        ));
    } else {
      executableEvidence = await this.resolveBaselineExecutableLocked(
        descriptor.runtimeKind,
        leaseFence,
        revalidationDeadlineAtMs,
        executableMaximumBytes,
      );
      executablePath = executableEvidence.executablePath;
      executableFile = executableEvidence.executableFile;
    }
    gameLaunchChain = this.requireGameLaunchChainForDescriptorLocked(descriptor, keyHash);
    leaseFence.assertActive();
    assertWindowsCommandLineFits(executablePath, argumentsArray);
    const argvSha256 = sha256(JSON.stringify(argumentsArray));
    const consumed = this.readOptionalConsumption(preparedLaunchId);
    if (consumed) {
      if (consumed.idempotencyHash === keyHash && consumed.requestFingerprint === requestFingerprint) {
        const runtime = this.readOptionalRuntimeReceipt(consumed.runtimeId);
        if (runtime) {
          if (runtime.preparedLaunchId !== preparedLaunchId) {
            throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Prepared-launch consumption points at another runtime receipt");
          }
          this.reconcileGameLaunchChainForRuntimeLocked(runtime);
          await this.reconcileRuntimeLifecycleLease(runtime);
          leaseFence.assertActive();
          return this.inspectReceipt(runtime);
        }
        throw new OwnedRuntimeError("START_UNVERIFIABLE", "Prepared launch was consumed without a successful receipt");
      }
      throw new OwnedRuntimeError(
        "PREPARED_LAUNCH_CONSUMED",
        "Prepared launch is one-shot and has already been consumed",
        { runtimeId: consumed.runtimeId }
      );
    }

    const runtimeId = `rt-${this.createId()}`;
    const consumedAt = nowIso(this.clock);
    // This prepared-ID-keyed record is the durable, scoped reverse authority.
    // Publish it before pending/runtime evidence so even unreadable forward
    // receipts can pin only their own preparation during retention.
    this.atomicWrite(root, consumptionPath, consumptionSchema.parse({
      version: STORAGE_VERSION,
      preparedLaunchId,
      runtimeId,
      idempotencyHash: keyHash,
      requestFingerprint,
      consumedAt,
    }), true);
    this.atomicWrite(root, idempotencyPath, idempotencySchema.parse({
      version: STORAGE_VERSION,
      action: "start",
      keyHash,
      requestFingerprint,
      runtimeId,
      state: "starting",
      updatedAt: consumedAt,
    }), true);
    if (gameLaunchChain) {
      gameLaunchChain = this.transitionGameLaunchAttempt(gameLaunchChain, {
        state: "starting",
        runtimeId,
      });
      this.writeGameLaunchChain(gameLaunchChain, false);
    }
    const launchedAtMs = this.clock();
    const pendingCreatedAt = new Date(launchedAtMs).toISOString();
    let pending = pendingStartSchema.parse({
      version: STORAGE_VERSION,
      runtimeId,
      sessionId: descriptor.sessionId,
      preparedLaunchId,
      state: "pre_spawn",
      pid: null,
      creationTimeFileTime: null,
      executablePath,
      executableFile,
      ownerTokenArgument,
      argvSha256,
      launchedAtMs,
      lifecycleGeneration: null,
      mcpOwner,
      createdAt: pendingCreatedAt,
      updatedAt: pendingCreatedAt,
    });

    let child: ChildProcess | null = null;
    let foregroundGuard: RuntimeFocusGuardTransaction | null = null;
    let foregroundBinding: Promise<void> | null = null;
    let foregroundProtectionComplete = false;
    let receiptPublished = false;
    let pinnedReceipt: OwnedRuntimeReceipt | null = null;
    try {
      const requiresForegroundGuard =
        (descriptor.runtimeKind === "client" || descriptor.runtimeKind === "listenServer") &&
        descriptor.arguments.some((argument) => argument.toLowerCase() === "-nofocus");
      if (requiresForegroundGuard) {
        // The helper's global hooks and rooted callback must be positively ready
        // before CreateProcess can expose an immediate first window.
        foregroundGuard = await this.prepareForegroundDuringStartup({
          executablePath,
          ownerTokenArgument,
        });
        try {
          // Hook preparation is an async continuation. If the mutex holder
          // disappeared while it was pending, tear down the prepared native
          // guard but never enter the recoverable-spawn journal transaction.
          leaseFence.assertActive();
        } catch (error) {
          await foregroundGuard.abort().catch(() => undefined);
          throw error;
        }
      }
      const transaction = await runRecoverableSpawn({
        transactionId: runtimeId,
        metadata: pending,
        backend: this.backend,
        fence: leaseFence,
        now: this.clock,
        journal: {
          persist: async (
            _previous: RecoverableSpawnRecord<OwnedRuntimeExactIdentity, PendingStart> | null,
            next: RecoverableSpawnRecord<OwnedRuntimeExactIdentity, PendingStart>
          ) => {
            if (next.phase === "pre_spawn") {
              pending = next.metadata;
              this.atomicWrite(root, this.pendingStartPath(runtimeId), pending, true);
            } else if (next.phase === "spawned_unverified") {
              pending = this.updatePendingStart(root, pending, {
                state: "spawned_unverified",
                pid: next.pid,
              });
            } else if (next.phase === "identity_verified") {
              const receipt = pinnedReceipt;
              if (!receipt || !next.identity) {
                throw new OwnedRuntimeError(
                  "IDENTITY_UNVERIFIABLE",
                  "Recoverable spawn journal received no exact runtime identity"
                );
              }
              pending = this.updatePendingStart(root, pending, {
                state: "identity_verified",
                pid: next.identity.pid,
                creationTimeFileTime: next.identity.creationTime,
                lifecycleGeneration: runtimeLifecycleGeneration(receipt),
              });
            } else {
              // The immutable runtime receipt is authoritative. Pending-start
              // completion is best-effort and remains replayable by sweep.
              try {
                pending = this.updatePendingStart(root, pending, { state: "succeeded" });
              } catch {
                // Preserve the successful publication.
              }
            }
            return next;
          },
        },
        spawn: () => {
          // The two isolated reads share this absolute wall budget. Recheck
          // synchronously at the irreversible CreateProcess edge so time
          // spent journaling or establishing the foreground guard cannot turn
          // expired evidence into a late spawn.
          leaseFence.assertActive();
          if (Date.now() >= revalidationDeadlineAtMs) {
            throw gameLaunchRevalidationDeadlineError();
          }
          child = this.spawnProcess(executablePath, argumentsArray, {
            cwd: dirname(executablePath),
            detached: false,
            shell: false,
            stdio: "ignore",
            windowsHide: false,
          });
          if (foregroundGuard && Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0) {
            // Bind synchronously at the spawn edge. The native guard opens and
            // retains this exact process generation before mutating any window.
            foregroundBinding = foregroundGuard.bindTarget(child.pid!);
            // Journal persistence and the child `spawn` event happen before
            // inspection awaits this promise; mark an early native rejection
            // handled without hiding it from the later authoritative await.
            void foregroundBinding.catch(() => undefined);
          }
          return child;
        },
        childPid: (spawned) => spawned.pid,
        awaitSpawn: (spawned) => this.awaitSpawn(spawned),
        inspect: async (spawned) => {
          const identity = await this.inspectSpawned(spawned, executablePath, ownerTokenArgument);
          await (foregroundBinding ?? Promise.resolve());
          if (foregroundGuard) {
            await foregroundGuard.complete(identity);
            foregroundProtectionComplete = true;
          }
          pinnedReceipt = runtimeReceiptSchema.parse({
            version: STORAGE_VERSION,
            runtimeId,
            sessionId: descriptor.sessionId,
            preparedLaunchId,
            pid: identity.pid,
            executablePath: identity.executablePath,
            executableFile,
            creationTimeFileTime: identity.creationTime,
            ownerTokenArgument,
            argvSha256,
            profilePath: descriptor.profilePath,
            runtimeKind: descriptor.runtimeKind,
            startedAt: new Date(launchedAtMs).toISOString(),
            launchedAtMs,
            preparedExpiresAt: descriptor.expiresAt,
            mcpOwner,
          });
          return identity;
        },
        afterIdentityPersisted: async () => {
          const executableFileAfterSpawn = await this.revalidateSpawnedExecutableLocked(
            executableEvidence,
            leaseFence,
            revalidationDeadlineAtMs,
            executableMaximumBytes,
          );
          const receipt = pinnedReceipt;
          if (!receipt) {
            throw new OwnedRuntimeError(
              "IDENTITY_UNVERIFIABLE",
              "Exact runtime receipt was not prepared before executable revalidation",
            );
          }
          pinnedReceipt = runtimeReceiptSchema.parse({
            ...receipt,
            executableFile: executableFileAfterSpawn,
          });
        },
        beforePublish: async () => {
          const receipt = pinnedReceipt;
          if (!receipt) {
            throw new OwnedRuntimeError(
              "IDENTITY_UNVERIFIABLE",
              "Exact runtime receipt was not prepared before lifecycle retention"
            );
          }
          // The retained generation is acquired before successful ownership
          // publication; exact vacancy is the only later release authority.
          await this.retainRuntimeLifecycle(receipt);
        },
        publish: async () => {
          const receipt = pinnedReceipt;
          if (!receipt) {
            throw new OwnedRuntimeError(
              "IDENTITY_UNVERIFIABLE",
              "Exact runtime receipt was not prepared before publication"
            );
          }
          this.atomicWrite(root, this.runtimePath(runtimeId), receipt, true);
          receiptPublished = true;
          if (gameLaunchChain) {
            gameLaunchChain = this.transitionGameLaunchAttempt(gameLaunchChain, { state: "running" });
            this.writeGameLaunchChain(gameLaunchChain, false);
          }
          return receipt;
        },
      });
      const receipt = transaction.publication;
      child = transaction.child;
      this.children.supervise(runtimeId, child, {
        onExit: (exit) => this.reconcileChildExit(receipt, exit),
      });
      try {
        this.atomicWrite(root, idempotencyPath, idempotencySchema.parse({
          version: STORAGE_VERSION,
          action: "start",
          keyHash,
          requestFingerprint,
          runtimeId,
          state: "succeeded",
          updatedAt: nowIso(this.clock),
        }), false);
      } catch {
        // The immutable ownership receipt is authoritative. A retry follows
        // the prior starting record to this receipt and returns it.
      }
      try { child.unref(); } catch { /* the verified lifecycle receipt remains authoritative */ }
      return this.publicStatus(receipt, "running", true);
    } catch (error) {
      // Cleanup is lifecycle mutation too. If the native holder disappeared,
      // leave the last durable pending phase untouched for the next exact
      // recovery transaction instead of racing it without exclusion.
      leaseFence.assertActive();
      if (foregroundGuard && !foregroundProtectionComplete) {
        await foregroundGuard.abort().catch(() => undefined);
        leaseFence.assertActive();
      }
      if (!receiptPublished) {
        const cleanupVerified = child
          ? await this.terminateRetainedChild(child).catch(() => false)
          : true;
        leaseFence.assertActive();
        try {
          pending = this.updatePendingStart(root, pending, {
            state: cleanupVerified
              ? (pinnedReceipt ? "release_required" : "release_acknowledged")
              : "cleanup_required",
            lastError: this.message(error).slice(0, 512),
          });
        } catch {
          // Retain the last durable pending state; never manufacture success.
        }
        if (cleanupVerified) {
          this.children.forget(runtimeId, child ?? undefined);
        } else if (pinnedReceipt && child) {
          // Keep the exact ChildProcess observed even though ownership was not
          // published. Its eventual exit durably completes pending cleanup
          // and releases the same generation; a process restart can perform
          // the equivalent exact reconciliation from the pending receipt.
          this.children.supervise(runtimeId, child, {
            onExit: () => this.reconcilePendingStartExit(pinnedReceipt!),
          });
          try { child.unref(); } catch { /* durable pending cleanup remains authoritative */ }
        }
        // Lifecycle release and its durable acknowledgement are completed by
        // `start()` after this mutex transaction exits.
      }
      throw this.normalizeError(error, "SPAWN_FAILED", "Owned runtime could not be spawned and verified");
    }
  }

  private async prepareStopLocked(
    input: OwnedRuntimeStopInput,
    keyHash: string,
    requestFingerprint: string,
    leaseFence: OwnedRuntimeLeaseFence,
    wallDeadline: OwnedRuntimeWallDeadline
  ): Promise<{
    receipt: OwnedRuntimeReceipt;
    needsRestorationReservation: boolean;
    allowUnknownVacantSession: boolean;
    proposedReservationId: string;
  }> {
    leaseFence.assertActive();
    this.assertOpenForMutation();
    const root = this.ensureStorage();
    if (input.skipRetentionSweep !== true) this.sweepLocked(this.clock());
    leaseFence.assertActive();
    const receipt = this.readRuntimeReceipt(input.runtimeId);
    const idempotencyPath = this.idempotencyPath("stop", keyHash);
    const existingAttempt = this.readOptionalParsed(
      idempotencyPath,
      idempotencySchema,
      "stop idempotency receipt"
    );
    if (existingAttempt && (existingAttempt.action !== "stop" || existingAttempt.keyHash !== keyHash)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop idempotency receipt does not match its filename");
    }
    if (existingAttempt && existingAttempt.requestFingerprint !== requestFingerprint) {
      throw new OwnedRuntimeError("IDEMPOTENCY_CONFLICT", "Stop idempotency key was reused with different input");
    }
    if (existingAttempt && existingAttempt.runtimeId !== input.runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop idempotency receipt points at a different runtime");
    }
    const existingStop = this.readOptionalStopReceipt(input.runtimeId);
    if (existingStop) {
      if (existingStop.sessionId !== receipt.sessionId ||
          existingStop.mcpActor.installationId !== receipt.mcpOwner.installationId ||
          existingStop.mcpActor.userSid !== receipt.mcpOwner.userSid) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop receipt session does not match its runtime receipt");
      }
      const authorityFailure = await this.inspectRecoveryAuthority(receipt, wallDeadline);
      leaseFence.assertActive();
      if (authorityFailure) {
        throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", authorityFailure);
      }
      return {
        receipt,
        needsRestorationReservation: false,
        allowUnknownVacantSession: false,
        proposedReservationId: deterministicReservationId(
          "owned-runtime-stop",
          receipt.runtimeId,
          keyHash
        ),
      };
    }
    if (!existingAttempt) {
      this.atomicWrite(root, idempotencyPath, idempotencySchema.parse({
        version: STORAGE_VERSION,
        action: "stop",
        keyHash,
        requestFingerprint,
        runtimeId: input.runtimeId,
        state: "starting",
        updatedAt: nowIso(this.clock),
      }), true);
    }
    const current = await this.inspectReceipt(receipt, wallDeadline);
    leaseFence.assertActive();
    if (current.state === "identity_mismatch" || current.state === "unverifiable") {
      throw new OwnedRuntimeError(
        "IDENTITY_UNVERIFIABLE",
        `Owned runtime cannot be terminated because its identity is ${current.state}`,
        { reason: current.reason }
      );
    }
    return {
      receipt,
      // Even an already-vacant runtime must serialize with an in-flight stop
      // lease. Otherwise it can publish a tokenless stop while another caller
      // has sealed the session but not yet persisted its proof.
      needsRestorationReservation: true,
      allowUnknownVacantSession: current.state === "exited",
      // The proposal is reproducible from the durable idempotency identity.
      // If an IPC response or proof-publication result is lost, the exact same
      // request can reclaim the child-side lease instead of orphaning it.
      proposedReservationId: deterministicReservationId(
        "owned-runtime-stop",
        receipt.runtimeId,
        keyHash
      ),
    };
  }

  private async stopLocked(
    input: OwnedRuntimeStopInput,
    keyHash: string,
    requestFingerprint: string,
    preparedReservation: StopReservation | null,
    leaseFence: OwnedRuntimeLeaseFence,
    wallDeadline: OwnedRuntimeWallDeadline
  ): Promise<StopLockedResult> {
    leaseFence.assertActive();
    this.assertOpenForMutation();
    const root = this.ensureStorage();
    const receipt = this.readRuntimeReceipt(input.runtimeId);
    const idempotencyPath = this.idempotencyPath("stop", keyHash);
    const existingAttempt = this.readOptionalParsed(idempotencyPath, idempotencySchema, "stop idempotency receipt");
    if (existingAttempt && (existingAttempt.action !== "stop" || existingAttempt.keyHash !== keyHash)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop idempotency receipt does not match its filename");
    }
    if (existingAttempt && existingAttempt.requestFingerprint !== requestFingerprint) {
      throw new OwnedRuntimeError("IDEMPOTENCY_CONFLICT", "Stop idempotency key was reused with different input");
    }
    if (existingAttempt && existingAttempt.runtimeId !== input.runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop idempotency receipt points at a different runtime");
    }
    const existingStop = this.readOptionalStopReceipt(input.runtimeId);
    if (existingStop) {
      if (existingStop.sessionId !== receipt.sessionId) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop receipt session does not match its runtime receipt");
      }
      return this.preflightStopCompletionLocked(
        root,
        receipt,
        idempotencyPath,
        keyHash,
        requestFingerprint,
        preparedReservation?.proof.reservationId
      );
    }
    if (!existingAttempt) {
      this.atomicWrite(root, idempotencyPath, idempotencySchema.parse({
        version: STORAGE_VERSION,
        action: "stop",
        keyHash,
        requestFingerprint,
        runtimeId: input.runtimeId,
        state: "starting",
        updatedAt: nowIso(this.clock),
      }), true);
    }

    let reservation: StopReservation | null = preparedReservation;
    let terminated = false;
    let terminationMayHaveOccurred = false;
    // Once the observer lease has a durable proof, retain both on every
    // pre-signal failure. Releasing it would reopen capture while another
    // retry can still hold and act on that proof. Recovery with the same
    // idempotency key completes or explicitly revokes the sealed session.
    try {
      const current = await this.inspectReceipt(receipt, wallDeadline);
      leaseFence.assertActive();
      if (current.state === "identity_mismatch" || current.state === "unverifiable") {
        throw new OwnedRuntimeError(
          "IDENTITY_UNVERIFIABLE",
          `Owned runtime cannot be terminated because its identity is ${current.state}`,
          { reason: current.reason }
        );
      }
      const mcpActor = await this.currentMcpOwner(wallDeadline);
      leaseFence.assertActive();
      if (current.state === "exited") {
        const priorProof = this.readOptionalRestorationProof(receipt.runtimeId);
        if (priorProof && (priorProof.sessionId !== receipt.sessionId ||
            priorProof.managerInstanceId !== receipt.mcpOwner.managerInstanceId)) {
          throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Runtime restoration proof belongs to another lifecycle");
        }
        const restorationProofKind = priorProof?.kind ??
          (reservation === null ? "exact_runtime_vacancy" : "process_already_exited");
        this.publishStop(
          root,
          receipt,
          keyHash,
          mcpActor,
          "already_exited",
          "pid_absent",
          restorationProofKind,
          priorProof?.sealedAt ?? nowIso(this.clock),
          priorProof?.reservationId
        );
        terminated = true;
        return this.preflightStopCompletionLocked(
          root,
          receipt,
          idempotencyPath,
          keyHash,
          requestFingerprint,
          priorProof?.reservationId
        );
      }
      if (!reservation) {
        throw new OwnedRuntimeError(
          "RECOVERY_REQUIRED",
          "Live runtime stop has no durable restoration reservation; retry is required"
        );
      }
      this.assertCurrentStopReservation(receipt, reservation.proof);
      if (input.signal?.aborted) throw new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled");
      this.assertExecutableFileMatches(receipt);
      const inspection = await this.beforeWallDeadline(wallDeadline, () =>
        this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument));
      leaseFence.assertActive();
      if (!inspection) {
        this.publishStop(
          root,
          receipt,
          keyHash,
          mcpActor,
          "already_exited",
          "pid_absent",
          reservation.proof.kind,
          reservation.proof.sealedAt,
          reservation.proof.reservationId
        );
        terminated = true;
        return this.preflightStopCompletionLocked(
          root,
          receipt,
          idempotencyPath,
          keyHash,
          requestFingerprint,
          reservation.proof.reservationId
        );
      }
      this.assertInspectionMatches(receipt, inspection);
      if (input.signal?.aborted) throw new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled");
      this.assertCurrentStopReservation(receipt, reservation.proof);
      this.assertTerminationPublicationCapacity(
        root,
        receipt,
        keyHash,
        mcpActor,
        reservation.proof
      );
      // From this point an exception or timeout may occur after the native
      // helper has issued TerminateProcess. Keep the restoration seal unless
      // the helper returns a refusal that is contractually pre-signal.
      leaseFence.assertActive();
      terminationMayHaveOccurred = true;
      const result = await this.beforeWallDeadline(wallDeadline, (remainingMs) =>
        this.backend.verifyAndTerminate({
          pid: receipt.pid,
          executablePath: receipt.executablePath,
          creationTime: receipt.creationTimeFileTime,
          ownerTokenArgument: receipt.ownerTokenArgument,
          launchedAtMs: receipt.launchedAtMs,
        }, Math.min(this.terminationTimeoutMs, remainingMs)));
      leaseFence.assertActive();
      if (result.kind === "refused") {
        if ([
          "access_denied",
          "pid_reused",
          "executable_mismatch",
          "creation_time_mismatch",
          "command_line_unverifiable",
          "token_mismatch",
        ].includes(result.reason)) {
          terminationMayHaveOccurred = false;
        }
        throw new OwnedRuntimeError("TERMINATION_REFUSED", result.message, { reason: result.reason });
      }
      const after = await this.beforeWallDeadline(wallDeadline, () =>
        this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument));
      leaseFence.assertActive();
      let vacancyProof: StopReceipt["vacancyProof"] = "retained_handle_exit";
      if (after) {
        const exactStillPresent = this.inspectionMatches(receipt, after);
        if (exactStillPresent) {
          throw new OwnedRuntimeError("TERMINATION_UNVERIFIABLE", "Exact runtime identity is still present after termination");
        }
        vacancyProof = "exact_identity_absent";
      } else {
        vacancyProof = "pid_absent";
      }
      this.publishStop(
        root,
        receipt,
        keyHash,
        mcpActor,
        result.kind,
        vacancyProof,
        reservation.proof.kind,
        reservation.proof.sealedAt,
        reservation.proof.reservationId
      );
      terminated = true;
      this.children.forget(input.runtimeId);
      return this.preflightStopCompletionLocked(
        root,
        receipt,
        idempotencyPath,
        keyHash,
        requestFingerprint,
        reservation.proof.reservationId
      );
    } catch (error) {
      if (terminationMayHaveOccurred && !terminated) {
        throw new OwnedRuntimeError(
          "RECOVERY_REQUIRED",
          `Exact runtime termination may have occurred, but vacancy publication is incomplete: ${this.message(error)}`,
          { runtimeId: receipt.runtimeId, state: "stopping" }
        );
      }
      throw error;
    }
  }

  private async inspectReceipt(
    receipt: OwnedRuntimeReceipt,
    wallDeadline?: OwnedRuntimeWallDeadline
  ): Promise<OwnedRuntimePublicStatus> {
    const stopped = this.readOptionalStopReceipt(receipt.runtimeId);
    if (stopped) {
      if (stopped.sessionId !== receipt.sessionId) {
        return this.publicStatus(receipt, "unverifiable", false, "Stop receipt session does not match the runtime receipt");
      }
      const completion = this.readOptionalStopCompletion(receipt.runtimeId);
      if (!completion) return this.publicCleanupPendingStatus(receipt, stopped);
      if (completion.sessionId !== receipt.sessionId) {
        return this.publicStatus(
          receipt,
          "unverifiable",
          false,
          "Stop completion session does not match the runtime receipt"
        );
      }
      return this.publicStoppedStatus(receipt, stopped);
    }
    const naturalExit = this.readOptionalChildExitReceipt(receipt.runtimeId);
    if (naturalExit) {
      if (naturalExit.sessionId !== receipt.sessionId || naturalExit.pid !== receipt.pid ||
          pathKey(naturalExit.executablePath) !== pathKey(receipt.executablePath) ||
          naturalExit.creationTimeFileTime !== receipt.creationTimeFileTime) {
        return this.publicStatus(
          receipt,
          "unverifiable",
          false,
          "Natural child-exit receipt does not match the exact runtime lifecycle"
        );
      }
      const authorityFailure = await this.inspectRecoveryAuthority(receipt, wallDeadline);
      if (authorityFailure) {
        return this.publicStatus(receipt, "unverifiable", false, authorityFailure);
      }
      let inspection: OwnedRuntimeInspection | null;
      try {
        inspection = wallDeadline
          ? await this.beforeWallDeadline(wallDeadline, () =>
            this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument))
          : await this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument);
      } catch (error) {
        if (this.isWallDeadlineError(error)) throw error;
        return this.publicStatus(
          receipt,
          "unverifiable",
          false,
          `Exact child-exit vacancy could not be re-inspected: ${this.message(error)}`
        );
      }
      if (inspection && this.inspectionMatches(receipt, inspection)) {
        return this.publicStatus(
          receipt,
          "unverifiable",
          false,
          "Exact runtime identity is still live despite its child-exit receipt"
        );
      }
      return this.publicStatus(
        receipt,
        "exited",
        true,
        `Direct child exit was reconciled at ${naturalExit.observedAt}`
      );
    }
    const restorationProof = this.readOptionalRestorationProof(receipt.runtimeId);
    if (restorationProof?.kind === "live_stop_reservation") {
      if (restorationProof.sessionId !== receipt.sessionId ||
          restorationProof.managerInstanceId !== receipt.mcpOwner.managerInstanceId) {
        return this.publicStatus(
          receipt,
          "unverifiable",
          false,
          "Runtime restoration proof belongs to another lifecycle"
        );
      }
      return {
        ...this.publicStatus(
          receipt,
          "stopping",
          true,
          "Camera restoration is sealed; exact process termination or recovery is pending"
        ),
        terminationComplete: false,
        observerCleanupPending: false,
      };
    }
    const authorityFailure = await this.inspectRecoveryAuthority(receipt, wallDeadline);
    if (authorityFailure) return this.publicStatus(receipt, "unverifiable", false, authorityFailure);
    let configuredExecutable: string;
    try {
      configuredExecutable = canonicalFile(
        this.resolveExecutable(receipt.runtimeKind),
        `Configured ${receipt.runtimeKind} runtime executable`
      );
    } catch (error) {
      return this.publicStatus(receipt, "unverifiable", false, `Configured executable is unavailable: ${this.message(error)}`);
    }
    if (pathKey(configuredExecutable) !== pathKey(receipt.executablePath)) {
      return this.publicStatus(receipt, "identity_mismatch", false, "Configured executable path drifted from the ownership receipt");
    }
    let configuredExecutableFile: ExecutableFileIdentity;
    try {
      configuredExecutableFile = inspectExecutableFile(configuredExecutable);
    } catch (error) {
      return this.publicStatus(receipt, "unverifiable", false, `Configured executable identity is unavailable: ${this.message(error)}`);
    }
    if (!executableFilesMatch(configuredExecutableFile, receipt.executableFile)) {
      return this.publicStatus(receipt, "identity_mismatch", false, "Configured executable file was replaced after the owned start");
    }
    let inspection: OwnedRuntimeInspection | null;
    try {
      inspection = wallDeadline
        ? await this.beforeWallDeadline(wallDeadline, () =>
          this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument))
        : await this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument);
    } catch (error) {
      if (this.isWallDeadlineError(error)) throw error;
      return this.publicStatus(receipt, "unverifiable", false, this.message(error));
    }
    if (!inspection) return this.publicStatus(receipt, "exited", true);
    if (!this.inspectionMatches(receipt, inspection)) {
      return this.publicStatus(receipt, "identity_mismatch", false, "PID, executable, creation time, or exact owner argument no longer matches");
    }
    if (Date.parse(receipt.preparedExpiresAt) <= this.clock()) {
      return this.publicStatus(receipt, "stale", true, "Observer session has expired; the exact process remains owned but is never stopped automatically");
    }
    return this.publicStatus(receipt, "running", true);
  }

  private async reconcileChildExit(
    receipt: OwnedRuntimeReceipt,
    exit: SupervisedChildExit
  ): Promise<void> {
    await this.machineMutex.withMachineMutex({
      name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
      timeoutMs: this.lockTimeoutMs,
      action: async () => {
        const root = this.ensureStorage();
        const current = this.readRuntimeReceipt(receipt.runtimeId);
        if (current.sessionId !== receipt.sessionId || current.pid !== receipt.pid ||
            pathKey(current.executablePath) !== pathKey(receipt.executablePath) ||
            current.creationTimeFileTime !== receipt.creationTimeFileTime) {
          throw new OwnedRuntimeError(
            "STORAGE_UNVERIFIABLE",
            "Child exit cannot be reconciled against a different runtime lifecycle"
          );
        }
        const existing = this.readOptionalChildExitReceipt(receipt.runtimeId);
        if (existing) return;
        this.atomicWrite(root, this.childExitPath(receipt.runtimeId), childExitReceiptSchema.parse({
          version: STORAGE_VERSION,
          runtimeId: receipt.runtimeId,
          sessionId: receipt.sessionId,
          pid: receipt.pid,
          executablePath: receipt.executablePath,
          creationTimeFileTime: receipt.creationTimeFileTime,
          observedAt: nowIso(this.clock),
          exitCode: exit.code,
          signal: exit.signal,
        }), true);
      },
    });
    await this.releaseRuntimeLifecycle(receipt);
  }

  private async persistObservedNaturalExit(receipt: OwnedRuntimeReceipt): Promise<boolean> {
    return this.withFencedMachineMutex(async (fence) => {
      const root = this.ensureStorage();
      const current = this.readRuntimeReceipt(receipt.runtimeId);
      this.assertSameRuntimeLifecycle(receipt, current);
      if (this.readOptionalStopReceipt(receipt.runtimeId)) return false;
      const existing = this.readOptionalChildExitReceipt(receipt.runtimeId);
      if (existing) {
        if (existing.sessionId !== receipt.sessionId || existing.pid !== receipt.pid ||
            pathKey(existing.executablePath) !== pathKey(receipt.executablePath) ||
            existing.creationTimeFileTime !== receipt.creationTimeFileTime) {
          throw new OwnedRuntimeError(
            "STORAGE_UNVERIFIABLE",
            "Observed child exit belongs to another exact runtime lifecycle"
          );
        }
        return true;
      }
      const inspection = await this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument);
      fence.assertActive();
      if (inspection && this.inspectionMatches(receipt, inspection)) return false;
      this.atomicWrite(root, this.childExitPath(receipt.runtimeId), childExitReceiptSchema.parse({
        version: STORAGE_VERSION,
        runtimeId: receipt.runtimeId,
        sessionId: receipt.sessionId,
        pid: receipt.pid,
        executablePath: receipt.executablePath,
        creationTimeFileTime: receipt.creationTimeFileTime,
        observedAt: nowIso(this.clock),
        exitCode: null,
        signal: null,
      }), true);
      return true;
    });
  }

  private async reserveStopWhenRestored(
    receipt: OwnedRuntimeReceipt,
    keyHash: string,
    proposedReservationId: string,
    waitForRestorationMs: number,
    signal?: AbortSignal,
    allowUnknownVacantSession = false,
    wallDeadline?: OwnedRuntimeWallDeadline
  ): Promise<StopReservation | null> {
    const restorationDeadline = Date.now() + waitForRestorationMs;
    let exactRuntimeVacant = allowUnknownVacantSession;
    z.string().uuid().parse(proposedReservationId);
    try {
      return await this.durableReservations.acquire<
        StopReservation | null,
        RuntimeStopPreflight,
        { code: "CANCELLED"; message: string }
      >({
        deadlineMs: restorationDeadline,
        retryIntervalMs: PROCESS_POLL_MS,
        signal,
        cancellationReason: {
          code: "CANCELLED",
          message: "Owned runtime stop was cancelled",
        },
        attempt: async ({ remainingMs }) => {
          const durableProof = wallDeadline
            ? await this.withFencedMachineMutex(
              async () => this.readValidatedRestorationProofLocked(receipt),
              wallDeadline
            )
            : await this.withFencedMachineMutex(
              async () => this.readValidatedRestorationProofLocked(receipt)
            );
          if (durableProof) {
            if (durableProof.kind === "live_stop_reservation" &&
                durableProof.stopIdempotencyHash !== keyHash) {
              throw new OwnedRuntimeError(
                "RECOVERY_REQUIRED",
                "A different idempotent stop owns the durable restoration lease",
                { runtimeId: receipt.runtimeId, state: "stopping" }
              );
            }
            return { kind: "acquired" as const, value: { proof: durableProof } };
          }

          let preflight: RuntimeStopPreflight;
          try {
            const request = () => this.options.observerGate.reserveRuntimeStop(
              receipt.sessionId,
              proposedReservationId,
              exactRuntimeVacant,
              {
                runtimeId: receipt.runtimeId,
                generation: runtimeLifecycleGeneration(receipt),
              }
            );
            preflight = wallDeadline
              ? await this.beforeWallDeadline(wallDeadline, () => request())
              : await request();
          } catch (error) {
            // The request may have reached the serialized child before IPC
            // failed. The deterministic proposal is recoverable by the next
            // exact idempotent API retry; never guess at release here.
            throw error;
          }
          if (!preflight.sessionKnown) {
            if (exactRuntimeVacant) {
              return { kind: "acquired" as const, value: null };
            }
            throw new OwnedRuntimeError(
              "SESSION_UNVERIFIABLE",
              "Observer session state is unavailable, so camera restoration cannot be proven"
            );
          }
          if (preflight.reservationRequired === false) {
            if (!exactRuntimeVacant || !preflight.ready || preflight.reserved ||
                preflight.reservationId !== undefined) {
              throw new OwnedRuntimeError(
                "SESSION_UNVERIFIABLE",
                "Observer runtime returned an invalid reservation-free stop preflight"
              );
            }
            return { kind: "acquired" as const, value: null };
          }
          if (preflight.ready && preflight.reserved) {
            const reservationId = this.requireReservationId(preflight);
            if (reservationId !== proposedReservationId) {
              throw new OwnedRuntimeError(
                "SESSION_UNVERIFIABLE",
                "Observer runtime stop lease did not echo the caller-proposed generation"
              );
            }
            const persist = async () => this.persistStopReservationLocked(
              receipt,
              keyHash,
              reservationId,
              exactRuntimeVacant
            );
            const reservation = wallDeadline
              ? await this.withFencedMachineMutex(persist, wallDeadline)
              : await this.withFencedMachineMutex(persist);
            return { kind: "acquired" as const, value: reservation };
          }
          if (!exactRuntimeVacant) {
            const current = await this.inspectReceipt(receipt, wallDeadline);
            if (current.state === "identity_mismatch" || current.state === "unverifiable") {
              throw new OwnedRuntimeError(
                "IDENTITY_UNVERIFIABLE",
                `Owned runtime changed while restoration was pending: ${current.state}`,
                { reason: current.reason }
              );
            }
            if (current.state === "exited") {
              exactRuntimeVacant = true;
              return { kind: "retry" as const, pending: preflight, delayMs: 1 };
            }
          }
          const wallRemaining = wallDeadline
            ? this.remainingWallBudget(wallDeadline)
            : Number.MAX_SAFE_INTEGER;
          return {
            kind: "retry" as const,
            pending: preflight,
            delayMs: Math.min(
              PROCESS_POLL_MS,
              Math.max(1, remainingMs),
              wallRemaining
            ),
          };
        },
        onDeadline: (preflight) => new OwnedRuntimeError(
          "CAMERA_BUSY",
          "Observer runtime still has active capture or camera-restoration work",
          {
            activeJobIds: preflight?.activeJobIds ?? [],
            cameraLeaseJobIds: preflight?.cameraLeaseJobIds ?? [],
            restorationPendingJobIds: preflight?.restorationPendingJobIds ?? [],
          }
        ),
      });
    } catch (error) {
      if (error instanceof ReservationCancelledError) {
        throw new OwnedRuntimeError(error.reason.code, error.reason.message);
      }
      throw error;
    }
  }

  private persistStopReservationLocked(
    receipt: OwnedRuntimeReceipt,
    keyHash: string,
    reservationId: string,
    exactRuntimeVacant: boolean
  ): StopReservation {
    const root = this.ensureStorage();
    const current = this.readRuntimeReceipt(receipt.runtimeId);
    this.assertSameRuntimeLifecycle(receipt, current);
    const existing = this.readValidatedRestorationProofLocked(receipt);
    if (existing) {
      if (existing.reservationId !== reservationId ||
          (existing.kind === "live_stop_reservation" && existing.stopIdempotencyHash !== keyHash)) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Observer and durable restoration reservation identities do not match"
        );
      }
      return { proof: existing };
    }
    const proof = restorationProofSchema.parse({
      version: STORAGE_VERSION,
      runtimeId: receipt.runtimeId,
      sessionId: receipt.sessionId,
      managerInstanceId: receipt.mcpOwner.managerInstanceId,
      sealedAt: nowIso(this.clock),
      kind: exactRuntimeVacant ? "exact_runtime_vacancy" : "live_stop_reservation",
      reservationId,
      stopIdempotencyHash: keyHash,
      activeJobIds: [],
      cameraLeaseJobIds: [],
      restorationPendingJobIds: [],
    });
    this.atomicWrite(root, this.restorationProofPath(receipt.runtimeId), proof, true);
    return { proof };
  }

  private requireReservationId(preflight: RuntimeStopPreflight): string {
    const parsed = z.string().uuid().safeParse(preflight.reservationId);
    if (!parsed.success) {
      throw new OwnedRuntimeError(
        "SESSION_UNVERIFIABLE",
        "Observer runtime stop reservation did not return a bounded generation token"
      );
    }
    return parsed.data;
  }

  private readValidatedRestorationProofLocked(receipt: OwnedRuntimeReceipt): RestorationProof | null {
    const current = this.readRuntimeReceipt(receipt.runtimeId);
    this.assertSameRuntimeLifecycle(receipt, current);
    const proof = this.readOptionalRestorationProof(receipt.runtimeId);
    if (proof && (proof.sessionId !== receipt.sessionId ||
        proof.managerInstanceId !== receipt.mcpOwner.managerInstanceId)) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Runtime restoration proof is bound to a different lifecycle"
      );
    }
    return proof;
  }

  private assertSameRuntimeLifecycle(
    expected: OwnedRuntimeReceipt,
    current: OwnedRuntimeReceipt
  ): void {
    if (current.sessionId !== expected.sessionId ||
        current.preparedLaunchId !== expected.preparedLaunchId ||
        current.pid !== expected.pid ||
        pathKey(current.executablePath) !== pathKey(expected.executablePath) ||
        current.creationTimeFileTime !== expected.creationTimeFileTime ||
        current.ownerTokenArgument !== expected.ownerTokenArgument ||
        current.launchedAtMs !== expected.launchedAtMs) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Runtime lifecycle changed before restoration reservation publication"
      );
    }
  }

  private assertCurrentStopReservation(
    receipt: OwnedRuntimeReceipt,
    expected: RestorationProof
  ): void {
    const current = this.readOptionalRestorationProof(receipt.runtimeId);
    if (!current || current.sessionId !== receipt.sessionId ||
        current.managerInstanceId !== receipt.mcpOwner.managerInstanceId ||
        current.kind !== expected.kind || current.sealedAt !== expected.sealedAt ||
        current.reservationId !== expected.reservationId ||
        current.stopIdempotencyHash !== expected.stopIdempotencyHash) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Runtime restoration proof changed before exact termination; retry recovery is required"
      );
    }
  }

  private async inspectSpawned(
    child: ChildProcess,
    executablePath: string,
    ownerTokenArgument: string
  ): Promise<OwnedRuntimeExactIdentity> {
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0) {
      throw new OwnedRuntimeError("SPAWN_FAILED", "Graphical runtime spawn returned no exact child PID");
    }
    const deadline = this.clock() + this.inspectionTimeoutMs;
    let lastError: unknown;
    while (this.clock() < deadline) {
      try {
        const inspection = await this.backend.inspectProcess(child.pid!, ownerTokenArgument);
        if (inspection) {
          if (inspection.identity.pid !== child.pid ||
              pathKey(inspection.identity.executablePath) !== pathKey(executablePath)) {
            throw new OwnedRuntimeError("IDENTITY_MISMATCH", "Spawned child executable identity does not match the trusted runtime");
          }
          if (inspection.ownerArgumentMatched === true) return inspection.identity;
        }
      } catch (error) {
        lastError = error;
      }
      await this.sleeper.sleep(PROCESS_POLL_MS);
    }
    throw new OwnedRuntimeError(
      "IDENTITY_UNVERIFIABLE",
      `Spawned runtime could not be verified by PID, executable path, creation time, and exact owner argument${lastError ? `: ${this.message(lastError)}` : ""}`
    );
  }

  private awaitSpawn(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new OwnedRuntimeError("SPAWN_FAILED", "Graphical runtime exited before spawn verification"));
    }
    return new Promise((resolvePromise, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError);
        resolvePromise();
      };
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        reject(new OwnedRuntimeError("SPAWN_FAILED", `Graphical runtime spawn failed: ${error.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private async terminateRetainedChild(child: ChildProcess): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let exitObserved = false;
    const exited = new Promise<void>((resolvePromise) => child.once("exit", () => {
      exitObserved = true;
      resolvePromise();
    }));
    // No PID lookup occurs here: failure cleanup signals only the exact
    // ChildProcess returned by the direct structured spawn.
    const signalled = child.kill();
    if (!signalled && child.exitCode === null && child.signalCode === null) return false;
    await Promise.race([exited, this.sleeper.sleep(5_000)]);
    return exitObserved || child.exitCode !== null || child.signalCode !== null;
  }

  private inspectionMatches(receipt: OwnedRuntimeReceipt, inspection: OwnedRuntimeInspection): boolean {
    return inspection.identity.pid === receipt.pid &&
      pathKey(inspection.identity.executablePath) === pathKey(receipt.executablePath) &&
      inspection.identity.creationTime === receipt.creationTimeFileTime &&
      inspection.ownerArgumentMatched === true;
  }

  private async inspectRecoveryAuthority(
    receipt: OwnedRuntimeReceipt,
    wallDeadline?: OwnedRuntimeWallDeadline
  ): Promise<string | null> {
    let currentOwner: z.infer<typeof mcpOwnerSchema>;
    try {
      currentOwner = await this.currentMcpOwner(wallDeadline);
    } catch (error) {
      if (this.isWallDeadlineError(error)) throw error;
      return `MCP owner identity is unavailable: ${this.message(error)}`;
    }
    if (currentOwner.installationId !== receipt.mcpOwner.installationId ||
        currentOwner.userSid !== receipt.mcpOwner.userSid) {
      return "Lifecycle receipt belongs to a different MCP installation or Windows owner";
    }
    if (currentOwner.managerInstanceId === receipt.mcpOwner.managerInstanceId) return null;

    let priorOwner: OwnedRuntimeInspection | null;
    try {
      priorOwner = wallDeadline
        ? await this.beforeWallDeadline(wallDeadline, () =>
          this.backend.inspectProcess(receipt.mcpOwner.pid))
        : await this.backend.inspectProcess(receipt.mcpOwner.pid);
    } catch (error) {
      if (this.isWallDeadlineError(error)) throw error;
      return `Prior MCP owner identity is unavailable: ${this.message(error)}`;
    }
    if (priorOwner && priorOwner.identity.pid === receipt.mcpOwner.pid &&
        pathKey(priorOwner.identity.executablePath) === pathKey(receipt.mcpOwner.executablePath) &&
        priorOwner.identity.creationTime === receipt.mcpOwner.creationTimeFileTime) {
      return "Prior exact MCP owner is still live; this process is not a restart recovery";
    }
    return null;
  }

  private assertInspectionMatches(receipt: OwnedRuntimeReceipt, inspection: OwnedRuntimeInspection): void {
    if (!this.inspectionMatches(receipt, inspection)) {
      throw new OwnedRuntimeError(
        "IDENTITY_MISMATCH",
        "Runtime PID no longer matches its exact executable, creation time, and owner-token identity"
      );
    }
  }

  private assertExecutableFileMatches(receipt: OwnedRuntimeReceipt): void {
    const executable = canonicalFile(
      this.resolveExecutable(receipt.runtimeKind),
      `Configured ${receipt.runtimeKind} runtime executable`
    );
    if (pathKey(executable) !== pathKey(receipt.executablePath)) {
      throw new OwnedRuntimeError("IDENTITY_MISMATCH", "Configured executable path drifted from the ownership receipt");
    }
    const current = inspectExecutableFile(executable);
    if (!executableFilesMatch(current, receipt.executableFile)) {
      throw new OwnedRuntimeError("IDENTITY_MISMATCH", "Configured executable file was replaced after the owned start");
    }
  }

  private async currentMcpOwner(
    wallDeadline?: OwnedRuntimeWallDeadline
  ): Promise<z.infer<typeof mcpOwnerSchema>> {
    const identity = wallDeadline
      ? await this.beforeWallDeadline(wallDeadline, () =>
        this.backend.inspectCurrentProcess(process.pid))
      : await this.backend.inspectCurrentProcess(process.pid);
    return mcpOwnerSchema.parse({
      installationId: this.installationId,
      managerInstanceId: this.managerInstanceId,
      pid: identity.pid,
      executablePath: identity.executablePath,
      creationTimeFileTime: identity.creationTime,
      userSid: identity.userSid,
    });
  }

  private publicStatus(
    receipt: OwnedRuntimeReceipt,
    state: OwnedRuntimeState,
    exactOwned: boolean,
    reason?: string
  ): OwnedRuntimePublicStatus {
    const descriptor = this.readPreparedDescriptor(receipt.preparedLaunchId);
    let gameLaunchFields: Pick<OwnedRuntimePublicStatus, "compositeAttemptId" | "chain"> = {};
    if (descriptor.gameLaunchAttempt) {
      const chain = this.readOptionalGameLaunchChain(pathKey(descriptor.profilePath));
      if (!chain) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Game-launch runtime has no profile attempt ledger",
        );
      }
      gameLaunchFields = {
        compositeAttemptId: descriptor.gameLaunchAttempt.compositeAttemptId,
        ...(chain.current.compositeAttemptId === descriptor.gameLaunchAttempt.compositeAttemptId
          ? { chain: this.publicGameLaunchChain(chain) }
          : {}),
      };
    }
    return {
      runtimeId: receipt.runtimeId,
      sessionId: receipt.sessionId,
      preparedLaunchId: receipt.preparedLaunchId,
      state,
      pid: receipt.pid,
      runtimeKind: receipt.runtimeKind,
      startedAt: receipt.startedAt,
      exactOwned,
      ...(reason ? { reason } : {}),
      ...gameLaunchFields,
    };
  }

  private publicStoppedStatus(receipt: OwnedRuntimeReceipt, stopped: StopReceipt): OwnedRuntimePublicStatus {
    return {
      ...this.publicStatus(receipt, "exited", true),
      stoppedAt: stopped.stoppedAt,
      termination: stopped.termination,
      identityVacant: true,
      terminationComplete: true,
      observerCleanupPending: false,
    };
  }

  private publicCleanupPendingStatus(
    receipt: OwnedRuntimeReceipt,
    stopped: StopReceipt
  ): OwnedRuntimePublicStatus {
    return {
      ...this.publicStatus(
        receipt,
        "stopping",
        true,
        "Exact runtime termination is complete; observer session cleanup is pending"
      ),
      stoppedAt: stopped.stoppedAt,
      termination: stopped.termination,
      identityVacant: true,
      terminationComplete: true,
      observerCleanupPending: true,
    };
  }

  private assertTerminationPublicationCapacity(
    root: string,
    receipt: OwnedRuntimeReceipt,
    keyHash: string,
    actor: z.infer<typeof mcpOwnerSchema>,
    proof: RestorationProof
  ): void {
    const stopped = stopReceiptSchema.parse({
      version: STORAGE_VERSION,
      runtimeId: receipt.runtimeId,
      sessionId: receipt.sessionId,
      stoppedAt: nowIso(this.clock),
      termination: "terminated",
      identityVacant: true,
      vacancyProof: "retained_handle_exit",
      stopIdempotencyHash: keyHash,
      restorationProofKind: proof.kind,
      restorationProvedAt: proof.sealedAt,
      ...(proof.reservationId ? { restorationReservationId: proof.reservationId } : {}),
      mcpActor: actor,
    });
    const completion = this.stopCompletionCandidate(receipt, false);
    this.assertBatchCapacity(root, [
      { target: this.stopPath(receipt.runtimeId), value: stopped, exclusive: true },
      { target: this.stopCompletionPath(receipt.runtimeId), value: completion, exclusive: true },
    ]);
  }

  private stopCompletionCandidate(
    receipt: OwnedRuntimeReceipt,
    sessionRevoked: boolean
  ): StopCompletion {
    return stopCompletionSchema.parse({
      version: STORAGE_VERSION,
      runtimeId: receipt.runtimeId,
      sessionId: receipt.sessionId,
      preparedLaunchId: receipt.preparedLaunchId,
      completedAt: nowIso(this.clock),
      observerCompleted: true,
      sessionRevoked,
    });
  }

  private publishStop(
    root: string,
    receipt: OwnedRuntimeReceipt,
    keyHash: string,
    actor: z.infer<typeof mcpOwnerSchema>,
    termination: "terminated" | "already_exited",
    vacancyProof: StopReceipt["vacancyProof"],
    restorationProofKind: StopReceipt["restorationProofKind"],
    restorationProvedAt: string,
    restorationReservationId?: string
  ): StopReceipt {
    const stopped = stopReceiptSchema.parse({
      version: STORAGE_VERSION,
      runtimeId: receipt.runtimeId,
      sessionId: receipt.sessionId,
      stoppedAt: nowIso(this.clock),
      termination,
      identityVacant: true,
      vacancyProof,
      stopIdempotencyHash: keyHash,
      restorationProofKind,
      restorationProvedAt,
      ...(restorationReservationId ? { restorationReservationId } : {}),
      mcpActor: actor,
    });
    this.atomicWrite(root, this.stopPath(receipt.runtimeId), stopped, true);
    return stopped;
  }

  private preflightStopCompletionLocked(
    root: string,
    receipt: OwnedRuntimeReceipt,
    idempotencyPath: string,
    keyHash: string,
    requestFingerprint: string,
    fallbackReservationId?: string
  ): StopLockedResult {
    const existing = this.readOptionalStopCompletion(receipt.runtimeId);
    if (existing) {
      if (existing.sessionId !== receipt.sessionId ||
          existing.preparedLaunchId !== receipt.preparedLaunchId) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop completion session does not match its runtime receipt");
      }
      const stopped = this.readOptionalStopReceipt(receipt.runtimeId);
      if (!stopped || stopped.sessionId !== receipt.sessionId) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Durable stop completion has no matching exact vacancy receipt"
        );
      }
      try {
        this.succeedStopIdempotency(
          root,
          idempotencyPath,
          keyHash,
          requestFingerprint,
          receipt.runtimeId
        );
      } catch {
        // The immutable stop and completion receipts remain authoritative.
      }
      this.reconcileGameLaunchChainForRuntimeLocked(receipt);
      return { kind: "complete", status: this.publicStoppedStatus(receipt, stopped) };
    }
    const stopped = this.readOptionalStopReceipt(receipt.runtimeId);
    if (!stopped || stopped.sessionId !== receipt.sessionId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Observer cleanup cannot precede the exact runtime stop receipt"
      );
    }
    const proof = this.readValidatedRestorationProofLocked(receipt);
    const reservationIds = [
      stopped.restorationReservationId,
      proof?.reservationId,
      fallbackReservationId,
    ].filter((value): value is string => value !== undefined);
    if (new Set(reservationIds).size > 1) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Stop completion authorities have different lease generations"
      );
    }
    this.assertBatchCapacity(root, [{
      target: this.stopCompletionPath(receipt.runtimeId),
      value: this.stopCompletionCandidate(receipt, false),
      exclusive: true,
    }]);
    const authorityFingerprint = this.stopCompletionAuthorityFingerprint(receipt, stopped, proof);
    return {
      kind: "observer_completion_required",
      authority: {
        receipt,
        stopped,
        restorationProof: proof,
        authorityFingerprint,
        ...(reservationIds[0] ? { reservationId: reservationIds[0] } : {}),
        idempotencyPath,
        keyHash,
        requestFingerprint,
      },
    };
  }

  private async requestStopCompletionUnlocked(
    authority: StopCompletionAuthority,
    wallDeadline: OwnedRuntimeWallDeadline
  ): Promise<StopCompletionAck> {
    let response: unknown;
    try {
      response = await this.beforeWallDeadline(wallDeadline, () =>
        this.options.observerGate.completeRuntimeStop(
          authority.receipt.sessionId,
          authority.reservationId,
          authority.stopped.identityVacant,
          {
            runtimeId: authority.receipt.runtimeId,
            generation: runtimeLifecycleGeneration(authority.receipt),
          }
        ));
    } catch (error) {
      if (this.isWallDeadlineError(error)) throw error;
      throw new OwnedRuntimeError(
        "SESSION_COMPLETION_FAILED",
        `Exact runtime is vacant, but observer session completion failed: ${this.message(error)}`
      );
    }
    const result = response && typeof response === "object" ? response as Record<string, unknown> : {};
    if (result.completed !== true) {
      throw new OwnedRuntimeError(
        "SESSION_COMPLETION_FAILED",
        "Exact runtime is vacant, but observer session completion was not acknowledged"
      );
    }
    return { sessionRevoked: result.revoked === true };
  }

  private commitStopCompletionLocked(
    authority: StopCompletionAuthority,
    ack: StopCompletionAck
  ): OwnedRuntimePublicStatus {
    const root = this.ensureStorage();
    const receipt = this.readRuntimeReceipt(authority.receipt.runtimeId);
    this.assertSameRuntimeLifecycle(authority.receipt, receipt);
    const stopped = this.readOptionalStopReceipt(receipt.runtimeId);
    if (!stopped || stopped.sessionId !== receipt.sessionId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Exact vacancy receipt changed before observer completion publication"
      );
    }
    const existing = this.readOptionalStopCompletion(receipt.runtimeId);
    if (existing) {
      if (existing.sessionId !== receipt.sessionId ||
          existing.preparedLaunchId !== receipt.preparedLaunchId) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Raced stop completion belongs to another runtime lifecycle"
        );
      }
      this.reconcileGameLaunchChainForRuntimeLocked(receipt);
      return this.publicStoppedStatus(receipt, stopped);
    }
    const proof = this.readValidatedRestorationProofLocked(receipt);
    if (this.stopCompletionAuthorityFingerprint(receipt, stopped, proof) !==
        authority.authorityFingerprint) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Stop completion authority changed while observer cleanup was pending"
      );
    }
    const completion = this.stopCompletionCandidate(receipt, ack.sessionRevoked);
    this.assertBatchCapacity(root, [{
      target: this.stopCompletionPath(receipt.runtimeId),
      value: completion,
      exclusive: true,
    }]);
    try {
      this.atomicWrite(root, this.stopCompletionPath(receipt.runtimeId), completion, true, true);
    } catch (error) {
      const raced = this.readOptionalStopCompletion(receipt.runtimeId);
      if (!raced) throw error;
      if (raced.sessionId !== receipt.sessionId ||
          raced.preparedLaunchId !== receipt.preparedLaunchId) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Raced stop completion belongs to another runtime lifecycle"
        );
      }
    }
    try {
      this.succeedStopIdempotency(
        root,
        authority.idempotencyPath,
        authority.keyHash,
        authority.requestFingerprint,
        receipt.runtimeId
      );
    } catch {
      // Stop and completion receipts remain the durable idempotent authority.
    }
    this.reconcileGameLaunchChainForRuntimeLocked(receipt);
    return this.publicStoppedStatus(receipt, stopped);
  }

  private stopCompletionAuthorityFingerprint(
    receipt: OwnedRuntimeReceipt,
    stopped: StopReceipt,
    proof: RestorationProof | null
  ): string {
    return sha256(JSON.stringify({ receipt, stopped, proof }));
  }

  private succeedStopIdempotency(
    root: string,
    path: string,
    keyHash: string,
    requestFingerprint: string,
    runtimeId: string
  ): void {
    this.atomicWrite(root, path, idempotencySchema.parse({
      version: STORAGE_VERSION,
      action: "stop",
      keyHash,
      requestFingerprint,
      runtimeId,
      state: "succeeded",
      updatedAt: nowIso(this.clock),
    }), false);
  }

  private async discardUncommittedStopAttempt(
    runtimeId: string,
    keyHash: string,
    requestFingerprint: string,
    wallDeadline: OwnedRuntimeWallDeadline
  ): Promise<void> {
    await this.withFencedMachineMutex(async (fence) => {
        const attemptPath = this.idempotencyPath("stop", keyHash);
        const attempt = this.readOptionalParsed(
          attemptPath,
          idempotencySchema,
          "stop idempotency receipt"
        );
        if (!attempt || attempt.action !== "stop" || attempt.runtimeId !== runtimeId ||
            attempt.keyHash !== keyHash || attempt.requestFingerprint !== requestFingerprint ||
            attempt.state !== "starting") return;
        const stopped = this.readOptionalStopReceipt(runtimeId);
        if (stopped?.stopIdempotencyHash === keyHash) return;
        const proof = this.readOptionalRestorationProof(runtimeId);
        if (proof?.stopIdempotencyHash === keyHash) return;
        fence.assertActive();
        this.unlinkOwnedFile(attemptPath);
      }, wallDeadline);
  }

  private gameLaunchRetentionProtection(): {
    preparedLaunchIds: Set<string>;
    runtimeIds: Set<string>;
    protectAllGameLaunchEvidence: boolean;
  } {
    const preparedLaunchIds = new Set<string>();
    const runtimeIds = new Set<string>();
    let protectAllGameLaunchEvidence = false;
    for (const name of this.recordFileNames("game-launch-chains")) {
      const profileKeyDigest = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!sha256Schema.safeParse(profileKeyDigest).success) {
        protectAllGameLaunchEvidence = true;
        continue;
      }
      try {
        const chain = this.readParsed(
          this.gameLaunchChainPath(profileKeyDigest),
          gameLaunchChainSchema,
          "game-launch retention chain",
        );
        if (chain.profileKeyDigest !== profileKeyDigest) throw new Error("chain binding");
        this.assertGameLaunchChain(chain);
        if (chain.current.preparedLaunchId) preparedLaunchIds.add(chain.current.preparedLaunchId);
        if (chain.current.runtimeId) runtimeIds.add(chain.current.runtimeId);
        // An aborted successor can be replaced only after re-attesting the
        // retained terminal predecessor. Protect that complete runtime cluster
        // until the chain advances or retires.
        if (chain.previous?.runtimeId) runtimeIds.add(chain.previous.runtimeId);
      } catch {
        // Unknown/corrupt profile authority pins every composite lifecycle; a
        // retention pass must never turn lost evidence into launch permission.
        protectAllGameLaunchEvidence = true;
      }
    }
    return { preparedLaunchIds, runtimeIds, protectAllGameLaunchEvidence };
  }

  private sweepLocked(now: number): OwnedRuntimeSweepResult {
    if (!Number.isFinite(now)) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "Owned runtime retention time is invalid");
    }
    const removedPreparedLaunchIds = new Set<string>();
    const removedRuntimeIds: string[] = [];
    const gameLaunchProtection = this.gameLaunchRetentionProtection();
    // LMDB has no unpublished temporary files: each record write is its own
    // synchronous commit, so there is nothing to sweep. The field is retained
    // for result-shape stability and is always zero.
    const removedTemporaryFiles = 0;

    // A completed stop is the sole terminal authority for a runtime cluster.
    // Natural exit, stale sessions, cleanup-pending stops, and failed starts
    // with unverified cleanup remain durable recovery obligations.
    for (const name of this.recordFileNames("stop-completions")) {
      const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!runtimeIdSchema.safeParse(runtimeId).success) continue;
      if (gameLaunchProtection.runtimeIds.has(runtimeId)) continue;
      try {
        const completion = this.readOptionalStopCompletion(runtimeId);
        if (!completion || now - Date.parse(completion.completedAt) < this.receiptRetentionMs) continue;
        if (this.hasRecord(this.runtimePath(runtimeId))) {
          const receipt = this.readRuntimeReceipt(runtimeId);
          if (gameLaunchProtection.protectAllGameLaunchEvidence &&
              this.readPreparedDescriptor(receipt.preparedLaunchId).gameLaunchEvidence) continue;
          if (completion.sessionId !== receipt.sessionId ||
              completion.preparedLaunchId !== receipt.preparedLaunchId) continue;
        }
        if (this.hasRecord(this.stopPath(runtimeId))) {
          const stopped = this.readOptionalStopReceipt(runtimeId);
          if (!stopped || stopped.sessionId !== completion.sessionId) continue;
        }
        this.removeRuntimeCluster(completion);
        removedPreparedLaunchIds.add(completion.preparedLaunchId);
        removedRuntimeIds.push(runtimeId);
      } catch {
        // One malformed lifecycle is retained for review and cannot block the
        // sweep of independent runtimes.
      }
    }

    // A failed start becomes retention-eligible only after exact child vacancy
    // and observer lifecycle release are separate durable commits. Legacy
    // cleanup_verified records without a generation never acquired a lease;
    // an exact-generation legacy record is migrated/retried, never swept.
    for (const name of this.recordFileNames("pending-starts")) {
      const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!runtimeIdSchema.safeParse(runtimeId).success || this.hasRecord(this.runtimePath(runtimeId))) continue;
      if (gameLaunchProtection.runtimeIds.has(runtimeId)) continue;
      try {
        const pending = this.readOptionalPendingStart(runtimeId);
        if (pending && (gameLaunchProtection.preparedLaunchIds.has(pending.preparedLaunchId) ||
            (gameLaunchProtection.protectAllGameLaunchEvidence &&
              this.readPreparedDescriptor(pending.preparedLaunchId).gameLaunchEvidence))) continue;
        const releaseComplete = pending?.state === "release_acknowledged" ||
          (pending?.state === "cleanup_verified" && !pending.lifecycleGeneration);
        if (!pending || !releaseComplete ||
            now - Date.parse(pending.updatedAt) < this.receiptRetentionMs) continue;
        const consumption = this.readOptionalConsumption(pending.preparedLaunchId);
        if (consumption && consumption.runtimeId !== runtimeId) continue;
        this.removeFailedStartCluster(pending, runtimeId);
        removedPreparedLaunchIds.add(pending.preparedLaunchId);
        removedRuntimeIds.push(runtimeId);
      } catch {
        // Preserve an unverifiable failed-start cluster for explicit recovery.
      }
    }

    // A pre-signal stop attempt owns no durable lifecycle once neither its
    // restoration proof nor its stop receipt exists. Bound crash-left retry
    // keys independently so repeated CAMERA_BUSY/cancel attempts cannot
    // consume the recovery headroom of a live runtime.
    for (const name of this.recordFileNames("idempotency")) {
      const match = /^stop-([a-f0-9]{64})\.json$/.exec(name);
      if (!match) continue;
      try {
        const attemptPath = join(this.directory("idempotency"), name);
        const attempt = this.readParsed(attemptPath, idempotencySchema, "stop idempotency receipt");
        if (attempt.action !== "stop" || attempt.keyHash !== match[1] ||
            attempt.state !== "starting" ||
            now - Date.parse(attempt.updatedAt) < this.receiptRetentionMs) continue;
        const stopped = this.readOptionalStopReceipt(attempt.runtimeId);
        const proof = this.readOptionalRestorationProof(attempt.runtimeId);
        if (stopped?.stopIdempotencyHash === attempt.keyHash ||
            proof?.stopIdempotencyHash === attempt.keyHash) continue;
        this.unlinkOwnedFile(attemptPath);
      } catch {
        // Isolate malformed retry evidence.
      }
    }

    // Expired preparations that were never consumed own no child or recovery
    // state. Each descriptor is isolated so corrupt unrelated evidence never
    // blocks later preparation or retention work.
    const preparedReferences = this.preparedRuntimeReferences();
    for (const name of this.recordFileNames("prepared")) {
      const preparedLaunchId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!preparedLaunchIdSchema.safeParse(preparedLaunchId).success ||
          this.hasRecord(this.consumptionPath(preparedLaunchId)) ||
          preparedReferences.has(preparedLaunchId)) continue;
      try {
        const descriptor = this.readPreparedDescriptor(preparedLaunchId);
        if (gameLaunchProtection.preparedLaunchIds.has(preparedLaunchId) ||
            (gameLaunchProtection.protectAllGameLaunchEvidence && descriptor.gameLaunchEvidence)) continue;
        if (now - Date.parse(descriptor.expiresAt) < this.receiptRetentionMs) continue;
        // A malformed or descriptor-mismatched invalidation is retained with
        // its preparation for explicit recovery rather than silently erased.
        this.readOptionalPreparedInvalidation(preparedLaunchId, descriptor);
        const index = this.readOptionalPreparedSessionIndex(descriptor.sessionId);
        if (index?.preparedLaunchId === preparedLaunchId) {
          this.unlinkOwnedFile(this.preparedSessionIndexPath(descriptor.sessionId));
        }
        this.unlinkOwnedFile(this.preparedInvalidationPath(preparedLaunchId));
        this.unlinkOwnedFile(this.preparedPath(preparedLaunchId));
        removedPreparedLaunchIds.add(preparedLaunchId);
      } catch {
        // Retain malformed evidence without poisoning other session indexes.
      }
    }

    return {
      removedPreparedLaunchIds: [...removedPreparedLaunchIds].sort(),
      removedRuntimeIds: [...new Set(removedRuntimeIds)].sort(),
      removedTemporaryFiles,
    };
  }

  private removeRuntimeCluster(completion: StopCompletion): void {
    const index = this.readOptionalPreparedSessionIndex(completion.sessionId);
    this.removeIdempotencyForRuntime(completion.runtimeId);
    for (const target of [
      this.childExitPath(completion.runtimeId),
      this.restorationProofPath(completion.runtimeId),
      this.stopPath(completion.runtimeId),
      this.pendingStartPath(completion.runtimeId),
      this.runtimePath(completion.runtimeId),
      this.consumptionPath(completion.preparedLaunchId),
      this.preparedInvalidationPath(completion.preparedLaunchId),
    ]) this.unlinkOwnedFile(target);
    if (index?.preparedLaunchId === completion.preparedLaunchId) {
      this.unlinkOwnedFile(this.preparedSessionIndexPath(completion.sessionId));
    }
    this.unlinkOwnedFile(this.preparedPath(completion.preparedLaunchId));
    // The terminal completion is the resumable cleanup trigger and must be
    // removed last so a crash can retry every earlier deletion idempotently.
    this.unlinkOwnedFile(this.stopCompletionPath(completion.runtimeId));
  }

  private removeFailedStartCluster(pending: PendingStart, runtimeId: string): void {
    const index = this.readOptionalPreparedSessionIndex(pending.sessionId);
    this.removeIdempotencyForRuntime(runtimeId);
    for (const target of [
      this.consumptionPath(pending.preparedLaunchId),
      this.preparedInvalidationPath(pending.preparedLaunchId),
    ]) this.unlinkOwnedFile(target);
    if (index?.preparedLaunchId === pending.preparedLaunchId) {
      this.unlinkOwnedFile(this.preparedSessionIndexPath(pending.sessionId));
    }
    this.unlinkOwnedFile(this.preparedPath(pending.preparedLaunchId));
    // Keep the release-acknowledged pending receipt until every dependent record
    // has been removed so an interrupted sweep remains resumable.
    this.unlinkOwnedFile(this.pendingStartPath(runtimeId));
  }

  private preparedRuntimeReferences(): Set<string> {
    const ids = new Set<string>();
    for (const name of this.recordFileNames("runtimes")) {
      const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!runtimeIdSchema.safeParse(runtimeId).success) continue;
      try {
        const value = this.readParsed(
          this.runtimePath(runtimeId),
          runtimeReceiptSchema,
          "runtime prepared-launch reference"
        );
        if (value.runtimeId === runtimeId) ids.add(value.preparedLaunchId);
      } catch {
        // The consumed/<preparedLaunchId>.json filename is the scoped reverse
        // authority for a corrupt lifecycle. Do not let one unreadable
        // forward receipt pin every unrelated preparation in the store.
      }
    }
    for (const name of this.recordFileNames("pending-starts")) {
      const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!runtimeIdSchema.safeParse(runtimeId).success) continue;
      try {
        const value = this.readParsed(
          this.pendingStartPath(runtimeId),
          pendingStartSchema,
          "pending start prepared-launch reference"
        );
        if (value.runtimeId === runtimeId) ids.add(value.preparedLaunchId);
      } catch {
        // See the scoped consumption authority above. Readable forward links
        // remain a recovery fallback if that marker was independently lost.
      }
    }
    return ids;
  }

  private removeIdempotencyForRuntime(runtimeId: string): void {
    for (const name of this.recordFileNames("idempotency")) {
      if (!name.endsWith(".json")) continue;
      const candidate = join(this.directory("idempotency"), name);
      let receipt: z.infer<typeof idempotencySchema>;
      try {
        receipt = this.readParsed(candidate, idempotencySchema, "idempotency receipt");
      } catch {
        // Preserve a malformed receipt as bounded forensic evidence.
        continue;
      }
      // Deletion failures must propagate so the terminal cleanup trigger is
      // retained and a later sweep can resume the cluster transaction.
      if (receipt.runtimeId === runtimeId) this.unlinkOwnedFile(candidate);
    }
  }

  private storageStats(root: string): OwnedRuntimeStorageStats {
    const usage = this.storeUsage(root);
    const mutationReserve = this.mutationReserve(usage.byPath, []);
    const prepared = this.recordFileNames("prepared")
      .filter((name) => preparedLaunchIdSchema.safeParse(name.endsWith(".json") ? name.slice(0, -5) : "").success)
      .length;
    let completedRuntimes = 0;
    let activeOrRecoverableRuntimes = 0;
    for (const name of this.recordFileNames("runtimes")) {
      const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!runtimeIdSchema.safeParse(runtimeId).success) continue;
      if (this.hasRecord(this.stopCompletionPath(runtimeId))) completedRuntimes += 1;
      else activeOrRecoverableRuntimes += 1;
    }
    for (const name of this.recordFileNames("pending-starts")) {
      const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (runtimeIdSchema.safeParse(runtimeId).success && !this.hasRecord(this.runtimePath(runtimeId))) {
        activeOrRecoverableRuntimes += 1;
      }
    }
    return {
      records: usage.records,
      bytes: usage.bytes,
      maxRecords: this.maxStoreRecords,
      maxBytes: this.maxStoreBytes,
      maxRecordBytes: this.maxRecordBytes,
      receiptRetentionMs: this.receiptRetentionMs,
      prepared,
      activeOrRecoverableRuntimes,
      completedRuntimes,
      reservedMutationRecords: mutationReserve.records,
      reservedMutationBytes: mutationReserve.bytes,
    };
  }

  private storeUsage(root: string): { records: number; bytes: number; byPath: Map<string, number> } {
    const byPath = new Map<string, number>();
    // `root` is the canonical storage root returned by ensureStorage; it must
    // still be identical to the manager's storage root before any accounting.
    if (!isContained(this.storageRoot, root)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Owned-runtime storage root escaped its managed root");
    }
    if (!existsSync(this.storageRoot)) return { records: 0, bytes: 0, byPath };
    const usage = this.recordStore().usage(OWNED_RUNTIME_RECORD_DIRECTORIES);
    for (const entry of usage.byId.values()) {
      // Re-key each record's stored byte count by its virtual path so
      // mutationReserve/assertBatchCapacity stay byte-for-byte unchanged. The
      // stored byte length equals the pre-migration serialized file size.
      const virtualPath = join(this.directory(entry.family as OwnedRuntimeRecordDirectory), `${entry.id}.json`);
      byPath.set(pathKey(virtualPath), entry.bytes);
    }
    return { records: usage.records, bytes: usage.bytes, byPath };
  }

  private mutationReserve(
    projectedPaths: ReadonlyMap<string, number>,
    writes: ReadonlyArray<{ target: string; value: unknown }>
  ): { records: number; bytes: number } {
    const writesByPath = new Map(writes.map((write) => [pathKey(write.target), write.value]));
    const validRecord = (
      target: string,
      schema: z.ZodTypeAny,
      binds: (value: Record<string, unknown>) => boolean
    ): boolean => {
      const key = pathKey(target);
      if (writesByPath.has(key)) {
        const parsed = schema.safeParse(writesByPath.get(key));
        return parsed.success && binds(parsed.data as Record<string, unknown>);
      }
      if (!projectedPaths.has(key)) return false;
      try {
        const value = this.readParsed(
          target,
          schema,
          "mutation-reserve lifecycle receipt"
        ) as Record<string, unknown>;
        return binds(value);
      } catch {
        return false;
      }
    };
    const runtimeIds = new Set<string>();
    for (const name of this.recordFileNames("runtimes")) {
      const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (runtimeIdSchema.safeParse(runtimeId).success &&
          projectedPaths.has(pathKey(this.runtimePath(runtimeId)))) runtimeIds.add(runtimeId);
    }
    for (const write of writes) {
      if (pathKey(dirname(write.target)) !== pathKey(this.directory("runtimes"))) continue;
      const runtimeId = write.target.endsWith(".json")
        ? write.target.slice(write.target.lastIndexOf(sep) + 1, -5)
        : "";
      if (runtimeIdSchema.safeParse(runtimeId).success) runtimeIds.add(runtimeId);
    }

    const stopAttemptRuntimeIds = new Set<string>();
    for (const name of this.recordFileNames("idempotency")) {
      const match = /^stop-([a-f0-9]{64})\.json$/.exec(name);
      if (!match) continue;
      try {
        const attempt = this.readParsed(
          join(this.directory("idempotency"), name),
          idempotencySchema,
          "stop idempotency reserve"
        );
        if (attempt.action === "stop" && attempt.keyHash === match[1]) {
          stopAttemptRuntimeIds.add(attempt.runtimeId);
        }
      } catch {
        // Corrupt receipts consume actual capacity but never satisfy reserve.
      }
    }
    for (const write of writes) {
      const attempt = idempotencySchema.safeParse(write.value);
      if (attempt.success && attempt.data.action === "stop") {
        stopAttemptRuntimeIds.add(attempt.data.runtimeId);
      }
    }

    let records = 0;
    let bytes = 0;
    const reserve = (maximumBytes: number): void => {
      records += 1;
      bytes += Math.min(this.maxRecordBytes, maximumBytes);
    };
    for (const runtimeId of runtimeIds) {
      const bindsRuntime = (value: Record<string, unknown>): boolean => value.runtimeId === runtimeId;
      if (validRecord(this.stopCompletionPath(runtimeId), stopCompletionSchema, bindsRuntime)) continue;
      const stopped = validRecord(this.stopPath(runtimeId), stopReceiptSchema, bindsRuntime);
      if (stopped) {
        reserve(SMALL_LIFECYCLE_RESERVE_BYTES);
        continue;
      }
      if (!validRecord(this.childExitPath(runtimeId), childExitReceiptSchema, bindsRuntime)) {
        reserve(CHILD_EXIT_RESERVE_BYTES);
      }
      if (!stopAttemptRuntimeIds.has(runtimeId)) reserve(SMALL_LIFECYCLE_RESERVE_BYTES);
      if (!validRecord(this.restorationProofPath(runtimeId), restorationProofSchema, bindsRuntime)) {
        reserve(SMALL_LIFECYCLE_RESERVE_BYTES);
      }
      reserve(CHILD_EXIT_RESERVE_BYTES); // exact stop receipt includes MCP identity paths
      reserve(SMALL_LIFECYCLE_RESERVE_BYTES); // observer completion receipt
    }
    return { records, bytes };
  }

  private assertStartLifecycleHeadroom(root: string, reservesPreparedInvalidation: boolean): void {
    if (this.maxRecordBytes < CHILD_EXIT_RESERVE_BYTES) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Owned-runtime record budget cannot preserve worst-case exact identity evidence"
      );
    }
    const usage = this.storeUsage(root);
    const existingReserve = this.mutationReserve(usage.byPath, []);
    const reserveRecords = reservesPreparedInvalidation
      ? GAME_LAUNCH_START_LIFECYCLE_RESERVE_RECORDS
      : START_LIFECYCLE_RESERVE_RECORDS;
    const nextRecords = usage.records + existingReserve.records + reserveRecords;
    const nextBytes = usage.bytes + existingReserve.bytes +
      Math.min(this.maxStoreBytes, START_LIFECYCLE_RESERVE_BYTES);
    if (nextRecords > this.maxStoreRecords || nextBytes > this.maxStoreBytes) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Owned-runtime store cannot reserve a complete start/stop recovery lifecycle"
      );
    }
  }

  private assertInitialGamePreparationHeadroom(
    root: string,
    input: ObserverLaunchInput,
    evidence: OwnedGameLaunchPreparationEvidence,
  ): void {
    const evidenceBytes = Buffer.byteLength(this.serializeRecord(evidence), "utf8");
    const descriptorMaximum = MAX_REALISTIC_PREPARED_DESCRIPTOR_BYTES + evidenceBytes;
    if (descriptorMaximum > this.maxRecordBytes) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Owned-runtime record budget cannot retain the bounded game-launch preparation evidence",
      );
    }
    // The private child may append only its bounded observer-owned launch
    // vector. Reserve the descriptor, session index, invalidation-capable start
    // lifecycle, and every already-live runtime mutation before initiating IPC.
    const usage = this.storeUsage(root);
    const existingReserve = this.mutationReserve(usage.byPath, []);
    const indexMaximum = SMALL_LIFECYCLE_RESERVE_BYTES;
    const nextRecords = usage.records + existingReserve.records +
      GAME_LAUNCH_START_LIFECYCLE_RESERVE_RECORDS + 2;
    const nextBytes = usage.bytes + existingReserve.bytes +
      Math.min(this.maxStoreBytes, START_LIFECYCLE_RESERVE_BYTES) +
      descriptorMaximum + indexMaximum;
    if (nextRecords > this.maxStoreRecords || nextBytes > this.maxStoreBytes) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Owned-runtime store cannot reserve the initial game-launch preparation and complete recovery lifecycle",
      );
    }
    // Keep this check tied to the exact already-derived vector rather than a
    // retry response that could expand the retained descriptor unexpectedly.
    if (input.arguments.length > PREPARED_ARGUMENT_MAX_COUNT ||
        input.profilePath.length > WINDOWS_PATH_MAX_CHARS) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Initial game-launch preparation exceeds its bounded descriptor shape",
      );
    }
  }

  private assertBatchCapacity(
    root: string,
    writes: ReadonlyArray<{ target: string; value: unknown; exclusive: boolean }>
  ): void {
    const usage = this.storeUsage(root);
    let nextRecords = usage.records;
    let nextBytes = usage.bytes;
    let peakRecords = usage.records;
    let peakBytes = usage.bytes;
    const projected = new Map(usage.byPath);
    for (const write of writes) {
      if (!isContained(root, write.target)) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle write escaped managed storage");
      }
      const serializedBytes = Buffer.byteLength(this.serializeRecord(write.value), "utf8");
      if (serializedBytes > this.maxRecordBytes) {
        throw new OwnedRuntimeError(
          "STORE_CAPACITY_EXCEEDED",
          "Owned-runtime lifecycle record exceeds its byte budget"
        );
      }
      const key = pathKey(write.target);
      const priorBytes = projected.get(key);
      if (write.exclusive && priorBytes !== undefined) {
        throw new OwnedRuntimeError("STORAGE_CONFLICT", "Lifecycle receipt already exists");
      }
      // Exclusive publication has only the temporary file before rename, so
      // its peak equals the final shape. Replacement briefly owns both the
      // old record and a durable fsynced temporary record.
      peakRecords = Math.max(peakRecords, nextRecords + 1);
      peakBytes = Math.max(peakBytes, nextBytes + serializedBytes);
      if (priorBytes === undefined) {
        nextRecords += 1;
        nextBytes += serializedBytes;
      } else {
        nextBytes = nextBytes - priorBytes + serializedBytes;
      }
      projected.set(key, serializedBytes);
    }
    const mutationReserve = this.mutationReserve(projected, writes);
    const reservedRecords = nextRecords + mutationReserve.records;
    const reservedBytes = nextBytes + mutationReserve.bytes;
    const reservedPeakRecords = peakRecords + mutationReserve.records;
    const reservedPeakBytes = peakBytes + mutationReserve.bytes;
    if (reservedPeakRecords > this.maxStoreRecords || reservedPeakBytes > this.maxStoreBytes ||
        reservedRecords > this.maxStoreRecords || reservedBytes > this.maxStoreBytes) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Owned-runtime lifecycle store retention budget is exhausted",
        {
          records: nextRecords,
          maxRecords: this.maxStoreRecords,
          bytes: nextBytes,
          maxBytes: this.maxStoreBytes,
          peakRecords,
          peakBytes,
          reservedPeakRecords,
          reservedPeakBytes,
          reservedMutationRecords: mutationReserve.records,
          reservedMutationBytes: mutationReserve.bytes,
        }
      );
    }
  }

  private serializeRecord(value: unknown): string {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized === undefined) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle record is not serializable");
    }
    return `${serialized}\n`;
  }

  private unlinkOwnedFile(target: string): void {
    // Cleanup targets are always virtual record paths; an absent record is a
    // no-op (parity with the prior existsSync guard). The coordinate mapping is
    // the "must be a managed record" key-validity check.
    if (!existsSync(this.storageRoot)) return;
    const { family, id } = this.recordCoordinates(target);
    this.bumpIdleRevision();
    this.recordStore().remove(family, id);
  }

  private ensureStorage(): string {
    const managedRoot = canonicalDirectory(this.managedRoot, true, true);
    if (pathKey(managedRoot) !== pathKey(this.managedRoot)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Owned-runtime managed root changed identity");
    }
    const stateRoot = canonicalDirectory(join(managedRoot, "state"), true, true);
    if (!isContained(managedRoot, stateRoot)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Owned-runtime state directory escaped its managed root");
    }
    const root = canonicalDirectory(join(stateRoot, "owned-runtimes-v1"), true, true);
    if (pathKey(root) !== pathKey(this.storageRoot)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Owned-runtime storage root changed identity");
    }
    // Open (lazily, once) the single LMDB record-store environment beneath the
    // validated storage root. Records live inside that environment; the ten
    // family directories are no longer created. The prior file-based store was
    // never released publicly, so there is no legacy on-disk state to import.
    this.recordStore();
    return root;
  }

  private directory(name: OwnedRuntimeRecordDirectory): string {
    return join(this.storageRoot, name);
  }

  /** Lazily bind the single synchronous LMDB record store for this manager. */
  private recordStore(): LmdbRecordStore {
    if (!this.recordStoreInstance) {
      this.recordStoreInstance = new LmdbRecordStore({
        storageRoot: this.storageRoot,
        maxRecordBytes: this.maxRecordBytes,
        // A namespace larger than the aggregate record cap cannot arise from
        // admitted writes; bound scans to it so a corrupt/oversized store fails
        // closed instead of materializing the whole namespace.
        maxScanRecords: this.maxStoreRecords,
      });
    }
    return this.recordStoreInstance;
  }

  /** Existing-only inventory accessor; construction and missing-root reads never create storage. */
  private existingSnapshotStore(): LmdbRecordStore {
    return this.recordStoreInstance ?? (this.existingRecordReader ??= new LmdbRecordStore({
      storageRoot: this.storageRoot,
      databaseDirectory: "records-v1",
      maxRecordBytes: this.maxRecordBytes,
      maxScanRecords: this.maxStoreRecords,
    }));
  }

  /** Serialize retained-reader snapshots, reader disposal, and writer activation. */
  private async withExistingSnapshotAccess<T>(action: () => Promise<T> | T): Promise<T> {
    const prior = this.existingSnapshotAccessTail;
    let release!: () => void;
    this.existingSnapshotAccessTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private snapshotExistingOwnedRuntimeRecords() {
    return this.withExistingSnapshotAccess(async () => {
      const store = this.existingSnapshotStore();
      return store.snapshotExisting(OWNED_RUNTIME_RECORD_DIRECTORIES, {
        retainOpen: store === this.existingRecordReader,
      });
    });
  }

  /**
   * Dispose the retained read-only environment and open the writer environment
   * before another readiness probe can recreate the reader. Windows LMDB cannot
   * safely promote two process-local handles for the same mapped environment.
   */
  private async prepareRuntimeHistoryMutationStore(runtimeId: string): Promise<void> {
    await this.withExistingSnapshotAccess(async () => {
      const reader = this.existingRecordReader;
      this.existingRecordReader = null;
      await reader?.close();
      this.ensureStorage();
      // A synchronous existence probe opens the writer without mutating state.
      // Keeping that handle installed makes later snapshots reuse the writer.
      this.recordStore().has("runtimes", runtimeId);
    });
  }

  private async closeRecordStores(): Promise<void> {
    await this.withExistingSnapshotAccess(async () => {
      const stores = [...new Set([
        this.recordStoreInstance,
        this.existingRecordReader,
      ].filter((store): store is LmdbRecordStore => store !== null))];
      this.recordStoreInstance = null;
      this.existingRecordReader = null;
      await Promise.all(stores.map((store) => store.close()));
    });
  }

  /**
   * Map a virtual record path `{storageRoot}/{family}/{basename}.json` back to
   * its `(family, id)` LMDB coordinates. The virtual path remains the record's
   * identity everywhere above the storage boundary; only this leaf translates.
   */
  private recordCoordinates(target: string): { family: OwnedRuntimeRecordDirectory; id: string } {
    const resolved = resolve(target);
    if (!isContained(this.storageRoot, resolved)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle record escaped managed storage");
    }
    const family = basename(dirname(resolved));
    if (pathKey(dirname(dirname(resolved))) !== pathKey(this.storageRoot) ||
        !(OWNED_RUNTIME_RECORD_DIRECTORIES as readonly string[]).includes(family)) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle record is outside a known family namespace");
    }
    const name = basename(resolved);
    if (!name.endsWith(".json")) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle record is not a canonical .json record");
    }
    return { family: family as OwnedRuntimeRecordDirectory, id: name.slice(0, -5) };
  }

  /** Existence of the record addressed by a virtual path (parity with existsSync). */
  private hasRecord(target: string): boolean {
    if (!existsSync(this.storageRoot)) return false;
    const { family, id } = this.recordCoordinates(target);
    return this.recordStore().has(family, id);
  }

  /**
   * Sorted `<id>.json` names in a family namespace, so callers that parsed
   * `readdirSync` filenames keep their existing `name.slice(0, -5)` logic.
   */
  private recordFileNames(family: OwnedRuntimeRecordDirectory): string[] {
    if (!existsSync(this.storageRoot)) return [];
    return this.recordStore().listIds(family).map((id) => `${id}.json`).sort();
  }

  private preparedPath(id: string): string { return join(this.directory("prepared"), `${id}.json`); }
  private preparedSessionIndexPath(sessionId: string): string {
    return join(this.directory("prepared-index"), `${sha256(sessionId)}.json`);
  }
  private preparedInvalidationPath(preparedLaunchId: string): string {
    return join(this.directory("prepared-invalidations"), `${preparedLaunchId}.json`);
  }
  private consumptionPath(id: string): string { return join(this.directory("consumed"), `${id}.json`); }
  private pendingStartPath(id: string): string { return join(this.directory("pending-starts"), `${id}.json`); }
  private runtimePath(id: string): string { return join(this.directory("runtimes"), `${id}.json`); }
  private childExitPath(id: string): string { return join(this.directory("child-exits"), `${id}.json`); }
  private stopPath(id: string): string { return join(this.directory("stops"), `${id}.json`); }
  private stopCompletionPath(id: string): string { return join(this.directory("stop-completions"), `${id}.json`); }
  private restorationProofPath(id: string): string {
    return join(this.directory("restoration-proofs"), `${id}.json`);
  }
  private idempotencyPath(action: "start" | "stop", hash: string): string {
    return join(this.directory("idempotency"), `${action}-${hash}.json`);
  }
  private gameLaunchChainPath(profileKeyDigest: string): string {
    return join(this.directory("game-launch-chains"), `${profileKeyDigest}.json`);
  }

  private readPreparedDescriptor(preparedLaunchId: string): PreparedDescriptor {
    const descriptor = this.readParsed(
      this.preparedPath(preparedLaunchId),
      preparedDescriptorSchema,
      "prepared-launch descriptor",
      this.maxRecordBytes,
    );
    if (descriptor.preparedLaunchId !== preparedLaunchId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Prepared-launch descriptor does not match its filename");
    }
    this.assertPreparedDescriptorCapacity(descriptor);
    if (descriptor.gameLaunchEvidence) validatedGameLaunchEvidence(descriptor.gameLaunchEvidence);
    if (descriptor.gameLaunchAttempt) {
      const link = gameLaunchAttemptLinkSchema.parse(descriptor.gameLaunchAttempt);
      if (!descriptor.gameLaunchEvidence || descriptor.gameLaunchEvidence.prepareKey !== link.prepareKey ||
          descriptor.prepareIdempotencyHash !== sha256(link.recordKey) ||
          pathKey(descriptor.profilePath) === "") {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Prepared game-launch attempt link does not match its descriptor",
        );
      }
    } else if (descriptor.gameLaunchEvidence &&
        gameLaunchAttemptKeySchema.safeParse(descriptor.gameLaunchEvidence.prepareKey).success) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Attempt-scoped game-launch evidence has no descriptor attempt link",
      );
    }
    return descriptor;
  }

  private preparedDescriptorMaxBytes(): number {
    return Math.min(MAX_REALISTIC_PREPARED_DESCRIPTOR_BYTES, this.maxRecordBytes);
  }

  private assertPreparedDescriptorCapacity(descriptor: PreparedDescriptor): void {
    const maximum = descriptor.gameLaunchEvidence
      ? this.maxRecordBytes
      : this.preparedDescriptorMaxBytes();
    if (Buffer.byteLength(this.serializeRecord(descriptor), "utf8") > maximum) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Prepared-launch descriptor exceeds its command-line-aligned byte budget"
      );
    }
  }

  private readOptionalPreparedSessionIndex(sessionId: string): PreparedSessionIndex | null {
    const index = this.readOptionalParsed(
      this.preparedSessionIndexPath(sessionId),
      preparedSessionIndexSchema,
      "prepared-launch session index"
    );
    if (index && index.sessionId !== sessionId) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        "Prepared-launch session index does not match its filename"
      );
    }
    return index;
  }

  private preparedFingerprint(value: {
    sessionId: string;
    arguments: string[];
    profilePath: string;
    runtimeKind: ObserverLaunchInput["runtimeKind"];
    expiresAt: string;
    bundleDigest: string;
    gameLaunchEvidence?: {
      gameLaunchEvidenceDigest: string;
      prepareKey: string;
    };
    gameLaunchAttempt?: GameLaunchAttemptLink;
  }): string {
    return sha256(JSON.stringify({
      sessionId: value.sessionId,
      arguments: value.arguments,
      profilePath: value.profilePath,
      runtimeKind: value.runtimeKind,
      expiresAt: value.expiresAt,
      bundleDigest: value.bundleDigest,
      ...(value.gameLaunchEvidence ? {
        gameLaunchEvidenceDigest: value.gameLaunchEvidence.gameLaunchEvidenceDigest,
        prepareKey: value.gameLaunchEvidence.prepareKey,
      } : {}),
      ...(value.gameLaunchAttempt ? {
        gameLaunchAttempt: value.gameLaunchAttempt,
      } : {}),
    }));
  }

  private readOptionalPreparedInvalidation(
    preparedLaunchId: string,
    descriptor?: PreparedDescriptor,
  ): PreparedInvalidation | null {
    const invalidation = this.readOptionalParsed(
      this.preparedInvalidationPath(preparedLaunchId),
      preparedInvalidationSchema,
      "prepared game-launch invalidation",
    );
    if (invalidation) {
      if (invalidation.preparedLaunchId !== preparedLaunchId) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Prepared game-launch invalidation does not match its filename",
        );
      }
      if (descriptor && (!descriptor.gameLaunchEvidence ||
          invalidation.sessionId !== descriptor.sessionId ||
          invalidation.gameLaunchEvidenceDigest !==
            descriptor.gameLaunchEvidence.gameLaunchEvidenceDigest ||
          invalidation.managerInstanceId !== descriptor.managerInstanceId)) {
        throw new OwnedRuntimeError(
          "STORAGE_UNVERIFIABLE",
          "Prepared game-launch invalidation does not match its retained descriptor",
        );
      }
    }
    return invalidation;
  }

  private readOptionalConsumption(preparedLaunchId: string): z.infer<typeof consumptionSchema> | null {
    const consumption = this.readOptionalParsed(
      this.consumptionPath(preparedLaunchId),
      consumptionSchema,
      "prepared-launch consumption"
    );
    if (consumption && consumption.preparedLaunchId !== preparedLaunchId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Prepared-launch consumption does not match its filename");
    }
    return consumption;
  }

  private readOptionalStopReceipt(runtimeId: string): StopReceipt | null {
    const stopped = this.readOptionalParsed(this.stopPath(runtimeId), stopReceiptSchema, "stop receipt");
    if (stopped && stopped.runtimeId !== runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop receipt does not match its runtime filename");
    }
    return stopped;
  }

  private readOptionalChildExitReceipt(runtimeId: string): ChildExitReceipt | null {
    const receipt = this.readOptionalParsed(
      this.childExitPath(runtimeId),
      childExitReceiptSchema,
      "child exit receipt"
    );
    if (receipt && receipt.runtimeId !== runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Child exit receipt does not match its runtime filename");
    }
    return receipt;
  }

  private readOptionalStopCompletion(runtimeId: string): StopCompletion | null {
    const completion = this.readOptionalParsed(
      this.stopCompletionPath(runtimeId),
      stopCompletionSchema,
      "stop completion receipt"
    );
    if (completion && completion.runtimeId !== runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop completion does not match its runtime filename");
    }
    return completion;
  }

  private readOptionalRestorationProof(runtimeId: string): RestorationProof | null {
    const proof = this.readOptionalParsed(
      this.restorationProofPath(runtimeId),
      restorationProofSchema,
      "runtime restoration proof"
    );
    if (proof && proof.runtimeId !== runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Runtime restoration proof does not match its filename");
    }
    return proof;
  }

  private readRuntimeReceipt(runtimeId: string): OwnedRuntimeReceipt {
    if (!this.hasRecord(this.runtimePath(runtimeId))) {
      throw new OwnedRuntimeError("RUNTIME_NOT_FOUND", "Owned runtime receipt was not found");
    }
    const receipt = this.readParsed(this.runtimePath(runtimeId), runtimeReceiptSchema, "runtime lifecycle receipt");
    if (receipt.runtimeId !== runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Runtime lifecycle receipt does not match its filename");
    }
    const descriptor = this.readPreparedDescriptor(receipt.preparedLaunchId);
    const consumption = this.readOptionalConsumption(receipt.preparedLaunchId);
    const argumentsHash = sha256(JSON.stringify([...descriptor.arguments, receipt.ownerTokenArgument]));
    if (!consumption || consumption.runtimeId !== receipt.runtimeId ||
        descriptor.sessionId !== receipt.sessionId || descriptor.profilePath !== receipt.profilePath ||
        descriptor.runtimeKind !== receipt.runtimeKind || descriptor.expiresAt !== receipt.preparedExpiresAt ||
        descriptor.managerInstanceId !== receipt.mcpOwner.managerInstanceId ||
        argumentsHash !== receipt.argvSha256) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Runtime receipt links do not match prepared-launch state");
    }
    return receipt;
  }

  private readOptionalRuntimeReceipt(runtimeId: string): OwnedRuntimeReceipt | null {
    return this.hasRecord(this.runtimePath(runtimeId)) ? this.readRuntimeReceipt(runtimeId) : null;
  }

  private readOptionalPendingStart(runtimeId: string): PendingStart | null {
    const value = this.readOptionalParsed(this.pendingStartPath(runtimeId), pendingStartSchema, "pending start receipt");
    if (value && value.runtimeId !== runtimeId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Pending start receipt does not match its runtime filename");
    }
    return value;
  }

  private updatePendingStart(
    root: string,
    pending: PendingStart,
    patch: Partial<Pick<PendingStart,
      "state" | "pid" | "creationTimeFileTime" | "lifecycleGeneration" | "lastError"
    >>
  ): PendingStart {
    const next = pendingStartSchema.parse({
      ...pending,
      ...patch,
      updatedAt: nowIso(this.clock),
    });
    this.atomicWrite(root, this.pendingStartPath(pending.runtimeId), next, false);
    return next;
  }

  private readParsed<T>(
    path: string,
    schema: z.ZodType<T>,
    label: string,
    maxBytes = Math.min(DEFAULT_LIFECYCLE_RECORD_MAX_BYTES, this.maxRecordBytes)
  ): T {
    const { family, id } = this.recordCoordinates(path);
    const raw = existsSync(this.storageRoot) ? this.recordStore().getRaw(family, id) : null;
    if (raw === null) {
      throw new OwnedRuntimeError("RUNTIME_NOT_FOUND", `${label} was not found`);
    }
    // Preserve the prior min/max byte bounds. A record outside them is
    // unverifiable, exactly like a corrupt file that violated the same bounds.
    if (raw.byteLength < LIFECYCLE_RECORD_MIN_BYTES || raw.byteLength > maxBytes) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        `${label} is invalid: record byte length ${raw.byteLength} is outside its bounds`
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(raw).toString("utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      return schema.parse(decoded);
    } catch (error) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private readOptionalParsed<T>(path: string, schema: z.ZodType<T>, label: string): T | null {
    return this.hasRecord(path) ? this.readParsed(path, schema, label) : null;
  }

  private atomicWrite(
    root: string,
    target: string,
    value: unknown,
    exclusive: boolean,
    capacityPreflighted = false
  ): void {
    if (!isContained(root, target)) throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle write escaped managed storage");
    // `target` remains the virtual record path (crash-injection tests hook it by
    // that path); only the leaf translation to (family, id) touches LMDB.
    const { family, id } = this.recordCoordinates(target);
    if (exclusive && this.recordStore().has(family, id)) {
      throw new OwnedRuntimeError("STORAGE_CONFLICT", "Lifecycle receipt already exists");
    }
    if (!capacityPreflighted) this.assertBatchCapacity(root, [{ target, value, exclusive }]);
    const serialized = this.serializeRecord(value);
    try {
      this.bumpIdleRevision();
      this.recordStore().putRaw(family, id, Buffer.from(serialized, "utf8"), { exclusive });
    } catch (error) {
      if (error instanceof LmdbRecordStoreError && error.code === "RECORD_EXISTS") {
        throw new OwnedRuntimeError(
          "STORAGE_CONFLICT",
          "Lifecycle receipt appeared concurrently"
        );
      }
      throw error;
    }
  }

  private normalizeError(error: unknown, fallbackCode: string, fallbackMessage: string): OwnedRuntimeError {
    if (error instanceof OwnedRuntimePreconsumptionError) return error;
    if (error instanceof OwnedRuntimeError) {
      return new OwnedRuntimeError(error.code, this.message(error), error.details, error.remedyReason);
    }
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code)
      : fallbackCode;
    return new OwnedRuntimeError(code, error instanceof Error ? this.message(error) : fallbackMessage);
  }

  private async withAdmission<T>(description: string, action: () => Promise<T>): Promise<T> {
    this.bumpIdleRevision();
    if (!this.admissionGate) {
      try { return await action(); }
      finally { this.bumpIdleRevision(); }
    }
    const token = this.admissionGate.acquire(description);
    try {
      return await action();
    } finally {
      this.bumpIdleRevision();
      token.release();
    }
  }

  private async withPrivilegedCleanup<T>(action: () => Promise<T>): Promise<T> {
    this.bumpIdleRevision();
    try {
      return this.admissionGate
        ? await this.admissionGate.runPrivilegedCleanup(action)
        : await action();
    } finally {
      this.bumpIdleRevision();
    }
  }

  private bumpIdleRevision(): void {
    if (this.idleRevision === Number.MAX_SAFE_INTEGER) throw new Error("Owned runtime idle revision exhausted");
    this.idleRevision += 1;
  }

  private assertOpenForMutation(): void {
    if (this.closing) {
      throw new OwnedRuntimeError("LIFECYCLE_CLOSING", "Owned runtime lifecycle is shutting down");
    }
  }

  private message(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return redactText(value, {
      profile: "command_argument",
      replacement: "[owner-token-redacted]",
      maxLength: 512,
    });
  }
}

/** Preserve restoration authority before shutting down the in-memory observer agent. */
export async function closeObserverRuntimeLifecycle(
  manager: Pick<OwnedRuntimeManager, "close">,
  application: { close(): Promise<void> }
): Promise<Record<string, unknown>> {
  const result = await manager.close();
  if (result.applicationCloseSafe !== true) {
    throw new OwnedRuntimeError(
      "SHUTDOWN_SEAL_FAILED",
      "Observer application remains live because one or more exact runtimes were not safely sealed",
      result
    );
  }
  await application.close();
  return result;
}
