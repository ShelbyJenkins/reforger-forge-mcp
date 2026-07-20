# ReforgerForge MCP

**The universal AI modding toolkit for Arma Reforger.**

Describe what you want to build — your AI agent handles API research, code generation, project scaffolding, Workbench control, and in-editor testing. Works with **any MCP-compatible agent**: Cursor, Google Antigravity, Claude Desktop, Claude Code, Kiro, Windsurf, VS Code Copilot, Continue.dev, and more.

> Forked from [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK) with permission. ReforgerForge adds universal agent support, simplified setup, and ongoing maintenance as an independent project.

## Features

- **Transactional observer captures** — launcher-neutral runtime instrumentation with validated PNG evidence
- **Opt-in owned runtime lifecycle** — explicit, exact-identity start/status/stop for observer-prepared graphical runtimes on Windows
- **Broad MCP toolset** — API search, wiki, asset browsing, code generation, and guarded Workbench control
- **8,693 indexed API classes** — full Enfusion/Arma Reforger class hierarchy
- **250+ wiki guides** — searchable tutorials and documentation
- **Agent-agnostic** — one server, install script for every major AI IDE
- **Zero modding experience required** — natural language → built addon

## Quick Start

```bash
git clone https://github.com/wastelandgoats/reforger-forge-mcp.git
cd reforger-forge-mcp
npm install
npm run build
```

Or on Windows:

```powershell
.\scripts\setup.ps1
```

Then install into your agent(s):

```powershell
# Install into ALL supported agents at once
.\scripts\install-agents.ps1 -All

# Or pick one
.\scripts\install-agents.ps1 -Agent antigravity
.\scripts\install-agents.ps1 -Agent cursor
```

Restart your agent and run `node scripts/list-tools.mjs` to verify the complete required tool set.

### Configure paths

Copy and edit the config file:

```bash
cp reforger-forge.config.example.json reforger-forge.config.json
```

| Key | Description |
|-----|-------------|
| `observer` | Optional evidence/log allowlists, private-agent timeouts, inline image limit, retention, managed root, profile root, and session TTL. Defaults keep observer state outside `projectPath`. |
| `workbenchPath` | Arma Reforger Tools (Steam) install |
| `gamePath` | Arma Reforger game install |
| `projectPath` | Where your mods are saved |
| `workbenchAddonDirs` | Ordered base-game and Workshop addon roots passed to Workbench as one `-addonsDir` value |
| `workbenchScriptAuthorizeAll` | Opt in to Workbench's `-scriptAuthorizeAll` flag for trusted local projects; defaults to `false` |

`workbenchScriptAuthorizeAll` suppresses prompts for protected `RunCmd`,
`RunProcess`, `KillProcess`, and out-of-profile `FileIO` operations. Leave it
disabled unless you trust the active project and all of its dependencies.

Automated launches enforce `-noThrow`. Assertions remain in the Workbench log
and can still fail a validation gate, but they cannot block the agent behind a
dialog that requires a person to dismiss it.

Re-run `.\scripts\install-agents.ps1` after changing paths so all agents get updated env vars.

### Add workspace instructions

Copy [the starter `AGENTS.md`](docs/AGENTS.md) into the root of your modding
workspace and replace its placeholders. It gives coding agents a practical
setup checklist, MCP tool-routing guide, Workbench workflow, resource-safety
rules, validation steps, and troubleshooting reference.

### Observer capture workflow

The runtime observer and Workbench helper are separately staged companion
addons. Their managed files, lifecycle receipts, and profiles remain outside
target projects. Preparing or capturing never starts or terminates a process.
On Windows, `observer_runtime` is a separate, explicit lifecycle tool for a
graphical runtime that ReforgerForge starts and proves it owns exactly.

1. Call `observer_setup` with `action="ensure"` to verify and stage both packaged companion add-ons, re-attest their hashes, and sweep expired Workbench helper bundles/captures when the lifecycle is vacant.
2. Call `observer_run` with `action="begin"`; the host creates a managed `runId` outside the project.
3. Call `observer_prepare_launch` with the launcher's existing argument array and an observer-exclusive profile path. It returns both the structured argument array for external launchers and an opaque, expiring `preparedLaunchId`; no process has started.
4. Either pass the returned arguments token-for-token to your own launcher, or explicitly call `observer_runtime action="start"` with the `preparedLaunchId` and a unique `idempotencyKey`. The managed path consumes the prepared launch once and returns a `runtimeId`. Start an editor separately with `wb_launch`.
5. Optionally call `observer_runtime action="status"` with that `runtimeId`, then call `observer_instances` and record the selected `instanceId`, `worldId`, and `worldEpoch`.
6. Call `observer_capture` with the run ID, a meaningful unique `captureLabel`, and the expected world binding. Prefer synchronous capture for immediate review.
7. Use `observer_job action="read"` for a completed asynchronous image that fits the inline limit. Oversized images stay managed for finalization.
8. Cancel unfinished work when necessary and wait for every capture to reach terminal camera restoration. If the runtime was lifecycle-managed, call `observer_runtime action="stop"` with its `runtimeId`, a unique `idempotencyKey`, and a bounded `waitForRestorationMs`.
9. Call `observer_run action="finalize"` to export only reviewed captures into an allowlisted evidence root, or `discard` a rejected run.

