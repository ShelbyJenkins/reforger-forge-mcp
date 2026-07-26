# Additive `workbenchAddonDirs` + Auto-Discovered Workshop Root + Diagnostic Command

**Date:** 2026-07-26
**Tracks:** MCP-016 in `MCP_ISSUES.md` (`arma` repo).
**Goal:** Stop every addon's `start_mcp.ps1` from having to manually
rediscover the base-game addon root just because it also needs to add a
Workshop root — and give a caller a way to see *which* root resolves *which*
dependency GUID instead of cross-referencing a bare GUID list by hand.
**Architecture:** Three independent, additive changes to `src/config.ts` and
a new CLI/diagnostic surface — no lifecycle, receipt, or build-behavior
changes. Safe to land independently of the other three plans in this
directory.

---

## Root cause (already documented in `MCP_ISSUES.md` MCP-016)

`config.ts:824-825` only fills `workbenchAddonDirs` with the auto-discovered
`<gamePath>/addons` default when the field is completely unset:

```typescript
if (merged.workbenchAddonDirs === undefined && merged.gamePath) {
  merged.workbenchAddonDirs = [join(merged.gamePath, "addons")];
}
```

`--workbench-addon-dir` is documented and implemented as a full *replacement*
of `workbenchAddonDirs` (`config.ts:228`, `"Replace workbenchAddonDirs;
repeat for each root."`; parsed at `config.ts:348-350`, applied via
`replaceArray` at `config.ts:419-436`). The moment a caller passes even one
`--workbench-addon-dir` — needed for almost every real addon, since it has at
least one Workshop dependency — `overrides.workbenchAddonDirs` becomes a
fully-populated array, `merged.workbenchAddonDirs === undefined` is false,
and the free base-game default above never applies. This is exactly why
every `addons/*/start_mcp.ps1` calls `discover-steam` itself to recover
`workbenchAddonDirs[0]` before also passing the Workshop root.

## Task 1: Make the base-game default additive, not replaced

**File:** `src/config.ts`, the final merge step (`~lines 820-826`).

Replace the unconditional-default block with one that injects the
discovered base-game addons root into whatever `workbenchAddonDirs` already
resolved to, unless the caller explicitly opted out:

```typescript
const baseGameAddonsRoot = merged.gamePath ? join(merged.gamePath, "addons") : undefined;
if (merged.workbenchAddonDirs === undefined) {
  merged.workbenchAddonDirs = baseGameAddonsRoot ? [baseGameAddonsRoot] : undefined;
} else if (merged.workbenchAddonDirs.length > 0 && baseGameAddonsRoot) {
  const key = pathComparisonKey(baseGameAddonsRoot);
  if (!merged.workbenchAddonDirs.some((dir) => pathComparisonKey(dir) === key)) {
    merged.workbenchAddonDirs = [baseGameAddonsRoot, ...merged.workbenchAddonDirs];
  }
}
```

Three cases, and only one changes behavior:
- `undefined` (nothing specified at all) → same as today, single-entry
  base-game default.
- Explicit `--no-workbench-addon-dirs` (`[]`) → **stays `[]`**. This is a
  deliberate opt-out and must not get the base-game root injected — do not
  special-case this away.
- One or more explicit `--workbench-addon-dir` values → **new behavior**:
  the base-game root is prepended (deduplicated via the same
  `pathComparisonKey` already used elsewhere in this file) instead of being
  discarded.

`pathComparisonKey` is already imported in this file (from
`foundation/managed-path.js`) for other path-dedup purposes — reuse it, don't
reimplement comparison logic.

No changes needed to CLI parsing, `replaceArray`, or the config-file schema —
this fix is entirely contained to the final merge step.

## Task 2: Auto-discover the standard Workshop addon root

**New file (or addition to an existing platform module):**
`src/platform/windows/workshop-discovery.ts`, parallel to the existing
`src/platform/windows/steam-discovery.ts`.

Every `start_mcp.ps1` currently computes this identically:

```powershell
$DocumentsRoot = if ($env:OneDrive) { "$env:OneDrive\Documents" } else { [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments) }
$WorkshopAddonRoot = "$DocumentsRoot\My Games\ArmaReforger\addons"
```

Port this to a discovery function:

```typescript
export function discoverStandardWorkshopAddonRoot(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const documentsRoot = env.OneDrive
    ? join(env.OneDrive, "Documents")
    : join(homedir(), "Documents");
  const candidate = join(documentsRoot, "My Games", "ArmaReforger", "addons");
  return existsSync(candidate) ? candidate : undefined;
}
```

