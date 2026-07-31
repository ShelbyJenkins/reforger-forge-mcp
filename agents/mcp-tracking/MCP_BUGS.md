# Outstanding MCP Bugs

This FIFO queue contains unintended, reproducible failures of the supported
MCP contract. Append new findings at the bottom; move resolved entries to
[MCP_BUGS_RESOLVED.md](MCP_BUGS_RESOLVED.md).

### MCP-006 — resource registration can stall and disconnect Workbench

**Status:** Open

**Severity:** Non-breaking authoring failure

**Observed:** 2026-07-28

`wb_resources(action: "register")` timed out after 10 seconds while registering
a newly created Sedan material. The next request reported an unknown Workbench
mode, and `wb_diagnose` found that bridge Ping also timed out.

**Impact:** Registration cannot be relied on during an active target-bound
authoring session and may require closing the exact owned editor.

**Workaround:** Safely close the unsaved target session, reopen the same
explicit prefab after the material files exist, and use Workbench to create the
material slots and save the assignment. Do not patch the prefab directly as a
substitute.

### MCP-010 — guarded build reports a non-vacant endpoint after its process exits

**Status:** Open

**Severity:** Breaking validation failure

**Observed:** 2026-07-28

A fresh `wb_build` retry failed with `ENDPOINT_UNVERIFIABLE`, reporting that TCP
`127.0.0.1:5775` remained owned by a PID after Workbench exited. An immediate
read-only process check could not find that PID.

**Impact:** The guarded lifecycle can block subsequent builds after a
Workbench crash even when the reported owner no longer exists.

**Workaround:** Pending. Do not terminate a process when the reported target
cannot be verified as a currently owned Workbench process.

**Additional reproduction (2026-07-31):** A SaltLine `wb_build` target-build
crashed after reporting script diagnostics. Windows continued to report two
listeners for `0.0.0.0:5775`, while both owning PIDs were absent from
`Get-Process` and `Win32_Process`. `wb_shutdown` correctly declined to signal an
unverified process, but later `wb_build` calls remained blocked with
`RECOVERY_REQUIRED`. A standalone guarded build requested on the otherwise
unused port `5776` was also refused with `ENDPOINT_UNVERIFIABLE` against the
durable stale lifecycle state, so the documented configurable-port escape path
could not establish an independent recovery build.

**Expected:** Once the exact managed Workbench process is proven dead, recovery
must either retire ghost socket rows safely or allow a freshly configured vacant
endpoint to establish a new guarded lifecycle without requiring operators to
terminate an unverifiable PID.

**Affected:** `wb_build`, `wb_shutdown`, the standalone
`reforger-forge-workbench build` runner, and Workbench endpoint-vacancy recovery
in `src/workbench/runner.ts` / `src/workbench/session-controller.ts`.

### MCP-032 - Workbench launch and build disagree on target-relative dependencies

**Status:** Open

**Severity:** Breaking validation failure

**Observed:** 2026-07-28

`wb_build` successfully resolved and built the exact
`OnePointZeroOneTestContent.gproj`, including its sibling Core dependency, from
the target-relative OnePointZeroOne add-on root. Immediately afterward,
`wb_launch` with the same exact `gprojPath` and a valid project-relative world
target refused with `INVALID_CONFIG`, claiming that Core GUID
`E62D3489FAA8E058` was missing.

**Expected contract:** Dependency preflight should use the same effective
automatic, explicit, and target-relative add-on roots for guarded build and
target-bound launch.

**Affected areas:** `wb_launch`, `wb_build`, dependency preflight, and
target-relative add-on discovery.

**Evidence:** The successful build returned 40 fresh TestContent artifacts,
verified process ownership, verified endpoint vacancy, and exit code `0`.
The following target-bound launch started no Workbench process and returned
the contradictory missing-Core refusal.

**Workaround:** Restart the MCP host through the TestContent-specific launcher
so Core and TestContent are explicit add-on roots, or use the already verified
guarded build while editor inspection remains blocked.

