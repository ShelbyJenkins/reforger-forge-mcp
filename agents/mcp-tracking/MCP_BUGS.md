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
