# Local observer failure matrix — Phase 3: Workbench matrix and closeout

**Status:** Implementation-ready plan  
**Scope:** Disposable Workbench fault coverage, exact-identity decoy safety,
remaining behavioral-ownership work, and final maintainer acceptance.

## Relationship to the original plan

This is the final implementation-phase companion to the retained
[original failure-matrix plan](1-independent-local-observer-failure-matrix.md).
It builds on [Phase 1: shared foundations](1-independent-local-observer-failure-matrix-phase-1-foundations.md)
and the proven execution/evidence approach from
[Phase 2: runtime matrix](1-independent-local-observer-failure-matrix-phase-2-runtime.md).

The original plan remains the authority for scope, safety constraints, and
completion criteria. This document only turns its Workbench and closeout work
into ordered repository changes; do not edit or replace the original plan as
part of this phase.

## Objective

Prove, on a controlled Windows machine and against a newly generated Workbench
project, that every declared Workbench fault reaches its public bounded result
and leaves either a restored editor camera or an exactly verified owned-process
exit. The run must also prove that an unrelated decoy process was untouched.

## Phase-entry gate

Do not start a live Workbench case until Phase 1 has supplied the shared matrix
definition, scheduler, capability-gated barrier contract, redaction policy,
and matrix-artifact schema. The Workbench runner must consume those exports; it
must not redefine phases, case IDs, public errors, or artifact fields locally.

Before the first case, confirm all of the following:

- The current positive-path command still passes:

  ```powershell
  $env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
  npm.cmd run dev:observer:acceptance:workbench -- --confirm-live-run
  ```

- `scripts/run-workbench-observer-acceptance.ts` still launches a new project
  under its per-run directory, uses a new `WorkbenchProcessGuard`, and rejects
  any pre-existing Arma Reforger or Workbench process through
  `assertNoArmaOrWorkbench()`.
- The generated fixture owns two blank worlds, `ObserverMatrixA` and
  `ObserverMatrixB`. They are the only resources a fault case may open. This
  gives the world-loss case a headless, prompt-free target; do not use a
  maintainer world, Save/Save As, generic menu execution, or UI automation.
- The local evidence root is outside the repository, and `docs/validation/`
  remains ignored. The runner may write a short-lived reviewed matrix artifact
  there, but it must not add a git exception for it.

Begin with one vertical slice before implementing the full table:
`WB-CANCEL-LEASE-ACQUIRED-POSE`. It must launch the disposable project, prove
the `lease_acquired` barrier from observable job state, cancel through
`ObserverApplication.cancelJob`, observe `cancelled`/`CANCELLED` with
`cameraLeaseHeld=false` and `restorationConfirmed=true`, release the job, run a
follow-up current capture, and establish Workbench/endpoint/process vacancy.
Record the measured launch, case, and cleanup time. Do not expand the case
inventory until this slice works without timing sleeps.

## Work assigned to this phase

- Add Workbench phase barriers and run every Workbench case serially, with a
  fresh preflight vacancy check for each case (original plan Task 3).
- Start with the vertical slice above, then add the declared success,
  transport-loss, lease-contention, world-loss, artifact-failure, cancellation,
  and exact-owned-shutdown cases.
- Reuse the existing Workbench handler, adapter, exact-owner guard, restoration
  path, PNG validators, and evidence writer. Do not add a public fault-control
  MCP tool, a general Workbench command executor, or a PID/name kill path.
- Integrate Workbench results with the shared matrix artifact and Markdown
  summary, completing the backend portion of original plan Task 4.
- Finish the source-text assertion migration table and retain only justified,
  narrow static ownership rules (remaining original plan Task 6).
- Run the final local runtime and Workbench acceptance commands, review the
  temporary artifacts, and complete the documented local-evidence closeout
  (original plan Task 7).

## Not in this phase

- Making live acceptance part of `npm test` or GitHub Actions.
- Parallel Workbench execution, reuse of a pre-existing user process, project,
  world, endpoint, or profile.
- UI-driven project switching. If a headless project-switch mechanism cannot be
  proven safe, do not invent one; model the real world-loss case separately and
  cover process/project loss through the exact-owned shutdown cases.
- Retaining validation artifacts in git history.

## Implementation sequence

### 1. Add a fixture-only Workbench barrier

