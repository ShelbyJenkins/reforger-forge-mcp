# Local observer failure matrix — Phase 3: Workbench matrix and closeout

**Status:** Implemented in code and hermetic tests; gated live Workbench matrix,
deliberate assertion-mutation review, and maintainer closeout outstanding
**Scope:** Disposable Workbench fault coverage, exact-identity decoy safety,
remaining behavioral-ownership work, and final maintainer acceptance.

## Relationship to the original plan

This is the final implementation-phase companion to the retained
[original failure-matrix plan](1-independent-local-observer-failure-matrix.md).
It builds on [Phase 1: shared foundations](1-independent-local-observer-failure-matrix-phase-1-foundations.md)
and the proven execution/evidence approach from
[Phase 2: runtime matrix](1-independent-local-observer-failure-matrix-phase-2-runtime.md).

The original plan remains the authority for scope, safety constraints, and
completion criteria. This document records the implemented Workbench design
and the still-open maintainer closeout.

## Objective

Prove, on a controlled Windows machine and against a newly generated Workbench
project, that every declared Workbench fault reaches its public bounded result
and leaves either a restored editor camera or an exactly verified owned-process
exit. The run must also prove that an unrelated decoy process was untouched.

## Phase-entry gate and current qualification state

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
  gives the world-loss case its bounded native target; the gated run must still
  establish that switching between them is prompt-free. Do not use a maintainer
  world, Save/Save As, generic menu execution, or UI automation.
- The local evidence root is outside the repository, and `docs/validation/`
  remains ignored. The runner may write a short-lived reviewed matrix artifact
  there, but it must not add a git exception for it.

The initial `workbench.cancel_capture.lease_acquired.pose` cancellation
checkpoint has been completed and superseded by the full implementation. The shared catalog now
contains all 69 Workbench declarations, the helper exposes all five passive
barriers, and the fixture authorizer is general rather than case-hardcoded.
That case remains useful with `--only` as a selected-case diagnostic, but it is
not the scope of Phase 3 and is not retained live proof of the full matrix.

No gated Workbench failure-matrix run has been recorded for this revision.
The implementation and hermetic contracts described below must not be read as
a claim that the 69 cases passed in Workbench or that retained images were
manually reviewed.

## Implemented repository state

- `observer/protocol/fault-matrix.ts` declares 69 canonical Workbench cases:
  3 completion, 12 cancellation, 15 handler-loss, 3 lease-contention,
  15 world-loss, 3 artifact-corruption, 15 owned-shutdown, and
  3 terminal-release replay cases.
- `EMCP_WB_ObserverCommon.c` supplies default-inert hooks for
  `before_lease`, `lease_acquired`, `capture_in_progress`,
  `restoration_in_progress`, and `terminal_release`. The generated fixture
  overrides all five and includes `RFO_WorkbenchObserverMatrixPlugin` to drain
  its capability-gated, lifecycle-bound file control channel.
- The Workbench matrix orchestration is serial. A full run uses fresh
  per-case project/profile/lifecycle/control state and publishes one full
  artifact; `--only <case-id>` runs one selected case and publishes explicit
  partial coverage. No selector preserves the five-view positive acceptance;
  `--matrix` is therefore required for the full failure matrix.
- `ObserverFailureMatrixArtifact` is schema version 3. It records full versus
  partial coverage, source commit/tree state, structured barrier, PNG/metadata,
  manifest, exact-owner, decoy, cleanup, and per-case limitation evidence.
  A full passing artifact requires a clean 40-hex commit and every declared
  backend case in canonical order.
- Repository-only acceptance composition owns one-shot real-handler transport
  loss, pre-validation PNG mutation, idempotent release replay, exact-exit
  confirmation, and exact-identity decoy comparison. These controls and their
  mutable records do not live in the production `WorkbenchObserverAdapter`.
  The shared production lifecycle seal remains a general owner-scoped shutdown
  safety primitive: it releases an unprovable capture wait only into the
  owned-shutdown path and does not claim camera restoration. Shutdown compares
  the sealed lifecycle, target, PID, executable path, and creation time before
  reservation and rechecks target and process identity immediately before
  signaling. Any mismatch returns `IDENTITY_UNVERIFIABLE`, retains the seal,
  and performs no termination call.
