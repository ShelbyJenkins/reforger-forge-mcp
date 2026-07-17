# ReforgerForge MCP

**The universal AI modding toolkit for Arma Reforger.**

Describe what you want to build — your AI agent handles API research, code generation, project scaffolding, Workbench control, and in-editor testing. Works with **any MCP-compatible agent**: Cursor, Google Antigravity, Claude Desktop, Claude Code, Kiro, Windsurf, VS Code Copilot, Continue.dev, and more.

> Forked from [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK) with permission. ReforgerForge adds universal agent support, simplified setup, and ongoing maintenance as an independent project.

## Features

- **Transactional observer captures** — launcher-neutral runtime instrumentation with validated PNG evidence
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
| `observer` | Optional private-agent timeouts, inline image limit, retention, managed root, profile root, and session TTL. Defaults keep observer state outside `projectPath`. |
| `workbenchPath` | Arma Reforger Tools (Steam) install |
| `gamePath` | Arma Reforger game install |
| `projectPath` | Where your mods are saved |
| `workbenchAddonDirs` | Ordered base-game and Workshop addon roots passed to Workbench as one `-addonsDir` value |
| `workbenchScriptAuthorizeAll` | Opt in to Workbench's `-scriptAuthorizeAll` flag for trusted local projects; defaults to `false` |
| `workbenchNoThrow` | Legacy compatibility setting; automated Workbench launches always enforce `-noThrow` so assertions cannot open modal dialogs |

`workbenchScriptAuthorizeAll` suppresses prompts for protected `RunCmd`,
`RunProcess`, `KillProcess`, and out-of-profile `FileIO` operations. Leave it
disabled unless you trust the active project and all of its dependencies.

Automated launches enforce `-noThrow` even if a legacy config sets
`workbenchNoThrow` false. Assertions remain in the Workbench log and can still
fail a validation gate, but they cannot block the agent behind a dialog that
requires a person to dismiss it.

Re-run `.\scripts\install-agents.ps1` after changing paths so all agents get updated env vars.

### Add workspace instructions

Copy [the starter `AGENTS.md`](docs/AGENTS.md) into the root of your modding
workspace and replace its placeholders. It gives coding agents a practical
setup checklist, MCP tool-routing guide, Workbench workflow, resource-safety
rules, validation steps, and troubleshooting reference.

### Observer capture workflow

The observer is a separately staged companion addon controlled by one lazy,
private child agent per MCP process. It never injects files into a target addon
and never launches or terminates Arma Reforger.

1. Call `observer_setup` with `action="ensure"` to verify and stage the packaged addon.
2. Call `observer_prepare_launch` with the launcher's existing argument array and an observer-exclusive profile path. Use the returned array in your own launcher.
3. Call `observer_instances` after the instrumented runtime registers. Headless instances remain visible for diagnostics but cannot be selected to render.
4. Call `observer_capture` for a synchronous PNG result, or set `asynchronous=true` and use `observer_job` to inspect, cancel, or release it.

The returned `profilePath` is the outer directory passed to Enfusion's
`-profile` argument. Enfusion mounts `$profile:` at the physical
`<profilePath>/profile` child (`<profilePath>\profile` on Windows), so the
activation contract and observer-owned files are beneath that child's
`ReforgerForgeObserver` directory. Do not append the inner `profile` segment to
the launch argument yourself.

The same inventory also includes a compatible, already-running exact-owned
Workbench. Start that visible editor lifecycle explicitly with `wb_launch`;
selecting it reuses its existing lifecycle lease and dedicated observer
handlers. The observer tools never auto-launch Workbench.

Synchronous capture returns one host-validated PNG image plus metadata including
job and instance identity, world epoch, actual camera, dimensions, SHA-256,
warnings, and contamination state. Images larger than the configured MCP inline
limit remain retained by the agent but are not embedded in the MCP response.
Managed uninstall requests cancellation first and returns `CAMERA_BUSY` while
any job or runtime camera lease still requires terminal restoration; retry only
after `observer_job` reports a terminal state.

