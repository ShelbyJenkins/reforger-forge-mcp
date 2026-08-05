# Commit 2 plan: add bounded observer refusal remedies

> **Commit:** `feat(observer): add operation-aware public remedies`
>
> **Series position:** 2 of 7 required baseline commits. Independent of Commit 1
> at the code level, but ordered second for review clarity.
>
> **Security boundary:** the complete public observer error remains at most 512
> characters, and fixed-policy codes must not read diagnostics, details, or remedy
> callbacks.

## Why this is its own commit

The observer projector is a redaction boundary, not a presentation helper.
Appending advice in `src/observer/tools.ts` or `src/tools/observer-runtime.ts` after
projection would bypass both the total-length cap and the fixed-message gate. This
commit keeps that security change isolated from Workbench errors and launch
features.

## Dependencies and next commit

No earlier implementation commit is required. The next baseline commit is
[registered project-world resolution](2026-08-04-launch-ergonomics-03-world-resolution.md).
See the [Step 0 series overview](2026-08-04-launch-ergonomics-00-series-overview.md)
for the full series map.

## Goal

Allow an observer tool/action to supply one typed recovery hint from trusted
operation context, with narrowly validated dynamic context only where required,
while preserving the central public projector's redaction, lazy-reader, and
total-length guarantees.

## Files

- `src/observer/public-contract.ts`
- new `src/observer/refusal-remedy.ts`
- `src/observer/tools.ts`
- `src/tools/observer-runtime.ts`
- `src/observer/owned-runtime-manager.ts`
- new `tests/observer/refusal-remedy.test.ts`
- `tests/observer/public-contract.test.ts`
- `tests/observer/observer-mcp-tools-registration-runtime.test.ts`
- `tests/observer/owned-runtime-manager-spawn-publication.test.ts`
- `tests/observer/observer-mcp-tools-schema-responses.test.ts` only if presentation
  is also exercised through that broader registered-handler harness
- `package.json` to add the focused/currently omitted files to stage 4

Do not add public tools or change registration order in this commit.

## Projector design

Extend `projectPublicObserverToolError` with an optional typed, operation-aware
remedy resolver. Use the existing `CaptureErrorCode`, never `string`.

Evaluation order is load-bearing:

1. extract and canonicalize a trusted domain error;
2. check the fixed-message registry;
3. for fixed codes, return immediately without invoking diagnostic, details, or
   remedy readers;
4. for non-fixed codes, resolve a remedy from canonical code plus explicit
   tool/action/reason context and, only when required, a lazy
   `readRemedyContext` callback;
5. reserve room for that remedy inside `PUBLIC_OBSERVER_ERROR_TEXT_MAXIMUM`;
6. truncate/redact diagnostic text and structured details into the remaining
   budget;
7. fall back to the fixed internal error on extraction/render failures.

The two private `toolError` helpers may pass context into this projector, but must
not concatenate anything onto its result or eagerly read error details. Invoke
`readRemedyContext` only after the fixed-message gate, validate every dynamic
field before rendering it, and include it inside the same 512-character budget.
Any resolver reason is a closed typed producer/input tag, never a value parsed
from error.message, diagnostics, details, or other prose. If operation/action plus
that typed tag is still insufficient to distinguish a broad code such as
`ARGUMENT_CONFLICT`, emit no remedy.

## Remedy policy

- Emit no remedy for `STORAGE_UNVERIFIABLE`, `INTERNAL_ERROR`, `UNAUTHORIZED`, or
  any other fixed-policy code.
- `ARGUMENT_CONFLICT` is reason/action-specific. It covers display flags, malformed
  managed arguments, command-line overflow, owner-token injection, NULs, and
  fingerprint conflicts; a global “remove window flags” answer is wrong.
- `RUNTIME_NOT_FOUND` is action-specific. Missing executable during start and
  missing receipt during status/stop do not share a remedy.
- `INSTANCE_NOT_FOUND`/`NO_RENDER_ENDPOINT` may suggest `observer_instances` only
  when the tool context owns a real `sessionId`; never invent a placeholder value.
- Emit no remedy for `PREPARED_LAUNCH_EXPIRED` or
  `PREPARED_LAUNCH_STALE` in this presentation-only commit. The manager checks
  those conditions before consumption/live-runtime evidence, so this layer cannot
  prove a safe next mutation.
- `PREPARED_LAUNCH_CONSUMED` must never advise preparing and starting again. The
  manager already has `consumed.runtimeId` at the refusal site; add it as bounded
  safe details, validate it against the exact rt-UUIDv4 syntax, and direct the
  caller only to `observer_runtime { action: "status", runtimeId }` (then stop if
  status proves that is appropriate). The consumed-conflict branch means the
  current key/fingerprint did not match; another start retry is not a safe remedy.

Keep advice declarative. This commit changes error output only; it does not
automatically run recovery tools or prepare/start a process.

## Tests

Extend the central projector tests to prove:

- the **entire** result, including remedy and JSON details, is <=512 characters;
- fixed-policy paths do not invoke diagnostic, details, or remedy readers;
- fixed-policy paths do not invoke the new dynamic remedy-context reader;
- diagnostic text is shortened to preserve a selected remedy without leaking
  unredacted data;
- unknown/spoofed/non-domain objects become fixed `INTERNAL_ERROR`;
- throwing extractors/resolvers/renderers fail closed;
- operation/reason context distinguishes broad codes;
- a missing session context suppresses a session-specific next call;
- a missing or malformed consumed runtime ID suppresses the dynamic status remedy.

Through the registered runtime handler, prove `PREPARED_LAUNCH_CONSUMED` exposes a
bounded valid runtime ID when available and never recommends a second prepare/start.

## Validation

The focused public-contract and registration-runtime tests are not in the current
explicit stage-4 list; invoke them directly.

```powershell
npx vitest run tests/observer/refusal-remedy.test.ts tests/observer/public-contract.test.ts tests/observer/observer-mcp-tools-registration-runtime.test.ts tests/observer/owned-runtime-manager-spawn-publication.test.ts
npm run test:stage4
npm run typecheck
```

## Commit acceptance

- No observer tool appends text after public projection.
- Fixed-message codes preserve lazy non-reading behavior.
- Every public error is <=512 characters.
- Broad codes receive advice only with sufficient typed context.
- Consumed preparation recovery cannot double-start a runtime.
- No Workbench, world-resolution, tool-registration, or script behavior changes.
- No attended/live acceptance is required; the manager edit adds bounded diagnostic
  context only and does not change launch behavior.
