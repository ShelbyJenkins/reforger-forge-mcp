# Prefab Ancestry Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the prefab ancestry resolution logic from `prefab-inspect.ts` into a shared utility, then wire it into `game_duplicate` and `prefab_create` so both tools understand the full inherited component set when duplicating or creating prefabs.

**Architecture:** A new `src/utils/prefab-ancestry.ts` module exports `walkChain`, `mergeAncestryComponents`, and supporting parsers. `prefab-inspect.ts` is refactored to import from this utility (no behavior change). `game_duplicate` gains a `flatten` parameter and injects ancestor components into duplicated prefabs. `prefab_create` gains an `includeAncestry` parameter (default `true`) that replaces hardcoded template components with the real inherited set when a `parentPrefab` is provided.

**Tech Stack:** TypeScript, Vitest, Node.js `fs`, existing `src/formats/enfusion-text.ts` (parse/serialize), existing `src/pak/vfs.ts` (PAK reading)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/utils/prefab-ancestry.ts` | **Create** | Shared ancestry resolution: chain walking, component parsing, merging |
| `src/tools/prefab-inspect.ts` | **Modify** | Remove private functions, import from utility |
| `src/tools/game-duplicate.ts` | **Modify** | Add `flatten` param, inject ancestor components |
| `src/tools/prefab-create.ts` | **Modify** | Add `includeAncestry` param, use resolved components |
| `src/templates/prefab.ts` | **Modify** | Accept pre-resolved `ComponentDef[]` as override for template defaults |
| `tests/utils/prefab-ancestry.test.ts` | **Create** | Unit tests for the utility module |
| `tests/templates/prefab.test.ts` | **Modify** | Add tests for ancestry-override path |

---

## Task 1: Create `src/utils/prefab-ancestry.ts`

**Files:**
- Create: `src/utils/prefab-ancestry.ts`

This is a pure extraction from `prefab-inspect.ts` plus the new `mergeAncestryComponents` export. No new logic yet — just making the existing logic shareable.

- [ ] **Step 1: Create the utility file**

```typescript
// src/utils/prefab-ancestry.ts
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath, findLooseFile } from "../utils/game-paths.js";
import { logger } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function stripGuid(ref: string): string {
  return ref.replace(/^\{[0-9A-Fa-f]{16}\}/, "");
}

export function parseParentPath(content: string): { entityClass: string; parentPath: string | null } {
  // Match: EntityClass : "{HEX16}Path/To/Parent.et" {
  const m = /^(\w+)\s*:\s*"\{[0-9A-Fa-f]{16}\}([^"]+)"\s*\{/m.exec(content);
  if (m) return { entityClass: m[1], parentPath: m[2] };
  // Match without GUID prefix
  const m2 = /^(\w+)\s*:\s*"([^"]+\.et)"\s*\{/m.exec(content);
  if (m2) return { entityClass: m2[1], parentPath: m2[2] };
  // No parent
  const m3 = /^(\w+)\s*\{/m.exec(content);
  return { entityClass: m3 ? m3[1] : "Unknown", parentPath: null };
}

function extractComponentsBlock(content: string): string {
  const m = /^[ \t]*components\s*\{/m.exec(content);
  if (!m || m.index === undefined) return "";
  const openPos = content.indexOf("{", m.index + m[0].length - 1);
  let depth = 1;
  let i = openPos + 1;
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }
  return content.slice(openPos + 1, i - 1);
}

export function parseComponents(content: string): Map<string, ParsedComponent> {
  const result = new Map<string, ParsedComponent>();
  const block = extractComponentsBlock(content);
  if (!block) return result;

  const re = /^[ \t]*(\w+)\s+"\{([0-9A-Fa-f]{16})\}"[^{]*\{/gm;
  let match: RegExpExecArray | null;

  while ((match = re.exec(block)) !== null) {
    const typeName = match[1];
    const guid = match[2];
    const openBrace = block.indexOf("{", match.index + match[0].length - 1);
    let depth = 1;
    let i = openBrace + 1;
    while (i < block.length && depth > 0) {
      if (block[i] === "{") depth++;
      else if (block[i] === "}") depth--;
      i++;
    }
    const rawBody = block.slice(openBrace + 1, i - 1);
    result.set(guid, { guid, typeName, rawBody });
  }

  return result;
}

export function readEtFile(path: string, config: Config, projectPath?: string): string | null {
  const bare = stripGuid(path);

  // 1. Mod project — check direct path and all addon subdirs
  const base = projectPath || config.projectPath;
  if (base) {
    const direct = join(base, bare);
    if (existsSync(direct)) {
      try { return readFileSync(direct, "utf-8"); } catch (e) { logger.debug(`Failed to read ${direct}: ${e}`); }
    }
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(base, entry.name, bare);
        if (existsSync(candidate)) {
          try { return readFileSync(candidate, "utf-8"); } catch (e) { logger.debug(`Failed to read ${candidate}: ${e}`); }
        }
      }
    } catch (e) { logger.debug(`Cannot read addon dir ${base}: ${e}`); }
  }

  // 2. Extracted files
  if (config.extractedPath) {
    const found = findLooseFile(config.extractedPath, bare);
    if (found) {
      try { return readFileSync(found, "utf-8"); } catch (e) { logger.debug(`Failed to read extracted ${found}: ${e}`); }
    }
  }

  // 3. Loose game data
  const gameDataPath = resolveGameDataPath(config.gamePath);
  if (gameDataPath) {
    const found = findLooseFile(gameDataPath, bare);
    if (found) {
      try { return readFileSync(found, "utf-8"); } catch (e) { logger.debug(`Failed to read loose ${found}: ${e}`); }
    }
  }

  // 4. Pak VFS
  const pakVfs = PakVirtualFS.get(config.gamePath);
  if (pakVfs && pakVfs.exists(bare)) {
    try { return pakVfs.readTextFile(bare); } catch (e) { logger.debug(`Failed to read pak ${bare}: ${e}`); }
  }

  return null;
}

