# Contributing to ReforgerForge MCP

Thanks for helping improve ReforgerForge MCP!

## Setup

Use the parameterless quick start:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

See [SETUP.md](SETUP.md) for installation, verification, and optional
configuration. See [MCP client notes](agents/README.md) for behavior specific
to each supported client.

## Making Changes

1. Create a branch: `git checkout -b feature/your-feature`
2. Make your changes in `src/`
3. Run tests: `npm test`
4. Build: `npm run build`
5. Verify the MCP server: `npm run mcp:verify` (add `-- --config <path>` only
   when testing an explicit override)
6. Refresh the MCP server in the AI client, or restart the client, before
   testing the rebuilt code through that client
7. Open a pull request

`npm test` runs the complete suite without file-level parallelism. Several
lifecycle tests exercise shared Windows process, mutex, and endpoint state, so
the default command intentionally matches the serial acceptance run. The real
multi-process lifecycle handoff test also requires that no unowned Workbench
process is running; when Workbench is already open, the test records an explicit
`UNOWNED_WORKBENCH` precondition skip instead of reporting a lifecycle failure.

An already-running stdio MCP process does not reload files changed by
`npm run build`. The verification command starts a separate fresh process; it
does not update the server already connected to an AI client. `wb_restart`
restarts only an MCP-owned Workbench process, not the MCP server.

For Observer architecture, maintainer validation, and technical
troubleshooting, see [observer/README.md](observer/README.md).

## Code Style

- TypeScript strict mode
- Match existing patterns in `src/tools/`
- Logger writes to **stderr only** (stdio MCP transport requirement)
- No `console.log` in server code

## Reporting Issues

Open an issue at https://github.com/wastelandgoats/reforger-forge-mcp/issues with:

- Your agent (Cursor, Claude, etc.)
- Node.js version
- Error message or unexpected behavior
- Steps to reproduce

## Upstream

This project is forked from [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK). When fixing bugs that exist upstream, consider contributing back.

## License

By contributing, you agree your contributions are licensed under the MIT License.
