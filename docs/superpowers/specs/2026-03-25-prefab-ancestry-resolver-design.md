# Prefab Ancestry Resolver — Design Spec

**Date:** 2026-03-25
**Upgrade Ideas ref:** #15 — Prefab Introspection + Ancestry Resolver
**Status:** Draft

---

## Problem

`game_duplicate` and `prefab_create` operate blind to what a parent prefab provides. When duplicating a base game prefab into a mod, only the leaf file is copied — ancestor components are invisible. When creating a new prefab with a `parentPrefab`, hardcoded template components are used instead of the actual inherited component set. This causes prefabs that either duplicate parent components or miss required ones.

The ancestry resolution logic already exists in `prefab-inspect.ts` (`walkChain`, `parseComponents`, etc.) but is private to that tool. The fix is to extract it into a shared utility and wire it into both `game_duplicate` and `prefab_create`.

---

## Decisions

| Question | Decision |
|----------|----------|
| Which tools get ancestry support? | Both `game_duplicate` and `prefab_create` |
| How should inherited components appear? | Keep parent reference + pre-populate overridable components with original GUIDs (Enfusion delta model) |
| Auto-resolve or opt-in for `prefab_create`? | Opt-out: `includeAncestry` defaults to `true`, can be set `false` |
| Flatten option for `game_duplicate`? | User chooses via `flatten: boolean` (default `false` = keep parent ref) |
| Where does shared logic live? | New `src/utils/prefab-ancestry.ts` |

---

## Architecture

### New module: `src/utils/prefab-ancestry.ts`

Extracted from `src/tools/prefab-inspect.ts`. Exports:

```typescript
// Types
export interface ParsedComponent {
  guid: string;
  typeName: string;
  rawBody: string;
}

export interface AncestorLevel {
  path: string;
  depth: number;
  entityClass: string;
  components: Map<string, ParsedComponent>;
  rawContent: string;
}

export interface MergedComponent {
  comp: ParsedComponent;
  source: AncestorLevel;
}

// Functions
export function stripGuid(ref: string): string;
export function parseParentPath(content: string): { entityClass: string; parentPath: string | null };
export function parseComponents(content: string): Map<string, ParsedComponent>;
export function readEtFile(path: string, config: Config, projectPath?: string): string | null;
export function walkChain(startPath: string, config: Config, projectPath?: string): { levels: AncestorLevel[]; warnings: string[] };
export function mergeAncestryComponents(levels: AncestorLevel[]): Map<string, MergedComponent>;
```

`mergeAncestryComponents` iterates levels from oldest ancestor to leaf. For each component GUID, the deepest (most-derived) level wins. Returns a map of GUID to `{ comp, source }`.

### Changes to `src/tools/prefab-inspect.ts`

- Remove all private functions and types (moved to utility)
- Import from `src/utils/prefab-ancestry.ts`
- Keep `formatReport()` and `registerPrefabInspect()` unchanged
- No behavior change

### Changes to `src/tools/game-duplicate.ts`

**New parameter:**
- `flatten: boolean` (default `false`)

**Modified flow:**

