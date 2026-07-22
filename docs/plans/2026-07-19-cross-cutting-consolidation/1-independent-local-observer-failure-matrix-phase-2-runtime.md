# Local observer failure matrix — Phase 2: runtime matrix

**Status:** Planned implementation document  
**Scope:** Disposable graphical-runtime instrumentation, runtime fault cases,
runtime evidence integration, and runtime behavioral-ownership migration.

## Relationship to the original plan

This is the runtime implementation-phase companion to the retained
[original failure-matrix plan](1-independent-local-observer-failure-matrix.md).
It assumes [Phase 1: shared foundations](1-independent-local-observer-failure-matrix-phase-1-foundations.md)
has established the matrix, control-channel, evidence, and hermetic-test
contracts.

## Objective

Prove, against a disposable real runtime fixture, that each declared runtime
fault reaches a bounded public terminal state while leaving no unsafe camera,
process, transport, child-process, or endpoint obligation behind.

## Work assigned to this phase

- Instrument the disposable runtime fixture with real phase barriers; never
  use timing sleeps as synchronization (original plan Task 2).
- Deliver a small end-to-end pilot first, preferably the cancellation family,
  including public-result capture and matrix-aware evidence. Measure the
  launch and per-case time before committing to the full inventory.
- Implement the declared runtime cases: positive path, cancellation, world
  loss, agent/transport loss, and owned shutdown across applicable phases and
  capture views.
- Reuse `OwnedRuntimeManager`, `PRIVATE_CHILD_PATH`, exact-process identity,
  and existing operational-baseline/vacancy helpers rather than implementing
  direct-kill or PID-only alternatives.
- Integrate runtime case results with the shared artifact writer and summary.
- Replace or retain runtime source-text assertions only after mutation-proven
  behavioral coverage exists (runtime portion of original plan Task 6).
- Keep ordinary CI tool-free while adding the runtime-specific hermetic tests
  needed to validate new scheduling and evidence behavior.

## Not in this phase

- Workbench-specific fixture controls, fault cases, and serial launch policy.
- Final combined maintainer acceptance for both backends.
- Shared protocol, authorization, or artifact-schema redesign; return such
  issues to Phase 1 unless the shared contract genuinely needs revision.

## Implementation instructions

### Prerequisite gate and source layout

Start this phase only after Phase 1 exposes all of the following as imported,
tested contracts:

- the validated runtime case declarations and lookup by case ID;
- the one-shot control command, acknowledgement, barrier, and redaction
  types;
- the bounded polling/deadline helper; and
- the failure-matrix JSON and Markdown writers.

Do not define another runtime-local action schema, evidence schema, timer
helper, or token redactor. If one of those Phase 1 exports is missing, add the
missing shared capability in Phase 1 first and return here after it is tested.

Keep the implementation split as follows:

| Location | Responsibility |
| --- | --- |
| observer/protocol/fault-matrix.ts | The Phase 1-owned runtime declarations, public-result expectations, and supported/unsupported scheduling validation. |
| scripts/observer-runtime-failure-matrix.ts | Runtime-only orchestration: fixture preparation, barrier wait, action dispatch, public-result capture, follow-up probes, and conversion to the shared evidence entry. |
| scripts/run-runtime-observer-acceptance.ts | CLI and live-run authorization. Preserve the exported runRuntimeObserverAcceptance entry point, but delegate matrix execution to the runtime runner instead of growing another monolithic capture sequence. |
| tests/fixtures/runtime-observer-failure-matrix-addon/ | A distinct, disposable acceptance add-on. It owns only the fixture controller and barrier hooks; it must not duplicate the production observer add-on. |
| tests/fixtures/runtime-observer-failure-matrix-addon/Scripts/Game/ReforgerForgeObserver/RFO_RuntimeMatrixControl.c | Capability-gated fixture controller. It emits phase acknowledgements and performs only the declared fixture actions. |
| scripts/observer-live-acceptance-support.ts | Continue to own OperationalBaselineRecorder, PNG inspection, blocking-process inspection, supervised-child vacancy waits, and baseline source closure identity. Extend it only through the shared Phase 1 artifact APIs. |

