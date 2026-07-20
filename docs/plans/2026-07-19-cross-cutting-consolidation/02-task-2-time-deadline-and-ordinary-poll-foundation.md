# Time, deadline, and ordinary-poll foundation implementation guide

**Status:** Proposed follow-on work  
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 2  
**Research snapshot:** 2026-07-19, against the active working tree  
**Entry condition:** Retain Task 0's baseline and characterization results
with the review. This work does not change durable lifecycle ownership,
recovery, public error codes, or operational performance measurements.

## Outcome

`src/foundation/time.ts` owns the small, injectable primitives for ordinary
delays, absolute deadlines, remaining-budget calculation, and ordinary polling.
New and migrated local waits use those primitives rather than independently
combining `Date.now()`, `setTimeout`, and loop conditions.

The module is deliberately not a lifecycle policy engine. Callers retain their
existing decisions about what expiry means: an artifact wait may return
`ARTIFACT_INCOMPLETE`, a log-attribution wait may return
`LOG_ATTRIBUTION_FAILED`, cancellation may remain `CANCELLED`, and the durable
Workbench and owned-runtime paths retain their current recovery behavior.

The migration removes repeated ordinary timing arithmetic without weakening the
persisted absolute expiry, fencing, exact-process verification, or public
error mapping owned by `OwnedRuntimeManager` and the Workbench lifecycle code.

## Scope and fixed decisions

1. Add `src/foundation/time.ts` and `tests/foundation/time.test.ts`. Use the
   existing `#foundation/*` import map; the normal build already emits
   `src/foundation` to `dist/foundation`.
2. A deadline is an injected-clock absolute instant. A child deadline may
   shorten a parent budget but can never outlive it.
3. Every public duration is validated before allocating a timer. Reject
   negative, non-finite, non-integer, and timer-overflow-prone values; do not
   rely on Node's timer clamping behavior.
4. Ordinary polling probes immediately. Later probes occur only after a
   bounded wait that observes cancellation and uses the current remaining
   budget. There is no final unbounded probe after expiry.
5. The foundation reports a neutral timeout/cancellation/probe result or
   throws the original probe error. It does not select domain codes, rewrite
   diagnostics, or retry a failed domain operation on its own.
6. `src/foundation/reservation-gate.ts` keeps its current durable,
   idempotent-reservation retry ordering. It may reuse a low-level validated
   clock/delay primitive only when doing so cannot alter that ordering; it is
   not to be replaced with generic `pollUntil`.
7. `src/workbench/readiness.ts` keeps its timing seam and its race between
   retry delay, child exit/error, and abort. A generic delay that cannot wake
   promptly for those events is not a valid replacement.
8. Do not migrate unrelated IPC, socket, fetch, response, interval, or native
   process timeout timers merely because they use `setTimeout`. Operational
   baseline measurements retain their intentionally monotonic clock.
9. `src/observer/owned-runtime-manager.ts` is the last and highest-risk
   migration. It consumes only a compatibility adapter for ordinary wall-clock
   waiting; its persisted absolute expiry, recovery records, fences, identity
   checks, and public result mapping remain local.

## Non-goals

- Do not create one universal timeout abstraction for network, IPC, process,
  interval, and lifecycle APIs.
- Do not convert persisted lifecycle records from absolute expiry timestamps to
  relative durations.
- Do not alter retry authority, idempotency semantics, recovery receipts,
  endpoint ownership, or exact-process termination behavior.
- Do not make a real-time unit test acceptable where a fake clock/sleeper can
  prove the behavior deterministically.
- Do not move performance instrumentation to wall-clock deadlines or infer
  lifecycle policy from a performance budget.

## Starting-point inventory

Re-run the searches before implementation and record each result in the
migration ledger. The categories below are the contract; exact line counts are
expected to move as the worktree changes.

| Current owner | Current concern | Intended treatment |
| --- | --- | --- |
| `observer/agent/artifacts.ts` | stable regular-file polling with a local `Date.now()` deadline and delay | migrate to ordinary foundation polling first |
| repository-only acceptance scripts, including `scripts/run-workbench-build-acceptance.ts` | local log/capture/terminal polling and budget arithmetic | migrate only ordinary waits; retain test/evidence-specific error text and live-run policy |
| `src/workbench/readiness.ts` | readiness/vacancy polling through an injectable timing seam | adapt the existing seam, preserving exit/error/abort races |
| `src/workbench/process-guard.ts` | local process-inspection sleep loop | migrate after foundation characterization tests pass |
| `src/workbench/runner.ts` | local log-attribution polling and remaining-time calculations | migrate ordinary polling while retaining attribution failure policy |
| `src/workbench/lifecycle-execution.ts` | retry loops, some of which are recovery-sensitive | migrate only loops with no durable receipt/recovery semantics |
| `src/foundation/reservation-gate.ts` | durable idempotent reservation retry semantics | retain as a specialized owner; adapt narrowly, if needed |
| `src/observer/owned-runtime-manager.ts` | persisted wall deadline, fences, recovery and public results | final compatibility-adapter migration only |

