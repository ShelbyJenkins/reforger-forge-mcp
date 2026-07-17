# Observer Companion Add-on and Evidence Workflow Implementation Guide

**Date:** 2026-07-17  
**Status:** Proposed, implementation-ready  
**Scope:** Workbench bridge deployment, Workbench process ownership, observer
capture usability, managed run storage, and curated evidence export

## Outcome

Implement one MCP-owned observation platform with three properties:

1. Workbench-only EnforceScript handlers load from an immutable companion
   add-on outside every target project.
2. All Workbench launch paths use one exact-process lifecycle implementation
   instead of project-local locks and owner markers.
3. Screenshots, profiles, logs, and other working material remain in external
   managed storage until a run finalizer exports a small, reviewed evidence
   bundle.

The target project must not gain `Scripts/WorkbenchGame/EnfusionMCP`, test
profiles, cloned repositories, archives, probe logs, or raw run directories as
a side effect of MCP use.

## Why this is the right boundary

The MCP server can connect directly to Workbench's NET API over TCP. The NET API
does not directly expose every required `WorldEditorAPI` operation, so the
`EMCP_WB_*.c` handlers still have to execute inside Workbench. That requirement
does not imply that the handlers have to live inside the project being edited.

Keep responsibilities split as follows:

| Responsibility | Owner |
|---|---|
| Validate requests, select instances, own jobs, retain artifacts, finalize runs | TypeScript host/private observer agent |
| Serialize NET API requests and call `WorldEditorAPI` | WorkbenchGame EnforceScript in the managed Workbench helper add-on |
| Capture a running game's renderer and restore its camera | Game EnforceScript in the managed runtime observer add-on |
| Prove and terminate an exact Workbench process | Shared MCP Workbench lifecycle guard |
| Decide whether an image proves a gameplay claim | Image-capable reviewer |

Do not add project paths, caller-selected output paths, evidence export, Git
operations, or process ownership to EnforceScript. The scripts should expose
engine functionality only.

## Current state and gaps

The runtime observer already has the correct staging model:

- `observer/addon` is immutable package input.
- `observer/agent/staging.ts` verifies a content manifest and stages it beneath
  the external observer managed root.
- `observer/agent/launch-arguments.ts` merges one `-addonsDir`, one `-addons`,
  and one exclusive `-profile` without launching a process.
- `src/observer/coordinator.ts` rejects managed and profile roots that overlap
  the configured project.
- `observer/agent/artifacts.ts` validates and retains runtime PNGs, and the
  server applies the configured artifact age and byte limits.

Workbench uses the older model:

- Canonical handler sources live under
  `mod/Scripts/WorkbenchGame/EnfusionMCP`.
- `src/workbench/handler-bundle.ts` transactionally copies them into the target
  mod before launch.
- `src/workbench/client.ts` carries install, rollback, recovery, and cleanup
  state whose only purpose is project-local injection.
- `wb_cleanup` can remove unchanged manifest-owned files, but cannot account
  for files copied outside that transaction.

Evidence handling also stops one layer too early:

- A capture is retained by job, not by a named validation run.
- There is no capture label, review state, or standardized bundle.
- Async capture returns a job ID, but `observer_job` offers only `status`,
  `cancel`, and `release`; it cannot return the completed image.
- A synchronous image over the inline MCP byte limit remains retained but has
  no public export path.
- Artifact retention does not clean abandoned run workspaces or observer
  profiles.
- Callers manually assemble directories and choose retention and names.

Roadblock Runners also has a second Workbench lifecycle implementation in
`addons/RoadblockRunners/workbench_process_guard.ps1`. It uses a legacy temp
file lock and version-1 owner marker, whereas the MCP uses the stronger
`src/workbench/process-guard.ts` version-2 lifecycle with a Windows global
mutex, durable compare-and-swap state, executable and creation-time identity,
an exact owner argument, endpoint ownership checks, and handle-based
termination. The two paths should not remain parallel.

## Target architecture

```text
MCP server
├── observer platform
│   ├── immutable add-on stager
│   ├── private observer agent
│   ├── run store
│   ├── managed artifact repository
│   └── evidence finalizer
│
├── Workbench client
│   ├── shared exact-process lifecycle guard
│   ├── companion add-on launch provider
│   └── NET API client
│            │
│            ▼
│   managed ReforgerForgeWorkbenchHelper add-on
│   └── Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_*.c
│            │
│            ▼
│       WorldEditorAPI
│
└── runtime launch preparation
             │
             ▼
    managed ReforgerForgeObserver runtime add-on
    └── Scripts/Game/ReforgerForgeObserver

external managed root
├── addons/<runtime-digest>/ReforgerForgeObserver/
├── addons/<workbench-digest>/ReforgerForgeWorkbenchHelper/
├── artifacts/<backend>/<job-id>/
├── profiles/<session-id>/
├── runs/<run-id>/run.json
├── logs/
└── export-work/<run-id>/
             │
             └── finalize reviewed files only
                         ▼
                <project evidence root>/<run-id>/
```

