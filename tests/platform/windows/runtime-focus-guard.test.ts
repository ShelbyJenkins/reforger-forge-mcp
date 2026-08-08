import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareWindowsForegroundDuringRuntimeStartup,
  validateRuntimeFocusGuardEvidence,
} from "../../../src/platform/windows/runtime-focus-guard.js";

const expected = {
  pid: 4242,
  executablePath: "C:\\fixture\\target.exe",
  creationTime: "133900000000004242",
};

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    status: "protected",
    targetPid: expected.pid,
    targetCreationTime: expected.creationTime,
    hookCount: 2,
    hooksUnhooked: true,
    callbackRooted: true,
    callbackReleased: true,
    protectedWindowCount: 2,
    styleVerifiedCount: 2,
    foregroundIntercepted: true,
    foregroundRestored: true,
    finalForegroundOwned: false,
    ...overrides,
  };
}

describe("Windows runtime focus guard", () => {
  it("accepts only positive hook, callback, style, window, foreground, and exact-identity evidence", () => {
    expect(validateRuntimeFocusGuardEvidence(evidence(), expected)).toEqual({
      targetPid: expected.pid,
      targetCreationTime: expected.creationTime,
      hookCount: 2,
      hooksUnhooked: true,
      callbackRooted: true,
      callbackReleased: true,
      protectedWindowCount: 2,
      styleVerifiedCount: 2,
      foregroundIntercepted: true,
      foregroundRestored: true,
      finalForegroundOwned: false,
    });

    for (const invalid of [
      { hookCount: 1 },
      { hooksUnhooked: false },
      { callbackRooted: false },
      { callbackReleased: false },
      { protectedWindowCount: 0 },
      { styleVerifiedCount: 0 },
      { foregroundIntercepted: true, foregroundRestored: false },
      { finalForegroundOwned: true },
      { targetCreationTime: "133900000000009999" },
    ]) {
      expect(() => validateRuntimeFocusGuardEvidence(evidence(invalid), expected))
        .toThrow(/focus guard|protection evidence|identity/i);
    }
  });

  it("keeps the native proof mechanisms in one pre-spawn transaction", () => {
    const source = readFileSync(resolve("scripts/windows/runtime-focus-guard.ps1"), "utf8");
    expect(source).toContain("PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE");
    expect(source).toContain("GetProcessTimes");
    expect(source).toContain("HasExactArgument(ownerArgument)");
    expect(source).toContain("GCHandle.Alloc(callback)");
    expect(source.indexOf("UnhookWinEvent(foregroundHook)")).toBeLessThan(
      source.indexOf("callbackRoot.Free()")
    );
    expect(source).toContain("SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, callback, 0, 0");
    expect(source).toContain("RecordLatestForeground(foreground)");
    const recordLatest = source.slice(
      source.indexOf("private void RecordLatestForeground"),
      source.indexOf("private bool RestoreLatestForeground"),
    );
    expect(recordLatest).toContain("foregroundChoices.RecordLatest(window, CaptureChoice);");
    expect(source).toContain("foregroundChoices.InvalidateWindow(window);");
    expect(source).toContain("MatchesExactTargetGeneration(exact.ProcessId, exact.IsSameGeneration(), pid)");
    expect(source).toContain("WS_EX_NOACTIVATE style readback did not match the write");
    expect(source).toContain("No target startup window was observed and protected.");
    expect(source).toContain('String.Equals(faultMode, "hook"');
    expect(source).toContain('String.Equals(faultMode, "style"');
  });

  it.runIf(process.platform === "win32")(
    "runs latest-choice, destroyed-window, reused-HWND, and reused-PID checks headlessly in the native helper assembly",
    () => {
      const powershell = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
      );
      const output = execFileSync(powershell, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", resolve("scripts/windows/runtime-focus-guard.ps1"),
        "-SelfTestScenario", "all",
      ], { encoding: "utf8", windowsHide: true });
      const result = JSON.parse(output.trim()) as {
        ok: boolean;
        status: string;
        cases: Array<{
          Scenario: string;
          Passed: boolean;
          SelectedWindow: number;
          MutationAuthorized: boolean;
        }>;
      };
      expect(result).toMatchObject({ ok: true, status: "self_test" });
      expect(result.cases.map((item) => item.Scenario)).toEqual([
        "latest-choice", "destroyed-window", "reused-hwnd", "pid-reuse",
      ]);
      expect(result.cases.every((item) => item.Passed)).toBe(true);
      expect(result.cases[0]).toMatchObject({ SelectedWindow: 0xB, MutationAuthorized: true });
      expect(result.cases.slice(1).every((item) => item.MutationAuthorized === false)).toBe(true);
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "installs real hooks before bind and fails closed when hook installation is injected to fail",
    async () => {
      const transaction = await prepareWindowsForegroundDuringRuntimeStartup({
        executablePath: process.execPath,
        ownerTokenArgument: `-reforgerForgeOwnerToken=${"a".repeat(32)}`,
        timeoutMs: 5_000,
      });
      await transaction.abort();

      await expect(prepareWindowsForegroundDuringRuntimeStartup({
        executablePath: process.execPath,
        ownerTokenArgument: `-reforgerForgeOwnerToken=${"b".repeat(32)}`,
        timeoutMs: 5_000,
        testFaultMode: "hook",
      })).rejects.toThrow(/hook|ready/i);
    },
    20_000
  );
});
