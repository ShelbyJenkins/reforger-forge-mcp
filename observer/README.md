# ReforgerForge Observer Platform

This directory contains the Observer runtime add-on, private local agent,
Workbench helper, and shared protocol. The public MCP orchestration lives in
`src/observer`; companion staging and managed state remain outside target mod
projects.

This is the technical design and maintainer reference. For the operator capture
workflow, see [docs/observer.md](../docs/observer.md). For installation and
configuration, see [SETUP.md](../SETUP.md). Coding-agent API notes belong in
[agents/AGENTS.md](../agents/AGENTS.md).

## Architecture

Observer has five cooperating parts:

| Component | Location | Responsibility |
|---|---|---|
| MCP host and orchestration | `src/observer` | Registers the public tools; owns capture routing, runs, jobs, idempotency, promotion, cancellation, and orderly shutdown. |
| Private local agent | `observer/agent` | Runs as a disposable child with an inherited JSON IPC channel; owns runtime session, transport, artifact, and mailbox services. |
| Runtime companion | `observer/addon` | Registers an instrumented graphical runtime with the private agent and performs capability-gated capture work. |
| Workbench helper | `observer/workbench-addon` | Supplies the protected Workbench NET API adapter for inventory, capture, job status, cancellation, and release. |
| Protocol | `observer/protocol` | Defines the versioned vocabulary and generated artifacts shared by host, private agent, and both Enfusion companions. |

The host creates one Observer application. It starts the private child lazily,
passes it an ephemeral loopback runtime port, and asks it to shut down when the
MCP transport closes. The child exits when its parent IPC channel disappears;
another MCP instance never adopts it.

```text
MCP client
  -> MCP host / ObserverApplication
       -> private child (loopback runtime control + mailbox fallback)
            -> staged runtime companion
       -> shared WorkbenchSessionController
            -> staged Workbench helper
```

Runtime and Workbench backends share one host capture service. The service owns
the public job ID, deadline, idempotency key, run binding, artifact promotion,
cancellation, and release behavior. Backends must not create parallel capture
or process-lifecycle ownership systems.

## Safety and ownership model

- Packaged companion add-ons are immutable inputs. They are verified and staged
  under the Observer managed root, never inside a target project.
- Launch preparation is data-only: it returns a structured argument array and
  never invokes Steam, Enfusion, Workbench, PowerShell, or a shell.
- An Observer profile is an exclusive outer directory passed unchanged to
  `-profile`; Enfusion maps `$profile:` to its physical `profile` child. The
  activation contract is confined to that child.
- A runtime companion is dormant without a valid, unexpired activation contract.
  It accepts neither arbitrary network endpoints nor arbitrary output paths.
- The private agent binds loopback only. Runtime session tokens cannot invoke
  control operations.
- Inventory PIDs are diagnostic only. Preparation and capture never adopt,
  signal, or terminate a pre-existing game process.
- The optional managed lifecycle can affect only a process it started and
  verified through the exact PID, canonical executable path, Windows creation
  time, generated owner argument, and executable identity evidence.
- A lifecycle mismatch, missing proof, or unclean-restart condition fails
  closed. Observer never substitutes a process name, PID-only stop, shell,
  `taskkill`, broad process tree, or unrelated Arma/Workbench process.
- Camera-changing work is not terminal until exact camera restoration is proven.
  A restoration failure is never presented as a successful capture.
- Workbench capture reuses the existing `WorkbenchSessionController`, lifecycle
  lease, local reader/writer gate, and external managed profile. It does not
  create a second Workbench owner or add helper sources to a target project.

On Windows, lifecycle records inherit the ACL of the configured Observer
managed root. A custom `observer.managedRoot` must be a current-user-private
directory, not a shared or broadly writable location.

## Public MCP contract

Observer exposes ten related `observer_*` primitives plus the separate
`game_launch` owned composite. Their client-facing descriptions and input
schemas are the authoritative API surface; the operator call order is in
[docs/observer.md](../docs/observer.md).

