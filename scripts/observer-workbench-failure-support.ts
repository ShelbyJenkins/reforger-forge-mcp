import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { extname, isAbsolute, win32 } from "node:path";
import type { ExactProcessInspection } from "../src/foundation/exact-process-backend.js";
import {
  WorkbenchNetApiError,
  type WorkbenchNetApiCallOptions,
  type WorkbenchNetApiPort,
} from "../src/workbench/net-api-client.js";

/**
 * These are the only production observer handlers the disposable fixture may
 * fault. Keeping the list narrow prevents this test seam from becoming a
 * general Workbench command-failure switch.
 */
export const WORKBENCH_OBSERVER_HANDLER_NAMES = Object.freeze([
  "EMCP_WB_ObserverPing",
  "EMCP_WB_ObserverSubmit",
  "EMCP_WB_ObserverStatus",
  "EMCP_WB_ObserverCancel",
  "EMCP_WB_ObserverRelease",
] as const);

export type WorkbenchObserverHandlerName =
  typeof WORKBENCH_OBSERVER_HANDLER_NAMES[number];
export type WorkbenchHandlerLossBoundary = "request" | "response";
export type WorkbenchHandlerMatchValue = string | number | boolean | null;

export interface WorkbenchHandlerLossPlan {
  readonly handler: WorkbenchObserverHandlerName;
  readonly boundary: WorkbenchHandlerLossBoundary;
  /**
   * Optional exact scalar subset used to bind the one shot to a particular
   * job/lease request. The wrapper snapshots this object when it is armed.
   */
  readonly matchParams?: Readonly<Record<string, WorkbenchHandlerMatchValue>>;
}

export type WorkbenchHandlerLossCategory =
  | "inactive"
  | "armed"
  | "response_pending"
  | "handler_request_lost"
  | "handler_response_lost"
  | "delegate_failed";

export interface WorkbenchHandlerLossResult {
  readonly category: WorkbenchHandlerLossCategory;
  readonly faultInjected: boolean;
}

export type WorkbenchHandlerLossErrorCategory =
  | "handler_request_lost"
  | "handler_response_lost";

/** A transport failure, never a synthesized observer-handler response. */
export class FixtureWorkbenchHandlerLossError extends WorkbenchNetApiError {
  constructor(public readonly category: WorkbenchHandlerLossErrorCategory) {
    super(
      category === "handler_request_lost"
        ? "The fixture deliberately lost one Workbench observer handler request."
        : "The fixture deliberately lost one Workbench observer handler response.",
      "timeout"
    );
    this.name = "FixtureWorkbenchHandlerLossError";
  }
}

const HANDLER_NAMES = new Set<string>(WORKBENCH_OBSERVER_HANDLER_NAMES);
const MATCH_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_MATCH_FIELDS = 16;
const MAX_MATCH_STRING_LENGTH = 512;

function immutableResult(
  category: WorkbenchHandlerLossCategory,
  faultInjected: boolean
): WorkbenchHandlerLossResult {
  return Object.freeze({ category, faultInjected });
}

function handlerLossError(boundary: WorkbenchHandlerLossBoundary): FixtureWorkbenchHandlerLossError {
  return new FixtureWorkbenchHandlerLossError(
    boundary === "request" ? "handler_request_lost" : "handler_response_lost"
  );
}

function snapshotLossPlan(input: WorkbenchHandlerLossPlan): WorkbenchHandlerLossPlan {
  if (!input || typeof input !== "object" ||
      !HANDLER_NAMES.has(input.handler) ||
      (input.boundary !== "request" && input.boundary !== "response")) {
    throw new TypeError("A one-shot loss requires a known observer handler and request/response boundary.");
  }
  const source = input.matchParams ?? {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Workbench handler match parameters must be a scalar record.");
  }
  const entries = Object.entries(source);
  if (entries.length > MAX_MATCH_FIELDS) {
    throw new TypeError(`Workbench handler matching is limited to ${MAX_MATCH_FIELDS} fields.`);
  }
  const matchParams: Record<string, WorkbenchHandlerMatchValue> = {};
  for (const [key, value] of entries) {
    if (!MATCH_KEY.test(key) ||
        (typeof value !== "string" && typeof value !== "number" &&
          typeof value !== "boolean" && value !== null) ||
        (typeof value === "string" && value.length > MAX_MATCH_STRING_LENGTH) ||
        (typeof value === "number" && !Number.isFinite(value))) {
      throw new TypeError("Workbench handler match parameters must contain bounded scalar fields.");
    }
    matchParams[key] = value;
  }
  return Object.freeze({
    handler: input.handler,
    boundary: input.boundary,
    matchParams: Object.freeze(matchParams),
  });
}

