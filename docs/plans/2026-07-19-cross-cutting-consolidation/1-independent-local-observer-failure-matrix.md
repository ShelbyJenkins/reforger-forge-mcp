# Local observer failure-matrix acceptance implementation

**Status:** Planned maintainer-only validation work  
**Scope:** Real local graphical-runtime and Workbench observer acceptance  
**Non-goal:** GitHub-hosted CI, contributor setup, or any always-on product fault-control surface
**Related context:** [Cross-cutting consolidation implementation guide](README.md), independent local-acceptance follow-on

## Outcome

The observer capture system has two complementary validation layers:

1. Ordinary CI runs hermetic TypeScript, package, and contract tests. It does
   not install Arma Reforger Tools or launch Arma processes.
2. A maintainer can run opt-in, controlled local acceptance that injects real
   faults into a disposable runtime or Workbench fixture and retains sanitized
   evidence of safe behavior.

The current scripts already prove the positive path:

- `scripts/run-runtime-observer-acceptance.ts`
- `scripts/run-workbench-observer-acceptance.ts`

They launch controlled fixtures, capture current/pose/look-at views, validate
PNG material and metadata, prove restoration, export managed evidence, and
clean up owned processes. This plan extends those scripts with controlled
failure cases. It must not make either script part of the normal `npm test` or
GitHub Actions workflow.

## Prerequisites and sequencing

This follow-on is independent of the parent consolidation guide's task order,
but it consumes artifacts that guide produces. Decide sequencing explicitly
rather than discovering the conflict mid-implementation:

- **Evidence redaction.** Task 4 here needs a stable redaction boundary for
  the new matrix schema. The parent guide's
  [Task 1 (`src/foundation/redact.ts`)](01-task-1-foundation-redaction-boundary.md)
  is the intended single owner of that policy. If Task 1 has not landed yet,
  either start this follow-on after it merges, or write Task 4's redaction
  against the *existing* scattered redaction helpers
  (`observer-live-acceptance-support.ts` already redacts diagnostics for the
  current positive-path evidence — grep it for the current rules) and accept
  a follow-up migration once `foundation/redact.ts` exists. Do not invent a
  third redaction implementation for matrix evidence.
- **Deadlines and polling.** Phase barriers (Task 0/1/2/3) are bounded waits
  with cancellation, which is exactly what the parent guide's
  [Task 2 (`src/foundation/time.ts`)](02-task-2-time-deadline-and-ordinary-poll-foundation.md)
  formalizes (`Deadline`, `pollUntil`). Reusing it avoids a second bespoke
  poll/timeout implementation inside the acceptance scripts. If Task 2 has
  not landed, the existing ad hoc polling in
  `scripts/observer-live-acceptance-support.ts` and
  `run-observer-enforce-mailbox-acceptance.mjs` is acceptable prior art to
  copy from, but note it as debt in Task 5's test list.
- **Public terminal mapping.** Task 0's "expected public terminal
  disposition" column should be defined in terms of the codes the parent
  guide's [Task 3 (`src/observer/public-contract.ts`)](03-task-3-public-observer-error-projection-safe-rendering.md)
  will canonicalize. If Task 3 has not landed, use the current error codes
  produced by `src/observer/tools.ts` / `src/tools/observer-runtime.ts` and
  keep a short note in the fault-matrix file itself listing which case
  expectations will need re-verification once `public-contract.ts` exists.

Recommended order: land parent Tasks 1-3 first if at all practical, then
start this follow-on's Task 0. If the two efforts must run concurrently,
assign one reviewer to both so the redaction/time/error-projection contracts
don't get duplicated by accident.

## Prior art already in the repository

Three existing pieces solve adjacent problems and should be reused or copied
rather than redesigned from scratch:

- **`observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverMailboxTransport.c`**
  is a working example of a file-mailbox transport with a per-instance random
  nonce (`m_RFO_WriterNonce`) embedded in every artifact name, plus a
  monotonic sequence counter. Task 1's "per-run capability" and "bind to
  exact lifecycle generation" requirements are the same shape of problem —
  model the new control channel's capability/nonce handling on this file
  instead of inventing a new authentication primitive in Enforce.
