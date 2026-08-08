# AI Client Setup and Troubleshooting

This guide covers first-use MCP registration, client refresh, and recovery
steps. It is for connecting an AI client to ReforgerForge; it is not the
coding-agent workflow guide.

For prerequisites, default setup, Doctor, Steam discovery, configuration
settings, and path validation, read the [complete setup guide](../SETUP.md).
For how an agent should use the available tools after registration, read
[AGENTS.md](AGENTS.md).

## First Use

From the ReforgerForge repository root, run:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
~~~

The default setup installs dependencies, builds the server, checks its MCP
handshake, and attempts the standard user/global registration for each detected
supported client. It uses a config-free server entry and does not launch
Workbench or the game.

Then:

1. Restart the AI client, or use its MCP-server refresh command.
2. Confirm that a server named reforger-forge is running and its tools appear.
3. If it does not, run the read-only diagnostic:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Doctor
~~~

Setup success confirms that the registration was written or already current; it
cannot prove the client has reloaded it.

## Registration Model

A normal registration starts the built server with:

~~~text
node --title=ReforgerForge-MCP-<client> <absolute-package-path>\dist\index.js --mcp-client-label <client>
~~~

Setup derives `<client>` from the supported client definition. The Node option
must remain before the server path and the server-only host option after it.
Old registrations without both markers are migrated as different entries.

A workspace may instead register a project-owned `start_mcp.ps1` when it needs
repository dependency roots, Observer evidence roots, or another explicit
startup setting. With no mode, that script is a stdio command owned by the MCP
client. Do not run it in an interactive terminal or launch it as a background
server; doing so does not connect the new process to an already-running client.

Project launchers based on `scripts/start-mcp-stdio.ps1` also support two
non-persistent checks:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\start_mcp.ps1 -Mode Describe
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\to\start_mcp.ps1 -Mode Verify
~~~

`Describe` writes a schema-2 JSON document containing the resolved Node
executable and version, `nodeArguments`, built server, verifier,
`hostArguments`, and configuration-only `configurationArguments`; it starts
neither the MCP server nor Workbench. `Verify` runs the existing fresh-process
MCP verifier with those arguments and exits. Neither mode refreshes the
client-owned server. `-ClientLabel` selects the validated marker and defaults
to `manual`.