// ── Chain walker ──────────────────────────────────────────────────────────────

const MAX_DEPTH = 20;

export function walkChain(
  startPath: string,
  config: Config,
  projectPath?: string
): { levels: AncestorLevel[]; warnings: string[] } {
  const levels: AncestorLevel[] = [];
  const warnings: string[] = [];
  const visited = new Set<string>();

  function visit(path: string): void {
    const bare = stripGuid(path);
    const key = bare.toLowerCase();
    if (visited.has(key)) {
      warnings.push(`Cycle detected: ${bare}`);
      return;
    }
    if (levels.length >= MAX_DEPTH) {
      warnings.push(`Chain truncated at depth ${MAX_DEPTH}`);
      return;
    }
    visited.add(key);

    const content = readEtFile(bare, config, projectPath);
    if (!content) {
      warnings.push(`Could not read: ${bare}`);
      return;
    }

    const { entityClass, parentPath } = parseParentPath(content);

    // Recurse to parent first so oldest ancestor ends up at index 0
    if (parentPath) visit(parentPath);

    levels.push({
      path: bare,
      depth: -1,
      entityClass,
      components: parseComponents(content),
      rawContent: content,
    });
  }

  visit(startPath);
  levels.forEach((l, i) => { l.depth = i; });

  return { levels, warnings };
}

// ── Merge ─────────────────────────────────────────────────────────────────────

/**
 * Merge components across an ancestry chain.
 * Deepest level (highest depth index) wins per component GUID.
 * Returns a map of GUID -> { comp, source }.
 */
export function mergeAncestryComponents(levels: AncestorLevel[]): Map<string, MergedComponent> {
  const merged = new Map<string, MergedComponent>();
  // Iterate oldest-to-newest so child overwrites parent for same GUID
  for (const level of levels) {
    for (const [guid, comp] of level.components) {
      merged.set(guid, { comp, source: level });
    }
  }
  return merged;
}
```

- [ ] **Step 2: Build to verify types compile**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npm run build 2>&1 | tail -20
```

Expected: no TypeScript errors. The file is purely additive so nothing should break.

- [ ] **Step 3: Commit**

```bash
git add src/utils/prefab-ancestry.ts
git commit -m "feat: extract prefab ancestry resolution into shared utility"
```

---

## Task 2: Unit tests for `prefab-ancestry.ts`

