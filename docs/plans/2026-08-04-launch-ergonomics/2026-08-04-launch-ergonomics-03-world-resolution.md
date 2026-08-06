# Commit 3 plan: resolve registered project worlds safely

> **Commit:** `feat(launch): add bounded project-world resolution`
>
> **Series position:** 3 of 7 required baseline commits.
>
> **Dependency:** none on the refusal commits at runtime; ordered after them so the
> later public composite can use their final error conventions.

## Why this is its own commit

Resource metadata parsing, project-contained world identity, and bounded discovery
form one read-only foundation. Dependency-provider policy is deliberately deferred
to Commit 4 because it changes shared `.gproj` audit behavior and needs an
independent rollback surface.

## Goal

Given a canonical project and optional world input, return one exact registered
`.ent` resource or a bounded typed refusal. Never guess a GUID, never follow an
escape, and never auto-select from a partial scan.

## Research context

[Bohemia's Workbench metadata documentation](https://community.bistudio.com/wiki/Arma_Reforger:Workbench_Metadata)
states that the stored path is informational and the GUID survives a
Workbench-managed move. That is why the sidecar's anchored resource GUID is
authoritative while its recorded path is not used as a rename veto.

## Files

- new `src/workbench/resource-meta.ts`
- `src/tools/wb-entity-duplicate.ts`
- new `src/launch/game-world-plan.ts`
- new `src/launch/game-launch-errors.ts`
- `tests/workbench/resource-meta.test.ts`
- new `tests/tools/wb-entity-duplicate.test.ts`
- new `tests/launch/game-world-plan.test.ts`
- new `tests/launch/game-launch-errors.test.ts`
- fixture `.ent`/`.meta` files captured from or shaped exactly like Workbench output

## Metadata parser

Move/generalize the private `readMetaGuid` logic from
`src/tools/wb-entity-duplicate.ts:273-281` into a low-level module. The strict API:

- reads at most a fixed byte limit;
- parses only the resource `Name "{16-hex-GUID}..."` field;
- uppercases the GUID;
- distinguishes missing, unreadable, oversize, and malformed metadata;
- never falls back to the first GUID-looking token.

Metadata's stored path is informational. A Workbench-managed rename preserves the
GUID, so do not reject solely because that path differs from the current file.

Preserve `wb_entity_duplicate` behavior through a tolerant adapter that catches the
new typed failures and returns `null`. The existing tool may still return an
unformed destination path when metadata is unavailable; this commit must not turn
that into a new tool failure.

## Canonical world input

Accept:

- an absolute `.ent` path;
- a project-relative `Worlds/X.ent` path;
- a formed `{GUID}Worlds/X.ent` resource reference.

Require the `.ent` and sibling `.meta` to be regular files contained by the
canonical project mod directory. Reject symlinks/reparse escapes and revalidate
canonical identity after reads. For formed input, the supplied GUID must equal the
sidecar GUID.

Build the output reference from the sidecar GUID plus the **current**
project-relative path. Normalize Windows `\` separators to `/` before forming the
resource string.

Return an immutable evidence snapshot with the canonical project identity,
canonical world/meta paths, bounded file identities/digests, parsed GUID, current
relative path, formed resource reference, schema version, and
`worldEvidenceDigest`. Compute that digest from a fixed-field canonical
serialization covering every selection and revalidation field, not only the
formed reference. Freeze a digest fixture so a content/identity change cannot
retain the same launch identity merely because GUID/path output stayed equal.

Export a `revalidateGameWorldPlan(snapshot)` operation that first validates the
stored snapshot/digest, repeats the same bounded reads, recomputes the digest, and
refuses if any identity or derived value changed. Commit 7 will persist and use
the original snapshot at the manager's pre-consumption launch boundary rather
than reimplementing world checks or substituting a snapshot rebuilt by a retry.

This baseline intentionally accepts only project-contained worlds. It does not
accept dependency/base-game worlds and does not interpret a `Missions/*.conf` as a
CLI target.

## Bounded discovery

When `world` is absent, scan `<modDirectory>/Worlds` with explicit limits for:

- recursion depth;
- visited directory entries, not only results;
- candidate count;
- metadata bytes;
- total diagnostic candidates.

Sort deterministically, do not follow links/reparse points, and fail closed when a
directory changes during the scan or any cap truncates the result.

Selection rules:

- exactly one total `.ent`, registered: select it;
- exactly one total `.ent`, unregistered: `WORLD_UNREGISTERED` with its absolute
  path and the exact registration workflow;
- zero: `WORLD_REQUIRED`/`WORLD_NOT_FOUND`;
- more than one: `WORLD_AMBIGUOUS`, listing a bounded set with registration status;
- truncated/unstable scan: a distinct refusal, never auto-selection.

Registration guidance is: open the exact project if needed, then call
`wb_resources { action: "register", path: <absolute .ent> }`. `wb_launch` alone does
not register an arbitrary unregistered file.

## Game planning error boundary

Define a trusted `GameLaunchPlanError` code union for project/world planning and a
`projectPublicGameLaunchPlanError` that produces at most 512 characters. Apply the
same bounded string/depth/breadth/node and redaction discipline as observer errors.

The eventual tool dispatcher will use trusted `instanceof`:

- game planning errors -> game projector;
- observer/runtime errors -> observer projector;
- unknown/spoofed values -> fixed `INTERNAL_ERROR`.

Do not register a tool in this commit. Test the projector directly so safe
candidates/remedies are retained without accepting a caller-supplied public code.

## Pre-existing scenario generator defect

Do not fix `scenario_create_conflict` here. It currently writes an unregistered
`Worlds/<name>.ent` while the MissionHeader `World` points to the selected base
world. Track that as a separate generator issue. This resolver should correctly
report its generated child world as unregistered until Workbench creates metadata.

## Tests

Cover:

- absolute, relative, and formed inputs;
- GUID match/mismatch and uppercase normalization;
- malformed/oversize metadata and an unrelated GUID elsewhere in the file;
- rename-stable metadata and `/` resource separators;
- file/directory/link/reparse containment failures;
- zero, one registered, one unregistered, and many candidates;
- registered plus unregistered ambiguity;
- every discovery cap and concurrent replacement;
- a stable evidence-digest fixture plus changed `.gproj`, `.ent`, or `.meta`
  identity/bytes changing the digest even when the final resource reference is
  unchanged;
- tolerant duplicate-tool behavior;
- <=512 game error output, bounded candidates, redaction, and spoofed errors.

## Validation

```powershell
npx vitest run tests/workbench/resource-meta.test.ts tests/tools/wb-entity-duplicate.test.ts tests/launch/game-world-plan.test.ts tests/launch/game-launch-errors.test.ts
npm run typecheck
npm run lint:unused
```

## Commit acceptance

- One exact registered project-contained `.ent` can be resolved without Workbench.
- Partial scans and unregistered/ambiguous worlds never auto-select.
- Metadata identity is strict without regressing `wb_entity_duplicate`.
- The returned snapshot has a stable complete digest and can be revalidated
  without changing selection semantics.
- Public planning failures are typed, bounded, and spoof-resistant.
- No dependency audit, argv policy, observer application, public tool, or scenario
  generator behavior changes.