| Tool | Contract boundary |
|---|---|
| `game_launch` | Resolves canonical project/world/add-on/executable evidence and delegates start/status/stop only to the exact-owned runtime manager. |
| `observer_setup` | Stages, inspects, or removes managed companions without launching or signaling an Arma Reforger or Workbench process. |
| `observer_prepare_launch` | Resolves a canonical executable path and creates an expiring runtime activation session with structured arguments, without starting the runtime. |
| `observer_runtime` | Explicitly starts, inspects, or restoration-gated stops an exact-owned graphical runtime on Windows. |
| `observer_instances` | Reports live or stale renderers, capabilities, world identity, health, and active work. |
| `observer_capture` | Submits a current, pose, or look-at transaction, optionally attached to an active or explicit managed run. |
| `observer_job` | Reads status, validated inline output, cancellation, and release state for a capture job. |
| `observer_run_begin` | Begins a bounded managed evidence run and activates it in the current MCP process. |
| `observer_run_status` | Inspects an explicit run or the process-local active run. |
| `observer_run_finalize` | Finalizes reviewed capture labels from an explicit or active run. |
| `observer_run_discard` | Discards an explicit or active unfinalized run. |

`observer_instances` projects an opaque, versioned capture target for each
renderer. A target binds the backend, exact instance, runtime session when
applicable, and world revision; it is mutually exclusive with the legacy
`sessionId`/`instanceId`/`expectedWorldRevision` fields. With no selection
fields, capture delegates only when exactly one compatible renderer exists.

`observer_job` takes only an action and job ID; backend and session authority
remain in the retained internal reference. A runtime must advertise
`render.capture` for `current`; `pose` and `lookAt` additionally require
`camera.runtime`. Workbench explicit views require `camera.editor`. When the
exact editor exposes restoration support but has not yet proven that capability,
the host primes it with one internal runless current capture, releases it, and
re-inventories the same lifecycle before submitting the requested view.

Public runtime start/stop calls do not accept idempotency keys. The host derives
stable operation keys from the exact prepared launch or owned runtime identity,
so a lost response can be retried without creating a second lifecycle command.
The composite defaults to one initial `listenServer` family for a derived
project profile and accepts `client` explicitly. Its first preparation is
serialized by the manager's machine-wide lifecycle mutex; equal in-process
requests join one mutation. The retained world, add-on, and executable snapshots
are re-attested immediately before consumption. An unconsumed mismatch records
an invalidation before session revocation; an unknown post-consumption result
never authorizes revocation. This baseline has no successor index, so changed,
terminal, stale, expired, or invalidated evidence refuses instead of relaunching.
Runless capture delivery automatically attempts release; cleanup failure stays
visible through a retained job handle and `cleanupRequired` diagnostics.

## Configuration and managed roots

Observer configuration is supplied only through an explicitly selected partial
config or the corresponding `--observer-*` flags. It does not discover
package-local/home configuration files or read environment variables for
installed-MCP settings.
CLI flags override the selected file; paths in that file resolve relative to the
file, while CLI paths resolve from the MCP process working directory.

The configuration reference and first-use recovery procedures are in
[SETUP.md](../SETUP.md). Key implementation properties are:

- `observer.managedRoot` holds private staged companions, lifecycle records,
  and managed working state.
- `observer.profileRoot` constrains all Observer-owned profile directories.
- `observer.evidenceRoots` is an allowlist. Capture and run creation work
  without it, but finalization fails with `CAPABILITY_UNAVAILABLE`.
- `observer.supportingLogRoots` is a separate allowlist for explicit-path text
  logs, including external launches. Exact-owned runtime logs use a private
  capture grant and do not add managed profiles to this allowlist.
- `observer.defaultLossyImageQuality` defaults JPEG and WebP to 75;
  `minimumLossyImageQuality` and `maximumLossyImageQuality` bound caller
  overrides.
