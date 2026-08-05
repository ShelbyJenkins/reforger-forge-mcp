# ReforgerForge Coding-Agent Guide

This is a starter workspace instruction file for coding agents that use the
ReforgerForge MCP server. Copy it to a mod workspace root, replace the
placeholders, and merge it with the workspace's existing project rules.

This document is deliberately about coding-tool use and workflows. Installation,
client registration, machine paths, and configuration troubleshooting belong in
the setup documentation instead:

- [Setup and configuration](../SETUP.md)
- [AI client registration and troubleshooting](README.md)
- [Observer usage guide](../docs/observer.md)
- [Standalone Workbench runner reference](../docs/runner-cli.md)

Do not commit machine paths, account names, tokens, local MCP configuration, or
generated logs in this file. Keep project-specific instructions alongside the
project and use placeholders in any reusable copy.

## Workspace Context

Fill in this block before asking an agent to make project changes:

~~~text
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
~~~

Each addon is a separate project. Read the target project's .gproj, metadata,
dependencies, prefixes, and local conventions; never borrow IDs, GUIDs, or
naming rules from a neighboring addon.

## Session Ownership and Startup

If the current coding client exposes the ReforgerForge tools, its stdio MCP
server is already running. Do not start `node dist/index.js`, a project's
`start_mcp.ps1`, or a second MCP host from a shell. A project `start_mcp.ps1`
with no mode is a client registration command: it waits for MCP protocol input
and is not an interactive or background-server command.

Use `start_mcp.ps1 -Mode Describe` to inspect a project's resolved Node path,
server path, and startup arguments without starting the MCP server or
Workbench. Use `-Mode Verify` to run a bounded fresh-process handshake with
those exact arguments. Verification does not replace the server already owned
by the client. After rebuilding ReforgerForge or changing a launcher, refresh
the MCP server in the client or restart the client before testing it.

Managed registrations carry a trusted client label in the Node command line,
and `wb_diagnose` exposes the same process UUID, PID, and start time used by the
Workbench and owned-runtime lifecycle components. These values are operator
identity only. They never authorize killing, preempting, or taking over a host
or child process; use the owning client's refresh/shutdown surface and the exact
supported lifecycle tools.

Host lifecycle code can form a bounded internal idle-readiness proof from the
same UUID. The proof is host-scoped and existing-only: it never starts a child,
creates state, repairs/sweeps receipts, revokes a session, or stops Workbench or
the game. Legacy-unattributed, malformed, incomplete, timed-out, or racing
evidence blocks the proof. The admission gate remains default-open in embedded
compositions. In the CLI stdio composition, a 30-minute-default bounded
inactivity controller uses the proof to atomically seal new host and protocol
admissions before normal shutdown. Active or uncertain lifecycle work keeps
the host open; a sole ready private Observer child with no pending work is
closed by the normal disposer. This controller is process-local and never
reaps another host or terminates an unowned Workbench or game process.

Start attended Workbench only through **wb_launch** while an MCP session owns
the lifecycle. The standalone `reforger-forge-workbench editor` runner is for a
foreground project script or operator session when no live MCP owns the lease;
do not invoke it as a second editor launcher from an active MCP task.

## Before Editing

1. Identify the target addon and read its .gproj plus any project instructions.
2. Inspect the relevant scripts, prefabs, worlds, metadata, and design notes.
3. Check the worktree and preserve unrelated user changes.
4. Check direct dependencies and make sure their add-on roots are available
   before starting a live Workbench task.
5. Use lookup tools before inventing API names, prefab paths, component
   properties, resource GUIDs, or serialized formats.
6. Decide whether the task is offline or requires a live Workbench or Observer
   session. Do not start a live session merely to browse source files.

## Tool Routing

MCP clients may prefix tool names with a namespace. Route by the final tool
name. The MCP tool schema and description shown by the connected client are the
authoritative field-level contract.