Use a dedicated `ReforgerForgeWorkbenchHelper` add-on under the observer
platform, while reusing the runtime observer's immutable staging machinery.
Do not literally merge the Workbench handlers into `ReforgerForgeObserver` in
the first implementation. Runtime sessions and Workbench lifecycles have
different leases; sharing one digest would let runtime uninstall remove files
still loaded by Workbench unless a durable cross-subsystem bundle lease were
added first. Separate descriptors and digests keep that ownership explicit.
Project-local injection is not an automatic fallback.

## Non-negotiable invariants

- Workbench launch preflight completes before an existing exact-owned process
  is stopped.
- The target `.gproj` and its containing mod are never used as handler staging
  locations.
- The host verifies the loaded helper GUID, build identity, protocol, and
  bundle digest before any tool call is considered ready.
- A helper from a different bundle is a hard identity conflict, even if its NET
  API function names happen to match.
- One machine-wide lifecycle guard serializes MCP editor, foreground editor,
  and data-build launches.
- A user-launched, externally owned, or unverifiable Workbench is never adopted
  or signalled.
- Detached Workbench ownership requires a live MCP owner or a persistent
  guardian. A one-shot wrapper must not exit and leave a supposedly owned
  process behind.
- Runtime session tokens never gain evidence-export or arbitrary-file-read
  authority.
- Run scratch and raw captures never use a Git worktree as an artifact root.
- Final evidence writes are confined to configured evidence roots; a caller
  cannot turn finalization into an arbitrary filesystem copy operation.
- Finalization never overwrites an existing evidence directory.
- A generated bundle never claims `Passed` unless a caller explicitly records
  image-capable review. Capture completion and PNG validation are not semantic
  review.
- Tokens, absolute managed paths, owner arguments, and unredacted secrets are
  excluded from exported manifests.

## Phase 0: prove companion loading before refactoring

Do this as a disposable, live-engine spike. Do not remove injection until it
passes.

1. Create a minimal disposable package at
   `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP` containing only
   `EMCP_WB_Ping.c`, a dedicated `.gproj`, and a role-specific source manifest.
2. Stage it through a descriptor-driven form of the existing
   content-addressed stager.
3. Launch a disposable target with all of these arguments present exactly once:

   ```text
   -addonsDir <base roots plus staged digest root>
   -addons <Workbench-helper GUID, plus target GUID if the engine requires it>
   -gproj <disposable target.gproj>
   -noThrow
   <exact owner argument>
   ```

4. Prove that `EMCP_WB_Ping` registers, that the intended target project is
   still the lifecycle target, and that no `Scripts/WorkbenchGame/EnfusionMCP`
   directory appears in the disposable target.
5. Add one read-only World Editor handler, then the observer current-view
   handler set, and repeat the proof.
6. Capture and retain compile diagnostics for these failure cases:

   - helper GUID omitted;
   - helper search root omitted;
   - wrong helper digest staged;
   - duplicate helper copies visible in different search roots;
   - a normal Game runtime launch, proving that it does not load or require the
     Workbench helper;
   - ResourceManager/data-build launch rather than WorldEditor launch.

**Go condition:** all handler classes load from the staged companion, runtime
observation still compiles, and the target tree is byte-for-byte unchanged.

**No-go condition:** if Workbench cannot reliably load a dedicated helper via
structured `-addonsDir`/`-addons` arguments while retaining the target supplied
by `-gproj`, stop the migration and record the engine limitation. Do not
silently write handlers into the target. An explicitly enabled, deprecated
legacy injection mode may remain for compatibility while another external
loading mechanism is investigated.

## Phase 1: move the Workbench bridge into immutable staging

### 1. Package the handlers

- Move the complete supported set from
  `mod/Scripts/WorkbenchGame/EnfusionMCP` to
  `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP`.
- Keep the `EMCP_WB_*` class and NET API names during this migration. They are
  protocol identifiers; renaming them adds risk without removing residue.
- Preserve `observer/addon/Scripts/WorkbenchGame/README.md` as the runtime
  add-on boundary: Workbench handlers remain absent there.
- Add a role-specific immutable source manifest for `observer/workbench-addon`
  so every helper file is covered by its own aggregate digest.