function matchesLossPlan(
  plan: WorkbenchHandlerLossPlan,
  apiFunc: string,
  params: Record<string, unknown>
): boolean {
  if (apiFunc !== plan.handler) return false;
  return Object.entries(plan.matchParams ?? {}).every(([key, expected]) =>
    Object.hasOwn(params, key) && params[key] === expected
  );
}

/**
 * Per-case, fixture-only transport seam.
 *
 * With no armed plan every argument and result is routed through the supplied
 * real port. A request loss rejects before delegation. A response loss first
 * awaits the delegate's real result and then rejects instead of fabricating an
 * adapter payload. The first matching invocation atomically consumes the arm,
 * so concurrent or repeated calls cannot receive the same fault.
 */
export class FixtureOnlyWorkbenchNetApiFaultPort implements WorkbenchNetApiPort {
  private plan: WorkbenchHandlerLossPlan | null = null;
  private armedOnce = false;
  private category: WorkbenchHandlerLossCategory = "inactive";

  constructor(private readonly delegate: WorkbenchNetApiPort) {
    if (!delegate || typeof delegate.call !== "function") {
      throw new TypeError("The fixture fault port requires a Workbench NET API delegate.");
    }
  }

  armOneShotLoss(input: WorkbenchHandlerLossPlan): void {
    if (this.armedOnce) {
      throw new Error("This fixture Workbench NET API port has already armed its one allowed loss.");
    }
    this.plan = snapshotLossPlan(input);
    this.armedOnce = true;
    this.category = "armed";
  }

  result(): WorkbenchHandlerLossResult {
    return immutableResult(
      this.category,
      this.category === "handler_request_lost" || this.category === "handler_response_lost"
    );
  }

  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options?: WorkbenchNetApiCallOptions
  ): Promise<T> {
    const selected = this.plan;
    if (!selected || !matchesLossPlan(selected, apiFunc, params)) {
      return this.delegate.call<T>(apiFunc, params, options);
    }

    // Consume synchronously before any await. If two matching calls are made
    // concurrently, only the invocation that reached this point first faults.
    this.plan = null;
    if (selected.boundary === "request") {
      this.category = "handler_request_lost";
      throw handlerLossError("request");
    }

    this.category = "response_pending";
    try {
      await this.delegate.call<T>(apiFunc, params, options);
    } catch (error) {
      // A delegate transport failure is not evidence that our response-loss
      // injection occurred. Preserve the real error and expose only a safe
      // result category.
      this.category = "delegate_failed";
      throw error;
    }
    this.category = "handler_response_lost";
    throw handlerLossError("response");
  }
}

/** Extract only the safe fixture fault category from a thrown transport error. */
export function extractFixtureWorkbenchHandlerLoss(
  error: unknown
): Readonly<{ category: WorkbenchHandlerLossErrorCategory }> | null {
  return error instanceof FixtureWorkbenchHandlerLossError
    ? Object.freeze({ category: error.category })
    : null;
}

export const WORKBENCH_FAILURE_PNG_MAX_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type WorkbenchPngMutation =
  | "truncated"
  | "crc_corruption"
  | "byte_length_mismatch";

export type WorkbenchPngMutationErrorCategory =
  | "invalid_input"
  | "bound_exceeded"
  | "artifact_unavailable"
  | "artifact_changed"
  | "write_failed"
  | "hook_already_used";

