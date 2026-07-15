import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";

function projectScript(name: string): string {
  return readFileSync(
    new URL(`../../../addons/RoadblockRunners/${name}`, import.meta.url),
    "utf8"
  );
}

function quotePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

describe("Roadblock Runners Workbench launchers", () => {
  const guardPath = fileURLToPath(
    new URL("../../../addons/RoadblockRunners/workbench_process_guard.ps1", import.meta.url)
  );
  const guard = projectScript("workbench_process_guard.ps1");
  const start = projectScript("start_workbench.ps1");
  const launch = projectScript("launch_workbench.ps1");
  const build = projectScript("build_workbench.ps1");

  it("uses the exact Node-compatible atomic machine-wide lock in every launcher", () => {
    expect(guard).toContain("reforger-forge-mcp-workbench.launch.lock");
    expect(guard).toContain("[IO.FileMode]::CreateNew");
    expect(guard).toContain("[IO.FileShare]::None");
    expect(guard).toContain("[IO.FileOptions]::DeleteOnClose");

    for (const source of [start, launch, build]) {
      expect(source).toContain("workbench_process_guard.ps1");
      expect(source).toContain("$LaunchLock = Enter-RRWorkbenchLaunchLock");
      expect(source).toContain("Assert-RRNoWorkbenchProcess");
      expect(source).toContain("Exit-RRWorkbenchLaunchLock -Lock $LaunchLock");
    }
  });

  it("never reclaims an aged lock without proving its holder PID is absent", () => {
    expect(guard).toContain("if (-not (Test-RRProcessIdAlive -ProcessId $holderPid))");
    expect(guard).toContain("Remove-Item -LiteralPath $script:RRWorkbenchLaunchLockPath");
    expect(guard.indexOf("Test-RRProcessIdAlive -ProcessId $holderPid"))
      .toBeLessThan(guard.indexOf("Remove-Item -LiteralPath $script:RRWorkbenchLaunchLockPath"));
    expect(guard).toContain("Access denial or another inspection failure must never authorize stale");
  });

  it.runIf(platform() === "win32")(
    "bounds a stale FileShare.None collision even when lock read and deletion fail",
    () => {
      const root = mkdtempSync(join(tmpdir(), "rr-powershell-lock-test-"));
      const lockPath = join(root, "reforger-forge-mcp-workbench.launch.lock");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `. '${quotePowerShell(guardPath)}'`,
        `$script:RRWorkbenchLaunchLockPath = '${quotePowerShell(lockPath)}'`,
        "[IO.File]::WriteAllText($script:RRWorkbenchLaunchLockPath, '{\"pid\":0}')",
        "(Get-Item -LiteralPath $script:RRWorkbenchLaunchLockPath).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-5)",
        "$held = [IO.File]::Open($script:RRWorkbenchLaunchLockPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)",
        "$timer = [Diagnostics.Stopwatch]::StartNew()",
        "try {",
        "  try {",
        "    $unexpected = Enter-RRWorkbenchLaunchLock -TimeoutSeconds 1 -StaleSeconds 30",
        "    throw 'unexpectedly acquired the exclusively held lock'",
        "  } catch {",
        "    if (-not $_.Exception.Message.Contains('Timed out waiting for the machine-wide Workbench launch lock')) { throw }",
        "  }",
        "  if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'lock timeout was not bounded' }",
        "} finally {",
        "  $held.Dispose()",
        "  Remove-Item -LiteralPath $script:RRWorkbenchLaunchLockPath -Force -ErrorAction SilentlyContinue",
        "}",
      ].join("\r\n");
      const encoded = Buffer.from(script, "utf16le").toString("base64");

      try {
        expect(() => execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
          { timeout: 10_000, windowsHide: true, stdio: "pipe" }
        )).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000
  );

  it.runIf(platform() === "win32")(
    "writes a durable PowerShell owner marker that Node reads without BOM loss",
    () => {
      const root = mkdtempSync(join(tmpdir(), "rr-powershell-owner-test-"));
      const markerPath = join(root, "reforger-forge-mcp-workbench.owner.json");
      const projectPath = join(root, "RoadblockRunners.gproj");
      const token = "de305d54-75b4-431b-adb2-eb6b9e546014";
      const script = [
        "$ErrorActionPreference = 'Stop'",
        `. '${quotePowerShell(guardPath)}'`,
        `$script:RRWorkbenchOwnerMarkerPath = '${quotePowerShell(markerPath)}'`,
        "$process = [Diagnostics.Process]::GetCurrentProcess()",
        "Write-RRWorkbenchOwnerMarker `",
        "  -Process $process `",
        "  -ExecutablePath $process.MainModule.FileName `",
        `  -OwnerToken '${token}' \``,
        `  -ProjectFile '${quotePowerShell(projectPath)}'`,
      ].join("\r\n");
      const encoded = Buffer.from(script, "utf16le").toString("base64");

      try {
        execFileSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
          { timeout: 10_000, windowsHide: true, stdio: "pipe" }
        );
        const bytes = readFileSync(markerPath);
        const nodeGuard = new WorkbenchProcessGuard({ stateDir: root });
        const marker = nodeGuard.readOwnerMarker();

        expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
        expect(marker).toMatchObject({
          version: 1,
          token,
          commandLineToken: `-reforgerForgeOwnerToken=${token}`,
          gprojPath: projectPath,
          host: "127.0.0.1",
          port: 5775,
        });
        expect(marker?.pid).toBeGreaterThan(0);
        expect(marker?.creationTimeMs).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("persists a BOM-free owner marker with PID-reuse defenses for detached launches", () => {
    expect(start).toContain("$OwnerToken = [Guid]::NewGuid().ToString('D')");
    expect(start).toContain('"-reforgerForgeOwnerToken=$OwnerToken"');
    expect(start).toContain("Write-RRWorkbenchOwnerMarker");
    expect(guard).toContain('commandLineToken = "-reforgerForgeOwnerToken=$OwnerToken"');
    expect(guard).toContain("$Process.StartTime.ToUniversalTime()");
    expect(guard).toContain("[Text.UTF8Encoding]::new($false)");
  });

  it("kills only the exact Process object and confirms exit on failure", () => {
    expect(guard).toContain("$Process.Kill()");
    expect(guard).toContain("$Process.WaitForExit($TimeoutSeconds * 1000)");
    expect(guard).not.toContain("taskkill");
    expect(guard).not.toContain("Stop-Process -Name");
    expect(build).not.toContain("Stop-Process");
    expect(start).not.toContain("Stop-Process");
  });

  it("runs ResourceManager buildData silently against an isolated platform target", () => {
    expect(build).toContain("RoadblockRunners\\WorkbenchBuild\\PC");
    expect(build).toContain("'-wbSilent'");
    expect(build).toContain("'-wbModule=ResourceManager'");
    expect(build).toContain("'-buildData', 'PC', ('\"{0}\"' -f $BuildTarget)");
    expect(build).toContain("'-loadBuiltData'");
    expect(build).toContain("$OwnerArgument = \"-reforgerForgeOwnerToken=$OwnerToken\"");
  });

  it("requires exactly one attributable nonempty log directory before releasing the lock", () => {
    expect(build).toContain("$NewLogDirectories.Count -ne 1");
    expect(build).toContain("exactly one attributable directory is required");
    expect(build).toContain("must contain at least one nonempty .log file");
    expect(build).toContain("$OwnerTokenObserved = $false");
    expect(build).toContain("if ($line.Contains($OwnerArgument))");
    expect(build).toContain("if (-not $OwnerTokenObserved)");
    expect(build).toContain("assertion failed|resources are leaking!|\\bout of memory\\b");

    const logAudit = build.indexOf("$NewLogDirectories = @(");
    const finalUnlock = build.lastIndexOf("Exit-RRWorkbenchLaunchLock -Lock $LaunchLock");
    expect(logAudit).toBeGreaterThan(-1);
    expect(finalUnlock).toBeGreaterThan(logAudit);
  });

  it("fails closed if process-table inspection cannot prove Workbench is absent", () => {
    expect(guard).toContain("Get-Process -ErrorAction Stop");
    expect(guard).toContain("Cannot prove that Workbench is absent because process inspection failed");
    expect(guard).toContain("No process was launched");
  });
});
