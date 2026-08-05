# Conditional follow-up plan: detached-camera dedicated hand-back

> **Conditional commit:** `feat(observer-runtime): enable qualified detached-camera hand-back`
>
> **Series position:** separate follow-up after the manager release. There is no
> detached implementation commit unless the live engine qualification proves a
> non-mutating activation and hand-back mechanism.

## Why this is not part of the manager series

The current MpTest player camera is intentionally detached from
`CameraManager`. The public API provides no select-current-camera-by-ID
operation, and destroying the observer is not proof that the detached
controller has republished its target. Manager hand-back evidence therefore
does not establish detached hand-back.

The manager feature must ship with
`CAMERA_DEDICATED_DETACHED_PROVEN=false` and detached runtimes current-only when
this gate is absent or failed. Do not retain same-slot state rewriting as a
fallback under the new non-mutation promise.

## Blocking qualification record

Before designing code, Commit 2's retained result must identify all of the
following on the actual detached runtime path:

- how the observer's distinct slot becomes current without losing the detached
  target;
- the exact normal controller event/tick that republishes the detached target;
- how target object identity and target ID are observed;
- whether the observer callback remains available to witness hand-back;
- how publication is proved before observer destruction;
- what happens if the detached target is replaced, deleted, or changes world;
- how cleanup proves the world did not remain on the observer slot.

Deletion while the observer is selected is characterization only, not an
acceptable production actuator. If no normal non-mutating mechanism is proven,
stop: there is no implementation commit.

## Scope if the gate passes

If the mechanism is concrete and fits the existing lease state machine, use one
atomic commit containing acquisition, publication, hand-back, destruction, and
cleanup. If it requires a new controller protocol or materially different
architecture, stop and write a new multi-commit plan from the retained evidence
instead of guessing here.

Expected files for the single-commit case:

- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverService.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapabilities.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCamera.c` only
  if the qualified witness requires it
- `observer/protocol/registry.ts` and generated
  `observer/protocol/capabilities.md` if proof wording expands
- `scripts/run-runtime-observer-acceptance.ts`
- `tests/observer/runtime-camera-restoration-contract.test.ts`
- `tests/observer/package-contract.test.ts`
- `tests/observer/runtime-live-acceptance-contract.test.ts`
- generated `observer/addon/.reforger-forge-observer-source.json`
- `observer/README.md` and `docs/observer.md` for the newly enabled mode

## Required implementation invariants

### Acquisition and publication

- Flip `CAMERA_DEDICATED_DETACHED_PROVEN` only in the commit backed by the
  retained passing result.
- Bind the exact detached target, target ID, world, and epoch before spawn.
- Give the observer the already qualified distinct index; never borrow the
  detached target's slot.
- Activate the observer only through the qualified mechanism.
- Prove requested observer publication from its distinct ID in POSTFRAME before
  screenshot issuance.
- Treat any partial activation as an outstanding restoration obligation.

### No target mutation

Never call any of the following on the detached target merely to force it to
publish:

- `SetWorldTransform()`;
- `SetVerticalFOV()`;
- `SetNearPlane()` or `SetFarPlane()`;
- `SetCameraIndex()`;
- `ApplyTransform()`.

All requested-view setters remain scoped to `RFO_ObserverCamera`.

### Hand-back and cleanup

Use only the controller behavior established by qualification:

1. stop observer capture-time publication;
2. request or await the normal detached-controller takeover;
3. keep the observer alive and armed;
4. prove exact detached target identity, target ID, world/epoch, and live world
   publication in POSTFRAME;
5. disarm the observer;
6. destroy it on a later update;
7. prove deletion/deregistration and continued detached publication before
   clearing the lease.

If the target cannot republish, remain nonterminal in contained restoration and
block managed runtime stop. Never fall back to mutating its old snapshot.

### Capability and admission

Advertise `camera.runtime` for detached mode only when its dedicated proof is
true and subsystem health is safe. Direct command admission must repeat that
gate. Manager support must remain unaffected if detached mode later becomes
unsafe.

## Tests

Extend hermetic contracts to prove:

- detached proof is separate from manager proof;
- false proof keeps the current-only behavior;
- true proof selects only the qualified dedicated route;
- no setter or `ApplyTransform()` targets the detached object;
- exact detached target publication precedes observer disarm/destruction;
- cleanup is proved before terminal state;
- partial activation and target loss retain an outstanding lease;
- manager behavior and Workbench behavior remain unchanged.

Run the complete live detached matrix on the actual MpTest path, including
movement, cancellation, timeout, target replacement, world change, repeated
cycles, and managed-stop refusal during a stalled hand-back.

## Generation and validation

Use `npm run observer:generate` if capability proof source changes; otherwise
use `npm run observer:manifest`. Include generated artifacts in the same
commit, then run:

```powershell
npx vitest run tests/observer/runtime-camera-restoration-contract.test.ts tests/observer/package-contract.test.ts tests/observer/runtime-live-acceptance-contract.test.ts tests/observer/capture-service.test.ts
npm run build
npm run protocol:check
npm run observer:manifest:check
npm run observer:validate:enforce -- --protocol-only --target runtime
npm test
```

## Commit acceptance

- A retained live result proves the exact non-mutating detached mechanism.
- Detached explicit capture uses the observer's distinct slot.
- Exact target hand-back and observer cleanup precede terminal status.
- Manager and Workbench behavior remain unchanged.
- If any prerequisite fails, this commit is omitted and current-only behavior
  is the completed outcome.
