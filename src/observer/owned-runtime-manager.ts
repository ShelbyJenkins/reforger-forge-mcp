import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  ChildSupervisor,
  type SupervisedChildCounts,
  type SupervisedChildExit,
} from "../foundation/child-supervisor.js";
import type {
  ObserverLaunchInput,
  ObserverPreparedLaunch,
  ObserverPreparedLaunchRecorder,
} from "./launch.js";

export const OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX = "-reforgerForgeOwnerToken=";
export const OWNED_RUNTIME_LIFECYCLE_MUTEX = "Global\\ReforgerForge.ObserverRuntimeLifecycle.v1";

const STORAGE_VERSION = 1;
// A serialized lifecycle record is at minimum `{}\n`; anything shorter is a
// truncated/corrupt value. Preserves the prior BoundedJsonStore lower bound.
const LIFECYCLE_RECORD_MIN_BYTES = 2;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 20_000;
const PROCESS_POLL_MS = 100;
const DEFAULT_LIFECYCLE_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_STORE_RECORDS = 16_384;
const DEFAULT_MAX_STORE_BYTES = 512 * 1024 * 1024;
// Keep the historical shared ceiling for unrelated lifecycle record kinds.
// Prepared descriptors have the tighter, launch-derived bound below.
const MAX_CONFIGURABLE_RECORD_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = MAX_CONFIGURABLE_RECORD_BYTES;
const START_LIFECYCLE_RESERVE_RECORDS = 9;
const START_LIFECYCLE_RESERVE_BYTES = 2 * 1024 * 1024;
const CHILD_EXIT_RESERVE_BYTES = 256 * 1024;
const SMALL_LIFECYCLE_RESERVE_BYTES = 8 * 1024;
const WINDOWS_COMMAND_LINE_MAX_UTF16_UNITS = 32_767;
const WINDOWS_PATH_MAX_CHARS = 32_768;
const WINDOWS_SID_MAX_CHARS = 256;
const DECIMAL_IDENTITY_MAX_CHARS = 32;
const PREPARED_SESSION_ID_MAX_UTF16_UNITS = 96;
const PREPARED_ARGUMENT_MAX_COUNT = 520;
const JSON_STRING_MAX_UTF8_BYTES_PER_UTF16_UNIT = 6;
const PREPARED_ARGUMENT_JSON_OVERHEAD_MAX_BYTES = PREPARED_ARGUMENT_MAX_COUNT * 8;
const PREPARED_FIXED_JSON_ENVELOPE_MAX_BYTES = 4 * 1024;
// A launchable argument vector contributes at most 32,767 UTF-16 units. JSON
// can encode one UTF-16 unit as six UTF-8 bytes (for example, "\u0000"), and
// the separately persisted profile path and session id have bounded lengths.
// Each of the 520 pretty-printed array entries needs at most eight structural
// bytes; 4 KiB covers the remaining production-generated keys, fixed metadata,
// braces, indentation, and trailing newline:
//   (32,767 + 32,768 + 96) * 6 + 520 * 8 + 4,096 = 402,042 bytes.
const MAX_REALISTIC_PREPARED_DESCRIPTOR_BYTES =
  (WINDOWS_COMMAND_LINE_MAX_UTF16_UNITS + WINDOWS_PATH_MAX_CHARS +
    PREPARED_SESSION_ID_MAX_UTF16_UNITS) * JSON_STRING_MAX_UTF8_BYTES_PER_UTF16_UNIT +
  PREPARED_ARGUMENT_JSON_OVERHEAD_MAX_BYTES + PREPARED_FIXED_JSON_ENVELOPE_MAX_BYTES;
export const OWNED_RUNTIME_RECORD_DIRECTORIES = [
  "prepared",
  "prepared-index",
  "consumed",
  "pending-starts",
  "runtimes",
  "child-exits",
  "stops",
  "stop-completions",
  "restoration-proofs",
  "idempotency",
] as const;
type OwnedRuntimeRecordDirectory = typeof OWNED_RUNTIME_RECORD_DIRECTORIES[number];
const preparedLaunchIdSchema = z.string().regex(/^pl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const runtimeIdSchema = z.string().regex(/^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
  projectPath?: string;
  backend?: ExactProcessBackend;
  /** Required when backend does not also implement the legacy combined adapter. */
  machineMutex?: MachineMutex;
  spawnProcess?: typeof nodeSpawn;
  executableResolver?: () => string;
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
}

export interface OwnedRuntimeStopInput {
  runtimeId: string;
  waitForRestorationMs: number;
  idempotencyKey: string;
  signal?: AbortSignal;
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
}

export class OwnedRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "OwnedRuntimeError";
  }
}

const preparedDescriptorSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  preparedLaunchId: preparedLaunchIdSchema,
  sessionId: z.string().min(1).max(PREPARED_SESSION_ID_MAX_UTF16_UNITS),
  // observer_prepare_launch accepts 512 input tokens. Normalization can append
  // six required observer tokens plus -forceUpdate and -noFocus, so preserve
  // that existing boundary in the persisted descriptor.
  arguments: z.array(z.string().max(32_768)).max(PREPARED_ARGUMENT_MAX_COUNT),
  profilePath: z.string().min(1).max(WINDOWS_PATH_MAX_CHARS),
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  expiresAt: z.string().datetime(),
  bundleDigest: sha256Schema,
  recordedAt: z.string().datetime(),
  managerInstanceId: z.string().uuid(),
  prepareIdempotencyHash: sha256Schema.optional(),
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

function inspectExecutableFile(filePath: string): ExecutableFileIdentity {
  const descriptor = openSync(filePath, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", "Configured runtime executable is not a regular file");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
      position += bytes;
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
      "Prepared arguments exceed the Windows CreateProcess command-line limit"
    );
  }
}

function pathKey(value: string): string {
  return pathComparisonKey(value);
}

function isContained(root: string, candidate: string): boolean {
  return isPathContained(root, candidate);
}

