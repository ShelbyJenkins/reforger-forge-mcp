# Commit 3 plan: model camera binding and restoration obligations explicitly

> **Commit:** `refactor(observer-runtime): model camera ownership and restoration obligations`
>
> **Series position:** 3 of 7 required commits. This is a behavior-preserving
> seam for the dedicated transaction plus a heartbeat bookkeeping fix. Public
> job-status wire semantics remain unchanged.

## Why this is its own commit

`RFO_ObserverCameraLease` currently overloads one camera ID for both the restore
target and observer. It also uses `IsHeld()` when building the heartbeat's
`cameraLeaseJobId`, even though `IsHeld()` becomes false during restoration
while `HasOutstandingLease()` remains true.

The public job status is different: `cameraLease.held=false` together with
`restorationConfirmed=false` is already a valid restoration obligation, and
host `JobStore`/runtime-stop logic understands it. This commit must not silently
redefine `held` to mean all cleanup work.

Separating these concepts before changing indices makes the safety-relevant
feature diff smaller and fixes the heartbeat without a protocol change.

## Goal

Represent, without changing the legacy shared-slot camera transaction:

- exact restore-target binding;
- observer identity and slot;
- current publication ownership;
- outstanding restoration/cleanup obligation;
- heartbeat ownership reporting.

## Files

- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverService.c`
- `tests/observer/runtime-camera-restoration-contract.test.ts`
- `tests/observer/package-contract.test.ts`
- generated `observer/addon/.reforger-forge-observer-source.json`

## Implementation

### 1. Split the binding

Replace the ambiguous `m_RFO_WorldCameraId` role with explicit fields for:

- restore-target object and camera ID;
- observer object and camera ID;
- bound world and epoch;
- manager-owned versus detached target mode.

For this commit's legacy transaction, initialize both IDs to the same shared
slot. `GetObserverCameraId()` must read the observer field so Commit 4 can make
the IDs distinct without changing capture evidence plumbing again.

No fallback matrix/FOV, state setter, or new hand-back behavior belongs in this
refactor.

### 2. Separate view state from obligation state

Keep read-only queries with single meanings:

- `HasOutstandingLease()` means restoration or observer cleanup is still owed;
- the active-view query means the observer is currently selected/publishing;
- `IsRestoring()` means hand-back has begun;
- `RestorationConfirmed()` means the full cleanup contract completed.

`IsHeld()` must remain read-only and retain its current active-view meaning.
Never hide `SetCamera()` or another mutation inside a status accessor.

### 3. Fix heartbeat obligation reporting without changing job JSON

Build heartbeat `cameraLeaseJobId` from `HasOutstandingLease()`, so a restoring
job remains named until hand-back and cleanup finish. Keep
`BuildStatusJson().cameraLease.held` tied to the current active-view meaning and
keep `restorationConfirmed` as the companion obligation signal.

Do not change the JSON shape, schema, backend mapping, or protocol wording. In
particular, do not require every `RESTORING` status to say `held=true`; the host
already treats `held=false` plus unconfirmed restoration as outstanding.

### 4. Preserve legacy behavior

The following must remain unchanged:

- shared observer/restore-target slot assignment;
- manager and detached selection behavior;
- original-camera state snapshot and rewrite;
- POSTFRAME restoration and deferred destruction order;
- GameMaster arbitration;
- capability probing and immediate `RESOLVING` refusal.

Commit 4 owns partial-acquisition disposition, maintenance outcomes, transient
diagnostics, and any change needed to make a spawned/selected observer an
explicit restoration obligation.

## Tests

Update source contracts to prove:

- restore-target and observer IDs are distinct fields;
- legacy initialization intentionally gives them the same value;
- `GetObserverCameraId()` reads the observer ID;
- `IsHeld()` and all status queries are non-mutating;
- heartbeat `cameraLeaseJobId` uses `HasOutstandingLease()`;
- public job `cameraLease.held` retains its current active-view meaning;
- `held=false` plus `restorationConfirmed=false` remains schema-valid and is
  treated as an outstanding restoration obligation by existing host tests;
- the existing POSTFRAME proof/destruction order remains unchanged;
- acquisition and maintenance behavior is unchanged.

## Validation

```powershell
npm run observer:manifest
npm run observer:manifest:check
npx vitest run tests/observer/runtime-camera-restoration-contract.test.ts tests/observer/package-contract.test.ts tests/observer/jobs.test.ts tests/observer/protocol.test.ts tests/observer/runtime-capture-backend.test.ts
npm run build
npm run observer:validate:enforce -- --protocol-only --target runtime
```

## Commit acceptance

- The legacy explicit-capture path behaves as before.
- Heartbeat continues naming the job while cleanup is outstanding.
- Public `cameraLease.held` semantics are unchanged.
- The runtime manifest is regenerated in this commit.
- No capability, protocol wording, host routing, Workbench, or documentation
  change is included.
