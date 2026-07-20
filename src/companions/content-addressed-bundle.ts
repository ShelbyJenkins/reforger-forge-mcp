import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { sha256File, sha256Hex } from "../foundation/digest.js";
import {
  BoundedJsonStore,
  JsonStoreError,
  atomicWriteFile,
} from "../foundation/json-store.js";
import {
  ManagedPathError,
  assertRegularManagedFile,
  canonicalizeExistingDirectory,
  resolveManagedPath,
} from "../foundation/managed-path.js";

export const CONTENT_SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const CONTENT_ADDRESSED_BUNDLE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const DEFAULT_MAX_MANIFEST_BYTES = 1024 * 1024;

export interface ContentAddressedBundleFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ContentAddressedBundleManifest {
  readonly manifestVersion: 1;
  readonly bundleDigest: string;
  readonly files: readonly ContentAddressedBundleFile[];
}

export const contentAddressedBundleFileSchema = z.object({
  path: z.string()
    .regex(CONTENT_ADDRESSED_BUNDLE_PATH_PATTERN)
    .refine(isSafeBundlePath, "Payload path must be a normalized relative path"),
  sha256: z.string().regex(CONTENT_SHA256_PATTERN),
});

/**
 * Build a companion-specific manifest schema from the one shared bundle
 * envelope. Identity fields stay literal at the adapter boundary while path,
 * digest, and payload validation stay identical for every companion.
 */
export function createContentAddressedBundleManifestSchema<
  IdentityShape extends z.ZodRawShape,
>(identityShape: IdentityShape) {
  return z.object({
    manifestVersion: z.literal(1),
    ...identityShape,
    bundleDigest: z.string().regex(CONTENT_SHA256_PATTERN),
    files: z.array(contentAddressedBundleFileSchema).min(1),
  });
}

export type ContentAddressedBundleMode = "source" | "staged";

export type ContentAddressedBundleIssue =
  | "directory_unavailable"
  | "directory_not_directory"
  | "unsafe_path"
  | "symbolic_link"
  | "non_regular_entry"
  | "manifest_unavailable"
  | "manifest_malformed"
  | "manifest_invalid"
  | "manifest_duplicate_path"
  | "manifest_reserved_path"
  | "manifest_payload_mismatch"
  | "manifest_digest_mismatch"
  | "expected_digest_mismatch"
  | "payload_set_mismatch"
  | "payload_hash_mismatch"
  | "payload_validation_failed"
  | "digest_root_conflict"
  | "stage_failed";

export class ContentAddressedBundleError extends Error {
  constructor(
    message: string,
    public readonly issue: ContentAddressedBundleIssue,
    public readonly mode: ContentAddressedBundleMode,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "ContentAddressedBundleError";
  }
}

interface ManifestParser<Manifest> {
  safeParse(value: unknown):
    | { success: true; data: Manifest }
    | { success: false; error: unknown };
}

export interface ContentAddressedBundlePolicy<
  Manifest extends ContentAddressedBundleManifest,
> {
  readonly displayName: string;
  readonly addonDirectoryName: string;
  readonly manifestName: string;
  readonly manifestSchema: ManifestParser<Manifest>;
  /** Hard read/write bound for the untrusted JSON manifest. */
  readonly maxManifestBytes?: number;
  /** An optional fixed payload allowlist, used by companions with a pinned ABI. */
  readonly requiredPayloadPaths?: readonly string[];
  /** Files the host application may generate after an immutable stage is published. */
  readonly allowedStagedExtraFiles?: ReadonlySet<string>;
  /** Additional attestation such as checking constants compiled into payload source. */
  readonly validatePayload?: (
    directory: string,
    manifest: Manifest,
    mode: ContentAddressedBundleMode
  ) => void;
}

export interface VerifiedContentAddressedBundle<
  Manifest extends ContentAddressedBundleManifest,
> {
  readonly sourceDirectory: string;
  readonly manifest: Manifest;
}

export interface StagedContentAddressedBundle<
  Manifest extends ContentAddressedBundleManifest,
> {
  readonly bundleDigest: string;
  readonly addonDirectory: string;
  readonly addonSearchRoot: string;
  readonly reused: boolean;
  readonly manifest: Manifest;
}

