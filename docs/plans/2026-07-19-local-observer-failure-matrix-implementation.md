# Local observer failure-matrix acceptance implementation

**Status:** Planned maintainer-only validation work  
**Scope:** Real local graphical-runtime and Workbench observer acceptance  
**Non-goal:** GitHub-hosted CI, contributor setup, or any always-on product fault-control surface

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
`docs/validation`, bound to the committed revision and source closure. Review
the Markdown summaries and any output images before recording a passing result.

**Acceptance:** Both backends have a complete passing matrix artifact for the
same reviewed source revision, and no unresolved process, transport, camera,
or artifact obligation remains.

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
