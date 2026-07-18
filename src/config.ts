import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { logger } from "./utils/logger.js";

export interface ObserverConfig {
  /** Optional managed observer root. The agent default is outside projectPath. */
  managedRoot?: string;
  /** Optional approved root for observer-exclusive runtime profiles. */
  profileRoot?: string;
  /** Optional override for the packaged private-child entry point. */
  agentPath?: string;
  /** Existing directories allowed as curated observer evidence destinations. */
  evidenceRoots?: string[];
  /** Existing directories from which bounded text log attachments may be read. */
  supportingLogRoots?: string[];
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  defaultCaptureTimeoutMs: number;
  maxInlineImageBytes: number;
  retentionIntervalMs: number;
  retentionMaxAgeMs: number;
  retentionMaxBytes: number;
  sessionTtlMs: number;
}

export interface Config {
  /** Path to "Arma Reforger Tools" installation */
  workbenchPath: string;
  /** Default project directory for project_browse */
  projectPath: string;
  /** Path to base game installation (auto-derived from workbenchPath) */
  gamePath: string;
  /** Optional ordered addon roots passed to Workbench as one comma-separated
   *  -addonsDir argument. Paths are validated before Workbench is launched. */
  workbenchAddonDirs?: string[];
  /** Suppress prompts for protected Workbench script operations in trusted
   *  local projects. Disabled by default. */
  workbenchScriptAuthorizeAll?: boolean;
  /** Pass -noThrow to automated Workbench sessions so assertions are written
   *  to the log instead of opening a modal dialog. Enabled by default. */
  workbenchNoThrow?: boolean;
  /** Optional path to a pre-extracted game data library (fully flattened prefabs).
   *  When set, game_duplicate checks here first before falling back to pak loose files.
   *  Set via ENFUSION_EXTRACTED_PATH env var. */
  extractedPath?: string;
  /** Directory containing scraped data index */
  dataDir: string;
  /** Directory containing mod pattern definitions */
  patternsDir: string;
  /** Workbench NET API host (default 127.0.0.1) */
  workbenchHost: string;
  /** Workbench NET API port (default 5775) */
  workbenchPort: number;
  /** Optional observer overrides plus bounded MCP/agent defaults. */
  observer?: ObserverConfig;
  /** Default addon folder name used when modName is not specified in tool calls.
   *  Automatically set at runtime when wb_launch opens a .gproj file.
   *  Can also be set via ENFUSION_DEFAULT_MOD env var as a static fallback. */
  defaultMod?: string;
}

const DEFAULT_WORKBENCH_PATH =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools";

const DEFAULTS: Config & { observer: ObserverConfig } = {
  workbenchPath: DEFAULT_WORKBENCH_PATH,
  projectPath: join(homedir(), "Documents", "My Games", "ArmaReforgerWorkbench", "addons"),
  gamePath: resolve(DEFAULT_WORKBENCH_PATH, "..", "Arma Reforger"),
  dataDir: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data"
  ),
  patternsDir: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data",
    "patterns"
  ),
  workbenchHost: "127.0.0.1",
  workbenchPort: 5775,
  workbenchNoThrow: true,
  observer: {
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 30_000,
    defaultCaptureTimeoutMs: 30_000,
    maxInlineImageBytes: 8 * 1024 * 1024,
    retentionIntervalMs: 60_000,
    retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
    retentionMaxBytes: 512 * 1024 * 1024,
    sessionTtlMs: 20 * 60 * 1_000,
  },
};

function loadJsonFile(path: string): Partial<Config> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<Config>;
  } catch (e) {
    // Distinguish read errors from parse errors so users can fix malformed JSON
    const detail = e instanceof SyntaxError
      ? `invalid JSON: ${e.message}`
      : String(e);
    logger.warn(`Failed to load config from ${path}: ${detail}`);
  }
  return {};
}