The fixture add-on must have its own add-on identity and be copied to a new
directory under the external run directory for each live run. It may extend
the installed observer service, but it must not replace or modify
observer/addon in place. The runtime continues to use the normal observer
source through sourceAddon: OBSERVER_SOURCE_PATH; launch arguments add only
the generated fixture's add-on directory and GUID. The full fixture template
digest and the copied fixture digest belong in the source closure evidence.

The matrix command must reject a user-selected fixture directory. Retain the
existing --addon-dir option only for the legacy positive-path compatibility
mode until that mode is retired; matrix mode always creates and validates its
own fixture. Do not publish the fixture add-on, its control protocol, or a
fault command through an MCP tool, package files list, normal add-on
configuration, or a production observer capability.

### Pilot, launch topology, and time budget

Implement exactly one end-to-end pilot before adding the remaining fault
families:

- case ID: RFO-RUNTIME-CANCEL-LEASE-ACQUIRED-POSE;
- view: the existing explicit pose view;
- barrier: lease_acquired;
- action: application.cancelJob for the selected public job;
- expected asynchronous public job result: state `cancelled` with no
  `errorCode` (the backend and host job projection publish an error code only
  for `failed`);
- required camera result: the lease reports everHeld true, held false, and
  restorationConfirmed true; and
- final result: the normal exact-owned shutdown and supervised-process
  vacancy checks still pass.

The pilot is complete only after the result contains a barrier acknowledgement,
the public terminal result captured before fixture diagnostics, the
post-cancellation camera proof, and a matrix artifact entry. A cancellation
that merely causes the harness timeout is not a pilot pass.

Use the current positive-path launch as the shared runtime for the three
success cases and the five cancellation cases. Run these sequentially only
after each case has a terminal job with no restoration obligation and its
managed artifact has been released or discarded. Start a new runtime for
every world-loss, agent/transport-loss, and owned-shutdown case. Those
families deliberately destroy an identity or communication assumption, so
reusing their process would make the next case's proof ambiguous.

This produces one initial launch plus fifteen destructive-case launches:

| Run group | Cases | Runtime launches |
| --- | ---: | ---: |
| Success | current, pose, look-at | 1 shared |
| Cancellation | five canonical phases | 0 additional when each case proves restoration |
| World loss | five canonical phases | 5 |
| Agent/transport loss | five canonical phases | 5 |
| Owned shutdown | five canonical phases | 5 |

After a world/transport follow-up capture, the proven-healthy replacement
runtime may serve as the next destructive case's fresh runtime. It still
counts as that next case's launch and must be stopped after that case; do not
start an extra probe-only process.

Record at least these measurements in the pilot and every subsequent matrix
run: setup, OwnedRuntimeManager start-to-running, instance readiness,
barrier arrival, action acknowledgement, public terminal result, recovery,
OwnedRuntimeManager stop, and supervised-process vacancy. Derive the
estimated full-run duration from the measured medians and the launch count;
do not estimate from a sleep constant.

The full matrix has a 30-minute maintainer usability budget. If the measured
projection exceeds it, stop expanding the inventory and first reduce avoidable
relaunches or per-case waits without weakening isolation. Do not increase the
budget by hiding fixed sleeps. Record the measured projection and the actual
duration in the Markdown summary even when both are below the limit.

Add these CLI options to the existing live command:

- --only <case-id> accepts exactly one known runtime matrix ID, performs the
  same authorization, preflight, fixture copy, final vacancy, and evidence
  rules as a full run, and emits an explicitly partial matrix artifact.
- --keep-profile is valid only with --only and --confirm-live-run. It keeps
  the external run directory after a failed selected case for local
  inspection; the final artifact still contains only redacted relative
  references and hashes.
- --list-cases prints the validated runtime IDs and exits before live-run
  authorization or filesystem preparation.

Reject duplicate options, an unknown ID, --keep-profile without --only, and
--only combined with a user-controlled matrix fixture. A partial run must
never set fullMatrix: true or be presented as full-matrix acceptance.

### Runtime phase-barrier contract

Use the five Phase 1 canonical names without aliases. The fixture controller
must acknowledge a phase only after the following proof is true. The
acknowledgement includes the case ID, command ID, fixture identity hash,
lifecycle-generation hash, job ID hash when a job exists, phase, and a
non-secret proof object. It never includes the capability, session token,
owner token, PID, absolute path, or raw control filename.

