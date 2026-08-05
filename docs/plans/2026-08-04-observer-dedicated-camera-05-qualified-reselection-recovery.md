# Conditional commit plan: recover qualified editor self-reselection

> **Conditional commit:** `feat(observer-runtime): recover qualified editor camera self-reselection`
>
> **Series position:** insert after Commit 4 and before Commit 6 only when the
> live qualification proves a specific, repeatable same-target reselection and
> a safe bounded recovery. Otherwise omit this commit.

## Why this must remain conditional

A dedicated index does not remove camera-manager contention. However, a generic
"reassert for 30 frames" policy would fight deliberate user camera changes for
the full preload, settle, screenshot, and artifact-stability interval. That can
last seconds and up to 300 artifact frames.

The base manager transaction therefore treats ownership displacement as
`LOST`. Recovery is justified only for an identified controller behavior—such
as the existing editor camera selecting itself again—that Commit 2 measured and
can distinguish from a new user-selected camera.

## Qualification required before implementation

The retained live record must identify:

- the exact displaced observer and exact self-reselecting target/controller;
- whether the observer POSTFRAME callback continues while deselected;
- how `manager.CurrentCamera()` and `world.GetCurrentCameraId()` evolve;
- the maximum observed delay before a reselected observer republishes;
- a reliable identity predicate that cannot match an arbitrary different
  camera;
- a qualified event-origin signal from the editor interlock/controller that
  distinguishes stock self-reselection from a user deliberately selecting the
  same camera object;
- evidence that bounded reselection does not corrupt hand-back.

If any item is absent, skip the commit and retain conservative failure plus
relinquishment.

## Files

- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverService.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverEditorCameraArbitration.c`
  only if the qualified identity predicate belongs in the interlock
- `tests/observer/runtime-camera-restoration-contract.test.ts`
- `tests/observer/package-contract.test.ts`
- `scripts/run-runtime-observer-acceptance.ts`
- `tests/observer/runtime-live-acceptance-contract.test.ts`
- generated `observer/addon/.reforger-forge-observer-source.json`

## Implementation

### 1. Add the third maintenance state

Use an explicit `HELD`, `RECOVERING`, `LOST` result:

- `HELD`: exact observer manager identity, observer world ID, and recent
  POSTFRAME publication are proved;
- `RECOVERING`: only the qualified same-target controller displaced the
  observer, reselection was attempted, and POSTFRAME proof is pending;
- `LOST`: a different/ambiguous target appeared, the operation failed, or the
  request deadline was exhausted.

Do not mutate from `IsHeld()`, status serialization, or capability probes.

### 2. Bound and classify reselection

Perform reselection only when both the exact target identity and the
live-qualified event-origin signal match. Same-target identity by itself is not
enough. Check `manager.SetCamera(observer)` and wait for both manager identity
and world slot publication. Use the request deadline. Add a shorter retry
cadence only if the measured live data supports it; do not add a magic
frame-count budget.

A different legitimate camera, target deletion, world change, manager change,
or ambiguous identity transitions directly to `LOST` and the conservative
hand-back path. Never reassert over a deliberate user takeover.

### 3. Pause the capture pipeline while recovering

While `RECOVERING`:

- do not advance preload readiness;
- do not consume settle frames;
- do not issue a screenshot;
- do not accept an artifact as evidence;
- continue cancellation/deadline checks and lease diagnostics.

If displacement occurs after `IssueCommitted()`, quarantine/delete the issued
artifact. Either re-arm and reissue only after a fresh POSTFRAME proof, or fail
the capture and restore; never later accept a frame issued before or during
lost ownership.

Resume only after a new POSTFRAME proves exact observer selection, distinct
world ID, and requested publication. Reset transient counters only after that
proof.

Keep transient recovery diagnostics separate from the first terminal camera
failure reason.

### 4. Preserve restoration safety

Recovery is capture-time behavior only. Once restoration starts, stop
reselection and run Commit 4's exact target hand-back. A stalled recovery must
not cause observer destruction, terminal reporting, or runtime stop while the
lease remains outstanding.

## Tests

Prove hermetically that:

- only the qualified self-reselection predicate enters `RECOVERING`;
- arbitrary manager/world mismatches enter `LOST`;
- all capture pipeline stages pause during recovery;
- status and capability queries are read-only;
- manager identity and world publication are both reproved;
- retries are deadline-bound and contain no fixed 30-frame rule;
- recovered contention does not set the terminal restoration diagnostic;
- restoration disables reselection and preserves the Commit 4 ordering.

The live runner must exercise both the qualified self-reselection and a
different-camera takeover to prove their outcomes differ.

## Validation

```powershell
npm run observer:manifest
npm run observer:manifest:check
npx vitest run tests/observer/runtime-camera-restoration-contract.test.ts tests/observer/package-contract.test.ts tests/observer/runtime-live-acceptance-contract.test.ts
npm run typecheck
npm run build
npm run observer:validate:enforce -- --protocol-only --target runtime
```

Repeat the controlled runtime acceptance with continuous editor activity. If
the identity predicate or bounded recovery is not reliable, drop this commit;
do not broaden it into a generic camera watchdog.

## Commit acceptance

- Known self-reselection recovers without advancing capture on unproved frames.
- Deliberate user takeover still wins conservatively.
- No query mutates camera state.
- The commit is absent when the qualification prerequisite is not met.