Create a non-shipped fixture under
`tests/fixtures/workbench-observer-failure-matrix-addon/`. Its Workbench plugin
should be named `RFO_WorkbenchObserverMatrixPlugin` and must be staged only
inside the generated project/profile of the live matrix harness. It must not be
listed in `package.json` `files`, added to the production helper payload, or
registered as an MCP tool or a `NetApiHandler`.

Extend `createDisposableProject()` in
`scripts/run-workbench-observer-acceptance.ts` to copy the fixture source and
generate both disposable worlds. Extend that harness's existing `spawnProcess`
override to append only the fixed fixture plugin argument for matrix runs; keep
the current `-forceUpdate` behavior and record the redacted launch-argument
identity. Add the fixture source to `WORKBENCH_OPERATIONAL_BASELINE_SOURCES`
and its source closure to the matrix source hash.

The plugin is an observer, not a command surface. It may receive a passive
phase notification from the helper and exchange files only beneath its own
generated `$profile:RFOWorkbenchObserverMatrix/` directory. The production
helper must retain exactly its five observer NET API handlers:
`Ping`, `Submit`, `Status`, `Cancel`, and `Release`.

Add the smallest passive phase hook needed in
`EMCP_WB_ObserverCommon.c`. It must publish the following product-observable
boundaries, not source-line labels:

| Matrix phase | Proof supplied by the helper |
| --- | --- |
| `before_lease` | A probe is armed before `Submit`; no job is retained and no camera state has been written. |
| `lease_acquired` | The job is retained and reports `cameraLeaseHeld=true` before screenshot issuance. |
| `capture_in_progress` | `System.MakeScreenshot` has succeeded and the job reports `capturing` or `awaiting_artifact`. |
| `restoration_in_progress` | The job reports `restoring` after artifact readiness but before `RestoreJob` completes. |
| `terminal_release` | A terminal status has `cameraLeaseHeld=false` and `restorationConfirmed=true`, before `Release` disposes the artifact/reference. |

The hook may block only while the fixture's authenticated barrier is pending.
With no staged fixture it must be absent/inert and have no behavior change.
It must never evaluate caller-provided Enforce, execute a Workbench action, or
accept an unbounded filename, path, or command.

Use the Phase 1 control-envelope shape. Each command and acknowledgement must
include `schemaVersion`, `runId`, random capability, case ID, lifecycle
generation, canonical target, job ID, phase, action, and a monotonic sequence.
The plugin must reject a wrong capability before parsing the rest of a command,
then reject a wrong run, target, generation, phase/action pair, sequence,
replay, or post-terminal command. An acknowledgement records only
`executed` or `refused`, the public phase, and a bounded redacted diagnostic.
The capability, owner token, absolute profile path, PID, and raw handler
arguments must never enter matrix evidence.

The runner waits for an `arrived` acknowledgement with `pollUntil` and a
per-case deadline, performs exactly one matrix action, then waits for an
`executed` or `refused` acknowledgement before resuming the fixture. A timeout
or cancellation invalidates the barrier, calls the existing restoration path,
and makes the case fail; do not use `setTimeout`/sleep as phase coordination.

### 2. Keep the Workbench runner serial and resettable

Refactor the positive-path body of
`runWorkbenchObserverAcceptance()` into a per-case executor. Add
`--only <case-id>` and `--keep-profile` to the existing CLI, plus matching
typed options. `--only` validates against the shared matrix before a Workbench
launch; `--keep-profile` is permitted only after a failed matrix run and must
print the retained generated directory without putting it in the Markdown
summary.

For every case, in this order:

1. Re-run `assertNoArmaOrWorkbench()` and `guard.assertNoWorkbenchProcesses()`.
   Verify the configured loopback endpoint is vacant before launch.
2. Generate a fresh project, managed root, lifecycle directory, profile, and
   fixture capability. Never reuse the previous case's Workbench process or
   control files.
3. Launch through `WorkbenchClient.ensureRunning`, open only
   `ObserverMatrixA`, and wait for one renderer with `render.capture`.
4. Start a managed observer run, submit the declared view, wait for the exact
   phase acknowledgement, and record the public job result before reading
   internal diagnostics.
5. Apply one action, wait for its bounded public terminal result, then perform
   the case's follow-up probe. Examples are a current capture after confirmed
   restoration, a second capture after a `CAMERA_BUSY` refusal, or a status
   query proving the old world/lease cannot be reused.
