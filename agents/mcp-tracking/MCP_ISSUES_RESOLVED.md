# Resolved MCP Issues

This is the reverse-chronological closed history for non-defect MCP contract
records. Move newly resolved or verified entries to the top. The legacy records
below were migrated from the mixed tracker on 2026-07-28; same-day ties retain
their migration order.

## Historical and verified records

### MCP-030 — remove configured `projectPath` targeting

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** Remove `projectPath`, `defaultMod`, their CLI flags, and
container-scanning target selection. Addon-scoped tools accept the exact
`.gproj` through `gprojPath` or, where supported, derive it from the verified
running Workbench lifecycle. `mod_create` instead receives an explicit
`outputDir`.

Base-game and standard Workshop addon roots remain automatically discovered.
Nonstandard roots are additive through `workbenchAddonDirs` or repeated
`--workbench-addon-dir` flags. Dependency preflight searches those effective
roots plus target-relative candidates; it does not search arbitrary filesystem
locations.

**Verification:** Configuration rejects the retired settings and flags;
target-resolution, project-identity, generators, duplication, prompts, setup,
and Workbench lifecycle tests cover exact and active targeting. The full
Vitest suite, TypeScript typecheck, and production build passed.

### MCP-029 — `observer_capture` uses only the opaque world revision

**Status:** Resolved

**Priority:** P0

**Closed:** 2026-07-28

**Decision:** The public `observer_capture` contract requires
`expectedWorldRevision` from the immediately preceding `observer_instances`
result. It does not support `expectedWorldId`, `expectedWorldEpoch`, legacy-pair
requests, or dual-form requests. Inventory and result metadata retain nullable
world-ID and epoch projections for diagnostics, while the internal runtime
protocol may project the opaque revision back to those fields.

A canonical revision may represent a graphical runtime with no loaded world.
That state permits `current` capture and rejects `pose` or `lookAt` until an
active world is available.

**Verification:** The registered MCP schema requires
`expectedWorldRevision`, omits both removed fields, and rejects additional
properties. Capture normalization, runtime and Workbench backends, durable-run
reservation, current-view null-world behavior, acceptance/failure-matrix
callers, package guidance, and MCP response tests use the canonical revision.
The focused observer contract suite passed 97 tests; the full Vitest suite,
TypeScript typecheck, MCP build, and Observer build also passed.

### MCP-026 — old release notes describe their release-time API surface

**Status:** Verified

**Closed:** 2026-07-28

The relevant legacy release notes are labeled as historical records, and
archived plans are not live API reference. Current MCP schemas and guides are
the present-behavior source; historical material is not used by verification or
package contracts as canonical documentation.

### MCP-018 — explicit resource save workflow

**Status:** Verified

**Closed:** 2026-07-28

The supported guarded save flow is:

```text
wb_launch(gprojPath, resourcePath) -> target-bound edits ->
wb_save_resource(confirm: "save", resourcePath)
```

The target must be the same `.ent` or `.et` resource supplied at launch.

### MCP-017 — evidence roots are needed only for finalization

**Status:** Verified

**Closed:** 2026-07-28

`observer_run finalize` requires a configured allowlisted evidence destination.
Run begin, capture, status, and discard remain available without one; a
caller-supplied path cannot bypass an empty allowlist.
