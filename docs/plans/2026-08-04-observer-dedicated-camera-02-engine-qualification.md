# Commit 2 plan: add a dedicated-camera engine qualification harness

> **Commit:** `test(observer): add inert runtime camera-slot qualification`
>
> **Series position:** 2 of 7 required commits, followed by a non-code manager
> go/no-go decision. Commit 4 is blocked until that decision passes.
>
> **Audit basis:** repository HEAD `eab52f9d8085`, public Reforger/Enfusion
> camera APIs, and the vanilla picture-in-picture camera precedent.

## Why this is its own commit

The public APIs expose camera indices and selection, but no allocator,
reservation call, registration call, or select-by-integer operation. Vanilla
picture-in-picture cameras use an authored index. Several important per-slot
render properties are write-only, so source inspection cannot establish that a
fresh slot renders the same image as the user's slot.

These are engine facts, not implementation details. A default-inert live
harness must establish them before production code claims a dedicated slot.
Keeping that harness separate prevents experimental camera changes and logging
from entering the production addon.

## Goal

Create a repeatable, opt-in characterization that establishes:

- the usable index mechanism: engine-assigned or one explicitly qualified
  reserved constant;
- registration, selection, and POSTFRAME publication ordering;
- render parity for a second slot;
- exact manager-owned hand-back;
- the observed detached-camera behavior, without making it a manager-release
  dependency.

This commit changes no production capability or camera behavior.

## Files

- create `tests/fixtures/runtime-observer-camera-qualification-addon/addon.gproj`
- create
  `tests/fixtures/runtime-observer-camera-qualification-addon/Scripts/Game/ReforgerForgeObserver/RFO_RuntimeCameraQualification.c`
- create `scripts/run-runtime-observer-camera-qualification.ts`
- modify `scripts/observer-runtime-launch-support.ts` only for reusable,
  launcher-neutral helpers
- modify `package.json` with a dedicated development command
- create `tests/observer/runtime-camera-qualification-contract.test.ts`
- modify `tests/observer/live-acceptance-ci-isolation.test.ts`
- modify `tests/observer/runtime-live-acceptance-contract.test.ts` only if it
  owns shared authorization/lifecycle assertions

Do not modify the production Observer addon or its source manifest.

## Safety and authorization

The fixture must be inert unless all of these bind the same run:

- a dedicated environment opt-in, for example
  `RFO_RUN_LIVE_RUNTIME_CAMERA_QUALIFICATION=1`;
- `--confirm-live-run`;
- a per-run unguessable control capability;
- exact owned-runtime lifecycle and generation identifiers;
- a private generated profile/control root;
- the exact qualification addon identity.

Reuse `OwnedRuntimeManager`, the existing vacancy checks, source-revision
attestation, external artifact-root rules, and bounded cleanup. Do not add a
direct process-kill path. Every camera-changing probe must capture a restore
binding first and prove hand-back before the next probe.

## Qualification protocol

Emit bounded structured records rather than unconditional `Print` output. Each
record should include the probe name, world/epoch, frame/tick, object-role
identity, camera index, manager registration/current identity, world current
ID, operation result, and cleanup result. Use fixture-local opaque identities;
do not expand the public Observer job schema for this experiment.

### 1. Baseline inventory

Record before mutation:

- `world.GetCurrentCameraId()`;
- manager current and full manager list;
- player and editor camera identities;
- every candidate index and registration classification;
- current world matrix, FOV, and readable per-slot properties.

Run this in manager-owned GameMaster/editor mode, a manager-owned character
mode when available, and the detached MpTest player-camera mode.

### 2. Index mechanism and collision behavior

First spawn two observers without assigning an index. Record whether spawn:

- assigns valid distinct indices;
- registers either camera;
- selects either camera;
- changes the world slot.

If spawn does not supply usable unique IDs, qualify a caller-supplied candidate
reserved index. Never derive it by scanning for the lowest unused manager ID.
Exercise the candidate while a vanilla PIP optic is actively rendering and
record every observed native/PIP index. Verify repeated create/delete cycles
and the one-observer-per-world invariant.

The result must identify the exact mechanism and, for a reserved mechanism, the
exact constant. Record the residual collision risk from third-party mods.

### 3. Selection and publication

For a registered observer with the candidate distinct index:

1. check the boolean returned by `manager.SetCamera(observer)`;
2. record synchronous manager identity and immediate world ID;
3. apply a known transform/FOV to the observer;
4. record the next POSTFRAME world ID, matrix, and FOV;
5. measure whether the observer callback continues while temporarily
   deselected.

