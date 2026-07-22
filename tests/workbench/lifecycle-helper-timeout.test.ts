import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateWindowsMutexDeadlineBudget,
  allocateWindowsTerminationDeadlineBudget,
} from "../../src/platform/windows/exact-process-backend.js";
import {
  LifecycleGuardError,
  WindowsLifecycleBackend,
  type WorkbenchIdentity,
} from "../../src/workbench/process-guard.js";

const roots: string[] = [];
const lifecycleHelperPath = fileURLToPath(
  new URL("../../scripts/windows/workbench-lifecycle.ps1", import.meta.url)
);
const failStopWorkerPath = fileURLToPath(
  new URL("./fixtures/mutex-holder-failstop-worker.ts", import.meta.url)
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Deadline cases intentionally return as soon as the helper is killed;
    // Windows can retain the script handle briefly while that process exits.
    rmSync(root, {
      recursive: true,
      force: true,
      // Under the full suite PowerShell shutdown can be delayed by other
      // process-heavy tests for longer than the focused-test 500 ms window.
      // Keep cleanup strict, but give the exact killed helper up to five
      // seconds to release its script handle.
      maxRetries: 100,
      retryDelay: 50,
    });
  }
});

function helper(body: string): string {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-helper-timeout-"));
  roots.push(root);
  const path = join(root, "helper.ps1");
  writeFileSync(path, [
    "param([string]$Mode, [long]$DeadlineUnixMs = 0)",
    "$ErrorActionPreference = 'Stop'",
    "$request = [Console]::In.ReadLine()",
    body,
  ].join("\r\n"), "utf8");
  return path;
}

const expectedWorkbench: WorkbenchIdentity = {
  pid: 4242,
  executablePath: "C:\\Tools\\Workbench.exe",
  creationTime: "4242",
  ownerTokenArgument: "-reforgerForgeOwnerToken=timeout-test",
  launchedAtMs: 1,
};

describe("Windows lifecycle deadline budget allocation", () => {
  it.each([
    {
      name: "divides a short shared deadline into acquisition and release thirds",
      input: { remainingMs: 900, requestedMutexWaitMs: 5_000, configuredHelperTimeoutMs: 1_000 },
      expected: { mutexWaitTimeoutMs: 300, helperTimeoutMs: 300, acquisitionTimeoutMs: 600 },
    },
    {
      name: "gives unused helper allowance back to the mutex wait",
      input: { remainingMs: 900, requestedMutexWaitMs: 5_000, configuredHelperTimeoutMs: 100 },
      expected: { mutexWaitTimeoutMs: 700, helperTimeoutMs: 100, acquisitionTimeoutMs: 800 },
    },
    {
      name: "does not inflate a caller's shorter mutex wait",
      input: { remainingMs: 900, requestedMutexWaitMs: 20, configuredHelperTimeoutMs: 1_000 },
      expected: { mutexWaitTimeoutMs: 20, helperTimeoutMs: 300, acquisitionTimeoutMs: 320 },
    },
    {
      name: "stays inside a two millisecond boundary budget",
      input: { remainingMs: 2, requestedMutexWaitMs: 5_000, configuredHelperTimeoutMs: 1_000 },
      expected: { mutexWaitTimeoutMs: 1, helperTimeoutMs: 1, acquisitionTimeoutMs: 2 },
    },
  ])("$name", ({ input, expected }) => {
    expect(allocateWindowsMutexDeadlineBudget(input)).toEqual(expected);
  });

  it("rejects invalid mutex budget inputs before process control", () => {
    expect(() => allocateWindowsMutexDeadlineBudget({
      remainingMs: 0,
      requestedMutexWaitMs: 1,
      configuredHelperTimeoutMs: 1,
    })).toThrow(/positive integers/);
  });

  it.each([
    {
      input: { operationBudgetMs: 1_000, requestedTerminationTimeoutMs: 5_000, configuredHelperTimeoutMs: 2_000 },
      expected: { terminationTimeoutMs: 500, responseAllowanceMs: 500 },
    },
    {
      input: { operationBudgetMs: 1_000, requestedTerminationTimeoutMs: 50, configuredHelperTimeoutMs: 100 },
      expected: { terminationTimeoutMs: 50, responseAllowanceMs: 100 },
    },
    {
      input: { operationBudgetMs: 1, requestedTerminationTimeoutMs: 5_000, configuredHelperTimeoutMs: 2_000 },
      expected: { terminationTimeoutMs: 1, responseAllowanceMs: 1 },
    },
  ])("reserves a bounded helper response allowance for $input.operationBudgetMs ms", ({ input, expected }) => {
    expect(allocateWindowsTerminationDeadlineBudget(input)).toEqual(expected);
  });
});

