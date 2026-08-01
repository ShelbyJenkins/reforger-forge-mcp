# ReforgerForge Coding-Agent Guide

This is a starter workspace instruction file for coding agents that use the
ReforgerForge MCP server. Copy it to a mod workspace root, replace the
placeholders, and merge it with the workspace's existing project rules.

This document is deliberately about coding-tool use and workflows. Installation,
client registration, machine paths, and configuration troubleshooting belong in
the setup documentation instead:

- [Setup and configuration](https://github.com/wastelandgoats/reforger-forge-mcp/blob/main/SETUP.md)
- [AI client registration and troubleshooting](https://github.com/wastelandgoats/reforger-forge-mcp/blob/main/agents/README.md)
- [Observer usage guide](https://github.com/wastelandgoats/reforger-forge-mcp/blob/main/docs/observer.md)
- [Standalone Workbench runner reference](https://github.com/wastelandgoats/reforger-forge-mcp/blob/main/docs/runner-cli.md)

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
| Create or validate an addon | **mod**; use **wb_build** to build |
| Start, inspect, diagnose, restart, or stop Workbench | **wb_launch**, **wb_state**, **wb_connect**, **wb_diagnose**, **wb_restart**, **wb_shutdown** |
| Build and inspect a Workbench build | **wb_build**, **wb_log_query** |
| Edit a live world or its entities | **wb_entity_\***, **wb_component**, **wb_layers**, **wb_terrain**, **wb_clipboard**, **scenario_create** |
| Inspect or manage live resources | **wb_resources**, **wb_prefabs**, **wb_projects**, **wb_localization**, **wb_script_editor**, **wb_validate** |
| Stage Observer, run captures, and export evidence | **observer_setup**, **observer_run**, **observer_prepare_launch**, **observer_runtime**, **observer_instances**, **observer_capture**, **observer_job** |

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

1. Call **wb_launch** with the exact gprojPath.
2. Confirm readiness with **wb_connect** or inspect the editor with
   **wb_state**.
3. If the editor is in Play mode, call **wb_stop** before changing the world.
4. Inspect the target before mutation, make the smallest scoped change, then
   inspect the resulting state.
5. Save intentional edits through the supported target-bound save workflow
   below or through an attended editor action.
6. After game-script changes, use **wb_restart** for a clean owner-scoped
   compilation session. **wb_reload** reloads Workbench plugins only; it is not
   a game-script reload.
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
2. Call **observer_run** with action=begin and retain the returned runId.
3. Choose one renderer: a prepared runtime or an already launched compatible
   Workbench. Observer capture never launches Workbench for you.

### Runtime capture

1. Call **observer_prepare_launch** and retain its sessionId and
   preparedLaunchId. Preparation assigns a session-specific `-logsDir`; do not
   replace it.
2. To let the MCP own the runtime, call **observer_runtime** with action=start,
   preparedLaunchId, and a unique idempotencyKey; retain its runtimeId.
   External launching may use the prepared argument array instead.
3. Call **observer_instances** with the runtime sessionId and choose one
   renderer instance.
4. Call **observer_capture** with the runId, runtime sessionId, instanceId,
   unique captureLabel, requested view, and the world binding from the
   immediately preceding inventory.
5. Runtime **observer_job** operations also require the same sessionId.

For runtime work, sessionId is required. Do not replace it with a PID, process
name, or runtimeId.

### Workbench capture

1. Launch the target Workbench project through **wb_launch** and confirm it is
   ready.
2. Call **observer_instances** and select the compatible Workbench renderer.
3. Submit **observer_capture** using the selected instance. A sessionId is
   optional only for an explicitly selected already-running Workbench renderer.
4. Restore or cancel outstanding captures and wait for terminal jobs before
   restarting or shutting down Workbench.

### Capture and cleanup contract

- Every capture needs the runId and a unique normalized captureLabel.
- Copy the inventory's opaque expectedWorldRevision into the capture request as
  the required world binding. Do not send separate world-ID or epoch fields.
  A revision may represent a runtime with no loaded world; only a current-view
  capture is available in that state.
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
  metadata.
- Review images before **observer_run** action=finalize. Finalization exports
  reviewed labels only to a configured allowlisted evidence root; use discard
  when no evidence should be retained.
- For an exact-owned runtime capture selected for export, attach its correlated
  runtime log semantically with `supportingFiles: [{ kind: "relevantLog",
  label: "runtime", sourceCaptureLabel: "<captureLabel>" }]`. Observer resolves
  only the private exact-generation grant for that capture's assigned
  `script.log`; it does not allowlist the profile. Keep the `path` form for
  logs beneath explicitly configured `supportingLogRoots`, including external
  launches.
- Before an MCP-owned runtime stop, wait for every job and camera restoration
  to reach terminal state. Then call **observer_runtime** action=stop with its
  runtimeId and a new idempotencyKey. Never stop by PID, process name, or broad
  process-tree action.

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
3. Launch the target project with all required dependency roots and check
   compile output after script changes.
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
| A wb_* action reports an undefined API function | The companion is absent, stale, or incompatible. Run **wb_diagnose**, then launch the exact project through **wb_launch**. |
| A component is Unknown or a script change is stale | Fix compile errors, save intentional work, and use **wb_restart**. Do not use **wb_reload** for game scripts. |
| A duplicated resource has no usable GUID | Open the exact destination project in Workbench, then call **wb_resources** with `action: "register"` and the copied file's absolute path. Registration verifies that the file is inside that active project and creates its `.meta` GUID; no GUID is needed as input. |
| **game_duplicate** registration fails after copying | Keep the copied file, open its exact destination project, and register its absolute path with **wb_resources**. Do not rerun **game_duplicate** at the occupied destination. |
| Observer capture is rejected for world binding | Re-run **observer_instances** immediately, select the renderer again, and copy its expectedWorldRevision. |
| **observer_runtime** reports identity mismatch or stop is blocked | Preserve the receipt. Finish or cancel captures and wait for restoration; never terminate the process by PID or name. |

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
