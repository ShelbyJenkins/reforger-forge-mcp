# Task 7 — Ownership-boundary enforcement

**Status:** Planned follow-on work
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 7
**Prerequisites:** Tasks 1, 2, 3, 4, and 6 establish the replacement owners
before duplicate implementations are deleted.

## Intended outcome

A narrow architecture check prevents new duplicate owners for redaction,
ordinary time/polling, observer add-on inventories, test temporary roots, and
managed filesystem comparisons. It documents small, expiring exceptions rather
than permitting a broad baseline allowlist.

## Planned work

1. Add AST-based checks for the named ownership rules and scope each rule to
   its actual invariant.
2. Audit and migrate remaining legitimate stragglers to the designated
   foundation or support owner.
3. Store each exception with its reason, owning test, and removal condition;
   fail if the exception no longer matches a prohibited use.
4. Add the focused check to the normal static/CI tier, then delete superseded
   helpers only after behavioral and package coverage has moved.

## Completion signals

- The ownership check is green without a broad baseline exception.
- Remaining exceptions are current, narrow, and reviewed.
- Deleted helper names have one clear replacement owner.
- The full suite remains green after the migration and cleanup.


## Detailed task plan

**Goal:** Finish the migration without allowing future movement work to
recreate the old owners.

**Actions:**

1. Add a repository architecture check, preferably using the TypeScript AST,
   with a small rule set:
   - local production function declarations named sleep outside
     src/foundation/time.ts;
   - new production redact-prefixed implementations outside
     src/foundation/redact.ts;
   - copied observer add-on filename arrays outside the manifest tooling;
   - raw test mkdtemp calls outside tests/support/ and an explicit exception
     table;
   - new filesystem path-comparison helpers that case-fold a path instead of
     using the managed-path owner.
2. Scope the path rule to filesystem comparison. Do not flag ordinary
   case-folding for identifiers, display text, JSON keys, or virtual paths.
3. Store exceptions beside the checker with a reason, owning test, and
   expiration/review condition. The checker must fail if an exception no
   longer matches a real prohibited use. Do not add a broad baseline-violation
   allowance; migrate known ordinary uses before enabling the rule.
4. Put the check in a focused architecture test, such as
   tests/architecture/foundation-ownership.test.ts, and use the TypeScript AST
   in the same narrow style as the existing Stage 3 architecture test. Document
   each rule and its exceptions beside it; do not parse source with broad
   regular expressions.
5. Audit existing filesystem comparison helpers before enabling the path rule.
   Migrate actual case-folding stragglers to managed-path, but retain a wrapper
   that already delegates to the foundation rather than creating churn for its
   own sake.
6. Add the check to the normal static/CI tier before the full test suite.
7. Remove superseded helpers only after their call sites, contract tests, and
   package checks have migrated. Do not leave a dead forwarding layer merely
   to preserve an internal name.

**Deletion order:**

1. Local redaction helpers and inline owner-token substitutions.
2. Local ordinary sleep/poll helpers after their domain tests use time.ts.
3. Duplicated toolError renderers.
4. Copied add-on filename arrays.
5. Observer-local test helper after support adoption.
6. Architecture-check temporary exceptions as their special tests are adapted
   or retired.

**Acceptance:** The architecture check is green with no broad allowlist, the
full suite is green, and each deleted owner has one clearly named replacement.