- **`scripts/run-observer-enforce-mailbox-acceptance.mjs`** already runs a
  disposable acceptance add-on (`tests/fixtures/enforce-mailbox-acceptance-addon`)
  against a real Workbench process, with its own case list
  (`fairness`, `deletion_failure`, `egress_reclamation`, `writer_pause`,
  `bounded_quarantine`), sentinel-size bounds, and a `--keep-profile` escape
  hatch for debugging a failed run. Its case-table shape, artifact path
  convention (`.artifacts/observer-enforce-mailbox-acceptance.json`), and
  argument parsing are a closer template for the new matrix scripts than a
  green-field design — reuse its argument-parsing and disposable-fixture
  conventions where they fit.
- **`src/observer/owned-runtime-manager.ts`** already has a phase-enum
  precedent (`pre_spawn` → `spawned_unverified` → `identity_verified` →
  `published`) gated by a fenced mutex (`withFencedMachineMutex`,
  `OwnedRuntimeLeaseFence.assertActive`) that throws a distinct
  `RECOVERY_REQUIRED` error if the lease is lost mid-operation. Task 1's
  "phase barrier" is the same problem in miniature: use a fence/lease object
  passed into the barrier callback, not a boolean flag, so a fault injected
  after the fence is invalidated fails loudly instead of silently mutating
  stale state.
- **Exact-process identity.** `src/foundation/identity.ts` /
  `src/platform/windows/exact-process-backend.ts` already define
  `ExactProcessIdentity` as the tuple `(pid, executablePath,
  creationTimeFileTime, ownerTokenArgument)`, and
  `src/workbench/process-guard.ts` already refuses to act on a PID whose
  creation time or owner-token argument doesn't match. This is the exact
  mechanism the safety constraint "never terminate the decoy" needs — the
  matrix's owned-shutdown cases must construct their decoy check the same
  way (compare the full identity tuple, not just a PID or process name), and
  can call the existing backend rather than re-implementing identity
  comparison.

## Safety constraints

- Every live run requires its existing environment gate and explicit
  `--confirm-live-run` confirmation.
- Run against generated disposable fixtures and external managed roots only.
  Never inject faults into a user-selected project, world, or existing Arma
  process.
- Preflight must reject pre-existing Arma/Workbench processes or occupied
  endpoints where the case requires vacancy.
- Fault controls must be unavailable through public MCP tools and normal
  add-on behavior. They require a fresh per-run capability and are accepted
  only by the generated acceptance fixture.
- A loss of restoration proof is a safety failure. The result must retain the
  recovery evidence and refuse to report success.
- Any shutdown test may terminate only the exact process created and
  attested by that case. An unrelated process is a decoy to protect, never a
  termination target.
- Evidence may contain hashes, booleans, bounded timings, case IDs, and
  version/revision identities. It must redact paths, PID values, owner tokens,
  session credentials, and machine/user identifiers.

## Task 0 — Define the fault-matrix contract

Create one typed, versioned fault-matrix definition shared by the local
acceptance scripts and their hermetic tests. Each case must specify:

- stable case ID and backend (`runtime` or `workbench`);
- capture view (`current`, `pose`, or `lookAt`) where applicable;
- injection phase;
- injection action;
- expected public terminal disposition;
- required camera disposition (`restored`, `exact_process_exit`, or
  `not_acquired`);
- required lifecycle/endpoint/child vacancy checks; and
- evidence fields required for that case.

Use phase names that correspond to product-observable state, not source-line
positions:

1. `before_lease`
2. `lease_acquired`
3. `capture_in_progress`
4. `restoration_in_progress`
5. `terminal_release`

Unknown case IDs, phase/action combinations, duplicate case IDs, and an
attempt to schedule a fault after terminal completion must fail closed.

**Implementation notes**

- Suggested home: `observer/protocol/fault-matrix.ts`, alongside
  `observer/protocol/enforce-contract.ts`, so the case table can import
  `OBSERVER_TERMINAL_STATES` directly instead of re-declaring terminal state
  names.
- The five canonical phases must hold across *both* backends even though the
  underlying state machines differ. Verify this before writing the schema:
  the runtime backend's phases correspond to `capture-service.ts` job-record
  lifecycle (`lease` acquisition, `release`/`releaseReceipt`); the Workbench
  backend's equivalent is visible today as `cameraLeaseHeld` in
  `run-workbench-observer-acceptance.ts`. If a Workbench case genuinely has
  no observable analog for one of the five phases (for example, Workbench
  may not have a distinct `capture_in_progress` versus
  `restoration_in_progress` boundary for every view type), the schema should
  let a case declare a phase as *not applicable* rather than force a case to
  claim a phase it cannot actually reach — silently dropping the phase would
  violate the fail-closed requirement below it.
