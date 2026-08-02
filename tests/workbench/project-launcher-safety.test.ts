import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";

const helperPath = fileURLToPath(
  new URL("../../scripts/windows/workbench-lifecycle.ps1", import.meta.url)
);
const helper = readFileSync(helperPath, "utf8");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundled Windows Workbench lifecycle helper", () => {
  it("uses a global named mutex and contains no pathname stale-recovery lock", () => {
    expect(helper).toContain("[Threading.Mutex]::new");
    expect(helper).toContain("[Threading.AbandonedMutexException]");
    expect(helper).toContain("MutexSecurity");
    expect(helper).not.toContain("reforger-forge-mcp-workbench.launch.lock");
    expect(helper).not.toContain("lockStaleMs");
    expect(helper).not.toContain("Test-RRProcessIdAlive");
  });

  it("verifies and terminates through one retained native process handle", () => {
    expect(helper).toContain("OpenProcess");
    expect(helper).toContain("GetProcessTimes");
    expect(helper).toContain("QueryFullProcessImageName");
    expect(helper).toContain("HasExactArgument");
    expect(helper).toContain("CharSet = CharSet.Unicode");
    expect(helper).toContain("TerminateAndWait");
    expect(helper).toContain("TerminateProcess(handle");
    expect(helper).toContain("WaitForSingleObject(handle");
    expect(helper).not.toContain("taskkill");
    expect(helper).not.toContain("Stop-Process -Name");
  });

  it("unwraps native lifecycle failures before reading their refusal reason", () => {
    expect(helper).toContain("$ErrorRecord.Exception.GetBaseException()");
    expect(helper).toContain("$processException.Reason");
    expect(helper).not.toContain("$_.Exception.Reason");
  });

  it("classifies query races as absent only after the retained handle signals exit", () => {
    expect(helper).toContain("if (HasExited())");
    expect(helper).toContain("The process exited before its executable path could be read.");
    expect(helper).toContain("The process exited before its creation time could be read.");
    expect(helper).toContain("The process exited before its command line could be read.");
  });

  it("uses only private JSON stdin/stdout protocol messages", () => {
    expect(helper).toContain("[Console]::In.ReadLine()");
    expect(helper).toContain("[Console]::Out.WriteLine($json)");
    expect(helper).toContain("[Console]::Out.Flush()");
    expect(helper).not.toContain("Write-Host");
  });

  it("minimizes each discovered window handle at most once", () => {
    const methodStart = helper.indexOf(
      "public static bool TryMinimizeProcessWindow(int processId, int timeoutMilliseconds)"
    );
    const methodEnd = helper.indexOf("\n    }\n}\n\npublic sealed class LifecycleWindowRecord", methodStart);
    expect(methodStart).toBeGreaterThan(-1);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const method = helper.slice(methodStart, methodEnd);

    expect(helper).toContain("FindUnseenVisibleTopLevelWindow");
    expect(helper).toContain("handledWindows.Contains(hWnd)");
    expect(method).toContain("handledWindows.Add(hWnd)");
    expect(method.match(/ShowWindow\(/g)).toHaveLength(1);
    expect(method).not.toContain("FindVisibleTopLevelWindow");
  });

  it("exposes an explicit fail-closed endpoint-vacancy protocol mode", () => {
    expect(helper).toContain("'VerifyEndpointVacant'");
    expect(helper).toContain("function Invoke-VerifyEndpointVacant");
    expect(helper).toContain("reason = 'listener_present'");
    expect(helper).toContain("status = 'vacant'");
    expect(helper).toContain("[LifecycleProcessHandle]::Open($listenerPid, $false)");
    expect(helper).toContain("$listenerException.Reason -eq 'pid_not_found'");
  });

  it.runIf(platform() === "win32")(
    "distinguishes an owned loopback listener from a vacant endpoint",
    async () => {
      const server = createServer();
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TCP test listener has no port");
      const request = `${JSON.stringify({
        endpoint: { host: "127.0.0.1", port: address.port },
      })}\n`;

      try {
        const occupiedText = execFileSync(
          "powershell.exe",
          [
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", helperPath, "-Mode", "VerifyEndpointVacant",
          ],
          { input: request, encoding: "utf8", windowsHide: true, timeout: 20_000 }
        );
        const occupied = JSON.parse(occupiedText.trim()) as {
          ok: boolean;
          status: string;
          reason: string;
          listenerPid: number;
        };
        expect(occupied).toMatchObject({
          ok: false,
          status: "refused",
          reason: "listener_present",
          listenerPid: process.pid,
        });
      } finally {
        await new Promise<void>((resolvePromise, reject) => {
          server.close((error) => error ? reject(error) : resolvePromise());
        });
      }

      const vacantText = execFileSync(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", helperPath, "-Mode", "VerifyEndpointVacant",
        ],
        { input: request, encoding: "utf8", windowsHide: true, timeout: 20_000 }
      );
      expect(JSON.parse(vacantText.trim())).toMatchObject({ ok: true, status: "vacant" });
    },
    30_000
  );

  it.runIf(platform() === "win32")(
    "inspects the caller through an exact Windows process handle",
    () => {
      const response = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          helperPath,
          "-Mode",
          "InspectCurrent",
        ],
        {
          input: `${JSON.stringify({ pid: process.pid })}\n`,
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        }
      );
      const parsed = JSON.parse(response.trim()) as {
        ok: boolean;
        identity: { pid: number; executablePath: string; creationTime: string; userSid: string };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.identity.pid).toBe(process.pid);
      expect(parsed.identity.executablePath.length).toBeGreaterThan(0);
      expect(parsed.identity.creationTime).toMatch(/^[1-9][0-9]+$/);
      expect(parsed.identity.userSid).toMatch(/^S-/);
    },
    30_000
  );

  it.runIf(platform() === "win32")(
    "holds the real global mutex for the complete callback",
    async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), "reforger-forge-native-mutex-"));
      roots.push(stateRoot);
      const mutexName = `Global\\ReforgerForge.Test.${Date.now()}.${process.pid}`;
      const first = new WorkbenchProcessGuard({
        stateDir: join(stateRoot, "first"), helperPath, mutexName, lockTimeoutMs: 10_000,
      });
      const second = new WorkbenchProcessGuard({
        stateDir: join(stateRoot, "second"), helperPath, mutexName, lockTimeoutMs: 10_000,
      });
      let releaseFirst!: () => void;
      const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
      const order: string[] = [];
      const firstRun = first.withLifecycleLock(async () => {
        order.push("first-enter");
        firstEntered();
        await release;
        order.push("first-exit");
      });
      await entered;
      const secondRun = second.withLifecycleLock(async () => { order.push("second-enter"); });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(order).toEqual(["first-enter"]);
      releaseFirst();
      await Promise.all([firstRun, secondRun]);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    },
    45_000
  );

  it.runIf(platform() === "win32")(
    "recovers an abandoned real global mutex",
    async () => {
      const mutexName = `Global\\ReforgerForge.Abandon.${Date.now()}.${process.pid}`;
      const encoded = (source: string): string =>
        Buffer.from(source, "utf16le").toString("base64");
      const lineFrom = (child: ReturnType<typeof spawn>): Promise<string> =>
        new Promise((resolvePromise, reject) => {
          let buffer = "";
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline >= 0) resolvePromise(buffer.slice(0, newline).trim());
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (!buffer.includes("\n")) reject(new Error(`mutex worker exited early (${code})`));
          });
        });
      const ownerScript = [
        "$m=[Threading.Mutex]::new($false,$env:RR_MUTEX_NAME)",
        "$null=$m.WaitOne()",
        "[Console]::Out.WriteLine('ready')",
        "[Console]::Out.Flush()",
        "$null=[Console]::In.ReadLine()",
        "[Environment]::Exit(0)",
      ].join("\n");
      const anchorScript = [
        "$m=[Threading.Mutex]::OpenExisting($env:RR_MUTEX_NAME)",
        "[Console]::Out.WriteLine('anchored')",
        "[Console]::Out.Flush()",
        "$null=[Console]::In.ReadLine()",
        "$m.Dispose()",
      ].join("\n");
      const environment = { ...process.env, RR_MUTEX_NAME: mutexName };
      const owner = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(ownerScript),
      ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment });
      expect(await lineFrom(owner)).toBe("ready");
      const ownerClosed = new Promise<void>((resolvePromise) => owner.once("close", () => resolvePromise()));

      const anchor = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(anchorScript),
      ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment });
      expect(await lineFrom(anchor)).toBe("anchored");
      const anchorClosed = new Promise<void>((resolvePromise) => anchor.once("close", () => resolvePromise()));

      const contender = spawn("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", helperPath, "-Mode", "HoldMutex",
      ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      contender.stdin?.write(`${JSON.stringify({ mutexName, timeoutMs: 10_000 })}\n`);
      const acquiredLine = lineFrom(contender);
      const contenderClosed = new Promise<void>((resolvePromise) =>
        contender.once("close", () => resolvePromise())
      );

      owner.stdin?.end("abandon\n");
      await ownerClosed;
      const acquired = JSON.parse(await acquiredLine) as {
        ok: boolean;
        status: string;
        abandoned: boolean;
      };
      expect(acquired).toMatchObject({ ok: true, status: "acquired", abandoned: true });
      contender.stdin?.end("release\n");
      await contenderClosed;
      anchor.stdin?.end("close\n");
      await anchorClosed;
    },
    45_000
  );

  it.runIf(platform() === "win32")(
    "verifies the owner argument and terminates through the same retained handle",
    async () => {
      const ownerArgument = `-reforgerForgeOwnerToken=native-${Date.now()}-${process.pid}`;
      const workerRoot = mkdtempSync(join(tmpdir(), "reforger-forge-native-owner-"));
      roots.push(workerRoot);
      const workerScript = join(workerRoot, "owner-worker.cmd");
      writeFileSync(
        workerScript,
        "@ping -n 31 127.0.0.1 >nul\r\n",
        "utf8"
      );
      const worker = spawn(
        "cmd.exe",
        ["/d", "/c", workerScript, ownerArgument],
        { stdio: "ignore", windowsHide: true }
      );
      const closed = new Promise<number | null>((resolvePromise) =>
        worker.once("close", (code) => resolvePromise(code))
      );
      await new Promise<void>((resolvePromise, reject) => {
        worker.once("spawn", resolvePromise);
        worker.once("error", reject);
      });
      expect(worker.pid).toBeTypeOf("number");

      const inspectText = execFileSync(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", helperPath, "-Mode", "InspectProcess",
        ],
        {
          input: `${JSON.stringify({
            pid: worker.pid,
            expectedOwnerTokenArgument: ownerArgument,
          })}\n`,
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        }
      );
      const inspected = JSON.parse(inspectText.trim()) as {
        ok: boolean;
        ownerArgumentMatched: boolean;
        identity: { pid: number; executablePath: string; creationTime: string };
      };
      expect(inspected.ok).toBe(true);
      expect(inspected.ownerArgumentMatched).toBe(true);

      const terminateText = execFileSync(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", helperPath, "-Mode", "VerifyTerminate",
        ],
        {
          input: `${JSON.stringify({
            expected: {
              ...inspected.identity,
              ownerTokenArgument: ownerArgument,
              launchedAtMs: Date.now(),
            },
            timeoutMs: 10_000,
          })}\n`,
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        }
      );
      const terminated = JSON.parse(terminateText.trim()) as {
        ok: boolean;
        status: string;
      };
      expect(terminated).toMatchObject({ ok: true, status: "terminated" });
      await expect(closed).resolves.not.toBeNull();
    },
    45_000
  );
});
