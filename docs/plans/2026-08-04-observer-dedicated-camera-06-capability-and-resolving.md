# Commit 6 plan: separate camera support from per-attempt readiness

> **Commit:** `feat(observer-runtime): wait for transient camera readiness`
>
> **Series position:** 6 in the numbered series, and the fifth required
> behavior commit when optional Commit 5 is omitted. It depends on the complete
> manager transaction from Commit 4.

## Why this is its own commit

The current runtime calls `CanAcquire()` from heartbeat capability generation,
direct command admission, and `RESOLVING`. A temporary owner/slot mismatch—or
even an active explicit lease—therefore removes `camera.runtime` before the
request can wait. After a positive probe, `Acquire()` can still lose a race and
immediately become `CAMERA_BUSY`.

Those are admission-policy changes, not part of camera hand-back. Keeping them
separate makes it possible to review the dedicated transaction first and then
verify exactly which failures are allowed to wait.

## Goal

Advertise stable qualified support, reject fatal/unproven modes, and wait in
`RESOLVING` for classified transient readiness without ever retrying over a
partial camera selection.

## Files

- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverService.c`
- `observer/addon/Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapabilities.c`
- `tests/observer/runtime-camera-restoration-contract.test.ts`
- `tests/observer/package-contract.test.ts`
- `scripts/run-runtime-observer-acceptance.ts`
- `tests/observer/runtime-live-acceptance-contract.test.ts`
- generated `observer/addon/.reforger-forge-observer-source.json`

No host routing or Workbench source file should change.

## Implementation

### 1. Separate support, health, and readiness

Define distinct read-only results for:

- **mode support:** manager dedicated, detached dedicated, current-only, or
  unsupported/ambiguous;
- **subsystem health:** safe versus an unresolved prior camera obligation;
- **attempt readiness:** ready, transiently unavailable, or fatal.

When no lease is outstanding, mode support may inspect the active world and
slot-aware candidate classification, but it must not require momentary
acquirability. While a healthy lease/restoration obligation exists, derive
support from that lease's already-qualified bound mode; the active world slot
then belongs to the observer and must not be reclassified as a new user mode.
Map every readiness reason explicitly; do not classify unknown reasons as
retryable by default.

Examples of transient reasons, subject to source-safe rollback, include a
short-lived target/slot publication transition. A lease already held by the
same resolving job is state reconciliation/partial acquisition; a lease owned
by another or stale job is an unresolved safety obligation. Neither is a
generic transient wait. Fatal reasons include unproven mode, missing required
manager API, world mismatch, ambiguous target, invalid/colliding observer
index, or unresolved unsafe restoration.

### 2. Stabilize capability advertisement

`CurrentCapabilities()` may advertise `camera.runtime` only when:

- graphical render capture is ready;
- an active world exists;
- camera subsystem health is safe;
- the current camera mode has its own true proof flag.

It must not call the old owner/slot-sensitive `CanAcquire()`. A healthy active
explicit lease must not make the capability disappear from heartbeat
inventory. A truly detached-unproven, headless, ambiguous, or unsafe runtime
must still omit it.

### 3. Keep direct command admission fail-closed

`OnRuntimeCommand()` must enforce the same graphical, world, mode-proof, and
subsystem-health gates. Remove only the momentary leaseability refusal. Preserve
the existing singleton active-job and rate-limit admission rules.

Direct transport delivery may never rely on host-side capability filtering for
safety. An unproven detached explicit view must still be rejected before any
camera mutation.

### 4. Wait in `RESOLVING`

In `RESOLVING`:

- run cancellation and request-deadline checks before readiness work;
- retry classified transient reasons without changing camera state;
- fail fatal reasons immediately with the specific reason;
- preserve the latest transient reason in the existing deadline diagnostic;
- leave current-view captures blocked behind the accepted singleton job and
  document/test this head-of-line behavior.

Do not add a separate unbounded camera wait. The request deadline is the outer
limit.

### 5. Handle the probe/acquire race explicitly

Use Commit 4's mutation-disposition outcome:

- retry only a failure that proves no observer is selected, registered, or
  otherwise owed cleanup;
- if spawn/selection partially succeeded, move to restoration immediately;
- if rollback was attempted but not proved, mark the subsystem unsafe and keep
  the job nonterminal in restoration;
- never convert a partial selection to ordinary `CAMERA_BUSY`.

Keep recovered readiness diagnostics separate from the first terminal
restoration reason.

### 6. Consume camera-subsystem health consistently

Commit 4 already makes `m_RFO_CameraSubsystemSafe=false` mean an actual
unresolved safety failure. Use that state consistently in support and direct
admission. A classified transient wait must not change it, and this commit must
not re-own ordinary restoration-health semantics.

## Host and protocol boundary

Do not change `CaptureService.isCompatible()`, instance selection, Workbench
priming, or `observer-adapter.ts`. Once inventory is stable, existing host
routing sends explicit requests correctly. Keep the generic
`CAPABILITY_UNAVAILABLE` registry text; Commit 4 already owns the
`camera.runtime` proof wording.

## Tests

Rewrite the admission section of
`runtime-camera-restoration-contract.test.ts` to prove:

- capability generation does not call momentary `CanAcquire()`;
- an outstanding healthy lease does not remove structural capability support;
- all stable support and health gates remain;
- direct command admission repeats them;
- transient and fatal reasons are explicitly classified;
- `RESOLVING` retries transient reasons under cancellation/deadline checks;
- fatal reasons transition immediately;
- no-lease acquisition races return to resolving only after cleanup absence is
  proved;
- partial acquisition enters restoration;
- latest transient and first terminal restoration diagnostics stay separate.

Keep `capture-service.test.ts` coverage that a genuinely missing
`camera.runtime` is refused and that Workbench priming occurs before an
explicit request. No host implementation change should be needed to make those
tests pass.

Extend live acceptance to poll inventory:

- during continuous movement of the same supported camera;
- while an explicit lease is active;
- during a transient resolving interval;
- after successful restoration.

Keep a hermetic test that unsafe health removes manager support. The native
unsafe-restoration injection and retained live proof belong to Commit 7.

## Validation

```powershell
npm run observer:manifest
npm run observer:manifest:check
npx vitest run tests/observer/runtime-camera-restoration-contract.test.ts tests/observer/package-contract.test.ts tests/observer/capture-service.test.ts tests/observer/runtime-live-acceptance-contract.test.ts
npm run typecheck
npm run build
npm run observer:validate:enforce -- --protocol-only --target runtime
```

Repeat controlled runtime acceptance and retain evidence that moving a
supported target no longer produces a host-side pre-dispatch capability
refusal.

## Commit acceptance

- Stable support no longer flaps with momentary leaseability.
- Fatal and unproven modes still fail before mutation.
- Only proved no-lease races are retried.
- Partial selection always remains an outstanding restoration obligation.
- Host and Workbench implementation files are unchanged.
