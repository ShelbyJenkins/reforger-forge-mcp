# Observer API Simplification Implementation Plan

## Status

Phases 0, 1, and 2 were implemented and validated on 2026-08-04. Lifecycle
idempotency, the Workbench submit-time world compare-and-swap, the smaller
public contract, retry-safe capture admission, delegated selection, automatic
labels, process-local active runs, and internal Workbench priming are complete.
No implementation task in this plan remains open.

The final hermetic suite passed 2,030 tests with one intentional skip and no
failures across 609 suites. Typecheck, protocol generation checks, both addon
manifests, native runtime and Workbench Enforce validation, the package build,
and a fresh production tarball install also passed. The package contained
1,011 files and verified both advertised binaries and both descriptor-derived
Enforce targets.

Guarded Workbench acceptance passed on 1.7.0.54, including internal current
capture priming, release, explicit pose capture, restoration, evidence
isolation, application shutdown, and exact process vacancy without manual
cleanup. Guarded runtime acceptance then passed on graphical
`ArmaReforgerSteamDiag.exe` 1.7.0.54 against the installed stock MP Test world.
It produced and validated the five current/pose/restored/look-at/restored PNGs
at 2560x1440, finalized the evidence bundle, restored both camera leases,
stopped the exact owned runtime, and proved process vacancy with no manual
cleanup.

The first runtime attempt exposed an invalid Windows native declaration in the
focus guard: `GetCurrentThreadId` was imported from `user32.dll` instead of
`kernel32.dll`. The helper failed closed and still proved exact runtime and
private-child cleanup. The import was corrected, a regression assertion was
added, and the complete runtime acceptance and final suite then passed.

## Plan validation record (2026-08-03)

Every file path and npm script referenced below was confirmed to exist. The
following source claims were checked directly and hold:

- `EMCP_WB_ObserverSubmit.c` exists as a separate handler and delegates to
  `EMCP_WB_ObserverService.Submit` in `EMCP_WB_ObserverCommon.c`; the
  `InspectEnvironment` → job-construction insertion point in Task 1.2 is
  correct.
- `RunStore.bindCapture` does set `state: "submitted"` before backend
  acknowledgement, as Task 2.2 asserts.
- `observer_runtime` requires `idempotencyKey` for both start and stop through
  handler guards rather than the schema, so Task 1.1 removes the schema field
  *and* those two guards.
- `REQUIRED_OBSERVER_TOOLS` in `src/setup/server-verification.ts` lists
  `observer_run` and must change with Task 1.6.

Four gaps were found and are now folded into the tasks below: the Task 1.4
signature change breaks six additional typechecked files; Task 2.2 had no file
list and needs a new durable revise operation to get past `reserveCapture`'s
fingerprint 409; Task 1.1 leaves the live acceptance harness bypassing the new
derivation; and Task 2.4 must also touch `application-operations.ts`.

The completed Phase 0/1/2 work in
`2026-08-03-mcp-lifecycle-option-a.md` was reviewed after implementation. The
API simplification remains compatible, with one implementation constraint now
made explicit: capture admission and job-lifecycle refactors must preserve
`CaptureService.quiesce(deadlineAtMs)`, its shutdown abort signal, and its
tracking of admissions that can become active jobs. New public operations must
also remain behind the application's `open` lifecycle gate; only the narrow
internal cancellation and exact-runtime seal path may run while the
application is quiescing, sealing, or `retryable_unsafe`. The CLI now closes
the MCP protocol before quiescence and enforces one 30-second absolute
deadline, so no task below may introduce a fresh per-phase shutdown budget or
an unconditional terminal Observer close. Phase 2 moved API-index loading
behind `SearchEngine` itself without changing Observer schemas or lifecycle
ownership. The simplification tasks must continue to consume the engine only
through its public operations; registration must not introduce an eager index
read or a handler-specific initialization bypass.

## Goal

Make the common Observer operation a one-call capture without moving existing
safety invariants onto the caller:

```json
{}
```

When exactly one compatible renderer is available, the final
`observer_capture` contract should select it, bind to its current world,
capture the default current view, and either attach the capture to the
process-local active run or automatically release a runless transaction.

Explicit selection remains available through an opaque target returned by
`observer_instances`:

```json
{
  "target": "ct1.<opaque>"
}
```

The evidence path remains explicit:

```text
observer_run_begin -> observer_capture x N -> review images -> observer_run_finalize
```

Finalization must still receive a review object and an explicit non-empty set
of reviewed capture labels. This project removes copied routing identifiers;
it does not weaken the review gate or silently select evidence for export.

## Verified findings and corrected framing

The following observations are treated as implementation facts:

1. `observer_job.sessionId` is already optional at the MCP schema and core
   boundary. The retained job reference supplies the backend session, and only
   a supplied mismatching session is rejected. The public field should be
   deleted rather than made optional again.
