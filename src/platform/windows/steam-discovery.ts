import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isPathContained } from "../../foundation/managed-path.js";

export const ARMA_REFORGER_APP_ID = "1874880";
export const ARMA_REFORGER_TOOLS_APP_ID = "1874910";

export const WORKBENCH_EXECUTABLE_RELATIVE_PATHS = [
  join("Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
  "ArmaReforgerWorkbenchSteamDiag.exe",
] as const;

export const GAME_EXECUTABLE_RELATIVE_PATHS = [
  "ArmaReforgerSteamDiag.exe",
  "ArmaReforgerDiag.exe",
  "ArmaReforgerSteam.exe",
  "ArmaReforger.exe",
] as const;

export type SteamDiscoveryStatus =
  | "success"
  | "not_found"
  | "ambiguous"
  | "malformed"
  | "unsupported";

export const STEAM_DISCOVERY_EXIT_CODES: Readonly<
  Record<SteamDiscoveryStatus, number>
> = {
  success: 0,
  not_found: 2,
  ambiguous: 3,
  malformed: 4,
  unsupported: 5,
};

export interface SteamDiscoveryResult {
  readonly status: SteamDiscoveryStatus;
  readonly workbenchPath?: string;
  readonly gamePath?: string;
  readonly workbenchAddonDirs?: string[];
  readonly workbenchCandidates: string[];
  readonly gameCandidates: string[];
  readonly steamRoots: string[];
  readonly libraryRoots: string[];
  readonly errors: SteamDiscoveryDiagnostic[];
}

export interface SteamDiscoveryDiagnostic {
  readonly code:
    | "METADATA_MALFORMED"
    | "INVALID_INSTALLATION"
    | "NOT_FOUND"
    | "UNSUPPORTED_PLATFORM";
  readonly source: "platform" | "libraryfolders" | "manifest" | "discovery";
  readonly message: string;
  readonly path?: string;
  readonly appId?: string;
}

export interface SteamDiscoveryOptions {
  /** Override for hermetic tests and diagnostic callers. */
  readonly platform?: NodeJS.Platform;
  /** Skip registry/process/default lookup and inspect only these Steam roots. */
  readonly steamRoots?: readonly string[];
  /** Override environment lookup for tests. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Override registry lookup for tests. */
  readonly readRegistryValue?: (
    key: string,
    valueName: string
  ) => string | undefined;
  /** Override running-process lookup for tests. */
  readonly runningSteamRoots?: () => readonly string[];
}

type ValveValue = string | ValveObject;
interface ValveObject {
  [key: string]: ValveValue;
}

const REGISTRY_LOCATIONS = [
  ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
  ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
  ["HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"],
] as const;
const MAX_STEAM_METADATA_BYTES = 4 * 1024 * 1024;

function comparisonPath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
}

function deduplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const absolute = resolve(trimmed);
    const key = comparisonPath(absolute);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(absolute);
  }
  return result;
}