export class WorkbenchPngMutationError extends Error {
  constructor(
    public readonly category: WorkbenchPngMutationErrorCategory,
    message: string
  ) {
    super(message);
    this.name = "WorkbenchPngMutationError";
  }
}

export interface WorkbenchPngMutationOptions {
  /** May lower, but never raise, the reviewed 64 MiB hard limit. */
  readonly maxBytes?: number;
}

export interface WorkbenchArtifactPreValidationInput {
  readonly artifactPath: string;
  /** Stable byte length reported by the real terminal handler response. */
  readonly artifactBytes: number;
}

export interface WorkbenchPngMutationResult {
  readonly mutation: WorkbenchPngMutation;
  readonly originalByteLength: number;
  readonly mutatedByteLength: number;
  readonly byteLengthChanged: boolean;
}

export type WorkbenchArtifactPreValidationHook = (
  input: WorkbenchArtifactPreValidationInput
) => WorkbenchPngMutationResult;

interface PngChunk {
  readonly type: string;
  readonly crcOffset: number;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngMutationError(
  category: WorkbenchPngMutationErrorCategory,
  message: string
): WorkbenchPngMutationError {
  return new WorkbenchPngMutationError(category, message);
}

function mutationLimit(options: WorkbenchPngMutationOptions): number {
  const limit = options.maxBytes ?? WORKBENCH_FAILURE_PNG_MAX_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 45 || limit > WORKBENCH_FAILURE_PNG_MAX_BYTES) {
    throw pngMutationError(
      "bound_exceeded",
      "The Workbench PNG mutation limit must be a safe integer from 45 bytes through 64 MiB."
    );
  }
  return limit;
}

function inspectValidPng(bytes: Buffer, maxBytes: number): readonly PngChunk[] {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > maxBytes) {
    throw pngMutationError("bound_exceeded", "The source PNG is outside the reviewed mutation bound.");
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw pngMutationError("invalid_input", "The source artifact does not have a PNG signature.");
  }

  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) {
      throw pngMutationError("invalid_input", "The source PNG has a truncated chunk.");
    }
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) {
      throw pngMutationError("invalid_input", "The source PNG chunk length exceeds the artifact.");
    }
    const typeOffset = offset + 4;
    const bodyOffset = offset + 8;
    const crcOffset = bodyOffset + length;
    const nextOffset = crcOffset + 4;
    const typeBytes = bytes.subarray(typeOffset, bodyOffset);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw pngMutationError("invalid_input", "The source PNG contains an invalid chunk type.");
    }
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    if (crc32(bytes.subarray(typeOffset, crcOffset)) !== expectedCrc) {
      throw pngMutationError("invalid_input", "The source PNG already contains a corrupt chunk CRC.");
    }

    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) {
        throw pngMutationError("invalid_input", "The source PNG does not begin with one IHDR chunk.");
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      throw pngMutationError("invalid_input", "The source PNG contains more than one IHDR chunk.");
    }
    if (type === "IDAT") sawImageData = true;
    if (type === "IEND") {
      if (length !== 0 || nextOffset !== bytes.length) {
        throw pngMutationError("invalid_input", "The source PNG has an invalid IEND or trailing data.");
      }
      sawEnd = true;
    } else if (sawEnd) {
      throw pngMutationError("invalid_input", "The source PNG contains data after IEND.");
    }

    chunks.push(Object.freeze({ type, crcOffset }));
    offset = nextOffset;
  }
  if (!sawHeader || !sawImageData || !sawEnd) {
    throw pngMutationError("invalid_input", "The source PNG is missing a required chunk.");
  }
  return Object.freeze(chunks);
}

/**
 * Produce one bounded invalid PNG without modifying the supplied buffer.
 * Inputs must first be structurally complete and CRC-valid, which prevents a
 * matrix case from presenting an already-broken file as a completed artifact.
 */
