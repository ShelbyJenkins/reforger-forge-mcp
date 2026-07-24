import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  canonicalizePotentialPath,
  isPathContained,
} from "./foundation/managed-path.js";

/** Bump whenever native JavaScript harnesses must reject an older compiled loader. */
export const EXPLICIT_CONFIGURATION_CONTRACT_VERSION = 1;

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
  /** Path to the Arma Reforger Tools installation. */
  workbenchPath: string;
  /** Addons container used as the default project/tool root. */
  projectPath: string;
  /** Path to the Arma Reforger game installation. */
  gamePath: string;
  /** Optional ordered addon roots passed to Workbench as one -addonsDir value. */
  workbenchAddonDirs?: string[];
  /** Suppress protected Workbench script prompts for trusted projects. */
  workbenchScriptAuthorizeAll?: boolean;
  /** Optional path to a pre-extracted game data library. */
  extractedPath?: string;
  /** Package-owned scraped data index directory. */
  dataDir: string;
  /** Package-owned mod-pattern directory. */
  patternsDir: string;
  /** Workbench NET API host. */
  workbenchHost: string;
  /** Workbench NET API port. */
  workbenchPort: number;
  /** Optional observer overrides plus bounded MCP/agent defaults. */
  observer?: ObserverConfig;
  /** Optional default addon folder used before wb_launch establishes one. */
  defaultMod?: string;
  /** Enable diagnostic logging for the MCP and private observer child. */
  debug?: boolean;
}