6. In `finally`, call `adapter.restoreAll()`, `application.close()`, and
   `client.shutdownOwnedWorkbench()` through the existing exact-owner path.
   Retain the existing recovery client only as its documented same-guard
   fallback.
7. Prove: no retained camera lease, no managed observer child, no owned
   Workbench, and a vacant configured endpoint. A missing restoration proof
   requires a failed result and exact owned exit; it is never a pass-by-exit.

The matrix runner must make lifecycle calls only through `WorkbenchClient` and
`WorkbenchProcessGuard`. It must not call `taskkill`, `Stop-Process`,
`KillProcess`, `child.kill()` against Workbench, or scan by process name to
choose a shutdown target.

### 3. Implement the Workbench case table

Define these cases in the shared `backend: "workbench"` fault matrix. Use the
case IDs below as the stable public IDs; expand only the phase/view combinations
that have the observable proof in the first table. A matrix entry that cannot
reach a phase must declare it `not_applicable`; silently skipping it is invalid.

| ID pattern | Action and implementation | Required terminal/camera proof |
| --- | --- | --- |
| `WB-SUCCESS-{CURRENT\|POSE\|LOOK_AT}` | Reuse the existing `captureAndRetain` flows. Keep the current/pose/look-at PNG, requested-view, camera-restoration, and post-restoration-current assertions. | `completed`; valid PNG and metadata; exact restoration; release and vacancy. |
| `WB-CANCEL-{PHASE}-{VIEW}` | At the acknowledged barrier, invoke `ObserverApplication.cancelJob`; do not call a handler directly. | `cancelled` with `CANCELLED` and exact restoration, or failed `RESTORATION_UNCONFIRMED` followed by exact owned exit. |
| `WB-TRANSPORT-LOSS-{PHASE}-{VIEW}` | Use a fixture-only `WorkbenchNetApiPort` fault wrapper around the real NET API client. It must break the selected real handler call/response after the barrier; it must not synthesize an adapter response. | Bounded `HANDLER_UNAVAILABLE`/public transport disposition; no claim of restoration unless it was observed. If a held lease cannot be queried safely, require exact owned exit. |
| `WB-LEASE-CONTENTION-{VIEW}` | Submit one capture and retain its activity lease. Submit the second capture through `ObserverApplication.capture` before releasing the first. | The second request returns public `CAMERA_BUSY`; the first job's camera state is unchanged; then cancel/complete and prove a follow-up capture can acquire the lease. |
| `WB-WORLD-LOSS-{PHASE}-{VIEW}` | At the barrier, call the existing `EMCP_WB_EditorControl.openResource` only for generated `ObserverMatrixB`. Verify it changes the world identity without a modal prompt. | Before lease: `not_acquired`. After lease: public `WORLD_CHANGED` or `STALE_LIFECYCLE`; if exact restoration cannot be proven, require `RESTORATION_UNCONFIRMED` and exact owned exit. |
| `WB-ARTIFACT-{TRUNCATED\|CRC\|MISMATCHED}` | Use a harness-only pre-promotion seam after handler terminal restoration and before `WorkbenchObserverAdapter.validateArtifact`. Truncate the generated PNG, corrupt one CRC, or change its byte length. Do not fake a completed artifact. | Public `ARTIFACT_INVALID`; helper restoration remains proven; no capture is promoted or included in an evidence-bundle manifest. |
| `WB-OWNED-SHUTDOWN-{PHASE}-{VIEW}` | At the barrier invoke `client.shutdownOwnedWorkbench()` through its normal activity-gate/adapter bookkeeping. | Public `WORKBENCH_EXITED` or the declared cancellation result, exact owner vacancy, endpoint vacancy, no child/lease obligation, and decoy identity unchanged. |
| `WB-TERMINAL-RELEASE-{VIEW}` | Hold at `terminal_release`, release once, then retry the identical release. | First release removes the managed artifact/reference only after restoration; second release is idempotently acknowledged; no camera mutation. |

For the transport family, use the existing `WorkbenchNetApiPort` dependency
seam in the session controller, but route all non-faulted calls to a real
`WorkbenchNetApiClient`. The test seam must be scoped to the per-case fixture
and disabled by default; it is not a production configuration setting.