- Update `scripts/check-package.mjs` and package-contract tests to require the
  handlers under `observer/workbench-addon` and reject packaged handler sources
  under `mod/`.
- Update build identity and add-on version. Bump the Workbench adapter protocol
  if the identity response changes.

### 2. Add a helper identity handshake

Extend the ping response with immutable constants compiled into the helper:

```json
{
  "status": "ok",
  "helperAddonId": "ReforgerForgeWorkbenchHelper",
  "helperAddonGuid": "<dedicated-guid>",
  "helperBuildIdentity": "<sha256>",
  "helperBundleDigest": "<sha256>",
  "workbenchProtocol": "2.0"
}
```

The digest can be generated into one small EnforceScript build file when the
helper source manifest is updated. The host compares every field with the staged
descriptor used for this launch. Do not infer identity from a success message
or handler availability alone.

Keep canonical target proof on the host. Workbench's current settings project
and the lifecycle's exact target `.gproj` are different facts and must not be
collapsed.

### 3. Replace injection with a launch provider

Introduce a narrow interface owned by the Workbench client, for example:

```ts
interface WorkbenchCompanionLaunch {
  addonId: string;
  addonGuid: string;
  addonSearchRoot: string;
  addonDirectory: string;
  bundleDigest: string;
  buildIdentity: string;
}

interface WorkbenchCompanionProvider {
  ensureWorkbenchCompanion(): Promise<WorkbenchCompanionLaunch>;
}
```

The observer platform implements this interface through a generalized verified
stager that accepts one fixed package descriptor. `WorkbenchClient` consumes
the Workbench descriptor and has no authority to copy files into the target
project. Runtime staging continues to use its separate fixed descriptor.

Refactor server construction so the observer platform exists before Workbench
launch preflight, then attach the shared `WorkbenchObserverAdapter` after the
`WorkbenchClient` is created. Avoid creating a second stager with independent
cleanup or retention decisions.

Extend `buildWorkbenchLaunchArgs` to merge:

- all configured base/Workshop roots plus the staged digest root into one
  deduplicated `-addonsDir` value;
- the helper GUID into one deduplicated `-addons` value;
- the exact target through one `-gproj` value;
- one MCP-managed external Workbench `-profile` allocated beneath the observer
  profile root; and
- `-noThrow` and the private owner argument as today.

Reject conflicting helper copies found in any configured root. As with runtime
launch preparation, never build one shell command string from these tokens.
Persist the canonical Workbench profile in lifecycle state. The adapter must
prove that a returned capture is contained beneath the exact physical
`<profile>/profile/ReforgerForgeObserver/workbench` directory, not merely that
its last two directory names look correct.

### 4. Simplify lifecycle state

Remove handler install/backup/restore transactions from the normal Workbench
launch state. Replace them with a companion binding containing only immutable
identity:

```ts
interface CompanionLifecycleState {
  addonGuid: string;
  bundleDigest: string;
  buildIdentity: string;
  stagedDirectoryKey: string;
  profilePathKey: string;
}
```

The lifecycle binding is also a durable staging lease. Workbench-helper cleanup
or observer-platform uninstall must refuse while an exact live Workbench state
references that digest. Runtime session leases and Workbench lifecycle leases
are collected separately and passed to the generalized stager; neither
subsystem may infer the other's liveness.

Because the durable state meaning changes, introduce an explicit lifecycle
schema migration rather than silently reinterpreting the current `handler`
field. A new lifecycle version is preferable. Migration must:

1. take the machine-wide mutex;
2. refuse while any Workbench identity is unverifiable;
3. restore or preserve a pending handler transaction using the old code;
4. archive the old state;
5. create the new vacant state; and
6. only then permit a companion-based launch.

Update diagnostics from `bundledScripts`, `installedMods`, and handler
transaction state to staged companion identity, loaded identity, and a separate
legacy-injection inventory.

### 5. Preserve one safe legacy cleanup path

Existing projects may already contain a manifest-owned injected bundle. Keep
the current hash-aware cleanup implementation for one deprecation window, but
rename its user-facing purpose to legacy cleanup. It must remain:

- callable only while no Workbench is running;
- bound to one canonical project;
- limited to manifest-owned, hash-matching files;
- preserving modified and unrelated files; and
- unable to recursively delete an unmanifested `EnfusionMCP` directory.

Do not run this cleanup automatically during the first companion launch. Report
the residue and let the caller invoke the guarded migration cleanup. Remove
`mod/Scripts/WorkbenchGame/EnfusionMCP` and normal `wb_cleanup` messaging only
after the compatibility window.

### 6. Migrate the existing Roadblock Runners handler copy

