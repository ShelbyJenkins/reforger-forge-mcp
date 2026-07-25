# MCP Client Notes

For prerequisites, default setup behavior, Doctor, receipts, Steam discovery,
configuration overrides, and manual installation, see the
[complete setup guide](../setup.md).

This page contains only registration targets, commands, migration caveats, and
refresh steps specific to each MCP client.

## Codex

Automatic setup uses the Codex MCP CLI and its default user/global scope. The
registration is named `reforger-forge`.

The equivalent config-free manual commands are:

```powershell
$ServerPath = (Resolve-Path .\dist\index.js).Path
codex mcp add reforger-forge -- node $ServerPath
codex mcp list
```

If a registration with that name already exists, remove or replace it through
the Codex CLI. To register an explicit ReforgerForge override, follow
[Registering an explicit override](../setup.md#registering-an-explicit-override).

## Google Antigravity

Automatic setup uses one user target. Fresh registrations use
`%USERPROFILE%\.gemini\config\mcp_config.json`. If Antigravity is positively
detected and the alternate
`%USERPROFILE%\.gemini\antigravity\mcp_config.json` already exists while the
canonical file does not, setup updates that alternate file instead. It never
writes both.

A shared `.gemini\config` file by itself is not positive Antigravity detection
evidence.

The explicit-config manual installer always writes the canonical
`.gemini\config\mcp_config.json` target. It does not retain an existing
alternate `.gemini\antigravity\mcp_config.json`, so review both files before
using `install-agents.ps1 -All`.

After setup, open Antigravity → **Settings** → **Customizations** →
**Open MCP Config**, confirm `reforger-forge` appears, and refresh Installed MCP
Servers if necessary.

The config-free entry has this shape:

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": [
        "C:\\full\\path\\to\\reforger-forge-mcp\\dist\\index.js"
      ]
    }
  }
}
```

## Cursor

Automatic setup updates the user registration at
`%USERPROFILE%\.cursor\mcp.json` under `mcpServers`.

For a manual config-free install, merge
[cursor-global.json](configs/cursor-global.json). To intentionally create a
workspace-only registration instead, copy
[stdio-template.json](configs/stdio-template.json) to `.cursor/mcp.json` and
replace the absolute server-path placeholder.

After changing the registration, run **MCP: Restart Servers**.

## Claude Desktop

Automatic setup writes only the user target
`%APPDATA%\Claude\claude_desktop_config.json` under `mcpServers` when Claude
Desktop is detected.

For a manual config-free install, merge
[claude-desktop.json](configs/claude-desktop.json) into the client's
`mcpServers` object, then restart Claude Desktop.

## Claude Code

Automatic setup uses a named `reforger-forge` registration with
`--scope user`. It inspects the entry through `claude mcp get` and reads the
exact user state from `%USERPROFILE%\.claude.json`, or
`%CLAUDE_CONFIG_DIR%\.claude.json` when that override is set.

A same-named local/project entry takes precedence over user scope. Setup leaves
that entry unchanged and reports the conflict for manual attention.

Command discovery prefers `claude` on `PATH`. When it is absent, setup checks
the standard VS Code and VS Code Insiders extension installations for
`anthropic.claude-code-*`, ignores obsolete versions, and selects the newest
validated bundled native CLI. Invalid, incomplete, or symbolic-link-backed
extension candidates are never executed. Custom VS Code `--extensions-dir`
locations remain manual.

The config-free manual equivalent is:

```powershell
claude mcp add --scope user reforger-forge -- node "FULL_PATH\reforger-forge-mcp\dist\index.js"
```

To add an explicit ReforgerForge config, append
`--config "FULL_PATH\reforger-forge.config.json"` after the server path.

## VS Code (GitHub Copilot)

VS Code uses the `servers` key rather than `mcpServers`. Automatic setup updates
only the user target `%APPDATA%\Code\User\mcp.json`; it does not also write the
workspace target `.vscode\mcp.json`.

The explicit-config manual installer is intentionally different: it writes
both `%APPDATA%\Code\User\mcp.json` and the ReforgerForge repository's
`.vscode\mcp.json`. Use its `-All` mode only when that workspace registration
is also wanted.

For manual config-free registration, merge
[vscode-template.json](configs/vscode-template.json) into the selected
`mcp.json`.

Open **MCP: List Servers** from the command palette and verify that
`reforger-forge` is running.

## Windsurf

Automatic setup uses the user target
`%USERPROFILE%\.codeium\windsurf\mcp_config.json` under `mcpServers`.

Refresh the MCP list in the Cascade panel after registration if Windsurf does
not reload it automatically.

## Continue.dev

Automatic setup updates the `mcpServers` sequence in the user target
`%USERPROFILE%\.continue\config.yaml`. It preserves unrelated YAML content.

Continue's legacy `config.json` and `config.yml` formats are not migrated
automatically. If one exists without the current `config.yaml`, setup reports a
manual migration instead of creating a competing file.

The explicit-config manual installer targets the legacy
`%USERPROFILE%\.continue\config.json` file rather than current
`config.yaml`. Review or migrate the Continue configuration before including
Continue in `install-agents.ps1 -All`.

## Kiro

Automatic setup uses the user target
`%USERPROFILE%\.kiro\settings\mcp.json`, or
`%KIRO_HOME%\settings\mcp.json` when `KIRO_HOME` is set.

Parameterless setup never infers or writes a workspace
`.kiro\settings\mcp.json`.

The explicit-config manual installer instead writes the ReforgerForge
repository's `.kiro\settings\mcp.json`. Use its `-All` mode only when that
workspace registration is wanted.

## Other MCP clients

Use [stdio-template.json](configs/stdio-template.json), replace the absolute
server-path placeholder, and merge the entry into the client's MCP
configuration.

If the client uses a `servers` key rather than `mcpServers`, adapt the outer
container to that client's schema. To opt into a custom ReforgerForge config,
follow [Registering an explicit override](../setup.md#registering-an-explicit-override)
and add the `--config` arguments to the client's server entry.
