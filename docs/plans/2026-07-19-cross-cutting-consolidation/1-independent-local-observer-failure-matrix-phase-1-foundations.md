# Local observer failure matrix — Phase 1: shared foundations

**Status:** Planned implementation document  
**Scope:** Shared contracts, local-only control-channel safety, evidence
invariants, and hermetic coverage needed before either live backend matrix is
expanded.

## Relationship to the original plan

This is the first implementation-phase companion to the retained
[original failure-matrix plan](1-independent-local-observer-failure-matrix.md).
The original is not replaced or deleted; it remains the complete source of
context, safety constraints, and acceptance criteria. This document is an
intentionally smaller place to add the implementation-level details for the
shared work.

The next phases are:

1. [Phase 2: runtime matrix](1-independent-local-observer-failure-matrix-phase-2-runtime.md)
2. [Phase 3: Workbench matrix and closeout](1-independent-local-observer-failure-matrix-phase-3-workbench-and-closeout.md)

## Objective

Create the common, fail-closed machinery that both runtime and Workbench
acceptance harnesses use. No live matrix should depend on a backend-specific,
ad hoc interpretation of fault schedules, control authorization, redaction,
or evidence publication.

## Work assigned to this phase

- Confirm or explicitly bridge the parent consolidation prerequisites for
  redaction, deadlines/polling, and public terminal-error projection.
- Define the typed, versioned fault-matrix contract and backend-specific
  actions (original plan Task 0).
- Implement the shared TypeScript scheduler and its fail-closed validation:
  duplicate or unknown cases, invalid phase/action pairs, and post-terminal
  scheduling must be rejected.
- Build the local-only, per-run capability and lifecycle-generation binding
  rules for the fixture control channel (original plan Task 1).
- Define the phase-barrier protocol: observable arrival acknowledgement,
  bounded release/refusal, cancellation, terminal invalidation, and one-shot
  execution semantics.
- Establish the matrix evidence schema and its common invariants: redaction,
  schema versioning, per-case entries, hashes, and manifest-last behavior
  (the shared portion of original plan Task 4).
- Add focused hermetic tests for all shared scheduler, authorization,
  deadline, redaction, and CI-local-only invariants (the shared portion of
  original plan Task 5).

## Not in this phase

- The full runtime fault-case inventory or its live acceptance run.
- Workbench-specific fault instrumentation or live acceptance run.
- Removal of existing static/source-text assertions; that follows proven
  behavioral coverage in the backend phases.

## Implementation decisions and instructions

### 1. Prerequisites and ownership

The three parent foundations required by this phase already exist and are the
only implementations Phase 1 may use:

| Need | Required owner | How Phase 1 uses it |
| --- | --- | --- |
| Redaction | `src/foundation/redact.ts` | Redact every exported diagnostic and every launch/control-derived string with the `evidence_portability` profile. Pass the per-run capability and lifecycle owner token as `knownSecretValues`. |
| Deadlines and polling | `src/foundation/time.ts` | Construct one case deadline with `deadlineAfter`, derive all barrier and acknowledgement deadlines with `deriveDeadline`, and use `pollUntil` with an abort signal. |
| Public terminal projection | `src/observer/public-contract.ts` and `observer/protocol/enforce-contract.ts` | Store only a canonical public terminal state; validate a canonical public error code when the asynchronous job result supplies one, and retain `null` for completed/cancelled job status. Import `OBSERVER_TERMINAL_STATES`; do not reproduce terminal state literals in the matrix. |

There is no temporary redaction, polling, or public-error compatibility
adapter. Do not add one to either acceptance script. If any of the three APIs
needs a change while this phase is implemented, make that change in its owner
module with its existing tests, then import the revised API here.

The matrix and control channel are maintainer-acceptance infrastructure, not
observer product protocol. They must not add a capability to
`observer/protocol/registry.ts`, an MCP method, or a command to the production
runtime/workbench add-ons. The backend phases own the small generated-fixture
Enforce bridges; this phase owns their TypeScript contract, validation, and
test doubles.

Implement the shared work in this order:

1. Define and test the immutable matrix contract.
2. Implement the scheduler and in-memory control-channel validator against
   that contract.
