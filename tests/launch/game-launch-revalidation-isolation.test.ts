import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGameLaunchPointOfUseIsolatedRevalidator,
  revalidateGameLaunchPointOfUseIsolated,
} from "../../src/launch/game-launch-revalidation-isolation.js";
import {
  computeOwnedRuntimeExecutableEvidenceDigest,
  resolveRuntimeExecutableEvidenceFromSource,
} from "../../src/observer/owned-runtime-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executableFixture(contents = "fixture executable") {
  const root = mkdtempSync(join(tmpdir(), "rfo-launch-revalidation-"));
  roots.push(root);
  const executablePath = join(root, "ArmaReforgerSteamDiag.exe");
  writeFileSync(executablePath, contents);
  const expectedExecutable = resolveRuntimeExecutableEvidenceFromSource(
    { kind: "executablePath", executablePath },
    "listenServer",
    1024 * 1024,
  );
  return { executablePath, expectedExecutable };
}

function toggleFirstAsciiLetter(value: string): string {
  return value.replace(/[A-Za-z]/, (letter) =>
    letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase());
}

class FakeRevalidationWorker extends EventEmitter {
  terminateCalls = 0;

  constructor(private readonly terminateImplementation: () => Promise<number>) {
    super();
  }

  unref(): void {
    // The fake owns no event-loop handle.
  }

  async terminate(): Promise<number> {
    this.terminateCalls += 1;
    return this.terminateImplementation();
  }
}

describe("isolated game-launch point-of-use revalidation", () => {
  it("uses exact canonical spelling in the worker and contains no Windows case fold", () => {
    const source = readFileSync(
      new URL("../../src/launch/game-launch-revalidation-worker.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "executable.executablePath !== request.expectedExecutable.executablePath",
    );
    expect(source).not.toMatch(/\.to(?:Locale)?LowerCase\s*\(/);
  });

  it.runIf(process.platform === "win32")(
    "refuses case-only drift from a noncanonical Windows path spelling",
    async () => {
      const fixture = executableFixture();
      const caseOnlyPath = join(
        dirname(fixture.executablePath),
        toggleFirstAsciiLetter(basename(fixture.executablePath)),
      );
      expect(caseOnlyPath).not.toBe(fixture.executablePath);
      expect(realpathSync.native(caseOnlyPath)).toBe(fixture.expectedExecutable.executablePath);

      const evidenceFields = {
        schemaVersion: fixture.expectedExecutable.schemaVersion,
        runtimeKind: fixture.expectedExecutable.runtimeKind,
        executablePath: caseOnlyPath,
        executableFile: fixture.expectedExecutable.executableFile,
      };
      const caseOnlyEvidence = {
        ...evidenceFields,
        executableEvidenceDigest: computeOwnedRuntimeExecutableEvidenceDigest(evidenceFields),
      };

      await expect(revalidateGameLaunchPointOfUseIsolated({
        phase: "post_spawn_executable",
        expectedExecutable: caseOnlyEvidence,
        executableMaximumBytes: 1024 * 1024,
        deadlineAtMs: Date.now() + 5_000,
      })).rejects.toMatchObject({ code: "EXECUTABLE_CHANGED" });
    },
  );

  it("keeps the caller event loop responsive while executable evidence is read", async () => {
    const fixture = executableFixture();
    const pending = revalidateGameLaunchPointOfUseIsolated({
      phase: "post_spawn_executable",
      expectedExecutable: fixture.expectedExecutable,
      executableMaximumBytes: 1024 * 1024,
      deadlineAtMs: Date.now() + 5_000,
    });

    let timerObserved = false;
    await new Promise<void>((resolve) => setTimeout(() => {
      timerObserved = true;
      resolve();
    }, 0));

    expect(timerObserved).toBe(true);
    await expect(pending).resolves.toMatchObject({
      executableEvidenceDigest: fixture.expectedExecutable.executableEvidenceDigest,
    });
  });

  it("resolves primitive-start baseline evidence inside the worker", async () => {
    const fixture = executableFixture();

    await expect(revalidateGameLaunchPointOfUseIsolated({
      phase: "baseline_executable",
      executableSource: {
        kind: "executablePath",
        executablePath: fixture.executablePath,
      },
      runtimeKind: "listenServer",
      executableMaximumBytes: 1024 * 1024,
      deadlineAtMs: Date.now() + 5_000,
    })).resolves.toEqual(fixture.expectedExecutable);
  });

  it("terminates a revalidation worker at the absolute deadline", async () => {
    const fixture = executableFixture();
    await expect(revalidateGameLaunchPointOfUseIsolated({
      phase: "post_spawn_executable",
      expectedExecutable: fixture.expectedExecutable,
      executableMaximumBytes: 1024 * 1024,
      deadlineAtMs: Date.now() + 1,
    })).rejects.toMatchObject({ code: "PLANNING_TIMEOUT" });
  });

  it("does not let worker construction extend the absolute deadline", async () => {
    const fixture = executableFixture();
    let now = 1_000;
    let worker!: FakeRevalidationWorker;
    worker = new FakeRevalidationWorker(async () => {
      queueMicrotask(() => worker.emit("exit", 1));
      return 1;
    });
    const revalidate = createGameLaunchPointOfUseIsolatedRevalidator(() => {
      // Model synchronous Worker construction/workerData cloning consuming the
      // complete budget after the initial validation but before timer setup.
      now = 1_101;
      return worker as unknown as Worker;
    });
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const outcome = revalidate({
        phase: "post_spawn_executable",
        expectedExecutable: fixture.expectedExecutable,
        executableMaximumBytes: 1024 * 1024,
        deadlineAtMs: 1_100,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(worker.terminateCalls).toBe(1);
      await expect(outcome).resolves.toMatchObject({ code: "PLANNING_TIMEOUT" });
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not settle a terminate rejection until physical worker exit is observed", async () => {
    const fixture = executableFixture();
    const worker = new FakeRevalidationWorker(async () => {
      throw new Error("fixture terminate rejection");
    });
    const revalidate = createGameLaunchPointOfUseIsolatedRevalidator(() =>
      worker as unknown as Worker);
    let settled = false;
    const outcome = revalidate({
      phase: "post_spawn_executable",
      expectedExecutable: fixture.expectedExecutable,
      executableMaximumBytes: 1024 * 1024,
      deadlineAtMs: Date.now() + 5_000,
    }).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    worker.emit("message", { ok: true, executable: fixture.expectedExecutable });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(worker.terminateCalls).toBe(1);
    expect(settled).toBe(false);

    worker.emit("exit", 1);
    await expect(outcome).resolves.toMatchObject({ code: "WORKER_TERMINATION_FAILED" });
    expect(settled).toBe(true);
  });

  it("refuses same-path executable replacement and the shared byte ceiling", async () => {
    const fixture = executableFixture();
    writeFileSync(fixture.executablePath, "replacement executable bytes");

    await expect(revalidateGameLaunchPointOfUseIsolated({
      phase: "post_spawn_executable",
      expectedExecutable: fixture.expectedExecutable,
      executableMaximumBytes: 1024 * 1024,
      deadlineAtMs: Date.now() + 5_000,
    })).rejects.toMatchObject({ code: "EXECUTABLE_CHANGED" });

    await expect(revalidateGameLaunchPointOfUseIsolated({
      phase: "post_spawn_executable",
      expectedExecutable: fixture.expectedExecutable,
      executableMaximumBytes: 1,
      deadlineAtMs: Date.now() + 5_000,
    })).rejects.toMatchObject({ code: "EXECUTABLE_OVERSIZE" });
  });
});
