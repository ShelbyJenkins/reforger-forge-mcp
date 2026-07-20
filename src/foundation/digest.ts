import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** Compute a lowercase SHA-256 digest for UTF-8 text or exact bytes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface Sha256FileOptions {
  /** Refuse a file larger than this bound before reading it. */
  maxBytes?: number;
  chunkBytes?: number;
}

/**
 * Hash one stable regular file through a retained descriptor. Size and file
 * identity are checked before and after the read so replacement is fail-closed.
 */
export function sha256File(path: string, options: Sha256FileOptions = {}): string {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("SHA-256 file byte limit must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new TypeError("SHA-256 chunk size must be a positive safe integer.");
  }
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`Digest source is not a regular file: ${path}`);
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`Digest source exceeds ${maxBytes} bytes: ${path}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let position = 0;
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs) {
      throw new Error(`Digest source changed while it was read: ${path}`);
    }
    return digest.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}
