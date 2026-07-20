# ReforgerForge Observer Platform

This directory contains the standalone observer runtime, its disposable
private-child agent, and the shared protocol. Public MCP orchestration lives
under `src/observer`; runtime addon staging remains separate from target
projects and from Workbench lifecycle ownership.

## Safety invariants

- The packaged addon is immutable input and is staged beneath the observer managed root, never beneath a target project.
- Launch preparation returns an argument array. It never invokes Steam, Enfusion, Workbench, PowerShell, or a shell.
- One exclusive outer profile maps `$profile:` to the physical
  `<profilePath>/profile` child (`<profilePath>\profile` on Windows) and
  contains the fixed `ReforgerForgeObserver/session.json` activation contract
  there.
- The addon is dormant without a valid, unexpired contract and accepts no arbitrary URL or output path.
- The agent binds loopback only. Runtime session tokens cannot call control operations.
- Runtime process IDs returned by inventory are diagnostic only. Preparation and capture never adopt or signal a game process; only an explicit `observer_runtime` lifecycle action may affect the exact child it started and verified.
- Exact-owned runtime lifecycle state is atomic beneath the external managed root and uses owner-only creation modes where supported. On Windows it inherits that root's ACL, so a custom managed root must be current-user-private rather than shared or broadly writable. The lifecycle never uses process names, a PID alone, a shell command, or broad process-tree termination, and it never adopts a pre-existing Arma process.
- MCP tools remain thin orchestration over the lazy private child and the shared exact-process lifecycle service; they do not duplicate staging, job, artifact, camera, or process-identity behavior.
- Workbench capture reuses the shared `WorkbenchSessionController` through the
  stable `WorkbenchClient` facade, its version-3 lifecycle lease, local
  writer-preferring reader/writer gate, externally staged Workbench companion,
  and dedicated external profile. It never creates a parallel Workbench owner
  or writes helper sources into a target project.

## Build and standalone CLI

```text
npm run build
node dist/observer/agent/index.js --version
node dist/observer/agent/index.js serve
node dist/observer/agent/index.js stage
node dist/observer/agent/index.js doctor
node dist/observer/agent/index.js prepare-launch --agent-descriptor live-agent.json --request request.json
```

`serve` writes one bounded startup descriptor to stdout and operational logs to stderr. It binds `127.0.0.1` on an ephemeral port by default. Loopback control HTTP is disabled unless `--control-http` is explicitly supplied; in-process control remains available to launch wrappers.

Profiles must be beneath the configured observer profile root. The returned
`profilePath` is the outer directory supplied unchanged to `-profile`; Enfusion
mounts `$profile:` at its physical `<profilePath>/profile` child
(`<profilePath>\profile` on Windows). A prepared argument array contains one
merged `-addonsDir`, one merged `-addons`, one matching `-profile`, and
`-forceUpdate` only when requested.

## MCP integration

The MCP server creates one host observer application. Its shared capture
service owns routing, public jobs, idempotency, deadlines, run binding,
promotion, cancellation, and release for both runtime and Workbench backends.
The application also owns orderly shutdown: capture restoration completes
before the private child closes. It lazily forks
`dist/observer/agent/private-child.js` with an inherited JSON IPC channel and
an ephemeral loopback runtime port. The child is never adopted by another MCP,
exits on parent-channel loss, and is asked to shut down when the MCP transport
closes. The public surface is exactly seven MCP tools:

- `observer_setup` verifies/stages both immutable companion add-ons, reports
  both managed roots, applies bounded Workbench-helper retention while vacant,
  and performs restoration- and lifecycle-aware managed uninstall.
- `observer_prepare_launch` creates an expiring activation session, merges the
  observer into a caller-supplied launch argument array without spawning a
  process, and returns an opaque one-shot `preparedLaunchId` in addition to the
  structured arguments.
- `observer_runtime` explicitly starts, inspects, or stops an exact-owned
  graphical runtime on Windows. Start and stop require idempotency keys;
  status is read-only, and stop is restoration-gated.
- `observer_instances` inventories runtime and already-running exact-owned
  Workbench renderers, including capabilities, health, world identity, and any
  active job.