### MCP-033 - owned `dedicated` runtime launches the game client executable

**Status:** Open

**Severity:** Breaking runtime-lifecycle mismatch

**Observed:** 2026-07-28

`observer_prepare_launch(runtimeKind: "dedicated")` followed by
`observer_runtime(action: "start")` launched the installed graphical
`ArmaReforgerSteamDiag.exe` with `-server -noRender`. The resulting runtime
created a local player and failed the dedicated-server fixture's fresh-process
precondition because one identity mapping already existed.

**Expected contract:** A supported `dedicated` runtime kind should launch and
own the installed dedicated-server executable, or the public schema and
description should reject that runtime kind and direct callers to an explicit
external-launch workflow.

**Affected areas:** `observer_prepare_launch`, `observer_runtime`,
owned-runtime executable discovery, and runtime-kind documentation.

**Evidence:** The observer receipt classified the process as `dedicated`, but
the exact process path was the game client executable and the server log
reported a local player plus
`fresh dedicated-server process inherited 1 runtime identity mappings`. A
control run using the installed `ArmaReforgerServerDiag.exe` with the prepared
arguments reported `freshProcessEmpty=1 retained=0` and completed the
disconnect/reconnect fixture.

**Workaround:** Use `observer_prepare_launch` only to prepare the exact
arguments and exclusive profile, launch the installed dedicated-server
executable externally, and retain exact PID/path/creation-time identity for
safe cleanup.

### MCP-034 - `observer_run finalize` schema marks a required label list optional

**Status:** Open

**Severity:** Non-breaking public-contract mismatch

**Observed:** 2026-07-28

The registered `observer_run` input schema exposes `includeCaptureLabels` as
optional, and the tool description does not state that it is mandatory for
`action: "finalize"`. A finalize request without it passed schema validation
but failed in the handler with `INVALID_REQUEST`, stating that `runId`,
`includeCaptureLabels`, and `review` are required.

**Expected contract:** The public action schema/description and handler must
agree. Finalize-specific required inputs should be represented by a
discriminated action schema where possible, or stated explicitly and tested
in the registered description.

**Affected areas:** `src/observer/tools.ts`, registered MCP metadata,
Observer API documentation, and focused schema/handler contract tests.

**Evidence:** The live tool schema declared
`includeCaptureLabels: ...optional()` while the handler's finalize branch
rejected its omission before attempting export. Supplying the reviewed label
list allowed finalization to succeed.

**Workaround:** Always provide a non-empty `includeCaptureLabels` list when
finalizing an Observer run.

### MCP-036 - managed server launch is not borderless and steals foreground focus

**Status:** Open

**Severity:** Disruptive runtime-launch behavior

**Observed:** 2026-07-28

When the server is launched through the MCP runtime workflow, its window does
not open in borderless fullscreen and it takes foreground focus from the
active application.

**Expected contract:** Unless a caller explicitly opts into a focused or
windowed launch, the managed graphical server should use borderless fullscreen
and remain in the background without stealing keyboard or mouse focus. This
must agree with `observer_prepare_launch` guidance that the default launch uses
`-noFocus -forceUpdate`.

**Affected areas:** `observer_prepare_launch`, `observer_runtime`, graphical
listen-server launch arguments, window-mode normalization, and operator
documentation.

**Evidence:** User-observed during the OnePointZeroOne validation workflow.
The server visibly opened in the wrong window mode and displaced the user's
foreground application. Exact argument/process reproduction still needs a
focused regression test covering default arguments and explicit opt-outs.

**Workaround:** Pending. Avoid relying on the managed launch to preserve focus
until the default and opt-out window-mode paths are verified.

### MCP-037 - `prefab(action: "create")` corrupts inherited game-mode structure

**Status:** Open

**Severity:** P0

**Observed:** 2026-07-28