| Canonical phase | Required proof at acknowledgement | Where to place the hook |
| --- | --- | --- |
| before_lease | The exact selected runtime has acknowledged fixture readiness; a capture command is accepted but cameraWasAcquired is false and no camera lease is held. | Between command admission and AdvanceAcquire in RFO_ObserverService.c. |
| lease_acquired | The job reports acquiringCamera, cameraWasAcquired is true, and RFO_ObserverCameraLease.IsHeld is true for the same job/world epoch. | Immediately after successful camera acquisition and status publication. |
| capture_in_progress | The job reports capturing, the same lease is held, and the screenshot operation has not been promoted to an artifact. | At the start of AdvanceCapture before Issue or CheckStable advances the job. |
| restoration_in_progress | The job reports restoring, it previously acquired a lease, and restorationConfirmed is not yet true. | In AdvanceRestoration before the first restoration-complete transition. |
| terminal_release | The job is still non-terminal, its lease is no longer held, restorationConfirmed is true, and the next normal transition is terminal publication or artifact release. | After restoration is proven and before SubmitArtifact or terminal state publication. |

The barrier must pause only progress of the selected job. The runtime frame
loop, status egress, cancellation handling, and the fixture control inbox
must continue while it waits. A barrier that blocks the entire Enforce update
loop cannot prove cancellation or transport behavior and must be rejected in
review.

The host waits for phase arrival through the shared bounded poll helper, using
the case deadline and an AbortSignal. On timeout, abort the wait, issue
fixture release if the control channel remains usable, run normal convergence,
and mark the case failed unless exact process exit proves recovery. Never use
setTimeout, delay, frame counts, or arbitrary polling rounds as proof that a
phase was reached.

At terminal release, the controller must invalidate the one-shot barrier
before the job becomes terminal. It must refuse a command for an already
terminal job, a different job, a stale world epoch, a stale lifecycle
generation, or a repeated command ID. The host records that refusal as a
control failure; it does not reinterpret it as a passed terminal state.

The controller receives only these actions:

| Action | Executor | Required behavior |
| --- | --- | --- |
| cancel_capture | Host runner | Call application.cancelJob with the public session and job ID after arrival acknowledgement. Do not synthesize a cancellation state in the fixture. |
| change_world | Fixture controller | Invoke the fixture's real, supported world reload/unload operation. The normal RFO_ObserverWorld.Refresh path must observe the changed world identity/epoch; changing a status field or a test-only epoch variable is prohibited. |
| drop_transport | Fixture controller | Disable the active observer transport path after acknowledgement so the normal runtime service emits TRANSPORT_UNAVAILABLE or the host receives the same canonical public error. The private fixture control inbox remains available only long enough to acknowledge the already-authorized command. |
| stop_owned_runtime | Host runner | Call OwnedRuntimeManager.stop for the exact runtime ID and its current lifecycle, with the existing restoration wait. Direct process termination, taskkill, Stop-Process, and PID-only logic are prohibited. |

The agent/transport family must exercise the private observer agent selected by
PRIVATE_CHILD_PATH. It must never locate a Node process by name or PID. Start
with the fixture-side drop_transport mechanism because it keeps the host
available to capture the public error deterministically. Add a private-agent
exit variant only when it can use the agent's authenticated private shutdown
protocol and still prove exact owned-runtime recovery; it is not allowed to
call ChildProcess.kill or expose a generic child-control method. The
fixture-side loss case remains required even if the additional agent-exit
variant is deferred.

Before implementing change_world, perform a one-case native-engine spike
against the generated fixture. Its acceptance is a normal service-observed
world identity or epoch change and a public WORLD_CHANGED result; an
acknowledged control message alone is insufficient. If the installed runtime
does not expose a headless unload/reload operation that passes this spike, do
not fake the outcome. Mark every world-loss declaration unsupported with the
specific engine limitation, make --only reject it before launch, and leave
the phase incomplete pending a real engine trigger.

### Declared runtime inventory and expected proof

Register these stable IDs in the shared matrix. Fault cases use explicit pose
because it creates a concrete camera-restoration obligation. The success
family retains all three existing views.

