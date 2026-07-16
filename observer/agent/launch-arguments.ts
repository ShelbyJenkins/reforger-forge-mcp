import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ADDON_GUID, ADDON_ID } from "../protocol/index.js";
import { ObserverError } from "./errors.js";
import { canonicalizeExistingDirectory } from "./paths.js";

const VALUE_FLAGS = new Set(["-profile", "-addonsdir", "-addons"]);
const OBSERVER_FLAGS = new Set([...VALUE_FLAGS, "-forceupdate"]);

function key(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function splitCommaValue(value: string, flag: string): string[] {
  if (value.includes('"') || value.includes("'")) {
    throw new ObserverError("ARGUMENT_CONFLICT", `${flag} values must be unquoted argument tokens`);
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function observerAddonAt(searchRoot: string): string | null {
  const project = join(searchRoot, ADDON_ID, "addon.gproj");
  if (!existsSync(project)) return null;
  try {
    return /(^|\s)ID\s+ReforgerForgeObserver(\s|$)/m.test(readFileSync(project, "utf8"))
      ? canonicalizeExistingDirectory(join(searchRoot, ADDON_ID), "Existing observer addon")
      : null;
  } catch {
    throw new ObserverError("ARGUMENT_CONFLICT", `Existing observer addon cannot be inspected: ${project}`);
  }
}

export interface MergeLaunchArgumentsInput {
  arguments: readonly string[];
  profilePath: string;
  addonSearchRoot: string;
  stagedAddonPath: string;
  forceUpdate: boolean;
}

export function mergeLaunchArguments(input: MergeLaunchArgumentsInput): string[] {
  const profilePath = canonicalizeExistingDirectory(input.profilePath, "Observer profile");
  const addonSearchRoot = canonicalizeExistingDirectory(input.addonSearchRoot, "Observer addon search root");
  const stagedAddonPath = canonicalizeExistingDirectory(input.stagedAddonPath, "Staged observer addon");
  if (basename(stagedAddonPath) !== ADDON_ID) {
    throw new ObserverError("ARGUMENT_CONFLICT", "Staged observer addon directory has an unexpected name");
  }

  const unrelated: string[] = [];
  const profiles: string[] = [];
  const addonRoots: string[] = [];
  const addonIds: string[] = [];
  let forceUpdateSeen = false;
  for (let index = 0; index < input.arguments.length; index += 1) {
    const token = input.arguments[index];
    const flag = token.toLowerCase();
    if (!OBSERVER_FLAGS.has(flag)) {
      unrelated.push(token);
      continue;
    }
    if (flag === "-forceupdate") {
      forceUpdateSeen = true;
      continue;
    }
    if (index + 1 >= input.arguments.length || input.arguments[index + 1].startsWith("-")) {
      throw new ObserverError("ARGUMENT_CONFLICT", `${token} requires one value token`);
    }
    const value = input.arguments[++index];
    if (flag === "-profile") profiles.push(value);
    else if (flag === "-addonsdir") addonRoots.push(...splitCommaValue(value, token));
    else addonIds.push(...splitCommaValue(value, token));
  }

  if (profiles.length > 1) throw new ObserverError("ARGUMENT_CONFLICT", "Multiple -profile flags are not supported");
  if (profiles.length === 1) {
    const existingProfile = canonicalizeExistingDirectory(profiles[0], "Existing profile");
    if (key(existingProfile) !== key(profilePath)) {
      throw new ObserverError("PROFILE_CONFLICT", "Existing -profile value conflicts with the observer-exclusive profile");
    }
  }

  const canonicalRoots: string[] = [];
  const seenRoots = new Set<string>();
  for (const root of [...addonRoots, addonSearchRoot]) {
    if (root.includes(",")) throw new ObserverError("ARGUMENT_CONFLICT", "Addon search roots containing commas cannot be represented safely");
    const canonical = canonicalizeExistingDirectory(root, "Addon search root");
    const rootKey = key(canonical);
    if (seenRoots.has(rootKey)) continue;
    const existingObserver = observerAddonAt(canonical);
    if (existingObserver && key(existingObserver) !== key(stagedAddonPath)) {
      throw new ObserverError("ARGUMENT_CONFLICT", "Arguments already reference a different ReforgerForgeObserver bundle");
    }
    seenRoots.add(rootKey);
    canonicalRoots.push(canonical);
  }

  const uniqueAddonIds: string[] = [];
  const seenAddonIds = new Set<string>();
  for (const addonId of [...addonIds, ADDON_GUID]) {
    const idKey = addonId.toLowerCase();
    if (seenAddonIds.has(idKey)) continue;
    seenAddonIds.add(idKey);
    uniqueAddonIds.push(addonId);
  }

  const result = [...unrelated, "-addonsDir", canonicalRoots.join(","), "-addons", uniqueAddonIds.join(","), "-profile", profilePath];
  if (input.forceUpdate || forceUpdateSeen) result.push("-forceUpdate");
  return result;
}
