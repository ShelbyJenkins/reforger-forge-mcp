# MCP API Contract Follow-up Plan

## Status

The source-backed contradictions found during the documentation-only
reorganization have now been corrected and recorded in the
[MCP problem tracker](../../agents/mcp-tracking/README.md). This plan remains
the home for the larger future idea: generated, mechanically checked public API
reference artifacts.
Implementation changes corresponding to `MCP-005`, `MCP-011`, `MCP-012`, and
`MCP-013` have been made. The Observer world-binding contract was approved in
`MCP-029`; exact addon targeting was approved in `MCP-030`, and the `.et`-only
duplication contract was approved in `MCP-031`. Historical-document handling
is recorded in `MCP-026`; the remaining API-reference work is tracked as
`MCP-027` and `MCP-028`.

## Goal

Make the MCP public surface self-describing, mechanically documented, and
verified against the executable server rather than against a hand-maintained
README table.

## Current findings

- The production server registers 58 tools, two prompts (`create-mod` and
  `modify-mod`), and three resource templates.
- At the time of the initial audit, the root README listed the 58 tool names,
  did not document prompts or resource templates, and was coupled to runtime
  verification through Markdown parsing. The README table was removed and
  runtime verification now inspects registered tools directly.
- Tools advertise descriptions and input schemas, but not titles, annotations,
  output schemas, or structured output contracts.
- Many tools use an `action` parameter whose action-specific requirements are
  enforced in handlers rather than fully expressed by the generic input
  schema.

## Contract decisions and implementations awaiting approval

The exact-targeting decision is approved; the remaining change must not be
treated as approved canonical behavior until its linked review ticket is
closed:

1. **Exact addon targeting (`MCP-030`, approved).** `projectPath`,
   `defaultMod`, container scanning, and their CLI flags are removed.
   Addon-scoped tools use an exact `gprojPath` or the verified running
   Workbench lifecycle target.
2. **Game duplication scope (`MCP-031`).** `game_duplicate` supports only `.et`
   prefabs, validates both extensions, reads source prefabs from extracted,
   loose, or PAK-backed data, and requires an already-running compatible
   Workbench when registration is requested. Offline copies remain supported;
   deferred `wb_resources(register)` recovery requires an absolute existing
   resource path contained by the exact active project. `.conf` copying is a
   separate future enhancement because it does not use prefab ancestry and
   entity-ID transformations.
3. **Release history.** The relevant release notes are explicitly labeled as
   historical records; current MCP schemas and guides are the live reference.

## Proposed implementation

### 1. Create a public-surface catalog

Add a small source catalog, for example `src/mcp/tool-catalog.ts`, containing
only metadata unavailable from MCP discovery:

- documentation group and audience;
- action-level behavior, side effects, and idempotency notes;
- workflow/documentation links; and
- stability or deprecation status.

Do not duplicate tool names, schemas, or long descriptions in the catalog.
Those remain owned by production registrations in `src/tools`, `src/observer`,
and `src/server.ts`.

Later, introduce a shared registration helper so a new public tool cannot
bypass catalog classification, title, description, and safety review.

### 2. Generate reference artifacts from a real server

Add a deterministic generator, for example
`scripts/generate-mcp-api-reference.ts`. It should create a production
`McpServer` with a hermetic fixture configuration, connect through an
in-memory MCP transport, and obtain the same public data a client receives:

- `tools/list`;
- `prompts/list`; and
- `resources/list` and `resources/templates/list`.

Generate and check in:

- `docs/api/mcp-tools.md` — grouped human-readable tool reference;
- `docs/api/mcp-tools.json` — normalized public `tools/list` contract; and
- `docs/api/mcp-prompts-resources.md` — prompt and resource-template reference.

Use stable sorting and a reproducible header so a check command can detect
drift without accessing Steam, Workbench, or a live game.

### 3. Improve MCP metadata

Add human-readable titles to every tool. Add only conservative MCP annotations
that are true for every action; do not mark mixed read/write tools as
read-only. Review supported annotations such as `readOnlyHint`,
`destructiveHint`, `idempotentHint`, and `openWorldHint`.

Normalize input-property descriptions, defaults, enum descriptions, and
conditional action contracts. Add output schemas and `structuredContent`
incrementally, starting with Observer and Workbench lifecycle receipts where
stable IDs and state fields are especially valuable to clients.

### 4. Extend runtime verification into generated API verification

The implemented first step removed README parsing from
`src/setup/server-verification.ts`, Doctor messaging, setup receipts, and
observer package-contract tests. The current verifier inspects the runtime
tool list and requires nonempty descriptions.

The remaining step is to compare that runtime public surface with a generated
catalog/artifact instead of a hand-maintained list.

The resulting checks should fail on:

- missing, extra, duplicate, or uncategorized tools;
- missing prompt/resource-template coverage;
- empty title or description;
- undocumented action-specific requirements; and
- stale generated API artifacts.

### 5. Add release gates

Introduce commands equivalent to:

```text
npm run mcp:docs:generate
npm run mcp:docs:check
npm run docs:check
```

`docs:check` should include public-surface generation checks, link checks,
Observer protocol checks, and package-content checks. Package and release
validation should fail when public docs are stale or omitted from the package.

## Test plan

- Compare runtime `tools/list` exactly with the generated JSON artifact.
- Verify every catalog entry resolves to a runtime tool and every runtime tool
  has catalog coverage.
- Verify prompts and resource templates are included.
- Assert high-risk conditional contracts for Observer, lifecycle, explicit
  resource save, builds, and write operations.
- Validate representative documented requests against the MCP schemas.
- Check generated artifacts, links, and packed npm contents in CI.

## Still out of scope for this follow-up plan

- Publishing or versioning work.
- A full catalog, generated reference artifacts, and CI drift gate described
  above.
