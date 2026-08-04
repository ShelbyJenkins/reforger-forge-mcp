# MCP Lifecycle Option A Implementation Plan

## Status

Phases 0, 1, and 2 were implemented and validated on 2026-08-04. The full
hermetic suite, guarded real Workbench lifecycle acceptance, and built
MCP/private-child process-tree acceptance all passed. Per the explicit no-game
constraint, no game runtime was launched; the persistent unsafe owned-runtime
path was exercised by the real-child black-box test instead. This document
covers only Option A: make MCP shutdown bounded and retry-correct, quiesce
Observer work before sealing owned runtimes, and load the API search index on
first use.

The diagnostics change must land before the shutdown redesign. The current
15-second failure drops the structured `OwnedRuntimeError.details`, so the
first implementation step is to turn the unexplained idle failure into
evidence and classify it. The remaining lifecycle tasks must preserve the
existing exact-runtime safety invariant even if the evidence changes which
branch is producing the failure.

## Plan validation record (2026-08-03)

The submitted feedback was checked against the current source, tests, and a
targeted test run. Its conclusions hold, with two wording refinements recorded
below.

1. **An unconditional `closeServices()` is unsafe.**
   `tests/observer/owned-runtime-manager-shutdown-integrity.test.ts` explicitly
   verifies that the Observer application stays alive and the coordinator is
   not closed when sealing is incomplete. `OwnedRuntimeManager.close()` also
   clears `closing` and `closePromise` after an unsafe result so that the same
   live application can be retried. Moving `closeServices()` to an unconditional
   `finally` would violate that recovery contract.
2. **The current shutdown order contains a real convergence cycle.**
   `observer/agent/application-operations.ts` reports a runtime ready to stop
   only when active jobs, camera leases, and restoration-pending jobs are all
   empty. During automatic shutdown, `CaptureService.close()` is the host-side
   convergence path that cancels those obligations, but it is currently called
   from `closeServices()` only after a safe owned-runtime seal. Public explicit
   cancellation exists, so the precise finding is about the automatic shutdown
   path rather than the absence of all other cancellation APIs. The required
   order is quiesce, then seal, then close terminal services.
3. **The originally named event-loop mechanisms were incorrect.**
   The capture retention sweep is `unref()`'d, and `shutdownHold` is cleared in
   `src/index.ts` even when disposal rejects. A started private Observer child
   is the relevant live-handle mechanism: `ObserverAgentClient` forks it with a
   piped `stderr` and an IPC channel, and both remain referenced. The 15-second
   delay matches `OwnedRuntimeManager`'s default `lockTimeoutMs` and its
   aggregate close wall deadline. With no child ever started, the process can
   exit after that failure; with a started child, the failed seal deliberately
   leaves the client and child live. The latter causal explanation is
   source-backed but must still be covered by a black-box regression test.
4. **The outer disposer defeats the manager's retry design.**
   `src/server.ts` memoizes `observerShutdown` with `??=`. A rejected promise is
   therefore retained forever even though `OwnedRuntimeManager.close()` resets
   its own close state after an unsafe result. Concurrent attempts should still
   coalesce, but a failed attempt must be removable and retryable.
5. **The revised memory estimate is credible and materially smaller than the
   original estimate.**
   The constructor of `SearchEngine` synchronously loads the index, and the
   loader synchronously reads and parses the API JSON tree. The supplied
   post-GC characterization (about 96 MiB after registration with an empty
   index versus about 229 MiB with the full index) agrees with the observed
   startup shape: lazy loading should remove roughly 130-136 MiB per idle
   instance, not 250 MiB. RSS is environment-sensitive, so the implementation
   will record comparative measurements rather than make an exact RSS value a
   CI assertion.
6. **Laziness belongs inside `SearchEngine`.**
   Search tools are not its only consumers. `src/server.ts` supplies the engine
   to the class and group resources as well as other tool registrations. One
   submitted phrase is slightly imprecise: the pattern resource receives the
   separate `patterns` object, not `SearchEngine`. That does not change the
   conclusion that gating only search handlers would miss valid first-use
   paths.

