import { parentPort, workerData } from "node:worker_threads";
import { readWindowsSameHandleFile } from "../../../src/platform/windows/same-handle-file.js";

if (!parentPort) throw new Error("Same-handle worker fixture requires a parent port.");

try {
  const read = readWindowsSameHandleFile(String(workerData), {
    maximumBytes: 4_096,
    includeBytes: true,
  });
  parentPort.postMessage({
    ok: true,
    systemRoot: process.env.SystemRoot ?? null,
    finalPath: read.finalPath,
    volumeIdentity: read.volumeIdentity,
    fileId: read.fileId,
    sha256: read.sha256,
  });
} catch (error) {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  parentPort.postMessage({
    ok: false,
    systemRoot: process.env.SystemRoot ?? null,
    systemRootUpper: process.env.SYSTEMROOT ?? null,
    windir: process.env.WINDIR ?? null,
    name: error instanceof Error ? error.name : typeof error,
    code: typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : null,
    message: error instanceof Error ? error.message : String(error),
    causeCode: cause && "code" in cause ? String(cause.code) : null,
    causeMessage: cause?.message ?? null,
  });
} finally {
  parentPort.close();
}
