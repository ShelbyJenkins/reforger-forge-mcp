# Adopt The Helper-Free Target Build As The Only Build Path

**Date:** 2026-07-26
**Goal:** Stop running the companion preflight before a build at all. The
"helper-free" build (what the removed V4 receipt would have described) is
already implemented, already runs today, and is already provably as safe as
the two-phase path — this is a direct switch, not a staged migration.
**Supersedes:** the open question in
[`2026-07-26-remove-receipt-version-ceremony.md`](2026-07-26-remove-receipt-version-ceremony.md)
("keep the preflight indefinitely, or implement helper-free later"). This
plan answers it: implement it now.

---

## Why this isn't a leap of faith — read the code, not the README's caution

`session-controller.ts`'s `runTargetBuildExclusive` (the method that actually
spawns a target build, `~line 1230`) unconditionally does its own complete
safety proof regardless of whether a preflight ran first:

```typescript
await execution.assertSpawnJournalReplaceable();
await execution.assertNoWorkbenchBeforeReservation("Workbench target-build reservation");
await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench target-build reservation");
if (!options.handoff) reservation.assertStillReservedAndSnapshot();
let lifecycle = options.handoff
  ? options.handoff.consume(endpoint, plan.lifecycleTarget)
  : await execution.reserve({ endpoint, target: plan.lifecycleTarget, companion: null });
// ...later, immediately before the actual spawn:
await execution.assertNoWorkbenchProcesses();
await execution.assertEndpointVacantBeforeSpawn(endpoint, "Workbench target-build spawn");
```

`options.handoff` is already optional. When absent, the function reserves its
own companion-free lifecycle slot directly (`companion: null`) and proceeds —
with the *exact same* vacancy/no-existing-process assertions it always runs.
This is not a hypothetical: it's the same method the acceptance harness
already calls to test the helper-free path (README: "the harness runs the
helper-free `target_build` controller path twice"). Grepping the codebase
confirms `WorkbenchSessionController.runTemporaryCompanionPreflight` (the
preflight's own controller method) has exactly one caller —
`runBuildCompanionPreflight` in `runner.ts` — so nothing else depends on it.

What the preflight uniquely contributes, that a helper-free build does *not*
already redo on its own:
- `companionIdentity` — proof the managed companion helper's build is exactly
  as expected. A helper-free build never loads the companion, so this proves
  nothing about the build that's actually running.
- The `handoff` token itself — purely a continuity optimization (reuse an
  already-open reservation instead of opening a fresh one in the same
  process). It is not a distinct safety guarantee; the fresh-reservation path
  runs the identical assertions.

Neither is something a target-only resource build functionally needs. The
preflight can be removed with no loss of the properties that actually matter
(process ownership, endpoint vacancy, fresh hashed output) — those are
already, unconditionally, redundantly proven by the build spawn itself.

## Task breakdown

### Task 1: Stop calling the preflight in the build flow

**File:** `src/workbench/runner.ts`, `runWorkbenchIntentWithExecution`'s build
branch (`~lines 1521-1575`).

Delete the `runBuildCompanionPreflight(...)` call. Call
`runTargetBuildStage` directly with no preflight/handoff — refactor
`TargetBuildStageArgs`/`runTargetBuildStageWithHandoff` to drop the
`preflight: BuildCompanionPreflightResult` field:
- `controller.runTargetBuild(launchPlan, reservation, { ...options })` —
  simply omit `handoff`; the reserve-from-scratch branch in
  `runTargetBuildExclusive` is exactly what should run.
- `runTargetBuildStage`'s error-path cleanup currently calls
  `args.controller.cancelTargetBuildHandoff(args.preflight.handoff, args.target)`.
  That only makes sense when a handoff exists. Without one,
  `runTargetBuildExclusive`'s own internal `execution.vacate(...)` (run when
  its post-claim reservation recheck fails) already covers cleanup — drop the
  handoff-cancellation call rather than replace it.

### Task 2: Delete the now-dead preflight machinery

Once nothing calls them:
- `runBuildCompanionPreflight`, `BuildCompanionPreflightArgs`,
  `BuildCompanionPreflightResult`, `WorkbenchBuildPreflightProof` (`runner.ts`).
- `WorkbenchSessionController.runTemporaryCompanionPreflight` /
  `runTemporaryCompanionPreflightExclusive` (`session-controller.ts`) —
  confirmed single-caller, fully dead once Task 1 lands.
- In `runTargetBuildExclusive` itself, once nothing ever supplies a
  `handoff` (Task 1 removes the only producer): the `options.handoff ? ... :
  ...` branch always takes the `else` arm, and `cancelTargetBuildHandoff`
  (`session-controller.ts:1191`) and the `consume()` method
  (`session-controller.ts:274`) become unreachable. Simplify
  `runTargetBuildExclusive` to always reserve fresh rather than leaving a
  permanently-false conditional in place — don't leave dead branches behind
  for the sake of a smaller diff.

### Task 3: Collapse receipt types, drop version entirely

Completes `2026-07-26-remove-receipt-version-ceremony.md`'s Task 1 (that
plan's open question is answered — implement helper-free, don't just decide
whether to).