A completed capture proves a structurally valid, world-bound PNG and terminal
camera restoration; it does not prove the gameplay claim shown in the image.
`Passed` requires `review.imagesReviewed=true` from an image-capable reviewer.
Use `Failed`, `Inconclusive`, or `Unreviewed` when the available evidence does
not support a pass.

The returned `profilePath` is the outer directory passed to Enfusion's
`-profile` argument. Enfusion mounts `$profile:` at the physical
`<profilePath>/profile` child (`<profilePath>\profile` on Windows), so the
activation contract and observer-owned files are beneath that child's
`ReforgerForgeObserver` directory. Do not append the inner `profile` segment to
the launch argument yourself.

`preparedLaunchId` is bound to an immutable session, profile, runtime kind, and
argument array. It is one-shot, expires with the prepared descriptor, and is
needed only for the opt-in managed start; keeping the returned arguments
preserves external-launch compatibility. Managed start resolves an allowlisted
graphical executable from `gamePath`, appends exactly one random owner-token
argument, and performs a visible direct spawn with a structured argument array
and no shell. A successful `runtimeId` is published only after PID, canonical
executable path, exact Windows creation time, and the owner argument have all
been verified. Start also brackets process creation with a stable executable
file identity and SHA-256 check, so later replacement at the same path fails
closed. Only then is an atomic external receipt written.
Lifecycle files use owner-only creation modes where the platform supports
them. On Windows they inherit the ACL of the configured observer managed root,
so any custom `observer.managedRoot` must be current-user-private rather than a
shared or broadly writable directory.

Runtime status is `running`, `exited`, `identity_mismatch`, `unverifiable`, or
`stale`. A PID or executable name alone never proves ownership. `stale` means
the prepared observer session expired while the exact runtime may still be
running; expiry never triggers unsafe automatic termination. Stop first gates
on active jobs and camera restoration, then reopens and reverifies the exact
identity, terminates only that process, proves its identity vacant, and retains
a stop receipt. It seals the session against new capture work during stop and
revokes the activation after success. A restarted MCP can recover exact status
only for the same installation and Windows owner and only while every recorded
identity field and owner token still matches. If the new private observer agent
does not know the old session, post-restart stop additionally requires the
durable restoration seal written during a clean MCP shutdown after proving no
active jobs, camera leases, or pending restoration. An unclean restart without
that seal fails stop with `SESSION_UNVERIFIABLE` and preserves the process.
This is lifecycle recovery, not adoption of an arbitrary existing Arma
process. Failed starts do not publish ownership, and unrelated Arma or
Workbench processes are never signalled. If retained-child cleanup cannot be
proved, a distinct non-success pending record remains; it grants neither
normal runtime ownership nor PID-only cleanup authority.

The same inventory also includes a compatible, already-running exact-owned
Workbench. Start that visible editor lifecycle explicitly with `wb_launch`;
selecting it reuses its existing lifecycle lease and dedicated observer
handlers from the managed Workbench companion. The observer tools never
auto-launch Workbench.

Synchronous capture returns one host-validated PNG image plus metadata including
job and instance identity, world epoch, actual camera, dimensions, SHA-256,
warnings, and contamination state. Images larger than the configured MCP inline
limit remain retained by the agent and can still be included by run
finalization; private managed paths are never returned as a workaround.
Managed uninstall requests cancellation first and returns `CAMERA_BUSY` while
any job or runtime camera lease still requires terminal restoration. It also
refuses while Workbench or its lifecycle is active; retry after `observer_job`
is terminal and `wb_shutdown` has made the lifecycle vacant.

