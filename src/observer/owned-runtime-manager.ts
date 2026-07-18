import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  fsyncSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  WindowsLifecycleBackend,
  type ExactProcessIdentity,
  type VerifyTerminateResult,
  type WorkbenchIdentity,
} from "../workbench/process-guard.js";
import type {
  ObserverLaunchInput,
  ObserverPreparedLaunch,
  ObserverPreparedLaunchRecorder,
} from "./launch.js";

export const OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX = "-reforgerForgeOwnerToken=";
export const OWNED_RUNTIME_LIFECYCLE_MUTEX = "Global\\ReforgerForge.ObserverRuntimeLifecycle.v1";

const STORAGE_VERSION = 1;
const DEFAULT_INSPECTION_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATION_TIMEOUT_MS = 20_000;
const PROCESS_POLL_MS = 100;
const DEFAULT_LIFECYCLE_RECORD_MAX_BYTES = 4 * 1024 * 1024;
// 519 strings × 32,768 UTF-16 code units, including worst-case JSON escaping.
const PREPARED_DESCRIPTOR_MAX_BYTES = 128 * 1024 * 1024;
const preparedLaunchIdSchema = z.string().regex(/^pl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const runtimeIdSchema = z.string().regex(/^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const fileTimeSchema = z.string().regex(/^\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const decimalSchema = z.string().regex(/^\d+$/);

export type OwnedRuntimeState =
  | "running"
  | "exited"
  | "identity_mismatch"
  | "unverifiable"
  | "stale";

export interface OwnedRuntimeExactIdentity {
  pid: number;
  executablePath: string;
  creationTimeFileTime: string;
}

export interface OwnedRuntimeInspection {
  identity: OwnedRuntimeExactIdentity;
  ownerArgumentMatched: boolean | null;
}

export type OwnedRuntimeTerminateResult = VerifyTerminateResult;

/** Generic exact-process surface used by the runtime manager. */
export interface OwnedRuntimeProcessBackend {
  readonly platform: "win32" | "test";
  withMachineMutex<T>(args: {
    name: string;
    timeoutMs: number;
    action: () => Promise<T>;
  }): Promise<T>;
  inspectCurrentProcess(pid: number): Promise<OwnedRuntimeExactIdentity & { userSid: string }>;
  inspectProcess(pid: number, expectedOwnerTokenArgument?: string): Promise<OwnedRuntimeInspection | null>;
  verifyAndTerminate(
    expected: OwnedRuntimeExactIdentity & { ownerTokenArgument: string; launchedAtMs: number },
    timeoutMs: number
  ): Promise<OwnedRuntimeTerminateResult>;
}

/**
 * Reuses the native Windows handle implementation without exposing its
 * Workbench lifecycle state, endpoint, or name-enumeration operations.
 */
export class WindowsOwnedRuntimeProcessBackend implements OwnedRuntimeProcessBackend {
  readonly platform = "win32" as const;
  private readonly backend: WindowsLifecycleBackend;

  constructor(backend?: WindowsLifecycleBackend) {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    this.backend = backend ?? new WindowsLifecycleBackend(
      join(packageRoot, "scripts", "windows", "workbench-lifecycle.ps1")
    );
  }

  withMachineMutex<T>(args: {
    name: string;
    timeoutMs: number;
    action: () => Promise<T>;
  }): Promise<T> {
    return this.backend.withMachineMutex(args);
  }

  async inspectCurrentProcess(pid: number): Promise<OwnedRuntimeExactIdentity & { userSid: string }> {
    const identity = await this.backend.inspectCurrentProcess(pid);
    return {
      pid: identity.pid,
      executablePath: identity.executablePath,
      creationTimeFileTime: identity.creationTime,
      userSid: identity.userSid,
    };
  }

  async inspectProcess(
    pid: number,
    expectedOwnerTokenArgument?: string
  ): Promise<OwnedRuntimeInspection | null> {
    const inspection = await this.backend.inspectProcess(pid, expectedOwnerTokenArgument);
    return inspection ? {
      identity: runtimeIdentity(inspection.identity),
      ownerArgumentMatched: inspection.ownerArgumentMatched,
    } : null;
  }

  verifyAndTerminate(
    expected: OwnedRuntimeExactIdentity & { ownerTokenArgument: string; launchedAtMs: number },
    timeoutMs: number
  ): Promise<OwnedRuntimeTerminateResult> {
    const workbenchShape: WorkbenchIdentity = {
      pid: expected.pid,
      executablePath: expected.executablePath,
      creationTime: expected.creationTimeFileTime,
      ownerTokenArgument: expected.ownerTokenArgument,
      launchedAtMs: expected.launchedAtMs,
    };
    return this.backend.verifyAndTerminate(workbenchShape, timeoutMs);
  }
}

export interface RuntimeStopPreflight {
  sessionKnown: boolean;
  ready: boolean;
  reserved: boolean;
  activeJobIds: string[];
  cameraLeaseJobIds: string[];
  restorationPendingJobIds: string[];
  reason?: string;
}

export interface OwnedRuntimeObserverGate {
  reserveRuntimeStop(sessionId: string): Promise<RuntimeStopPreflight>;
  releaseRuntimeStop(sessionId: string): Promise<unknown>;
  completeRuntimeStop(sessionId: string): Promise<unknown>;
}

export interface OwnedRuntimeManagerOptions {
  managedRoot: string;
  gamePath: string;
  observerGate: OwnedRuntimeObserverGate;
  projectPath?: string;
  backend?: OwnedRuntimeProcessBackend;
  spawnProcess?: typeof nodeSpawn;
  executableResolver?: () => string;
  clock?: () => number;
  ownerToken?: () => string;
  randomId?: () => string;
  installationRoot?: string;
  inspectionTimeoutMs?: number;
  terminationTimeoutMs?: number;
  lockTimeoutMs?: number;
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
  sessionId: z.string().min(1).max(96),
  // observer_prepare_launch accepts 512 input tokens. Normalization can append
  // six required observer tokens plus -forceUpdate, so preserve that existing
  // boundary in the persisted descriptor.
  arguments: z.array(z.string().max(32_768)).max(519),
  profilePath: z.string().min(1),
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  expiresAt: z.string().datetime(),
  bundleDigest: sha256Schema,
  recordedAt: z.string().datetime(),
  managerInstanceId: z.string().uuid(),
  prepareIdempotencyHash: sha256Schema.optional(),
});
type PreparedDescriptor = z.infer<typeof preparedDescriptorSchema>;

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
  executablePath: z.string().min(1),
  creationTimeFileTime: fileTimeSchema,
  userSid: z.string().min(1),
});

const runtimeReceiptSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  preparedLaunchId: preparedLaunchIdSchema,
  pid: z.number().int().positive(),
  executablePath: z.string().min(1),
  executableFile: executableFileIdentitySchema,
  creationTimeFileTime: fileTimeSchema,
  ownerTokenArgument: z.string().startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX),
  argvSha256: sha256Schema,
  profilePath: z.string().min(1),
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
  restorationProofKind: z.enum(["process_already_exited", "live_stop_reservation", "clean_shutdown_restoration_seal"]),
  restorationProvedAt: z.string().datetime(),
  mcpActor: mcpOwnerSchema,
});
type StopReceipt = z.infer<typeof stopReceiptSchema>;

const stopCompletionSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  completedAt: z.string().datetime(),
  observerCompleted: z.literal(true),
  sessionRevoked: z.boolean(),
});
type StopCompletion = z.infer<typeof stopCompletionSchema>;

const restorationProofSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  runtimeId: runtimeIdSchema,
  sessionId: z.string().min(1).max(96),
  managerInstanceId: z.string().uuid(),
  sealedAt: z.string().datetime(),
  kind: z.enum(["clean_shutdown_restoration_seal", "live_stop_reservation"]),
  stopIdempotencyHash: sha256Schema.optional(),
  activeJobIds: z.tuple([]),
  cameraLeaseJobIds: z.tuple([]),
  restorationPendingJobIds: z.tuple([]),
});
type RestorationProof = z.infer<typeof restorationProofSchema>;

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
  state: z.enum(["pre_spawn", "spawned_unverified", "identity_verified", "cleanup_required", "cleanup_verified", "succeeded"]),
  pid: z.number().int().positive().nullable(),
  creationTimeFileTime: fileTimeSchema.nullable(),
  executablePath: z.string().min(1),
  executableFile: executableFileIdentitySchema,
  ownerTokenArgument: z.string().startsWith(OWNED_RUNTIME_OWNER_ARGUMENT_PREFIX),
  argvSha256: sha256Schema,
  mcpOwner: mcpOwnerSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().max(512).optional(),
});
type PendingStart = z.infer<typeof pendingStartSchema>;

function runtimeIdentity(identity: ExactProcessIdentity): OwnedRuntimeExactIdentity {
  return {
    pid: identity.pid,
    executablePath: identity.executablePath,
    creationTimeFileTime: identity.creationTime,
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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
  if (lengthWithNull > 32_767) {
    throw new OwnedRuntimeError(
      "ARGUMENT_CONFLICT",
      "Prepared arguments exceed the Windows CreateProcess command-line limit"
    );
  }
}

function pathKey(value: string): string {
  const absolute = resolve(value);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function pathsOverlap(left: string, right: string): boolean {
  return isContained(left, right) || isContained(right, left);
}

function assertNoLinkedDirectorySegments(directoryPath: string): void {
  const absolute = resolve(directoryPath);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) break;
    const entry = lstatSync(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new OwnedRuntimeError(
        "STORAGE_UNVERIFIABLE",
        `Owned-runtime storage traverses a link or non-directory: ${current}`
      );
    }
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
  const canonical = realpathSync.native(absolute);
  return canonical;
}

function canonicalDirectoryTarget(directoryPath: string, rejectLinkedSegments: boolean): string {
  const absolute = resolve(directoryPath);
  if (rejectLinkedSegments) assertNoLinkedDirectorySegments(absolute);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", `Owned-runtime storage has no resolvable ancestor: ${absolute}`);
    }
    existing = parent;
  }
  const canonicalAncestor = rejectLinkedSegments
    ? canonicalDirectory(existing, false, true)
    : realpathSync.native(existing);
  if (!lstatSync(canonicalAncestor).isDirectory()) {
    throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", `Configured path has a non-directory ancestor: ${existing}`);
  }
  return resolve(canonicalAncestor, relative(existing, absolute));
}

