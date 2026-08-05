# Commit 1 plan: resolve the active runtime view from the world slot

> **Execution constraint:** Do not launch Enfusion Workbench or the game client
> while carrying out this plan. If testing reaches a point that requires either,
> stop before launching it and wait for explicit confirmation that it is
> available for use.

> **Series overview:** [Step 0](2026-08-04-observer-dedicated-camera-00-series-overview.md).

> **Commit:** `fix(observer-runtime): resolve the camera publishing the active world slot`
>
> **Series position:** 1 of 7 required commits. This correction is independent
> of dedicated-camera feasibility and should land even if the later engine gate
> fails.
>
> **Audit basis:** repository HEAD `eab52f9d8085`, reviewed 2026-08-04.

## Why this is its own commit

The current resolver accepts a live `CameraManager.CurrentCamera()` before it
looks at `PlayerController.GetPlayerCamera()`. It then rejects that object if
its index differs from `BaseWorld.GetCurrentCameraId()`, without checking whether
another known camera actually matches the published slot. The same
manager-first assumption exists in current-view preload/evidence snapshots.

This is a source-backed bug independent of the proposed dedicated slot. Keeping
the fix separate gives it a small regression surface and prevents the later
feature commit from hiding a change in restore-target selection.

## Goal

Resolve the camera associated with the actual current world slot without
mutating camera state, and measure current-view captures from `BaseWorld`
rather than from a possibly stale manager object.

This commit deliberately retains the existing shared-slot acquisition and
state-restoration transaction.

## Files

- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapture.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraProjection.c`
  only if a shared projection-validation helper is needed
- `tests/observer/runtime-camera-restoration-contract.test.ts`
- `tests/observer/package-contract.test.ts`
- generated `observer/addon/.reforger-forge-observer-source.json`

## Implementation

### 1. Replace manager-first fallback with candidate resolution

Keep the resolver read-only. For the active `BaseWorld`:

1. Read `world.GetCurrentCameraId()` once and reject a negative ID.
2. Gather non-null, non-deleted candidates from:
   - `manager.CurrentCamera()`;
   - `PlayerController.GetPlayerCamera()`;
   - the editor camera accessor already used by
     `RFO_ObserverEditorCameraArbitration`;
   - `manager.GetCamerasList()`.
3. Deduplicate candidates by object identity before classifying them.
4. Retain only candidates whose `GetCameraIndex()` equals the captured world
   slot.
5. Record manager registration separately from slot matching. A matching ID is
   evidence, not proof of ownership; the current implementation itself can put
   two objects on one ID.
6. Select only an unambiguous eligible candidate. Fail closed when multiple
   distinct objects match or when the target's manager/detached classification
   is unsupported.

A non-null stale manager camera must not prevent a matching player camera from
being considered. Do not introduce a priority rule that merely recreates the
old bug in a different order.

Keep distinct diagnostics for at least:

- world/game unavailable or mismatched;
- no current slot;
- no live slot-matching object;
- ambiguous slot match;
- manager target not registered or lacking structural manager support;
- detached mode classification (a successful legacy classification in this
  commit, not an error by itself);
- outstanding lease.

Do not spawn, select, destroy, or configure a camera from the resolver.

### 2. Measure current-view preload and evidence from the world

Change `RFO_ObserverCapture.SnapshotCurrentCamera()` to accept the bound world
and return the camera ID together with the matrix/FOV from one
`RFO_ObserverCameraProjection.SnapshotCurrent()` call. Current-view preload and
evidence need the published values, not an object identity.

`BeginPreload()` must use that returned ID for `GetCameraFarPlane()`; it must
not snapshot matrix/FOV and then independently reread a potentially newer
`world.GetCurrentCameraId()`. Keep the existing finite-value checks and the
documented degree units for FOV.

### 3. Preserve the current transaction

This commit must not:

- introduce a dedicated index;
- change `SpawnObserverCamera()` index assignment;
- remove `ApplyOriginalState()`;
- change manager/detached restoration ordering;
- change capability advertisement, direct admission, or `RESOLVING`;
- change the GameMaster arbitration interlock.

## Tests

Rewrite the resolver-focused assertions in
`runtime-camera-restoration-contract.test.ts` to prove:

- all candidate sources are considered;
- manager non-nullness is not a terminal precedence decision;
- candidates are filtered by the captured world slot and deduplicated;
- ambiguity fails closed;
- the resolver contains no camera-changing operation;
- current-view snapshots use `RFO_ObserverCameraProjection.SnapshotCurrent()`;
- the legacy acquisition and restoration transaction remains present.

Update `package-contract.test.ts` only for assertions owned by these source
changes. Avoid pinning incidental whitespace or helper ordering.

## Validation

```powershell
npm run observer:manifest
npx vitest run tests/observer/runtime-camera-restoration-contract.test.ts tests/observer/package-contract.test.ts
npm run build
npm run observer:manifest:check
npm run observer:validate:enforce -- --protocol-only --target runtime
```

Run a current-view live smoke capture when a graphical runtime is available.
The smoke check should confirm that captured matrix/FOV metadata follows the
published view during a GameMaster-to-character transition.

## Commit acceptance

- All hermetic checks pass with the regenerated runtime manifest included.
- Current-view source no longer trusts a stale manager object.
- Explicit capture still uses the existing shared-slot transaction.
- No protocol, host, Workbench, or operator-documentation files change.