3. Add the versioned evidence builder and publisher.
4. Wire the current runtime and Workbench scripts only far enough to construct
   the shared objects behind their existing live-run gate. Do not enable a
   fault case yet.
5. Add the hermetic tests and CI-isolation guard before Phase 2 adds a real
   fixture action.

### 2. Matrix contract

Create `observer/protocol/fault-matrix.ts`. It is the one source of truth for
the schedule vocabulary and must contain no file-system, process, MCP, or
Enforce code. Export the following values and functions:

```ts
export const FAULT_MATRIX_SCHEMA_VERSION = 1 as const;
export const FAULT_MATRIX_PHASES = [
  "before_lease",
  "lease_acquired",
  "capture_in_progress",
  "restoration_in_progress",
  "terminal_release",
] as const;

export type FaultMatrixBackend = "runtime" | "workbench";
export type FaultMatrixPhase = typeof FAULT_MATRIX_PHASES[number];
export type RuntimeFaultAction =
  | "cancel_capture"
  | "replace_runtime_world"
  | "disconnect_private_agent"
  | "stop_owned_runtime";
export type WorkbenchFaultAction =
  | "cancel_capture"
  | "disable_fixture_handler"
  | "submit_competing_capture"
  | "replace_fixture_world"
  | "write_invalid_artifact"
  | "stop_owned_workbench";

export type FaultMatrixCase = RuntimeFaultMatrixCase | WorkbenchFaultMatrixCase;
export function defineFaultMatrix(cases: readonly FaultMatrixCase[]): FaultMatrix;
export function caseForId(matrix: FaultMatrix, caseId: string): FaultMatrixCase;
export function validateFaultMatrix(cases: readonly FaultMatrixCase[]): void;
```

Use a discriminated union for `RuntimeFaultMatrixCase` and
`WorkbenchFaultMatrixCase`. Each variant carries its own action union; do not
use `action: string`, a shared action enum, or a backend/action compatibility
table that is only checked after parsing an untyped value. An action that can
only be meaningful to Workbench must be impossible to write in a runtime case
without an explicit unsafe cast in a test.

Each case is a complete declaration, not an instruction inferred from a test
name. Require these fields:

```ts
{
  schemaVersion: 1,
  id: "runtime.cancel_capture.lease_acquired.current",
  backend: "runtime",
  view: "current" | "pose" | "lookAt" | null,
  injection: { phase: FaultMatrixPhase, action: RuntimeFaultAction | WorkbenchFaultAction },
  phaseSupport: Record<FaultMatrixPhase, PhaseSupport>,
  expectedTerminal: { state: typeof OBSERVER_TERMINAL_STATES[number], errorCode: ObserverErrorCode | null },
  cameraDisposition: "restored" | "exact_process_exit" | "not_acquired",
  requiredChecks: readonly ("lifecycle_vacant" | "endpoint_vacant" | "child_vacant" | "exact_owner_vacant")[],
  requiredEvidence: readonly MatrixEvidenceField[],
}
```

`phaseSupport` must have every canonical phase as a key. Its value is either a
structured observable proof or `{ kind: "not_applicable", rationale: string
}`. A case may schedule only a phase with a proof. This is the explicit
not-applicable policy: it prevents a backend from silently omitting a phase,
while allowing a view that cannot reach a distinct product state to say why.
The validator must reject an empty rationale, an injection phase marked not
applicable, and a phase/action pair outside the action's declared phase set.

Use lower-case dot-separated stable IDs with this grammar:

```text
<backend>.<action>.<phase>.<view-or-na>
```

`<view-or-na>` is `current`, `pose`, `lookat`, or `na`; identifiers must match
`^[a-z][a-z0-9_]*(\.[a-z0-9_]+){3,5}$`. Do not put source method names,
paths, process IDs, runtime IDs, fixture GUIDs, dates, or random values in an
ID. The Phase 2 and Phase 3 inventories append cases through
`defineFaultMatrix`; they do not make private arrays in their runner scripts.

`defineFaultMatrix` must validate, clone, index by ID, and deeply freeze its
input. Export the production catalog as a module-level call to
`defineFaultMatrix`, so a bad checked-in catalog fails during import. During
this phase the catalog may contain only the declared foundation/available
cases; a runner must reject an `--only` ID that has not yet been declared,
rather than fabricate an unsupported row. The backend phases extend the same
catalog in a single change with their fixture capability.