Do not require synchronous world-ID equality if the engine publishes in
POSTFRAME.

### 4. Render parity

Capture the user's slot and candidate observer slot at the same deterministic
pose. Reuse `comparePngImages` and record its complete diagnostic. Test scenes
that expose write-only per-slot differences:

- daylight and interior exposure transitions;
- HDR/EV-sensitive lighting;
- rain or underwater post-process;
- ocean in view;
- a sun angle that produces lens flare;
- PIP optic active.

Also verify projection, far-plane preload behavior, and absence of black or
default-only frames. Define and record a tolerance before declaring the gate
passed; do not invent read-back checks for near plane, camera type,
post-process, or lens-flare state where the API has no getter.

### 5. Hand-back and cleanup

For manager-owned targets:

- select the exact live registered target;
- keep the observer alive and armed as the POSTFRAME witness;
- prove target identity, target slot, and live publication;
- disarm and delete the observer later;
- prove deregistration/deletion and continued target publication.

For detached targets, first test normal controller takeover and publish a
non-observer slot before deletion. Test deletion while the observer is still
selected only in a disposable recovery probe. Never treat deletion as the
production hand-back actuator. That destructive probe has its own terminal:
either prove non-observer publication and cleanup, or prove exact owned-process
vacancy and relaunch before any later probe. It is exempt from the ordinary
same-process hand-back precondition only because the process is disposable.

Also characterize GameMaster self-reselection separately from a deliberate
different-camera takeover, target replacement, and world transition.

## Hermetic tests

The contract test must prove that:

- the fixture is default-inert and capability-bound;
- live authorization requires both opt-ins;
- exact owned lifecycle and vacancy checks are used;
- output and profiles cannot overlap the repository;
- no direct process-kill or shell path exists;
- candidate indices are explicit inputs, not computed from manager-list gaps;
- every mutating probe has a restoration/cleanup terminal;
- CI cannot accidentally start the live procedure.

## Validation

```powershell
npx vitest run tests/observer/runtime-camera-qualification-contract.test.ts tests/observer/live-acceptance-ci-isolation.test.ts tests/observer/runtime-live-acceptance-contract.test.ts
npm run typecheck
npm run build
```

Example controlled run:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_CAMERA_QUALIFICATION = '1'
npm run dev:observer:qualification:runtime-camera -- --config <CONFIG_PATH> --artifact-root <EXTERNAL_ROOT> --confirm-live-run
```

The runner must execute from a clean committed source revision and retain its
result bundle outside the worktree.

## Manager go/no-go record

Before Commit 4 starts, attach a review/sign-off record with the engine build,
clean source commit, retained external artifact identity, and observed values
for the following. Do not amend the attested harness commit after the run; if a
repository record is required, add it in a later documentation commit.

| Gate | Required result |
|---|---|
| Index | No collision in the qualified stock/PIP inventory for an engine-assigned ID or exact reserved constant |
| Registration | Spawned observer is registered and selectable through the manager |
| Publication | Requested observer matrix/FOV is measured from its distinct ID in POSTFRAME |
| Parity | Same-pose images satisfy the declared tolerance in every required render condition |
| Manager hand-back | Exact target publication is proved before observer deletion, with cleanup confirmed afterward |
| Moving-target ordering | Same-frame/tolerance rule is recorded for live target publication |
| User takeover | Conservative relinquishment behavior is feasible and bounded |

Any failed manager row blocks the production dedicated-camera series. A failed
detached result only keeps detached runtimes current-only.

## Research sources

- checked-in Reforger API data: [`data/api/arma-classes.json`](../../data/api/arma-classes.json)
- checked-in Enfusion API data: [`data/api/enfusion-classes.json`](../../data/api/enfusion-classes.json)
- official
  [`CameraManager`](https://community.bistudio.com/wikidata/external-data/arma-reforger/ArmaReforgerScriptAPIPublic/interfaceCameraManager.html)
  API
- official
  [`CameraBase`](https://community.bistudio.com/wikidata/external-data/arma-reforger/ArmaReforgerScriptAPIPublic/interfaceCameraBase.html)
  API
- official
  [`BaseWorld`](https://community.bistudio.com/wikidata/external-data/arma-reforger/EnfusionScriptAPIPublic/interfaceBaseWorld.html)
  API

The local API data is the implementation-time authority for the checked-out
toolchain. Recheck the official generated pages when the target engine version
changes.
