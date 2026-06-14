# Tool Discoverability Design

**Date:** 2026-03-27
**Goal:** Reduce noise in the 54-tool MCP surface and give Claude upfront knowledge of what each tool does, so natural language requests route to the right tool without the user having to remember names.

---

## Problem

All 54 MCP tools are deferred — Claude sees only tool names at session start, not descriptions or parameters. With 54 names, Claude must guess which to `ToolSearch` before calling, and similar names (`game_duplicate` vs `wb_entity_duplicate`, `prefab_create` vs `prefab_inspect`) create ambiguity.

---

## Solution

Two complementary changes:

1. **Tool consolidation** — Merge tightly related tool families into single multi-action tools. Reduces 54 → 47 tools.
2. **Routing file** — Add `tools-routing.md` to `arma-knowledge/`, referenced from INDEX.md. Loaded at every session start, giving Claude a compact intent→tool cheat sheet.

---

## Part 1: Tool Consolidations

### 1.1 `animation_graph` (3 → 1)

Merge `animation_graph_author`, `animation_graph_inspect`, `animation_graph_setup` into `animation_graph` with `action: "author" | "inspect" | "setup"`.

- All three live in separate files but share the same domain (animation graph editing).
- Parameters don't conflict — each action has its own schema, dispatched on `action`.
- Implementation: keep the three handler functions, dispatch on `action` inside one registered tool.

### 1.2 `prefab` (2 → 1)

Merge `prefab_create` and `prefab_inspect` into `prefab` with `action: "create" | "inspect"`.

- Both operate on `.et` prefab files in the mod/project.
- Parameters are disjoint — `create` needs name/type/components, `inspect` needs a path.

### 1.3 `project` (3 → 1)

Merge `project_browse`, `project_read`, `project_write` into `project` with `action: "browse" | "read" | "write"`.

- All three operate on the project file tree.
- Parameters are disjoint — `browse` takes a directory, `read` takes a file path, `write` takes a path + content.

### 1.4 `mod` (3 → 1)

Merge `mod_build`, `mod_create`, `mod_validate` into `mod` with `action: "build" | "create" | "validate"`.

- All three are lifecycle operations on the mod as a whole.
- Parameters are disjoint — `create` needs a name, `build`/`validate` take optional modName.

### 1.5 `scenario_create` partial merge (3 → 2)

`scenario_create_base` and `scenario_create_objective` are Workbench entity-placers (require WB connected). Merge them into `scenario_create` with `type: "base" | "objective"`.

`scenario_create_conflict` is a standalone file generator (no WB needed, different parameter set). Keep it as `scenario_create_conflict`.

**Net result: 54 → 47 tools.**

---

## Part 2: Routing File

### Location

`C:\Users\Steffen\.claude\arma-knowledge\tools-routing.md`

Added as a pointer in `INDEX.md` under a new "MCP Tools" section so Claude reads it at every session start alongside the patterns index.

### Content structure

Grouped by user intent, not by tool name. Each entry:
```
- <natural language trigger> → <tool name> [action/type if applicable]
```

Disambiguation notes where tool names are similar (e.g. game_duplicate vs wb_entity_duplicate).

### Coverage (all 47 post-consolidation tools)

**Search & lookup**
- find/search a prefab or asset by name → `asset_search`
- look up API class or method → `api_search`
- find a component by name → `component_search`
- search the wiki → `wiki_search`
- read a specific wiki page → `wiki_read`

**Base game files**
- browse base game file tree → `game_browse`
- read a base game file → `game_read`
- copy/duplicate a base game prefab into the mod → `game_duplicate`
  *(Note: this is for base game → mod copy. For duplicating a scene entity use `wb_entity_duplicate`)*

**Prefab**
- create a new prefab from scratch → `prefab` (action: create)
- inspect a prefab's components/ancestry → `prefab` (action: inspect)

**Mod lifecycle**
- scaffold/create a new mod → `mod` (action: create)
- build/package the mod → `mod` (action: build)
- validate/check the mod for errors → `mod` (action: validate)

