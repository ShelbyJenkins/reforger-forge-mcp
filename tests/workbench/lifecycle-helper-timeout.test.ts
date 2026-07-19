import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LifecycleGuardError,
  WindowsLifecycleBackend,
  type WorkbenchIdentity,
  type WorkbenchLifecycleStateV3,
} from "../../src/workbench/process-guard.js";

const roots: string[] = [];
const lifecycleHelperPath = fileURLToPath(
  new URL("../../scripts/windows/workbench-lifecycle.ps1", import.meta.url)
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

const vacantState: WorkbenchLifecycleStateV3 = {
  version: 3,
  generation: "next-generation",
  phase: "vacant",
  endpoint: { host: "127.0.0.1", port: 5775 },
  target: null,
  mcpOwner: null,
  workbench: null,
  companion: null,
  operation: null,
};

describe("Windows lifecycle helper schema contract", () => {
  it("compares version-3 replacement records against a version-3 current record", () => {
    const source = readFileSync(lifecycleHelperPath, "utf8");

    expect(source).toMatch(/\$currentVersion\s+-ne\s+3/);
    expect(source).not.toMatch(/\$currentVersion\s+-ne\s+2/);
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

  it("invalidates active work and returns durable recovery when the mutex holder exits", async () => {
    let leaseLoss: LifecycleGuardError | null = null;
    const backend = new WindowsLifecycleBackend(helper([
      "[Console]::Out.WriteLine('{\"ok\":true,\"status\":\"acquired\"}')",
      "[Console]::Out.Flush()",
      "Start-Sleep -Milliseconds 250",
      "exit 0",
    ].join("\r\n")), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.withMachineMutex({
      name: `Global\\ReforgerForge.Timeout.HolderExit.${process.pid}.${Date.now()}`,
      timeoutMs: 1_000,
      onLeaseLost: (error) => { leaseLoss = error; },
      action: () => new Promise<never>(() => undefined),
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(leaseLoss).toMatchObject({ code: "RECOVERY_REQUIRED" });
  }, 10_000);

  it("bounds a helper hung during process inspection without fail-stopping", async () => {
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.inspectProcess(4242)).rejects.toBeInstanceOf(LifecycleGuardError);
  }, 10_000);

  it("returns durable recovery when lifecycle state replacement does not return", async () => {
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.replaceState({
      path: join(roots[0], "state.json"),
      expectedGeneration: null,
      next: vacantState,
    })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
  }, 10_000);

  it("returns durable recovery when exact termination does not return", async () => {
    const backend = new WindowsLifecycleBackend(helper("Start-Sleep -Seconds 30"), {
      helperTimeoutMs: 1_000,
    });

    await expect(backend.verifyAndTerminate(expectedWorkbench, 50))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
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