export class ConfigurationError extends Error {
  readonly code = "INVALID_CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

type ObserverNumericKey = Exclude<
  keyof ObserverConfig,
  "managedRoot" | "profileRoot" | "agentPath" | "evidenceRoots" | "supportingLogRoots"
>;

const OBSERVER_NUMERIC_BOUNDS: Record<
  ObserverNumericKey,
  readonly [minimum: number, maximum: number]
> = {
  startupTimeoutMs: [1_000, 60_000],
  requestTimeoutMs: [1_000, 300_000],
  defaultCaptureTimeoutMs: [1_000, 300_000],
  maxInlineImageBytes: [1_024, 64 * 1024 * 1024],
  retentionIntervalMs: [1_000, 24 * 60 * 60 * 1_000],
  retentionMaxAgeMs: [1_000, 5 * 365 * 24 * 60 * 60 * 1_000],
  retentionMaxBytes: [1024 * 1024, 64 * 1024 * 1024 * 1024],
  sessionTtlMs: [1_000, 24 * 60 * 60 * 1_000],
};

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKBENCH_EXECUTABLE_NAME = "ArmaReforgerWorkbenchSteamDiag.exe";
const GAME_EXECUTABLE_NAMES = [
  "ArmaReforgerSteamDiag.exe",
  "ArmaReforgerDiag.exe",
  "ArmaReforgerSteam.exe",
  "ArmaReforger.exe",
] as const;
const pathValue = z.string().trim().min(1).max(32_768);
const boundedInteger = (key: ObserverNumericKey) => {
  const [minimum, maximum] = OBSERVER_NUMERIC_BOUNDS[key];
  return z.number().int().min(minimum).max(maximum);
};

const observerFileSchema = z.object({
  managedRoot: pathValue.optional(),
  profileRoot: pathValue.optional(),
  agentPath: pathValue.optional(),
  evidenceRoots: z.array(pathValue).max(64).optional(),
  supportingLogRoots: z.array(pathValue).max(64).optional(),
  startupTimeoutMs: boundedInteger("startupTimeoutMs").optional(),
  requestTimeoutMs: boundedInteger("requestTimeoutMs").optional(),
  defaultCaptureTimeoutMs: boundedInteger("defaultCaptureTimeoutMs").optional(),
  maxInlineImageBytes: boundedInteger("maxInlineImageBytes").optional(),
  retentionIntervalMs: boundedInteger("retentionIntervalMs").optional(),
  retentionMaxAgeMs: boundedInteger("retentionMaxAgeMs").optional(),
  retentionMaxBytes: boundedInteger("retentionMaxBytes").optional(),
  sessionTtlMs: boundedInteger("sessionTtlMs").optional(),
}).strict();

const configFileSchema = z.object({
  workbenchPath: pathValue.optional(),
  projectPath: pathValue.optional(),
  gamePath: pathValue.optional(),
  workbenchAddonDirs: z.array(pathValue).max(128).optional(),
  workbenchScriptAuthorizeAll: z.boolean().optional(),
  extractedPath: pathValue.optional(),
  workbenchHost: z.string().trim().min(1).max(255).optional(),
  workbenchPort: z.number().int().min(1).max(65_535).optional(),
  observer: observerFileSchema.optional(),
  defaultMod: z.string().trim().min(1).max(128).optional(),
  debug: z.boolean().optional(),
}).strict();

type ConfigFile = z.infer<typeof configFileSchema>;
type ObserverOverrides = Partial<ObserverConfig>;
type ConfigOverrides = Partial<Omit<Config, "observer" | "dataDir" | "patternsDir">> & {
  observer?: ObserverOverrides;
};

export interface PartitionedConfigurationArguments {
  readonly configurationArguments: string[];
  readonly remainingArguments: string[];
}

interface ParsedConfigurationArguments {
  readonly configPath?: string;
  readonly overrides: ConfigOverrides;
}

export interface LoadConfigOptions {
  /** Base for relative --config and CLI path values. */
  cwd?: string;
}

const INTERNAL_OBSERVER_DEFAULTS: ObserverConfig = {
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  defaultCaptureTimeoutMs: 30_000,
  maxInlineImageBytes: 8 * 1024 * 1024,
  retentionIntervalMs: 60_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  retentionMaxBytes: 512 * 1024 * 1024,
  sessionTtlMs: 20 * 60 * 1_000,
};

const VALUE_FLAGS = new Set([
  "--config",
  "--workbench-path",
  "--game-path",
  "--project-path",
  "--workbench-addon-dir",
  "--extracted-path",
  "--workbench-host",
  "--workbench-port",
  "--default-mod",
  "--observer-managed-root",
  "--observer-profile-root",
  "--observer-agent-path",
  "--observer-evidence-root",
  "--observer-supporting-log-root",
  "--observer-startup-timeout-ms",
  "--observer-request-timeout-ms",
  "--observer-capture-timeout-ms",
  "--observer-max-inline-image-bytes",
  "--observer-retention-interval-ms",
  "--observer-retention-max-age-ms",
  "--observer-retention-max-bytes",
  "--observer-session-ttl-ms",
]);

const BOOLEAN_FLAGS = new Set([
  "--workbench-script-authorize-all",
  "--no-workbench-script-authorize-all",
  "--debug",
  "--no-debug",
]);

const REPEATABLE_FLAGS = new Set([
  "--workbench-addon-dir",
  "--observer-evidence-root",
  "--observer-supporting-log-root",
]);

const CONFIGURATION_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

export const CONFIGURATION_USAGE = [
  "Configuration:",
  "  --config <file>                         Load exactly this JSON file.",
  "  --workbench-path <directory>            Override workbenchPath.",
  "  --game-path <directory>                 Override gamePath.",
  "  --project-path <directory>              Override projectPath.",
  "  --workbench-addon-dir <directory>       Replace workbenchAddonDirs; repeat for each root.",
  "  --workbench-host <host>                 Override the NET API host.",
  "  --workbench-port <1..65535>             Override the NET API port.",
  "  --workbench-script-authorize-all        Enable protected Workbench script operations.",
  "  --no-workbench-script-authorize-all     Disable protected Workbench script operations.",
  "  --extracted-path <directory>            Override the optional extracted-data root.",
  "  --default-mod <name>                    Override the initial default addon.",
  "  --observer-managed-root <directory>     Override the observer managed root.",
  "  --observer-profile-root <directory>     Override the observer profile root.",
  "  --observer-agent-path <file>            Override the private observer child.",
  "  --observer-evidence-root <directory>    Replace evidenceRoots; repeat for each root.",
  "  --observer-supporting-log-root <dir>    Replace supportingLogRoots; repeat for each root.",
  "  --observer-*-ms / --observer-max-*      Override the documented observer limits.",
  "  --debug / --no-debug                    Enable or disable diagnostic logging.",
].join("\n");

function flagRequiresValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new ConfigurationError(`${flag} requires one value.`);
  }
  return value;
}