**Project files**
- browse project directory → `project` (action: browse)
- read a project file → `project` (action: read)
- write/edit a project file → `project` (action: write)

**Scenario**
- place a Conflict military base entity in Workbench → `scenario_create` (type: base)
- place an objective/SF task entity in Workbench → `scenario_create` (type: objective)
- generate a full Conflict scenario (files on disk) → `scenario_create_conflict`

**Scripts & configs**
- create a new EnforceScript file → `script_create`
- create a config (.conf) file → `config_create`
- create a layout (.layout) file → `layout_create`
- configure the server → `server_config`

**Workbench — control**
- launch Workbench → `wb_launch`
- connect to running Workbench → `wb_connect`
- stop Workbench → `wb_stop`
- play/test the scene → `wb_play`
- save the scene → `wb_save`
- reload resources → `wb_reload`
- clean up temp files → `wb_cleanup`

**Workbench — scene entities**
- create/place an entity in the scene → `wb_entity_create`
- list entities in the scene → `wb_entity_list`
- inspect/get info on an entity → `wb_entity_inspect`
- move, rotate, or change an entity's properties → `wb_entity_modify`
- duplicate an entity already in the scene → `wb_entity_duplicate`
  *(Note: for duplicating base game prefabs into mod use `game_duplicate`)*
- delete an entity from the scene → `wb_entity_delete`
- select an entity in Workbench → `wb_entity_select`

**Workbench — info & navigation**
- check Workbench connection/state → `wb_state`
- diagnose Workbench issues → `wb_diagnose`
- list/manage scene layers → `wb_layers`
- browse/manage resources → `wb_resources`
- browse/manage prefabs in Workbench → `wb_prefabs`
- list open Workbench projects → `wb_projects`
- terrain tools → `wb_terrain`
- localization strings → `wb_localization`
- validate the scene → `wb_validate`
- open a resource in Workbench → `wb_open_resource`
- run a Workbench action → `wb_execute_action`
- knowledge/patterns lookup → `wb_knowledge`

**Workbench — editing**
- clipboard operations → `wb_clipboard`
- add/remove/configure a component on an entity → `wb_component`
- script editor operations → `wb_script_editor`
- undo/redo → `wb_undo_redo`

**Animation graph**
- author/build an animation graph → `animation_graph` (action: author)
- inspect an animation graph → `animation_graph` (action: inspect)
- set up animation graph scaffolding → `animation_graph` (action: setup)

**Workshop & misc**
- get Workshop mod info → `workshop_info`

---

## File Changes Summary

### MCP server (`src/`)

| Change | Files affected |
|---|---|
| Merge animation_graph_* into `animation_graph` | `animation-graph-author.ts`, `animation-graph-inspect.ts`, `animation-graph-setup.ts` → new `animation-graph.ts` |
| Merge prefab_create + prefab_inspect into `prefab` | `prefab-create.ts`, `prefab-inspect.ts` → new `prefab.ts` |
| Merge project_browse/read/write into `project` | `project-browse.ts`, `project-read.ts`, `project-write.ts` → new `project.ts` |
| Merge mod_build/create/validate into `mod` | `mod-build.ts`, `mod-create.ts`, `mod-validate.ts` → new `mod.ts` |
| Merge scenario_create_base + objective into `scenario_create` | `wb-scenario.ts` (already in one file) |
| Update `server.ts` registrations | `server.ts` |

### Arma knowledge (`C:\Users\Steffen\.claude\arma-knowledge\`)

| Change | File |
|---|---|
| Add routing cheat sheet | `tools-routing.md` (new) |
| Add pointer to tools-routing.md | `INDEX.md` (update) |

---

## Out of Scope

- Merging `wb_entity_*` tools — already 7 separate actions with very different parameter shapes; merging would create a mega-tool that's harder to call correctly.
- Merging `wb_connect`/`wb_launch`/`wb_stop` — control flow tools that Claude calls sequentially; keeping them named clearly helps sequencing.
- Any new tool functionality.
