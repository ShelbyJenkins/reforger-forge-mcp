import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import {
  assertSteamClientReady,
  assertWorkbenchStateOwnerReady,
  executeWorkbenchRunnerCli,
  receiptExitCode,
  type WorkbenchRunnerCliDependencies,
} from "../../src/workbench/runner-cli.js";
import {
  classifyWorkbenchExitStatus,
  type WorkbenchCheckReceipt,
  type WorkbenchEditorReceipt,
  type WorkbenchRunnerExitStatus,
} from "../../src/workbench/runner.js";

const CLI_ARGUMENTS = ["editor", "--gproj", "C:\\target\\project.gproj", "--foreground"];

function receipt(exitStatus: WorkbenchRunnerExitStatus): WorkbenchEditorReceipt {
  return {
    intent: "editor",
    pid: 42,
    target: "<target.gproj>",
    lifecycleGeneration: "generation",
    endpointOwnership: "verified",
    companionIdentity: {
      addonId: "ReforgerForgeWorkbenchHelper",
      addonGuid: "5E7D1D4A3F2B8C90",
      addonVersion: "1.0.0",
      protocolVersion: "1",
      workbenchProtocol: "1",
      buildIdentity: "build",
      bundleDigest: "a".repeat(64),
    },
    logDirectory: "<log>",
    exitStatus,
  };
}

function status(
  reason: WorkbenchRunnerExitStatus["reason"],
  exitCode: number | null
): WorkbenchRunnerExitStatus {
  return classifyWorkbenchExitStatus({
    reason,
    exitCode,
    signal: null,
    timedOut: reason === "timed_out",
  });
}

function checkReceipt(): WorkbenchCheckReceipt {
  return {
    intent: "check",
    scope: "enforceScripts",
    engineValidated: true,
    pid: 43,
    executablePath: "C:\\tools\\Workbench.exe",
    creationTime: "133900000000000043",
    target: "C:\\target\\project.gproj",
    targetAddon: {
      addonId: "Example",
      addonGuid: "1122334455667788",
      sourceSha256: "a".repeat(64),
    },
    configuration: "PC",
    lifecycleGeneration: "check-generation",
    processOwnership: "verified",
    endpointVacancy: "verified",
    logDirectory: "C:\\logs\\check",
    compilation: {
      status: "failed",
      code: "PROJECT_COMPILE_FAILED",
      module: "Game",
      diagnostics: ["Broken.c(1): error"],
      logPath: "C:\\logs\\check\\script.log",
    },
    exitStatus: status("exited", -1),
  };
}

function dependencies(
  value: WorkbenchEditorReceipt,
  stdout: string[],
  stderr: string[]
): WorkbenchRunnerCliDependencies {
  return {
    loadConfiguration: () => ({} as Config),
    runIntent: vi.fn(async () => value) as NonNullable<WorkbenchRunnerCliDependencies["runIntent"]>,
    assertSteamReady: () => undefined,
    assertStateOwnerReady: () => undefined,
    stdout: { write: (line) => stdout.push(line) },
    stderr: { write: (line) => stderr.push(line) },
  };
}

