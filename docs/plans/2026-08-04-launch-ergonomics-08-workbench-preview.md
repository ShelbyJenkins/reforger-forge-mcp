# Commit 8 plan: add a non-runnable Workbench launch preview

> **Commit:** `feat(workbench): add non-runnable launch preview`
>
> **Series position:** optional, independent after the required baseline.
>
> **Dependency:** none on game_launch. It reuses the existing Workbench launch-plan
> builder and current staged companion evidence.

## Why this is its own commit

A Workbench preview is diagnostic presentation, not process activation. It has
different ownership, availability, and security properties from a runnable game
script. Keeping it separate lets it ship or be dropped without changing the game
launch series.

## Goal

Optionally include the exact non-secret Workbench editor launch shape in
wb_diagnose for a requested project, without staging files, creating roots,
minting an owner token, or producing anything that a script renderer can execute.

## Files

- src/workbench/helper-addon.ts
- src/workbench/launch-plan.ts
- src/workbench/session-controller.ts
- src/tools/wb-diagnose.ts
- tests/workbench/helper-addon.test.ts
- tests/workbench/workbench-launch-plan.test.ts
- tests/workbench/workbench-session-controller.test.ts
- tests/workbench/wb-diagnose-tool.test.ts
- package.json if the focused tests are not already in stage 3

## Trusted staged-companion evidence

WorkbenchCompanionProvider.status() reports managed roots and digests, but it does
not return a trusted WorkbenchCompanionLaunch suitable for the launch-plan builder.
Add a read-only operation that returns the current staged companion only after
re-attesting its manifest, files, digest, target binding, containment, and
no-link/reparse properties.

The read-only operation must:

- never call ensureStaged;
- never create, repair, retain, or delete anything;
- return unavailable when no current digest is already staged and valid;
- distinguish unavailable from invalid/tampered evidence;
- preserve the provider's existing bounded file checks.

Do not weaken ensureStaged or synthesize a companion value from status output.

## Controller-owned preview

Add a controller-level method so private config, lifecycle endpoint, managed root,
and companion-provider access stay encapsulated. It accepts an exact project path,
canonicalizes/revalidates the project, obtains the read-only staged attestation,
and calls the existing editor launch-plan builder.

The builder may receive an internal structurally valid owner-slot placeholder to
exercise the real argv validation. Before the value crosses the controller
boundary:

- replace the placeholder in argv with the literal presentation marker
  <MCP-generated-owner-token>;
- omit the builder's separate top-level ownerArgument field entirely so the marker
  appears exactly once in the public preview;
- set kind=workbench_editor, ownership=preview_only, and runnable=false;
- omit any private token, lease, claim, or callable spawn closure;
- mark a displayed command as presentation-only.

Define WorkbenchLaunchPreview as a separate discriminated type. The external game
descriptor renderer/writer in Commit 10 must accept only its own
ExternalGameLaunchDescriptor type and runtime schema, so a preview can never flow
into it even if a caller forges TypeScript values.

If the staged helper is unavailable, return a bounded diagnostic message such as
preview unavailable until wb_launch stages the exact helper. Do not stage merely
to improve diagnosis.

## wb_diagnose composition

Extend the input from the current empty schema with optional:

    gprojPath: bounded nonblank string
    includeLaunchPlan: boolean

Keep the default report unchanged when includeLaunchPlan is false or omitted.
When includeLaunchPlan is true, require gprojPath in a strict selected branch,
require that its caller spelling is absolute before canonicalization, and append a
Workbench Launch Preview subsection containing either the preview object or its
bounded unavailable/error status. Reject gprojPath when the preview flag is not
true rather than silently ignoring it.

Catch preview failures locally. Configuration, NET API, companion, lifecycle, and
compiler-failure diagnosis must still be returned even when preview construction
fails. Keep registerWbDiagnose dependencies narrow; if a controller method is
available through WorkbenchClient, do not pass raw config/provider objects into
the tool. src/workbench/client.ts already wildcard-re-exports the controller and
src/server.ts already supplies that client, so neither should require an edit.

## Tests

Prove:

- default wb_diagnose schema/response behavior remains compatible;
- exact staged companion evidence produces the expected launch argv;
- unstaged, stale, changed, linked, or malformed companion state is unavailable;
- preview construction performs zero writes, staging, retention, token generation,
  or new process operations; the surrounding existing wb_diagnose call may still
  read its normal lifecycle, NET, and process evidence;
- the placeholder appears once and no real owner token appears;
- runnable is always false and the preview has a distinct workbench_editor /
  preview_only discriminant;
- project/config/endpoint changes are re-attested;
- preview errors do not fail the rest of wb_diagnose;
- path quotes, spaces, backslashes, and Unicode remain presentation-safe.

## Validation

    npx vitest run tests/workbench/helper-addon.test.ts tests/workbench/workbench-launch-plan.test.ts tests/workbench/workbench-session-controller.test.ts tests/workbench/wb-diagnose-tool.test.ts
    npm run test:stage3
    npm run typecheck
    npm run lint:unused

## Commit acceptance

- The preview is exact enough to diagnose but structurally non-runnable.
- Requesting it has no filesystem or lifecycle side effects.
- Only an already staged and freshly re-attested companion can be previewed.
- wb_diagnose remains useful when preview is unavailable.
- No game tool, external descriptor/script, or owned-runtime behavior changes.
