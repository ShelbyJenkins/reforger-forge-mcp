# Workbench Log Query — Implementation Guide

**Date:** 2026-07-26
**Goal:** Add a read-only MCP tool that filters Workbench build/editor logs by
addon attribution, severity level, channel, and free-text pattern, returning
only matching lines instead of requiring the caller to fetch and re-parse an
entire raw log file.
**Architecture:** One new dependency-free line parser (`src/formats/`), one
new read-only tool (`src/tools/`) that walks already-attributed log
directories. No changes to the build/editor lifecycle itself.
**Tech Stack:** TypeScript, Vitest, Zod schemas — no native/handler changes,
no new dependencies.

---

## Motivation

Roadblock Runners hand-rolls this exact capability today, entirely in
PowerShell, per-addon:

- `addons/RoadblockRunners/docs/systems/runtime-diagnostics/tools/diagnostic_line_policy.ps1`
  decides whether a line is fatal, using string patterns hardcoded to
  `RoadblockRunners` / `RR_` / `RR <Tag>:`.
- `addons/RoadblockRunners/docs/systems/runtime-diagnostics/tools/write_retained_diagnostics.ps1`
  re-reads whole raw log files after the fact and writes a curated
  `RoadblockRunners-retained.log` using the same addon-specific patterns plus
  a hand-maintained allowlist of "important lifecycle" message shapes.

Both require the caller to already have the raw log file(s) on disk and to
read every line of every file themselves. That's wasteful for a script, and
actively bad for an MCP client — dumping a full raw Workbench log into a tool
response burns context for no reason. It also means every addon in the repo
that wants the same behavior (OnePointZeroOne, SecondWind, SaltLine, ...)
would have to reimplement the same regex-matching logic with its own addon ID
baked in.

This guide splits the capability along the line established in
`MCP_ISSUES.md` MCP-016's fix plan: push the generic mechanism into
`reforger-forge-mcp`, leave addon-specific *policy* (RR's lifecycle-event
allowlist, its definition of "fatal") out of the shared server entirely. RR's
own scripts are expected to stop carrying that policy rather than have it
reimplemented here — see "Non-goals" below.

## Log line format (verified against real fixtures)

Every line the current RR tooling matches against follows one shape,
confirmed in `addons/RoadblockRunners/docs/systems/runtime-diagnostics/tools/verify_retained_diagnostics.ps1`:

```
<CHANNEL>       (<LEVEL>): <message>
```

Examples pulled directly from that fixture file:

```
SCRIPT       (I): RoadblockRunners outfit: applied playerId=7 team=RED
SCRIPT       (W): RoadblockRunners outfit: no backpack slot playerId=17 team=FAI
ENGINE       (E): Assertion failed: owner != null entity=RR_GameMode playerId=17
RESOURCES    (E): Resources are leaking! count=3 owner=RR_GameMode
RESOURCES    (W): resource not registered: @"$RoadblockRunners:Configs/Runtime/RR_RuntimeConfig.json". Setting null GUID
```

Observed levels: `I` (info), `W` (warning), `E` (error). There is no distinct
"fatal" level — `Assertion failed`, `Resources are leaking!`, and
`Out of memory` all show up as ordinary `(E)` lines, escalated only by
message text. `CHANNEL` is a free-form token (`SCRIPT`, `ENGINE`,
`RESOURCES`, ...) padded with spaces before the level marker.

Addon attribution is inferable from the message text alone, without any
addon-specific configuration, via three patterns anchored on the addon ID:
- the literal addon ID as a whole word (`RoadblockRunners`);
- the Enfusion resource-prefix notation (`$RoadblockRunners:...`);
- an addon-root path segment (`addons/RoadblockRunners/...` or
  `addons\RoadblockRunners\...`).

What is **not** generalizable — and must not be added here — is RR's
script-prefix convention (`RR_`, `RR VehicleSpawn:`, etc.) or its lifecycle
event allowlist. Those are this one addon's internal naming choices.

## Non-goals

- No "fatal" enum or built-in pass/fail judgment. The tool returns matches;
  the caller (a script, a human, an agent) decides what those matches mean.
- No addon-specific pattern lists (RR's lifecycle events, its script-prefix
  convention). `addonIds` filtering covers only what's mechanically derivable
  from the ID itself.
- No multi-line grouping (stack traces spanning several lines are matched
  line-by-line, not as a block) — flag as a candidate follow-up, not v1 scope.
- No automatic "use the log directory from my last build/launch" default.
  `session-controller.ts` does not currently track a last-known log
  directory across calls; adding that is a separate, larger change. v1
  requires the caller to pass `logDirectory` explicitly, using the value
  already returned by `wb_build`'s/`wb_launch`'s receipt.
- No coverage of runtime/dedicated-server logs yet — those aren't
  attributed to a `logDirectory` the same way today. Worth a follow-up once
  observer-owned runtime logs have an equivalent attributed location.