The audited directory
`addons/RoadblockRunners/Scripts/WorkbenchGame/EnfusionMCP` contains the exact
26 canonical MCP `.c` files byte-for-byte plus its version-3
`.reforger-forge-handler-bundle.json`. It does not contain Roadblock-specific
handler logic. The companion migration therefore includes the complete bridge,
not only the five observer capture handlers:

- entity create/read/list/modify/delete/select and component operations;
- layers, terrain, resources, prefabs, localization, clipboard, and script
  editor operations;
- editor control, action execution, state, camera, reload, and ping; and
- observer ping/submit/status/cancel/release plus the shared transaction code.

Migrate this installed copy in this order:

1. Package and live-qualify all 26 handlers in
   `ReforgerForgeWorkbenchHelper`.
2. Shut down the exact owned Workbench and prove the NET API endpoint is vacant.
3. Re-read the Roadblock Runners version-3 manifest and verify every managed
   file still matches its recorded SHA-256.
4. Invoke the legacy manifest-aware cleanup. Remove only the 26 matching files,
   the matching manifest, and created directories that are empty.
5. Preserve and report any changed, missing, or unrelated file; do not replace
   it or recursively delete the directory.
6. Relaunch Roadblock Runners with the external helper, exercise every handler
   family, capture through the observer adapter, and verify that the project
   `Scripts/WorkbenchGame/EnfusionMCP` directory does not return.

If any project-local handler changes before migration, treat it as a fork to
review and port deliberately into the canonical helper source. Hash mismatch is
never permission to discard it.

## Phase 2: consolidate every Workbench process guard

### Problem with the project-local guard

`addons/RoadblockRunners/workbench_process_guard.ps1` is careful but is still a
second ownership protocol. Its temp lock is not the MCP's Windows global mutex,
its owner marker is the legacy path consumed by v2 migration logic, and its
process record cannot be treated as a live MCP lifecycle lease. The project
launchers therefore cannot safely promise that they share one lifecycle with
`wb_launch` merely because the filenames and owner-argument prefix match.
It also scans by process name, terminates through the project-held
`Diagnostics.Process`, and replaces the version-1 marker rather than using the
MCP guard's executable/creation-FILETIME/owner-argument identity, endpoint PID
proof, compare-and-swap state, and retained OS-handle termination protocol.

### Provide a supported MCP Workbench runner

Extract a reusable foreground runner around `WorkbenchProcessGuard` rather
than asking projects to dot-source `scripts/windows/workbench-lifecycle.ps1`.
That PowerShell file is a private JSON/OS backend, not a public launcher API.

The runner should expose structured intents, not an unrestricted shell:

```text
reforger-forge-workbench editor --gproj <path> --foreground
reforger-forge-workbench build --gproj <path> --platform PC --output <path> --timeout-ms <n>
```

Both commands must:

- use the same global mutex, strict process scan, and exact process-identity
  backend as `wb_launch`;
- validate the exact executable, target, configured addon roots, and purpose
  before spawn;
- retain the exact process handle and owner lease until the child exits;
- record and internally verify the owner token without printing it;
- attribute the engine log directory to the exact run;
- return a bounded JSON receipt containing PID, exit status, target, lifecycle
  generation, and attributed log directory; and
- fail closed on inspection, identity, endpoint, or log-attribution ambiguity.

For an interactive foreground editor, the runner stays alive and holds the
machine mutex until the editor closes. For a bounded data build, it stays alive
through exit or exact-handle termination on timeout. These externally owned
foreground modes do not write a claimable MCP lifecycle record; a concurrent
MCP observes the process and refuses it as external. The durable lifecycle state
remains exclusive to `wb_launch` and other operations owned by a live MCP.

Do not offer a one-shot detached mode. Project automation that needs a detached
editor should call MCP `wb_launch`, whose MCP process remains the live owner. A
future detached CLI requires a persistent guardian process and a control
protocol; it cannot be implemented safely by writing a marker and exiting.

### Migrate Roadblock Runners wrappers

- Replace lifecycle and spawn logic in `launch_workbench.ps1` with a thin call
  to the foreground editor runner.
- Replace lifecycle and spawn logic in `build_workbench.ps1` with the structured
  build runner.
- Retain `write_retained_diagnostics.ps1` and Roadblock-specific warning/error
  policy as a post-processing hook over the exact log directory returned by the
  runner. Those filters are project policy, not generic process ownership.
- Replace `start_workbench.ps1` with a thin `wb_launch` instruction or remove
  it. Its hidden detached window is also unsuitable for viewport capture.
- Load executable, project, and add-on roots from the MCP configuration instead
  of keeping machine-specific absolute paths in each wrapper. Keep
  `-scriptAuthorizeAll` an explicit trusted-workspace opt-in, not a wrapper
  default.