- `WorkbenchObserverAcceptanceRuntime` owns the shared disposable-directory,
  client, adapter, application, recovery, and process-baseline composition used
  by both positive and matrix acceptance. `WorkbenchMatrixCaseExecution` and
  `WorkbenchLiveMatrixCaseExecution` hold dispatcher and live-case state in
  named fields and split setup, execution, cleanup, and closeout into bounded
  methods; the CLI runner now coordinates those modules instead of containing
  either state machine.
- Hermetic catalog, authorizer, fixture-envelope, phase-hook, transport,
  artifact, release, decoy, exact-exit, evidence, redaction, runner, and CI
  isolation tests are present. Native Workbench execution and manual evidence
  review remain the phase-exit gate.

## Work assigned to this phase

- Add Workbench phase barriers and run every Workbench case serially, with a
  fresh preflight vacancy check for each case (original plan Task 3).
- Expand the completed cancellation checkpoint into the declared success,
  transport-loss, lease-contention, world-loss, artifact-failure, cancellation,
  owned-shutdown, and terminal-release cases.
- Reuse the existing Workbench handler, adapter, exact-owner guard, restoration
  path, PNG validators, and evidence writer. Do not add a public fault-control
  MCP tool, a general Workbench command executor, or a PID/name kill path.
- Integrate Workbench results with the shared matrix artifact and Markdown
  summary, completing the backend portion of original plan Task 4.
- Finish the source-text assertion migration table and retain only justified,
  narrow static ownership rules (remaining original plan Task 6).
- Run the final local runtime and Workbench acceptance commands, review the
  temporary artifacts, and complete the documented local-evidence closeout
  (original plan Task 7). This final item remains outstanding.

## Not in this phase

- Making live acceptance part of `npm test` or GitHub Actions.
- Parallel Workbench execution, reuse of a pre-existing user process, project,
  world, endpoint, or profile.
- UI-driven project switching. If a headless project-switch mechanism cannot be
  proven safe, do not invent one; model the real world-loss case separately and
  cover process/project loss through the exact-owned shutdown cases.
- Retaining validation artifacts in git history.

## Implementation sequence

### 1. Fixture-only Workbench barriers

The non-shipped fixture lives under
`tests/fixtures/workbench-observer-failure-matrix-addon/`. Its Workbench plugin
is `RFO_WorkbenchObserverMatrixPlugin` and is staged only
inside the generated project/profile of the live matrix harness. It must not be
listed in `package.json` `files`, added to the production helper payload, or
registered as an MCP tool or a `NetApiHandler`.

`createDisposableProject()` in
`scripts/run-workbench-observer-acceptance.ts` copies the fixture source and
generates both disposable worlds. The harness's `spawnProcess` override appends
only the fixed fixture plugin argument for matrix runs, retains the current
`-forceUpdate` behavior, and records the redacted launch-argument identity.
The fixture source participates in `WORKBENCH_OPERATIONAL_BASELINE_SOURCES`
and the matrix source hash.

The plugin is an observer, not a command surface. It may receive a passive
phase notification from the helper and exchange files only beneath its own
generated `$profile:RFOWorkbenchObserverMatrix/` directory. The production
helper must retain exactly its five observer NET API handlers:
`Ping`, `Submit`, `Status`, `Cancel`, and `Release`.

`EMCP_WB_ObserverCommon.c` exposes five protected passive hooks at the following
product-observable boundaries, not source-line labels:

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

The implemented Phase 1 control envelope carries `schemaVersion`, `runId`,
request and case IDs, phase/action, and the generated fixture/lifecycle
binding. The random capability and monotonic sequence are authenticated in
the new-file mailbox name before command parsing; the bootstrap binds the
generated project/add-on identities, and arrival binds the retained job where
the phase has one. The plugin rejects a wrong capability before parsing, then
rejects a wrong run, fixture/lifecycle binding, phase/action pair, sequence,
replay, or post-terminal command. Acknowledgements contain only the bounded
control disposition, request/case/phase identity, and a bounded refusal reason.
The capability, owner token, absolute profile path, PID, and raw handler
arguments must never enter matrix evidence.