Creating a `gamemode` prefab with
`parentPrefab="{EF18A4EFB5E667B2}Prefabs/MP/Modes/TeamDeathmatch/GameMode_TeamDeathmatch_Auto.et"`
and `includeAncestry=true` wrote a `GenericEntity` child even though the
parent's root class is `SCR_BaseGameMode`. The generated `components` block
also promoted nested container objects such as `EndGameAction`,
`SCR_UIDescription`, and `SCR_BaseGameMode` into peer components.

**Expected contract:** Prefab creation with a parent must preserve the parsed
root entity class and component/container nesting. Ancestry expansion must add
only actual inherited components and must remain loadable by Workbench.

**Affected areas:** `prefab` create recipes, packed-parent ancestry parsing,
root-class selection, nested container traversal, and prefab-create tests.

**Evidence:** The live tool reported 118 inherited components and wrote
`addons/addons-scenarios/KillBox/Prefabs/GameModes/GameMode_KillBox.et` beginning with
`GenericEntity : "{EF18A4EFB5E667B2}..."`. Its component peers included
`EndGameAction`, multiple `SCR_UIDescription` objects, and an
`SCR_BaseGameMode` object. The same MCP's `prefab(action: "inspect")` correctly
reports the parent chain root as `SCR_BaseGameMode`, so the create output
disagrees with the inspection result.

**Workaround:** Create a minimal typed child manually from the inspected raw
parent serialization, then register, reopen, and validate it in the exact
target Workbench project.

### MCP-038 - `scenario_create_conflict` treats `patrolCount: 0` as the default

**Status:** Open

**Severity:** P1

**Observed:** 2026-07-28

Creating a temporary Conflict scaffold with one base whose
`patrolCount` was explicitly `0` still generated `Defenders.layer` with two
`SCR_AmbientPatrolSpawnPointComponent` entities.

**Expected contract:** An explicit zero must disable defender generation for
that base. The documented default of two should apply only when
`patrolCount` is omitted.

**Affected areas:** `scenario_create_conflict`, base patrol-count defaulting,
Defenders layer generation, and zero-value regression tests.

**Evidence:** The successful KillBox scaffold creation emitted
`Worlds/KillBox_Montignac_Layers/Defenders.layer` with patrol spawners at
`4823.455 164.342 7094.566` and `4723.455 164.342 7094.566`, despite the
single requested base specifying `patrolCount: 0`.

**Workaround:** Delete the generated defender entities/layer in the
target-bound Workbench session before saving the final world.

### MCP-040 - loose-resource registration deadlocks behind World Editor edit mode

**Status:** Open

**Severity:** P0

**Observed:** 2026-07-29

After a successful generic `wb_launch(gprojPath)`, Workbench loads and compiles
the exact project but has no opened World Editor document. The helper reports
`mode: game` because `WorldEditor.GetApi()` is null. `wb_resources(action:
"register")` then refuses every loose resource as if Workbench were in Play
mode, and `wb_stop` cannot establish edit mode because there is no registered
world to open.

This creates a bootstrap deadlock for a new addon: target-bound `wb_launch`
requires an existing `.meta`, while the supported operation that creates that
metadata refuses to run until a registered resource is already open.

**Expected contract:** ResourceManager registration is document-independent
and must be available in an exact-owned generic Workbench session when no
simulation is running. The mode guard should distinguish `no_world_editor`
from actual Play mode, or `wb_launch` should provide a supported empty edit
document for first-resource registration.

**Affected areas:** `wb_resources`, `requireEditMode`,
`EMCP_WB_GetState`, generic `wb_launch`, first-resource registration, and
target-bound launch preflight.

**Evidence:** KillBox generic Workbench PID `23892` launched successfully and
compiled the Game module without errors. The resource database logged the four
new `.conf`, `.et`, and `.ent` files as unregistered. All four
`wb_resources(register)` calls were refused with “Cannot register resource
while in play mode.” `wb_stop` was acknowledged but still reported
`WorldEditorAPI not available`. Target-bound launch had previously refused the
world because its `.meta` did not yet exist.

**Acceptance tests:**

