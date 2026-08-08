# MCP-056 plan: bounded owned-runtime history recovery

> **Issue:** MCP-056
>
> **Scope:** classify retained lifecycle history without mutation, then expose a
> separate explicit recovery actor for exact process-vacant records.

## Goal

Make the default Observer root diagnosable and recoverable without deleting its
LMDB store, treating record age as authority, or weakening exact-process,
session, profile, and camera-restoration fencing.

## Read-only history classification

Add a bounded `observer_runtime history` action. It inventories the existing
owned-runtime LMDB namespace without creating storage or opening a writer and
classifies each valid runtime lifecycle as:

- `completed`: exact stop and observer completion are both durable;
- `child_exit_only`: an exact child-exit receipt is durable but semantic stop
  evidence is absent;
- `cleanup_pending`: exact stop evidence exists but observer completion is
  absent;
- `active_or_unresolved`: no process-vacancy receipt authorizes reconciliation;
- `indeterminate`: the record or one of its lifecycle links is malformed or
  cross-bound.

The result reports bounded counts, candidate runtime IDs, and bounded issue
samples. It never uses age to change a disposition. Inventory remains capped by
the configured record and byte budgets and by a caller-selected candidate and
wall-clock budget.

Repeated idle-readiness probes retain an already-existing read-only LMDB handle
so a silent host does not repeatedly pay environment-open cost. The handle is
closed with the manager and never creates or enables writes.

## Explicit recovery

Add a separate `observer_runtime recover` action. It considers only
`child_exit_only` and `cleanup_pending` candidates. Before acting it requires:

- valid, fully linked lifecycle records;
- the same installation and Windows user authority;
- absence of the prior exact MCP owner when the manager instance changed;
- absence of the exact runtime identity (PID, executable, creation time, and
  owner argument) for child-exit-only history.

Recovery reuses the ordinary idempotent `OwnedRuntimeManager.stop` transaction.
That transaction recreates/reclaims exact lifecycle authority as needed,
publishes semantic stop/restoration evidence, completes or revokes the Observer
session, and writes stop completion. Recovery has no deletion path and never
calls process termination: any candidate that is still live, mismatched, or
unverifiable is returned as blocked.

The batch has a stable deterministic idempotency key per runtime, a bounded
candidate count, one aggregate deadline, bounded error text, and a fresh
post-recovery inventory.

## Shutdown convergence

Filter historical foreign-manager receipts during the shutdown inventory while
holding one lifecycle mutex, instead of reacquiring that mutex once per retained
runtime merely to discover it is foreign. Malformed receipts still fail closed.
The final shutdown CAS evaluates only current-manager obligations.

Idle readiness stays read-only. It may report `OWNED_RUNTIME_RECOVERY` for the
current manager or a prior manager whose installation and Windows user match
the current host's recovery authority. History owned by another installation or
Windows user remains visible and is returned as blocked by explicit recovery,
but it is not an idle obligation that can keep an unrelated host alive forever.
The explicit history result gives the stable retained disposition needed to
distinguish those cases.

## Tests

Prove:

- retained existing-only LMDB reads observe later commits and create no missing
  root;
- history classification is read-only, bounded, deterministic, and rejects
  malformed/cross-bound evidence;
- child-exit-only history is recovered through semantic stop completion;
- exact-live, prior-owner-live, installation/user-mismatched, and process
  inspection failure cases never terminate or mutate the runtime lifecycle;
- cleanup-pending recovery is idempotent;
- high-cardinality foreign history no longer consumes one shutdown mutex lease
  per runtime;
- `observer_runtime` exposes strict `history` and `recover` branches without
  exposing owner tokens, PIDs beyond existing public runtime status, or a raw
  deletion/termination primitive.

## Live acceptance

1. Build and start the production MCP composition against the established
   default Observer root.
2. Run bounded history inspection and explicit recovery batches until no valid
   recoverable candidate remains, preserving blocked evidence.
3. Re-run read-only readiness and a silent 60-second idle host.
4. Prove the controlled host and its disposable private Observer child exit,
   and verify no owned runtime was terminated and no lifecycle store was
   deleted.

## Implementation result

Implemented on 2026-08-05. `observer_runtime` now exposes strict `history` and
`recover` branches. History retains one existing-only read handle, renews its
read transaction so later commits remain visible, and returns bounded lifecycle
counts, candidate IDs, and issue samples without creating or mutating storage.
Recovery is a separate bounded writer path that first releases the retained
reader, reopens the existing environment for mutation, and delegates every
eligible candidate to the ordinary idempotent stop transaction. Authority,
exact-process, prior-owner, installation/user, session, profile, and restoration
fences remain fail closed.