- Model the discriminated union so `backend: "runtime"` cases and
  `backend: "workbench"` cases carry different allowed action enums (a
  `world_unload` action, for instance, may not be a meaningful Workbench
  action if there is no separate "world" from "project"). A single shared
  `action` string type would let a case reference an action its backend
  cannot execute; catch that at the type level, not just at runtime.
- Duplicate-ID and unknown-phase rejection should happen at module load
  (throw when the matrix file is imported), not lazily on first use — this
  makes the hermetic test in Task 5 trivial (`expect(() =>
  loadFaultMatrix()).not.toThrow()` plus targeted mutation tests that
  reintroduce a duplicate).

**Hurdles**

- The temptation is to let "phase" drift back into source-line meaning
  (e.g., "right after the `await backend.acquire(...)` call"). Guard against
  this in review by requiring each phase to cite the *public* status field
  or state value that proves the fixture reached it, not a code path.
- Runtime and Workbench genuinely differ in when "restoration" is even
  possible (a `not_acquired` disposition presumably means no restoration
  obligation exists yet). Make sure the schema's camera-disposition enum
  can express "this phase/action combination structurally cannot produce a
  restoration obligation" instead of leaving reviewers to infer it.

**Acceptance:** Hermetic tests validate the complete matrix, including the
failure of every invalid or ambiguous schedule.

## Task 1 — Build a local-only fixture control channel

Add a per-run, authenticated control channel between the acceptance script and
the generated fixture. It may be a private file/mailbox/control endpoint, but
it must not be registered as a public MCP method or shipped as an enabled
production feature.

The channel must:

- receive a random one-run capability from the launcher;
- bind commands to the expected generated project/add-on and exact lifecycle
  generation;
- expose a phase barrier so the script can inject one deterministic fault;
- acknowledge either execution or refusal with a bounded deadline; and
- become unusable on terminal release, restart, world change, or capability
  mismatch.

Put shared fault scheduling and evidence shaping in TypeScript. Put only the
minimum native Workbench/runtime signal needed to reach real product states in
the disposable fixture. Do not introduce an arbitrary script-evaluation or
process-control mechanism.

**Implementation notes**

- For the runtime backend, `RFO_ObserverMailboxTransport.c`'s nonce/sequence
  pattern is directly reusable: generate a fresh 64-bit-ish random capability
  per run (`randomUUID()` on the TypeScript side, written once into a file
  the disposable fixture reads at startup), and have every command file name
  embed that capability the same way the existing transport embeds
  `m_RFO_WriterNonce`. A command whose embedded capability doesn't match is
  rejected before it is parsed, not after.
- For the Workbench backend, `run-workbench-observer-acceptance.ts` already
  talks to a "handler" over some existing transport for the positive-path
  script — read how that handler is addressed today before adding a second,
  parallel channel. If the existing handler transport can carry an
  additional authenticated command without becoming a public capability,
  prefer extending it over standing up an entirely separate control path;
  two control channels into the same disposable fixture double the surface
  Task 1's hermetic tests have to cover.
- "Bind commands to the exact lifecycle generation" should reuse the
  generation-comparison pattern already in
  `owned-runtime-manager.ts` (`runtimeLifecycleGeneration(expected)` compared
  field-by-field against a stored authority record) rather than a new
  equality helper. The existing code already handles the edge case of a
  raced/stale generation; duplicating that logic is a likely source of a
  subtle divergence.
- The phase barrier itself should be implemented as a real synchronization
  point the fixture blocks on (e.g., the fixture writes an
  "arrived at phase X, awaiting release" acknowledgment and then polls its
  inbox with `foundation/time.ts`'s `pollUntil` once that exists, or the
  ad hoc equivalent today), not a fixed sleep. A fixed sleep is both flaky
  (the fixture may not have reached the phase yet) and slow (padding every
  case with worst-case margin). See "Known hurdles" below for why this
  matters more than it looks like it should.

**Hurdles**

- **One-shot enforcement is easy to get wrong under retries.** The
  acceptance script itself may retry a transient send failure; make sure
  "second use" rejection is keyed on whether the fixture *executed* the
  command, not merely received bytes, or a legitimate resend after a dropped
  ack will be misclassified as replay abuse.
