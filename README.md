# ReforgerForge MCP

**The universal AI modding toolkit for Arma Reforger.**

Describe what you want to build — your AI agent handles API research, code generation, project scaffolding, Workbench control, and in-editor testing. Works with **any MCP-compatible agent**: Cursor, Claude Desktop, Claude Code, Kiro, VS Code, and more.

> Forked from [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK) with permission. ReforgerForge adds universal agent support, simplified setup, and ongoing maintenance as an independent project.

## Features

- **50 MCP tools** — API search, wiki, asset browsing, code generation, Workbench live control
- **8,693 indexed API classes** — full Enfusion/Arma Reforger class hierarchy
- **250+ wiki guides** — searchable tutorials and documentation
- **Agent-agnostic** — one server, configs for every major AI IDE
- **Zero modding experience required** — natural language → built addon

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/goatboynz/reforger-forge-mcp.git
cd reforger-forge-mcp
npm install
```

Or on Windows, run the setup script:

```powershell
.\scripts\setup.ps1
```

### 2. Configure paths

Copy the example config and set your paths:

```bash
cp reforger-forge.config.example.json reforger-forge.config.json
```

Edit `reforger-forge.config.json`:

| Key | Description |
|-----|-------------|
| `workbenchPath` | Arma Reforger Tools (Steam) install |
| `gamePath` | Arma Reforger game install |
| `projectPath` | Where your mods are saved |

### 3. Connect your agent

Pick your agent below, then restart it and verify **reforger-forge** shows 50 tools.

## Agent Setup

### Cursor

**Workspace** (included): `.cursor/mcp.json`

**Global** (all projects): run `.\scripts\setup.ps1` and answer `y`, or merge `configs/cursor-global.json` into `%USERPROFILE%\.cursor\mcp.json`.

Then: **MCP: Restart Servers**

### Claude Desktop

Merge `configs/claude-desktop.json` into your Claude config:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

### Claude Code

```bash
# Windows
claude mcp add --scope user reforger-forge -- cmd /c node "FULL_PATH\reforger-forge-mcp\dist\index.js"

# macOS / Linux
claude mcp add --scope user reforger-forge -- node /path/to/reforger-forge-mcp/dist/index.js
```

### Kiro

Config at `.kiro/settings/mcp.json` — restart Kiro or **MCP: Reconnect Server**.

### Any other MCP client

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": ["/absolute/path/to/reforger-forge-mcp/dist/index.js"],
      "env": {
        "ENFUSION_WORKBENCH_PATH": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools",
        "ENFUSION_GAME_PATH": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger",
        "ENFUSION_PROJECT_PATH": "C:\\Users\\YOU\\Documents\\My Games\\ArmaReforgerWorkbench\\addons"
      }
    }
  }
}
```

## Tools

Run `node scripts/list-tools.mjs` to verify all registered tools.

### Offline (no Workbench needed)

| Tool | What it does |
|------|-------------|
| `api_search` | Search 8,693 API classes and methods |
| `component_search` | Find ScriptComponents by category |
| `wiki_search` / `wiki_read` | Search and read modding guides |
| `wb_knowledge` | Bundled modding knowledge base |
| `game_browse` / `game_read` | Browse base game files and `.pak` archives |
| `asset_search` | Search game assets by name |
| `mod` | Create, validate, and build addons |
| `script_create` | Generate Enforce Script `.c` files |
| `prefab` | Create and inspect `.et` prefabs |
| `project` | Browse, read, and write project files |
| `layout_create` | Generate UI `.layout` files |
| `config_create` | Generate faction/mission configs |
| `scenario_create` | Build scenario framework objectives |
| `animation_graph` | Animation graph tooling |
| `building_setup` | Building destruction workflow |

### Live Workbench (`wb_*` — requires Workbench running)

| Tool | What it does |
|------|-------------|
| `wb_launch` | Start Workbench and install handler scripts |
| `wb_connect` | Test NET API connection |
| `wb_play` / `wb_stop` | Enter/exit play mode |
| `wb_entity_*` | Create, modify, inspect, select entities |
| `wb_component` | Add/remove/list components |
| `wb_layers` | Layer management |
| `wb_prefabs` | Prefab operations |
| `wb_resources` | Register resources, rebuild database |
| `wb_script_editor` | Read/write open script file |
| `wb_state` | Full Workbench state snapshot |
| ...and 20 more | See `node scripts/list-tools.mjs` |

## Usage Examples

```
Create a HUD widget that shows player health and stamina
Make a zombie survival game mode with wave spawning
Search the API for all vehicle damage components
Launch Workbench, load my mod, and enter play mode
```

## Configuration

Environment variables override config files:

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFUSION_WORKBENCH_PATH` | Arma Reforger Tools path | Steam default |
| `ENFUSION_GAME_PATH` | Arma Reforger game path | Sibling of Tools |
| `ENFUSION_PROJECT_PATH` | Mod output directory | `~/Documents/My Games/.../addons` |
| `ENFUSION_WORKBENCH_HOST` | NET API host | `127.0.0.1` |
| `ENFUSION_WORKBENCH_PORT` | NET API port | `5775` |
| `REFORGER_FORGE_DEBUG` | Enable debug logging | off |

Config file search order:
1. `reforger-forge.config.json` (project root)
2. `~/.reforger-forge/config.json` (user home)
3. Legacy `enfusion-mcp.config.json` paths (backward compatible)

## Requirements

- **Node.js 20+**
- **Arma Reforger Tools** (Steam) — for `mod_build` and all `wb_*` tools
- **Arma Reforger** (Steam) — for game asset browsing

## Development

```bash
npm run build     # Compile TypeScript
npm test          # Run test suite (446 tests)
npm run dev       # Run server in dev mode
node scripts/list-tools.mjs   # Verify tool registration
```

## Project Structure

```
reforger-forge-mcp/
├── src/                    # TypeScript source
├── data/                   # API index, wiki, patterns, knowledge base
├── mod/                    # Workbench NET API handler scripts
├── configs/                # Agent config templates
├── scripts/                # Setup and verification scripts
├── .cursor/mcp.json        # Cursor workspace config
├── .kiro/settings/mcp.json # Kiro config
├── dist/                   # Built server (generated)
└── package.json
```

## Publishing to GitHub

```bash
# Create repo on GitHub first, then:
git remote add origin https://github.com/goatboynz/reforger-forge-mcp.git
git branch -M main
git push -u origin main
```

## Credits & Attribution

ReforgerForge MCP is based on the excellent work of:

- **[steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK)** — primary upstream fork
- **[Articulated7/enfusion-mcp](https://github.com/Articulated7/enfusion-mcp)** — original project

Used and modified with permission. MIT licensed.

## License

MIT — see [LICENSE](LICENSE)
