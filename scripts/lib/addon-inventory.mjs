import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

/**
 * Verify a packaged add-on payload against the manifest shipped in that same
 * package tree. This intentionally does not read the source checkout.
 */
export function verifyPackagedAddonInventory(directory, options) {
  const { manifestName, displayName, role } = options;
  const fail = (detail) => {
    throw new Error(`${displayName} manifest inventory ${detail}`);
  };

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, manifestName), "utf8"));
  } catch (error) {
    fail(`is unavailable or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      manifest.manifestVersion !== 1 || !SHA256_PATTERN.test(manifest.bundleDigest) ||
      !Array.isArray(manifest.files) || manifest.files.length === 0 ||
      (role !== undefined && manifest.role !== role)) {
    fail("has an invalid envelope");
  }

  const files = manifest.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file) ||
        !safePayloadPath(file.path) || !SHA256_PATTERN.test(file.sha256)) {
      fail("contains an invalid payload entry");
    }
    return { path: file.path, sha256: file.sha256 };
  });
  const keys = files.map((file) => file.path.toLowerCase());
  if (new Set(keys).size !== keys.length || keys.includes(manifestName.toLowerCase())) {
    fail("contains a duplicate or reserved payload path");
  }
  if (aggregateDigest(files) !== manifest.bundleDigest) {
    fail("does not match its aggregate payload digest");
  }

  let actual;
  try {
    actual = listRegularFiles(directory);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const expected = [manifestName, ...files.map((file) => file.path)]
    .sort((left, right) => left.localeCompare(right));
  const actualKeys = actual.map((path) => path.toLowerCase());
  const expectedKeys = expected.map((path) => path.toLowerCase());
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((path, index) => path !== expectedKeys[index])) {
    fail("does not declare every packaged payload file exactly once");
  }

  for (const file of files) {
    const contents = readFileSync(join(directory, ...file.path.split("/")));
    const actualHash = createHash("sha256").update(contents).digest("hex");
    if (actualHash !== file.sha256) {
      fail(`hash does not match payload: ${file.path}`);
    }
  }
  return manifest;
}