| Need | Preferred tool or tools |
|---|---|
| Enfusion API, inheritance, methods, enums | **api_search** |
| Appropriate component or event handler | **component_search** |
| Official modding guidance | **wiki_search**, then **wiki_read** |
| Bundled implementation patterns | **wb_knowledge** |
| Base-game asset path or indexed GUID | **asset_search** |
| Read or browse installed game data | **game_browse**, **game_read** |
| Copy a base-game `.et` prefab into an addon | **game_duplicate** |
| Inspect a mod's .gproj metadata and dependencies | **workshop_info** |
| Browse, read, or write a target addon | **project** |
| Create or inspect a prefab | **prefab** |
| Generate scripts, layouts, configs, or server config | **script_create**, **layout_create**, **config_create**, **server_config** |
| Create or inspect vehicle animation graphs | **animation_graph** |
| Generate destructible-building resources | **building_setup** |
| Generate an offline Conflict scenario | **scenario_create_conflict** |
| Create or statically validate an addon | **mod** |
| Compile-check Enforce Scripts without opening an editor | **wb_check** |
| Start, inspect, diagnose, restart, or stop Workbench | **wb_launch**, **wb_state**, **wb_connect**, **wb_diagnose**, **wb_restart**, **wb_shutdown** |
| Build and inspect a Workbench build | **wb_build**, **wb_log_query** |
| Edit a live world or its entities | **wb_entity_\***, **wb_component**, **wb_layers**, **wb_terrain**, **wb_clipboard**, **scenario_create** |
| Inspect or manage live resources | **wb_resources**, **wb_prefabs**, **wb_projects**, **wb_localization**, **wb_script_editor**, **wb_validate** |
| Stage Observer, launch an exact-owned game, run captures, and export evidence | **observer_setup**, **game_launch**, **observer_run_begin**, **observer_run_status**, **observer_run_finalize**, **observer_run_discard**, **observer_prepare_launch**, **observer_runtime**, **observer_instances**, **observer_capture**, **observer_job** |

Use game-data tools rather than ordinary filesystem commands to inspect the
installed game. Use **game_duplicate** for a base-game `.et` prefab and
**wb_entity_duplicate** for an entity already placed in the open world; they
are different operations.

## MCP Prompts and Resources

Clients that expose MCP prompts can offer **create-mod** and **modify-mod** as
guided starting contexts. Treat them as task scaffolding, then follow the
project-specific instructions and the tool-routing rules above.

Some clients can also browse these read-only resource templates:

- `enfusion://class/{className}` for a known Enfusion class;
- `enfusion://pattern/{patternName}` for a bundled implementation pattern; and
- `enfusion://group/{groupName}` for a grouped pattern collection.

If the client does not expose prompts or resources, use **api_search** and
**wb_knowledge** for the equivalent discovery work. Do not assume a resource
template grants write access or replaces a tool call.

## Project, Resource, and GUID Rules

- Pass the exact target `.gproj` through `gprojPath` whenever a tool asks for
  it, or first establish that exact project as the verified running Workbench
  lifecycle target. The server never chooses an addon by scanning a container.
- Dependency lookup uses the effective add-on roots: automatically discovered
  base-game and standard Workshop roots, plus any nonstandard roots supplied
  through `workbenchAddonDirs` or repeated `--workbench-addon-dir` flags.
- Treat .meta GUIDs as durable references. Do not regenerate, replace, or
  hand-edit them casually.
- Search with **asset_search** before choosing a game resource. Preserve
  prefab ancestry unless a standalone flattened copy is intentional.
- **game_duplicate** supports `.et` prefabs only, loaded from extracted data,
  loose game data, or PAK files. `.conf` copying is intentionally outside this
  prefab-specific tool. With register=true it requires a compatible Workbench
  that is already running; it does not launch Workbench. Launch the exact
  target `.gproj` first or pass the matching `gprojPath`.
- With `game_duplicate(register=false)`, the copied `.et` has a fresh internal
  entity ID but no registered resource GUID or Workbench-created `.meta` file.
  Registration does not require a GUID: after opening the exact destination
  project in Workbench, call **wb_resources** with `action: "register"` and the
  copied file's absolute path. **wb_resources** verifies that the existing file
  belongs to the exact active project before Workbench creates the `.meta` file
  and assigns the resource GUID. Verify the result with **wb_resources**
  `getInfo` or **wb_prefabs** `getGuid` before referencing the copy.
- Resource registration is document-independent. A generic exact-owned
  Workbench with no open World Editor document can register loose resources;
  registration remains prohibited during actual Play mode.
- A `game_duplicate(register=true)` result can be a recoverable partial
  success: the `.et` may have been written even though registration failed.
  Preserve the file, open its exact destination project, and register that
  existing absolute path with **wb_resources**. Registration fails closed if
  the path is outside the active project. Do not rerun **game_duplicate** at
  the same destination; it refuses to overwrite an existing file.
- Reopen and validate directly patched .et, .conf, and world resources in
  Workbench before treating them as usable. Prefer Workbench-created metadata.
- Never reuse a project GUID, resource GUID, entity ID, or mod prefix from a
  similar project.

## Workbench API Workflow

### Normal live editing

1. Call **wb_launch** with the exact gprojPath. A fresh MCP-owned editor opens
   as a normal, focusable attended window; restoring or focusing it must not be
   treated as an automation failure.