- Delete `workbench_process_guard.ps1` only after all three callers migrate and
  regression tests prove they no longer reference the legacy marker or lock.

Archive a stale version-1 owner marker through the existing guarded migration
path. Never delete it merely because a PID lookup failed once.

## Phase 3: introduce managed observation runs

### Public tool shape

Add one discoverable `observer_run` tool with four actions:

```text
begin      create a managed run and return runId
status     list capture labels, terminal state, warnings, and missing artifacts
finalize   export a reviewed, standardized evidence bundle
discard    release the run's retained artifacts and remove managed run work
```

An action-based tool keeps the MCP surface compact. If host schema import makes
the conditional inputs unclear, split it into `observer_run_begin` and
`observer_run_finalize`; do not weaken validation to preserve one tool name.

Suggested begin input:

```json
{
  "action": "begin",
  "title": "RR-OBS-MACGUFFIN containment",
  "caseIds": ["RR-OBS-MACGUFFIN"],
  "sourceRevision": "<commit-or-declared-working-tree-id>",
  "procedureRevision": "<revision>",
  "idempotencyKey": "<caller-stable-key>"
}
```

Generate `runId` on the host. Do not accept a caller-selected run directory.
Store a crash-safe record at `runs/<run-id>/run.json` with restrictive
permissions. A run record contains references to managed artifacts, not copies
of repositories, profiles, archives, or arbitrary directories.

### Bind captures to runs and worlds

Extend `observer_capture` with:

```ts
runId: string;
captureLabel: string;       // normalized, unique within the run
purpose?: string;
expectedWorldId?: string | null;
expectedWorldEpoch?: number;
```

For evidence capture, `runId` and `captureLabel` should be required. Preserve a
short compatibility period for unassociated diagnostic captures, then make the
managed path the default.

The expected world values close the race between `observer_instances` and
capture submission. Fail before camera acquisition if the selected instance no
longer matches. Recheck at artifact completion as today.

Use labels such as `rr-obs-macguffin--bounds-recovered`, not job UUIDs, as
filenames. Reject duplicate normalized labels instead of silently suffixing
them.

### Unify backend artifacts

Define one backend-neutral managed artifact interface:

```ts
interface ManagedArtifactRef {
  backend: "runtime" | "workbench";
  jobId: string;
  storeKey: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

interface ManagedArtifactRepository {
  read(ref: ManagedArtifactRef): Promise<{ image: Buffer; metadata: object }>;
  release(ref: ManagedArtifactRef): Promise<void>;
  pinForOperation(ref: ManagedArtifactRef): Disposable;
}
```

Runtime artifacts already have a suitable filesystem form. Promote Workbench
PNGs and metadata into the same external repository after validation instead of
retaining the only reusable copy in `WorkbenchObserverAdapter.completedImages`
and the Workbench profile. The promotion boundary must revalidate regular-file
status, size, PNG structure, hash, lifecycle generation, target, world, and job.

Run finalization reads through this interface. It must work for async and
oversized captures without embedding the full image in an MCP response.

Also add `observer_job action="read"` for a completed artifact that fits the
inline limit. This fixes async capture usability. For larger images, return a
clear instruction to finalize the associated run; never disclose a private
managed path as a workaround.

### Correct the capture policy surface

- Keep synchronous capture as the default for interactive review.
- Remove `performance` from the public screenshot schema until an external
  measurement coordinator actually exists; both current backends reject it.
- Define `evidence` as the normal review mode.
- Define `instrumented` as allowed but contaminated, with a required warning in
  the manifest and result.
- Normalize `settleFrames` across backends. Do not pass a frame count to
  Workbench as an undocumented poll count. Either implement an equivalent
  editor-frame acknowledgement or expose a separate backend-neutral settle
  duration with measured results in metadata.
- Use `current` for UI/player-camera/editor-viewport claims, `lookAt` for most
  world-space evidence, and `pose` only when a known quaternion must be replayed.
- A successful Workbench current-view transaction remains the capability gate
  before `camera.editor` pose/look-at work.

## Phase 4: finalize only curated evidence

### Final bundle

`observer_run action="finalize"` exports this structure:

```text
<evidence-root>/<run-id>/
├── RESULT.md
├── manifest.json
├── captures/
│   ├── <capture-label>.png
│   └── <capture-label>.json
├── relevant-logs/
│   └── <log-label>.log
└── runtime-config.json
```

`relevant-logs` and `runtime-config.json` are optional inputs, but when absent
the manifest must say they were not supplied. Do not create misleading empty
proof files.

