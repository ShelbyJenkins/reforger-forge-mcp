import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  captureStableWorkbenchMatrixSource,
  launchWorkbenchMatrixDecoy,
  remainingWorkbenchMatrixCaptureTimeout,
  remainingWorkbenchMatrixStepTimeout,
  removeWorkbenchCaseDirectoryIfSafe,
  requireWorkbenchReplacementWorldId,
  workbenchFailureDeadlineEvidence,
} from "../../scripts/run-workbench-observer-acceptance.js";

describe("Workbench failure-matrix safety helpers", () => {
  const vacantCleanup = {
    lifecycleVacant: true,
    endpointVacant: true,
    childVacant: true,
    exactOwnerVacant: true,
  };
  const noDecoy = { category: "not_applicable" as const, identityUnchanged: null };

  it("never removes a case directory with an unresolved cleanup or decoy proof", () => {
    const remove = vi.fn();
    for (const key of Object.keys(vacantCleanup) as Array<keyof typeof vacantCleanup>) {
      expect(removeWorkbenchCaseDirectoryIfSafe({
        caseDirectory: "case-directory",
        entry: {
          cleanup: { ...vacantCleanup, [key]: false },
          decoy: noDecoy,
        },
        remove,
      })).toBe(false);
    }
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: {
        cleanup: vacantCleanup,
        decoy: { category: "unproven", identityUnchanged: null },
      },
      remove,
    })).toBe(false);
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: { cleanup: vacantCleanup, decoy: noDecoy },
      retainForDecoyRecovery: true,
      remove,
    })).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("reports removal failures and removes only fully proven disposable directories", () => {
    const removalError = new Error("locked directory");
    const onRemovalError = vi.fn();
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: { cleanup: vacantCleanup, decoy: noDecoy },
      remove: () => {
        throw removalError;
      },
      onRemovalError,
    })).toBe(false);
    expect(onRemovalError).toHaveBeenCalledWith(removalError);

    const remove = vi.fn();
    expect(removeWorkbenchCaseDirectoryIfSafe({
      caseDirectory: "case-directory",
      entry: { cleanup: vacantCleanup, decoy: noDecoy },
      remove,
    })).toBe(true);
    expect(remove).toHaveBeenCalledWith("case-directory");
  });

  it("uses the remaining absolute case budget at capture dispatch", () => {
    expect(remainingWorkbenchMatrixCaptureTimeout(10_000, 5_000)).toBe(5_000);
    expect(remainingWorkbenchMatrixCaptureTimeout(400_000, 0)).toBe(300_000);
    expect(() => remainingWorkbenchMatrixCaptureTimeout(5_999, 5_000))
      .toThrow(/deadline expired before capture dispatch/);
  });

  it("derives infrastructure waits from the same absolute case deadline", () => {
    expect(remainingWorkbenchMatrixStepTimeout(10_000, 15_000, "preflight", 4_500))
      .toBe(5_500);
    expect(remainingWorkbenchMatrixStepTimeout(30_000, 10_000, "decoy", 4_500))
      .toBe(10_000);
    expect(() => remainingWorkbenchMatrixStepTimeout(4_500, 10_000, "decoy", 4_500))
      .toThrow(/deadline expired before decoy/);
  });

  it("records early failures as cancelled and clamps true timeouts to the budget", () => {
    expect(workbenchFailureDeadlineEvidence(1_000, 1_400, 1_000)).toEqual({
      outcome: "cancelled",
      elapsedMs: 400,
      budgetMs: 1_000,
    });
    expect(workbenchFailureDeadlineEvidence(1_000, 2_500, 1_000)).toEqual({
      outcome: "expired",
      elapsedMs: 1_000,
      budgetMs: 1_000,
    });
  });

  it("rejects a replacement world identity that did not actually change", () => {
    expect(requireWorkbenchReplacementWorldId("world-a", "world-b")).toBe("world-b");
    expect(() => requireWorkbenchReplacementWorldId("world-a", "world-a"))
      .toThrow(/did not change the observed Workbench world identity/);
  });

  it("detects source-closure mutation across the final revision bracket", () => {
    const source = (sha256: string) => ({
      harness: { path: "scripts/harness.ts", sha256 },
      recorder: { path: "scripts/recorder.ts", sha256: "b".repeat(64) },
      measured: [{ path: "src/measured.ts", sha256: "c".repeat(64) }],
    });
    const readSource = vi.fn()
      .mockReturnValueOnce(source("a".repeat(64)))
      .mockReturnValueOnce(source("d".repeat(64)));
    const readRevision = vi.fn().mockReturnValue({
      commit: "e".repeat(40),
      tree: "clean" as const,
    });
    const captured = captureStableWorkbenchMatrixSource({ readSource, readRevision });
    expect(captured.stable).toBe(false);
    expect(captured.source).toEqual(source("d".repeat(64)));
    expect(readSource).toHaveBeenCalledTimes(2);
    expect(readRevision).toHaveBeenCalledTimes(2);
  });

  it("exits a spawned decoy through its sentinel when identity qualification fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-decoy-failure-"));
    let observedExit = false;
    try {
      const inspectProcess = vi.fn().mockResolvedValue(null);
      await expect(launchWorkbenchMatrixDecoy(
        root,
        { inspectProcess },
        {
          inspectionDeadlineMs: 1,
          onSpawn: (child) => {
            child.once("exit", () => {
              observedExit = true;
            });
          },
        }
      )).rejects.toThrow(/decoy exact identity could not be verified/);
      expect(inspectProcess).toHaveBeenCalled();
      expect(existsSync(join(root, "decoy-exit.sentinel"))).toBe(true);
      expect(observedExit).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not grant decoy qualification cleanup a fresh window past the case deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "rfo-workbench-decoy-deadline-"));
    let exited!: Promise<void>;
    try {
      const startedAt = Date.now();
      await expect(launchWorkbenchMatrixDecoy(
        root,
        { inspectProcess: vi.fn().mockResolvedValue(null) },
        {
          deadlineAtMs: startedAt + 5,
          onSpawn: (child) => {
            exited = new Promise((resolveExit) => child.once("exit", () => resolveExit()));
          },
        }
      )).rejects.toThrow(/qualification failed and sentinel exit could not be proven/);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(existsSync(join(root, "decoy-exit.sentinel"))).toBe(true);
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("decoy did not honor its sentinel")),
          2_000
        )),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
