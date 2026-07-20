import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import {
  executeWorkbenchRunnerCli,
  receiptExitCode,
  type WorkbenchRunnerCliDependencies,
} from "../../src/workbench/runner-cli.js";
import type {
  WorkbenchEditorRunnerReceipt,
  WorkbenchRunnerExitStatus,
} from "../../src/workbench/runner.js";

const CLI_ARGUMENTS = ["editor", "--gproj", "C:\\target\\project.gproj", "--foreground"];

function receipt(exitStatus: WorkbenchRunnerExitStatus): WorkbenchEditorRunnerReceipt {
  return {
    version: 2,
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
  return {
    reason,
    exitCode,
    signal: null,
    timedOut: reason === "timed_out",
  };
}

function dependencies(
  value: WorkbenchEditorRunnerReceipt,
  stdout: string[],
  stderr: string[]
): WorkbenchRunnerCliDependencies {
  return {
    loadConfiguration: () => ({} as Config),
    runIntent: vi.fn(async () => value) as NonNullable<WorkbenchRunnerCliDependencies["runIntent"]>,
    stdout: { write: (line) => stdout.push(line) },
    stderr: { write: (line) => stderr.push(line) },
  };
}

describe("Workbench runner CLI contract", () => {
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
});