2. Public `performancePolicy` already exposes only `evidence` and
   `instrumented`. The blocked `performance` value is an internal protocol
   variant. `instrumented` intentionally marks captures contaminated, so
   changing or removing this field is a separate product decision and is not
   part of this project.
3. A runless capture is not persistence-free today. It is unpinned, but the
   job store refuses to sweep it until a backend release receipt exists.
   Runless delivery therefore requires automatic release semantics.
4. `settleFrames` is semantic capture input included in request identity and
   evidence metadata. It remains public with a default.
5. Fresh random idempotency keys are acceptable as uniqueness for
   re-submittable captures but are unsafe for `observer_runtime`. A lost start
   response followed by a newly keyed retry can reach
   `PREPARED_LAUNCH_CONSUMED`. Runtime lifecycle keys must be hidden from the
   caller and derived stably from the canonical operation.
6. Capture admission currently reserves a run label before selecting an
   instance and checking its world revision. Selection and resolution must
   move ahead of durable reservation, and a submit-time world rejection needs
   a revision-safe provisional reservation transition.
7. Automatic labels belong in the durable run store, while an ambient run is
   process-local state. Neither may be inferred by scanning and selecting the
   most recent durable run.

Workbench already performs more world validation than the original review
framing implied:

- the host compares the selected revision in `CaptureService`;
- `WorkbenchCaptureBackend.submit` repeats the host-side comparison; and
- the Workbench helper seeds `job.worldIdentity` and verifies that identity,
  the world pointer, project, viewport, and camera ownership throughout the
  transaction and restoration path.

The residual gap is a narrow time-of-check/time-of-use window between host
inventory and the helper's initial `CurrentWorldIdentity()` read. Delegated
selection already narrows that window compared with a caller copying a token
through a separate model turn. The Tier 1a fix still closes the live gap:
send the expected Workbench world identity on the submit wire and compare it
before constructing the job or acquiring the camera lease. This converts the
helper's initial read-and-adopt into a compare-and-swap.

## Safety invariants that remain unchanged

- Explicit targets fail with `WORLD_CHANGED`; they are never silently
  rebound.
- A delegated retry may refresh only the originally selected backend and
  instance, once, under the original timeout budget.
- Runtime and Workbench camera restoration remains mandatory before release,
  lifecycle mutation, restart, or stop.
- Run finalization still requires `imagesReviewed`, reviewer/outcome policy,
  and explicitly selected reviewed labels.
- Evidence destinations and supporting logs remain limited to configured
  allowlisted roots and exact-owned runtime grants.
- Raw `-window`, `-screenWidth`, and `-screenHeight` launch arguments remain
  refused.
- The target token is a routing convenience, not authorization. Decoding it
  must never bypass fresh inventory, exact lifecycle checks, or backend-side
  world comparison.

## Public contract after each phase

### After Tier 1a

- `observer_instances` returns a `target` for every projected renderer.
- `observer_capture` accepts either `target` or the deprecated legacy
  selector/binding fields, never both.
- `view` defaults to `{ "kind": "current" }`.
- `runId` and `captureLabel` may both be omitted for a runless capture. During
  Tier 1a they must still be supplied together for a run-bound capture.
- A successful synchronous runless capture automatically releases its backend
  transaction.
- `observer_job` no longer exposes `sessionId`.
- `observer_runtime` no longer exposes `idempotencyKey` for start or stop.
- `observer_run` is replaced by `observer_run_begin`,
  `observer_run_status`, `observer_run_finalize`, and
  `observer_run_discard`, each with an action-specific schema.
- Workbench submit rejects an inventory/submit world mismatch before camera
  lease acquisition and projects it as `WORLD_CHANGED`.

Tier 1a does not yet allow a completely empty capture request. Without a
target, callers remain on the legacy selector path until the admission
refactor lands.

### After the capture-admission refactor

- Omitting `target` and all legacy selector fields delegates selection across
  all configured capture backends.
- Exactly one compatible renderer is selected; zero and multiple candidates
  remain explicit errors.
- Ambiguity details return candidate targets, not fields that must be manually
  recombined.
- Delegated `WORLD_CHANGED` retries once against the same instance only.
- `runId` resolves to the process-local active run when omitted; with no active
  run the capture is runless.
- A missing `captureLabel` is allocated atomically by the durable run store.
- An unprimed but otherwise compatible Workbench renderer can perform an
  internal current-view restoration proof before a requested pose or look-at.

## Out of scope

- Removing or changing `performancePolicy`.
- Moving `settleFrames` to global configuration.
- Removing the review gate or defaulting finalization to all completed images.
- Changing evidence-root, supporting-log, or exact-runtime ownership policy.
- Signing target tokens while they carry no authority. If a future multi-user
  boundary treats targets as credentials, introduce an authenticated token
  version rather than changing `ct1` semantics in place.
