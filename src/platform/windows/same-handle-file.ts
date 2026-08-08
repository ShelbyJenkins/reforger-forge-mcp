import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasUsableFileIdentity,
  type BigIntFileIdentity,
} from "../../foundation/file-identity.js";

export const WINDOWS_SAME_HANDLE_FILE_SCHEMA_VERSION = 1;
export const WINDOWS_SAME_HANDLE_FILE_MAXIMUM_BYTES = 64 * 1024 * 1024;
export const WINDOWS_SAME_HANDLE_FILE_TIMEOUT_MS = 30_000;

export type WindowsSameHandleFileErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_REQUEST"
  | "HELPER_UNAVAILABLE"
  | "HELPER_TIMEOUT"
  | "HELPER_FAILURE"
  | "MALFORMED_PROTOCOL"
  | "OPEN_FAILED"
  | "NOT_REGULAR_FILE"
  | "REPARSE_POINT"
  | "FINAL_PATH_UNAVAILABLE"
  | "PATH_MISMATCH"
  | "HANDLE_PATH_MISMATCH"
  | "IDENTITY_UNAVAILABLE"
  | "OVERSIZE"
  | "CHANGED";

const NATIVE_REFUSAL_CODES = new Set<WindowsSameHandleFileErrorCode>([
  "INVALID_REQUEST",
  "HELPER_FAILURE",
  "OPEN_FAILED",
  "NOT_REGULAR_FILE",
  "REPARSE_POINT",
  "FINAL_PATH_UNAVAILABLE",
  "PATH_MISMATCH",
  "HANDLE_PATH_MISMATCH",
  "IDENTITY_UNAVAILABLE",
  "OVERSIZE",
  "CHANGED",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9]\d*$/;
const NONNEGATIVE_DECIMAL = /^\d+$/;
const MAXIMUM_PROTOCOL_OVERHEAD_BYTES = 256 * 1024;

export class WindowsSameHandleFileError extends Error {
  constructor(
    public readonly code: WindowsSameHandleFileErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WindowsSameHandleFileError";
  }
}

export interface WindowsSameHandleFileRead {
  readonly finalPath: string;
  /** Node-compatible BY_HANDLE_FILE_INFORMATION fields from the verified handle. */
  readonly device: string;
  readonly inode: string;
  /** Complete FILE_ID_INFO pair, retained as positive native proof. */
  readonly volumeIdentity: string;
  readonly fileId: string;
  readonly byteLength: number;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
  readonly birthNanoseconds: string;
  readonly sha256: string;
  readonly bytes?: Buffer;
}

export interface WindowsSameHandleFileRequest {
  readonly path: string;
  readonly maximumBytes: number;
  readonly includeBytes: boolean;
  readonly expectedPathIdentity: Readonly<BigIntFileIdentity>;
  readonly expectedByteLength: number;
  readonly expectedModifiedNanoseconds: string;
  readonly expectedChangedNanoseconds: string;
  readonly expectedBirthNanoseconds: string;
}

export interface ReadWindowsSameHandleFileOptions {
  readonly maximumBytes: number;
  readonly includeBytes: boolean;
  /** @internal Deterministic replacement checkpoint; production callers omit it. */
  readonly beforeOpen?: () => void;
  /** @internal Deterministic unavailable-identity adapter; production callers omit it. */
  readonly fileIdentity?: (
    identity: Readonly<BigIntFileIdentity>,
  ) => BigIntFileIdentity;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requestError(message: string): WindowsSameHandleFileError {
  return new WindowsSameHandleFileError("INVALID_REQUEST", message);
}

function validateRequest(request: WindowsSameHandleFileRequest): void {
  if (typeof request.path !== "string" || !isAbsolute(request.path) ||
      request.path.length > 32_768 || /[\0\r\n]/.test(request.path)) {
    throw requestError("Windows same-handle reading requires one bounded absolute path.");
  }
  if (!Number.isSafeInteger(request.maximumBytes) || request.maximumBytes <= 0 ||
      request.maximumBytes > WINDOWS_SAME_HANDLE_FILE_MAXIMUM_BYTES) {
    throw requestError(
      `Windows same-handle reading requires a 1..${WINDOWS_SAME_HANDLE_FILE_MAXIMUM_BYTES} byte bound.`,
    );
  }
  if (typeof request.includeBytes !== "boolean") {
    throw requestError("Windows same-handle reading requires an explicit byte-retention policy.");
  }
  if (!hasUsableFileIdentity(request.expectedPathIdentity)) {
    throw new WindowsSameHandleFileError(
      "IDENTITY_UNAVAILABLE",
      "The pre-open path has no usable device and file identity.",
    );
  }
  if (!Number.isSafeInteger(request.expectedByteLength) || request.expectedByteLength < 0 ||
      request.expectedByteLength > request.maximumBytes ||
      !NONNEGATIVE_DECIMAL.test(request.expectedModifiedNanoseconds) ||
      !NONNEGATIVE_DECIMAL.test(request.expectedChangedNanoseconds) ||
      !NONNEGATIVE_DECIMAL.test(request.expectedBirthNanoseconds)) {
    throw requestError("Windows same-handle reading requires one complete bounded pre-open snapshot.");
  }
}

function helperPath(): string {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(packageRoot, "scripts", "windows", "same-handle-file-read.ps1");
}

function windowsPowerShellPath(): string {
  // A copied Windows Worker environment can expose the canonical variable
  // only as `SYSTEMROOT`; unlike the main process object, lookup there is
  // case-sensitive. Accept both spellings, then apply the same strict bound.
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !isAbsolute(systemRoot) ||
      systemRoot.length > 1_024 || /[\0\r\n]/u.test(systemRoot)) {
    throw new WindowsSameHandleFileError(
      "HELPER_UNAVAILABLE",
      "Windows same-handle reading requires an absolute bounded SystemRoot.",
    );
  }
  return join(
    resolve(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function boundedHelperMessage(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 512)
    : "Windows same-handle evidence collection refused the file.";
}

function positiveDecimal(value: unknown): string | null {
  return typeof value === "string" && POSITIVE_DECIMAL.test(value) ? value : null;
}

function nonnegativeDecimal(value: unknown): string | null {
  return typeof value === "string" && NONNEGATIVE_DECIMAL.test(value) ? value : null;
}

/**
 * Validate the native helper protocol independently of process execution.
 * Exported so deterministic tests can prove every fail-closed field without
 * pretending that Node path stats are a Windows handle-final-path primitive.
 */
export function validateWindowsSameHandleFileProtocol(
  value: unknown,
  request: WindowsSameHandleFileRequest,
): WindowsSameHandleFileRead {
  validateRequest(request);
  if (!plainRecord(value) || value.schemaVersion !== WINDOWS_SAME_HANDLE_FILE_SCHEMA_VERSION ||
      typeof value.ok !== "boolean" || typeof value.status !== "string") {
    throw new WindowsSameHandleFileError(
      "MALFORMED_PROTOCOL",
      "Windows same-handle helper returned an incomplete protocol response.",
    );
  }
  if (!value.ok || value.status !== "verified") {
    const code = typeof value.code === "string" &&
        NATIVE_REFUSAL_CODES.has(value.code as WindowsSameHandleFileErrorCode)
      ? value.code as WindowsSameHandleFileErrorCode
      : "HELPER_FAILURE";
    throw new WindowsSameHandleFileError(code, boundedHelperMessage(value.message));
  }
  if (value.handleIdentityStable !== true || value.handlePathStable !== true ||
      value.pathHandleMatched !== true || value.reparseTraversal !== false) {
    throw new WindowsSameHandleFileError(
      "MALFORMED_PROTOCOL",
      "Windows same-handle helper did not return complete positive handle evidence.",
    );
  }

  const finalPath = typeof value.finalPath === "string" && isAbsolute(value.finalPath) &&
      value.finalPath.length <= 32_768 && !/[\0\r\n]/.test(value.finalPath)
    ? value.finalPath
    : null;
  if (finalPath === null) {
    throw new WindowsSameHandleFileError(
      "FINAL_PATH_UNAVAILABLE",
      "Windows same-handle helper did not return a usable final handle path.",
    );
  }
  if (resolve(finalPath) !== resolve(request.path)) {
    throw new WindowsSameHandleFileError(
      "PATH_MISMATCH",
      "The final Windows handle path does not match the requested canonical path.",
    );
  }

  const device = positiveDecimal(value.device);
  const inode = positiveDecimal(value.inode);
  const pathDevice = positiveDecimal(value.pathDevice);
  const pathInode = positiveDecimal(value.pathInode);
  if (device === null || inode === null || pathDevice === null || pathInode === null) {
    throw new WindowsSameHandleFileError(
      "IDENTITY_UNAVAILABLE",
      "Windows same-handle helper did not return complete nonzero file identity.",
    );
  }
  if (BigInt(pathDevice) !== request.expectedPathIdentity.dev ||
      BigInt(pathInode) !== request.expectedPathIdentity.ino) {
    throw new WindowsSameHandleFileError(
      "HANDLE_PATH_MISMATCH",
      "The Windows read handle does not match the pre-open path identity.",
    );
  }

  const byteLength = value.byteLength;
  const modifiedNanoseconds = nonnegativeDecimal(value.modifiedNanoseconds);
  const changedNanoseconds = nonnegativeDecimal(value.changedNanoseconds);
  const birthNanoseconds = nonnegativeDecimal(value.birthNanoseconds);
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0 ||
      (byteLength as number) > request.maximumBytes || modifiedNanoseconds === null ||
      changedNanoseconds === null || birthNanoseconds === null ||
      typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) {
    throw new WindowsSameHandleFileError(
      "MALFORMED_PROTOCOL",
      "Windows same-handle helper returned invalid bounded file evidence.",
    );
  }
  if (byteLength !== request.expectedByteLength ||
      modifiedNanoseconds !== request.expectedModifiedNanoseconds ||
      changedNanoseconds !== request.expectedChangedNanoseconds ||
      birthNanoseconds !== request.expectedBirthNanoseconds) {
    throw new WindowsSameHandleFileError(
      "HANDLE_PATH_MISMATCH",
      "The Windows read handle does not match the complete pre-open path snapshot.",
    );
  }

  let bytes: Buffer | undefined;
  if (request.includeBytes) {
    if (typeof value.bytesBase64 !== "string" ||
        value.bytesBase64.length > Math.ceil(request.maximumBytes / 3) * 4 + 4) {
      throw new WindowsSameHandleFileError(
        "MALFORMED_PROTOCOL",
        "Windows same-handle helper omitted the requested bounded file bytes.",
      );
    }
    bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64 || bytes.length !== byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== value.sha256) {
      throw new WindowsSameHandleFileError(
        "MALFORMED_PROTOCOL",
        "Windows same-handle helper bytes do not match its handle evidence.",
      );
    }
  } else if (value.bytesBase64 !== null) {
    throw new WindowsSameHandleFileError(
      "MALFORMED_PROTOCOL",
      "Windows same-handle helper returned unrequested file bytes.",
    );
  }

  return {
    finalPath,
    device: pathDevice,
    inode: pathInode,
    volumeIdentity: device,
    fileId: inode,
    byteLength: byteLength as number,
    modifiedNanoseconds,
    changedNanoseconds,
    birthNanoseconds,
    sha256: value.sha256,
    ...(bytes === undefined ? {} : { bytes }),
  };
}

function parseHelperOutput(output: string): unknown {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new WindowsSameHandleFileError(
      "MALFORMED_PROTOCOL",
      "Windows same-handle helper returned an invalid response count.",
    );
  }
  try {
    return JSON.parse(lines[0]);
  } catch (error) {
    throw new WindowsSameHandleFileError(
      "MALFORMED_PROTOCOL",
      "Windows same-handle helper returned malformed JSON.",
      { cause: error },
    );
  }
}

