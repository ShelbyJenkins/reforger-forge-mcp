import { fork, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (pidAlive(pid)) throw new Error(`Process ${pid} remained alive after emergency shutdown`);
}

describe("black-box MCP emergency shutdown", () => {
  it("removes the MCP and its real private child without killing an unrelated process", async () => {
    await withTemporaryDirectory(async (root) => {
      const marker = join(root, "durable-marker.txt");
      const decoy = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const worker = fork(
        join(process.cwd(), "tests", "cross-cutting", "fixtures", "mcp-emergency-private-child-worker.mjs"),
        [join(root, "managed"), marker],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
      );
      let stderr = "";
      worker.stderr?.setEncoding("utf8");
      worker.stderr?.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
      try {
        const pids = await new Promise<{ parentPid: number; childPid: number }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Emergency worker did not report its process IDs")), 15_000);
          worker.once("error", reject);
          worker.once("message", (message: unknown) => {
            clearTimeout(timer);
            resolve(message as { parentPid: number; childPid: number });
          });
        });
        expect(pidAlive(pids.parentPid)).toBe(true);
        expect(pidAlive(pids.childPid)).toBe(true);

        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          worker.once("exit", (code, signal) => resolve({ code, signal }));
        });
        expect(exit.code).toBe(1);
        await Promise.all([
          waitForPidExit(pids.parentPid, 5_000),
          waitForPidExit(pids.childPid, 5_000),
        ]);
        expect(stderr).toContain("rt-black-box-busy");
        expect(stderr).toContain("emergency=true");
        expect(pidAlive(decoy.pid!)).toBe(true);
        expect(existsSync(marker)).toBe(true);
        expect(readFileSync(marker, "utf8")).toContain("durable-state-preserved");
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill();
        if (decoy.exitCode === null && decoy.signalCode === null) decoy.kill();
      }
    }, { prefix: "rfo-mcp-emergency-black-box-" });
  }, 30_000);
});