| IDs | View | Phase/action | Expected public disposition | Required camera disposition |
| --- | --- | --- | --- | --- |
| RFO-RUNTIME-SUCCESS-CURRENT, RFO-RUNTIME-SUCCESS-POSE, RFO-RUNTIME-SUCCESS-LOOK-AT | current, pose, look-at respectively | normal flow | completed | restored for pose/look-at; not_acquired for current if no lease was obtained |
| RFO-RUNTIME-CANCEL-BEFORE-LEASE through RFO-RUNTIME-CANCEL-TERMINAL-RELEASE | pose | each canonical phase / cancel_capture | cancelled, no error code | not_acquired before_lease; restored for every later phase |
| RFO-RUNTIME-WORLD-LOSS-BEFORE-LEASE through RFO-RUNTIME-WORLD-LOSS-TERMINAL-RELEASE | pose | each canonical phase / change_world | failed, WORLD_CHANGED | not_acquired before_lease; exact_process_exit thereafter unless ordinary restoration is independently proven |
| RFO-RUNTIME-TRANSPORT-LOSS-BEFORE-LEASE through RFO-RUNTIME-TRANSPORT-LOSS-TERMINAL-RELEASE | pose | each canonical phase / drop_transport | failed or rejected with TRANSPORT_UNAVAILABLE | not_acquired before_lease; exact_process_exit thereafter |
| RFO-RUNTIME-OWNED-SHUTDOWN-BEFORE-LEASE through RFO-RUNTIME-OWNED-SHUTDOWN-TERMINAL-RELEASE | pose | each canonical phase / stop_owned_runtime | exact owned-runtime stop reports exited | exact_process_exit |

Expand each range in the source table into the five literal phase IDs. Do not
generate IDs dynamically at execution time: duplicate IDs, an omitted phase,
or a case whose declared action is impossible for its phase must fail during
matrix module validation.

For every case, run the following sequence in this order:

1. Start or reuse the runtime according to the launch topology, select exactly
   one graphical renderer, and record its public instance/world revision.
2. Arm exactly one validated barrier for the case, submit the asynchronous
   pose/current capture with asynchronous: true and a case-scoped idempotency
   key, then wait for the arrival acknowledgement. Do not use the existing
   synchronous positive-path helper: it cannot observe a mid-job barrier.
3. Dispatch the declared action and wait for its execution acknowledgement or
   explicit refusal.
4. Capture the public job, capture-call error, run status, or
   OwnedRuntimeManager stop result before reading fixture logs, control
   diagnostics, process counts, or evidence directories.
5. Assert the declared public state/error mapping and the camera disposition.
   A thrown generic timeout, an internal error, or an absent job result never
   satisfies an expected public mapping.
6. Perform the case-specific follow-up probe, then collect bounded, redacted
   diagnostics only if the public assertion has already been recorded.
7. Release/discard managed artifacts only after the public and camera proof
   succeeds. Finish with the required exact-owned, child, endpoint, and
   global Arma vacancy checks.

For cancellation and normal completion, use the existing job cameraLease
fields plus the current-view-after-pose probe. A restored result requires
everHeld true, held false, restorationConfirmed true, and a post-case current
capture whose position is at least the existing five-metre displaced-camera
threshold away from the explicit pose. Image similarity remains diagnostic
only; retain the existing comparePngImages tolerances rather than introducing
a stricter fault-only pixel rule.

For world and transport loss after a lease may have existed, do not claim
restoration from a missing status response. Drive exact shutdown through
OwnedRuntimeManager.stop, then require state exited, exactOwned true,
identityVacant true, terminationComplete true, observerCleanupPending false,
and a subsequent status confirmation with the same values. This is the
exact_process_exit proof. Before_lease cases instead prove no camera
acquisition through cameraWasAcquired false and no held lease.

The follow-up probe after every world-loss or transport-loss case is
mandatory:

- first prove the old runtime's exact identity is vacant and supervised child
  counts converge to zero;
- start a fresh runtime with a fresh lifecycle generation;
- wait for exactly one healthy renderer with a different lifecycle/world
  binding as applicable; and
- run a normal current capture. It must complete with a validated PNG and
  must not report CAMERA_BUSY, a held stale lease, or an old job ID.

The probe is evidence that a stale lease cannot poison the next runtime. A
successful stop without this fresh capture is incomplete.

