import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeLifecycleBackend } from "./fake-lifecycle-backend.js";
import {
  closeTrackedWorkbenchProcessGuards,
  WorkbenchProcessGuard,
} from "./tracked-process-guard.js";

const roots: string[] = [];

afterEach(async () => {
  await closeTrackedWorkbenchProcessGuards();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exact termination identity races", () => {
  it("does not terminate a replacement when PID identity changes after inspection", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "reforger-forge-identity-race-"));
    roots.push(stateDir);
    const backend = createFakeLifecycleBackend();
    const guard = new WorkbenchProcessGuard({ stateDir, backend });
    const pid = 7300;
    const executablePath = "C:\\Tools\\ArmaReforgerWorkbenchSteamDiag.exe";
    const ownerTokenArgument = guard.ownerArgument("identity-race");
    backend.addWorkbench({ pid, executablePath, creationTime: "730001" }, ownerTokenArgument);

    const result = await guard.withLifecycleLock(async (session) => {
      const captured = await session.inspectSpawnedWorkbench({
        pid,
        executablePath,
        ownerTokenArgument,
        launchedAtMs: Date.now(),
      });

      backend.processes.set(pid, {
        pid,
        executablePath,
        creationTime: "730002",
      });
      return session.verifyAndTerminate(captured, 1000);
    });

    expect(result).toMatchObject({
      kind: "refused",
      reason: "creation_time_mismatch",
    });
    expect(backend.terminationCalls).toHaveLength(1);
    expect(backend.processes.get(pid)?.creationTime).toBe("730002");
    expect(backend.workbenchPids.has(pid)).toBe(true);
  });
});