function existingDirectory(path: string): string | undefined {
  try {
    const canonical = realpathSync.native(path);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isUsableSteamRoot(path: string): boolean {
  const steamapps = join(path, "steamapps");
  return existingDirectory(steamapps) !== undefined &&
    (
      existsSync(join(steamapps, "libraryfolders.vdf")) ||
      existsSync(join(steamapps, `appmanifest_${ARMA_REFORGER_APP_ID}.acf`)) ||
      existsSync(join(steamapps, `appmanifest_${ARMA_REFORGER_TOOLS_APP_ID}.acf`))
    );
}

function defaultRegistryValue(
  key: string,
  valueName: string
): string | undefined {
  try {
    const output = execFileSync(
      "reg.exe",
      ["query", key, "/v", valueName],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const line = output
      .split(/\r?\n/)
      .find((candidate) =>
        new RegExp(
          `^\\s*${valueName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+REG_`,
          "i"
        ).test(candidate)
      );
    return line?.replace(/^\s*\S+\s+REG_\S+\s+/i, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultRunningSteamRoots(): string[] {
  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='steam.exe'\" | ForEach-Object { $_.ExecutablePath }",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return output
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean)
      .map((executable) => dirname(executable));
  } catch {
    return [];
  }
}

export function locateSteamRoots(
  options: Omit<SteamDiscoveryOptions, "steamRoots"> = {}
): string[] {
  const readRegistryValue =
    options.readRegistryValue ?? defaultRegistryValue;
  const registryRoots = REGISTRY_LOCATIONS
    .map(([key, valueName]) => readRegistryValue(key, valueName))
    .filter((path): path is string => typeof path === "string")
    .map((path) => existingDirectory(path))
    .filter((path): path is string => path !== undefined)
    .filter(isUsableSteamRoot);
  if (registryRoots.length > 0) return deduplicatePaths(registryRoots);

  const processRoots = (
    options.runningSteamRoots ?? defaultRunningSteamRoots
  )()
    .map((path) => existingDirectory(path))
    .filter((path): path is string => path !== undefined)
    .filter(isUsableSteamRoot);
  if (processRoots.length > 0) return deduplicatePaths(processRoots);

  const environment = options.environment ?? process.env;
  const defaults = [
    environment["PROGRAMFILES(X86)"]
      ? join(environment["PROGRAMFILES(X86)"]!, "Steam")
      : undefined,
    environment.ProgramFiles
      ? join(environment.ProgramFiles, "Steam")
      : undefined,
    "C:\\Program Files (x86)\\Steam",
    "C:\\Program Files\\Steam",
  ]
    .filter((path): path is string => path !== undefined)
    .map((path) => existingDirectory(path))
    .filter((path): path is string => path !== undefined)
    .filter(isUsableSteamRoot);
  return deduplicatePaths(defaults);
}

function readBoundedMetadata(path: string): string {
  const size = statSync(path).size;
  if (size > MAX_STEAM_METADATA_BYTES) {
    throw new Error(
      `Metadata exceeds the ${MAX_STEAM_METADATA_BYTES}-byte limit.`
    );
  }
  return readFileSync(path, "utf8");
}

function tokenizeValveText(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "{" || char === "}") {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char !== "\"") {
      throw new Error(`Unexpected character at offset ${index}.`);
    }
    index += 1;
    let value = "";
    let terminated = false;
    while (index < text.length) {
      const current = text[index++];
      if (current === "\"") {
        terminated = true;
        break;
      }
      if (current === "\\") {
        if (index >= text.length) {
          throw new Error("Unterminated escape sequence.");
        }
        const escaped = text[index++];
        value += escaped === "\\" || escaped === "\"" ? escaped : `\\${escaped}`;
        continue;
      }
      value += current;
    }
    if (!terminated) throw new Error("Unterminated quoted string.");
    tokens.push(value);
  }
  return tokens;
}

export function parseValveKeyValues(text: string): ValveObject {
  const tokens = tokenizeValveText(text.replace(/^\uFEFF/, ""));
  let index = 0;

  const object = (nested: boolean): ValveObject => {
    const result = Object.create(null) as ValveObject;
    while (index < tokens.length) {
      if (tokens[index] === "}") {
        if (!nested) throw new Error("Unexpected closing brace.");
        index += 1;
        return result;
      }
      const key = tokens[index++];
      if (key === "{") throw new Error("Expected a quoted key.");
      const next = tokens[index++];
      if (next === undefined) throw new Error(`Missing value for '${key}'.`);
      if (next === "{") {
        result[key] = object(true);
      } else if (next === "}") {
        throw new Error(`Missing value for '${key}'.`);
      } else {
        result[key] = next;
      }
    }
    if (nested) throw new Error("Missing closing brace.");
    return result;
  };

  return object(false);
}

function asObject(value: ValveValue | undefined): ValveObject | undefined {
  return value && typeof value === "object" ? value : undefined;
}

function libraryRootsFromMetadata(
  steamRoot: string,
  errors: SteamDiscoveryDiagnostic[]
): string[] {
  const roots = [steamRoot];
  const metadataPath = join(steamRoot, "steamapps", "libraryfolders.vdf");
  if (!existsSync(metadataPath)) return roots;
  try {
    const document = parseValveKeyValues(readBoundedMetadata(metadataPath));
    const folders =
      asObject(document.libraryfolders) ??
      asObject(document.LibraryFolders);
    if (!folders) {
      throw new Error("Missing libraryfolders object.");
    }
    for (const [key, entry] of Object.entries(folders)) {
      if (!/^\d+$/.test(key)) continue;
      const rawPath =
        typeof entry === "string"
          ? entry
          : typeof entry.path === "string"
            ? entry.path
            : undefined;
      if (rawPath) roots.push(rawPath);
    }
  } catch (error) {
    errors.push({
      code: "METADATA_MALFORMED",
      source: "libraryfolders",
      path: metadataPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return roots;
}

function containsOneFile(
  root: string,
  relativePaths: readonly string[]
): boolean {
  return relativePaths.some((relativePath) => {
    try {
      const path = realpathSync.native(join(root, relativePath));
      return statSync(path).isFile() && isPathContained(root, path);
    } catch {
      return false;
    }
  });
}

export function isValidWorkbenchInstallation(path: string): boolean {
  const root = existingDirectory(path);
  return root !== undefined &&
    containsOneFile(root, WORKBENCH_EXECUTABLE_RELATIVE_PATHS);
}

export function isValidGameInstallation(path: string): boolean {
  const root = existingDirectory(path);
  if (root === undefined) return false;
  const addons = existingDirectory(join(root, "addons"));
  return addons !== undefined &&
    comparisonPath(addons) !== comparisonPath(root) &&
    isPathContained(root, addons) &&
    containsOneFile(root, GAME_EXECUTABLE_RELATIVE_PATHS);
}

function installationFromManifest(
  libraryRoot: string,
  appId: string,
  validate: (path: string) => boolean,
  errors: SteamDiscoveryDiagnostic[]
): string | undefined {
  const manifestPath = join(
    libraryRoot,
    "steamapps",
    `appmanifest_${appId}.acf`
  );
  if (!existsSync(manifestPath)) return undefined;
  try {
    const document = parseValveKeyValues(readBoundedMetadata(manifestPath));
    const state =
      asObject(document.AppState) ??
      asObject(document.appstate);
    if (!state) throw new Error("Missing AppState object.");
    if (state.appid !== appId) {
      throw new Error(
        `Manifest appid is '${
          typeof state.appid === "string" ? state.appid : "<missing>"
        }', expected '${appId}'.`
      );
    }
    if (typeof state.installdir !== "string" || !state.installdir.trim()) {
      throw new Error("Missing installdir.");
    }
    const commonRoot = resolve(libraryRoot, "steamapps", "common");
    const candidate = resolve(commonRoot, state.installdir);
    if (!isPathContained(commonRoot, candidate)) {
      errors.push({
        code: "INVALID_INSTALLATION",
        source: "manifest",
        path: manifestPath,
        appId,
        message: "installdir escapes steamapps/common.",
      });
      return undefined;
    }
    const canonical = existingDirectory(candidate);
    const canonicalCommon = existingDirectory(commonRoot);
    if (!canonical || !canonicalCommon
        || !isPathContained(canonicalCommon, canonical)
        || !validate(canonical)) {
      errors.push({
        code: "INVALID_INSTALLATION",
        source: "manifest",
        path: manifestPath,
        appId,
        message:
          "Resolved installation is outside the canonical library or is missing required files.",
      });
      return undefined;
    }
    return canonical;
  } catch (error) {
    errors.push({
      code: "METADATA_MALFORMED",
      source: "manifest",
      path: manifestPath,
      appId,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function discoverSteamInstallations(
  options: SteamDiscoveryOptions = {}
): SteamDiscoveryResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      status: "unsupported",
      workbenchCandidates: [],
      gameCandidates: [],
      steamRoots: [],
      libraryRoots: [],
      errors: [{
        code: "UNSUPPORTED_PLATFORM",
        source: "platform",
        message: `Steam discovery is supported only on Windows, not '${platform}'.`,
      }],
    };
  }

  const requestedRoots =
    options.steamRoots === undefined
      ? locateSteamRoots(options)
      : deduplicatePaths(options.steamRoots);
  const steamRoots = requestedRoots
    .map((path) => existingDirectory(path))
    .filter((path): path is string => path !== undefined);
  const errors: SteamDiscoveryDiagnostic[] = [];
  const libraryRoots = deduplicatePaths(
    steamRoots.flatMap((root) => libraryRootsFromMetadata(root, errors))
  )
    .map((path) => existingDirectory(path))
    .filter((path): path is string => path !== undefined);

  const workbenchCandidates = deduplicatePaths(
    libraryRoots
      .map((library) =>
        installationFromManifest(
          library,
          ARMA_REFORGER_TOOLS_APP_ID,
          isValidWorkbenchInstallation,
          errors
        )
      )
      .filter((path): path is string => path !== undefined)
  );
  const gameCandidates = deduplicatePaths(
    libraryRoots
      .map((library) =>
        installationFromManifest(
          library,
          ARMA_REFORGER_APP_ID,
          isValidGameInstallation,
          errors
        )
      )
      .filter((path): path is string => path !== undefined)
  );

  const common = {
    workbenchCandidates,
    gameCandidates,
    steamRoots,
    libraryRoots,
    errors,
  };
  if (errors.some((error) => error.code === "METADATA_MALFORMED")) {
    return { status: "malformed", ...common };
  }
  if (workbenchCandidates.length > 1 || gameCandidates.length > 1) {
    return { status: "ambiguous", ...common };
  }
  if (workbenchCandidates.length === 1 && gameCandidates.length === 1) {
    const gamePath = gameCandidates[0];
    return {
      status: "success",
      workbenchPath: workbenchCandidates[0],
      gamePath,
      workbenchAddonDirs: [join(gamePath, "addons")],
      ...common,
    };
  }
  return {
    status: "not_found",
    ...common,
    errors: [
      ...errors,
      {
        code: "NOT_FOUND",
        source: "discovery",
        message: `Could not find valid Steam manifests for Arma Reforger (${ARMA_REFORGER_APP_ID}) and Arma Reforger Tools (${ARMA_REFORGER_TOOLS_APP_ID}).`,
      },
    ],
  };
}

export function describeSteamDiscoveryFailure(
  result: SteamDiscoveryResult
): string {
  if (result.status === "success") return "";
  const candidates = [
    result.gameCandidates.length > 0
      ? `game candidates: ${result.gameCandidates.join(", ")}`
      : "no valid game candidate",
    result.workbenchCandidates.length > 0
      ? `Tools candidates: ${result.workbenchCandidates.join(", ")}`
      : "no valid Tools candidate",
  ].join("; ");
  const details =
    result.errors.length > 0
      ? ` ${result.errors
        .map((error) =>
          `${error.path ? `${error.path}: ` : ""}${error.message}`
        )
        .join(" ")}`
      : "";
  return `Steam discovery ${result.status}: ${candidates}.${details} Install both Steam apps or supply --workbench-path and/or --game-path (or their properties in an optional --config file).`;
}
