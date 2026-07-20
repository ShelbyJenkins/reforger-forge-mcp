# Observer host facade removal implementation guide

**Status:** Active outstanding work  
**Source task:** [Outstanding maintainability work](OUTSTANDING.md)  
**Research snapshot:** 2026-07-19, against the active working tree  
**Entry condition:** Preserve the current observer lifecycle guarantees. This
change must not be combined with a private-agent protocol, camera, runtime
ownership, or evidence-format redesign.

## Outcome

The host has one public composition root:
`createObserverApplication()` in `src/observer/application.ts`. Every host
consumer receives that `ObserverApplication` interface (or a smaller
structural port when it needs only a subset of operations). The historical
`ObserverCoordinator` class and its construction/type/export aliases no longer
exist.

The private agent remains a separate graph rooted at
`observer/agent/application.ts`. It continues to own runtime REST, mailbox
polling, session and camera authority, artifact storage, and evidence export.
The host continues to own MCP composition, the shared capture service,
Workbench adapter integration, exact-owned runtime composition, and orderly
shutdown. Removing the facade must not make either graph reach through the
other's boundary.

## Scope and decisions

1. Delete `src/observer/coordinator.ts` only after every import and type use
   has migrated to the host application owner.
2. Construct host graphs with `createObserverApplication(options)`, not a new
   replacement wrapper or another factory alias.
3. Type ordinary consumers as `ObserverApplication`; retain existing narrow,
   structural ports such as `ObserverLaunchPort`, `ObserverSetupPort`, and
   `OwnedRuntimeObserverGate` where they already express less authority.
4. Move `ObserverCoordinatorError` imports to `src/observer/errors.ts`, but do
   **not** rename its class or public-facing behavior in this change. The
   historical error spelling is not the facade and renaming it would expand
   the migration into an error-contract change. A later, separately reviewed
   naming cleanup may do that once it characterizes the error-name consumers.
5. Preserve operation ordering exactly: capture cancellation/restoration
   precedes private-child close; exact-owned runtime stop and identity-vacancy
   proof precede session revocation; the Workbench adapter restores before the
   application closes.
6. Keep the live acceptance harnesses repository-only and opt-in. Their
   source-closure lists, artifact operation names, and source-text contracts
   must describe the application rather than a deleted facade.

## Non-goals

- Do not change the seven public MCP tool names, schemas, result shapes, or
  public observer error codes.
- Do not merge `src/observer/application.ts` with
  `observer/agent/application.ts`; the same factory name in distinct host and
  agent modules deliberately describes different composition roots.
- Do not move private-agent REST, mailbox, job, camera, retention, or evidence
  logic into `src/`.
- Do not change ownership-proof rules, process termination behavior, IPC wire
  contracts, managed paths, artifact formats, or controlled-capture
  procedures.
- Do not treat a passing hermetic source test as a substitute for the required
  controlled runtime and Workbench capture evidence.

## Current dependency inventory

| Area | Current coordinator dependency | Target |
| --- | --- | --- |
| Production MCP composition | `src/server.ts` already creates the application once and passes it to `registerObserverTools`. | Keep this as the reference composition path. |
| Tool registrar | `src/observer/tools.ts` imports facade exports and accepts `ObserverApplication \| ObserverCoordinator`. | Import the error from `errors.ts`; accept `ObserverApplication` only. |
| Runtime live harness | `scripts/run-runtime-observer-acceptance.ts` constructs/types/measures a coordinator and includes `src/observer/coordinator.ts` in its hash-bound source list. | Create/type/measure an application and remove the deleted file from its source list. |
| Workbench live harness | `scripts/run-workbench-observer-acceptance.ts` has the equivalent construction, typing, measurement strings, and source list. | Make the same application migration while preserving `adapter.restoreAll()` before close. |
| Host unit/contract tests | `tests/observer/phase-h.test.ts` and `tests/observer/private-child-owned-runtime-recovery.test.ts` exercise the compatibility constructor and casts. | Exercise the application factory and interface directly; retain behavioral assertions. |
| Source/package contracts | Stage-4, live-acceptance, and package tests mention the facade/module deliberately. | Replace legacy-presence assertions with absence checks and application composition checks; stop requiring the deleted dist module. |
| Documentation | `observer/README.md` calls the coordinator historical/delegating. | Describe the application directly, including its shutdown responsibility. |

`src/observer/launch.ts`, `src/observer/setup.ts`, and
`src/observer/owned-runtime-manager.ts` already use structural ports. Their
port names do not need to change merely because the facade disappears.

## Migration plan

### OHF-0: Freeze the safety boundary

1. Run the focused host and recovery tests before edits:

   ```powershell
   npx vitest run tests/observer/application.test.ts tests/observer/stage4-architecture.test.ts tests/observer/phase-h.test.ts tests/observer/private-child-owned-runtime-recovery.test.ts tests/workbench/observer-live-acceptance-contract.test.ts tests/observer/runtime-live-acceptance-contract.test.ts
   ```

