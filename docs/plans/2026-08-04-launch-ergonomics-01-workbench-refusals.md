# Commit 1 plan: make Workbench refusals safely actionable



> **Series overview:** [Step 0](2026-08-04-launch-ergonomics-00-series-overview.md).

> **Commit:** `feat(workbench): add contextual refusal remedies`
>
> **Series position:** 1 of 7 required baseline commits. Independent of the
> game-launch work and safe to ship alone.
>
> **Audit basis:** repository reviewed 2026-08-04. `WorkbenchErrorCode` has 27
> members, but the producer/message surface is larger; an exhaustive code table is
> therefore only a fallback behind producer context.

## Why this is its own commit

Workbench refusal presentation and observer public-error projection share a user
goal but no implementation boundary. Combining them would mix ordinary Workbench
tool text with the observer's security-sensitive 512-character redaction contract.
This commit owns only Workbench errors, including compile guidance.

## Goal

Preserve every existing Workbench diagnostic while appending one typed, safe next
action when the producer has enough evidence to provide it. Never infer recovery
from message substrings and never turn uncertain lifecycle/save state into an
automatic retry.

## Files

- new `src/workbench/refusal-remedy.ts`
- `src/workbench/session-controller.ts`
- `src/workbench/compile-diagnostics.ts`
- `src/tools/wb-launch.ts`
- `src/tools/wb-shutdown.ts`
- `src/tools/wb-restart.ts`
- `src/tools/wb-state.ts`
- `src/tools/wb-save-resource.ts`
- new `tests/workbench/refusal-remedy.test.ts`
- new `tests/workbench/wb-refusal-tool-boundaries.test.ts` for shutdown, restart,
  and state
- `tests/workbench/wb-launch-tool.test.ts`
- `tests/workbench/wb-save-resource-tool.test.ts`
- `tests/workbench/compile-diagnostics.test.ts`
- `tests/workbench/launch-compile-diagnostics.test.ts`
- `package.json` to add new/currently omitted files to the enduring stage-3 gate

Do not change `wb_check`, `wb_build`, or `wb_validate` structured result formats.

## Public types and formatting

Create a discriminated remedy model:

```ts
export type WorkbenchRemedy =
  | { readonly kind: "tool"; readonly tool: string; readonly input: object; readonly why: string }
  | { readonly kind: "retry"; readonly when: string; readonly why: string }
  | { readonly kind: "external"; readonly action: string; readonly why: string };

export interface WorkbenchRefusalContext {
  readonly operation: string;
  readonly gprojPath?: string;
  readonly resourcePath?: string;
  readonly originalInput?: Readonly<Record<string, unknown>>;
}

export function formatWorkbenchRefusal(
  error: unknown,
  context: WorkbenchRefusalContext,
): string;
```

Use an exhaustive
`satisfies Record<WorkbenchErrorCode, RemedyResolver | null>`. `null` is required
for overloaded codes with no globally safe answer. Add a discriminated producer
decision to `WorkbenchError`: `remedy`, `message_owns_recovery`, or
`no_safe_remedy`. The producer decision wins over the fallback table. Do not use
vague optional reason fields; the discriminant is what mechanically prevents a
second action from being appended to a message that already owns recovery.

Formatting must:

1. preserve every raw `WorkbenchError.message` byte-for-byte, while normalizing
   the tool-owned envelope at launch, shutdown, restart, and save-resource to
   `` `CODE` — message``. The current save-resource separator is mojibaked
   (`â€”`); fix that framing defect instead of treating it as a compatibility
   contract. Preserve wb_state's existing
   `Error getting Workbench state: <message>` wrapper rather than inventing a
   code envelope there, and preserve current generic-error treatment;
2. append at most one action;
3. serialize suggested inputs with `JSON.stringify`;
4. avoid duplicate advice through typed producer ownership, never prose matching;
5. preserve existing GUID, path, and `--workbench-addon-dir` text byte-for-byte.

## Producer-specific rules

- `PROJECT_COMPILE_FAILED`: pass `preflight.project.displayPath` to
  `formatWorkbenchCompileFailure` at the `startReserved` catch and name the exact
  `wb_check` call there. The outer table entry is `null`, preventing duplicate
  advice.
- Cold `TARGET_REQUIRED`: require an exact absolute `.gproj`. Do not suggest
  `wb_projects list`; that tool queries a live Workbench and cannot enumerate cold
  project files.
- `TARGET_SESSION_REQUIRED`: producer/context only. A mismatched save path, changed
  process/generation, and an already-live unproven target session require different
  actions.
- `TARGET_CONFLICT`: advise shutdown only when the producer proves replacement of
  the active exact target is required.
- `LIFECYCLE_BUSY`: producer/context only. `wb_diagnose` plus a later retry is valid
  for some active-operation cases, but not MCP shutdown, maintenance, or an exact
  Workbench already live during check/build. `wb_state` is editor state, not a
  lifecycle diagnostic.
- Dependency `INVALID_CONFIG`: keep the existing missing-root versus
  duplicate-provider instructions; they are not interchangeable.
- `UNOWNED_WORKBENCH`: producer/context only. Suggest saving and closing named
  Workbench windows only with exact identity evidence. An unknown process on the
  NET endpoint is not proven to be such a window.
- `OWNED_BY_OTHER_MCP`: direct the caller to the owning MCP; the current process
  cannot claim or stop it.
- `RECOVERY_REQUIRED`: producer/context only. Preserve specific shutdown, journal
  repair, or transient-race guidance.
- `TARGET_SESSION_TAINTED` and `SAVE_OUTCOME_UNCERTAIN`: preserve safe producer
  instructions and never recommend blind save retry.

Correct the stale `wb_launch` tool description while changing its boundary: there
is no cold configured-project enumeration fallback.

## Tests

Add exhaustive registry coverage and prove overloaded codes have `null` fallbacks
unless the producer supplies a typed producer decision/remedy. Exercise paths
containing quotes, newlines, and backslashes to prove suggested JSON is valid.

At each public tool boundary, assert:

- raw text survives;
- all four coded boundaries use a real U+2014 em dash and save-resource contains
  no mojibaked separator;
- no duplicate action appears;
- the original operation, not always `wb_launch`, is the retry target;
- generic/non-Workbench errors retain current treatment;
- uncertain saves are never converted into success or automatic retry.

The compile tests must assert that the exact canonical `.gproj` appears in the
serialized suggested `wb_check` input/call, and that the advice occurs only once.
No tool is actually invoked by the formatter.

## Validation

`tests/workbench/launch-compile-diagnostics.test.ts` is not in the current explicit
stage list, so run it directly.

```powershell
npx vitest run tests/workbench/refusal-remedy.test.ts tests/workbench/wb-refusal-tool-boundaries.test.ts tests/workbench/wb-launch-tool.test.ts tests/workbench/wb-save-resource-tool.test.ts tests/workbench/compile-diagnostics.test.ts tests/workbench/launch-compile-diagnostics.test.ts
npm run test:stage3
npm run typecheck
```

## Commit acceptance

- All 27 codes are handled exhaustively, including deliberate `null` entries.
- Producer context, not message prose, selects overloaded remedies.
- Compile failure names `wb_check` exactly once with the canonical project path.
- Existing raw diagnostics and structured build/check/validate contracts remain
  unchanged; only the malformed save-resource framing separator is normalized.
- No observer, game-launch, script, or Workbench-preview files change.
- No attended/live acceptance is required; this is bounded error presentation and
  does not alter staging, ownership, spawn, or lifecycle behavior.
