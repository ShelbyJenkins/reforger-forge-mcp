# Commit 9 plan: add fenced successor and relaunch recovery

> **Commit:** `feat(observer): add fenced game launch successors`
>
> **Series position:** deferred lifecycle follow-up.
>
> **Dependency:** [owned-only game_launch](2026-08-04-launch-ergonomics-07-owned-game-launch.md).
> Start only after the baseline has real usage evidence showing that deliberate
> same-profile relaunch is worth the durable-state cost.

## Why this is its own commit

Safe relaunch is not a small schema addition. It requires a crash-recoverable,
machine-fenced chain that can distinguish retry, successor, abandoned unstarted
work, and unknown outcomes across MCP processes. It has its own storage,
reconciliation, capacity, and rollback surface.

## Goal

Allow exactly one deliberate successor after an exact owned predecessor has been
stopped, restored, sealed, and revoked. Recover exact retries without double
prepare/spawn, and never turn missing evidence into permission to launch.

## Files

- src/tools/game-launch.ts
- src/tools/owned-runtime-operations.ts
- src/observer/owned-runtime-manager.ts
- tests/observer/game-launch.test.ts
- new tests/observer/game-launch-successor-recovery.test.ts
- existing owned-runtime manager reconciliation, mutex, persistence, retention,
  crash-characterization, restoration, and exit suites
- docs/observer.md
- observer/README.md
- agents/AGENTS.md

## Public contract

Add afterRuntimeId only to the strict start branch and the raw optional property
shape. It must use the exact runtime-ID schema from Commit 6. It is invalid for
status, stop, and the future script branch.

An initial launch omits afterRuntimeId. A successor supplies the concrete runtimeId
returned by the prior launch. Do not substitute a free integer generation or a
caller-defined idempotency key: neither proves profile identity, chain order,
terminal restoration, or recovery.

Return compositeAttemptId and chain state. Offer the next afterRuntimeId only after
stop has durably completed sealing/restoration/revocation, never merely when status
observes a natural process exit.

## Profile-keyed attempt index

Store the index by canonical profile identity, not world, argv, or runtime kind.
Changing launch details must not create a second initial family for the same
profile. Bind a versioned canonical attempt fingerprint from Commit 7's resolved
identity, explicitly including `worldEvidenceDigest`, `addonEvidenceDigest`, the
canonical executable path, and `executableEvidenceDigest`, while still excluding
waitForInstanceMs.

Use a crash-recoverable state machine:

    reserved -> prepared -> starting -> running -> terminal
         \          \
          +----------+-> abandoned
                           |
                           +-> reserved replacement

Each record binds, as it becomes known:

- schema version, delivery=owned, compositeAttemptId, canonical profile key, and
  fingerprint;
- the world/add-on/executable evidence schema versions and digests, plus an exact
  reference to the manager-stored original prepared evidence used for
  revalidation;
- predecessor runtime ID and prior chain-tip proof;
- private-child generation/manager authority;
- sessionId and preparedLaunchId;
- pending start and runtime receipt identity;
- terminal, restoration, sealing, and revocation evidence;
- timestamps/version needed for bounded recovery.

All transitions use the manager's existing machine mutex and atomic record store.
Reserve before private-child IPC. Bind prepared state before making it publicly
startable and bind starting/running identity at the same lifecycle boundaries used
by OwnedRuntimeManager.

Persist delivery=owned even though this commit supports only owned attempts, and
make unknown delivery/state versions fail closed. Commit 12 may add external
states through an explicit schema migration; it must not reinterpret an old record
by absence of a delivery field.

## Attempt-scoped idempotency

Do not reuse Commit 7's canonical-fields-only prepare key once the ledger exists.
Derive the private-child prepare key and manager start/record keys from a fixed
versioned serialization containing:

    delivery
    compositeAttemptId
    canonicalFingerprint

The canonical fingerprint still identifies equal launch intent, but
compositeAttemptId identifies the fenced generation. Exact retries recover the
same durable attempt ID and therefore the same keys. A successor or proven
abandoned replacement always receives a new attempt ID/key, even when every launch
field is identical; otherwise it could recover the predecessor's consumed or
revoked private-child prepare receipt. Freeze exact digest fixtures.

When first adopting a profile that has retained Commit 7 evidence but no ledger,
inspect its prepared-invalidation receipts as well as prepared/consumption/
pending/runtime/stop/restoration evidence under the mutex, then seed an
unambiguous owned chain state only after validating the retained snapshot and
executable evidence schemas/digests, or pin it for reconciliation. Never treat
absence of the new record alone as permission for a fresh initial launch.

## Admission rules

Atomically enforce:

- no-predecessor input creates the first attempt only;
- an exact retry recovers or joins that attempt; changed input conflicts;
- afterRuntimeId belongs to the same profile and is the current chain tip;
- the predecessor is exact-owned, terminal, restored, sealed, and revoked through
  stop;
- one predecessor authorizes one successor;
- an exact successor retry recovers the same successor; different input conflicts;
- any prepared, pending, live, or unknown attempt blocks another activation even
  after observer session TTL;
- concurrent retries join/wait on one reservation instead of both preparing.

Put terminal/index advancement in OwnedRuntimeManager stop completion. A
game_launch runtime stopped through observer_runtime stop must authorize the same
successor. A natural exit followed by status does not; the caller must run stop to
complete the contract.

## Abandonment and restart reconciliation

Abandon only after proving all of the following:

