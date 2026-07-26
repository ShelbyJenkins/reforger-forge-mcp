# ReforgerForge Setup

The [main README](README.md#quick-start) contains the shortest path from a
fresh clone to a working installation. This guide explains what that command
does, how to verify the installation, and how to opt into nonstandard paths or
settings.

For registration locations, manual commands, and refresh steps unique to each
MCP client, see [MCP client notes](agents/README.md).

## Requirements

- Windows
- Node.js 20 or newer
- Arma Reforger from Steam for game-asset browsing
- Arma Reforger Tools from Steam for resource registration and reviewed live
  Workbench control

Run commands from the ReforgerForge repository root.

## Default setup

Normal onboarding uses the parameterless setup command:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

Setup installs dependencies, builds the server, verifies config-free startup
and tool registration, detects every supported MCP client available to the
current user, and attempts the standard registration in each detected client.
It does not:

- create a ReforgerForge config file;
- require or infer a project path;
- ask which clients to update;
- add `--config` or `--project-path` to standard registrations;
- guess a package or mod workspace; or
- launch Workbench or the game.

Normal server startup discovers Arma Reforger, Arma Reforger Tools, the
base-game add-on directory from the user's Steam libraries, and (when it
exists) the standard Workshop add-on directory.

The supported automatic clients are Codex, Cursor, Google Antigravity, Claude
Desktop, Claude Code, Windsurf, VS Code, Continue.dev, and Kiro. Setup attempts
one user/global registration for each detected client. See
[MCP client notes](agents/README.md) for the exact target and behavior of each
client.

Every standard registration runs:

```text
node <absolute-package-path>\dist\index.js
```

Rerunning setup is supported. An exact existing registration is reported as
already current without a material rewrite.

## Safe registration and completion receipts

The completion receipt includes every supported client, including clients that
were not detected or could not be updated. One client failure does not stop
the remaining registration attempts.

Setup uses these exit codes:

| Exit code | Meaning |
|-----------|---------|
| `0` | Core setup and all detected-client registrations succeeded |
| `1` | Core setup failed before client configuration was changed |
| `2` | The server was installed and verified, but at least one client detection, registration, or safe migration needs manual attention |

Existing JSON and current-format Continue YAML documents are merged rather
than replaced wholesale. Setup parses and validates the existing document,
preserves unrelated settings and servers, validates the proposed result,
writes through a same-directory temporary file, and retains a timestamped
backup before materially replacing an existing file.

Malformed, structurally unsafe, non-regular, or symbolic-link-backed targets
are not replaced. An undetected client receives no file or directory, while a
failed evidence check is reported separately as `detection failed`.

Some clients own their registration storage behind a client CLI. Their
successful updates are listed as CLI-managed changes with user scope rather
than being reported as direct file edits. Client-specific details are in
[MCP client notes](agents/README.md).

A successful registration level proves only that the configured entry was
written or already current. It does not prove that the client restarted or
loaded the server. Restart or refresh the client and confirm that the
`reforger-forge` tools are available.

## Doctor and structured output

Inspect the built installation without installing dependencies, rebuilding,
or changing client registrations:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Doctor
```

Doctor reports these levels separately:

- Steam discovery;
- effective settings;
- compiled-server version and MCP handshake;
- tool registration;
- read-only client-registration status;
- Workbench NET API; and
- observer capture.

No explicit config or project is required. Their receipt fields may validly
report automatic defaults and project-independent mode. Normal setup and
default Doctor report Workbench NET API and observer capture as `not tested`;
neither command performs an observer capture.

To test an already-running Workbench, add `-CheckWorkbench`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Doctor -CheckWorkbench
```

This performs exactly one read-only `EMCP_WB_Ping` against the resolved
Workbench endpoint. It never launches or terminates Workbench or the game.

