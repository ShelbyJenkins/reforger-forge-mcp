import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWindowsExactProcessBackend } from "../../../src/platform/windows/exact-process-backend.js";
import {
  prepareWindowsForegroundDuringRuntimeStartup,
} from "../../../src/platform/windows/runtime-focus-guard.js";

const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
);
const fixture = resolve("tests/fixtures/windows/runtime-focus-window.ps1");
const lifecycleHelper = resolve("scripts/windows/workbench-lifecycle.ps1");
const enabled = process.platform === "win32" &&
  process.env.RFO_RUN_LIVE_FOCUS_GUARD_ACCEPTANCE === "1" &&
  existsSync(powershell) && existsSync(fixture) && existsSync(lifecycleHelper);
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

async function runFixture(
  firstWindowDelayMs: number,
  testFaultMode?: "style"
): Promise<number> {
  const token = `-reforgerForgeOwnerToken=${randomUUID().replaceAll("-", "")}`;
  const timeoutMs = firstWindowDelayMs + 5_000;
  const guard = await prepareWindowsForegroundDuringRuntimeStartup({
    executablePath: powershell,
    ownerTokenArgument: token,
    timeoutMs,
    ...(testFaultMode ? { testFaultMode } : {}),
  });
  const child = spawn(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", fixture,
    "-OwnerTokenArgument", token,
    "-FirstWindowDelayMs", String(firstWindowDelayMs),
    "-ReplacementDelayMs", "250",
    "-LifetimeMs", String(timeoutMs + 2_000),
  ], { stdio: "ignore", windowsHide: false });
  children.push(child);
  if (!child.pid) throw new Error("Focus fixture returned no PID");
  await guard.bindTarget(child.pid);
  const backend = createWindowsExactProcessBackend(lifecycleHelper);
  const inspected = await backend.inspectProcess(child.pid, token);
  if (!inspected || inspected.ownerArgumentMatched !== true) {
    throw new Error("Focus fixture exact identity was not inspectable");
  }
  const result = await guard.complete(inspected.identity);
  expect(result.styleVerifiedCount).toBeGreaterThanOrEqual(2);
  return result.protectedWindowCount;
}

describe.runIf(enabled)("runtime focus guard live Windows desktop acceptance", () => {
  it("protects immediate and post-15-second replacement GUIs under GC pressure", async () => {
    await expect(runFixture(0)).resolves.toBeGreaterThanOrEqual(2);
    await expect(runFixture(16_000)).resolves.toBeGreaterThanOrEqual(2);
  }, 45_000);

  it("refuses forced hook installation before target spawn", async () => {
    await expect(prepareWindowsForegroundDuringRuntimeStartup({
      executablePath: powershell,
      ownerTokenArgument: `-reforgerForgeOwnerToken=${"a".repeat(32)}`,
      timeoutMs: 5_000,
      testFaultMode: "hook",
    })).rejects.toThrow(/hook|ready/i);
  }, 15_000);

  it("refuses a forced style-write failure instead of accepting an observed window", async () => {
    await expect(runFixture(0, "style")).rejects.toThrow(/style|protection/i);
  }, 15_000);
});
