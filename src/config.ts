import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { logger } from "./utils/logger.js";

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
  /** Default addon folder name used when modName is not specified in tool calls.
   *  Automatically set at runtime when wb_launch opens a .gproj file.
   *  Can also be set via ENFUSION_DEFAULT_MOD env var as a static fallback. */
  defaultMod?: string;
}

const DEFAULT_WORKBENCH_PATH =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools";

const DEFAULTS: Config = {
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
  const config = { ...DEFAULTS };

  // 2. Load the user-home config as a lower-precedence base. The legacy name
  //    is a fallback only when the current config file does not exist.
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const homeConfigPath = resolve(homedir(), ".reforger-forge", "config.json");
  const legacyHomeConfigPath = resolve(homedir(), ".enfusion-mcp", "config.json");
  const homeConfig = loadJsonFile(
    existsSync(homeConfigPath) ? homeConfigPath : legacyHomeConfigPath
  );
  Object.assign(config, homeConfig);

  // 3. Package-local config overrides the user-home config. Its legacy name is
  //    likewise considered only when the current file is absent.
  const localConfigPath = resolve(packageDir, "reforger-forge.config.json");
  const legacyLocalConfigPath = resolve(packageDir, "enfusion-mcp.config.json");
  const localConfig = loadJsonFile(
    existsSync(localConfigPath) ? localConfigPath : legacyLocalConfigPath
  );
  Object.assign(config, localConfig);

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
