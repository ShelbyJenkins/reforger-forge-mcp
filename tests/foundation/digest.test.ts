import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256File, sha256Hex } from "../../src/foundation/digest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("foundation digest", () => {
  it("hashes text, bytes, and file content identically", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-digest-"));
    roots.push(root);
    const path = join(root, "payload.bin");
    writeFileSync(path, "payload");
    expect(sha256Hex("payload")).toBe(sha256Hex(Buffer.from("payload")));
    expect(sha256File(path)).toBe(sha256Hex("payload"));
  });

  it("refuses files above the caller's byte bound", () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-digest-"));
    roots.push(root);
    const path = join(root, "payload.bin");
    writeFileSync(path, "payload");
    expect(() => sha256File(path, { maxBytes: 3 })).toThrow("exceeds 3 bytes");
  });
});
