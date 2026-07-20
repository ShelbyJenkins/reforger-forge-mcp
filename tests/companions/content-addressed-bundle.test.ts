import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ContentAddressedBundleError,
  computeContentAddressedBundleDigest,
  createContentAddressedBundleManifestSchema,
  sha256ContentFile,
  stageContentAddressedBundle,
  verifyContentAddressedBundle,
  type ContentAddressedBundlePolicy,
} from "../../src/companions/content-addressed-bundle.js";

const descriptorRace = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path: Parameters<typeof actual.openSync>[0], flags: Parameters<typeof actual.openSync>[1], mode?: number) => {
      descriptorRace.beforeOpen?.(String(path));
      return actual.openSync(path, flags, mode);
    }) as typeof actual.openSync,
  };
});

const manifestName = ".test-bundle.json";
const manifestSchema = createContentAddressedBundleManifestSchema({
  role: z.literal("contract-test"),
});
type TestManifest = z.infer<typeof manifestSchema>;

const policy: ContentAddressedBundlePolicy<TestManifest> = {
  displayName: "Contract test",
  addonDirectoryName: "TestAddon",
  manifestName,
  manifestSchema,
  allowedStagedExtraFiles: new Set(["generated.cache"]),
};

const roots: string[] = [];

function temporaryDirectory(): string {
  const root = join(tmpdir(), `reforger-forge-bundle-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function writeSource(
  root: string,
  payload: Readonly<Record<string, string>> = {
    "addon.gproj": "GameProject {}\n",
    "Scripts/main.c": "class ContractTest {}\n",
  }
): TestManifest {
  const files = Object.entries(payload).map(([path, contents]) => {
    const absolute = join(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, "utf8");
    return { path, sha256: sha256ContentFile(absolute) };
  });
  const manifest: TestManifest = {
    manifestVersion: 1,
    role: "contract-test",
    bundleDigest: computeContentAddressedBundleDigest(files),
    files,
  };
  writeFileSync(join(root, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

afterEach(() => {
  descriptorRace.beforeOpen = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("content-addressed bundle contract", () => {
  it("computes one order-independent canonical digest", () => {
    const files = [
      { path: "z.txt", sha256: "a".repeat(64) },
      { path: "a.txt", sha256: "b".repeat(64) },
    ];
    expect(computeContentAddressedBundleDigest(files)).toBe(
      computeContentAddressedBundleDigest([...files].reverse())
    );
  });

  it("verifies, atomically publishes, re-attests, and reuses an immutable bundle", () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    const addonsRoot = join(root, "addons");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(addonsRoot, { recursive: true });
    const manifest = writeSource(sourceRoot);
    const source = verifyContentAddressedBundle(policy, sourceRoot);

    const first = stageContentAddressedBundle(policy, source, addonsRoot);
    const second = stageContentAddressedBundle(policy, source, addonsRoot);

    expect(first).toMatchObject({ bundleDigest: manifest.bundleDigest, reused: false });
    expect(second).toMatchObject({
      bundleDigest: manifest.bundleDigest,
      addonDirectory: first.addonDirectory,
      reused: true,
    });
    expect(readdirSync(addonsRoot)).toEqual([manifest.bundleDigest]);
    expect(verifyContentAddressedBundle(policy, first.addonDirectory, {
      mode: "staged",
      expectedDigest: manifest.bundleDigest,
    }).manifest).toEqual(manifest);
  });

  it("fails closed on case-folded duplicate and traversal manifest paths", () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    mkdirSync(sourceRoot, { recursive: true });
    const manifest = writeSource(sourceRoot, { "Scripts/main.c": "payload" });
    const duplicate = {
      ...manifest,
      files: [
        manifest.files[0],
        { path: "scripts/MAIN.c", sha256: manifest.files[0]!.sha256 },
      ],
    };
    duplicate.bundleDigest = computeContentAddressedBundleDigest(duplicate.files);
    writeFileSync(join(sourceRoot, manifestName), JSON.stringify(duplicate), "utf8");
    expect(() => verifyContentAddressedBundle(policy, sourceRoot)).toThrowError(
      expect.objectContaining<Partial<ContentAddressedBundleError>>({
        issue: "manifest_duplicate_path",
        mode: "source",
      })
    );

    writeFileSync(join(sourceRoot, manifestName), JSON.stringify({
      ...manifest,
      files: [{ path: "../outside", sha256: "a".repeat(64) }],
    }), "utf8");
    expect(() => verifyContentAddressedBundle(policy, sourceRoot)).toThrowError(
      expect.objectContaining<Partial<ContentAddressedBundleError>>({ issue: "manifest_invalid" })
    );
  });

  it("bounds manifest bytes before parsing untrusted JSON", () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    mkdirSync(sourceRoot, { recursive: true });
    writeSource(sourceRoot);

    expect(() => verifyContentAddressedBundle({
      ...policy,
      maxManifestBytes: 32,
    }, sourceRoot)).toThrowError(
      expect.objectContaining<Partial<ContentAddressedBundleError>>({ issue: "manifest_invalid" })
    );
  });

  it("fails closed when a same-size manifest is replaced before descriptor open", () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    mkdirSync(sourceRoot, { recursive: true });
    writeSource(sourceRoot);
    const manifestPath = join(sourceRoot, manifestName);
    const original = readFileSync(manifestPath, "utf8");
    const replacement = original.replace("contract-test", "contract-evil");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    const replacementPath = join(sourceRoot, ".replacement.json");
    writeFileSync(replacementPath, replacement, "utf8");
    let replaced = false;
    descriptorRace.beforeOpen = (path) => {
      if (replaced || path !== manifestPath) return;
      replaced = true;
      descriptorRace.beforeOpen = undefined;
      renameSync(replacementPath, manifestPath);
    };

    expect(() => verifyContentAddressedBundle(policy, sourceRoot)).toThrowError(
      expect.objectContaining<Partial<ContentAddressedBundleError>>({ issue: "unsafe_path" })
    );
    expect(replaced).toBe(true);
  });

  it("rejects symbolic links before reading payload content", () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    const outsideRoot = join(root, "outside");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });
    writeSource(sourceRoot);
    symlinkSync(
      outsideRoot,
      join(sourceRoot, "linked"),
      "junction"
    );

    expect(() => verifyContentAddressedBundle(policy, sourceRoot)).toThrowError(
      expect.objectContaining<Partial<ContentAddressedBundleError>>({ issue: "symbolic_link" })
    );
  });

  it("cleans an unpublished temporary root when the verified source changes", () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    const addonsRoot = join(root, "addons");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(addonsRoot, { recursive: true });
    writeSource(sourceRoot);
    const source = verifyContentAddressedBundle(policy, sourceRoot);
    unlinkSync(join(sourceRoot, "addon.gproj"));

    expect(() => stageContentAddressedBundle(policy, source, addonsRoot)).toThrowError(
      expect.objectContaining<Partial<ContentAddressedBundleError>>({ mode: "source" })
    );
    expect(readdirSync(addonsRoot)).toEqual([]);
  });

  it("permits declared host-generated files only during explicit staged attestation", () => {
    const root = temporaryDirectory();
    const sourceRoot = join(root, "source");
    const addonsRoot = join(root, "addons");
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(addonsRoot, { recursive: true });
    writeSource(sourceRoot);
    const staged = stageContentAddressedBundle(
      policy,
      verifyContentAddressedBundle(policy, sourceRoot),
      addonsRoot
    );
    writeFileSync(join(staged.addonDirectory, "generated.cache"), "cache", "utf8");

    expect(() => verifyContentAddressedBundle(policy, staged.addonDirectory, {
      mode: "staged",
      expectedDigest: staged.bundleDigest,
    })).toThrowError(expect.objectContaining({ issue: "payload_set_mismatch" }));
    expect(verifyContentAddressedBundle(policy, staged.addonDirectory, {
      mode: "staged",
      expectedDigest: staged.bundleDigest,
      allowStagedExtraFiles: true,
    }).manifest.bundleDigest).toBe(staged.bundleDigest);
    expect(existsSync(join(staged.addonDirectory, "generated.cache"))).toBe(true);
  });
});
