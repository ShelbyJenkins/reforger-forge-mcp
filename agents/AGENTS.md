# ReforgerForge Workspace Instructions

This is a starter `AGENTS.md` for an Arma Reforger modding workspace. Copy it
to the workspace root, replace project placeholders such as `<MOD_NAME>`, and
remove sections that do not apply. Keep machine-specific values as placeholders
in any committed copy. It is written for coding agents that can use the
ReforgerForge MCP server.

Do not put private machine paths, account names, tokens, or local MCP config in
the committed version of this file. If this workspace needs overrides, keep
them in one ignored JSON file selected explicitly by the MCP client's
`--config <absolute-path>` arguments.

## Workspace Facts

Fill this in before asking an agent to modify a project:

```text
Workspace root: repository root
Addons root: addons
Mod root: addons/<MOD_NAME>
Project file: addons/<MOD_NAME>/<MOD_NAME>.gproj
Runtime scripts: addons/<MOD_NAME>/Scripts/Game
Shared script library: addons/<MOD_NAME>/Scripts/GameLib
Workbench-only scripts: addons/<MOD_NAME>/Scripts/WorkbenchGame
Prefabs: addons/<MOD_NAME>/Prefabs
Worlds: addons/<MOD_NAME>/Worlds
Documentation: addons/<MOD_NAME>/docs
Script/resource prefix: <PREFIX>_
Player-facing title: <TITLE>
Technical addon ID: <MOD_NAME>
```

Treat every `addons/<MOD_NAME>` directory as a separate project. Read IDs,
GUIDs, prefixes, dependencies, and naming conventions from the target project;
never copy them from another mod.

## Local Setup

ReforgerForge requires Node.js 20 or newer. Arma Reforger Tools is required for
builds, resource registration, and live editor-control operations, and the Arma
Reforger game installation is required for base-game asset browsing.