- Removing the legacy capture selector in the same release. It remains a
  mutually exclusive compatibility path and should receive an explicit later
  deprecation decision.
- Retaining the old action-based `observer_run` tool. The four checkable run
  tools intentionally replace it in this change.

---

## Phase 0: Characterize the current contract

### Task 0.1: Lock the pre-change behavior in focused tests

**Files:**

- Modify: `tests/observer/observer-mcp-tools-schema-responses.test.ts`
- Modify: `tests/observer/observer-mcp-tools-registration-runtime.test.ts`
- Modify: `tests/observer/capture-service.test.ts`
- Modify: `tests/observer/capture-request.test.ts`
- Modify: `tests/observer/workbench-capture-backend.test.ts`

**Work:**

1. Add characterization assertions proving that a missing
   `observer_job.sessionId` succeeds today and a supplied mismatch fails.
2. Prove that a completed runless job is not swept before release.
3. Prove that start recovery depends on reuse of the same runtime
   idempotency key, while a different key sees the one-shot prepared launch as
   consumed.
4. Prove the current Workbench flow performs both host comparisons and adopts
   the helper's initial world identity without comparing an expected identity
   on the wire.
5. Preserve the current public `performancePolicy` assertions:
   `instrumented` accepted, `performance` rejected.

**Validation:**

```powershell
npm.cmd exec -- vitest run tests/observer/capture-request.test.ts tests/observer/capture-service.test.ts tests/observer/observer-mcp-tools-schema-responses.test.ts tests/observer/observer-mcp-tools-registration-runtime.test.ts tests/observer/workbench-capture-backend.test.ts
```

---

## Phase 1: Tier 1a

### Task 1.1: Derive stable runtime lifecycle idempotency keys

This is the first implementation task.

**Files:**

- Modify: `src/tools/observer-runtime.ts`
- Modify: `tests/observer/observer-mcp-tools-registration-runtime.test.ts`
- Modify: `tests/observer/owned-runtime-manager-recovery-authority.test.ts`
- Modify as needed: `tests/observer/owned-runtime-manager-reconciliation.test.ts`

**Design:**

1. Remove `idempotencyKey` from the public `observer_runtime` input schema.
2. Add a private canonical key helper that hashes a versioned, fixed-order
   payload:

   - start: `{ action: "start", preparedLaunchId }`;
   - stop: `{ action: "stop", runtimeId, waitForRestorationMs }`.

3. Format the result as a bounded internal key such as
   `mcp-runtime-start-v1-<sha256>` or
   `mcp-runtime-stop-v1-<sha256>`.
4. Resolve schema defaults before deriving the key so an omitted default and
   the explicit default produce the same stop key.
5. Keep `OwnedRuntimeManager.start` and `.stop` keyed internally. Do not weaken
   or remove their durable idempotency receipts.
6. Do not apply fresh UUID generation to lifecycle mutations.

**Required tests:**

- Two identical public start calls pass the same private key to the manager.
- A simulated lost start response can be retried and recovers the same runtime
  receipt rather than returning `PREPARED_LAUNCH_CONSUMED`.
- Equivalent stop requests derive the same key.
- A changed canonical stop parameter derives a different key.
- The registered schema no longer contains `idempotencyKey`.

**Coverage note:** the live acceptance harness calls
`OwnedRuntimeManager.start`/`.stop` directly with its own
`runtime-start-${randomUUID()}` and `runtime-stop-${randomUUID()}` keys
(`scripts/run-runtime-observer-acceptance.ts`), so it keeps compiling and
passing after this task while exercising none of the new derivation. Export the
derivation helper and route those call sites through it, or the lost-response
recovery path stays unit-test-only.

### Task 1.2: Add Workbench submit-side expected-world compare-and-swap

**Files:**

- Modify: `src/observer/workbench-capture-backend.ts`
- Modify: `src/workbench/observer-adapter.ts`
- Modify: `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverSubmit.c`
- Modify: `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverCommon.c`
- Modify: `observer/workbench-addon/.reforger-forge-workbench-helper-source.json`
- Modify: `tests/observer/workbench-capture-backend.test.ts`
- Modify: `tests/workbench/observer-adapter-submit-recovery.test.ts`
- Modify: `tests/workbench/observer-adapter-lifecycle-restoration.test.ts`
- Modify as needed: Workbench observer failure-matrix fixtures and tests

**Design:**

1. Decode the request's Workbench revision with
   `workbenchWorldIdentity` in `WorkbenchCaptureBackend` and pass the result as
   required `expectedWorldIdentity` adapter input.
