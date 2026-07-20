# Shared test support implementation guide

**Status:** Proposed follow-on work  
**Parent context:** [Cross-cutting consolidation implementation guide](README.md), Task 6  
**Prerequisite:** Task 2 supplies the injectable `Clock`, `Sleeper`, deadline,
and ordinary-poll contract consumed by the manual-time and wait support.  
**Research snapshot:** 2026-07-19, against the active working tree

## Outcome

`tests/support/` becomes the small, obvious home for ordinary test setup:

- a cleanup-safe temporary-root scope;
- a manually advanced implementation of the foundation time seam;
- a test-facing adapter over the foundation polling contract; and
- deterministic observer-session and registration builders.

An ordinary unit test should be able to create a disposable filesystem root,
advance a deadline, or construct a protocol-valid observer registration without
reimplementing cleanup, wall-clock timing, or a full protocol object. The
support layer is deliberately not a second runtime. Native-process,
filesystem-race, crash-recovery, and cleanup-timing tests retain direct control
when that direct control is part of what the test proves.

## Scope and fixed decisions

1. Add `tests/support/temporary-directory.ts`, `tests/support/manual-time.ts`,
   `tests/support/wait.ts`, and `tests/support/observer-fixtures.ts`, with
   focused tests beside them under `tests/support/`.
2. A temporary-root helper is callback-scoped, not a mutable module-level
   `beforeEach` fixture. This keeps roots isolated when Vitest runs tests in
   parallel and ensures `finally` cleanup for assertion failures and rejected
   promises.
3. The support layer creates real directories. A fake filesystem is not a
   requirement. The distinction is whether the test needs to own allocation or
   cleanup timing itself.
4. `ManualTime` implements Task 2's production-facing `Clock` and `Sleeper`
   interfaces structurally. It is not a `Date.now` monkey patch, a global fake
   timer, or a separate deadline implementation.
5. A test wait helper delegates directly to `#foundation/time` polling. It
   must not contain a second `Date.now`/`setTimeout` loop, choose a domain error
   code, or silently use wall-clock defaults.
6. Observer fixtures have one owner. The current
   `tests/observer/helpers.ts` session, clock, and graphical-registration
   builders move or are adapted into `tests/support/observer-fixtures.ts`.
   A temporary forwarding module may exist for one migration boundary only.
7. Reuse `tests/foundation/fake-exact-process-backend.ts` and the Workbench
   adapter in `tests/workbench/fake-lifecycle-backend.ts`. This task must not
   introduce another exact-process, Windows-helper, or lifecycle-backend fake.
8. Do not create a broad Workbench-fixture package speculatively. Extract a
   small `tests/support/workbench-fixtures.ts` module only after two unrelated
   suites need the same construction, and only for that shared construction.
   The Stage 3 policy fixture's lifecycle-specific behavior stays local.
9. Keep the migration ledger and documented exceptions in this task's review
   artifacts. Do not add a repository-wide architecture rule solely to enforce
   the support migration.

## Non-goals

- Do not replace Vitest's assertions, mocks, test contexts, or all uses of
  `vi.waitFor` with an abstraction.
- Do not make filesystem integration tests use in-memory paths or prevent a
  test from deleting its root halfway through when that deletion is the
  behavior under test.
- Do not move exact process identity, machine mutex, child-process,
  crash-recovery, native-helper, or cleanup authority into `tests/support/`.
- Do not change Task 2's timeout, cancellation, deadline, or polling
  semantics. Test support consumes that contract; it does not redefine it.
- Do not keep both `tests/observer/helpers.ts` and a new observer-fixture
  implementation indefinitely.
- Do not convert live Workbench or Windows acceptance tests into hermetic
  tests merely to remove a `mkdtemp`, a process, or an elapsed-time assertion.

## Starting-point inventory

Re-run the inventory before implementation and attach its output to the first
review. Counts are expected to change; the classifications, not a stale count,
are the deliverable.