The parent guide's shorthand "coordinator" refers to the current
`observer/agent/mailbox-coordinator.ts`; inventory its actual waits before
changing it. `src/observer/capture-service.ts` already has injected
`now`/`sleep` seams and needs an explicit classify-as-migrate-or-retain
decision, rather than a blanket replacement.

Useful characterization commands:

```powershell
rg -n "function sleep|pollUntil|waitFor|deadline|remaining|setTimeout" observer src scripts tests -g "*.ts" -g "*.mjs"
rg -n "Date\.now\(\)|timers/promises|new Promise.*setTimeout" observer src scripts tests -g "*.ts" -g "*.mjs"
npm run test:cross-cutting:baseline
npm run test:stage3
npm run test:stage4
```

Before moving a call site, characterize its first-probe timing, final-attempt
behavior, cancellation behavior, accepted duration range, error/result code,
and timer cleanup. Record each decision in a migration ledger as **migrate**,
**retain**, or **specialized adapter**, with the reason.

## Target foundation contract

Keep the exported surface small. Exact type and function names may differ, but
the implementation must provide an equivalent, injectable contract:

```ts
export interface Clock {
  now(): number;
}

export interface Sleeper {
  sleep(durationMs: number, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface Deadline {
  readonly atMs: number;
}

export function deadlineAfter(clock: Clock, durationMs: number): Deadline;
export function deriveDeadline(
  clock: Clock,
  parent: Deadline,
  durationMs?: number,
): Deadline;
export function remainingMs(clock: Clock, deadline: Deadline): number;

export async function pollUntil<T>(options: {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly deadline: Deadline;
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly probe: () => Promise<T | undefined>;
}): Promise<{ readonly kind: "value"; readonly value: T } | { readonly kind: "expired" }>;
```

This is a semantic sketch, not permission to make every call site depend on a
large options bag. Keep the system clock/sleeper implementation private or
minimal, and make deterministic fakes easy for tests to construct.

### Deadline and duration semantics

- Validate a duration before creating the deadline or scheduling its timer.
  Use safe integer milliseconds and a finite maximum compatible with the
  timer implementation. A caller must receive a clear argument error rather
  than a clamped or unexpectedly immediate timer.
- `remainingMs` returns zero once expired. It never returns a negative value
  or reconstitutes budget from a previous loop iteration.
- `deriveDeadline(parent, childBudget)` computes `min(parent.atMs,
  now + childBudget)`. A derived deadline without a child budget is exactly
  the parent deadline, not a fresh budget.
- Use one clock consistently within a deadline calculation. The system
  adapter may use `Date.now()` for ordinary wall-clock work, while fake clocks
  advance only under test control.
- A deadline used for persistent lifecycle state remains an absolute persisted
  value controlled by its existing owner. The foundation must not serialize,
  recover, or reinterpret that state.

### Sleep and cancellation semantics

The system sleeper must clear its timer and remove any abort listener on every
settlement path. It must reject or otherwise report an already-aborted signal
without allocating a timer, and it must stop waiting promptly when abort occurs
during a delay. Preserve the original abort reason where the surrounding
contract exposes it.

Callers may choose whether a cancelled wait becomes an exception or a neutral
result, but they must make that translation outside the generic foundation.
Likewise, a probe exception propagates unchanged unless the calling domain has
an established mapping at its own boundary.

### Ordinary poll semantics

`pollUntil` must use this sequence:

1. Check cancellation and probe immediately.
2. If the probe supplies a value, return it without allocating a timer.
3. Compute the current remaining budget from the absolute deadline. If it is
   exhausted, return the neutral expiry result.
4. Wait for `min(intervalMs, remainingMs)`, observing cancellation.
5. Recompute time and repeat. Never perform a probe solely because a loop
   iteration started before expiry.

The probe's success predicate is caller-owned. The foundation should not infer
that a false boolean, empty array, `null`, or a domain status string means
success. Provide a narrow API that lets a caller state its predicate explicitly
or return a distinguished "not ready" value.

