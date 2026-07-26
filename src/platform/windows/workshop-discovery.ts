import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Discover the conventional per-user Arma Reforger Workshop add-on root.
 *
 * This intentionally uses the common `homedir()/Documents` approximation
 * rather than reading the Windows redirected-Documents registry value. A
 * redirected Documents folder can therefore be missed, but the candidate is
 * existence-checked before use and callers can still provide a custom root.
 */
export function discoverStandardWorkshopAddonRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: () => string = homedir
): string | undefined {
  const documentsRoot = env.OneDrive
    ? join(env.OneDrive, "Documents")
    : join(homeDirectory(), "Documents");
  const candidate = join(
    documentsRoot,
    "My Games",
    "ArmaReforger",
    "addons"
  );
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}
