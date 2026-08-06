# Outstanding MCP Bugs

This FIFO queue contains unintended, reproducible failures of the supported
MCP contract. Append new findings at the bottom; move resolved entries to
[MCP_BUGS_RESOLVED.md](MCP_BUGS_RESOLVED.md).

## MCP-057 - existing-only Workbench LMDB inspection can crash a fresh host

**Status:** Open

**Severity:** P1 - native host termination during a supported read-only idle probe

**Observed:** 2026-08-05

**Observed behavior:** While another MCP/Workbench lifecycle had the shared
Workbench v3 LMDB environment mapped, a fresh production process calling
`WorkbenchProcessGuard.readLifecycleStateExistingOnly()` terminated with Windows
exception `0xC0000005` before the read returned. The full host idle-readiness
probe failed the same way. A production MCP host otherwise completed MCP-056
history/recovery with no blockers, committed idle shutdown at 60.02 seconds, and
then exited with that native status because the immediately preceding aggregate
readiness probe had opened the shared Workbench environment. The lifecycle and
spawn-journal reads are now serialized, eliminating same-process concurrent
opens, but a single temporary read-only open against the already-mapped live
environment remains sufficient to reproduce the exception.

**Expected contract:** Existing-only Workbench inspection must remain bounded,
noncreating, logically read-only, and fail closed on malformed, legacy,
unreadable, or racing evidence. It must return `INCOMPLETE_PROOF` or a stable
Workbench blocker instead of terminating the MCP process, and it must not
require stopping, restarting, or otherwise disturbing the active Workbench or
its owning MCP host.

**Affected areas:**
[`src/foundation/lmdb-store.ts`](../../src/foundation/lmdb-store.ts),
[`src/workbench/process-guard.ts`](../../src/workbench/process-guard.ts),
[`src/workbench/session-controller.ts`](../../src/workbench/session-controller.ts),
and aggregate MCP idle readiness on Windows.

**Evidence:** The direct existing-only process printed its pre-read marker and
then exited natively before producing a lifecycle result. A byte-exact-snapshot
MCP-056 acceptance with isolated Workbench state classified the retained
Observer snapshot, started and closed its disposable private Observer child,
committed the 60-second idle shutdown, and exited with code 0. No Workbench
process was launched, stopped, restarted, or claimed during this diagnosis.