The feedback about a future shared server was also checked, but that option is
explicitly outside this plan. No shared-transport or multi-session server work
is specified here.

The following targeted baseline passed before this plan was written:

```powershell
.\node_modules\.bin\vitest.cmd run `
  tests/observer/owned-runtime-manager-shutdown-integrity.test.ts `
  tests/index/search-engine.test.ts
```

Result: 2 test files and 61 tests passed.

### Phase 0 diagnostic checkpoint (implemented 2026-08-03)

The controlled lifecycle characterization did not reproduce a 15-second
failure in either clean state. An application with no Workbench, private child,
jobs, or owned runtimes closed without starting a child. A real started private
child with no jobs or owned runtimes also closed cleanly and its PID was no
longer alive afterward. A started child alone is therefore not sufficient to
produce the failure.

The controlled unsafe state did reproduce the source-backed convergence
cycle: an exact owned runtime with an active/restoration-pending capture was
reported with `applicationCloseSafe: false`, its exact runtime ID, and the
active-job/camera-lease obligation category. Ordinary close retained the same
private child for retry. This evidence supports the Phase 1 order implemented
below: quiesce admitted capture work before exact-runtime sealing, and retain
the agent connection whenever the seal remains unsafe. The earlier unexplained
clean-idle symptom is not being relabeled as this active-work case; it remains
unreproduced by the hermetic three-state fixture.

## Goal

Deliver two independent but complementary improvements without changing MCP
tool schemas, client configuration, or exact-runtime ownership semantics:

- an orderly shutdown that first stops admissions and converges active capture
  work, seals exact owned runtimes while the Observer connection remains live,
  and closes terminal services only after a safe seal;
- a CLI-owned hard shutdown deadline that exits non-zero and cannot leave its
  disposable private child behind if orderly recovery never becomes safe; and
- a lazily initialized `SearchEngine` that preserves all current results while
  avoiding the full API JSON parse for MCP instances that never use an
  index-backed tool or resource.

Expected idle memory after the index change is approximately the empty-index
registration baseline, currently about 95-100 MiB on the measured machine.
Using the submitted characterization, five idle agents should fall from about
1.15 GiB to about 480 MiB. These are characterization targets, not portable
hard limits.

## Safety invariants

The implementation is not complete unless all of these remain true:

1. An ordinary or embedded shutdown must not close the Observer agent client,
   Workbench restoration services, or exact-runtime coordinator while a seal is
   unsafe or retryable.
2. Shutdown must reject new MCP requests before lifecycle convergence begins.
   Internal cancellation, release, restoration, and seal operations must retain
   access to the still-live Observer connection.
3. Quiescence must cover work already admitted before shutdown. Merely setting
   `CaptureService.sealed` is insufficient; in-flight admissions must be
   aborted, awaited, and converged within the shared deadline.
4. A retry must use the same application and durable ownership identity. It
   must not silently replace the private child or publish an unsafe runtime as
   vacant.
5. The CLI hard-deadline path is an emergency process-crash path, not a clean
   close. It must log a bounded, redacted diagnostic, terminate only the
   disposable process-owned child, and exit non-zero. Durable leases remain for
   the next owner to reconcile.
6. Library and embedded disposal APIs must never call `process.exit()`.
   Process termination policy belongs only to `src/index.ts`.
7. Lazy loading must be transparent to every public index-backed operation and
   resource. A load failure must never expose a partially built index.

## Shutdown state and deadline contract

Represent the host lifecycle explicitly rather than deriving it from several
booleans:

```text
open -> quiescing -> sealing -> closing -> closed
                    |
                    +-> retryable_unsafe -> quiescing/sealing on retry
```

`retryable_unsafe` is closed to new public work but retains the services needed
to cancel obligations and retry exact-runtime sealing. Concurrent close calls
for the same attempt share one promise. A rejected or unsafe attempt clears the
outer attempt promise after the application state has been made retryable; a
successful close remains memoized.

Use one absolute `deadlineAtMs` throughout shutdown. Do not grant a fresh
15-second budget each time the manager or outer disposer retries. Existing
operation-specific timeouts may clamp their work further, but no phase may
extend the process-wide deadline.