- `observer_setup action="doctor"` and the installed agent's `doctor` command
  are read-only: they do not create roots, stage files, load stores, or start a
  private child.

## Runtime transport and lifecycle design

Launch preparation produces a one-shot, immutable descriptor bound to an
Observer session, profile, and expiration. The descriptor contains one merged
`-addonsDir`, one merged `-addons`, the matching `-profile`, a session-specific
relative `-logsDir`, and defaults for `-forceUpdate` and `-noFocus` unless
callers opt out. Caller-supplied `-logsDir` values are refused. Graphical
launches use the engine's native borderless fullscreen by default. Raw
`-window`, `-screenWidth`, and `-screenHeight` tokens are refused;
`forceNonNativeWindowSize` is the exceptional opt-out and requires bounded
dimensions plus a meaningful justification. Capture size belongs in
`observer_capture.image`, not in the launch window.

The optional Windows runtime manager resolves an allowlisted graphical
executable beneath the configured game path and uses a visible direct spawn
without a shell. It publishes a `runtimeId` only after the child has passed
exact process identity verification. For graphical `-noFocus` launches it also
guards Reforger's replacement startup windows against activation, then restores
their original styles so they remain normally focusable after initialization.
A failed start leaves no successful
ownership receipt; a retained child whose exit cannot be proved remains a
non-success pending record without PID-only cleanup authority.

`game_launch` builds `-world <resource>` for `client` and `-server <resource>`
for `listenServer`. It rejects caller-owned `-world`, `-server`, `-addons`,
`-addonsDir`, profile, display, observer-policy, and owner-token arguments. Its
dependency scan includes configured roots, the target's parent, installation
add-ons, and the derived profile add-ons, and refuses missing or ambiguous
providers. The point-of-use check cannot lock project files against unrelated
writers after it returns; the manager's independent spawn-time executable
identity check remains authoritative for the executable.

Runtime registration uses acknowledged loopback REST delivery with a confined
mailbox fallback. Session registration, heartbeats, job idempotency, artifact
completion, and release receipts are replay-safe. The host validates each
finished source image as a regular file with stable size, valid structure and
dimensions, digest, and session/job binding. It then uses the pinned
`@napi-rs/image` encoder to apply optional fit-inside bounds and PNG, JPEG, or
WebP output before retaining the artifact.

Stopping an exact-owned runtime first reserves restoration, rejects new capture
submissions, verifies that jobs and camera leases can become terminal, and then
re-verifies exact process identity immediately before native termination. A
restart can recover only an exact matching persisted receipt belonging to the
same MCP installation and Windows owner. Without the required clean-shutdown
restoration seal, post-restart stop remains `SESSION_UNVERIFIABLE` rather than
adopting an uncertain process.

## Capture, artifacts, and evidence runs

The capture service rejects stale, unhealthy, or capability-incompatible
instances before a camera lease is acquired. A request binds the selected
instance to its required opaque world revision. Completion, cancellation,
failure, release, and managed shutdown converge on a terminal restoration
disposition. Runtime requires exact restoration. Workbench also permits a
terminal, restoration-unconfirmed job to relinquish its lease without a camera
write when a newer editor world, context, or camera state definitively displaced
the installed state; that result remains a failed capture, but its retired
handler reference can be released.

Synchronous capture returns one host-validated image and concise metadata only
when it fits the configured inline limit. Larger artifacts remain in managed
storage and can be exported through the evidence-run finalizer. Private managed
paths are never published to clients.

An evidence run is backend-neutral. Finalization confines output to an
allowlisted evidence root, rejects path/link escapes, pins artifacts while
exporting, hashes bundle members, writes `manifest.json` last, and never
overwrites an existing run directory. It accepts only bounded structured
runtime configuration and bounded regular text logs. Explicit paths remain
confined to configured supporting-log roots. A semantic capture reference can
resolve only the completed, selected runtime capture's private durable grant,
which binds its session and exact-owned runtime generation to the assigned
`script.log`; the managed profile root is never globally admitted. Both forms
share regular-file, link, identity, size, UTF-8, redaction, copying, and hashing
checks. A matching retry returns its existing receipt; managed artifacts
release only after verified export.