export interface VerifyContentAddressedBundleOptions {
  readonly mode?: ContentAddressedBundleMode;
  readonly expectedDigest?: string;
  readonly allowStagedExtraFiles?: boolean;
}

function isSafeBundlePath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) =>
    segment !== "" && segment !== "." && segment !== ".."
  );
}

function fail<Manifest extends ContentAddressedBundleManifest>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  mode: ContentAddressedBundleMode,
  issue: ContentAddressedBundleIssue,
  message: string,
  cause?: unknown
): never {
  throw new ContentAddressedBundleError(
    `${policy.displayName} ${message}`,
    issue,
    mode,
    cause === undefined ? {} : { cause }
  );
}

function canonicalDirectory<Manifest extends ContentAddressedBundleManifest>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  directoryPath: string,
  mode: ContentAddressedBundleMode
): string {
  try {
    return canonicalizeExistingDirectory(directoryPath, `${policy.displayName} bundle`);
  } catch (error) {
    return fail(
      policy,
      mode,
      error instanceof ManagedPathError && error.reason === "root_not_directory"
        ? "directory_not_directory"
        : "directory_unavailable",
      error instanceof Error ? error.message : `bundle is unavailable: ${directoryPath}`,
      error
    );
  }
}

function assertContainedPath<Manifest extends ContentAddressedBundleManifest>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  rootPath: string,
  candidatePath: string,
  mode: ContentAddressedBundleMode
): string {
  try {
    return resolveManagedPath(rootPath, candidatePath, "link-safe");
  } catch (error) {
    return fail(
      policy,
      mode,
      "unsafe_path",
      error instanceof Error ? error.message : `path cannot be resolved safely: ${candidatePath}`,
      error
    );
  }
}

function assertRegularContainedFile<Manifest extends ContentAddressedBundleManifest>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  root: string,
  filePath: string,
  mode: ContentAddressedBundleMode
): string {
  const candidate = assertContainedPath(policy, root, filePath, mode);
  let info;
  try {
    info = lstatSync(candidate);
  } catch (error) {
    return fail(policy, mode, "non_regular_entry", `payload file is unavailable: ${candidate}`, error);
  }
  if (info.isSymbolicLink()) {
    return fail(policy, mode, "symbolic_link", `bundle contains a symbolic link: ${candidate}`);
  }
  if (!info.isFile()) {
    return fail(policy, mode, "non_regular_entry", `bundle contains a non-regular entry: ${candidate}`);
  }
  try {
    return assertRegularManagedFile(root, candidate);
  } catch (error) {
    return fail(
      policy,
      mode,
      error instanceof ManagedPathError && error.reason === "not_regular_file"
        ? "non_regular_entry"
        : "unsafe_path",
      error instanceof Error ? error.message : `payload cannot be resolved safely: ${candidate}`,
      error
    );
  }
}

function listBundleFiles<Manifest extends ContentAddressedBundleManifest>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  root: string,
  mode: ContentAddressedBundleMode
): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      fail(policy, mode, "directory_unavailable", `bundle cannot be read: ${directory}`, error);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      let info;
      try {
        info = lstatSync(path);
      } catch (error) {
        fail(policy, mode, "non_regular_entry", `bundle entry cannot be inspected: ${rel}`, error);
      }
      if (info.isSymbolicLink()) {
        fail(policy, mode, "symbolic_link", `bundle contains a symbolic link: ${rel}`);
      }
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) files.push(rel);
      else fail(policy, mode, "non_regular_entry", `bundle contains a non-regular entry: ${rel}`);
    }
  };
  visit(root);
  return files;
}

export function readContentAddressedBundleManifest<
  Manifest extends ContentAddressedBundleManifest,