Suggested finalize input:

```json
{
  "action": "finalize",
  "runId": "20260717T184233Z-a1b2c3d4",
  "evidenceRoot": "<owner's screenshots directory>",
  "includeCaptureLabels": [
    "rr-obs-macguffin--before",
    "rr-obs-macguffin--bounds-recovered"
  ],
  "review": {
    "imagesReviewed": true,
    "reviewer": "<name or stable identity>",
    "outcome": "Passed",
    "summary": "Reviewed recovery and correlated the authoritative event."
  },
  "runtimeConfig": {
    "configurationId": "<declared-id>",
    "values": { "warmupDurationSeconds": 60 }
  },
  "supportingFiles": [
    { "kind": "relevantLog", "label": "runtime", "path": "<retained log>" }
  ],
  "releaseManagedArtifacts": true
}
```

Do not infer `Passed` from job state. If `imagesReviewed` is false, the only
valid result is `Unreviewed` or `Inconclusive`.

### Manifest requirements

`manifest.json` is machine-readable and versioned. Include:

- run ID, title, case IDs, created/finalized timestamps;
- declared source and procedure revisions;
- review state, reviewer, outcome, summary, and limitations;
- observer protocol, add-on, helper build, and MCP versions;
- each capture's label, relative paths, backend, job and instance IDs, world ID
  and epoch, requested view, actual camera/FOV, dimensions, byte count, SHA-256,
  timestamps, contamination, and warnings;
- each supporting file's kind, label, relative path, bytes, and SHA-256; and
- an export receipt and whether managed source artifacts were released.

Exclude activation/session tokens, Workbench owner arguments, absolute profile
paths, absolute managed artifact paths, and environment dumps. Redact configured
secret fields from runtime config or refuse the snapshot if it cannot be safely
classified. The generic finalizer must not copy a caller-selected raw config
file. Accept a bounded structured snapshot produced by a registered sanitizer;
for Roadblock Runners, allowlist the documented runtime-config keys and reject
unknown or secret-like keys.

`RESULT.md` is a compact rendering of the same facts: scope, outcome, reviewer,
capture links, warnings/contamination, supporting evidence, and limitations. It
must not contain independent facts absent from the manifest.

Relevant-log attachments are confined to managed or explicitly configured log
roots, size bounded, and copied as filtered text. Do not accept directories,
binary logs, complete profile trees, or arbitrary caller-readable files.

### Export transaction

1. Resolve the evidence root against a configured allowlist, then validate it
   and every existing path segment.
2. Require the final leaf to be exactly the generated `runId` beneath that
   root.
3. Refuse symbolic-link traversal, alternate data streams, devices, roots,
   existing non-identical output, and any capture label that changes its
   normalized path.
4. Pin selected managed artifacts only for the duration of export.
5. Build and validate all bytes beneath external `export-work/<run-id>`.
6. Create the new final directory. Never overwrite an existing directory.
7. Copy only allowlisted regular files with bounded per-file and total sizes,
   rehashing each destination.
8. Write `manifest.json` last as the completion marker.
9. On failure, remove only the new directory created by this transaction; never
   clean a caller-owned pre-existing directory.
10. On an idempotent retry, return the prior receipt only when the complete
    manifest digest matches.
11. Release selected and unselected run artifacts only after successful export
    when requested.

Cross-volume atomic directory rename is not generally available between the
external managed root and a project on another drive. Treat the manifest-last
protocol as the commit boundary instead of pretending the whole export can be
renamed atomically.

### Scratch-root policy

Acceptance harnesses and test runners must use the observer managed root or an
OS-created temporary directory by default. If an override remains available,
reject it when it:

- overlaps the configured project;
- is inside any Git worktree (detect `.git` files as well as directories);
- contains an existing non-observer run;
- resolves through a link outside the approved root; or
- is broad, such as a drive root, home directory, addon root, or repository
  root.

Only `finalize` may write into an evidence directory in a worktree, and it may
write only the standardized allowlisted bundle.

## Phase 5: retain all temporary classes, not only PNGs

Extend retention from `ArtifactStore.applyRetention` to a coordinated managed
storage sweep covering:

- completed and abandoned artifacts;
- open, finalized, and discarded run records;
- expired observer-exclusive profiles and capture source directories;
- export-work directories left by interruption;
- observer logs and probe output; and
- old unreferenced staged add-on digests.

Keep the existing seven-day/512 MiB defaults as a starting policy, but report
usage by class so one category cannot hide another. Active camera restoration,
an in-progress intake, and a finalizer's short-lived pins block deletion only
for those exact paths. Artifacts referenced by an open run remain pinned only
until that run's bounded TTL and quota expire. Expiry auto-aborts the run and
makes those artifacts eligible for ordinary retention; an open run is never an
indefinite exemption.