Success cases retain the current PNG requirements: analyzePngMaterial must
find material variation; metadata, PNG hash, dimensions, selected instance,
world ID, and epoch must agree; pose and look-at must match their requested
matrices/FOV; and finalized evidence must pass the existing bundle
verification. Fault cases must not promote a PNG unless their declaration
expects completion. A cancellation/world/transport case that happens to leave
a partial image behind records its hash only as bounded diagnostic evidence;
it must not validate or export it as a passing capture artifact.

### Runner lifecycle and cleanup

Refactor the current runRuntimeObserverAcceptance body into a small matrix
driver with explicit resources:

- RuntimeCaseSession owns one ObserverApplication, one OwnedRuntimeManager,
  one external run directory, one generated fixture copy, and at most one
  exact runtime lifecycle.
- runRuntimeMatrixCase owns one observer run, one case declaration, one
  barrier arm, one public-result snapshot, and one MatrixCaseEntry.
- disposeRuntimeCaseSession owns cancellation/convergence, exact runtime
  stop when necessary, session revocation after exact vacancy, application
  close, global Arma vacancy, and supervised private-child vacancy.

Begin the observer run with caseIds containing exactly the selected matrix ID
and use a unique capture label derived from that ID. A normal success case
finalizes that one validated capture and runs the existing evidence-bundle
verification. A fault case discards its observer run only after terminal
convergence and camera safety are proven; its matrix entry records
not_expected or rejected_before_export rather than attempting to finalize a
failed capture. The shared failure-matrix artifact, not an observer capture
bundle, is the retained evidence for an expected fault result.

Use try/finally around every case session. Do not allow a failing declaration
to skip its cleanup just because the matrix will ultimately fail. Reuse the
existing cancelRunJobs logic for a reachable agent, but treat a failure to
prove restored terminal cleanup as a safety failure and preserve the owned
scratch directory rather than deleting it.

The normal cleanup ordering is fixed:

1. converge or cancel reachable jobs and prove no restoration obligation;
2. invoke OwnedRuntimeManager.stop when an exact runtime remains;
3. verify exact identity vacancy with OwnedRuntimeManager.status;
4. revoke the session only after exact-process vacancy is proven;
5. close ObserverApplication;
6. use inspectBlockingProcesses to prove global Arma/Workbench vacancy; and
7. use waitForOperationalBaselineProcessVacancy to prove the private agent
   and all supervised children are gone.

Retain the existing externally-rooted scratch cleanup guards. On success,
remove profiles, managed state, fixture copy, and diagnostics only after the
matrix manifest has been published. On a safety failure, preserve the
external run directory but record only portable/redacted references in the
manifest.

### Evidence, diagnostics, and review summary

Call the shared Phase 1 matrix writer once, after all selected cases have
finished cleanup and their final vacancy results are known. It writes a unique
runtime-failure-matrix JSON file and a same-stem Markdown file under
docs/validation using the same manifest-last temporary-file/rename rule as
writeOperationalBaselineArtifact. Do not overwrite the current operational
baseline JSON; include its source closure and relevant measurements in the
matrix artifact instead.

Each runtime MatrixCaseEntry must contain:

- case ID, backend, view, phase, action, and the matrix declaration hash;
- bounded start/end/duration and deadline outcome;
- the redacted phase acknowledgement and action acknowledgement/refusal;
- the public result captured before diagnostics: terminal state, canonical
  public error code when present, and a bounded redacted message;
- selected and observed world-revision disposition;
- camera disposition and its proof fields;
- PNG/artifact disposition: validated, not_expected, or rejected_before_export;
- follow-up fresh-capture result for world/transport loss;
- exact owned-runtime stop/vacancy result, supervised-child vacancy result,
  and global-process vacancy result;
- hashes, byte counts, and bounded relative names for retained diagnostics;
  and
- case outcome, failure classification, and whether cleanup recovered.

The runtime Markdown table has one row per declaration, including unsupported
declarations. Its columns are case ID, view, phase/action, public result,
camera result, follow-up result, exact vacancy, elapsed time, and outcome.
Above the table, print the product/revision identity, source closure hash,
fixture digest, matrix schema version, selected/full scope, measured
launch/case/cleanup timings, and known limitations. Never write absolute
paths, PIDs, raw arguments, session IDs, capabilities, owner tokens, image
pixels, or raw mailbox contents.

