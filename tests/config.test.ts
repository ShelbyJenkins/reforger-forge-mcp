import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  CONFIGURATION_USAGE,
  ConfigurationError,
  loadConfig,
  MCP_IDLE_SHUTDOWN_DEFAULT_MS,
  MCP_IDLE_SHUTDOWN_MAX_MS,
  MCP_IDLE_SHUTDOWN_MIN_MS,
  partitionConfigurationArguments,
} from "../src/config.js";
import type { SteamDiscoveryResult } from "../src/platform/windows/steam-discovery.js";

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
    ...overrides,
  };
}

function discoveryResult(
  overrides: Partial<SteamDiscoveryResult> = {}
): SteamDiscoveryResult {
  return {
    status: "success",
    workbenchPath: fixturePaths.workbench,
    gamePath: fixturePaths.game,
    workbenchAddonDirs: [join(fixturePaths.game, "addons")],
    workbenchCandidates: [fixturePaths.workbench],
    gameCandidates: [fixturePaths.game],
    steamRoots: [],
    libraryRoots: [],
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "reforger-forge-config-test-"));
  vi.stubEnv("OneDrive", join(temporaryRoot, "missing-onedrive"));
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

describe("effective configuration contract", () => {
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

    const discoverSteam = vi.fn(() => discoveryResult({
      status: "not_found",
      workbenchPath: undefined,
      gamePath: undefined,
      workbenchAddonDirs: undefined,
      workbenchCandidates: [],
      gameCandidates: [],
      errors: [{
        code: "NOT_FOUND",
        source: "discovery",
        message: "fixture has no Steam installation",
      }],
    }));

    expect(() => loadConfig([], {
      cwd: temporaryRoot,
      discoverSteam,
    })).toThrowError(
      /Steam discovery not_found/
    );
    expect(discoverSteam).toHaveBeenCalledOnce();
  });

  it("starts from Steam discovery without project configuration", () => {
    const config = loadConfig([], {
      cwd: temporaryRoot,
      discoverSteam: () => discoveryResult(),
    });

    expect(config).toMatchObject({
      workbenchPath: fixturePaths.workbench,
      gamePath: fixturePaths.game,
      workbenchAddonDirs: [join(fixturePaths.game, "addons")],
      workbenchHost: "127.0.0.1",
      workbenchPort: 5775,
      mcpIdleShutdownMs: MCP_IDLE_SHUTDOWN_DEFAULT_MS,
    });
    expect(config.observer!.evidenceRoots).toBeUndefined();
  });

  it("adds base-game and standard Workshop roots around explicit roots while preserving opt-out", () => {
    const workshopRoot = createDirectory("workshop-addons");
    const explicitRoot = createDirectory("explicit-addons");
    const options = {
      discoverWorkshopAddonRoot: () => workshopRoot,
    };

    const unspecified = loadConfig([
      "--workbench-path", fixturePaths.workbench,
      "--game-path", fixturePaths.game,
    ], options);
    expect(unspecified.workbenchAddonDirs).toEqual([
      join(fixturePaths.game, "addons"),
      workshopRoot,
    ]);

    const explicit = loadConfig([
      "--workbench-path", fixturePaths.workbench,
      "--game-path", fixturePaths.game,
      "--workbench-addon-dir", explicitRoot,
    ], options);
    expect(explicit.workbenchAddonDirs).toEqual([
      join(fixturePaths.game, "addons"),
      workshopRoot,
      explicitRoot,
    ]);

    const optedOut = loadConfig([
      "--workbench-path", fixturePaths.workbench,
      "--game-path", fixturePaths.game,
      "--no-workbench-addon-dirs",
    ], options);
    expect(optedOut.workbenchAddonDirs).toEqual([]);
  });

  it("does not duplicate a base-game root the caller already supplied", () => {
    const workshopRoot = createDirectory("workshop-addons");
    const baseGameRoot = join(fixturePaths.game, "addons");

    const config = loadConfig([
      "--workbench-path", fixturePaths.workbench,
      "--game-path", fixturePaths.game,
      "--workbench-addon-dir", baseGameRoot,
    ], {
      discoverWorkshopAddonRoot: () => workshopRoot,
    });

    expect(config.workbenchAddonDirs).toEqual([baseGameRoot, workshopRoot]);
  });

  it("loads exactly the requested partial file and retains safe internal defaults", () => {
    const configPath = writeConfig(requiredFileValues());

    const config = loadConfig(["--config", configPath], {
      cwd: createDirectory("unrelated-working-directory"),
    });

    expect(config).toMatchObject({
      workbenchPath: fixturePaths.workbench,
      gamePath: fixturePaths.game,
      workbenchHost: "127.0.0.1",
      workbenchPort: 5775,
      workbenchScriptAuthorizeAll: false,
      mcpIdleShutdownMs: 1_800_000,
      debug: false,
      observer: {
        startupTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        defaultCaptureTimeoutMs: 30_000,
        maxInlineImageBytes: 8 * 1024 * 1024,
      },
    });
    expect(config.observer!.evidenceRoots).toBeUndefined();
  });

  it("ignores configuration environment variables even when an explicit file is loaded", () => {
    const alternateProject = createDirectory("environment-project");
    const configPath = writeConfig(requiredFileValues());
    vi.stubEnv("ENFUSION_PROJECT_PATH", alternateProject);
    vi.stubEnv("ENFUSION_WORKBENCH_HOST", "environment-host");
    vi.stubEnv("REFORGER_FORGE_OBSERVER_REQUEST_TIMEOUT_MS", "99999");

    const config = loadConfig(["--config", configPath]);

    expect(config).not.toHaveProperty("projectPath");
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

    expect(config.workbenchAddonDirs).toEqual([
      join(fixturePaths.game, "addons"),
      addonOne,
      addonTwo,
    ]);
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
      mcpIdleShutdownMs: 60_000,
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
      "--mcp-idle-shutdown-ms", "86400000",
      "--no-workbench-script-authorize-all",
      "--no-debug",
      "--observer-evidence-root", "cli-evidence-one",
      "--observer-evidence-root", "cli-evidence-two",
      "--observer-supporting-log-root", "cli-log",
      "--observer-request-timeout-ms", "50000",
    ], { cwd: temporaryRoot });

    expect(config.workbenchPath).toBe(cliWorkbench);
    expect(config.workbenchAddonDirs).toEqual([
      join(fixturePaths.game, "addons"),
      cliAddonOne,
      cliAddonTwo,
    ]);
    expect(config.workbenchHost).toBe("cli-host");
    expect(config.workbenchPort).toBe(7000);
    expect(config.mcpIdleShutdownMs).toBe(86_400_000);
    expect(config.workbenchScriptAuthorizeAll).toBe(false);
    expect(config.debug).toBe(false);
    expect(config.observer!.evidenceRoots).toEqual([cliEvidenceOne, cliEvidenceTwo]);
    expect(config.observer!.supportingLogRoots).toEqual([cliLog]);
    expect(config.observer!.requestTimeoutMs).toBe(50_000);
    expect(fileAddon).not.toBe(cliAddonOne);
    expect(fileEvidence).not.toBe(cliEvidenceOne);
  });

  it("keeps CLI precedence independent of where --config appears", () => {
    const configPath = writeConfig(requiredFileValues({
      workbenchHost: "file-host",
      workbenchScriptAuthorizeAll: true,
    }));

    const config = loadConfig([
      "--workbench-host", "cli-host",
      "--no-workbench-script-authorize-all",
      "--config", configPath,
    ]);

    expect(config.workbenchHost).toBe("cli-host");
    expect(config.workbenchScriptAuthorizeAll).toBe(false);
  });

  it("supports a CLI-only configuration", () => {
    const workbench = createWorkbenchInstallation("cli-only", "workbench");
    const game = createGameInstallation("cli-only", "game");
    const config = loadConfig([
      "--workbench-path", workbench,
      "--game-path", game,
    ]);

    expect(config).toMatchObject({ workbenchPath: workbench, gamePath: game });
    expect(config.observer!.evidenceRoots).toBeUndefined();
  });

  it("maps every JSON-configurable scalar and array setting to CLI", () => {
    const workbench = createWorkbenchInstallation("all-cli", "workbench");
    const game = createGameInstallation("all-cli", "game");
    const addon = createDirectory("all-cli", "addon");
    const extracted = createDirectory("all-cli", "extracted");
    const managedRoot = createDirectory("all-cli", "managed");
    const profileRoot = createDirectory("all-cli", "profiles");
    const evidenceRoot = createDirectory("all-cli", "evidence");
    const logRoot = createDirectory("all-cli", "logs");
    const agentPath = join(temporaryRoot, "all-cli", "private-child.js");
    writeFileSync(agentPath, "", "utf8");

    const config = loadConfig([
      "--workbench-path", workbench,
      "--game-path", game,
      "--workbench-addon-dir", addon,
      "--workbench-script-authorize-all",
      "--workbench-host", "cli-host",
      "--workbench-port", "6001",
      "--mcp-idle-shutdown-ms", "60000",
      "--extracted-path", extracted,
      "--observer-managed-root", managedRoot,
      "--observer-profile-root", profileRoot,
      "--observer-agent-path", agentPath,
      "--observer-evidence-root", evidenceRoot,
      "--observer-supporting-log-root", logRoot,
      "--observer-startup-timeout-ms", "11000",
      "--observer-request-timeout-ms", "32000",
      "--observer-capture-timeout-ms", "33000",
      "--observer-max-inline-image-bytes", "9000000",
      "--observer-default-lossy-image-quality", "70",
      "--observer-minimum-lossy-image-quality", "40",
      "--observer-maximum-lossy-image-quality", "90",
      "--observer-retention-interval-ms", "61000",
      "--observer-retention-max-age-ms", "700000000",
      "--observer-retention-max-bytes", "600000000",
      "--observer-session-ttl-ms", "1300000",
      "--debug",
    ]);

    expect(config).toMatchObject({
      workbenchPath: workbench,
      gamePath: game,
      workbenchAddonDirs: [join(game, "addons"), addon],
      workbenchScriptAuthorizeAll: true,
      workbenchHost: "cli-host",
      workbenchPort: 6001,
      mcpIdleShutdownMs: 60_000,
      extractedPath: extracted,
      debug: true,
      observer: {
        managedRoot,
        profileRoot,
        agentPath,
        evidenceRoots: [evidenceRoot],
        supportingLogRoots: [logRoot],
        startupTimeoutMs: 11_000,
        requestTimeoutMs: 32_000,
        defaultCaptureTimeoutMs: 33_000,
        maxInlineImageBytes: 9_000_000,
        defaultLossyImageQuality: 70,
        minimumLossyImageQuality: 40,
        maximumLossyImageQuality: 90,
        retentionIntervalMs: 61_000,
        retentionMaxAgeMs: 700_000_000,
        retentionMaxBytes: 600_000_000,
        sessionTtlMs: 1_300_000,
      },
    });
  });

  it("uses Steam discovery only for an installation path omitted by explicit config", () => {
    const explicitWorkbench = createWorkbenchInstallation(
      "configuration",
      "explicit-workbench"
    );
    const configPath = writeConfig({
      workbenchPath: "./explicit-workbench",
    });
    const discoveredWorkbench = createWorkbenchInstallation(
      "discovered",
      "workbench"
    );
    const discoverSteam = vi.fn(() => discoveryResult({
      workbenchPath: discoveredWorkbench,
      workbenchCandidates: [discoveredWorkbench],
    }));

    const config = loadConfig(["--config", configPath], { discoverSteam });

    expect(config.workbenchPath).toBe(explicitWorkbench);
    expect(config.workbenchPath).not.toBe(discoveredWorkbench);
    expect(config.gamePath).toBe(fixturePaths.game);
    expect(discoverSteam).toHaveBeenCalledOnce();
  });

  it("ignores malformed metadata only for an explicitly overridden app", () => {
    const explicitWorkbench = createWorkbenchInstallation(
      "configuration",
      "explicit-workbench"
    );
    const configPath = writeConfig({
      workbenchPath: "./explicit-workbench",
    });
    const config = loadConfig(["--config", configPath], {
      discoverSteam: () => discoveryResult({
        status: "malformed",
        workbenchPath: undefined,
        workbenchCandidates: [],
        errors: [{
          code: "METADATA_MALFORMED",
          source: "manifest",
          appId: "1874910",
          message: "broken Tools manifest",
        }],
      }),
    });

    expect(config.workbenchPath).toBe(explicitWorkbench);
    expect(config.gamePath).toBe(fixturePaths.game);
  });

  it("applies discovery, then config, then CLI precedence", () => {
    const discoveredWorkbench = createWorkbenchInstallation("discovered", "workbench");
    const discoveredGame = createGameInstallation("discovered", "game");
    const fileGame = createGameInstallation("configuration", "file-game");
    const cliGame = createGameInstallation("cli", "game");
    const configPath = writeConfig({
      gamePath: "./file-game",
      workbenchHost: "file-host",
    });

    const config = loadConfig([
      "--config", configPath,
      "--game-path", cliGame,
      "--workbench-host", "cli-host",
    ], {
      discoverSteam: () => discoveryResult({
        workbenchPath: discoveredWorkbench,
        gamePath: discoveredGame,
        workbenchAddonDirs: [join(discoveredGame, "addons")],
        workbenchCandidates: [discoveredWorkbench],
        gameCandidates: [discoveredGame],
      }),
    });

    expect(config.workbenchPath).toBe(discoveredWorkbench);
    expect(config.gamePath).toBe(cliGame);
    expect(config.gamePath).not.toBe(fileGame);
    expect(config.workbenchAddonDirs).toEqual([join(cliGame, "addons")]);
    expect(config.workbenchHost).toBe("cli-host");
  });

  it("preserves an explicit empty evidence allowlist", () => {
    const configPath = writeConfig(requiredFileValues({
      observer: { evidenceRoots: [] },
    }));

    const config = loadConfig(["--config", configPath]);

    expect(config.observer!.evidenceRoots).toEqual([]);
  });

  it("propagates the MCP idle setting through file resolution and accepts both endpoints", () => {
    const minimumPath = writeConfig(requiredFileValues({
      mcpIdleShutdownMs: MCP_IDLE_SHUTDOWN_MIN_MS,
    }), "minimum.json");
    expect(loadConfig(["--config", minimumPath]).mcpIdleShutdownMs).toBe(60_000);

    const maximumPath = writeConfig(requiredFileValues({
      mcpIdleShutdownMs: MCP_IDLE_SHUTDOWN_MAX_MS,
    }), "maximum.json");
    expect(loadConfig(["--config", maximumPath]).mcpIdleShutdownMs).toBe(86_400_000);

    expect(() => loadConfig(["--mcp-idle-shutdown-ms"])).toThrowError(
      /--mcp-idle-shutdown-ms requires one value/
    );
    expect(() => loadConfig([
      "--mcp-idle-shutdown-ms", "60000",
      "--mcp-idle-shutdown-ms", "86400000",
    ])).toThrowError(/may be supplied only once/);
  });

  it.each([null, 0, -1, 59_999, 60_000.5, 86_400_001])(
    "rejects invalid JSON mcpIdleShutdownMs %j",
    (mcpIdleShutdownMs) => {
      const configPath = writeConfig(requiredFileValues({ mcpIdleShutdownMs }), "invalid-idle.json");
      expect(() => loadConfig(["--config", configPath])).toThrowError(/mcpIdleShutdownMs/);
    }
  );

  it.each(["0", "-1", "59999", "60000.5", "86400001"])(
    "rejects invalid CLI MCP idle timeout %s",
    (value) => {
      expect(() => loadConfig([
        "--workbench-path", fixturePaths.workbench,
        "--game-path", fixturePaths.game,
        "--mcp-idle-shutdown-ms", value,
      ])).toThrowError(/integer from 60000 through 86400000/);
    }
  );

  it("documents the MCP-only bounded configuration flag", () => {
    expect(CONFIGURATION_USAGE).toContain("--mcp-idle-shutdown-ms <60000..86400000>");
    expect(CONFIGURATION_USAGE).toContain("MCP server idle-exit interval");
  });

  it("lets CLI clear flags express empty array overrides", () => {
    const configPath = writeConfig(requiredFileValues({
      workbenchAddonDirs: ["./game/addons"],
      observer: {
        evidenceRoots: ["./project"],
        supportingLogRoots: ["./project"],
      },
    }));

    const config = loadConfig([
      "--config", configPath,
      "--no-workbench-addon-dirs",
      "--no-observer-evidence-roots",
      "--no-observer-supporting-log-roots",
    ]);

    expect(config.workbenchAddonDirs).toEqual([]);
    expect(config.observer!.evidenceRoots).toEqual([]);
    expect(config.observer!.supportingLogRoots).toEqual([]);
  });

  it("rejects contradictory array replacement flags regardless of order", () => {
    expect(() => loadConfig([
      "--no-workbench-addon-dirs",
      "--workbench-addon-dir", join(fixturePaths.game, "addons"),
      "--workbench-path", fixturePaths.workbench,
      "--game-path", fixturePaths.game,
    ])).toThrowError(/cannot be combined/);
  });

  it("rejects the retired project-path CLI setting", () => {
    expect(() => loadConfig([
      "--project-path", fixturePaths.project,
    ])).toThrowError(/Unknown configuration argument/);
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
    ["workbenchAddonDirs entry 2", { workbenchAddonDirs: ["./missing-addon"] }, "directory"],
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

  it("rejects an explicit game whose addons junction escapes gamePath", () => {
    const game = createGameInstallation("escaped-game");
    rmSync(join(game, "addons"), { recursive: true, force: true });
    const externalAddons = createDirectory("external-addons");
    symlinkSync(externalAddons, join(game, "addons"), "junction");

    expect(() => loadConfig([
      "--workbench-path", fixturePaths.workbench,
      "--game-path", game,
    ])).toThrowError(/gamePath\/addons must resolve beneath gamePath/);
  });

  it.each(["projectPath", "defaultMod"])("rejects the retired %s config setting", (field) => {
    const configPath = writeConfig(requiredFileValues({ [field]: "retired" }));
    expect(() => loadConfig(["--config", configPath])).toThrowError(/Unrecognized key/);
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

  it("rejects observer private roots that overlap gamePath", () => {
    const configPath = writeConfig(requiredFileValues({
      observer: { managedRoot: "./game/observer-state" },
    }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /observer\.managedRoot must not overlap gamePath/
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

  it("rejects an inconsistent observer lossy image quality range", () => {
    const configPath = writeConfig(requiredFileValues({
      observer: {
        minimumLossyImageQuality: 80,
        defaultLossyImageQuality: 75,
        maximumLossyImageQuality: 90,
      },
    }));

    expect(() => loadConfig(["--config", configPath])).toThrowError(
      /minimumLossyImageQuality <= defaultLossyImageQuality <= maximumLossyImageQuality/
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
      "--mcp-idle-shutdown-ms", "60000",
      "--debug",
      "--foreground",
    ])).toEqual({
      configurationArguments: [
        "--config", "instance.json",
        "--workbench-addon-dir", "first",
        "--workbench-addon-dir", "second",
        "--mcp-idle-shutdown-ms", "60000",
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

  it("rejects empty path flags instead of inferring the working directory", () => {
    expect(() => loadConfig([
      "--workbench-path", "   ",
      "--workbench-path", fixturePaths.workbench,
      "--game-path", fixturePaths.game,
    ], { cwd: fixturePaths.project })).toThrowError(
      /--workbench-path requires a non-empty path/
    );
  });
});
