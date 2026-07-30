# Resolved MCP Issues

This is the reverse-chronological closed history for non-defect MCP contract
records. Move newly resolved or verified entries to the top. The legacy records
below were migrated from the mixed tracker on 2026-07-28; same-day ties retain
their migration order.

### MCP-039 — provide a safe way to release or transfer an idle lifecycle lease

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** Preempt a provably idle lease at claim time instead of building a
cooperative release/transfer protocol between MCP hosts.

The root cause was that the lease had no release path at all: `mcpOwner` was
never cleared, so a claim survived for the owning process's entire lifetime.
`validateAndClaimLocked` recovered a dead owner but refused a live one purely
because its PID still resolved, even when the record was quiescent.

`WorkbenchProcessGuard.validateAndClaimLocked` now consults
`provenIdleLease` before refusing a live owner, and claims with the new
`source: "idle_owner"` when every one of these holds:

- the durable record is `phase: vacant` with no `workbench` and no `operation`
- no Workbench process exists (a strict scan, not a best-effort one)
- the NET API endpoint is positively `vacant`
- the recorded owner has the same Windows user SID (unchanged precondition)

Anything unproven — an unverifiable process scan or an unverifiable endpoint
probe — keeps the lease with its current owner and returns
`OWNED_BY_OTHER_MCP` with the specific reason it was not idle.

A cooperative request to the owner was deliberately not built. Every operation
the lease protects (capture, editor session, build, target-bound save, Observer
restoration) requires a live Workbench and is already fenced by
`workbench !== null` plus `phase: running`, so a vacant record is itself the
owner's durable idle attestation. Asking the owning process would add a channel
and a new class of hangs without adding evidence. A heartbeat/expiry contract
was also rejected: it is time-based, and it can revoke a lease from an owner
whose Workbench is live but whose event loop is briefly blocked.

Safety rests on two existing invariants rather than on process termination.
The whole decision runs inside the machine-wide lifecycle mutex, so concurrent
claims cannot interleave, and `transitionLocked` refuses any mutation whose
generation and lease id were superseded. A preempted owner is never signalled;
its next mutation fails `GENERATION_MISMATCH` and it recovers by re-claiming.

Clearing `mcpOwner` inside `transitionToVacant` was evaluated and rejected as
unsafe. Several flows — `ensureRunningCoordinated` in particular — pass through
a vacant record as an intermediate state of one larger owned operation and then
reacquire across a separate lock acquisition, so releasing there would open a
window for a competing MCP mid-launch. Preemption covers those cases anyway,
because it recovers any vacant lease regardless of how it was left behind.

`wb_diagnose` lifecycle evidence gained `leaseOwner` (owning pid, instance id,
lease id, claim time) and `leasePreemptible`, so the owning session can be
identified without terminating an OS process.

**Verification:** Focused regression coverage in
`tests/workbench/process-guard.test.ts` for idle-owner preemption, the
preempted owner's `GENERATION_MISMATCH` fence and re-claim, and refusal for a
running Workbench, an in-progress operation, an occupied endpoint, an
unverifiable endpoint, a live unowned Workbench process, an unverifiable
process scan, and a different Windows user. `tests/workbench/diagnostics.test.ts`
covers the new lease projection. `tests/workbench/multiprocess-lifecycle.test.ts`
proves the handoff across two real live Node MCP processes on Windows: the
contender takes the idle lease with `source: "idle_owner"`, neither process is
terminated, and the previous owner is refused with `OWNED_BY_OTHER_MCP` once
the new owner reserves the lease. The full Vitest suite (1820 tests),
TypeScript typecheck, and knip passed.

## Historical and verified records

### MCP-030 — remove configured `projectPath` targeting

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** Remove `projectPath`, `defaultMod`, their CLI flags, and
container-scanning target selection. Addon-scoped tools accept the exact
`.gproj` through `gprojPath` or, where supported, derive it from the verified
running Workbench lifecycle. `mod_create` instead receives an explicit
`outputDir`.

Base-game and standard Workshop addon roots remain automatically discovered.
Nonstandard roots are additive through `workbenchAddonDirs` or repeated
`--workbench-addon-dir` flags. Dependency preflight searches those effective
roots plus target-relative candidates; it does not search arbitrary filesystem
locations.

**Verification:** Configuration rejects the retired settings and flags;
target-resolution, project-identity, generators, duplication, prompts, setup,
and Workbench lifecycle tests cover exact and active targeting. The full
Vitest suite, TypeScript typecheck, and production build passed.

### MCP-029 — `observer_capture` uses only the opaque world revision

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** The public `observer_capture` contract requires
`expectedWorldRevision` from the immediately preceding `observer_instances`
result. It does not support `expectedWorldId`, `expectedWorldEpoch`, legacy-pair
requests, or dual-form requests. Inventory and result metadata retain nullable
world-ID and epoch projections for diagnostics, while the internal runtime
protocol may project the opaque revision back to those fields.

A canonical revision may represent a graphical runtime with no loaded world.
That state permits `current` capture and rejects `pose` or `lookAt` until an
active world is available.

**Verification:** The registered MCP schema requires
`expectedWorldRevision`, omits both removed fields, and rejects additional
properties. Capture normalization, runtime and Workbench backends, durable-run
reservation, current-view null-world behavior, acceptance/failure-matrix
callers, package guidance, and MCP response tests use the canonical revision.
The focused observer contract suite passed 97 tests; the full Vitest suite,
TypeScript typecheck, MCP build, and Observer build also passed.

### MCP-026 — old release notes describe their release-time API surface

**Status:** Verified

**Closed:** 2026-07-28

The relevant legacy release notes are labeled as historical records, and
archived plans are not live API reference. Current MCP schemas and guides are
the present-behavior source; historical material is not used by verification or
package contracts as canonical documentation.

### MCP-018 — explicit resource save workflow

**Status:** Verified

**Closed:** 2026-07-28

The supported guarded save flow is:

```text
wb_launch(gprojPath, resourcePath) -> target-bound edits ->
wb_save_resource(confirm: "save", resourcePath)
```

The target must be the same `.ent` or `.et` resource supplied at launch.

### MCP-017 — evidence roots are needed only for finalization

**Status:** Verified

**Closed:** 2026-07-28

`observer_run finalize` requires a configured allowlisted evidence destination.
Run begin, capture, status, and discard remain available without one; a
caller-supplied path cannot bypass an empty allowlist.