describe.runIf(platform() === "win32")("Windows lifecycle helper parent deadlines", () => {
  it("rejects a mutex helper that exits silently before its acquisition response", async () => {
    const backend = new WindowsLifecycleBackend(helper("exit 0"), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.withMachineMutex({
      name: `Global\\ReforgerForge.Timeout.Silent.${process.pid}.${Date.now()}`,
      timeoutMs: 1_000,
      action: async () => undefined,
    })).rejects.toMatchObject({ code: "HELPER_FAILURE" });
  }, 10_000);

  it("bounds a mutex helper that never produces its acquisition response", async () => {
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
    });
    let actionRan = false;

    await expect(backend.withMachineMutex({
      name: `Global\\ReforgerForge.Timeout.NoResponse.${process.pid}.${Date.now()}`,
      timeoutMs: 50,
      action: async () => { actionRan = true; },
    })).rejects.toMatchObject({ code: "HELPER_FAILURE" });
    expect(actionRan).toBe(false);
  }, 10_000);

  it("shares one absolute deadline across mutex wait, helper response, and release", async () => {
    const deadlineAtMs = Date.now() + 250;
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
      operationDeadlineAtMs: () => deadlineAtMs,
    });
    const startedAt = Date.now();

    await expect(backend.withMachineMutex({
      name: `Global\\ReforgerForge.Timeout.Absolute.${process.pid}.${Date.now()}`,
      timeoutMs: 5_000,
      action: async () => undefined,
    })).rejects.toMatchObject({ code: "HELPER_FAILURE" });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 10_000);

  it("kills an alive mutex helper after an invalid first line", async () => {
    const backend = new WindowsLifecycleBackend(helper([
      "[Console]::Out.WriteLine('not-json')",
      "[Console]::Out.Flush()",
      "Start-Sleep -Seconds 30",
    ].join("\r\n")), { helperTimeoutMs: 1_000 });

    await expect(backend.withMachineMutex({
      name: `Global\\ReforgerForge.Timeout.Invalid.${process.pid}.${Date.now()}`,
      timeoutMs: 1_000,
      action: async () => undefined,
    })).rejects.toMatchObject({ code: "HELPER_FAILURE" });
  }, 10_000);

  it("bounds a refusing mutex helper that ignores stdin without aborting the parent", async () => {
    const backend = new WindowsLifecycleBackend(helper([
      "[Console]::Out.WriteLine('{\"ok\":false,\"status\":\"timeout\"}')",
      "[Console]::Out.Flush()",
      "Start-Sleep -Seconds 30",
    ].join("\r\n")), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.withMachineMutex({
      name: `Global\\ReforgerForge.Timeout.Refusal.${process.pid}.${Date.now()}`,
      timeoutMs: 1_000,
      action: async () => undefined,
    })).rejects.toMatchObject({ code: "HELPER_FAILURE" });
  }, 10_000);

  it("returns durable recovery when an acquired mutex helper ignores release", async () => {
    const backend = new WindowsLifecycleBackend(helper([
      "[Console]::Out.WriteLine('{\"ok\":true,\"status\":\"acquired\"}')",
      "[Console]::Out.Flush()",
      "Start-Sleep -Seconds 30",
    ].join("\r\n")), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.withMachineMutex({
      name: `Global\\ReforgerForge.Timeout.Release.${process.pid}.${Date.now()}`,
      timeoutMs: 1_000,
      action: async () => undefined,
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  }, 10_000);

  it("fail-stops the MCP before a callback can mutate after its mutex holder exits", async () => {
    const helperPath = helper([
      "[Console]::Out.WriteLine('{\"ok\":true,\"status\":\"acquired\"}')",
      "[Console]::Out.Flush()",
      "Start-Sleep -Milliseconds 250",
      "exit 0",
    ].join("\r\n"));
    const markerPath = join(roots[roots.length - 1], "late-mutation.txt");
    const worker = spawn(process.execPath, [
      "--import", "tsx", failStopWorkerPath,
      helperPath,
      markerPath,
      `Global\\ReforgerForge.Timeout.HolderExit.${process.pid}.${Date.now()}`,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code, signal) => resolveExit({ code, signal }));
      }
    );
    expect(exit).toEqual({ code: 86, signal: null });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    expect(existsSync(markerPath)).toBe(false);
  }, 10_000);

  it("bounds a helper hung during process inspection without fail-stopping", async () => {
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.inspectProcess(4242)).rejects.toBeInstanceOf(LifecycleGuardError);
  }, 10_000);

  it("maps a hung endpoint-vacancy helper into the total unverifiable result", async () => {
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.verifyEndpointVacant({ host: "127.0.0.1", port: 5775 }))
      .resolves.toMatchObject({ kind: "unverifiable", reason: "timeout" });
  }, 10_000);

  it("maps invalid endpoint-vacancy helper JSON into the total unverifiable result", async () => {
    const backend = new WindowsLifecycleBackend(helper(
      "[Console]::Out.WriteLine('not-json')"
    ), { helperTimeoutMs: 1_000 });

    await expect(backend.verifyEndpointVacant({ host: "127.0.0.1", port: 5775 }))
      .resolves.toMatchObject({ kind: "unverifiable", reason: "helper_failure" });
  }, 10_000);

  it("maps endpoint-vacancy helper launch failure into the total unverifiable result", async () => {
    const missing = join(dirname(helper("exit 0")), "missing-helper.ps1");
    const backend = new WindowsLifecycleBackend(missing, { helperTimeoutMs: 1_000 });

    await expect(backend.verifyEndpointVacant({ host: "127.0.0.1", port: 5775 }))
      .resolves.toMatchObject({ kind: "unverifiable", reason: "helper_failure" });
  }, 10_000);

  it("returns durable recovery when exact termination does not return", async () => {
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.verifyAndTerminate(expectedWorkbench, 50))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  }, 10_000);

  it("does not add a fresh helper allowance after an absolute termination deadline", async () => {
    const deadlineAtMs = Date.now() + 250;
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
      operationDeadlineAtMs: () => deadlineAtMs,
    });
    const startedAt = Date.now();

    await expect(backend.verifyAndTerminate(expectedWorkbench, 5_000))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 10_000);
});

