# Commit 7 plan: exercise native restoration and takeover faults

> **Commit:** `test(observer-runtime): exercise dedicated-camera restoration faults`
>
> **Series position:** 7 in the numbered series and the sixth required commit
> when optional recovery is omitted. It follows the final manager transaction
> and admission state machine.

## Why this is its own commit

The current `OnRestorationInProgressBarrier` is only a pause point. It cannot
force restoration failure, so a test that waits there and expects
`RESTORATION_UNCONFIRMED` does not test the proposed failure semantics.

Native fault actions, matrix protocol changes, and retained live evidence form
one verification layer. They should not be mixed into the production behavior
commit, but they must land before the feature is considered complete.

## Goal

Add opt-in, fixture-owned faults that demonstrate:

- a different legitimate camera takeover is relinquished to rather than fought;
- target loss or selection/publication refusal cannot produce false success;
- a job remains nonterminal and held while observer influence remains;
- managed runtime stop remains blocked by the outstanding obligation;
- after safe hand-back, the original capture/cancellation error is preserved;
- repeated success and failure cycles leak no camera registrations or slots.

## Files

- `observer/protocol/fault-matrix.ts`
- `scripts/observer-runtime-failure-matrix.ts`
- `scripts/run-runtime-observer-acceptance.ts`
- `tests/fixtures/runtime-observer-failure-matrix-addon/Scripts/Game/ReforgerForgeObserver/RFO_RuntimeMatrixControl.c`
- `tests/observer/fault-matrix.test.ts`
- `tests/observer/fault-matrix-evidence.test.ts`
- `tests/observer/runtime-failure-matrix.test.ts`
- `tests/observer/runtime-failure-matrix-runner.test.ts`
- `tests/observer/runtime-live-acceptance-contract.test.ts`
- a production runtime source and generated runtime manifest only if a new
  default-inert protected hook is unavoidable

## Fault design

### 1. Keep the control plane default-inert

Retain the fixture's per-run bootstrap, unguessable capability, exact lifecycle
binding, sequence/replay checks, phase acknowledgement, external artifacts, and
owned-runtime cleanup. Extend the hardcoded pilot allowlist deliberately; do
not turn it into a general remote camera command surface.

Every action must name its allowed phase, precondition, expected public state,
camera disposition, and cleanup terminal in `fault-matrix.ts`.

### 2. Use fixture-owned camera targets

Never delete or corrupt an arbitrary gameplay/GameMaster camera merely to make
a test fail. For target-loss cases:

1. let the fixture create and register a camera it owns;
2. select that camera as the pre-capture restore target;
3. verify production capture binds it;
4. delete or replace only that fixture-owned target at the authorized phase;
5. prove the runtime follows its safe relinquishment/containment policy;
6. clean up every remaining fixture-owned camera.

For deliberate takeover, select a separate live registered fixture camera and
treat it as a legitimate new winner. Verify the runtime does not reassert over
it.

Prefer native manager operations and owned entities. If publication refusal
cannot be induced safely, add one narrow protected event seam to the
production lease and override it only in the fixture. The production default
must be a no-op, and that source plus its regenerated manifest belongs in this
commit. Do not add a public request field or environment bypass.

### 3. Add explicit matrix cases

At minimum cover:

- cancellation after the dedicated lease is acquired;
- deliberate different-camera takeover during capture;
- restore-target replacement before target selection;
- target loss while restoration is pending;
- selection succeeds but POSTFRAME publication proof is withheld/refused;
- world transition with an old-world observer outstanding;
- transport loss while restoration is owed;
- attempted owned-runtime stop while the job is still restoring;
- terminal release after successful cleanup.

Each case must declare whether its terminal camera disposition is `restored`,
`relinquished`, `exact_process_exit`, or `not_acquired`. Do not claim
`RESTORATION_UNCONFIRMED` merely because a barrier is paused.

## Required assertions

While the observer is still selected, publishing, alive for cleanup, or may
still own a registered slot:

- public state is nonterminal `RESTORING`;
- `cameraLeaseHeld`/`cameraLease.held` remains true;
- `restorationConfirmed` remains false;
- runtime stop is refused with the exact obligation;
- neither capture success nor terminal restoration failure is emitted.

Once a non-observer target is proved and observer cleanup completes:

- `cameraLeaseHeld` becomes false;
- safe restoration/relinquishment is recorded;
- the original capture/cancellation/timeout failure remains the terminal
  result rather than being overwritten by a recovered transient;
- current-view capture remains usable when subsystem health is safe.

If the fault cannot be released and observer influence remains, the expected
result is contained nonterminal restoration, not a fabricated terminal result.
The exact-owned lifecycle must then retain control rather than killing the
process by name.

## Positive acceptance retained in this commit

In addition to fault cases, repeat and retain:

- manager-owned pose and look-at evidence bound to the distinct observer ID;
- continuous movement without capability flap;
- active PIP without index collision;
- exact target POSTFRAME hand-back;
- current capture materially displaced from the explicit pose after hand-back;
- repeated cycles with no registration/slot leak.

Pixel similarity remains diagnostic when the target can move. Identity, slot,
publication, and cleanup are the restoration oracle.

## Hermetic tests

Prove that:

- every new action/phase/case combination is schema-valid and immutable;
- malformed, replayed, wrong-run, wrong-lifecycle, and wrong-capability commands
  are refused;
- the runner cannot claim live completion without fixture acknowledgement,
  public status evidence, cleanup disposition, and stable source identity;
- the inert restoration barrier alone is never described as a fault;
- no direct process-kill path is introduced;
- retained artifacts are outside the repository and bounded/redacted;
- CI cannot enter a live case without both opt-ins.

## Validation

```powershell
npx vitest run tests/observer/fault-matrix.test.ts tests/observer/fault-matrix-evidence.test.ts tests/observer/runtime-failure-matrix.test.ts tests/observer/runtime-failure-matrix-runner.test.ts tests/observer/runtime-live-acceptance-contract.test.ts tests/observer/live-acceptance-ci-isolation.test.ts
npm run build
```

If production source changed for a protected seam, also run:

```powershell
npm run observer:manifest
npm run observer:manifest:check
npm run observer:validate:enforce -- --protocol-only --target runtime
```

Commit the clean source first, then run each selected live case through the
runtime acceptance command:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:runtime -- --config <CONFIG_PATH> --only <CASE_ID> --confirm-live-run
```

`scripts/observer-runtime-failure-matrix.ts` is an exported runner, not a
standalone command.

## Commit acceptance

- At least one real native restoration fault has a retained passing result.
- Observer influence never coexists with a terminal public result.
- Different-camera takeover is not overridden.
- Managed stop is demonstrably blocked while cleanup is owed.
- No case relies on the pause barrier as the failure mechanism.
