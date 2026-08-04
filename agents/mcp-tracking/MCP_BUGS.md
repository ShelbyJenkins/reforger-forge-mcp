# Outstanding MCP Bugs

This FIFO queue contains unintended, reproducible failures of the supported
MCP contract. Append new findings at the bottom; move resolved entries to
[MCP_BUGS_RESOLVED.md](MCP_BUGS_RESOLVED.md).

## MCP-054 — `wb_log_query` misses error-level editor diagnostics

**Status:** Open

**Severity:** P2 — hides relevant diagnostics and forces raw-log fallback

**Observed:** 2026-08-04

**Observed behavior:** In a live exact-owned Workbench editor session,
`wb_log_query` was called for the session's exact attributed log directory with
`levels: ["E"]` and `maxLines: 300`. It reported `fileCount: 3`,
`matchCount: 0`, and no matches. The same directory's raw `error.log` contained
29 error-level records, including ordinary `SCRIPT (E)` records and
`PATHFINDING(E)` records. A target-addon warning query also returned no matches
despite target-relevant diagnostics being present in the same log set.

**Intended contract:** Severity filtering should recognize supported Workbench
log spellings across the attributed `console.log`, `error.log`, and
`script.log` inputs, or the tool should explicitly report any excluded file or
unrecognized record formats instead of returning a clean zero-match result.

**Affected areas:** `wb_log_query`, `src/tools/wb-log-query.ts`, Workbench
editor-log parsing and severity normalization.

**Evidence:** The zero-match MCP receipt and raw-log comparison were obtained
against the same exact owner-attributed directory in one running lifecycle.
Representative missed spellings were `SCRIPT    (E):` and `PATHFINDING(E):`.