2. Confirm readiness with **wb_connect** or inspect the editor with
   **wb_state**.
3. If the editor is in Play mode, call **wb_stop** before changing the world.
4. Inspect the target before mutation, make the smallest scoped change, then
   inspect the resulting state.
5. Save intentional edits through the supported target-bound save workflow
   below or through an attended editor action.
6. After game-script changes, use **wb_check** with the exact absolute
   gprojPath and declared configuration for a hidden compile-only preflight.
   Use **wb_restart** when the task actually needs a clean attended editor
   replacement after compilation. **wb_reload** reloads Workbench plugins
   only; it is not a game-script reload.
7. Restore or cancel active Observer captures and wait for terminal jobs before
   calling **wb_shutdown**.

Do not assume a live action succeeded because the call returned. Read the tool
result and re-inspect the editor or changed resource. Most scene mutations
require edit mode. There is no general automated Play action: when attended
Play testing is needed, ask the user to enter Play, wait for confirmation,
verify state, and use **wb_stop** to return to edit mode.

### Explicit resource save

The only automated save is target-bound. It is not a general Save or Save As
API.

1. Call **wb_launch** with both gprojPath and resourcePath for one existing
   .ent world or .et prefab.
2. Make edits only to that startup target. A target-bound session refuses
   programmatic document switching.
3. Call **wb_save_resource** with confirm set to "save" and the same
   resourcePath.
4. Inspect the returned changed paths and reopen or inspect the saved resource.

The save call refuses generic Workbench sessions, a missing or different
resourcePath, and paths that were not supplied at launch.
It also refuses an inherited prefab containing explicit empty nested override
blocks before invoking Workbench, because the native template serializer can
silently remove those load-bearing overrides. Preserve such a prefab with a
minimal direct source edit and relaunch it before further live editing.

### Build, lifecycle, and diagnostics

- While the MCP owns the lifecycle, use **wb_check** for a bounded Enforce
  Script compile-only preflight. Treat only `compilation.status=compiled` as
  script success. `PROJECT_COMPILE_FAILED` carries the exact module, bounded
  diagnostics, and attributed log evidence. This result says nothing about
  resources, materials, prefabs, worlds, packaging, or whole-addon validity.
- While the MCP owns the Workbench lifecycle, use **wb_build** with an explicit
  .gproj and a caller-exclusive empty output directory.
- Use **wb_diagnose** for launch, connection, helper, or target-identity
  failures. Do not guess at a cause or terminate processes by name.
- **wb_restart** and **wb_shutdown** operate only on the exact MCP-owned
  Workbench process. They must not be used as a way to take over a user-owned
  editor.
- For project scripts or CI when no live MCP owns the lifecycle, use the
  standalone runner. Its contract is linked at the top of this document.

## Observer API Workflow

Observer captures are evidence transactions, not a substitute for validation.
Inspect the capture itself and record what it proves and does not prove.

### Start an evidence run

1. Call **observer_setup** to inspect or stage the managed companions when
   needed.
2. Call **observer_run_begin**. It becomes the process-local active run; retain
   its runId when work may need an explicit cross-reference.
3. Choose one renderer: a prepared runtime or an already launched compatible
   Workbench. Observer capture never launches Workbench for you.

### Runtime capture

1. Prefer **game_launch** action=start for a normal exact-owned renderer. Supply
   an exact absolute gprojPath, or omit it only when the running owned Workbench
   has the intended active project. Optionally select a project-contained world;
   otherwise discovery must find exactly one registered `.ent`. Retain the
   returned sessionId, runtimeId, canonical project/profile/world, and opaque
   capture target. `listenServer` is the default; request `client` explicitly.
   A readiness warning is partial success and still owns a runtimeId that must
   be inspected or stopped.
2. **game_launch** owns the world/server selector, add-on roots/GUIDs, profile,
   observer policy flags, display policy, and process owner token. Do not pass
   those through `arguments`. Graphical launches use native borderless
   fullscreen by default.
   Do not pass `-window`, `-screenWidth`, or `-screenHeight`. Leave
   `forceNonNativeWindowSize` unset unless native fullscreen cannot be used for
   a compelling external reason; the exceptional field requires bounded width,
   height, and a meaningful justification. Large screenshots are not a reason
   to shrink the renderer—bound `observer_capture.image` output instead.
3. The baseline supports one initial launch family for each retained derived
   profile. Retry the exact same request to recover a lost response. Never vary
   inputs to force a relaunch: changed, stale, invalidated, expired, or terminal
   evidence requires a future successor workflow or a deliberately fresh
   isolated managed/profile root and MCP lifecycle.