1. Read the source .et file (existing logic)
2. Call `walkChain(bareSourcePath, config)` to resolve the full ancestry
3. Parse the source file into an `EnfusionNode` tree using `parse()` from `enfusion-text.ts`
4. Call `mergeAncestryComponents(levels)` to get the flattened component set
5. Find the `components` child node in the parsed tree
6. For each merged component whose GUID is NOT already in the source file's components block, create a new `EnfusionNode` for that component (preserving its original GUID) and inject it into the components block
7. If `flatten === true`: strip the root node's `inheritance` field
8. If `flatten === false`: keep `inheritance` as-is
9. Serialize back with `serialize()` to produce the final .et text
10. Replace entity ID with fresh GUID via regex on the serialized text (existing logic — must happen after serialize, not before, since the EnfusionNode tree doesn't track the ID property specially)
11. Write to destination and proceed with Workbench registration (existing logic, unchanged)

**Response output** includes a summary:
- Number of ancestor levels resolved
- Number of inherited components injected
- List of component types added (e.g., "MeshObject from [0] Vehicle_Base.et")

### Changes to `src/tools/prefab-create.ts`

**New parameter:**
- `includeAncestry: boolean` (default `true`)

**Modified flow:**

1. If `parentPrefab` is provided AND `includeAncestry !== false`:
   a. Call `walkChain(parentPrefab, config, projectPath)`
   b. If levels are returned (ancestry resolved successfully):
      - Call `mergeAncestryComponents(levels)` to get inherited components
      - Use these as the base component set instead of `PREFAB_CONFIGS[type].defaultComponents`
      - Preserve original GUIDs so they act as override slots in the Enfusion delta model
      - Append any user-provided extra `components` with fresh GUIDs (existing behavior)
   c. If walkChain returns no levels (game files unavailable):
      - Log warning in response
      - Fall back to step 2
2. If `parentPrefab` is not provided, or `includeAncestry === false`:
   - Use current behavior: hardcoded `PREFAB_CONFIGS[type].defaultComponents`

**Graceful degradation:** Ancestry resolution failure is never a hard error. The tool always produces a valid prefab — either ancestry-informed or template-based.

**Response output** includes:
- "Resolved N ancestor levels, included M inherited components" on success
- "Ancestry resolution unavailable: <reason>. Using template defaults." on fallback

### Integration with `enfusion-text.ts`

The ancestry utility uses regex-based parsing (`parseComponents`, `parseParentPath`) inherited from the original `prefab-inspect.ts` implementation. When injecting components into `game_duplicate` output, we use the structured `EnfusionNode` tree from `parse()` + `serialize()` to ensure valid output.

For `prefab_create`, the `generatePrefab()` function in `src/templates/prefab.ts` already builds an `EnfusionNode` tree. The ancestry components are converted to `ComponentDef[]` and passed in place of the hardcoded defaults.

---

## Testing

### Unit tests: `tests/utils/prefab-ancestry.test.ts`

- **`parseParentPath`**: parses entity class + parent path from .et headers
  - With GUID prefix: `SCR_ChimeraCharacter : "{ABC123}Prefabs/Base.et" {`
  - Without GUID prefix: `Vehicle : "Prefabs/Base.et" {`
  - No parent: `GenericEntity {`
- **`parseComponents`**: extracts component map from a components block
  - Verifies GUID, typeName, rawBody for each component
  - Handles nested properties within component bodies
- **`mergeAncestryComponents`**: multi-level merge
  - Child overrides parent when same GUID exists at both levels
  - Ancestor-only components are included
  - Empty levels produce empty merge result

### Integration tests: `tests/tools/game-duplicate.test.ts` (new or extended)

- `flatten: false` — output .et retains parent reference, ancestor components are injected with original GUIDs
- `flatten: true` — output .et has no parent reference, all components baked in
- Source file with no parent — behaves as before, no ancestry to resolve

### Integration tests: `tests/tools/prefab-create.test.ts` (new or extended)

- `includeAncestry: true` + valid parentPrefab — output uses ancestor components, not template defaults
- `includeAncestry: true` + missing game files — graceful fallback to template defaults, warning in response
- `includeAncestry: false` — current behavior unchanged
- No `parentPrefab` provided — current behavior unchanged

### Regression: `prefab-inspect` tests

Existing tests must pass unchanged after the refactor (behavior is identical, only import paths changed).

---

## Files Changed

| File | Change |
|------|--------|
| `src/utils/prefab-ancestry.ts` | **New** — shared ancestry resolution utility |
| `src/tools/prefab-inspect.ts` | Refactor: imports from utility, removes private functions |
| `src/tools/game-duplicate.ts` | Add `flatten` param, wire in ancestry resolution |
| `src/tools/prefab-create.ts` | Add `includeAncestry` param, wire in ancestry resolution |
| `src/templates/prefab.ts` | Minor: accept pre-resolved components as alternative to hardcoded defaults |
| `tests/utils/prefab-ancestry.test.ts` | **New** — unit tests for the utility |
| `tests/tools/game-duplicate.test.ts` | New or extended integration tests |
| `tests/tools/prefab-create.test.ts` | New or extended integration tests |
