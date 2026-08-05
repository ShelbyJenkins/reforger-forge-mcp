# ReforgerForge MCP

ReforgerForge MCP is a local MCP server for AI-assisted Arma Reforger modding.
It gives compatible coding clients a safer way to research Enfusion, work with
game and project assets, generate mod content, and use Arma Reforger Workbench.

## Features

- Search the bundled Enfusion API, modding guidance, and implementation patterns.
- Browse game assets, inspect projects, and create scripts, prefabs, layouts, and scenarios.
- Control Workbench for guarded editor, Enforce Script compile-check, and build workflows.
- Capture reviewable runtime or Workbench PNG evidence with Observer.
- Use the same local server from supported MCP clients and coding tools.

## Quick start

Windows and Node.js 24 LTS or newer are required. From a fresh clone, run:

```powershell
git clone https://github.com/wastelandgoats/reforger-forge-mcp.git
cd reforger-forge-mcp
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

The setup script installs, builds, verifies, and attempts registration in each
detected supported MCP client. Restart or refresh the client afterwards, then
confirm that its `reforger-forge` tools are available.

Managed registrations identify the owning client in the Node command line, for
example `ReforgerForge-MCP-codex`. In Windows Task Manager, enable the
**Command line** column on the **Details** tab to distinguish MCP hosts. The
ordinary package still runs as `node.exe`; its Image name is not renamed. Use
the supported client refresh or shutdown workflow instead of terminating a
process by its label, PID, or displayed instance UUID.

## Use it from your MCP client

Ask the connected coding tool for the task you want to perform, for example:

```text
Find a vehicle-damage component and show its inherited methods.
Create a HUD widget that displays player health and stamina.
Open my addon in Workbench and inspect the selected entity.
Prepare a reviewed Observer capture of the current runtime view.
```

The live tool descriptions and input schemas that your MCP client receives are
the authoritative API contract. For tool routing, call order, safety rules, and
validation expectations for coding tools, use [agents/AGENTS.md](agents/AGENTS.md).

## Common configuration

Configuration is optional; automatic discovery is used when no override is
selected. These are the most common overrides. The complete setting and flag
reference is in [SETUP.md](SETUP.md#optional-configuration).

| Setting or flag | Purpose |
|---|---|
| `--config <path>` | Load one explicitly selected JSON override file. |
| Tool input `gprojPath` | Select the exact addon for writes; when omitted, supported tools use the verified project in the running Workbench lifecycle. |
| `workbenchPath`, `gamePath` / `--workbench-path`, `--game-path` | Override automatic Steam discovery for a nonstandard installation. |
| `workbenchAddonDirs` / repeat `--workbench-addon-dir` | Add nonstandard dependency roots while retaining normal discovered roots. |
| `mcpIdleShutdownMs` / `--mcp-idle-shutdown-ms` | Set safe stdio-host inactivity shutdown from 60000 through 86400000 ms; the default is 1800000 ms (30 minutes). |
| `observer.evidenceRoots` / repeat `--observer-evidence-root` | Allowlist where reviewed Observer evidence may be finalized. |
| `debug` / `--debug` | Enable diagnostic logging for the explicitly configured server process. |

The CLI stdio host exits after the configured interval only when protocol work
has settled and its bounded Workbench/Observer readiness proof is complete.
Live, busy, foreign, malformed, or uncertain lifecycle evidence keeps that host
open. Client disconnect, stdin close, and process signals still begin shutdown
immediately; the inactivity interval has no disable value.

## Documentation

| Guide | Use it for |
|---|---|
| [SETUP.md](SETUP.md) | Initial installation, configuration, Doctor, discovery, and recovery. |
| [agents/README.md](agents/README.md) | MCP-client registration, refresh, and client-specific troubleshooting. |
| [agents/AGENTS.md](agents/AGENTS.md) | API/workflow notes for coding tools using the MCP. |
| [docs/observer.md](docs/observer.md) | Operator-facing Observer capture and evidence workflow. |
| [observer/README.md](observer/README.md) | Observer architecture, maintainer guidance, and technical troubleshooting. |
| [docs/runner-cli.md](docs/runner-cli.md) | Standalone Workbench runner invocation and receipt contract. |
| [contributing.md](contributing.md) | Source changes, checks, and contribution expectations. |

## Attribution and license

ReforgerForge MCP is based on
[steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK), which
is based on [Articulated7/enfusion-mcp](https://github.com/Articulated7/enfusion-mcp).
It is distributed under the [MIT License](LICENSE).
