# Resolved MCP Bugs

This is the reverse-chronological closed history for fixed MCP defects. Move
newly resolved bugs to the top. The legacy records below were migrated from the
mixed tracker on 2026-07-28; same-day ties retain their migration order.

## Resolved defects

### MCP-009 — TestContent MCP launch omitted the Core dependency root

**Status:** Resolved

**Closed:** 2026-07-28

**Observed behavior:** A target-bound TestContent launch was refused because
Workbench could not resolve the declared Core dependency GUID
`E62D3489FAA8E058`.

**Cause:** `TestContent/start_mcp.ps1` registered TestContent as a Workbench
addon root but omitted its sibling Core project.

**Resolution:** The launcher supplies both the Core and TestContent addon
roots. The local stdio MCP host must be restarted through that launcher before
retrying because an active host retains its startup configuration.

### MCP-008 — target-bound launch resolved resources from the wrong root

**Status:** Resolved

**Closed:** 2026-07-28

**Observed behavior:** `wb_launch` received the exact TestContent `.gproj` and
project-relative world path
`Worlds/Testing/OPZO_BodyIdentityValidation/OPZO_BodyIdentityValidation.ent`,
but resolved it beneath the repository root and rejected it as missing.

**Cause:** Nonabsolute target paths were resolved from the MCP process working
directory instead of the selected project's `modDirectory`.

**Resolution:** Target canonicalization now resolves relative resources from
the explicit project root. The TestContent launcher also uses the existing
OnePointZeroOne screenshot-evidence directory.

**Verification:** Focused resource-target regression tests and the TypeScript
build pass, including the TestContent-relative `.ent` case. The live launch
reached the MCP but was safely refused because an independent MCP-owned
Workbench lifecycle lease was active; no editor state or resource was changed.

### MCP-005 — Observer opaque and legacy world expectations conflicted

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-28

**Observed behavior:** `observer_instances` returned a matching `worldId`,
legacy epoch, and opaque `worldRevision`, but a capture containing all three
could be rejected with `WORLD_CHANGED` because the legacy and opaque values did
not identify the same revision.

**Resolution:** The public contract accepts either canonical
`expectedWorldRevision` or the complete legacy
`expectedWorldId`/`expectedWorldEpoch` pair. Both forms may be supplied only
when they identify the same revision. Absent binding and one-sided legacy
values are rejected, and current guidance prefers the canonical revision.

**Verification:** Observer schema and capture-request regression coverage
exercise canonical-only, complete-legacy, matching dual, mismatched dual, and
partial legacy requests.

**Superseded contract:** MCP-029 later approved `expectedWorldRevision` as the
only public capture binding and removed the temporary legacy and dual forms.

### MCP-001 — Workbench helper staging rejected a normal generated file

**Status:** Resolved

**Severity:** Breaking

**Observed:** 2026-07-28

**Closed:** 2026-07-28

**Observed behavior:** `wb_launch` failed with `LAUNCH_FAILED` and reported an
incomplete helper payload after Workbench had previously opened the staged
helper.

**Cause:** Workbench writes `UserMaps.desc` beside the helper. The staging
policy allowed `resourceDatabase.rdb` but not that second normal generated
file, so the next launch failed closed.

**Resolution:** Added `UserMaps.desc` to the exact staged-only generated-file
allowlist in `src/workbench/helper-addon.ts` and extended
`tests/workbench/helper-addon.test.ts` to cover both generated files.

**Verification:** The focused helper-addon suite passed 10 tests and the
TypeScript build passed. The exact stale generated cache file was removed so
the observed Workbench session could launch.

### MCP-025 — live acceptance recreated the removed validation-docs folder

**Status:** Resolved

**Closed:** 2026-07-28

The opt-in runtime and Workbench Observer acceptance harnesses previously
defaulted their baseline artifacts to `docs/validation`, recreating a removed
repository directory. They now default beneath their externally confined
acceptance artifact root; callers can still choose an explicit publication
directory with `--validation-root`.