export function loadConfig(): Config {
  // 1. Start with defaults
  const config = { ...DEFAULTS, observer: { ...DEFAULTS.observer } };

  // 2. Load the user-home config as a lower-precedence base. The legacy name
  //    is a fallback only when the current config file does not exist.
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const homeConfigPath = resolve(homedir(), ".reforger-forge", "config.json");
  const legacyHomeConfigPath = resolve(homedir(), ".enfusion-mcp", "config.json");
  const homeConfig = loadJsonFile(
    existsSync(homeConfigPath) ? homeConfigPath : legacyHomeConfigPath
  );
  const homeObserver = {
    ...DEFAULTS.observer,
    ...(homeConfig.observer && typeof homeConfig.observer === "object" ? homeConfig.observer : {}),
  };
  Object.assign(config, homeConfig);
  config.observer = homeObserver;

  // 3. Package-local config overrides the user-home config. Its legacy name is
  //    likewise considered only when the current file is absent.
  const localConfigPath = resolve(packageDir, "reforger-forge.config.json");
  const legacyLocalConfigPath = resolve(packageDir, "enfusion-mcp.config.json");
  const localConfig = loadJsonFile(
    existsSync(localConfigPath) ? localConfigPath : legacyLocalConfigPath
  );
  const localObserver = {
    ...config.observer,
    ...(localConfig.observer && typeof localConfig.observer === "object" ? localConfig.observer : {}),
  };
  Object.assign(config, localConfig);
  config.observer = localObserver;

  const gamePathConfigured =
    homeConfig.gamePath !== undefined || localConfig.gamePath !== undefined;

  // 4. Environment variables override everything
  if (process.env.ENFUSION_WORKBENCH_PATH) {
    config.workbenchPath = process.env.ENFUSION_WORKBENCH_PATH;
  }
  if (process.env.ENFUSION_PROJECT_PATH) {
    config.projectPath = process.env.ENFUSION_PROJECT_PATH;
  }
  if (process.env.ENFUSION_GAME_PATH) {
    config.gamePath = process.env.ENFUSION_GAME_PATH;
  }
  if (process.env.ENFUSION_EXTRACTED_PATH) {
    config.extractedPath = process.env.ENFUSION_EXTRACTED_PATH;
  }
  if (process.env.ENFUSION_MCP_DATA_DIR) {
    config.dataDir = process.env.ENFUSION_MCP_DATA_DIR;
    // patternsDir is always <dataDir>/patterns unless explicitly set in a config file
    config.patternsDir = join(process.env.ENFUSION_MCP_DATA_DIR, "patterns");
  }
  if (process.env.ENFUSION_WORKBENCH_HOST) {
    config.workbenchHost = process.env.ENFUSION_WORKBENCH_HOST;
  }
  if (process.env.ENFUSION_WORKBENCH_PORT) {
    const port = parseInt(process.env.ENFUSION_WORKBENCH_PORT, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      config.workbenchPort = port;
    }
  }
  if (process.env.ENFUSION_DEFAULT_MOD) {
    config.defaultMod = process.env.ENFUSION_DEFAULT_MOD;
  }
  if (process.env.REFORGER_FORGE_OBSERVER_ROOT) {
    config.observer.managedRoot = process.env.REFORGER_FORGE_OBSERVER_ROOT;
  }
  if (process.env.REFORGER_FORGE_OBSERVER_PROFILE_ROOT) {
    config.observer.profileRoot = process.env.REFORGER_FORGE_OBSERVER_PROFILE_ROOT;
  }
  if (process.env.REFORGER_FORGE_OBSERVER_AGENT_PATH) {
    config.observer.agentPath = process.env.REFORGER_FORGE_OBSERVER_AGENT_PATH;
  }
  if (process.env.REFORGER_FORGE_OBSERVER_EVIDENCE_ROOTS) {
    config.observer.evidenceRoots = process.env.REFORGER_FORGE_OBSERVER_EVIDENCE_ROOTS.split(delimiter).filter(Boolean);
  }
  if (process.env.REFORGER_FORGE_OBSERVER_SUPPORTING_LOG_ROOTS) {
    config.observer.supportingLogRoots = process.env.REFORGER_FORGE_OBSERVER_SUPPORTING_LOG_ROOTS.split(delimiter).filter(Boolean);
  }
  type ObserverNumericKey = Exclude<keyof ObserverConfig, "managedRoot" | "profileRoot" | "agentPath" | "evidenceRoots" | "supportingLogRoots">;
  const observerNumericEnvironment: Array<[ObserverNumericKey, string]> = [
    ["startupTimeoutMs", "REFORGER_FORGE_OBSERVER_STARTUP_TIMEOUT_MS"],
    ["requestTimeoutMs", "REFORGER_FORGE_OBSERVER_REQUEST_TIMEOUT_MS"],
    ["defaultCaptureTimeoutMs", "REFORGER_FORGE_OBSERVER_CAPTURE_TIMEOUT_MS"],
    ["maxInlineImageBytes", "REFORGER_FORGE_OBSERVER_MAX_INLINE_IMAGE_BYTES"],
    ["retentionIntervalMs", "REFORGER_FORGE_OBSERVER_RETENTION_INTERVAL_MS"],
    ["retentionMaxAgeMs", "REFORGER_FORGE_OBSERVER_RETENTION_MAX_AGE_MS"],
    ["retentionMaxBytes", "REFORGER_FORGE_OBSERVER_RETENTION_MAX_BYTES"],
    ["sessionTtlMs", "REFORGER_FORGE_OBSERVER_SESSION_TTL_MS"],
  ];
  for (const [key, environmentName] of observerNumericEnvironment) {
    const raw = process.env[environmentName];
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value > 0) {
      config.observer[key] = value;
    }
  }

  // Auto-derive gamePath only when neither JSON nor the environment supplied it.
  if (
    !process.env.ENFUSION_GAME_PATH &&
    !gamePathConfigured &&
    config.workbenchPath !== DEFAULT_WORKBENCH_PATH
  ) {
    config.gamePath = resolve(config.workbenchPath, "..", "Arma Reforger");
  }

  logger.debug("Config loaded", config);
  return config;
}