- `observer_capture` submits current-view, explicit-pose, or look-at work. Sync
  mode returns exactly one validated PNG image followed by one metadata text
  item; async mode returns a job ID.
- `observer_job` reads status or a completed inline PNG and requests
  cancellation/restoration. Independent release refuses artifacts retained by
  an open run; finalize or discard that run instead.
- `observer_run` begins, inspects, finalizes, or discards managed evidence
  runs. Finalization is confined to configured `observer.evidenceRoots`.

Synchronous capture embeds one host-validated PNG plus concise metadata when it
fits the configured inline limit. Oversized artifacts remain retained for
run finalization, without disclosing a private managed path.

Inventory and jobs include an opaque, versioned `worldRevision` that represents
nullable runtime worlds and Workbench composite world identity without
inventing backend epochs. New callers should echo it as
`expectedWorldRevision`; legacy world ID/epoch fields remain projected for
compatibility. The durable run store is backend-neutral. Filesystem bundle
construction, member hashing, log redaction, manifest-last publication,
verification, and interrupted-export recovery live in an optional exporter.
Without configured evidence roots, new begin/reserve/finalize requests fail
immediately, while status, failure, discard, and cleanup remain available for
existing durable records.

Runtime sessions support acknowledged REST delivery with a confined mailbox
fallback. Registration, heartbeats, job idempotency, artifact completion, and
release receipts are bounded and replay-safe. A job is never reported complete
until the host has validated the regular PNG file, dimensions, stable size,
digest, and session/job binding. Status and doctor remain non-mutating while the
private child is idle.

The installed `observer-agent doctor` command calls lexical/read-only path
inspection directly. Missing managed and profile roots remain missing: doctor
does not construct stores, stage files, create directories, or start a child.

### Bounded mailbox and retention behavior

The agent sweeps in-memory ownership stores every second and once more during
controlled shutdown. By default, revoked session tombstones remain replayable
for five minutes, terminal jobs and idempotency receipts for ten minutes, and
stale instances for five minutes after the liveness threshold. Nonterminal or
restoration-pending jobs, runtime-stop reservations, and captures referenced by
an open evidence run pin their owning records. Store diagnostics report current
counts, estimated bytes, and configured ceilings.

Mailbox remains a supported fallback. Each command has an explicit `disposed`,
`retained_for_retry`, or `storage_unavailable` disposition. Accepted cleanup is
replay-safe, permanent rejection uses one exact idempotent quarantine target per
source file, and transient failures have an eight-attempt/30-second budget.
Polling rotates beyond the 256-file work batch, so one locked poison file cannot
starve later commands or disable status, heartbeat, or artifact egress. Each
quarantine keeps at most 128 records, 4 MiB, and 24 hours of evidence; the agent
also enforces a 64-MiB aggregate mailbox-state ceiling and substitutes a bounded
disposition summary when retaining an original would exceed it.

Runtime status publication serializes orphan reclamation with the next write,
before applying the 512-data-file cap. The host never deletes markerless data
for an active session: host reclamation begins only after durable session state
proves the writer terminal and unpinned. Thus a writer paused after data copy but
before marker publication can resume without finding its payload removed.

After changing the runtime add-on, regenerate its source manifest, build the
host, compile Enforce, and run the real mailbox behavior gate:

```powershell
npm run observer:manifest
npm run build
npm run observer:validate:enforce
npm run observer:acceptance:enforce-mailbox
```

Both commands read only Workbench/add-on paths from the gitignored local config,
refuse an already-running Workbench, use isolated temporary profiles, and write
sanitized JSON evidence. `observer:validate:enforce` is compile-only and
deliberately records `behavioralMailboxAcceptance.result: "not_run"`.
`observer:acceptance:enforce-mailbox` is the V10 behavioral gate: it verifies the
source manifest and just-built host modules, compiles Game and WorkbenchGame,
executes all five cases, and proves final Workbench vacancy.

