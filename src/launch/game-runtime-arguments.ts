import { ADDON_GUID_PATTERN } from "../workbench/addon-dependencies.js";

export type GameRuntimeKind = "client" | "listenServer";

export interface BuildGraphicalRuntimeArgumentsOptions {
  readonly runtimeKind: GameRuntimeKind;
  readonly worldResourceReference: string;
  readonly addon?: {
    readonly emittedAddonRoots: readonly string[];
    readonly targetAddonGuid: string;
  };
  readonly extraArguments?: readonly string[];
}

export interface BuildGameRuntimeArgumentsOptions {
  readonly runtimeKind: GameRuntimeKind;
  readonly worldResourceReference: string;
  readonly emittedAddonRoots: readonly string[];
  readonly targetAddonGuid: string;
  readonly extraArguments?: readonly string[];
}

export function gameRuntimeWorldSelector(runtimeKind: GameRuntimeKind): "-world" | "-server" {
  return runtimeKind === "listenServer" ? "-server" : "-world";
}

/** Shared mapping used by both acceptance scripts and the public composite. */
export function buildGraphicalRuntimeArguments(
  options: BuildGraphicalRuntimeArgumentsOptions,
): string[] {
  if ((options.runtimeKind !== "client" && options.runtimeKind !== "listenServer") ||
      typeof options.worldResourceReference !== "string" ||
      options.worldResourceReference.trim().length === 0 || /[\0\r\n]/.test(options.worldResourceReference)) {
    throw new TypeError("Graphical runtime world selection is invalid.");
  }
  const result = [
    "-noSplash",
    "-noThrow",
    "-disableCrashReporter",
    gameRuntimeWorldSelector(options.runtimeKind),
    options.worldResourceReference,
  ];
  if (options.addon) {
    if (!Array.isArray(options.addon.emittedAddonRoots) || options.addon.emittedAddonRoots.length === 0 ||
        options.addon.emittedAddonRoots.some((root) => typeof root !== "string" || root.length === 0 || /[,\0\r\n]/.test(root)) ||
        !ADDON_GUID_PATTERN.test(options.addon.targetAddonGuid)) {
      throw new TypeError("Graphical runtime add-on selection is invalid.");
    }
    result.push(
      "-addonsDir",
      options.addon.emittedAddonRoots.join(","),
      "-addons",
      options.addon.targetAddonGuid,
    );
  }
  result.push(...(options.extraArguments ?? []));
  return result;
}

export function buildGameRuntimeArguments(options: BuildGameRuntimeArgumentsOptions): string[] {
  return buildGraphicalRuntimeArguments({
    runtimeKind: options.runtimeKind,
    worldResourceReference: options.worldResourceReference,
    addon: {
      emittedAddonRoots: options.emittedAddonRoots,
      targetAddonGuid: options.targetAddonGuid,
    },
    extraArguments: options.extraArguments,
  });
}