**Files:**
- Create: `tests/utils/prefab-ancestry.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
// tests/utils/prefab-ancestry.test.ts
import { describe, it, expect } from "vitest";
import {
  stripGuid,
  parseParentPath,
  parseComponents,
  mergeAncestryComponents,
  type AncestorLevel,
} from "../../src/utils/prefab-ancestry.js";

describe("stripGuid", () => {
  it("removes leading GUID prefix", () => {
    expect(stripGuid("{AABBCCDD11223344}Prefabs/Foo.et")).toBe("Prefabs/Foo.et");
  });

  it("returns path unchanged when no GUID prefix", () => {
    expect(stripGuid("Prefabs/Foo.et")).toBe("Prefabs/Foo.et");
  });
});

describe("parseParentPath", () => {
  it("parses entity class and parent with GUID prefix", () => {
    const content = `SCR_ChimeraCharacter : "{AABB112233445566}Prefabs/Base.et" {\n  ID "abc"\n}`;
    const result = parseParentPath(content);
    expect(result.entityClass).toBe("SCR_ChimeraCharacter");
    expect(result.parentPath).toBe("Prefabs/Base.et");
  });

  it("parses entity class and parent without GUID prefix", () => {
    const content = `Vehicle : "Prefabs/VehicleBase.et" {\n  ID "abc"\n}`;
    const result = parseParentPath(content);
    expect(result.entityClass).toBe("Vehicle");
    expect(result.parentPath).toBe("Prefabs/VehicleBase.et");
  });

  it("parses root entity with no parent", () => {
    const content = `GenericEntity {\n  ID "abc"\n}`;
    const result = parseParentPath(content);
    expect(result.entityClass).toBe("GenericEntity");
    expect(result.parentPath).toBeNull();
  });
});

describe("parseComponents", () => {
  it("returns empty map when no components block", () => {
    const content = `GenericEntity {\n  ID "abc"\n}`;
    expect(parseComponents(content).size).toBe(0);
  });

  it("parses a single component", () => {
    const content = `GenericEntity {\n  components {\n   MeshObject "{AABBCCDD11223344}" {\n    Object "foo.xob"\n   }\n  }\n}`;
    const comps = parseComponents(content);
    expect(comps.size).toBe(1);
    const comp = comps.get("AABBCCDD11223344");
    expect(comp).toBeDefined();
    expect(comp!.typeName).toBe("MeshObject");
    expect(comp!.guid).toBe("AABBCCDD11223344");
  });

  it("parses multiple components with distinct GUIDs", () => {
    const content = `GenericEntity {\n  components {\n   MeshObject "{AAAAAAAAAAAAAAAA}" {\n  }\n   RigidBody "{BBBBBBBBBBBBBBBB}" {\n  }\n  }\n}`;
    const comps = parseComponents(content);
    expect(comps.size).toBe(2);
    expect(comps.has("AAAAAAAAAAAAAAAA")).toBe(true);
    expect(comps.has("BBBBBBBBBBBBBBBB")).toBe(true);
  });
});

describe("mergeAncestryComponents", () => {
  function makeLevel(depth: number, components: Record<string, string>): AncestorLevel {
    const compMap = new Map(
      Object.entries(components).map(([guid, type]) => [
        guid,
        { guid, typeName: type, rawBody: "" },
      ])
    );
    return { path: `level${depth}.et`, depth, entityClass: "GenericEntity", components: compMap, rawContent: "" };
  }

  it("returns empty map for empty levels", () => {
    expect(mergeAncestryComponents([]).size).toBe(0);
  });

  it("returns all components from a single level", () => {
    const level = makeLevel(0, { AAAAAAAAAAAAAAAA: "MeshObject", BBBBBBBBBBBBBBBB: "RigidBody" });
    const merged = mergeAncestryComponents([level]);
    expect(merged.size).toBe(2);
    expect(merged.get("AAAAAAAAAAAAAAAA")!.comp.typeName).toBe("MeshObject");
  });

  it("child overrides parent for same GUID", () => {
    const parent = makeLevel(0, { AAAAAAAAAAAAAAAA: "MeshObject" });
    const child = makeLevel(1, { AAAAAAAAAAAAAAAA: "MeshObject" }); // same GUID, re-declared
    const merged = mergeAncestryComponents([parent, child]);
    expect(merged.size).toBe(1);
    expect(merged.get("AAAAAAAAAAAAAAAA")!.source.depth).toBe(1); // child wins
  });

  it("includes ancestor-only components not present in leaf", () => {
    const parent = makeLevel(0, { AAAAAAAAAAAAAAAA: "MeshObject" });
    const child = makeLevel(1, { BBBBBBBBBBBBBBBB: "RigidBody" }); // different GUID
    const merged = mergeAncestryComponents([parent, child]);
    expect(merged.size).toBe(2);
    expect(merged.has("AAAAAAAAAAAAAAAA")).toBe(true);
    expect(merged.has("BBBBBBBBBBBBBBBB")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npx vitest run tests/utils/prefab-ancestry.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/utils/prefab-ancestry.test.ts
git commit -m "test: add unit tests for prefab-ancestry utility"
```

---

## Task 3: Refactor `prefab-inspect.ts` to import from utility

**Files:**
- Modify: `src/tools/prefab-inspect.ts`

No behavior change — just replace private functions with imports.

- [ ] **Step 1: Replace private functions with imports**

Replace the entire content of `src/tools/prefab-inspect.ts` with:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  walkChain,
  mergeAncestryComponents,
  type AncestorLevel,
  type ParsedComponent,
} from "../utils/prefab-ancestry.js";

// ── Output ────────────────────────────────────────────────────────────────────

