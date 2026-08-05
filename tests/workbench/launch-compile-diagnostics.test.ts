import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchError } from "../../src/workbench/client.js";
import { WorkbenchReadinessError } from "../../src/workbench/readiness.js";
import {
  cleanupRestartOwnershipFixtures,
  createHarness,
  type Harness,
} from "./restart-ownership-fixture.js";

afterEach(cleanupRestartOwnershipFixtures);

describe("MCP Workbench launch compile-failure triage", () => {
  it("classifies an exact owner-attributed Game compile error instead of downstream Ping failure", async () => {
    let harness!: Harness;
    harness = createHarness({
      companionReadiness: async (options) => {
        const ownerArgument = harness.spawnArgs[0].find((argument) =>
          argument.startsWith("-reforgerForgeOwnerToken=")
        );
        if (!ownerArgument) throw new Error("fixture launch omitted owner token");
        const logDirectory = join(options.companion.workbenchProfilePath, "logs", "logs-current");
        mkdirSync(logDirectory, { recursive: true });
        writeFileSync(join(logDirectory, "console.log"), `CLI Params: ${ownerArgument}\n`);
        writeFileSync(join(logDirectory, "script.log"), [
          "21:56:44.935    SCRIPT    (E): Can't compile \"Game\" script module!",
          "",
          "Scripts/Game/Presentation/RV_BoundaryCurtainComponent.c(581): method exceeds VM stack",
          "21:56:45.005    SCRIPT    (W): Failed to load",
        ].join("\n"));
        throw new WorkbenchReadinessError(
          "Workbench did not become ready before the absolute deadline. " +
            "Last Ping error: Workbench error: Undefined API func",
          "TIMEOUT"
        );
      },
    });

    const launchError = await harness.client.ensureRunning(harness.projectPath).then(
      () => null,
      (error: unknown) => error
    );
    expect(launchError).toMatchObject({
      code: "PROJECT_COMPILE_FAILED",
      message: expect.stringContaining(
        "Scripts/Game/Presentation/RV_BoundaryCurtainComponent.c(581): method exceeds VM stack"
      ),
      remedyDecision: { kind: "message_owns_recovery" },
    });
    expect((launchError as WorkbenchError).message).toContain("call wb_check with");
    expect((launchError as WorkbenchError).message).toContain(
      JSON.stringify({ gprojPath: harness.projectPath })
    );
    expect((launchError as WorkbenchError).message.match(/wb_check/g)).toHaveLength(1);
    expect(harness.backend.terminationCalls).toHaveLength(1);
    expect(harness.backend.workbenchPids.size).toBe(0);

    await expect(harness.client.diagnose()).resolves.toMatchObject({
      lastLaunchFailure: {
        code: "PROJECT_COMPILE_FAILED",
        module: "Game",
        diagnostics: [
          "Scripts/Game/Presentation/RV_BoundaryCurtainComponent.c(581): method exceeds VM stack",
        ],
      },
    });
  });

  it("does not let compiler logs mask an authoritative endpoint-identity failure", async () => {
    let harness!: Harness;
    harness = createHarness({
      companionReadiness: async (options) => {
        const ownerArgument = harness.spawnArgs[0].find((argument) =>
          argument.startsWith("-reforgerForgeOwnerToken=")
        );
        if (!ownerArgument) throw new Error("fixture launch omitted owner token");
        const logDirectory = join(options.companion.workbenchProfilePath, "logs", "logs-current");
        mkdirSync(logDirectory, { recursive: true });
        writeFileSync(join(logDirectory, "console.log"), `CLI Params: ${ownerArgument}\n`);
        writeFileSync(join(logDirectory, "script.log"), [
          "21:56:44.935    SCRIPT    (E): Can't compile \"Game\" script module!",
          "",
          "Scripts/Game/Broken.c(9): Syntax error",
        ].join("\n"));
        throw new WorkbenchError(
          "Workbench endpoint ownership could not be proven",
          "IDENTITY_UNVERIFIABLE"
        );
      },
    });

    await expect(harness.client.ensureRunning(harness.projectPath)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIABLE",
      message: "Workbench endpoint ownership could not be proven",
    });
    await expect(harness.client.diagnose()).resolves.not.toHaveProperty("lastLaunchFailure");
  });
});