/**
 * Separate shared configuration flags from another executable's command
 * surface. The MCP entrypoint rejects all remaining arguments; the standalone
 * Workbench runner parses them as its own intent.
 */
export function partitionConfigurationArguments(
  argv: readonly string[]
): PartitionedConfigurationArguments {
  const configurationArguments: string[] = [];
  const remainingArguments: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!CONFIGURATION_FLAGS.has(token)) {
      remainingArguments.push(token);
      continue;
    }
    configurationArguments.push(token);
    if (VALUE_FLAGS.has(token)) {
      configurationArguments.push(flagRequiresValue(token, argv[index + 1]));
      index += 1;
    }
  }
  return { configurationArguments, remainingArguments };
}

function numericFlag(flag: string, raw: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new ConfigurationError(`${flag} must be an integer from ${minimum} through ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${flag} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function resolveCliPath(cwd: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function parseConfigurationArguments(
  argv: readonly string[],
  cwd: string
): ParsedConfigurationArguments {
  const seen = new Set<string>();
  const overrides: ConfigOverrides = {};
  const observer: ObserverOverrides = {};
  const workbenchAddonDirs: string[] = [];
  const evidenceRoots: string[] = [];
  const supportingLogRoots: string[] = [];
  let configPath: string | undefined;

  const unique = (key: string, flag: string): void => {
    if (seen.has(key)) throw new ConfigurationError(`${flag} may be supplied only once.`);
    seen.add(key);
  };
  const setObserverNumber = (key: ObserverNumericKey, flag: string, raw: string): void => {
    unique(String(key), flag);
    const [minimum, maximum] = OBSERVER_NUMERIC_BOUNDS[key];
    (observer as Record<string, unknown>)[key] = numericFlag(
      flag,
      raw,
      minimum,
      maximum
    );
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!CONFIGURATION_FLAGS.has(flag)) {
      throw new ConfigurationError(`Unknown configuration argument: ${flag}`);
    }
    const raw = VALUE_FLAGS.has(flag)
      ? flagRequiresValue(flag, argv[++index])
      : undefined;
    if (!REPEATABLE_FLAGS.has(flag)) unique(flag, flag);

    switch (flag) {
      case "--config":
        configPath = resolveCliPath(cwd, raw!);
        break;
      case "--workbench-path":
        overrides.workbenchPath = resolveCliPath(cwd, raw!);
        break;
      case "--game-path":
        overrides.gamePath = resolveCliPath(cwd, raw!);
        break;
      case "--project-path":
        overrides.projectPath = resolveCliPath(cwd, raw!);
        break;
      case "--workbench-addon-dir":
        workbenchAddonDirs.push(resolveCliPath(cwd, raw!));
        break;
      case "--extracted-path":
        overrides.extractedPath = resolveCliPath(cwd, raw!);
        break;
      case "--workbench-host":
        overrides.workbenchHost = raw!;
        break;
      case "--workbench-port":
        overrides.workbenchPort = numericFlag(flag, raw!, 1, 65_535);
        break;
      case "--default-mod":
        overrides.defaultMod = raw!;
        break;
      case "--workbench-script-authorize-all":
      case "--no-workbench-script-authorize-all":
        unique("workbenchScriptAuthorizeAll", flag);
        overrides.workbenchScriptAuthorizeAll = flag === "--workbench-script-authorize-all";
        break;
      case "--debug":
      case "--no-debug":
        unique("debug", flag);
        overrides.debug = flag === "--debug";
        break;
      case "--observer-managed-root":
        observer.managedRoot = resolveCliPath(cwd, raw!);
        break;
      case "--observer-profile-root":
        observer.profileRoot = resolveCliPath(cwd, raw!);
        break;
      case "--observer-agent-path":
        observer.agentPath = resolveCliPath(cwd, raw!);
        break;
      case "--observer-evidence-root":
        evidenceRoots.push(resolveCliPath(cwd, raw!));
        break;
      case "--observer-supporting-log-root":
        supportingLogRoots.push(resolveCliPath(cwd, raw!));
        break;
      case "--observer-startup-timeout-ms":
        setObserverNumber("startupTimeoutMs", flag, raw!);
        break;
      case "--observer-request-timeout-ms":
        setObserverNumber("requestTimeoutMs", flag, raw!);
        break;
      case "--observer-capture-timeout-ms":
        setObserverNumber("defaultCaptureTimeoutMs", flag, raw!);
        break;
      case "--observer-max-inline-image-bytes":
        setObserverNumber("maxInlineImageBytes", flag, raw!);
        break;
      case "--observer-retention-interval-ms":
        setObserverNumber("retentionIntervalMs", flag, raw!);
        break;
      case "--observer-retention-max-age-ms":
        setObserverNumber("retentionMaxAgeMs", flag, raw!);
        break;
      case "--observer-retention-max-bytes":
        setObserverNumber("retentionMaxBytes", flag, raw!);
        break;
      case "--observer-session-ttl-ms":
        setObserverNumber("sessionTtlMs", flag, raw!);
        break;
    }
  }

  if (workbenchAddonDirs.length > 0) overrides.workbenchAddonDirs = workbenchAddonDirs;
  if (evidenceRoots.length > 0) observer.evidenceRoots = evidenceRoots;
  if (supportingLogRoots.length > 0) observer.supportingLogRoots = supportingLogRoots;
  if (Object.keys(observer).length > 0) overrides.observer = observer;
  return { configPath, overrides };
}

function resolveFilePath(base: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function resolvePathArray(base: string, values: string[] | undefined): string[] | undefined {
  return values?.map((value) => resolveFilePath(base, value));
}

function resolveFileConfigPaths(config: ConfigFile, configPath: string): ConfigOverrides {
  const base = dirname(configPath);
  const observer = config.observer
    ? {
        ...config.observer,
        ...(config.observer.managedRoot
          ? { managedRoot: resolveFilePath(base, config.observer.managedRoot) }
          : {}),
        ...(config.observer.profileRoot
          ? { profileRoot: resolveFilePath(base, config.observer.profileRoot) }
          : {}),
        ...(config.observer.agentPath
          ? { agentPath: resolveFilePath(base, config.observer.agentPath) }
          : {}),
        ...(config.observer.evidenceRoots
          ? { evidenceRoots: resolvePathArray(base, config.observer.evidenceRoots) }
          : {}),
        ...(config.observer.supportingLogRoots
          ? { supportingLogRoots: resolvePathArray(base, config.observer.supportingLogRoots) }
          : {}),
      }
    : undefined;
  return {
    ...(config.workbenchPath
      ? { workbenchPath: resolveFilePath(base, config.workbenchPath) }
      : {}),
    ...(config.projectPath
      ? { projectPath: resolveFilePath(base, config.projectPath) }
      : {}),
    ...(config.gamePath
      ? { gamePath: resolveFilePath(base, config.gamePath) }
      : {}),
    ...(config.workbenchAddonDirs
      ? { workbenchAddonDirs: resolvePathArray(base, config.workbenchAddonDirs) }
      : {}),
    ...(config.extractedPath
      ? { extractedPath: resolveFilePath(base, config.extractedPath) }
      : {}),
    ...(config.workbenchScriptAuthorizeAll !== undefined
      ? { workbenchScriptAuthorizeAll: config.workbenchScriptAuthorizeAll }
      : {}),
    ...(config.workbenchHost !== undefined ? { workbenchHost: config.workbenchHost } : {}),
    ...(config.workbenchPort !== undefined ? { workbenchPort: config.workbenchPort } : {}),
    ...(config.defaultMod !== undefined ? { defaultMod: config.defaultMod } : {}),
    ...(config.debug !== undefined ? { debug: config.debug } : {}),
    ...(observer ? { observer } : {}),
  };
}

function readExplicitConfig(path: string): ConfigOverrides {
  if (!existsSync(path)) {
    throw new ConfigurationError(`Configuration file does not exist: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigurationError(
      `Configuration file could not be read as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const parsed = configFileSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Configuration file is invalid: ${detail}`);
  }
  return resolveFileConfigPaths(parsed.data, path);
}

