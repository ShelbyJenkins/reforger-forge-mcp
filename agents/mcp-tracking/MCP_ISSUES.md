# Outstanding MCP Issues

This FIFO queue contains open contract decisions, acknowledged limitations, and
deferred improvements that are not currently a broken supported behavior.
Append new findings at the bottom; move resolved or verified records to
[MCP_ISSUES_RESOLVED.md](MCP_ISSUES_RESOLVED.md).

## MCP-056 - reconcile child-exit-only owned-runtime history within bounded lifecycle probes

**Status:** Open

**Priority:** P1

**Observed:** 2026-08-05

**Observed behavior:** A silent production MCP host using the established
default Observer root remained alive after its configured 60-second idle period
because readiness returned `INCOMPLETE_PROOF`. On ordinary stdin-close cleanup,
owned-runtime shutdown sealing exceeded its aggregate wall-clock deadline and
reported that 42 runtimes were not inspected. Read-only inventory found 754
retained records representing 81 runtimes: 41 had complete stop evidence and 40
had an exact child-exit receipt but no stop receipt, stop completion, or
restoration proof. All 40 unresolved records referred to an observed child exit;
36 were older than 24 hours and they spanned 14 historical manager instances.

**Expected contract or decision:** Preserve the current fail-closed rule, but
define a supported, bounded way to classify and reconcile process-absent
child-exit-only histories without deleting the LMDB store or treating age as
authority. Readiness and shutdown diagnostics should either complete within
their aggregate budgets or identify a stable bounded blocker category; an
explicit recovery path must write the semantic stop/restoration evidence needed
to make a record nonblocking and must retain exact ownership, process-vacancy,
session, profile, and restoration fencing.

**Affected areas:**
[`src/observer/owned-runtime-manager.ts`](../../src/observer/owned-runtime-manager.ts),
[`src/mcp-idle-readiness.ts`](../../src/mcp-idle-readiness.ts), owned-runtime
existing-only LMDB inventory, application shutdown sealing, and the focused
[owned-runtime readiness tests](../../tests/observer/owned-runtime-manager-idle-readiness.test.ts).
The live result and its relationship to Commits 14 and 15 are summarized in the
[series status table](../../docs/plans/2026-08-04-launch-ergonomics-00-series-overview.md).

**Evidence:** The same built production composition exited cleanly after 60.4
seconds with an isolated empty Observer root, proving the inactivity actor and
safe-path disposer were operational. Only the retained default-root lifecycle
inventory changed the outcome. Both harness processes were terminated, the live
Workbench was shut down through exact ownership, and the NET API port was vacant
after validation. No lifecycle record or Observer store was mutated during the
inventory investigation.
