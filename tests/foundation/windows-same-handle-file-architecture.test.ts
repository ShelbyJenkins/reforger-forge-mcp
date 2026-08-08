import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Windows same-handle file architecture", () => {
  it("owns identity, final-path, reparse, read, and post-read checks on one native handle", () => {
    const helper = readFileSync(
      resolve("scripts/windows/same-handle-file-read.ps1"),
      "utf8",
    );

    expect(helper).toContain("CreateFileW");
    expect(helper).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(helper).toContain("FILE_ID_INFO_CLASS = 18");
    expect(helper).toContain("GetFinalPathNameByHandleW");
    expect(helper).toContain("new FileStream(handle");
    expect(helper).toContain("SameHandleSnapshot before = Capture(handle)");
    expect(helper).toContain("SameHandleSnapshot after = Capture(handle)");
    expect(helper).toContain("using (SafeFileHandle currentHandle = Open(expectedPath))");
    expect(helper).toContain("HANDLE_PATH_MISMATCH");
  });

  it("routes every supported Windows evidence reader through the native boundary", () => {
    for (const path of [
      "src/launch/game-world-plan.ts",
      "src/launch/game-addon-plan.ts",
      "src/workbench/resource-meta.ts",
    ]) {
      const source = readFileSync(resolve(path), "utf8");
      const windowsBranch = source.indexOf('process.platform === "win32"');
      const helperCall = source.indexOf("readWindowsFileThroughVerifiedHandle", windowsBranch);
      const noFollowFallback = source.indexOf("O_NOFOLLOW", windowsBranch);

      expect(windowsBranch, path).toBeGreaterThanOrEqual(0);
      expect(helperCall, path).toBeGreaterThan(windowsBranch);
      expect(noFollowFallback, path).toBeGreaterThan(helperCall);
    }
  });
});