- `WorkbenchEditorRunnerReceipt` (`version: 2`) → plain
  `WorkbenchEditorReceipt`, drop `version`. No behavior change — the editor
  path was never part of the preflight discussion.
- `WorkbenchBuildRunnerReceiptV3` / `WorkbenchBuildRunnerReceiptV4` → one
  plain `WorkbenchBuildReceipt`, drop `version`, drop `companionIdentity` and
  `preflight` fields entirely (this is what V4 already declared, minus the
  version literal — nothing new to design here).
- `receiptExitCode` (`runner-cli.ts`) already doesn't branch on `.version` —
  confirmed, no change needed.

### Task 4: Delete the acceptance-gate ceremony

- Delete `scripts/run-workbench-build-acceptance.ts` (1233 lines) and
  `tests/workbench/build-acceptance-contract.test.ts` (371 lines) — their
  purpose (proving it's safe to remove the preflight) is satisfied by the
  code-level argument above, not by collecting live-run evidence.
- Remove the `dev:workbench:acceptance:build` script from `package.json`.
- **`tests/workbench/hermetic-build-acceptance.test.ts` (559 lines) is the
  one exception to "delete the ceremony."** It already tests the helper-free
  path against the (formerly future) V4 shape — once that shape is simply
  *the* build shape, most of this file likely becomes the primary hermetic
  build-lifecycle test going forward. Rewrite it against the single
  collapsed `WorkbenchBuildReceipt`; expect to keep most of it, not delete it.
- Leave `scripts/observer-live-acceptance-support.ts` and
  `dev:workbench:acceptance:lifecycle` untouched — confirmed shared,
  unrelated infrastructure for the separate observer/screenshot acceptance
  system.

### Task 5: Rewrite `README.md:349-397`

Describe one build path: target-only, no companion, no preflight, no version
number, same fresh-hashed-output guarantee it already provides. Drop all
migration/gate language — there's nothing left to migrate toward.

### Task 6: Sweep remaining test assertions

Same files as the prior plan's Task 6 (`runner-build-lifecycle.test.ts`,
`runner-build-output-attestation.test.ts`, `runner-cli.test.ts`,
`runner-editor-lifecycle.test.ts`, `wb-build-tool.test.ts`,
`runner-addon-dependencies.test.ts`, `spawn-crash-characterization.test.ts`,
`fake-lifecycle-backend.ts`) — remove version-literal assertions, and update
any assertion that expects a `preflight`/`companionIdentity` field on a build
receipt, since those fields are gone entirely now, not just unversioned.

## File change summary

| File | Change Type |
|---|---|
| `src/workbench/runner.ts` | Remove preflight call + dead preflight functions/types; collapse to one editor receipt, one build receipt, no `version` field |
| `src/workbench/session-controller.ts` | Remove `runTemporaryCompanionPreflight(Exclusive)`, `cancelTargetBuildHandoff`, the handoff `consume()` path; simplify `runTargetBuildExclusive` to always reserve fresh |
| `scripts/run-workbench-build-acceptance.ts` | **Delete** |
| `tests/workbench/build-acceptance-contract.test.ts` | **Delete** |
| `tests/workbench/hermetic-build-acceptance.test.ts` | Rewrite against the collapsed receipt shape — keep most of it |
| `package.json` | Remove `dev:workbench:acceptance:build` |
| `README.md` | Rewrite lines 349-397: one build path, no version/gate language |
| `tests/workbench/runner-build-lifecycle.test.ts` | Remove version-literal + preflight-field assertions |
| `tests/workbench/runner-build-output-attestation.test.ts` | Remove version-literal + preflight-field assertions |
| `tests/workbench/runner-cli.test.ts` | Remove version-literal assertions |
| `tests/workbench/runner-editor-lifecycle.test.ts` | Remove version-literal assertions |
| `tests/workbench/wb-build-tool.test.ts` | Remove version-literal + preflight-field assertions |
| `tests/workbench/runner-addon-dependencies.test.ts` | Remove version-literal assertions |
| `tests/workbench/spawn-crash-characterization.test.ts` | Remove version-literal assertions |
| `tests/workbench/fake-lifecycle-backend.ts` | Remove version-literal assertions |
| `scripts/observer-live-acceptance-support.ts` | **No change** — unrelated shared infra |

## Relationship to the other two plans

- Supersedes `2026-07-26-remove-receipt-version-ceremony.md`'s Section 2 open
  question — this plan implements helper-free directly rather than leaving
  it as a future decision.
- `2026-07-26-runner-cli-usage-docs.md` should describe the resulting single
  build receipt with no `preflight`/`companionIdentity` fields at all, not
  merely "no version number."
