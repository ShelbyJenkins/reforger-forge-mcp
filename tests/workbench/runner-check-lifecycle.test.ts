import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRunnerHarnesses,
  closeRunnerChild,
  createHarness,
  createOwnedRunnerChild,
  exitAfterDurablePublication,
  runCheck,
} from "./runner-fixture.js";

afterEach(cleanupRunnerHarnesses);

describe("guarded Enforce Script check runner", () => {
  it("runs one hidden helper-free compile-only process and returns a success receipt", async () => {
    const harness = createHarness();
    const journalPhases: string[] = [];
    harness.backend.spawnJournalReplaceFailure = ({ next }) => {
      journalPhases.push(`${next.record.metadata.purpose}:${next.record.phase}`);
      return null;
    };
    const exitAfterPublication = exitAfterDurablePublication(harness);
    let observedArguments: readonly string[] = [];
    const receipt = await runCheck(harness, (command, args, options) => {
      observedArguments = args;
      expect(options.windowsHide).toBe(true);
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: 24_001,
        logName: "successful-check",
      });
      writeFileSync(join(harness.logRoot, "successful-check", "script.log"), "Scripts compiled\n");
      exitAfterPublication(() => closeRunnerChild(harness, child, 0));
      return child;
    });

    expect(receipt).toMatchObject({
      intent: "check",
      scope: "enforceScripts",
      engineValidated: true,
      pid: 24_001,
      target: harness.projectPath,
      configuration: "PC",
      processOwnership: "verified",
      endpointVacancy: "verified",
      logDirectory: join(harness.logRoot, "successful-check"),
      compilation: { status: "compiled" },
      exitStatus: { classification: "success", exitCode: 0 },
    });
    expect(observedArguments.slice(observedArguments.indexOf("-wbsilent"))).toEqual([
      "-wbsilent",
      "-wbModule=ScriptEditor",
      "-validate",
      "PC",
    ]);
    expect(observedArguments).not.toContain("-run");
    expect(observedArguments).not.toContain("-builddata");
    expect(observedArguments).not.toContain("-addons");
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(journalPhases).toEqual([
      "target_check:pre_spawn",
      "target_check:spawned_unverified",
      "target_check:identity_verified",
      "target_check:published",
    ]);
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });

  it("classifies an attributed compiler failure without losing native minus-one", async () => {
    const harness = createHarness();
    const exitAfterPublication = exitAfterDurablePublication(harness);
    const receipt = await runCheck(harness, (command, args) => {
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: 24_002,
        logName: "failed-check",
      });
      writeFileSync(join(harness.logRoot, "failed-check", "script.log"), [
        'SCRIPT       : Can\'t compile "Game" script module!',
        "scripts/Game/Broken.c(7): Unexpected token '}'",
        "12:00:00.000 ENGINE : shutdown",
      ].join("\n"));
      exitAfterPublication(() => closeRunnerChild(harness, child, -1));
      return child;
    });

    expect(receipt).toMatchObject({
      intent: "check",
      compilation: {
        status: "failed",
        code: "PROJECT_COMPILE_FAILED",
        module: "Game",
        diagnostics: ["scripts/Game/Broken.c(7): Unexpected token '}'"],
        logPath: join(harness.logRoot, "failed-check", "script.log"),
      },
      exitStatus: {
        reason: "exited",
        exitCode: -1,
        classification: "nonzero_exit",
      },
    });
  });

  it("rejects an absent project configuration before native spawn", async () => {
    const harness = createHarness();
    const spawnProcess = vi.fn();

    await expect(runCheck(harness, spawnProcess, {
      intent: { configuration: "SERVER" },
    })).rejects.toMatchObject({ code: "INVALID_TARGET" });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await harness.guard.readLifecycleState()).toMatchObject({ kind: "missing" });
  });

  it("keeps native exceptions distinct when no attributed compiler marker exists", async () => {
    const harness = createHarness();
    const exitAfterPublication = exitAfterDurablePublication(harness);
    const receipt = await runCheck(harness, (command, args) => {
      const { child } = createOwnedRunnerChild(harness, command, args, {
        pid: 24_003,
        logName: "exception-check",
      });
      writeFileSync(join(harness.logRoot, "exception-check", "script.log"), "native failure\n");
      exitAfterPublication(() => closeRunnerChild(harness, child, 0xC0000005));
      return child;
    });

    expect(receipt).toMatchObject({
      compilation: { status: "indeterminate", code: "COMPILATION_INDETERMINATE" },
      exitStatus: {
        classification: "windows_exception",
        nativeStatus: "0xC0000005",
        exceptionName: "STATUS_ACCESS_VIOLATION",
      },
    });
  });

  it("preserves the check deadline classification after exact-child cleanup", async () => {
    const harness = createHarness();

    await expect(runCheck(harness, (command, args) =>
      createOwnedRunnerChild(harness, command, args, {
        pid: 24_004,
        logName: "timed-check",
      }).child, {
      intent: { timeoutMs: 25 },
    })).rejects.toMatchObject({ code: "CHECK_DEADLINE_EXCEEDED" });

    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(await harness.guard.readLifecycleState()).toMatchObject({
      kind: "valid",
      state: { phase: "vacant", workbench: null, operation: null },
    });
  });
});