| Current location | Existing role | Intended treatment |
| --- | --- | --- |
| `tests/observer/helpers.ts` | random-UUID temporary directory, manual clock, session fixture, graphical registration, repository paths | split ordinary temporary-root behavior into `temporary-directory.ts`; move observer-specific data and builders into `observer-fixtures.ts`; replace `FakeClock` with `ManualTime` where its broader seam is needed |
| observer unit suites such as `artifacts`, `jobs`, `registry`, `retention`, `mailbox`, and `staging` | repeated helper imports and manual `try`/`finally` cleanup | migrate in small reviewable groups to callback-scoped roots and observer builders |
| `tests/workbench/workbench-policy-fixture.ts` | Stage 3 target-build policy fixture, fake child, lifecycle adapter, and manual cleanup | retain as the authoritative Stage 3 fixture; compose the temporary-root scope only if its lifecycle proves compatible; extract only genuinely shared construction |
| `tests/foundation/fake-exact-process-backend.ts` and `tests/workbench/fake-lifecycle-backend.ts` | shared exact-process fake and Workbench-specific adapter | retain and reuse; do not duplicate |
| direct `mkdtempSync` use in observer, Workbench, and integration tests | mixture of ordinary setup and behavior-sensitive native setup | classify each call as **migrate**, **retain**, or **move to a narrowly named fixture** |
| local `waitFor`, `vi.waitFor`, and `setTimeout` use | mixture of ordinary eventual assertions, child-process scheduling, and lifecycle races | delegate ordinary deterministic polling to Task 2; retain tests that prove real event-loop, child, or cleanup timing |

Useful characterization commands:

```powershell
rg -n "mkdtemp(Sync)?\\(" tests -g "*.ts"
rg -n "temporaryDirectory\\(|cleanup\\(" tests -g "*.ts"
rg -n "vi\\.waitFor|function waitFor|setTimeout|pollUntil" tests -g "*.ts"
rg -n 'from ".*helpers\.js"' tests -g "*.ts"
npm run test:cross-cutting:baseline
npm run test:stage3
npm run test:stage4
```

For every raw temporary-directory allocation, record the following in the
migration ledger:

| Field | Required content |
| --- | --- |
| File and test name | Exact current call site |
| Classification | `migrate`, `retain`, or `narrow fixture` |
| Behavioral reason | Why direct allocation, process ownership, or cleanup timing is asserted |
| Replacement or owner | Support helper, named local fixture, or no replacement |
| Removal condition | What change would make the exception unnecessary |

Examples likely to remain direct or use a named local fixture include
owned-runtime crash characterization, Windows owned-runtime integration,
multi-process lifecycle tests, process-identity races, and tests whose
assertion is the cleanup or persistence of a real OS-created path. A raw call
is not justified merely because the test happens to touch the filesystem.

## Target support contracts

The following shapes are intentionally small semantic contracts. Names may be
refined to fit the repository's conventions, but additions must preserve these
properties.

### Temporary directories

```ts
export interface TemporaryDirectoryOptions {
  readonly prefix?: string;
}

export async function withTemporaryDirectory<T>(
  run: (path: string) => Promise<T> | T,
  options?: TemporaryDirectoryOptions,
): Promise<T>;
```

Usage should read as one test-scoped resource:

```ts
await withTemporaryDirectory(async (root) => {
  await writeFile(join(root, "input.txt"), "fixture input");
  // Assert ordinary filesystem behavior using root.
}, { prefix: "rfo-registry-" });
```

Implementation requirements:

1. Create the root with Node's native unique-directory primitive under the OS
   temporary directory. Preserve a caller-provided prefix, but validate it as
   a single safe name prefix; it must not select an arbitrary parent directory.
2. Invoke `run` only after creation succeeds and pass only the root path. The
   helper should not create a wrapper filesystem API or hide native operations
   from the test.
3. Remove the root recursively and forcibly in `finally`, whether `run`
   returns, throws an assertion error, or returns a rejected promise. If
   cleanup itself fails, surface it without silently discarding the test-body
   failure (for example, as a suppressed or causal cleanup failure).
4. Do not cache, reuse, or publish a mutable current root. Two concurrent
   calls with the same prefix must receive different paths and clean up only
   their own paths.
5. A test that must delete a directory mid-test calls the native removal API
   on the supplied `path` directly. That operation remains visible in the test
   because it is the subject of its assertion; final cleanup then tolerates an
   already removed root.

Do not expose a standalone `cleanup(path)` as the normal API. It encourages
new `try`/`finally` boilerplate and makes failure cleanup easy to forget.

