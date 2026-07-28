# Outstanding MCP Issues

This FIFO queue contains open contract decisions, acknowledged limitations, and
deferred improvements that are not currently a broken supported behavior.
Append new findings at the bottom; move resolved or verified records to
[MCP_ISSUES_RESOLVED.md](MCP_ISSUES_RESOLVED.md).

### MCP-002 — a running stdio MCP does not reload a repaired local build

**Status:** Open

**Severity:** Non-breaking workflow limitation

**Observed:** 2026-07-28

Rebuilding `dist` does not update an already-running MCP server; the process
continues using the code and staged-file policy loaded at startup.

**Impact:** A host or client reconnect is required before a local source fix
affects the active stdio process.

**Workaround:** Restart the MCP host after rebuilding. In the observed session,
removing the exact stale generated `UserMaps.desc` from the external managed
helper cache allowed Workbench to launch before the restart.

### MCP-003 — evidence runs cannot span a Workbench lifecycle restart

**Status:** Open

**Severity:** Non-breaking, fail-closed workflow limitation

**Observed:** 2026-07-28

An evidence run containing captures from before a Workbench restart accepted
later captures but refused finalization with `STALE_LIFECYCLE`. Once stale,
`discard` also refused the run, leaving a fail-closed record for retention.

**Impact:** A mixed-lifecycle run cannot become durable evidence, and the
incompatibility is surfaced only at finalization.

**Workaround:** Begin a fresh run after the restart, recapture and review the
selected images, and finalize only the stable-lifecycle bundle.

### MCP-004 — material validation cannot resolve inherited stock dependencies

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

### MCP-007 — guarded TestContent build can terminate in a Workbench access violation

**Status:** Open

**Severity:** Breaking validation limitation

**Observed:** 2026-07-28

`wb_build` for `OnePointZeroOneTestContent.gproj` terminated with Windows exit
code `0xC0000005`, with no output tree or MCP `validationFailure`. A second
fresh-output retry reproduced the access violation, and its attributed addon
warning/error query returned no matches.

**Impact:** The MCP cannot distinguish this Workbench engine crash from a
successful or ordinary failed validation, so the visual fixture cannot be
certified through this build path.

**Evidence:** The managed build receipt recorded exact process ownership and
endpoint cleanup. Personal crash-report fields were intentionally not retained.

**Workaround:** Pending. Do not treat the failed build output as evidence; use
a fresh independent validation run only after the crash is understood or the
guarded build is stable.

## Deferred API-reference improvements

### MCP-027 — public MCP metadata is incomplete

**Status:** Deferred

**Priority:** P1

Registered tools provide descriptions and input schemas, but do not yet have
consistent titles, action-safe annotations, output schemas, or structured
output contracts. This does not contradict the current runtime API, but it
limits discoverability and machine validation.

**Next step:** Apply the incremental metadata work in the
[MCP API contract follow-up plan](../../docs/plans/2026-07-28-mcp-api-contract-follow-up.md).

### MCP-028 — runtime API reference and drift gate are not generated

**Status:** Deferred

**Priority:** P1

MCP-023 removed the obsolete README parser, but the MCP still has no generated,
checked-in reference for its tools, prompts, resources, and resource templates,
or a release check that detects their drift.

**Next step:** Generate those artifacts from a hermetic MCP discovery session
and verify them in CI as described in the
[MCP API contract follow-up plan](../../docs/plans/2026-07-28-mcp-api-contract-follow-up.md).

### MCP-031 — review the implemented `game_duplicate` contract

**Status:** Decision required

**Priority:** P0

**Related implementation records:** MCP-012 and MCP-013

The implementation now requires an already-running compatible Workbench when
`register=true`, disables Workbench auto-launch for registration, and restricts
both source and destination to `.et` prefabs. It describes later registration
of an existing offline copy through `wb_resources(action: "register")`.

**Review required:** Confirm the no-auto-launch behavior and decide whether
`.conf` duplication should remain unsupported or receive a tested
implementation. Also review extension validation, loose/extracted source-data
requirements, target-project identity, and `register=false`. Current recovery
guidance treats a copied-but-unregistered result as a recoverable partial
success: open the exact destination project and call
`wb_resources(action: "register")` with the existing copy's absolute path.
Registration takes a path and creates the `.meta` resource GUID; it does not
require a GUID as input. Re-running `game_duplicate` is not the retry path
because the tool refuses to overwrite the existing destination.
Do not treat MCP-012 or MCP-013 as product approval until this review is
complete.

### MCP-035 - decide whether exact-owned runtime profile logs are supporting evidence

**Status:** Open

**Priority:** P1

**Observed:** 2026-07-28

Observer created exclusive client profiles through `observer_prepare_launch`,
and their correlated `script.log` files were required by the validation
procedure. `observer_run finalize` refused those files because the prepared
profile directories were outside the configured `supportingLogRoots`, even
though the sessions and exact-owned processes were known to Observer.

**Decision required:** Decide whether finalization should automatically permit
logs beneath the exact prepared profile of a capture included in the same run,
or whether setup/launch guidance must require callers to preconfigure a common
profile-log root. The automatic option must remain fail-closed to unrelated
profiles and private files.

**Affected areas:** Observer supporting-file allowlists,
`observer_prepare_launch`, `observer_run finalize`, setup defaults, and
operator guidance.

**Evidence:** All captures finalized successfully, but the relevant logs had
to be copied beside each reviewed bundle afterward. Those copies are not
members of the MCP-generated manifest, so the manifest receipt covers the
captures and review files but not the correlated runtime log.

**Workaround:** Configure `--observer-supporting-log-root` for the intended
profile parent before launching the MCP, or copy the correlated logs into the
retained bundle after finalization and document that they are outside the
managed manifest.
