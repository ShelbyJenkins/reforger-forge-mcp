import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARMA_REFORGER_APP_ID,
  ARMA_REFORGER_TOOLS_APP_ID,
  discoverSteamInstallations,
  locateSteamRoots,
  parseValveKeyValues,
  STEAM_DISCOVERY_EXIT_CODES,
} from "../../../src/platform/windows/steam-discovery.js";

let temporaryRoot: string;

function directory(...segments: string[]): string {
  const path = join(temporaryRoot, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function steamRoot(name: string): string {
  const root = directory(name);
  directory(name, "steamapps");
  return root;
}

function writeLibraries(root: string, libraries: readonly string[]): void {
  const entries = libraries
    .map((library, index) =>
      `  "${index}"\n  {\n    "path" ${quote(library)}\n  }`
    )
    .join("\n");
  writeFileSync(
    join(root, "steamapps", "libraryfolders.vdf"),
    `"libraryfolders"\n{\n${entries}\n}\n`,
    "utf8"
  );
}

function install(
  library: string,
  appId: string,
  installDirectory: string,
  kind: "game" | "workbench",
  options: { valid?: boolean; appIdValue?: string | null } = {}
): string {
  const root = join(library, "steamapps", "common", installDirectory);
  mkdirSync(root, { recursive: true });
  if (options.valid !== false) {
    if (kind === "game") {
      mkdirSync(join(root, "addons"), { recursive: true });
      writeFileSync(join(root, "ArmaReforgerSteam.exe"), "", "utf8");
    } else {
      mkdirSync(join(root, "Workbench"), { recursive: true });
      writeFileSync(
        join(root, "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
        "",
        "utf8"
      );
    }
  }
  const manifestAppId =
    options.appIdValue === undefined ? appId : options.appIdValue;
  writeFileSync(
    join(library, "steamapps", `appmanifest_${appId}.acf`),
    `"AppState"\n{\n${
      manifestAppId === null ? "" : `  "appid" "${manifestAppId}"\n`
    }  "installdir" ${quote(installDirectory)}\n}\n`,
    "utf8"
  );
  return realpathSync.native(root);
}

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "reforger-forge-steam-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("Valve KeyValues parsing", () => {
  it("supports BOMs, comments, escaped paths, and nested objects", () => {
    const parsed = parseValveKeyValues(
      `\uFEFF// fixture\n"libraryfolders"\n{\n  "0" { "path" "D:\\\\Steam Library" }\n}\n`
    );

    expect(parsed).toEqual({
      libraryfolders: {
        "0": { path: "D:\\Steam Library" },
      },
    });
  });

  it("rejects malformed metadata", () => {
    expect(() => parseValveKeyValues("\"root\" { \"key\"")).toThrow(
      /Missing value|closing brace/
    );
  });

  it("uses null-prototype maps for untrusted Valve keys", () => {
    const parsed = parseValveKeyValues(
      `"__proto__"\n{\n  "AppState"\n  {\n    "appid" "${ARMA_REFORGER_APP_ID}"\n  }\n}\n`
    );

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed.AppState).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
  });
});

