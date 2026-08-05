import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { GameLaunchPlanError } from "../launch/game-launch-errors.js";
import { isPathContained } from "../foundation/managed-path.js";
import { ObserverApplicationError } from "./errors.js";

export const forceNonNativeWindowSizeSchema = z.object({
  width: z.number().int().min(640).max(16_384).describe(
    "Exceptional window width in pixels.",
  ),
  height: z.number().int().min(480).max(16_384).describe(
    "Exceptional window height in pixels.",
  ),
  justification: z.string().trim().min(20).max(512).describe(
    "Why native fullscreen cannot be used. Screenshot size is not a valid reason; bound observer_capture image output instead.",
  ),
}).strict().describe(
  "Exceptional opt-in to a non-native window size. Omit this field for the native fullscreen default.",
);

const RAW_DISPLAY_ARGUMENTS = new Set(["-window", "-screenwidth", "-screenheight"]);

export function rawDisplayArgument(argumentsArray: readonly string[]): string | undefined {
  return argumentsArray.find((token) =>
    RAW_DISPLAY_ARGUMENTS.has(token.split("=", 1)[0].toLowerCase()),
  );
}

/** Preserve the primitive observer_prepare_launch native-fullscreen contract. */
export function assertNativeFullscreenLaunch(input: {
  runtimeKind: string;
  arguments: readonly string[];
  forceNonNativeWindowSize?: unknown;
}): void {
  const conflicting = rawDisplayArgument(input.arguments);
  if (conflicting) {
    throw new ObserverApplicationError(
      "ARGUMENT_CONFLICT",
      `${conflicting} cannot be supplied through arguments. Omit display overrides for native fullscreen, or use forceNonNativeWindowSize with explicit dimensions and a compelling justification.`,
    );
  }
  if (input.runtimeKind === "dedicated" && input.forceNonNativeWindowSize !== undefined) {
    throw new ObserverApplicationError(
      "INVALID_REQUEST",
      "forceNonNativeWindowSize is valid only for a graphical runtime",
    );
  }
}

/**
 * Put configuration-owned roots ahead of caller roots, then let the private
 * observer agent perform the single canonical `-addonsDir` normalization.
 */
export function mergeConfiguredAddonDirectories(
  argumentsArray: readonly string[],
  configuredAddonDirs: readonly string[] | undefined,
): string[] {
  if (!configuredAddonDirs || configuredAddonDirs.length === 0) {
    return [...argumentsArray];
  }
  return ["-addonsDir", configuredAddonDirs.join(","), ...argumentsArray];
}

const COMPOSITE_RESERVED_ARGUMENTS = new Set([
  "-profile",
  "-logsdir",
  "-addonsdir",
  "-addons",
  "-addondownloaddir",
  "-world",
  "-server",
  "-client",
  "-config",
  "-worldsystemsconfig",
  "-forceupdate",
  "-nofocus",
  "-nosplash",
  "-nothrow",
  "-disablecrashreporter",
  "-window",
  "-screenwidth",
  "-screenheight",
]);
const OWNER_ARGUMENT_PREFIXES = ["-reforgerforgeownertoken"];
export const COMPOSITE_ARGUMENT_MAXIMUM_COUNT = 512;
export const COMPOSITE_ARGUMENT_MAXIMUM_TOKEN_LENGTH = 8_192;
// Leave room for the executable, derived policy vector, observer-managed
// arguments, native-window exception, and final owner token. The manager still
// performs the exact quoted CreateProcess-length proof immediately before use.
export const COMPOSITE_ARGUMENT_MAXIMUM_UTF16_UNITS = 24_000;

/** Return the normalized reserved flag when a composite-only token owns it. */
export function compositeReservedArgument(token: string): string | undefined {
  const lower = token.toLowerCase();
  if (OWNER_ARGUMENT_PREFIXES.some((prefix) =>
    lower === prefix || lower.startsWith(`${prefix}=`) || lower.startsWith(`${prefix}:`))) {
    return "-reforgerForgeOwnerToken";
  }
  const flag = lower.split("=", 1)[0];
  return COMPOSITE_RESERVED_ARGUMENTS.has(flag) ? flag : undefined;
}

/** Validate only the future game_launch extra-argument surface. */
export function assertCompositeLaunchArguments(argumentsArray: readonly string[]): void {
  if (!Array.isArray(argumentsArray) || argumentsArray.length > COMPOSITE_ARGUMENT_MAXIMUM_COUNT) {
    throw new GameLaunchPlanError(
      "ARGUMENT_CONFLICT",
      `Additional game launch arguments exceed the ${COMPOSITE_ARGUMENT_MAXIMUM_COUNT}-token limit.`,
    );
  }
  let aggregate = 0;
  for (const [index, token] of argumentsArray.entries()) {
    if (typeof token !== "string" || token.length === 0 ||
        token.length > COMPOSITE_ARGUMENT_MAXIMUM_TOKEN_LENGTH || /[\0-\x1f\x7f]/u.test(token)) {
      throw new GameLaunchPlanError(
        "ARGUMENT_CONFLICT",
        `Additional game launch argument ${index} is empty, contains control characters, or exceeds its token limit.`,
      );
    }
    aggregate += token.length;
    if (aggregate > COMPOSITE_ARGUMENT_MAXIMUM_UTF16_UNITS) {
      throw new GameLaunchPlanError(
        "ARGUMENT_CONFLICT",
        "Additional game launch arguments exceed their aggregate input budget.",
      );
    }
    const reserved = compositeReservedArgument(token);
    if (reserved) {
      throw new GameLaunchPlanError(
        "ARGUMENT_CONFLICT",
        `${token.slice(0, 128)} is managed by game_launch and cannot be supplied through arguments.`,
      );
    }
  }
}

/** Deterministic, non-creating profile allocation for one canonical project. */
export function deriveGameLaunchProfilePath(
  profileRoot: string,
  projectComparisonKey: string,
): string {
  if (typeof profileRoot !== "string" || profileRoot.length === 0 ||
      typeof projectComparisonKey !== "string" || projectComparisonKey.length === 0) {
    throw new TypeError("Derived game launch profile input is invalid.");
  }
  const root = resolve(profileRoot);
  const leaf = createHash("sha256").update(projectComparisonKey, "utf8").digest("hex").slice(0, 32);
  const derived = resolve(root, "derived-v1", leaf);
  if (!isPathContained(root, derived)) {
    throw new GameLaunchPlanError("ADDON_ROOT_CONFLICT", "Derived game launch profile escaped its configured root.");
  }
  return derived;
}

export const deriveObserverProjectProfilePath = deriveGameLaunchProfilePath;