- **Capability storage must not leak into evidence.** The random capability
  is exactly the kind of value the safety constraints require redacted from
  evidence (it's effectively a session credential). Task 1's hermetic tests
  should include a check that the capability value never appears in any
  artifact Task 4 produces — this is cheap to add now and easy to forget
  later once Task 4 is a separate PR.
- **Windows file locking.** If the channel is file/mailbox based on Windows,
  writer/reader contention on the same file (the existing mailbox transport
  already deals with this via its sequence+nonce naming to avoid
  overwrite-in-place) needs the same treatment here. Don't rely on atomic
  rename semantics that differ between POSIX and Windows; the existing
  transport's "new file per message" approach sidesteps this and is worth
  keeping.

**Acceptance:** Hermetic tests reject stale capabilities, wrong target/generation,
second use, malformed commands, and any command outside the declared matrix.

## Task 2 — Add phase barriers and runtime fault cases

Instrument the disposable graphical-runtime fixture so a case can pause at
each camera-lease phase without relying on timers. Extend
`run-runtime-observer-acceptance.ts` to execute and record at least these
controlled cases:

| Case family | Required coverage |
| --- | --- |
| Success | Current, explicit-pose, and look-at capture with validated PNG, world revision, restoration, release, and final vacancy. |
| Cancellation | Cancel at every lease phase; prove a terminal public result and restoration or exact owned exit. |
| World loss | Unload/change the world at every lease phase; prove the stale/world result is public and the lease cannot remain held. |
| Agent/transport loss | Lose the private agent or transport at every lease phase; prove bounded failure, no unsafe adoption, and a recoverable or fail-closed disposition. |
| Owned shutdown | Request owned-runtime shutdown at every lease phase; prove no camera or child obligation remains. |

For every case, capture the public job/run result before inspecting internal
diagnostics. The script must never infer success from process exit alone.

**Implementation notes**

- The existing script already has the scaffolding to build on:
  `PRIVATE_CHILD_PATH`, `OwnedRuntimeManager`, and
  `observer-live-acceptance-support.ts`'s `inspectBlockingProcesses` /
  `waitForOperationalBaselineProcessVacancy` for the final-vacancy check. The
  "Agent/transport loss" case family maps onto killing/blocking
  `dist/observer/agent/private-child.js` specifically — reuse
  `PRIVATE_CHILD_PATH` rather than re-deriving the path.
  `RUNTIME_OPERATIONAL_BASELINE_SOURCES` already lists every source file the
  positive-path baseline hashes; the fault-matrix artifact (Task 4) should
  bind to the same closure so a reviewer can tell the matrix ran against the
  same code the baseline claims to cover.
- "Owned shutdown" cases should drive through `OwnedRuntimeManager.stop`
  (and, for the mid-phase variants, whatever internal hook Task 1's phase
  barrier exposes) rather than killing the process directly from the script
  — killing it directly bypasses the exact-identity bookkeeping
  (`withFencedMachineMutex`, `closeOwnedRuntimes`) the real product path
  goes through, so it would validate a scenario the product can't actually
  produce.
- "World loss" needs a concrete trigger. Check whether the disposable
  runtime fixture already exposes a scripted world-change/unload command
  (used anywhere in `observer/agent` or the `.c` addon sources); if not,
  this case family may require a small addition to the disposable fixture's
  Enforce side, which should go through the same capability-gated channel as
  everything else in Task 1, not a separate ad hoc mechanism.

**Hurdles**

- **Five phases × five case families × three views is a lot of real Arma
  launches.** Even at a conservative per-launch cost, running every
  phase/action/view combination as a fresh process start will make this
  script slow (potentially tens of minutes). Decide up front whether a
  single long-lived fixture process can serve multiple cases sequentially
  (preferred — matches how the existing positive-path script already
  reuses one launch for current/pose/look-at) or whether some fault
  families inherently require a fresh process (e.g., anything that kills
  the agent). Budget wall-clock time in the plan rather than discovering a
  50-minute script during Task 7.
- **"Prove the lease cannot remain held" after world loss is a negative
  assertion.** It's checked by demonstrating the *next* capture attempt (or
  a status query) sees no stale lease, not by the absence of an error in
  the current run. Make sure the case's evidence includes that follow-up
  probe, not just the immediate fault response.