The validator must reject all of the following before a live process can be
launched:

- a wrong schema version, malformed or duplicate ID, duplicate case object,
  unknown backend, view/action incompatible with its backend, or unknown
  phase;
- a missing `phaseSupport` member, a source-line-oriented proof, or an
  injection phase declared not applicable;
- an invalid expected terminal state/error-code combination: `completed` and
  `cancelled` require `null` because asynchronous job status only publishes an
  error code for `failed`; `failed` requires a non-null canonical error code;
- `not_acquired` after `lease_acquired`, or an `exact_process_exit`
  disposition without `exact_owner_vacant` evidence; and
- missing, duplicate, or unknown required evidence/check names.

The `PhaseSupport` proof is deliberately observable. It must name a public
status predicate and the corresponding fixture acknowledgement, never a
source location such as "after `await acquire()`". Use these canonical
proofs when writing backend cases:

| Phase | Runtime proof | Workbench proof |
| --- | --- | --- |
| `before_lease` | Fixture acknowledgement before native camera acquisition, while the public job is non-terminal and `cameraLeaseHeld !== true`. | Fixture acknowledgement before the adapter reports a held camera lease. |
| `lease_acquired` | Fixture acknowledgement after lease acquisition and a public job with `cameraLeaseHeld === true`. | Handler status is `accepted`/`settling` and `cameraLeaseHeld === true`. |
| `capture_in_progress` | Fixture acknowledgement while the public job is `capturing` or awaiting its artifact, before promotion. | Handler status is `capturing` or `awaitingArtifact`, with a held lease. |
| `restoration_in_progress` | Fixture acknowledgement after restoration has begun, while the public job still has a restoration obligation. | Handler status is `restoring` and the camera has not yet been proven restored. |
| `terminal_release` | Public terminal state has been captured but the harness has not invoked `release`; the release receipt is absent. | The same terminal-before-release condition against the adapter's handler lease. |

`terminal_release` is the last admissible synchronization point, not a
permission to schedule a fault after the case is closed. The scheduler marks a
case terminal only after it has captured the public terminal result, completed
or recorded the release/recovery obligation, and called `finishCase`.
`schedule`, `arm`, or `releaseBarrier` after `finishCase` must fail with a
fixed `CASE_TERMINAL` refusal.

### 3. Shared scheduler and local-only control channel

Create `scripts/observer-fault-matrix-support.ts`. Keep it independent from
the live scripts by injecting a mailbox, `Clock`, `Sleeper`, and lifecycle
binding reader. It owns:

- `FaultMatrixScheduler`, which resolves a case ID, waits for an observed
  phase arrival, sends one authorized action, and seals the case;
- `FaultControlAuthorizer`, which validates bootstrap, command, and
  acknowledgement envelopes; and
- small JSON/filename schema validators and fixed refusal-code enums.

The two backend fixtures use the same private, per-run mailbox shape. This is
intentionally separate from public observer ingress: do **not** extend
`RFO_ObserverMailboxTransport.c`, the Workbench NET API handler, or any MCP
tool. The runtime fixture may copy the existing mailbox transport's
new-file-per-message, sequence, and nonce approach. The Workbench fixture may
reuse the disposable-mailbox conventions from
`scripts/run-observer-enforce-mailbox-acceptance.mjs`. Both bridges exist only
inside generated fixture directories created by the live scripts and are not
included in a normal add-on build.

For each run, the launcher must:

1. Create a fresh `runId` and `randomUUID()` capability after preflight and
   before starting the disposable fixture.
2. Create an owned control root below the run's generated profile/fixture
   root; reject a symlinked or pre-existing root. It is never placed beneath a
   user project or a normal observer session directory.
3. Write one bootstrap document, readable only by the generated fixture,
   containing the raw capability and this complete binding:
   `runId`, backend, fixture content identity, generated project/add-on
   identity, lifecycle ID, and lifecycle generation.
4. Pass only the control-root location and run ID through the generated
   fixture configuration. The capability is read from the bootstrap document;
   it is not an argument, public status field, or evidence value.