describe.runIf(platform() === "win32")("Windows endpoint-owner helper", () => {
  it("resolves a live loopback listener to its owning PID before the sole-Workbench check", async () => {
    const ownerArgument = `-reforgerForgeOwnerToken=listener-${process.pid}-${Date.now()}`;
    const worker = spawn(process.execPath, [
      "-e",
      "const net=require('net');const s=net.createServer(()=>{});" +
        "s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
      "--",
      ownerArgument,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const closed = new Promise<void>((resolvePromise) => worker.once("close", () => resolvePromise()));
    try {
      const port = await new Promise<number>((resolvePromise, reject) => {
        let output = "";
        worker.stdout.setEncoding("utf8");
        worker.stdout.on("data", (chunk: string) => {
          output += chunk;
          const newline = output.indexOf("\n");
          if (newline >= 0) resolvePromise(Number(output.slice(0, newline).trim()));
        });
        worker.once("error", reject);
        worker.once("close", (code) => reject(new Error(`listener worker exited early (${code})`)));
      });
      expect(port).toBeGreaterThan(0);
      expect(worker.pid).toBeTypeOf("number");

      const invoke = (mode: string, request: unknown): Record<string, unknown> => {
        const output = execFileSync("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", lifecycleHelperPath,
          "-Mode", mode,
          "-DeadlineUnixMs", String(Date.now() + 20_000),
        ], {
          input: `${JSON.stringify(request)}\n`,
          encoding: "utf8",
          windowsHide: true,
          timeout: 25_000,
        });
        return JSON.parse(output.trim()) as Record<string, unknown>;
      };
      const inspected = invoke("InspectProcess", {
        pid: worker.pid,
        expectedOwnerTokenArgument: ownerArgument,
      });
      expect(inspected).toMatchObject({ ok: true, status: "found", ownerArgumentMatched: true });

      const verified = invoke("VerifyEndpointOwner", {
        endpoint: { host: "127.0.0.1", port },
        expected: {
          ...(inspected.identity as Record<string, unknown>),
          ownerTokenArgument: ownerArgument,
          launchedAtMs: Date.now(),
        },
      });
      // The helper got past both retained-handle and listener-PID checks. It
      // correctly refuses only because this controlled listener is Node, not
      // the required sole Arma Workbench process.
      expect(verified).toMatchObject({
        ok: false,
        status: "refused",
        reason: "workbench_process_mismatch",
      });
    } finally {
      worker.kill();
      await closed;
    }
  }, 60_000);
});