### Manual time

`ManualTime` is a deterministic test utility that implements the exact Task 2
`Clock` and `Sleeper` seams:

```ts
import type { Clock, Sleeper } from "#foundation/time";

export class ManualTime implements Clock, Sleeper {
  constructor(options?: { readonly nowMs?: number });

  now(): number;
  sleep(durationMs: number, options?: { readonly signal?: AbortSignal }): Promise<void>;
  advanceBy(durationMs: number): Promise<void>;
  advanceTo(targetMs: number): Promise<void>;
  runNextSleep(): Promise<boolean>;
  readonly pendingSleepCount: number;
}
```

The final surface may omit `runNextSleep` if `advanceTo` makes its behavior
unambiguous, but callers need a controlled way to release a scheduled poll
without waiting for wall time. Its semantics are:

- `now()` returns the manually maintained absolute time. Construction uses a
  fixed, documented default instant or a caller-supplied instant; it never
  reads `Date.now()` after construction.
- `sleep` records a wake-up at `now() + durationMs`; it allocates no real
  timer. A sleep resolves only when manual time reaches that wake-up, in stable
  insertion order for equal deadlines.
- `advanceBy` rejects invalid backward or non-finite movement; `advanceTo`
  rejects movement into the past. Both release due sleepers and allow their
  promise continuations to settle before resolving.
- `runNextSleep` advances exactly to the earliest pending wake-up and returns
  `false` when no sleeper is pending. It is useful for a polling test that
  should not know a private interval.
- An already-aborted signal rejects without registering a sleeper. Aborting a
  pending sleep removes it from the queue and listener set, preserves the
  surrounding abort reason where Task 2's contract exposes one, and cannot be
  resolved by a later advance.
- Tests can inspect the number of pending sleepers only to prove cleanup and
  scheduling behavior. They must not mutate the queue or manufacture a clock
  value.

The support implementation must use Task 2's duration validation or an
equivalent guard. It must not quietly accept values that production sleep or
polling would reject. Do not use `vi.useFakeTimers()` as a replacement: global
fake timers conceal the real child-process and event-loop behavior that several
Workbench and owned-runtime tests are specifically designed to exercise.

### Test wait adapter

`tests/support/wait.ts` exists only to make the correct foundation call short
in a test. Its implementation is a thin adapter over `pollUntil` with injected
`clock`, `sleeper`, `deadline`, `intervalMs`, and optional abort signal. A
representative contract is:

```ts
export async function waitForValue<T>(options: {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly deadline: Deadline;
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly probe: () => T | undefined | Promise<T | undefined>;
}): Promise<PollResult<T>>;
```

It may use a different name if it avoids colliding with Vitest's `vi.waitFor`,
but it must preserve the foundation result shape. In particular:

- call the foundation poller once rather than writing a loop around it;
- require a caller-provided deadline and time seam; no hidden `Date.now()` or
  real-time default timeout;
- leave timeout translation, assertion wording, and domain error codes to the
  calling test; and
- propagate probe errors and cancellation according to the foundation
  contract.

If a wrapper needs its own loop, timer, interval policy, or a special
"eventually" error, it is out of scope and should not be added. Existing
`vi.waitFor` remains appropriate where a test intentionally waits for a real
child event, socket cleanup, or scheduler effect and manual time cannot model
the event being observed.

### Observer fixtures

`tests/support/observer-fixtures.ts` owns deterministic observer test data.
It consolidates the useful portions of the current observer helper rather than
creating a new protocol fake:

```ts
export const testBundleDigest: string;

export function createObserverSessionFixture(options: {
  readonly root: string;
  readonly clock?: Clock;
  readonly sessionOptions?: SessionStoreOptions;
}): {
  readonly store: SessionStore;
  readonly created: ReturnType<SessionStore["create"]>;
  readonly profilePath: string;
  readonly clock: Clock;
};

export function graphicalRegistration(
  created: ReturnType<SessionStore["create"]>,
  overrides?: Partial<InstanceRegistration>,
): InstanceRegistration;
```

The default registration must pass the canonical
`instanceRegistrationSchema`, use the created session's contract values, have
a fixed valid instance identity and capability set, and derive `registeredAt`
from the fixture clock/session creation instant. Explicit overrides must win
without requiring a test to copy a complete `InstanceRegistration` object.