For runtime, derive the lifecycle binding from the exact
`OwnedRuntimeManager` receipt/generation path. For Workbench, derive it from
the `WorkbenchProcessGuard`/lifecycle reservation that launched the generated
project and include its exact process/target binding. A PID, executable name,
project path, handler lease alone, or a fixture GUID alone is never enough.
The fixture compares every binding member against its startup authority before
it accepts a command. A restart, world/project replacement, lifecycle change,
or terminal release invalidates the binding.

Use this fixed v1 mailbox layout; no producer writes in place:

```text
<control-root>/bootstrap.json                 # launcher -> fixture, once
<control-root>/inbox/<sequence>-<capability>.json
<control-root>/outbox/<sequence>-<capability>.json
```

`sequence` is a zero-padded monotonic decimal value. Both readers accept only
the exact filename grammar, cap every document at 32 KiB, and refuse duplicate
sequence numbers. The fixture checks the capability in the filename before it
opens or parses the JSON body. It then validates an exact-object command
schema--unknown keys are a refusal, not forward compatibility.

The command body contains no duplicate raw capability:

```ts
{
  schemaVersion: 1,
  kind: "arm" | "release" | "cancel" | "terminal",
  runId: string,
  requestId: string,
  caseId: string,
  phase: FaultMatrixPhase,
  action: RuntimeFaultAction | WorkbenchFaultAction,
  binding: { fixtureId: string, lifecycleId: string, lifecycleGeneration: string },
}
```

For `arm`, `release`, and `cancel`, `caseId`, `phase`, and `action` must be an
exact match for the case selected by the host scheduler. `terminal` is emitted
only by the host after public terminal capture and has no action. The fixture
must validate the filename capability, run ID, fixture identity, and lifecycle
binding before it examines the action. It must never accept a generic script
expression, command name, path, process ID, endpoint, or arbitrary payload.

Use one acknowledgement schema with only fixed reason codes:

```ts
{
  schemaVersion: 1,
  kind: "arrived" | "executed" | "refused" | "terminalled",
  requestId: string,
  caseId: string,
  phase: FaultMatrixPhase,
  disposition: "arrived" | "executed" | "refused" | "terminalled",
  reason: FaultControlRefusalCode | null,
}
```

The only refusal codes are `MALFORMED`, `CAPABILITY_MISMATCH`,
`RUN_MISMATCH`, `FIXTURE_MISMATCH`, `LIFECYCLE_MISMATCH`, `MATRIX_MISMATCH`,
`PHASE_MISMATCH`, `REPLAY_REFUSED`, `CASE_TERMINAL`, and `DEADLINE_EXPIRED`.
Do not place parser errors, paths, command names, tokens, or native diagnostics
in an acknowledgement.

Barrier and replay rules are mandatory:

1. The fixture writes `arrived` only after it has reached the declared
   observable phase and has stopped before the action boundary. The scheduler
   first verifies that acknowledgement, then sends `release` or `cancel`; it
   must not use a sleep as phase synchronization.
2. The scheduler allocates one `requestId` for the case action. Retrying the
   same byte-equivalent command after a lost acknowledgement returns the
   recorded acknowledgement and does not execute the action again. The same
   request ID with different bytes is refused. A different action request
   after an action has executed is `REPLAY_REFUSED`.
3. Every wait receives the case `AbortSignal` and a deadline derived from the
   case deadline. An arrival timeout, missing acknowledgement, cancellation,
   or refusal calls `abort`, records a bounded failure, and starts ordinary
   product cleanup; it cannot leave the fixture paused indefinitely.
4. On `finishCase`, the scheduler sends `terminal` if the mailbox remains
   reachable, aborts outstanding waits, invalidates the capability and
   lifecycle binding in memory, and asks the host-owned cleanup path to remove
   the control root. The fixture also treats terminal/restart/world-change as
   permanent invalidation. A cleanup failure is a failed case, not a reason to
   retain a usable control channel.

Use `Deadline`/`pollUntil` for all waits. Keep the poll interval and maximum
per-barrier allowance as exported, testable constants in
`observer-fault-matrix-support.ts`; backend scripts may lower the allowance
from their remaining overall deadline but may not create a second timer loop.
The Phase 2 pilot sets the live values after measurement. Unit tests must use
`tests/support/manual-time.ts`, never real timeouts.

### 4. Matrix evidence and publication