function requireDirectory(path: string | undefined, label: string): string {
  if (!path) {
    throw new ConfigurationError(
      `${label} is required; provide it in --config or with its explicit CLI flag.`
    );
  }
  try {
    const canonical = realpathSync.native(path);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new ConfigurationError(`${label} must resolve to an existing directory: ${path}`);
  }
}

function validateOptionalDirectories(
  paths: string[] | undefined,
  label: string
): string[] | undefined {
  return paths?.map((path, index) => requireDirectory(path, `${label} ${index + 1}`));
}

function requireFile(path: string | undefined, label: string): string {
  if (!path) {
    throw new ConfigurationError(
      `${label} is required; provide it in --config or with its explicit CLI flag.`
    );
  }
  try {
    const canonical = realpathSync.native(path);
    if (!statSync(canonical).isFile()) throw new Error("not a file");
    return canonical;
  } catch {
    throw new ConfigurationError(`${label} must resolve to an existing file: ${path}`);
  }
}

function requireOneInstallationFile(
  installationRoot: string,
  relativePaths: readonly string[],
  label: string
): void {
  const paths = relativePaths.map((path) => join(installationRoot, path));
  for (const path of paths) {
    try {
      const canonical = realpathSync.native(path);
      if (statSync(canonical).isFile()
          && isPathContained(installationRoot, canonical)) {
        return;
      }
    } catch {
      // Continue through the fixed allowlist.
    }
  }
  throw new ConfigurationError(
    `${label} must contain one supported executable: ${paths.join(", ")}`
  );
}