Keep observer-specific repository paths, the observer add-on source path, and
the test bundle digest beside these builders if they remain genuinely shared.
Do not put production constants in a generic test-utility file or hard-code a
second copy of the protocol schema.

### Workbench fixture extraction threshold

The existing `createWorkbenchPolicyFixture` is a useful Stage 3 fixture but is
not proof that all Workbench tests need a common owner. When a second unrelated
suite needs the same minimal construction, extract only the common portion:
for example, a disposable project layout, valid `Config`, canonical `.gproj`,
and managed-profile path. Keep fake child supervision, lifecycle traces,
reservations, target-build plans, and exact-process behavior in the current
Stage 3 owner unless those exact capabilities are also shared.

The extracted fixture must compose `withTemporaryDirectory` or have an equally
clear scoped cleanup story. It must not absorb the shared exact-process fake;
callers continue to obtain that fake from its existing foundation owner.

## Implementation tasks

### TEST-0: freeze behavior and create the migration ledger

1. Run the characterization commands and list every direct temporary-root
   allocation, observer-helper import, local polling helper, and real-time
   delay in the scope.
2. Classify each occurrence using the ledger fields above. Confirm the reason
   with the test assertion, not from the filename alone.
3. Add focused characterization coverage before changing any behavior-sensitive
   test: a current observer fixture must produce a schema-valid registration;
   selected lifecycle tests must retain their real child/cleanup behavior; and
   Task 2's ordinary polling behavior must be green.
4. Treat existing specialized owners as explicit boundaries: the foundation
   exact-process fake, the Workbench lifecycle adapter, and the Stage 3 policy
   fixture are not migration targets merely because they contain test setup.

**Acceptance:** A reviewer can identify every direct native setup call as an
ordinary migration, a named local fixture, or a current behavioral exception.

### TEST-1: add and prove the temporary-root scope

1. Implement `withTemporaryDirectory` using native unique-directory creation
   and asynchronous cleanup in `finally`.
2. Keep the prefix option in the public type and use stable repository naming
   such as `rfo-registry-` or `reforger-forge-launch-` to aid failure diagnosis.
3. Add `tests/support/temporary-directory.test.ts` before migrating callers.
   Capture the path inside the callback and verify it no longer exists after:
   - a successful synchronous callback;
   - a failed assertion or thrown callback error; and
   - a rejected asynchronous callback.
4. Use `Promise.all` to create at least two same-prefix scopes concurrently;
   prove their paths are different, both exist while their callbacks run, and
   both are gone afterward.
5. Add a test that removes the supplied root inside the callback and proves
   final cleanup is harmless. This protects tests whose subject is cleanup.

**Acceptance:** The only common temporary-directory API has automatic cleanup
on every test-body settlement path and has no shared mutable root state.

### TEST-2: add manual time against the foundation seam

1. Implement `ManualTime` in `tests/support/manual-time.ts` against the Task 2
   `Clock` and `Sleeper` types. Do not duplicate `Deadline`, `remainingMs`, or
   `pollUntil` in this file.
2. Store sleepers in a deterministic deadline-then-sequence queue. Ensure every
   resolution and abort removes its pending entry and abort listener.
3. Implement controlled advancement and microtask settlement. A test should be
   able to start a poll, advance to the next wake-up, and observe the next
   probe without an elapsed wall-clock delay.
4. Add `tests/support/manual-time.test.ts` for fixed construction, incremental
   advancement, multiple sleepers, equal-deadline ordering, next-sleeper
   advancement, invalid movement, abort-before-sleep, abort-during-sleep,
   listener/queue cleanup, and the absence of real timers.
5. Add one integration-style support test that passes `ManualTime` to Task 2's
   `pollUntil`: prove immediate probing, a bounded retry, expiry without a
   post-expiry probe, and cancellation. Keep the exhaustive timing semantics
   in `tests/foundation/time.test.ts`; this test proves compatibility only.

**Acceptance:** A fake time test can drive ordinary deadlines and polling
entirely through Task 2's public seam, with no global fake timers or sleeps.

### TEST-3: add the thin wait adapter

1. Implement `waitForValue` (or the selected non-conflicting name) by passing
   its inputs directly to Task 2's `pollUntil`.