**Known limitation to flag, not silently paper over:** `[Environment]::GetFolderPath(MyDocuments)`
is .NET's *actual* Documents location, which can differ from
`homedir()/Documents` if the user has redirected their Documents folder
(NTFS folder redirection, roaming profiles). A fully faithful port would read
the Windows registry key
`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders\Personal`.
Decide explicitly whether the `homedir()`-based approximation is good enough
(it matches the common case, and the discovered path is `existsSync`-checked
before use, so a wrong guess just fails to find it rather than silently
pointing somewhere wrong) or worth the registry read. Either way, document
the choice in this function's own comment.

**Unlike Steam discovery, this must be best-effort, not a hard requirement.**
A user with no Workshop-installed addons yet has no such folder, and that
must not be an error — `discoverSteamInstallations` throws when Workbench or
the game can't be found because those are hard prerequisites; a Workshop
root is not.

Wire it into `config.ts`'s discovery step and Task 1's merge, alongside the
base-game root, under the same additive/opt-out rules — both roots are
injected together, both respect `--no-workbench-addon-dirs`.

## Task 3: Read-only "what do I need" diagnostic

**New CLI subcommand**, parallel to the existing `discover-steam` (`src/index.ts`):
`node dist/index.js check-addon-dirs --gproj <path>` (name open to
bikeshedding — match whatever `discover-steam` naming precedent suggests).

Reuse `auditWorkbenchAddonDependencies` (`src/workbench/addon-dependencies.ts`)
— already exported, already used by both `wb_build`'s and the standalone
runner's preflight — against the auto-discoverable candidate roots:
1. Base-game addons root (Task 1's discovery).
2. Standard Workshop root (Task 2's discovery), if it exists.
3. The repository's own sibling-addons root, derived from the target
   `.gproj`'s parent's parent directory (`addons/<Mod>/<Mod>.gproj` →
   `addons/`) — matches this repo's own convention, harmless to include even
   for a target with no local sibling dependencies.

Print a report, not just the raw audit result:

```text
Target: RoadblockRunners (02412E2D8D82234A)
Resolved:
  58D0FB3206B6F859  <- C:\...\Arma Reforger\addons
  64C912EF952E1075  <- C:\Users\...\Documents\My Games\ArmaReforger\addons
  ...
Missing (not found in any candidate root):
  69AF6B47AD1FF6F0
Ambiguous (resolved by more than one candidate root):
  (none)
```

This turns "cross-reference a bare GUID against installed addons by hand"
into a direct answer. It's read-only — never launches Workbench, never
mutates config, safe to run at any time against any target `.gproj`.

## Non-goals

- Not changing `--workbench-addon-dir`'s CLI flag name, its repeatability, or
  `--no-workbench-addon-dirs`'s opt-out semantics — only what happens when
  neither is the deciding factor (i.e., what the *default* merges with).
- Not adding a way to reconfigure `workbenchAddonDirs` on an already-running
  MCP server — that remains a restart, per the existing "config is read once
  at process start" design. This plan only reduces how often a restart is
  needed to fix a wrong default, and gives a diagnostic for when one still
  is.
- Not touching `--workbench-script-authorize-all`, `--observer-evidence-root`,
  or any other CLI flag.

## Task breakdown / file change summary

| File | Change Type |
|---|---|
| `src/config.ts` | Task 1: additive base-game default merge |
| `src/platform/windows/workshop-discovery.ts` | **New file**: Task 2's discovery function |
| `src/config.ts` | Wire Workshop-root discovery into the same additive merge |
| `src/index.ts` | Task 3: new `check-addon-dirs` subcommand |
| `tests/foundation/` or `tests/platform/` | New tests: `discoverStandardWorkshopAddonRoot` (OneDrive set/unset, folder missing) |
| `tests/config.test.ts` (or wherever config merge is tested) | New tests: additive merge for all three cases (undefined / opt-out / explicit-plus-default), dedup when caller already includes the base-game root explicitly |
| `tests/index.test.ts` or new file | New tests: `check-addon-dirs` output for resolved/missing/ambiguous cases |
| `README.md` / `agents/AGENTS.md` | Document the new additive default and `check-addon-dirs` |

## Relationship to the other plans in this directory

Independent of `2026-07-26-adopt-helper-free-build.md`,
`2026-07-26-remove-receipt-version-ceremony.md`, and
`2026-07-26-runner-cli-usage-docs.md` — this is config/CLI-argument handling,
unrelated to receipt shape or build behavior. Can land in any order relative
to those three, but ships together with them as part of the same combined
release (see the top-level project plan in the `arma` repo).
