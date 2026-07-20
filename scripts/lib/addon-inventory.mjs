import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** Keep archive and checkout manifest reads at the production validator's 1 MiB bound. */
export const MAX_SOURCE_MANIFEST_BYTES = 1024 * 1024;

function listRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new Error(`contains a symbolic link: ${relativePath}`);
      }
      if (info.isDirectory()) {
        visit(path);
      } else if (info.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`contains a non-regular entry: ${relativePath}`);
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function safePayloadPath(value) {
  return typeof value === "string" && PATH_PATTERN.test(value) &&
    !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function aggregateDigest(files) {
  const aggregate = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    aggregate.update(file.path, "utf8");
    aggregate.update("\0", "utf8");
    aggregate.update(file.sha256, "ascii");
    aggregate.update("\n", "utf8");
  }
  return aggregate.digest("hex");
}

function fail(displayName, detail) {
  throw new Error(`${displayName} manifest inventory ${detail}`);
}

/**
 * Validate the source-manifest envelope independently from any filesystem or
 * archive reader. Package checks and checkout checks deliberately share this
 * schema, path, duplicate, and aggregate-digest policy.
 */
export function validateAddonSourceManifest(value, options) {
  const { manifestName, displayName, role } = options;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.manifestVersion !== 1 || !SHA256_PATTERN.test(value.bundleDigest) ||
      !Array.isArray(value.files) || value.files.length === 0 ||
      (role !== undefined && value.role !== role)) {
    fail(displayName, "has an invalid envelope");
  }

  const files = value.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file) ||
        !safePayloadPath(file.path) || !SHA256_PATTERN.test(file.sha256)) {
      fail(displayName, "contains an invalid payload entry");
    }
    return Object.freeze({ path: file.path, sha256: file.sha256 });
  });
  const keys = files.map((file) => file.path.toLowerCase());
  if (new Set(keys).size !== keys.length || keys.includes(manifestName.toLowerCase())) {
    fail(displayName, "contains a duplicate or reserved payload path");
  }
  if (aggregateDigest(files) !== value.bundleDigest) {
    fail(displayName, "does not match its aggregate payload digest");
  }
  return Object.freeze({ ...value, files: Object.freeze(files) });
}

function parseBoundedManifestText(text, options) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_SOURCE_MANIFEST_BYTES) {
    fail(options.displayName, `exceeds the ${MAX_SOURCE_MANIFEST_BYTES}-byte manifest bound`);
  }
  try {
    return validateAddonSourceManifest(JSON.parse(text), options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${options.displayName} manifest inventory`)) {
      throw error;
    }
    fail(options.displayName, `is unavailable or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function expectedPayloadKeys(manifestName, manifest) {
  return new Set([
    manifestName,
    ...manifest.files.map((file) => file.path),
  ].map((path) => path.toLowerCase()));
}

function allowedGeneratedFiles(options) {
  return options.allowedGeneratedFiles ?? new Set();
}

/**
 * Check a source manifest and payload inventory read from a tarball by the
 * generic packed-archive helper. `archive.files` must map package-relative
 * paths to streamed byte digests; no source-checkout file is consulted.
 */
export function verifyPackedArchiveAddonInventory(archive, options) {
  const { addonRoot, manifestName, displayName } = options;
  if (typeof addonRoot !== "string" || addonRoot.length === 0) {
    throw new Error("Packed add-on root must be a nonempty package-relative path");
  }
  const normalizedRoot = addonRoot.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (!safePayloadPath(normalizedRoot)) {
    throw new Error(`Packed add-on root is not a normalized package-relative path: ${addonRoot}`);
  }
  const manifestArchivePath = `${archive.packagePrefix}${normalizedRoot}/${manifestName}`;
  const manifestText = [...archive.textEntries.entries()].find(([path]) =>
    path.toLowerCase() === manifestArchivePath.toLowerCase()
  )?.[1];
  const manifest = parseBoundedManifestText(manifestText, options);
  const actual = new Map();
  const addonPrefix = `${normalizedRoot}/`;
  for (const [path, entry] of archive.files) {
    if (!path.startsWith(addonPrefix)) continue;
    const payloadPath = path.slice(addonPrefix.length);
    if (!safePayloadPath(payloadPath)) {
      fail(displayName, `contains an unsafe packaged payload path: ${payloadPath}`);
    }
    actual.set(payloadPath.toLowerCase(), { path: payloadPath, entry });
  }
  const allowedExtras = allowedGeneratedFiles(options);
  const expected = expectedPayloadKeys(manifestName, manifest);
  const allowed = new Set([...expected, ...allowedExtras].map((path) => path.toLowerCase()));
  if ([...expected].some((key) => !actual.has(key)) || [...actual.keys()].some((key) => !allowed.has(key))) {
    fail(
      displayName,
      `does not declare every archive payload file exactly once ` +
      `(expected ${expected.size} declared entries, found ${actual.size})`
    );
  }
  for (const file of manifest.files) {
    const archived = actual.get(file.path.toLowerCase());
    if (!archived || archived.entry.sha256 !== file.sha256) {
      fail(displayName, `hash does not match archive payload: ${file.path}`);
    }
  }
  return manifest;
}

/**
 * Verify a packaged add-on payload against the manifest shipped in that same
 * package tree. This intentionally does not read the source checkout.
 */
export function verifyPackagedAddonInventory(directory, options) {
  const { manifestName, displayName, role } = options;

  let manifest;
  try {
    const manifestPath = join(directory, manifestName);
    const info = lstatSync(manifestPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SOURCE_MANIFEST_BYTES) {
      fail(displayName, "is not a bounded regular manifest file");
    }
    manifest = parseBoundedManifestText(readFileSync(manifestPath, "utf8"), options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${displayName} manifest inventory`)) throw error;
    fail(displayName, `is unavailable or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let actual;
  try {
    actual = listRegularFiles(directory);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const actualKeys = actual.map((path) => path.toLowerCase());
  const expected = expectedPayloadKeys(manifestName, manifest);
  const allowed = new Set([
    ...expected,
    ...allowedGeneratedFiles(options).values(),
  ].map((path) => path.toLowerCase()));
  if (actualKeys.length < expected.size || [...expected].some((path) => !actualKeys.includes(path)) ||
      actualKeys.some((path) => !allowed.has(path))) {
    fail(displayName, "does not declare every packaged payload file exactly once");
  }

  for (const file of manifest.files) {
    const contents = readFileSync(join(directory, ...file.path.split("/")));
    const actualHash = createHash("sha256").update(contents).digest("hex");
    if (actualHash !== file.sha256) {
      fail(displayName, `hash does not match payload: ${file.path}`);
    }
  }
  return manifest;
}