2. Require explicit injected time and deadline inputs. Do not accept a bare
   numeric timeout; that would recreate a second deadline owner.
3. Add `tests/support/wait.test.ts` that verifies the adapter preserves a
   value result, expiry result, probe error, and abort result from the
   foundation contract using `ManualTime`.
4. Inspect the implementation during review: it should contain neither
   `Date.now`, `setTimeout`, nor a retry loop. If it becomes more than a narrow
   adapter, delete it and have tests call the foundation directly.

**Acceptance:** Tests that need deterministic ordinary polling have one
readable entry point and one actual polling implementation.

### TEST-4: migrate observer fixtures without duplicating the protocol

1. Move `testBundleDigest`, session construction, graphical registration, and
   any genuinely shared observer source paths from `tests/observer/helpers.ts`
   to `tests/support/observer-fixtures.ts`.
2. Replace the existing mutable `FakeClock` with `ManualTime` where the
   fixture only needs the `Clock` portion. Preserve a narrow clock type in the
   return value so tests that do not need sleeper control remain simple.
3. Keep the session fixture's current meaningful defaults: loopback agent,
   stable profile path, expected client runtime, protocol/add-on/build values,
   20-minute TTL, and REST/mailbox preference. Any intentional behavior change
   belongs in an observer contract change, not this consolidation.
4. Add `tests/support/observer-fixtures.test.ts`. Parse the default result with
   the canonical registration schema, assert that session-derived values are
   copied, and prove representative overrides such as capabilities, runtime
   kind, and registration timestamp are preserved exactly.
5. Migrate a first group of low-risk observer suites: `artifacts`, `jobs`,
   `registry`, and `retention`, to the new imports and callback-scoped roots.
   Run their focused tests before migrating the broader observer suite.
6. Migrate the remaining ordinary uses in observer application, mailbox,
   staging, paths, evidence, CLI, and cross-cutting tests. Convert each
   `try`/`finally` pair only when the root is ordinary setup; retain visible
   direct deletion where it is an assertion.
7. Replace `tests/observer/helpers.ts` with a one-line re-export only while a
   single reviewable migration group remains. Delete it before task closeout;
   do not leave an alternate fixture owner.

**Acceptance:** New observer tests can create a valid session and registration
with one fixture owner, while invalid-protocol tests still write their special
inputs explicitly.

### TEST-5: migrate ordinary Workbench setup conservatively

1. Start with pure Workbench unit tests whose temporary roots only hold fake
   projects, launch arguments, helper-source copies, or managed-profile data.
   Candidate suites include `helper-addon`, `launch-args`,
   `workbench-launch-plan`, and `project-identity`; reclassify each current
   call before changing it.
2. Convert ordinary roots to `withTemporaryDirectory` and remove duplicated
   cleanup helpers. Keep the native file operations inside the callback so the
   domain assertion remains legible.
3. Retain local scheduling or process fixtures where the assertion involves
   actual child exits, mutex holders, socket release, process identity, or
   cleanup timing. In particular, do not force `multiprocess-lifecycle`,
   restart ownership, termination-identity races, live lifecycle acceptance,
   or Stage 3 policy tests through a generic wrapper without an equivalence
   proof.
4. Extract a small Workbench fixture only when the second independent use has
   arrived. Add its own contract test proving valid `Config` and project paths,
   root isolation, cleanup, and preserved overrides; do not move lifecycle
   policy merely to increase adoption counts.
5. Where a deterministic poll is truly ordinary, migrate it to Task 2 plus
   `ManualTime`/the thin wait adapter. Leave `vi.waitFor` and real waits that
   observe real child or event-loop transitions documented in the ledger.

**Acceptance:** Ordinary Workbench unit setup is concise and cleanup-safe,
while exact-process and lifecycle tests remain honest about their native
dependencies.

### TEST-6: integration boundaries and deletion

1. Review every remaining raw temporary-root allocation after observer and
   Workbench migration. For each retained use, add a narrowly scoped ledger
   entry with its behavioral reason and removal condition.
2. Run integration and live-test candidates only in their supported Windows
   environment. Do not treat an unavailable controlled environment as a
   passed check.