The recorded 2026-07-18 local run (2026-07-19 UTC) is
[`docs/validation/2026-07-18-observer-enforce-compile.json`](../docs/validation/2026-07-18-observer-enforce-compile.json).
Workbench 1.7.0.54 loaded the Game module and completed compilation with no
script error lines, emitted `Script validation successful.`, and exited `0`.
That record is authoritative compile-stage evidence only. The separate V10 run
is [`docs/validation/2026-07-18-observer-enforce-mailbox-acceptance.json`](../docs/validation/2026-07-18-observer-enforce-mailbox-acceptance.json).
It passed fairness beyond one 256-file batch, real `FileShare.None` deletion
failures, 513-file reclamation and exact 512-file cap recovery, active-writer
preservation followed by exactly-once host delivery, and both quarantine bounds.
Both modules had zero script errors, Workbench exited `0`, and vacancy was `0/0`.

Explicit runtime views restore in two phases. The normal update stages the
original camera owner and state; the still-live observer entity then reapplies
and verifies that state from POSTFRAME, after gameplay camera updates. The
callback only records proof and disarms itself. Observer-entity destruction and
lease release occur on the following update, never from inside the entity's own
callback. Ownership or world drift remains fail-closed and cannot be promoted
to restoration success.

## Prepare, own, capture, restore, stop

Launch preparation is launcher-neutral and side-effect free with respect to
the game. Its structured `arguments` remain suitable for an external launcher;
the additional `preparedLaunchId` is an opaque handle for callers that opt into
the supported Windows lifecycle:

```json
{
  "action": "start",
  "preparedLaunchId": "<value from observer_prepare_launch>",
  "idempotencyKey": "<unique start key>"
}
```

The prepared descriptor is immutable, bound to its observer session and
profile, expiring, and one-shot. Start resolves an allowlisted graphical
executable beneath the configured `gamePath`, appends exactly one generated
`-reforgerForgeOwnerToken=...` token, and spawns it visibly with the original
arguments preserved token-for-token, `shell: false`, and the executable
directory as its working directory. It publishes a `runtimeId` only after the
spawned child has been verified by PID, canonical executable path, exact
Windows creation time, exact owner argument, and stable pre/post-spawn
executable file identity plus SHA-256. The atomic ownership receipt
also binds the session, `preparedLaunchId`, argument-array SHA-256, profile,
runtime kind, start time, and MCP installation/Windows-owner identity. If spawn
or inspection fails, the manager attempts to stop only its retained child and
does not publish a successful ownership receipt. If retained-child exit cannot
be proved, it preserves a distinct non-success pending record that grants no
PID-only recovery or termination authority.

Status reopens the receipt and exact process identity:

```json
{
  "action": "status",
  "runtimeId": "<owned runtime ID>"
}
```

The state is `running`, `exited`, `identity_mismatch`, `unverifiable`, or
`stale`. Matching a PID or executable name is insufficient. PID reuse,
executable-path drift, creation-time mismatch, or a missing/changed owner token
fails closed. `stale` reports that the observer session expired while the exact
process may remain owned; session expiry never causes an automatic stop.
Multiple runtimes remain independent under their own `runtimeId` receipts.

Prepared launches use one hashed session index, so replay never scans or parses
unrelated descriptors. The durable lifecycle store admits at most 16,384
records and 512 MiB by default, with a 128-MiB per-record ceiling. Completed
runtime clusters, cleanup-verified failed starts, and expired unused
preparations retain their retry evidence for 24 hours before an explicit or
shutdown sweep removes them. Live children, cleanup-pending stops,
cleanup-required starts, and any other unresolved exact-ownership obligation
are never evicted; capacity exhaustion fails closed and is visible through
bounded storage diagnostics. Admission also reserves the temporary-file peak
and the complete mutation headroom needed to publish later exact-exit and stop
evidence. The prepared-ID-keyed consumption receipt scopes a malformed live
record to its own lifecycle/session, so it does not stop independent
preparation or sweeping.

Capturing is a separate transaction. Inventory binds the runtime instance and
world; capture may acquire a camera lease; completion, cancellation, or failure
must reach terminal restoration. Only then should the caller request stop:

```json
{
  "action": "stop",
  "runtimeId": "<owned runtime ID>",
  "waitForRestorationMs": 20000,
  "idempotencyKey": "<unique stop key>"
}
```