The production CLI deadline is 30 seconds. This leaves room for capture
convergence, the existing manager seal budget, and the private child close while
remaining short enough to prevent hours-long orphan processes. The constant,
clock, timer, and exit callback must be injectable in tests; it is not a new
user configuration option.

## Phase 0: Surface the failure before redesigning shutdown

### Task 0.1: Preserve structured shutdown diagnostics

**Files:**

- Create `src/mcp-lifecycle.ts`.
- Modify `src/index.ts`.
- Modify `src/server.ts`.
- Add `tests/mcp-lifecycle.test.ts`.
- Modify `tests/workbench/server-disposer.test.ts`.

**Work:**

- Add a small lifecycle error normalizer that recognizes
  `OwnedRuntimeError.details` without serializing arbitrary error objects.
- Emit a bounded, redacted diagnostic containing only the stable fields needed
  to explain shutdown: error code, `applicationCloseSafe`, busy runtime IDs,
  and per-runtime error summaries. Cap array counts, identifier lengths, and
  the final rendered message. Write diagnostics to stderr through the existing
  logger so stdout remains valid MCP transport traffic.
- Make fulfilled unsafe seal results and thrown `SHUTDOWN_SEAL_FAILED` errors
  use the same formatter. Do not reduce thrown failures to `error.message`.
- Replace permanent rejected-promise memoization in `src/server.ts` with
  per-attempt coalescing. Clear the active promise on rejection, memoize only a
  successful terminal close, and retain dependencies needed by a retry.
- Verify whether `processGuard.close()` can precede a retry. If the retry path
  can use the guard or its LMDB state, defer that close until safe terminal
  shutdown. In either case, preserve idempotent guard cleanup after success and
  on the CLI emergency path.

**Validation:**

- A synthetic `OwnedRuntimeError` logs its stable details and no unapproved
  fields.
- Long or hostile detail strings are redacted and bounded.
- Two simultaneous disposer calls share one attempt.
- A failed attempt can invoke the underlying close again; a successful attempt
  cannot.
- stdout remains untouched.

### Task 0.2: Reproduce and classify the current 15-second failure

**Files:**

- Add a controlled lifecycle fixture under `tests/observer/fixtures/` if the
  existing private-child fixture cannot express all three states.
- Add `tests/observer/mcp-shutdown-characterization.test.ts`.
- Update this plan's validation record with the observed reason before Phase 1
  implementation starts.

**Work:**

Run disposal in three controlled states and capture the newly surfaced
structured result:

1. no Workbench, no private child, and no jobs;
2. private child started, but no active jobs or runtimes; and
3. an active or restoration-pending owned-runtime capture.

The first case is a mandatory evidence checkpoint. The current source proves
that capture obligations can block sealing, but it does not explain a clean
idle failure with no child and no jobs. If that reproduction reports a
different cause, record it and amend the affected Phase 1 task before changing
shutdown order. Do not discard the diagnostic because a retry happens to
succeed.

**Validation:**

- Each fixture completes under a test-controlled deadline.
- The started-child case records the child PID and proves whether it is alive
  after an unsafe ordinary close.
- The active-work case identifies the blocking runtime and obligation category
  without exposing local paths or tokens.
- The no-work case either closes cleanly or has a concrete structured failure
  reason attached to the implementation change that follows.

## Phase 1: Implement phased, retryable, bounded shutdown

### Task 1.1: Add real capture quiescence

**Files:**

- Modify `src/observer/capture-service.ts`.
- Modify `src/observer/capture-contract.ts` if an internal-only quiesce result
  type is needed.
- Modify `tests/observer/capture-service.test.ts`.

**Work:**

- Split "stop accepting work" and terminal service close into explicit,
  idempotent operations. Quiescence must immediately seal new admissions.
- Add an internal shutdown abort source and combine it with each caller's
  `AbortSignal`. Shutdown must abort captures already admitted even when the
  MCP request signal remains open.
- Snapshot and await the `admissions` promises. Account for admissions that
  move into the active-job map during shutdown; convergence must repeat until
  the obligation set is stable and empty or the absolute deadline expires.
