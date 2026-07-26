import { basename, dirname, join, resolve } from "node:path";
import { pathComparisonKey } from "../foundation/managed-path.js";
import {
  discoverSteamInstallations,
  type SteamDiscoveryResult,
} from "../platform/windows/steam-discovery.js";
import { discoverStandardWorkshopAddonRoot } from "../platform/windows/workshop-discovery.js";
import {
  auditWorkbenchAddonDependencies,
  type WorkbenchAddonDependencyAudit,
} from "./addon-dependencies.js";

export const CHECK_ADDON_DIRS_COMMAND = "check-addon-dirs";

export interface CheckAddonDirsDependencies {
  /** Override Steam discovery for hermetic callers and tests. */
  readonly discoverSteam?: () => SteamDiscoveryResult;
  /** Override standard Workshop-root discovery for hermetic callers and tests. */
  readonly discoverWorkshopAddonRoot?: () => string | undefined;
  /** Override the bounded dependency audit for focused callers and tests. */
  readonly audit?: typeof auditWorkbenchAddonDependencies;
}

export interface CheckAddonDirsReport {
  readonly targetGprojPath: string;
  /** Auto-discoverable candidate add-on roots passed to the dependency audit. */
  readonly addonRoots: readonly string[];
  readonly audit: WorkbenchAddonDependencyAudit;
}

function uniquePathList(paths: readonly (string | undefined)[]): readonly string[] {
  const roots: string[] = [];
  for (const path of paths) {
    if (!path || roots.some((root) =>
      pathComparisonKey(root) === pathComparisonKey(path)
    )) {
      continue;
    }
    roots.push(path);
  }
  return Object.freeze(roots);
}

function discoverBaseGameAddonRoot(
  discoverSteam: () => SteamDiscoveryResult
): string | undefined {
  try {
    const discovery = discoverSteam();
    const gamePath = discovery.gamePath ??
      (discovery.gameCandidates.length === 1
        ? discovery.gameCandidates[0]
        : undefined);
    return gamePath ? join(gamePath, "addons") : undefined;
  } catch {
    return undefined;
  }
}

function discoverWorkshopAddonRoot(
  discoverWorkshop: () => string | undefined
): string | undefined {
  try {
    return discoverWorkshop();
  } catch {
    return undefined;
  }
}

/**
 * Gather the read-only diagnostic's standard roots. The sibling root follows
 * the usual `addons/<Mod>/<Mod>.gproj` layout and is harmless when absent.
 */
export function discoverCheckAddonDirsRoots(
  targetGprojPath: string,
  dependencies: CheckAddonDirsDependencies = {}
): readonly string[] {
  const target = resolve(targetGprojPath);
  return uniquePathList([
    discoverBaseGameAddonRoot(
      dependencies.discoverSteam ?? discoverSteamInstallations
    ),
    discoverWorkshopAddonRoot(
      dependencies.discoverWorkshopAddonRoot ?? discoverStandardWorkshopAddonRoot
    ),
    dirname(dirname(target)),
  ]);
}

/** Audit an exact target against only roots that can be found without config. */
export function checkAddonDirs(
  targetGprojPath: string,
  dependencies: CheckAddonDirsDependencies = {}
): CheckAddonDirsReport {
  if (typeof targetGprojPath !== "string" || targetGprojPath.trim().length === 0) {
    throw new Error("check-addon-dirs requires one non-empty --gproj <path> value.");
  }
  const target = resolve(targetGprojPath.trim());
  const addonRoots = discoverCheckAddonDirsRoots(target, dependencies);
  const audit = (dependencies.audit ?? auditWorkbenchAddonDependencies)({
    targetGprojPath: target,
    addonRoots,
  });
  return Object.freeze({ targetGprojPath: target, addonRoots, audit });
}

function targetName(targetGprojPath: string): string {
  return basename(targetGprojPath).replace(/\.gproj$/i, "");
}

function linesOrNone(lines: readonly string[]): readonly string[] {
  return lines.length > 0 ? lines : ["  (none)"];
}

/** Render the human-readable dependency-to-root diagnostic report. */
export function formatCheckAddonDirsReport(report: CheckAddonDirsReport): string {
  return [
    `Target: ${targetName(report.targetGprojPath)} (${report.audit.targetGuid})`,
    "Resolved:",
    ...linesOrNone(report.audit.resolvedDependencies.map((dependency) =>
      `  ${dependency.guid}  <- ${dependency.addonRoot}`
    )),
    "Missing (not found in any candidate root):",
    ...linesOrNone(report.audit.missingGuids.map((guid) => `  ${guid}`)),
    "Ambiguous (resolved by more than one candidate root):",
    ...linesOrNone(report.audit.ambiguousGuids.map((guid) => `  ${guid}`)),
  ].join("\n");
}

/** Parse the narrow command surface without loading or changing server config. */
export function parseCheckAddonDirsArguments(
  argv: readonly string[],
  cwd = process.cwd()
): string {
  if (argv[0] !== CHECK_ADDON_DIRS_COMMAND) {
    throw new Error(`Expected ${CHECK_ADDON_DIRS_COMMAND} command.`);
  }
  let targetGprojPath: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--gproj") {
      throw new Error(
        `${CHECK_ADDON_DIRS_COMMAND} accepts only --gproj <path>.`
      );
    }
    if (targetGprojPath !== undefined) {
      throw new Error(`${CHECK_ADDON_DIRS_COMMAND} accepts --gproj only once.`);
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      throw new Error(`${CHECK_ADDON_DIRS_COMMAND} requires --gproj <path>.`);
    }
    targetGprojPath = resolve(cwd, value.trim());
  }
  if (!targetGprojPath) {
    throw new Error(`${CHECK_ADDON_DIRS_COMMAND} requires --gproj <path>.`);
  }
  return targetGprojPath;
}