Stop inspects the observer session for active jobs and camera leases. It may
wait up to `waitForRestorationMs`, but refuses with `CAMERA_BUSY` if terminal
restoration cannot be proved. It then reopens and reverifies the exact identity,
terminates only that verified process through the native handle backend, waits
for exact-process exit, proves the identity vacant, and preserves an idempotent
stop-result receipt. A successful restoration reservation seals the session
against new capture submissions. Each caller proposes an exclusive lease
generation; a competing caller cannot learn or release the incumbent lease.
The lease is persisted before native termination and retained after any
pre-signal failure, so recovery must reuse the same stop idempotency key. The
stop receipt records that proof; observer-session completion is separately
acknowledged and retried idempotently before stop reports success. It never
invokes `taskkill`, `Stop-Process`, process-name enumeration, PID-only
termination, or broad tree termination.

A restarted MCP may recover exact status for a persisted lifecycle receipt only
when it belongs to the same installation and Windows owner and every
executable, creation-time, PID, and owner-token identity field still matches.
If the new private agent does not know the old observer session, stopping after
restart additionally requires the durable restoration seal created during a
clean MCP shutdown. The old MCP writes that seal only after reserving the
session and proving there are no active jobs, camera leases, or pending
restoration. An unclean restart without that proof makes stop fail with
`SESSION_UNVERIFIABLE` and preserves the process for diagnosis. This
exact-match path is lifecycle recovery, not adoption of an arbitrary
pre-existing Arma process. Identity mismatch or unverifiable state is reported
and never signalled; unrelated Arma and Workbench processes remain untouched.

Successful receipts are the only restart-recoverable ownership authority.
Pending-start evidence is intentionally not adoptable: if the host dies in the
narrow interval after process creation but before its exact PID/creation record
is durable, recovery fails closed and an operator must handle that visible
process without PID/name automation. Executable file-ID and digest snapshots
detect stable or in-place replacement; as with trusted executable discovery,
they assume the configured game installation is not being maliciously
swap-and-restored during the exact process-creation interval.

## Using screenshots effectively

Configure one or more existing evidence destinations before finalizing:

```json
{
  "observer": {
    "evidenceRoots": ["C:\\path\\to\\project\\screenshots"],
    "supportingLogRoots": ["C:\\path\\to\\approved\\logs"]
  }
}
```

Begin a run before capturing. The host creates the run ID and keeps its raw
artifacts outside the project:

```json
{
  "action": "begin",
  "title": "RR-OBS-MACGUFFIN containment",
  "caseIds": ["RR-OBS-MACGUFFIN"],
  "sourceRevision": "<commit-or-working-tree-id>",
  "procedureRevision": "<procedure-revision>",
  "idempotencyKey": "rr-obs-macguffin-1"
}
```

Every capture requires its `runId` and a human-meaningful `captureLabel`.
Labels are normalized and must be unique within the run, so name them for the
claim they show rather than for an internal job ID.

Choose the view by what the image must prove:

| View | Use it for |
|---|---|
| `current` | Player camera, UI, an already-positioned validation camera, or the exact Workbench viewport |
| `lookAt` | A reproducible world overview using an explicit position, target, and FOV |
| `pose` | Replaying a known transform with a normalized quaternion |

For Workbench, take one successful `current` capture after each restart before
requesting `pose` or `lookAt`; that restoration proof enables
`camera.editor`. A settle value can reduce capture-time movement, but it does
not prove elapsed gameplay time. Use `performancePolicy="evidence"` normally.
`instrumented` deliberately marks the result contaminated and adds a warning;
`performance` is not a public capture policy because no external measurement
instrumentation exists.

Inventory first, select an explicit renderer, and bind the inventory's
`worldId` and `worldEpoch` into the request. Submission fails before camera
acquisition if either value changed. A runtime current-view request uses:

```json
{
  "runId": "<managed-run-id>",
  "captureLabel": "rr-obs-macguffin--runtime-current",
  "purpose": "Show the recovered runtime state",
  "sessionId": "<prepared-session-id>",
  "instanceId": "<selected-runtime-instance-id>",
  "expectedWorldId": "<inventory-world-id>",
  "expectedWorldEpoch": 3,
  "view": { "kind": "current" },
  "asynchronous": false,
  "timeoutMs": 30000,
  "settleFrames": 0,
  "performancePolicy": "evidence"
}
```

