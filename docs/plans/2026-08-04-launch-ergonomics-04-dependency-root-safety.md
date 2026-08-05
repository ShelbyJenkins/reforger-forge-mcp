# Commit 4 plan: harden game dependency and add-on-root planning

> **Commit:** `fix(launch): make game addon resolution fail closed`
>
> **Series position:** 4 of 7 required baseline commits.
>
> **Dependency:** [Commit 3 world resolution](2026-08-04-launch-ergonomics-03-world-resolution.md).

## Why this is its own commit

The existing Workbench audit silently ignores malformed dependency strings, reads
manifests and root children without the limits needed for a public composite, sorts
roots, and intentionally skips target-GUID uniqueness. Those behaviors are
reasonable to review separately from world discovery and runtime argv generation.

## Goal

Produce a bounded, deterministic add-on resolution for one exact project. Prove
all declared dependencies are uniquely reachable and prove `-addons <targetGuid>`
cannot select another provider of the target GUID.

## Research context

[Bohemia's Resource Manager options documentation](https://community.bistudio.com/wiki/Arma_Reforger:Resource_Manager:_Options)
describes dependency search roots as required startup context. The composite
therefore treats missing or ambiguous declared dependencies as a hard refusal,
even though this is intentionally stricter than some hand-run game invocations.

## Files

- `src/workbench/addon-dependencies.ts`
- new `src/launch/game-addon-plan.ts`
- `src/launch/game-launch-errors.ts`
- `tests/workbench/addon-dependencies.test.ts`
- new `tests/launch/game-addon-plan.test.ts`
- dependency `.gproj` fixtures, including malformed/oversize/duplicate cases

## Harden the shared audit boundary

Factor bounded manifest/root readers that can be used by a stricter game-specific
audit. Keep `auditWorkbenchAddonDependencies` and all existing Workbench
lifecycle/runner callers on their current compatibility semantics; do not make an
unrelated malformed project in a root a new `wb_launch` failure as a side effect.
The game scanner may use an explicit strict mode or a separate
`auditGameAddonDependencies` entry point. Required game behavior:

- malformed declared dependency values are findings, not silently dropped;
- `.gproj` reads have a byte cap and typed unreadable/malformed errors;
- root enumeration has visited-entry and candidate caps;
- traversal never follows links/reparse escapes;
- truncation or concurrent replacement fails closed;
- caller/configured precedence is retained explicitly instead of inherited from
  `canonicalAddonRoots` sorting;
- unrelated duplicate GUIDs remain irrelevant unless they can affect the target or
  traversed graph.

Define a typed bounded game finding union rather than overloading current
Workbench missing/ambiguous fields. It must distinguish malformed declared GUID,
manifest unreadable/malformed/oversize, root unreadable, scan
truncated/unstable, dependency missing/ambiguous, and target-provider collision,
with only bounded safe GUID/path/cap context passed to GameLaunchPlanError.

Preserve existing Workbench error wording/semantics unless a test-backed correction
is intentional. Game-specific failures should be adapted to `GameLaunchPlanError`,
not leaked as Workbench-branded messages.

## Prove the exact target provider

The current dependency traversal seeds `visited` with the target GUID, so it never
checks another provider of that GUID. Add a bounded provider check across every
effective explicit and implicit root:

- exactly one provider must resolve to the canonical target `.gproj`;
- any other `.gproj` with the target GUID is a hard refusal;
- root ordering is not an acceptable substitute for uniqueness.

This check is required because the game uses `-addons <targetGuid>`, unlike
Workbench's explicit `-gproj <path>`.

## Root classes

Represent roots with provenance instead of a bare array:

1. configured add-on roots, preserving configuration order;
2. `dirname(project.modDirectory)` so sibling dependencies resolve;
3. implicit `join(dirname(executablePath), "addons")`;
4. implicit `<derived launch profile>/profile/addons`;
5. uniquely resolved dependency containers.

Configured standard Workshop roots (the repository discovers the conventional
`ArmaReforger/addons`) remain explicit configured roots. Existing implicit roots
participate in the audit but are not redundantly emitted in `-addonsDir`.

Implicit roots are prospective engine locations. A missing implicit installation
addons directory or derived `profile/addons` directory is an empty root, not an
audit failure; the latter normally does not exist until observer preparation
creates the profile. If an implicit path exists but is a link/reparse point,
unreadable, a non-directory, or changes during inspection, fail closed. Missing
explicit configured roots retain the configured-root error policy.

Build the emitted list once from configured roots, the target parent, and uniquely
resolved non-implicit dependency containers. Deduplicate canonically while keeping
documented precedence.

Reject commas, NULs, and control characters in every emitted root because
`-addonsDir` is comma-delimited. Accept private managed/profile roots as inputs to
the planner and reject overlap between them and:

- the project/mod directory;
- the target parent;
- every configured or resolved explicit/emitted root.

The derived profile's own implicit `profile/addons` directory is the narrow
intentional exception and must never be emitted.

Return an immutable dependency/root evidence snapshot containing ordered root
provenance, bounded canonical manifest identities/digests, the resolved GUID
graph, target-provider proof, scan-completeness evidence, schema version, and
`addonEvidenceDigest`. Compute that digest from a fixed-field canonical
serialization of every proof-bearing field and freeze a digest fixture; roots and
argv remaining equal must not hide a changed manifest or provider proof. Export
`revalidateGameAddonPlan(snapshot)` to validate the stored snapshot/digest, repeat
the bounded proof, recompute the digest, and reject any change. Commit 7 persists
the original snapshot and invokes it inside the manager's final pre-consumption
callback.

## Dependency policy

Missing, ambiguous, malformed, truncated, or unstable direct/transitive dependency
evidence is a hard refusal for **owned start**. Bohemia documents that unavailable
dependency roots can fail launch or fall back to vanilla without the intended mod.

Pass only the target project GUID to `-addons`; do not flatten dependency GUIDs.
Declared dependencies load from proven reachable roots. Report `addonGuids`, not
`addonIds`.

This is intentionally stricter than some hand-run command lines. Do not add an
unsafe escape to the owned baseline. Commit 12 deliberately keeps the same hard
refusal for external scripts; any warning-based escape would require a separate
future policy review.

## Tests

Cover:

- missing, ambiguous, malformed, and transitive dependency findings;
- oversize manifests, entry/candidate limits, and concurrent change;
- configured order and canonical deduplication;
- target parent and both implicit root classes;
- missing prospective implicit roots as empty, plus existing invalid implicit
  roots as refusals;
- target-GUID collision with the requested path and in another root;
- unrelated duplicate GUID non-failure;
- explicit versus implicit emission;
- comma/control/NUL paths;
- project, target-parent, configured-root, and dependency-root overlap with private
  managed/profile roots;
- only the target GUID selected for `-addons`;
- a stable evidence-digest fixture plus manifest/provider identity or byte changes
  changing the digest even when emitted roots, GUIDs, and argv stay equal;
- existing Workbench audit/runner behavior remains characterized and unchanged.

## Validation

```powershell
npx vitest run tests/workbench/addon-dependencies.test.ts tests/launch/game-addon-plan.test.ts
npm run test:stage3
npm run typecheck
npm run lint:unused
```

## Commit acceptance

- The exact target GUID resolves only to the requested `.gproj`.
- Every traversed declared dependency is valid and uniquely reachable.
- All scans/reads are bounded and fail closed on incomplete evidence.
- Explicit and implicit roots are distinguished and ordered deterministically.
- A frozen snapshot has a stable complete digest and supports point-of-use
  revalidation.
- No runtime argv, application-root exposure, public tool, or process launch is
  added.
