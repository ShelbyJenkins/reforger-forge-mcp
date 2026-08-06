# Commit 14 plan: add host-scoped idle readiness fencing

> **Commit:** `refactor(mcp): add host-scoped idle readiness fencing`
>
> **Series position:** non-acting safety foundation for Commit 15.
>
> **Dependency:** [operator-visible MCP host identity](2026-08-04-launch-ergonomics-13-mcp-host-identity.md).
> Commits 7, 9, and 12 extend the blocker projection when their feature-specific
> lifecycle states are present; they are not prerequisites for this foundation.
>
> **Source backlog:** first half of MCP-055. Commits 14 and 15 jointly own the
> removed queue entry; planning is not resolution.

## Why this is its own commit

The audited implementation needs substantially more than a timer: trusted
durable-record attribution, noncreating LMDB readers, pure provider snapshots,
revision fencing, and a process-wide admission gate. Those changes are coherent,
testable, and safe to land with the gate permanently open. This commit adds no
configuration key, protocol activity decorator, idle timer, diagnostic timer
state, protocol close, signal, or process exit.

Commit 15 is the sole production actor. Reverting it leaves this commit as
rollback-compatible attribution and read-only lifecycle infrastructure with no
automatic shutdown behavior.

## Goal

Provide a bounded, read-only proof that the exact MCP host identified by Commit 13
has no lifecycle obligation that an idle exit would abandon. Make every host-local
admission revisioned and synchronously sealable, while keeping the production gate
open until Commit 15 supplies a validated protocol/activity transaction.

The proof is conservative. Unknown ownership, malformed evidence, incomplete
inventory, timeout, or a race is a blocker. It never stops a process, revokes a
session, advances a state machine, performs retention, or treats age as ownership.

## Current-code constraints

- `registerTools` returns a disposer but no read-only lifecycle projection.
  `ObserverApplication.closeRuntimeLifecycle`, `CaptureService.quiesce`, and
  `OwnedRuntimeManager.close` mutate or seal state and are invalid probes.
- The disposer closes owner-scoped target-build work, observer lifecycle, and the
  Workbench LMDB handle. It neither checks nor closes a running owned Workbench.
- Workbench, capture, observer-child, owned-runtime, and feature-specific work is
  admitted by separate objects, including background/recovery callbacks.
- Current Workbench durable readers and owned-runtime lazy accessors can create
  state/environment/archive paths while reading.
- Workbench spawn-journal v3 has no host UUID. Its LMDB envelope accepts exactly
  the v3 schema, so an envelope-v4 migration would strand retained journals.
- `ObserverAgentClient` can temporarily retain an old child in `liveChildren`
  while a replacement is current; checking only `this.child` is insufficient.

## Files

- new `src/mcp-host-admission.ts`
- new `src/mcp-idle-readiness.ts`
- `src/server.ts`
- `src/workbench/activity-gate.ts`
- `src/workbench/session-controller.ts`
- `src/workbench/process-guard.ts`
- `src/workbench/lifecycle-execution.ts`
- `src/observer/application.ts`
- `src/observer/agent-client.ts`
- `src/observer/capture-service.ts`
- `src/observer/owned-runtime-manager.ts`
- `src/foundation/child-supervisor.ts`
- `src/foundation/lmdb-store.ts`
- `src/foundation/lmdb-cas-store.ts`
- `src/foundation/lmdb-record-store.ts`
- Commit 7/9/12 state owners when those commits are present
- `docs/observer.md` and `agents/AGENTS.md` for the lifecycle/readiness contract
- new `tests/mcp-host-admission.test.ts`
- new `tests/mcp-idle-readiness.test.ts`
- `tests/foundation/lmdb-store.test.ts`
- `tests/foundation/lmdb-cas-store.test.ts`
- `tests/foundation/lmdb-record-store.test.ts`
- `tests/workbench/activity-gate.test.ts`
- `tests/workbench/child-supervisor.test.ts`
- `tests/workbench/process-guard.test.ts`
- `tests/workbench/server-composition.test.ts`
- `tests/workbench/workbench-session-controller.test.ts`
- `tests/observer/agent-client.test.ts`
- `tests/observer/capture-service.test.ts`
- `tests/observer/application-shutdown.test.ts`
- owned-runtime manager lifecycle/recovery tests
- `tests/workbench/server-disposer.test.ts`
- `scripts/check-package.mjs`
- `package.json` for enduring stage-4 coverage

Add `dist/mcp-host-admission.js` and `dist/mcp-idle-readiness.js` to
`scripts/check-package.mjs`'s explicit `requiredFiles` inventory.
`package.json.files` already includes all of `dist`.

## Trusted durable ownership