describe("Steam installation discovery", () => {
  it("finds the game and Tools across separate configured libraries", () => {
    const root = steamRoot("Steam");
    const gameLibrary = steamRoot("Game Library");
    const toolsLibrary = steamRoot("Tools Library");
    writeLibraries(root, [root, gameLibrary, toolsLibrary]);
    const gamePath = install(
      gameLibrary,
      ARMA_REFORGER_APP_ID,
      "Arma Reforger",
      "game"
    );
    const workbenchPath = install(
      toolsLibrary,
      ARMA_REFORGER_TOOLS_APP_ID,
      "Arma Reforger Tools",
      "workbench"
    );

    const result = discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    });

    expect(result.status).toBe("success");
    expect(result.gamePath).toBe(gamePath);
    expect(result.workbenchPath).toBe(workbenchPath);
    expect(result.workbenchAddonDirs).toEqual([join(gamePath, "addons")]);
    expect(STEAM_DISCOVERY_EXIT_CODES[result.status]).toBe(0);
  });

  it("parses legacy string-valued library entries", () => {
    const root = steamRoot("Steam");
    const library = steamRoot("Legacy Library");
    writeFileSync(
      join(root, "steamapps", "libraryfolders.vdf"),
      `"libraryfolders"\n{\n  "1" ${quote(library)}\n}\n`,
      "utf8"
    );
    install(library, ARMA_REFORGER_APP_ID, "Arma Reforger", "game");
    install(
      library,
      ARMA_REFORGER_TOOLS_APP_ID,
      "Arma Reforger Tools",
      "workbench"
    );

    expect(discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    }).status).toBe("success");
  });

  it("fails closed when multiple valid installations exist", () => {
    const root = steamRoot("Steam");
    const first = steamRoot("First");
    const second = steamRoot("Second");
    writeLibraries(root, [root, first, second]);
    install(first, ARMA_REFORGER_APP_ID, "Arma Reforger", "game");
    install(
      first,
      ARMA_REFORGER_TOOLS_APP_ID,
      "Arma Reforger Tools",
      "workbench"
    );
    install(second, ARMA_REFORGER_APP_ID, "Arma Reforger Copy", "game");

    const result = discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    });

    expect(result.status).toBe("ambiguous");
    expect(result.gameCandidates).toHaveLength(2);
    expect(STEAM_DISCOVERY_EXIT_CODES[result.status]).toBe(3);
  });

  it("reports missing manifests as not found", () => {
    const root = steamRoot("Steam");
    writeLibraries(root, [root]);

    const result = discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    });

    expect(result.status).toBe("not_found");
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "NOT_FOUND" })
    );
  });

  it("distinguishes an invalid installation from malformed metadata", () => {
    const root = steamRoot("Steam");
    writeLibraries(root, [root]);
    install(root, ARMA_REFORGER_APP_ID, "Broken Reforger", "game", {
      valid: false,
    });
    install(
      root,
      ARMA_REFORGER_TOOLS_APP_ID,
      "Arma Reforger Tools",
      "workbench"
    );

    const result = discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    });

    expect(result.status).toBe("not_found");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "INVALID_INSTALLATION",
        appId: ARMA_REFORGER_APP_ID,
      })
    );
    expect(result.errors.some((error) => error.code === "METADATA_MALFORMED"))
      .toBe(false);
  });

  it("treats malformed library metadata as fatal even with direct candidates", () => {
    const root = steamRoot("Steam");
    writeFileSync(
      join(root, "steamapps", "libraryfolders.vdf"),
      "\"libraryfolders\" {",
      "utf8"
    );
    install(root, ARMA_REFORGER_APP_ID, "Arma Reforger", "game");
    install(
      root,
      ARMA_REFORGER_TOOLS_APP_ID,
      "Arma Reforger Tools",
      "workbench"
    );

    const result = discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    });

    expect(result.status).toBe("malformed");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "METADATA_MALFORMED",
        source: "libraryfolders",
      })
    );
  });

  it("requires the manifest appid field to match", () => {
    const root = steamRoot("Steam");
    writeLibraries(root, [root]);
    install(root, ARMA_REFORGER_APP_ID, "Arma Reforger", "game", {
      appIdValue: null,
    });
    install(
      root,
      ARMA_REFORGER_TOOLS_APP_ID,
      "Arma Reforger Tools",
      "workbench"
    );

    const result = discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    });

    expect(result.status).toBe("malformed");
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "METADATA_MALFORMED",
        appId: ARMA_REFORGER_APP_ID,
      })
    );
  });

  it("returns the unsupported-platform exit status deterministically", () => {
    const result = discoverSteamInstallations({ platform: "linux" });

    expect(result.status).toBe("unsupported");
    expect(STEAM_DISCOVERY_EXIT_CODES[result.status]).toBe(5);
  });

  it("defines stable exit codes for every discovery outcome", () => {
    expect(STEAM_DISCOVERY_EXIT_CODES).toEqual({
      success: 0,
      not_found: 2,
      ambiguous: 3,
      malformed: 4,
      unsupported: 5,
    });
  });

  it("rejects a game whose addons junction escapes the installation", () => {
    const root = steamRoot("Steam");
    writeLibraries(root, [root]);
    const game = install(
      root,
      ARMA_REFORGER_APP_ID,
      "Escaped Game",
      "game",
      { valid: false }
    );
    writeFileSync(join(game, "ArmaReforgerSteam.exe"), "", "utf8");
    const externalAddons = directory("External Addons");
    symlinkSync(externalAddons, join(game, "addons"), "junction");
    install(
      root,
      ARMA_REFORGER_TOOLS_APP_ID,
      "Valid Tools",
      "workbench"
    );

    const result = discoverSteamInstallations({
      platform: "win32",
      steamRoots: [root],
    });

    expect(result.status).toBe("not_found");
    expect(result.gameCandidates).toEqual([]);
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "INVALID_INSTALLATION",
      appId: ARMA_REFORGER_APP_ID,
    }));
  });
});

describe("Steam root location fallbacks", () => {
  it("falls back from a stale registry directory to a running Steam instance", () => {
    const stale = directory("Stale Registry");
    const running = steamRoot("Running Steam");
    writeLibraries(running, [running]);
    const runningSteamRoots = vi.fn(() => [running]);

    const roots = locateSteamRoots({
      platform: "win32",
      environment: {},
      readRegistryValue: () => stale,
      runningSteamRoots,
    });

    expect(roots).toEqual([realpathSync.native(running)]);
    expect(runningSteamRoots).toHaveBeenCalledOnce();
  });

  it("does not query processes when the registry identifies usable Steam metadata", () => {
    const registered = steamRoot("Registered Steam");
    writeLibraries(registered, [registered]);
    const runningSteamRoots = vi.fn(() => []);

    const roots = locateSteamRoots({
      platform: "win32",
      environment: {},
      readRegistryValue: () => registered,
      runningSteamRoots,
    });

    expect(roots).toEqual([realpathSync.native(registered)]);
    expect(runningSteamRoots).not.toHaveBeenCalled();
  });

  it("checks the standard Program Files location after registry and process fallbacks", () => {
    const programFiles = directory("Program Files (x86)");
    const standard = join(programFiles, "Steam");
    mkdirSync(join(standard, "steamapps"), { recursive: true });
    writeLibraries(standard, [standard]);

    const roots = locateSteamRoots({
      platform: "win32",
      environment: { "PROGRAMFILES(X86)": programFiles },
      readRegistryValue: () => undefined,
      runningSteamRoots: () => [],
    });

    expect(roots[0]).toBe(realpathSync.native(standard));
    expect(roots).toContain(realpathSync.native(standard));
  });
});