## Workbench adapter design

The Workbench backend consists of five protected NET API handlers: `ping`,
`submit`, `status`, `cancel`, and `release`. Their canonical Enforce sources
are under `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP`.

Before launch, the host verifies the helper role, identity, full file set,
individual hashes, and bundle digest. It stages a digest-addressed immutable
copy beneath the external managed root and gives Workbench a dedicated external
profile. Editor readiness requires `EMCP_WB_Ping` to return the exact helper
add-on ID, GUID, version, protocol, and build identity expected by the active
MCP build. A reachable NET API with a different helper is refused.

The adapter uses the same long-lived Workbench client, canonical target `.gproj`,
lifecycle generation, endpoint, and exact process identity as `wb_*` tools. It
does not auto-launch Workbench, enter Play, run arbitrary menu commands, save,
or reload scripts. The lifecycle canonical target is the requested mod project;
the base-game project returned by `Workbench.GetCurrentGameProjectFile()` is
tracked separately.

Each camera-changing transaction snapshots the native `BaseWorld` camera slot,
full matrix, measured vertical FOV, read-only far plane, and viewport dimensions.
The API has no near-plane getter, so Observer does not mutate the near plane.
Unexpected world, lifecycle, slot, or camera drift returns
`RESTORATION_UNCONFIRMED`. Native PNG output is confined under the managed
profile, validated, then optionally resized or converted before it enters the
shared retained-artifact contract.

The helper contains default-inert acceptance hooks for maintainer failure
testing. They are not general editor commands, public Observer capabilities, or
runtime configuration.

## Mailbox and retention behavior

The private agent sweeps ownership stores every second and on controlled
shutdown. By default, revoked session tombstones remain replayable for five
minutes, terminal jobs and idempotency receipts for ten minutes, and stale
instances for five minutes after the liveness threshold. Nonterminal or
restoration-pending jobs, runtime stop reservations, and captures retained by
an open evidence run pin their records.

The mailbox is a supported fallback with bounded, replay-safe dispositions.
Permanent rejections use an exact idempotent quarantine target; transient
failures have an eight-attempt, 30-second budget. Polling rotates beyond a
256-file batch so one locked file cannot starve subsequent work. Quarantine
retains at most 128 records, 4 MiB, and 24 hours of evidence; aggregate mailbox
state is capped at 64 MiB. Orphan reclamation is serialized with publication,
and markerless active-writer data is never deleted.

## Protocol, build, and maintainer validation

After changing canonical Observer protocol vocabulary, regenerate the protocol
artifacts and source manifests before validating. The protocol-only check needs
no Workbench installation; the controlled checks require an explicit config and
use isolated temporary profiles.

```powershell
npm run observer:generate
npm run protocol:check
npm run observer:manifest:check
npm run build
npm run observer:validate:enforce -- --protocol-only --target both
npm run observer:validate:enforce -- --config <CONFIG_PATH> --target both
npm run observer:acceptance:enforce-mailbox -- --config <CONFIG_PATH>
```

`observer:validate:enforce` checks source, descriptor, generated C, and
consumer drift before any compiler launch. The controlled commands refuse an
already-running Workbench, accept explicit `--workbench` and repeated
`--addons-dir` overrides for that process only, and write sanitized output.
`observer:acceptance:enforce-mailbox` additionally checks the built host
modules, compiles both Game and WorkbenchGame, exercises the mailbox cases, and
proves final Workbench vacancy.

For private-agent maintenance, these commands are also available after a build:

```text
node dist/observer/agent/index.js --version
node dist/observer/agent/index.js serve
node dist/observer/agent/index.js stage
node dist/observer/agent/index.js doctor
node dist/observer/agent/index.js prepare-launch --agent-descriptor live-agent.json --request request.json
```

`serve` emits one bounded startup descriptor to stdout and operational logs to
stderr. Loopback control HTTP is disabled unless `--control-http` is explicitly
provided; in-process control remains available to wrappers.

Live runtime and Workbench acceptance harnesses are opt-in repository checks.
They require explicit configuration and both an environment authorization gate
and command-line confirmation. They must run only against a controlled machine
with no unrelated Arma Reforger or Workbench processes. Consult each command's
`--help` before running it:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:runtime -- --config <CONFIG_PATH> --confirm-live-run
npm run dev:observer:acceptance:runtime -- --config <CONFIG_PATH> --runtime-kind client --confirm-live-run

$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = '1'
npm run dev:observer:acceptance:workbench -- --config <CONFIG_PATH> --confirm-live-run
```

The runtime harness invokes the public `game_launch` start/status/stop handler
against a project-contained `.ent` fixture. Run the listen-server and client
commands as separate invocations so each receives a fresh managed/profile root
and MCP lifecycle; this baseline deliberately cannot create a same-profile
successor.

`npm run test:observer:integration` is reserved for the harmless exact-owned
runtime native fixture; it does not launch Arma Reforger or Workbench.

## Technical troubleshooting

| Symptom | Inspect first | Safe response |
|---|---|---|
| Companion staging fails | `observer_setup action="doctor"`, managed-root ACLs, and package integrity | Correct explicit configuration or package state; do not manually place helper files in a mod. |
| Workbench ping has a wrong helper identity | Active helper ID/GUID/version/protocol/build identity and lifecycle target | Close or diagnose the mismatched session, then launch the exact target through the managed Workbench path. |
| A capture remains nonterminal | Job state, active camera lease, selected renderer health, and world identity | Cancel through `observer_job`. Preserve runtime or active-lease state until restoration is proved; a Workbench job may instead become terminal with `cameraLeaseHeld=false` after safe no-write relinquishment. |
| `RESTORATION_UNCONFIRMED` | Camera slot/matrix/FOV, active world, lifecycle generation, lease flag, and error receipt | Treat it as a hard failure and never promote it as successful evidence. Retain and retry while `cameraLeaseHeld=true`; a terminal Workbench record with `cameraLeaseHeld=false` may be released because the displaced lease was already relinquished. |
| Runtime lifecycle is `identity_mismatch`, `unverifiable`, or `stale` | Persisted receipt, executable identity, creation time, owner argument, MCP installation, and Windows owner | Preserve the process and receipt; never use PID/name-based termination. |
| Mailbox is backlogged | Store diagnostics, quarantine disposition, lock/retry state, and quota | Fix the underlying storage or access condition. Do not delete markerless active-writer data. |
| Finalization cannot write evidence | Configured evidence roots, selected root, path confinement, and supporting-log allowlist | Fix configuration or choose an allowlisted destination. Capture and discard remain usable without an exporter root. |
| Helper source changes are not accepted | Generated protocol, source manifests, and package verification | Regenerate with `observer:generate` and `observer:manifest`, then run the relevant validation gate. |

## Capability boundaries

| Backend | Current-view condition | Explicit-view condition |
|---|---|---|
| Graphical runtime | Advertises `render.capture` after healthy graphical initialization. | Requires dynamic `camera.runtime` leaseability proof. |
| Dedicated/headless runtime | Does not advertise `render.capture`. | No camera capability. |
| Workbench editor | Exposes `render.capture` when the staged helper and current capture path are ready. | Requires a successful current-view restoration proof in that exact editor process, then advertises `camera.editor`. |

The public capability advertisement is authoritative at the time of inventory.
Do not infer explicit camera capability from an instance type, a PID, or a prior
run.
