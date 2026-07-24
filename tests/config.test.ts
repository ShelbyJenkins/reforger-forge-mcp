import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ConfigurationError,
  loadConfig,
  partitionConfigurationArguments,
} from "../src/config.js";

interface FixturePaths {
  readonly workbench: string;
  readonly game: string;
  readonly project: string;
}

let temporaryRoot: string;
let configurationDirectory: string;
let fixturePaths: FixturePaths;

function createDirectory(...segments: string[]): string {
  const path = join(temporaryRoot, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function createWorkbenchInstallation(...segments: string[]): string {
  const root = createDirectory(...segments);
  const executableDirectory = createDirectory(...segments, "Workbench");
  writeFileSync(
    join(executableDirectory, "ArmaReforgerWorkbenchSteamDiag.exe"),
    "",
    "utf8"
  );
  return root;
}

function createGameInstallation(...segments: string[]): string {
  const root = createDirectory(...segments);
  createDirectory(...segments, "addons");
  writeFileSync(join(root, "ArmaReforgerSteam.exe"), "", "utf8");
  return root;
}

function writeConfig(
  values: Record<string, unknown>,
  filename = "reforger-forge.json"
): string {
  const path = join(configurationDirectory, filename);
  writeFileSync(path, `${JSON.stringify(values, null, 2)}\n`, "utf8");
  return path;
}

function requiredFileValues(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    workbenchPath: "./workbench",
    gamePath: "./game",
    projectPath: "./project",
    ...overrides,
  };
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "reforger-forge-config-test-"));
  configurationDirectory = createDirectory("configuration");
  fixturePaths = {
    workbench: createWorkbenchInstallation("configuration", "workbench"),
    game: createGameInstallation("configuration", "game"),
    project: createDirectory("configuration", "project"),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("explicit configuration contract", () => {
  it("does not discover package-local files or read configuration from the environment", () => {
    writeFileSync(
      join(temporaryRoot, "reforger-forge.config.json"),
      JSON.stringify({
        workbenchPath: fixturePaths.workbench,
        gamePath: fixturePaths.game,
        projectPath: fixturePaths.project,
      }),
      "utf8"
    );
    vi.stubEnv("ENFUSION_WORKBENCH_PATH", fixturePaths.workbench);
    vi.stubEnv("ENFUSION_GAME_PATH", fixturePaths.game);
    vi.stubEnv("ENFUSION_PROJECT_PATH", fixturePaths.project);

    expect(() => loadConfig([], { cwd: temporaryRoot })).toThrowError(
      /workbenchPath is required/
    );
  });

  it("loads exactly the requested file and retains only safe internal defaults", () => {
    const configPath = writeConfig(requiredFileValues());

    const config = loadConfig(["--config", configPath], {
      cwd: createDirectory("unrelated-working-directory"),
    });

    expect(config).toMatchObject({
      workbenchPath: fixturePaths.workbench,
      gamePath: fixturePaths.game,
      projectPath: fixturePaths.project,
      workbenchHost: "127.0.0.1",
      workbenchPort: 5775,
      workbenchScriptAuthorizeAll: false,
      debug: false,
      observer: {
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        defaultCaptureTimeoutMs: 30_000,
        maxInlineImageBytes: 8 * 1024 * 1024,
      },
    });
  });

  it("ignores configuration environment variables even when an explicit file is loaded", () => {
    const alternateProject = createDirectory("environment-project");
    const configPath = writeConfig(requiredFileValues());
    vi.stubEnv("ENFUSION_PROJECT_PATH", alternateProject);
    vi.stubEnv("ENFUSION_WORKBENCH_HOST", "environment-host");
    vi.stubEnv("REFORGER_FORGE_OBSERVER_REQUEST_TIMEOUT_MS", "99999");

    const config = loadConfig(["--config", configPath]);

    expect(config.projectPath).toBe(fixturePaths.project);
    expect(config.workbenchHost).toBe("127.0.0.1");
    expect(config.observer!.requestTimeoutMs).toBe(30_000);
  });

  it("resolves file path values relative to the selected file", () => {
    const addonOne = createDirectory("configuration", "addons", "one");
    const addonTwo = createDirectory("configuration", "addons", "two");
    const extracted = createDirectory("configuration", "extracted");
    const managedRoot = createDirectory("configuration", "observer", "managed");
    const profileRoot = createDirectory("configuration", "observer", "profiles");
    const evidenceRoot = createDirectory("configuration", "observer", "evidence");
    const logRoot = createDirectory("configuration", "observer", "logs");
    const agentPath = join(configurationDirectory, "observer", "private-child.js");
    writeFileSync(agentPath, "", "utf8");
    const configPath = writeConfig(requiredFileValues({
      workbenchAddonDirs: ["./addons/one", "./addons/two"],
      extractedPath: "./extracted",
      observer: {
        managedRoot: "./observer/managed",
        profileRoot: "./observer/profiles",
        agentPath: "./observer/private-child.js",
        evidenceRoots: ["./observer/evidence"],
        supportingLogRoots: ["./observer/logs"],
      },
    }));

    const config = loadConfig(
      ["--config", relative(temporaryRoot, configPath)],
      { cwd: temporaryRoot }
    );

    expect(config.workbenchAddonDirs).toEqual([addonOne, addonTwo]);
    expect(config.extractedPath).toBe(extracted);
    expect(config.observer).toMatchObject({
      managedRoot,
      profileRoot,
      agentPath,
      evidenceRoots: [evidenceRoot],
      supportingLogRoots: [logRoot],
    });
  });

  it("lets CLI flags override file values and replaces repeated array settings", () => {
    const fileAddon = createDirectory("configuration", "file-addon");
    const fileEvidence = createDirectory("configuration", "file-evidence");
    const cliWorkbench = createWorkbenchInstallation("cli-workbench");
    const cliAddonOne = createDirectory("cli-addon-one");
    const cliAddonTwo = createDirectory("cli-addon-two");
    const cliEvidenceOne = createDirectory("cli-evidence-one");
    const cliEvidenceTwo = createDirectory("cli-evidence-two");
    const cliLog = createDirectory("cli-log");
    const configPath = writeConfig(requiredFileValues({
      workbenchAddonDirs: ["./file-addon"],
      workbenchHost: "file-host",
      workbenchPort: 6000,
      workbenchScriptAuthorizeAll: true,
      debug: true,
      observer: {
        evidenceRoots: ["./file-evidence"],
        requestTimeoutMs: 40_000,
      },
    }));

    const config = loadConfig([
      "--config", relative(temporaryRoot, configPath),
      "--workbench-path", "cli-workbench",
      "--workbench-addon-dir", "cli-addon-one",
      "--workbench-addon-dir", "cli-addon-two",
      "--workbench-host", "cli-host",
      "--workbench-port", "7000",
      "--no-workbench-script-authorize-all",
      "--no-debug",
      "--observer-evidence-root", "cli-evidence-one",
      "--observer-evidence-root", "cli-evidence-two",
      "--observer-supporting-log-root", "cli-log",
      "--observer-request-timeout-ms", "50000",
    ], { cwd: temporaryRoot });

    expect(config.workbenchPath).toBe(cliWorkbench);
    expect(config.workbenchAddonDirs).toEqual([cliAddonOne, cliAddonTwo]);
    expect(config.workbenchHost).toBe("cli-host");
    expect(config.workbenchPort).toBe(7000);
    expect(config.workbenchScriptAuthorizeAll).toBe(false);
    expect(config.debug).toBe(false);
    expect(config.observer!.evidenceRoots).toEqual([cliEvidenceOne, cliEvidenceTwo]);
    expect(config.observer!.supportingLogRoots).toEqual([cliLog]);
    expect(config.observer!.requestTimeoutMs).toBe(50_000);
    expect(fileAddon).not.toBe(cliAddonOne);
    expect(fileEvidence).not.toBe(cliEvidenceOne);
  });

  it("supports a CLI-only configuration", () => {
    const workbench = createWorkbenchInstallation("cli-only", "workbench");
    const game = createGameInstallation("cli-only", "game");
    const project = createDirectory("cli-only", "project");

    const config = loadConfig([
      "--workbench-path", workbench,
      "--game-path", game,
      "--project-path", project,
    ]);

    expect(config).toMatchObject({ workbenchPath: workbench, gamePath: game, projectPath: project });
  });

  it("does not derive a missing game path from the Workbench path", () => {
    const configPath = writeConfig({
      workbenchPath: "./workbench",
      projectPath: "./project",
    });

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /gamePath is required/
    );
  });

  it("rejects an add-on root that cannot be represented in Workbench's -addonsDir argument", () => {
    const commaAddon = createDirectory("configuration", "addon,with-comma");
    const configPath = writeConfig(requiredFileValues({
      workbenchAddonDirs: [commaAddon],
    }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /workbenchAddonDirs entries cannot contain commas/
    );
  });

  it.each([
    ["workbenchPath", { workbenchPath: "./missing-workbench" }, "directory"],
    ["gamePath", { gamePath: "./missing-game" }, "directory"],
    ["projectPath", { projectPath: "./missing-project" }, "directory"],
    ["workbenchAddonDirs entry 1", { workbenchAddonDirs: ["./missing-addon"] }, "directory"],
    ["extractedPath", { extractedPath: "./missing-extracted" }, "directory"],
    ["observer.agentPath", { observer: { agentPath: "./missing-agent.js" } }, "file"],
    [
      "observer.evidenceRoots entry 1",
      { observer: { evidenceRoots: ["./missing-evidence"] } },
      "directory",
    ],
    [
      "observer.supportingLogRoots entry 1",
      { observer: { supportingLogRoots: ["./missing-logs"] } },
      "directory",
    ],
  ])("rejects a non-existent %s", (label, override, kind) => {
    const configPath = writeConfig(requiredFileValues(override));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      new RegExp(`${label}.*existing ${kind}`)
    );
  });

  it("rejects missing, malformed, and schema-invalid explicit files", () => {
    expect(() => loadConfig([
      "--config",
      join(configurationDirectory, "missing.json"),
    ])).toThrowError(/Configuration file does not exist/);

    const malformedPath = join(configurationDirectory, "malformed.json");
    writeFileSync(malformedPath, "{", "utf8");
    expect(() => loadConfig(["--config", malformedPath])).toThrowError(
      /could not be read as JSON/
    );

    const unknownPath = writeConfig(
      requiredFileValues({ environment: { projectPath: "hidden" } }),
      "unknown.json"
    );
    expect(() => loadConfig(["--config", unknownPath])).toThrowError(
      /Configuration file is invalid.*Unrecognized key/
    );
  });

  it("rejects directories that are not actual Workbench or game installations", () => {
    const emptyWorkbench = createDirectory("empty-workbench");
    const emptyGame = createDirectory("empty-game");
    createDirectory("empty-game", "addons");

    expect(() => loadConfig([
      "--config",
      writeConfig(requiredFileValues({ workbenchPath: emptyWorkbench }), "bad-workbench.json"),
    ])).toThrowError(/workbenchPath must contain one supported executable/);
    expect(() => loadConfig([
      "--config",
      writeConfig(requiredFileValues({ gamePath: emptyGame }), "bad-game.json"),
    ])).toThrowError(/gamePath must contain one supported executable/);
  });

  it("rejects project roots that overlap an installation", () => {
    const configPath = writeConfig(requiredFileValues({
      projectPath: "./game/addons",
    }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /projectPath must not overlap/
    );
  });

  it("rejects observer managed or profile roots that resolve through files", () => {
    const filePath = join(configurationDirectory, "not-a-directory");
    writeFileSync(filePath, "", "utf8");

    for (const field of ["managedRoot", "profileRoot"] as const) {
      const configPath = writeConfig(requiredFileValues({
        observer: { [field]: "./not-a-directory/child" },
      }), `bad-${field}.json`);
      expect(() => loadConfig(["--config", configPath])).toThrowError(
        new RegExp(`observer\\.${field} must be an existing directory`)
      );
    }
  });

  it("rejects observer private roots that overlap projectPath", () => {
    const configPath = writeConfig(requiredFileValues({
      observer: { managedRoot: "./project/observer-state" },
    }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /observer\.managedRoot must not overlap projectPath/
    );
  });

  it("rejects an invalid direct-folder defaultMod", () => {
    const configPath = writeConfig(requiredFileValues({ defaultMod: "../other" }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /defaultMod must name one direct project folder/
    );
  });

  it.each([
    [["--unknown"], /Unknown configuration argument/],
    [["--config", "--debug"], /--config requires one value/],
    [["--workbench-port", "0"], /integer from 1 through 65535/],
    [["--workbench-port", "5775.5"], /integer from 1 through 65535/],
    [["--observer-startup-timeout-ms", "999"], /integer from 1000 through 60000/],
    [["--debug", "--no-debug"], /may be supplied only once/],
  ] as const)("rejects invalid CLI arguments %j", (argumentsArray, expected) => {
    expect(() => loadConfig(argumentsArray, { cwd: temporaryRoot })).toThrowError(expected);
  });

  it("rejects the obsolete workbenchNoThrow setting", () => {
    const configPath = writeConfig(requiredFileValues({ workbenchNoThrow: false }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /Configuration file is invalid.*workbenchNoThrow/
    );
  });

  it("rejects observer numeric values outside downstream runtime bounds", () => {
    const configPath = writeConfig(requiredFileValues({
      observer: { maxInlineImageBytes: 64 * 1024 * 1024 + 1 },
    }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /observer\.maxInlineImageBytes.*less than or equal to 67108864/
    );
  });

  it("rejects a Workbench host containing control delimiters", () => {
    const configPath = writeConfig(requiredFileValues({
      workbenchHost: "127.0.0.1\nother-host",
    }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /workbenchHost.*without control delimiters/
    );
  });
});

describe("partitionConfigurationArguments", () => {
  it("preserves non-configuration argument order while extracting shared flags", () => {
    expect(partitionConfigurationArguments([
      "editor",
      "--config", "instance.json",
      "--gproj", "target.gproj",
      "--workbench-addon-dir", "first",
      "--workbench-addon-dir", "second",
      "--debug",
      "--foreground",
    ])).toEqual({
      configurationArguments: [
        "--config", "instance.json",
        "--workbench-addon-dir", "first",
        "--workbench-addon-dir", "second",
        "--debug",
      ],
      remainingArguments: [
        "editor",
        "--gproj", "target.gproj",
        "--foreground",
      ],
    });
  });

  it("fails immediately when a shared value flag has no value", () => {
    expect(() => partitionConfigurationArguments([
      "editor",
      "--config",
      "--foreground",
    ])).toThrowError(ConfigurationError);
  });
});
