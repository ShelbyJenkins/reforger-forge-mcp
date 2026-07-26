const FORM_MAGIC = "FORM";
const DATABASE_MAGIC = "RDBC";
const SUPPORTED_VERSION = 7;
const MAX_PLATFORM_COUNT = 16;
const MAX_PLATFORM_NAME_BYTES = 1_024;
const MAX_RESOURCE_PATH_BYTES = 32_768;

const RECORD_WITHOUT_TRAILER = new Set([4, 5]);
const RECORD_WITH_TRAILER = new Set([6, 7, 22]);

export interface ResourceGuidIndex {
  version: number;
  entries: Map<string, string>;
}

/**
 * Parse the path/GUID table in a version-7 Enfusion resourceDatabase.rdb.
 * Paths retain their database spelling; GUIDs are returned in resource-ref
 * order (the database stores each 64-bit GUID little-endian).
 */
export function parseResourceGuidIndex(database: Buffer): ResourceGuidIndex {
  if (database.length < 32
      || database.toString("ascii", 0, 4) !== FORM_MAGIC
      || database.toString("ascii", 8, 12) !== DATABASE_MAGIC) {
    throw new Error("Not an Enfusion RDBC resource database");
  }

  const formSize = database.readUInt32BE(4);
  if (formSize + 8 !== database.length) {
    throw new Error(
      `RDBC FORM length mismatch: header declares ${formSize + 8}, file has ${database.length}`
    );
  }

  const version = database.readUInt32LE(12);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported RDBC version ${version}; expected ${SUPPORTED_VERSION}`
    );
  }

  const declaredSize = database.readBigUInt64LE(16);
  if (declaredSize !== BigInt(database.length)) {
    throw new Error(
      `RDBC body length mismatch: header declares ${declaredSize}, file has ${database.length}`
    );
  }

  let offset = 24;
  const platformCount = readUInt32(database, offset, "platform count");
  offset += 4;
  if (platformCount < 1 || platformCount > MAX_PLATFORM_COUNT) {
    throw new Error(`Invalid RDBC platform count: ${platformCount}`);
  }

  for (let index = 0; index < platformCount; index++) {
    const nameLength = readUInt32(database, offset, "platform name length");
    offset += 4;
    if (nameLength < 1 || nameLength > MAX_PLATFORM_NAME_BYTES
        || offset + nameLength + 4 > database.length
        || database[offset + nameLength - 1] !== 0) {
      throw new Error(`Invalid RDBC platform name at index ${index}`);
    }
    offset += nameLength;
    // Platform build/version value.
    offset += 4;
  }

  const entries = new Map<string, string>();
  while (offset < database.length) {
    const recordOffset = offset;
    const pathLength = readUInt32(database, offset, "resource path length");
    offset += 4;
    if (pathLength < 1 || pathLength > MAX_RESOURCE_PATH_BYTES
        || offset + pathLength + 14 > database.length
        || database[offset + pathLength - 1] !== 0) {
      throw new Error(`Invalid RDBC resource record at byte ${recordOffset}`);
    }

    const path = database.toString("utf8", offset, offset + pathLength - 1)
      .replace(/\\/g, "/");
    offset += pathLength;

    const recordKind = database[offset];
    const hasTrailer = RECORD_WITH_TRAILER.has(recordKind);
    if (!hasTrailer && !RECORD_WITHOUT_TRAILER.has(recordKind)) {
      throw new Error(
        `Unsupported RDBC record kind ${recordKind} at byte ${recordOffset}`
      );
    }
    const guidBytes = database.subarray(offset + 6, offset + 14);
    const guid = Buffer.from(guidBytes).reverse().toString("hex").toUpperCase();
    if (path && guid !== "0000000000000000") entries.set(path, guid);

    offset += 14;
    if (hasTrailer) {
      if (offset + 8 > database.length) {
        throw new Error(`Truncated RDBC record trailer at byte ${recordOffset}`);
      }
      offset += 8;
    }
  }

  return { version, entries };
}

function readUInt32(database: Buffer, offset: number, label: string): number {
  if (offset + 4 > database.length) {
    throw new Error(`Truncated RDBC ${label} at byte ${offset}`);
  }
  return database.readUInt32LE(offset);
}