4. For an external launcher or primitive diagnosis, call
   **observer_prepare_launch** and retain its sessionId and preparedLaunchId.
   Preparation is data-only and assigns a session-specific `-logsDir`; do not
   replace it. **observer_runtime** action=start consumes preparedLaunchId and
   returns runtimeId; external launching may instead use the prepared argument
   array. These primitives remain public and are not replaced by the composite.
5. Call **observer_instances** with the runtime sessionId when explicit
   selection is needed and retain its opaque target.
6. Call **observer_capture** with the target and requested view. Omit runId to
   use the active run and omit captureLabel for durable automatic allocation.
   With exactly one compatible renderer, omit target as well.
7. **observer_job** operations require only action and jobId.

For runtime preparation and explicit inventory, sessionId is required. The
preferred capture target carries it internally. Do not replace session
authority with a PID, process name, or runtimeId.

### Workbench capture

1. Launch the target Workbench project through **wb_launch** and confirm it is
   ready.
2. Call **observer_instances** and select the compatible Workbench renderer.
3. Submit **observer_capture** with the selected opaque target, or omit target
   when Workbench is the only compatible renderer. Explicit-view priming is
   automatic on an exact editor with the restoration API.
4. Restore or cancel outstanding captures and wait for terminal jobs before
   restarting or shutting down Workbench.

### Capture and cleanup contract

- A capture uses an explicit runId or the process-local active run. Labels are
  durably allocated when omitted. A capture may also be runless.
- Prefer the opaque target from inventory. It binds backend, exact instance,
  runtime session, and world revision. Do not combine target with legacy
  sessionId, instanceId, or expectedWorldRevision fields. Targetless delegated
  selection succeeds only with exactly one compatible renderer.
- Use view kind=current first. Explicit pose and look-at requests require the
  selected backend capability and may be safely refused.
- Synchronous capture returns one validated image in the requested format.
  Omit `image` for a native-resolution PNG, or provide independent
  `maxWidth`/`maxHeight` fit-inside bounds and `format`=`png`, `jpeg`, or
  `webp`. JPEG and WebP accept an optional quality from 1 through 100 within
  the configured range and otherwise use the configured default; PNG rejects
  quality. For asynchronous capture, poll **observer_job** action=status, use
  action=read when complete, and use cancel or release only as the job
  contract allows. The read result carries the actual MIME type and image
  metadata. Runless synchronous delivery, successful asynchronous reads, safe
  terminal cancellation, and oversized inline results automatically attempt
  release; honor `cleanupRequired` and the retained job when cleanup fails.
- Review images before **observer_run_finalize**. Finalization exports reviewed
  labels only to a configured allowlisted evidence root; use
  **observer_run_discard** when no evidence should be retained.
- For an exact-owned runtime capture selected for export, attach its correlated
  runtime log semantically with `supportingFiles: [{ kind: "relevantLog",
  label: "runtime", sourceCaptureLabel: "<captureLabel>" }]`. Observer resolves
  only the private exact-generation grant for that capture's assigned
  `script.log`; it does not allowlist the profile. Keep the `path` form for
  logs beneath explicitly configured `supportingLogRoots`, including external
  launches.
- Before an MCP-owned runtime stop, wait for every job and camera restoration
  to reach terminal state. Then call **game_launch** action=stop for a
  composite-started runtime or **observer_runtime** action=stop for a
  primitive-started runtime, with its exact runtimeId. Never stop by PID,
  process name, or broad process-tree action.

## Safety and Scope

- Make only changes needed for the current request. Do not reset, delete,
  rename, or broadly reformat unrelated work.
- Preserve user-authored changes and project-specific documentation.
- Keep private paths, tokens, logs, profiles, caches, and generated evidence
  out of commits.
- Avoid cloud-synchronized or read-only project locations during live
  Workbench work; locks and changed attributes can prevent loading or saving.
- Do not publish, push, open a pull request, release, or upload a Workshop
  item without the user's explicit approval immediately before that action.
- Treat generated code and prefabs as a starting point. Inspect, compile, and
  test them before claiming they work.

## Validation

Choose checks proportional to the change. A typical complete pass is:

1. Run **mod** with action=validate for the explicit target addon.
2. Reopen or inspect every changed prefab, config, and world resource.
3. Run **wb_check** for the exact project and declared configuration after
   script changes. Launch an attended editor only when the task also needs
   live inspection, editing, or Play testing.
4. Run the project's targeted static checks and tests.
5. For gameplay, have the user enter Play when required, verify the editor
   state, exercise concrete acceptance cases, and return to edit mode.
6. Test the required real-client count for networking behavior; solo Play does
   not prove replication, join-in-progress, ownership, or authority.
