import {
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readWindowsFileThroughVerifiedHandle,
  validateWindowsSameHandleFileProtocol,
  WindowsSameHandleFileError,
  type WindowsSameHandleFileRequest,
  type WindowsSameHandleFileRead,
} from "../../src/platform/windows/same-handle-file.js";
import type { BigIntFileIdentity } from "../../src/foundation/file-identity.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function capture(action: () => unknown): WindowsSameHandleFileError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WindowsSameHandleFileError);
    return error as WindowsSameHandleFileError;
  }
  throw new Error("Expected WindowsSameHandleFileError");
}

function read(
  path: string,
  maximumBytes: number,
  includeBytes: boolean,
  beforeOpen?: () => void,
  identity?: (value: Readonly<BigIntFileIdentity>) => BigIntFileIdentity,
): WindowsSameHandleFileRead {
  const stat = lstatSync(path, { bigint: true });
  const expectedPathIdentity = identity?.({ dev: stat.dev, ino: stat.ino }) ?? stat;
  beforeOpen?.();
  return readWindowsFileThroughVerifiedHandle({
    path,
    maximumBytes,
    includeBytes,
    expectedPathIdentity,
    expectedByteLength: Number(stat.size),
    expectedModifiedNanoseconds: stat.mtimeNs.toString(),
    expectedChangedNanoseconds: stat.ctimeNs.toString(),
    expectedBirthNanoseconds: stat.birthtimeNs.toString(),
  });
}

describe.runIf(process.platform === "win32")("Windows same-handle file evidence", () => {
  it("rejects a deterministic zero FILE_ID_INFO volume or 128-bit file ID", () => {
    const request: WindowsSameHandleFileRequest = {
      path: "C:\\Evidence\\file.txt",
      maximumBytes: 64,
      includeBytes: false,
      expectedPathIdentity: { dev: 11n, ino: 12n },
      expectedByteLength: 3,
      expectedModifiedNanoseconds: "13",
      expectedChangedNanoseconds: "14",
      expectedBirthNanoseconds: "15",
    };
    const protocol = {
      schemaVersion: 1,
      ok: true,
      status: "verified",
      finalPath: request.path,
      device: "21",
      inode: "22",
      pathDevice: "11",
      pathInode: "12",
      byteLength: 3,
      modifiedNanoseconds: "13",
      changedNanoseconds: "14",
      birthNanoseconds: "15",
      sha256: "a".repeat(64),
      bytesBase64: null,
      handleIdentityStable: true,
      handlePathStable: true,
      pathHandleMatched: true,
      reparseTraversal: false,
    };

    expect(capture(() => validateWindowsSameHandleFileProtocol({
      ...protocol,
      device: "0",
    }, request)).code).toBe("IDENTITY_UNAVAILABLE");
    expect(capture(() => validateWindowsSameHandleFileProtocol({
      ...protocol,
      inode: "0",
    }, request)).code).toBe("IDENTITY_UNAVAILABLE");
  });

  it("binds bytes, digest, final path, and nonzero FILE_ID_INFO to one stable handle", async () => {
    await withTemporaryDirectory((root) => {
      const path = join(root, "evidence.txt");
      writeFileSync(path, "same handle", "utf8");

      const result = read(path, 64, true);

      expect(result.finalPath).toBe(path);
      expect(result.device).toMatch(/^[1-9][0-9]*$/);
      expect(result.inode).toMatch(/^[1-9][0-9]*$/);
      expect(result.bytes?.toString("utf8")).toBe("same handle");
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(read(path, 64, false)).toMatchObject({
        finalPath: result.finalPath,
        volumeIdentity: result.volumeIdentity,
        fileId: result.fileId,
        sha256: result.sha256,
      });
    }, { prefix: "rfo-same-handle-basic-" });
  });

  it("refuses a deterministic replacement between path inspection and native open", async () => {
    await withTemporaryDirectory((root) => {
      const path = join(root, "evidence.txt");
      const replacement = join(root, "replacement.txt");
      writeFileSync(path, "first", "utf8");
      writeFileSync(replacement, "second", "utf8");

      const error = capture(() => read(path, 64, true, () => {
          unlinkSync(path);
          renameSync(replacement, path);
      }));

      expect(error.code).toBe("HANDLE_PATH_MISMATCH");
    }, { prefix: "rfo-same-handle-replace-" });
  });

  it("refuses a deterministic zero path identity", async () => {
    await withTemporaryDirectory((root) => {
      const path = join(root, "evidence.txt");
      writeFileSync(path, "identity", "utf8");

      const error = capture(() => read(path, 64, false, undefined, () => ({ dev: 0n, ino: 0n })));

      expect(error.code).toBe("IDENTITY_UNAVAILABLE");
    }, { prefix: "rfo-same-handle-zero-" });
  });

  it("accepts a regular hard-link spelling but keeps its exact final path", async () => {
    await withTemporaryDirectory((root) => {
      const original = join(root, "original.txt");
      const alias = join(root, "alias.txt");
      writeFileSync(original, "hard link", "utf8");
      linkSync(original, alias);

      const first = read(original, 64, false);
      const second = read(alias, 64, false);

      expect(first.finalPath).toBe(original);
      expect(second.finalPath).toBe(alias);
      expect(second.device).toBe(first.device);
      expect(second.inode).toBe(first.inode);
    }, { prefix: "rfo-same-handle-hardlink-" });
  });

  it("refuses a final file symlink instead of silently following it", async () => {
    await withTemporaryDirectory((root) => {
      const target = join(root, "target.txt");
      const link = join(root, "link.txt");
      writeFileSync(target, "symlink", "utf8");
      symlinkSync(target, link, "file");

      const error = capture(() => read(link, 4_096, false));

      expect(["REPARSE_POINT", "OPEN_FAILED"]).toContain(error.code);
    }, { prefix: "rfo-same-handle-symlink-" });
  });

  it("refuses traversal through a junction because the handle final path changes", async () => {
    await withTemporaryDirectory((root) => {
      const outside = join(root, "outside");
      const junction = join(root, "junction");
      mkdirSync(outside);
      writeFileSync(join(outside, "evidence.txt"), "junction", "utf8");
      symlinkSync(outside, junction, "junction");

      const error = capture(() => read(join(junction, "evidence.txt"), 64, false));

      expect(error.code).toBe("PATH_MISMATCH");
    }, { prefix: "rfo-same-handle-junction-" });
  });
});