Add a non-mutating storage report to `observer_setup action="status"` and a
bounded explicit sweep action for maintenance. Never make status/doctor create
the managed root while the private child is idle.

## Phase 6: improve screenshot instructions and examples

Document this normal sequence with complete MCP call examples:

1. `observer_setup ensure`.
2. `observer_run begin`.
3. Prepare/launch a runtime, or explicitly `wb_launch` an editor.
4. Inventory renderers and record an exact `instanceId`, `worldId`, and
   `worldEpoch`.
5. Take a synchronous current-view capture first. Supply `runId`, a meaningful
   `captureLabel`, and the expected world binding.
6. Inspect the returned image itself.
7. Take only the additional before/after or close detail views required by the
   case.
8. Correlate non-visible claims with relevant diagnostics.
9. Finalize reviewed captures into the owning evidence directory.
10. Verify the finalize receipt, then release managed artifacts (normally done
    by finalize) and stop only owned processes.

Example current-view capture:

```json
{
  "sessionId": "<runtime-session-id>",
  "instanceId": "<selected-instance-id>",
  "runId": "<managed-run-id>",
  "captureLabel": "rr-obs-warmup--staging-roster",
  "expectedWorldId": "<inventory-world-id>",
  "expectedWorldEpoch": 3,
  "view": { "kind": "current" },
  "asynchronous": false,
  "settleFrames": 0,
  "performancePolicy": "evidence",
  "timeoutMs": 30000
}
```

Example look-at capture:

```json
{
  "sessionId": "<runtime-session-id>",
  "instanceId": "<selected-instance-id>",
  "runId": "<managed-run-id>",
  "captureLabel": "rr-obs-arena-world--overhead-active",
  "expectedWorldId": "<inventory-world-id>",
  "expectedWorldEpoch": 3,
  "view": {
    "kind": "lookAt",
    "position": [1000, 800, 1000],
    "target": [1000, 0, 1000],
    "fov": 60
  },
  "asynchronous": false,
  "settleFrames": 2,
  "performancePolicy": "evidence",
  "timeoutMs": 30000
}
```

Coordinates above are illustrative; case documentation owns real framing.

Until managed finalization ships, the safe interim workflow is:

- use synchronous capture for evidence;
- inspect the returned image immediately;
- keep unreviewed/raw working copies in the observer managed root or another
  external temporary directory, never the repository's root `screenshots`;
- manually copy only reviewed proof and its metadata into the owning service or
  map's `screenshots/<run-id>` directory;
- link that proof from the owner's validation page; and
- call `observer_job release` after the reviewed copy is safely retained or the
  capture is rejected.

Async and oversized captures are diagnostic-only until `read` or run finalize
is implemented; do not describe a retained-but-unretrievable job as saved
evidence.

## Implementation sequence by file

### Companion and Workbench lifecycle

- New `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/*` — canonical
  handler location.
- New `observer/workbench-addon/addon.gproj` and role-specific source manifest —
  independent helper identity and handler hashes.
- `observer/protocol/constants.ts` — add helper identity/protocol constants.
- Generalize the source-manifest update script or add a Workbench-helper
  counterpart — generate the compiled helper identity and manifest without
  recursive digest ambiguity.
- `package.json` — publish the Workbench-helper add-on and its manifest.
- `scripts/check-package.mjs` — require staged handlers, reject legacy package
  location.
- `src/workbench/client.ts` — consume companion provider and launch arguments;
  remove normal injection transactions.
- `src/workbench/handler-bundle.ts` — retain temporarily as legacy cleanup only,
  then remove.
- `src/workbench/process-guard.ts` — lifecycle schema migration and runner use.
- `scripts/windows/workbench-lifecycle.ps1` — keep as private OS backend.
- `src/server.ts` — construct shared platform/provider/client/adapter without a
  second lifecycle owner.
- `src/tools/wb-launch.ts`, `src/tools/wb-shutdown.ts`, and diagnostics — update
  companion and legacy-cleanup language.
- New `src/workbench/runner.ts` and a packaged CLI entry — foreground editor and
  bounded build intents.
- Roadblock Runners `launch_workbench.ps1`, `start_workbench.ps1`,
  `build_workbench.ps1`, and `workbench_process_guard.ps1` — thin-wrapper
  migration and removal.

### Runs, artifacts, and export

- New `observer/agent/runs.ts` — durable run store and label associations.
- New `observer/agent/evidence.ts` — bundle construction, validation, export,
  and receipts.
