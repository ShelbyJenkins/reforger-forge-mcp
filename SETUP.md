# ReforgerForge Setup

The [main README](README.md#quick-start) contains the shortest path from a
fresh clone to a working installation. This guide explains what that command
does, how to verify the installation, and how to opt into nonstandard paths or
settings.

For registration locations, manual commands, and refresh steps unique to each
MCP client, see [MCP client notes](agents/README.md).

## Requirements

- Windows
- Node.js 24 LTS or newer
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
- add `--config` or other override flags to standard registrations;
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

No explicit config or project is required. The receipt reports the effective
automatic and explicit settings. Normal setup and default Doctor report
Workbench NET API and observer capture as `not tested`; neither command
performs an observer capture.

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

## Observer first use and recovery

Observer is optional. Normal setup and the setup-script Doctor do not stage an
Observer companion, start Workbench or the game, or take a capture.

Before a first capture, use the live MCP tool `observer_setup` with
`action: "doctor"` to inspect the Observer configuration and staging state.
It is inspection-only. When its result is healthy, use
`observer_setup` with `action: "ensure"` to stage the required companions, then
follow the [Observer usage guide](docs/observer.md) for beginning a run,
selecting a renderer, capturing, reviewing, and finishing it.

An evidence root is required only to finalize a reviewed run. Beginning a run,
inspecting a runtime, and taking or discarding captures do not require one.
Configure `observer.evidenceRoots` or pass `--observer-evidence-root` before
finalizing.

After changing an explicit Observer setting, restart the MCP process and rerun
`observer_setup` with `action: "doctor"`. For a capture-workflow issue, use
the [Observer usage guide](docs/observer.md); for implementation and technical
troubleshooting, use [observer/README.md](observer/README.md).

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

## Add-on targeting

Addon-scoped tools identify one exact project through a `gprojPath` input.
When a supported tool omits that input, it may use the verified target of the
currently running Workbench lifecycle. Otherwise, mutations return
`ADDON_TARGET_REQUIRED`; preview-capable generators may return content without
writing.

The server does not scan an addons container to choose a target, and
`projectPath`, `defaultMod`, `modName` targeting, `--project-path`, and
`--default-mod` are not configuration surfaces. Keep the exact `.gproj` path
returned when creating a mod and pass it to later operations or launch it with
`wb_launch`.

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
CLI paths resolve from the MCP process working directory.

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
| `workbenchAddonDirs` | repeat `--workbench-addon-dir` | Discovered base-game root plus standard Workshop root when present; nonempty explicit arrays are additive, while `--no-workbench-addon-dirs` is an explicit empty opt-out |
| `extractedPath` | `--extracted-path` | Optional existing directory |
| `workbenchHost` | `--workbench-host` | `127.0.0.1` |
| `workbenchPort` | `--workbench-port` | `5775` |
| `workbenchScriptAuthorizeAll` | paired authorize flags above | `false` |
| `debug` | `--debug` / `--no-debug` | `false` |
| `observer.managedRoot` | `--observer-managed-root` | Platform-local application/state directory |
| `observer.profileRoot` | `--observer-profile-root` | `<managed root>/profiles` |
| `observer.agentPath` | `--observer-agent-path` | Packaged private child, or an existing regular file |
| `observer.evidenceRoots` | repeat `--observer-evidence-root` | Explicit allowlisted finalization roots; finalization requires at least one |
| `observer.supportingLogRoots` | repeat `--observer-supporting-log-root` | Existing directories for explicit-path logs; defaults to the managed observer log root. Exact-owned runtime `script.log` admission uses a private capture grant and does not require or widen this allowlist. |
| `observer.startupTimeoutMs` | `--observer-startup-timeout-ms` | `10000` |
| `observer.requestTimeoutMs` | `--observer-request-timeout-ms` | `30000` |
| `observer.defaultCaptureTimeoutMs` | `--observer-capture-timeout-ms` | `30000` |
| `observer.maxInlineImageBytes` | `--observer-max-inline-image-bytes` | `8388608` |
| `observer.defaultLossyImageQuality` | `--observer-default-lossy-image-quality` | `75` |
| `observer.minimumLossyImageQuality` | `--observer-minimum-lossy-image-quality` | `1` |
| `observer.maximumLossyImageQuality` | `--observer-maximum-lossy-image-quality` | `100` |
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

A fresh `wb_launch` and every `wb_restart` leave Workbench's normal, focusable
attended window policy in place. Reusing an existing session does not change
its current window state. The internal minimize-without-activation policy is
not the generic MCP editor default; when explicitly selected by a low-level
automation plan, each newly discovered top-level window is minimized at most
once, so restoring that same window is not undone repeatedly.

For a fast Enforce Script compilation preflight while the MCP owns the
lifecycle, call `wb_check` with an exact absolute `gprojPath`, a configuration
declared by that project (default `PC`), and a bounded timeout. The operation
starts a hidden, helper-free Workbench, returns only after exact-child cleanup
and endpoint vacancy, and does not run `-buildData` or create a caller-selected
build-output tree. Workbench can still refresh the target's ordinary ignored
`resourceDatabase.rdb` project cache during `.gproj` initialization. A
successful receipt means only that Enforce Scripts compiled; it does not validate resources,
materials, prefabs, worlds, packaging, or the whole add-on. `mod` with
`action: "validate"` remains a separate static check.

On Workbench 1.7.0.54, a valid `PC` check remained fully headless. An
intentionally broken script briefly exposed Workbench's small native Qt
failure window despite `-wbsilent -noThrow`; the guarded receipt and exact log
still classified that normal native `-1` compiler result without requiring
interaction.

When no MCP server owns the Workbench lifecycle, the packaged equivalent is:

```powershell
reforger-forge-workbench check --gproj C:\path\to\Addon\Addon.gproj --configuration PC --timeout-ms 120000
```

See [the runner CLI reference](docs/runner-cli.md) for the JSON receipt and
portable exit-code contract.

Use `wb_log_query` with the `logDirectory` returned by `wb_build` to inspect
only relevant managed Workbench log lines. It requires one or more addon,
severity, channel, or case-insensitive text filters and never returns an
unfiltered raw log dump.

### Path validation

Startup fails when:

- Steam cannot resolve a unique valid required installation and no explicit
  fallback is supplied;
- a configured path is invalid;
- the strict JSON shape is invalid;
- required installation roots overlap;
- an observer managed/profile root overlaps either installation; or
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
