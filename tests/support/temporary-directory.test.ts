import { existsSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "./temporary-directory.js";

describe("withTemporaryDirectory", () => {
  it("cleans a successful synchronous callback and preserves the prefix", async () => {
    let path = "";
    await withTemporaryDirectory((root) => {
      path = root;
      expect(existsSync(root)).toBe(true);
    }, { prefix: "rfo-support-success-" });
    expect(path).toContain("rfo-support-success-");
    expect(existsSync(path)).toBe(false);
  });

  it("cleans after thrown and rejected callbacks", async () => {
    let thrownPath = "";
    await expect(withTemporaryDirectory((root) => {
      thrownPath = root;
      throw new Error("callback failure");
    })).rejects.toThrow("callback failure");
    expect(existsSync(thrownPath)).toBe(false);

    let rejectedPath = "";
    await expect(withTemporaryDirectory(async (root) => {
      rejectedPath = root;
      await Promise.resolve();
      throw new Error("async callback failure");
    })).rejects.toThrow("async callback failure");
    expect(existsSync(rejectedPath)).toBe(false);
  });

  it("isolates concurrent scopes with the same prefix", async () => {
    const paths: string[] = [];
    await Promise.all([1, 2].map(() => withTemporaryDirectory(async (root) => {
      paths.push(root);
      expect(existsSync(root)).toBe(true);
      await Promise.resolve();
    }, { prefix: "rfo-support-concurrent-" })));
    expect(new Set(paths).size).toBe(2);
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

  it("tolerates a callback that removes its own root", async () => {
    let path = "";
    await withTemporaryDirectory((root) => {
      path = root;
      rmSync(root, { recursive: true, force: true });
      expect(existsSync(root)).toBe(false);
    });
    expect(existsSync(path)).toBe(false);
  });

  it("rejects prefixes that can escape the operating-system temp root", async () => {
    await expect(withTemporaryDirectory(() => undefined, { prefix: "..\\escape-" })).rejects.toThrow(RangeError);
    await expect(withTemporaryDirectory(() => undefined, { prefix: "C:escape-" })).rejects.toThrow(RangeError);
  });
});