- no activation, pending start, or runtime receipt exists;
- no prepared descriptor was consumed;
- the known session was revoked or expired and its profile lease is gone;
- the relevant manager/private-child generation cannot still complete the
  mutation.

Unknown or lost outcomes stay pinned. A prior-manager prepared descriptor is stale
but not automatically abandoned: reconcile consumption/pending/runtime evidence,
then revoke or wait out the session before the fenced transition.

An abandoned attempt must not permanently brick the profile. Permit exactly one
atomic abandoned-to-reserved replacement with a new compositeAttemptId linked to
the tombstone. The first proven-unstarted replacement may use changed canonical
input; later retries are bound to its fingerprint, and a different concurrent
replacement conflicts.

Retain a bounded terminal chain-tip after larger runtime records are swept. Either
verify afterRuntimeId from that retained record or atomically retire the complete
index/evidence family so a later initial request is unambiguous. Never leave a
profile index pointing to swept proof.

## MCP idle-shutdown classification

Preserve a typed, read-only idle classification for the profile-attempt index.
If Commit 14 is already present, extend its provider in this commit; if Commit 14
lands later, it consumes this projection. The
`reserved`, unexpired or outcome-uncertain `prepared`, `starting`, and `running`
states; any pending index or manager mutation; a replacement-in-flight state; and
every unknown, corrupt, lost-outcome, or pinned state block automatic idle
shutdown for the exact host that owns the obligation. The projection must use
parsed state and exact host ownership, not record totals or age.

An expired `prepared` attempt may be nonblocking without mutation only when exact
read-only evidence proves it was never consumed, no start/replacement can still
publish, and its observer session, cleanup, and profile lease are already vacant.
Keep its index/evidence intact for later recovery; expiry by itself is not that
proof and the idle timer never transitions it to `abandoned`.

An `abandoned` attempt becomes nonblocking only after the full proven-unstarted
conditions above and its fenced terminal transition are durable. A retained
terminal chain tip is nonblocking only when exact stop/vacancy, restoration,
seal/release, session revoke/expiry, and profile-lease vacancy are complete. Its
durable retry/recovery evidence remains readable after the host exits; automatic
idle shutdown neither sweeps the tip nor advances, replaces, abandons, or retires
an attempt.

## Storage and recovery accounting

Add the record family everywhere OwnedRuntimeManager accounts for durable data:

- OWNED_RUNTIME_RECORD_DIRECTORIES;
- per-record and aggregate byte/count caps;
- start headroom reservation before prepare;
- no-link/canonical storage validation;
- corruption quarantine/fail-closed behavior;
- retention and sweep ordering;
- restart/shutdown reconciliation.

Reserve enough capacity before prepare/start that binding an index cannot fail
after the old lifecycle cluster has already consumed the available headroom.

## Tests

Exercise every transition and crash window:

- exact initial and successor retry, including lost responses;
- attempt-scoped key digest fixtures and an identical-input successor proving it
  cannot recover the predecessor's prepared session;
- concurrent join/wait and changed-input conflict;
- wrong profile, non-tip, non-owned, running, natural-exit-only, unsealed, or
  unrestored predecessor refusal;
- direct game_launch stop and observer_runtime stop advancing the same chain;
- one predecessor authorizing exactly one successor;
- failures before/after reserve, prepare, record, pending start, spawn publication,
  terminal receipt, restoration, revocation, and index update;
- stale prior-manager prepared reconciliation;
- unknown outcomes pinned;
- proven abandonment and exactly one fenced replacement;
- forward idle-readiness fixtures for every ledger state, including expired
  prepared state with and without the complete unconsumed/vacancy proof, a
  replacement in flight, and a retained terminal tip. If Commits 14/15 are
  already present, also run timer/host-exit integration; otherwise Commit 15 owns
  that later actor test;
- migration/adoption of retained Commit 7 evidence and fail-closed unknown schema
  versions/delivery values;
- corrupt, oversize, capacity-exhausted, linked, and partially written records;
- retention of the chain tip and atomic whole-family retirement;
- unchanged world/dependency/executable re-attestation on recovered attempts,
  using the original stored evidence;
- same visible world/roots/argv with changed snapshot bytes, and same canonical
  executable path with changed file identity, conflicting with an exact retry
  rather than recovering or spawning.

## Validation

    npx vitest run tests/observer/game-launch.test.ts tests/observer/game-launch-successor-recovery.test.ts tests/observer/owned-runtime-manager-reconciliation.test.ts tests/observer/owned-runtime-manager-mutex-fencing.test.ts tests/observer/owned-runtime-manager-descriptor-persistence.test.ts tests/observer/owned-runtime-spawn-crash-characterization.test.ts
    npm run test:cross-cutting:baseline
    npm run test
    npm run typecheck
    npm run build

Repeat the live Commit 7 start/capture/stop gate, then use its exact stopped
runtimeId for one successor start/capture/stop. Verify an old/non-tip ID and a
second successor both refuse without spawning.

## Commit acceptance

- afterRuntimeId is a proof-bearing predecessor, not an idempotency token.
- One profile has one unambiguous chain tip across concurrent MCP processes.
- Exact retries recover; unknown outcomes never become launch permission.
- Both stop surfaces advance the same durable chain.
- Successor and replacement state extends the MCP idle-readiness proof without
  making the timer a lifecycle-transition actor.
- No external-script marker, process enumeration, PowerShell output, or Workbench
  preview is introduced.