- Cancel active jobs, release run/job bindings as the existing contract
  requires, and wait for camera/restoration obligations to settle. Preserve
  idempotency keys and existing durable job state rather than inventing a
  shutdown-only release path.
- Return a bounded internal quiesce result with remaining job IDs and failure
  summaries. Do not swallow cancellation failures with only a warning.
- Keep terminal `close()` idempotent. It may clear timers and immutable local
  resources after quiescence, but it must not close the private agent connection
  needed by the seal phase.

**Validation:**

- Captures submitted after quiescence starts are rejected.
- A capture admitted just before quiescence is aborted, awaited, cancelled, and
  cannot appear after the service reports quiescent.
- A job moving between admission and active state is not missed.
- Camera lease and restoration-pending fixtures converge before seal readiness.
- Deadline expiry returns structured remaining obligations and does not report
  success.
- Repeating quiescence is safe and can finish work left by a prior timed-out
  attempt.

### Task 1.2: Reorder application shutdown without weakening the seal invariant

**Files:**

- Modify `src/observer/application.ts`.
- Modify `src/observer/owned-runtime-manager.ts`.
- Modify `tests/observer/application.test.ts`.
- Modify `tests/observer/owned-runtime-manager-shutdown-integrity.test.ts`.
- Add `tests/observer/application-shutdown.test.ts` if the existing application
  suite cannot isolate phase order.

**Work:**

- Replace the current `closing`/`closed` interpretation with the explicit
  lifecycle states above. Once quiescence starts, ordinary tool-facing methods
  reject new work, while narrowly scoped internal cancellation and seal calls
  remain permitted.
- Implement application shutdown in this order:

  1. stop application admissions and quiesce capture work;
  2. ask `OwnedRuntimeManager` to seal exact runtimes using the remaining
     absolute deadline;
  3. if and only if `applicationCloseSafe === true`, perform terminal capture
     cleanup, restore remaining Workbench observer state, and close the private
     agent client; and
  4. otherwise return or throw the structured unsafe result and remain
     retryable with the private agent connection intact.

- Allow `OwnedRuntimeManager.close()` to accept an absolute deadline and clamp
  its existing aggregate wall deadline to the remaining process budget.
  Preserve its current behavior of resetting close state after unsafe results
  and closing its durable environment only after a safe result.
- Do not place terminal service closure in an unconditional `finally`.
- Make repeated calls resume convergence/sealing on the same application. Do
  not reopen public admissions between retries.

**Validation:**

- Assert phase order directly: quiesce completes before manager seal, and agent
  close occurs only after a safe seal.
- Preserve the existing test that the coordinator remains open on incomplete
  sealing.
- An unsafe result retains the same private child and can succeed on a later
  retry after the blocking obligation clears.
- The manager never receives more time than remains on the outer absolute
  deadline.
- No-work/no-manager applications still close all terminal services.

### Task 1.3: Stop protocol admissions before disposing tools

**Files:**

- Modify `src/index.ts`.
- Modify `tests/observer/package-contract.test.ts`.
- Modify `tests/mcp-lifecycle.test.ts`.

**Work:**

- On EOF, transport close, signal, or startup failure, detach shutdown event
  handlers and close the `McpServer`/stdio transport first. This prevents new
  protocol requests and aborts SDK request signals before application
  convergence starts.
- Then run the retryable tool/application disposer using the one absolute
  deadline. Application-level quiescence is still required because SDK close
  aborts request signals but does not prove all domain work has settled.
- Update the existing package contract that currently asserts
  `disposeTools()` precedes `server.close()`.
- Keep shutdown idempotent when stdin emits both `end` and `close`, or when a
  signal races transport closure.

**Validation:**

- No new handler begins after protocol close.
- An in-flight MCP capture receives cancellation and is included in capture
  quiescence.
- EOF plus `close`, and two simultaneous signals, execute one shutdown
  orchestration.
- Startup failure uses the same bounded path.

### Task 1.4: Add the CLI hard deadline and emergency child termination

**Files:**