Extend `scripts/observer-live-acceptance-support.ts`; do not add a direct
`writeFileSync` artifact path in either live runner. Keep the existing v1
operational-baseline artifact readable. Add a v2 discriminated matrix artifact
and a single shared publisher alongside `OperationalBaselineRecorder` and
`writeOperationalBaselineArtifact`:

```ts
{
  schemaVersion: 2,
  kind: "reforger_forge_runtime_observer_failure_matrix" |
        "reforger_forge_workbench_observer_failure_matrix",
  backend: "runtime" | "workbench",
  result: "passed" | "failed",
  evaluator: { kind: "local_maintainer", stableId: null },
  matrix: { schemaVersion: 1, declaredCaseIds: string[], sourceClosureSha256: string },
  cases: MatrixCaseEntry[],
  // retained baseline environment, workload, source, measurements,
  // process counts, limitations, and failure classification
}
```

The v2 builder must reuse the existing canonical source identity, launch
argument identity, environment, bounded process-count, and atomic-publication
logic. It may add a matrix-specific builder and filename prefix, but it must
use the same validation/publisher path rather than create a parallel artifact
format or a second redaction policy. Preserve v1 output for positive-path
baseline consumers until a separately reviewed migration removes it.

`MatrixCaseEntry` must have one and only one entry for every declared case.
It records only these portable facts:

```ts
{
  caseId: string,
  schedule: { backend, view, phase, action },
  result: "passed" | "failed",
  publicTerminal: { state, errorCode },
  deadline: { outcome: "completed" | "expired" | "cancelled", elapsedMs, budgetMs },
  worldRevision: "unchanged" | "changed" | "not_acquired" | "unavailable",
  camera: "restored" | "exact_process_exit" | "not_acquired" | "unproven",
  artifact: "validated" | "not_created" | "rejected" | "unproven",
  cleanup: { lifecycleVacant, endpointVacant, childVacant, exactOwnerVacant },
  retainedDiagnostics: readonly { sha256: string, byteCount: number, tail: string }[],
}
```

The builder rejects a passed artifact if any case fails, is missing, is
duplicated, has a terminal result different from its matrix declaration, has a
missing required check, or has an `unproven` required disposition. It also
rejects `result: "passed"` unless every declared case ID is present in sorted
matrix order. The artifact contains no raw job ID, run ID, lifecycle
generation, handler lease, endpoint, path, PID, owner token, capability,
arguments, image bytes, user name, host name, or machine identifier. A
digest may represent a retained file; the file name and absolute location may
not.

Before serializing a diagnostic tail, call `redactText` or
`redactDiagnostic` with `profile: "evidence_portability"`, a 4 KiB maximum,
and every per-run secret in `knownSecretValues`. Treat a redaction failure or
the discovery of an unsafe value in the post-redaction object as an unsafe
publication failure. Do not fall back to raw text.

Publish artifacts beneath the existing gitignored `docs/validation/` default,
or a caller-supplied external `--validation-root`. Use a distinct basename:

```text
<UTC-start>-<backend>-observer-failure-matrix-<uuid>.md
<UTC-start>-<backend>-observer-failure-matrix-<uuid>.json
```

The Markdown summary is compact: matrix result, product version, public case
table, source-closure hash, `local_maintainer` evaluator kind, limitations,
and hashes of retained diagnostics. It repeats no raw evidence. Write the
summary through a unique sibling first, validate/redact it, and atomically
rename it. Its SHA-256 and basename are then included in the JSON. Publish the
JSON manifest last through the existing unique-sibling/atomic-rename behavior.

There are exactly three publication outcomes:

| Outcome | Required behavior |
| --- | --- |
| All cases pass | Publish the Markdown summary and a `result: "passed"` JSON manifest last. |
| A case fails but all completed entries, diagnostics, and redaction validate | Publish a `result: "failed"` summary and JSON manifest last. This is debugging evidence, never passing evidence. |
| Matrix/evidence schema, redaction, or publication-closure validation fails | Publish no final JSON manifest and no final Markdown summary. Remove only the unique temporary siblings owned by this attempt, retain the in-memory failure reason, and fail the run. |