For the world-loss family, update the helper's public projection so a changed
world produces canonical `WORLD_CHANGED`, while a lifecycle/target mismatch
produces `STALE_LIFECYCLE`. Do not retain the private
`CAPTURE_INVALIDATED` spelling as a matrix expectation. If opening the second
generated world causes a modal dialog or cannot be made headless, stop this
family at the spike, record the limitation, and do not misrepresent a fake
adapter failure as world loss.

The `restoration_in_progress` barrier needs a real yield between setting the
state and calling `RestoreJob`; a probe that merely observes the terminal state
after synchronous restoration does not satisfy the phase. The barrier must
continue to use the helper's normal `RestoreJob`, `Cancel`, and `Release`
paths once released.

### 4. Add exact-identity decoy protection

Create a small, fixture-only long-lived Node decoy that exits only when its
own generated exit sentinel appears. Launch it with a unique owner argument,
but never pass its identity to `WorkbenchProcessGuard` as a termination target.

For every `WB-OWNED-SHUTDOWN-*` case:

1. Inspect the decoy through the existing Windows exact-process backend before
   triggering shutdown. Retain its `ExactProcessIdentity` and require the
   unique owner argument to match.
2. Trigger only `client.shutdownOwnedWorkbench()` for the Workbench process.
   Do not call an OS termination API from the harness.
3. Inspect the decoy again after owned Workbench and endpoint vacancy are
   proven. Assert the process is still present, its executable path and exact
   creation time equal the pre-case values, and its owner argument still
   matches. PID equality or process-name liveness alone is insufficient.
4. Only after the assertion, create the decoy's own exit sentinel and wait for
   its normal exit. Failure to prove the decoy identity is a failed case and
   leaves the decoy running for manual recovery rather than risking a broad
   termination.

Redact the decoy PID, executable path, owner argument, and creation time from
the artifact. Evidence records only `identityUnchanged: true|false` and the
inspection/result category.

### 5. Make evidence matrix-aware

Keep `OperationalBaselineArtifact` v1 readable by its existing tests. Add the
Phase 1 matrix-artifact type and writer path beside
`writeOperationalBaselineArtifact` in
`scripts/observer-live-acceptance-support.ts`; reuse its canonical source
closure, redaction, atomic write, and evaluator-identity conventions instead
of creating a second ad hoc serializer.

Each Workbench case entry must contain:

- stable case ID, backend, view, schedule, declared phase/action, and bounded
  deadline outcome;
- public terminal state/error captured before internal diagnostics;
- world/lifecycle disposition and camera disposition;
- PNG/metadata validation outcome and retained hash values, never image bytes
  or raw filesystem locations;
- barrier acknowledgement result, exact-owner shutdown result when applicable,
  decoy result when applicable, child/process/endpoint vacancy, and retained
  diagnostic hashes; and
- the shared source-closure hash, procedure revision, and sanitized evaluator
  identity for the run.

Write a sibling Markdown summary after all case cleanup and before publishing
the final JSON artifact. Its table should contain case ID, declared fault,
public result, camera/exit result, artifact result, vacancy, and limitations.
It must also state the Workbench version, reviewed source revision, source
closure hash, and whether images were manually reviewed. Do not include paths,
PIDs, tokens, raw arguments, credentials, or image pixels.

Use this publication rule:

1. Per-case raw working material remains beneath the generated external run
   directory.
2. A passing managed evidence-bundle manifest is written only after every
   included capture has passed validation. An artifact-injection case must call
   `discard`, not `finalizeRun`, for the invalid capture.
3. After all cleanup has completed, atomically publish one matrix JSON/Markdown
   pair. A failed pair is allowed for diagnosis but must be marked `failed`,
   set `manifestPublished=false` when a bundle was not valid, and never be
   presented as passing evidence.
4. Schema tests must reject missing or duplicate cases, a passing result with a
   failed case, a camera/exit contradiction, a manifest before valid metadata,
   unredacted identity data, and raw Windows-style paths or capability values.

Add adversarial redaction tests using real-looking Windows home paths, PIDs,
owner tokens, profile paths, and control capabilities. Test the serialized JSON
and Markdown rather than only the in-memory object.

### 6. Replace source-text checks only when behavior owns the invariant