## Implementation tasks

### TIME-0: freeze current behavior and classify timing owners

1. Run the characterization commands and build the migration ledger described
   above. Include every local sleep, deadline, and polling loop in the listed
   migration areas.
2. Add focused characterization assertions for artifact stability, Workbench
   readiness/vacancy, log attribution, process inspection, lifecycle recovery,
   and the owned-runtime wall deadline. Capture first probe, final budget,
   errors/results, and cancellation behavior.
3. Mark each `setTimeout`, `setInterval`, timer-promise import, and clock seam
   in the inventory as ordinary wait, specialized lifecycle wait, network/IPC
   timeout, performance measurement, or out of scope. A text match alone is
   not migration authority.

**Acceptance:** A reviewer can explain why each selected loop is ordinary and
why each retained timer is specialized or out of scope.

### TIME-1: implement and prove the foundation primitives

1. Add `src/foundation/time.ts` with injected clock and sleeper seams, a
   production wall-clock/timer implementation, deadline creation/derivation,
   remaining-budget calculation, and ordinary polling.
2. Validate all public duration and interval inputs at the foundation
   boundary. Reject invalid input before calling `setTimeout`.
3. Ensure derived deadlines cannot exceed their parent, even when a fake clock
   advances between calculations.
4. Make all timer/listener cleanup explicit and testable. Avoid detached timer
   promises that can fire after a completed or aborted poll.
5. Add `tests/foundation/time.test.ts` before migrating production owners.

**Acceptance:** The foundation has deterministic fake-clock coverage and no
test relies on elapsed real time to prove deadline behavior.

### TIME-2: migrate low-risk artifact and repository-only waits

1. Replace the local stable-file deadline loop in `observer/agent/artifacts.ts`
   with the foundation. Keep its file inspection rules and
   `ARTIFACT_INCOMPLETE` mapping at the artifact boundary.
2. Migrate ordinary polling in repository-only acceptance scripts, beginning
   with the Workbench build-acceptance log wait. Preserve live-run confirmation,
   evidence shape, attribution rules, and script-specific diagnostics.
3. For each script, leave any external command, socket, process, or protocol
   timeout in place unless the ledger classifies it as an ordinary poll.
4. Convert new test paths to fakes or injected seams where practical; do not
   introduce a generic global fake timer that conceals child-process behavior.

**Acceptance:** Artifact and acceptance waits have the same public outcomes,
while their ordinary timing arithmetic is owned by the foundation.

### TIME-3: adapt coordinator and Workbench readiness timing

1. Inspect the current mailbox coordinator for ordinary delayed polling. Use
   the foundation only for those waits, retaining its durable mailbox ordering
   and cursor/receipt behavior.
2. Adapt `src/workbench/readiness.ts` through its established timing seam.
   Its delay continues to race child exit/error and abort; an exit or abort
   must wake the caller without waiting for the entire poll interval.
3. Preserve the readiness and endpoint-vacancy callers' current absolute
   deadline checks, detailed diagnostics, and endpoint ownership policy.
4. Add regression tests for an exit/error or abort occurring while the delay
   is pending, as well as the normal immediate-ready and delayed-ready cases.

**Acceptance:** Readiness remains promptly interruptible and its existing
diagnostic and error behavior is unchanged.

### TIME-4: migrate ordinary Workbench guard and runner waits

1. Migrate the local process-inspection sleep/poll helper in
   `src/workbench/process-guard.ts`. Keep all exact process identity
   inspection, machine-mutex, and failure classification local.
2. Migrate ordinary log-attribution polling in `src/workbench/runner.ts`.
   The runner decides whether expiry becomes `LOG_ATTRIBUTION_FAILED`; the
   foundation only supplies the bounded wait and polling sequence.
3. Reuse derived deadlines for sub-budgets so every runner stage remains
   bounded by the existing overall build deadline.
4. Retain process-spawn, endpoint probe, and native execution timeout behavior
   unless TIME-0 explicitly classified a wait as ordinary.

**Acceptance:** Workbench local polling has one timing owner without changing
process attribution, machine ownership, or runner receipt policy.

### TIME-5: migrate only non-durable lifecycle-execution retries

1. Inspect every retry path in `src/workbench/lifecycle-execution.ts` before
   changing it. Separate ordinary retries from recovery paths that publish,
   preserve, or reconcile durable state.
