# Outstanding MCP Issues

This FIFO queue contains open contract decisions, acknowledged limitations, and
deferred improvements that are not currently a broken supported behavior.
Append new findings at the bottom; move resolved or verified records to
[MCP_ISSUES_RESOLVED.md](MCP_ISSUES_RESOLVED.md).

### MCP-004 â€” material validation cannot resolve inherited stock dependencies

**Status:** Open

**Severity:** Non-breaking validation limitation

**Observed:** 2026-07-28

`wb_validate(action: "material")` reported fatal missing metafiles for stock
S105 dependencies in both newly added Sedan Red wrappers and a pre-existing,
known-good Sedan Blue wrapper.

**Impact:** The result cannot distinguish a wrapper-specific defect from
missing base-game dependency metadata in the current project context.

**Workaround:** Treat the result as an environmental validator limitation,
verify the property assignment and explicit save in Workbench, and retain a
visual Workbench review as the presentation check.

## Deferred API-reference improvements

### MCP-027 â€” public MCP metadata is incomplete

**Status:** Deferred

**Priority:** P1

Registered tools provide descriptions and input schemas, but do not yet have
consistent titles, action-safe annotations, output schemas, or structured
output contracts. This does not contradict the current runtime API, but it
limits discoverability and machine validation.

**Next step:** Apply the incremental metadata work in the
[MCP API contract follow-up plan](../../docs/plans/2026-07-28-mcp-api-contract-follow-up.md).

### MCP-028 â€” runtime API reference and drift gate are not generated

**Status:** Deferred

**Priority:** P1

MCP-023 removed the obsolete README parser, but the MCP still has no generated,
checked-in reference for its tools, prompts, resources, and resource templates,
or a release check that detects their drift.

**Next step:** Generate those artifacts from a hermetic MCP discovery session
and verify them in CI as described in the
[MCP API contract follow-up plan](../../docs/plans/2026-07-28-mcp-api-contract-follow-up.md).