At `before_lease`, authenticated Ping arrival proves the lifecycle, case, phase,
and absence of a retained job; the declared view is instead host-bound by the
validated capture input. The fixture retains a one-shot expected view/lifecycle
tuple and rejects a later Submit that does not match it. Submit is intentionally
optional because world replacement, Ping response loss, and owned shutdown may
terminate the case before any handler Submit.

The runner waits for an `arrived` acknowledgement with `pollUntil` and a
per-case deadline, performs exactly one matrix action, then waits for an
`executed` or `refused` acknowledgement before resuming the fixture. A timeout
or cancellation invalidates the barrier, calls the existing restoration path,
and makes the case fail; do not use `setTimeout`/sleep as phase coordination.

### 2. Serial, resettable Workbench runner

The matrix path uses a per-case executor while preserving the separate
positive-path behavior of `runWorkbenchObserverAcceptance()`. With no selector,
the CLI runs that positive acceptance. `--matrix` selects all 69 Workbench cases
in canonical order and emits full coverage; `--only <case-id>` selects one
Workbench case and emits partial coverage. The two selectors are mutually
exclusive and validate before process launch. `--keep-profile` is legal only
with `--only`; it retains and prints that case's generated directory only when
the selected case fails, without putting the path in the Markdown summary.
`--list-cases` and `--help` are standalone read-only modes and require neither
live confirmation. Both executing matrix modes require the existing environment
gate and `--confirm-live-run`.

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

The shared `backend: "workbench"` catalog now contains these 69 lower-case,
dotted public IDs. `lookAt` is serialized as `lookat` in an ID. The fixture
implements all five phase hooks, while each case schedules only the applicable
phase/view combinations below; all other combinations are rejected.

| ID pattern | Count | Action and required terminal/camera proof |
| --- | ---: | --- |
| `workbench.complete_capture.terminal_release.{current\|pose\|lookat}` | 3 | Complete a real capture; `completed`, validated PNG/metadata, exact restoration, release, and vacancy. |
| `workbench.cancel_capture.{lease_acquired\|capture_in_progress\|restoration_in_progress\|terminal_release}.{current\|pose\|lookat}` | 12 | Cancel through `ObserverApplication.cancelJob`; `cancelled` with no asynchronous error and exact restoration. |
| `workbench.disable_fixture_handler.{phase}.{current\|pose\|lookat}` | 15 | The one-shot transport seam breaks a selected real handler request/response; public `TRANSPORT_UNAVAILABLE`, with `not_acquired` before lease, exact owned exit during the three held/restoring phases, and already-proven restoration at `terminal_release`. |
| `workbench.submit_competing_capture.lease_acquired.{current\|pose\|lookat}` | 3 | Overlap a second application capture; public `CAMERA_BUSY`, unchanged first lease, restoration, and a successful follow-up acquisition. |
| `workbench.replace_fixture_world.{phase}.{current\|pose\|lookat}` | 15 | Open generated `ObserverMatrixB`; before lease reports `WORLD_CHANGED`/`not_acquired`; the three held/restoring phases report `RESTORATION_UNCONFIRMED` and require exact owned exit; `terminal_release` remains `completed`/restored. |
| `workbench.{write_truncated_artifact\|write_crc_artifact\|write_mismatched_artifact}.capture_in_progress.pose` | 3 | Mutate the real bounded PNG immediately before validation; public `ARTIFACT_INVALID`, proven restoration, and no published managed manifest for the rejected capture. |
| `workbench.stop_owned_workbench.{phase}.{current\|pose\|lookat}` | 15 | Call owner-scoped shutdown and verify exact owner/endpoint/child vacancy plus unchanged decoy identity. Before terminal release the public result is `WORKBENCH_EXITED` with exact exit; at `terminal_release` the capture remains `completed`/restored before shutdown. |
| `workbench.release_twice.terminal_release.{current\|pose\|lookat}` | 3 | Replay the identical frozen release request; equivalent idempotent acknowledgements after restoration and no camera mutation. |

The transport family uses the existing `WorkbenchNetApiPort` dependency seam
in the session controller and routes every non-faulted call to a real
`WorkbenchNetApiClient`. The seam is scoped to the per-case fixture and
disabled by default; it is not a production configuration setting.