2. Add the bounded identity to the adapter submit schema and NET API request.
   This is a three-place wire change: the `EMCP_WB_ObserverSubmitRequest`
   fields plus their `RegV` registrations in `EMCP_WB_ObserverSubmit.c`, the
   `service.Submit(...)` call site there, and the `Submit` declaration in
   `EMCP_WB_ObserverCommon.c`, which currently takes thirteen positional
   parameters and two `out` parameters. Because the helper bundle is content
   hashed, `observer:manifest` must regenerate the per-file `sha256` entries,
   `buildIdentity`, and `bundleDigest` in the same commit.
3. Include it in the handler's exact replay tuple so a lost acknowledgement
   can replay only the same compare-and-swap command.
4. After `InspectEnvironment` and before constructing `EMCP_WB_ObserverJob`,
   read `CurrentWorldIdentity()` once and compare it with
   `expectedWorldIdentity`. Verified insertion point: `InspectEnvironment` is
   called near the top of `EMCP_WB_ObserverService.Submit`, and the
   `new EMCP_WB_ObserverJob()` construction that currently self-seeds
   `job.worldIdentity = CurrentWorldIdentity()` follows immediately after.
   The compare must precede both the job allocation and the camera lease.
5. On mismatch, return a structured pre-admission `WORLD_CHANGED` rejection.
   Extend the private handler response if necessary so the adapter can map this
   exact code without manufacturing a job or collapsing it into generic
   `CAPTURE_REJECTED`.
6. On equality, assign the same measured identity to `job.worldIdentity` and
   retain all existing later-stage world, project, viewport, camera ownership,
   and restoration checks.

**Required tests:**

- A world change between inventory and submit returns `WORLD_CHANGED`.
- The mismatch creates no handler job, acquires no camera lease, and writes no
  artifact.
- An identical replay with the same expected identity remains idempotent.
- A replay with a different expected identity is rejected as a different
  command.
- Later world displacement still follows the existing restore/relinquish
  behavior.

**Validation:**

```powershell
npm.cmd run observer:validate:enforce
npm.cmd exec -- vitest run tests/observer/workbench-capture-backend.test.ts tests/workbench/observer-adapter-submit-recovery.test.ts tests/workbench/observer-adapter-lifecycle-restoration.test.ts
npm.cmd run observer:manifest
npm.cmd run observer:manifest:check
```

### Task 1.3: Introduce the opaque capture target

**Files:**

- Add: `src/observer/capture-target.ts`
- Add: `tests/observer/capture-target.test.ts`
- Modify: `src/observer/tools.ts`
- Modify: `src/observer/capture-contract.ts`
- Modify: `src/observer/application.ts`
- Modify: `tests/observer/observer-mcp-tools-schema-responses.test.ts`
- Modify: `tests/observer/capture-service.test.ts`

**Token contract:**

Use `ct1.<base64url-json>` with a strictly validated payload containing:

- `backend`;
- runtime `sessionId` when applicable;
- `instanceId`; and
- `expectedWorldRevision`.

The decoder must enforce:

- exact version/prefix and a bounded total token length;
- bounded identifiers;
- runtime targets require a session and Workbench targets do not carry one;
- the world-revision kind matches the declared backend;
- the embedded world revision passes the existing canonical validator; and
- no decoded value is treated as authorization or recovery authority.

**Tool behavior:**

1. Project a target for each `observer_instances` renderer without exposing
   `recoveryBinding`.
2. Add `target` to `observer_capture`.
3. Make `expectedWorldRevision` schema-optional only to support the target
   path; retain handler-level validation for the compatibility path.
4. Reject `target` combined with any legacy selector/binding field.
5. Decode the target into the existing session, instance, and expected
   revision fields before application capture normalization.
6. Continue to feed the decoded revision into the same world assertion so
   explicit-target `WORLD_CHANGED` behavior remains unchanged.
7. Default `view` to `{ kind: "current" }` at the MCP boundary.

Because the MCP SDK registration currently accepts a property shape rather
than an action/selector discriminated union, the compatibility XOR may require
explicit boundary validation. The description and schema tests must make the
transition contract unambiguous.

**Required tests:**

- Runtime and Workbench round trips.
- Malformed base64/JSON, unknown version, oversized token, missing fields, and
  backend/revision mismatch.
- A forged but structurally valid target never bypasses inventory and fails as
  stale, unavailable, or world-changed through the ordinary selection path.
- `target` plus any legacy field is rejected.
- A target-only capture defaults to current view.
- The legacy selector remains accepted during the compatibility period.

### Task 1.4: Remove `observer_job.sessionId` end to end

**Files:**

- Modify: `src/observer/tools.ts`
- Modify: `src/observer/application.ts`
- Modify: `src/observer/capture-service.ts`
- Modify: `tests/observer/application-contract.test.ts`
- Modify: `tests/observer/capture-service.test.ts`
- Modify: `tests/observer/observer-mcp-tools-schema-responses.test.ts`
- Modify: `tests/observer/observer-mcp-tools-workbench-lifecycle.test.ts`