2. Record the current shutdown ordering from both live harnesses. In
   particular, preserve the runtime order of exact-owned stop, proven vacancy,
   session revocation, then application close; and the Workbench order of
   adapter restoration before application close.
3. Capture a full import inventory before and after each stage:

   ```powershell
   rg -n 'ObserverCoordinator|createObserverCoordinator|ObserverCoordinatorOptions|coordinator\.js' src observer tests scripts
   ```

4. Do not use a broad search-and-replace for `Coordinator`: it would alter the
   private-agent `MailboxCoordinator` and generic Workbench lifecycle
   coordinator terminology, which are unrelated and must remain intact.

**Acceptance:** The baseline is known, and the legacy references have been
classified as facade uses, error-name uses, or unrelated coordinator concepts.

### OHF-1: Make the host application the only host-facing API

1. In `src/observer/tools.ts`, import `ObserverCoordinatorError` directly from
   `./errors.js` and keep the `ObserverCaptureResult` type from
   `./application.js`.
2. Change `registerObserverTools` to accept only `ObserverApplication`.
   Remove the `ObserverApplication | ObserverCoordinator` union; it is the
   primary production compatibility allowance.
3. Keep `ObserverToolDefaults` and all tool handler behavior unchanged. The
   compiler should prove that every member used by the registrar is part of
   `ObserverApplication`.
4. In `src/observer/launch.ts`, import the error from `./errors.js`. Leave its
   narrow `ObserverLaunchPort` intact. In `src/observer/agent-client.ts`,
   retain the existing direct `errors.ts` import and error re-export only if
   it is a real supported module API; it must not recreate a coordinator
   compatibility surface.
5. Confirm that `src/server.ts` still has exactly one
   `createObserverApplication(...)` call, passes the resulting object to
   `registerObserverTools`, and owns the idempotent
   `closeRuntimeLifecycle()` disposer.

**Acceptance:** No production host module imports `coordinator.js`; MCP tools
compile against exactly one application interface.

### OHF-2: Migrate host test and harness consumers

1. Replace every `new ObserverCoordinator(options)` in
   `tests/observer/phase-h.test.ts` with `createObserverApplication(options)`.
   Update explicit type annotations and test doubles from `ObserverCoordinator`
   to `ObserverApplication` (or a minimal local port). Keep tests that prove
   option validation, startup loss, runtime/Workbench routing, run recovery,
   cancellation, release, and shutdown behavior; delete only tests whose
   subject is constructor forwarding or facade delegation.
2. Migrate `tests/observer/private-child-owned-runtime-recovery.test.ts` in
   the same way. Rename fixture-only identifiers such as
   `FaultingCoordinatorGate`, `coordinator`, and `coordinators` where they
   imply the deleted wrapper, but leave `OwnedRuntimeObserverGate` unchanged.
   Its real IPC restart, durable authority, release-fault, camera-restoration,
   and exact-process recovery assertions are required completion evidence and
   must not be weakened.
3. Update `scripts/run-runtime-observer-acceptance.ts` to import
   `createObserverApplication`, `ObserverApplication`,
   `ObserverCaptureResult`, and `ObserverCaptureView` from
   `src/observer/application.ts`. Create an `application` value, pass it to
   `OwnedRuntimeManager` and `prepareObserverLaunch`, and retain every current
   operation and cleanup edge.
4. Update `scripts/run-workbench-observer-acceptance.ts` equivalently. Keep
   the `WorkbenchObserverAdapter` as an injected `workbenchAdapter`, retain
   the async job/status/read sequence, and retain
   `adapter.restoreAll()` before `application.close()`.
5. Replace evidence measurement labels and summary keys that claim
   `ObserverCoordinator.*` with truthful `ObserverApplication.*` names. Update
   `scripts/observer-live-acceptance-support.ts` and its tests as one
   artifact-schema change: operation names are evidence data, so no stale
   aliases may remain in generated operational baselines.
6. In both harness source lists, delete
   `src/observer/coordinator.ts`; `src/observer/application.ts` is already the
   relevant host source. Review all source-closure assertions so the deleted
   file is never hash-bound or expected.

**Acceptance:** Both controlled harnesses exercise the concrete application
object directly and preserve their existing cleanup, source-closure, and
artifact-validation rules.

### OHF-3: Replace compatibility-specific contracts

1. Rewrite `tests/observer/stage4-architecture.test.ts` so it asserts the
   host composition root and public interface, rather than constraining the
   size/content of a compatibility wrapper. It should continue to prove one
   application construction in `src/server.ts`, one tool registration path,
   and no second owned-runtime or Workbench graph.
2. Update `tests/observer/application.test.ts` to remain the composition-root
   test for host agent transport, capture service, evidence runs, diagnostics,
   and safe close. Add a focused test proving production registration accepts
   an `ObserverApplication` without a facade.
3. Update the runtime and Workbench live-acceptance source contracts to expect
   `createObserverApplication`, `ObserverApplication` measurement names, and
   application shutdown. Preserve assertions that rule out direct adapter
   capture bypasses, global process-kill paths, or a second lifecycle owner.