Repository maintainers can exercise all three supported camera views on both
backends with double-gated five-capture harnesses: `initial-current`,
`explicit-pose`, `post-pose-restoration-current`, `explicit-look-at`, and
`post-look-at-restoration-current`. Use the
[Workbench screenshot harness](observer/README.md#opt-in-workbench-screenshot-acceptance)
for the editor path and the
[graphical runtime screenshot harness](observer/README.md#opt-in-graphical-runtime-screenshot-acceptance)
for an installed graphical Diag executable.

---

## Agent Setup

ReforgerForge uses **stdio MCP** (local Node.js process). Every agent below runs the same server — only the config file location differs.

| Agent | Config file | Install command |
|-------|-------------|-----------------|
| **Cursor** | `%USERPROFILE%\.cursor\mcp.json` | `.\scripts\install-agents.ps1 -Agent cursor` |
| **Google Antigravity** | `%USERPROFILE%\.gemini\config\mcp_config.json` | `.\scripts\install-agents.ps1 -Agent antigravity` |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` | `.\scripts\install-agents.ps1 -Agent claude` |
| **Windsurf** | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | `.\scripts\install-agents.ps1 -Agent windsurf` |
| **VS Code (Copilot)** | `%APPDATA%\Code\User\mcp.json` + `.vscode\mcp.json` | `.\scripts\install-agents.ps1 -Agent vscode` |
| **Continue.dev** | `%USERPROFILE%\.continue\config.json` | `.\scripts\install-agents.ps1 -Agent continue` |
| **Kiro** | `.kiro/settings/mcp.json` (workspace) | `.\scripts\install-agents.ps1 -Agent kiro` |
| **All agents** | All of the above | `.\scripts\install-agents.ps1 -All` |

### Google Antigravity

1. Run `.\scripts\install-agents.ps1 -Agent antigravity`
2. Open Antigravity → **Settings** → **Customizations** → **Open MCP Config**
3. Confirm `reforger-forge` appears, then click **Refresh** in Installed MCP Servers
4. The shared config is at `~/.gemini/config/mcp_config.json` (same file used by Antigravity CLI)

Manual config (if needed):

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\reforger-forge-mcp\\dist\\index.js"],
      "env": {
        "ENFUSION_WORKBENCH_PATH": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools",
        "ENFUSION_GAME_PATH": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger",
        "ENFUSION_PROJECT_PATH": "C:\\Users\\YOU\\Documents\\My Games\\ArmaReforgerWorkbench\\addons"
      }
    }
  }
}
```

### Cursor

For a global install, run the install script or merge
`configs/cursor-global.json`. For a workspace-only install, copy
`configs/agents/stdio-template.json` to `.cursor/mcp.json` and replace the
placeholder path. Generated workspace config is intentionally ignored by Git.

Restart → **MCP: Restart Servers**

### Claude Desktop

Merge `configs/claude-desktop.json` or run install script.

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

### Claude Code

```bash
# Windows
claude mcp add --scope user reforger-forge -- cmd /c node "FULL_PATH\reforger-forge-mcp\dist\index.js"

# macOS / Linux
claude mcp add --scope user reforger-forge -- node /path/to/reforger-forge-mcp/dist/index.js
```

### VS Code (GitHub Copilot)

Uses `servers` key (not `mcpServers`). Run install script — it writes both user-level and workspace `.vscode/mcp.json`.

Command palette: **MCP: List Servers** → verify `reforger-forge` is running.

### Windsurf (Cascade)

Global config only at `~/.codeium/windsurf/mcp_config.json`. Run install script, then refresh MCP list in Cascade panel.

### Continue.dev

Run install script. MCP servers live inside `~/.continue/config.json` under `mcpServers`.

### Any other MCP client

Use the stdio template at `configs/agents/stdio-template.json`. Replace `REPLACE_WITH_ABSOLUTE_PATH` with your clone path.

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": ["/absolute/path/to/reforger-forge-mcp/dist/index.js"],
      "env": {
        "ENFUSION_WORKBENCH_PATH": "...",
        "ENFUSION_GAME_PATH": "...",
        "ENFUSION_PROJECT_PATH": "..."
      }
    }
  }
}
```

---

## Complete Tool Reference

Legend: **Offline** = no Workbench needed | **Live** = requires Workbench running (`wb_launch`)

### API & Documentation (Offline)

| Tool | What it does |
|------|-------------|
| `api_search` | Search 8,693 Enfusion/Arma Reforger API classes and methods. Includes inherited methods, enum detection, sibling classes, and `format: 'tree'` for ASCII inheritance hierarchy. |
| `component_search` | Find ScriptComponent descendants — filter by category (character, vehicle, weapon, damage, inventory, ai, ui, etc.) and event handlers (e.g. `OnDamage`, `EOnFrame`). |
| `wiki_search` | Search 250+ pre-downloaded BIKI wiki pages and Enfusion tutorials. Returns previews — use `wiki_read` for full content. |
| `wiki_read` | Read the full content of a wiki page by title, including code examples (up to 100k chars, no truncation). |
| `wb_knowledge` | Search the bundled modding knowledge base — scripting, audio, weapons, vehicles, AI, UI, game modes, animation, and more. Use `query='index'` to list all topics. |

### Game Assets

Search and read operations are offline. `game_duplicate` is offline only with
`register=false`; its default registration step requires Workbench and may
auto-launch it.

| Tool | What it does |
|------|-------------|
| `game_browse` | Browse base game files (scripts, prefabs, configs) from loose files and `.pak` archives. Do not use filesystem tools on the game install directly. |
| `game_read` | Read a specific base game file — vanilla `.c` scripts, `.et` prefabs, `.conf` configs from loose files or `.pak`. |
| `asset_search` | Search game assets (prefabs, models, textures, scripts, configs) by name across loose files and `.pak` archives. Returns paths and indexed GUIDs when available. |
| `game_duplicate` | Duplicate a base game prefab/config into your mod folder with full ancestor chain resolved. Optionally `flatten=true` to bake all inherited components. By default, registers with Workbench for a new GUID; set `register=false` for an unregistered offline copy. |
| `workshop_info` | Read Workshop metadata from a mod's `.gproj` — mod ID, GUID, title, dependencies, configurations. |

### Project & Mod Management

| Tool | Workbench? | What it does |
|------|-----------|-------------|
| `project` | No | Browse, read, or write files in your mod project directory (`action`: browse / read / write). |
| `mod` | No | Manage addons: `action=create` scaffolds a new addon and `action=validate` checks structure. Unsafe generic `action=build` is retired; use a project-owned bounded build wrapper. |

### Code Generation (Offline)

| Tool | What it does |
|------|-------------|
| `script_create` | Generate Enforce Script `.c` files — component, gamemode, action, entity, manager, modded, basic. Auto-fetches overridable parent methods from API index. |
| `prefab` | `action=create`: Generate `.et` prefab with components and ancestry. `action=inspect`: Full inheritance chain merge showing which ancestor each component/value comes from. |
| `layout_create` | Generate UI `.layout` files — hud, menu, dialog, list, custom widget types. |
| `config_create` | Generate `.conf` files — factions, mission headers, entity catalogs, editor placeables. |
| `server_config` | Generate `server.json` for local dedicated server testing. |

### Scenarios & Advanced Workflows

| Tool | Workbench? | What it does |
|------|-----------|-------------|
| `scenario_create` | **Live** | Place scenario elements in open Workbench world — `type=objective` (SP/co-op Scenario Framework hierarchy) or `type=base` (Conflict multiplayer base). |
| `scenario_create_conflict` | No | Generate a complete Conflict multiplayer scenario (up to 7 files): mission header, SubScene stub, layer files with game mode, bases, capture zones, defenders, ambient vehicles. |
| `animation_graph` | No | Vehicle animation graph tool — `action=author` (generate .agr/.ast scaffolds), `action=inspect` (read/validate graphs), `action=setup` (full guided wizard). |
| `building_setup` | No | Set up destructible building from Blender export manifest — creates structure prefab with slot wiring and per-phase destruction components. |

### Observer Platform (Private Local Agent)

One host observer application owns the transport client, runtime and Workbench
capture backends, shared capture job service, durable evidence-run port,
owned-runtime lifecycle, and ordered shutdown. The historical coordinator is a
thin compatibility facade. The disposable child starts only when an operation
needs private agent state; idle status and doctor checks stay non-mutating.
Launch preparation returns argument tokens, session data, and an opaque
`preparedLaunchId`; it does not start the game. Starting or stopping is always
a distinct, explicit `observer_runtime` action.

| Tool | What it does |
|------|-------------|
| `observer_setup` | Ensure/status/doctor/uninstall for immutable companion-addon staging. Uninstall refuses while restoration is pending, then revokes sessions and preserves modified or unrelated files. |
| `observer_prepare_launch` | Merge the staged observer and exclusive profile into an existing structured argument array without spawning Enfusion; also return an opaque, expiring, one-shot `preparedLaunchId` for an optional managed start. |
| `observer_runtime` | On Windows, explicitly start, inspect, or stop an exact-owned graphical runtime. Start and stop are idempotent side effects; status is read-only, and stop waits for terminal camera restoration before exact-identity termination. |
| `observer_instances` | List live and stale runtime instances, capabilities, transport, world epoch, active job, and health; optionally wait for compatible renderers. |
| `observer_capture` | Submit current-view, explicit-pose, or look-at capture. Sync mode returns one validated PNG plus metadata; async mode returns a job ID. |
| `observer_job` | Inspect, read, cancel, or release a capture. Inline reads return a completed validated PNG; oversized captures remain available to run finalization. |
| `observer_run` | Begin, inspect, finalize, or discard a bounded managed evidence run. Finalize exports a standardized reviewed bundle beneath an allowlisted evidence root. |

Both renderers use the same public capture IDs, idempotency receipts, absolute
deadline, cancellation, artifact promotion, and release rules. Inventory also
publishes an opaque `worldRevision`; prefer binding that exact value on new
requests while the legacy `worldId`/`worldEpoch` fields remain compatible.
Evidence-run durability is always owned by the agent, but beginning or
finalizing a new run is disabled unless at least one evidence root is
configured. Bundle hashing, redaction, manifest-last publication, and recovery
are isolated in the optional evidence exporter.

### Workbench Lifecycle, Connection & Diagnostics (Windows)

Automated launch/restart/shutdown lifecycle control is release-supported on
Windows. One composed `WorkbenchSessionController` backs the stable
`WorkbenchClient` compatibility facade used by the `wb_*` tools and Workbench
observer adapter. The global named mutex serializes cross-process lifecycle
transitions; a controller-local, writer-preferring reader/writer gate allows
concurrent managed NET calls while draining them before lifecycle or companion
administration changes. Ordinary NET calls do not hold the machine mutex. A
second live MCP cannot adopt the first MCP's Workbench; a replacement may claim
the lease only after the prior MCP process identity is proven dead. The target
is always one canonical `.gproj`, and a different requested target is refused
rather than reported as success. User-launched or otherwise unverifiable
Workbench processes are never terminated. If `gprojPath` is omitted, launch
succeeds only when a prior verified target or exactly one configured project can
be resolved; ambiguity is refused with the candidate paths.

Automated lifecycle control requires a numeric loopback NET API endpoint. The
version-3 lifecycle records the immutable companion identity and its external
profile with the exact Workbench process. After helper readiness, and again
before reuse or recovery, the Windows lifecycle backend
resolves the listening socket to its owning PID and re-proves the recorded PID,
creation time, executable, owner-token argument, and sole-Workbench condition. A
compatible response from a foreign listener is refused and a pending launch is
rolled back.

Lifecycle helper operations are deadline-bounded. Read-only stalls are terminated
and reported; if mutex ownership or a mutating operation's outcome becomes
uncertain, the MCP fails closed and stops rather than continuing with uncertain
state. Shutdown and
unexpected-child-exit reconciliation use the stored target identity, so exact
shutdown remains available if the recorded `.gproj` has been deleted or
disconnected. Launch and restart still require current project revalidation.

Before an editor spawn, ReforgerForge digest-verifies and stages
`ReforgerForgeWorkbenchHelper` from `observer/workbench-addon` beneath the
external observer managed root. Workbench receives the helper search root,
add-on GUID, and a dedicated external `-profile`. Editor readiness requires
`EMCP_WB_Ping` to return the exact add-on ID, GUID, version, protocol, and build
identity expected by the running MCP. No Workbench helper source is written to
the target project. The canonical `target_build` plan has no helper activation
or NET-readiness capability.

| Tool | What it does |
|------|-------------|
| `wb_launch` | Launch or reuse one exact canonical `.gproj` under the version-3 MCP lease and verified companion identity. Different targets, live-other-MCP owners, occupied endpoints, and user-owned/unverifiable Workbench processes are refused. |
| `wb_connect` | Test connection to Workbench NET API. Returns connection status and editor mode. |
| `wb_diagnose` | Non-mutating diagnostic — config, packaged/staged companion identity, NET API identity, lifecycle schema/generation/phase, canonical target, endpoint, lease status, and operation. |
| `wb_restart` | Preflight a complete replacement, then terminate through the retained verified process handle and restart the same canonical `.gproj`. A live different MCP owner cannot be claimed. |
| `wb_shutdown` | Stop only the exact verified owner process, wait for endpoint release, and transition lifecycle state to vacant. User-launched Workbench is never signalled. |
| `wb_state` | Full Workbench snapshot — mode (edit/play), entity count, selection, terrain bounds, sub-scene, prefab edit status. |
| `wb_reload` | Reload plugins only. Every in-process game-script reload is refused; use verified owner-scoped `wb_restart` for clean compilation. |

#### Workbench observer adapter

The Workbench companion provides five dedicated observer endpoints (`ping`,
`submit`, `status`, `cancel`, and `release`) plus their shared transaction
implementation. They are consumed through the same long-lived compatibility
facade, session controller, local reader/writer gate, and exact lifecycle lease
used by the `wb_*` tools. Observer capture never launches Workbench, creates
another process guard, enters Play, executes a menu action, saves, or reloads
scripts.

Workbench capture is bound to the lifecycle generation, canonical target
`.gproj`, exact process identity, native `BaseWorld` camera slot, and
editor-world identity. `Workbench.GetCurrentGameProjectFile()` identifies the
base-game settings project, not necessarily the mod passed to `-gproj`; the
lifecycle guard proves the canonical target while the handler separately binds
the nonempty base-project and world/subscene identities. The handler snapshots
the current camera slot, full matrix, measured vertical FOV, read-only far
plane, and viewport dimensions. `BaseWorld` exposes no near-plane getter, so the
observer does not mutate that value. Success, failure, cancellation, and
release all pass through exact slot/matrix/FOV restoration. If ownership or
identity changes, the adapter reports `RESTORATION_UNCONFIRMED` and does not
advertise `camera.editor`.

`camera.editor` is deliberately fail-closed after every Workbench restart. A
current-view transaction must first complete and verify an exact restoration in
that process. Only then may explicit-pose or look-at requests be submitted.
Workbench writes a native PNG at the generated
`$profile:ReforgerForgeObserver/workbench/<job>.png` path. The adapter confines
and canonicalizes that regular file, validates stable length and the PNG
signature/structure/dimensions, computes SHA-256, and returns those exact bytes
from `observer_capture`; there is no BMP conversion step.

Before owner-scoped restart or shutdown, the controller's local writer gate
stops admitting new managed reads and gives active captures a bounded restoration
window. If reads or restoration do not drain in time, the lifecycle mutation is
refused before process termination. The normal order is: restore or cancel
captures, wait for terminal state, then call `wb_shutdown`.

For project-owned scripts and CI, the packaged `reforger-forge-workbench`
runner shares the same version-3 lifecycle and companion staging:

```text
reforger-forge-workbench editor --gproj <path> --foreground
reforger-forge-workbench build --gproj <path> --platform PC --output <path> --timeout-ms <n>
```

Editor mode is intentionally foreground-only and returns its version-2 receipt
only after exact helper endpoint and Ping qualification. The target-build plan
itself is helper-free, uses a dedicated build profile, and performs no NET call.
At this pre-removal boundary, however, the public build command still provides a
guarded two-phase lifecycle under one machine lock and one absolute deadline.
Its separate managed-companion editor preflight proves endpoint ownership and
immutable Ping identity, then is exact-terminated and followed by an
endpoint-vacancy proof before the distinct target-only child starts. The public
command therefore still emits the version-3 build receipt, which keeps the two
PIDs, lifecycle generations, and attributed log directories separate; binds the
target add-on ID/GUID, project-file SHA-256, and companion bundle; and requires
fresh nonempty output containing exactly one hashed `resourceDatabase.rdb`
before reporting success. Timeout and nonzero exits have `output: null`; an
exit-zero output-proof failure carries `validationFailure` and makes the CLI
fail while preserving both attributed log directories. Removing the preflight
and emitting a helper-free version-4 receipt remain gated on two consecutive
controlled target-only Workbench acceptance runs plus green hermetic contracts.

Maintainers can collect that pre-removal evidence through the repository-only
controller harness. It requires both an environment gate and explicit command
confirmation, an exact real target, and an external output parent:

```powershell
$env:RFO_RUN_LIVE_WORKBENCH_BUILD_ACCEPTANCE = '1'
npm run dev:workbench:acceptance:build -- --confirm-live-run --gproj <ABSOLUTE_TARGET_GPROJ> --output-root <EXTERNAL_OUTPUT_PARENT>
```

The harness runs the helper-free `target_build` controller path twice with
distinct exclusive outputs and records a path/PID/token-sanitized artifact under
`docs/validation`. Its existence is not acceptance evidence, and it neither
removes the public helper preflight nor emits a version-4 receipt.

Guarded data build is supported on installed Workbench 1.7.0.54 with the exact
Resource Manager sequence
`-wbModule=ResourceManager -builddata PC <fresh-output> <AddonName>`; the
`-builddata` token requires that lowercase spelling. The target invocation
intentionally omits `-run`. This path was verified on 2026-07-18 by fresh output
containing one hashed `resourceDatabase.rdb` and attributed logs that passed the
diagnostic policy. The receipt requirements above remain authoritative: a
spawned child or zero exit without fresh output proof is not build evidence.

### Workbench Editor Control (Live)

Embedders that call `registerTools()` directly must await its returned disposer
before closing their `McpServer`. The disposer seals owned observer runtime
lifecycle state; `src/index.ts` already follows this explicit shutdown contract.

| Tool | What it does |
|------|-------------|
| `wb_stop` | Exit play mode and return to World Editor; already-edit mode is an idempotent success. |
| `wb_undo_redo` | Undo or redo the last World Editor action. |
| `wb_open_resource` | Open a resource in its editor (.et → Prefab Editor, .c → Script Editor, etc.). |

Enter Play and save intentional editor changes manually while a person is
attending Workbench. No automated Play, Save/Save As, or generic menu-action
tool is advertised because those operations cannot be made reliably modal-free.

### Workbench Entities (Live)

| Tool | What it does |
|------|-------------|
| `wb_entity_create` | Create entity from prefab at position/rotation. Optional name and target layer. Edit mode only. |
| `wb_entity_delete` | Delete entity by name. Edit mode only. |
| `wb_entity_list` | List entities in current world with pagination and optional name filter. |
| `wb_entity_inspect` | Get entity details — components, properties, position, children. By name or index. |
| `wb_entity_modify` | Move, rotate, rename, reparent, set/clear/list component properties, manage array items. Edit mode only. |
| `wb_entity_select` | Deselect, clear, or inspect current selection. Single-entity selection is safely refused because Workbench exposes no supported API for it. |
| `wb_entity_duplicate` | Duplicate a scene entity (including locked base-game instances) into your mod as a standalone `.et` with new GUID. |
| `wb_component` | Add, remove, or list components on an entity. Edit mode only for add/remove. |
| `wb_clipboard` | Copy, cut, paste, paste at cursor, duplicate selected entities, check clipboard content. |

### Workbench World & Resources (Live)

| Tool | What it does |
|------|-------------|
| `wb_terrain` | Query terrain height at coordinates or get world bounds (min/max extents). |
| `wb_layers` | Create, delete, rename layers; set active layer; toggle visibility/lock. Edit mode only for mutations. |
| `wb_resources` | Register new resources, rebuild resource databases, get resource info, open in editor. |
| `wb_prefabs` | Create entity templates, save prefab changes, GUID lookup, locate prefabs by path. Edit mode only for create/save. |
| `wb_projects` | List loaded addon projects, locate project by name, open `.gproj` file in Workbench. |
| `wb_localization` | Insert, delete, modify string table entries, or get full localization table. |
| `wb_script_editor` | Read/write lines in the open Script Editor file — get file, read/write/insert/remove lines, line count. |
| `wb_validate` | Validate material or texture resources using Workbench built-in validators. Returns errors and warnings. |

Run `node scripts/list-tools.mjs` anytime to verify every required tool registers on your machine.

---

## Usage Examples

```
Create a HUD widget that shows player health and stamina
Make a zombie survival game mode with wave spawning
Search the API for all vehicle damage components
Launch Workbench and inspect my mod without entering Play mode
Generate a Conflict scenario for Everon with 3 bases
Inspect the inheritance chain for Rifle_M16A2.et
Prepare an observer launch and capture the current runtime view
```

---

## Configuration

Environment variables override config files:

| Variable | Description | Default |
|----------|-------------|---------|
| `REFORGER_FORGE_OBSERVER_ROOT` | Managed observer root; must remain outside target projects | platform-local application/state directory |
| `REFORGER_FORGE_OBSERVER_PROFILE_ROOT` | Approved root for observer-exclusive launch profiles | `<observer root>/profiles` |
| `REFORGER_FORGE_OBSERVER_AGENT_PATH` | Packaged private-child entry override | `dist/observer/agent/private-child.js` |
| `REFORGER_FORGE_OBSERVER_EVIDENCE_ROOTS` | Allowlisted existing evidence roots, separated by the platform path delimiter (`;` on Windows) | none; finalization disabled |
| `REFORGER_FORGE_OBSERVER_SUPPORTING_LOG_ROOTS` | Allowlisted existing log roots, separated by the platform path delimiter (`;` on Windows) | managed observer log root only |
| `REFORGER_FORGE_OBSERVER_STARTUP_TIMEOUT_MS` | Private child startup deadline | `10000` |
| `REFORGER_FORGE_OBSERVER_REQUEST_TIMEOUT_MS` | Private control request deadline | `30000` |
| `REFORGER_FORGE_OBSERVER_CAPTURE_TIMEOUT_MS` | Default synchronous capture/job deadline | `30000` |
| `REFORGER_FORGE_OBSERVER_MAX_INLINE_IMAGE_BYTES` | Maximum PNG bytes embedded in an MCP result | `8388608` |
| `REFORGER_FORGE_OBSERVER_RETENTION_INTERVAL_MS` | Agent retention sweep cadence | `60000` |
| `REFORGER_FORGE_OBSERVER_RETENTION_MAX_AGE_MS` | Retained artifact age limit | `604800000` |
| `REFORGER_FORGE_OBSERVER_RETENTION_MAX_BYTES` | Coordinated managed-storage limit for artifacts, runs, profiles, logs, and export scratch | `536870912` |
| `REFORGER_FORGE_OBSERVER_SESSION_TTL_MS` | Default prepared-session lifetime | `1200000` |
| `ENFUSION_WORKBENCH_PATH` | Arma Reforger Tools path | Steam default |
| `ENFUSION_GAME_PATH` | Arma Reforger game path | Sibling of Tools |
| `ENFUSION_PROJECT_PATH` | Mod output directory | `~/Documents/My Games/.../addons` |
| `ENFUSION_WORKBENCH_HOST` | NET API host; automated lifecycle control requires a numeric loopback address | `127.0.0.1` |
| `ENFUSION_WORKBENCH_PORT` | NET API port | `5775` |
| `REFORGER_FORGE_DEBUG` | Enable debug logging | off |

Config file search order:
1. `reforger-forge.config.json` in the package root
2. `~/.reforger-forge/config.json` in the user home

Package-local values override user-home values; environment variables override
both.

---

## Requirements

- **Node.js 20+**
- **Windows** — required for the exact automated Workbench lifecycle guarantee
- **Arma Reforger Tools** (Steam) — for resource registration and reviewed live editor-control tools
- **Arma Reforger** (Steam) — for game asset browsing

---

## Development

```bash
npm run build                  # Compile TypeScript
npm run observer:manifest      # Regenerate Workbench helper identity/manifest after helper changes
npm run observer:validate:enforce                 # Compile the production observer addon in Workbench
npm run observer:acceptance:enforce-mailbox       # Execute the five-case real Enforce mailbox gate
npm test                       # Run hermetic default unit/contract suite
npm run test:integration       # Run explicitly gated environment integration tests
npm run test:package           # Verify published-package contents
npm run dev                    # Run server in dev mode
node scripts/list-tools.mjs    # Verify every required tool registers
.\scripts\install-agents.ps1 -All   # Push config to all agents
```

After changing anything under `observer/workbench-addon`, run
`npm run observer:manifest`, then `npm run test:package`. The first command
regenerates the compiled helper identity and source manifest; the second checks
that the complete helper payload is packaged correctly.

The two Enforce commands require Windows, an installed Arma Reforger Workbench,
and Steam initialization. They refuse an existing Workbench process and use an
isolated profile. See [the observer validation guide](observer/README.md#bounded-mailbox-and-retention-behavior)
for the compile-only versus behavioral evidence contract.

The observer screenshot harnesses are repository-development commands and are
not shipped in the npm package. They are opt-in because they launch installed
GUI applications. Each requires an environment gate and an independent
command-line confirmation from a source checkout with dev dependencies:

```powershell
$env:RFO_RUN_LIVE_RUNTIME_OBSERVER_ACCEPTANCE = "1"
npm run dev:observer:acceptance:runtime -- --confirm-live-run