Every remaining caller of the two-argument job API must change in the same
commit. `tsconfig.json` includes `scripts/**/*` and `tests/**/*`, so these are
`npm run typecheck` failures, not deferred cleanup:

- Modify: `scripts/run-runtime-observer-acceptance.ts`
- Modify: `scripts/run-workbench-observer-acceptance.ts`
- Modify: `scripts/observer-runtime-failure-matrix.ts`
- Modify: `scripts/workbench-observer-matrix-case.ts`
- Modify: `tests/observer/runtime-failure-matrix-runner.test.ts`
- Modify: `tests/workbench/observer-live-acceptance-contract.test.ts`

Note that `scripts/observer-runtime-failure-matrix.ts` and
`scripts/workbench-observer-matrix-case.ts` also narrow the application type
with `Pick<ObserverApplication, "capture" | "cancelJob" | "jobStatus" | ...>`,
so their fixture types change with the interface.

**Design:**

1. Delete `sessionId` from the MCP job schema and description.
2. Change public application job operations to accept only `jobId`.
3. Change `CaptureService.status`, `read`, `cancel`, `release`, and
   `requireJob` to resolve the exact backend reference solely from the retained
   job record.
4. Preserve `ref.sessionId` internally for runtime backend calls and evidence
   ownership.
5. Treat `jobId` as the existing process-local bearer handle; this is not a
   privilege change because omission already succeeds today.
6. Drop the now-dead `SESSION_MISMATCH` branch in `requireJob` only after
   confirming no other caller depends on that projected code.

### Task 1.5: Implement runless delivery and automatic release

**Files:**

- Modify: `src/observer/capture-contract.ts`
- Modify: `src/observer/capture-service.ts`
- Modify: `src/observer/application.ts`
- Modify: `src/observer/tools.ts`
- Modify: `src/observer/capture-job-store.ts` only if a guarded provisional or
  cleanup-state operation is required
- Modify: `tests/observer/capture-service-contract.ts`
- Modify: `tests/observer/capture-service.test.ts`
- Modify: `tests/observer/observer-mcp-tools-schema-responses.test.ts`

**Public schema:**

- `runId` and `captureLabel` become optional.
- During Tier 1a, they must be present together for a run-bound capture.
- Run-bound retention and finalization behavior remains unchanged.

**Cleanup outcomes:**

| Mode/outcome | Required behavior |
|---|---|
| Synchronous, inline image | Validate and buffer the image, then release the backend transaction before returning. Preserve the completed capture projection and include the cleanup receipt separately. |
| Asynchronous | Retain the job while queued/running. A successful inline `observer_job read` auto-releases a runless job after buffering the image. |
| Cancelled asynchronous job | Once terminal restoration is proven, cancellation auto-releases the runless job. If release cannot complete, return the retained job ID and cleanup state. |
| Oversized runless image | Attempt release because the fixed image policy cannot later make the same artifact inline-readable. Return `ARTIFACT_TOO_LARGE` with release or cleanup-required details. |
| Cleanup failure after inline success | Return the validated image plus a bounded cleanup warning, `cleanupRequired: true`, and the retained `jobId`; do not report persistence-free success. |

Automatic release must occur only after terminal restoration requirements are
satisfied. A release failure must never be converted into a false restoration
claim. Explicit `observer_job release` remains idempotent for cleanup recovery.

**Required tests:**

- A normal synchronous runless runtime capture calls release exactly once.
- A normal synchronous runless Workbench capture releases its handler and
  lifecycle activity gate.
- A run-bound capture is not auto-released ahead of run ownership.
- Async status does not release; successful read does.
- Cancel auto-releases only after safe terminal restoration.
- Oversized runless output does not become an unsweepable orphan.
- Cleanup failure returns the image when available and a usable job handle.
- The job store can eventually sweep every successfully delivered runless
  transaction because a release receipt is retained.

### Task 1.6: Split the run action tool

**Files:**

- Modify: `src/observer/tools.ts`
- Modify: `src/setup/server-verification.ts`
- Modify: `tests/observer/observer-mcp-tools-registration-runtime.test.ts`
- Modify: `tests/observer/observer-mcp-tools-schema-responses.test.ts`
- Modify: `tests/observer/package-contract.test.ts`
- Modify: `observer/README.md`
- Modify: `docs/observer.md`
- Modify: `agents/AGENTS.md`

**New tools:**

1. `observer_run_begin`
   - required: `title`;
   - optional: `caseIds`, source/procedure revisions, existing optional begin
     idempotency key.
2. `observer_run_status`
   - required in Tier 1a: `runId`.
3. `observer_run_finalize`
   - required in Tier 1a: `runId`, `includeCaptureLabels`, `review`;
   - optional: configured-root selector, runtime configuration, supporting
     files, artifact-release choice.