- Modify `src/mcp-lifecycle.ts`.
- Modify `src/index.ts`.
- Modify `src/server.ts` and its disposer type.
- Modify `src/observer/application.ts`.
- Modify `src/observer/agent-client.ts`.
- Modify `tests/observer/agent-client.test.ts`.
- Modify `tests/mcp-lifecycle.test.ts`.
- Add a black-box child-process lifecycle test under `tests/cross-cutting/`.

**Work:**

- Arm a referenced 30-second watchdog when CLI shutdown begins. The watchdog
  itself replaces the current interval as the handle that keeps Node alive
  during cleanup. Clear it only after successful terminal cleanup. Route an
  unrecoverable failure through the same non-zero emergency termination path
  immediately rather than waiting out the remaining deadline.
- Retry retryable seal failures only while time remains, using a bounded backoff
  and the same absolute deadline. Do not busy-loop and do not reset any phase
  budget.
- If the watchdog fires, emit the last structured lifecycle result, mark the
  shutdown as emergency, and invoke a synchronous best-effort termination hook
  for disposable process-owned children before calling the injected
  `process.exit(1)` callback.
- Add a narrow `ObserverAgentClient` emergency termination method that rejects
  pending IPC requests, disconnects or kills every tracked private child, and
  cannot publish runtime state as clean. Do not route this through normal
  `closeServices()` and do not kill Workbench or game/runtime processes.
- Expose that hook to the CLI through the registered-tools lifecycle handle
  without making `process.exit()` available to embedded callers.
- Preserve durable owned-runtime and process-guard records so a later MCP owner
  performs the existing crash/restart reconciliation.

**Validation:**

- With fake timers and an injected exit callback, successful shutdown clears
  the watchdog and never exits forcibly.
- Persistent unsafe sealing triggers exactly one non-zero emergency exit at the
  deadline and includes the last redacted details.
- The emergency method is idempotent and kills all tracked private children,
  including a child that started but never completed its ready handshake.
- The black-box test starts a real private child, forces persistent unsafe
  shutdown, and proves that both MCP parent and private child PIDs disappear
  within a bounded grace period.
- A runtime/Workbench process is not terminated by the emergency private-child
  hook, and durable recovery state remains available to the next owner.
- Embedded disposer tests prove no call path invokes `process.exit()`.

### Task 1.5: Run lifecycle regression and recovery suites

**Files:**

- Modify only tests or implementation exposed by failures from the commands
  below; do not weaken ownership assertions to make them pass.

**Validation:**

```powershell
npm.cmd exec -- vitest run `
  tests/mcp-lifecycle.test.ts `
  tests/observer/mcp-shutdown-characterization.test.ts `
  tests/observer/agent-client.test.ts `
  tests/observer/capture-service.test.ts `
  tests/observer/application.test.ts `
  tests/observer/application-operations.test.ts `
  tests/observer/owned-runtime-manager-shutdown-integrity.test.ts `
  tests/observer/private-child-owned-runtime-recovery.test.ts `
  tests/observer/package-contract.test.ts `
  tests/workbench/server-disposer.test.ts `
  tests/workbench/restart-ownership-shutdown.test.ts `
  tests/workbench/restart-ownership-recovery.test.ts
npm.cmd run typecheck
npm.cmd run test:stage4
```

## Phase 2: Lazily initialize the API search index

### Phase 2 memory and startup checkpoint (implemented 2026-08-03)

Run from a built checkout with:

```powershell
node --expose-gc scripts/measure-search-index-memory.mjs
```

The probe runs each mode in three fresh child processes, forces GC at the
measurement checkpoint, uses temporary Observer managed/profile roots, and
reports medians without enforcing an absolute RSS threshold. Results on the
reference Windows x64 machine with Node v26.4.0 were:

| Mode | RSS MiB | Heap MiB | Registration ms | First load ms |
|---|---:|---:|---:|---:|
| Bare Node | 55.7 | 4.5 | 0 | 0 |
| Production module imports | 88.6 | 19.9 | 0 | 0 |
| Registered tools, empty index | 89.4 | 21.6 | 11.2 | 0 |
| Registered tools, full index idle | 89.4 | 21.6 | 11.1 | 0 |
| Full index after first use | 208.1 | 103.4 | 11.5 | 249.1 |

