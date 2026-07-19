# Post-fork MCP maintainability implementation guide

**Status:** Stage 0 complete; Stage 1 repository work and controlled evidence complete, with external branch-protection administration pending
**Review date:** 2026-07-18 · **Last implementation validation:** 2026-07-19
**Review scope:** `upstream/main@5e52376` → `HEAD@a7d6095` (13 commits)
**Validation target:** `HEAD@7da4411` plus the current uncommitted working-tree implementation reviewed through 2026-07-19

## Purpose

This guide reviews the code added since the fork point and gives an implementation sequence for making it smaller, more maintainable, and more idiomatic without weakening the safety properties the new code was intended to add.

The concern about size is justified. Ignoring CRLF-only noise, the fork delta is 216 files with about 42,695 additions and 1,694 deletions. The current server exposes 58 tools, while the public MCP surface grew by only about eight net tools. The new standalone Workbench CLI is another meaningful feature, but the implementation still contains more lifecycle, job, protocol, and test machinery than those features require.

This is not a recommendation to rewrite the subsystem or collapse every state machine into one abstraction. The safe direction is:

1. Fix demonstrated correctness and liveness defects.
2. Extract narrow shared primitives with behavioral contract tests.
3. Keep Workbench and runtime policy in separate domain controllers.
4. Put both capture implementations behind one host-side service.
5. Remove refusal-only surface, broken package payloads, redundant build phases, duplicate schemas, and source-text tests once replacements exist.

## Current status

### Baseline metrics

Measured at the reviewed commit:

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

### Validation results

At the reviewed baseline:

- `npm run build`: passed.
- `npm test -- --reporter=dot`: 815 passed, 4 skipped.
- `npm run test:package`: passed its repository package-content checks.
- Focused native Windows lifecycle/helper tests passed locally.

Those green results are useful, but they overstate behavioral coverage. CI runs only on Ubuntu, `test:package` is not in CI, Enforce `.c` code is not compiled by the normal test command, live Workbench/runtime tests are opt-in, and several contract suites inspect source strings instead of executing behavior.

At the latest implementation validation:

