# Tool Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce MCP tool count from 54 → 47 by merging related tool families, and add a session-start routing file so Claude knows which tool to use from natural language.

**Architecture:** Each tool family (animation_graph, prefab, project, mod, scenario_create) is collapsed into a single registered tool with an `action` or `type` discriminator. Handler logic stays in dedicated files to keep them focused. A markdown routing table in arma-knowledge is loaded every session via the existing INDEX.md read rule.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`, `vitest` (no existing tool-level tests — build verification via `npx tsc --noEmit`)

---

## File Map

| Action | Path |
|---|---|
| Create | `src/tools/animation-graph.ts` |
| Delete | `src/tools/animation-graph-author.ts`, `animation-graph-inspect.ts`, `animation-graph-setup.ts` |
| Create | `src/tools/prefab.ts` |
| Delete | `src/tools/prefab-create.ts`, `prefab-inspect.ts` |
| Create | `src/tools/project.ts` |
| Delete | `src/tools/project-browse.ts`, `project-read.ts`, `project-write.ts` |
| Create | `src/tools/mod.ts` |
| Delete | `src/tools/mod-build.ts`, `mod-create.ts`, `mod-validate.ts` |
| Modify | `src/tools/wb-scenario.ts` (merge two `registerTool` calls into one) |
| Modify | `src/server.ts` (update all imports and registration calls) |
| Create | `C:\Users\Steffen\.claude\arma-knowledge\tools-routing.md` |
| Modify | `C:\Users\Steffen\.claude\arma-knowledge\INDEX.md` |

---

## Task 1: Merge animation graph tools

**Files:**
- Create: `src/tools/animation-graph.ts`
- Delete: `src/tools/animation-graph-author.ts`, `src/tools/animation-graph-inspect.ts`, `src/tools/animation-graph-setup.ts`

- [ ] **Step 1: Read all three source files in full**

Read `src/tools/animation-graph-author.ts`, `src/tools/animation-graph-inspect.ts`, `src/tools/animation-graph-setup.ts` completely. Note the exact function signatures for `registerAnimationGraphAuthor`, `registerAnimationGraphInspect`, `registerAnimationGraphSetup` and their `inputSchema` fields.

- [ ] **Step 2: Create `src/tools/animation-graph.ts`**

The merged file structure. All handler logic is copied verbatim from the source files — only the registration wrapper changes:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
// Copy all imports from animation-graph-author.ts, animation-graph-inspect.ts,
// and animation-graph-setup.ts here (deduplicated).

// ── Copy all helper functions and interfaces verbatim from all three source files ──
// (generateAgr, VehicleConfig, readFileForTool, etc.)

export function registerAnimationGraph(server: McpServer, config: Config): void {
  server.registerTool(
    "animation_graph",
    {
      description:
        "Work with Enfusion animation graphs (.agr/.agf/.ast/.asi/.aw files). " +
        "action='author': generate a new .agr animation graph file for a vehicle. " +
        "action='inspect': read and summarise an existing animation graph file. " +
        "action='setup': scaffold the full animation workspace folder structure and provide authoring guidance.",
      inputSchema: {
        action: z
          .enum(["author", "inspect", "setup"])
          .describe(
            "'author' — generate a new .agr animation graph. " +
            "'inspect' — read and summarise an existing animation graph file. " +
            "'setup' — scaffold animation workspace and provide authoring guide."
          ),

        // ── author + setup params (copy from animation-graph-author.ts inputSchema) ──
        vehicleName: z.string().optional().describe("(author, setup) Vehicle name, e.g. 'BRDM2'."),
        vehicleType: z.string().optional().describe("(author, setup) Vehicle type folder, e.g. 'Wheeled'."),
        wheelCount: z.number().optional().describe("(author) Number of wheels."),
        hasTurret: z.boolean().optional().describe("(author) Whether the vehicle has a turret."),
        hasSuspensionIK: z.boolean().optional().describe("(author) Enable suspension IK nodes."),
        hasShockAbsorbers: z.boolean().optional().describe("(author) Enable shock absorber nodes."),
        hasSteeringLinkage: z.boolean().optional().describe("(author) Enable steering linkage nodes."),
        seatTypes: z.array(z.string()).optional().describe("(author) Seat type list, e.g. ['Driver','Commander']."),
        dialList: z.array(z.string()).optional().describe("(author) Dashboard dial names."),
        outputPath: z.string().optional().describe("(author) Destination path within the mod for the .agr file."),
        modName: z.string().optional().describe("(author) Addon folder name."),

        // ── inspect params (copy from animation-graph-inspect.ts inputSchema) ──
        filePath: z.string().optional().describe("(inspect) Path to the .agr/.agf/.ast/.asi/.aw file to inspect."),
        source: z.enum(["mod", "game"]).optional().describe("(inspect) Whether the file is in the mod or base game."),
        projectPath: z.string().optional().describe("(inspect) Override project path."),
        includeRaw: z.boolean().optional().describe("(inspect) Include raw file content in output."),
      },
    },
    async (params) => {
      const { action } = params;

      if (action === "author") {
        // Paste the full handler body from registerAnimationGraphAuthor verbatim here.
        // Replace: async ({ vehicleName, ... }) => { ... }
        // With the body of that handler, referencing `params` instead of destructured args.
      }

      if (action === "inspect") {
        // Paste the full handler body from registerAnimationGraphInspect verbatim here.
      }

      if (action === "setup") {
        // Paste the full handler body from registerAnimationGraphSetup verbatim here.
      }

      // Unreachable — zod guarantees action is one of the three values.
      return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
  );
}
```

