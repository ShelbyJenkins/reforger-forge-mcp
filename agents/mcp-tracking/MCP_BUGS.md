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