>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  manifestPath: string,
  mode: ContentAddressedBundleMode
): Manifest {
  let value: unknown;
  try {
    const maxManifestBytes = policy.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
    const store = new BoundedJsonStore<unknown>({
      root: dirname(manifestPath),
      minRecordBytes: 1,
      maxRecordBytes: maxManifestBytes,
      parse: (input) => input,
    });
    const inspected = store.inspect(manifestPath);
    if (inspected.kind === "missing") {
      return fail(policy, mode, "manifest_unavailable", `manifest is unavailable: ${manifestPath}`);
    }
    if (inspected.kind === "corrupt") {
      return fail(policy, mode, "manifest_malformed", inspected.message);
    }
    value = inspected.value;
  } catch (error) {
    if (error instanceof ContentAddressedBundleError) throw error;
    if (error instanceof JsonStoreError) {
      if (error.code === "RECORD_TOO_LARGE") {
        return fail(policy, mode, "manifest_invalid", error.message, error);
      }
      if (error.code === "NOT_REGULAR_FILE") {
        return fail(policy, mode, "non_regular_entry", error.message, error);
      }
      if (error.code === "UNSAFE_PATH") {
        return fail(
          policy,
          mode,
          /symbolic link|traverses a link/i.test(error.message) ? "symbolic_link" : "unsafe_path",
          error.message,
          error
        );
      }
    }
    return fail(policy, mode, "manifest_malformed", `manifest is missing or malformed: ${manifestPath}`, error);
  }

  const parsed = policy.manifestSchema.safeParse(value);
  if (!parsed.success) {
    return fail(policy, mode, "manifest_invalid", "manifest does not match its supported schema", parsed.error);
  }

  const seen = new Set<string>();
  const reservedPath = policy.manifestName.toLowerCase();
  for (const file of parsed.data.files) {
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      return fail(policy, mode, "manifest_duplicate_path", `manifest repeats a payload path: ${file.path}`);
    }
    if (key === reservedPath) {
      return fail(policy, mode, "manifest_reserved_path", `manifest manages its reserved path: ${file.path}`);
    }
    seen.add(key);
  }

  if (policy.requiredPayloadPaths) {
    const actual = parsed.data.files.map((file) => file.path)
      .sort((left, right) => left.localeCompare(right));
    const expected = [...policy.requiredPayloadPaths]
      .sort((left, right) => left.localeCompare(right));
    if (actual.length !== expected.length ||
        actual.some((path, index) => path !== expected[index])) {
      return fail(
        policy,
        mode,
        "manifest_payload_mismatch",
        "manifest does not contain the exact supported payload"
      );
    }
  }

  if (computeContentAddressedBundleDigest(parsed.data.files) !== parsed.data.bundleDigest) {
    return fail(
      policy,
      mode,
      "manifest_digest_mismatch",
      "aggregate bundle digest does not match its file manifest"
    );
  }
  return parsed.data;
}

function atomicWriteManifest(
  root: string,
  targetPath: string,
  value: unknown,
  maxBytes: number
): void {
  atomicWriteFile({
    root,
    targetPath,
    data: `${JSON.stringify(value, null, 2)}\n`,
    maxBytes,
    mode: 0o600,
  });
}

export function sha256ContentFile(path: string): string {
  return sha256File(path);
}