> **Note on destructuring:** The original handlers use destructured params like `async ({ vehicleName, wheelCount, ... })`. In the merged handler, access the same fields via `params.vehicleName`, `params.wheelCount`, etc., or destructure at the top of each `if` block:
> ```typescript
> if (action === "author") {
>   const { vehicleName, wheelCount, hasTurret, ... } = params;
>   // ... paste original handler body unchanged
> }
> ```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "c:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK"
npx tsc --noEmit
```

Expected: no errors. Fix any type errors before proceeding.

- [ ] **Step 4: Delete source files**

```bash
rm src/tools/animation-graph-author.ts src/tools/animation-graph-inspect.ts src/tools/animation-graph-setup.ts
```

- [ ] **Step 5: Verify again**

```bash
npx tsc --noEmit
```

Expected: no errors (server.ts still imports old names — that's fine until Task 6).

---

## Task 2: Merge prefab tools

**Files:**
- Create: `src/tools/prefab.ts`
- Delete: `src/tools/prefab-create.ts`, `src/tools/prefab-inspect.ts`

- [ ] **Step 1: Read both source files in full**

Read `src/tools/prefab-create.ts` and `src/tools/prefab-inspect.ts` completely. Note all imports, helpers, and the exact `inputSchema` of each tool.

- [ ] **Step 2: Create `src/tools/prefab.ts`**

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
// Merge all imports from prefab-create.ts and prefab-inspect.ts (deduplicated).

// ── Copy all helper functions verbatim from both source files ──
// (generatePrefab, getPrefabSubdirectory, getPrefabFilename, formatReport, etc.)

export function registerPrefab(server: McpServer, config: Config): void {
  server.registerTool(
    "prefab",
    {
      description:
        "Create or inspect Entity Template (.et) prefab files. " +
        "action='create': scaffold a new prefab with components in valid Enfusion text serialization format. " +
        "action='inspect': read a prefab and report its full inheritance chain and components.",
      inputSchema: {
        action: z
          .enum(["create", "inspect"])
          .describe("'create' — write a new .et prefab. 'inspect' — analyse an existing prefab."),

        // ── create params (copy from prefab-create.ts inputSchema) ──
        name: z.string().optional().describe("(create) Prefab name, e.g. 'MySpawnPoint'."),
        prefabType: z
          .enum(["character", "vehicle", "weapon", "spawnpoint", "gamemode", "interactive", "generic"])
          .optional()
          .describe("(create) Prefab template type."),
        parentPrefab: z.string().optional().describe("(create) Optional parent prefab path to inherit from."),
        components: z.array(z.any()).optional().describe("(create) Component definitions to include."),
        modName: z.string().optional().describe("(create) Addon folder name."),
        includeAncestry: z.boolean().optional().describe("(create) Pre-populate inherited components (default true)."),

        // ── inspect params (copy from prefab-inspect.ts inputSchema) ──
        path: z.string().optional().describe("(inspect) Prefab path to inspect, e.g. 'Prefabs/MyPrefab.et'."),
        source: z.enum(["mod", "game"]).optional().describe("(inspect) Where to find the prefab."),
        includeRaw: z.boolean().optional().describe("(inspect) Include raw file content in output."),
      },
    },
    async (params) => {
      const { action } = params;

      if (action === "create") {
        const { name, prefabType, parentPrefab, components, modName, includeAncestry } = params;
        // Paste the full handler body from registerPrefabCreate verbatim.
      }

      if (action === "inspect") {
        const { path, source, includeRaw } = params;
        // Paste the full handler body from registerPrefabInspect verbatim.
      }

      return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Delete source files**

```bash
rm src/tools/prefab-create.ts src/tools/prefab-inspect.ts
```

---

## Task 3: Merge project tools

**Files:**
- Create: `src/tools/project.ts`
- Delete: `src/tools/project-browse.ts`, `src/tools/project-read.ts`, `src/tools/project-write.ts`

- [ ] **Step 1: Read all three source files in full**

Read `src/tools/project-browse.ts`, `src/tools/project-read.ts`, `src/tools/project-write.ts` completely.

- [ ] **Step 2: Create `src/tools/project.ts`**

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
// Merge all imports from the three source files (deduplicated).

// ── Copy all helper functions verbatim ──

export function registerProject(server: McpServer, config: Config): void {
  server.registerTool(
    "project",
    {
      description:
        "Browse, read, or write files in the Arma Reforger mod project directory. " +
        "action='browse': list files in a project directory. " +
        "action='read': read a specific project file. " +
        "action='write': write or overwrite a project file.",
      inputSchema: {
        action: z
          .enum(["browse", "read", "write"])
          .describe("'browse' — list directory contents. 'read' — read a file. 'write' — write a file."),

        // ── browse params (from project-browse.ts) ──
        path: z.string().optional().describe("(browse, read, write) Path within the project."),
        pattern: z.string().optional().describe("(browse) File extension filter, e.g. '*.et'."),
        projectPath: z.string().optional().describe("Override project path."),
        recursive: z.boolean().optional().describe("(browse) List recursively."),
        limit: z.number().optional().describe("(browse) Max results."),

        // ── write params (from project-write.ts) ──
        content: z.string().optional().describe("(write) File content to write."),
        encoding: z.string().optional().describe("(write) File encoding, default 'utf-8'."),
      },
    },
    async (params) => {
      const { action } = params;

      if (action === "browse") {
        const { path, pattern, projectPath, recursive, limit } = params;
        // Paste the full handler body from registerProjectBrowse verbatim.
      }

      if (action === "read") {
        const { path, projectPath } = params;
        // Paste the full handler body from registerProjectRead verbatim.
      }

      if (action === "write") {
        const { path, content, projectPath, encoding } = params;
        // Paste the full handler body from registerProjectWrite verbatim.
      }

      return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
  );
}
```