$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = "1"
npm run dev:observer:acceptance:workbench -- --confirm-live-run
```

The runtime command defaults to Reforger's installed stock
`{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent`. It uses an explicit
normalized-quaternion pose at `[96, 90, -5]` with a 58-degree FOV, then a
separate look-at view from `[64, 121, -40]` toward `[64, 10, 100]` at 70
degrees. It loads no project add-on and keeps all managed, profile, diagnostic,
and evidence data under an external temporary root. It launches the fixture as
a visible graphical listen host and can optionally override it with `--world` or
`RFO_RUNTIME_OBSERVER_WORLD`, load a fixture add-on with `--addon-dir`, append
bounded launch tokens with repeated `--launch-arg`, override the
executable, pose, or look-at view, require a color marker, and select an external
artifact root or timeout. It launches only after proving all Arma and Workbench
processes are absent; captures current, explicit pose, current-after-pose,
explicit look-at, and current-after-look-at views; validates PNG material,
camera/world binding, the exact requested pose matrix/position/FOV, look-at
position/FOV, material visual displacement, and independent lease restoration
and release from both explicit views while allowing natural current-camera
movement or rotation; verifies bundle hashes; and terminates only its exact
child process. The
external finalized bundle is marked `Unreviewed` and must be visually reviewed
before it can qualify the runtime screenshot path.

The Workbench command reads installed-tool and addon-root paths from the
gitignored `reforger-forge.config.json`. It retains its evidence outside the
repository by default and refuses to start if an Arma Reforger or Workbench
process is already running. It creates a run-specific disposable
`Worlds/ObserverAcceptance.ent` that inherits stock Everon
`{853E92315D1D9EFE}worlds/Eden/Eden.ent` and exercises the same five-view
sequence without writing helper files into the target.

**Runtime live validation status:** five-capture v2 automation passed on July
17, 2026 local (July 18 UTC) against Reforger 1.7.0.54 and stock
`{96A8AF57260A7392}worlds/MP/MpTest/MpTest.ent`. Harness run `run-kUN6is`
finalized managed run `20260718T015727Z-cbe43230` after validating current,
explicit pose, restored current, explicit look-at, and restored current PNGs;
the exact requested matrices and FOVs; independent camera-lease restoration;
and final process vacancy. All five images were visually inspected during
implementation. The exported bundle deliberately remains `Unreviewed` with
`imagesReviewed=false`, so formal evidence review is still pending.

**Workbench live validation status:** five-capture v3 automation passed on July
17, 2026 local (July 18 UTC) with Workbench engine 1.7.0.54. Harness run
`run-wzuGy6` finalized managed run
`20260718T015947Z-6ec8429d` from disposable world
`{71D11CE993734B08}Worlds/ObserverAcceptance.ent`, which inherits stock Everon.
Workbench loaded helper digest
`db44e43be9ec4249c23e55c0d1f19a1fb6cf72d6800c4540e938773d729d1eed`;
both explicit views had the exact requested matrices and FOVs, differed
materially from their preceding current views, and restored the original camera
exactly. Finalization reported no warnings, the disposable target remained
clean, exact-owner shutdown left zero Workbench processes, and all five images
were formally inspected at original resolution. The finalized manifest's
recorded state remains `Unreviewed` with `imagesReviewed=false`; the separate
[hash-bound formal review](docs/validation/2026-07-19-workbench-observer-evidence-review.json)
records a `Passed` outcome under its stated warning and limitations. The
companion editor path is therefore live-qualified for this Workbench 1.7.0.54
procedure.

The real Workbench lifecycle smoke test is separately gated because it opens and
closes the installed GUI against a disposable project:

```powershell
$env:RR_RUN_LIVE_WORKBENCH = "1"
$env:RR_LIVE_INITIAL_DWELL_MS = "210000"
$env:RR_LIVE_RESTART_DWELL_MS = "60000"
npx vitest run tests/workbench/integration/live-lifecycle-acceptance.test.ts --reporter=verbose
Remove-Item Env:RR_RUN_LIVE_WORKBENCH
Remove-Item Env:RR_LIVE_INITIAL_DWELL_MS
Remove-Item Env:RR_LIVE_RESTART_DWELL_MS
```

It covers companion staging and identity, launch, same-target reuse,
target-conflict refusal, restart, shutdown, soak health checks, and no target
project residue. The test reads `workbenchPath`,
`gamePath`, and `workbenchAddonDirs` only from the repository-local, gitignored
`reforger-forge.config.json`; keep every machine-specific path in that file. The
test complements, but does not replace, the documented manual failure-injection
and log-review acceptance protocol.

## Project Structure

```
reforger-forge-mcp/
├── src/                         # TypeScript source
├── data/                        # API index, wiki, patterns, knowledge base
├── observer/
│   ├── addon/                   # Runtime observer companion
│   └── workbench-addon/         # Managed Workbench helper companion
├── docs/AGENTS.md               # Copy-ready modding workspace instructions
├── configs/agents/              # Manual install templates
├── scripts/
│   ├── setup.ps1                # Build + configure
│   ├── install-agents.ps1       # Install into any AI agent
│   ├── list-tools.mjs           # Verify tool registration
│   └── windows/                 # Named-mutex and exact-process lifecycle helper
└── dist/                        # Built server (generated)
```

## Contributing via a fork

The canonical repository is
[wastelandgoats/reforger-forge-mcp](https://github.com/wastelandgoats/reforger-forge-mcp).
After cloning your GitHub fork, keep the canonical repository as `upstream`:

```bash
git remote add upstream https://github.com/wastelandgoats/reforger-forge-mcp.git
git fetch upstream
```

## Credits & Attribution

ReforgerForge MCP is based on:

- **[steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK)** — primary upstream fork
- **[Articulated7/enfusion-mcp](https://github.com/Articulated7/enfusion-mcp)** — original project

Used and modified with permission. MIT licensed.

## License

MIT — see [LICENSE](LICENSE)
