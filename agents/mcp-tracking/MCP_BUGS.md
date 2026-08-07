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

## MCP-055 — `observer_setup ensure` hides a reproducible staging failure

**Status:** Open

**Severity:** P2 — blocks the documented setup step without actionable evidence

**Observed:** 2026-08-06

**Observed behavior:** Two consecutive `observer_setup` calls with
`action: "ensure"` returned only `Observer error (INTERNAL_ERROR): Observer
operation failed.` In the same MCP process, both `observer_setup status` and
`observer_setup doctor` completed successfully. They reported a valid runtime
Observer source manifest, an installed Workbench companion, no stale captures,
and a healthy Workbench-companion status.

**Intended contract:** `ensure` should either complete idempotently when the
managed companions are already staged or return a bounded error code and the
specific failed staging/retention operation. It should not collapse a
reproducible supported operation into an opaque `INTERNAL_ERROR` while the
diagnostic actions report the managed state as healthy.

**Affected areas:** `observer_setup`, ensure/staging error translation,
external-retention application, private-child control API diagnostics.

**Evidence:** The repeated failures and the successful status/doctor receipts
were produced back-to-back in one stdio MCP process. The reported runtime
Observer build identity was
`000cec19226673ce911c68dca027dca7449ff58a604fe0cef6509afbc4d7ec22`.

## MCP-056 — runtime focus guard intermittently returns no protocol response

**Status:** Open

**Severity:** P2 — prevents otherwise valid exact-owned graphical launches

**Observed:** 2026-08-06

**Observed behavior:** `observer_runtime action: "start"` failed on two fresh
prepared listen-server launches with `SPAWN_FAILED`, reporting that the runtime
focus guard returned no protocol response. A byte-identical workflow on a
third fresh prepared launch succeeded between the two failures. Each failed
attempt removed the spawned game process and left no live lifecycle lease; a
retry of the consumed prepared launch correctly failed closed with
`START_UNVERIFIABLE` and `state: "release_acknowledged"`.

**Intended contract:** With `noFocus: true`, the focus guard should reliably
publish its bounded protocol result before the startup deadline. If the helper
itself cannot start, the receipt should preserve a concrete PowerShell/helper
failure reason rather than the generic absence of a response.

**Affected areas:** `observer_runtime`, owned-runtime startup focus protection,
`scripts/windows/runtime-focus-guard.ps1`, focus-guard protocol collection and
deadline handling.

**Evidence:** Both failures occurred during the same live MCP task on distinct
prepared launch IDs and distinct exclusive profiles. In both cases the tool
reported a target PID, the PID was vacant immediately after cleanup, and
Observer status showed no lifecycle pin or owned-runtime authority for the
failed session.

## MCP-057 — runtime capture supporting-log grant resolves to a non-file

**Status:** Open

**Severity:** P2 — prevents runtime script logs from being included in evidence bundles

**Observed:** 2026-08-06

**Observed behavior:** `observer_run_finalize` reproducibly returned
`INVALID_REQUEST: Supporting log is not a regular file` when
`supportingFiles` selected a completed exact-owned runtime capture through
`sourceCaptureLabel`. The failure occurred first for one capture in an earlier
run and again for both red and blue captures in a separate two-runtime run.
Each selected runtime had a regular `script.log` under its assigned
`<profilePath>\logs\observer-<sessionId>` directory, and each capture completed
without contamination or cleanup warnings.

**Intended contract:** A completed exact-owned runtime capture should mint a
grant for its assigned regular `script.log`, allowing
`supportingFiles.sourceCaptureLabel` to include that log without admitting an
arbitrary caller path. If the assigned log is unavailable, the error should
identify the resolved path and why it is unavailable.

**Affected areas:** runtime capture completion metadata, supporting-log grant
minting, assigned `-logsDir` path projection, evidence bundle finalization.

**Evidence:** The repeated failures used distinct Observer sessions, profiles,
jobs, and run records. Direct read-only inspection found each corresponding
regular `script.log`, while finalization without `supportingFiles` remained
available.

## MCP-058 — `api_search` cannot return the public `EmitterParam` enum

**Status:** Open

**Severity:** P2 — hides the supported runtime particle-parameter surface

**Observed:** 2026-08-06

**Observed behavior:** `api_search` with `query: "EmitterParam"`,
`source: "enfusion"`, and `type: "enum"` returned `No enums found matching
"EmitterParam"`. In the same MCP process, the same query with `type: "any"`
returned `Particles.SetParam`, `GetParam`, `GetParamOrig`, and `MultParam`, all
with `EmitterParam` in their public signatures. The generated Enfusion API and
the public Visual API documentation both expose the complete `EmitterParam`
enum.

**Intended contract:** Enum-filtered search should return generated public
enum-like types that are referenced by indexed API methods, including
`EmitterParam`, or explicitly report that the enum source was excluded rather
than returning a clean no-match result.

**Affected areas:** `api_search`, generated Enfusion enum ingestion, enum-like
type detection, API search indexing and type filtering.

**Evidence:** The enum-filtered no-match and the method-signature matches were
reproduced back-to-back. The official public Visual API lists `EmitterParam`
and its constants, while the MCP search only surfaced methods that consume it.