export function mutateWorkbenchPngBytes(
  bytes: Buffer,
  mutation: WorkbenchPngMutation,
  options: WorkbenchPngMutationOptions = {}
): Buffer {
  if (mutation !== "truncated" && mutation !== "crc_corruption" &&
      mutation !== "byte_length_mismatch") {
    throw pngMutationError("invalid_input", "The Workbench PNG mutation kind is unknown.");
  }
  const limit = mutationLimit(options);
  const chunks = inspectValidPng(bytes, limit);
  if (mutation === "truncated") {
    return Buffer.from(bytes.subarray(0, bytes.length - 1));
  }
  if (mutation === "byte_length_mismatch") {
    if (bytes.length >= limit) {
      throw pngMutationError("bound_exceeded", "The byte-length mutation would exceed its bound.");
    }
    return Buffer.concat([bytes, Buffer.from([0])], bytes.length + 1);
  }

  const imageData = chunks.find((chunk) => chunk.type === "IDAT");
  if (!imageData) {
    throw pngMutationError("invalid_input", "The source PNG has no image-data CRC to corrupt.");
  }
  const result = Buffer.from(bytes);
  result[imageData.crcOffset] = result[imageData.crcOffset]! ^ 0x01;
  return result;
}

function sameOpenedFile(
  before: Stats,
  opened: Stats
): boolean {
  return before.dev === opened.dev && before.ino === opened.ino;
}

function writeEntireFile(descriptor: number, bytes: Buffer): void {
  let written = 0;
  while (written < bytes.length) {
    const count = writeSync(descriptor, bytes, written, bytes.length - written, written);
    if (count <= 0) throw new Error("zero-byte write");
    written += count;
  }
  ftruncateSync(descriptor, bytes.length);
  fsyncSync(descriptor);
}

/** Mutate the exact regular PNG named by a real terminal handler response. */
export function mutateWorkbenchPngArtifact(
  input: WorkbenchArtifactPreValidationInput,
  mutation: WorkbenchPngMutation,
  options: WorkbenchPngMutationOptions = {}
): WorkbenchPngMutationResult {
  const limit = mutationLimit(options);
  if (!input || typeof input !== "object" ||
      typeof input.artifactPath !== "string" ||
      !isAbsolute(input.artifactPath) || input.artifactPath.length > 32_767 ||
      extname(input.artifactPath).toLowerCase() !== ".png" ||
      !Number.isSafeInteger(input.artifactBytes) || input.artifactBytes < 45 ||
      input.artifactBytes > limit) {
    throw pngMutationError("invalid_input", "The pre-validation artifact description is invalid.");
  }

  let before: Stats;
  try {
    const inspected = lstatSync(input.artifactPath);
    if (!inspected) {
      throw pngMutationError("artifact_unavailable", "The pre-validation artifact is unavailable.");
    }
    before = inspected;
  } catch {
    throw pngMutationError("artifact_unavailable", "The pre-validation artifact is unavailable.");
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw pngMutationError("invalid_input", "The pre-validation artifact is not a regular file.");
  }
  if (before.size !== input.artifactBytes) {
    throw pngMutationError("artifact_changed", "The artifact length changed before fault injection.");
  }

  let descriptor: number;
  try {
    descriptor = openSync(input.artifactPath, "r+");
  } catch {
    throw pngMutationError("artifact_unavailable", "The pre-validation artifact could not be opened.");
  }

  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameOpenedFile(before, opened) || opened.size !== input.artifactBytes) {
      throw pngMutationError("artifact_changed", "The artifact identity changed before fault injection.");
    }
    const original = readFileSync(descriptor);
    if (original.length !== input.artifactBytes) {
      throw pngMutationError("artifact_changed", "The artifact changed while fault injection was prepared.");
    }
    const mutated = mutateWorkbenchPngBytes(original, mutation, { maxBytes: limit });
    try {
      writeEntireFile(descriptor, mutated);
    } catch {
      throw pngMutationError("write_failed", "The artifact fault could not be written completely.");
    }
    if (fstatSync(descriptor).size !== mutated.length) {
      throw pngMutationError("write_failed", "The artifact fault length could not be verified.");
    }
    return Object.freeze({
      mutation,
      originalByteLength: original.length,
      mutatedByteLength: mutated.length,
      byteLengthChanged: original.length !== mutated.length,
    });
  } catch (error) {
    if (error instanceof WorkbenchPngMutationError) throw error;
    throw pngMutationError("artifact_unavailable", "The artifact could not be inspected for fault injection.");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The mutation result is still verified through the open descriptor.
      // Cleanup of a failed close remains the operating system's responsibility.
    }
  }
}