For Workbench, select its inventory `instanceId` and omit `sessionId`:

```json
{
  "runId": "<managed-run-id>",
  "captureLabel": "rr-obs-macguffin--editor-overview",
  "purpose": "Show the editor overview",
  "instanceId": "<selected-workbench-instance-id>",
  "expectedWorldId": "<inventory-world-id>",
  "expectedWorldEpoch": 0,
  "view": { "kind": "current" },
  "asynchronous": false,
  "timeoutMs": 30000,
  "settleFrames": 0,
  "performancePolicy": "evidence"
}
```

Synchronous capture remains best for interactive image review. A completed
capture proves a valid, world-bound image and terminal camera restoration; it
does not by itself prove the gameplay claim. `Passed` and `Failed` require
`imagesReviewed=true` and a stable reviewer identity. With unreviewed images,
use `Unreviewed` or `Inconclusive` instead. For an async
capture, poll `observer_job action="status"`, then use `action="read"` after it
completes. If the PNG exceeds the inline limit, leave it managed and finalize
the run; do not copy a private artifact path.

After an image-capable reviewer has inspected the selected captures, finalize
the run into an allowlisted root:

```json
{
  "action": "finalize",
  "runId": "<managed-run-id>",
  "evidenceRoot": "C:\\path\\to\\project\\screenshots",
  "includeCaptureLabels": [
    "rr-obs-macguffin--runtime-current",
    "rr-obs-macguffin--editor-overview"
  ],
  "review": {
    "imagesReviewed": true,
    "reviewer": "<stable-reviewer-id>",
    "outcome": "Passed",
    "summary": "Reviewed both bound world views."
  },
  "releaseManagedArtifacts": true
}
```

Finalization creates `<evidenceRoot>/<runId>/` with `RESULT.md`,
`manifest.json`, capture PNG/JSON pairs, and only supplied allowlisted logs or
sanitized runtime configuration. It never overwrites an existing directory.
The finalizer confines the destination to a configured root, rejects path and
link escapes, pins source artifacts during export, re-hashes the output, and
writes `manifest.json` last as the completion marker. A matching retry returns
the existing receipt, and managed artifacts are released only after verified
export. Optional `runtimeConfig` accepts only bounded structured scalar values
without secret-like keys. Optional `supportingFiles` accepts only bounded,
regular text `relevantLog` files beneath `supportingLogRoots`. Use `discard` for
a run that should produce no evidence bundle. On timeout or failure, cancel the
job and wait for terminal restoration before stopping an owned process.

## Opt-in graphical runtime screenshot acceptance

