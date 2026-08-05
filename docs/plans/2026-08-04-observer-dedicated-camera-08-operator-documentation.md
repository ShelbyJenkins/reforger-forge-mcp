# Commit 8 plan: publish dedicated runtime-camera semantics

> **Commit:** `docs(observer): document dedicated runtime camera hand-back`
>
> **Series position:** final required commit after production behavior,
> admission, hermetic contracts, and retained live fault results are stable.

## Why documentation is last

The product promise depends on the actual qualified index mechanism, measured
render parity, whether optional same-target recovery landed, and the final
detached result. Publishing those claims earlier would either document a
speculative mechanism or require repeated generated-copy churn.

This is a documentation and final-verification commit, not a place to repair
lease logic.

## Goal

Describe the released runtime behavior accurately:

- manager-owned explicit capture uses an observer-owned dedicated slot;
- non-observer camera state is not rewritten by that path;
- restoration means proven selection/publication hand-back and observer
  cleanup, not equality with a frozen pre-capture matrix;
- transient readiness may wait under the request deadline and blocks the
  runtime's single job slot;
- stalled hand-back remains nonterminal and blocks managed runtime stop;
- detached mode is either separately proven or accurately current-only;
- Workbench retains its existing borrow-and-exact-state-restore transaction.

## Files

- `observer/README.md`
- `docs/observer.md`
- `tests/observer/package-contract.test.ts` for pinned copy
- `tests/observer/protocol.test.ts` only if generated capability copy needs a
  final consistency assertion
- `observer/protocol/registry.ts` and generated
  `observer/protocol/capabilities.md` only if Commit 4 did not already land the
  final manager proof wording

Do not modify historical release notes merely to restate the new design.

## Documentation changes

### `observer/README.md`

Update the current general/runtime sections:

- the invariant currently around lines 65–66: distinguish runtime
  non-mutation/hand-back from Workbench state equality;
- the runtime capture/restoration discussion around lines 182–190: define
  `restorationConfirmed` as exact target or qualified takeover publication,
  followed by observer deletion/deregistration;
- runtime diagnostics around lines 321–322: distinguish active publication,
  outstanding restoration obligation, containment, and confirmed cleanup;
- the capability table around line 332: remove momentary "leaseable camera"
  wording and describe qualified mode plus health.

Leave the Workbench adapter paragraph around lines 230–234 unchanged. It
correctly describes Workbench's native-slot borrow-and-restore behavior.

### `docs/observer.md`

Update:

- runtime inventory/capability behavior around lines 122–124;
- runtime troubleshooting around line 307;
- live acceptance examples if Commit 2 or Commit 7 added a named command/case.

Preserve Workbench priming around lines 139–154. Host priming already exists and
is not part of this feature.

### Capability proof

The final `camera.runtime` proof should name:

- graphical runtime capture;
- qualified manager-owned dedicated slot;
- requested POSTFRAME publication;
- proven target hand-back and observer cleanup;
- mode-specific proof/health gating.

Keep generic `CAPABILITY_UNAVAILABLE` wording unchanged. No protocol schema or
version bump is justified by copy alone.

## Required limitations and policy

Document these without softening them:

- The guarantee is bounded to a stable graphical world and a qualified camera
  mode.
- A deliberate different-camera takeover wins conservatively and may fail the
  capture.
- Target deletion, world transition, or ambiguous ownership may keep the job
  in restoration until safe relinquishment is proved.
- A reserved constant has residual third-party-mod collision risk; cite the
  tested engine build, observed PIP range, and retained qualification artifact.
- Render equivalence is established by the tested pixel-parity matrix because
  several per-slot properties are write-only.
- A resolving explicit job is the runtime's sole active job and has already
  consumed capture-rate admission.
- `cameraLease.held=true` represents an outstanding camera obligation, including
  cleanup after target publication.

If optional Commit 5 was omitted, do not claim automatic reselection recovery.
If the detached gate failed or remains unrun, say detached explicit views are
unsupported/current-only.

## Workbench and host exclusions

Verify that documentation does not imply changes to:

- `CaptureService.primeWorkbenchIfNeeded()`;
- `src/workbench/observer-adapter.ts`;
- `EMCP_WB_ObserverCommon.c`;
- Workbench restoration, near-plane, or snapshot semantics.

No host implementation or Workbench file belongs in this commit.

## Validation

If protocol source did not change here:

```powershell
npx vitest run tests/observer/package-contract.test.ts tests/observer/protocol.test.ts tests/observer/capture-service.test.ts tests/workbench/observer-handler-contract.test.ts tests/workbench/observer-adapter-lifecycle-restoration.test.ts
npm run build
npm run observer:manifest:check
npm run protocol:check
npm test
```

If final protocol wording changed here, run `npm run observer:generate` first
and inspect generated diffs. Workbench helper source/build/manifest and adapter
files must remain byte-for-byte unchanged unless an independently explained
canonical generator input requires otherwise.

Repeat the final controlled manager acceptance on the exact documented commit.
Run detached acceptance only if its separate proof is enabled. Record the
engine build, source commit, fixture mode, client role, retained result identity,
and any unrun manual condition.

## Commit acceptance

- Documentation matches the code and retained live evidence.
- Manager and detached support are stated separately.
- Nonterminal containment and stop refusal are explicit.
- Workbench semantics remain unchanged.
- Full hermetic tests and final controlled manager acceptance pass.