Use Commit 13's one frozen `McpHostIdentity.instanceId` as the production
Workbench process-guard MCP UUID and owned-runtime manager UUID. Thread that same
trusted object through `RegisterToolsOptions` and the provider composition; never
accept an origin UUID from tool input.

Keep the existing `workbench-spawn-journal-v3` domain and LMDB envelope. Add an
optional `originMcpInstanceId` metadata field to new journal writes, populated by
the process guard, and validate a present value as a UUID. The current v3 parser
preserves extra metadata, so old code can still read new records. Absence means a
legacy/unattributable unresolved journal and blocks readiness; an unequal valid
UUID identifies foreign evidence and is skipped. Do not infer ownership from a
PID, lifecycle generation, target path, timestamp, or apparent host liveness.

Test new-reader/old-record and old-reader/new-record compatibility plus rollback.
Do not rewrite a legacy record merely to make it attributable, and do not add a
durable MCP-host liveness registry.

## Existing-only durable inspection

Add explicit existing-only inspection APIs to the LMDB store layers. An absent
root, Workbench environment, or `state/owned-runtimes-v1` directory is exact
absence without creating or opening it. For an existing environment, reuse its
already-open handle when possible; otherwise open and close a temporary
noncreating `readOnly` handle.

The idle path must not call the current creating
`WorkbenchProcessGuard.durableEnv()`, `OwnedRuntimeManager.ensureStorage()`, or
`recordStore()` accessors. A corrupt record is reported as indeterminate without
creating a corrupt-evidence directory. The reader creates no managed/state/
environment/archive path and changes no logical record or `data.mdb` content or
mtime. Access-time changes and LMDB's ephemeral `lock.mdb` reader-slot metadata
are not logical storage mutations. Keep ordinary writer/quarantine behavior
unchanged.

## Pure readiness contract

Extend `RegisteredToolsDisposer` with a bounded method such as:

```ts
inspectIdleShutdownReadiness(options: {
  readonly deadlineTick: number;
  readonly signal: AbortSignal;
  readonly probeGeneration: number;
}): Promise<IdleShutdownReadiness>;
```

`IdleShutdownReadiness` contains `complete`, a bounded sorted set of fixed blocker
codes, and opaque provider revisions used only for same-process revalidation. It
contains no PIDs, paths, runtime/session/request IDs, owner tokens, or raw error
text. Use categories for Workbench activity/ownership/recovery, observer child and
capture/restoration work, owned-runtime preparation/start/live/recovery, external
activation, and incomplete proof.

Use one shared five-second monotonic deadline and `AbortSignal`. A logical timeout
invalidates that probe generation. Every provider honors the common bound when
its backend supports cancellation. If a physical scan cannot be cancelled, retain
its promise internally, discard its late result, and make later inspections
coalesce behind or report incomplete for that same physical probe until it
settles. Do not expose the promise through `IdleShutdownReadiness`, and never
accumulate overlapping `Promise.race` losers.

The inspection is read-only. It does not create storage, lazily start the search
index or observer child, acquire a lifecycle mutation lease, seal admissions,
cancel ordinary work, revoke a session, sweep evidence, archive corruption,
retire a record, or perform retention.

Each provider captures its revision after its own inspection settles. State that
can change without a protocol request increments its revision before admission or
publication. Commit 15 captures the protocol epoch before the aggregate proof and
revalidates these returned revisions at its synchronous seal; do not snapshot an
agent revision before a probe-owned child RPC changes it.

## Provider classification

- `WorkbenchActivityGate` reports managed actions, lifecycle waiters/active
  writer, capture leases, exact-owner-exit seals, and a revision.
  `WorkbenchSessionController` adds active lifecycle/target-build work,
  child-supervisor activity and recovery, attributed spawn-journal state, and the
  exact host-owned Workbench. A running owned Workbench or unprovable vacancy
  blocks. Valid unowned/foreign evidence is never stopped or mutated.
- `CaptureService` reports admissions, active operations, nonterminal jobs, camera
  leases, and restoration obligations. Completed evidence with no cleanup duty is
  nonblocking. Do not call `quiesce`.
- `ObserverAgentClient` reports startup/closing, unrelated pending requests, and
  exact `liveChildren`. A ready idle private child is nonblocking only when it is
  the sole live/current child. Extra or noncurrent children block until exact
  exit. Parent capture/manager records, not the shared child session total, remain
  authoritative for detached work. A Commit 12 exact profile-lease query is
  allowed only for its host-bound marker proof; capture the provider revision
  after that RPC settles and exclude only that already-settled probe request.
