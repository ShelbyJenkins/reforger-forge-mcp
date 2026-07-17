# Reforger Forge MCP 1.1.0

This release adds the transactional ReforgerForge observer platform and replaces
the previous best-effort Workbench launch/restart path with a Windows-only,
exact-owner lifecycle coordinator.

## Observer platform

- The public observer surface is exactly five tools: `observer_setup`,
  `observer_prepare_launch`, `observer_instances`, `observer_capture`, and
  `observer_job`.
- One lazy private child per MCP process owns staging, runtime registration,
  credentials, job delivery, artifacts, and retention. It uses inherited JSON
  IPC, binds an ephemeral loopback runtime port, exits if its parent channel is
  lost, and is never adopted by another MCP process. Idle status and doctor
  operations remain non-mutating and do not start the child.
- `observer_setup` verifies immutable packaged input, stages only beneath the
  managed observer root, and removes only unchanged managed files. Uninstall
  cancels work first and refuses while a camera lease still needs proven
  restoration.
- `observer_prepare_launch` merges one addon path, addon ID, exclusive profile,
  and optional `-forceUpdate` into a structured caller-owned argument array. It
  is launcher-neutral and never invokes Steam, Enfusion, Workbench, PowerShell,
  or a shell.
- The returned `profilePath` is the outer directory supplied to `-profile`;
  Enfusion maps `$profile:` to its physical `<profilePath>/profile` child
  (`<profilePath>\profile` on Windows), so contracts and artifacts live below
  that child's `ReforgerForgeObserver` directory.
- The companion addon remains dormant without a valid, unexpired activation
  contract. Runtime and control credentials are separated, output paths are
  fixed beneath the exclusive profile, and REST delivery has a confined mailbox
  fallback.
- Runtime capture supports current-view, explicit-pose, and look-at requests.
  Command delivery, completion, cancellation, and release are acknowledged and
  idempotent; the host validates stable PNG bytes, dimensions, digest, and
  session/job binding before completion.
- Synchronous `observer_capture` returns exactly one `image/png` content item
  followed by one concise metadata item. Async capture returns a job ID for
  `observer_job` status, cancellation/restoration, and managed release.
- Dedicated/headless instances remain available for authority and health
  diagnostics but never advertise render or camera capabilities.

## Workbench lifecycle changes

- `wb_launch`, automatic launch, `wb_restart`, `wb_shutdown`, cleanup, and
  unexpected-exit recovery share one target-aware coordinator and one global
  Windows named mutex.
- Durable version-2 lifecycle state records the MCP lease and the exact
  Workbench PID, executable path, process creation time, canonical `.gproj`,
  endpoint, generation, owner-token argument, phase, and handler transaction.
- A replacement MCP can claim a lease only after the prior MCP's exact process
  identity is dead. A live owner, a different Windows user, a user-launched
  Workbench, or an unverifiable process fails closed without signalling it.
- `wb_shutdown` stops only the exact verified owner process. Cleanup is refused
  while any Workbench may be watching the target and removes only unchanged,
  manifest-owned handler files.
- Handler installation is hashed and transactional. Restart completes all
  executable, argument, target, bundle, manifest, and collision preflight before
  stopping a healthy Workbench. Failure rollback retains durable recovery data.
- Automated lifecycle control now requires a numeric loopback NET API endpoint.
  Readiness, reuse, and recovery resolve the listening socket's owner and bind it
  to the recorded PID, creation time, executable, owner token, and sole-Workbench
  proof. A compatible foreign ping is refused and a pending launch is rolled back.
- Handler recovery fully cross-binds the transaction ID, target, mod and handler
  directories, manifest, and generation before any mutation. Mismatches fail with
  `RECOVERY_REQUIRED` while leaving files untouched.
- Lifecycle helper work is deadline-bounded. Read-only hangs are terminated and
  reported; uncertainty after mutex acquisition or a mutating operation invokes
  fail-stop behavior instead of continuing with ambiguous ownership or state.
- Exact shutdown and dead-child reconciliation use the stored target identity and
  therefore still work if the recorded `.gproj` has disappeared. Launch and
  restart continue to revalidate the current project file.
