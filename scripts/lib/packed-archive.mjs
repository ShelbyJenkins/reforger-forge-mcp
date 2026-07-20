import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { t as listTar } from "tar";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class PackedArchiveInspectionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "PackedArchiveInspectionError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new PackedArchiveInspectionError(code, message, cause === undefined ? {} : { cause });
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_000 ? message : `${message.slice(0, 1_000)}…`;
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_OPTIONS", `${label} must be a positive safe integer`);
  }
}

function canonicalDirectory(path, label) {
  try {
    const resolved = realpathSync.native(resolve(path));
    if (!lstatSync(resolved).isDirectory()) fail("UNSAFE_TARBALL_PATH", `${label} is not a directory`);
    return resolved;
  } catch (error) {
    if (error instanceof PackedArchiveInspectionError) throw error;
    fail("UNSAFE_TARBALL_PATH", `${label} cannot be resolved safely: ${boundedError(error)}`, error);
  }
}

function canonicalTarball(path, root) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    fail("UNSAFE_TARBALL_PATH", "Tarball path must be an absolute path");
  }
  let canonical;
  try {
    canonical = realpathSync.native(path);
    const info = lstatSync(canonical);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail("UNSAFE_TARBALL_PATH", "Tarball must be a regular non-link file");
    }
  } catch (error) {
    if (error instanceof PackedArchiveInspectionError) throw error;
    fail("UNSAFE_TARBALL_PATH", `Tarball cannot be resolved safely: ${boundedError(error)}`, error);
  }
  const tarballRoot = canonicalDirectory(root, "Tarball root");
  const rel = relative(tarballRoot, canonical);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    fail("UNSAFE_TARBALL_PATH", "Tarball escapes its approved package-check root");
  }
  return canonical;
}

