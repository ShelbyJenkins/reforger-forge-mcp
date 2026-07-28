import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalizeGproj } from "../workbench/project-identity.js";

export const ADDON_TARGET_REQUIRED = "ADDON_TARGET_REQUIRED";
export const INVALID_ADDON_TARGET = "INVALID_ADDON_TARGET";

export class AddonTargetError extends Error {
  constructor(
    public readonly code: typeof ADDON_TARGET_REQUIRED | typeof INVALID_ADDON_TARGET,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "AddonTargetError";
  }
}

export interface AddonTargetOptions {
  /** Name of the public operation, used only in actionable error text. */
  readonly operation: string;
  /** Exact project file. When omitted, the currently running Workbench target is used. */
  readonly gprojPath?: string | null;
}

export interface ActiveProjectProvider {
  activeProjectGprojPath(): Promise<string | null>;
}

/**
 * Resolve the game data directory (loose/extracted files).
 * Tries gamePath/addons/data first (standard Steam install), then gamePath/addons.
 */
export function resolveGameDataPath(gamePath: string): string | null {
  const dataPath = join(gamePath, "addons", "data");
  if (existsSync(dataPath)) return dataPath;
  const addonsPath = join(gamePath, "addons");
  if (existsSync(addonsPath)) return addonsPath;
  return null;
}

/**
 * Find a loose file in the game data directory.
 * Handles paths with DataXXX prefix ("Data006/Prefabs/...") and bare paths ("Prefabs/...").
 */
export function findLooseFile(gameDataPath: string, relativePath: string): string | null {
  const direct = join(gameDataPath, relativePath);
  if (existsSync(direct)) return direct;

  if (!relativePath.startsWith("Data")) {
    try {
      const entries = readdirSync(gameDataPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("Data")) continue;
        const candidate = join(gameDataPath, entry.name, relativePath);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function targetRequiredMessage(operation: string): string {
  return `${operation} requires a project target. Supply the exact gprojPath or launch that project with wb_launch first.`;
}

/**
 * Resolve an addon root for a mutating addon-scoped operation.
 *
 * Project identity always comes from an exact .gproj. Dependency search roots
 * are a separate workbenchAddonDirs concern and are never used as write roots.
 */
export async function resolveAddonRoot(
  provider: ActiveProjectProvider | undefined,
  options: AddonTargetOptions
): Promise<string> {
  return dirname(await resolveProjectGprojPath(provider, options));
}

/** Resolve and canonicalize the exact project file for an addon-scoped operation. */
export async function resolveProjectGprojPath(
  provider: ActiveProjectProvider | undefined,
  options: AddonTargetOptions
): Promise<string> {
  const requested = options.gprojPath?.trim();
  const gprojPath = requested || await provider?.activeProjectGprojPath() || null;
  if (!gprojPath) {
    throw new AddonTargetError(
      ADDON_TARGET_REQUIRED,
      targetRequiredMessage(options.operation)
    );
  }
  try {
    return canonicalizeGproj(gprojPath).displayPath;
  } catch (error) {
    throw new AddonTargetError(
      INVALID_ADDON_TARGET,
      `${options.operation} requires an existing, unambiguous .gproj file: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Resolve a default write target when one was explicitly selected. Returning
 * null preserves generator preview behavior when no target was selected at all.
 */
export async function resolveOptionalAddonRoot(
  provider: ActiveProjectProvider | undefined,
  options: AddonTargetOptions
): Promise<string | null> {
  if (options.gprojPath?.trim()) return resolveAddonRoot(provider, options);
  const active = await provider?.activeProjectGprojPath() || null;
  return active
    ? resolveAddonRoot(undefined, { ...options, gprojPath: active })
    : null;
}