Shutdown inventory now filters well-formed foreign-manager history before
per-runtime mutex acquisition, while malformed evidence remains a blocker.
Idle readiness reports only recovery obligations that the current installation
and Windows user can actually own. The LMDB record store closes retained read
and write handles together and renews existing-only transactions safely.

## Verification result

The focused history-recovery suite passes 9/9, including read-only
classification, bounded/idempotent recovery, exact-live and prior-owner-live
refusals, cross-authority and malformed-history fences, high-cardinality
shutdown filtering, cleanup-pending completion, and the retained-reader to
writer transition. The LMDB record-store suite passes 15/15 and the focused
idle-readiness suite passes 7/7. Stage 3 passes 42 files and 370 tests; Stage 4
passes 37 files and 296 tests; the cross-cutting baseline passes 10 files and 56
tests. The complete serial suite passes 251 files and 2,278 tests, with one
fixture file/test intentionally skipped. Typecheck, unused-code analysis, build,
protocol artifacts, both add-on manifests, a fresh packed production install,
and an isolated-state 63-tool MCP handshake also pass.

## Live acceptance result

The established default Observer environment was already mapped by older MCP
hosts belonging to other active work. To avoid killing or disturbing those
hosts, acceptance copied the environment byte-for-byte while holding the
lifecycle mutex and ran the production composition against that snapshot. The
initial `data.mdb` copy was 1,310,720 bytes with SHA-256
`36DB93F3135531C9525AC04F338310D2DE03AECCAC324B2D562D680A176063E6`.

The first read-only inventory classified 539 records across 63 runtimes: 22
completed and 41 child-exit-only, with no malformed, pending, unresolved, or
indeterminate lifecycle. A one-candidate recovery batch attempted one candidate
and correctly returned `IDENTITY_UNVERIFIABLE`: the retained histories belonged
to another installation/Windows-user authority. It issued zero termination
calls and did not mutate that runtime lifecycle. Because none of the 41 foreign
histories were obligations the controlled host could own, its final idle
readiness had no blockers.

With Workbench state isolated, the production MCP host started and closed its
disposable private Observer child, committed ordinary idle shutdown after the
60-second window, and exited with code 0 after 61.061 seconds. No game or
Workbench process was launched, stopped, restarted, or claimed; no owned
runtime was terminated; and no lifecycle store was deleted. The original
default Observer environment was never opened by the acceptance host and
remained available to the older MCP processes.

## Live acceptance re-validation, 2026-08-07 (true default root)

The adversarial review correctly identified that the snapshot substitution
above did not exercise the real gate (open-handle/multi-host behavior against
the actual default root), and tracked the blocking native crash as `MCP-057`.
With `MCP-057` resolved (2026-08-06) and Workbench plus every other MCP/Node
process confirmed stopped, the true default-root gate was re-run directly
against `%LOCALAPPDATA%\ReforgerForge\Observer\v1` — not a copy.

A read-only `history` scan found 813 records across 88 runtimes accumulated
from this installation's own prior dev/test work: 39 completed, 49
child-exit-only. `recover` correctly attempted and refused all 49 as
`IDENTITY_UNVERIFIABLE` (cross-installation authority), issuing zero
termination calls, matching the original run's fail-closed behavior against a
different, larger, real dataset. Per explicit user direction the default
Observer root and the separate `%LOCALAPPDATA%\ReforgerForge\Workbench\v3`
lifecycle store were then deleted outright (confirmed disposable dev-cache:
build/profile/helper staging and an already-orphaned legacy `lifecycle.json`;
no real project source lives under either root), rather than recovered
record-by-record.

Re-running the gate against the resulting fresh state surfaced a second,
independent defect: the idle-shutdown seal almost never committed even with
every provider reporting clean. Root cause and fix are recorded as `MCP-071`
in `agents/mcp-tracking/MCP_BUGS_RESOLVED.md` — `CaptureService`'s retention
sweep timer was bumping the same idle-revision counter the seal's TOCTOU
recheck depends on, on every 50-1000ms tick, even when it had no work to do.
After the fix, three separate runs (two isolated idle-only, one full
history-plus-idle) each committed clean idle shutdown at 60.5-63.6 seconds
with exit code 0. The observer and idle-shutdown suites (656 tests across 74
files) and typecheck pass with no regressions from the fix.