Full-data idle registration was indistinguishable from empty-index
registration at the reported precision (0.0 MiB median RSS difference). First
use paid the parse/index cost once. Comparing the loaded state, which has the
same index allocations as the former eager-construction baseline, with the
full-data idle state showed a 118.7 MiB median RSS reduction. This exceeds the
100 MiB acceptance target. The roughly 89 MiB idle floor is primarily Node and
the imported production module graph; lazily parsing the API data is not
expected to reduce that irreducible startup cost.

The focused search/resource suites (99 tests), typecheck, Stage 4 (129 tests),
cross-cutting baseline (55 tests), build, 59-tool MCP handshake, and fresh
packed installation all passed without launching Workbench or the game. After
the external Workbench was released on 2026-08-04, the default full suite also
passed. Guarded real Workbench acceptance then passed resource registration,
target reopen/save, launch/reuse/restart, and final exact-process vacancy.

A disposable harness subsequently drove the real built MCP entry point through
Observer private-child startup and an active Workbench capture, then closed
stdin. The MCP exited with code 0, its exact private child was gone, Workbench
remained alive as the ordinary-shutdown invariant requires, and a fresh MCP
owner reconciled the durable state and safely shut down the exact Workbench
PID. The persistent-unsafe fault-injection black-box test also passed: it
removed the MCP and its real disposable child while preserving an unrelated
process. No game runtime was launched for these checks.

### Task 2.1: Move the load boundary into `SearchEngine`

**Files:**

- Modify `src/index/search-engine.ts`.
- Modify `src/index/loader.ts` only if a narrow loader seam is needed for
  deterministic tests.
- Modify `tests/index/search-engine.test.ts`.
- Add `tests/index/search-engine-lifecycle.test.ts`.

**Work:**

- Make the constructor store configuration only. It must not read or parse the
  data tree.
- Add a synchronous internal `ensureLoaded()` state machine with `unloaded`,
  `loading`, `loaded`, and `failed` states. The first index-backed operation
  performs exactly one load.
- Ensure every public data operation crosses that boundary, including class,
  method, enum, property, broad search, wiki, group, name, tree, inheritance,
  component, statistics, and `hasClass` queries. Keep `isLoaded()` as a
  non-loading diagnostic.
- Avoid recursive initialization. The current load path calls class-tree logic
  while building indexes, so use a private already-loading helper rather than
  re-entering the public guarded method.
- Build into temporary structures and publish them only after successful
  completion. On an unexpected load failure, clear partial structures and
  cache a bounded deterministic error so later calls cannot observe partial
  data or repeatedly parse the tree.
- Preserve the loader's existing per-file malformed-data behavior and all
  successful result ordering.

**Validation:**

- Construction leaves `isLoaded()` false and performs no file reads.
- The first public index-backed call loads once and returns the existing result.
- A second and re-entrant call cannot load twice.
- A load failure exposes no partial classes and rethrows a stable failure.
- The existing search behavior suite passes unchanged apart from assertions
  that intentionally expected eager construction.

### Task 2.2: Exercise non-search first-use paths

**Files:**

- Modify or add focused tests for the class and group resources under
  `tests/resources/`.
- Modify focused mod/script tool tests that consume `SearchEngine` if those
  paths are not already covered.
- Modify `tests/workbench/server-composition.test.ts` only if needed to assert
  registration remains non-loading.

**Work:**

- Register all tools and resources against a full data directory and assert
  registration alone leaves the engine unloaded.
- Invoke a class resource, a group resource, one search tool, and one non-search
  tool that uses the engine. Each must transparently trigger the same load
  boundary and preserve its response contract.
- Do not add handler-specific load calls. Tests should prove that new and
  existing consumers are protected by the engine itself.

**Validation:**

- All four first-use paths work from an initially unloaded engine.
- Resource registration and MCP startup do not parse the API tree.
- MCP tool names, schemas, annotations, prompts, and resource URIs do not
  change.

### Task 2.3: Record repeatable memory and startup characterization

**Files:**

- Add `scripts/measure-search-index-memory.mjs`.
- Document the command and results in this plan or a linked test artifact.

