# Launch fullscreen without stealing focus — implementation plan

**Goal:** When the MCP launches the Arma Reforger game (observer runtime) or the
Workbench editor, the target application should not steal the user's window
focus on launch, and the game should default to real fullscreen (not a
bordered window) while doing so.

**Decisions locked in (2026-07-26):**
- Game runtime (`observer_prepare_launch` / `observer_runtime`): `-noFocus`
  and `-forceUpdate` become **default-on** launch arguments, still overridable
  per call.
- Workbench (`wb_launch`): also build a "launch without stealing focus" path,
  even though Workbench has no engine-level equivalent and this requires new
  native Win32 launch code (first P/Invoke *launch* surface in this codebase —
  the existing PowerShell helper only *inspects/terminates* processes by PID,
  it never spawns one).

Part 1 is low-risk and self-contained. Part 2 touches the exact-identity /
supervision core of the Workbench lifecycle and has a real design fork with a
known trade-off — read its "Risk" section before starting.

---

## Background

[Startup Parameters](https://community.bistudio.com/wiki/Arma_Reforger:Startup_Parameters)
documents the game client's `Window` section:

- Fullscreen is the **default**; `-window` is what switches to a bordered
  window. There is no documented `-borderless` mode — windowed mode is a real
  window with `-posX`/`-posY`/`-screenWidth`/`-screenHeight`.
- **`-noFocus`** — "prevents window focus stealing on game initialization."
- **`-forceUpdate`** — "forces the application to render and update even when
  the window is out of focus" (needed because a fullscreen app normally
  throttles/pauses when it isn't the active window).

So `-noFocus -forceUpdate` with no `-window` is a real, engine-native
"launch fullscreen, stay in the background, keep rendering" mode — no OS-level
trick needed for the game. This section of the wiki is documented under the
game client, not Workbench; Workbench is a docked-panel editor with no
fullscreen concept, so none of this applies to `wb_launch` (see Part 2).

Today, an operator can *already* get this behavior by passing `-noFocus`
manually in the `arguments` array of `observer_prepare_launch` — unrecognized
tokens pass through untouched
(`reforger-forge-mcp/observer/agent/launch-arguments.ts:58-61`). Part 1 makes
it the default so nobody has to remember it.

---

## Part 1 — Game runtime: default `-noFocus` / `-forceUpdate`

### Current state

`forceUpdate` is already a first-class boolean that flows
tool → agent → argument merge:

1. `reforger-forge-mcp/src/observer/tools.ts:187` — MCP tool schema for
   `observer_prepare_launch`: `forceUpdate: z.boolean().default(false)`.
2. `reforger-forge-mcp/src/observer/launch.ts:9` — `ObserverLaunchInput`
   interface field `forceUpdate: boolean`.
3. `reforger-forge-mcp/observer/agent/control-api.ts:27-37` — the agent's own
   re-validated schema, `prepareLaunchSchema`, has an independent
   `forceUpdate: z.boolean().default(false)` at line 33 (this is the one that
   actually governs behavior — `tools.ts`'s schema just validates the MCP
   surface before the request crosses into the agent).
4. `reforger-forge-mcp/observer/agent/control-api.ts:229-235` — calls
   `mergeLaunchArguments({ ..., forceUpdate: request.forceUpdate })`.
5. `reforger-forge-mcp/observer/agent/launch-arguments.ts:42-110` —
   `mergeLaunchArguments`: recognizes `-forceupdate` as a known flag (line 8,
   `OBSERVER_FLAGS`), dedupes it if the caller already passed it (line 62-65,
   `forceUpdateSeen`), and appends `-forceUpdate` at the end only if
   `input.forceUpdate || forceUpdateSeen` (line 108).

`-noFocus` needs the identical treatment, plus both defaults need to flip from
opt-in (`false`) to opt-out (`true`).

### Changes

**1. `reforger-forge-mcp/observer/agent/launch-arguments.ts`**

```ts
// line 7-8
const VALUE_FLAGS = new Set(["-profile", "-addonsdir", "-addons"]);
const OBSERVER_FLAGS = new Set([...VALUE_FLAGS, "-forceupdate", "-nofocus"]); // add -nofocus

// MergeLaunchArgumentsInput (line 34-40)
export interface MergeLaunchArgumentsInput {
  arguments: readonly string[];
  profilePath: string;
  addonSearchRoot: string;
  stagedAddonPath: string;
  forceUpdate: boolean;
  noFocus: boolean; // add
}

// inside mergeLaunchArguments's loop (line 54-73), parallel to forceUpdateSeen
let forceUpdateSeen = false;
let noFocusSeen = false; // add
for (...) {
  ...
  if (flag === "-forceupdate") { forceUpdateSeen = true; continue; }
  if (flag === "-nofocus") { noFocusSeen = true; continue; } // add
  ...
}

// end of function (line 107-109)
const result = [...unrelated, "-addonsDir", canonicalRoots.join(","), "-addons", uniqueAddonIds.join(","), "-profile", profilePath];
if (input.forceUpdate || forceUpdateSeen) result.push("-forceUpdate");
if (input.noFocus || noFocusSeen) result.push("-noFocus"); // add
return result;
```

**2. `reforger-forge-mcp/observer/agent/control-api.ts`**

```ts
// prepareLaunchSchema, line 27-37
const prepareLaunchSchema = z.object({
  ...
  forceUpdate: z.boolean().default(true),  // was default(false)
  noFocus: z.boolean().default(true),      // add
});

// call site, line 229-235
const argumentsArray = mergeLaunchArguments({
  arguments: request.arguments,
  profilePath,
  addonSearchRoot: staged.addonSearchRoot,
  stagedAddonPath: staged.addonDirectory,
  forceUpdate: request.forceUpdate,
  noFocus: request.noFocus, // add
});
```

**3. `reforger-forge-mcp/src/observer/tools.ts`** (line 175-190,
`observer_prepare_launch` inputSchema)

```ts
inputSchema: {
  runtimeKind: z.enum(["client", "listenServer", "dedicated", "testRunner"]),
  arguments: z.array(z.string().max(32_768)).max(512).default([]),
  profilePath: z.string().min(1).max(32_768),
  sessionTtlMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1_000).default(sessionTtlMs),
  transportPreference: z.array(z.enum(["rest", "mailbox"])).min(1).max(2).default(["rest", "mailbox"]),
  forceUpdate: z.boolean().default(true),  // was default(false)
  noFocus: z.boolean().default(true),      // add
  idempotencyKey: z.string().min(1).max(128).optional(),
},
```

Update the tool `description` string too — it should mention that the launch
defaults to fullscreen-in-background (`-noFocus -forceUpdate`) unless the
caller passes `noFocus: false` / `forceUpdate: false` or includes `-window`
in `arguments`.

**4. `reforger-forge-mcp/src/observer/launch.ts`** (line 3-11,
`ObserverLaunchInput`)

```ts
export interface ObserverLaunchInput {
  runtimeKind: "client" | "listenServer" | "dedicated" | "testRunner";
  arguments: string[];
  profilePath: string;
  sessionTtlMs: number;
  transportPreference: Array<"rest" | "mailbox">;
  forceUpdate: boolean;
  noFocus: boolean; // add
  idempotencyKey?: string;
}
```

This type is passed straight through to `coordinator.prepareLaunch(input)`
(line 53) as an untyped object, so no other change is needed here beyond the
field existing on the interface for callers/tests that construct it directly.

### Testing

- `reforger-forge-mcp/observer/agent/launch-arguments.ts` has no dedicated
  unit test file today (verify with a repo search for
  `mergeLaunchArguments` in `tests/`); if one doesn't exist, add
  `tests/observer/launch-arguments.test.ts` covering:
  - default merge includes both `-forceUpdate` and `-noFocus`.
  - passing `forceUpdate: false, noFocus: false` omits both.
  - passing `-noFocus`/`-forceUpdate` manually in `arguments` is deduped, not
    doubled.
- Search `tests/observer/` and `tests/workbench/observer-*` for existing
  `forceUpdate` assertions (e.g. anything asserting the exact argument array
  built by `observer_prepare_launch`) and update expected fixtures to include
  `-noFocus`.
- Run `npm run test:observer` (or the closest matching script in
  `reforger-forge-mcp/package.json`) after the change.

### Manual verification

Call `observer_prepare_launch` then `observer_runtime` (`action: "start"`)
against a real installation and confirm: the game window never becomes the
foreground window (check via Task Manager / Alt-Tab — it shouldn't appear in
the Alt-Tab ring stealing focus), it renders fullscreen once brought forward,
and screenshots/camera capture still work (this is the observer's core use
case — `-forceUpdate` is what lets rendering continue while unfocused).

---

## Part 2 — Workbench: launch without stealing focus

### Why this is harder than Part 1

Workbench has no `-noFocus` equivalent — nothing in the wiki's `Workbench`
startup-parameter section addresses window activation. The only lever left is
OS-level: Windows' `CreateProcess` accepts a `STARTUPINFO` struct with
`dwFlags = STARTF_USESHOWWINDOW` and `wShowWindow = SW_SHOWMINNOACTIVATE` (or
`SW_SHOWNOACTIVATE`), which tells the new process to open minimized (or
inactive) without taking focus. **Node's `child_process.spawn` does not
expose this** — there is no `windowsHide`-style knob for show-state, only for
suppressing console-window creation.

Today, Workbench is launched with a plain `spawn()` call:
`reforger-forge-mcp/src/workbench/lifecycle-execution.ts:632-645`
(`safeSpawn`), fed by `spawnRecoverable` (line 371-445), which is invoked
from `session-controller.ts:2538+` (`startReserved`) using the plan built by
`buildMcpEditorLaunchPlan` (`launch-plan.ts:688-719`). The spawn options come
from `spawnPolicy()` (`launch-plan.ts:479-491`) via the
`WorkbenchSpawnPolicy` interface (`launch-plan.ts:87-94`), which currently has
no show-state field at all.

### The constraint that shapes the design

`spawnRecoverable` doesn't just fire-and-forget the child — it races the
Node `ChildProcess`'s own `exit`/`error` events against Workbench's exact
identity verification and recovery/termination polling:

- `lifecycle-execution.ts:396-413` — `this.childSupervisor.supervise(key,
  child, ...)` wraps the *actual Node `ChildProcess` object* to produce a
  `SupervisedChildHandle` with `.exit`/`.error` promises
  (`reforger-forge-mcp/src/foundation/child-supervisor.ts:131+`).
- `lifecycle-execution.ts:527-555` (`inspectSpawnedIdentity`) races
  `guard.inspectSpawnedWorkbench({ pid: child.pid, ... })` against
  `supervisedChild.exit` — if the process dies before its exact identity
  (PID + executable path + creation time) is proven, this is how the code
  finds out immediately instead of hanging.
- `lifecycle-execution.ts:557-630` (`terminateExactAndObserve`) does the same
  race during shutdown/recovery.

Two things about `child.pid` and `child` matter here: **the code assumes the
Node `ChildProcess` it holds *is* Workbench itself** — `child.pid` is passed
directly as Workbench's PID, and `child`'s `exit`/`error` events are trusted
as Workbench's own liveness signal. Any redesign has to either preserve that
1:1 relationship, or explicitly break it in a way every downstream consumer
understands.

### Recommended design: a blocking native-launch helper (extends the existing PowerShell pattern)

This codebase already has exactly the plumbing needed, just not for
*launching*: `reforger-forge-mcp/scripts/windows/workbench-lifecycle.ps1` is a
`-Mode`-dispatched helper invoked by
`reforger-forge-mcp/src/platform/windows/exact-process-backend.ts` (`invoke()`,
line 272-330+) — it spawns `powershell.exe -File workbench-lifecycle.ps1
-Mode <mode>`, writes one JSON request line to stdin, reads one JSON response
line from stdout. `Invoke-HoldMutex` (ps1 line 540-602) already demonstrates
the exact shape needed: do the native work, write a response, then **block**
until told to stop.

Add a new mode, e.g. `LaunchBackground`, that:

1. Reads `{ executablePath, arguments: string[], workingDirectory }` from
   stdin.
2. Calls `CreateProcess` via P/Invoke (new `Add-Type` block, same style as
   the existing `LifecycleProcessHandle`/`LifecycleTcpTable` classes at ps1
   line 62+) with `STARTUPINFO.dwFlags = STARTF_USESHOWWINDOW` and
   `wShowWindow = SW_SHOWMINNOACTIVATE` (value `7`; `SW_SHOWNOACTIVATE` is
   `4` if you'd rather it open non-minimized-but-inactive instead of
   minimized — pick one, see "Open choice" below).
3. Writes `{ ok: true, status: "started", pid: <real Workbench PID> }`
   **immediately** so Node isn't blocked waiting.
4. Then calls `WaitForSingleObject` on the real process handle (blocking,
   mirroring `Invoke-HoldMutex`'s `[Console]::In.ReadLine()` block) so this
   PowerShell process's own lifetime — and therefore its Node-visible `exit`
   event — tracks Workbench's actual lifetime.
5. Exits when Workbench exits.

`CreateProcess` takes one command-line string, not an argv array, so building
it requires correct Windows argument quoting (backslash/quote escaping) —
don't skip this, paths like `C:\Program Files\...\ArmaReforgerWorkbenchSteamDiag.exe`
and profile paths will break silently otherwise. Reference algorithm (same
one MSVCRT/`CommandLineToArgvW` expect, which the file already imports for
the reverse direction at ps1 line 130-131):

```csharp
private static string QuoteArgument(string argument)
{
    if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        return argument;
    var result = new StringBuilder();
    result.Append('"');
    int backslashes = 0;
    foreach (char c in argument)
    {
        if (c == '\\') { backslashes++; continue; }
        if (c == '"')
        {
            result.Append('\\', backslashes * 2 + 1);
            result.Append('"');
            backslashes = 0;
            continue;
        }
        result.Append('\\', backslashes);
        backslashes = 0;
        result.Append(c);
    }
    result.Append('\\', backslashes * 2);
    result.Append('"');
    return result.ToString();
}
```

`STARTUPINFO`/`PROCESS_INFORMATION` structs and the `CreateProcess` DllImport
signature are standard — mirror the existing struct/DllImport style already
in the file (see `LifecycleProcessHandle`'s `OpenProcess`/`GetProcessTimes`
declarations for the pattern to copy). Remember to `CloseHandle` both
`hProcess` and `hThread` from `PROCESS_INFORMATION` once you're done with them
(after the blocking wait, or keep `hProcess` open for the wait and close both
right before the helper exits) — `CreateProcess` leaks handles otherwise.

**Node-side wiring:**

- Add a `showWindow: "normal" | "minimizedNoActivate"` field to
  `WorkbenchSpawnPolicy` (`launch-plan.ts:87-94`) and thread it through
  `spawnPolicy()` (line 479-491) and `buildMcpEditorLaunchPlan` (line
  710-714) — default it to `"minimizedNoActivate"` for the `mcp_editor` plan
  kind to match Part 1's "default-on" behavior, unless you decide Workbench
  should default to `"normal"` and be opt-in instead (the user only decided
  *to build* this, not its default — pick one and note it in the tool
  description).
- In `lifecycle-execution.ts`, when `request.spawnOptions` (really, the plan)
  says `minimizedNoActivate`, `safeSpawn` (line 632-645) must call the new
  `LaunchBackground` helper instead of `this.spawnProcess(...)`, but still
  return something that behaves like a Node `ChildProcess` for
  `childSupervisor.supervise()` — that "something" is the `powershell.exe`
  process Node spawns to run the helper script (spawned the normal way, via
  `spawn("powershell.exe", [...])`, exactly like
  `exact-process-backend.ts:286` already does for every other mode).
- The real Workbench PID now comes from the helper's first JSON response
  line, **not** `child.pid`. `childPid: (child) => child.pid` (line 396-403)
  and `inspectSpawnedIdentity`'s use of `child.pid` (line 534-546) both need
  to use the reported real PID instead. This is the trickiest part of the
  change — thread the real PID out of the spawn step (e.g. have `safeSpawn`
  return `{ child, realPid }` instead of bare `ChildProcess` when this path
  is taken) and update every caller in `spawnRecoverable` that currently
  reads `child.pid`.

### Known risk with this design (read before implementing)

If the `powershell.exe` helper process dies **without** Workbench dying (helper
crash, killed by something external, etc.), `ChildSupervisor` will see the
helper's `exit` event and the code will believe Workbench exited — even
though it's still running. The existing PID-based re-verification
(`InspectProcess`/`VerifyEndpointOwner` modes, which re-open the process by
PID independent of any Node handle) will eventually catch the discrepancy on
the next real check, but the *fast* "did it crash before we proved identity"
race in `inspectSpawnedIdentity` could report a false
`IDENTITY_UNVERIFIABLE` failure. This is a real, if narrow, regression versus
today's direct-spawn behavior — decide if it's acceptable or needs a
mitigation (e.g. `VerifyEndpointOwner`-style re-check by PID before trusting a
supervisor exit event as "Workbench actually exited").

### Simpler fallback if the above is too much for a first pass

Keep `spawn()` exactly as it is today (zero changes to
`ChildSupervisor`/PID/identity code), and **after** spawn, poll briefly for
the new process's main window (`EnumWindows` + `GetWindowThreadProcessId`
matching `child.pid`, same P/Invoke style) and call `ShowWindow(hwnd,
SW_MINIMIZE)` without `SetForegroundWindow`. This is strictly less invasive
and has zero identity/supervision risk, but there's a real chance of a brief
visible flash/focus-steal between window creation and your minimize call,
since you're racing Windows' own default activation behavior instead of
preventing it at `CreateProcess` time. Given how much this codebase already
invests in avoiding races (see `RECOVERY_REQUIRED`/`IDENTITY_UNVERIFIABLE`
handling throughout `lifecycle-execution.ts`), this fallback trades a UX
imperfection for a much smaller blast radius — reasonable to ship first and
revisit.

### Open choice: `SW_SHOWMINNOACTIVE` vs `SW_SHOWNOACTIVATE`

- `SW_SHOWMINNOACTIVE` (7): opens minimized, never activates. Matches
  "in the background" literally — nothing visible until the user restores it.
- `SW_SHOWNOACTIVATE` (4): opens at its normal size/position, visible, but
  doesn't take keyboard/mouse focus. Could still visually cover other
  windows since it isn't minimized.

Given the user asked for "in the background so it doesn't steal focus,"
`SW_SHOWMINNOACTIVE` matches the request more literally — recommended.

### Testing

- Extend `reforger-forge-mcp/tests/workbench/workbench-launch-plan.test.ts`
  to cover the new `showWindow` field on `WorkbenchSpawnPolicy` /
  `buildMcpEditorLaunchPlan`.
- No existing test harness in this repo launches a real process through the
  PowerShell helper (the existing tests exercise `InspectProcess` /
  `VerifyEndpointOwner` / etc. against fixture/fake processes — see
  `reforger-forge-mcp/tests/workbench/process-guard.test.ts` and
  `reforger-forge-mcp/tests/workbench/lifecycle-helper-timeout.test.ts` for
  the mocking pattern to follow for a new `LaunchBackground` mode).
- There is no CI path that launches the real Workbench (see
  `docs/release-notes/RELEASE_NOTES_v1.1.0.md` — all real-engine runs are
  manual, gated behind `RFO_RUN_LIVE_*` env vars). Plan on a manual
  `wb_launch` acceptance run against a real installation: confirm Workbench
  starts minimized/inactive, `wb_state` still reports it as ready, and
  `wb_shutdown` still cleanly terminates it.

---

## Suggested rollout order

1. Ship Part 1 alone first — it's low-risk, self-contained, and delivers the
   original ask ("fullscreen, in the background, no focus steal") for the
   game, which is likely the more common launch path via
   `observer_prepare_launch`/`observer_runtime`.
2. Do Part 2 as a follow-up, starting with the "simpler fallback" (poll +
   minimize) to ship something safe, then upgrade to the blocking-helper
   design if the brief-flash behavior proves unacceptable in practice.
