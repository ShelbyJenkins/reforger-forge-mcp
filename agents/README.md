# Agent Setup

ReforgerForge uses **stdio MCP** (local Node.js process). Every agent below runs
the same server with `--config <absolute-path>`.

Run commands from the ReforgerForge repository root after building the server.

## Workspace instructions

Copy [the starter `AGENTS.md`](AGENTS.md) into the root of your modding
workspace and replace its placeholders. It gives coding agents a practical
setup checklist, MCP tool-routing guide, Workbench workflow, resource-safety
rules, validation steps, and troubleshooting reference.

## Supported clients

| Agent | Config file | Install command |
|-------|-------------|-----------------|
| **Codex** | `%USERPROFILE%\.codex\config.toml` | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent codex` |
| **Cursor** | `%USERPROFILE%\.cursor\mcp.json` | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent cursor` |
| **Google Antigravity** | `%USERPROFILE%\.gemini\config\mcp_config.json` | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent antigravity` |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent claude` |
| **Windsurf** | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent windsurf` |
| **VS Code (Copilot)** | `%APPDATA%\Code\User\mcp.json` + `.vscode\mcp.json` | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent vscode` |
| **Continue.dev** | `%USERPROFILE%\.continue\config.json` | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent continue` |
| **Kiro** | `.kiro/settings/mcp.json` (workspace) | `.\agents\install-agents.ps1 -ConfigPath <path> -Agent kiro` |
| **All installer-supported agents** | All installer rows above | `.\agents\install-agents.ps1 -ConfigPath <path> -All` |

## Codex

The installer uses the standard Codex MCP CLI documented in the
[official Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp):

```powershell
.\agents\install-agents.ps1 -ConfigPath <path> -Agent codex
```

The equivalent manual commands are:

```powershell
$ServerPath = (Resolve-Path .\dist\index.js).Path
$ConfigPath = (Resolve-Path .\reforger-forge.config.json).Path
codex mcp add reforger-forge -- node $ServerPath --config $ConfigPath
codex mcp list
```

If a registration with that name already exists, run
`codex mcp remove reforger-forge` first. Restart Codex after adding or replacing
the server.

## Google Antigravity

1. Run `.\agents\install-agents.ps1 -ConfigPath <path> -Agent antigravity`
2. Open Antigravity → **Settings** → **Customizations** → **Open MCP Config**
3. Confirm `reforger-forge` appears, then click **Refresh** in Installed MCP Servers
4. The shared config is at `~/.gemini/config/mcp_config.json` (same file used by Antigravity CLI)

Manual config (if needed):

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": [
        "C:\\full\\path\\to\\reforger-forge-mcp\\dist\\index.js",
        "--config",
        "C:\\full\\path\\to\\reforger-forge.config.json"
      ]
    }
  }
}
```

## Cursor

For a global install, run the install script or merge
`agents/configs/cursor-global.json`. For a workspace-only install, copy
`agents/configs/stdio-template.json` to `.cursor/mcp.json` and replace the
placeholder path. Generated workspace config is intentionally ignored by Git.

Restart → **MCP: Restart Servers**

## Claude Desktop

Merge `agents/configs/claude-desktop.json` or run the install script.

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## Claude Code

```powershell
claude mcp add --scope user reforger-forge -- node "FULL_PATH\reforger-forge-mcp\dist\index.js" --config "FULL_PATH\reforger-forge.config.json"
```

## VS Code (GitHub Copilot)

Uses `servers` key (not `mcpServers`). Run the install script—it writes both
user-level and workspace `.vscode/mcp.json`.

Command palette: **MCP: List Servers** → verify `reforger-forge` is running.

## Windsurf (Cascade)

Global config only at `%USERPROFILE%\.codeium\windsurf\mcp_config.json`. Run the
install script, then refresh the MCP list in the Cascade panel.

## Continue.dev

Run the install script. MCP servers live inside
`%USERPROFILE%\.continue\config.json` under `mcpServers`.

## Any other MCP client

Use the stdio template at `agents/configs/stdio-template.json`. Replace both
absolute-path placeholders with the built server and selected config locations.

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": [
        "/absolute/path/to/reforger-forge-mcp/dist/index.js",
        "--config",
        "/absolute/path/to/reforger-forge.config.json"
      ]
    }
  }
}
```