Repository maintainers can prove an editor current screenshot, explicit pose
restoration, and a post-restoration screenshot with the double-gated
[Workbench screenshot harness](observer/README.md#opt-in-workbench-screenshot-acceptance).

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

The observer coordinator starts its disposable child only when an operation
needs private agent state; idle status and doctor checks stay non-mutating.
Launch preparation returns argument tokens and session data; it does not start
the game.

| Tool | What it does |
|------|-------------|
| `observer_setup` | Ensure/status/doctor/uninstall for immutable companion-addon staging. Uninstall refuses while restoration is pending, then revokes sessions and preserves modified or unrelated files. |
| `observer_prepare_launch` | Merge the staged observer and exclusive profile into an existing structured argument array without spawning Enfusion. |
| `observer_instances` | List live and stale runtime instances, capabilities, transport, world epoch, active job, and health; optionally wait for compatible renderers. |
| `observer_capture` | Submit current-view, explicit-pose, or look-at capture. Sync mode returns one validated PNG plus metadata; async mode returns a job ID. |
| `observer_job` | Read status, request cancellation, or release a retained managed artifact. |

### Workbench Lifecycle, Connection & Diagnostics (Windows)

Automated launch/restart/shutdown/cleanup lifecycle control is release-supported
on Windows. A global named mutex serializes every mutation. A second live MCP
cannot adopt the first MCP's Workbench; a replacement may claim the lease only
after the prior MCP process identity is proven dead. The target is always one
canonical `.gproj`, and a different requested target is refused rather than
reported as success. User-launched or otherwise unverifiable Workbench processes
are never terminated. If `gprojPath` is omitted, launch succeeds only when a
prior verified target or exactly one configured project can be resolved;
ambiguity is refused with the candidate paths. A live version-1 owner marker
requires one manual Workbench close before the version-2 state can be initialized.

Automated lifecycle control requires a numeric loopback NET API endpoint. After
handler readiness, and again before reuse or recovery, the Windows helper
resolves the listening socket to its owning PID and re-proves the recorded PID,
creation time, executable, owner-token argument, and sole-Workbench condition. A
compatible response from a foreign listener is refused and a pending launch is
rolled back.

Lifecycle helper operations are deadline-bounded. Read-only stalls are terminated
and reported; if mutex ownership or a mutating operation's outcome becomes
uncertain, the MCP fails closed and stops rather than continuing with uncertain
state. Handler recovery cross-binds the durable transaction, target, mod and
handler directories, manifest, and generation before any mutation. Shutdown and
unexpected-child-exit reconciliation use the stored target identity, so exact
shutdown remains available if the recorded `.gproj` has been deleted or
disconnected. Launch and restart still require current project revalidation.

| Tool | What it does |
|------|-------------|
| `wb_launch` | Launch or reuse one exact canonical `.gproj` under the v2 MCP lease, global mutex, and transactional handler bundle. Different targets, live-other-MCP owners, occupied endpoints, and user-owned/unverifiable Workbench processes are refused. |
| `wb_connect` | Test connection to Workbench NET API. Returns connection status and editor mode. |
| `wb_diagnose` | Non-mutating diagnostic — config, handler locations, NET API, lifecycle schema/generation/phase, canonical target, endpoint, lease status, operation, and handler transaction. |
| `wb_restart` | Preflight a complete replacement, then terminate through the retained verified process handle and restart the same canonical `.gproj`. A live different MCP owner cannot be claimed. |
| `wb_shutdown` | Stop only the exact verified owner process, wait for endpoint release, and transition lifecycle state to vacant. Required before cleanup; user-launched Workbench is never signalled. |
| `wb_cleanup` | After `wb_shutdown`, remove only hash-matching manifest-owned handler files. Cleanup is blocked while Workbench may be watching the mod; modified and unrelated files are preserved. |
| `wb_state` | Full Workbench snapshot — mode (edit/play), entity count, selection, terrain bounds, sub-scene, prefab edit status. |
| `wb_reload` | Reload plugins only. Every in-process game-script reload is refused; use verified owner-scoped `wb_restart` for clean compilation. |

#### Workbench observer adapter

The managed handler transaction also installs five dedicated observer endpoints
(`ping`, `submit`, `status`, `cancel`, and `release`) plus one non-handler common
transaction file. They are consumed only through the same long-lived
`WorkbenchClient` and exact lifecycle lease used by the `wb_*` tools. Observer
capture never launches Workbench, creates another process guard, enters Play,
executes a menu action, saves, or reloads scripts.

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

Before owner-scoped restart, shutdown, or cleanup, active captures receive a
bounded restoration request through the shared activity gate. If restoration
does not finish in time, the lifecycle mutation is refused before the global
mutex or process termination. Cleanup order remains: restore/cancel captures,
`wb_shutdown`, wait for a vacant endpoint, then explicitly call `wb_cleanup`.

### Workbench Editor Control (Live)

| Tool | What it does |
|------|-------------|
| `wb_play` | Refused for unattended automation. Enter Play manually while attended, confirm the action, verify mode with `wb_state`, and use `wb_stop` to return to edit mode. |
| `wb_stop` | Exit play mode and return to World Editor; already-edit mode is an idempotent success. |
| `wb_save` | Refused for unattended automation because Save/Save As can open modal UI. Save intentional editor changes manually while attended. |
| `wb_undo_redo` | Undo or redo the last World Editor action. |
| `wb_open_resource` | Open a resource in its editor (.et → Prefab Editor, .c → Script Editor, etc.). |
| `wb_execute_action` | Generic menu execution is disabled in both the MCP tool and direct handler; use a purpose-built, reviewed tool instead. |

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
| `REFORGER_FORGE_OBSERVER_STARTUP_TIMEOUT_MS` | Private child startup deadline | `10000` |
| `REFORGER_FORGE_OBSERVER_REQUEST_TIMEOUT_MS` | Private control request deadline | `30000` |
| `REFORGER_FORGE_OBSERVER_CAPTURE_TIMEOUT_MS` | Default synchronous capture/job deadline | `30000` |
| `REFORGER_FORGE_OBSERVER_MAX_INLINE_IMAGE_BYTES` | Maximum PNG bytes embedded in an MCP result | `8388608` |
| `REFORGER_FORGE_OBSERVER_RETENTION_INTERVAL_MS` | Agent retention sweep cadence | `60000` |
| `REFORGER_FORGE_OBSERVER_RETENTION_MAX_AGE_MS` | Retained artifact age limit | `604800000` |
| `REFORGER_FORGE_OBSERVER_RETENTION_MAX_BYTES` | Retained artifact total-size limit | `536870912` |
| `REFORGER_FORGE_OBSERVER_SESSION_TTL_MS` | Default prepared-session lifetime | `1200000` |
| `ENFUSION_WORKBENCH_PATH` | Arma Reforger Tools path | Steam default |
| `ENFUSION_GAME_PATH` | Arma Reforger game path | Sibling of Tools |
| `ENFUSION_PROJECT_PATH` | Mod output directory | `~/Documents/My Games/.../addons` |
| `ENFUSION_WORKBENCH_HOST` | NET API host; automated lifecycle control requires a numeric loopback address | `127.0.0.1` |
| `ENFUSION_WORKBENCH_PORT` | NET API port | `5775` |
| `REFORGER_FORGE_DEBUG` | Enable debug logging | off |

Config file search order:
1. `reforger-forge.config.json` in the package root, falling back to the local
   legacy `enfusion-mcp.config.json`
2. `~/.reforger-forge/config.json` in the user home, falling back to the home
   legacy `~/.enfusion-mcp/config.json`

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
npm test                       # Run hermetic default unit/contract suite
npm run test:integration       # Run explicitly gated environment integration tests
npm run test:package           # Verify published-package contents
npm run dev                    # Run server in dev mode
node scripts/list-tools.mjs    # Verify every required tool registers
.\scripts\install-agents.ps1 -All   # Push config to all agents
```

The observer screenshot harnesses are opt-in because they launch installed GUI
applications. Each requires an environment gate and an independent command-line
confirmation:

```powershell
$env:RFO_RUN_LIVE_WORKBENCH_OBSERVER_ACCEPTANCE = "1"
npm run observer:acceptance:workbench -- --confirm-live-run
```

The Workbench command reads installed-tool and addon-root paths from the
gitignored `reforger-forge.config.json`. It retains its evidence outside the
repository by default and refuses to start if an Arma Reforger or Workbench
process is already running.

**Live validation status:** the Workbench screenshot harness passed on
2026-07-16 and its retained PNGs were reviewed. Run `run-owDNnE` passed with
three materially varied 1165x641 native PNGs whose SHA-256 values are
`b70ee2343ea330eefcedd2fae6465385f7e8740d1812fb72dbfae4d0c2707d23`,
`ee09b489f4bae2531d2c4d02a0b0819efd4137e7d2fc423c843d936ed40f7af8`,
and `084844713cbfcc845fca4742abd3fcbf1ead885cefb13e169b0afad6633fc087`.
The explicit pose moved the editor camera by `(75, 25, 50)` world units and
increased vertical FOV by 10 degrees before exact restoration.
Every transaction reported restoration, the exact lifecycle owner shut down,
no Workbench process remained, and cleanup removed the unmodified managed
handler bundle with no modified or unrelated files.

The summary is retained outside the repository under the run's
`evidence/summary.json`. This pass qualifies the documented screenshot and
camera-restoration transaction only; it does not qualify headless rendering,
minimized/out-of-focus capture, failure injection, or remote/delegated
rendering.

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

It covers launch, same-target reuse, target-conflict refusal, restart, shutdown,
soak health checks, and manifest-scoped cleanup. The test reads `workbenchPath`,
`gamePath`, and `workbenchAddonDirs` only from the repository-local, gitignored
`reforger-forge.config.json`; keep every machine-specific path in that file. The
test complements, but does not replace, the documented manual failure-injection
and log-review acceptance protocol.

## Project Structure

```
reforger-forge-mcp/
├── src/                         # TypeScript source
├── data/                        # API index, wiki, patterns, knowledge base
├── mod/                         # Workbench NET API handler scripts
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
