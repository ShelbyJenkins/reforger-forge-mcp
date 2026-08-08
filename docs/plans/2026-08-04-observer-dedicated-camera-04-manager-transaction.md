# Commit 4 plan: implement the manager-owned dedicated-camera transaction

> **Commit:** `feat(observer-runtime): use a dedicated slot for manager-owned explicit capture`
>
> **Series position:** 4 of 7 required commits. This commit is blocked until
> Commit 2's manager qualification table is complete and passing.
>
> **Atomicity rule:** acquisition, POSTFRAME publication, hand-back, observer
> destruction, and cleanup proof are one safety transaction. Do not split them
> into separate commits.
>
> **Release rule:** Commit 4 enables the manager proof after its own controlled
> positive acceptance, but the feature series is not release-complete until
> required Commits 6, 7, and 8 also land. Do not release or merge only the
> partial Commit 4–7 stack.

## Goal

For a live registered manager-owned restore target, capture an explicit
`pose`/`lookAt` view through an observer-owned camera index without mutating the
restore target, then prove camera hand-back and observer cleanup before the job
becomes terminal.

This commit enables only the qualified manager path. Detached runtimes remain
current-only under a separate false proof flag.

## Preconditions from live qualification

Copy the following observed values into the implementation review description:

- engine build and retained qualification artifact identity;
- engine-assigned versus reserved-index mechanism;
- exact reserved constant, if used;
- known vanilla/PIP index range observed by the fixture;
- registration and `SetCamera()` behavior;
- POSTFRAME publication ordering and moving-target comparison tolerance;
- same-pose render-parity tolerance and results;
- manager hand-back and observer cleanup result;
- conservative different-camera takeover result.

If any manager result is missing or failed, stop. Do not invent an allocator,
guess an index, or weaken image parity to proceed.

## Files

- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverService.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapabilities.c`
- `observer/protocol/registry.ts`
- generated `observer/protocol/capabilities.md`
- `scripts/run-runtime-observer-acceptance.ts`
- `tests/observer/runtime-camera-restoration-contract.test.ts`
- `tests/observer/package-contract.test.ts`
- `tests/observer/runtime-live-acceptance-contract.test.ts`
- `tests/observer/jobs.test.ts`
- `tests/observer/runtime-capture-backend.test.ts`
- generated `observer/addon/.reforger-forge-observer-source.json`

Include `RFO_ObserverEditorCameraArbitration.c`, `RFO_ObserverCamera.c`, or
`RFO_ObserverCameraProjection.c` only when the recorded qualification produces
a concrete required change. Otherwise preserve them byte-for-byte.

## Implementation

### 1. Gate manager and detached modes independently

Replace the single restoration proof with explicit attestations such as:

- `CAMERA_DEDICATED_MANAGER_PROVEN = true`, backed by Commit 2 evidence;
- `CAMERA_DEDICATED_DETACHED_PROVEN = false`.

Do not infer one mode from the other. A manager-owned explicit request must use
the dedicated route when its proof is enabled; it must never fall back to the
legacy same-slot borrowing path. A detached explicit request must be refused
and continue to support current-view capture.

Until Commit 6 replaces momentary admission, keep the existing `CanAcquire()`
call sites but make the probe mode-aware: it may return ready only for the
qualified manager route and must return a specific unproven-detached reason for
the detached route. Direct admission and capability generation therefore
cannot reach legacy detached borrowing in this intermediate commit. Commit 6
owns removing the remaining owner/slot-sensitive refusal and heartbeat flap.

Keep `RENDER_CAPTURE_PROVEN` independent. Do not change the generic
`CAPABILITY_UNAVAILABLE` message.

### 2. Bind the exact restore target before spawn

Use Commit 1's slot-aware resolution to bind:

- exact target object and camera ID;
- manager identity and registration;
- world and epoch.

Capture this binding before spawn because the qualification may show that
spawn can affect manager selection. A matching integer alone is not a binding.

### 3. Spawn and configure only the observer

Spawn `RFO_ObserverCamera` with the requested transform, then assign its index
only through the mechanism proved in Commit 2:

- retain a qualified engine-assigned index; or
- apply the one qualified reserved constant.

Never calculate a free ID from `GetCamerasList()`. Before selection, reject an
invalid index or any collision with the restore target, current world ID, or
another observed live candidate. The one-active-job/one-observer invariant is
still required even with a reserved constant.

Store observer-owned near/far values separately from restore-target state. Copy
readable target values only when Commit 2 qualified them for the new slot;
otherwise use the exact qualified observer defaults/current-far-plane rule from
the retained result. Configure only the observer's transform, FOV, near plane,
and far plane. Configure other per-slot behavior only when the API and live
evidence provide a supported value. Do not pretend write-only post-process,
camera type, lens-flare, or near-plane state can be copied or read back. The
Commit 2 pixel gate is the evidence for acceptable defaults.

Every camera-state setter and `ApplyTransform()` in the manager-dedicated path
must be statically typed to `RFO_ObserverCamera`.

### 4. Select and prove publication in stages

Require:

- observer object is live and registered;
- restore target is still live, registered, and current;
- `manager.SetCamera(observer)` returns true;
- `manager.CurrentCamera() == observer` synchronously.

Create a stable lease ID and schema-valid observer identity before any operation
that can select or publish the observer. If spawn yields an invalid/colliding
index, return `NO_OBLIGATION` only after synchronous deletion/deregistration is
proved; otherwise record `RESTORATION_REQUIRED` with that identity.

Use mutation-disposition outcomes such as `NO_OBLIGATION`,
`PUBLICATION_PENDING`, and `RESTORATION_REQUIRED`, each carrying a concrete
reason. Commit 6 alone decides whether a `NO_OBLIGATION` reason is transient or
fatal.

Do not require immediate world-ID equality. Record an outstanding lease as soon
as selection may have occurred, arm the observer, and let the existing
`POSITIONING`/POSTFRAME boundary prove:

- the world/epoch is unchanged;
- `world.GetCurrentCameraId()` equals the distinct observer ID;
- manager current is the exact observer;
- the requested matrix/FOV is the published world view;
- evidence metadata uses `GetObserverCameraId()` and that distinct ID.

Any failure after possible selection must either prove an exact synchronous
rollback or enter restoration. It may not return a no-lease result while an
observer could remain selected or registered.

### 5. Use conservative ownership-loss behavior

This commit supports `HELD` and `LOST`. It does not blindly reselect the
observer after a different camera appears.

- Normal movement of the same restore target is not ownership loss.
- The existing GameMaster arbitration interlock remains active because it
  suppresses manager-selection contention, not slot sharing.
- If a genuinely different legitimate user camera wins, stop capture-time
  publication and preserve a failed-capture result. Keep the original restore
  binding immutable; record the exact winner separately as a relinquishment
  target and prove that it remains manager current and published through its
  own slot before observer cleanup.
- If ownership is ambiguous, remain fail-closed and nonterminal while safe
  hand-back is owed.

Only the optional Commit 5 may add qualified same-target reselection.

### 6. Restore before destroying the witness

For the normal manager target:

1. stop capture-time publication/reselection;
2. verify the exact target remains live and registered;
3. call `manager.SetCamera(target)` and check its boolean result and exact
   synchronous identity;
4. keep the observer alive and armed;
5. in observer POSTFRAME, verify bound world/epoch, target identity and
   registration, target camera ID, current world ID, and the target's live
   publication using the qualified same-frame/tolerance rule;
6. mark hand-back witnessed and disarm the observer;
7. on a later `Update`, revalidate the binding and destroy the observer;
8. on the following cleanup check, prove deletion/deregistration and continued
   target publication, then `Clear(true)`.

Compare with the target's live transform/FOV at proof time, not its pre-capture
snapshot. This permits legitimate controller motion. Do not call
`ApplyOriginalState()`, target setters, or target `ApplyTransform()` on the
manager-dedicated path.

For the conservative takeover path, run the same witness and cleanup ordering
against the separately recorded relinquishment target without rewriting the
original restore binding. Define public `restorationConfirmed=true` here as
"the camera obligation was safely restored to the bound target or relinquished
to a qualified legitimate winner, and observer cleanup completed." The capture
itself remains failed when a takeover interrupted it.

Adapt `RetireOldWorldObserver()` rather than deleting it. A world transition
must retire the old-world observer without claiming success and must preserve
the original `WORLD_CHANGED` failure.

Fix camera-subsystem health as part of this transaction: the ordinary first
`Restore()` return of false while POSTFRAME proof is pending is healthy staged
restoration and must not set `m_RFO_CameraSubsystemSafe=false`. Mark it unsafe
only for a concrete unresolved selection, publication, cleanup, or retirement
failure.

### 7. Contain stalled hand-back without terminalizing

If hand-back stalls:

- keep the observer alive as the cleanup witness;
- maintain its last proven observer-owned view only while it still controls the
  published slot; never reselect it over a proven non-observer winner merely for
  containment;
- keep the outstanding lease visible through the heartbeat job ID, nonterminal
  state, and unconfirmed-restoration fields without redefining public `held`;
- set camera subsystem health unsafe only for a real unresolved safety fault;
- keep the job in `RESTORING`;
- refuse managed runtime stop while the obligation remains.

Containment is not restoration. Do not emit success or terminal
`RESTORATION_UNCONFIRMED` while observer influence remains.

## Protocol and host behavior

Update only the `camera.runtime` proof in `observer/protocol/registry.ts` to
describe an observer-owned camera with qualified manager selection, distinct
slot publication, and proven hand-back. Regenerate `capabilities.md`. No
protocol-version bump or schema change is required.

Do not change `src/observer/capture-service.ts` or
`src/workbench/observer-adapter.ts`. Existing host selection remains correct
when the runtime advertises the capability. Keep host tests that refuse a
genuinely missing capability.

## Expected intermediate state

This commit intentionally still uses the old momentary `CanAcquire()` surfaces
for manager-mode capability, command admission, and `RESOLVING`. As a result,
`camera.runtime` can still disappear during an active lease or a transient
owner/slot transition. That limitation is safe but incomplete and is removed
by Commit 6. Do not fold speculative retry policy into this transaction merely
to hide the temporary behavior between commits.

## Hermetic tests

Rewrite the primary restoration contract to prove:

- manager and detached proof flags are separate;
- the observer ID never comes from the restore-target ID;
- the qualified assignment mechanism and collision checks are present;
- observer registration and the `SetCamera()` boolean are checked;
- first world publication remains a POSTFRAME proof;
- all manager-path setters target `RFO_ObserverCamera`;
- exact target/world/epoch/slot binding is retained;
- target selection precedes POSTFRAME proof;
- observer disarm follows proof, destruction occurs in a later update, and
  deletion/deregistration precedes `Clear(true)`;
- partial acquisition creates a restoration obligation;
- an ordinary pending POSTFRAME restoration does not poison subsystem health;
- qualified relinquishment reports `restorationConfirmed=true` only after
  cleanup while preserving the failed capture result;
- old-world retirement and original-error preservation remain;
- detached explicit capture is unavailable and cannot reach same-slot
  borrowing.

Scope negative setter assertions to the enabled manager path. The legacy
detached helpers remain until the separate detached decision; their presence
must not make them reachable under the manager proof.

Update the live runner and its source contract in this commit so manager
acceptance records target/observer identities and distinct IDs. Replace frozen
pre/post FOV equality with live publication and displacement checks. Preserve
pixel similarity as diagnostic because a live target may move.

## Generation and validation

Run generation once after both runtime and protocol source changes:

```powershell
npm run observer:generate
npm run protocol:check
npm run observer:manifest:check
npm run typecheck
npm run build
npm run observer:validate:enforce -- --protocol-only --target runtime
npx vitest run tests/observer/runtime-camera-restoration-contract.test.ts tests/observer/package-contract.test.ts tests/observer/runtime-live-acceptance-contract.test.ts tests/observer/jobs.test.ts tests/observer/runtime-capture-backend.test.ts tests/observer/capture-service.test.ts
```

Do not run `observer:manifest` again after `observer:generate`. Do not hand-edit
generated build identities.

Start generation only from a clean, internally consistent generated baseline.
If `observer:generate` exposes pre-existing stale Workbench helper identity or
payload state, stop and resolve that separately rather than absorbing it here.
From a clean baseline, verify that Workbench helper source, its
manifest/build file, `src/workbench/helper-addon.ts`, its payload, the adapter,
and Workbench tests remain byte-for-byte unchanged.

## Controlled acceptance

From the clean candidate commit, run the existing positive manager-owned pose,
look-at, cancellation, and repeated cleanup procedure:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:runtime -- --config <CONFIG_PATH> --confirm-live-run
```

Do not keep this commit if manager hand-back, render parity, or leak-free
cleanup fails. Fix and amend the transaction before proceeding.

Where the Commit 2 fixture already exposes an applicable production-path
active-PIP check, rerun it here and record the result; otherwise mark active PIP
as an attended release condition for Commit 7. Deliberate takeover, target
replacement, world transition, transport loss, and stalled hand-back require
the native actions added by Commit 7 and are not claimed by the generic command
above.

## Commit acceptance

- Manager-owned explicit capture uses a distinct qualified slot.
- No non-observer camera is mutated on the enabled manager path.
- Success and failure both prove hand-back and cleanup before terminal state.
- Detached runtimes remain accurately current-only.
- Source contracts, generated artifacts, build, Enforce validation, and the
  controlled manager acceptance all pass.