function formatReport(
  levels: AncestorLevel[],
  warnings: string[],
  includeRaw: boolean
): string {
  const lines: string[] = [];

  lines.push("=== Prefab Inheritance Chain ===");
  for (const level of levels) {
    const tag = level.depth === levels.length - 1 ? "  ← this file" : "";
    lines.push(`  [${level.depth}] ${level.path}  [${level.entityClass}]${tag}`);
  }

  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) lines.push(`  WARNING: ${w}`);
  }

  const merged = mergeAncestryComponents(levels);

  lines.push("");
  lines.push("=== Merged Components ===");

  if (merged.size === 0) {
    lines.push("  (no components found in chain)");
  }

  for (const [, { comp, source }] of merged) {
    const isLeaf = source.depth === levels.length - 1;
    const srcTag = isLeaf ? "← this file" : `inherited from [${source.depth}]: ${source.path}`;
    lines.push("");
    lines.push(`[${comp.typeName} {${comp.guid}}]  ${srcTag}`);
    for (const bl of comp.rawBody.split("\n")) {
      if (bl.trim()) lines.push(`  ${bl}`);
    }
  }

  if (includeRaw) {
    lines.push("");
    lines.push("=== Raw File Contents ===");
    for (const level of levels) {
      lines.push(`\n--- [${level.depth}] ${level.path} ---\n${level.rawContent}`);
    }
  }

  return lines.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerPrefabInspect(server: McpServer, config: Config): void {
  server.registerTool(
    "prefab_inspect",
    {
      description:
        "Inspect an Arma Reforger prefab (.et file) and its full inheritance chain. " +
        "Reads each ancestor prefab, parses all components, and returns a fully merged view " +
        "showing which ancestor each component comes from. " +
        "Child values override parent values (matched by component GUID). " +
        "Use this to understand the complete component set of a prefab, including all " +
        "inherited values not visible in the prefab file itself.",
      inputSchema: {
        path: z.string().describe(
          "Relative prefab path, e.g. 'Prefabs/Weapons/Handguns/M9/Handgun_M9.et'. " +
          "A leading {GUID} prefix is accepted and stripped automatically."
        ),
        include_raw: z.boolean().default(false).describe(
          "Include the full raw .et text for each ancestor at the bottom of the report."
        ),
        projectPath: z.string().optional().describe(
          "Mod project root to search first. Uses ENFUSION_PROJECT_PATH if omitted."
        ),
      },
    },
    async ({ path: inputPath, include_raw, projectPath }) => {
      try {
        const { levels, warnings } = walkChain(inputPath, config, projectPath);

        if (levels.length === 0) {
          return {
            content: [{
              type: "text",
              text: `Could not read prefab: ${inputPath}\n` +
                (warnings.length > 0 ? warnings.join("\n") : "File not found."),
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: formatReport(levels, warnings, include_raw ?? false),
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
```

- [ ] **Step 2: Build and verify no errors**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npm run build 2>&1 | tail -20
```

Expected: clean build, no TypeScript errors.

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npx vitest run
```

Expected: all tests pass (same count as before this task).

- [ ] **Step 4: Commit**

```bash
git add src/tools/prefab-inspect.ts
git commit -m "refactor: prefab-inspect imports from shared prefab-ancestry utility"
```

---

## Task 4: Add ancestry support to `prefab_create` — template layer

**Files:**
- Modify: `src/templates/prefab.ts`

Add an optional `ancestorComponents` field to `PrefabOptions` that, when provided, replaces `defaultComponents` from the config.

- [ ] **Step 1: Update `PrefabOptions` and `generatePrefab`**

In `src/templates/prefab.ts`, make these changes:

1. Add `ancestorComponents?: ComponentDef[]` to `PrefabOptions`:

```typescript
export interface PrefabOptions {
  /** Prefab name (used for filename and ID) */
  name: string;
  /** Prefab template type */
  prefabType: PrefabType;
  /** Parent prefab path to inherit from (uses default per type if omitted) */
  parentPrefab?: string;
  /** Additional components to add */
  components?: ComponentDef[];
  /** Description (used for m_sDisplayName if applicable) */
  description?: string;
  /**
   * Pre-resolved ancestor components (from prefab-ancestry walkChain).
   * When provided, replaces the hardcoded defaultComponents for this prefab type.
   * GUIDs are preserved so they act as override slots in the Enfusion delta model.
   */
  ancestorComponents?: ComponentDef[];
}
```

2. Update the component assembly inside `generatePrefab` (replace the `const allComponents` line):

```typescript
  // Use resolved ancestor components if provided, otherwise fall back to type defaults
  const baseComponents: ComponentDef[] = opts.ancestorComponents ?? config.defaultComponents;
  const allComponents: ComponentDef[] = [
    ...baseComponents,
    ...(opts.components ?? []),
  ];
```

3. When building component nodes, preserve GUIDs from `ancestorComponents`. Update the `for (const comp of allComponents)` loop:

```typescript
  for (const comp of allComponents) {
    // Preserve GUID if provided (ancestor components carry their original GUID)
    const compGuid = comp.guid ?? generateGuid();
    const compNode = createNode(comp.type, {
      id: `{${compGuid}}`,
    });

    if (comp.properties) {
      for (const [key, value] of Object.entries(comp.properties)) {
        compNode.properties.push({ key, value });
      }
    }

    componentNodes.push(compNode);
  }
```

4. Add `guid?: string` to the `ComponentDef` interface:

```typescript
export interface ComponentDef {
  type: string;
  guid?: string;
  properties?: Record<string, string>;
}
```

- [ ] **Step 2: Build to verify**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npm run build 2>&1 | tail -20
```

Expected: clean build.

- [ ] **Step 3: Add tests for `ancestorComponents` path**

In `tests/templates/prefab.test.ts`, add at the end of the `generatePrefab` describe block:

```typescript
  it("uses ancestorComponents instead of type defaults when provided", () => {
    const text = generatePrefab({
      name: "Test",
      prefabType: "character",
      ancestorComponents: [
        { type: "CustomComponent", guid: "AAAAAAAAAAAAAAAA", properties: {} },
      ],
    });
    const node = parse(text);
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    // ancestorComponents replaces defaults — InventoryStorageManagerComponent should NOT be present
    expect(comps!.children.find((c) => c.type === "InventoryStorageManagerComponent")).toBeUndefined();
    // Custom component should be present
    const custom = comps!.children.find((c) => c.type === "CustomComponent");
    expect(custom).toBeDefined();
    // GUID should be preserved from ancestorComponents
    expect(custom!.id).toBe("{AAAAAAAAAAAAAAAA}");
  });

  it("appends user components after ancestorComponents", () => {
    const text = generatePrefab({
      name: "Test",
      prefabType: "generic",
      ancestorComponents: [
        { type: "MeshObject", guid: "AAAAAAAAAAAAAAAA" },
      ],
      components: [
        { type: "RigidBody" },
      ],
    });
    const node = parse(text);
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    expect(comps!.children.find((c) => c.type === "MeshObject")).toBeDefined();
    expect(comps!.children.find((c) => c.type === "RigidBody")).toBeDefined();
  });
```

- [ ] **Step 4: Run template tests**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npx vitest run tests/templates/prefab.test.ts
```

Expected: all tests pass including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/templates/prefab.ts tests/templates/prefab.test.ts
git commit -m "feat: prefab template accepts ancestorComponents to override type defaults"
```

---

## Task 5: Wire ancestry into `prefab_create`

**Files:**
- Modify: `src/tools/prefab-create.ts`

- [ ] **Step 1: Update `prefab-create.ts`**

Replace the full content of `src/tools/prefab-create.ts` with:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Config } from "../config.js";
import {
  generatePrefab,
  getPrefabSubdirectory,
  getPrefabFilename,
  type PrefabType,
  type ComponentDef,
} from "../templates/prefab.js";
import { walkChain, mergeAncestryComponents } from "../utils/prefab-ancestry.js";
import { validateFilename } from "../utils/safe-path.js";

export function registerPrefabCreate(server: McpServer, config: Config): void {
  server.registerTool(
    "prefab_create",
    {
      description:
        "Create a new Entity Template (.et) prefab file for an Arma Reforger mod. Generates a properly structured prefab with components in valid Enfusion text serialization format. " +
        "When parentPrefab is provided, automatically resolves the full ancestor chain and pre-populates inherited components (set includeAncestry=false to skip). " +
        "IMPORTANT: For 'interactive' and other visible prefabs, the MeshObject component MUST have its 'Object' property set to a base game .xob model path (e.g., '{5F4C4181F065B447}Assets/Props/Military/Barrels/BarrelGreen_01.xob') or the entity will be invisible in-game. Use api_search to find model paths.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Prefab name (e.g., 'MySpawnPoint', 'CustomVehicle')"),
        prefabType: z
          .enum([
            "character",
            "vehicle",
            "weapon",
            "spawnpoint",
            "gamemode",
            "interactive",
            "generic",
          ])
          .describe(
            "Prefab template type. Determines the root entity type, default components, and file location."
          ),
        parentPrefab: z
          .string()
          .optional()
          .describe(
            "Parent prefab to inherit from (e.g., '{GUID}Prefabs/Weapons/AK47.et'). Omit to create a standalone prefab."
          ),
        components: z
          .array(
            z.object({
              type: z.string().describe("Component class name (e.g., 'RigidBody', 'MeshObject')"),
              properties: z
                .record(z.string())
                .optional()
                .describe("Component property key-value pairs"),
            })
          )
          .optional()
          .describe("Additional components to add beyond the defaults for this prefab type"),
        description: z
          .string()
          .optional()
          .describe(
            "Description for the prefab. Used as the display name in Game Master."
          ),
        includeAncestry: z
          .boolean()
          .default(true)
          .describe(
            "When parentPrefab is provided, resolve the full ancestor chain and pre-populate inherited components. " +
            "Defaults to true. Set false to skip ancestry resolution (uses hardcoded template defaults instead)."
          ),
        projectPath: z
          .string()
          .optional()
          .describe("Addon root path. Uses configured default if omitted."),
      },
    },
    async ({ name, prefabType, parentPrefab, components, description, includeAncestry, projectPath }) => {
      const basePath = projectPath || config.projectPath;

      try {
        validateFilename(name);

        // Resolve ancestry if parentPrefab is given and includeAncestry is not disabled
        let ancestorComponents: ComponentDef[] | undefined;
        let ancestryNote = "";

        if (parentPrefab && includeAncestry !== false) {
          const { levels, warnings } = walkChain(parentPrefab, config, projectPath);
          if (levels.length > 0) {
            const merged = mergeAncestryComponents(levels);
            ancestorComponents = Array.from(merged.values()).map(({ comp }) => ({
              type: comp.typeName,
              guid: comp.guid,
              properties: {},
            }));
            ancestryNote = `\n\nAncestry resolved: ${levels.length} ancestor level(s), ${ancestorComponents.length} inherited component(s) pre-populated.`;
            if (warnings.length > 0) {
              ancestryNote += `\nWarnings: ${warnings.join("; ")}`;
            }
          } else {
            ancestryNote = `\n\nAncestry resolution unavailable (game files not found). Using template defaults.`;
            if (warnings.length > 0) {
              ancestryNote += ` Warnings: ${warnings.join("; ")}`;
            }
          }
        }

        const content = generatePrefab({
          name,
          prefabType: prefabType as PrefabType,
          parentPrefab,
          components: components as ComponentDef[] | undefined,
          description,
          ancestorComponents,
        });

        if (basePath) {
          const subdir = getPrefabSubdirectory(prefabType as PrefabType);
          const filename = getPrefabFilename(name);
          const targetDir = resolve(basePath, subdir);
          const targetPath = join(targetDir, filename);

          mkdirSync(targetDir, { recursive: true });

          if (existsSync(targetPath)) {
            return {
              content: [
                {
                  type: "text",
                  text: `File already exists: ${subdir}/${filename}\n\nGenerated content (not written):\n\n\`\`\`\n${content}\n\`\`\``,
                },
              ],
            };
          }

          writeFileSync(targetPath, content, "utf-8");

          const meshWarning = (prefabType === "interactive" || prefabType === "generic")
            ? "\n\nIMPORTANT: The MeshObject 'Object' property is empty. You MUST set it to a base game .xob model path (e.g., '{5F4C4181F065B447}Assets/Props/Military/Barrels/BarrelGreen_01.xob') or the entity will be INVISIBLE in-game. Use project_write to update the prefab."
            : "";

          return {
            content: [
              {
                type: "text",
                text: `Prefab created: ${subdir}/${filename}\n\n\`\`\`\n${content}\n\`\`\`${meshWarning}${ancestryNote}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Generated prefab (no project path configured — not written to disk):\n\n\`\`\`\n${content}\n\`\`\`\n\nSet ENFUSION_PROJECT_PATH to write files automatically.${ancestryNote}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error creating prefab: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npm run build 2>&1 | tail -20
```

Expected: clean build.

- [ ] **Step 3: Run full test suite**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/prefab-create.ts
git commit -m "feat: prefab_create resolves ancestry when parentPrefab is provided"
```

---

## Task 6: Wire ancestry into `game_duplicate`

**Files:**
- Modify: `src/tools/game-duplicate.ts`

- [ ] **Step 1: Update `game-duplicate.ts`**

Replace the full content of `src/tools/game-duplicate.ts` with:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import type { WorkbenchClient } from "../workbench/client.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { resolveGameDataPath, findLooseFile, resolveAddonDir } from "../utils/game-paths.js";
import { generateGuid } from "../formats/guid.js";
import { parse, serialize, createNode } from "../formats/enfusion-text.js";
import {
  walkChain,
  mergeAncestryComponents,
  parseComponents,
  stripGuid,
} from "../utils/prefab-ancestry.js";

export function registerGameDuplicate(
  server: McpServer,
  config: Config,
  client: WorkbenchClient
): void {
  server.registerTool(
    "game_duplicate",
    {
      description:
        "Duplicate a base game prefab (.et) or config (.conf) into your mod folder for editing. " +
        "Reads the file from game data or .pak archives, resolves the full ancestor chain, and injects " +
        "inherited components so the duplicate is a complete representation of what the entity provides. " +
        "Writes the file to your mod's directory, then registers it with Workbench so it gets a new resource GUID. " +
        "Mirrors the Workbench right-click → Duplicate workflow. " +
        "Set flatten=true to bake all ancestor components into a standalone prefab with no parent reference. " +
        "Use asset_search to find the source path (with GUID) first.",
      inputSchema: {
        sourcePath: z
          .string()
          .describe(
            "Source prefab path — either a GUID reference like '{657590C1EC9E27D3}Prefabs/Groups/OPFOR/Group_USSR_LightFireTeam.et' " +
            "or a bare relative path like 'Prefabs/Groups/OPFOR/Group_USSR_LightFireTeam.et'"
          ),
        destPath: z
          .string()
          .describe(
            "Destination path within your mod folder, relative to the addon root " +
            "(e.g., 'Prefabs/Groups/MyCustomGroup.et'). Must end in .et"
          ),
        modName: z
          .string()
          .optional()
          .describe(
            "Addon folder name under ENFUSION_PROJECT_PATH (e.g., 'MyMod'). " +
            "If omitted, the first addon found in the project path is used."
          ),
        flatten: z
          .boolean()
          .default(false)
          .describe(
            "When false (default), keeps the parent reference and includes ancestor components as overridable " +
            "entries with original GUIDs preserved. " +
            "When true, strips the parent reference and bakes all ancestor components into the copy, producing " +
            "a fully standalone prefab."
          ),
        register: z
          .boolean()
          .default(true)
          .describe(
            "Register the duplicated file with Workbench after writing (assigns a new GUID). " +
            "Requires Workbench to be running. Set false to write the file without registering."
          ),
      },
    },
    async ({ sourcePath, destPath, modName, flatten, register }) => {
      // Strip GUID prefix from sourcePath if present: {GUID}path → path
      const bareSourcePath = sourcePath.replace(/^\{[0-9A-Fa-f]{16}\}/, "");

      // Locate the source file — extracted library first, then pak loose files
      let sourceFile: string | null = null;
      let sourceLabel = "";

      if (config.extractedPath && existsSync(config.extractedPath)) {
        sourceFile = findLooseFile(config.extractedPath, bareSourcePath);
        if (sourceFile) sourceLabel = "(extracted library)";
      }

      if (!sourceFile) {
        const gameDataPath = resolveGameDataPath(config.gamePath);
        if (!gameDataPath) {
          return {
            content: [{ type: "text", text: `Base game not found at ${config.gamePath}.` }],
            isError: true,
          };
        }
        sourceFile = findLooseFile(gameDataPath, bareSourcePath);
        if (sourceFile) sourceLabel = "(pak loose files)";
      }

      if (!sourceFile) {
        return {
          content: [
            {
              type: "text",
              text: `Source file not found: ${bareSourcePath}\n` +
                (config.extractedPath ? `Searched extracted library: ${config.extractedPath}\n` : "") +
                `Searched pak loose files under: ${config.gamePath}\n` +
                `Use asset_search to verify the path exists.`,
            },
          ],
          isError: true,
        };
      }

      // Resolve destination addon directory
      const addonDir = resolveAddonDir(config.projectPath, modName);
      if (!addonDir) {
        return {
          content: [
            {
              type: "text",
              text: `Could not find addon directory. ` +
                (modName
                  ? `'${modName}' not found under ${config.projectPath}`
                  : `No addons found under ${config.projectPath}`) +
                `. Provide modName matching the addon folder name.`,
            },
          ],
          isError: true,
        };
      }

      // Validate and resolve the destination path
      let absDestPath: string;
      try {
        absDestPath = validateProjectPath(addonDir, destPath);
      } catch {
        return {
          content: [{ type: "text", text: `Invalid destination path: ${destPath}` }],
          isError: true,
        };
      }

      if (existsSync(absDestPath)) {
        return {
          content: [{ type: "text", text: `Destination already exists: ${absDestPath}` }],
          isError: true,
        };
      }

      // Read source content
      let rawContent: string;
      try {
        rawContent = readFileSync(sourceFile, "utf-8");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Failed to read source file: ${msg}` }],
          isError: true,
        };
      }

      // Resolve ancestry and inject inherited components
      let ancestryNote = "";
      let finalContent = rawContent;

      // Only apply ancestry for .et prefab files, not .conf
      if (bareSourcePath.endsWith(".et")) {
        const { levels, warnings } = walkChain(bareSourcePath, config);

        if (levels.length > 1) {
          // Parse source into node tree
          let rootNode = parse(rawContent);

          // Get merged components from full ancestry
          const merged = mergeAncestryComponents(levels);

          // Get GUIDs already present in the source file
          const existingGuids = new Set(parseComponents(rawContent).keys());

          // Find or create the components child node
          let componentsNode = rootNode.children.find((c) => c.type === "components");
          const injected: string[] = [];

          for (const [guid, { comp, source }] of merged) {
            if (existingGuids.has(guid)) continue; // already declared in leaf
            if (source.depth === levels.length - 1) continue; // it's in the leaf itself

            // Build a minimal component node with the original GUID preserved
            const compNode = createNode(comp.typeName, { id: `{${comp.guid}}` });
            if (!componentsNode) {
              componentsNode = createNode("components");
              rootNode.children.push(componentsNode);
            }
            componentsNode.children.push(compNode);
            injected.push(`${comp.typeName} (from [${source.depth}] ${source.path})`);
          }

          // If flatten, strip parent reference
          if (flatten) {
            rootNode = { ...rootNode, inheritance: undefined };
          }

          finalContent = serialize(rootNode);

          const levelCount = levels.length;
          ancestryNote = `\n\nAncestry: resolved ${levelCount} level(s), injected ${injected.length} inherited component(s).`;
          if (injected.length > 0) {
            ancestryNote += `\nInjected: ${injected.join(", ")}`;
          }
          if (flatten) {
            ancestryNote += `\nParent reference stripped (flatten=true).`;
          }
          if (warnings.length > 0) {
            ancestryNote += `\nWarnings: ${warnings.join("; ")}`;
          }
        }
      }

      // Replace the ID field (entity GUID) with a fresh one so the duplicate is independent
      const newEntityId = generateGuid();
      finalContent = finalContent.replace(/^(\s*ID\s+")[0-9A-Fa-f]{16}(")/m, `$1${newEntityId}$2`);

      try {
        mkdirSync(dirname(absDestPath), { recursive: true });
        writeFileSync(absDestPath, finalContent, "utf-8");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Failed to write file: ${msg}` }],
          isError: true,
        };
      }

      // Register with Workbench to assign a new GUID (if requested)
      if (register) {
        try {
          const regResp = await client.call<{ status: string; message?: string }>(
            "EMCP_WB_Resources",
            { action: "register", path: absDestPath, buildRuntime: false }
          );

          const guidNote = regResp.status === "ok"
            ? `Registered with Workbench — a new GUID has been assigned.`
            : `Warning: registration returned: ${regResp.message ?? JSON.stringify(regResp)}`;

          return {
            content: [
              {
                type: "text",
                text: [
                  `**Prefab duplicated successfully**`,
                  `- Source: ${sourcePath}`,
                  `- Copied from: ${sourceFile} ${sourceLabel}`,
                  `- Saved to: ${absDestPath}`,
                  ``,
                  guidNote,
                  `Use wb_resources getInfo or wb_prefabs getGuid to look up the new GUID.`,
                  ``,
                  `**Next steps:**`,
                  `1. Edit the .et file to customize it.`,
                  `2. Reference it as {GUID}${destPath} in your prefabs.`,
                ].join("\n") + ancestryNote,
              },
            ],
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [
              {
                type: "text",
                text: [
                  `**File copied but Workbench registration failed**`,
                  `- Saved to: ${absDestPath}`,
                  `- Registration error: ${msg}`,
                  ``,
                  `To assign a GUID manually: in Workbench Resource Browser, right-click the file and register it.`,
                ].join("\n") + ancestryNote,
              },
            ],
            isError: true,
          };
        }
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `**Prefab copied (not registered)**`,
              `- Source: ${sourcePath}`,
              `- Saved to: ${absDestPath}`,
              ``,
              `To assign a GUID: call again with register=true, or register manually in Workbench.`,
            ].join("\n") + ancestryNote,
          },
        ],
      };
    }
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npm run build 2>&1 | tail -20
```

Expected: clean build.

- [ ] **Step 3: Run full test suite**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/game-duplicate.ts
git commit -m "feat: game_duplicate injects ancestor components and supports flatten mode"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full clean build**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npm run build 2>&1
```

Expected: zero TypeScript errors.

- [ ] **Step 2: Full test run with verbose output**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" && npx vitest run --reporter=verbose
```

Expected: all tests pass. Note the total pass count.

- [ ] **Step 3: Mark #15 done in UPGRADE_IDEAS.md**

In `UPGRADE_IDEAS.md`, update the heading and summary table entry for item 15:

Heading (line ~227):
```markdown
### ~~15. Prefab Introspection + Ancestry Resolver~~ ✅ Done
```

Summary table row:
```markdown
| ~~15~~ | ~~Prefab Introspection + Ancestry~~ ✅ | M | Modder Workflow | L1+L2 merged |
```

- [ ] **Step 4: Commit**

```bash
git add UPGRADE_IDEAS.md
git commit -m "docs: mark upgrade #15 prefab ancestry resolver as done"
```