- **GPU/driver variance in PNG comparison.** The existing
  `comparePngImages`/`analyzePngMaterial` helpers presumably already have
  some tolerance for the positive path; fault-case PNG assertions (e.g.,
  "no new frame was captured after cancellation") need to reuse that same
  tolerance rather than a stricter one invented for this plan, or the matrix
  will be flakier than the script it extends.

**Acceptance:** A local run produces one revision-bound runtime matrix
artifact in which every required case either satisfies its declared terminal
contract or causes the overall run to fail.

## Task 3 — Add phase barriers and Workbench fault cases

Instrument the generated disposable Workbench project and helper only enough
to exercise the declared cases. Extend
`run-workbench-observer-acceptance.ts` to run each case against current, pose,
and look-at capture where it is meaningful:

| Case family | Required coverage |
| --- | --- |
| Success and restoration | Current, pose, and look-at; independently validate PNG material, requested pose, and restored editor camera. |
| Handler loss | Make the acceptance handler unavailable during each applicable phase; verify a bounded public failure and no dangling lease. |
| Lease contention | Hold the fixture lease, request another capture, and verify refusal without camera mutation. |
| World/project loss | Change or unload the generated world/project during each applicable phase; verify stale identity handling and cleanup. |
| PNG/artifact failure | Deliver an invalid, incomplete, or mismatched fixture artifact before promotion; verify validation fails before manifest export. |
| Cancellation and shutdown | Cancel or request exact-owned shutdown at every lease phase; prove restoration or exact exit and protect the unrelated-process decoy. |

The decoy check must assert identity non-interference; it must not rely on a
name match or attempt to terminate the decoy.

**Implementation notes**

- Build the decoy check on `ExactProcessIdentity` (see "Prior art" above):
  launch a second, genuinely unrelated disposable process (not another
  Workbench instance, to avoid the single-instance conflict noted below —
  a plain long-lived `node` or `timeout`-style helper process is enough),
  record its full identity tuple before the case runs, and assert the tuple
  is byte-for-byte unchanged after the shutdown case completes. Asserting
  "the decoy is still running" is necessary but not sufficient — also
  assert its `creationTimeFileTime` is unchanged, since a PID getting
  reused after an accidental kill-and-relaunch would otherwise pass a
  liveness-only check.
- "Lease contention" is the one family that doesn't need a phase barrier at
  all — it needs two overlapping capture requests against the same fixture,
  which the existing single-lease enforcement in `capture-service.ts`
  (`CAMERA_BUSY` on release; check the acquire path for the equivalent
  contention error code) should already reject. This case mostly needs the
  script to attempt the second request and assert the specific public error
  code, not new fixture instrumentation.
- "PNG/artifact failure" cases can likely reuse `observer-live-acceptance-support.ts`'s
  existing PNG validators (`analyzePngMaterial`, `detectPngColorMarker`) by
  feeding them a deliberately corrupted fixture artifact — confirm those
  validators reject bad input with a distinguishable error rather than
  throwing something generic, since the case needs to assert *which*
  validation failed.

**Hurdles**

- **Workbench is effectively single-instance per machine.** Confirm this
  constraint before scoping "Lease contention" and "Handler loss" cases: if
  only one Workbench process can run at a time, every Workbench case in this
  task must run serially against the one disposable project, and the
  preflight vacancy check (existing safety constraint) has to be satisfied
  fresh before *each* case, not once for the whole matrix. This multiplies
  wall-clock cost similarly to the runtime concern in Task 2, but is worse
  here because Workbench startup is typically slower than the runtime
  executable.
- **"Handler unavailable" needs a real unavailability, not a simulated one.**
  If the acceptance handler lives inside the Workbench process itself
  (likely, given `EMCP_WB_ObserverCommon.c` / the handler-contract test
  naming), truly making it "unavailable" mid-phase may require either
  unloading the add-on module or blocking its transport — both are more
  invasive than killing an external process. Decide which mechanism is both
  realistic (matches a real failure mode) and safe (doesn't corrupt the
  disposable Workbench project state for the next case in the same run).
- **World/project loss inside an editor** may prompt Workbench's own
  "unsaved changes" or reload UI, which would hang a scripted run
  indefinitely. Confirm the generated disposable project can be
  unloaded/reloaded headlessly through the same control channel rather than
  through UI automation before committing to this case family's design.

**Acceptance:** A local run emits a revision-bound Workbench matrix artifact
covering every declared case and verifies exact-owned cleanup.

## Task 4 — Make evidence matrix-aware and reviewable