- Regression coverage now includes separate Node owner processes, two contenders
  after mutex abandonment, PID-replacement termination refusal, foreign endpoint
  ownership, and helper hangs at acquisition, inspection, state replacement, and
  retained-handle termination boundaries.
- `wb_entity_select` now safely refuses unsupported single-entity selection
  without clearing the user's existing selection or reporting false success.

## Workbench observer adapter

- The managed handler bundle now includes dedicated observer `ping`, `submit`,
  `status`, `cancel`, and `release` endpoints plus a shared transaction file.
  The adapter uses the existing long-lived `WorkbenchClient`, canonical
  `.gproj`, lifecycle generation, endpoint, exact owner lease, and activity
  gate; it never auto-launches Workbench or creates a second process guard.
- The lifecycle guard proves the launched mod's canonical target `.gproj`.
  Workbench's current-project API separately reports the base-game settings
  project; the handler cross-binds the canonical target while tracking that
  base-project identity and the editor world/subscene identity.
- Camera-changing requests snapshot and restore the native `BaseWorld` current
  camera slot, full matrix, measured vertical FOV, and read-only far plane.
  `BaseWorld` exposes no near-plane getter, and the observer never mutates that
  value. Any camera-slot, world, or lifecycle mismatch fails with
  `RESTORATION_UNCONFIRMED` and blocks restart, shutdown, or cleanup until safe
  convergence.
- A new Workbench generation may advertise current `render.capture`, but
  `camera.editor` remains fail-closed until that exact process completes a
  current-view transaction with verified restoration. Explicit-pose and look-at
  capture are refused before that proof.
- Native PNG output is path-confined and independently checked as a regular
  file with stable length, valid PNG structure and dimensions, and SHA-256. The
  adapter returns those exact bytes through the public MCP image contract; no
  BMP conversion is involved.
- Capture submission and release receipts are replay-safe. Owner-scoped restart,
  shutdown, and cleanup request bounded cancellation/restoration through the
  shared lifecycle activity gate and refuse the lifecycle mutation on timeout.

## Observer validation status

Hermetic protocol, coordinator, private-child, staging, runtime-contract,
artifact, Workbench-adapter, handler, and lifecycle regression suites are
included. A double-gated Workbench live harness is also included:

```powershell
$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = "1"
npm run observer:acceptance:workbench -- --confirm-live-run
```

The transaction passed on 2026-07-16 and its retained images were reviewed.
Visible Workbench run `run-owDNnE` produced three materially varied 1165x641
native PNG digests:
`b70ee2343ea330eefcedd2fae6465385f7e8740d1812fb72dbfae4d0c2707d23`,
`ee09b489f4bae2531d2c4d02a0b0819efd4137e7d2fc423c843d936ed40f7af8`,
and `084844713cbfcc845fca4742abd3fcbf1ead885cefb13e169b0afad6633fc087`.
The explicit-pose image used a `(75, 25, 50)` world-space displacement and a
10-degree FOV change before exact camera restoration.
All three captures confirmed restoration; exact-owner shutdown left no
Workbench process, and cleanup removed the unchanged managed bundle with no
modified or unrelated files.

The summary remains outside the repository beneath the run's
`evidence/summary.json`. These results qualify the Workbench screenshot and
camera transaction case only. They do not claim dedicated or headless
rendering, minimized/out-of-focus operation, failure injection, or
remote/delegated rendering.

## Migration and operator notes

- If a live Workbench still has the legacy version-1 owner marker, close it once
  manually. The next lifecycle operation can then archive the legacy marker and
  initialize version-2 state.
- If no prior verified target exists, omitting `gprojPath` succeeds only when
  configuration resolves to exactly one `.gproj`. Ambiguity is refused and the
  candidates are listed; call `wb_launch` with an explicit path.
- Workbench Play remains an attended manual action. Confirm it with the user,
  enter Play in Workbench, verify with `wb_state`, and use `wb_stop` to return to
  edit mode.
- Exact process-identity and global-mutex guarantees are supported on Windows.
  Other platforms refuse automated lifecycle mutation.