describe("Workbench runner CLI contract", () => {
  it("forwards shared configuration flags to the loader without exposing them to the intent parser", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const config = { marker: "explicit-config", debug: true } as unknown as Config;
    const loadConfiguration = vi.fn(() => config);
    const setDebug = vi.fn();
    const runIntent = vi.fn(async (receivedConfig: Config) => {
      expect(receivedConfig).toBe(config);
      return receipt(status("exited", 0));
    }) as NonNullable<WorkbenchRunnerCliDependencies["runIntent"]>;

    await expect(executeWorkbenchRunnerCli([
      "editor",
      "--config", "C:\\instances\\observer.json",
      "--gproj", "C:\\target\\project.gproj",
      "--workbench-addon-dir", "C:\\addons\\first",
      "--workbench-addon-dir", "C:\\addons\\second",
      "--mcp-idle-shutdown-ms", "60000",
      "--debug",
      "--foreground",
    ], {
      loadConfiguration,
      setDebug,
      runIntent,
      assertSteamReady: () => undefined,
      assertStateOwnerReady: () => undefined,
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
    })).resolves.toBe(0);

    expect(loadConfiguration).toHaveBeenCalledOnce();
    expect(loadConfiguration).toHaveBeenCalledWith([
      "--config", "C:\\instances\\observer.json",
      "--workbench-addon-dir", "C:\\addons\\first",
      "--workbench-addon-dir", "C:\\addons\\second",
      "--mcp-idle-shutdown-ms", "60000",
      "--debug",
    ]);
    expect(setDebug).toHaveBeenCalledOnce();
    expect(setDebug).toHaveBeenCalledWith(true);
    expect(runIntent).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
  });

  it("reports the version without requiring configuration", async () => {
    const stdout: string[] = [];
    const loadConfiguration = vi.fn(() => ({} as Config));

    await expect(executeWorkbenchRunnerCli(["--version"], {
      loadConfiguration,
      packageVersion: () => "9.8.7",
      stdout: { write: (line) => stdout.push(line) },
    })).resolves.toBe(0);

    expect(loadConfiguration).not.toHaveBeenCalled();
    expect(stdout).toEqual(["9.8.7\n"]);
  });

  it.each([
    ["zero exit", status("exited", 0), 0],
    ["nonzero exit", status("exited", 1), 1],
    ["absolute deadline", status("timed_out", null), 124],
    ["abort", status("aborted", null), 130],
  ] as const)("maps %s to exit code %i and emits one JSON receipt", async (
    _label,
    exitStatus,
    expectedCode
  ) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const value = receipt(exitStatus);

    await expect(executeWorkbenchRunnerCli(
      CLI_ARGUMENTS,
      dependencies(value, stdout, stderr)
    )).resolves.toBe(expectedCode);

    expect(receiptExitCode(value)).toBe(expectedCode);
    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual([]);
    expect(stdout[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout[0])).toEqual(value);
  });

  it.each([
    ["unsigned", 0xC0000005],
    ["signed", -1_073_741_819],
  ] as const)("normalizes an %s Windows access-violation status", (_label, exitCode) => {
    const exitStatus = status("exited", exitCode);

    expect(exitStatus).toMatchObject({
      classification: "windows_exception",
      nativeStatus: "0xC0000005",
      exceptionName: "STATUS_ACCESS_VIOLATION",
    });
    expect(receiptExitCode(receipt(exitStatus))).toBe(1);
  });

  it("maps Workbench compile-failure minus-one to portable exit 1 without losing the receipt", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const value = checkReceipt();
    const runIntent = vi.fn(async (_config: Config, intent) => {
      expect(intent).toEqual({
        kind: "check",
        gprojPath: "C:\\target\\project.gproj",
        configuration: "PC",
        timeoutMs: 120_000,
      });
      return value;
    }) as NonNullable<WorkbenchRunnerCliDependencies["runIntent"]>;

    await expect(executeWorkbenchRunnerCli([
      "check",
      "--gproj", "C:\\target\\project.gproj",
      "--configuration", "PC",
      "--timeout-ms", "120000",
    ], {
      loadConfiguration: () => ({} as Config),
      runIntent,
      assertSteamReady: () => undefined,
      assertStateOwnerReady: () => undefined,
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
    })).resolves.toBe(1);

    expect(receiptExitCode(value)).toBe(1);
    expect(JSON.parse(stdout[0])).toEqual(value);
    expect(JSON.parse(stdout[0]).exitStatus.exitCode).toBe(-1);
    expect(stderr).toEqual([]);
  });

  it("emits one redacted JSON error record and no success record", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const privateToken = "-reforgerForgeOwnerToken=private-cli-secret";
    const failure = Object.assign(new Error(`spawn refused for ${privateToken}`), {
      code: "SPAWN_FAILED",
    });
    const runIntent = vi.fn(async () => { throw failure; }) as NonNullable<
      WorkbenchRunnerCliDependencies["runIntent"]
    >;

    await expect(executeWorkbenchRunnerCli(CLI_ARGUMENTS, {
      loadConfiguration: () => ({} as Config),
      runIntent,
      assertSteamReady: () => undefined,
      assertStateOwnerReady: () => undefined,
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
    })).resolves.toBe(1);

    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).not.toContain("private-cli-secret");
    expect(JSON.parse(stderr[0])).toMatchObject({
      ok: false,
      code: "SPAWN_FAILED",
      message: expect.stringContaining("[redacted]"),
    });
  });

  it("emits one prerequisite error and never invokes the runner when Steam is absent", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runIntent = vi.fn();

    await expect(executeWorkbenchRunnerCli(CLI_ARGUMENTS, {
      loadConfiguration: () => ({} as Config),
      runIntent,
      assertSteamReady: () => assertSteamClientReady({
        platform: "win32",
        listProcesses: () => "",
      }),
      assertStateOwnerReady: () => undefined,
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
    })).resolves.toBe(1);

    expect(runIntent).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0])).toMatchObject({
      ok: false,
      code: "STEAM_CLIENT_NOT_RUNNING",
      message: expect.stringMatching(/Start Steam.*No Workbench process was launched/i),
    });
  });

  it("accepts an exact PowerShell Steam process name as prerequisite evidence", () => {
    expect(() => assertSteamClientReady({
      platform: "win32",
      listProcesses: () => "steam\r\n",
    })).not.toThrow();
  });

  it("emits one prerequisite error before the runner opens another identity's state", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const runIntent = vi.fn();

    await expect(executeWorkbenchRunnerCli(CLI_ARGUMENTS, {
      loadConfiguration: () => ({} as Config),
      runIntent,
      assertSteamReady: () => undefined,
      assertStateOwnerReady: () => assertWorkbenchStateOwnerReady({
        platform: "win32",
        inspectOwnership: () => ({
          currentSid: "S-1-5-21-1005",
          stateDirectoryExists: true,
          stateOwnerSid: "S-1-5-21-1002",
        }),
      }),
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
    })).resolves.toBe(1);

    expect(runIntent).not.toHaveBeenCalled();
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0])).toMatchObject({
      ok: false,
      code: "WORKBENCH_STATE_OWNER_MISMATCH",
      message: expect.stringMatching(
        /owned by a different Windows identity.*No Workbench process was launched/i
      ),
    });
  });

  it("accepts absent state or state owned by the current Windows identity", () => {
    expect(() => assertWorkbenchStateOwnerReady({
      platform: "win32",
      inspectOwnership: () => ({
        currentSid: "S-1-5-21-1002",
        stateDirectoryExists: false,
        stateOwnerSid: null,
      }),
    })).not.toThrow();

    expect(() => assertWorkbenchStateOwnerReady({
      platform: "win32",
      inspectOwnership: () => ({
        currentSid: "S-1-5-21-1002",
        stateDirectoryExists: true,
        stateOwnerSid: "s-1-5-21-1002",
      }),
    })).not.toThrow();
  });
});
