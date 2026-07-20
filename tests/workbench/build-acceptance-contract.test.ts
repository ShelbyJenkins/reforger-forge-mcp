import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import {
  LIVE_WORKBENCH_BUILD_ENVIRONMENT,
  WORKBENCH_BUILD_ACCEPTANCE_SOURCE_PATHS,
  assertLiveWorkbenchBuildAuthorized,
  assertSanitizedBuildAcceptanceArtifact,
  attestFreshBuildOutput,
  parseWorkbenchBuildAcceptanceArguments,
  runWorkbenchBuildAcceptance,
  type RepositoryAcceptanceEvidence,
  type TargetBuildAcceptanceRunEvidence,
} from "../../scripts/run-workbench-build-acceptance.js";

const roots: string[] = [];
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const ZERO_COUNTS = Object.freeze({ active: 0, reconciling: 0, total: 0 });

interface Harness {
  root: string;
  gprojPath: string;
  outputParent: string;
  validationRoot: string;
  config: Config;
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-build-acceptance-"));
  roots.push(root);
  const targetRoot = join(root, "target", "ExampleAddon");
  const gprojPath = join(targetRoot, "ExampleAddon.gproj");
  const outputParent = join(root, "retained-output");
  const validationRoot = join(root, "validation");
  const toolsRoot = join(root, "tools");
  const gameRoot = join(root, "game");
  const baseAddons = join(gameRoot, "addons");
  for (const directory of [targetRoot, outputParent, validationRoot, toolsRoot, baseAddons]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(gprojPath, [
    "GameProject {",
    " ID ExampleAddon",
    ' GUID "1122334455667788"',
    "}",
    "",
  ].join("\n"));
  return {
    root,
    gprojPath: resolve(gprojPath),
    outputParent: resolve(outputParent),
    validationRoot: resolve(validationRoot),
    config: {
      workbenchPath: resolve(toolsRoot),
      projectPath: resolve(dirname(targetRoot)),
      gamePath: resolve(gameRoot),
      workbenchAddonDirs: [resolve(baseAddons)],
      workbenchScriptAuthorizeAll: false,
      dataDir: resolve(root, "data"),
      patternsDir: resolve(root, "data", "patterns"),
      workbenchHost: "127.0.0.1",
      workbenchPort: 5775,
    },
  };
}

function repositoryEvidence(): RepositoryAcceptanceEvidence {
  return {
    revision: "c".repeat(40),
    dirty: true,
    sourceClosureSha256: SHA_A,
    sourceMembers: WORKBENCH_BUILD_ACCEPTANCE_SOURCE_PATHS.map((path) => ({
      path,
      sha256: SHA_B,
    })),
  };
}

function validRun(sequence: 1 | 2): TargetBuildAcceptanceRunEvidence {
  return {
    sequence,
    planKind: "target_build",
    normalizedArguments: [
      "-profile",
      "<managed-build-profile>",
      "-noThrow",
      "-gproj",
      "<target.gproj>",
      "<owner-token:redacted>",
      "-wbModule=ResourceManager",
      "-builddata",
      "PC",
      `<exclusive-output-${sequence}>`,
      "ExampleAddon",
    ],
    initialWorkbenchVacancy: true,
    initialEndpointVacancy: true,
    spawnCount: 1,
    netCallCount: 0,
    helperReferenceCount: 0,
    exactProcessIdentity: {
      pidPresent: true,
      creationIdentityPresent: true,
      executableMatched: true,
      ownerArgumentMatched: true,
    },
    lifecycleGenerationBound: true,
    deadline: { kind: "absolute", timeoutMs: 60_000 },
    timing: {
      startedAt: `2026-07-19T00:00:0${sequence}.000Z`,
      finishedAt: `2026-07-19T00:00:1${sequence}.000Z`,
      durationMs: 10_000,
    },
    exit: { reason: "exited", code: 0, signal: null },
    logs: {
      fileCount: 2,
      totalBytes: 512,
      aggregateSha256: SHA_A,
      ownerTokenAttributed: true,
    },
    output: {
      fileCount: 2,
      totalBytes: 1_024,
      aggregateSha256: SHA_B,
      freshArtifactCount: 2,
      resourceDatabase: { count: 1, bytes: 900, sha256: SHA_A },
    },
    exactChildAbsence: true,
    endpointVacancy: "verified",
    lifecycleVacant: true,
    supervisedAtStart: ZERO_COUNTS,
    supervisedAtRest: ZERO_COUNTS,
    workbenchVersion: {
      executable: "ArmaReforgerWorkbenchSteamDiag.exe",
      version: "1.7.0.54",
      fileVersion: "1.7.0.54",
      discovery: "windows_file_metadata",
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("controlled target-only Workbench build acceptance", () => {
  it("requires independent environment and command-line confirmation", () => {
    expect(() => assertLiveWorkbenchBuildAuthorized(false, {
      [LIVE_WORKBENCH_BUILD_ENVIRONMENT]: "1",
    })).toThrow(/--confirm-live-run/);
    expect(() => assertLiveWorkbenchBuildAuthorized(true, {})).toThrow(
      new RegExp(LIVE_WORKBENCH_BUILD_ENVIRONMENT)
    );
    expect(() => assertLiveWorkbenchBuildAuthorized(true, {
      [LIVE_WORKBENCH_BUILD_ENVIRONMENT]: "1",
    })).not.toThrow();
  });

  it("parses one explicit real target and external output parent", () => {
    expect(parseWorkbenchBuildAcceptanceArguments([
      "--confirm-live-run",
      "--gproj",
      "C:\\controlled\\Example.gproj",
      "--output-root",
      "D:\\retained-builds",
      "--timeout-ms",
      "120000",
    ])).toEqual({
      confirmed: true,
      gprojPath: "C:\\controlled\\Example.gproj",
      outputParent: "D:\\retained-builds",
      timeoutMs: 120_000,
      help: false,
    });
    expect(() => parseWorkbenchBuildAcceptanceArguments([
      "--confirm-live-run",
      "--output-root",
      "D:\\retained-builds",
    ])).toThrow(/--gproj and --output-root/);
    expect(() => parseWorkbenchBuildAcceptanceArguments(["--unknown"])).toThrow(/Unknown/);
  });

  it("runs exactly two sequential exclusive outputs and publishes only sanitized proof", async () => {
    const harness = createHarness();
    const observedOutputs: string[] = [];
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const result = await runWorkbenchBuildAcceptance({
      confirmed: true,
      gprojPath: harness.gprojPath,
      outputParent: harness.outputParent,
      timeoutMs: 60_000,
      environment: {
        [LIVE_WORKBENCH_BUILD_ENVIRONMENT]: "1",
        USERNAME: "private-user",
      },
      validationRoot: harness.validationRoot,
      config: harness.config,
    }, {
      platform: "win32",
      now: (() => {
        const values = [1_000, 31_000];
        return () => values.shift() ?? 31_000;
      })(),
      randomId: () => ids.shift()!,
      repositoryEvidence,
      executeRun: async (context) => {
        expect(readdirSync(context.outputRoot)).toEqual([]);
        expect(context.profile.managedRoot).not.toBe(context.outputRoot);
        observedOutputs.push(context.outputRoot);
        writeFileSync(join(context.outputRoot, "resourceDatabase.rdb"), `run-${context.sequence}`);
        return validRun(context.sequence);
      },
    });

    expect(observedOutputs).toHaveLength(2);
    expect(observedOutputs[0]).not.toBe(observedOutputs[1]);
    expect(result.artifact.configuration).toMatchObject({
      runCount: 2,
      outputRootsDistinctAndExclusive: true,
      publicBuildPreflightRetained: true,
      publicReceiptVersion: 3,
    });
    expect(result.artifact.runs.map((run) => run.spawnCount)).toEqual([1, 1]);
    const serialized = readFileSync(result.artifactPath, "utf8");
    expect(serialized).not.toContain(harness.root);
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("ownerTokenArgument");
    expect(serialized).not.toMatch(/"pid"\s*:/);
    expect(() => assertSanitizedBuildAcceptanceArtifact({
      ...result.artifact,
      target: {
        ...result.artifact.target,
        leaked: harness.gprojPath,
      },
    } as unknown as typeof result.artifact, [harness.gprojPath])).toThrow(/raw path|sensitive/);
  });

  it("rejects claimed evidence that used a second spawn or any NET call", async () => {
    const harness = createHarness();
    const executeRun = vi.fn(async ({ sequence }: { sequence: 1 | 2 }) => ({
      ...validRun(sequence),
      spawnCount: 2,
      netCallCount: 1,
    }));
    await expect(runWorkbenchBuildAcceptance({
      confirmed: true,
      gprojPath: harness.gprojPath,
      outputParent: harness.outputParent,
      timeoutMs: 60_000,
      environment: { [LIVE_WORKBENCH_BUILD_ENVIRONMENT]: "1" },
      validationRoot: harness.validationRoot,
      config: harness.config,
    }, {
      platform: "win32",
      randomId: () => "33333333-3333-4333-8333-333333333333",
      repositoryEvidence,
      executeRun,
    })).rejects.toThrow(/missing required proof/);
    expect(executeRun).toHaveBeenCalledTimes(1);
  });

  it("attests exactly one fresh nonempty regular resource database", async () => {
    const root = mkdtempSync(join(tmpdir(), "reforger-forge-build-output-proof-"));
    roots.push(root);
    writeFileSync(join(root, "resourceDatabase.rdb"), "fresh-database");
    writeFileSync(join(root, "build.info"), "fresh-metadata");
    const proof = await attestFreshBuildOutput(root, new Map());
    expect(proof).toMatchObject({
      fileCount: 2,
      freshArtifactCount: 2,
      resourceDatabase: { count: 1, bytes: 14 },
    });
    expect(proof.aggregateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.resourceDatabase.sha256).toMatch(/^[a-f0-9]{64}$/);

    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "resourceDatabase.rdb"), "second-database");
    await expect(attestFreshBuildOutput(root, new Map())).rejects.toThrow(/exactly one/);
  });

  it("wires the repository-only command directly to the controller target path", () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const source = readFileSync(
      join(repositoryRoot, "scripts", "run-workbench-build-acceptance.ts"),
      "utf8"
    );
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
    const packageCheck = readFileSync(join(repositoryRoot, "scripts", "check-package.mjs"), "utf8");
    expect(source).toContain("controller.runTargetBuild(plan, reservation");
    expect(source).toContain('kind: "target_build"');
    expect(source).toContain("publicBuildPreflightRetained: true");
    expect(source).not.toMatch(/from\s+["'][^"']*workbench\/runner\.js["']/);
    expect(source).not.toContain("runWorkbenchIntent");
    expect(source).not.toContain("runBuildCompanionPreflight");
    expect(source).not.toContain("WorkbenchHelperStager");
    expect(source).not.toContain("EMCP_WB_Ping");
    expect(packageJson.scripts["dev:workbench:acceptance:build"]).toContain(
      "scripts/run-workbench-build-acceptance.ts"
    );
    expect(packageJson.scripts["test:stage3"]).toContain(
      "tests/workbench/stage3-architecture.test.ts"
    );
    expect(packageJson.scripts["test:stage3"]).toContain(
      "tests/workbench/server-composition.test.ts"
    );
    expect(packageJson.files).not.toContain("scripts/run-workbench-build-acceptance.ts");
    expect(packageCheck).toContain('"scripts/run-workbench-build-acceptance.ts"');
  });
});