- Stage 0 implementation spans observer crash recovery and retention, mailbox safety, lifecycle liveness, protocol generation, child reconciliation, and behavioral acceptance coverage.
- `npm run build`: passed.
- Stage 1 closeout Vitest suite: 262 suites, 980 passed, 4 skipped, 0 failed.
- Repeated Windows gate: 10 consecutive shuffled full-suite runs passed with retries disabled, seeds 1-10, and zero failures; a parallel contention gate also passed one full suite plus 20/20 repetitions of the repaired deadline cases. The structured record is [`2026-07-18-phase-0-vitest-repetition.json`](../validation/2026-07-18-phase-0-vitest-repetition.json).
- Real forked-private-child V1/V2 boundary tests: 3 passed, including repeated replacement, camera-obligation reconstruction, lost delivery, and lost response.
- Focused mailbox tests: 20 passed; owned-runtime manager tests: 59 passed.
- `npm run protocol:check`: passed; all 10 generated artifacts are current.
- `npm run test:package`: passed; a 690-file tarball, fresh `--omit=dev` install, and both advertised binaries were verified.
- `git diff --check`: passed.
- With Steam initialized, Workbench 1.7.0.54 loaded and compiled the final Game module with zero Enforce script errors, emitted `Script validation successful.`, and exited `0` in the compile-only gate.
- Controlled V10 behavioral acceptance then loaded both Game and WorkbenchGame with zero script errors and passed all five real-addon cases in 16.67 seconds. The sanitized record is [`2026-07-18-observer-enforce-mailbox-acceptance.json`](../validation/2026-07-18-observer-enforce-mailbox-acceptance.json).
- Controlled Task 4 acceptance produced two passed, identity-matched Workbench baselines and two passed, identity-matched runtime baselines with all required timing boundaries and zero supervised processes at rest; the four records are linked from the dedicated [`Stage 1 guide`](2026-07-18-stage-1-safety-evidence-implementation-guide.md#task-4-record-baseline-timings-and-helper-process-counts).
- An image-capable review passed all five finalized Workbench captures and verified the manifest plus all 12 exported member hashes/byte counts. The separate record is [`2026-07-19-workbench-observer-evidence-review.json`](../validation/2026-07-19-workbench-observer-evidence-review.json); its machine-local, non-durable source-bundle limitation remains explicit.

### Status legend

- **Complete:** the finding's current acceptance criteria are implemented and behaviorally validated in the available environment.
- **Partial:** important behavior is implemented, but one or more correctness, recovery, or evidence requirements remain.
- **Not started:** no implementation satisfying the finding's exit criteria was identified.

### Findings at a glance

| Finding | Priority | Status | Implemented | Remaining work |
| --- | --- | --- | --- | --- |
| **F1** runtime idempotency | High correctness | Complete | Canonical request fingerprints, conflicts, normalized replay, and receipt retention. | Keep the behavior in the future shared `CaptureService`. |
| **F2** observer bounds | High reliability | Complete | Bounded stores plus durable exact-generation authority reconstruction, camera obligations, stop reservations, and release acknowledgement across private-child replacement. | Preserve these contracts during later store/controller extraction. |
| **F3** mailbox starvation | High correctness (mailbox enabled) | Complete | Recoverable per-file disposition, independent ingress/egress health, exact idempotent quarantine, writer-safe reclamation, fairness, compiled Game/WorkbenchGame evidence, and controlled V10 execution. | Preserve these contracts during later transport extraction. |
| **F4** protocol registry | High contract correctness | Complete | Canonical typed registries and deterministic generation of TypeScript-facing JSON, schemas, fixed messages, and Markdown with CI dirty-diff enforcement. | Broaden conformance as new emitters are added. |
| **F5** nullable world | Medium contract correctness | Partial | Nullable current-world capture crosses the public tool boundary and is tested. | Resolve shared `worldEpoch`/`worldRevision` semantics during capture convergence. |
| **F6** lifecycle liveness | High operational reliability | Complete | One wall deadline spans every owned-runtime stop/shutdown sub-operation; ordinary managed NET/staging/retention work runs outside the machine mutex with exact final revalidation. | Preserve the deadline and local-activity-gate contracts during controller extraction. |
| **F7** endpoint vacancy | Medium safety | Complete | The total `vacant | occupied | unverifiable` contract absorbs timeout, spawn, exit, and invalid-helper failures; every spawn site fails closed. | Preserve zero-spawn behavior in the future shared process backend. |
| **F8** unpublished child | High recovery design | Partial | Crash cuts are characterized across client, runner, and owned runtime; exact verified owned pending children have cleanup-only recovery and observer authority survives private-child loss. | Stage 2 shared spawn transaction or OS guardian for Workbench/runner post-spawn pre-publication windows. |
| **F9** cleanup-pending status | Medium correctness | Complete | Termination and observer cleanup are distinguished; same-key completion retry is durable and idempotent. | Preserve this contract during controller extraction. |
| **F10** child reconciliation | Medium reliability | Complete | Workbench and owned-runtime exits remove supervised children and retry exact durable reconciliation with bounded, generation-fenced callbacks. | Preserve this contract in the future shared `ChildSupervisor`. |
| **F11** output reservation | Medium correctness | Complete for cooperating runners | Output emptiness checked inside and immediately after reservation, and again before target spawn. | Decide whether unrelated filesystem writers are in scope; use an exclusive UUID child if so. |
| **F12** package harnesses | Medium packaging correctness | Complete | Acceptance harnesses are repository-only; a real tarball is installed with `--omit=dev` and both advertised binaries are executed in CI. | Preserve the production-install smoke as package contents change. |
| **F13** CLI composition | Medium correctness/maintainability | Not started | No convergence satisfying this finding was identified. | Use one composition root; split read-only inspection from state creation. |

## Findings

F1-F13 are the findings from the original review. V1-V10 are additional blocking tasks that implementation validation on 2026-07-18 surfaced inside specific findings' scope; each is nested under its parent finding as "Remaining work" and is Stage 0 work unless its **Blocks** line names a dependency. The staged roadmap below is the primary work order; F and V identifiers are traceability references, not task numbers.

### F1. Runtime idempotency accepts changed requests

**Priority:** high correctness · **Status:** Complete

[`JobStore.submit()`](../../observer/agent/jobs.ts#L110) indexes only `sessionId + idempotencyKey` and returns the original job without comparing the new logical request. A retry can change the instance, view, deadline, or world expectation and silently receive an unrelated prior job. Workbench capture, evidence runs, and owned-runtime operations already use request fingerprints, so the semantics are inconsistent.

**Implementation:**

- Add a canonical `normalizeCaptureRequest()` function.
- Hash all semantic request fields. Exclude only transport-local values such as an `AbortSignal`; document whether a deadline is absolute or policy-derived and include its canonical representation.
- Store `{ jobId, fingerprint, expiresAt }` per session/key.
- Replay only an identical fingerprint.
- Return the canonical `IDEMPOTENCY_CONFLICT` code for a changed request.
- Bound the receipt lifetime; do not turn the fix into another permanent map.

**Required tests:**

- Identical retry returns the original job.
- Changing each semantic field conflicts.
- Equivalent normalized representations replay.
- Expired receipts follow the documented retention rule.

### F2. Long-lived observer state is unbounded

**Priority:** high reliability · **Status:** Complete — bounded stores and durable exact-generation lifecycle authority now survive private-child replacement, preserve camera-restoration obligations, and retain release authority until acknowledgement.

Jobs, idempotency entries, queue arrays, sessions, instances, and mailbox transports remain in memory indefinitely. `releaseJob` releases the artifact but not the job or queue state. Disk retention in the observer server does not compact these maps. Owned-runtime receipts have the same broader issue: prepared descriptors and terminal/pending/idempotency receipts have no complete retention policy, and each preparation synchronously scans all prior descriptors.

**Implementation:**

- Give every record an explicit owner, terminal condition, and retention period.
- Remove queue entries when dispatched or terminal rather than repeatedly scanning history.
- Add `sweep(now)` to the agent application, invoked on a bounded cadence and during controlled shutdown.
- Expire session-scoped instances and transports when a session is revoked and no restoration or terminal work remains.
- Retain small idempotency/release tombstones for a documented retry window, then delete them.
- Preserve records pinned by an open evidence run or unresolved recovery obligation.
- Replace the owned-runtime O(n) prepared-descriptor scan with a direct session/index receipt.
- Isolate a corrupt receipt so one bad file does not block all later preparation.
- Enforce per-record and total-store byte budgets.
- Add test-only or diagnostic store statistics so tests can assert bounds without inspecting private source text.

#### Implemented stabilization

V1 and V2 are complete. Real coordinator-to-forked-child tests repeatedly kill and replace the child beyond session TTL, reconstruct exact status and camera obligations, prove stop remains blocked until restoration, and show authority count/bytes return to zero. Release loss before delivery and response loss after application both preserve the exact generation until durable acknowledgement and final drainage.

##### V1. Reconstruct observer lifecycle authority after private-child or MCP failure

**Priority:** high recovery correctness · **Blocks:** F6

The runtime-generation lease, session, jobs, and camera-restoration obligations currently live only in the private child's memory. A replacement child starts empty, so a still-live exact runtime cannot re-retain its session or prove safe stop after a crash.

**Implementation:**

- Persist or securely reconstruct the exact session, runtime-generation lease, and stop-relevant job/camera-restoration obligations before a replacement child accepts lifecycle operations.
- Bind recovery to the durable exact runtime receipt and generation; never adopt by PID, executable similarity, or an unverified profile alone.
- Distinguish graceful shutdown sealing from unexpected child/MCP crash recovery.
- Never infer restoration safety merely because a replacement child has no in-memory jobs.

**Acceptance:**

- Start a runtime, terminate the private child unexpectedly, advance past session TTL and tombstone retention, start a replacement child, and prove status and exact stop still work.
- Repeat while a camera restoration obligation exists; stop must remain blocked until the obligation is reconstructed and restoration is confirmed.
- Repeat the cycle enough times to prove count and byte bounds remain stable.

##### V2. Make lifecycle-release acknowledgement durable before retention

**Priority:** high retention correctness

A failed start can retain the agent lifecycle, prove child vacancy, fail release IPC, and later lose its only retry authority when the `cleanup_verified` cluster is swept.

**Implementation:**

- Add explicit durable states such as `release_required` and `release_acknowledged` to pending-start cleanup.
- Retry lifecycle release outside the machine mutex and CAS the acknowledgement before making the cluster retention-eligible.
- Make release idempotently distinguish an already-released exact generation from a conflicting generation.
- Never sweep the last record capable of releasing an outstanding lease.

**Acceptance:**

- Lose the release request before delivery, advance beyond receipt retention, and prove the pending authority remains.
- Retry, durably acknowledge release, sweep again, and assert the agent pin, session lease, and manager receipts all drain.
- Repeat with the release applied but its response lost; the same generation must replay without conflict.

### F3. Mailbox poison files can starve valid commands

**Priority:** high correctness when mailbox transport is enabled · **Status:** Complete — V3 and V4 are implemented with cursor fairness, bounded retry/quarantine, independent ingress/egress health, exact fail-closed evidence, and writer-safe host/runtime reclamation; V10 executed those paths against compiled Enforce.

[`RFO_ObserverMailboxTransport.c`](../../observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverMailboxTransport.c#L46) examines only the first 256 sorted command files. Accepted files are removed, but malformed, oversized, expired, wrong-instance, and permanently rejected files remain. Once 256 stale files sort before a valid command, the valid command is never reached.

**Decision:** Mailbox remains a supported transport in this plan. Implement an explicit disposition state: accepted -> delete; permanently rejected -> bounded quarantine; transient failure -> retry with a bounded attempt/age budget.

**Required acceptance:**

- Place more than 256 stale or malformed files before one valid command and prove the valid command is eventually consumed without losing bounded forensic evidence.
- Inject transient deletion/quarantine failures and prove they remain accounted and retryable without disabling unrelated ingress or egress.
- Exercise writer/cleaner publication races and the actual 512-file egress boundary.
- Run the acceptance against compiled Enforce; a source-text check or independently implemented model is not sufficient.

#### Controlled acceptance evidence

V3 and V4 are complete in the host and addon implementations. The controlled V10 run compiled the final Game and WorkbenchGame modules with zero Enforce script errors, then passed fairness, cleanup-failure recovery, egress reclamation and exact-cap recovery, writer/cleaner coordination with exactly-once host delivery, and bounded quarantine against the real addon. The run used a Steam-initialized isolated profile, exited `0`, and proved zero Workbench processes before and after execution.

##### V3. Recover Enforce mailbox disposition without disabling the transport

**Priority:** high mailbox liveness

A transient deletion, quarantine, or orphan-cleanup failure currently sets the global mailbox transport to not ready permanently.

**Implementation:**

- Represent disposition as `disposed`, `retained_for_retry`, or `storage_unavailable` rather than a single boolean.
- Keep a failed exact file in count/byte accounting, continue round-robin work for unrelated files, and retry it with bounded attempt/age policy.
- Make quarantine publication idempotent so deletion retry cannot duplicate forensic evidence.
- Separate command-ingress health from status-egress health; one locked poison command must not stop heartbeat, status, or artifact publication.
- Add an explicit recovery path instead of relying on runtime restart.

**Acceptance:**

- Put more than 256 malformed commands before a valid command and lock one early poison file. Across bounded polls, the valid command must be consumed, the poison retried after unlock, egress must remain usable, and quarantine must stay bounded.
- Exercise missing and sharing-violation cleanup across multiple profiles and prove one retained file cannot stop unrelated retention.

##### V4. Make orphan ingress reclamation safe against an active writer

**Priority:** medium publication correctness · required for complete sign-off of F3

The host snapshots marker names and later deletes old markerless data without synchronizing with marker creation. A runtime paused longer than the grace period can resume after its valid data was deleted and publish a marker with no payload.

**Implementation:**

- Prefer runtime-side serialized reclamation for active sessions.
- Restrict host reclamation to a durably inactive writer/session, or introduce a writer-generation/cleanup-claim protocol.
- Do not treat a second unsynchronized marker check as a complete fix; it only narrows the race.

**Acceptance:**

- Pause the writer after data copy but before marker publication beyond the grace period while host cleanup runs, then resume and prove exactly-once delivery with intact payload.
- Create at least 513 markerless `.json` files plus separate `.json.tmp` remnants and prove the next real write safely reclaims capacity and publishes a complete status.

##### V10. Compile and execute mailbox acceptance in Enforce

**Priority:** high evidence quality · **Blocks:** F3 sign-off and the Stage 1 evidence exit criteria

**Status:** Complete — recorded in [`2026-07-18-observer-enforce-mailbox-acceptance.json`](../validation/2026-07-18-observer-enforce-mailbox-acceptance.json).

Before V10, the command-scanner test inspected source and ran a separately written TypeScript model. It did not compile or execute the changed `.c` code, and the orphan fixture did not place more than 512 `.json` files behind the runtime's actual egress guard.

**Completed implementation and acceptance:**

- Established reproducible, packaged Workbench Script Editor/Enforce compile and behavioral-acceptance commands for a Steam-initialized controlled environment.
- Executed the V3 and V4 cases against the real addon: more-than-one-batch fairness, deletion failure recovery, egress-cap reclamation, writer/cleaner race, and bounded quarantine.
- Retained source-text assertions only as supplementary architecture checks.

### F4. Protocol errors and capabilities have drifted

**Priority:** high contract correctness · **Status:** Complete — canonical typed registries, runtime-scoped errors, fixed-message redaction, emitter checks, and deterministic artifact generation are implemented.

[`ERROR_CODES`](../../observer/protocol/constants.ts#L81) omits codes emitted on public paths, including `AMBIGUOUS_INSTANCE`, `IDEMPOTENCY_CONFLICT`, `JOB_RELEASED`, `STALE_INSTANCE`, `SESSION_MISMATCH`, `WORKBENCH_ADAPTER_UNAVAILABLE`, and lifecycle verification errors. The common capability list omits implemented `camera.editor` while advertising capabilities with no confirmed producer.

**Implementation:**

- Create one typed error registry with code, public message policy, retryability, and backend applicability.
- Create one typed capability registry with the backend that can prove each capability.
- Map backend-private failures at adapter boundaries.
- Derive TypeScript unions, Zod enums, JSON schema, and protocol documentation from those registries.
- Add a test that fails when any emitted or advertised value is absent.
- Do not advertise `entity.resolve` or `server.coordinate` until an implementation and conformance test exist.

#### Implemented stabilization

V9 is complete. `npm run protocol:generate` writes all 10 derived artifacts deterministically, `npm run protocol:check` verifies byte-for-byte currency, and CI checks generation before its dirty-diff guard.

##### V9. Add an executable protocol-artifact generator

**Priority:** medium maintainability

**Implementation:**

- Add one repository command that reads the typed registries and writes TypeScript-facing JSON, JSON schema enums, fixed-message data, and Markdown tables deterministically.
- Make CI run the generator and fail on a dirty diff.
- Remove claims that manually edited files are generated until the command exists.

**Acceptance:**

- Delete or alter an artifact, run the generator, and reproduce the canonical byte-for-byte output.
- Change registry order or backend applicability and prove every derived artifact and conformance test updates from that one source.

### F5. The public world schema rejects a supported runtime state

**Priority:** medium contract correctness · **Status:** Partial — nullable current-world capture is implemented and tested through the public tool; the shared Workbench/runtime `worldRevision` representation remains for Stage 4.

The MCP schema for `expectedWorldId` accepts only a string, while runtime registration and current-view capture explicitly allow a null world. Make the field `nullable().optional()` and prove an inventory-null to current-view capture through the public tool, or define that `render.capture` is unavailable until a world is bindable. Do not keep contradictory rules at the protocol and MCP layers.

Workbench's hard-coded `worldEpoch: 0` is not a demonstrated race bug: the backend uses and rechecks a composite `worldIdentity`. It is still poor shared semantics. Replace the pair with an opaque `worldRevision`, or make epoch absent for Workbench and centralize the projection in one adapter.

### F6. Lifecycle operations can lose liveness

**Priority:** high operational reliability · **Status:** Complete — V5 total wall deadlines and V6 unlocked managed work are implemented alongside bounded runner recovery, durable uncertain termination, exact revalidation, and explicit mutex-loss fail-stop behavior.

The standalone runner's documented absolute deadline is not absolute. If exact termination is refused, recovery can wait indefinitely while retaining the global mutex. Observer stop can hold the same mutex while waiting up to five minutes for restoration. These are correct to refuse unsafe termination, but incorrect to monopolize global progress indefinitely.

**Implementation:**

- Separate the execution deadline from a short, bounded recovery deadline.
- On bounded recovery expiry, persist `stopping` plus the exact identity and return `RECOVERY_REQUIRED`.
- Release the mutex while waiting for readiness, restoration, or process lifetime.
- Reacquire it only for reserve/CAS/commit and revalidate generation plus owner before committing.
- Never publish `vacant` unless exact absence is proven.
- Make helper loss a durable recovery result rather than an implicit `process.abort()` policy hidden in a backend.

**Required tests:** use a fake clock/backend and assert a finite upper bound for every public lifecycle operation.

**Additional acceptance:**

- A never-settling restoration or lifecycle-release request must not exceed the public wall-clock budget.
- A blocked ordinary managed NET call must not prevent another process from acquiring and inspecting the lifecycle mutex, while the local activity gate must still prevent a conflicting restart.

#### Implemented stabilization

V5 and V6 are complete. One real wall deadline now covers stop/shutdown preparation, mutex, observer IPC, inspection, termination, release, and final inventory; expiry preserves exact recovery evidence. Managed NET calls, companion hashing/staging, and retention run outside the machine mutex behind the process-local activity gate, with exact generation/owner revalidation before any publication. V1 under F2 closes the private-child dependency.

##### V5. Enforce one wall-clock deadline across every lifecycle sub-operation

**Priority:** high liveness

**Implementation:**

- Compute the public operation deadline before stop/shutdown preparation.
- Pass the remaining budget to every mutex acquisition, observer IPC request, process inspection, termination, and release call.
- Do not start another sub-operation after expiry.
- Apply the same rule to `closeOwnedRuntimes()`, including terminal lifecycle release and final inventory locking.
- On expiry, retain exact durable recovery evidence and return the documented recovery result.

**Acceptance:**

- A never-settling restoration gate must return within the configured wall budget, including `waitForRestorationMs: 0`.
- A mutex or inspection that consumes the remaining budget must prevent later IPC/inspection attempts.
- A never-settling lifecycle release must not overrun the aggregate shutdown deadline.

##### V6. Remove ordinary Workbench work from the machine mutex

**Priority:** high cross-process liveness

**Implementation:**

- Use the process-local activity gate for managed NET call lifetime.
- Perform network I/O, companion hashing/staging, and retention outside the global mutex.
- Reacquire the mutex only for bounded snapshot/CAS/revalidation and refuse stale commits by generation and owner.
- Cache immutable companion attestation by lifecycle generation and digest.

**Acceptance:**

- While a managed NET request is blocked, another process can acquire and read the lifecycle mutex.
- The local activity gate still prevents restart/shutdown from racing that request.
- A generation change during the unlocked call prevents stale state publication.

### F7. Endpoint vacancy can fail open

**Priority:** medium safety · **Status:** Complete — all current runner spawn sites and the MCP client consume a total vacancy result and fail closed on occupied or unverifiable outcomes.

The MCP Workbench client treats TCP timeout and every socket error as "not listening" and uses that result to gate launch/restart. The standalone runner already has a fail-closed `verifyEndpointVacant` result.

**Implementation:**

- Delete the boolean `isPortListening()` decision path.
- Use a result union such as `vacant | occupied | unverifiable` from the shared backend.
- Spawn only on `vacant`; return a stable recovery/diagnostic error on `unverifiable`.
- Test refusal, timeout, reset, permission error, occupied, and clean vacancy.

#### Implemented stabilization

V7 is complete. Native helper timeout, launch failure, nonzero exit, and invalid JSON map to stable `unverifiable` results, and client/runner fixtures prove lifecycle recovery with zero target spawns.

##### V7. Make endpoint vacancy a total result contract

**Priority:** medium fail-closed contract correctness

**Implementation:**

- Catch read-only helper timeout, spawn, exit, and invalid-response failures inside `verifyEndpointVacant()`.
- Map them to stable `unverifiable` reasons rather than throwing or projecting `STATE_INVALID`.
- Keep client and runner error mapping consistent and preserve zero-spawn behavior.

**Acceptance:**

- Use native helper fixtures for timeout and invalid JSON.
- Assert the backend returns `unverifiable`, public callers return the documented endpoint/recovery error, lifecycle state remains recoverable, and spawn count stays zero.

### F8. A crash can orphan a child before ownership publication

**Priority:** high recovery design · **Status:** Partial — Phase 0 crash characterization, exact owned-runtime cleanup-only recovery, and private-child/MCP authority reconstruction are complete; Workbench client/runner post-spawn pre-publication recovery remains Stage 2 work.

Workbench client and runner still spawn before durable exact identity is committed. A parent crash after process creation and before the identity CAS can leave a live tokened process that recovery deliberately treats as unowned. The client recovers a reservation-only crash when no process exists and cleans up an exact published identity, while the standalone runner preserves every crash-left busy reservation for MCP or attended recovery.

Owned runtime now records `pre_spawn`, `spawned_unverified`, and `identity_verified` pending phases. A same-key retry performs cleanup-only termination only for a fully verified pending identity and durably advances `release_required` to `release_acknowledged`; it neither adopts nor terminates a merely similar process. An immutable runtime receipt remains the sole successful ownership publication.

**Close this window in the shared spawn primitive:**

- Persist a unique launch capability before spawn.
- After spawn, inspect and atomically publish exact identity.
- Recover only with full executable, token, PID, and creation identity evidence.
- If Windows cannot make publication sufficiently safe, use a small guardian or Job Object that terminates an unpublished child when the parent channel closes.
- Expose cleanup-only recovery for fully verified pending identities; never adopt a merely similar process.

Behavioral crash-cut characterization now covers every spawn transaction phase for the Workbench client, standalone runner, and owned runtime:

| Cut point | Workbench client | Standalone runner | Owned runtime |
| --- | --- | --- | --- |
| Before spawn | Retry after proving no Workbench exists. | Preserve the busy reservation for MCP/attended recovery. | Preserve `pre_spawn`; a restart cannot distinguish this cut from entry into the spawn call. |
| After spawn | Preserve the live unowned child; no PID-only signal. | Preserve the live child and reservation; no PID-only signal. | Preserve `spawned_unverified`; no exact cleanup authority exists yet. |
| After exact inspection | Preserve until the exact identity CAS exists. | Preserve until the exact identity CAS exists. | Preserve `spawned_unverified`; in-memory inspection is not recovery authority. |
| Before successful publication | Preserve if Workbench identity is not durable. | Preserve for MCP/attended recovery. | Cleanup-only terminate the exact `identity_verified` pending generation, then acknowledge lifecycle release. |
| After successful publication | Recover/terminate only the exact durable Workbench identity. | Preserve for MCP/attended recovery. | Resume the immutable owned-runtime receipt; this is no longer a pending-child recovery. |

F8 remains **Partial** because the Workbench post-spawn/pre-publication orphan window and standalone-runner replacement recovery require Stage 2's shared spawn-transaction primitive or an OS guardian/Job Object. The Phase 0 characterization and the owned-runtime fully verified pending cleanup path are complete.

### F9. Owned-runtime stop can report completion too early

**Priority:** medium correctness · **Status:** Complete — public status remains cleanup-pending until observer completion is durable, and same-key retry completes it idempotently.

A stop receipt is published before observer session completion. Status treats the stop receipt as terminal even when the stop-completion record is absent. Represent `termination_complete / observer_cleanup_pending` explicitly and continue reporting `stopping` until cleanup is durable. Retrying stop must complete cleanup idempotently.

### F10. Child-process and receipt resources are not reconciled

**Priority:** medium reliability · **Status:** Complete — Workbench and owned-runtime natural exits remove supervised children and retry exact durable state reconciliation with bounded, generation-fenced callbacks.

Successful runtime children are retained in an effectively write-only `Map`; natural exit has no reconciliation path. Extract a `ChildSupervisor` with persistent `error` and `exit` handlers, automatic map removal, and a callback that reconciles durable state. Use it for Workbench and runtime children.

#### Implemented stabilization

V8 is complete. Callback failure is observable and automatically retried within a bound; retries are tied to the expected generation and canceled when a newer child is supervised.

##### V8. Retry exact child-exit reconciliation durably

**Priority:** medium lifecycle reliability

**Implementation:**

- Make child callback failure observable.
- Enqueue bounded reconciliation retry or have periodic sweep retry exact terminal reconciliation.
- Bind every retry to the expected runtime generation and discard it if a newer generation exists.
- Keep the lifecycle lease until exit evidence and release acknowledgement are durable.

**Acceptance:**

- Fail the first mutex, storage, or release attempt after exit and make no status call.
- Prove automatic retry writes exact exit evidence, releases the lifecycle lease, drains retry/supervisor state, and leaves a newer generation untouched.

### F11. Workbench build validates output too early

**Priority:** medium correctness · **Status:** Complete for cooperating runner invocations — the implementation checks inside and immediately after lifecycle reservation and rechecks/snapshots before target spawn; it does not provide exclusive filesystem ownership against an unrelated writer.

Output emptiness is checked before the lifecycle lock and not rechecked until after companion preflight. Two builds can both accept the same initially empty output, and the loser can launch a preflight before discovering the race.

**Implementation:**

- Prefer accepting an output parent and atomically creating an exclusive UUID child.
- Otherwise revalidate immediately after reservation and before any spawn.
- Reject overlap with the target mod, companion profile, and managed roots.

If unrelated writers are in scope, retain a follow-up to accept an output parent and atomically create an unpredictable exclusive child. Otherwise document that a caller-supplied output directory must be caller-exclusive.

### F12. Installed-package acceptance scripts are not runnable

**Priority:** medium packaging correctness · **Status:** Complete — the TypeScript acceptance harnesses are repository-only and explicitly dev-prefixed; the package smoke creates a real tarball, installs it into a fresh project with `--omit=dev`, and executes both advertised binaries without a shell.

The initial package published TypeScript acceptance harnesses and advertised npm scripts for them even though `tsx` was dev-only, `src` and `tsconfig*.json` were absent, and the build excluded the scripts. The implemented path removes those raw harnesses from the packed contract, names the repository commands `dev:observer:acceptance:*`, and makes [`scripts/check-package.mjs`](../../scripts/check-package.mjs) validate a fresh production install. The final smoke passed with 690 packed files and both binaries, and Ubuntu Node 20 CI runs it.

**Recommended decision:** keep acceptance harnesses repository-only and remove them from `files`. If they are intended product commands, compile them into `dist`, expose supported binaries, move runtime dependencies appropriately, and smoke-test the installed tarball with `--omit=dev`.

### F13. The standalone observer CLI has a divergent, partly unusable composition root

**Priority:** medium correctness and maintainability · **Status:** Not started

`observer/agent/index.ts` defines the canonical application graph, but `observer/agent/cli.ts` reconstructs it manually. Standalone `serve` cannot provide evidence or supporting-log roots, so it can begin evidence runs but finalization fails against an empty allowlist. Standalone `doctor` also constructs the mutating graph and creates the managed root plus its directories, unlike the MCP-side read-only diagnostic.

**Implementation:**

- Make CLI and private child call the same `createObserverApplication(options)` composition root.
- Require or explicitly disable evidence-run operations when no evidence roots are configured.
- Split `inspectPaths()` from `ensurePaths()` and use only the former for `doctor`.
- Share application operation handlers; keep CLI/private IPC serialization as thin adapters.

## Target architecture

### Preserve

These invariants justify real implementation complexity and should remain explicit:

- Only terminate a process after exact executable, PID, creation identity, and owner-token verification.
- Fail closed when ownership or mutation outcome is uncertain.
- Never inject helpers into the user's project; stage immutable, content-addressed companions.
- Restore camera and world state before declaring a capture terminal or releasing it.
- Make side-effecting operations idempotent and durable across retries.
- Keep runtime IPC isolated from the public MCP process.

### Consolidate

The fork delta spreads each of the following concerns across multiple modules that have drifted from one another. Extract one implementation per concern, not a single mega-controller.

#### 1. Exact-process and lifecycle infrastructure

Lifecycle work is currently spread across:

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

Several persisted fields and states in this area currently add branches without recovery behavior. `validateAndClaim({ operation })` accepts an operation that the initial claim discards, while a vacant state cannot legally contain one. Owned runtime records six pending-start variants but rejects rather than repairs them, and `prepareIdempotencyHash` is written but never read. Remove the ignored claim option, transition operation state explicitly, and either implement a tested cleanup/recovery path for each pending state or collapse it to one fail-closed `cleanup_required` record.

#### 2. Workbench client and runner

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

#### 3. Observer coordinator and capture backends

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

#### 4. Paths, storage, and companion staging

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

#### 5. Protocol, registries, and build layout

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

#### 6. Composition and shutdown

`src/server.ts` reaches into an SDK-private `server` property and overwrites `onclose`, while `src/index.ts` also owns disposal and process signals. Replace this with one explicit composition contract:

```ts
interface Application {
  register(server: McpServer): void;
  close(): Promise<void>;
}
```

Make `close()` idempotent. The executable installs signal handlers and calls it; embedded users receive and call it explicitly. Do not depend on private SDK fields.

### Remove or defer

- Refusal-only tool actions and their full schemas/tests.
- Published TypeScript acceptance harnesses that cannot run from an installed package.
- The unused `playwright` dependency unless an actual test consumes it.
- Workbench build's helper-enabled preflight if target-build acceptance proves it adds no safety.
- A second transport such as mailbox if it is not a demonstrated product requirement.
- A generic cross-domain lifecycle state machine. The domains share primitives, not all policy.

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
- Retention: repeated submit/complete/release/session expiry remains within explicit count and byte limits; failed lifecycle release retains its exact retry authority; private-child crash reconstructs stop-relevant state.
- Mailbox transport: more-than-one-batch fairness, idempotent disposition, deletion-failure recovery, writer/cleaner publication races, egress-cap reclamation, and bounded quarantine in compiled Enforce.
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

## Roadmap

The stages below are the sole numbered implementation sequence. Finding and validation identifiers are traceability references, not task names. Suggested review boundaries use names rather than a competing number line; they organize reviewable changes without creating a second roadmap.

### Stages

#### Stage 0: correctness stabilization

Status: **Complete.** Do not move large modules until their Stage 2 extraction contracts are in place.

1. **Complete —** preserve canonical runtime idempotency and nullable-world behavior at the public boundary. _References: F1, F5; the shared worldRevision projection remains Stage 4 work._
2. **Complete —** build the executable protocol-artifact generator and make its output the canonical schema and documentation source. _References: F4, V9._
3. **Complete —** keep mailbox as a supported transport and recover transient disposition failures without disabling it. _References: F3, V3._
4. **Complete —** make orphan ingress reclamation safe against an active writer. _References: F3, V4._
5. **Complete —** real Enforce mailbox acceptance compiled Game and WorkbenchGame with zero script errors and passed fairness, deletion-failure recovery, egress-cap reclamation/recovery, the writer/cleaner race with exactly-once delivery, and bounded quarantine. _References: F3, V10._
6. **Complete —** reconstruct observer lifecycle authority after private-child or MCP loss before accepting lifecycle operations. _References: F2, V1._
7. **Complete —** make lifecycle-release acknowledgement durable, retryable, and safe to retain. _References: F2, V2._
8. **Complete —** complete the total, fail-closed endpoint-vacancy contract, including native-helper failures. _References: F7, V7._
9. **Complete —** enforce one wall-clock deadline across every lifecycle sub-operation and persist an exact recovery result on expiry. _References: F6, V5._
10. **Complete —** add durable exact child-exit reconciliation retry and settle the unrelated build-output-writer threat model. _References: F10, V8; F11._
11. **Complete —** move ordinary managed NET calls, companion work, and retention outside the global machine mutex while preserving a local activity gate. _References: F6, V6._
12. **Complete for Phase 0 —** characterize every unpublished-child crash window and make minimal immediate fixes; the common recoverable transaction remains Stage 2 work. _References: F8._

**Suggested review boundaries:**

- **Observer crash and mailbox safety:** Tasks 3-7.
- **Lifecycle liveness:** Tasks 8-11.
- **Unpublished-child recovery:** Task 12.

**Exit criteria:** met. Every finding F1-F11 has regression coverage, public lifecycle operations complete or return durable recovery within a documented bound, retention preserves sole release authority, replacement children reconstruct restoration obligations, cleaners preserve active-writer data, V10 supplies controlled real-addon Enforce evidence, and the final Windows suite passed the 10-consecutive-run repetition bar recorded in [`2026-07-18-phase-0-vitest-repetition.json`](../validation/2026-07-18-phase-0-vitest-repetition.json).

**Evidence provenance closeout:** [`2026-07-19-stage-0-evidence-provenance-review.json`](../validation/2026-07-19-stage-0-evidence-provenance-review.json) independently rechecked the retained record/report hashes and counts and assesses the results as `internally_consistent_provenance_limited`. It documents, without retroactively curing, the absent full-tree/revision identity, machine-local non-durable Vitest reports, unretained raw 20-run focused evidence, closeout-only evaluator hashes, and non-retained diagnostic bytes. Those limitations do not alter the recorded pass results but must travel with them.

#### Stage 1: make safety evidence trustworthy

Status: **repository implementation and controlled evidence complete; external administration pending**. Task 0's evidence-integrity work and Tasks 1-5 are closed out in the working tree. Requiring the new CI check contexts in `main` branch protection is a repository-settings action that cannot be performed or verified from this checkout.

1. [x] Added symmetric Ubuntu/Windows Node 20/22 CI jobs with the Stage 0 generator dirty-diff check.
   - [ ] A repository administrator must require the applicable Ubuntu and Windows check contexts in `main` branch protection.
2. [x] Added installed-tarball smoke testing and made the raw TypeScript acceptance harnesses repository-only. _References: F12._
3. [x] Replaced the prepared-descriptor-specific 128 MiB allowance with a 402,034-byte cap derived from the real Windows command-line and launcher boundary; the generic record ceiling remains for unrelated records.
4. [x] Recorded two comparable Workbench and two comparable runtime timing/helper-count baselines, all passed with zero supervised processes at rest. See the [`Stage 1 guide`](2026-07-18-stage-1-safety-evidence-implementation-guide.md#task-4-record-baseline-timings-and-helper-process-counts).
5. [x] An image-capable reviewer inspected the five finalized Workbench captures and manifest for run `20260718T015947Z-6ec8429d`. The separate, hash-bound [`2026-07-19-workbench-observer-evidence-review.json`](../validation/2026-07-19-workbench-observer-evidence-review.json) records the reviewer, Workbench 1.7.0.54 product/file version and provenance, per-capture outcome, warning, limitations, exact manifest/receipt digest match, and all 12 exported member byte/hash checks. The finalized source manifest remained unmodified with `Unreviewed`/`imagesReviewed=false`; the review record supplies the formal `Passed` decision without rewriting it. The record also discloses that the source bundle is machine-local temporary evidence, not a durable repository archive.

**Exit criteria:** the repository-side criteria are met: Windows process code has a Windows CI job, package checks exercise the installed production package, Stage 0 generator/Enforce evidence and Stage 1 operational baselines are reproducible in CI or a controlled environment, and the Workbench observer export has a formal review. The merge-enforcement clause remains pending until an administrator requires the applicable Ubuntu and Windows CI contexts in `main` branch protection.

#### Stage 2: extract the shared safety kernel

Status: **not started**. One primitive (`ChildSupervisor`) is already shared; every other primitive in this stage's scope currently has two or three independent implementations with drifted safety properties. (See Target architecture → Consolidate #1 and #4.) The task list below was re-derived against the current tree (`HEAD@7da4411` plus the uncommitted working-tree state reviewed 2026-07-19) rather than restated from the original review, so every duplication claim carries a file/line citation.

##### Task 1. Move pure identity, owner capability, path, digest, and result types first

**Current state:** managed-path containment exists at two safety levels that both call themselves the safe way to stay inside a root:

- [`safePath()`/`validateProjectPath()`](../../src/utils/safe-path.ts#L56) resolve and prefix-check a path but never call `realpathSync`, so a symlinked segment inside an already-validated directory is not detected. It backs most of `src/tools/*` (12 call sites, including [`mod.ts`](../../src/tools/mod.ts), [`project.ts`](../../src/tools/project.ts), and [`game-duplicate.ts`](../../src/tools/game-duplicate.ts)).
- [`assertManagedPath()`](../../observer/agent/paths.ts#L101) canonicalizes the root, walks every path segment with `realpathSync.native`, and rejects a link that resolves outside the root. It backs the observer agent exclusively.

These exist for different trust boundaries today (general project files versus observer-managed state), so unifying them is a real design decision, not a rename: decide whether general tool paths should be upgraded to the link-safe check or whether the weaker check is an intentional, documented tradeoff for user project directories that are not adversarial. Do not silently swap one for the other without that decision.

Also collapse the clamp-and-validate helper that six classes each reimplement with the identical `(value, fallback, minimum, maximum, label)` shape: [`sessions.ts#L586`](../../observer/agent/sessions.ts#L586), [`registry.ts#L425`](../../observer/agent/registry.ts#L425), [`mailbox-coordinator.ts#L811`](../../observer/agent/mailbox-coordinator.ts#L811), [`mailbox.ts#L308`](../../observer/agent/mailbox.ts#L308), [`server.ts#L688`](../../observer/agent/server.ts#L688), plus the differently-named `integerOption` in [`jobs.ts#L1225`](../../observer/agent/jobs.ts#L1225) and `option` in [`owned-runtime-authority.ts#L490`](../../observer/agent/owned-runtime-authority.ts#L490). One `boundedOption()` export in `src/foundation/` replaces all seven.

Identity types are already close to convergent: [`ExactProcessIdentity`](../../src/workbench/process-guard.ts#L20) (`pid`, `executablePath`, `creationTime`) and [`OwnedRuntimeExactIdentity`](../../src/observer/owned-runtime-manager.ts#L107) (`pid`, `executablePath`, `creationTimeFileTime`) differ only in field name. Pick one field name, move the type to `src/foundation/identity.ts`, and delete the field-renaming translation currently done by hand in `WindowsOwnedRuntimeProcessBackend` (see Task 3).

**Target:** `src/foundation/managed-path.ts`, `src/foundation/bounded-option.ts`, `src/foundation/identity.ts`, `src/foundation/digest.ts`, `src/foundation/result.ts`, matching the layout already sketched under Target architecture → Consolidate #4.

##### Task 2. Introduce `BoundedJsonStore`/`JsonCasStore` and migrate one store at a time

**Current state:** at least six classes independently implement "bounded in-memory map plus disk-durable records plus a `sweep(now)`," each with its own record schema, its own count/byte budget fields, and its own retention pass:

| Store | File | Bound fields |
| --- | --- | --- |
| `SessionStore` | [`observer/agent/sessions.ts#L148`](../../observer/agent/sessions.ts#L148) | `maxRecords`, `maxEstimatedBytes`, `terminalRetentionMs` |
| `JobStore` | [`observer/agent/jobs.ts#L274`](../../observer/agent/jobs.ts#L274) | `maxRecords`, `maxEstimatedBytes`, `maxRecordEstimatedBytes` |
| `InstanceRegistry` | [`observer/agent/registry.ts#L84`](../../observer/agent/registry.ts#L84) (ctor at L92) | `maxRecords`, `maxEstimatedBytes` |
| `OwnedRuntimeAuthorityStore` | [`observer/agent/owned-runtime-authority.ts#L121`](../../observer/agent/owned-runtime-authority.ts#L121) | `maxRecords` (L123), `maxBytes` |
| `ArtifactStore` | [`observer/agent/artifacts.ts#L119`](../../observer/agent/artifacts.ts#L119) | per-artifact retention |
| `ObserverRunStore` | [`observer/agent/runs.ts#L273`](../../observer/agent/runs.ts#L273) | run-scoped retention |

A parallel, disk-only CAS mechanism already exists for Workbench: [`WorkbenchLifecycleBackend.replaceState()`/`archiveState()`](../../src/workbench/process-guard.ts#L925) performs the compare-and-swap by invoking the native `ReplaceState`/`ArchiveState` PowerShell helper commands rather than doing the rename in Node, because the state file's atomicity guarantee has to hold across processes/machine-mutex holders, not just within one Node process. Separately, [`OwnedRuntimeManager`'s private `atomicWrite()`](../../src/observer/owned-runtime-manager.ts#L4048) does a third variant in plain Node: `open("wx")` + `fsyncSync` + optional exclusive-exists check + `renameSync`. `observer/agent/paths.ts`'s [`atomicWriteFile()`/`atomicWriteJson()`](../../observer/agent/paths.ts#L141) is a fourth, the only one already shared (used by `sessions.ts`, `artifacts.ts`, `mailbox.ts`, `mailbox-coordinator.ts`, `owned-runtime-authority.ts`, `runs.ts`, `staging.ts`).

`JsonCasStore` therefore needs two backends, not one implementation: a plain-Node rename-based CAS (generalizing `paths.ts#L141` and `owned-runtime-manager.ts#L4048`) and a helper-mediated CAS for state that must stay valid across the machine mutex (generalizing `process-guard.ts#L925`). Do not force the Workbench lifecycle state onto the plain-Node path without first confirming the native helper's guarantee is not load-bearing (see the F6/V6 mutex-scope contracts this state file already has to preserve).

**Migration order:** start with `OwnedRuntimeAuthorityStore` and `ArtifactStore` — both already use `paths.ts` atomic writes and have the simplest record shape — then `SessionStore`, then `InstanceRegistry`, then `JobStore` (largest, most call sites), then fold `MailboxCoordinator.sweep()` retention in last since F3/V3/V4 correctness depends on it and it should move only once the contract suite is proven on lower-risk stores. Leave `WorkbenchLifecycleStateV3`'s helper-mediated CAS for its own migration once the plain-Node `JsonCasStore` is stable, per the two-backend split above.

**Contract suite:** the bounded reads / link rejection / corrupt-state / CAS-race / atomic-replacement suite already required under "Required contract suites" applies per store as it migrates; do not delete a store's bespoke tests until its data runs through the shared suite.

##### Task 3. Introduce `ExactProcessBackend`, `MachineMutex`, and `ChildSupervisor` behind existing adapters

**`ChildSupervisor` is already done.** [`src/workbench/child-supervisor.ts`](../../src/workbench/child-supervisor.ts) is generic today and is already imported by both [`WorkbenchClient`](../../src/workbench/client.ts#L411) and [`OwnedRuntimeManager`](../../src/observer/owned-runtime-manager.ts#L833). The only remaining work is the mechanical move to `src/foundation/` (or `src/platform/`) called for by the target layout — there is no behavior left to consolidate.

**`ExactProcessBackend` is not done, but the underlying implementation already is.** Two interfaces exist:

- [`WorkbenchLifecycleBackend`](../../src/workbench/process-guard.ts#L178), implemented by `WindowsLifecycleBackend` ([`process-guard.ts#L431`](../../src/workbench/process-guard.ts#L431)).
- [`OwnedRuntimeProcessBackend`](../../src/observer/owned-runtime-manager.ts#L121), implemented by [`WindowsOwnedRuntimeProcessBackend`](../../src/observer/owned-runtime-manager.ts#L141), which is a hand-written adapter that wraps a `WindowsLifecycleBackend` instance and renames fields (`creationTime` → `creationTimeFileTime`, drops `ownerTokenArgument`/`launchedAtMs` on the way in, re-adds them on the way out at L182-193) to satisfy the second interface's shape.

In other words, one native Windows implementation already backs both call sites; only the TypeScript-level interface is duplicated, plus a translation shim that exists solely to reconcile the two shapes. Once Task 1's identity types are unified, most of `WindowsOwnedRuntimeProcessBackend` becomes a pass-through and can be deleted rather than migrated.

`MachineMutex` is not extracted at all: `withMachineMutex()` is declared directly on both backend interfaces ([`process-guard.ts#L180`](../../src/workbench/process-guard.ts#L180), [`owned-runtime-manager.ts#L123`](../../src/observer/owned-runtime-manager.ts#L123)) instead of being a standalone primitive the backend composes. Extracting it as its own class is what lets `OwnedRuntimeManager` stop importing Workbench-named types to reach its mutex.

**Test debt to close in the same pass:** [`tests/workbench/fake-lifecycle-backend.ts`](../../tests/workbench/fake-lifecycle-backend.ts) implements `WorkbenchLifecycleBackend`; [`tests/observer/owned-runtime-manager.test.ts#L45`](../../tests/observer/owned-runtime-manager.test.ts#L45) independently defines `class FakeBackend implements OwnedRuntimeProcessBackend`. This is the concrete instance of the "repeated fake backend copies" row already listed under Test and CI redesign — collapse both to one `ExactProcessBackend` fake with adapter factories before deleting either.

##### Task 4. Implement the recoverable spawn transaction and shorten mutex scopes

**Current state:** `OwnedRuntimeManager` already has the target shape of the transaction. Its `start()` path persists `pending.state` through `pre_spawn` ([`owned-runtime-manager.ts#L2037`](../../src/observer/owned-runtime-manager.ts#L2037)) → spawn → `spawned_unverified` (L2065) → inspect → `identity_verified` (L2099) → `retainRuntimeLifecycle()` → publish the immutable receipt, with `leaseFence.assertActive()` checks between every step so a lost lease aborts the transaction instead of completing it under a stale generation.

Neither Workbench spawn site has an equivalent durable transaction: [`WorkbenchClient`'s spawn call](../../src/workbench/client.ts#L438) and the two native-helper `spawn()` calls in [`process-guard.ts#L516`](../../src/workbench/process-guard.ts#L516) (PowerShell lifecycle helper) and [`process-guard.ts#L593`](../../src/workbench/process-guard.ts#L593) (mutex helper) go straight from process creation to in-memory state with no persisted `pre_spawn`/`spawned_unverified` record. This is exactly the gap F8 still lists as **Partial** for the Workbench client and standalone runner.

**Target:** extract the `pre_spawn → spawned_unverified → identity_verified → published` state machine from `owned-runtime-manager.ts` into a shared primitive parameterized over `ExactProcessBackend` and `JsonCasStore`, then point the two Workbench spawn sites at it. Task 4 is the permanent home for this transaction; it completes the minimal Stage 0 Task 12 crash-characterization patches rather than duplicating them, and it is what finally closes F8.

##### Task 5. Introduce a reusable reservation/lease gate with abortable waits

**Current state:** two structurally different lease mechanisms already exist and both matter:

- [`WorkbenchActivityGate`](../../src/workbench/activity-gate.ts#L1) issues an in-process `CaptureActivityLease` bound to an `AbortController`; cancellation is delivered through `lease.signal` (L39-43). This is a single-process, single-generation lease.
- [`OwnedRuntimeManager.reserveStopWhenRestored()`](../../src/observer/owned-runtime-manager.ts#L2671) is a hand-rolled `for (;;)` poll loop: it re-acquires the machine mutex each iteration, calls `observerGate.reserveRuntimeStop()` over IPC, checks `signal?.aborted` inline (L2684, L2726), and sleeps in bounded increments against a wall deadline until restoration proof appears or the deadline expires. This is a cross-process, IPC-mediated, idempotent-retry lease.

**Target:** do not force these into one implementation that hides which guarantee it provides. The shared primitive should separate "an abortable in-process lease" (generalizing `activity-gate.ts`) from "a durable, idempotent, deadline-bounded reservation retried over an unreliable channel" (generalizing `reserveStopWhenRestored`), while giving both the same cancellation vocabulary (`AbortSignal` in, typed cancellation reason out) so callers compose them the same way. Building one abstraction that quietly drops the IPC-retry semantics to look like the simpler in-process lease would reintroduce the F6/V5 liveness bugs Stage 0 just fixed.

##### Task 6. Consolidate companion staging after storage/path behavior is shared

**Current state:** content-addressed bundle staging is implemented twice with near-identical function names and an identical temp-directory-then-atomic-rename sequence:

- [`src/workbench/helper-addon.ts`](../../src/workbench/helper-addon.ts): `sha256File()` (L324), `computeWorkbenchHelperBundleDigest()` (L328), `verifyBundleDirectory()` (L~426), stage-to-`.{digest}.{uuid}.tmp`-then-`renameSync`-to-digest-root (L648-672).
- [`observer/agent/staging.ts`](../../observer/agent/staging.ts): `sha256File()` (L64), `computeBundleDigest()` (L68), `verifyBundleDirectory()` (L103), the same temp-then-rename sequence (L163-184).

The manifest shapes are also independently declared and independently Zod-validated in each file rather than sharing one schema.

**Target:** one `src/companions/content-addressed-bundle.ts` accepting a manifest and payload source, per Target architecture → Consolidate #4, built on the Task 1 digest primitive and the Task 2 atomic-write primitive. Do this last in the stage because both current implementations already depend on the atomic-write behavior Task 2 is migrating; consolidating staging first would mean migrating it twice.

##### Sequencing and exit criteria

Each migration must run the same backend contract suite before deleting its old helper. Avoid a flag day: land Tasks 1-2 (pure types, then the store split) before Task 3 depends on the unified identity types, and land Task 3 before Task 4 needs one `ExactProcessBackend` to parameterize the spawn transaction over. Tasks 5 and 6 have no ordering dependency on each other but both assume Task 2's atomic-write primitive exists.

**Exit criteria:** one implementation each for managed-path validation, bounded atomic JSON (with its two backends, plain-Node and helper-mediated, explicitly documented rather than silently merged), exact process verification/termination, child reconciliation (already met), and content-addressed staging. `WindowsOwnedRuntimeProcessBackend`'s field-renaming shim is deleted, not migrated. `tests/observer/owned-runtime-manager.test.ts`'s `FakeBackend` and `tests/workbench/fake-lifecycle-backend.ts` are one fake. No store still reimplements `boundedOption()` locally.

#### Stage 3: converge Workbench lifecycle paths

Status: **not started**. Phase 0 moved ordinary managed work outside the global mutex, but client and runner remain separate lifecycle implementations without the shared session controller required by this stage. (See Target architecture → Consolidate #2.)

1. Split `WorkbenchNetApiClient` from lifecycle state.
2. Create the canonical `WorkbenchLaunchPlan` and readiness/attestation checks.
3. Put client and runner over `WorkbenchSessionController` while preserving their explicit policy differences.
4. Preserve and recheck build output reservation immediately before spawn.
5. Remove helper preflight after real target-build acceptance proves it unnecessary.
6. Cache companion attestation by lifecycle generation plus immutable digest; do not hash the full bundle around every ordinary NET call.
7. Restrict global mutex usage to lifecycle transitions. Use a local reader/writer activity gate for same-session NET calls.

Task 7 is the architectural form of the urgent Stage 0 Task 11 mutex-liveness fix, not a duplicate.

**Exit criteria:** launch arguments, state drafts, readiness, exact-child supervision, and endpoint vacancy each have one implementation. `client.ts` no longer owns staging and process policy, and `runner.ts` is a CLI policy layer rather than a second lifecycle engine.

#### Stage 4: converge observer orchestration

Status: **not started**. (See Target architecture → Consolidate #3.)

1. Introduce `CaptureService` over the existing adapters without changing public tools.
2. Move common idempotency, timeout, polling, cancellation, projection, run binding, release, and the shared worldRevision projection into it. _References: F1, F5._
3. Reduce runtime and Workbench adapters to backend-specific behavior.
4. Split `ObserverAgentClient` from coordinator orchestration.
5. Use one application composition root and shared operation handlers for CLI and private child. _References: F13._
6. Split read-only `inspectPaths()` from mutating `ensurePaths()` so `doctor` does not create state.
7. Move evidence-bundle export into an optional `EvidenceBundleService` rather than capture transport/lifecycle.

Mailbox support was decided in Stage 0 and is intentionally not reopened here.

**Exit criteria:** one host job/idempotency system, coordinator reduced to composition/routing, and every backend passes the same capture contract.

#### Stage 5: prune surface and generated duplication

Status: **not started**. (See Public surface cleanup and Target architecture → Consolidate #5.)

1. Remove or deprecate refusal-only tools/actions.
2. Remove ignored configuration fields.
3. Migrate remaining handwritten schema and documentation consumers to the Stage 0 generator output, then delete the handwritten copies.
4. Compile host TypeScript once or introduce project references.
5. Replace private SDK shutdown hooks with explicit application ownership.
6. Remove repo-only acceptance sources and unused dependencies from the package.
7. Apply the validated line-ending policy in an isolated mechanical commit.

#### Stage 6: delete superseded tests and code

Status: **not started**. Delete only after the replacement contracts and acceptance paths are green (see Test and CI redesign → Replace implementation-text contracts):

1. Delete duplicate fake lifecycle backends.
2. Delete source-text camera/lifecycle/acceptance tests.
3. Delete copied path/digest/atomic-write helpers.
4. Delete duplicate Workbench state adapters and build-preflight receipts.
5. Delete handwritten protocol schema copies.
6. Delete standalone composition duplication.
7. Delete refusal-only schemas and tests.
8. Delete the separate observer TypeScript build if compilation is unified.

Measure the diff after every deletion review boundary. The goal is not an arbitrary line quota; it is one owner per invariant and no implementation retained solely to test or document an unavailable feature.

## Completion criteria

The maintainability work is complete when:

- Every emitted public error and capability comes from one canonical registry, and one executable generator produces every derived schema, JSON list, fixed-message file, and documentation table.
- Changed requests cannot reuse an idempotency key silently.
- Every in-memory and on-disk collection has an explicit bound and sweep policy.
- A failed lifecycle-release acknowledgement retains exact retry authority until release is durably acknowledged.
- A private-child or MCP crash reconstructs the exact runtime-generation lease and every stop-relevant restoration obligation without treating empty memory as proof of safety.
- Every public lifecycle operation has a finite response deadline and durable recovery outcome.
- No child can be terminated without exact identity, and no unpublished owned child is permanently unmanageable after a parent crash.
- Mailbox remains usable after a transient per-file deletion failure, and no orphan cleaner can race an active writer's valid publication.
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
