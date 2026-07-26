# Documenting Direct Runner CLI Invocation

**Date:** 2026-07-26
**Goal:** Document the existing `runner-cli.js` build/editor contract clearly
enough that a caller (RoadblockRunners' scripts, or any future addon) can
trust it instead of re-deriving ~90 lines of receipt verification by hand.
No new CLI code — this is a documentation change only.
**Why docs and not code:** every check worth adding is already provably
guaranteed by the runner today (see below); the one genuine gap is small
enough to document as a three-line recipe rather than build a CLI flag for.

---

## Current state (read this before assuming a CLI needs to be built)

`src/workbench/runner-cli.ts` (compiled to `dist/workbench/runner-cli.js`,
packaged as `reforger-forge-workbench`) already is a standalone CLI that
uses the exact same code the MCP tools `wb_build`/`wb_launch` call
internally (`runner-cli.ts:90` and `src/tools/wb-build.ts:105` both call
`runWorkbenchIntent`). This is what
`addons/RoadblockRunners/build_workbench.ps1`/`launch_workbench.ps1` already
invoke today. `README.md:349-397` already documents its invocation syntax and
narrates its guarantees in prose.

What's missing isn't a capability — it's a **reference**. The README
explains *that* the build receipt binds add-on ID/GUID, project-file SHA-256,
and fresh hashed output before reporting success, but nowhere does it lay out
the receipt's actual field shape, or say plainly "therefore you do not need
to re-check X, Y, Z yourself." Without that, every caller either trusts the
exit code blindly or re-derives the whole contract by hand — which is
exactly what RR's `build_workbench.ps1` does today, in PowerShell, all ~90
lines of it.

## Finding: most of RR's receipt re-verification is already redundant

Walking RR's compound verification block against the runner's actual
internal guarantees, with line citations:

| RR's check | Already guaranteed before a receipt returns? |
|---|---|
| `processOwnership`/`endpointVacancy`/preflight equivalents == `verified`, distinct preflight/build PID & `lifecycleGeneration`, `companionIdentity` fields | **Yes** — internal invariants; no code path returns a receipt with any other value. |
| `targetAddon.sourceSha256` matches the actual `.gproj` file on disk | **Yes** — `runner.ts:1399-1418` re-reads the target descriptor and throws `INVALID_TARGET` if `addonId`/`addonGuid`/`sourceSha256` drifted from what was captured at the start. A successful receipt's `sourceSha256` cannot be stale. |
| `output.previousResourceDatabaseSha256` is `null` | **Yes** — `runner.ts:516` requires the output directory to be a unique *empty* directory before launch. There is no path to a successful receipt with a non-null previous hash. |
| Log directories exist and are non-empty | Cheap to keep if wanted, but marginal — not worth documenting as required. |
| `targetAddon.addonId == 'RoadblockRunners'`, `addonGuid == '02412E2D8D82234A'` | **No.** The runner has no way to know what the caller *meant* to build beyond the path they passed — this is the one real gap, and it's simple enough to document as a caller-side recipe rather than a new flag (below). |

This is the content the new doc needs to state explicitly, with these same
citations, so a caller can delete the corresponding PowerShell checks with
confidence rather than guessing.

## What the new reference doc must cover

New file: `reforger-forge-mcp/docs/runner-cli.md` — a field-level companion
to `README.md`'s existing narrative section, linked from it.

1. **Invocation.** The two exact command forms already in `README.md`
   (`editor --gproj <path> --foreground`, `build --gproj <path> --platform PC
   --output <path> --timeout-ms <n>`), plus the configuration flags a caller
   actually needs (`--config`, `--workbench-addon-dir`, etc. — cross-link
   `setup.md` rather than duplicating it).
2. **Exit codes.** Document `receiptExitCode`'s actual behavior
   (`runner-cli.ts:29-37`) as a table: `0` success, build `validationFailure`
   → `1`, `timed_out` → `124`, `aborted` → `130`, otherwise the process exit
   code passed through. A caller needs nothing beyond "exit code `0` means
   the receipt is fully verified" for the majority case.
3. **Receipt field reference**, one table per intent (the editor receipt,
   the build receipt), listing every field, its type, and — critically — whether it is
   *guaranteed* given exit code `0` (link to the redundancy table above) or
   *informational only* (e.g. `output.freshArtifactCount`/`freshBytes`,
   which a caller may want to log but never needs to gate on).
4. **The one thing worth checking yourself: target identity.** A three-line
   recipe, not a flag:

   ```powershell
   $Receipt = (& node $RunnerCli build --gproj $ProjectFile --platform PC --output $BuildTarget --timeout-ms $TimeoutMilliseconds) | ConvertFrom-Json
   if ($LASTEXITCODE -ne 0) { throw "Build failed." }
   if ($Receipt.targetAddon.addonId -ne 'RoadblockRunners' -or $Receipt.targetAddon.addonGuid -ne '02412E2D8D82234A') {
       throw "Built the wrong project: $($Receipt.targetAddon.addonId) ($($Receipt.targetAddon.addonGuid))."
   }
   ```

   State plainly that this is the *only* receipt field worth an explicit
   caller-side check; everything else in the table above is already
   guaranteed and re-checking it is dead code, not defense in depth.
5. **What this doc does not cover:** diagnostic-line filtering and retained
   logs (separate concern — see
   [`2026-07-26-workbench-log-query.md`](2026-07-26-workbench-log-query.md)),
   and evidence quarantine (dropped, not replaced, per the separate decision
   to remove RR-specific build rules).

## Where to link it from

- `README.md:349-397` — add one line after the existing prose pointing to
  the new reference doc for the field table and the target-identity recipe.
- `agents/AGENTS.md` — wherever the packaged runner is already mentioned for
  project scripts/CI.
- `arma/addons/SETUP.md`'s "Launch And Build A Project" section — it already
  says to "prefer a bounded module wrapper"; add a pointer to this reference
  doc for anyone writing or reviewing such a wrapper.
- `arma/addons/RoadblockRunners/README.md`'s Build/Launch sections — link
  here instead of only describing `build_workbench.ps1`'s internal behavior,
  so the contract has one canonical source instead of being re-explained per
  addon.

## Non-goals

- No new CLI flags, no changes to `runner.ts`/`runner-cli.ts` behavior, no
  new tests beyond what already exists — this plan produces documentation
  only.
- Not itself simplifying `build_workbench.ps1`/`launch_workbench.ps1` — that
  follow-on cleanup (deleting the proven-redundant verification block, per
  the table above) happens in the `arma` repo once this doc exists to point
  at, and is tracked as a separate follow-up rather than part of this guide.

## Sequencing note

[`2026-07-26-remove-receipt-version-ceremony.md`](2026-07-26-remove-receipt-version-ceremony.md)
removes the receipt `version` field entirely (confirmed fork-original, no
pre-fork compatibility reason to keep it). Write `docs/runner-cli.md` to
describe "the editor receipt" and "the build receipt" with no version number
at all — not as a v2/v3 detail worth footnoting. If that cleanup hasn't
landed yet when this doc is written, describe the receipts the same way
regardless; the version field was never something a caller needed to reason
about even before removal (see the redundancy table above).

---

## Task breakdown

### Task 1: Write `docs/runner-cli.md`
Cover invocation, exit codes, the per-intent receipt field reference table,
the redundancy table with citations, and the target-identity recipe, per the
outline above.

### Task 2: Link it in
Add the cross-reference lines to `README.md` and `agents/AGENTS.md` in this
repo, and to `arma/addons/SETUP.md` and
`arma/addons/RoadblockRunners/README.md` in the outer repo.

## File change summary

| File | Change Type |
|---|---|
| `reforger-forge-mcp/docs/runner-cli.md` | **New file** |
| `reforger-forge-mcp/README.md` | Add one cross-reference line near the existing packaged-runner section |
| `reforger-forge-mcp/agents/AGENTS.md` | Add one cross-reference line near the existing packaged-runner mention |
| `arma/addons/SETUP.md` | Add one cross-reference line in "Launch And Build A Project" |
| `arma/addons/RoadblockRunners/README.md` | Link the new doc from the Build/Launch sections |

## Relationship to RR's scripts

Once this doc exists, `build_workbench.ps1`'s ~90-line verification block
can be deleted with a citation instead of a guess — replaced by the exit-code
check plus the three-line target-identity recipe above. `launch_workbench.ps1`
loses its companion-identity re-check the same way (same reasoning, editor
receipts). That cleanup is a small, mechanical follow-up once the reference
doc is in place; it isn't part of this plan.