/**
 * Read and attest one bounded Windows file through the same native OS handle.
 *
 * Node intentionally exposes a numeric descriptor rather than the Windows
 * HANDLE required by GetFinalPathNameByHandleW. The bundled helper therefore
 * owns the HANDLE, computes the digest/bytes through it, and returns a strict
 * bounded protocol. Any unavailable helper or incomplete proof is a refusal.
 */
export function readWindowsFileThroughVerifiedHandle(
  request: WindowsSameHandleFileRequest,
): WindowsSameHandleFileRead {
  validateRequest(request);
  if (process.platform !== "win32") {
    throw new WindowsSameHandleFileError(
      "UNSUPPORTED_PLATFORM",
      "Windows same-handle file reading is available only on Windows.",
    );
  }

  const maximumOutputBytes = request.includeBytes
    ? Math.ceil(request.maximumBytes / 3) * 4 + MAXIMUM_PROTOCOL_OVERHEAD_BYTES
    : MAXIMUM_PROTOCOL_OVERHEAD_BYTES;
  const result = spawnSync(windowsPowerShellPath(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", helperPath(),
    "-LiteralPath", request.path,
    "-MaximumBytes", String(request.maximumBytes),
    "-IncludeBytes", String(request.includeBytes),
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: WINDOWS_SAME_HANDLE_FILE_TIMEOUT_MS,
    maxBuffer: maximumOutputBytes,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? "HELPER_TIMEOUT"
      : "HELPER_UNAVAILABLE";
    throw new WindowsSameHandleFileError(
      code,
      code === "HELPER_TIMEOUT"
        ? "Windows same-handle helper exceeded its fixed deadline."
        : "Windows same-handle helper could not be executed.",
      { cause: result.error },
    );
  }
  const protocol = parseHelperOutput(result.stdout);
  const protocolSuccess = plainRecord(protocol) && protocol.ok === true && protocol.status === "verified";
  const protocolRefusal = plainRecord(protocol) && protocol.ok === false && protocol.status === "refused";
  if (result.signal !== null || (result.stderr ?? "").length !== 0 ||
      (protocolSuccess && result.status !== 0) || (protocolRefusal && result.status !== 2) ||
      (!protocolSuccess && !protocolRefusal)) {
    throw new WindowsSameHandleFileError(
      "HELPER_FAILURE",
      "Windows same-handle helper process status contradicts its bounded protocol.",
    );
  }
  try {
    const read = validateWindowsSameHandleFileProtocol(protocol, request);
    return read;
  } catch (error) {
    if (error instanceof WindowsSameHandleFileError) throw error;
    throw new WindowsSameHandleFileError(
      "HELPER_FAILURE",
      "Windows same-handle helper response could not be validated.",
      { cause: error },
    );
  }
}

/**
 * Capture the pre-open namespace snapshot and bind it to the native read
 * handle. This is the reusable entry point for callers that do not already
 * hold a typed pre-open snapshot.
 */
export function readWindowsSameHandleFile(
  path: string,
  options: ReadWindowsSameHandleFileOptions,
): WindowsSameHandleFileRead {
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes <= 0 ||
      options.maximumBytes > WINDOWS_SAME_HANDLE_FILE_MAXIMUM_BYTES ||
      typeof options.includeBytes !== "boolean") {
    throw requestError("Windows same-handle file options are outside their fixed bounds.");
  }
  let initial;
  try {
    initial = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new WindowsSameHandleFileError(
      "OPEN_FAILED",
      "The Windows evidence path cannot be inspected.",
      { cause: error },
    );
  }
  if (initial.isSymbolicLink()) {
    throw new WindowsSameHandleFileError(
      "REPARSE_POINT",
      "The Windows evidence path is a symbolic link or reparse point.",
    );
  }
  if (!initial.isFile()) {
    throw new WindowsSameHandleFileError(
      "NOT_REGULAR_FILE",
      "The Windows evidence path is not a regular file.",
    );
  }
  if (initial.size > BigInt(options.maximumBytes)) {
    throw new WindowsSameHandleFileError(
      "OVERSIZE",
      "The Windows evidence path exceeds its byte bound.",
    );
  }
  const expectedPathIdentity = options.fileIdentity?.({
    dev: initial.dev,
    ino: initial.ino,
  }) ?? initial;
  options.beforeOpen?.();
  try {
    return readWindowsFileThroughVerifiedHandle({
      path,
      maximumBytes: options.maximumBytes,
      includeBytes: options.includeBytes,
      expectedPathIdentity,
      expectedByteLength: Number(initial.size),
      expectedModifiedNanoseconds: initial.mtimeNs.toString(),
      expectedChangedNanoseconds: initial.ctimeNs.toString(),
      expectedBirthNanoseconds: initial.birthtimeNs.toString(),
    });
  } catch (error) {
    if (error instanceof WindowsSameHandleFileError &&
        error.code === "HANDLE_PATH_MISMATCH") {
      throw new WindowsSameHandleFileError(
        "CHANGED",
        "The Windows evidence path changed between inspection and native open.",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Re-read one path and require exact equality with a prior native-handle proof. */
export function revalidateWindowsSameHandleFile(
  path: string,
  expected: WindowsSameHandleFileRead,
  maximumBytes: number,
): WindowsSameHandleFileRead {
  const current = readWindowsSameHandleFile(path, {
    maximumBytes,
    includeBytes: false,
  });
  if (current.finalPath !== expected.finalPath ||
      current.device !== expected.device || current.inode !== expected.inode ||
      current.volumeIdentity !== expected.volumeIdentity || current.fileId !== expected.fileId ||
      current.byteLength !== expected.byteLength ||
      current.modifiedNanoseconds !== expected.modifiedNanoseconds ||
      current.changedNanoseconds !== expected.changedNanoseconds ||
      current.birthNanoseconds !== expected.birthNanoseconds ||
      current.sha256 !== expected.sha256) {
    throw new WindowsSameHandleFileError(
      "CHANGED",
      "The Windows evidence file no longer matches its prior same-handle proof.",
    );
  }
  return current;
}
