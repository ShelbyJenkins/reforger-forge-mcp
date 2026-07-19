# Post-fork MCP maintainability implementation guide

Status: proposed

Review date: 2026-07-18

Scope: `upstream/main@5e52376` through `HEAD@a7d6095` (13 commits)

## Purpose

This guide reviews the code added since the fork point and gives an implementation sequence for making it smaller, more maintainable, and more idiomatic without weakening the safety properties the new code was intended to add.

The concern about size is justified. Ignoring CRLF-only noise, the fork delta is 216 files with about 42,695 additions and 1,694 deletions. The current server exposes 58 tools, while the public MCP surface grew by only about eight net tools. The new standalone Workbench CLI is another meaningful feature, but the implementation still contains more lifecycle, job, protocol, and test machinery than those features require.

This is not a recommendation to rewrite the subsystem or collapse every state machine into one abstraction. The safe direction is:

1. Fix demonstrated correctness and liveness defects.
2. Extract narrow shared primitives with behavioral contract tests.
3. Keep Workbench and runtime policy in separate domain controllers.
4. Put both capture implementations behind one host-side service.
5. Remove refusal-only surface, broken package payloads, redundant build phases, duplicate schemas, and source-text tests once replacements exist.

## Review baseline

| Measure | Result |
| --- | ---: |
| Commits since `upstream/main` | 13 |
| Files changed | 216 |
| Logical diff, ignoring CRLF-only changes | +42,695 / -1,694 |
| Current MCP tools | 58 |
| New observer MCP tools | 7 |
| Largest new host modules | 1,810-2,352 lines each |
| Observer and Workbench test code | about 11,500 lines |
| Observer and Workbench test cases | about 384 |
| Source-text assertions in six contract-heavy files | at least 271 |

Validation at the reviewed commit:

- `npm run build`: passed.
- `npm test -- --reporter=dot`: 815 passed, 4 skipped.
- `npm run test:package`: passed its repository package-content checks.
- Focused native Windows lifecycle/helper tests passed locally.

Those green results are useful, but they overstate behavioral coverage. CI runs only on Ubuntu, `test:package` is not in CI, Enforce `.c` code is not compiled by the normal test command, live Workbench/runtime tests are opt-in, and several contract suites inspect source strings instead of executing behavior.

## Executive decision

### Preserve

These invariants justify real implementation complexity and should remain explicit:

- Only terminate a process after exact executable, PID, creation identity, and owner-token verification.
- Fail closed when ownership or mutation outcome is uncertain.
- Never inject helpers into the user's project; stage immutable, content-addressed companions.
- Restore camera and world state before declaring a capture terminal or releasing it.
- Make side-effecting operations idempotent and durable across retries.
- Keep runtime IPC isolated from the public MCP process.

### Consolidate

- Exact-process inspection, termination, child supervision, and machine mutex use.
- Bounded atomic JSON/CAS storage and canonical managed-path checks.
- Content-addressed companion staging and retention.
- Workbench launch planning, readiness, companion attestation, and state transitions.
- Capture idempotency, polling, cancellation, public projection, run binding, and release.
- Error codes, capability declarations, protocol schemas, and generated documentation.
- Composition and shutdown ownership.

### Remove or defer

- Refusal-only tool actions and their full schemas/tests.
- Published TypeScript acceptance harnesses that cannot run from an installed package.
- The unused `playwright` dependency unless an actual test consumes it.
- Workbench build's helper-enabled preflight if target-build acceptance proves it adds no safety.
- A second transport such as mailbox if it is not a demonstrated product requirement.
- A generic cross-domain lifecycle state machine. The domains share primitives, not all policy.

## Findings to resolve before structural refactoring

### F1. Runtime idempotency accepts changed requests

Priority: high correctness.