1. From the ReforgerForge repository, run
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1`.
   It installs,
   builds, verifies config-free startup, and attempts registration in every
   detected supported MCP client.
2. Confirm the client can see the `reforger-forge` tools.
3. Let normal startup discover the Steam installations, base-game add-on root,
   and (when it exists) the standard Workshop add-on root.
4. If this workspace needs project-scoped defaults or nonstandard paths, copy
   `reforger-forge.config.example.json` to an ignored local path, keep only the
   required overrides, and manually register the server with
   `--config <absolute-config-path>`.
5. Restart the MCP process after changing values in an explicit config. Rerun
   the manual installer only if the selected file path changes.

Use
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Doctor`
for a read-only installation and registration
inspection. It is valid for the receipt to show no config and no project;
Workbench NET API and observer capture remain `not tested`. If an already
running Workbench should be checked, use
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Doctor -CheckWorkbench`;
this makes exactly one read-only
`EMCP_WB_Ping` and never launches or terminates Workbench or the game. Add
`-Json` to setup or Doctor for one machine-readable receipt on stdout.
Registration success proves only that the client entry is current, not that the
client restarted or loaded it. Receipts list exact files and backups for direct
edits; Codex and Claude Code CLI-owned updates are disclosed separately with
their concrete storage file marked unverified.

Claude Code command discovery is PATH-first. If `claude` is absent, setup and
Doctor may use only the newest validated, non-obsolete native CLI from the
standard Anthropic VS Code or VS Code Insiders extension installations; do not
guess a binary from extension-directory presence alone. Custom
`--extensions-dir` locations remain manual.

ReforgerForge does not discover a package-local or user-home file and does not
read environment variables for server configuration. A config is optional and
is loaded only when its path is supplied. CLI values override the explicit
file. Relative paths in that file resolve from the file's directory, while
relative CLI paths resolve from the MCP process working directory.

For an optional override, use placeholders rather than real local paths in
committed documentation:

```json
{
  "workbenchPath": "<ARMA_REFORGER_TOOLS_DIRECTORY>",
  "gamePath": "<ARMA_REFORGER_GAME_DIRECTORY>",
  "projectPath": "<ABSOLUTE_WORKSPACE_PATH>/addons",
  "workbenchAddonDirs": [
    "<ADDITIONAL_NONSTANDARD_ADDON_ROOT>"
  ],
  "workbenchScriptAuthorizeAll": false,
  "workbenchHost": "127.0.0.1",
  "workbenchPort": 5775
}
```

The configured `projectPath` is the addons container (`<ABSOLUTE_WORKSPACE_PATH>/addons`),
not one addon. This lets `wb_launch` discover projects and lets
`game_duplicate` select a child addon by `modName`. Tools that read or write
inside one addon require the target addon root explicitly: pass
`projectPath: "<ABSOLUTE_WORKSPACE_PATH>/addons/<MOD_NAME>"` to `project`, `prefab`,
`script_create`, `layout_create`, `config_create`, `server_config`,
`scenario_create_conflict`, and `animation_graph`, and to `mod` when
validating. Generic `mod(action=build)` is retired. While the MCP is active,
use `wb_build` with an explicit `.gproj` and caller-exclusive empty output
directory. Project scripts and CI may use the packaged standalone runner only
when no live MCP owns the Workbench lifecycle lease. Pass an explicit target
`outputDir` to `building_setup`.

ReforgerForge automatically adds the discovered base-game add-on root and,
when present, the standard Workshop add-on root. A nonempty explicit
`workbenchAddonDirs` list is additive: those discovered roots are prepended
unless they are already present. Add only any other local or nonstandard
Workshop roots needed to resolve the target project's direct and transitive
dependencies. `--no-workbench-addon-dirs` remains an explicit opt-out. Use
`node dist/index.js check-addon-dirs --gproj <path>` for a read-only report of
which candidate root resolves each dependency GUID. ReforgerForge passes the
effective roots to Workbench as one ordered, comma-separated `-addonsDir`
value. When launching manually, keep that entire value quoted because paths
commonly contain spaces.

Leave `workbenchScriptAuthorizeAll` disabled unless the active project and all
of its dependencies are trusted. Enabling it suppresses authorization prompts
for protected `RunCmd`, `RunProcess`, `KillProcess`, and out-of-profile `FileIO`
operations.

Agent-launched Workbench sessions always enforce `-noThrow`. It sends assertions
to the log instead of displaying modal dialogs, which keeps unattended
validation from waiting forever for a person to click a button.

Avoid putting a Workbench project in a cloud-synchronized or read-only
directory. Sync clients can change attributes or lock files in ways that stop
Workbench from loading or saving resources.

## Workbench NET API

- Enable the Workbench NET API in Workbench options.
- The default endpoint is `127.0.0.1:5775`; keep the MCP config and Workbench
  setting in sync if it is changed.
- Launch the exact target `.gproj`, not just the Workbench project picker.
- Use `wb_diagnose` when launch or connection fails; do not guess at the cause.
- A working bridge reports that the EnfusionMCP Workbench bridge is active.

`wb_launch` digest-verifies and stages the packaged
`ReforgerForgeWorkbenchHelper` beneath the external observer managed root. It
loads that add-on alongside the exact target `.gproj` and gives Workbench a
dedicated external profile. It does not place MCP helper files in the target
project. Editor readiness requires `EMCP_WB_Ping` to return the exact helper
add-on ID, GUID, version, protocol, and build identity expected by the running
MCP. The target-build plan has no helper activation or NET-readiness capability.

Automated lifecycle control is supported on Windows through one shared
`WorkbenchSessionController` behind the stable `WorkbenchClient` facade. The
version-3 global named mutex and lifecycle record serialize cross-process state
transitions. A controller-local, writer-preferring reader/writer gate permits
concurrent managed NET calls, blocks new readers once a writer is pending, and
drains active reads and capture restoration before lifecycle or companion
administration changes. Ordinary NET calls do not hold the machine mutex. A
second live MCP cannot adopt the first MCP's Workbench. A replacement MCP may
claim the lease only after the prior MCP PID and exact creation identity are
proven dead.
`wb_restart` preflights the complete replacement before it stops anything,
retains the same canonical `.gproj`, terminates through the verified OS process
handle, waits for the NET API port to release, launches with `-noThrow`, and
refuses different-target, user-owned, unverifiable, or wrong-helper sessions.

When live automation is finished, restore or cancel every observer capture,
wait for a terminal job state, and call `wb_shutdown`. The managed helper and
profile remain outside the mod, so there is no project cleanup step.

Workbench observer capture uses dedicated companion NET API handlers and the same
long-lived client, canonical target, exact owner lease, and lifecycle generation
as other `wb_*` operations. It never auto-launches Workbench; launch the visible
target explicitly with `wb_launch` first. The lifecycle canonical target is the
mod `.gproj`, while `Workbench.GetCurrentGameProjectFile()` separately reports
the base-game settings project. The guard proves the former and the handler
cross-binds it while tracking the latter and the editor world/subscene identity.

`camera.editor` remains unavailable after each Workbench start until a
current-view capture has proved exact restoration of the native `BaseWorld`
camera slot, full matrix, measured vertical FOV, and read-only far plane.
`BaseWorld` has no near-plane getter, so observer capture does not mutate that
value. Workbench capture produces native PNG artifacts; do not document or
expect a BMP conversion path. Treat `RESTORATION_UNCONFIRMED` as a hard failure.
Restore or cancel active captures before `wb_shutdown`, then wait for vacancy.

Project scripts and CI should call the packaged lifecycle runner instead of
maintaining another process guard:

```text
reforger-forge-workbench --config <config> editor --gproj <path> --foreground
reforger-forge-workbench --config <config> build --gproj <path> --platform PC --output <path> --timeout-ms <n>
```

Editor ownership is foreground-only. A build is one direct helper-free
target-only child under the same guarded lifecycle, using a dedicated profile
and no NET-readiness or companion-preflight step. Supply a caller-exclusive
unique empty output directory for every run. A zero build exit means the runner
has re-attested the target and accepted fresh nonempty output with one hashed
`resourceDatabase.rdb`; it does not need a caller-side replay of process,
endpoint, source-hash, or output checks. The [standalone runner CLI
reference](../docs/runner-cli.md) owns the unversioned receipt shapes,
exit-code mapping, and the one target-identity check a fixed-project wrapper
should retain.

Installed Workbench 1.7.0.54 requires the exact target sequence
`-wbModule=ResourceManager -builddata PC <fresh-output> <AddonName>`, with the
`-builddata` token in lowercase and no target `-run`. This guarded path produced
qualified fresh output on 2026-07-18. Keep the lifecycle and receipt checks
intact: child launch and zero exit alone remain insufficient, and any missing or
stale output proof must fail closed.

### Workbench implementation cohesion

`session-controller.ts`, `runner.ts`, and `launch-plan.ts` may each remain over
800 lines when reviewing Stage 3. Their size is not itself a reason to split a
transaction. Socket framing, process execution, state projection, readiness,
diagnostics, supervision, and managed-profile creation have separate modules.
The session controller keeps lifecycle/gate ordering local because reservation,
spawn publication, exact cleanup, and vacancy form one fail-closed transaction.
The runner keeps CLI/build evidence policy local because log attribution, output
reservation, output proof, exit mapping, and single-receipt shaping must agree. The
launch-plan module keeps the three-plan validation and final argument ordering
together so no caller can assemble a partial policy. Extract another module only
when it owns an independently testable invariant, not merely to reduce line
count.

## Observer Runtime Lifecycle (Windows)

Keep the runtime phases distinct:

1. `observer_prepare_launch` stages an activation session and returns both a
   structured argument array and an opaque, expiring `preparedLaunchId`. It
   never starts a process. The array remains available for external launchers.
2. `observer_runtime action="start"` is an explicit side effect. Pass the
   `preparedLaunchId` and a unique `idempotencyKey`; the one-shot immutable
   descriptor is consumed and a successful call returns a `runtimeId`.
3. `observer_instances` and `observer_capture` observe that running instance.
   A pose/look-at transaction may hold a camera lease, and success, failure, or
   cancellation is not terminal until camera restoration is confirmed.
4. `observer_runtime action="stop"` is a separate explicit side effect. Pass
   the `runtimeId`, a unique `idempotencyKey`, and an appropriate
   `waitForRestorationMs`; it refuses if restoration cannot become terminal.

Managed start resolves the graphical executable from trusted configuration,
preserves each prepared argument as one token, appends exactly one random owner
argument, and performs a visible direct spawn without a shell. It publishes an
external atomic receipt only after verifying the child by PID, canonical
executable path, exact Windows creation time, exact owner argument, and stable
pre/post-spawn executable file identity plus SHA-256. Later same-path
replacement fails closed. A failed spawn or inspection publishes no successful
ownership receipt; unproved retained-child cleanup remains a non-success
pending record without PID-only termination authority.
Lifecycle files use owner-only creation modes where supported. On Windows they
inherit the configured observer managed root's ACL, so configure any custom
`observer.managedRoot` as a current-user-private directory, never a shared or
broadly writable location.

Use `observer_runtime action="status"` with the returned `runtimeId` to inspect
`running`, `exited`, `identity_mismatch`, `unverifiable`, or `stale`. A PID or
process name alone never proves ownership. `stale` means the observer session
expired while the exact process may still exist; expiry never triggers an
automatic stop. Before termination, stop checks active jobs and camera leases,
waits only for the requested bound, reverifies every identity field, terminates
through the native exact-process handle, proves identity vacancy, and preserves
a stop-result receipt. The restoration reservation is persisted before native
termination, and observer-session completion is separately acknowledged and
retried idempotently before stop reports success. Once restoration is reserved,
the session rejects new capture submissions; successful stop revokes its
activation session.

A restarted MCP may recover exact status only for one of the same
installation's persisted receipts under the same Windows owner and only when
every identity field and owner token still matches. If the new private observer
agent does not know the old session, post-restart stop additionally requires a
durable restoration seal from a clean MCP shutdown. That seal is written only
after the old MCP reserves the session and proves there are no active jobs,
camera leases, or pending restoration. After an unclean restart without the
seal, preserve the process: stop fails with `SESSION_UNVERIFIABLE`. This is
lifecycle recovery, not adoption. Never use `taskkill`, `Stop-Process`,
process-name enumeration, PID-only termination, or broad process-tree
termination as a substitute, and never signal an unrelated Arma or Workbench
process.

Only a successful runtime receipt is restart-recoverable. A pending-start file
is failure evidence, not adoption authority. If the host dies between process
creation and durable exact PID/creation publication, preserve safety and handle
the visible process manually; never substitute PID/name cleanup. Treat the
configured game installation as trusted during process creation: file-ID and
digest snapshots fail closed on stable/in-place replacement but are not a
defense against a privileged swap-and-restore attacker inside that exact
interval.

## Start-of-Task Checklist

Before editing:

1. Identify the target mod and read its `.gproj`.
2. Inspect its direct dependencies and make sure their addon roots are
   available to Workbench, including transitive dependencies.
3. Read the project's current instructions, design notes, scripts, prefabs,
   worlds, and relevant `.meta` files.
4. Check the working tree and preserve unrelated user changes.
5. Match the existing prefix, folder layout, serialization style, and naming
   conventions.
6. Decide whether the task can be completed with offline tools or requires a
   live Workbench session.

## MCP Tool Routing

MCP clients may display a namespace before each name. Route by the final tool
name below.

| Intent | Preferred tool |
|---|---|
| Find an API class, method, enum, or inheritance detail | `api_search` |
| Find an appropriate component or event handler | `component_search` |
| Search or read official modding guidance | `wiki_search`, then `wiki_read` |
| Search bundled implementation patterns | `wb_knowledge` |
| Find a base-game asset by name/path and return an indexed GUID when available | `asset_search` |
| Browse or read base-game files and archives | `game_browse`, `game_read` |
| Copy a base-game prefab/config into a mod | `game_duplicate` |
| Inspect addon metadata and dependencies from its `.gproj` | `workshop_info` |
| Browse, read, or write files in a target addon | `project` with explicit `projectPath` |
| Create or inspect a prefab and its inheritance | `prefab` |
| Generate scripts, layouts, configs, or server config | `script_create`, `layout_create`, `config_create`, `server_config` |
| Generate or inspect vehicle animation graphs | `animation_graph` |
| Generate a destructible-building prefab set | `building_setup` |
| Place Scenario Framework entities in the open world | `scenario_create` (live) |
| Generate Conflict scenario files | `scenario_create_conflict` (offline) |
| Create or validate an addon | `mod` (`action=build` is retired) |
| Build one exact addon while MCP is active | `wb_build` |
| Stage or diagnose the observer companion addon | `observer_setup` |
| Begin, inspect, finalize, or discard a managed evidence run | `observer_run` |
| Prepare an instrumented runtime argument array without launching it | `observer_prepare_launch` |
| Explicitly start, inspect, or restoration-gated stop an exact-owned graphical runtime | `observer_runtime` |
| Inventory runtime or exact-owned Workbench renderers | `observer_instances` |
| Capture a current, explicit-pose, or look-at PNG | `observer_capture`; use `observer_job` for async status/read/cancel/release |
| Inspect Workbench and troubleshoot the connection | `wb_state`, `wb_connect`, `wb_diagnose` |
| Inspect or edit placed entities | `wb_entity_list`, `wb_entity_inspect`, `wb_entity_modify`, `wb_component` |
| Duplicate an entity already placed in a scene | `wb_entity_duplicate` |
| Register a new resource or inspect resource metadata | `wb_resources` |
| Stop Play, clean-restart, reload plugins, undo, or redo | `wb_stop`, `wb_restart`, `wb_reload`, `wb_undo_redo` |

Use the lookup tools before inventing class names, method signatures, prefab
paths, component properties, or GUIDs. Prefer an exact resource path over a
broad recursive browse of the base game.

Use `game_browse`, `game_read`, and `asset_search` for installed game data
instead of ordinary filesystem tools. Use `game_duplicate` for a base-game
resource and `wb_entity_duplicate` for an entity already placed in the current
world; they solve different problems. `game_duplicate` registers the copy by
default and may auto-launch Workbench. For a registered copy, first launch the
exact target `.gproj` and pass its `modName`; use `register: false` only when an
unregistered, offline copy is intentional.

## Workbench Editing Flow

For live editor work:

1. Call `wb_launch` with the target `.gproj` path.
2. Confirm the connection with `wb_connect` or inspect it with `wb_state`.
3. If Workbench is already in Play mode, call `wb_stop` before mutating the
   scene.
4. Inspect the target entity, component, prefab, layer, or resource before
   changing it.
5. Make the smallest scoped change and inspect the result.
6. Save intentional editor changes manually while a person is attending the
   editor; no automated Save/Save As tool is advertised because the operation
   may open modal UI.
7. After script changes, use verified owner-scoped `wb_restart` for a clean
   compile. Never use `wb_reload` or a generic menu action for scripts.
8. Prefer a bounded standalone diagnostic/autotest launcher for gameplay
   acceptance. When attended in-editor testing is required, ask the user to
   enter Play manually because no automated Play tool exists, pause until they confirm,
   verify Play mode with `wb_state`, and use `wb_stop` to return to edit mode.
9. When live automation is finished, restore or cancel active captures, wait
   for terminal state, and call `wb_shutdown`.

After changing `.c` files in a session that has loaded a world, save intentional
editor changes manually and use `wb_restart`. Do not route a script compile
through `wb_reload` or a generic menu action; generic menu execution is disabled
entirely, including in the direct NET API handler.

Most scene mutations only work in edit mode. Do not assume an operation failed
or succeeded without reading its tool result and re-inspecting the saved state.
An already-running Play session may retain stale prefab or script values.

Avoid `wb_open_resource` on a prefab while an important world is open unless
switching into prefab edit mode is intentional; opening the resource can close
or replace the current world-editor context.

## Screenshot Evidence Flow

Use `screenshots` only for finalized evidence, never for profiles, repositories,
archives, probe logs, or raw capture work. Configure its absolute path in
`observer.evidenceRoots`; the observer keeps all working artifacts under its
external managed root.

Runtime and Workbench captures intentionally share one public capture service:
do not bypass its job ID, exact revision, absolute deadline, promotion, or
release receipt. Durable run ownership remains available for cleanup, but new
begin/reserve/finalize operations are refused when no evidence exporter root is
configured. `observer_setup action="doctor"` and the installed CLI `doctor`
are inspection-only and must not create missing roots, load stores, stage
companions, or start the private child.

1. Call `observer_run action="begin"` and retain the generated `runId`.
2. Prepare a runtime with `observer_prepare_launch`. Either use its structured
   arguments in an external launcher or explicitly start its `preparedLaunchId`
   with `observer_runtime`; call `wb_launch` separately for an editor.
3. Call `observer_instances`, choose one exact renderer, and record its
   `instanceId` and opaque `worldRevision`. The legacy `worldId` and
   `worldEpoch` fields remain available for compatibility.
4. Call `observer_capture` with the `runId`, a meaningful unique
   `captureLabel`, and `expectedWorldRevision` copied from inventory. These
   fields are required for evidence captures. Prefer `view.kind="current"`
   first and synchronous mode while reviewing interactively.
5. Inspect the image itself. A successful capture transaction proves image
   integrity and camera restoration, not the gameplay claim shown in the image.
6. For asynchronous work, poll `observer_job action="status"`, then call
   `action="read"` when complete. If it exceeds the inline limit, leave it
   managed; `observer_run action="finalize"` can still export it.
7. Finalize only reviewed labels into the allowlisted evidence root. The result
   is `<evidenceRoot>/<runId>/` with `RESULT.md`, `manifest.json`, capture
   PNG/JSON pairs, and only supplied allowlisted logs or sanitized runtime
   configuration. Use `discard` when the run should produce no evidence.
8. For an exact-owned runtime, wait for every job to reach terminal restoration,
   call `observer_runtime action="stop"`, and confirm `identityVacant=true`.

An outcome of `Passed` requires `review.imagesReviewed=true`. Record warnings,
contamination, limitations, source revision, procedure revision, and the stable
reviewer identity rather than inferring success from a completed job.

## Resource and GUID Rules

- Treat `.meta` GUIDs as durable references. Do not regenerate, replace, or
  hand-edit them casually.
- Do not copy a prefab from extracted game files directly into a mod and assume
  it is usable. An unregistered copy has no valid mod resource GUID.
- Prefer `game_duplicate` or Workbench's Duplicate action so the resource is
  written into the mod and registered. Verify the resulting `.meta` file.
- The resource GUID used in references comes from metadata, not an unrelated
  internal `ID` field in the serialized prefab.
- Inspect prefab ancestry before overriding components. Keep the parent
  reference by default; use a flattened duplicate only when a standalone copy
  is intentionally required.
- Prefer Workbench-created assets and metadata. If a serialized `.et`, `.conf`,
  or world file must be patched directly, reopen it in Workbench and verify
  that its references and components still resolve.
- Never reuse a project GUID, resource GUID, entity ID, or mod prefix merely
  because a similar project has one.

## Script and Project Conventions

- Runtime gameplay code belongs under `Scripts/Game`; shared libraries may use
  `Scripts/GameLib`; editor-only automation belongs under
  `Scripts/WorkbenchGame`. Scripts outside recognized module folders can be
  silently ignored.
- Research parent classes and inherited methods with `api_search` before
  writing overrides.
- Inspect existing source before generating a new class. Extend local patterns
  instead of creating parallel frameworks without a clear need.
- Keep changes within the current request. Do not reset, delete, rename, or
  broadly reformat unrelated files.
- Preserve existing user-authored changes and project-specific documentation.
- Treat generated code and prefabs as a starting point that still requires
  inspection, compilation, and runtime validation.

## Validation Workflow

Validation should be proportional to the change, but a complete pass normally
includes:

1. Run `mod` with `action: "validate"` and the target addon's explicit
   `projectPath` for structure, `.gproj`, script, prefab, config, reference, and
   naming checks.
2. Launch the target project with all required addon roots.
3. Compile the Game module and stop on project script errors.
4. Reopen or inspect every changed prefab, config, and world resource.
5. Ask the user to enter Play manually, wait for confirmation, verify Play mode
   with `wb_state`, and exercise the behavior's concrete acceptance cases.
6. Manually check the Workbench Log Console for new errors, warnings, and
   expected project-specific evidence.
7. Test networking behavior with the required number of real clients; a solo
   Play session does not validate replication, join-in-progress, ownership, or
   authority behavior.
8. Run the project's own static checks and targeted tests.
9. Build when packaging is in scope. A process that remains open without build
   output or a successful exit is not evidence of a successful build.

Record what was actually tested, the Workbench/game version when relevant, the
client count and roles for multiplayer tests, the observed result, and any
remaining validation gap. Do not describe an unrun check as passed.

## Troubleshooting

| Symptom | Check |
|---|---|
| `wb_connect` cannot reach Workbench | Confirm the NET API is enabled, host/port match, the correct `.gproj` is loaded, then run `wb_diagnose`. |
| `Undefined API func` from a `wb_*` tool | The managed Workbench companion is absent, did not compile, or has the wrong identity. Close that Workbench, run `wb_diagnose`, then launch the exact `.gproj` through `wb_launch`. Use owner-scoped `wb_restart` for another clean compile. |
| A component appears as `Unknown` | Its script did not compile in the loaded project. Fix compile errors and reload or restart before setting properties. |
| Workbench opens without the target mod | Close any stale session and call `wb_launch` with the exact `gprojPath`; if it still fails, check direct/transitive dependencies and every configured addon root. |
| A path is truncated near `Arma Reforger` | Preserve quoting around paths with spaces and around the full comma-separated `-addonsDir` value. |
| A generated or duplicated prefab lacks expected components | Reopen it, inspect its ancestry and saved component list, and confirm registration metadata exists. |
| A new resource reports a zero or missing GUID | It was probably copied without registration. Duplicate/register it through Workbench or `game_duplicate`. |
| `RegisterResourceFile` reports failure | Reopen the project or rebuild the resource database, then verify the resource and `.meta` resolve before treating it as a cache-only warning. |
| Edits seem stale in Play | Stop Play, save in edit mode, reload the affected resource or scripts, and start a fresh Play session. |
| Runtime manager references are null | Inspect inherited components and required support managers; a bare manager entity may not contain required arrays or references. |
| `observer_runtime` reports `identity_mismatch` or `unverifiable` | Do not terminate by PID or name. Preserve the receipt for diagnosis and verify the configured executable, exact creation identity, owner token, MCP installation, and Windows owner. |
| `observer_runtime` stop reports `CAMERA_BUSY` | Cancel or finish active captures, poll `observer_job` until restoration is terminal, then retry with an appropriate bounded `waitForRestorationMs`. |
| Unexpected game-mode behavior | Check for multiple active game-mode entities and leftovers from failed duplication attempts. |
| Project is read-only or saves intermittently | Move it out of synchronized storage or remove the external lock before continuing. |

## Documentation Expectations

Keep project-specific documentation with the mod. At minimum, record:

- the active `.gproj`, world, primary prefab, and main runtime scripts;
- required dependencies and local setup assumptions without private paths;
- exact launch, compile, Play, and multiplayer validation steps;
- named entities or resources referenced directly by scripts;
- current scope, explicit non-goals, and known unresolved errors;
- validation evidence and what remains unverified.

Update the owning document when a workflow or acceptance case changes. Keep
workspace-level instructions generic enough to apply to every mod in the
workspace.

## Completion and Publishing Checklist

Before reporting completion or publishing:

- Do not create a public fork, push, open a pull request, publish a Workshop
  item/package/release, or otherwise make material public without the user's
  explicit approval immediately before that external action.
- Re-inspect the changed files and preserve unrelated worktree changes.
- Confirm new resources have stable metadata and all references resolve.
- Run the relevant static checks, `mod` validation, Workbench compile, and Play
  acceptance cases.
- Save editor changes and record any validation that still requires manual or
  multiplayer testing.
- Restore/cancel observer work; stop each exact-owned runtime through
  `observer_runtime` and prove identity vacancy, then call `wb_shutdown` for an
  owned editor. Confirm no MCP helper files exist beneath the target addon.
- Exclude local MCP config, logs, caches, absolute paths, usernames, and other
  machine-specific information from the commit.
