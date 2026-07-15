import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mockState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  home: "C:\\Users\\ConfigTest",
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => mockState.files.has(path),
  readFileSync: (path: string) => {
    const contents = mockState.files.get(path);
    if (contents === undefined) {
      throw new Error(`Unexpected config read: ${path}`);
    }
    return contents;
  },
}));

vi.mock("node:os", () => ({
  homedir: () => mockState.home,
}));

import { loadConfig } from "../src/config.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeConfigPath = resolve(mockState.home, ".reforger-forge", "config.json");
const legacyHomeConfigPath = resolve(mockState.home, ".enfusion-mcp", "config.json");
const localConfigPath = resolve(packageDir, "reforger-forge.config.json");
const legacyLocalConfigPath = resolve(packageDir, "enfusion-mcp.config.json");

const configEnvKeys = [
  "ENFUSION_WORKBENCH_PATH",
  "ENFUSION_PROJECT_PATH",
  "ENFUSION_GAME_PATH",
  "ENFUSION_EXTRACTED_PATH",
  "ENFUSION_MCP_DATA_DIR",
  "ENFUSION_WORKBENCH_HOST",
  "ENFUSION_WORKBENCH_PORT",
  "ENFUSION_DEFAULT_MOD",
] as const;

function putConfig(path: string, values: Record<string, unknown>): void {
  mockState.files.set(path, JSON.stringify(values));
}

beforeEach(() => {
  mockState.files.clear();
  for (const key of configEnvKeys) vi.stubEnv(key, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("enables non-modal assertion handling by default and allows an explicit override", () => {
    expect(loadConfig().workbenchNoThrow).toBe(true);

    putConfig(localConfigPath, { workbenchNoThrow: false });
    expect(loadConfig().workbenchNoThrow).toBe(false);
  });

  it("merges home below package-local config and environment variables above both", () => {
    putConfig(homeConfigPath, {
      projectPath: "home-project",
      workbenchHost: "home-current",
    });
    putConfig(legacyHomeConfigPath, {
      projectPath: "legacy-home-project",
      workbenchHost: "legacy-home",
    });
    putConfig(localConfigPath, { workbenchHost: "local-current" });
    putConfig(legacyLocalConfigPath, {
      projectPath: "legacy-local-project",
      workbenchHost: "legacy-local",
    });
    vi.stubEnv("ENFUSION_PROJECT_PATH", "environment-project");

    const config = loadConfig();

    expect(config.projectPath).toBe("environment-project");
    expect(config.workbenchHost).toBe("local-current");
  });

  it("uses legacy filenames when the corresponding current file is absent", () => {
    putConfig(legacyHomeConfigPath, {
      projectPath: "legacy-home-project",
      workbenchHost: "legacy-home",
    });
    putConfig(legacyLocalConfigPath, { workbenchHost: "legacy-local" });

    const config = loadConfig();

    expect(config.projectPath).toBe("legacy-home-project");
    expect(config.workbenchHost).toBe("legacy-local");
  });

  it("derives gamePath from a configured workbenchPath when gamePath is omitted", () => {
    const workbenchPath = resolve("D:\\SteamLibrary", "steamapps", "common", "Arma Reforger Tools");
    putConfig(localConfigPath, { workbenchPath });

    expect(loadConfig().gamePath).toBe(
      resolve(workbenchPath, "..", "Arma Reforger")
    );
  });

  it("derives gamePath from the environment workbenchPath when gamePath is omitted", () => {
    const workbenchPath = resolve("E:\\Games", "Arma Reforger Tools");
    vi.stubEnv("ENFUSION_WORKBENCH_PATH", workbenchPath);

    expect(loadConfig().gamePath).toBe(
      resolve(workbenchPath, "..", "Arma Reforger")
    );
  });

  it("preserves an explicitly configured gamePath when workbenchPath changes", () => {
    const gamePath = resolve("F:\\Reforger", "Game");
    putConfig(homeConfigPath, { gamePath });
    putConfig(localConfigPath, {
      workbenchPath: resolve("D:\\SteamLibrary", "Arma Reforger Tools"),
    });
    vi.stubEnv(
      "ENFUSION_WORKBENCH_PATH",
      resolve("E:\\AlternateLibrary", "Arma Reforger Tools")
    );

    expect(loadConfig().gamePath).toBe(gamePath);
  });

  it("lets ENFUSION_GAME_PATH override an explicitly configured gamePath", () => {
    putConfig(localConfigPath, { gamePath: resolve("D:\\Games", "Reforger") });
    const environmentGamePath = resolve("E:\\Games", "Reforger");
    vi.stubEnv("ENFUSION_GAME_PATH", environmentGamePath);

    expect(loadConfig().gamePath).toBe(environmentGamePath);
  });
});
