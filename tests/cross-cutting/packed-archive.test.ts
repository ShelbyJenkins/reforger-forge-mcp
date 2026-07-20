import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PackedArchiveInspectionError,
  inspectPackedArchive,
  readPackedTextEntry,
} from "../../scripts/lib/packed-archive.mjs";
import { verifyPackedArchiveAddonInventory } from "../../scripts/lib/addon-inventory.mjs";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const manifestPath = "package/observer/addon/.reforger-forge-observer-source.json";

interface TarEntry {
  path: string;
  body?: string | Buffer;
  type?: string;
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

/** Small intentionally literal fixture writer; production code only reads through node-tar. */
function tarHeader(entry: TarEntry, body: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.path, 0, 100, "utf8");
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(body.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(entry.type ?? "0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

function archive(root: string, entries: readonly TarEntry[]): { root: string; tarballPath: string } {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "", "utf8");
    blocks.push(tarHeader(entry, body), body);
    const padding = body.length % 512;
    if (padding) blocks.push(Buffer.alloc(512 - padding));
  }
  blocks.push(Buffer.alloc(1024));
  const tarballPath = join(root, "package.tgz");
  writeFileSync(tarballPath, gzipSync(Buffer.concat(blocks)));
  return { root, tarballPath };
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function aggregate(files: readonly { path: string; sha256: string }[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.sha256, "ascii");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

function observerManifest(files: readonly { path: string; sha256: string }[]): string {
  return `${JSON.stringify({
    manifestVersion: 1,
    addonVersion: "0.1.0",
    protocolVersion: "1.0",
    addonId: "ReforgerForgeObserver",
    addonGuid: "7F3A91C2E40B6D58",
    buildIdentity: "a".repeat(64),
    bundleDigest: aggregate(files),
    files,
  })}\n`;
}

function validObserverArchive(root: string, extraEntries: readonly TarEntry[] = [], payload = "packed addon"): {
  root: string;
  tarballPath: string;
} {
  const files = [{ path: "addon.gproj", sha256: digest(payload) }];
  return archive(root, [
    { path: "package", type: "5" },
    { path: "package/observer", type: "5" },
    { path: "package/observer/addon", type: "5" },
    { path: manifestPath, body: observerManifest(files) },
    { path: "package/observer/addon/addon.gproj", body: payload },
    ...extraEntries,
  ]);
}

function inspect(fixture: { root: string; tarballPath: string }, options: { textEntries?: string[]; maximumEntryBytes?: number } = {}) {
  return inspectPackedArchive({
    tarballPath: fixture.tarballPath,
    tarballRoot: fixture.root,
    packagePrefix: "package/",
    maximumEntryBytes: options.maximumEntryBytes ?? 1024,
    textEntries: options.textEntries ?? [manifestPath],
  });
}

function scopedIt(
  name: string,
  run: (root: string) => Promise<void> | void,
): void {
  it(name, () => withTemporaryDirectory(run, { prefix: "rfo-packed-archive-" }));
}

describe("packed tarball archive inspection", () => {
  scopedIt("streams a deterministic regular-file inventory and exact manifest text", async (root) => {
    const fixture = validObserverArchive(root);
    const result = await inspect(fixture);

    expect([...result.files.keys()].sort()).toEqual([
      "observer/addon/.reforger-forge-observer-source.json",
      "observer/addon/addon.gproj",
    ]);
    expect(result.files.get("observer/addon/addon.gproj")?.sha256).toBe(digest("packed addon"));
    expect(await readPackedTextEntry({
      tarballPath: fixture.tarballPath,
      tarballRoot: fixture.root,
      packagePrefix: "package/",
      maximumEntryBytes: 1024,
      entryPath: manifestPath,
    })).toContain('"manifestVersion":1');
  });

  it.each([
    ["duplicate payload", (root: string) => validObserverArchive(root, [{ path: "package/observer/addon/addon.gproj", body: "again" }])],
    ["traversal spelling", (root: string) => validObserverArchive(root, [{ path: "package/observer/addon/../escape.txt", body: "escape" }])],
    ["absolute spelling", (root: string) => validObserverArchive(root, [{ path: "/package/observer/addon/absolute.txt", body: "absolute" }])],
    ["symbolic link", (root: string) => validObserverArchive(root, [{ path: "package/observer/addon/link", type: "2" }])],
    ["case-colliding payload", (root: string) => validObserverArchive(root, [{ path: "package/observer/addon/ADDON.gproj", body: "case" }])],
  ])("fails closed for %s", async (_label, create) => {
    await withTemporaryDirectory(async (root) => {
      await expect(inspect(create(root))).rejects.toBeInstanceOf(PackedArchiveInspectionError);
    }, { prefix: "rfo-packed-archive-" });
  });

  scopedIt("rejects oversized, missing, and duplicated requested manifests", async (root) => {
    const oversized = validObserverArchive(root, [], "packed addon");
    await expect(inspect(oversized, { maximumEntryBytes: 20 })).rejects.toMatchObject({
      code: "TEXT_ENTRY_TOO_LARGE",
    });

    const missing = archive(root, [{ path: "package", type: "5" }]);
    await expect(inspect(missing)).rejects.toMatchObject({ code: "MISSING_TEXT_ENTRY" });

    const duplicate = validObserverArchive(root, [{ path: manifestPath, body: "{}" }]);
    await expect(inspect(duplicate)).rejects.toMatchObject({ code: "DUPLICATE_ENTRY_PATH" });
  });
});

describe("packed add-on manifest inventory", () => {
  function verifyArchive(fixture: { root: string; tarballPath: string }) {
    return inspect(fixture).then((result) => verifyPackedArchiveAddonInventory(result, {
      addonRoot: "observer/addon",
      manifestName: ".reforger-forge-observer-source.json",
      displayName: "Packed observer add-on",
      allowedGeneratedFiles: new Set(["resourceDatabase.rdb"]),
    }));
  }

  scopedIt("uses the packed manifest after a checkout manifest would have changed", async (root) => {
    const fixture = validObserverArchive(root);
    const sourceManifestAfterPacking = observerManifest([{ path: "addon.gproj", sha256: digest("changed checkout") }]);
    expect(sourceManifestAfterPacking).not.toContain(digest("packed addon"));

    await expect(verifyArchive(fixture)).resolves.toMatchObject({
      bundleDigest: aggregate([{ path: "addon.gproj", sha256: digest("packed addon") }]),
    });
  });

  scopedIt("rejects an undeclared archive payload and archive-byte digest drift", async (root) => {
    await expect(verifyArchive(validObserverArchive(root, [
      { path: "package/observer/addon/undeclared.c", body: "not declared" },
    ]))).rejects.toThrow("does not declare every archive payload file exactly once");

    const drift = archive(root, [
      { path: "package", type: "5" },
      { path: "package/observer", type: "5" },
      { path: "package/observer/addon", type: "5" },
      { path: manifestPath, body: observerManifest([{ path: "addon.gproj", sha256: digest("original") }]) },
      { path: "package/observer/addon/addon.gproj", body: "changed archive byte" },
    ]);
    await expect(verifyArchive(drift)).rejects.toThrow("hash does not match archive payload: addon.gproj");
  });
});