4. `observer_run_discard`
   - required in Tier 1a: `runId`.

Remove the old `observer_run` registration and handler guards. Keep evidence
root resolution in a shared private helper so the finalize tool does not
duplicate policy. Update every runtime tool-list assertion and operator guide
in the same change.

### Task 1.7: Complete the Tier 1a documentation and compatibility gate

**Files:**

- Modify: `docs/observer.md`
- Modify: `observer/README.md`
- Modify: `agents/AGENTS.md`
- Modify as needed: `README.md`, `SETUP.md`
- Do not rewrite historical release notes as current API documentation.

**Documentation requirements:**

- Lead with target-only current capture and runless automatic cleanup.
- Document the legacy selector only as a compatibility path.
- Remove the session-versus-runtime-ID instructions from capture/job usage;
  retain `runtimeId` only where lifecycle status/stop requires it.
- Document cleanup-required responses and oversized runless behavior.
- Show the four new run tools with the review gate intact.
- State that Workbench compares the expected world before lease acquisition
  and continues validating the adopted identity throughout restoration.

**Tier 1a validation gate:**

```powershell
npm.cmd run typecheck
npm.cmd exec -- vitest run tests/observer/capture-target.test.ts tests/observer/capture-request.test.ts tests/observer/capture-service.test.ts tests/observer/observer-mcp-tools-schema-responses.test.ts tests/observer/observer-mcp-tools-registration-runtime.test.ts tests/observer/observer-mcp-tools-workbench-lifecycle.test.ts tests/observer/owned-runtime-manager-recovery-authority.test.ts tests/observer/workbench-capture-backend.test.ts tests/workbench/observer-adapter-submit-recovery.test.ts tests/workbench/observer-adapter-lifecycle-restoration.test.ts
npm.cmd run observer:validate:enforce
npm.cmd run protocol:check
npm.cmd run observer:manifest:check
```

---

## Phase 2: Capture-admission refactor

### Task 2.1: Separate capture intent, target resolution, and canonical request

**Files:**

- Modify: `src/observer/capture-contract.ts`
- Modify: `src/observer/capture-request.ts`
- Modify: `src/observer/capture-service.ts`
- Modify: `src/observer/evidence-run-service.ts`
- Modify: `observer/agent/runs.ts`
- Modify: `observer/agent/application-operations.ts`
- Modify: corresponding capture, run, recovery, and retention tests

**New admission stages:**

1. Normalize caller intent that does not depend on a renderer: view, image,
   timeout, settle frames, policy, purpose, async mode, and explicit/delegated
   selection mode.
2. Resolve an explicit target/legacy selector or inventory candidates for
   delegated selection.
3. If Workbench priming is needed, complete it before allocating user evidence
   state, then revalidate the same instance and world.
4. Materialize the canonical dispatch request with the resolved session,
   instance, and world revision.
5. Resolve an explicit or active run and atomically reserve/allocate its label.
6. Persist a provisional exact backend binding sufficient for crash recovery.
7. Submit to the backend.
8. Mark the provisional binding submitted only after backend acceptance.

`normalizeCaptureRequest` must no longer require a caller-provided world
revision before selection. Keep a distinct canonical resolved request for
backend dispatch and evidence metadata.

### Task 2.2: Make provisional run admission retry-safe

**Files:**

- Modify: `observer/agent/runs.ts`
- Modify: `observer/agent/application-operations.ts`
- Modify: `src/observer/evidence-run-service.ts`
- Modify: `src/observer/capture-service.ts`
- Modify: `src/observer/capture-contract.ts`
- Modify: `tests/observer/runs.test.ts`
- Modify: `tests/observer/evidence-run-service.test.ts`
- Modify: `tests/observer/capture-service.test.ts`
- Modify as needed: recovery/convergence tests covering the new state

The current `bindCapture` transition marks a capture `submitted` before the
backend acknowledges it. Replace that conflation with explicit durable states
or operations, for example:

```text
reserved -> admitting -> submitted -> completed/failed
```

**Blocking constraint discovered in the durable store:**

`RunStore.reserveCapture` derives `requestFingerprint` from a semantic payload
that already includes `expectedWorldRevision`, then rejects an existing label
whose fingerprint differs with a 409 `Capture label '<label>' is already
reserved in this run`. A delegated retry therefore *cannot* re-enter through
`reserveCapture` with a refreshed revision — it would collide with its own
first attempt.

The retry path needs a distinct durable operation (for example
`reviseCaptureAdmission`) that atomically rewrites the proposed revision and
`requestFingerprint` on a capture still in `admitting`, guarded by the
conditions below. Expose it through `application-operations.ts` alongside
`runReserveCapture`/`runBindCapture`. Do not relax the 409 in `reserveCapture`;
that check is what makes ordinary label reuse safe.

