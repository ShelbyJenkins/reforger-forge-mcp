import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function workerRead(path: string): Promise<unknown> {
  const worker = new Worker(
    new URL("../fixtures/windows/same-handle-worker.ts", import.meta.url),
    { workerData: path, execArgv: ["--import", "tsx"] },
  );
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Same-handle worker exited ${code}.`));
    });
  });
}

describe.runIf(process.platform === "win32")("Windows same-handle worker composition", () => {
  it("resolves and executes the bundled helper from a TypeScript planning-style worker", async () => {
    await withTemporaryDirectory(async (root) => {
      const path = join(root, "worker-evidence.txt");
      writeFileSync(path, "worker evidence", "utf8");

      const result = await workerRead(path);

      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        finalPath: path,
        volumeIdentity: expect.stringMatching(/^[1-9]\d*$/),
        fileId: expect.stringMatching(/^[1-9]\d*$/),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }, { prefix: "rfo-same-handle-worker-" });
  }, 30_000);
});