[`JobStore.submit()`](../../observer/agent/jobs.ts#L110) indexes only `sessionId + idempotencyKey` and returns the original job without comparing the new logical request. A retry can change the instance, view, deadline, or world expectation and silently receive an unrelated prior job. Workbench capture, evidence runs, and owned-runtime operations already use request fingerprints, so the semantics are inconsistent.

Implementation:

- Add a canonical `normalizeCaptureRequest()` function.
- Hash all semantic request fields. Exclude only transport-local values such as an `AbortSignal`; document whether a deadline is absolute or policy-derived and include its canonical representation.
- Store `{ jobId, fingerprint, expiresAt }` per session/key.
- Replay only an identical fingerprint.
- Return the canonical `IDEMPOTENCY_CONFLICT` code for a changed request.
- Bound the receipt lifetime; do not turn the fix into another permanent map.

Required tests:

- Identical retry returns the original job.
- Changing each semantic field conflicts.
- Equivalent normalized representations replay.
- Expired receipts follow the documented retention rule.

### F2. Long-lived observer state is unbounded

Priority: high reliability.

Jobs, idempotency entries, queue arrays, sessions, instances, and mailbox transports remain in memory indefinitely. `releaseJob` releases the artifact but not the job or queue state. Disk retention in the observer server does not compact these maps. Owned-runtime receipts have the same broader issue: prepared descriptors and terminal/pending/idempotency receipts have no complete retention policy, and each preparation synchronously scans all prior descriptors.

Implementation:

- Give every record an explicit owner, terminal condition, and retention period.
- Remove queue entries when dispatched or terminal rather than repeatedly scanning history.
- Add `sweep(now)` to the agent application, invoked on a bounded cadence and during controlled shutdown.
- Expire session-scoped instances and transports when a session is revoked and no restoration or terminal work remains.
- Retain small idempotency/release tombstones for a documented retry window, then delete them.
- Preserve records pinned by an open evidence run or unresolved recovery obligation.
- Replace the owned-runtime O(n) prepared-descriptor scan with a direct session/index receipt.
- Isolate a corrupt receipt so one bad file does not block all later preparation.
- Enforce per-record and total-store byte budgets.

Add test-only or diagnostic store statistics so tests can assert bounds without inspecting private source text.

### F3. Mailbox poison files can starve valid commands

Priority: high correctness when mailbox transport is enabled.

[`RFO_ObserverMailboxTransport.c`](../../observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverMailboxTransport.c#L46) examines only the first 256 sorted command files. Accepted files are removed, but malformed, oversized, expired, wrong-instance, and permanently rejected files remain. Once 256 stale files sort before a valid command, the valid command is never reached.

Choose one of two product decisions:

1. If mailbox is required, implement an explicit disposition state:
   - accepted: delete;
   - permanently rejected: move to a bounded quarantine;
   - transient failure: retry with a bounded attempt/age budget.
2. If REST is the supported first release, remove mailbox from advertised capabilities and delete its second queue/state machine until a concrete use case requires it.

Required test: place more than 256 stale or malformed files before one valid command and prove the valid command is eventually consumed without losing bounded forensic evidence.

### F4. Protocol errors and capabilities have drifted

Priority: high contract correctness.

[`ERROR_CODES`](../../observer/protocol/constants.ts#L81) omits codes emitted on public paths, including `AMBIGUOUS_INSTANCE`, `IDEMPOTENCY_CONFLICT`, `JOB_RELEASED`, `STALE_INSTANCE`, `SESSION_MISMATCH`, `WORKBENCH_ADAPTER_UNAVAILABLE`, and lifecycle verification errors. The common capability list omits implemented `camera.editor` while advertising capabilities with no confirmed producer.

Implementation:

- Create one typed error registry with code, public message policy, retryability, and backend applicability.
- Create one typed capability registry with the backend that can prove each capability.
- Map backend-private failures at adapter boundaries.
- Derive TypeScript unions, Zod enums, JSON schema, and protocol documentation from those registries.
- Add a test that fails when any emitted or advertised value is absent.
- Do not advertise `entity.resolve` or `server.coordinate` until an implementation and conformance test exist.

### F5. The public world schema rejects a supported runtime state

Priority: medium contract correctness.

The MCP schema for `expectedWorldId` accepts only a string, while runtime registration and current-view capture explicitly allow a null world. Make the field `nullable().optional()` and prove an inventory-null to current-view capture through the public tool, or define that `render.capture` is unavailable until a world is bindable. Do not keep contradictory rules at the protocol and MCP layers.

Workbench's hard-coded `worldEpoch: 0` is not a demonstrated race bug: the backend uses and rechecks a composite `worldIdentity`. It is still poor shared semantics. Replace the pair with an opaque `worldRevision`, or make epoch absent for Workbench and centralize the projection in one adapter.

### F6. Lifecycle operations can lose liveness

Priority: high operational reliability.

The standalone runner's documented absolute deadline is not absolute. If exact termination is refused, recovery can wait indefinitely while retaining the global mutex. Observer stop can hold the same mutex while waiting up to five minutes for restoration. These are correct to refuse unsafe termination, but incorrect to monopolize global progress indefinitely.

Implementation:

- Separate the execution deadline from a short, bounded recovery deadline.
- On bounded recovery expiry, persist `stopping` plus the exact identity and return `RECOVERY_REQUIRED`.
- Release the mutex while waiting for readiness, restoration, or process lifetime.
- Reacquire it only for reserve/CAS/commit and revalidate generation plus owner before committing.
- Never publish `vacant` unless exact absence is proven.
- Make helper loss a durable recovery result rather than an implicit `process.abort()` policy hidden in a backend.

Tests must use a fake clock/backend and assert a finite upper bound for every public lifecycle operation.

### F7. Endpoint vacancy can fail open

Priority: medium safety.

The MCP Workbench client treats TCP timeout and every socket error as "not listening" and uses that result to gate launch/restart. The standalone runner already has a fail-closed `verifyEndpointVacant` result.

Implementation:

- Delete the boolean `isPortListening()` decision path.
- Use a result union such as `vacant | occupied | unverifiable` from the shared backend.
- Spawn only on `vacant`; return a stable recovery/diagnostic error on `unverifiable`.
- Test refusal, timeout, reset, permission error, occupied, and clean vacancy.

### F8. A crash can orphan a child before ownership publication

Priority: high recovery design.

Workbench client and runner spawn before durable exact identity is committed. A parent crash in that window can leave a live tokened process that recovery treats as unowned. Owned runtime records a pending owner token, but retries reject pending starts and status/shutdown ignore them, so the evidence is not used for recovery.

Close this window in the shared spawn primitive:

- Persist a unique launch capability before spawn.
- After spawn, inspect and atomically publish exact identity.
- Recover only with full executable, token, PID, and creation identity evidence.
- If Windows cannot make publication sufficiently safe, use a small guardian or Job Object that terminates an unpublished child when the parent channel closes.
- Expose cleanup-only recovery for fully verified pending identities; never adopt a merely similar process.

Add crash injection between every spawn transaction phase for Workbench client, runner, and owned runtime.

### F9. Owned-runtime stop can report completion too early

Priority: medium correctness.

A stop receipt is published before observer session completion. Status treats the stop receipt as terminal even when the stop-completion record is absent. Represent `termination_complete / observer_cleanup_pending` explicitly and continue reporting `stopping` until cleanup is durable. Retrying stop must complete cleanup idempotently.

### F10. Child-process and receipt resources are not reconciled

Priority: medium reliability.

Successful runtime children are retained in an effectively write-only `Map`; natural exit has no reconciliation path. Extract a `ChildSupervisor` with persistent `error` and `exit` handlers, automatic map removal, and a callback that reconciles durable state. Use it for Workbench and runtime children.

### F11. Workbench build validates output too early

Priority: medium correctness.

Output emptiness is checked before the lifecycle lock and not rechecked until after companion preflight. Two builds can both accept the same initially empty output, and the loser can launch a preflight before discovering the race.

Implementation:

- Prefer accepting an output parent and atomically creating an exclusive UUID child.
- Otherwise revalidate immediately after reservation and before any spawn.
- Reject overlap with the target mod, companion profile, and managed roots.

### F12. Installed-package acceptance scripts are not runnable

Priority: medium packaging correctness.

`package.json` publishes the TypeScript acceptance harnesses and advertises npm scripts for them, but `tsx` is dev-only, `src` and `tsconfig*.json` are absent, and the build excludes the scripts. The current package check requires the broken source payload but does not run it as a production install.

Recommended decision: keep acceptance harnesses repository-only and remove them from `files`. If they are intended product commands, compile them into `dist`, expose supported binaries, move runtime dependencies appropriately, and smoke-test the installed tarball with `--omit=dev`.

### F13. The standalone observer CLI has a divergent, partly unusable composition root

Priority: medium correctness and maintainability.

`observer/agent/index.ts` defines the canonical application graph, but `observer/agent/cli.ts` reconstructs it manually. Standalone `serve` cannot provide evidence or supporting-log roots, so it can begin evidence runs but finalization fails against an empty allowlist. Standalone `doctor` also constructs the mutating graph and creates the managed root plus its directories, unlike the MCP-side read-only diagnostic.

Implementation:

- Make CLI and private child call the same `createObserverApplication(options)` composition root.
- Require or explicitly disable evidence-run operations when no evidence roots are configured.
- Split `inspectPaths()` from `ensurePaths()` and use only the former for `doctor`.
- Share application operation handlers; keep CLI/private IPC serialization as thin adapters.

## Main duplication clusters

### 1. Exact-process and lifecycle infrastructure

The current implementation spreads lifecycle work across:

- `src/workbench/process-guard.ts` (1,422 lines);
- `scripts/windows/workbench-lifecycle.ps1` (1,098 lines);
- `src/workbench/client.ts` (2,352 lines total responsibilities);
- `src/workbench/runner.ts` (2,237 lines);
- `src/observer/owned-runtime-manager.ts` (1,810 lines).

Observer already adapts a `WindowsLifecycleBackend` whose public types are named for Workbench. Client and runner copy state-draft, expected-generation, companion mapping, spawn, readiness, termination, and recovery logic. The duplicated stores have drifted: observer receipt reads are bounded and reject links, while Workbench state reads do not consistently provide the same guarantees.

Extract these primitives, not a mega-controller:

```ts
interface ExactProcessBackend {
  inspect(candidate: ProcessCandidate): Promise<ProcessInspection>;
  verifyEndpointVacant(endpoint: Endpoint): Promise<VacancyResult>;
  terminateExact(identity: ExactProcessIdentity): Promise<TerminationResult>;
}

interface JsonCasStore<T> {
  read(): Promise<Versioned<T> | Missing>;
  compareAndSwap(expected: Generation, next: T): Promise<CasResult<T>>;
}
```

Also extract `MachineMutex`, `ChildSupervisor`, canonical managed paths, bounded atomic file I/O, and error redaction. Keep these controllers separate:

- `WorkbenchSessionController`: singleton endpoint, target, companion, and readiness policy.
- `OwnedRuntimeController`: multi-runtime session, restoration, and idempotency policy.

### 2. Workbench client and runner

`WorkbenchClient` currently owns TCP transport, connection caching, helper staging, diagnostics, lifecycle, capture gates, launch, restart, and shutdown. `runWorkbenchIntent` separately reimplements much of the lifecycle and contains a roughly 393-line main function.

Target split:

- `WorkbenchNetApiClient`: protocol framing and calls only.
- `WorkbenchLaunchPlan`: validated executable/project/addon/arguments/visibility/readiness.
- `WorkbenchSessionController`: durable lifecycle state and exact child ownership.
- `WorkbenchDiagnostics`: read-only evidence collection.
- `WorkbenchCaptureGate`: capture quiescence and restoration coordination.
- `WorkbenchRunner`: CLI policy and output presentation over the shared controller.

Preserve the real policy differences:

- MCP editor is visible and detached, and releases the mutex after readiness.
- CLI editor is foreground and guarded for its lifetime.
- Build is hidden, bounded, target-only, and proves its output.

The build helper preflight launches and tears down a helper-enabled Workbench, while the actual build excludes that helper and never uses NET API. After target-build characterization exists, remove the preflight or make it an explicit `doctor` command. Exact target identity, lifecycle exclusion, a bounded deadline, and output proof should protect the actual build without a second launch.

Ordinary managed NET calls are also doing lifecycle-transition work: they hold the machine mutex across network I/O, repeatedly hash the staged addon, and invoke PowerShell helpers that compile embedded C# per process. Cache immutable companion attestation by lifecycle generation and digest, use a process-local activity gate for normal calls, and reserve global/native verification for transitions and bounded periodic revalidation.

### 3. Observer coordinator and duplicate job systems

`ObserverCoordinator` is 2,066 lines and owns child IPC, runtime and Workbench routing, a second Workbench job/idempotency system, polling, cancellation, public projection, artifact import/release, run recovery, and shutdown. Runtime `JobStore` and `WorkbenchObserverAdapter` own overlapping state transitions.

Introduce one host service:

```ts
interface CaptureBackend {
  readonly kind: "runtime" | "workbench";
  listInstances(input: ListInstancesInput): Promise<CaptureInstance[]>;
  submit(input: NormalizedCaptureRequest): Promise<BackendJob>;
  status(ref: BackendJobRef): Promise<BackendJob>;
  cancel(ref: BackendJobRef): Promise<BackendJob>;
  read(ref: BackendJobRef): Promise<CaptureArtifact>;
  release(ref: BackendJobRef): Promise<void>;
}
```

`CaptureService` should own request normalization, public idempotency, backend routing, polling/deadlines, cancellation, public job projection, evidence-run binding, and release receipts. `RuntimeCaptureBackend` and `WorkbenchCaptureBackend` should own only backend-specific submission and camera/restoration behavior.

Split the remaining coordinator into:

- `ObserverAgentClient`: fork/request/close only;
- `CaptureService`;
- `EvidenceRunService`;
- `OwnedRuntimeController`;
- a thin application composition root.

Keep private IPC versus runtime REST as a security boundary. Share operation handlers and application services across those adapters rather than merging transports.

### 4. Paths, storage, and companion staging

Canonical path keys, containment, overlap checks, SHA-256, sleeps, and atomic JSON writes are repeated across Workbench helper staging, the runner, owned runtime, the observer coordinator, and the agent. Content-addressed bundle verification/staging/retention is independently implemented in `src/workbench/helper-addon.ts` and `observer/agent/staging.ts`.

Create one shared foundation:

```text
src/foundation/
  managed-path.ts
  bounded-json-store.ts
  atomic-file.ts
  digest.ts
  idempotency.ts
  reservation-gate.ts
src/platform/windows/
  exact-process-backend.ts
  lifecycle-helper-client.ts
src/companions/
  content-addressed-bundle.ts
```

The companion API should accept a manifest and payload source, then perform the same digest verification, atomic stage, immutable attestation, and retention for both addons. Generate the TypeScript payload descriptor from the canonical manifest instead of maintaining a three-way list in source, generated manifest, and disk files.

### 5. Protocol and build layout

The protocol is represented as Zod, handwritten JSON schema, Markdown tables, MCP schemas, and backend-specific constants. The observer TypeScript is also compiled separately even though both builds land in the same package tree, making otherwise useful sharing awkward.

Preferred layout:

```text
src/
  observer/
    agent/
    protocol/
    backends/
    capture-service.ts
observer/
  addon/             # Enforce runtime asset
  workbench-addon/   # Enforce Workbench asset
  protocol/schemas/  # generated artifacts only
```

Compile host TypeScript once. Runtime process isolation does not depend on a separate `tsc` invocation. If separate compilation remains desirable, use project references and a small shared package rather than duplicated helpers.

Several persisted fields and states currently add branches without recovery behavior. `validateAndClaim({ operation })` accepts an operation that the initial claim discards, while a vacant state cannot legally contain one. Owned runtime records six pending-start variants but rejects rather than repairs them, and `prepareIdempotencyHash` is written but never read. Remove the ignored claim option, transition operation state explicitly, and either implement a tested cleanup/recovery path for each pending state or collapse it to one fail-closed `cleanup_required` record.

### 6. Composition and shutdown

`src/server.ts` reaches into an SDK-private `server` property and overwrites `onclose`, while `src/index.ts` also owns disposal and process signals. Replace this with one explicit composition contract:

```ts
interface Application {
  register(server: McpServer): void;
  close(): Promise<void>;
}
```

Make `close()` idempotent. The executable installs signal handlers and calls it; embedded users receive and call it explicitly. Do not depend on private SDK fields.

## Public surface cleanup

The following advertised operations are refusal-only or misleading:

- `mod action=build` accepts build-only parameters solely to return an error.
- `wb_execute_action` rejects every possible action.
- `wb_play` rejects every call.
- `wb_save` rejects every call.
- `wb_reload` advertises `scripts | plugins | both`, defaults to `scripts`, and refuses the default.
- `workbenchNoThrow=false` is accepted in config while both managed launch paths enforce `-noThrow`.

For the next breaking release:

- Remove impossible actions and unused parameters from schemas and tool registration.
- Make `wb_reload` plugin-only, with `plugins` as the default, or route script reload directly to the safe restart operation.
- Remove `workbenchNoThrow` from public config and document `-noThrow` as a managed-launch invariant.
- If compatibility is required, retain a tiny deprecated adapter for one release. Do not preserve the full implementation and contract-test burden for a permanently refused capability.

Tool absence is a clearer capability signal than a registered tool that can never succeed.

## Test and CI redesign

### Replace implementation-text contracts

At least 271 assertions in six files match source strings or ordering. These tests can detect textual deletion, but they do not prove camera restoration, process ownership, cleanup, or failure behavior. Delete them only after their intended invariant has a behavioral home.

| Current test style | Replacement |
| --- | --- |
| Regex for lifecycle calls | `ExactProcessBackend` conformance suite |
| Source order for camera restoration | Engine acceptance with failure injection at every lease phase |
| Acceptance-harness source inspection | Run the compiled harness in a controlled environment |
| Package source-presence assertions | Install tarball with `--omit=dev` and run supported binaries |
| Repeated fake backend copies | Shared backend contract suite with adapter factories |
| Handwritten schema equality checks | Generated schema plus round-trip/conformance tests |

Keep a very small architecture lint only for rules that cannot be exercised dynamically, such as forbidden project injection or forbidden imports. Do not call such tests behavioral coverage.

### Required contract suites

- `JsonCasStore`: bounded reads, link rejection, corrupt state, CAS races, atomic replacement.
- `ExactProcessBackend`: exact match, PID reuse, token mismatch, endpoint uncertainty, termination refusal, helper loss.
- Spawn transaction: crash injection before spawn, after spawn, after inspection, and before/after publication.
- `CaptureBackend`: submit/status/cancel/read/release, idempotency conflict, nullable world, loss and timeout mapping.
- Retention: repeated submit/complete/release/session expiry remains within explicit count and byte limits.
- Workbench launch plan: editor/build policy matrix with one canonical argument builder.
- Application close: every child, lease, mutex, transport, and pending request is settled once.

### CI tiers

1. Ubuntu, Node 20 and 22: typecheck/build, pure unit/contract tests, schema generation check, package-content check.
2. Windows hosted runner: exact-process helper, mutex, multiprocess, endpoint, spawn/recovery, and installed-tarball smoke tests.
3. Controlled Workbench environment, manual or nightly: real editor launch/restart/shutdown, target build, helper attestation, capture, restoration, and injected failure paths.
4. Controlled graphical runtime environment, manual or nightly: capture plus cancellation, world unload, agent loss, transport loss, and shutdown during each camera lease phase.

Make `test:package` required in CI. Its smoke path must install the tarball in a temporary project with `--omit=dev` and execute every supported binary.

### Line-ending policy

The new `.gitattributes` entries use `-text` for observer addons, which makes line-ending-only moves noisy and causes normal diff checks to report CRLF lines poorly. If Enforce tooling requires CRLF, use an explicit text policy such as `text eol=crlf`; otherwise normalize to LF. Keep TypeScript and JSON as normal text. Validate the chosen policy in Workbench before applying the mechanical normalization as its own commit.

## Implementation sequence

### Phase 0: correctness stabilization

Do not move large modules yet.

1. Fix runtime request fingerprints and add conflict tests.
2. Add bounded observer state cleanup and retention tests.
3. Fix mailbox disposition/starvation, or formally remove mailbox from the supported release.
4. Establish canonical error/capability registries and fix nullable-world validation.
5. Make endpoint vacancy fail closed.
6. Bound runner/stop recovery and expose durable `RECOVERY_REQUIRED`/cleanup-pending states.
7. Reconcile natural child exits and fix output-root reservation.
8. Add crash-injection characterization for the unpublished-child window; close it in Phase 2's process primitive unless a minimal safe patch is available sooner.

Exit criteria: every finding F1-F11 has a behavioral regression test, and all public operations either complete or return a durable recovery state within a documented bound.

### Phase 1: make safety evidence trustworthy

1. Add the Windows CI job.
2. Add installed-tarball smoke testing and remove or compile published harnesses.
3. Add generated schema drift checks.
4. Establish a reproducible Workbench/Enforce compile command or recorded acceptance artifact.
5. Replace maximum 128 MiB prepared-descriptor tests with an aggregate launch-argument limit aligned with the actual Windows command-line/launcher boundary.
6. Record baseline timings and helper-process counts for launch, managed calls, capture, and shutdown.

Exit criteria: a change to Windows process code cannot merge on Ubuntu-only evidence, and package checks exercise the installed production package.

### Phase 2: extract the shared safety kernel

1. Move pure identity, owner capability, path, digest, and result types first.
2. Introduce `BoundedJsonStore`/`JsonCasStore` and migrate one store at a time.
3. Introduce `ExactProcessBackend`, `MachineMutex`, and `ChildSupervisor` behind existing adapters.
4. Implement the recoverable spawn transaction and shorten mutex scopes.
5. Introduce a reusable reservation/lease gate with abortable waits.
6. Consolidate companion staging after storage/path behavior is shared.

Each migration must run the same backend contract suite before deleting its old helper. Avoid a flag day.

Exit criteria: one implementation each for managed-path validation, bounded atomic JSON, exact process verification/termination, child reconciliation, and content-addressed staging.

### Phase 3: converge Workbench lifecycle paths

1. Split `WorkbenchNetApiClient` from lifecycle state.
2. Create the canonical `WorkbenchLaunchPlan` and readiness/attestation checks.
3. Put client and runner over `WorkbenchSessionController` while preserving their explicit policy differences.
4. Recheck build output reservation before spawn.
5. Remove helper preflight after real target-build acceptance proves it unnecessary.
6. Cache companion attestation by lifecycle generation plus immutable digest; do not hash the full bundle around every ordinary NET call.
7. Restrict global mutex usage to lifecycle transitions. Use a local reader/writer activity gate for same-session NET calls.

Exit criteria: launch arguments, state drafts, readiness, exact-child supervision, and endpoint vacancy each have one implementation. `client.ts` no longer owns staging and process policy, and `runner.ts` is a CLI policy layer rather than a second lifecycle engine.

### Phase 4: converge observer orchestration

1. Introduce `CaptureService` over the existing adapters without changing public tools.
2. Move common idempotency, timeout, polling, cancellation, projection, run binding, and release into it.
3. Reduce runtime and Workbench adapters to backend-specific behavior.
4. Split `ObserverAgentClient` from coordinator orchestration.
5. Make CLI and private child use one application composition root and shared operation handlers.
6. Split read-only `inspectPaths()` from mutating `ensurePaths()` so `doctor` does not create state.
7. Move evidence-bundle export into an optional `EvidenceBundleService` rather than capture transport/lifecycle.
8. Resolve mailbox's long-term support decision.

Exit criteria: one host job/idempotency system, coordinator reduced to composition/routing, and every backend passes the same capture contract.

### Phase 5: prune surface and generated duplication

1. Remove or deprecate refusal-only tools/actions.
2. Remove ignored configuration fields.
3. Generate JSON schema and protocol docs from canonical definitions.
4. Compile host TypeScript once or introduce project references.
5. Replace private SDK shutdown hooks with explicit application ownership.
6. Remove repo-only acceptance sources and unused dependencies from the package.
7. Apply the validated line-ending policy in an isolated mechanical commit.

### Phase 6: delete superseded tests and code

Delete only after the replacement contracts and acceptance paths are green:

- duplicate fake lifecycle backends;
- source-text camera/lifecycle/acceptance tests;
- copied path/digest/atomic-write helpers;
- duplicate Workbench state adapters and build preflight receipts;
- handwritten protocol schema copies;
- standalone composition duplication;
- refusal-only schemas and tests;
- the separate observer TypeScript build if compilation is unified.

Measure the diff after every deletion PR. The goal is not an arbitrary line quota; it is one owner per invariant and no implementation retained solely to test or document an unavailable feature.

## Suggested pull-request sequence

1. **Observer correctness:** idempotency conflict, nullable world, error/capability registry.
2. **Observer bounds:** job/session/instance/transport retention and mailbox disposition.
3. **Lifecycle liveness:** fail-closed vacancy, bounded recovery, cleanup-pending status, child reconciliation, output reservation.
4. **CI/package evidence:** Windows job, package install smoke, aggregate argument limits.
5. **Shared storage/path kernel:** bounded CAS store and common path/digest utilities.
6. **Shared process kernel:** exact backend, child supervisor, spawn transaction, narrow lock scopes.
7. **Shared companion staging:** manifest-driven content-addressed bundles.
8. **Workbench convergence:** launch plan/session controller; remove proven-redundant preflight.
9. **Capture convergence:** `CaptureService`, two backends, slim coordinator/composition root.
10. **Surface and test pruning:** refusal-only tools, generated schemas/docs, broken package payload, substring tests.

Keep each PR behavior-preserving except the explicitly identified defect or removal. Include a before/after inventory of modules, tests, public schemas, persisted-state migrations, and supported recovery paths.

## Completion criteria

The maintainability work is complete when:

- Every emitted public error and capability comes from one canonical registry.
- Changed requests cannot reuse an idempotency key silently.
- Every in-memory and on-disk collection has an explicit bound and sweep policy.
- Every public lifecycle operation has a finite response deadline and durable recovery outcome.
- No child can be terminated without exact identity, and no unpublished owned child is permanently unmanageable after a parent crash.
- Workbench client and runner share launch, readiness, endpoint, process, and state-transition code.
- Runtime and Workbench capture pass one backend contract and share one host job service.
- Path containment, atomic JSON/CAS, content-addressed staging, and exact process handling each have one implementation.
- No advertised tool/action is guaranteed to refuse every valid input.
- The production tarball works without development dependencies.
- Windows process tests are required in CI; Enforce behavior has real compile/acceptance evidence.
- Source-text tests remain only for a small, documented architecture rule set.
- No hand-written host orchestration file remains a multi-domain 1,800-2,300-line owner. Any module above roughly 800 lines requires a documented cohesion reason.

## Non-goals

- Do not weaken exact-process checks to reduce code.
- Do not share Workbench singleton recovery policy with runtime restoration policy merely because both launch processes.
- Do not move camera restoration into the generic host service.
- Do not collapse private IPC and runtime REST into one trust boundary.
- Do not relax the global single-Workbench policy in the same refactor. If multi-instance coexistence is desired, design and test endpoint-scoped exclusion separately.
- Do not delete recovery receipts until their obligations are completed or migrated.

The intended end state is smaller because policy is expressed once, not because safety checks have been removed.