Do not create a ReforgerForge configuration file for ordinary discovery. Use an
explicit configuration only for nonstandard paths or settings. The full
procedure, including the manual installer, is in
[Registering an explicit override](../SETUP.md#registering-an-explicit-override).

When manually adding a configured server, append:

~~~text
--config <absolute-config-path>
~~~

Keep that machine-local file out of source control. Restart the client after
changing its registration or its selected configuration path.

## Local Development Rebuilds

After `npm run build`, refresh the `reforger-forge` MCP server in the AI client
or restart the client before testing the rebuilt code. An already-running
stdio process continues using the modules, tool registrations, and startup
policy it loaded when it started.

`npm run mcp:verify` validates the build by starting a separate fresh MCP
process; it does not update the process already connected to the client.
Likewise, `wb_restart` restarts only the exact MCP-owned Workbench process. It
does not reload the MCP server.

When the ReforgerForge tools are already visible in a coding session, do not
shell-launch `node dist/index.js` or a project `start_mcp.ps1`: the client owns
the connected stdio process. Use `wb_launch` for attended Workbench. Use the
standalone `reforger-forge-workbench editor` command only when no live MCP owns
the lifecycle lease.

## Client-Specific Registration

### Codex

Automatic setup uses the Codex MCP CLI at its default user/global scope. The
registration name is reforger-forge.

The config-free manual equivalent is:

~~~powershell
$ServerPath = (Resolve-Path .\dist\index.js).Path
codex mcp add reforger-forge -- node --title=ReforgerForge-MCP-codex $ServerPath --mcp-client-label codex
codex mcp list
~~~

If the name already exists, use the Codex CLI to remove or replace that entry.
For an explicit ReforgerForge configuration, add the config argument described
above.

### Google Antigravity

Automatic setup normally updates:

~~~text
%USERPROFILE%\.gemini\config\mcp_config.json
~~~

If Antigravity is positively detected and only its existing alternate file is
present, setup instead updates:

~~~text
%USERPROFILE%\.gemini\antigravity\mcp_config.json
~~~

It never writes both. A shared .gemini\config folder by itself is not proof of
an Antigravity installation. After registration, open Settings, Customizations,
Open MCP Config, verify the reforger-forge entry, and refresh Installed MCP
Servers if necessary.

The explicit-config manual installer always targets the canonical config path.
Review both locations before running its all-client mode.

### Cursor

Automatic setup updates the user entry at:

~~~text
%USERPROFILE%\.cursor\mcp.json
~~~

For a config-free manual install, merge
[cursor-global.json](configs/cursor-global.json). To use a workspace-only
registration, copy [stdio-template.json](configs/stdio-template.json) to
.cursor/mcp.json and replace the absolute server-path and client-label
placeholders with the intended trusted client slug.

After changing the entry, run MCP: Restart Servers.

### Claude Desktop

Automatic setup updates the detected user configuration:

~~~text
%APPDATA%\Claude\claude_desktop_config.json
~~~

For a config-free manual registration, merge
[claude-desktop.json](configs/claude-desktop.json) into mcpServers, then
restart Claude Desktop.

### Claude Code

Automatic setup creates a reforger-forge entry at user scope. A same-named
local or project entry takes precedence; setup preserves it and reports the
conflict for manual review.

The config-free manual equivalent is:

~~~powershell
claude mcp add --scope user reforger-forge -- node --title=ReforgerForge-MCP-claude-code "FULL_PATH\reforger-forge-mcp\dist\index.js" --mcp-client-label claude-code
~~~

To use an explicit configuration, append:

~~~text
--config "FULL_PATH\reforger-forge.config.json"
~~~

Setup prefers claude on PATH. When it is unavailable, it can use a validated
bundled native CLI from a standard Claude Code VS Code installation. A custom
VS Code extensions directory remains a manual setup case.

### VS Code (GitHub Copilot)

VS Code uses the servers key, rather than mcpServers. Automatic setup updates:

~~~text
%APPDATA%\Code\User\mcp.json
~~~

For a manual config-free registration, merge
[vscode-template.json](configs/vscode-template.json) into the selected mcp.json.
Use the Command Palette command MCP: List Servers to verify that
reforger-forge is running.

The explicit-config manual installer can also write this repository's
.vscode/mcp.json. Use that workspace registration only when it is intentional.

### Windsurf

Automatic setup updates:

~~~text
%USERPROFILE%\.codeium\windsurf\mcp_config.json
~~~

Refresh the Cascade MCP list if it does not reload automatically.

### Continue.dev

Automatic setup updates the mcpServers sequence in:

~~~text
%USERPROFILE%\.continue\config.yaml
~~~

Legacy config.json and config.yml files are not migrated automatically. If a
legacy file exists without current config.yaml, migrate or review the
configuration manually before adding ReforgerForge.

The explicit-config manual installer uses the legacy config.json target, so
review the current Continue configuration before including Continue in its
all-client mode.

### Kiro

Automatic setup updates:

~~~text
%USERPROFILE%\.kiro\settings\mcp.json
~~~

When KIRO_HOME is set, its settings directory is used instead. Parameterless
setup never infers a workspace .kiro\settings\mcp.json. The explicit-config
manual installer can target the repository workspace file; use that only when
the workspace-level registration is desired.

### Other MCP Clients

Copy [stdio-template.json](configs/stdio-template.json), replace the absolute
server-path placeholder and both `REPLACE_WITH_CLIENT_LABEL` placeholders, and
merge the entry into the client configuration. Use one stable lowercase client
slug in both label positions.
If that client uses servers instead of mcpServers, adapt the outer container to
its documented schema. Add an explicit --config argument only when using a
deliberately selected ReforgerForge configuration file.

### Identifying a running host

On Windows, enable Task Manager's **Details > Command line** column. Managed
entries show the product and owning client in both the Node title argument and
the server host argument. The runtime title also contains the first eight hex
characters of the process instance UUID, while `wb_diagnose` reports the full
bounded identity.

The executable **Image name** remains `node.exe`; the package does not copy or
rename Node. A command-line label, runtime title, PID, or UUID is informational,
not termination authority. Refresh or stop the MCP server through the client
that owns its stdio connection. Never terminate Workbench or a game process by
name or PID; use the exact-owned lifecycle tools.

## Troubleshooting

| Problem | Recovery |
|---|---|
| The client does not list reforger-forge | Restart or refresh the client, then run setup.ps1 -Doctor to inspect the registration without changing it. |
| The client starts the server but no tools appear | Run npm run mcp:verify from the repository root. Check the client log for its server-start error and verify its entry points to the built dist\index.js. |
| The registration points at an old checkout | Replace the entry through the client CLI or its configuration file with the current absolute dist\index.js path, then restart the client. |
| A custom path or setting is required | Follow the explicit override procedure in [SETUP.md](../SETUP.md#registering-an-explicit-override); do not edit a shared or committed config. |
| A duplicate name behaves unexpectedly | Check user, workspace, local, and project registrations. In particular, Claude Code local/project entries override user scope. Keep one intentional entry for each scope. |
| Setup reports manual attention | Read the client-specific section above and the setup receipt. It deliberately preserves malformed, unsafe, or ambiguous client configuration instead of overwriting it. |
| Workbench or Observer is shown as not tested by Doctor | This is expected for normal Doctor. Add -CheckWorkbench only to ping an already-running Workbench; it never launches Workbench or captures the game. |

## Configuration Templates

The config-free templates are provided for manual registration:

- [stdio-template.json](configs/stdio-template.json)
- [cursor-global.json](configs/cursor-global.json)
- [claude-desktop.json](configs/claude-desktop.json)
- [vscode-template.json](configs/vscode-template.json)

Use the [complete setup guide](../SETUP.md) for the ReforgerForge configuration
file itself, discovery defaults, settings reference, and recovery from path or
validation errors.