2. Migrate only the former to the foundation. Leave recovery deadline races,
   exact identity publication, and post-spawn uncertainty handling in their
   existing owner unless an adapter can prove equivalence through focused tests.
3. Preserve current cleanup and cancellation order. A foundation timeout must
   not skip a required identity inspection or retained-child record.

**Acceptance:** No generic time helper changes a durable recovery result or
the ordering of a recovery-sensitive retry.

### TIME-6: introduce the owned-runtime compatibility adapter last

1. After TIME-1 through TIME-5 and their focused suites pass, introduce a thin
   owned-runtime adapter for ordinary wall-clock waits only.
2. Keep persisted absolute expiry, fence checks, recovery files, exact native
   process verification, stop authority, and public `ObserverError` mapping in
   `OwnedRuntimeManager`.
3. Route the adapter through the existing clock/test seam so V5-focused
   lifecycle tests can run unchanged. Do not replace the manager's durable
   deadline helper merely for naming consistency.
4. Remove an old helper only after every affected recovery, endpoint, and
   exact-process test is passing through the adapter.

**Acceptance:** The high-risk manager retains its durable semantics while the
ordinary wait implementation is shared and testable.

### TIME-7: remove duplicate ordinary owners and close out

1. Delete migrated local ordinary sleep/poll helpers and update tests to
   exercise the foundation contract rather than deleted implementation names.
2. Re-run the inventory searches. Document every retained specialized timer
   and any newly discovered ordinary loop; do not leave a silent exception.
3. Add only a scoped architecture assertion if it can distinguish a newly
   introduced ordinary poll from known specialized timing seams. Task 7 owns
   the broader cross-cutting architecture check.

**Acceptance:** New ordinary sleeps and polling loops have one reviewed
foundation owner, while specialized lifecycle and I/O timing remain explicit.

## Required test matrix

The foundation suite must cover, at minimum:

- immediate success without creating a timer;
- delayed success after one or more bounded waits;
- expiry before any retry and no post-expiry probe;
- a final wait capped exactly to the remaining budget;
- invalid duration/interval rejection before timer allocation;
- a derived deadline equal to or earlier than its parent;
- a probe exception propagated without retry or remapping;
- abort before call, abort during a delay, abort listener removal, and timer
  cleanup on success, expiry, error, and abort; and
- a fake clock/sleeper proving no wall-clock sleep is required.

Migration suites must additionally prove:

- artifact stability still maps expiry to `ARTIFACT_INCOMPLETE`;
- Workbench readiness delay still races child exit/error and abort;
- runner log attribution retains its stable failure mapping and remains within
  its parent build deadline;
- process-guard exact-process behavior is unchanged by an ordinary delay;
- durable reservation behavior and retry ordering remain unchanged; and
- owned-runtime recovery, exact-process, fence, endpoint, and public result
  tests pass unchanged through the final adapter.

Use fake clocks that advance only when the fake sleeper is awaited. Include a
test where the probe itself advances the clock to the deadline, proving that
the next action is expiry rather than an extra timer allocation or final probe.

## Validation

Run focused suites after each migration group, then the complete repository
checks:

```powershell
npm run build
npm test -- tests/foundation/time.test.ts tests/workbench/readiness.test.ts tests/workbench/process-guard.test.ts tests/workbench/runner.test.ts tests/workbench/workbench-session-controller.test.ts tests/observer/private-child-owned-runtime-recovery.test.ts
npm run test:cross-cutting:baseline
npm run test:stage3
npm run test:stage4
npm test
npm run test:package
```

When a controlled Windows environment is available, run the applicable
repository-only Workbench and observer acceptance commands. Record any
unavailable live validation as skipped, not passed. Attach the migration ledger
and the post-migration timer inventory to the review.

## Completion criteria

This task is complete when:

- `src/foundation/time.ts` is the reviewed owner of ordinary delay, deadline,
  remaining-budget, and polling semantics;
- every migrated ordinary wait validates duration at its boundary, observes
  cancellation, and cannot exceed its absolute deadline;
- no poll performs a final unbounded attempt after expiry;
- callers still own domain error codes and lifecycle/recovery policy;
- reservation-gate, readiness, operational measurement, network/IPC timers,
  and durable owned-runtime semantics remain intentionally specialized;
- the owned-runtime migration is only a compatibility adapter and all V5
  focused lifecycle behavior is preserved;
- fake-clock tests prove the foundation contract without real-time sleeps; and
- focused, baseline, Stage 3, Stage 4, full, package, and available controlled
  checks are green.
