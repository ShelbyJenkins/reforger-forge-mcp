import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupRunnerHarnesses,
  createBuildSpawner,
  createHarness,
  runBuild,
  writeResourceDatabase,
} from "./runner-fixture.js";

afterEach(cleanupRunnerHarnesses);

describe("standalone Workbench lifecycle runner", () => {
  it("refuses a nonempty output root before spawning either Workbench phase", async () => {
    const harness = createHarness();
    writeResourceDatabase(harness.outputPath, "stale database");
    const spawnProcess = vi.fn();

    await expect(runBuild(harness, spawnProcess)).rejects.toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects build output that overlaps the target mod or managed companion roots", async () => {
    const targetHarness = createHarness();
    const targetOutput = join(targetHarness.root, "addons", "ExampleMod", "build-output");
    await expect(runBuild(targetHarness, vi.fn(), {
      intent: { outputPath: targetOutput },
    })).rejects.toMatchObject({ code: "INVALID_INTENT" });

    const managedHarness = createHarness();
    const managedOutput = join(managedHarness.companion.workbenchProfilePath, "build-output");
    await expect(runBuild(managedHarness, vi.fn(), {
      intent: { outputPath: managedOutput },
    })).rejects.toMatchObject({ code: "INVALID_INTENT" });
  });

  it("rejects a filesystem alias whose canonical output overlaps the target mod", async () => {
    const harness = createHarness();
    const outputAlias = join(harness.root, "aliased-build-output");
    symlinkSync(join(harness.root, "addons", "ExampleMod"), outputAlias, "junction");

    await expect(runBuild(harness, vi.fn(), {
      intent: { outputPath: outputAlias },
    })).rejects.toMatchObject({ code: "INVALID_INTENT" });
  });

  it("returns a diagnostic receipt when exit zero produces no resource database", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, { pidBase: 22_400 });

    const receipt = await runBuild(harness, spawner.spawnProcess);

    expect(receipt).toMatchObject({
      version: 3,
      logDirectory: join(harness.logRoot, "build-22400"),
      output: null,
      validationFailure: {
        code: "OUTPUT_ATTESTATION_FAILED",
        message: expect.stringMatching(/exactly one regular resourceDatabase\.rdb/i),
      },
      exitStatus: { reason: "exited", exitCode: 0 },
    });
  });

  it("rejects a fresh zero-byte resource database as unattested output", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_500,
      onBuildBeforeExit: () => {
        writeResourceDatabase(harness.outputPath, "");
      },
    });

    const receipt = await runBuild(harness, spawner.spawnProcess);

    expect(receipt.intent === "build" && receipt.output).toBeNull();
    expect(receipt.intent === "build" && receipt.validationFailure).toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });
  });

  it("rejects exit-zero output containing more than one resource database", async () => {
    const harness = createHarness();
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_550,
      onBuildBeforeExit: () => {
        for (const name of ["A", "B"]) {
          writeResourceDatabase(harness.outputPath, `database ${name}`, name);
        }
      },
    });

    const receipt = await runBuild(harness, spawner.spawnProcess);

    expect(receipt.intent === "build" && receipt.output).toBeNull();
    expect(receipt.intent === "build" && receipt.validationFailure?.message)
      .toMatch(/exactly one regular resourceDatabase\.rdb; found 2/i);
  });

  it("rejects a post-build output symlink and redacts its private token from the receipt", async () => {
    const harness = createHarness();
    const externalRoot = join(harness.root, "external-output");
    mkdirSync(externalRoot, { recursive: true });
    let privateOwnerArgument = "";
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_600,
      onBuildBeforeExit: (args) => {
        privateOwnerArgument = args.find((arg) =>
          arg.startsWith("-reforgerForgeOwnerToken="))!;
        symlinkSync(
          externalRoot,
          join(harness.outputPath, `${privateOwnerArgument}-escape`),
          "junction"
        );
      },
    });

    // This case exercises post-build attestation, not deadline handling.
    // Leave enough headroom for junction creation in the parallel full suite.
    const receipt = await runBuild(harness, spawner.spawnProcess, {
      intent: { timeoutMs: 5_000 },
    });

    expect(receipt.intent === "build" && receipt.output).toBeNull();
    expect(receipt.intent === "build" && receipt.validationFailure).toMatchObject({
      code: "OUTPUT_ATTESTATION_FAILED",
    });
    expect(privateOwnerArgument).not.toBe("");
    expect(JSON.stringify(receipt)).not.toContain(privateOwnerArgument);
    expect(JSON.stringify(receipt)).toContain("[redacted]");
  });

  it("attributes preflight and target build under their dedicated managed log roots", async () => {
    const harness = createHarness();
    const preflightLogRoot = join(harness.companion.workbenchProfilePath, "logs");
    const buildLogRoot = join(
      harness.root,
      "managed",
      "workbench-build",
      "profile",
      "logs"
    );
    const spawner = createBuildSpawner(harness, {
      pidBase: 22_700,
      preflightLogRoot,
      buildLogRoot,
      onBuildBeforeExit: () => {
        writeResourceDatabase(harness.outputPath, "managed build");
      },
    });

    const receipt = await runBuild(harness, spawner.spawnProcess, {
      dependencies: { logRoot: undefined },
    });

    expect(receipt).toMatchObject({
      version: 3,
      preflight: { logDirectory: join(preflightLogRoot, "preflight-22700") },
      logDirectory: join(buildLogRoot, "build-22700"),
      validationFailure: null,
    });
    expect(receipt.intent === "build" && receipt.output).not.toBeNull();
  });

  it("accepts consecutive deterministic builds only when each uses a distinct empty output root", async () => {
    const harness = createHarness();
    const receipts = [];
    for (let index = 0; index < 2; index += 1) {
      const outputPath = join(harness.root, "build", `run-${index}`, "PC");
      const spawner = createBuildSpawner(harness, {
        pidBase: 22_800 + index * 10,
        onBuildBeforeExit: () => {
          writeResourceDatabase(outputPath, "deterministic database");
        },
      });
      receipts.push(await runBuild(harness, spawner.spawnProcess, {
        intent: { outputPath },
      }));
    }

    expect(receipts.map((receipt) => receipt.intent === "build"
      ? receipt.output?.resourceDatabaseSha256
      : null)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(receipts[0].intent === "build" && receipts[1].intent === "build" &&
      receipts[0].output?.resourceDatabaseSha256)
      .toBe(receipts[1].intent === "build" ? receipts[1].output?.resourceDatabaseSha256 : null);
  });

});