- `observer/agent/artifacts.ts` — backend-neutral reads, pins, import, and
  release.
- `observer/agent/paths.ts` — `runs` and `exportWork` managed paths plus strict
  evidence-root validation.
- `observer/agent/server.ts` — coordinated retention and storage diagnostics.
- `src/config.ts` and `reforger-forge.config.example.json` — bounded run TTL and
  quota settings plus explicit evidence-root allowlists.
- `observer/agent/private-child.ts` and control API — begin/status/finalize/
  discard/read operations.
- `src/observer/coordinator.ts` — expected-world checks, run association,
  Workbench artifact promotion, and finalize orchestration.
- `src/observer/tools.ts` — public schemas, examples, and corrected policy
  values.
- New versioned run/export manifest schemas under `observer/protocol/schemas`.
- `observer/README.md`, root `README.md`, starter `docs/AGENTS.md`, and project
  observation docs — current workflow, finalization workflow, and residue rules.

## Test plan

### Hermetic tests

- Each staged manifest accepts exactly its expected runtime or Workbench files,
  with no cross-role payload.
- Package check fails if a handler remains under `mod/` or is absent from the
  Workbench-helper source manifest.
- Workbench launch arguments contain one deduplicated `-addonsDir`, one
  `-addons`, one `-gproj`, and the private owner argument.
- Conflicting helper GUID/digest/build identity fails before spawn.
- Lifecycle migration recovers or preserves every old handler transaction
  phase and archives version-1 owner markers safely.
- The foreground runner cannot exit while its owned Workbench remains live.
- Project wrappers no longer create the legacy lock or owner marker.
- Begin is idempotent by caller key; labels are normalized and unique.
- Capture rejects an expected-world mismatch before camera acquisition.
- Async completed artifacts can be read when inline and finalized regardless of
  inline size.
- Finalization rejects links, traversal, worktree scratch roots, existing
  output, duplicate labels, unsupported files, unreviewed `Passed`, and
  destination hash changes.
- Finalization writes the exact tree, writes the manifest last, is idempotent by
  manifest digest, and releases only after verified export.
- Retention covers artifacts, profiles, runs, logs, and export work while
  respecting exact in-use pins.
- Status and doctor remain read-only while idle.

### Live acceptance

1. Hash/list the disposable target tree before launch.
2. Launch Workbench with the staged helper and prove all NET API handlers are
   ready with the expected identity.
3. Take current, look-at, and post-restoration current captures.
4. Finalize them outside the disposable target, verify every exported hash, and
   release the jobs.
5. Shut down the exact owner and prove the endpoint and process are gone.
6. Hash/list the target tree again; require no added or changed helper files.
7. Run a foreground editor wrapper and a bounded data build concurrently with
   attempted MCP launch; require the shared lifecycle to refuse the second
   owner.
8. Exercise cancellation, Workbench exit, compile failure, stale world, full
   inline-size overflow, interrupted export, and retention expiry.

The live test's own artifact root must be external and rejected if it is any Git
worktree. After review, retain only its finalized bundle.

The currently documented `run-owDNnE` is a useful behavioral baseline, but it
proves the injected-handler design. It does not qualify companion loading or
the no-target-residue invariant. Replace the current live-validation claim only
after the new acceptance run and image review succeed; keep old release notes as
historical records.

## Rollout

1. Land Phase 0 proof and record engine/tool versions.
2. Ship companion loading and identity verification while keeping explicit
   legacy cleanup. Do not silently fall back to injection.
3. Migrate the project wrappers to the shared runner and remove the project
   guard.
4. Ship run begin/status and capture association.
5. Ship artifact read, finalization, and full managed-storage retention.
6. Update project docs to require finalized evidence and remove all root
   `screenshots` staging instructions.
7. After one compatibility release, remove injection packaging and normal
   `wb_cleanup` from the supported workflow.

## Definition of done

- A clean target project remains clean after Workbench launch, every MCP tool,
  screenshot capture, restart, shutdown, and cleanup.
- Workbench handlers demonstrably load from a digest-verified external add-on.
- Every Workbench launcher in the workspace shares the same exact-process
  lifecycle or is explicitly documented as externally user-owned.
- No project-local process guard or version-1 owner marker writer remains.
- An evidence run has a stable ID and human labels, binds captures to the
  expected world, supports sync/async/oversized artifacts, and finalizes the
  standardized bundle.
- Raw captures, profiles, logs, acceptance output, and interrupted exports are
  externally managed and expire under reported limits.
- Only reviewed, allowlisted evidence enters project `screenshots` directories.
- Documentation never equates a successful capture transaction with proof that
  the visible gameplay requirement passed.