- Not a replacement for raw log access — `logDirectory` stays the source of
  truth; this tool is an additive, filtered view onto it.

---

## New module: `src/formats/enfusion-log.ts`

Parallel to the existing `src/formats/enfusion-text.ts` (which parses
`.gproj`/`.et` Enfusion text), this is a small, dependency-free line parser.

```typescript
export type EnfusionLogLevel = "I" | "W" | "E";

export interface ParsedLogLine {
  readonly channel: string;
  readonly level: EnfusionLogLevel;
  readonly message: string;
  /** The complete original line, unmodified. */
  readonly raw: string;
}

const LOG_LINE_PATTERN = /^(\S+)\s+\(([IWE])\):\s?(.*)$/;

export function parseLogLine(line: string): ParsedLogLine | null {
  const match = LOG_LINE_PATTERN.exec(line);
  if (!match) return null;
  return {
    channel: match[1],
    level: match[2] as EnfusionLogLevel,
    message: match[3],
    raw: line,
  };
}

/**
 * Whether a line's raw text references the given addon ID via its literal
 * name, its `$<AddonId>:` resource prefix, or an `addons/<AddonId>/` path
 * segment. Word-bounded so `RR` cannot match inside `ARRAY` or `CURRENT`.
 */
export function referencesAddon(line: string, addonId: string): boolean {
  const escaped = addonId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b${escaped}\\b|\\$${escaped}:|addons[\\\\/]${escaped}(?:[\\\\/]|$)`,
    "i"
  );
  return pattern.test(line);
}
```

`parseLogLine` returning `null` (a banner/noise line with no `(LEVEL):`
marker) is expected and common — those lines are simply unmatchable by level
or channel, but can still match `addonIds`/`pattern` against their raw text.

### Tests: `tests/formats/enfusion-log.test.ts`

Port the fixture lines already proven out in
`verify_retained_diagnostics.ps1` directly into Vitest cases — they're a
ready-made, adversarial set:

- `parseLogLine` extracts channel/level/message for `SCRIPT (I): ...`,
  `RESOURCES (E): ...`, including the zero-space-after-colon and
  multi-space-before-paren variants seen in the fixtures.
- `parseLogLine` returns `null` for a line with no `(LEVEL):` marker.
- `referencesAddon(line, "RoadblockRunners")` is `true` for the literal-name,
  `$RoadblockRunners:`, and `addons/RoadblockRunners/` cases.
- `referencesAddon(line, "RR")` is **`false`** for
  `'SCRIPT (E): RR AIRBORNE subsystem failure from an unrelated addon'` if
  `RR` is used as a full addon ID being tested against a longer word — mirror
  the exact false-positive case the PowerShell suite already guards
  (`$unownedAIPrefixError`), adapted to whatever this project's real addon
  IDs are (`RoadblockRunners`, not the `RR` prefix — the generic matcher only
  ever tests the real ID, never RR's internal script-prefix convention).
  Add an explicit case for a substring collision, e.g. `referencesAddon(...,
  "Sedan")` must not match a line only containing `SedanDeluxe`.
- Case-insensitivity and comma-in-message safety.

---

## New tool: `src/tools/wb-log-query.ts`

```typescript
server.registerTool(
  "wb_log_query",
  {
    description:
      "Filter attributed Workbench build/editor log files by addon " +
      "reference, severity level, channel, and/or text pattern, returning " +
      "only matching lines instead of the full raw log.",
    inputSchema: {
      logDirectory: z.string().trim().min(1).describe(
        "An exact log directory from a prior wb_build/wb_launch receipt " +
        "(its logDirectory or preflight.logDirectory field)."
      ),
      addonIds: z.array(z.string().trim().min(1)).max(16).optional().describe(
        "Return only lines that reference at least one of these addon IDs " +
        "by name, $<AddonId>: resource prefix, or addons/<AddonId>/ path."
      ),
      levels: z.array(z.enum(["I", "W", "E"])).max(3).optional(),
      channels: z.array(z.string().trim().min(1)).max(16).optional(),
      pattern: z.string().trim().min(1).max(512).optional().describe(
        "Case-insensitive substring or regex applied to the line's raw text."
      ),
      maxLines: z.number().int().min(1).max(2_000).default(500),
    },
  },
  async ({ logDirectory, addonIds, levels, channels, pattern, maxLines }) => {
    // 1. Resolve logDirectory (must exist, must be a directory, no reparse
    //    points — reuse the same guarded-path helpers `managed-path.ts`
    //    already provides elsewhere in this codebase).
    // 2. Enumerate *.log files directly under it (non-recursive — matches
    //    the flat layout the runner already writes; do not silently widen
    //    scope to arbitrary caller-supplied directories elsewhere on disk).
    // 3. For each file, for each line: parseLogLine, then apply every
    //    supplied filter as an AND — level/channel test the parsed fields;
    //    addonIds test referencesAddon against the raw line; pattern tests
    //    the raw line. A line with no supplied filters at all is rejected
    //    with INVALID_CONFIG — this tool is never "return everything."
    // 4. Stop at maxLines total across all files; report `truncated: true`
    //    if the cap was hit so the caller knows to narrow the query.
    // 5. Return { matches: [{ sourceFile, lineNumber, channel, level,
    //    matchedAddonIds, text }], fileCount, matchCount, truncated }.
  }
);
```

Notes for implementation:
- This tool is **read-only** and never touches the Workbench lifecycle,
  process guard, or companion — it doesn't need `WorkbenchLifecycleGuard` or
  any of the machinery `wb_build`/`wb_launch` depend on. It only needs
  filesystem read access to a directory the caller already learned about from
  a receipt.
- Require at least one of `addonIds` / `levels` / `channels` / `pattern` —
  an unfiltered "dump everything" call defeats the entire purpose (return
  only what's relevant) and reintroduces the "read the whole log" problem
  this tool exists to avoid.
- Cap `maxLines` the same way `wb_resources browse` already caps entries at
  200 — bounded output is an established convention in this codebase, not a
  new one.
- Reuse `redactText` (`src/foundation/redact.ts`) on returned line text the
  same way `wb-build.ts` already does on error messages, in case a log line
  ever contains a path or token worth redacting.

### Registration (`src/server.ts`)

Add alongside the other `wb_*` tools registered in Phase 4
(`src/server.ts:207-230`):

```typescript
import { registerWbLogQuery } from "./tools/wb-log-query.js";
// ...
registerWbLogQuery(server);
```

No dependency injection needed beyond what every other stateless read-only
tool in that block already gets — this tool needs no `wbClient`, no
`processGuard`, no `companionProvider`.

### Tests: `tests/tools/wb-log-query.test.ts`

Follow the pattern of `tests/tools/asset-search.test.ts` (a read-only,
filesystem-backed tool test, no live Workbench needed):
- Write fixture log files to a temp directory per test (reuse the same
  fixture line set as `enfusion-log.test.ts` and
  `verify_retained_diagnostics.ps1`).
- Assert filtering by each parameter independently, and combinations
  (`addonIds` + `levels` together must AND, not OR).
- Assert the "no filter supplied" refusal.
- Assert `truncated: true` when `maxLines` is hit, and that the reported
  `matchCount`/returned array length are consistent.
- Assert a `logDirectory` outside any expected root, a missing directory,
  and a reparse-point directory are all rejected the same way other tools in
  this codebase already reject unsafe paths (see `managed-path.test.ts` for
  the existing guard patterns to reuse rather than reinvent).

---

## Task breakdown

### Task 1: `enfusion-log.ts` parser + tests
**Files:** new `src/formats/enfusion-log.ts`, new `tests/formats/enfusion-log.test.ts`
Write the fixture-driven tests first (port lines from
`verify_retained_diagnostics.ps1`), confirm they fail against no
implementation, then implement `parseLogLine` and `referencesAddon` until
green.

### Task 2: `wb-log-query.ts` tool + tests
**Files:** new `src/tools/wb-log-query.ts`, new `tests/tools/wb-log-query.test.ts`
Depends on Task 1. Implement the directory-walk + filter pipeline described
above; reuse `managed-path.ts` guards for `logDirectory` validation and
`redact.ts` for output text.

### Task 3: Registration
**Files:** `src/server.ts`
One import + one registration call in the existing Phase 4 block.

### Task 4: Docs
**Files:** `README.md` (tool table), `agents/AGENTS.md` (tool-selection
table), `setup.md` if it documents log inspection anywhere.
Add `wb_log_query` to the existing tool tables the same way `wb_build` was
added when it shipped.

None of these tasks touch the native Workbench handler side (`mod/...`) —
this is pure TypeScript, filesystem-only, and testable without a live
Workbench instance.

## File change summary

| File | Change Type |
|---|---|
| `src/formats/enfusion-log.ts` | **New file** |
| `tests/formats/enfusion-log.test.ts` | **New file** |
| `src/tools/wb-log-query.ts` | **New file** |
| `tests/tools/wb-log-query.test.ts` | **New file** |
| `src/server.ts` | Register `wb_log_query` in Phase 4 |
| `README.md` | Add `wb_log_query` to the tool table |
| `agents/AGENTS.md` | Add `wb_log_query` to the tool-selection table |

## Relationship to existing RoadblockRunners tooling

This guide does not modify anything under `addons/RoadblockRunners/`. Once
`wb_log_query` ships, RR's `diagnostic_line_policy.ps1` and
`write_retained_diagnostics.ps1` become candidates for deletion rather than
migration — per the separate decision already recorded to drop RR-specific
build rules rather than reimplement them here. That removal is tracked and
should happen as its own change in the `arma` repo, not as part of this
`reforger-forge-mcp` feature.
