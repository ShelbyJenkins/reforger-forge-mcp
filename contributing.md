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
6. Open a pull request

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