**Requirements:**

1. `admitting` records the job ID, backend, session, instance, and proposed
   revision so a crash never leaves an accepted backend job without an exact
   recovery reference.
2. A confirmed pre-admission `WORLD_CHANGED` may revise an `admitting` record
   only when:

   - selection was delegated;
   - the backend guarantees that no job/lease was created;
   - backend and instance ID are unchanged;
   - the retry count is zero; and
   - the original deadline has not expired.

3. Revision changes update the resolved request fingerprint and evidence
   metadata atomically. They may not reuse an already submitted binding.
4. Explicit targets never take this transition; they fail hard.
5. Exhausted retry marks the reserved capture failed once. The first
   pre-admission mismatch must not consume or fail the label prematurely.
6. Recovery/convergence understands `admitting` and can distinguish a backend
   job not found from an accepted or retained job.

Runtime already checks expected world ID/epoch before constructing its job
record. Task 1.2 gives Workbench the same pre-admission property. Preserve and
test those guarantees because this retry transition depends on them.

### Task 2.3: Add delegated selection and same-instance retry

**Behavior:**

1. When `target` and all legacy selector fields are absent, inventory all
   configured backends under one deadline.
2. Filter stale, unhealthy, headless, and capability-incompatible instances.
3. For a pose/look-at request, treat a Workbench renderer with current capture
   and an available restoration API as primable rather than immediately
   incompatible.
4. If exactly one candidate remains, select it and record that selection was
   delegated.
5. If none remain, return `NO_RENDER_ENDPOINT` or the more specific capability
   error already supported by the service.
6. If multiple remain, return `AMBIGUOUS_INSTANCE` with bounded candidate
   summaries and their opaque targets.
7. On submit-time `WORLD_CHANGED`, re-inventory only the selected backend and
   require the same instance ID. Refresh its revision and retry once under the
   original deadline.
8. Never fail over to a different renderer, Workbench lifecycle generation, or
   runtime instance during the retry.

**Required tests:**

- One runtime, one Workbench, zero candidates, and mixed ambiguous inventory.
- Targetless default-current capture.
- Explicit target remains pinned.
- Delegated same-instance world refresh succeeds on the second attempt.
- A replacement instance is refused rather than silently selected.
- A second world change is returned without another retry.
- Timeout and cancellation budgets cover inventory, optional priming, retry,
  capture, and cleanup as one operation.

### Task 2.4: Allocate capture labels atomically in the durable run store

**Files:**

- Modify: `observer/agent/runs.ts`
- Modify: `observer/agent/application-operations.ts`
- Modify: `src/observer/evidence-run-service.ts`
- Modify: `src/observer/capture-contract.ts`
- Modify: `tests/observer/runs.test.ts`
- Modify: `tests/observer/evidence-run-service.test.ts`
- Modify: `tests/observer/capture-service.test.ts`

**Design:**

1. Make `captureLabel` optional in run reservation input. `runReserveCapture`
   forwards its payload untyped, but the sibling `runFailCapture` dispatch
   pulls `captureLabel` through `requiredString`; the allocated label must be
   resolved before any failure path calls it.
2. Persist a monotonic allocation cursor in the private run record, with a
   migration/default for records created before this change.
3. Generate a normalized label from the requested view and ordinal, such as
   `current-1`, `pose-2`, or `look-at-3`, skipping collisions with manually
   supplied labels.
4. Allocate the label and append the reservation in the same synchronous
   durable run-store operation.
5. Return the actual label in capture responses, job projections, run status,
   and errors after reservation.
6. Keep explicit meaningful labels supported and keep uniqueness normalized
   within the run.

Concurrent calls, retries, and process restarts must never allocate the same
label to two semantic captures.

### Task 2.5: Add a process-local active run

**Files:**

- Modify: `src/observer/tools.ts` or extract a small
  `src/observer/active-run-context.ts`
- Modify: run and MCP tool tests

**Rules:**

1. A successful `observer_run_begin` sets `activeRunId` in the current MCP
   process. If begin calls overlap, the most recently completed successful
   begin is active.
2. Successful finalize/discard clears the active value only when operating on
   that same run.
3. MCP restart starts with no active run. Never reconstruct it by scanning
   durable open runs.
4. An explicit `runId` on capture overrides active state without implicitly
   changing it.
5. With no explicit or active run, capture is runless.
6. `captureLabel` without an explicit or active run is invalid because it has
   no retention owner.
7. `observer_run_status`, `observer_run_finalize`, and
   `observer_run_discard` may omit `runId` only when an active run exists;
   otherwise return a bounded request error.
8. The finalization review object and selected capture labels remain required.

**Required tests:**

- Begin, multiple captures, finalize without copying `runId`.
- Multiple durable open runs do not cause ambiguity when one process-local run
  is active.