Replace the positive-path-only summaries with a schema that records one entry
per case. Each entry must include the declared case ID, redacted schedule,
public terminal state/error, deadline outcome, world-revision disposition,
camera disposition, artifact validation result, exact-owner cleanup result,
and hashes for retained logs/evidence.

Keep manifest-last behavior. On a failing case, retain only the bounded
sanitized diagnostics needed to explain the failure and do not produce a
passing matrix artifact.

Add a compact Markdown review summary next to each JSON artifact with the
case table, product version, source closure hash, evaluator identity, and
known limitations. Do not record absolute paths, PIDs, credentials, raw
arguments, or image pixels in the summary.

**Implementation notes**

- `observer-live-acceptance-support.ts` already has
  `writeOperationalBaselineArtifact`, `operationalBaselineProcedureSha256`,
  and `operationalBaselineSource`/`operationalBaselineEnvironment` for the
  positive-path artifact. Extend that schema (add a `cases: MatrixCaseEntry[]`
  array alongside the existing fields) rather than inventing a parallel
  artifact writer — this keeps the source-closure-hash and evaluator-identity
  plumbing that already exists in one place.
- "Evaluator identity" already needs to be something other than a raw
  username per the redaction rules (machine/user identifiers must be
  redacted). Check what the current positive-path artifact records for this
  field today and keep the same convention rather than introducing a second
  identity representation.
- Consider a `schemaVersion` field on the matrix artifact from the start.
  `docs/validation/` stays `.gitignore`d at the repo root and nothing this
  plan produces there is meant to be committed: Task 7's artifacts are
  written locally, reviewed by the maintainer, and then deleted as part of
  the same manual closeout the parent guide already documents. Confirm
  Task 4's writer targets `docs/validation/` (or an external evidence root)
  the same way the existing positive-path artifact does, and do not add a
  git exception for it.

**Hurdles**

- **Manifest-last is harder to guarantee with N cases than with one
  positive-path run.** The existing script can probably get away with
  "write nothing until the whole run succeeds." A matrix run may partially
  fail (some cases pass, one fails); Task 4 needs to decide explicitly
  whether a partial failure still emits a JSON artifact (marked failing,
  per "does not produce a passing matrix artifact") or emits nothing at
  all. The task text says "do not produce a passing matrix artifact" on
  failure, which implies a *failing* artifact may still be written — make
  sure the schema and the manifest-last invariant test agree on which case
  this actually is, since "manifest-last" and "always write on failure for
  debuggability" are in tension and need a precise rule.
- **Redaction correctness still matters even though the artifact is
  deleted afterward.** Between being written and being deleted, the
  artifact is reviewed locally and may be pasted into a PR description, a
  chat, or a bug report by the maintainer — any of the redaction failure
  modes (leaked owner token, absolute path with the user's real home
  directory) leaks the moment someone shares the file, not only if it were
  committed. Treat the "schema tests reject ... unredacted paths/tokens"
  acceptance criterion as needing adversarial test inputs (real-looking
  Windows paths with the current user's actual home-directory shape,
  real-looking PIDs, etc.), not just a happy-path fixture.

**Acceptance:** Schema tests reject missing cases, duplicated cases, raw
identity fields, unredacted paths/tokens, terminal-state contradictions, and a
manifest published before all included capture metadata is valid.

## Task 5 — Preserve CI coverage and add hermetic fault-scheduler tests

Keep the normal Windows/Node CI workflow unchanged: it runs build, package,
protocol, lint, and hermetic tests only. Add focused tests for:

- fault-matrix completeness and scheduler rejection paths;
- phase-barrier ordering and bounded deadlines;
- capability binding and one-shot control authorization;
- evidence schema/redaction/manifest-last invariants;
- expected public terminal mapping for every synthetic fault response; and
- exact-identity shutdown refusal and decoy non-interference.

These tests use fakes for process, transport, clock, and fixture signaling.
They validate the harness implementation but do not claim to replace the
maintainer's real product run.

**Implementation notes**

- `.github/workflows/ci.yml` currently runs, in order:
  `protocol:check`, `lint:unused`, `protocol:generate` (+ dirty-diff check),
  `build`, `test`, and `test:package` (Node 20 leg only). None of these steps
  install Arma Reforger Tools or set the `RFO_RUN_LIVE_*` environment
  variables, and this plan must keep it that way — the new hermetic tests
  belong in whatever suite `npm test` already runs, not a new workflow step.
