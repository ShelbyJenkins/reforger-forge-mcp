# Remove Build/Editor Receipt Versioning Ceremony

**Date:** 2026-07-26
**Status:** Superseded by
[`2026-07-26-adopt-helper-free-build.md`](2026-07-26-adopt-helper-free-build.md),
which carries out this entire removal as part of switching to the
already-implemented helper-free build path. Follow that plan's task list, not
this one — the two fully overlapped and duplicating both risked drifting out
of sync. This document is kept only for the provenance evidence and the
process-guard.ts carve-out below, both of which the newer plan assumes rather
than restates.

---

## Why this needed to go: confirmed fork-original, not upstream

`src/workbench/runner.ts` — the entire build/editor receipt system, versions
and all — did not exist at the fork point:

```text
$ git show 5e52376:src/workbench/runner.ts
fatal: path 'src/workbench/runner.ts' exists on disk, but not in '5e52376'
```

`docs/plans/2026-07-22-fork-development-summary.md` explicitly lists
"structured receipts" and "a guarded Workbench runner and target-build path"
under this fork's own 29 commits. There is no pre-fork version of this
contract, and no independent consumer relying on it across releases — a
staged API-version migration gated behind formal acceptance evidence was
solving a compatibility problem this single-maintainer, single-consumer
project doesn't have.

## Explicit non-goal: do not touch the lifecycle-state schema version

`src/workbench/process-guard.ts` also declares `version: 3`
(`WorkbenchLifecycleStateV3`), and `wb_diagnose` reports it as
`Record: valid (schema v3)`. **This is a different concept and stays.** It
tags the durable, on-disk lifecycle state that survives process restarts —
its job is to reject state written by an incompatible older build of this
same tool before touching it with a newer one. That's a real local safety
concern regardless of how many consumers exist; it has nothing to do with
API-compatibility versioning for independent clients. Do not conflate the two
while doing this cleanup.

## Where the actual task list lives now

See [`2026-07-26-adopt-helper-free-build.md`](2026-07-26-adopt-helper-free-build.md)
for the full, current task breakdown: collapsing the receipt types, deleting
the acceptance-gate harness, rewriting the README, and sweeping the remaining
version-literal test assertions — all folded into that plan's implementation
of the helper-free build switch.