function canonicalFile(filePath: string, label: string): string {
  const absolute = resolve(filePath);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new OwnedRuntimeError("IDENTITY_UNVERIFIABLE", `${label} is not a regular non-link file`);
  }
  return realpathSync.native(absolute);
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

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled"));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, milliseconds);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
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
  private readonly backend: OwnedRuntimeProcessBackend;
  private readonly spawnProcess: typeof nodeSpawn;
  private readonly clock: () => number;
  private readonly createOwnerToken: () => string;
  private readonly createId: () => string;
  private readonly resolveExecutable: () => string;
  private readonly inspectionTimeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly managedRoot: string;
  private readonly children = new Map<string, ChildProcess>();
  private closing = false;
  private closePromise: Promise<Record<string, unknown>> | null = null;

  constructor(private readonly options: OwnedRuntimeManagerOptions) {
    this.managerInstanceId = randomUUID();
    this.backend = options.backend ?? new WindowsOwnedRuntimeProcessBackend();
    this.spawnProcess = options.spawnProcess ?? nodeSpawn;
    this.clock = options.clock ?? Date.now;
    this.createOwnerToken = options.ownerToken ?? (() => randomBytes(32).toString("base64url"));
    this.createId = options.randomId ?? randomUUID;
    this.resolveExecutable = options.executableResolver ?? (() => resolveGraphicalRuntimeExecutable(options.gamePath));
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS;
    this.terminationTimeoutMs = options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
    for (const [label, value, minimum, maximum] of [
      ["inspection timeout", this.inspectionTimeoutMs, 100, 60_000],
      ["termination timeout", this.terminationTimeoutMs, 100, 5 * 60_000],
      ["lifecycle lock timeout", this.lockTimeoutMs, 100, 60_000],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new OwnedRuntimeError("INVALID_REQUEST", `Owned runtime ${label} is invalid`);
      }
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

  async recordPreparedLaunch(
    input: ObserverLaunchInput,
    prepared: ObserverPreparedLaunch
  ): Promise<string> {
    this.assertOpenForMutation();
    const root = this.ensureStorage();
    const descriptorFingerprint = sha256(JSON.stringify({
      sessionId: prepared.sessionId,
      arguments: prepared.arguments,
      profilePath: prepared.profilePath,
      runtimeKind: input.runtimeKind,
      expiresAt: prepared.expiresAt,
      bundleDigest: prepared.bundleDigest,
    }));
    for (const name of readdirSync(this.directory("prepared"))) {
      const preparedLaunchId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!preparedLaunchIdSchema.safeParse(preparedLaunchId).success) continue;
      const existing = this.readPreparedDescriptor(preparedLaunchId);
      if (existing.sessionId !== prepared.sessionId) continue;
      const existingFingerprint = sha256(JSON.stringify({
        sessionId: existing.sessionId,
        arguments: existing.arguments,
        profilePath: existing.profilePath,
        runtimeKind: existing.runtimeKind,
        expiresAt: existing.expiresAt,
        bundleDigest: existing.bundleDigest,
      }));
      if (existingFingerprint !== descriptorFingerprint) {
        throw new OwnedRuntimeError("ARGUMENT_CONFLICT", "Observer session was reused with a different prepared launch");
      }
      return existing.preparedLaunchId;
    }

    const preparedLaunchId = `pl-${this.createId()}`;
    const descriptor = preparedDescriptorSchema.parse({
      version: STORAGE_VERSION,
      preparedLaunchId,
      sessionId: prepared.sessionId,
      arguments: [...prepared.arguments],
      profilePath: prepared.profilePath,
      runtimeKind: input.runtimeKind,
      expiresAt: prepared.expiresAt,
      bundleDigest: prepared.bundleDigest,
      recordedAt: nowIso(this.clock),
      managerInstanceId: this.managerInstanceId,
      ...(input.idempotencyKey
        ? { prepareIdempotencyHash: sha256(boundedIdempotencyKey(input.idempotencyKey)) }
        : {}),
    });
    this.atomicWrite(root, this.preparedPath(preparedLaunchId), descriptor, true);
    return preparedLaunchId;
  }

  async start(input: OwnedRuntimeStartInput): Promise<OwnedRuntimePublicStatus> {
    this.assertOpenForMutation();
    preparedLaunchIdSchema.parse(input.preparedLaunchId);
    const keyHash = sha256(boundedIdempotencyKey(input.idempotencyKey));
    const requestFingerprint = sha256(JSON.stringify({ preparedLaunchId: input.preparedLaunchId }));
    try {
      return await this.backend.withMachineMutex({
        name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
        timeoutMs: this.lockTimeoutMs,
        action: () => this.startLocked(input.preparedLaunchId, keyHash, requestFingerprint),
      });
    } catch (error) {
      throw this.normalizeError(error, "START_FAILED", "Owned runtime start failed");
    }
  }

  async status(runtimeId: string): Promise<OwnedRuntimePublicStatus> {
    runtimeIdSchema.parse(runtimeId);
    try {
      const receipt = this.readRuntimeReceipt(runtimeId);
      return await this.inspectReceipt(receipt);
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

  async stop(input: OwnedRuntimeStopInput): Promise<OwnedRuntimePublicStatus> {
    this.assertOpenForMutation();
    runtimeIdSchema.parse(input.runtimeId);
    boundedIdempotencyKey(input.idempotencyKey);
    if (!Number.isSafeInteger(input.waitForRestorationMs) || input.waitForRestorationMs < 0 ||
        input.waitForRestorationMs > 5 * 60_000) {
      throw new OwnedRuntimeError("INVALID_REQUEST", "waitForRestorationMs must be from 0 through 300000");
    }
    const keyHash = sha256(input.idempotencyKey);
    const requestFingerprint = sha256(JSON.stringify({
      runtimeId: input.runtimeId,
      waitForRestorationMs: input.waitForRestorationMs,
    }));
    try {
      return await this.backend.withMachineMutex({
        name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
        timeoutMs: this.lockTimeoutMs,
        action: () => this.stopLocked(input, keyHash, requestFingerprint),
      });
    } catch (error) {
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
    this.closing = true;
    this.closePromise ??= this.closeOwnedRuntimes();
    return this.closePromise;
  }

  private async closeOwnedRuntimes(): Promise<Record<string, unknown>> {
    if (!existsSync(this.directory("runtimes"))) return { sealedRuntimeIds: [], busyRuntimeIds: [] };
    try {
      return await this.backend.withMachineMutex({
        name: OWNED_RUNTIME_LIFECYCLE_MUTEX,
        timeoutMs: this.lockTimeoutMs,
        action: async () => {
          const root = this.ensureStorage();
          const sealedRuntimeIds: string[] = [];
          const busyRuntimeIds: string[] = [];
          const errorRuntimes: Array<{ runtimeId: string; reason: string }> = [];
          for (const name of readdirSync(this.directory("runtimes")).sort()) {
            const runtimeId = name.endsWith(".json") ? name.slice(0, -5) : "";
            if (!runtimeIdSchema.safeParse(runtimeId).success) continue;
            let reservedSessionId: string | null = null;
            let sealed = false;
            try {
              const receipt = this.readRuntimeReceipt(runtimeId);
              if (receipt.mcpOwner.managerInstanceId !== this.managerInstanceId ||
                  existsSync(this.stopPath(runtimeId))) continue;
              const status = await this.inspectReceipt(receipt);
              if (status.state !== "running" && status.state !== "stale") continue;
              const preflight = await this.options.observerGate.reserveRuntimeStop(receipt.sessionId);
              if (!preflight.sessionKnown || !preflight.ready || !preflight.reserved) {
                busyRuntimeIds.push(runtimeId);
                continue;
              }
              reservedSessionId = receipt.sessionId;
              const proof = restorationProofSchema.parse({
                version: STORAGE_VERSION,
                runtimeId,
                sessionId: receipt.sessionId,
                managerInstanceId: this.managerInstanceId,
                sealedAt: nowIso(this.clock),
                kind: "clean_shutdown_restoration_seal",
                activeJobIds: [],
                cameraLeaseJobIds: [],
                restorationPendingJobIds: [],
              });
              const existing = this.readOptionalRestorationProof(runtimeId);
              if (existing && (existing.sessionId !== receipt.sessionId ||
                  existing.managerInstanceId !== this.managerInstanceId)) {
                throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Existing restoration proof belongs to another lifecycle");
              }
              if (!existing) this.atomicWrite(root, this.restorationProofPath(runtimeId), proof, true);
              sealed = true;
              sealedRuntimeIds.push(runtimeId);
              // Deliberately retain the reservation until the coordinator closes
              // its private child, preventing a capture from racing the proof.
            } catch (error) {
              errorRuntimes.push({ runtimeId, reason: this.message(error).slice(0, 512) });
              if (reservedSessionId && !sealed) {
                await this.options.observerGate.releaseRuntimeStop(reservedSessionId).catch(() => undefined);
              }
            }
          }
          return { sealedRuntimeIds, busyRuntimeIds, errorRuntimes };
        },
      });
    } catch (error) {
      throw this.normalizeError(error, "SHUTDOWN_SEAL_FAILED", "Owned runtime shutdown sealing failed");
    }
  }

  private async startLocked(
    preparedLaunchId: string,
    keyHash: string,
    requestFingerprint: string
  ): Promise<OwnedRuntimePublicStatus> {
    this.assertOpenForMutation();
    const root = this.ensureStorage();
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
        return this.inspectReceipt(runtime);
      }
      const pending = this.readOptionalPendingStart(existingAttempt.runtimeId);
      if (pending && pending.preparedLaunchId !== preparedLaunchId) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Pending start receipt points at another prepared launch");
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

    const consumptionPath = this.consumptionPath(preparedLaunchId);
    const consumed = this.readOptionalConsumption(preparedLaunchId);
    if (consumed) {
      if (consumed.idempotencyHash === keyHash && consumed.requestFingerprint === requestFingerprint) {
        const runtime = this.readOptionalRuntimeReceipt(consumed.runtimeId);
        if (runtime) {
          if (runtime.preparedLaunchId !== preparedLaunchId) {
            throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Prepared-launch consumption points at another runtime receipt");
          }
          return this.inspectReceipt(runtime);
        }
        throw new OwnedRuntimeError("START_UNVERIFIABLE", "Prepared launch was consumed without a successful receipt");
      }
      throw new OwnedRuntimeError("PREPARED_LAUNCH_CONSUMED", "Prepared launch is one-shot and has already been consumed");
    }

    const runtimeId = `rt-${this.createId()}`;
    const consumedAt = nowIso(this.clock);
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
    const pendingCreatedAt = nowIso(this.clock);
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
      mcpOwner,
      createdAt: pendingCreatedAt,
      updatedAt: pendingCreatedAt,
    });
    this.atomicWrite(root, this.pendingStartPath(runtimeId), pending, true);

    const launchedAtMs = this.clock();
    let child: ChildProcess | null = null;
    let receiptPublished = false;
    try {
      child = this.spawnProcess(executablePath, argumentsArray, {
        cwd: dirname(executablePath),
        detached: false,
        shell: false,
        stdio: "ignore",
        windowsHide: false,
      });
      this.children.set(runtimeId, child);
      pending = this.updatePendingStart(root, pending, {
        state: "spawned_unverified",
        pid: Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0 ? child.pid! : null,
      });
      await this.awaitSpawn(child);
      const identity = await this.inspectSpawned(child, executablePath, ownerTokenArgument);
      const executableFileAfterSpawn = inspectExecutableFile(executablePath);
      if (!executableFilesMatch(executableFile, executableFileAfterSpawn)) {
        throw new OwnedRuntimeError("IDENTITY_MISMATCH", "Graphical runtime executable was replaced during start");
      }
      pending = this.updatePendingStart(root, pending, {
        state: "identity_verified",
        pid: identity.pid,
        creationTimeFileTime: identity.creationTimeFileTime,
      });
      const receipt = runtimeReceiptSchema.parse({
        version: STORAGE_VERSION,
        runtimeId,
        sessionId: descriptor.sessionId,
        preparedLaunchId,
        pid: identity.pid,
        executablePath: identity.executablePath,
        executableFile: executableFileAfterSpawn,
        creationTimeFileTime: identity.creationTimeFileTime,
        ownerTokenArgument,
        argvSha256,
        profilePath: descriptor.profilePath,
        runtimeKind: descriptor.runtimeKind,
        startedAt: new Date(launchedAtMs).toISOString(),
        launchedAtMs,
        preparedExpiresAt: descriptor.expiresAt,
        mcpOwner,
      });
      // This is the first successful ownership publication. Everything above
      // may fail without leaving a successful runtime receipt.
      this.atomicWrite(root, this.runtimePath(runtimeId), receipt, true);
      receiptPublished = true;
      try { pending = this.updatePendingStart(root, pending, { state: "succeeded" }); } catch { /* runtime receipt is authoritative */ }
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
            state: cleanupVerified ? "cleanup_verified" : "cleanup_required",
            lastError: this.message(error).slice(0, 512),
          });
        } catch {
          // Retain the last durable pending state; never manufacture success.
        }
        if (cleanupVerified) this.children.delete(runtimeId);
      }
      throw this.normalizeError(error, "SPAWN_FAILED", "Owned runtime could not be spawned and verified");
    }
  }

  private async stopLocked(
    input: OwnedRuntimeStopInput,
    keyHash: string,
    requestFingerprint: string
  ): Promise<OwnedRuntimePublicStatus> {
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
      await this.ensureStopCompletion(root, receipt);
      if (!existingAttempt) {
        try {
          this.atomicWrite(root, idempotencyPath, idempotencySchema.parse({
            version: STORAGE_VERSION,
            action: "stop",
            keyHash,
            requestFingerprint,
            runtimeId: input.runtimeId,
            state: "succeeded",
            updatedAt: nowIso(this.clock),
          }), true);
        } catch {
          // The immutable stop receipt remains authoritative.
        }
      }
      return this.publicStoppedStatus(receipt, existingStop);
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

    const current = await this.inspectReceipt(receipt);
    if (current.state === "identity_mismatch" || current.state === "unverifiable") {
      throw new OwnedRuntimeError(
        "IDENTITY_UNVERIFIABLE",
        `Owned runtime cannot be terminated because its identity is ${current.state}`,
        { reason: current.reason }
      );
    }
    const mcpActor = await this.currentMcpOwner();
    if (current.state === "exited") {
      const priorProof = this.readOptionalRestorationProof(receipt.runtimeId);
      if (priorProof && (priorProof.sessionId !== receipt.sessionId ||
          priorProof.managerInstanceId !== receipt.mcpOwner.managerInstanceId)) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Runtime restoration proof belongs to another lifecycle");
      }
      const stopped = this.publishStop(
        root,
        receipt,
        keyHash,
        mcpActor,
        "already_exited",
        "pid_absent",
        priorProof?.kind ?? "process_already_exited",
        priorProof?.sealedAt ?? nowIso(this.clock)
      );
      await this.ensureStopCompletion(root, receipt);
      try { this.succeedStopIdempotency(root, idempotencyPath, keyHash, requestFingerprint, input.runtimeId); } catch { /* stop receipt is authoritative */ }
      return this.publicStoppedStatus(receipt, stopped);
    }

    let reservation: { held: boolean; proof: RestorationProof } | null = null;
    let terminated = false;
    let terminationMayHaveOccurred = false;
    try {
      reservation = await this.reserveStopWhenRestored(root, receipt, keyHash, input.waitForRestorationMs, input.signal);
      if (input.signal?.aborted) throw new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled");
      this.assertExecutableFileMatches(receipt);
      const inspection = await this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument);
      if (!inspection) {
        const stopped = this.publishStop(
          root,
          receipt,
          keyHash,
          mcpActor,
          "already_exited",
          "pid_absent",
          reservation.proof.kind,
          reservation.proof.sealedAt
        );
        terminated = true;
        await this.ensureStopCompletion(root, receipt);
        try { this.succeedStopIdempotency(root, idempotencyPath, keyHash, requestFingerprint, input.runtimeId); } catch { /* stop receipt is authoritative */ }
        return this.publicStoppedStatus(receipt, stopped);
      }
      this.assertInspectionMatches(receipt, inspection);
      if (input.signal?.aborted) throw new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled");
      // From this point an exception or timeout may occur after the native
      // helper has issued TerminateProcess. Keep the restoration seal unless
      // the helper returns a refusal that is contractually pre-signal.
      terminationMayHaveOccurred = true;
      const result = await this.backend.verifyAndTerminate({
        pid: receipt.pid,
        executablePath: receipt.executablePath,
        creationTimeFileTime: receipt.creationTimeFileTime,
        ownerTokenArgument: receipt.ownerTokenArgument,
        launchedAtMs: receipt.launchedAtMs,
      }, this.terminationTimeoutMs);
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
      const after = await this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument);
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
      const stopped = this.publishStop(
        root,
        receipt,
        keyHash,
        mcpActor,
        result.kind,
        vacancyProof,
        reservation.proof.kind,
        reservation.proof.sealedAt
      );
      terminated = true;
      this.children.delete(input.runtimeId);
      await this.ensureStopCompletion(root, receipt);
      try { this.succeedStopIdempotency(root, idempotencyPath, keyHash, requestFingerprint, input.runtimeId); } catch { /* stop receipt is authoritative */ }
      return this.publicStoppedStatus(receipt, stopped);
    } finally {
      if (reservation?.held && !terminated && !terminationMayHaveOccurred) {
        let proofInvalidated = true;
        if (existsSync(this.restorationProofPath(receipt.runtimeId))) {
          try {
            unlinkSync(this.restorationProofPath(receipt.runtimeId));
          } catch {
            proofInvalidated = false;
          }
        }
        // Never reopen the session while a durable restoration proof remains.
        if (proofInvalidated) {
          await this.options.observerGate.releaseRuntimeStop(receipt.sessionId).catch(() => undefined);
        }
      }
    }
  }

  private async inspectReceipt(receipt: OwnedRuntimeReceipt): Promise<OwnedRuntimePublicStatus> {
    const stopped = this.readOptionalStopReceipt(receipt.runtimeId);
    if (stopped) {
      if (stopped.sessionId !== receipt.sessionId) {
        return this.publicStatus(receipt, "unverifiable", false, "Stop receipt session does not match the runtime receipt");
      }
      return this.publicStoppedStatus(receipt, stopped);
    }
    let currentOwner: z.infer<typeof mcpOwnerSchema>;
    try {
      currentOwner = await this.currentMcpOwner();
    } catch (error) {
      return this.publicStatus(receipt, "unverifiable", false, `MCP owner identity is unavailable: ${this.message(error)}`);
    }
    if (currentOwner.installationId !== receipt.mcpOwner.installationId ||
        currentOwner.userSid !== receipt.mcpOwner.userSid) {
      return this.publicStatus(receipt, "unverifiable", false, "Lifecycle receipt belongs to a different MCP installation or Windows owner");
    }
    if (currentOwner.managerInstanceId !== receipt.mcpOwner.managerInstanceId) {
      let priorOwner: OwnedRuntimeInspection | null;
      try {
        priorOwner = await this.backend.inspectProcess(receipt.mcpOwner.pid);
      } catch (error) {
        return this.publicStatus(receipt, "unverifiable", false, `Prior MCP owner identity is unavailable: ${this.message(error)}`);
      }
      if (priorOwner && priorOwner.identity.pid === receipt.mcpOwner.pid &&
          pathKey(priorOwner.identity.executablePath) === pathKey(receipt.mcpOwner.executablePath) &&
          priorOwner.identity.creationTimeFileTime === receipt.mcpOwner.creationTimeFileTime) {
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
      inspection = await this.backend.inspectProcess(receipt.pid, receipt.ownerTokenArgument);
    } catch (error) {
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

  private async reserveStopWhenRestored(
    root: string,
    receipt: OwnedRuntimeReceipt,
    keyHash: string,
    waitForRestorationMs: number,
    signal?: AbortSignal
  ): Promise<{ held: boolean; proof: RestorationProof }> {
    const deadline = this.clock() + waitForRestorationMs;
    for (;;) {
      if (signal?.aborted) throw new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled");
      const preflight = await this.options.observerGate.reserveRuntimeStop(receipt.sessionId);
      if (signal?.aborted) {
        if (preflight.reserved) {
          await this.options.observerGate.releaseRuntimeStop(receipt.sessionId).catch(() => undefined);
        }
        throw new OwnedRuntimeError("CANCELLED", "Owned runtime stop was cancelled");
      }
      if (!preflight.sessionKnown) {
        const proof = this.readOptionalRestorationProof(receipt.runtimeId);
        if (proof && proof.sessionId === receipt.sessionId &&
            proof.managerInstanceId === receipt.mcpOwner.managerInstanceId) {
          return { held: false, proof };
        }
        throw new OwnedRuntimeError(
          "SESSION_UNVERIFIABLE",
          "Observer session state is unavailable, so camera restoration cannot be proven"
        );
      }
      if (preflight.ready && preflight.reserved) {
        const proofPath = this.restorationProofPath(receipt.runtimeId);
        const existing = this.readOptionalRestorationProof(receipt.runtimeId);
        if (existing) {
          if (existing.sessionId !== receipt.sessionId ||
              existing.managerInstanceId !== receipt.mcpOwner.managerInstanceId) {
            await this.options.observerGate.releaseRuntimeStop(receipt.sessionId).catch(() => undefined);
            throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Runtime restoration proof is bound to a different lifecycle");
          }
          return { held: true, proof: existing };
        }
        const proof = restorationProofSchema.parse({
          version: STORAGE_VERSION,
          runtimeId: receipt.runtimeId,
          sessionId: receipt.sessionId,
          managerInstanceId: receipt.mcpOwner.managerInstanceId,
          sealedAt: nowIso(this.clock),
          kind: "live_stop_reservation",
          stopIdempotencyHash: keyHash,
          activeJobIds: [],
          cameraLeaseJobIds: [],
          restorationPendingJobIds: [],
        });
        try {
          this.atomicWrite(root, proofPath, proof, true);
        } catch (error) {
          await this.options.observerGate.releaseRuntimeStop(receipt.sessionId).catch(() => undefined);
          throw error;
        }
        return { held: true, proof };
      }
      if (waitForRestorationMs === 0 || this.clock() >= deadline) {
        throw new OwnedRuntimeError(
          "CAMERA_BUSY",
          "Observer runtime still has active capture or camera-restoration work",
          {
            activeJobIds: preflight.activeJobIds,
            cameraLeaseJobIds: preflight.cameraLeaseJobIds,
            restorationPendingJobIds: preflight.restorationPendingJobIds,
          }
        );
      }
      await wait(Math.min(PROCESS_POLL_MS, Math.max(1, deadline - this.clock())), signal);
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
      await wait(PROCESS_POLL_MS);
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
    await Promise.race([exited, wait(5_000)]);
    return exitObserved || child.exitCode !== null || child.signalCode !== null;
  }

  private inspectionMatches(receipt: OwnedRuntimeReceipt, inspection: OwnedRuntimeInspection): boolean {
    return inspection.identity.pid === receipt.pid &&
      pathKey(inspection.identity.executablePath) === pathKey(receipt.executablePath) &&
      inspection.identity.creationTimeFileTime === receipt.creationTimeFileTime &&
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

  private async currentMcpOwner(): Promise<z.infer<typeof mcpOwnerSchema>> {
    const identity = await this.backend.inspectCurrentProcess(process.pid);
    return mcpOwnerSchema.parse({
      installationId: this.installationId,
      managerInstanceId: this.managerInstanceId,
      pid: identity.pid,
      executablePath: identity.executablePath,
      creationTimeFileTime: identity.creationTimeFileTime,
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
    };
  }

  private publishStop(
    root: string,
    receipt: OwnedRuntimeReceipt,
    keyHash: string,
    actor: z.infer<typeof mcpOwnerSchema>,
    termination: "terminated" | "already_exited",
    vacancyProof: StopReceipt["vacancyProof"],
    restorationProofKind: StopReceipt["restorationProofKind"],
    restorationProvedAt: string
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
      mcpActor: actor,
    });
    this.atomicWrite(root, this.stopPath(receipt.runtimeId), stopped, true);
    return stopped;
  }

  private async ensureStopCompletion(
    root: string,
    receipt: OwnedRuntimeReceipt
  ): Promise<StopCompletion> {
    const existing = this.readOptionalStopCompletion(receipt.runtimeId);
    if (existing) {
      if (existing.sessionId !== receipt.sessionId) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Stop completion session does not match its runtime receipt");
      }
      return existing;
    }
    let response: unknown;
    try {
      response = await this.options.observerGate.completeRuntimeStop(receipt.sessionId);
    } catch (error) {
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
    const completion = stopCompletionSchema.parse({
      version: STORAGE_VERSION,
      runtimeId: receipt.runtimeId,
      sessionId: receipt.sessionId,
      completedAt: nowIso(this.clock),
      observerCompleted: true,
      sessionRevoked: result.revoked === true,
    });
    try {
      this.atomicWrite(root, this.stopCompletionPath(receipt.runtimeId), completion, true);
    } catch (error) {
      const raced = this.readOptionalStopCompletion(receipt.runtimeId);
      if (!raced) throw error;
      return raced;
    }
    return completion;
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
    for (const name of [
      "prepared",
      "consumed",
      "pending-starts",
      "runtimes",
      "stops",
      "stop-completions",
      "restoration-proofs",
      "idempotency",
    ]) {
      const directory = canonicalDirectory(join(root, name), true, true);
      if (!isContained(root, directory)) {
        throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Owned-runtime storage escaped its managed root");
      }
    }
    return root;
  }

  private directory(name:
    | "prepared"
    | "consumed"
    | "pending-starts"
    | "runtimes"
    | "stops"
    | "stop-completions"
    | "restoration-proofs"
    | "idempotency"
  ): string {
    return join(this.storageRoot, name);
  }

  private preparedPath(id: string): string { return join(this.directory("prepared"), `${id}.json`); }
  private consumptionPath(id: string): string { return join(this.directory("consumed"), `${id}.json`); }
  private pendingStartPath(id: string): string { return join(this.directory("pending-starts"), `${id}.json`); }
  private runtimePath(id: string): string { return join(this.directory("runtimes"), `${id}.json`); }
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
      PREPARED_DESCRIPTOR_MAX_BYTES
    );
    if (descriptor.preparedLaunchId !== preparedLaunchId) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Prepared-launch descriptor does not match its filename");
    }
    return descriptor;
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
    if (!existsSync(this.runtimePath(runtimeId))) {
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
    return existsSync(this.runtimePath(runtimeId)) ? this.readRuntimeReceipt(runtimeId) : null;
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
    patch: Partial<Pick<PendingStart, "state" | "pid" | "creationTimeFileTime" | "lastError">>
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
    maxBytes = DEFAULT_LIFECYCLE_RECORD_MAX_BYTES
  ): T {
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size < 2 || entry.size > maxBytes) {
        throw new Error("not a bounded regular file");
      }
      return schema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OwnedRuntimeError("RUNTIME_NOT_FOUND", `${label} was not found`);
      }
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", `${label} is invalid: ${this.message(error)}`);
    }
  }

  private readOptionalParsed<T>(path: string, schema: z.ZodType<T>, label: string): T | null {
    if (!existsSync(path)) return null;
    return this.readParsed(path, schema, label);
  }

  private atomicWrite(root: string, target: string, value: unknown, exclusive: boolean): void {
    if (!isContained(root, target)) throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle write escaped managed storage");
    const targetDirectory = canonicalDirectory(dirname(target), false, true);
    if (pathKey(targetDirectory) !== pathKey(dirname(target))) {
      throw new OwnedRuntimeError("STORAGE_UNVERIFIABLE", "Lifecycle write directory changed identity");
    }
    if (exclusive && existsSync(target)) {
      throw new OwnedRuntimeError("STORAGE_CONFLICT", "Lifecycle receipt already exists");
    }
    const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      if (exclusive && existsSync(target)) {
        throw new OwnedRuntimeError("STORAGE_CONFLICT", "Lifecycle receipt appeared concurrently");
      }
      renameSync(temporary, target);
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch { /* best effort for a failed unpublished write */ }
      }
      try { unlinkSync(temporary); } catch { /* best effort for an unpublished temp file */ }
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
    return value
      .replace(/-reforgerForgeOwnerToken=[^\s"']+/gi, "[owner-token-redacted]")
      .slice(0, 512);
  }
}

/** Preserve restoration authority before shutting down the in-memory observer agent. */
export async function closeObserverRuntimeLifecycle(
  manager: Pick<OwnedRuntimeManager, "close">,
  coordinator: { close(): Promise<void> }
): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> | undefined;
  try {
    result = await manager.close();
    return result;
  } finally {
    await coordinator.close();
  }
}