- Add an explicit hermetic test (in the Task 5 suite, or as an assertion in
  Task 0's tests) that greps `.github/workflows/ci.yml` for the
  `RFO_RUN_LIVE_*` variable names and fails if either appears — this turns
  "must not make either script part of the... GitHub Actions workflow" into
  something CI itself enforces, rather than a convention that quietly rots.

**Hurdles**

- Faking "fixture signaling" convincingly enough to exercise Task 1's
  capability/generation-binding logic without a real fixture is the riskiest
  part of this task — a fake that's too permissive will pass tests that a
  real fixture's stricter behavior would fail. Where possible, share the
  *validation* code path between the fake and the real fixture (i.e., the
  fake should call the same TypeScript capability-check function the real
  control channel uses, with a fake transport underneath) rather than
  reimplementing the check's logic a second time in test doubles.

**Acceptance:** The focused suites run under ordinary `npm test` on a clean
clone without Arma Reforger Tools.

## Task 6 — Replace source-text assertions only with behavioral ownership

Create a migration table before deleting any assertion. The initial review set
includes:

- `tests/observer/runtime-camera-restoration-contract.test.ts`
- `tests/workbench/observer-handler-contract.test.ts`
- `tests/observer/runtime-live-acceptance-contract.test.ts`
- `tests/workbench/observer-live-acceptance-contract.test.ts`
- relevant source-reading checks in `tests/observer/package-contract.test.ts`

For every source-text assertion, record its invariant, its proposed behavioral
replacement, the injected fault that demonstrates the replacement, and whether
the behavioral test actually fails when that invariant is deliberately broken.

Delete the source-text assertion only after that mutation proof exists. Retain
a small AST ownership rule only when the invariant cannot be observed safely at
runtime; document the exact reason beside the rule. Do not remove package
inventory checks merely because they read a manifest or package file—those are
artifact-integrity checks, not automatically redundant source-text contracts.

**Implementation notes**

- `tests/observer/package-contract.test.ts` today contains two different
  kinds of assertion that are easy to conflate while building the migration
  table: (a) genuine source-text/string-literal checks (e.g.
  `expect(packageCheck).toContain("dist/observer/agent/private-child.js")`,
  which asserts a *string appears in a script's source*), and (b) manifest
  and config shape checks (`.gitattributes` contents, `package.json`
  `scripts` and `files` fields, `tsconfig` contents) that are artifact
  integrity checks the task text explicitly says to keep. When building the
  migration table, classify each `expect(...).toContain(...)` /
  `expect(...).toContain(...)`-style line individually — this file mixes
  both kinds within the same test body, so a blanket "delete the source-text
  checks in package-contract.test.ts" instruction would be wrong.
- A literal "mutation proof" is concrete and mechanical: temporarily revert
  the invariant in a scratch branch (e.g., comment out the restoration call
  the assertion is protecting), run the proposed behavioral test, confirm it
  fails, then revert the scratch change. Do this for real for each row
  before checking it off — an unverified "should fail" entry is exactly the
  kind of unclassified deletion the acceptance criterion is meant to catch.

**Hurdles**

- Some invariants in `runtime-camera-restoration-contract.test.ts` may exist
  precisely *because* the real restoration behavior is expensive or
  impossible to exercise hermetically (that's presumably why a source-text
  check was used in the first place). For those, the "documented
  non-observability rationale" is not a formality — write down specifically
  why Task 2's new runtime fault cases can't replace this particular check
  even though they now exercise restoration under fault conditions. If they
  can, the AST rule should go; if they genuinely can't (e.g., the check
  guards a Windows-only code path this plan's hermetic fakes can't reach),
  say so explicitly.

**Acceptance:** The migration table has no unclassified deletion, and every
remaining static rule has a documented non-observability rationale.

## Task 7 — Run and retain the maintainer acceptance

On a controlled Windows machine with Arma Reforger Tools and the normal local
configuration, run the final matrix commands one at a time with no pre-existing
Arma or Workbench process:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm.cmd run dev:observer:acceptance:runtime -- --confirm-live-run

$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
npm.cmd run dev:observer:acceptance:workbench -- --confirm-live-run
```

Retain the resulting sanitized runtime and Workbench matrix artifacts under
`docs/validation` only for the duration of review: bind them to the committed
revision and source closure while reviewing the Markdown summaries and any
output images, then delete them as part of the same manual closeout the
parent guide already documents for its own validation evidence. The
artifacts are proof the run happened and passed at review time; they are not
meant to persist in the tree or in git history afterward.

**Implementation notes**

- `docs/validation/` stays `.gitignore`d at the repo root; nothing from this
  task gets committed. After review, delete the runtime and Workbench matrix
  artifacts the same way the parent guide's manual closeout step removes its
  own tracked-by-accident validation output, and confirm a clean checkout
  doesn't recreate them.
- Run each command exactly once end-to-end before treating the matrix as
  final; given the wall-clock concerns raised in Tasks 2 and 3, budget real
  calendar time for this step and expect to re-run at least once after
  fixing whatever the first run's Markdown summary flags.

**Hurdles**

- This is the step where every deferred risk above becomes real at once:
  wall-clock cost (Tasks 2/3) and Workbench single-instance serialization
  (Task 3) both have to be resolved *before* this step is attempted, not
  discovered during it.
- Deleting the evidence after review means the "passing" claim rests on the
  maintainer's own record (PR description, review notes) rather than on an
  artifact anyone can re-inspect later. Make sure whatever summary goes into
  the PR/commit message captures enough of the Markdown review summary's
  content (case table, source closure hash, revision) to stand on its own
  once the underlying file is gone.

**Acceptance:** Both backends have a complete passing matrix artifact for the
same reviewed source revision, and no unresolved process, transport, camera,
or artifact obligation remains.

## Known hurdles and mitigations (cross-cutting)

These apply across multiple tasks and are easy to under-scope if each task is
planned in isolation:

- **Wall-clock cost compounds.** Five phases × several case families × up to
  three capture views, across two backends, each potentially needing a fresh
  process launch, adds up fast even at generous per-case estimates. Get a
  rough time budget from a small pilot (implement and time *one* case family
  end-to-end, e.g. Cancellation, before committing to the full matrix's
  scope) rather than assuming the full matrix is a quick extension of the
  existing positive-path script.
- **Workbench is a shared, effectively single-instance resource on the
  maintainer's machine.** Every Workbench case in Task 3 must be planned as
  a serial step with its own preflight vacancy check, not a parallelizable
  unit. This also means a failed case can't simply be re-run in isolation
  without re-running preflight; design the script so a single case can be
  re-targeted (e.g. `--only <case-id>`) for debugging without re-running the
  entire matrix, mirroring the existing `--keep-profile` escape hatch in
  `run-observer-enforce-mailbox-acceptance.mjs`.
- **Timer-based synchronization is the most likely source of flaky, silently
  wrong results.** Every "pause at phase X" mechanism must be driven by an
  observable acknowledgment from the fixture, not a sleep tuned to "usually
  enough." A flaky phase barrier doesn't just fail loudly — it risks
  injecting the fault into the *wrong* phase and having the case still
  report a plausible-looking (but meaningless) pass.
- **PID reuse and process-identity edge cases are exactly where Windows
  differs from POSIX assumptions.** Lean on the existing
  `ExactProcessIdentity` / `WindowsExactProcessBackend` machinery for every
  identity comparison in this plan rather than any new PID-only check, since
  that machinery already exists specifically because PID alone is not a
  safe identity on Windows.
- **Redaction is the one place where "close enough" is not acceptable**
  because evidence may end up retained (Task 7) and potentially reviewed by
  people other than the maintainer who ran it. Treat Task 4's redaction as
  needing the same adversarial-test rigor as a security boundary, not just
  schema validation.
- **This plan depends on parts of the parent consolidation guide that may
  not exist yet** (see "Prerequisites and sequencing"). The single biggest
  scheduling risk to this follow-on is starting Task 4's redaction work
  against a `foundation/redact.ts` that doesn't exist yet and having to
  redo it once the parent guide's Task 1 lands with different policy
  configuration than assumed here.

## Completion criteria

This work is complete only when:

- ordinary CI remains tool-free and passes the expanded hermetic suites;
- both live harnesses are explicitly local-only and reject accidental runs;
- every declared runtime and Workbench fault case has retained passing
  revision-bound evidence;
- evidence proves bounded terminal behavior, camera restoration or exact exit,
  validated artifacts, manifest-last export, idempotent release, and vacancy;
- source-text contracts have either been behaviorally replaced or retained as
  documented narrow AST ownership checks; and
- the local procedure and its prerequisites are documented without personal
  paths, credentials, or machine-specific configuration.