1. Launch a new addon containing a loose `.et` and `.ent` but no metadata,
   register both from a generic exact-owned session, and prove Workbench
   creates their `.meta` GUIDs.
2. Continue refusing registration during actual World Editor Play mode.
3. Reopen each registered resource in a fresh target-bound session and save it
   successfully.
4. Preserve exact project ownership, path containment, and lifecycle
   generation checks throughout the bootstrap.

**Workaround:** Pending. A disposable pre-registered edit document can break
the cycle, but hand-authored metadata or raw NET API calls are not acceptable
normal workflows.

### MCP-041 - `wb_layers` reports destructive mutations as successful when the helper rejected them

**Status:** Open

**Severity:** P1

**Observed:** 2026-07-29

`wb_layers(action: "delete", layerPath: "Bases")` and the equivalent call for
`Defenders` returned a successful `Layer Updated` receipt saying the layer was
deleted. The same response then included the Workbench helper's contradictory
message: `Unknown action: delete. Valid: list, getActive, getEntityLayer,
isVisible, getInfo, toggleLock`. Neither layer was deleted.

**Expected contract:** Every mutation exposed by the public `wb_layers` schema
must be implemented by the staged helper. When the helper rejects an action,
the MCP tool must return `isError: true` and must never prepend a false success
receipt.

**Affected areas:** `wb_layers`, `EMCP_WB_Layers`, staged-helper/server schema
parity, helper result status validation, and layer mutation regression tests.

**Evidence:** In the target-bound KillBox world session, the calls for
`Bases.layer` and `Defenders.layer` both produced `Deleted layer ...` followed
by the helper's `Unknown action: delete` message. Saving the world changed the
empty `Bases.layer` but left the 777-byte `Defenders.layer` and its two
unintended FIA patrol spawners intact.

**Workaround:** After explicit authorization, save all supported live edits
through the target-bound Workbench session, shut Workbench down, and remove only
the generated obsolete layer files outside Workbench.

### MCP-042 - `wb_component` reports an added prefab component that `wb_save_resource` drops

**Status:** Open

**Severity:** P0

**Observed:** 2026-07-29

In a target-bound KillBox game-mode prefab session,
`wb_component(action: "add", componentClass: "OPZO_BodyIdentityComponent")`
returned `Component Added`, and a subsequent component list showed the new
component. `wb_entity_modify` could not address any of its attributed
properties, reporting both `Component not found` and `SetVariableValue returned
false`. `wb_save_resource` then returned a successful changed receipt, but the
saved `.et` contained no OPZO component.

The same save also silently removed the prefab's explicit empty
`SCR_ScoringSystemComponent.m_aActions` override, thereby restoring the
inherited team-deathmatch end-game action. The successful save therefore both
lost the requested addition and changed unrelated load-bearing behavior.

**Expected contract:** A component addition reported as successful must remain
addressable and must be serialized by the explicit target-bound save.
`wb_save_resource` must preserve unrelated child overrides. If Workbench cannot
persist an added component or an empty inherited-array override, the mutation
or save must fail explicitly rather than return success.

**Affected areas:** `wb_component`, `wb_entity_modify`,
`wb_save_resource`, target-bound prefab editing, script-component property
lookup, inherited empty-array serialization, and mutation/save verification.

**Evidence:** Exact target
`addons/addons-scenarios/KillBox/Prefabs/GameModes/GameMode_KillBox.et` was opened in MCP-owned
Workbench PID `23264`. The component list increased from 70 to 72 entries and
showed `OPZO_BodyIdentityComponent`. After the successful save receipt, the
file diff contained no OPZO component and showed only deletion of the explicit
empty scoring-actions block. The component and the scoring override had to be
restored by a direct minimal source edit, after which `prefab(action:
"inspect")`, all seven static checks, and a guarded Workbench build succeeded.

**Workaround:** Add and configure the component with a minimal direct prefab
edit, restore any stripped empty inherited-array overrides, then inspect the
full prefab ancestry and run a guarded build before treating the resource as
valid.
