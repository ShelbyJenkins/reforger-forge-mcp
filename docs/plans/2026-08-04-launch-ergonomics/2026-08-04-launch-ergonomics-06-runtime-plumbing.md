# Commit 6 plan: share owned-runtime tool plumbing

> **Commit:** `refactor(observer): share owned runtime operations`
>
> **Series position:** 6 of 7 required baseline commits.
>
> **Dependency:** none for behavior, but land after
> [shared launch policy](2026-08-04-launch-ergonomics-05-runtime-launch-policy.md)
> so the composite can consume one stable observer surface.

## Why this is its own commit

The current observer_runtime tool owns its action parsing, idempotency-key
derivation, manager dispatch, success rendering, and public error adaptation in one
registrar. game_launch needs exactly the same status/stop semantics and the same
owned start operation. Copying that code would create two lifecycle contracts.
This commit is deliberately behavior-preserving and adds no tool.

## Goal

Expose a small internal owned-runtime operation API that both public tools can use,
while preserving observer_runtime's schema, text, defaults, abort handling,
idempotency keys, and error projection exactly.

## Files

- new src/tools/owned-runtime-operations.ts
- src/tools/observer-runtime.ts
- src/observer/owned-runtime-manager.ts
- tests/observer/observer-mcp-tools-registration-runtime.test.ts
- tests/observer/observer-mcp-tools-schema-responses.test.ts
- tests/observer/owned-runtime-executable-resolution.test.ts
- focused new tests for the shared operation executor if they do not fit the
  registration-runtime suite

## Shared operation boundary

Move the following out of the registrar:

- the exact rt-UUIDv4 schema;
- ObserverRuntimeLifecycleOperation and the versioned idempotency-key derivation;
- strict internal start, status, and stop operation types;
- manager dispatch, including the request abort signal for stop;
- operation-specific success headings for the observer_runtime presenter;
- a reusable OwnedRuntimeError extractor for public presenters.

The shared raw executor must return the existing manager result and let typed
errors throw. Do not catch/project inside the executor used by game_launch: its
dispatcher must distinguish planning errors from observer/runtime errors, and
cleanup must see the real manager outcome. A thin observer-runtime-only presenter
catches around that executor, applies the existing observer projector, and renders
the existing success heading. game_launch includes the raw safe result in its
larger response without reparsing Markdown.

Keep the MCP registration property schema unchanged. In particular,
waitForRestorationMs still defaults to 20 seconds at the observer_runtime boundary,
and irrelevant branch fields retain today's validation behavior. This refactor is
not the place to redesign that older flat schema.

The operation helper must be the single path for:

1. observer_runtime start;
2. observer_runtime status;
3. observer_runtime stop;
4. the corresponding owned operations used by Commit 7.

Do not generalize it to external scripts, process inventory, or Workbench.

## Executable resolution

Add a public read-only manager method:

    resolveRuntimeExecutablePath(kind)

It must invoke the manager's configured executableResolver seam and then apply the
same canonicalFile regular-file validation used immediately before spawn. The
resolver result is the allowlist authority; do not substitute a basename check.
The method returns a canonical absolute path and does not create directories or
prepare a launch. The working directory for later descriptors is always
dirname(the returned executable).

Import the existing resolver helpers back into the manager as needed; do not
export canonicalFile itself or make callers duplicate its checks. This method is
needed by Commit 7's implicit add-ons-root audit and later by the external
descriptor factory.

Only graphical client and listenServer are consumed by the composite. Preserve
the manager's existing dedicated/testRunner resolver behavior for
observer_runtime and its tests.

## Tests

Characterize observer_runtime before moving code and assert after the refactor:

- the exact registered input schema and description are unchanged;
- start/status/stop call the manager once with the same values;
- start and stop derive the same stable keys as before;
- stop forwards the MCP abort signal;
- the same success headings and JSON are returned;
- OwnedRuntimeError, unknown errors, and spoofed error-shaped objects project
  exactly as before;
- no owner token or private receipt field becomes public.

Test resolveRuntimeExecutablePath with the injected resolver, kind routing, missing
paths, directories, final-file links/reparse points, and canonical spelling.
Characterize the current behavior exactly: the injected/configured resolver is the
path authority and canonicalFile rejects a linked final file, but this refactor
must not add basename/installation allowlisting or stricter ancestor-link rules.
Property access and resolution must not create the managed/profile roots.

## Validation

Run the directly affected tests because the current stage-4 script omits some of
them:

    npx vitest run tests/observer/observer-mcp-tools-registration-runtime.test.ts tests/observer/observer-mcp-tools-schema-responses.test.ts tests/observer/owned-runtime-executable-resolution.test.ts
    npm run test:stage4
    npm run typecheck
    npm run lint:unused

## Commit acceptance

- observer_runtime is observably unchanged.
- One tested internal executor owns all three lifecycle operations.
- The manager exposes one read-only, canonical executable resolver.
- No game_launch registration, world planning, successor state, process inventory,
  Workbench preview, descriptor, or script is added.
