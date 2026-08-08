# Outstanding MCP Bugs

This FIFO queue contains unintended, reproducible failures of the supported
MCP contract. Append new findings at the bottom; move resolved entries to
[MCP_BUGS_RESOLVED.md](MCP_BUGS_RESOLVED.md).

## MCP-058 - the Windows runtime focus guard can report protection it did not prove

**Status:** Fix implemented; opt-in live desktop acceptance pending

**Severity:** P1 - disruptive desktop focus behavior and possible mutation of an unrelated window

**Observed:** 2026-08-05

**Observed behavior:** The exact-owned graphical launch path advertises that its
default native-fullscreen launch does not steal startup focus, but the helper can
return `ok: true` after a fixed 15-second interval without observing any target
window. Protection also begins only after the target is spawned and a new
PowerShell process has parsed/JIT-compiled the helper; a fast window can activate
before any hook exists, and the helper discards the restore HWND if the target is
already foreground when protection starts. It does not reject failed
`SetWinEventHook`, `SetWindowLongPtr`, or
`SetWindowPos` calls, and success means only that the target PID does not own the
foreground at the final sample. A slow first window can therefore appear after
the helper exits and take focus. Its managed hook callback is not rooted for the
native hooks' lifetime, so garbage collection can also invalidate hook delivery
or raise at the interop boundary. The helper identifies windows only by PID,
so PID reuse during its lifetime can redirect style mutation/restoration to an
unrelated process. On each intercepted target activation, it attempts to restore
the foreground HWND captured at helper startup even if the user deliberately
switched to another application in the meantime.

**Expected contract:** Focus protection must be ready before the target can
activate, then either return bounded positive evidence that the relevant
startup-window interval was covered or fail closed.
Every native hook/style operation must be checked, window ownership must remain
bound to the exact process creation identity, and restoration must never force a
stale application over the user's newer foreground choice. The managed callback
must remain rooted until both native hooks have been removed.

**Affected areas:**
[`src/platform/windows/runtime-focus-guard.ts`](../../src/platform/windows/runtime-focus-guard.ts),
[`scripts/windows/runtime-focus-guard.ps1`](../../scripts/windows/runtime-focus-guard.ps1),
[`src/observer/owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts),
and the `game_launch` / `observer_runtime` `noFocus` contract.

**Evidence:** Static tracing found that hook-installation and style/position
mutation return values do not gate `ok`; `protectedWindowCount: 0` is accepted;
the local `WinEventProc` delegate is passed to two hooks without `GCHandle` or an
equivalent lifetime root; readiness can be awaited for another 60 seconds only
after the 15-second guard has returned; and existing tests cover routing/import
presence, not GC pressure, an immediate or delayed GUI, native-call failures, PID
reuse, or an `A -> B -> target` foreground sequence. This extends the failure
surface behind resolved MCP-036.

**Implementation progress (2026-08-06):** The guard is now a pre-spawn
transaction with nonzero checked hooks, a rooted callback, verified style
write/readback and rollback, exact retained process-generation identity, and a
positive observed-window requirement. It follows the user's latest inspectable
foreground choice, and observing a newer but uninspectable protected/elevated
foreground invalidates older restoration authority instead of restoring a stale
window. The focused guard and spawn-publication suites pass 16/16. The opt-in
real-GUI fixtures for immediate and post-15-second replacement windows, GC
pressure, and injected native failures have not yet been run on the attended
desktop, so this bug remains open rather than being moved to resolved history.
Headless native-ledger scenarios now also prove `A -> B -> target` chooses B,
destroyed choices lose restoration authority even across numeric HWND reuse,
and a matching PID with a stale retained process generation cannot authorize
window mutation. Actual USER32 ordering and OS-level HWND/PID recycling remain
part of the attended gate.

## MCP-072 — `observer_setup ensure` hides a reproducible staging failure

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

## MCP-073 — runtime focus guard intermittently returns no protocol response

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

## MCP-074 — runtime capture supporting-log grant resolves to a non-file

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

## MCP-075 — `api_search` cannot return the public `EmitterParam` enum

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
