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
- Runtime process IDs are diagnostic only; the observer never adopts, signals, restarts, or terminates a game process.
- MCP tools remain thin orchestration over one lazy private child; they do not duplicate staging, job, artifact, camera, or game-process behavior.
- Workbench capture reuses the existing shared `WorkbenchClient`, lifecycle
  lease, activity gate, and managed handler transaction. It never creates a
  parallel Workbench owner.

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

The MCP server lazily forks `dist/observer/agent/private-child.js` with an
inherited JSON IPC channel and an ephemeral loopback runtime port. The child is
never adopted by another MCP, exits on parent-channel loss, and is asked to
shut down when the MCP transport closes. The public surface is exactly five MCP
tools:

- `observer_setup` verifies/stages the immutable companion addon, reports
  status or diagnostics, and performs restoration-aware managed uninstall.
- `observer_prepare_launch` creates an expiring activation session and merges
  the observer into a caller-supplied launch argument array without spawning a
  process.
- `observer_instances` inventories runtime and already-running exact-owned
  Workbench renderers, including capabilities, health, world identity, and any
  active job.
- `observer_capture` submits current-view, explicit-pose, or look-at work. Sync
  mode returns exactly one validated PNG image followed by one metadata text
  item; async mode returns a job ID.
- `observer_job` reads status, requests cancellation/restoration, or releases a
  retained managed artifact.

Synchronous capture embeds one host-validated PNG plus concise metadata when it
fits the configured inline limit. Oversized artifacts remain retained and the
error includes the job identity so the caller can inspect or release it.

Runtime sessions support acknowledged REST delivery with a confined mailbox
fallback. Registration, heartbeats, job idempotency, artifact completion, and
release receipts are bounded and replay-safe. A job is never reported complete
until the host has validated the regular PNG file, dimensions, stable size,
digest, and session/job binding. Status and doctor remain non-mutating while the
private child is idle.

## Using screenshots effectively today

Use synchronous capture for evidence. It is the only current public path that
returns the validated image bytes to the MCP client. Async capture is useful for
status and cancellation, but `observer_job` does not yet have an image-read
action. Likewise, an image over the configured inline limit remains managed but
cannot currently be exported through a public tool. Do not treat either case as
retained evidence.

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
`performance` is exposed by the current schema but rejected because no external
measurement coordinator exists.

Inventory first, select an explicit renderer, and capture soon afterward. The
current input cannot lock the inventory's expected `worldId` and `worldEpoch`,
so re-inventory after a world transition and reject evidence whose completed
metadata does not match the intended world. A runtime current-view request uses:

```json
{
  "sessionId": "<prepared-session-id>",
  "instanceId": "<selected-runtime-instance-id>",
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
  "instanceId": "<selected-workbench-instance-id>",
  "view": { "kind": "current" },
  "asynchronous": false,
  "timeoutMs": 30000,
  "settleFrames": 0,
  "performancePolicy": "evidence"
}
```

Inspect the returned image itself. Keep raw or rejected working material in the
external observer managed root or another external temporary directory, never
in a target project or Git worktree. After review, retain only the selected PNG
and binding metadata in the owning evidence directory, then call
`observer_job` with `action="release"`. On timeout or failure, cancel and wait
for a terminal restoration result before stopping an owned process.

The planned run IDs, capture labels, expected-world binding, async/oversized
retrieval, standardized evidence export, and full scratch retention are defined
in the [companion and evidence implementation guide](../docs/plans/2026-07-17-observer-companion-evidence-workflow.md).

## Workbench adapter

The Workbench backend is implemented by five dedicated NET API handlers
(`ping`, `submit`, `status`, `cancel`, and `release`) plus their common
transaction implementation. The handler bundle is installed only by the
existing Workbench lifecycle transaction. Observer inventory and capture reuse
the same long-lived client, canonical `.gproj`, lifecycle generation, endpoint,
and exact process identity. They do not auto-launch Workbench, enter Play,
execute menu actions, save, or reload scripts.

The lifecycle canonical target is the exact mod `.gproj` supplied to the
Workbench process. `Workbench.GetCurrentGameProjectFile()` separately reports
the base-game settings project, so the handler does not equate those values: the
host proves the canonical target and the handler immutably binds it while also
tracking the nonempty base-project and editor world/subscene identities.

Every camera-changing transaction snapshots the native `BaseWorld` current
camera slot, full matrix, measured vertical FOV, read-only far plane, and
viewport dimensions. `BaseWorld` exposes no near-plane getter and the observer
does not mutate the near plane. Completion, cancellation, failure, release,
restart, shutdown, and cleanup must converge on exact slot/matrix/FOV
restoration. If the active slot, world, lifecycle, or requested camera state
changes unexpectedly, the adapter returns `RESTORATION_UNCONFIRMED` and the
shared activity gate blocks lifecycle mutation.