- `OwnedRuntimeManager` uses existing-only inventory for records attributed to
  its exact host UUID. Unexpired preparation; consumed/pending/recovery state;
  live runtime; stop/restoration/release work; or uncertain cleanup blocks. An
  expired, provably unconsumed preparation with complete session, cleanup, and
  profile vacancy is nonblocking without a sweep. Exact release-acknowledged or
  terminal vacancy/restoration evidence may remain retained. Foreign records are
  skipped; malformed, unlinked, or unattributable records are indeterminate.
- Commits 7, 9, and 12 own their additional typed classifications. In particular,
  successor `prepared` is nonblocking only after its complete unconsumed/vacancy
  proof, and a current-host unresolved external marker blocks until its fenced
  `external_retired` transition. A valid unequal origin is nonblocking for this
  host's exit and never mutated, while an unattributable origin blocks. This
  host-local projection does not weaken Commit 12's global shared-uninstall
  refusal. The reader never performs those transitions.

## Process-local admission gate

Create one default-open `McpHostAdmissionGate` at the composition root and pass it
to every Workbench, observer, capture/restoration, owned-runtime, child-recovery,
and feature-specific path that can begin host-local work. Ordinary and
background/retry work acquires a token synchronously before publication, which
increments the revision. Hold the token through the full asynchronous operation
or recovery callback and release it only in `finally`. Work intentionally
detached from a parent must acquire its own token or publish a provider blocker
before the parent releases.

Shutdown cleanup uses an internal close capability instead of ordinary admission.
Expose a synchronous, single-use, nonthrowing operation such as
`trySealIdleAdmissions(proof)`. It first validates zero gate tokens and every
provider revision, then seals and consumes the proof in the same JavaScript turn.
A failed check leaves the gate open. This commit never calls the method in
production; only unit tests exercise it. Commit 15 composes the nonthrowing host
seal with its protocol epoch/count check and nonthrowing transport seal.

The current disposer remains the observer/owned-runtime close authority but not a
Workbench safety check. A complete proof plus the sealed host-admission gate is
therefore required before Commit 15 can exit; neither commit gains authority to
signal Workbench, a game process, another MCP, or foreign evidence.

## Tests

Cover:

- gate token acquisition/release/revision, admission races, one-use proof,
  failed-seal transparency, privileged cleanup, full async `finally` lifetime,
  and detached-token transfer;
- Workbench current/foreign/legacy/corrupt v3 journal attribution and exact
  owned-live/vacant state;
- absent, valid, and corrupt existing-only reads with no new path or logical/data
  mutation, including already-open and temporary read-only LMDB handles;
- Workbench reader/writer/capture/seal, active build, child reconciliation, and
  recovery states;
- observer starting/pending/sole-ready/extra-child states, capture/camera/
  restoration duties, completed evidence, and no lazy child startup;
- unexpired preparation, expired proven-unconsumed preparation, pending/live/
  restoring/releasing clusters, terminal evidence, foreign records, corrupt
  inventory, capacity, and deadline failures;
- every Commit 7/9/12 classification when present;
- probe-owned versus unrelated child RPCs, provider revision changes, monotonic
  timeout/abort, late-result invalidation, and no overlapping physical probes;
  and
- source/architecture coverage proving all host-local admission paths use the
  shared gate.

## Validation

```powershell
npx vitest run tests/mcp-host-admission.test.ts tests/mcp-idle-readiness.test.ts tests/foundation/lmdb-store.test.ts tests/foundation/lmdb-cas-store.test.ts tests/foundation/lmdb-record-store.test.ts tests/workbench/activity-gate.test.ts tests/workbench/child-supervisor.test.ts tests/workbench/process-guard.test.ts tests/workbench/server-composition.test.ts tests/workbench/workbench-session-controller.test.ts tests/workbench/server-disposer.test.ts tests/observer/agent-client.test.ts tests/observer/capture-service.test.ts tests/observer/application-shutdown.test.ts
npm run test:stage3
npm run test:stage4
npm run test:cross-cutting:baseline
npm run test
npm run test:package
npm run typecheck
npm run build
```

## Commit acceptance

- The commit builds and passes with no configuration key, timer, transport close,
  signal, or automatic process-exit path.
- Durable ownership is exact and rollback-compatible; unresolved legacy or
  malformed evidence fails closed.
- Readiness is bounded, host-scoped, noncreating, logically read-only, and never
  overlaps a prior unsettled physical probe.
- Every host-local admission and background continuation remains visible through
  its full lifetime and can be synchronously revision-checked and sealed.
- Expired/terminal evidence becomes nonblocking only through complete semantic
  proof, never age or record totals.
- No new cross-host registry, cleanup actor, PID-only authority, or public MCP tool
  is introduced.