For the world-loss family, the helper's public projection no longer uses the
private `CAPTURE_INVALIDATED` spelling. A pre-lease replacement declares
canonical `WORLD_CHANGED`. At `lease_acquired`, `capture_in_progress`, or
`restoration_in_progress`, inability to restore against the changed world
declares `RESTORATION_UNCONFIRMED` and enters the exact-owner-exit path. At
`terminal_release`, restoration and completion are already proven, so replacing
the fixture world cannot retroactively turn that capture into a restoration
failure. The gated native run must still prove that opening the second generated
world is prompt-free; hermetic projection tests alone do not establish that
Workbench behavior.

The `restoration_in_progress` barrier needs a real yield between setting the
state and calling `RestoreJob`; a probe that merely observes the terminal state
after synchronous restoration does not satisfy the phase. The barrier must
continue to use the helper's normal `RestoreJob`, `Cancel`, and `Release`
paths once released.

### 4. Exact-identity decoy protection

The fixture-only long-lived Node decoy exits only when its own generated exit
sentinel appears. It starts with a unique owner argument, but its identity is
never passed to `WorkbenchProcessGuard` as a termination target.

For every `workbench.stop_owned_workbench.{phase}.{view}` case:

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

`OperationalBaselineArtifact` remains version 1 and readable by its existing
tests. The separate `ObserverFailureMatrixArtifact` writer beside
`writeOperationalBaselineArtifact` is now version 3 and reuses the baseline's
canonical source closure, redaction, atomic write, and evaluator-identity
conventions.

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

Version 3 also records explicit `coverage`. A full artifact selects all
declared backend IDs in canonical order; `--only` produces a partial artifact
whose selected IDs and rows match exactly. `sourceRevision` records the commit
and `clean`, `dirty`, or `unavailable` tree state. A full passing artifact is
invalid unless the tree is clean and the commit is a 40-hex Git revision.

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

Adversarial redaction tests use real-looking Windows home paths, PIDs, owner
tokens, profile paths, and control capabilities and inspect serialized JSON and
Markdown rather than only the in-memory object.

### 6. Source-text checks remain until behavior owns the invariant

The committed migration table in this document's directory governs removal of
any source-text assertion. Each row names the assertion location, protected
invariant, behavioral replacement, deliberate mutation, command run, observed
failure, disposition (`replace` or `retain`), and a non-observability rationale
when retained.

The active table is
[the assertion migration ledger](1-independent-local-observer-failure-matrix-assertion-migration.md).
Rows whose native mutation is still gated by live acceptance remain explicitly marked
`Retain`; they are not silently treated as behaviorally replaced.
The current ledger is therefore a retention inventory, not a completed
migration: it records 22 retained groups and zero behavioral replacements or
deletions. Retained checks were retargeted where ownership moved, but that
receives no migration credit. Task 6 remains open unless deliberate
mutation evidence changes a disposition or the maintainer explicitly accepts a
retention-only closeout.

The ledger begins with these concrete groups:

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
process, run the currently declared runtime pilot and complete Workbench matrix
one at a time after all hermetic tests and package checks pass:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm.cmd run dev:observer:acceptance:runtime -- --only runtime.cancel_capture.lease_acquired.pose --confirm-live-run

$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
npm.cmd run dev:observer:acceptance:workbench -- --matrix --confirm-live-run
```

Review the runtime-pilot and Workbench-matrix JSON and Markdown together. They
must name the same committed source revision, and each must retain its own
backend source-closure hash and procedure revision. If either source or
procedure changes between runs, rerun both. Inspect every retained
output image relevant to a successful capture and record the reviewer result
truthfully. A passed review must not inherit `imagesReviewed=true` from
automation alone.

The Workbench command prints
`RFO_WORKBENCH_OBSERVER_FAILURE_MATRIX_REVIEW_DIRECTORY=<path>` after copying
successful completed-case bundles out of their disposable case roots. Review
every image beneath that exact directory at original resolution. The runner
deliberately neither marks those images reviewed nor deletes this directory;
retain it through the review and include that exact printed directory in the
targeted cleanup below.

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

**Current result:** not satisfied. The catalog, fixture, runner, repository-only
acceptance instrumentation, evidence schema, and hermetic contracts are
implemented, but the gated full Workbench matrix, retained revision-bound
evidence, deliberate assertion-mutation review, cross-backend review, and
manual image review have not been completed.

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