### MCP-024 — live guides linked from the README were omitted from packages

**Status:** Resolved

**Closed:** 2026-07-28

The npm package now includes the linked Observer guide, runner guide, and
contribution guide, and package verification requires them. This keeps package
README links usable after installation.

### MCP-023 — verification parsed a removed README tool table

**Status:** Resolved

**Closed:** 2026-07-28

Runtime verification and setup receipts previously treated the root README's
hand-maintained tool table as an API oracle. The verifier now inspects the
registered MCP tools directly, rejects duplicate/refusal-only tools, and
requires a nonempty runtime description. This makes the runtime registration,
not prose, the source of truth for the verification check.

### MCP-022 — case-sensitive package entry for `SETUP.md`

**Status:** Resolved

**Closed:** 2026-07-28

The documentation file is now `SETUP.md`; package metadata and package-contract
coverage now use that same case, including on case-sensitive publish targets.

### MCP-021 — removed validation path remains in configuration example

**Status:** Resolved

**Closed:** 2026-07-28

`reforger-forge.config.example.json` previously pointed evidence output at the
removed `docs/validation` path. It now uses an explicit managed evidence-root
example.

### MCP-020 — model GUID availability in `asset_search`

**Status:** Resolved

**Closed:** 2026-07-28

`asset_search(type: "model")` now returns indexed GUID-prefixed `.xob`
references when the resource database contains them. Prefab and prompt guidance
directs model discovery there rather than to `api_search`.

### MCP-019 — residual `ObserverCoordinatorError` terminology

**Status:** Resolved

**Closed:** 2026-07-28

The deleted `ObserverCoordinator` facade is not used in production; the
composition root is `ObserverApplication`. The host boundary now uses
`ObserverApplicationError`. `ObserverCoordinatorError` remains only as a
deprecated constructor alias for import and `instanceof` compatibility; current
host code, tests, and guidance use the application terminology.

### MCP-016 — `wb_resources` advertised unsupported `browse`

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

The MCP schema advertised `browse`, but the Workbench helper deliberately
returned “not yet implemented.” The public action enum now omits `browse`
until a tested helper implementation exists.

### MCP-015 — model lookup guidance used the wrong discovery tool

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

Live prefab guidance directed callers to `api_search` for `.xob` models.
Models are game assets, so discovery now uses `asset_search(type: "model")`;
the asset index returns the GUID-prefixed model references used in that
guidance.

### MCP-014 — `wiki_read` claimed unlimited page text

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

`wiki_read` returns at most 100,000 page-content characters and appends a
truncation notice. Its tool description and prompt guidance now advertise that
cap consistently.

### MCP-013 — `game_duplicate` overstated its supported resource scope

**Status:** Resolved

**Severity:** P1

**Closed:** 2026-07-28

The tool advertised `.conf` and PAK support despite a prefab-centric loose-data
implementation. It now supports `.et` prefabs only, validates both extensions,
describes the source-data requirement accurately, and directs later
registration through `wb_resources(action: "register")`.

### MCP-012 — `game_duplicate(register=true)` could auto-launch Workbench

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-28

Registration now calls Workbench with `skipAutoLaunch: true`. It requires an
already-running compatible Workbench; failures state that a copy may exist but
is not registered, and non-`ok` helper receipts are MCP errors.

### MCP-011 — configured `projectPath` was unsafe as a default write root

**Status:** Resolved

**Severity:** P0

**Closed:** 2026-07-28

`projectPath` remains an addons container. Addon-scoped mutations now require
an explicit addon root, a direct-child `modName`, or a valid configured
`defaultMod`; they never write to the container or select its first child.

**Superseded contract:** MCP-030 later removed `projectPath`, `defaultMod`, and
container-based targeting entirely in favor of exact `gprojPath` or the
verified running Workbench lifecycle target.