function pathsOverlap(left: string, right: string): boolean {
  return isContained(left, right) || isContained(right, left);
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
      "Prepared launch arguments already contain an owner-token argument"
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

/** Resolve only allowlisted graphical runtime names beneath the configured game installation. */
export function resolveGraphicalRuntimeExecutable(gamePath: string): string {
  const gameRoot = canonicalDirectory(gamePath, false);
  const names = [
    "ArmaReforgerSteamDiag.exe",
    "ArmaReforgerDiag.exe",
    "ArmaReforgerSteam.exe",
    "ArmaReforger.exe",
  ];
  for (const name of names) {
    const candidate = join(gameRoot, name);
    if (!existsSync(candidate)) continue;
    const executable = canonicalFile(candidate, "Configured Arma Reforger graphical executable");
    if (!isContained(gameRoot, executable)) {
      throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", "Configured runtime executable escapes the game installation");
    }
    return executable;
  }
  throw new OwnedRuntimeError(
    "RUNTIME_NOT_FOUND",
    "No allowlisted graphical Arma Reforger executable exists beneath the configured game path"
  );
}

export class OwnedRuntimeManager implements ObserverPreparedLaunchRecorder {
  readonly managerInstanceId: string;
  readonly installationId: string;
  readonly storageRoot: string;
  private readonly backend: ExactProcessBackend;
  private readonly machineMutex: MachineMutex;
  private readonly durableReservations = new DurableReservationGate();
  private readonly spawnProcess: typeof nodeSpawn;
  private readonly clock: () => number;
  private readonly sleeper: Sleeper;
  private readonly createOwnerToken: () => string;
  private readonly createId: () => string;
  private readonly resolveExecutable: () => string;
  private readonly inspectionTimeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly receiptRetentionMs: number;
  private readonly maxStoreRecords: number;
  private readonly maxStoreBytes: number;
  private readonly maxRecordBytes: number;
  private readonly managedRoot: string;
  private readonly children = new ChildSupervisor();
  private recordStoreInstance: LmdbRecordStore | null = null;
  private closing = false;
  private closePromise: Promise<Record<string, unknown>> | null = null;

  constructor(private readonly options: OwnedRuntimeManagerOptions) {
    this.managerInstanceId = randomUUID();
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
    this.clock = options.clock ?? Date.now;
    this.sleeper = options.sleeper ?? systemSleeper;
    this.createOwnerToken = options.ownerToken ?? (() => randomBytes(32).toString("base64url"));
    this.createId = options.randomId ?? randomUUID;
    this.resolveExecutable = options.executableResolver ?? (() => resolveGraphicalRuntimeExecutable(options.gamePath));
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
    if (options.projectPath && pathsOverlap(resolve(options.projectPath), requestedManagedRoot)) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "Owned-runtime storage must not overlap the configured project path");
    }
    this.managedRoot = canonicalDirectoryTarget(requestedManagedRoot, true);
    if (options.projectPath) {
      const projectTarget = canonicalDirectoryTarget(options.projectPath, false);
      if (pathsOverlap(projectTarget, this.managedRoot)) {
        throw new OwnedRuntimeError("INVALID_REQUEST", "Owned-runtime storage must not resolve into the configured project path");
      }
    }
    this.storageRoot = join(this.managedRoot, "state", "owned-runtimes-v1");
    const installationRoot = canonicalDirectory(
      options.installationRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      false
    );
    this.installationId = sha256(pathKey(installationRoot));
  }

  private withFencedMachineMutex<T>(
    action: (fence: OwnedRuntimeLeaseFence) => Promise<T>,
    deadline?: OwnedRuntimeWallDeadline
  ): Promise<T> {
    let leaseLoss: MachineMutexLeaseLoss | null = null;
    const fence: OwnedRuntimeLeaseFence = {
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
        onLeaseLost: (error) => { leaseLoss = error; },
        action: async () => {
          fence.assertActive();
          const result = await action(fence);
          fence.assertActive();
          return result;
        },
      });
    return deadline
      ? this.beforeWallDeadline(deadline, (remainingMs) => acquire(remainingMs))
      : acquire();
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
    this.assertOpenForMutation();
    const descriptorFingerprint = this.preparedFingerprint({
      sessionId: prepared.sessionId,
      arguments: prepared.arguments,
      profilePath: prepared.profilePath,
      runtimeKind: input.runtimeKind,
      expiresAt: prepared.expiresAt,
      bundleDigest: prepared.bundleDigest,
    });
    try {
      return await this.machineMutex.withMachineMutex({
        name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
        timeoutMs: this.lockTimeoutMs,
        action: async () => {
          this.assertOpenForMutation();
          const root = this.ensureStorage();
          const existingIndex = this.readOptionalPreparedSessionIndex(prepared.sessionId);
          if (existingIndex) {
            if (existingIndex.descriptorFingerprint !== descriptorFingerprint) {
              throw new OwnedRuntimeError(
                "ARGUMENT_CONFLICT",
                "Observer session was reused with a different prepared launch"
              );
            }
            const existing = this.readPreparedDescriptor(existingIndex.preparedLaunchId);
            if (existing.sessionId !== prepared.sessionId ||
                existingIndex.expiresAt !== existing.expiresAt ||
                this.preparedFingerprint(existing) !== descriptorFingerprint) {
              throw new OwnedRuntimeError(
                "STORAGE_UNVERIFIABLE",
                "Prepared-launch session index does not match its descriptor"
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
        },
      });
    } catch (error) {
      throw this.normalizeError(error, "PREPARE_FAILED", "Prepared runtime launch could not be recorded");
    }
  }

  async start(input: OwnedRuntimeStartInput): Promise<OwnedRuntimePublicStatus> {
    this.assertOpenForMutation();
    preparedLaunchIdSchema.parse(input.preparedLaunchId);
    const keyHash = sha256(boundedIdempotencyKey(input.idempotencyKey));
    const requestFingerprint = sha256(JSON.stringify({ preparedLaunchId: input.preparedLaunchId }));
    try {
      return await this.withFencedMachineMutex((fence) =>
        this.startLocked(input.preparedLaunchId, keyHash, requestFingerprint, fence));
    } catch (error) {
      // A failed start may have durably proved exact child vacancy while
      // leaving observer lifecycle release outstanding. Retry that IPC after
      // the start transaction has relinquished the machine mutex. Preserve
      // the primary start outcome; `release_required` remains the durable
      // authority if this best-effort attempt also fails.
      await this.retryPendingStartLifecycleReleaseForKey(keyHash).catch(() => undefined);
      throw this.normalizeError(error, "START_FAILED", "Owned runtime start failed");
    }
  }

  async status(runtimeId: string): Promise<OwnedRuntimePublicStatus> {
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

  /** Explicit bounded retention hook for controlled shutdown and diagnostics. */
  async sweep(now = this.clock()): Promise<OwnedRuntimeSweepResult> {
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
    this.assertOpenForMutation();
    runtimeIdSchema.parse(input.runtimeId);
    boundedIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.waitForRestorationMs) || input.waitForRestorationMs < 0 ||
        input.waitForRestorationMs > 5 * 60_000) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "waitForRestorationMs must be from 0 through 300000");
    }
    // One budget covers preparation, the requested restoration wait, exact
    // inspection/termination, observer completion, and the final CAS. Each
    // configured component contributes once; no sub-operation resets it.
    const wallDeadline: OwnedRuntimeWallDeadline = {
      expiresAtMs: Date.now() + input.waitForRestorationMs +
        this.lockTimeoutMs + this.inspectionTimeoutMs + this.terminationTimeoutMs,
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
      // The literal exact-vacancy stop receipt also makes lifecycle release
      // safe. Re-acknowledge its exact generation immediately before
      // completion so a retry remains valid after bounded tombstone expiry.
      await this.releaseRuntimeLifecycle(transition.authority.receipt, wallDeadline);
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
  close(): Promise<Record<string, unknown>> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const attempt = this.closeOwnedRuntimes();
    this.closePromise = attempt.then(async (result) => {
      if (result.applicationCloseSafe !== true) {
        this.closing = false;
        this.closePromise = null;
      } else {
        // A clean shutdown seal completed; release the LMDB environment. An
        // unsafe/retryable close deliberately keeps it open for the retry.
        await this.recordStoreInstance?.close();
        this.recordStoreInstance = null;
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
    await this.recordStoreInstance?.close();
    this.recordStoreInstance = null;
  }

  private async closeOwnedRuntimes(): Promise<Record<string, unknown>> {
    // Shutdown uses the configured lifecycle lock timeout as one aggregate
    // budget, including inventory, observer release/reservation IPC, sealing,
    // and the final inventory CAS. It is deliberately not reset per runtime.
    const wallDeadline: OwnedRuntimeWallDeadline = {
      expiresAtMs: Date.now() + this.lockTimeoutMs,
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
            if (runtimeIdSchema.safeParse(runtimeId).success) ids.push(runtimeId);
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
              if (receipt.mcpOwner.managerInstanceId !== this.managerInstanceId) return null;
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
              if (receipt.mcpOwner.managerInstanceId !== this.managerInstanceId) continue;
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

  private async startLocked(
    preparedLaunchId: string,
    keyHash: string,
    requestFingerprint: string,
    leaseFence: OwnedRuntimeLeaseFence
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
    if (descriptor.managerInstanceId !== this.managerInstanceId) {
      throw new OwnedRuntimeError("PREPARED_LAUNCH_STALE", "Prepared launch belongs to a prior MCP lifecycle instance");
    }
    if (Date.parse(descriptor.expiresAt) <= this.clock()) {
      throw new OwnedRuntimeError("PREPARED_LAUNCH_EXPIRED", "Prepared launch has expired");
    }
    assertNoOwnerArgument(descriptor.arguments);
    if (descriptor.arguments.some((argument) => argument.includes("\0"))) {
      throw new OwnedRuntimeError("ARGUMENT_CONFLICT", "Prepared launch arguments cannot contain NUL characters");
    }
    // Reserve the complete ownership/recovery cluster before any consumption
    // receipt, spawn, or other irreversible action is attempted.
    this.assertStartLifecycleHeadroom(root);

    const executablePath = canonicalFile(this.resolveExecutable(), "Graphical runtime executable");
    const executableFile = inspectExecutableFile(executablePath);
    const ownerNonce = this.createOwnerToken();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(ownerNonce)) {
      throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", "Generated runtime owner token is not a bounded cryptographic nonce");
    }
    const ownerTokenArgument = `${OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX}${ownerNonce}`;
    const argumentsArray = [...descriptor.arguments, ownerTokenArgument];
    if (argumentsArray.filter((argument) =>
      argument.toLowerCase().startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX.toLowerCase())).length !== 1) {
      throw new OwnedRuntimeError("ARGUMENT_CONFLICT", "Owned runtime start did not produce exactly one owner argument");
    }
    assertWindowsCommandLineFits(executablePath, argumentsArray);
    const argvSha256 = sha256(JSON.stringify(argumentsArray));
    const mcpOwner = await this.currentMcpOwner();
    leaseFence.assertActive();

    const consumptionPath = this.consumptionPath(preparedLaunchId);
    const consumed = this.readOptionalConsumption(preparedLaunchId);
    if (consumed) {
      if (consumed.idempotencyHash === keyHash && consumed.requestFingerprint === requestFingerprint) {
        const runtime = this.readOptionalRuntimeReceipt(consumed.runtimeId);
        if (runtime) {
          if (runtime.preparedLaunchId !== preparedLaunchId) {
            throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Prepared-launch consumption points at another runtime receipt");
          }
          await this.reconcileRuntimeLifecycleLease(runtime);
          leaseFence.assertActive();
          return this.inspectReceipt(runtime);
        }
        throw new OwnedRuntimeError("START_UNVERIFIABLE", "Prepared launch was consumed without a successful receipt");
      }
      throw new OwnedRuntimeError("PREPARED_LAUNCH_CONSUMED", "Prepared launch is one-shot and has already been consumed");
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
    let receiptPublished = false;
    let pinnedReceipt: OwnedRuntimeReceipt | null = null;
    try {
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
          child = this.spawnProcess(executablePath, argumentsArray, {
            cwd: dirname(executablePath),
            detached: false,
            shell: false,
            stdio: "ignore",
            windowsHide: false,
          });
          return child;
        },
        childPid: (spawned) => spawned.pid,
        awaitSpawn: (spawned) => this.awaitSpawn(spawned),
        inspect: async (spawned) => {
          const identity = await this.inspectSpawned(
            spawned,
            executablePath,
            ownerTokenArgument
          );
          const executableFileAfterSpawn = inspectExecutableFile(executablePath);
          if (!executableFilesMatch(executableFile, executableFileAfterSpawn)) {
            throw new OwnedRuntimeError(
              "IDENTITY_MISMATCH",
              "Graphical runtime executable was replaced during start"
            );
          }
          pinnedReceipt = runtimeReceiptSchema.parse({
            version: STORAGE_VERSION,
            runtimeId,
            sessionId: descriptor.sessionId,
            preparedLaunchId,
            pid: identity.pid,
            executablePath: identity.executablePath,
            executableFile: executableFileAfterSpawn,
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
      if (!receiptPublished) {
        const cleanupVerified = child ? await this.terminateRetainedChild(child).catch(() => false) : true;
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
    this.sweepLocked(this.clock());
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
      if (existingStop.sessionId !== receipt.sessionId) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop receipt session does not match its runtime receipt");
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
    let currentOwner: z.infer<typeof mcpOwnerSchema>;
    try {
      currentOwner = await this.currentMcpOwner(wallDeadline);
    } catch (error) {
      if (this.isWallDeadlineError(error)) throw error;
      return this.publicStatus(receipt, "unverifiable", false, `MCP owner identity is unavailable: ${this.message(error)}`);
    }
    if (currentOwner.installationId !== receipt.mcpOwner.installationId ||
        currentOwner.userSid !== receipt.mcpOwner.userSid) {
      return this.publicStatus(receipt, "unverifiable", false, "Lifecycle receipt belongs to a different MCP installation or Windows owner");
    }
    if (currentOwner.managerInstanceId !== receipt.mcpOwner.managerInstanceId) {
      let priorOwner: OwnedRuntimeInspection | null;
      try {
        priorOwner = wallDeadline
          ? await this.beforeWallDeadline(wallDeadline, () =>
            this.backend.inspectProcess(receipt.mcpOwner.pid))
          : await this.backend.inspectProcess(receipt.mcpOwner.pid);
      } catch (error) {
        if (this.isWallDeadlineError(error)) throw error;
        return this.publicStatus(receipt, "unverifiable", false, `Prior MCP owner identity is unavailable: ${this.message(error)}`);
      }
      if (priorOwner && priorOwner.identity.pid === receipt.mcpOwner.pid &&
          pathKey(priorOwner.identity.executablePath) === pathKey(receipt.mcpOwner.executablePath) &&
          priorOwner.identity.creationTime === receipt.mcpOwner.creationTimeFileTime) {
        return this.publicStatus(
          receipt,
          "unverifiable",
          false,
          "Prior exact MCP owner is still live; this process is not a restart recovery"
        );
      }
    }
    let configuredExecutable: string;
    try {
      configuredExecutable = canonicalFile(this.resolveExecutable(), "Configured graphical runtime executable");
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

  private assertInspectionMatches(receipt: OwnedRuntimeReceipt, inspection: OwnedRuntimeInspection): void {
    if (!this.inspectionMatches(receipt, inspection)) {
      throw new OwnedRuntimeError(
        "IDENTITY_MISMATCH",
        "Runtime PID no longer matches its exact executable, creation time, and owner-token identity"
      );
    }
  }

  private assertExecutableFileMatches(receipt: OwnedRuntimeReceipt): void {
    const executable = canonicalFile(this.resolveExecutable(), "Configured graphical runtime executable");
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

  private sweepLocked(now: number): OwnedRuntimeSweepResult {
    if (!Number.isFinite(now)) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "Owned runtime retention time is invalid");
    }
    const removedPreparedLaunchIds = new Set<string>();
    const removedRuntimeIds: string[] = [];
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
      try {
        const completion = this.readOptionalStopCompletion(runtimeId);
        if (!completion || now - Date.parse(completion.completedAt) < this.receiptRetentionMs) continue;
        if (this.hasRecord(this.runtimePath(runtimeId))) {
          const receipt = this.readRuntimeReceipt(runtimeId);
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
      try {
        const pending = this.readOptionalPendingStart(runtimeId);
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
        if (now - Date.parse(descriptor.expiresAt) < this.receiptRetentionMs) continue;
        const index = this.readOptionalPreparedSessionIndex(descriptor.sessionId);
        if (index?.preparedLaunchId === preparedLaunchId) {
          this.unlinkOwnedFile(this.preparedSessionIndexPath(descriptor.sessionId));
        }
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

  private assertStartLifecycleHeadroom(root: string): void {
    if (this.maxRecordBytes < CHILD_EXIT_RESERVE_BYTES) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Owned-runtime record budget cannot preserve worst-case exact identity evidence"
      );
    }
    const usage = this.storeUsage(root);
    const existingReserve = this.mutationReserve(usage.byPath, []);
    const nextRecords = usage.records + existingReserve.records + START_LIFECYCLE_RESERVE_RECORDS;
    const nextBytes = usage.bytes + existingReserve.bytes +
      Math.min(this.maxStoreBytes, START_LIFECYCLE_RESERVE_BYTES);
    if (nextRecords > this.maxStoreRecords || nextBytes > this.maxStoreBytes) {
      throw new OwnedRuntimeError(
        "STORE_CAPACITY_EXCEEDED",
        "Owned-runtime store cannot reserve a complete start/stop recovery lifecycle"
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

  private readPreparedDescriptor(preparedLaunchId: string): PreparedDescriptor {
    const descriptor = this.readParsed(
      this.preparedPath(preparedLaunchId),
      preparedDescriptorSchema,
      "prepared-launch descriptor",
      this.preparedDescriptorMaxBytes()
    );
    if (descriptor.preparedLaunchId !== preparedLaunchId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Prepared-launch descriptor does not match its filename");
    }
    return descriptor;
  }

  private preparedDescriptorMaxBytes(): number {
    return Math.min(MAX_REALISTIC_PREPARED_DESCRIPTOR_BYTES, this.maxRecordBytes);
  }

  private assertPreparedDescriptorCapacity(descriptor: PreparedDescriptor): void {
    if (Buffer.byteLength(this.serializeRecord(descriptor), "utf8") > this.preparedDescriptorMaxBytes()) {
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

  private preparedFingerprint(value: Pick<PreparedDescriptor,
    "sessionId" | "arguments" | "profilePath" | "runtimeKind" | "expiresAt" | "bundleDigest"
  >): string {
    return sha256(JSON.stringify({
      sessionId: value.sessionId,
      arguments: value.arguments,
      profilePath: value.profilePath,
      runtimeKind: value.runtimeKind,
      expiresAt: value.expiresAt,
      bundleDigest: value.bundleDigest,
    }));
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
    if (error instanceof OwnedRuntimeError) {
      return new OwnedRuntimeError(error.code, this.message(error), error.details);
    }
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? String((error as { code: string }).code)
      : fallbackCode;
    return new OwnedRuntimeError(code, error instanceof Error ? this.message(error) : fallbackMessage);
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
