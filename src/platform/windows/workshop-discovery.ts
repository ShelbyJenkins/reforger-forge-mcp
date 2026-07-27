import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Discover the conventional per-user Arma Reforger Workshop add-on root.
 *
 * Prefer the OneDrive environment variable when the host passes it through.
 * Some MCP hosts omit that variable from child processes even when the
 * profile uses the usual `<home>/OneDrive/Documents` location, so check that
 * bounded convention before the ordinary `<home>/Documents` fallback.
 *
 * This intentionally does not read the Windows redirected-Documents registry
 * value. Other redirected Documents locations can therefore still be missed,
 * but every candidate is existence-checked and callers can provide a custom
 * root when necessary.
 */
export function discoverStandardWorkshopAddonRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: () => string = homedir
): string | undefined {
  const documentsRoots = env.OneDrive
    ? [join(env.OneDrive, "Documents")]
    : [
        join(homeDirectory(), "OneDrive", "Documents"),
        join(homeDirectory(), "Documents"),
      ];
  for (const documentsRoot of documentsRoots) {
    const candidate = join(
      documentsRoot,
      "My Games",
      "ArmaReforger",
      "addons"
    );
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next bounded conventional Documents location.
    }
  }
  return undefined;
}