4. Update `tests/observer/package-contract.test.ts` and
   `scripts/check-package.mjs`: remove `dist/observer/coordinator.js` from
   required installed files, and add an explicit assertion that it is absent
   from the packed package. Keep the required host application and private
   agent entry points.
5. Add a narrowly scoped regression assertion, for example a file-existence
   check plus a source import scan, that refuses any new host
   `coordinator.js` import or `ObserverCoordinator` construction. Scope it to
   `src/`, repository-only host harnesses, and host tests so private
   `MailboxCoordinator` is not falsely rejected.

**Acceptance:** The test suite protects the desired architecture rather than
the implementation detail being removed.

### OHF-4: Remove the facade and update documentation

1. Delete `src/observer/coordinator.ts` after the compiler and import search
   show no remaining consumer. This removes `ObserverCoordinator`,
   `createObserverCoordinator`, `ObserverCoordinatorOptions`, and all
   forwarding methods together; do not leave an empty re-export or a
   deprecated compatibility shim.
2. Remove facade-only test blocks, fixtures, casts, and comments. Keep tests
   that validate the host application's actual behavior.
3. In `observer/README.md`, replace statements that the historical coordinator
   delegates with an accurate description of the host application composition
   root and its explicit shutdown responsibility. Update live-harness cleanup
   wording from "closes the coordinator" to "closes the host application."
4. Update implementation comments, diagnostic names, and documentation links
   that refer specifically to the deleted facade. Leave unrelated terms such
   as the private `MailboxCoordinator` and the Workbench lifecycle coordinator
   alone.
5. Verify the final focused search has no facade result:

   ```powershell
   rg -n 'ObserverCoordinator|createObserverCoordinator|ObserverCoordinatorOptions|coordinator\.js' src tests scripts
   ```

   Any remaining `ObserverCoordinatorError` occurrence is intentional only if
   it comes from `errors.ts` or a direct `errors.js` import. Audit it rather
   than using it as grounds to recreate the deleted module.

**Acceptance:** There is no host compatibility facade, alias, union type,
constructor, or compatibility-only test remaining.

## Required validation and completion proof

Run tests in increasing scope. Report each command's actual result rather than
calling an unrun live gate passed.

```powershell
npm run build
npx vitest run tests/observer/application.test.ts tests/observer/stage4-architecture.test.ts tests/observer/phase-h.test.ts tests/observer/private-child-owned-runtime-recovery.test.ts tests/observer/package-contract.test.ts tests/observer/runtime-live-acceptance-contract.test.ts tests/workbench/observer-live-acceptance-contract.test.ts tests/workbench/observer-live-acceptance-support.test.ts
npm run test:stage4
npm test
npm run test:package
```

The removal criterion in `OUTSTANDING.md` additionally requires evidence that
the actual application interface preserves the boundary under real lifecycle
conditions. On a prepared Windows machine, with no existing Arma or Workbench
process and an external artifact root, run both explicitly gated paths:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:runtime -- --confirm-live-run

$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:workbench -- --confirm-live-run
```

For each successful controlled run, retain the sanitized artifact/summary and
review that it proves all of the following:

| Proof | Runtime path | Workbench path |
| --- | --- | --- |
| Correct host/private separation | Private-child recovery and control calls use the application, with no host REST/mailbox implementation. | Managed application routes capture through the Workbench adapter, not direct handler calls. |
| Shutdown order | Jobs/restoration settle; exact-owned runtime stops and proves vacancy; session is revoked; application/private child closes. | Jobs are terminal and restored; adapter restoration completes; application/private child closes; exact-owned Workbench shutdown proves vacancy. |
| Evidence hygiene | Managed run finalizes/discards safely, releases artifacts as requested, and leaves no camera/child obligation. | Managed run/export has the same cleanup result and no target-project residue. |
| Redaction and attribution | Summary/source closure includes `application.ts`, omits the deleted facade, and contains no private tokens or paths. | The equivalent Workbench source closure and sanitized baseline are correct. |

If either live path is not run, the code/test migration may be ready for
review, but the outstanding task is **not complete**. Record the environmental
blocker and retain the facade-removal work as pending until the required
controlled evidence is reviewed.

## Review checklist

- `src/observer/application.ts` is still the sole host observer composition
  root; `observer/agent/application.ts` is still the sole private-agent root.
- `registerObserverTools` has no facade union and production has no second
  observer application, owned-runtime manager, or Workbench client graph.
- Runtime/Workbench harnesses still use managed runs, public capture APIs,
  strict restoration, exact-owner cleanup, and source-closure hashing.
- No `src/observer/coordinator.ts` source or `dist/observer/coordinator.js`
  package payload exists.
- The full `rg` audit contains no facade import/construction; unrelated
  Mailbox/Workbench coordinator names were preserved.
- Private-child recovery and both opt-in live capture paths have retained
  evidence satisfying the completion proof above.
