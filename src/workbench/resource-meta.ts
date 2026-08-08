import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { resolve } from "node:path";
import { sameUsableFileIdentity } from "../foundation/file-identity.js";
import {
  readWindowsFileThroughVerifiedHandle,
  WindowsSameHandleFileError,
  WINDOWS_SAME_HANDLE_FILE_MAXIMUM_BYTES,
  type WindowsSameHandleFileRead,
} from "../platform/windows/same-handle-file.js";

export const RESOURCE_META_MAXIMUM_BYTES = 256 * 1024;

export type ResourceMetaErrorCode =
  | "MISSING"
  | "UNREADABLE"
  | "OVERSIZE"
  | "MALFORMED";

/** A bounded, typed failure while reading one Workbench resource sidecar. */
export class ResourceMetaError extends Error {
  constructor(
    public readonly code: ResourceMetaErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResourceMetaError";
  }
}

export interface ResourceMetaFileEvidence {
  readonly byteLength: number;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  /** Complete FILE_ID_INFO volume identity; on non-Windows this equals device. */
  readonly volumeIdentity: string;
  /** Complete unsigned FILE_ID_INFO identifier; on non-Windows this equals inode. */
  readonly fileId: string;
  readonly modifiedNanoseconds: string;
  readonly changedNanoseconds: string;
  readonly birthNanoseconds: string;
}

export interface ResourceMetaRecord {
  readonly guid: string;
  readonly evidence: ResourceMetaFileEvidence;
}

export interface ReadResourceMetaOptions {
  readonly maximumBytes?: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function sameStableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameUsableFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs;
}

function evidenceFrom(stat: BigIntStats, sha256: string): ResourceMetaFileEvidence {
  return Object.freeze({
    byteLength: Number(stat.size),
    sha256,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    volumeIdentity: stat.dev.toString(),
    fileId: stat.ino.toString(),
    modifiedNanoseconds: stat.mtimeNs.toString(),
    changedNanoseconds: stat.ctimeNs.toString(),
    birthNanoseconds: stat.birthtimeNs.toString(),
  });
}

function windowsEvidenceFrom(read: WindowsSameHandleFileRead): ResourceMetaFileEvidence {
  return Object.freeze({
    byteLength: read.byteLength,
    sha256: read.sha256,
    device: read.device,
    inode: read.inode,
    volumeIdentity: read.volumeIdentity,
    fileId: read.fileId,
    modifiedNanoseconds: read.modifiedNanoseconds,
    changedNanoseconds: read.changedNanoseconds,
    birthNanoseconds: read.birthNanoseconds,
  });
}

function validateMaximumBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 ||
      value > WINDOWS_SAME_HANDLE_FILE_MAXIMUM_BYTES) {
    throw new TypeError(
      `Resource metadata byte limit must be a positive safe integer no greater than ${WINDOWS_SAME_HANDLE_FILE_MAXIMUM_BYTES}.`,
    );
  }
}

function malformed(path: string, reason: string): ResourceMetaError {
  return new ResourceMetaError(
    "MALFORMED",
    `Workbench resource metadata is malformed (${reason}): ${path}`,
  );
}

/**
 * Parse the top-level Workbench resource `Name` field.
 *
 * A line containing some other GUID is deliberately irrelevant. The resource
 * field must be a direct child of `MetaFileClass`, and there must be exactly
 * one such field. Its stored path remains informational.
 */
export function parseResourceMetaGuid(text: string, path = "<resource metadata>"): string {
  if (typeof text !== "string") throw new TypeError("Resource metadata text must be a string.");
  const normalized = text.replace(/^\uFEFF/, "");
  const header = /^\s*MetaFileClass[ \t]*\{/.exec(normalized);
  if (!header) throw malformed(path, "missing MetaFileClass root");

  const fields: string[] = [];
  let depth = 0;
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let rootOpened = false;
  let rootClosed = false;
  let lineStart = 0;
  let lineDepth = 0;

  const inspectLine = (end: number): void => {
    if (lineDepth !== 1 || rootClosed) return;
    const line = normalized.slice(lineStart, end).replace(/\r$/, "");
    const match = /^[ \t]*Name[ \t]+"\{([0-9A-Fa-f]{16})\}([^"\r\n]*)"[ \t]*$/.exec(line);
    if (!match) return;
    if (match[2].length === 0 || /[\0-\x1F]/.test(match[2])) {
      throw malformed(path, "invalid stored resource path");
    }
    fields.push(match[1].toUpperCase());
  };

  for (let index = 0; index <= normalized.length; index += 1) {
    const character = normalized[index] ?? "\n";
    const next = normalized[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        inspectLine(index);
        lineStart = index + 1;
        lineDepth = depth;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      if (character === "\n") {
        inspectLine(index);
        lineStart = index + 1;
        lineDepth = depth;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quote = false;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    } else if (character === "\"") {
      quote = true;
    } else if (character === "{") {
      depth += 1;
      rootOpened = true;
    } else if (character === "}") {
      depth -= 1;
      if (depth < 0) throw malformed(path, "unbalanced braces");
      if (rootOpened && depth === 0) rootClosed = true;
    }

    if (character === "\n") {
      inspectLine(index);
      lineStart = index + 1;
      lineDepth = depth;
    }
  }

  if (quote || blockComment || depth !== 0) throw malformed(path, "unterminated structure");
  if (fields.length !== 1) {
    throw malformed(path, fields.length === 0
      ? "missing resource Name field"
      : "multiple resource Name fields");
  }
  return fields[0];
}