The Windows-only runtime harness performs an end-to-end screenshot transaction
against an installed graphical Diag executable. It maps the requested fixture
world to Reforger's `-server <world>` launch form and prepares the matching
`listenServer` observer contract, producing a visible graphical listen host.
It exercises the shared exact-owned lifecycle service and may stop only the
runtime whose full receipt identity it verified. It refuses to start while any
Arma Reforger or Workbench process exists. A direct live run requires both an
environment gate and an independent command-line confirmation:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:runtime -- --confirm-live-run
```

By default the harness uses the installed stock world
`{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent`. Its explicit pose uses position
`[96, 90, -5]`, a normalized quaternion aimed into the fixture, and a 58-degree
FOV. Its separate look-at view looks from `[64, 121, -40]` toward
`[64, 10, 100]` at 70 degrees. It loads no project add-on and creates every
managed, profile, diagnostic, and evidence root under an external temporary
artifact root. This keeps acceptance isolated from the current project. The
harness also finds a graphical Diag executable beneath the configured
`gamePath`. Confirmed optional settings include:

- `--addon-dir <directory>` for a fixture add-on containing exactly one
  `.gproj`; the harness derives its parent search root and add-on GUID for the
  launch.
- Repeated `--launch-arg <token>` arguments for additional launcher tokens, or
  `--executable <file>` to select the installed executable explicitly.
- `--pose-position`, `--pose-orientation`, and `--pose-fov` to override the
  normalized-quaternion pose for another fixture.
- `--look-at-position`, `--look-at-target`, and `--look-at-fov` to bind the
  look-at view to the fixture.
- `--marker-rgb` and optional normalized `--marker-roi` to require a
  deterministic color marker in the look-at capture.
- `--artifact-root` and `--timeout-ms` to select the external retained run root
  and bounded deadline. Run with `--help` for the complete syntax.

The harness stages managed and profile data beneath an external temporary run
root, begins a managed observer run, prepares the launch, and selects exactly
one healthy non-Workbench renderer advertising `render.capture` and
`camera.runtime`. It captures `initial-current`, `explicit-pose`,
`post-pose-restoration-current`, `explicit-look-at`, and
`post-look-at-restoration-current`, then validates:

- PNG structure, dimensions, digest, material variation, and exact
  instance/world/epoch binding for every image.
- The exact pose quaternion matrix, position, and FOV; the look-at position and
  FOV; and an independently acquired, released, and restoration-confirmed
  camera lease for each explicit mode.
- Proof after each explicit capture that the following current camera is no
  longer at that mode's displaced position. This intentionally permits normal
  player-camera motion between captures.
- Material image change from each mode's preceding current view and the
  configured look-at color marker when present. Each before/after-restoration
  pixel comparison is retained as diagnostic evidence but is not a pass/fail
  oracle: a restored live gameplay camera may legitimately rotate or move.
- Every finalized manifest member, byte count, SHA-256 attestation, capture
  label, and exported PNG against the already validated inline result.

Successful automation exports
`<artifact-root>/<run-directory>/evidence/<run-id>/` with `RESULT.md`,
`manifest.json`, `runtime-config.json`, and the five capture PNG/JSON pairs.
The manifest is deliberately finalized as `Unreviewed` with
`imagesReviewed=false`; automation cannot promote visual evidence to `Passed`.
Review the images and manifest and record the engine version before using the
bundle as qualification evidence.

On failure, the harness cancels unfinished jobs and requires terminal camera
restoration before discarding the managed run. If restoration cannot be
proven, it preserves the open run and managed artifacts for diagnosis instead.
It then stops only its exact-owned runtime after the restoration gate, closes
the host application, and proves process vacancy. It retains the external
`acceptance-summary.json`; no scratch data is written into a target project or
its `screenshots` directory. A successful run removes its exact owned managed,
profile, and diagnostic scratch, leaving only the summary and finalized
evidence.

The Vitest live entry is skipped unless both
`RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE=1` and
`RFO_CONFIRM_LIVE_RUNTIME_OBSERVER_ACCEPTANCE=1` are set. It uses the same
stock world by default; `RFO_RUNTIME_OBSERVER_WORLD` is an optional override.
Run it through `npm run test:observer:integration`.

Five-capture v2 automation passed on July 17, 2026 local (July 18 UTC) against
Reforger 1.7.0.54 and stock
`{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent`. Harness run `run-kUN6is`
finalized managed run `20260718T015727Z-cbe43230` with all five labels, exact
pose and look-at matrices/FOVs, independent lease restoration, material image
difference, and final process vacancy. All five images were visually inspected
during implementation. The finalized bundle deliberately remains `Unreviewed`
with `imagesReviewed=false`, so formal evidence review remains pending.

## Workbench adapter

The Workbench backend is implemented by five dedicated NET API handlers
(`ping`, `submit`, `status`, `cancel`, and `release`) plus their common
transaction implementation. Their canonical sources live in
`observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP`. The immutable
`ReforgerForgeWorkbenchHelper` package is digest-verified and staged beneath the
external observer managed root; its dedicated Workbench profile is external as
well. Target projects receive no MCP helper sources.

After changing any helper source or project file under
`observer/workbench-addon`, run `npm run observer:manifest` to regenerate the
compiled identity and source manifest, then run package verification. Before a
Workbench spawn, staging validates the helper role, identity, complete file set,
file hashes, and bundle digest; rejects target overlap with the managed root,
staged add-on, search root, or profile; and re-hashes the payload after copying
it into digest-addressed immutable external storage.

Workbench editor launches record the helper add-on ID, GUID, staged directory,
search root, bundle digest, build identity, and profile in the version-3
lifecycle. Editor readiness and reuse require `EMCP_WB_Ping` to return the exact
helper add-on ID, GUID, version, protocol, and build identity expected by the
current MCP build. A reachable NET API with a different helper identity is
refused. The target-build launch plan has no helper or NET-readiness capability.

Observer inventory and capture reuse the same long-lived client, canonical
`.gproj`, lifecycle generation, endpoint, and exact process identity. They do
not auto-launch Workbench, enter Play, execute menu actions, save, or reload
scripts.

The lifecycle canonical target is the exact mod `.gproj` supplied to the
Workbench process. `Workbench.GetCurrentGameProjectFile()` separately reports
the base-game settings project, so the handler does not equate those values: the
host proves the canonical target and the handler immutably binds it while also
tracking the nonempty base-project and editor world/subscene identities.

Every camera-changing transaction snapshots the native `BaseWorld` current
camera slot, full matrix, measured vertical FOV, read-only far plane, and
viewport dimensions. `BaseWorld` exposes no near-plane getter and the observer
does not mutate the near plane. Completion, cancellation, failure, release,
restart and shutdown must converge on exact slot/matrix/FOV
restoration. If the active slot, world, lifecycle, or requested camera state
changes unexpectedly, the adapter returns `RESTORATION_UNCONFIRMED`. The shared
controller's local writer gate blocks new managed reads and requires active
reads and capture restoration to drain before a lifecycle mutation proceeds.

A freshly started Workbench may advertise `render.capture` for current-view
captures, but it does not advertise `camera.editor` immediately. The exact
process must first finish a current-view transaction and prove restoration;
only then are explicit-pose and look-at requests eligible. Workbench produces a
native PNG for an extensionless, generated screenshot request beneath the
managed profile capture directory. The adapter confines and canonicalizes the
exact `.png`, validates its regular-file status, stable size, PNG
signature/structure and dimensions, computes SHA-256, and exposes those exact
bytes in the same one-image plus metadata MCP result as the runtime backend.

For project launch/build wrappers, use the packaged
`reforger-forge-workbench` foreground editor or bounded build command. It shares
the lifecycle and companion staging, so a project does not need its own
Workbench process guard. The target-build plan itself is helper-free, uses a
dedicated profile, and makes no NET call. At this pre-removal boundary, the
public build still holds one machine lock and absolute deadline across two exact
children: a managed-companion editor preflight proves endpoint/Ping identity and
post-termination endpoint vacancy before the distinct target-only child starts.
Its version-3 receipt keeps the preflight and build PIDs, generations, and
attributed log directories distinct and requires a fresh nonempty
`resourceDatabase.rdb` for success from a caller-exclusive unique empty output
root. It also binds the project and output-database SHA-256 values. Timeout,
nonzero exit, and output-attestation failure remain machine-readable without
being promoted to success. Removing the preflight and changing the public
receipt to version 4 remain gated on two consecutive controlled target-only
Workbench acceptance runs and green hermetic contracts.

Installed Workbench 1.7.0.54 successfully dispatches the guarded build with the
exact sequence
`-wbModule=ResourceManager -builddata PC <fresh-output> <AddonName>`, with the
`-builddata` token in lowercase and no target `-run`.
The path was verified with qualified fresh output on 2026-07-18. The wrapper
still fails closed when output proof is absent; child launch and a zero exit
alone are never evidence of a completed Resource Manager build.

## Opt-in Workbench screenshot acceptance

The separate Workbench harness creates a disposable project outside the
repository, explicitly launches a visible Workbench through the exact-owner
lifecycle coordinator, and opens a disposable editor world. Observer inventory
and capture themselves still never auto-launch the editor. The harness refuses
to start while any Arma Reforger or Workbench process exists. A live run
requires both confirmations:

```powershell
$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:workbench -- --confirm-live-run
```

The harness reads machine paths only from the gitignored
`reforger-forge.config.json`. Optional `--artifact-root` and `--timeout-ms`
arguments control the retained evidence location and deadline. It creates a
run-specific `Worlds/ObserverAcceptance.ent` inheriting stock Everon and captures
`initial-current`, `explicit-pose`, `post-pose-restoration-current`,
`explicit-look-at`, and `post-look-at-restoration-current`. Both explicit views
are derived from the baseline and must differ materially from their preceding
current views. The harness verifies their exact matrices and FOVs, exact
post-view restoration of camera owner/matrix/FOV/world identity, native PNG
material variation, lease release, clean-target invariance, exact-owner
shutdown, and final process vacancy.
The Vitest live entry is additionally skipped unless
`RFO_CONFIRM_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE=1` is set.

Five-capture v3 automation passed on July 17, 2026 local (July 18 UTC) with
Workbench engine 1.7.0.54. Harness run `run-wzuGy6` finalized managed run
`20260718T015947Z-6ec8429d` from
disposable world `{71D11CE993734B08}Worlds/ObserverAcceptance.ent`, inheriting
stock Everon `{853E92315D1D9EFE}worlds/Eden/Eden.ent`. Workbench loaded the
staged helper with digest
`db44e43be9ec4249c23e55c0d1f19a1fb6cf72d6800c4540e938773d729d1eed`.
Both explicit captures were materially different and matched their exact
requested matrices/FOVs; both following current captures proved exact
restoration. Finalization had no warnings, the target stayed clean, exact-owner
shutdown left zero Workbench processes, and all five images were visually
inspected at original resolution. The finalized manifest remains unmodified
with `Unreviewed`/`imagesReviewed=false`; the separate
[hash-bound formal review](../docs/validation/2026-07-19-workbench-observer-evidence-review.json)
records a `Passed` outcome, the Workbench 1.7.0.54 version, warning,
limitations, and successful verification of every exported hash. The companion
editor path is live-qualified for this reviewed procedure.

## Capability status

The host protocol, staging, launch preparation, registration, transports, jobs,
artifact validation, runtime camera transaction, and Workbench adapter all have
hermetic regression coverage. Runtime compile gates
`RENDER_CAPTURE_PROVEN` and `CAMERA_RESTORE_PROVEN` are enabled. That enables the
implemented paths; it is not a substitute for recording a successful live run.

| Case | Implemented behavior | Capability advertisement | Live validation |
|---|---|---|---|
| Graphical runtime client/listen host | REST and mailbox delivery, current/pose/look-at PNG capture, camera lease and exact transform/FOV restoration | `render.capture` and `camera.runtime` only after graphical renderer/camera initialization | Five-capture v2 automation passed against Reforger 1.7.0.54 stock `MpTest`; formal bundle review remains pending |
| Dedicated/headless server | Registration, health, authority facts, coordination, and diagnostics without camera/render claims | Never advertises `render.capture` or a camera capability | Pending non-render qualification |
| Minimized/out-of-focus client | Same transaction path; `-forceUpdate` remains an explicit launch-preparation option | Same initialized graphical gates | Pending |
| World unload or agent loss during a lease | World epochs invalidate stale work; cancellation/watchdog restoration must reach a terminal state | Renderer is withheld when restoration or world identity is uncertain | Pending failure-injection qualification |
| Workbench editor | Externally staged helper, exact Ping identity, dedicated profile, version-3 lifecycle, confined native-PNG validation, activity gating, and exact `BaseWorld` slot/matrix/FOV restoration | `render.capture` when current capture is initialized; `camera.editor` only after a current-view restoration proof in that exact process | Five-capture v3 automation and hash-bound formal image review passed in a disposable stock-Everon-derived world on Workbench 1.7.0.54, with clean-target and exact-owner-shutdown proof |

**Live validation status:** fresh five-capture automation passed for both the
graphical stock-`MpTest` listen host and the companion-based Workbench editor as
recorded above. The Workbench export now has a hash-bound formal `Passed` image
review; the graphical runtime export remains pending formal review. Both source
manifests retain their finalized `Unreviewed` metadata. Dedicated and headless
non-render behavior, minimized/out-of-focus rendering, world-unload or
agent-loss failure injection, and remote/delegated rendering remain outside
current live proof.

Real-engine tests belong under `tests/observer/integration` and run only through `npm run test:observer:integration` with disposable profiles and target projects.
