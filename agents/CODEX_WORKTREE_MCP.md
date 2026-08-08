# Codex Worktree MCP Development

Use this guide when a stable ReforgerForge MCP registration already exists but
one Codex worktree should launch ReforgerForge from paths inside that worktree.
The normal user/global registration remains unchanged everywhere else.

This workflow only renders a worktree-local MCP configuration with different
paths. The environment setup does not install dependencies, compile the
project, or start the server. Codex starts the configured server afterward and
owns its stdio connection.

## How project scoping works

Codex reads personal MCP registrations from `~/.codex/config.toml` and trusted
project overrides from `.codex/config.toml`. Project values have higher
precedence than user values. Defining the same `mcp_servers` key in the
worktree therefore selects the worktree command for that project without
rewriting the normal user/global registration.

The project configuration applies only when:

- the worktree is trusted by Codex;
- the Codex task root/current working directory is that worktree or one of its
  descendants; and
- the configuration is present when the new worktree task initializes, or the
  desktop client reloads MCP configuration after it is written.

Merely adding the worktree as another accessible directory to a task rooted
elsewhere does not select the worktree's project configuration.

Codex starts a configured stdio server as its own child process. Do not launch
`node` or `scripts/start-mcp-stdio.ps1` in a separate terminal and expect Codex
to attach to it; that process's stdin and stdout belong to the terminal rather
than to the MCP client.

Official Codex references:

- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- [Configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)
- [Local environments](https://learn.chatgpt.com/docs/environments/local-environment)
- [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## Automate Codex-created worktrees

Use a Codex local-environment setup script as the creation-time path injector.
Codex supplies these environment variables to the script:

- `CODEX_SOURCE_TREE_PATH`: the original checkout from which Codex creates the
  worktree;
- `CODEX_WORKTREE_PATH`: the new worktree that the task will use.

The source path lets the setup locate a canonical MCP config template. The
worktree path is inserted into that template and determines the project data
paths and working directory in the generated project config. The launcher can
come from either path, depending on the repository layout.

The generic example below assumes that the Codex worktree is itself a
ReforgerForge MCP checkout. When the MCP runtime remains in a stable checkout
while project data comes from the worktree, use
[Split a stable MCP runtime from worktree data](#split-a-stable-mcp-runtime-from-worktree-data).

### 1. Add a source-tree template

Create this template in the source checkout:

~~~text
<source-tree>\.codex\worktree-mcp.config.toml
~~~

Codex does not load that filename as project configuration. It becomes active
only after the environment setup renders it as `.codex/config.toml` in the new
worktree.

~~~toml
[mcp_servers.reforger-forge]
command = 'powershell.exe'
args = [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', '__CODEX_WORKTREE_PATH__\scripts\start-mcp-stdio.ps1',
  '-ClientLabel', 'codex-worktree',
]
cwd = '__CODEX_WORKTREE_PATH__'
enabled = true
startup_timeout_sec = 20
~~~

Use the same `reforger-forge` key as the user/global registration. That makes
this entry a project override instead of a second, side-by-side tool set.

The placeholder is inside TOML literal strings so the rendered Windows path
does not require doubled backslashes. Do not put a single quote in the
worktree path; the setup below rejects that case rather than emitting invalid
TOML.

### 2. Configure the Windows environment setup

In the ChatGPT desktop app, open the project's Codex local-environment settings
and add the following Windows setup script. The app stores the environment in
the project's `.codex/environment.toml`; it can be checked into the repository
with the template when the setup should be shared.

~~~powershell
$ErrorActionPreference = 'Stop'

$sourcePath = $env:CODEX_SOURCE_TREE_PATH
$worktreePath = $env:CODEX_WORKTREE_PATH

if ([string]::IsNullOrWhiteSpace($sourcePath)) {
    throw 'CODEX_SOURCE_TREE_PATH was not supplied by Codex.'
}
if ([string]::IsNullOrWhiteSpace($worktreePath)) {
    throw 'CODEX_WORKTREE_PATH was not supplied by Codex.'
}

$sourceRoot = [System.IO.Path]::GetFullPath($sourcePath)
$worktreeRoot = [System.IO.Path]::GetFullPath($worktreePath)

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "Codex source tree does not exist: $sourceRoot"
}
if (-not (Test-Path -LiteralPath $worktreeRoot -PathType Container)) {
    throw "Codex worktree does not exist: $worktreeRoot"
}
if ($worktreeRoot.Contains("'")) {
    throw "The worktree path cannot be written safely as a TOML literal string: $worktreeRoot"
}

$templatePath = Join-Path $sourceRoot '.codex\worktree-mcp.config.toml'
$worktreeCodexDir = Join-Path $worktreeRoot '.codex'
$worktreeConfig = Join-Path $worktreeCodexDir 'config.toml'
$placeholder = '__CODEX_WORKTREE_PATH__'

if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
    throw "Worktree MCP template is missing: $templatePath"
}

$template = [System.IO.File]::ReadAllText($templatePath)
if (-not $template.Contains($placeholder)) {
    throw "Worktree MCP template does not contain $placeholder"
}

$rendered = $template.Replace($placeholder, $worktreeRoot)
[System.IO.Directory]::CreateDirectory($worktreeCodexDir) | Out-Null
[System.IO.File]::WriteAllText(
    $worktreeConfig,
    $rendered,
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Wrote worktree MCP config: $worktreeConfig"
~~~

This script is idempotent: each run renders the destination from the canonical
source template. It intentionally owns the generated worktree
`.codex/config.toml`. If that file also needs unrelated project settings, put
those settings in the template so the setup preserves them.

The important sequence is:

1. Codex creates the Git worktree.
2. The local environment renders `.codex/config.toml` with the new worktree
   paths.
3. Setup exits without launching ReforgerForge.
4. The new worktree task loads the project override and Codex starts the MCP
   server as its stdio child.

That provisioning sequence avoids asking the already-running source task to
hot-load a server. The generated config belongs to the new task rooted in the
new worktree.

## Split a stable MCP runtime from worktree data

Some projects keep one prepared MCP runtime in a stable checkout instead of
copying or installing it into every worktree. The generated project config can
launch that stable runtime while pointing its project-specific roots at the
new worktree. Keep the boundary explicit:

| Concern | Resolve from |
|---|---|
| Project-owned launcher or wrapper | `CODEX_SOURCE_TREE_PATH` |
| Prepared MCP runtime and server entry point | `CODEX_SOURCE_TREE_PATH`, or another explicitly configured stable location |
| Project, add-on, and evidence roots | `CODEX_WORKTREE_PATH` |
| Generated project config and process working directory | `CODEX_WORKTREE_PATH` |

Do not put a real checkout name, account name, or machine path in the shared
template. Store only relative paths and the two placeholders shown below.

### Repository-neutral file layout

Keep the environment definition, renderer, and inactive template at generic
repository-relative locations:

~~~text
.codex\environment.toml
.codex\configure-worktree-mcp.ps1
.codex\worktree-mcp.config.toml
<relative-path-to-project-wrapper.ps1>
~~~

The stable checkout does not need an active `.codex/config.toml` for this
pattern. The environment creates that active filename inside each destination
worktree.

The checked-in environment can call the renderer without installing, building,
or starting the MCP server:

~~~toml
version = 1
name = "Worktree MCP"

[setup]
script = ""

[setup.win32]
script = '''
& powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:CODEX_SOURCE_TREE_PATH\.codex\configure-worktree-mcp.ps1" `
  -SourceTreePath "$env:CODEX_SOURCE_TREE_PATH" `
  -WorktreePath "$env:CODEX_WORKTREE_PATH"

if ($LASTEXITCODE -ne 0) {
    throw "Worktree MCP configuration failed with exit code $LASTEXITCODE."
}
'''
~~~

This assumes the selected stable runtime is already runnable. Path rendering
alone does not create runtime artifacts, and no rebuild is required merely to
change which worktree paths the server receives.

### Two-path template

Adapt the angle-bracket placeholders to the wrapper used by the project before
checking in the template:

~~~toml
# Generated by .codex/configure-worktree-mcp.ps1. Do not edit generated copies.

[mcp_servers.reforger-forge]
command = 'powershell.exe'
args = [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', '__CODEX_SOURCE_TREE_PATH__\<relative-path-to-project-wrapper.ps1>',
  '-Mode', 'Serve',
  '<worktree-root-option>', '__CODEX_WORKTREE_PATH__',
  '<mcp-root-option>', '__CODEX_SOURCE_TREE_PATH__\<relative-path-to-mcp-runtime>',
]
cwd = '__CODEX_WORKTREE_PATH__'
enabled = true
startup_timeout_sec = 20
~~~

The angle-bracket option names are wrapper-defined placeholders, not Codex or
MCP protocol flags. Replace them with the wrapper's actual parameter names.
Likewise, replace each angle-bracket path with a repository-relative path. Keep
the `__CODEX_SOURCE_TREE_PATH__` and `__CODEX_WORKTREE_PATH__` tokens unchanged;
the renderer substitutes those per worktree.

Only include launcher options supported by the selected wrapper and runtime.
Use a non-starting describe mode or a bounded verification mode, when the
wrapper provides one, to confirm the final command line.

### Wrapper contract

A project-owned wrapper should accept separate optional roots for:

- the project checkout whose project, add-on, and evidence paths the server
  will use; and
- the stable MCP checkout whose launcher and server entry point it will use.

Default both roots as appropriate for the project's normal user/global
registration. Supplying the overrides should change only path resolution; it
should not install dependencies, compile the server, or start another process
outside the client-owned stdio lifecycle.

### Renderer safety

The checked-in renderer should:

- accept explicit source-tree and worktree paths, so the same helper works for
  creation-time setup and remediation;
- verify that the paths are distinct existing directories and safe for the
  template's TOML literal strings;
- verify the template, wrapper, runtime entry point, and required worktree
  directories before writing;
- replace both `__CODEX_SOURCE_TREE_PATH__` and `__CODEX_WORKTREE_PATH__`, then
  write UTF-8 without a byte-order mark;
- update an identical or previously generated config idempotently, but refuse
  to overwrite an existing config without its generated marker; and
- support PowerShell `-WhatIf` for a non-writing preview after validation.

An unmanaged config may contain settings that must be retained. Merge its
`mcp_servers.reforger-forge` table deliberately rather than weakening the
renderer safeguard.

### Apply the split pattern to an existing worktree

Preview the same renderer with generic explicit paths:

~~~powershell
$sourceTree = 'C:\path\to\source-checkout'
$existingWorktree = 'C:\path\to\existing-worktree'

& powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$sourceTree\.codex\configure-worktree-mcp.ps1" `
  -SourceTreePath $sourceTree `
  -WorktreePath $existingWorktree `
  -WhatIf
~~~

After reviewing the resolved destination, run the same command without
`-WhatIf`. If the helper reports an unmanaged existing config, stop and merge
the server table instead of deleting or replacing that file. Then follow
[Refresh an already-loaded task through App Server](#refresh-an-already-loaded-task-through-app-server)
or open a new task rooted in that worktree.

If the wrapper has a non-starting describe mode, invoke it with the worktree
root and stable MCP root. Verify that its server entry point resolves from the
stable location and every project-owned data path resolves from the worktree.

## Remediate existing worktrees and tasks

Local-environment setup runs automatically while Codex creates a new
worktree. It does not run retroactively for worktrees or tasks that already
exist. Remediate those checkouts by rendering their project config once, then
refreshing the client that owns the MCP connection.

| Existing state | Remediation |
|---|---|
| Worktree exists and no task is loaded | Render `<worktree>\.codex\config.toml`, then open a task rooted in that worktree. |
| Task is loaded and rooted in the worktree | Render the config, wait for the active turn to finish, reload MCP configuration, and use the refreshed tools on the next turn. |
| Task is rooted in another checkout | Open, fork, or hand off to a task rooted in the intended worktree. Reloading does not change project-config scope. |
| Worktree was deleted | Restore that checkout or create a replacement. A task cannot launch a project-scoped server from a missing path. |

For an existing worktree, render or create this file directly:

~~~text
<worktree>\.codex\config.toml
~~~

Use the same TOML as the source template, replacing every
`__CODEX_WORKTREE_PATH__` placeholder with that worktree's absolute path. A
Codex task with workspace-write access can create the file normally. An App
Server client can use `fs/createDirectory` and `fs/writeFile`. Neither route
needs to invoke the local-environment setup retroactively.

Do not replace a shared project configuration without agreement from the
repository maintainers. If the file also contains unrelated settings, merge
the rendered `mcp_servers.reforger-forge` table instead of overwriting it.

### Refresh an already-loaded task through App Server

After the worktree config exists, an App Server client can request an MCP
configuration reload:

~~~json
{ "method": "config/mcpServer/reload", "id": 1 }
~~~

That operation rereads MCP configuration from disk and queues an MCP refresh
for loaded tasks. It has no request parameters. Inspect the resulting startup
and tool state with:

~~~json
{
  "method": "mcpServerStatus/list",
  "id": 2,
  "params": {
    "detail": "toolsAndAuthOnly"
  }
}
~~~

Finish any active agent turn before reloading. A model turn already in
progress keeps the tools with which it started; use the refreshed MCP tools on
the following turn.

The App Server reload RPC is a client operation and is not exposed as a
callable tool in every Codex surface. When it is unavailable, use the desktop
app's MCP refresh/restart control. If that control is also unavailable, open
or fork a new task rooted in the already-configured worktree. The new task
will discover the project override during initialization.

Creating a worktree and its config from one running task does not move that
task into the new worktree. Adding the destination as another writable path is
also insufficient. The task root must be the intended worktree for its project
configuration to apply.

### Remediate several worktrees

A maintenance helper may enumerate the repository's existing Git worktrees,
render one `.codex/config.toml` for each valid worktree path, and then issue one
`config/mcpServer/reload` request so loaded tasks refresh. Skip stale or
deleted paths and preserve unrelated project config.

For one implementation across new and existing worktrees, extract the render
logic into a checked-in PowerShell helper that accepts explicit source-tree
and worktree paths. The local environment calls it with
`CODEX_SOURCE_TREE_PATH` and `CODEX_WORKTREE_PATH`; remediation calls the same
helper with the two known paths. The helper only renders configuration and
must not launch the MCP server.

## Worktree-local path arguments

Use the same `__CODEX_WORKTREE_PATH__` placeholder anywhere the MCP command
needs a path inside the new worktree. For example:

~~~text
  '--workbench-addon-dir', '__CODEX_WORKTREE_PATH__\path\to\first-addon-root',
  '--observer-evidence-root', '__CODEX_WORKTREE_PATH__\tmp\reviewed-evidence',
~~~

Leave paths outside the repository as ordinary absolute paths; the setup
should not rewrite them. For repeated PowerShell array parameters, prefer a
project-owned wrapper script that supplies actual PowerShell arrays rather
than relying on repeated values after `powershell.exe -File`.

## Start the Codex task

1. Configure the local environment on the source project.
2. Start a new Codex task and choose a new worktree for that project.
3. Confirm that setup reports the generated worktree `.codex/config.toml`.
4. Trust the project if Codex prompts for trust.
5. Inspect the connected MCP servers and confirm the `reforger-forge` tools are
   present.
6. Use `wb_diagnose` when host identity or lifecycle diagnosis is needed. The
   managed command line should contain the worktree launcher path and the
   `codex-worktree` client label.

The server remains an ordinary client-owned process. Its title, client label,
PID, and instance UUID are diagnostic identity, not authority to terminate or
take over that process. Refresh or stop it through the owning Codex surface.

## Optional side-by-side registration

For deliberate compatibility comparisons, change the project key in the
template:

~~~toml
[mcp_servers.reforger-forge-worktree]
~~~

That adds the worktree server alongside the inherited global server instead
of overriding it. The two servers expose similar tool sets under different MCP
names, which makes accidental routing easier. Do not ask both hosts to mutate
the same Workbench or owned runtime concurrently. Prefer the same-name override
for normal development.

## Troubleshooting

| Symptom | Check |
|---|---|
| Codex still uses the stable server | Confirm that the task root is the generated worktree, the project is trusted, and the rendered table uses the same `reforger-forge` key as the global entry. Inspect the rendered `-File` and `cwd` paths, then refresh MCP or start a new task. |
| Setup did not generate the config | Confirm the environment is attached to the source project, its Windows setup is selected, both Codex path variables are present, and `.codex/worktree-mcp.config.toml` exists in `CODEX_SOURCE_TREE_PATH`. |
| The rendered config still contains a placeholder | Confirm the placeholder is spelled exactly `__CODEX_WORKTREE_PATH__` and rerun the environment setup. |
| The current task cannot see the new tools | The setup prepared a different worktree task; it did not add tools to the task that created the files. Refresh MCP in the destination task or open a new task rooted there. |
| Two nearly identical tool sets appear | A differently named project entry was added alongside the global entry. Use the same `reforger-forge` key for a project override unless side-by-side comparison is intentional. |
| TOML reports an invalid Windows path | Keep generated paths in single-quoted TOML literal strings as shown and avoid a single quote in the worktree path. |