**Work:**

- Run each mode in a fresh child process with `node --expose-gc`: bare Node,
  module imports, registered tools with an empty index, registered tools with
  the full index but no index-backed call, and full index after first use.
- Use temporary managed/profile roots so the probe does not reuse or mutate an
  operator's live Observer state.
- Force GC at the same checkpoints and report RSS, heap used, elapsed
  registration time, and elapsed first-load time. Record at least three runs
  and report the median.
- Keep this a characterization tool, not production instrumentation. Do not
  fail CI on an absolute RSS threshold.

**Validation:**

- Full-data idle registration remains within a small observational margin of
  empty-index registration in the same run/build.
- First index-backed use pays the expected memory and parse cost once.
- The median idle reduction versus the pre-change full-index baseline is at
  least 100 MiB on the reference machine; if it is not, investigate remaining
  eager consumers before declaring the task complete.
- Results explain the irreducible startup floor from Node and the imported
  module graph rather than promising a 60-80 MiB process.

## Final validation

Run the focused suites first, then the complete package checks:

```powershell
npm.cmd exec -- vitest run tests/index/search-engine.test.ts tests/index/search-engine-lifecycle.test.ts
npm.cmd run typecheck
npm.cmd run test:stage4
npm.cmd run test:cross-cutting:baseline
npm.cmd test
npm.cmd run build
npm.cmd run mcp:verify
npm.cmd run test:package
node --expose-gc scripts/measure-search-index-memory.mjs
```

Also perform one Windows process-tree acceptance run with a real built MCP
entry point:

1. start the MCP server and invoke an Observer operation that starts the private
   child;
2. close stdin during an active owned-runtime obligation;
3. confirm structured shutdown diagnostics appear on stderr;
4. confirm orderly convergence exits before the deadline when the obligation
   can be cancelled; and
5. with a fault-injected persistent unsafe seal, confirm the MCP parent and its
   disposable private child are both gone after the 30-second deadline while
   the next owner can reconcile durable state.

Completed on 2026-08-04 with the no-game constraint recorded above. The live
built-MCP run used an active Workbench capture for the orderly path; the
persistent unsafe owned-runtime path used the real-child black-box fixture.

After implementation and validation are complete, review
`docs/plans/2026-08-03-observer-api-simplification.md` against the final changes
from this plan. Update that document if lifecycle state, shutdown sequencing,
Observer API assumptions, affected files, or validation guidance changed in a
way that impacts its implementation. Record the review even when no update is
required, so the dependency was checked deliberately.

## Out of scope

- Shared MCP server or alternative MCP transport architecture.
- Per-session configuration negotiation.
- Changes to tool schemas, resource URIs, or client configuration.
- Reducing the roughly 95 MiB empty-index startup floor by removing LMDB,
  native image, HTML parsing, or other modules from the startup import graph.
- Weakening exact-runtime sealing, restoration, or durable restart ownership.
- Killing Workbench or game/runtime processes on the emergency path.

## Definition of done

1. Idle and started-child shutdown failures report bounded structured seal
   details instead of only a message.
2. Rejected shutdown attempts are retryable through every composition layer;
   concurrent attempts still coalesce.
3. Capture admissions stop before sealing, and admitted work is aborted,
   awaited, cancelled, and restored within the shared deadline.
4. Exact-runtime manager sealing occurs before terminal Observer services close,
   and all existing unsafe-close integrity tests remain intact.
5. The CLI exits non-zero within 30 seconds on persistent unsafe shutdown and
   leaves no disposable private child process behind. Embedded disposal never
   exits the host process.
6. Registering tools with the full data tree does not load the search index.
   Every index-backed tool/resource loads it exactly once on first use and
   preserves existing results.
7. The reference memory probe shows at least a 100 MiB idle reduction and does
   not claim the earlier 60-80 MiB floor.
8. Focused lifecycle, recovery, index, full test, build, MCP verification, and
   package validation commands pass.
9. No implementation work for the excluded shared-server option is introduced.
10. `docs/plans/2026-08-03-observer-api-simplification.md` has been reviewed
    after completion and updated if the implemented lifecycle changes affect
    it.