Use `-Json` with normal setup or Doctor to emit the canonical receipt as one
JSON document on stdout. Operational messages remain on stderr:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Doctor -Json
```

You can also verify compiled MCP startup and all required tool registrations
directly:

```powershell
npm run mcp:verify
npm run mcp:verify -- --config C:\path\to\overrides.json
```

The second form is only for an explicitly selected override file.

## PowerShell execution policy

The setup and Doctor examples above use a process-local bypass so they work
when local PowerShell policy blocks direct `.ps1` execution:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

This does not permanently change the user's execution policy.

## Starting the server directly

Normal startup needs no config file:

```powershell
node dist/index.js
```

The MCP client normally starts this process through its registration. Running
it directly is primarily useful for diagnostics or development.

## Steam discovery

ReforgerForge discovers Steam through the Windows registry, running Steam
process metadata, configured `libraryfolders.vdf` entries, and app manifests:

- `1874880` — Arma Reforger
- `1874910` — Arma Reforger Tools

Inspect the result without starting the MCP transport:

```powershell
node dist/index.js discover-steam
```

Explicit `workbenchPath` and `gamePath` values are fallbacks or overrides for
nonstandard installations; they are not normally required.

## Add-on root discovery

Workbench needs an add-on root for the base game and for every local or
Workshop dependency used by the target project. ReforgerForge automatically
uses the discovered base-game add-on root and, when it exists, the standard
Workshop root beneath Documents. If `workbenchAddonDirs` or repeated
`--workbench-addon-dir` values add one or more explicit roots, the automatic
roots are prepended unless already present. This means a launcher normally adds
only nonstandard or repository-specific roots.

`--no-workbench-addon-dirs` is the explicit exception: it leaves the effective
root list empty and suppresses automatic injection. Use it only when that is
intentional.

To see how a target's declared dependency GUIDs resolve without starting
Workbench or changing configuration, run:

```powershell
node dist/index.js check-addon-dirs --gproj C:\path\to\Addon\Addon.gproj
```

The report identifies dependencies resolved by the base-game, standard
Workshop, and target-sibling add-on candidates, then lists missing and
ambiguous GUIDs separately. It is diagnostic only.

## Optional project path

`projectPath` is optional. Supply it when project-scoped tools should discover
or create addons beneath an explicit addons-container directory:

```powershell
node dist/index.js --project-path "C:\path\to\arma-projects\addons"
```

Without `projectPath`, project-independent tools remain available. An
operation that needs an implicit addons container returns
`PROJECT_PATH_REQUIRED`; a tool that accepts a complete explicit target can
continue to use that target.

When a project path exists, the default finalized observer-evidence location
is `<projectPath>\.reforger-forge-screenshots`. It is allowlisted without being
created during startup and is created only when finalization first needs it.

## Optional configuration

The config file is an explicit override surface, not a setup requirement.
Settings omitted from it continue to use automatic discovery and internal
defaults. ReforgerForge does not search the package directory or user home for
a config file and does not read environment variables for server
configuration.

An optional JSON file may contain any subset of supported settings. It is
loaded only when explicitly selected:

```powershell
node dist/index.js --config C:\path\to\overrides.json
```

Its complete precedence is:

```text
safe internal constants < automatic Steam discovery < explicit --config file < explicit CLI flags
```

Relative paths in the JSON file resolve from that file's directory. Relative
CLI paths resolve from the MCP process working directory. `projectPath` is
never inferred from that working directory.

### CLI override behavior

CLI flags can make small per-client adjustments to a shared file. Repeated
`--workbench-addon-dir`, `--observer-evidence-root`, and
`--observer-supporting-log-root` flags replace their corresponding explicit
arrays in the file while preserving command-line order. A nonempty effective
`workbenchAddonDirs` array then receives the automatic base-game and standard
Workshop roots described above.

Boolean settings use paired flags such as `--debug` / `--no-debug` and
`--workbench-script-authorize-all` /
`--no-workbench-script-authorize-all`.

Use `--no-workbench-addon-dirs`, `--no-observer-evidence-roots`, or
`--no-observer-supporting-log-roots` when the CLI must explicitly replace an
array with `[]`. A clear flag cannot be combined with its repeated value flag.

### Settings reference

| JSON setting | CLI flag | Default or requirement |
|--------------|----------|------------------------|
| `workbenchPath` | `--workbench-path` | Discovered Tools installation; explicit fallback or override |
| `gamePath` | `--game-path` | Discovered game installation; explicit fallback or override |
| `projectPath` | `--project-path` | Optional existing addons-container directory |
| `workbenchAddonDirs` | repeat `--workbench-addon-dir` | Discovered base-game root plus standard Workshop root when present; nonempty explicit arrays are additive, while `--no-workbench-addon-dirs` is an explicit empty opt-out |
| `extractedPath` | `--extracted-path` | Optional existing directory |
| `workbenchHost` | `--workbench-host` | `127.0.0.1` |
| `workbenchPort` | `--workbench-port` | `5775` |
| `workbenchScriptAuthorizeAll` | paired authorize flags above | `false` |
| `defaultMod` | `--default-mod` | none |
| `debug` | `--debug` / `--no-debug` | `false` |
| `observer.managedRoot` | `--observer-managed-root` | Platform-local application/state directory |
| `observer.profileRoot` | `--observer-profile-root` | `<managed root>/profiles` |
| `observer.agentPath` | `--observer-agent-path` | Packaged private child, or an existing regular file |
| `observer.evidenceRoots` | repeat `--observer-evidence-root` | `<projectPath>\.reforger-forge-screenshots` when a project path exists; otherwise finalization needs an explicit root |
| `observer.supportingLogRoots` | repeat `--observer-supporting-log-root` | Existing directories; defaults to the managed observer log root |
| `observer.startupTimeoutMs` | `--observer-startup-timeout-ms` | `10000` |
| `observer.requestTimeoutMs` | `--observer-request-timeout-ms` | `30000` |
| `observer.defaultCaptureTimeoutMs` | `--observer-capture-timeout-ms` | `30000` |
| `observer.maxInlineImageBytes` | `--observer-max-inline-image-bytes` | `8388608` |
| `observer.retentionIntervalMs` | `--observer-retention-interval-ms` | `60000` |
| `observer.retentionMaxAgeMs` | `--observer-retention-max-age-ms` | `604800000` |
| `observer.retentionMaxBytes` | `--observer-retention-max-bytes` | `536870912` |
| `observer.sessionTtlMs` | `--observer-session-ttl-ms` | `1200000` |

`workbenchScriptAuthorizeAll` suppresses prompts for protected `RunCmd`,
`RunProcess`, `KillProcess`, and out-of-profile `FileIO` operations. Leave it
disabled unless you trust the active project and all of its dependencies.

Automated Workbench launches enforce `-noThrow`. Assertions remain in the
Workbench log and can still fail a validation gate, but they cannot block an
agent behind a dialog that requires a person to dismiss it.

### Path validation

Startup fails when:

- Steam cannot resolve a unique valid required installation and no explicit
  fallback is supplied;
- a configured path is invalid;
- the strict JSON shape is invalid;
- required installation and project roots overlap;
- an observer managed/profile root overlaps the project or either
  installation; or
- a Workbench addon root contains a comma, because `-addonsDir` is
  comma-delimited.

`workbenchPath` must contain `ArmaReforgerWorkbenchSteamDiag.exe` either at its
root or under `Workbench`. `gamePath` must contain `addons` and one of:

- `ArmaReforgerSteamDiag.exe`
- `ArmaReforgerDiag.exe`
- `ArmaReforgerSteam.exe`
- `ArmaReforger.exe`

Observer managed/profile roots may have a missing tail, but their nearest
existing ancestor must be a directory. Obsolete or unknown settings, including
`workbenchNoThrow`, are rejected; automated launches always enforce
`-noThrow`.

Restart the MCP server after changing an explicitly selected config file. You
do not need to rerun an installer unless the registered config-file path itself
changes.

## Registering an explicit override

`setup.ps1` intentionally does not accept a config path. Create an override
only for nonstandard paths or settings, then register that explicit file.
The manual installer's targets differ from parameterless setup for some
clients; review the [client-specific notes](agents/README.md) before using
`-All`.

```powershell
Copy-Item .\reforger-forge.config.example.json .\reforger-forge.config.json
# Remove settings that should continue using discovery/defaults, then:
$ConfigPath = (Resolve-Path .\reforger-forge.config.json).Path

.\agents\install-agents.ps1 -ConfigPath $ConfigPath -All
# Or target one client supported by the manual installer:
.\agents\install-agents.ps1 -ConfigPath $ConfigPath -Agent codex
```

The manual installer supports `codex`, `cursor`, `antigravity`, `claude`
(Claude Desktop), `windsurf`, `vscode`, `continue`, and `kiro`. Unlike
`setup.ps1`, it verifies and registers the supplied
`--config <absolute-path>`.

For Claude Code or another client not covered by the manual installer, use the
client-specific registration surface and add `--config <absolute-path>` after
the server path. See [MCP client notes](agents/README.md).

Do not commit a machine-local override containing personal paths.

## Workspace instructions for coding agents

Copy [the starter `AGENTS.md`](agents/AGENTS.md) into the root of a modding
workspace and replace its placeholders. It gives coding agents a practical
startup checklist, MCP tool-routing guide, Workbench workflow, resource-safety
rules, validation steps, and troubleshooting reference.

Do not overwrite an existing workspace's instructions without reviewing and
merging its project-specific rules.