export function computeContentAddressedBundleDigest(
  files: readonly ContentAddressedBundleFile[]
): string {
  const canonical = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.sha256}\n`)
    .join("");
  return sha256Hex(canonical);
}

export function verifyContentAddressedBundle<
  Manifest extends ContentAddressedBundleManifest,
>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  directoryPath: string,
  options: VerifyContentAddressedBundleOptions = {}
): VerifiedContentAddressedBundle<Manifest> {
  const mode = options.mode ?? "source";
  const directory = canonicalDirectory(policy, directoryPath, mode);
  const manifestPath = join(directory, policy.manifestName);
  const manifest = readContentAddressedBundleManifest(policy, manifestPath, mode);
  if (options.expectedDigest && manifest.bundleDigest !== options.expectedDigest) {
    return fail(
      policy,
      mode,
      "expected_digest_mismatch",
      "digest does not match its content-addressed directory"
    );
  }

  const allowedExtras = mode === "staged" && options.allowStagedExtraFiles
    ? policy.allowedStagedExtraFiles ?? new Set<string>()
    : new Set<string>();
  const actual = listBundleFiles(policy, directory, mode)
    .filter((path) => path !== policy.manifestName)
    .filter((path) => !allowedExtras.has(path))
    .sort((left, right) => left.localeCompare(right));
  const expected = manifest.files.map((file) => file.path)
    .sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    return fail(
      policy,
      mode,
      "payload_set_mismatch",
      "payload is incomplete or contains unexpected files"
    );
  }

  for (const file of manifest.files) {
    const payload = join(directory, ...file.path.split("/"));
    const canonical = assertRegularContainedFile(policy, directory, payload, mode);
    if (sha256ContentFile(canonical) !== file.sha256) {
      return fail(policy, mode, "payload_hash_mismatch", `payload hash mismatch: ${file.path}`);
    }
  }

  if (policy.validatePayload) {
    try {
      policy.validatePayload(directory, manifest, mode);
    } catch (error) {
      if (error instanceof ContentAddressedBundleError) throw error;
      return fail(
        policy,
        mode,
        "payload_validation_failed",
        error instanceof Error ? error.message : "payload-specific validation failed",
        error
      );
    }
  }
  return { sourceDirectory: directory, manifest };
}

export function stageContentAddressedBundle<
  Manifest extends ContentAddressedBundleManifest,
>(
  policy: ContentAddressedBundlePolicy<Manifest>,
  source: VerifiedContentAddressedBundle<Manifest>,
  addonsRootPath: string
): StagedContentAddressedBundle<Manifest> {
  const addonsRoot = canonicalDirectory(policy, addonsRootPath, "staged");
  const digestRoot = join(addonsRoot, source.manifest.bundleDigest);
  const addonDirectory = join(digestRoot, policy.addonDirectoryName);
  assertContainedPath(policy, addonsRoot, addonDirectory, "staged");

  if (existsSync(addonDirectory)) {
    const verified = verifyContentAddressedBundle(policy, addonDirectory, {
      mode: "staged",
      expectedDigest: source.manifest.bundleDigest,
      allowStagedExtraFiles: true,
    });
    return {
      bundleDigest: verified.manifest.bundleDigest,
      addonDirectory,
      addonSearchRoot: digestRoot,
      reused: true,
      manifest: verified.manifest,
    };
  }
  if (existsSync(digestRoot)) {
    return fail(
      policy,
      "staged",
      "digest_root_conflict",
      `digest directory exists without its verified add-on: ${digestRoot}`
    );
  }

  const temporaryRoot = join(
    addonsRoot,
    `.${source.manifest.bundleDigest}.${randomUUID()}.tmp`
  );
  const temporaryAddon = join(temporaryRoot, policy.addonDirectoryName);
  try {
    mkdirSync(temporaryAddon, { recursive: true, mode: 0o700 });
    for (const file of source.manifest.files) {
      const from = join(source.sourceDirectory, ...file.path.split("/"));
      const to = join(temporaryAddon, ...file.path.split("/"));
      assertRegularContainedFile(policy, source.sourceDirectory, from, "source");
      assertContainedPath(policy, temporaryRoot, to, "staged");
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      copyFileSync(from, to);
    }
    atomicWriteManifest(
      temporaryAddon,
      join(temporaryAddon, policy.manifestName),
      source.manifest,
      policy.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES
    );
    verifyContentAddressedBundle(policy, temporaryAddon, {
      mode: "staged",
      expectedDigest: source.manifest.bundleDigest,
    });
    try {
      renameSync(temporaryRoot, digestRoot);
    } catch (error) {
      if (!existsSync(addonDirectory)) throw error;
      const verified = verifyContentAddressedBundle(policy, addonDirectory, {
        mode: "staged",
        expectedDigest: source.manifest.bundleDigest,
        allowStagedExtraFiles: true,
      });
      rmSync(temporaryRoot, { recursive: true, force: true });
      return {
        bundleDigest: verified.manifest.bundleDigest,
        addonDirectory,
        addonSearchRoot: digestRoot,
        reused: true,
        manifest: verified.manifest,
      };
    }
    return {
      bundleDigest: source.manifest.bundleDigest,
      addonDirectory,
      addonSearchRoot: digestRoot,
      reused: false,
      manifest: source.manifest,
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (error instanceof ContentAddressedBundleError) throw error;
    return fail(
      policy,
      "staged",
      "stage_failed",
      `could not be staged: ${error instanceof Error ? error.message : String(error)}`,
      error
    );
  }
}