- Restart loses ambient state and does not adopt an abandoned run.
- Explicit run capture does not replace active state.
- Finalizing/discarding another explicit run does not clear the active run.

### Task 2.6: Prime Workbench internally under the normal job lifecycle

Implement priming as an internal runless current-view transaction that reuses
the same restoration, artifact validation, release, and cleanup behavior as an
ordinary capture. Do not create an unreachable adapter-only job.

**Constraints:**

1. Use the outer capture's original deadline and cancellation signal.
2. Pin the prime to the same Workbench lifecycle instance selected for the
   requested pose/look-at.
3. Do not attach the prime to the active or explicit evidence run and do not
   consume a user capture label.
4. Validate the prime artifact and exact restoration proof, then auto-release
   it through the runless cleanup path.
5. Re-inventory the same Workbench instance after priming and compare its world
   before reserving the requested capture.
6. If the world changed, use the newly measured revision only under delegated
   selection; an explicit target fails `WORLD_CHANGED`.
7. If priming fails or restoration cannot be proved, fail closed and return a
   cleanup-addressable job ID when state remains retained.
8. Never submit the requested camera view until `camera.editor` is advertised
   for the exact same Workbench process.

**Required tests:**

- First pose automatically performs current prime, release, then pose.
- Later pose on the same proven process skips priming.
- Workbench restart requires a new prime.
- Prime is absent from run status and final evidence labels.
- Cancellation during prime restores/releases safely and never submits pose.
- World change during prime follows explicit/delegated binding rules.
- Restoration failure keeps lifecycle mutation blocked and exposes recovery
  information.

### Task 2.7: Update final guidance and package contracts

**Files:**

- Modify: `docs/observer.md`
- Modify: `observer/README.md`
- Modify: `agents/AGENTS.md`
- Modify: `src/setup/server-verification.ts`
- Modify: `tests/observer/package-contract.test.ts`
- Modify as needed: setup verification and release packaging checks

**Documentation examples:**

1. Ordinary screenshot: `observer_capture {}`.
2. Ambiguous inventory: select one returned `target`, then capture with it.
3. Evidence: begin, capture repeatedly without copied run IDs or labels, review
   returned images/labels, finalize with required review and selected labels.
4. Async runless capture: status/read and automatic release behavior.
5. Explicit target `WORLD_CHANGED`: inventory again and choose a new target.
6. Delegated retry: one transparent same-instance refresh only.
7. Workbench first pose: internal priming and its failure behavior.

---

## Cross-cutting validation

Run focused tests after each task, then complete the following gate before
claiming the project finished:

```powershell
npm.cmd run typecheck
npm.cmd run protocol:check
npm.cmd run observer:manifest:check
npm.cmd run observer:validate:enforce
npm.cmd run test:stage4
npm.cmd exec -- vitest run tests/observer/observer-mcp-tools-registration-runtime.test.ts tests/observer/observer-mcp-tools-schema-responses.test.ts tests/observer/observer-mcp-tools-workbench-lifecycle.test.ts tests/observer/owned-runtime-manager-recovery-authority.test.ts tests/observer/runs.test.ts tests/observer/evidence-run-service.test.ts tests/observer/retention.test.ts tests/observer/package-contract.test.ts tests/workbench/observer-adapter-submit-recovery.test.ts tests/workbench/observer-adapter-lifecycle-restoration.test.ts
npm.cmd run build
npm.cmd run test:package
```

The live Workbench acceptance is required for the helper wire change and
internal priming, but only after the hermetic and Enforce validation gates pass:

```powershell
npm.cmd run dev:observer:acceptance:workbench
```

Record the Workbench version, exact project target, observed current/pose
sequence, restoration result, and whether any manual cleanup was required.
Runtime live acceptance is required if the admission/idempotency refactor
changes runtime job submission or recovery behavior.

## Definition of done

- Public runtime lifecycle mutations survive lost responses without caller
  idempotency strings.
- Workbench compares the inventory world at submit before camera lease
  acquisition and still enforces all later binding/restoration checks.
- Target tokens replace copied session/instance/revision triples while the
  legacy path remains mutually exclusive and compatible.
- `observer_job` needs only action and job ID.
- Normal synchronous runless captures leave a durable release receipt and no
  unrecoverable backend job/artifact.
- All four run actions have independently checkable schemas.
- `observer_capture {}` succeeds only when exactly one compatible renderer is
  available and never silently changes instance on retry.
- Automatic labels are durable and collision-free.
- Ambient run state is process-local and never inferred from abandoned durable
  runs.
- Workbench priming is invisible to evidence selection but fully visible to
  cleanup and restoration recovery when it fails.
- Review, allowlist, exact-runtime ownership, and restoration-before-stop
  safety tests continue to pass.
- Registered schemas, handlers, tests, package contracts, and current operator
  guidance describe the same API.