3. Delete obsolete local `temporaryDirectory`, `cleanup`, manual-clock,
   observer-registration, and ordinary wait helpers after their final imports
   are migrated. Remove the observer forwarding module in the same change or
   immediately following review boundary.
4. Re-run the inventory commands. A new raw call found at closeout is a
   migration decision, not an unreviewed baseline addition.

**Acceptance:** Every remaining direct setup call has a specific behavioral
reason, and the old observer helper is gone.

## Required test matrix

Support tests must prove the support contracts themselves, not merely cover
some migrated caller:

| Area | Required coverage |
| --- | --- |
| Temporary root | success, assertion failure, async rejection, same-prefix concurrent isolation, cleanup after explicit mid-test removal, and caller prefix preservation |
| Manual time | fixed clock value, scheduled wake-up, no early wake-up, exact-deadline wake-up, stable equal-deadline order, `runNextSleep`, invalid advance rejection, abort before/during sleep, queue/listener cleanup, and no wall-clock timer |
| Foundation compatibility | immediate poll probe, controlled retry, bounded final wait, expiry without an extra probe, probe error, and cancellation through `ManualTime` |
| Wait adapter | direct forwarding of success, expiry, error, and cancellation; no independent timeout logic |
| Observer builders | schema-valid default, session-derived fields, deterministic defaults, and exact preservation of representative overrides |
| Migration regression | representative observer and Workbench domain assertions still pass after setup changes; a retained native test proves why its direct resource control remains necessary |

When testing cleanup after a failing callback, capture the root path before
throwing and assert absence outside the rejected `withTemporaryDirectory`
promise. Do not make a test intentionally leave data in the OS temporary
directory as proof of failure behavior.

## Migration and review rules

Keep each pull request or review group small enough that a reviewer can see
both the helper contract and the affected domain assertions. Recommended order:

1. support implementation and its direct tests;
2. low-risk observer fixtures and ordinary roots;
3. remaining observer unit suites and cross-cutting setup;
4. ordinary Workbench unit roots;
5. only then integration classification, narrow fixture extraction, and
   helper deletion.

For every migration, confirm all of the following:

- the test still asserts the same production behavior rather than merely the
  new helper;
- a root path is unique and cleanup occurs even on failure;
- deterministic waits receive the injected Task 2 clock, sleeper, and
  deadline explicitly;
- native/process-sensitive tests remain direct when their scheduling or
  cleanup behavior is evidence; and
- the source has no second implementation of an observer builder, exact
  process fake, polling loop, or temporary-root owner.

## Validation

Run focused support and migration suites after each group, then the repository
checks:

```powershell
npm run build
npm test -- tests/support/temporary-directory.test.ts tests/support/manual-time.test.ts tests/support/wait.test.ts tests/support/observer-fixtures.test.ts
npm test -- tests/observer/artifacts.test.ts tests/observer/jobs.test.ts tests/observer/registry.test.ts tests/observer/retention.test.ts
npm test -- tests/workbench/helper-addon.test.ts tests/workbench/launch-args.test.ts tests/workbench/workbench-launch-plan.test.ts tests/workbench/project-identity.test.ts
npm run test:cross-cutting:baseline
npm run test:stage3
npm run test:stage4
npm test
npm run test:package
```

When the controlled Windows environment is available, also run the applicable
Workbench and observer integration/acceptance commands. Record unavailable
live validation as **skipped**, with the environment reason, rather than as a
pass. Attach the pre- and post-migration inventory and the final exception
ledger to the review.

## Completion criteria

This task is complete when:

- `tests/support/` owns cleanup-safe temporary roots, Task 2-compatible manual
  time, the thin deterministic wait adapter, and observer fixture defaults;
- ordinary tests no longer hand-roll temporary-root creation/cleanup or
  deterministic polling;
- support cleanup works after successful, failing, rejected, and concurrent
  test scopes;
- observer builders have canonical, deterministic, protocol-valid defaults and
  preserve explicit overrides;
- the shared exact-process fake remains the only exact-process test fake;
- any Workbench extraction is small, actually reused, and does not absorb
  lifecycle policy;
- every raw native root, real-time wait, and direct cleanup remaining in tests
  has a narrow documented behavioral reason; and
- focused, baseline, Stage 3, Stage 4, full, package, and available controlled
  checks are green.