Add a committed migration table in this document's directory before removing a
source-text assertion. Each row must name the assertion location, protected
invariant, behavioral replacement, deliberate mutation, command run, observed
failure, disposition (`replace` or `retain`), and a non-observability rationale
when retained.

Start the table with these concrete groups:

| Current location | First classification | Required action |
| --- | --- | --- |
| `tests/workbench/observer-handler-contract.test.ts` handler inventory and ban on generic editor execution | Retain as narrow static ownership/package checks. | Keep the five-handler inventory and the `ExecuteAction`/`RunCmd`/`RunProcess` ban because exposing the forbidden surface is not safely observable at runtime. Reduce only duplicated literal checks after an AST/package-level rule covers the same invariant. |
| `tests/workbench/observer-handler-contract.test.ts` camera snapshot, restore, binding, and idempotency literals | Candidate behavioral replacement. | Add hermetic adapter/fixture tests plus the live matrix cases. Temporarily break one protected operation at a time (for example, skip `RestoreJob`, omit generation binding, or remove release-receipt matching), run the replacement test, and record the observed failure before deleting the literal assertion. |
| `tests/workbench/observer-live-acceptance-contract.test.ts` source-string checks | Split by invariant. | Replace source-presence assertions with exported option/argument/evidence behavior tests where possible. Retain only the local-live gate and no-global-kill ownership rule if it cannot be proven without running a real graphical process. |
| `tests/observer/runtime-camera-restoration-contract.test.ts` and `tests/observer/runtime-live-acceptance-contract.test.ts` | Phase 2 must supply the behavior first. | Do not delete any row until Phase 2 records its fault mutation proof; Phase 3 only closes the table. |
| `tests/observer/package-contract.test.ts` | Mostly artifact integrity, not source text. | Keep manifest, package-file, `.gitattributes`, published-file, and generated-payload assertions. Classify each individual `toContain` before changing it; do not remove the whole test body. |

Run the targeted hermetic suite after each migration row, then the normal suite.
At minimum add tests for the Workbench matrix scheduler, fixture-envelope
rejection, phase-to-product-state mapping, transport wrapper, world-loss
projection, artifact pre-promotion hook, decoy comparison, artifact redaction,
and manifest-last publication. The tests must run without Arma Reforger Tools
and must assert that neither live-run environment variable is set in CI.

### 7. Final maintainer acceptance and closeout

On a controlled Windows machine, with no pre-existing Arma or Workbench
process, run the complete matrices one at a time after all hermetic tests and
package checks pass:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm.cmd run dev:observer:acceptance:runtime -- --confirm-live-run

$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
npm.cmd run dev:observer:acceptance:workbench -- --confirm-live-run
```

Review the runtime and Workbench JSON and Markdown together. They must name the
same committed source revision and source-closure hash; if either source or
procedure changes between runs, rerun both matrices. Inspect every retained
output image relevant to a successful capture and record the reviewer result
truthfully. A passed review must not inherit `imagesReviewed=true` from
automation alone.

Before deleting local evidence, retain a short PR/review note containing the
committed revision, both source-closure hashes, Workbench version, case-table
outcomes, any `not_applicable` declarations, reviewer identity convention, and
known limitations. Do not copy raw JSON, raw logs, paths, PIDs, credentials, or
capabilities into that note.

Delete only the exact JSON, Markdown, and generated run directories named by
the reviewed results; do not recursively clear `docs/validation/`, which may
contain another maintainer's ignored work. Confirm that the removed paths are
gone, `git status --short` contains no newly tracked validation output, and a
fresh run does not recreate evidence unless its explicit live gate is set.

## Phase exit criteria

- Every declared Workbench case has a bounded, public terminal result and
  sanitised evidence of cleanup, restoration or exact exit, and final vacancy.
- Every owned-shutdown case proves the decoy's exact identity is unchanged;
  no result relies on PID or process-name matching.
- The Workbench fixture control surface is generated, capability-gated,
  lifecycle-bound, one-shot, and absent from the public MCP and production
  helper handler inventories.
- Both backend matrices pass for the same reviewed revision without adding
  live tooling or environment gates to ordinary CI.
- The assertion migration table has no unclassified deletion, and every
  retained static rule has a specific non-observability rationale.
- Review records retain the case table, revision, and source-closure hash;
  temporary local validation artifacts are deleted after review.
