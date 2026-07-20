import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delimiter, dirname, resolve } from "node:path";
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
  "REFORGER_FORGE_OBSERVER_ROOT",
  "REFORGER_FORGE_OBSERVER_PROFILE_ROOT",
  "REFORGER_FORGE_OBSERVER_AGENT_PATH",
  "REFORGER_FORGE_OBSERVER_EVIDENCE_ROOTS",
  "REFORGER_FORGE_OBSERVER_SUPPORTING_LOG_ROOTS",
  "REFORGER_FORGE_OBSERVER_STARTUP_TIMEOUT_MS",
  "REFORGER_FORGE_OBSERVER_REQUEST_TIMEOUT_MS",
  "REFORGER_FORGE_OBSERVER_CAPTURE_TIMEOUT_MS",
  "REFORGER_FORGE_OBSERVER_MAX_INLINE_IMAGE_BYTES",
  "REFORGER_FORGE_OBSERVER_RETENTION_INTERVAL_MS",
  "REFORGER_FORGE_OBSERVER_RETENTION_MAX_AGE_MS",
  "REFORGER_FORGE_OBSERVER_RETENTION_MAX_BYTES",
  "REFORGER_FORGE_OBSERVER_SESSION_TTL_MS",
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

  it("merges observer defaults and applies bounded environment overrides", () => {
    putConfig(homeConfigPath, {
      observer: { maxInlineImageBytes: 1_000_000, sessionTtlMs: 90_000 },
    });
    putConfig(localConfigPath, {
      observer: { defaultCaptureTimeoutMs: 45_000 },
    });
    vi.stubEnv("REFORGER_FORGE_OBSERVER_ROOT", resolve("D:\\Observer", "managed"));
    vi.stubEnv("REFORGER_FORGE_OBSERVER_MAX_INLINE_IMAGE_BYTES", "2000000");
    vi.stubEnv("REFORGER_FORGE_OBSERVER_EVIDENCE_ROOTS", ["D:\\Evidence", "E:\\Reviewed"].join(delimiter));
    vi.stubEnv("REFORGER_FORGE_OBSERVER_SUPPORTING_LOG_ROOTS", ["D:\\Logs"].join(delimiter));
    vi.stubEnv("REFORGER_FORGE_OBSERVER_SESSION_TTL_MS", "not-a-number");

    const observer = loadConfig().observer!;

    expect(observer.managedRoot).toBe(resolve("D:\\Observer", "managed"));
    expect(observer.maxInlineImageBytes).toBe(2_000_000);
    expect(observer.defaultCaptureTimeoutMs).toBe(45_000);
    expect(observer.sessionTtlMs).toBe(90_000);
    expect(observer.evidenceRoots).toEqual(["D:\\Evidence", "E:\\Reviewed"]);
    expect(observer.supportingLogRoots).toEqual(["D:\\Logs"]);
    expect(observer.retentionMaxAgeMs).toBeGreaterThan(0);
  });
});