Use `operationalBaselineSource` to bind each matrix to the harness, the common
support file, `observer/protocol/fault-matrix.ts`,
`scripts/observer-fault-matrix-support.ts`, `src/foundation/redact.ts`,
`src/foundation/time.ts`, `src/observer/public-contract.ts`, and the relevant
backend source closure already named by the runtime or Workbench baseline
script. The matrix's source-closure digest must be derived from this sorted
set, not hand-written in a runner. `evaluator.kind: "local_maintainer"` with
`stableId: null` is the required evaluator representation; never derive an
identity from environment variables, the current user, or the hostname.

### 5. Hermetic test plan

Add these focused Vitest suites. They run through the existing `npm test`;
do not add a workflow step, Arma installation, live environment variable, or
graphical-process dependency.

| Test file | Primary seam and required assertions |
| --- | --- |
| `tests/observer/fault-matrix.test.ts` | Imports the production catalog and tests `defineFaultMatrix` with mutated in-memory entries. Cover duplicate IDs, invalid ID grammar, unknown backend/action/phase, missing phase proof, not-applicable injection, illegal action/phase pair, inconsistent terminal/error result, illegal camera disposition, duplicate evidence/check fields, and deep-freeze behavior. |
| `tests/observer/fault-control-channel.test.ts` | Uses an in-memory mailbox, fake lifecycle binding, and `ManualTime`. Prove valid arrival/release/action execution; wrong filename capability rejected before JSON parsing; malformed/oversize command; wrong run, fixture, lifecycle, or matrix binding; arrival and acknowledgement deadlines; cancellation; same-request lost-ack retry without re-execution; changed same-request rejection; second action rejection; restart/world-change invalidation; and all post-`finishCase` commands rejected. |
| `tests/observer/fault-matrix-evidence.test.ts` | Builds v2 artifacts in a temporary directory. Cover a valid passing artifact, a failing artifact, missing/duplicate case rows, terminal contradiction, absent required proof, summary hash mismatch, and the three manifest-last outcomes. Confirm the final manifest never appears before the summary is valid. |
| `tests/observer/live-acceptance-ci-isolation.test.ts` | Reads `.github/workflows/ci.yml` as CI configuration integrity evidence. Assert it contains neither `RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE` nor `RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE`, and invokes neither `dev:observer:acceptance:runtime` nor `dev:observer:acceptance:workbench`. |

Expand the existing `tests/foundation/redact.test.ts` only when a real
redaction policy gap is found; do not duplicate its unit coverage in the
matrix suite. The matrix evidence test must nevertheless use adversarial,
realistic values: a Windows home path and UNC path, a POSIX absolute path, a
numeric PID, a `-reforgerForgeOwnerToken=...` argument, a random UUID
capability, a bearer credential, a hostname/user-shaped value, and a raw
lifecycle/handler identifier. Assert none occur in either JSON or Markdown,
while their permitted SHA-256 and bounded non-secret facts remain.

Every invalid matrix test must call the production validator, not a test-only
copy. Every control-channel fake must call `FaultControlAuthorizer`, not
reimplement the acceptance predicate. This preserves the important property
that the real fixtures and fakes differ only at the mailbox/native-action
boundary.

### 6. Review checklist before Phase 2

- `npm test` passes on a clean clone without Tools installed.
- The new catalog, scheduler, authorizer, and evidence builder compile with
  `npm run build` and no production MCP or normal add-on surface changed.
- A code review can trace every exported terminal state and error code to the
  canonical public-contract/protocol owner.
- No fixture action can be sent without a fresh capability, matching generated
  fixture identity, and matching exact lifecycle generation.
- A lost acknowledgement is idempotent, but a second distinct action is not.
- A valid failed artifact is visibly failed; an unsafe or incomplete artifact
  has no final manifest; a passing manifest is always the last published file.
- Both Phase 2 and Phase 3 can add their concrete cases by using this contract
  and cannot bypass its validation through a runner-local schedule.

## Phase exit criteria

- Both backends can consume the same validated matrix and shared evidence
  contract.
- The control channel has no public MCP or ordinary add-on surface and rejects
  malformed, stale, mismatched, replayed, and post-terminal commands.
- Hermetic tests exercise the common validation path without requiring Arma
  Reforger Tools or a live graphical process.
- A backend team can add a real case without redefining shared safety or
  evidence rules.