/** Read and attest one resource sidecar without reading past its fixed bound. */
export function readResourceMeta(
  metaPath: string,
  options: ReadResourceMetaOptions = {},
): ResourceMetaRecord {
  if (typeof metaPath !== "string" || metaPath.length === 0) {
    throw new TypeError("Resource metadata path must be a nonempty string.");
  }
  const maximumBytes = options.maximumBytes ?? RESOURCE_META_MAXIMUM_BYTES;
  validateMaximumBytes(maximumBytes);

  let initial: BigIntStats;
  try {
    initial = lstatSync(metaPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ResourceMetaError("MISSING", `Workbench resource metadata is missing: ${metaPath}`);
    }
    throw new ResourceMetaError(
      "UNREADABLE",
      `Workbench resource metadata cannot be inspected: ${metaPath}`,
      { cause: error },
    );
  }
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new ResourceMetaError(
      "UNREADABLE",
      `Workbench resource metadata is not a regular non-link file: ${metaPath}`,
    );
  }
  if (initial.size > BigInt(maximumBytes)) {
    throw new ResourceMetaError(
      "OVERSIZE",
      `Workbench resource metadata exceeds its ${maximumBytes}-byte limit: ${metaPath}`,
    );
  }

  if (process.platform === "win32") {
    let read: WindowsSameHandleFileRead;
    try {
      read = readWindowsFileThroughVerifiedHandle({
        path: resolve(metaPath),
        maximumBytes,
        includeBytes: true,
        expectedPathIdentity: initial,
        expectedByteLength: Number(initial.size),
        expectedModifiedNanoseconds: initial.mtimeNs.toString(),
        expectedChangedNanoseconds: initial.ctimeNs.toString(),
        expectedBirthNanoseconds: initial.birthtimeNs.toString(),
      });
    } catch (error) {
      if (error instanceof WindowsSameHandleFileError && error.code === "OVERSIZE") {
        throw new ResourceMetaError(
          "OVERSIZE",
          `Workbench resource metadata exceeds its ${maximumBytes}-byte limit: ${metaPath}`,
          { cause: error },
        );
      }
      throw new ResourceMetaError(
        "UNREADABLE",
        `Workbench resource metadata failed its same-handle Windows proof: ${metaPath}`,
        { cause: error },
      );
    }
    if (read.bytes === undefined) {
      throw new ResourceMetaError(
        "UNREADABLE",
        `Workbench resource metadata helper omitted the verified bytes: ${metaPath}`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      throw malformed(metaPath, "invalid UTF-8");
    }
    return Object.freeze({
      guid: parseResourceMetaGuid(text, metaPath),
      evidence: windowsEvidenceFrom(read),
    });
  }

  let descriptor: number | undefined;
  try {
    const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    descriptor = openSync(metaPath, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameUsableFileIdentity(initial, opened)) {
      throw new ResourceMetaError(
        "UNREADABLE",
        `Workbench resource metadata changed identity while being opened: ${metaPath}`,
      );
    }
    if (opened.size > BigInt(maximumBytes)) {
      throw new ResourceMetaError(
        "OVERSIZE",
        `Workbench resource metadata exceeds its ${maximumBytes}-byte limit: ${metaPath}`,
      );
    }

    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) {
      throw new ResourceMetaError(
        "UNREADABLE",
        `Workbench resource metadata changed size while being read: ${metaPath}`,
      );
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameStableIdentity(opened, after)) {
      throw new ResourceMetaError(
        "UNREADABLE",
        `Workbench resource metadata changed while being read: ${metaPath}`,
      );
    }
    const current = lstatSync(metaPath, { bigint: true });
    if (current.isSymbolicLink() || !sameStableIdentity(opened, current)) {
      throw new ResourceMetaError(
        "UNREADABLE",
        `Workbench resource metadata changed identity while being read: ${metaPath}`,
      );
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw malformed(metaPath, "invalid UTF-8");
    }
    const guid = parseResourceMetaGuid(text, metaPath);
    return Object.freeze({
      guid,
      evidence: evidenceFrom(opened, createHash("sha256").update(bytes).digest("hex")),
    });
  } catch (error) {
    if (error instanceof ResourceMetaError) throw error;
    if (errorCode(error) === "ENOENT") {
      throw new ResourceMetaError("MISSING", `Workbench resource metadata is missing: ${metaPath}`);
    }
    throw new ResourceMetaError(
      "UNREADABLE",
      `Workbench resource metadata cannot be read: ${metaPath}`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Read only the authoritative resource GUID. */
export function readResourceMetaGuid(
  metaPath: string,
  options: ReadResourceMetaOptions = {},
): string {
  return readResourceMeta(metaPath, options).guid;
}

/** Compatibility adapter for callers whose established behavior is best-effort. */
export function tryReadResourceMetaGuid(
  metaPath: string,
  options: ReadResourceMetaOptions = {},
): string | null {
  try {
    return readResourceMetaGuid(metaPath, options);
  } catch (error) {
    if (error instanceof ResourceMetaError) return null;
    throw error;
  }
}