7. Build when packaging is in scope and verify fresh output rather than only a
   process exit.

Record what actually ran, relevant Workbench and game versions, client roles,
observed results, and remaining gaps. Never describe an unrun check as passed.

## Troubleshooting

| Symptom | Safe next step |
|---|---|
| **wb_connect** cannot reach Workbench | Confirm the NET API and target .gproj, then run **wb_diagnose**. |
| **wb_build** reports `exitStatus.classification: "windows_exception"` | Treat it as a Workbench engine crash, not an output-attestation failure or usable build. Record `nativeStatus`/`exceptionName`, inspect the attributed log with **wb_log_query**, and do not retry automatically. |
| **wb_check** returns `PROJECT_COMPILE_FAILED` | Fix the reported module and bounded compiler diagnostics, then rerun the exact compile-only check. Do not substitute `mod(action: "validate")`; it does not compile Enforce Scripts. |
| **wb_check** returns `compilation.status: "indeterminate"` | Preserve the distinct timeout, abort, exception, or nonzero `exitStatus`; do not relabel it as a compiler error or retry automatically. |
| A wb_* action reports an undefined API function | The companion is absent, stale, or incompatible. Run **wb_diagnose**, then launch the exact project through **wb_launch**. |
| A component is Unknown or a script change is stale | Fix compile errors, save intentional work, and use **wb_restart**. Do not use **wb_reload** for game scripts. |
| A duplicated resource has no usable GUID | Open the exact destination project in Workbench, then call **wb_resources** with `action: "register"` and the copied file's absolute path. Registration verifies that the file is inside that active project and creates its `.meta` GUID; no GUID is needed as input. |
| **game_duplicate** registration fails after copying | Keep the copied file, open its exact destination project, and register its absolute path with **wb_resources**. Do not rerun **game_duplicate** at the occupied destination. |
| Observer capture is rejected for world binding | Re-run **observer_instances** immediately and use the renderer's new opaque target. |
| **game_launch** or **observer_runtime** reports identity mismatch or stop is blocked | Preserve the receipt. Finish or cancel captures and wait for restoration; never terminate the process by PID or name. |

## Completion Notes

Before reporting completion:

- Re-inspect changed files and preserve unrelated work.
- Confirm new resources have stable metadata and resolving references.
- State the validation actually performed and any manual, runtime, or
  multiplayer work still required.
- Clean up Observer jobs and exact-owned runtimes; shut down an MCP-owned
  Workbench when its live work is complete.
- Update the target project's documentation when a workflow, acceptance case,
  dependency, or known limitation changed.

## MCP Problem Tracking

Track ReforgerForge MCP problems here whenever this MCP checkout and its
tracker are available, even when the current task, working directory, or target
mod is elsewhere in the containing monorepo. The place where a problem is
discovered does not determine tracker ownership: if the defect or limitation is
in the ReforgerForge MCP, its advertised API, helpers, configuration, packaging,
or guidance, record it in
[`agents/mcp-tracking`](mcp-tracking/README.md).

Do not put a target mod's own code or content defects in the MCP tracker. If
this guide has been copied into a standalone workspace that does not contain
the linked tracker, report the MCP problem to the user and identify the source
MCP checkout where it should be recorded instead of creating an unrelated
local tracker.

1. Search both open and resolved tracker files before creating an entry.
2. Use the next unused ID in the single shared `MCP-NNN` sequence. Search all
   four tracker files first, retain IDs when moving entries, and never create
   subsystem-specific IDs such as `DEV-001` or `OBS-001`.
3. Record an unintended, reproducible failure of the supported MCP contract as
   a bug in [MCP_BUGS.md](mcp-tracking/MCP_BUGS.md). Record an open contract
   decision, acknowledged limitation, or deferred improvement as an issue in
   [MCP_ISSUES.md](mcp-tracking/MCP_ISSUES.md). If unsure, use the issue queue
   and explain the uncertainty.
4. Append new open entries at the bottom. Include an ID, status, priority when
   meaningful, observed behavior, intended contract or required decision,
   affected areas, and evidence.
5. Tell the user that the problem was found and documented, naming the tracker
   path and entry ID. Do not silently leave a discovered MCP problem only in
   chat, a plan, or a code comment.
6. When resolving or verifying an entry, preserve its ID, record the closure
   date and validation evidence, and move it to the top of the corresponding
   `*_RESOLVED.md` history. Tell the user about that move as well.

An entry is not resolved merely because wording changed. Where a public
contract is involved, verify that registered schemas and descriptions, handler
behavior, focused tests, and current operator or coding-tool guidance agree.