On a case failure, write a failing matrix artifact only after all possible
cleanup paths complete. It must contain the failing public result and bounded
sanitized diagnostics, never a passing manifest. If the harness cannot prove
camera safety, exact vacancy, or child/endpoint vacancy, it records
recovery: unproven and the overall result is failed even if the declared
fault itself produced its expected public error.

Add an adversarial redaction test that seeds the per-run capability, session
token, owner token, a Windows home-directory path, the generated fixture
path, and a PID-like number into every diagnostic source. Assert that none
appear in either JSON or Markdown while the expected hashes and case IDs
remain reviewable.

### Hermetic tests and behavioral-ownership migration

Add focused ordinary-test coverage before enabling the full live inventory:

| Test file | Required coverage |
| --- | --- |
| tests/observer/runtime-failure-matrix.test.ts | Literal runtime inventory completeness, legal action/phase pairs, --only selection, unsupported-case rejection, public-result mapping, camera-disposition rules, and partial-versus-full artifact status. |
| tests/observer/runtime-failure-matrix-runner.test.ts | Fake application, runtime manager, fixture control client, clock, and process-count reader. Exercise barrier ordering, public-before-diagnostics ordering, cancellation, world/transport follow-up probes, exact shutdown, cleanup despite action failure, and manifest-last behavior. |
| tests/observer/runtime-live-acceptance-contract.test.ts | Update only the narrow CLI/ownership assertions needed to verify the live script keeps PRIVATE_CHILD_PATH, OwnedRuntimeManager, source closure, no direct process-kill path, and the new --only/--keep-profile gate. |
| tests/observer/runtime-camera-restoration-contract.test.ts | Retain existing static checks until the corresponding live mutation proof below has passed. |

The runner fakes must call the same Phase 1 schedule validation and evidence
shaping functions as the real runner. They may fake transport timing and
fixture responses, but they must not implement a parallel permissive
validation path.

Record these mutation proofs in a migration table in this document before
removing any assertion:

| Existing invariant | Behavioral replacement | Required deliberate break | Keep/remove decision |
| --- | --- | --- | --- |
| A cancellation after a held lease restores the runtime camera. | RFO-RUNTIME-CANCEL-RESTORATION-IN-PROGRESS plus post-pose current-view probe. | Temporarily bypass the restoration call/confirmation in the disposable build; the case must fail camera proof or exact-exit recovery. | Remove only after a retained live mutation result. |
| Restoration runs through the post-frame path before observer-camera cleanup. | Cancellation and world-loss cases at restoration_in_progress, with barrier ordering and camera/exact-exit evidence. | Temporarily report restoration before the post-frame confirmation; the barrier/order or camera proof must fail. | Keep the static rule until this mutation is demonstrated on a real runtime. |
| Cleanup revalidates world/camera ownership. | RFO-RUNTIME-WORLD-LOSS-RESTORATION-IN-PROGRESS requires WORLD_CHANGED and exact-process exit when restoration cannot be proven. | Temporarily relax the fixture's normal world-binding revalidation; the case must fail its declared public/camera/vacancy contract. | Keep if the engine cannot make the unsafe path observable; document that specific limitation. |
| The live script uses exact owned lifecycle management and never direct-kills a process. | Runner fake asserts that every shutdown action calls OwnedRuntimeManager.stop and verifies its exact identity receipt. | Replace the stop call with a direct-stop fake; the hermetic runner test must fail. | Retain a narrow static/package guard as a non-observable authorization boundary. |

Run the focused suite with npm test -- followed by the listed test files, and
run the existing full npm test suite before a live run. Keep ordinary CI
tool-free: it must not set RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE, invoke
the runtime command, install Arma Reforger Tools, or require the fixture.

Do not delete a source-text assertion merely because a new case sounds
similar. The migration row needs a real mutation command/result, the affected
case ID, and a reviewer-visible explanation for any static check that
remains.

## Phase exit criteria

- A local runtime run can execute every declared runtime case, or a documented
  applicable subset while the matrix rejects unsupported scheduling.
- Each case has revision-bound, sanitized evidence of its public disposition,
  restoration or exact owned exit, artifact validation, and final vacancy.
- Runtime behavioral tests demonstrably fail when the protected invariant is
  deliberately broken; remaining static checks have a specific rationale.
- The measured full-run time and per-case debugging path are acceptable for
  maintainer use.