A freshly started Workbench may advertise `render.capture` for current-view
captures, but it does not advertise `camera.editor` immediately. The exact
process must first finish a current-view transaction and prove restoration;
only then are explicit-pose and look-at requests eligible. Workbench produces a
native PNG for an extensionless, generated screenshot request beneath the
managed profile capture directory. The adapter confines and canonicalizes the
exact `.png`, validates its regular-file status, stable size, PNG
signature/structure and dimensions, computes SHA-256, and exposes those exact
bytes in the same one-image plus metadata MCP result as the runtime backend.

## Opt-in Workbench screenshot acceptance

The separate Workbench harness creates a disposable project outside the
repository, explicitly launches a visible Workbench through the exact-owner
lifecycle coordinator, and opens a disposable editor world. Observer inventory
and capture themselves still never auto-launch the editor. The harness refuses
to start while any Arma Reforger or Workbench process exists. A live run
requires both confirmations:

```powershell
$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
npm run observer:acceptance:workbench -- --confirm-live-run
```

The harness reads machine paths only from the gitignored
`reforger-forge.config.json`. Optional `--artifact-root` and `--timeout-ms`
arguments control the retained evidence location and deadline. It captures an
initial current view, a baseline-derived explicit pose, and a post-restoration
current view; independently validates PNG material variation; compares the
camera matrix, FOV, owner, and world identity; restores all leases; shuts down
only its exact Workbench owner; and then removes the managed handler bundle.
The Vitest live entry is additionally skipped unless
`RFO_CONFIRM_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE=1` is set.

Reviewed live proof: run `run-owDNnE` produced three materially varied native
1165x641 PNGs: `initial-current.png`
(`b70ee2343ea330eefcedd2fae6465385f7e8740d1812fb72dbfae4d0c2707d23`),
`explicit-pose.png`
(`ee09b489f4bae2531d2c4d02a0b0819efd4137e7d2fc423c843d936ed40f7af8`),
and `post-restoration-current.png`
(`084844713cbfcc845fca4742abd3fcbf1ead885cefb13e169b0afad6633fc087`).
Every capture reported a held submit lease and confirmed restoration. The exact
lifecycle owner shut down, the process inventory was empty afterward, and
cleanup removed the unchanged managed handlers while reporting no modified or
unrelated files. The explicit pose displaced the camera by `(75, 25, 50)`
world units and added 10 degrees of vertical FOV. Its retained summary is
`run-owDNnE/evidence/summary.json`
outside the repository.

## Capability status

The host protocol, staging, launch preparation, registration, transports, jobs,
artifact validation, runtime camera transaction, and Workbench adapter all have
hermetic regression coverage. Runtime compile gates
`RENDER_CAPTURE_PROVEN` and `CAMERA_RESTORE_PROVEN` are enabled. That enables the
implemented paths; it is not a substitute for recording a successful live run.

| Case | Implemented behavior | Capability advertisement | Live validation |
|---|---|---|---|
| Graphical runtime client/listen host | REST and mailbox delivery, current/pose/look-at PNG capture, camera lease and exact transform/FOV restoration | `render.capture` and `camera.runtime` only after graphical renderer/camera initialization | Pending generic listen-host qualification |
| Dedicated/headless server | Registration, health, authority facts, coordination, and diagnostics without camera/render claims | Never advertises `render.capture` or a camera capability | Pending non-render qualification |
| Minimized/out-of-focus client | Same transaction path; `-forceUpdate` remains an explicit launch-preparation option | Same initialized graphical gates | Pending |
| World unload or agent loss during a lease | World epochs invalidate stale work; cancellation/watchdog restoration must reach a terminal state | Renderer is withheld when restoration or world identity is uncertain | Pending failure-injection qualification |
| Workbench editor | Dedicated NET API adapter, confined native-PNG validation, lifecycle activity gating, and exact `BaseWorld` slot/matrix/FOV restoration | `render.capture` when current capture is initialized; `camera.editor` only after a current-view restoration proof in that exact process | Passed in run `run-owDNnE`, including displaced explicit pose, exact restoration/shutdown, and managed cleanup |

**Live validation status:** the double-gated Workbench screenshot transaction
passed and its retained images were reviewed as recorded above. Dedicated and
headless non-render behavior, minimized/out-of-focus rendering, world-unload or
agent-loss failure injection, generic listen-host operation, and
remote/delegated rendering remain outside this live proof.

Real-engine tests belong under `tests/observer/integration` and run only through `npm run test:observer:integration` with disposable profiles and target projects.