function requireProspectiveDirectory(path: string, label: string): string {
  try {
    return canonicalizePotentialPath(path, {
      linkPolicy: "follow-existing",
      existingAncestor: "directory",
      label,
    });
  } catch (error) {
    throw new ConfigurationError(
      `${label} must be an existing directory or have a creatable missing tail: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function validateConfig(config: Config): Config {
  config.workbenchPath = requireDirectory(config.workbenchPath, "workbenchPath");
  config.gamePath = requireDirectory(config.gamePath, "gamePath");
  requireOneInstallationFile(
    config.workbenchPath,
    [
      join("Workbench", WORKBENCH_EXECUTABLE_NAME),
      WORKBENCH_EXECUTABLE_NAME,
    ],
    "workbenchPath"
  );
  requireDirectory(join(config.gamePath, "addons"), "gamePath/addons");
  requireOneInstallationFile(
    config.gamePath,
    GAME_EXECUTABLE_NAMES,
    "gamePath"
  );
  config.projectPath = requireDirectory(config.projectPath, "projectPath");
  if (isPathContained(config.workbenchPath, config.gamePath)
      || isPathContained(config.gamePath, config.workbenchPath)) {
    throw new ConfigurationError("workbenchPath and gamePath must not overlap.");
  }
  if (isPathContained(config.workbenchPath, config.projectPath)
      || isPathContained(config.projectPath, config.workbenchPath)
      || isPathContained(config.gamePath, config.projectPath)
      || isPathContained(config.projectPath, config.gamePath)) {
    throw new ConfigurationError(
      "projectPath must not overlap the Workbench or Arma Reforger installation."
    );
  }
  if ((config.workbenchAddonDirs?.length ?? 0) > 128) {
    throw new ConfigurationError("workbenchAddonDirs may contain at most 128 entries.");
  }
  config.workbenchAddonDirs = validateOptionalDirectories(
    config.workbenchAddonDirs,
    "workbenchAddonDirs entry"
  );
  for (const path of config.workbenchAddonDirs ?? []) {
    if (path.includes(",")) {
      throw new ConfigurationError(
        `workbenchAddonDirs entries cannot contain commas because Workbench uses a comma-delimited -addonsDir argument: ${path}`
      );
    }
  }
  if (config.extractedPath) {
    config.extractedPath = requireDirectory(config.extractedPath, "extractedPath");
  }
  if (config.observer?.agentPath) {
    config.observer.agentPath = requireFile(config.observer.agentPath, "observer.agentPath");
  }
  if (config.observer?.managedRoot) {
    config.observer.managedRoot = requireProspectiveDirectory(
      config.observer.managedRoot,
      "observer.managedRoot"
    );
  }
  if (config.observer?.profileRoot) {
    config.observer.profileRoot = requireProspectiveDirectory(
      config.observer.profileRoot,
      "observer.profileRoot"
    );
  }
  for (const [label, path] of [
    ["observer.managedRoot", config.observer?.managedRoot],
    ["observer.profileRoot", config.observer?.profileRoot],
  ] as const) {
    if (!path) continue;
    const protectedRoot = [
      ["projectPath", config.projectPath],
      ["workbenchPath", config.workbenchPath],
      ["gamePath", config.gamePath],
    ] as const;
    for (const [protectedLabel, root] of protectedRoot) {
      if (isPathContained(root, path) || isPathContained(path, root)) {
        throw new ConfigurationError(`${label} must not overlap ${protectedLabel}.`);
      }
    }
  }
  if ((config.observer?.evidenceRoots?.length ?? 0) > 64) {
    throw new ConfigurationError("observer.evidenceRoots may contain at most 64 entries.");
  }
  if ((config.observer?.supportingLogRoots?.length ?? 0) > 64) {
    throw new ConfigurationError("observer.supportingLogRoots may contain at most 64 entries.");
  }
  if (config.observer) {
    config.observer.evidenceRoots = validateOptionalDirectories(
      config.observer.evidenceRoots,
      "observer.evidenceRoots entry"
    );
    config.observer.supportingLogRoots = validateOptionalDirectories(
      config.observer.supportingLogRoots,
      "observer.supportingLogRoots entry"
    );
  }
  config.workbenchHost = config.workbenchHost.trim();
  if (!config.workbenchHost
      || config.workbenchHost.length > 255
      || /[\0\r\n]/.test(config.workbenchHost)) {
    throw new ConfigurationError(
      "workbenchHost must contain 1 through 255 characters without control delimiters."
    );
  }
  if (!Number.isInteger(config.workbenchPort)
      || config.workbenchPort < 1
      || config.workbenchPort > 65_535) {
    throw new ConfigurationError("workbenchPort must be an integer from 1 through 65535.");
  }
  if (config.defaultMod !== undefined) {
    config.defaultMod = config.defaultMod.trim();
    if (!config.defaultMod
        || config.defaultMod.length > 128
        || config.defaultMod === "."
        || config.defaultMod === ".."
        || config.defaultMod.includes("/")
        || config.defaultMod.includes("\\")) {
      throw new ConfigurationError(
        "defaultMod must name one direct project folder using 1 through 128 characters."
      );
    }
  }
  return config;
}

/**
 * Load one explicit configuration. No package/home file discovery and no
 * environment-variable configuration are performed.
 */
export function loadConfig(
  argv: readonly string[] = [],
  options: LoadConfigOptions = {}
): Config {
  const cwd = resolve(options.cwd ?? process.cwd());
  const parsed = parseConfigurationArguments(argv, cwd);
  const fileConfig = parsed.configPath ? readExplicitConfig(parsed.configPath) : {};
  const fileObserver = fileConfig.observer ?? {};
  const cliObserver = parsed.overrides.observer ?? {};
  const config = {
    dataDir: resolve(packageDirectory, "data"),
    patternsDir: resolve(packageDirectory, "data", "patterns"),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
    workbenchScriptAuthorizeAll: false,
    debug: false,
    ...fileConfig,
    ...parsed.overrides,
    observer: {
      ...INTERNAL_OBSERVER_DEFAULTS,
      ...fileObserver,
      ...cliObserver,
    },
  } as Config;
  return validateConfig(config);
}