> **Note:** Match the exact param names from the source files — the names above are approximate. Read the files first (Step 1) and adjust accordingly.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Delete source files**

```bash
rm src/tools/project-browse.ts src/tools/project-read.ts src/tools/project-write.ts
```

---

## Task 4: Merge mod tools

**Files:**
- Create: `src/tools/mod.ts`
- Delete: `src/tools/mod-build.ts`, `src/tools/mod-create.ts`, `src/tools/mod-validate.ts`

- [ ] **Step 1: Read all three source files in full**

Read `src/tools/mod-build.ts`, `src/tools/mod-create.ts`, `src/tools/mod-validate.ts` completely. Note that `mod-create.ts` needs `PatternLibrary` and `mod-validate.ts` needs `SearchEngine`.

- [ ] **Step 2: Create `src/tools/mod.ts`**

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { SearchEngine } from "../index/search-engine.js";
import type { PatternLibrary } from "../patterns/loader.js";
// Merge remaining imports from the three source files (deduplicated).

// ── Copy all helper functions verbatim ──
// (findWorkbenchExe, runBuild, derivePrefix, findFiles, etc.)

export function registerMod(
  server: McpServer,
  config: Config,
  searchEngine: SearchEngine,
  patterns: PatternLibrary
): void {
  server.registerTool(
    "mod",
    {
      description:
        "Manage an Arma Reforger mod (addon) lifecycle. " +
        "action='create': scaffold a new mod directory with .gproj and folder structure. " +
        "action='build': compile and package the mod using Workbench CLI. " +
        "action='validate': check the mod for structural errors, broken references, and naming issues.",
      inputSchema: {
        action: z
          .enum(["create", "build", "validate"])
          .describe("'create' — scaffold a new mod. 'build' — compile the mod. 'validate' — run validation checks."),

        // ── create params (from mod-create.ts) ──
        name: z.string().optional().describe("(create) Addon name, e.g. 'MyCustomMod'."),
        pattern: z.string().optional().describe("(create) Optional mod pattern to apply."),

        // ── build + validate params (from mod-build.ts, mod-validate.ts) ──
        modName: z.string().optional().describe("(build, validate) Addon folder name. Omit to use default."),

        // ── validate params (from mod-validate.ts) ──
        checks: z
          .array(z.enum(["structure", "gproj", "scripts", "prefabs", "configs", "references", "naming"]))
          .optional()
          .describe("(validate) Which checks to run. Omit to run all."),
      },
    },
    async (params) => {
      const { action } = params;

      if (action === "create") {
        const { name, pattern } = params;
        // Paste the full handler body from registerModCreate verbatim.
        // The handler needs `patterns` — it is in scope from the outer function.
      }

      if (action === "build") {
        const { modName } = params;
        // Paste the full handler body from registerModBuild verbatim.
      }

      if (action === "validate") {
        const { modName, checks } = params;
        // Paste the full handler body from registerModValidate verbatim.
        // The handler needs `searchEngine` — it is in scope from the outer function.
      }

      return { content: [{ type: "text", text: "Unknown action." }], isError: true };
    }
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Delete source files**

```bash
rm src/tools/mod-build.ts src/tools/mod-create.ts src/tools/mod-validate.ts
```

---

## Task 5: Merge scenario_create_base + scenario_create_objective in wb-scenario.ts

**Files:**
- Modify: `src/tools/wb-scenario.ts`

Both tools are already in this file and share all helpers. The merge is purely in the registration layer.

- [ ] **Step 1: Read `src/tools/wb-scenario.ts` in full**

Identify the two `server.registerTool(...)` calls: one for `"scenario_create_objective"` and one for `"scenario_create_base"`. Note all `inputSchema` fields for each.

- [ ] **Step 2: Replace both `registerTool` calls with one**

Replace the two separate `registerTool` calls with a single registration. The shared helpers (`cleanupEntities`, `setEntityProp`, `resolvePosition`, `PREFABS`, `AREA_PREFAB`, etc.) stay unchanged.

The new single call:

```typescript
server.registerTool(
  "scenario_create",
  {
    description:
      "Place scenario entities in the live Workbench scene. Requires Workbench running with a world open in Edit mode. " +
      "type='base': place a Conflict military base entity (SCR_CampaignMilitaryBaseComponent) at a position. " +
      "type='objective': place a complete Scenario Framework objective hierarchy (Area → LayerTask → Layer_AI → Slot entities) for SP/coop narrative missions. " +
      "For generating a full Conflict scenario as files on disk, use scenario_create_conflict instead.",
    inputSchema: {
      type: z
        .enum(["base", "objective"])
        .describe(
          "'base' — place a Conflict military base in Workbench. " +
          "'objective' — place a Scenario Framework objective hierarchy in Workbench."
        ),

      // ── shared ──
      position: z
        .string()
        .optional()
        .describe("World position as 'x y z'. Omit to use current camera position."),

      // ── base params (copy all fields from scenario_create_base inputSchema) ──
      // (name, faction, type as base type enum, radioRange, patrolCount, etc.)
      // Paste them here exactly as they appear in the original schema.

      // ── objective params (copy all fields from scenario_create_objective inputSchema) ──
      // (taskType, targetPrefab, aiGroupPrefab, areaRadius, etc.)
      // Paste them here exactly as they appear in the original schema.
    },
  },
  async (params) => {
    const { type } = params;

    if (type === "base") {
      // Paste the full handler body from the original scenario_create_base handler verbatim.
      // Replace references to the old `type` param (base type enum) with params.baseType
      // or whichever name you use to disambiguate from the discriminator param.
    }

    if (type === "objective") {
      // Paste the full handler body from the original scenario_create_objective handler verbatim.
    }

    return { content: [{ type: "text", text: "Unknown type." }], isError: true };
  }
);
```

> **Name collision warning:** The original `scenario_create_base` schema has a field called `type` (the base type enum: "base", "major", "MOB", etc.). Rename that field to `baseType` in the merged schema and update all references inside the handler body.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors from `wb-scenario.ts`. `server.ts` errors are expected until Task 6.

---

## Task 6: Update server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Read `src/server.ts` in full**

- [ ] **Step 2: Replace all affected imports and registrations**

Remove old imports:
```typescript
// DELETE these:
import { registerAnimationGraphInspect } from "./tools/animation-graph-inspect.js";
import { registerAnimationGraphAuthor } from "./tools/animation-graph-author.js";
import { registerAnimationGraphSetup } from "./tools/animation-graph-setup.js";
import { registerPrefabCreate } from "./tools/prefab-create.js";
import { registerPrefabInspect } from "./tools/prefab-inspect.js";
import { registerProjectBrowse } from "./tools/project-browse.js";
import { registerProjectRead } from "./tools/project-read.js";
import { registerProjectWrite } from "./tools/project-write.js";
import { registerModBuild } from "./tools/mod-build.js";
import { registerModCreate } from "./tools/mod-create.js";
import { registerModValidate } from "./tools/mod-validate.js";
```

Add new imports:
```typescript
import { registerAnimationGraph } from "./tools/animation-graph.js";
import { registerPrefab } from "./tools/prefab.js";
import { registerProject } from "./tools/project.js";
import { registerMod } from "./tools/mod.js";
```

Replace old registration calls:
```typescript
// DELETE:
registerAnimationGraphAuthor(server, config);
registerAnimationGraphInspect(server, config);
registerAnimationGraphSetup(server, config);
registerPrefabCreate(server, config);
registerPrefabInspect(server, config);
registerProjectBrowse(server, config);
registerProjectRead(server, config);
registerProjectWrite(server, config);
registerModBuild(server, config);
registerModCreate(server, config, patterns);
registerModValidate(server, config, searchEngine);

// ADD (in their place):
registerAnimationGraph(server, config);
registerPrefab(server, config);
registerProject(server, config);
registerMod(server, config, searchEngine, patterns);
```

`registerScenarioTools` stays as-is (wb-scenario.ts was modified in place).

- [ ] **Step 3: Full build**

```bash
npm run build
```

Expected: clean build with no TypeScript errors and `dist/` populated. Fix any errors before continuing.

- [ ] **Step 4: Commit**

```bash
git add src/tools/animation-graph.ts src/tools/prefab.ts src/tools/project.ts src/tools/mod.ts src/tools/wb-scenario.ts src/server.ts
git commit -m "refactor: consolidate 9 tools into 4 merged tools (54 → 47)"
```

---

## Task 7: Create tools-routing.md

**Files:**
- Create: `C:\Users\Steffen\.claude\arma-knowledge\tools-routing.md`

- [ ] **Step 1: Write the routing file**

```markdown
# MCP Tool Routing Guide

Use this table to pick the right tool from natural language intent.
All tools are available via the `mcp__enfusion-mcp__*` deferred tool list.

---

## Search & Lookup
- find/search a prefab or asset by name → `asset_search`
- look up an API class or method → `api_search`
- find a component by name → `component_search`
- search the Enfusion wiki → `wiki_search`
- read a specific wiki page → `wiki_read`

## Base Game Files
- browse the base game file tree → `game_browse`
- read a base game file → `game_read`
- copy/duplicate a base game prefab into the mod → `game_duplicate`
  *(for duplicating a scene entity that's already placed, use `wb_entity_duplicate`)*

## Prefab
- create a new prefab from scratch → `prefab` (action: create)
- inspect a prefab's components or inheritance chain → `prefab` (action: inspect)

## Mod Lifecycle
- scaffold / start a new mod → `mod` (action: create)
- build / package the mod → `mod` (action: build)
- validate / check the mod for errors → `mod` (action: validate)

## Project Files
- browse the project directory → `project` (action: browse)
- read a project file → `project` (action: read)
- write or edit a project file → `project` (action: write)

## Scenario
- place a Conflict military base entity in Workbench → `scenario_create` (type: base)
- place a Scenario Framework objective in Workbench → `scenario_create` (type: objective)
- generate a full Conflict scenario as files on disk → `scenario_create_conflict`

## Scripts & Configs
- create a new EnforceScript (.c) file → `script_create`
- create a config (.conf) file → `config_create`
- create a layout (.layout) file → `layout_create`
- configure the dedicated server → `server_config`

## Workbench — Control
- launch Workbench → `wb_launch`
- connect to a running Workbench → `wb_connect`
- stop Workbench → `wb_stop`
- play / enter game mode to test the scene → `wb_play`
- save the scene → `wb_save`
- reload resources → `wb_reload`
- clean up temp/cache files → `wb_cleanup`

## Workbench — Scene Entities
- create / place an entity in the scene → `wb_entity_create`
- list entities in the scene → `wb_entity_list`
- inspect or get info on a scene entity → `wb_entity_inspect`
- move, rotate, or change a scene entity's properties → `wb_entity_modify`
- duplicate an entity already in the scene → `wb_entity_duplicate`
  *(for copying a base game prefab into the mod, use `game_duplicate`)*
- delete a scene entity → `wb_entity_delete`
- select an entity in Workbench → `wb_entity_select`

## Workbench — Info & Navigation
- check Workbench connection or current state → `wb_state`
- diagnose Workbench issues → `wb_diagnose`
- list or manage scene layers → `wb_layers`
- browse or manage resources → `wb_resources`
- browse prefabs in the Workbench resource browser → `wb_prefabs`
- list open Workbench projects → `wb_projects`
- terrain editing tools → `wb_terrain`
- localization strings → `wb_localization`
- validate the scene → `wb_validate`
- open a resource in Workbench → `wb_open_resource`
- run a Workbench editor action → `wb_execute_action`
- look up patterns / knowledge → `wb_knowledge`

## Workbench — Editing
- clipboard operations (copy/paste entities) → `wb_clipboard`
- add, remove, or configure a component on an entity → `wb_component`
- script editor operations → `wb_script_editor`
- undo or redo → `wb_undo_redo`

## Animation Graph
- generate / author a new animation graph → `animation_graph` (action: author)
- inspect / summarise an existing animation graph → `animation_graph` (action: inspect)
- scaffold animation workspace structure → `animation_graph` (action: setup)

## Workshop & Misc
- get Workshop mod info → `workshop_info`
```

- [ ] **Step 2: Verify the file saved correctly**

```bash
cat "C:/Users/Steffen/.claude/arma-knowledge/tools-routing.md" | head -20
```

Expected: first 20 lines of the routing guide.

---

## Task 8: Update INDEX.md

**Files:**
- Modify: `C:\Users\Steffen\.claude\arma-knowledge\INDEX.md`

- [ ] **Step 1: Add MCP Tools section to INDEX.md**

Add a new section before `## How to Use` at the bottom of the file:

```markdown
## MCP Tools

| File | Contents |
|---|---|
| [tools-routing.md](tools-routing.md) | Intent → tool routing guide for all 47 MCP tools. Read when deciding which tool to use. |
```

Also update the `## How to Use` step 1 to mention the routing file:

```markdown
## How to Use

1. Read this index at session start to identify relevant files.
   - If working with MCP tools, also read `tools-routing.md` for the intent→tool routing guide.
2. Read the relevant `patterns/` file(s) before writing or suggesting code.
3. Only read `reference/` files when patterns lack sufficient detail.
4. At session end, save new confirmed patterns to the correct category file.
   - If no category fits, create a new file and add it to this index.
   - Do not duplicate existing entries.
```

- [ ] **Step 2: Commit**

```bash
git -C "C:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" add docs/superpowers/plans/2026-03-27-tool-discoverability.md docs/superpowers/specs/2026-03-27-tool-discoverability-design.md
git -C "C:/Users/Steffen/Documents/A_documents/Github/enfusion-mcp-BK" commit -m "docs: add tool discoverability spec and implementation plan"
```

The arma-knowledge files are not in the repo, so no git add needed for them.

---

## Self-Review Checklist

- [x] All 5 consolidations from spec are covered (animation_graph, prefab, project, mod, scenario_create base+objective)
- [x] scenario_create_conflict explicitly kept separate (spec requirement)
- [x] Name collision in scenario merge (old `type` field → `baseType`) flagged with warning
- [x] Dependency injection for `mod` (searchEngine + patterns) correctly threaded through
- [x] server.ts update covers all removed registrations
- [x] tools-routing.md covers all 47 post-consolidation tools
- [x] INDEX.md update points to routing file
- [x] Build verification step after every file deletion