/** A synchronous one-shot callback suitable for an adapter pre-validation seam. */
export function createOneShotWorkbenchPngArtifactHook(
  mutation: WorkbenchPngMutation,
  options: WorkbenchPngMutationOptions = {}
): WorkbenchArtifactPreValidationHook {
  // Validate configuration before a capture can reach terminal completion.
  mutationLimit(options);
  if (mutation !== "truncated" && mutation !== "crc_corruption" &&
      mutation !== "byte_length_mismatch") {
    throw pngMutationError("invalid_input", "The Workbench PNG mutation kind is unknown.");
  }
  let used = false;
  return (input) => {
    if (used) {
      throw pngMutationError("hook_already_used", "The Workbench PNG mutation hook is one-shot.");
    }
    used = true;
    return mutateWorkbenchPngArtifact(input, mutation, options);
  };
}

export type WorkbenchDecoyIdentityCategory =
  | "unchanged"
  | "before_absent"
  | "after_absent"
  | "before_identity_invalid"
  | "after_identity_invalid"
  | "before_owner_unverified"
  | "after_owner_unverified"
  | "pid_changed"
  | "executable_path_changed"
  | "creation_time_changed";

export interface WorkbenchDecoyIdentityResult {
  readonly category: WorkbenchDecoyIdentityCategory;
  readonly identityUnchanged: boolean;
}

interface ComparableIdentity {
  readonly pid: number;
  readonly executablePath: string;
  readonly creationTime: string;
}

function normalizeWindowsExecutablePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_767 ||
      value.includes("\0")) return null;
  let candidate = value;
  if (/^\\\\\?\\UNC\\/i.test(candidate)) candidate = `\\\\${candidate.slice(8)}`;
  else if (/^\\\\\?\\/.test(candidate)) candidate = candidate.slice(4);
  if (!win32.isAbsolute(candidate)) return null;
  return win32.normalize(candidate).toLowerCase();
}

function positiveFileTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return false;
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function comparableIdentity(value: unknown): ComparableIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const executablePath = normalizeWindowsExecutablePath(candidate.executablePath);
  if (!Number.isSafeInteger(candidate.pid) || (candidate.pid as number) <= 0 ||
      !executablePath || !positiveFileTime(candidate.creationTime)) return null;
  return {
    pid: candidate.pid as number,
    executablePath,
    creationTime: candidate.creationTime,
  };
}

function decoyResult(category: WorkbenchDecoyIdentityCategory): WorkbenchDecoyIdentityResult {
  return Object.freeze({ category, identityUnchanged: category === "unchanged" });
}

/**
 * Compare two exact-process inspections without returning any identity field.
 * Both sides must independently prove the unique owner argument.
 */
export function compareWorkbenchDecoyIdentity(
  before: ExactProcessInspection | null,
  after: ExactProcessInspection | null
): WorkbenchDecoyIdentityResult {
  if (before === null) return decoyResult("before_absent");
  if (after === null) return decoyResult("after_absent");
  const beforeIdentity = comparableIdentity(before.identity);
  if (!beforeIdentity) return decoyResult("before_identity_invalid");
  const afterIdentity = comparableIdentity(after.identity);
  if (!afterIdentity) return decoyResult("after_identity_invalid");
  if (before.ownerArgumentMatched !== true) return decoyResult("before_owner_unverified");
  if (after.ownerArgumentMatched !== true) return decoyResult("after_owner_unverified");
  if (beforeIdentity.pid !== afterIdentity.pid) return decoyResult("pid_changed");
  if (beforeIdentity.executablePath !== afterIdentity.executablePath) {
    return decoyResult("executable_path_changed");
  }
  if (beforeIdentity.creationTime !== afterIdentity.creationTime) {
    return decoyResult("creation_time_changed");
  }
  return decoyResult("unchanged");
}