function normalizePath(value, label, allowRoot = false) {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_ENTRY_PATH", `${label} is empty`);
  }
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (normalized === "" && allowRoot) return normalized;
  if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    fail("INVALID_ENTRY_PATH", `${label} is absolute or empty: ${JSON.stringify(value)}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("INVALID_ENTRY_PATH", `${label} is not normalized: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function normalizePackagePrefix(packagePrefix) {
  if (typeof packagePrefix !== "string" || packagePrefix.length === 0) {
    fail("INVALID_OPTIONS", "Package prefix must be a nonempty path");
  }
  const normalized = normalizePath(packagePrefix, "Package prefix");
  return `${normalized}/`;
}

function normalizeRequestedTextEntries(entries, packagePrefix) {
  if (!Array.isArray(entries)) fail("INVALID_OPTIONS", "Requested text entries must be an array");
  const normalized = new Set();
  for (const entry of entries) {
    const path = normalizePath(entry, "Requested text entry");
    if (!path.startsWith(packagePrefix)) {
      fail("INVALID_OPTIONS", `Requested text entry is outside ${packagePrefix}: ${path}`);
    }
    const key = path.toLowerCase();
    if (normalized.has(key)) fail("INVALID_OPTIONS", `Requested text entry is duplicated: ${path}`);
    normalized.add(key);
  }
  return normalized;
}

function entryKind(entry) {
  if (entry.meta) return "metadata";
  if (entry.type === "Directory") return "directory";
  if (entry.type === "File" || entry.type === "OldFile") return "file";
  return "unsupported";
}

/**
 * Inspect a package tarball without writing any archive entry to disk.
 *
 * `textEntries` are archive paths, including `package/`. All other regular
 * files are streamed only into a SHA-256 digest, so payload verification never
 * needs a temporary extraction directory.
 */
export async function inspectPackedArchive(options) {
  if (!options || typeof options !== "object") fail("INVALID_OPTIONS", "Archive options are required");
  const packagePrefix = normalizePackagePrefix(options.packagePrefix ?? "package/");
  const maximumEntryBytes = options.maximumEntryBytes;
  assertPositiveSafeInteger(maximumEntryBytes, "Maximum text-entry bytes");
  const tarballPath = canonicalTarball(options.tarballPath, options.tarballRoot);
  const requestedTextEntries = normalizeRequestedTextEntries(options.textEntries ?? [], packagePrefix);
  const files = new Map();
  const textEntries = new Map();
  const paths = new Map();
  let inspectionFailure;

  const recordFailure = (error) => {
    if (inspectionFailure) return;
    inspectionFailure = error instanceof PackedArchiveInspectionError
      ? error
      : new PackedArchiveInspectionError("ARCHIVE_READ_FAILED", boundedError(error), { cause: error });
  };

  try {
    await listTar({
      file: tarballPath,
      strict: true,
      maxDecompressionRatio: 1000,
      onReadEntry(entry) {
        try {
          const kind = entryKind(entry);
          if (kind === "metadata") return;
          const archivePath = normalizePath(entry.path, "Archive entry", entry.type === "Directory");
          const rootName = packagePrefix.slice(0, -1);
          if (archivePath !== rootName && !archivePath.startsWith(packagePrefix)) {
            fail("INVALID_ENTRY_PATH", `Archive entry is outside ${packagePrefix}: ${archivePath}`);
          }
          if (archivePath === rootName) {
            if (kind !== "directory") fail("INVALID_ENTRY_TYPE", "Package root must be a directory");
            return;
          }
          const payloadPath = archivePath.slice(packagePrefix.length);
          const pathKey = payloadPath.toLowerCase();
          const previous = paths.get(pathKey);
          if (previous !== undefined) {
            fail(
              "DUPLICATE_ENTRY_PATH",
              `Archive entry duplicates or case-collides with ${previous}: ${payloadPath}`
            );
          }
          if (kind === "unsupported") {
            fail("INVALID_ENTRY_TYPE", `Archive payload has unsupported ${entry.type} entry: ${payloadPath}`);
          }
          paths.set(pathKey, payloadPath);
          if (kind === "directory") return;
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
            fail("INVALID_ENTRY_SIZE", `Archive file has an invalid size: ${payloadPath}`);
          }
          const wantsText = requestedTextEntries.has(archivePath.toLowerCase());
          if (wantsText && entry.size > maximumEntryBytes) {
            fail("TEXT_ENTRY_TOO_LARGE", `Archive text entry exceeds ${maximumEntryBytes} bytes: ${archivePath}`);
          }
          const digest = createHash("sha256");
          const chunks = wantsText ? [] : null;
          let bytes = 0;
          entry.on("data", (chunk) => {
            if (inspectionFailure) return;
            bytes += chunk.length;
            if (!Number.isSafeInteger(bytes) || (wantsText && bytes > maximumEntryBytes)) {
              recordFailure(new PackedArchiveInspectionError(
                "TEXT_ENTRY_TOO_LARGE",
                `Archive text entry exceeds ${maximumEntryBytes} bytes: ${archivePath}`
              ));
              return;
            }
            digest.update(chunk);
            if (chunks) chunks.push(chunk);
          });
          entry.on("error", (error) => recordFailure(error));
          entry.on("end", () => {
            if (inspectionFailure) return;
            if (bytes !== entry.size) {
              recordFailure(new PackedArchiveInspectionError(
                "INVALID_ENTRY_SIZE",
                `Archive file size changed while reading: ${archivePath}`
              ));
              return;
            }
            const record = Object.freeze({ path: payloadPath, bytes, sha256: digest.digest("hex") });
            files.set(payloadPath, record);
            if (chunks) {
              try {
                textEntries.set(archivePath, utf8Decoder.decode(Buffer.concat(chunks)));
              } catch (error) {
                recordFailure(new PackedArchiveInspectionError(
                  "INVALID_TEXT_ENCODING",
                  `Archive text entry is not valid UTF-8: ${archivePath}`,
                  { cause: error }
                ));
              }
            }
          });
        } catch (error) {
          recordFailure(error);
        }
      },
    });
  } catch (error) {
    if (inspectionFailure) throw inspectionFailure;
    fail("ARCHIVE_READ_FAILED", `Could not inspect packed tarball: ${boundedError(error)}`, error);
  }
  if (inspectionFailure) throw inspectionFailure;
  for (const requested of requestedTextEntries) {
    const entryPath = [...textEntries.keys()].find((path) => path.toLowerCase() === requested);
    if (entryPath === undefined) {
      fail("MISSING_TEXT_ENTRY", `Archive is missing required text entry: ${requested}`);
    }
  }
  return Object.freeze({
    tarballPath,
    packagePrefix,
    files,
    textEntries,
  });
}

export async function readPackedTextEntry(options) {
  const entryPath = normalizePath(options?.entryPath, "Requested text entry");
  const archive = await inspectPackedArchive({
    ...options,
    textEntries: [entryPath],
  });
  return archive.textEntries.get(entryPath);
}
