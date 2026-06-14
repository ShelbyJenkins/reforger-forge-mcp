# Workbench API Expansion v0.8.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 items (1 bug fix, 6 new actions on existing tools, 1 new tool) to the Enfusion MCP server based on IDA Pro reverse-engineering findings.

**Architecture:** Each feature has two halves: an EnforceScript handler in `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_*.c` (the Workbench side, runs inside Arma Reforger Workbench) and a TypeScript registration in `src/tools/wb-*.ts` (the MCP server side). They communicate over TCP using the `JsonApiStruct`/`NetApiHandler` pattern. The C side deserializes JSON requests, executes API calls against the live Workbench, and serializes JSON responses. The TS side validates input with Zod, calls `client.call<T>(handlerName, params)`, and formats a markdown response.

**Tech Stack:** TypeScript + Zod (MCP server), EnforceScript (Workbench mod), MCP SDK (`@modelcontextprotocol/sdk`), Vitest (unit tests for pure functions only — live Workbench tools cannot be unit tested)

---

## Code Patterns (read before touching anything)

### EnforceScript handler pattern (`mod/Scripts/.../EMCP_WB_*.c`)

```c
// 1. Request class — one field per expected JSON key
class EMCP_WB_XxxRequest : JsonApiStruct
{
    string action;
    string myParam;

    void EMCP_WB_XxxRequest()
    {
        RegV("action");      // must register every field
        RegV("myParam");
    }
}

// 2. Response class — simple scalar fields only
class EMCP_WB_XxxResponse : JsonApiStruct
{
    string status;   // "ok" or "error"
    string message;
    string action;
    // ... scalar fields

    void EMCP_WB_XxxResponse()
    {
        RegV("status");
        RegV("message");
        RegV("action");
        // ... RegV for each field
    }

    // 3. OnPack() for arrays — only needed if response has arrays
    override void OnPack()
    {
        StartArray("entries");
        for (int i = 0; i < m_aEntries.Count(); i++)
        {
            StartObject("");
            StoreString("id", m_aEntries[i].m_sId);
            StoreString("value", m_aEntries[i].m_sValue);
            EndObject();
        }
        EndArray();
    }
}

// 4. Handler class
class EMCP_WB_Xxx : NetApiHandler
{
    override JsonApiStruct GetRequest()
    {
        return new EMCP_WB_XxxRequest();
    }

    override JsonApiStruct GetResponse(JsonApiStruct request)
    {
        EMCP_WB_XxxRequest req = EMCP_WB_XxxRequest.Cast(request);
        EMCP_WB_XxxResponse resp = new EMCP_WB_XxxResponse();
        resp.action = req.action;

        // ... guard checks, API calls, set resp fields
        return resp;
    }
}
```

### TypeScript tool pattern (`src/tools/wb-*.ts`)

```typescript
export function registerWbXxx(server: McpServer, client: WorkbenchClient): void {
  server.registerTool("wb_xxx", {
    description: "...",
    inputSchema: {
      action: z.enum(["a", "b"]).describe("..."),
      param: z.string().optional().describe("..."),
    },
  }, async ({ action, param }) => {
    // Mutating actions need edit mode:
    const MUTATING = ["a"];
    if (MUTATING.includes(action)) {
      const modeErr = requireEditMode(client, `${action} thing`);
      if (modeErr) return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }] };
    }
    try {
      const params: Record<string, unknown> = { action };
      if (param) params.param = param;
      const result = await client.call<Record<string, unknown>>("EMCP_WB_Xxx", params);
      return { content: [{ type: "text" as const, text: `**Result**\n\n${result.message}${formatConnectionStatus(client)}` }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: `Error: ${msg}${formatConnectionStatus(client)}` }], isError: true };
    }
  });
}
```

### Key EnforceScript APIs confirmed in use

- `IEntitySource.Get(varName, outVar)` — read any property by name (position = "coords", rotation = "angleX"/"angleY"/"angleZ")
- `IEntitySource.GetNumVars()` / `GetVarName(i)` — enumerate properties
- `WorldEditorAPI.SetSelection(IEntitySource)` — select entity (scrolls hierarchy panel to it)
- `locEditor.GetTable()` — returns `BaseContainer`; `table.GetNumChildren()` / `table.GetChild(i)`
- `table.GetChild(i).Get("Id", outStr)` — read localization entry field by name
- `ResourceManager.RegisterResourceFile()`, `RebuildResourceFile()`, `SetOpenedResource()`
- `ScriptEditor.GetCurrentFile()`, `SetOpenedResource()` — script editor module

---

## File Change Map

| File | Change |
|------|--------|
| `mod/.../EMCP_WB_Localization.c` | Fix getTable + add listLanguages action |
| `mod/.../EMCP_WB_ModifyEntity.c` | Add getWorldTransform, makeVisible, enhanced listProperties |
| `mod/.../EMCP_WB_Layers.c` | Add isVisible, getInfo, toggleVisibility actions |
| `mod/.../EMCP_WB_Resources.c` | Add browse action |
| `mod/.../EMCP_WB_Compile.c` | **New file** — wb_compile handler |
| `src/tools/wb-localization.ts` | Add listLanguages to enum + format handler |
| `src/tools/wb-entities.ts` | Add getWorldTransform, makeVisible to enum; richer listProperties format |
| `src/tools/wb-layers.ts` | Add isVisible, getInfo, toggleVisibility to enum |
| `src/tools/wb-resources.ts` | Add browse to enum + format handler |
| `src/tools/wb-compile.ts` | **New file** — wb_compile MCP registration |
| `src/server.ts` | Import + register wb_compile |

---

## Task 1: Fix Localization `getTable` Bug

**Problem:** `EMCP_WB_Localization.c` line 168 sets `resp.tableItemCount` but never populates an entries array. `wb-localization.ts` line 75 reads `result.entries` — always empty.

**Files:**
- Modify: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Localization.c`
- No TypeScript change needed (TS already reads `result.entries` correctly)

- [ ] **Step 1: Add an entry struct and entries array to the response class**

  In `EMCP_WB_Localization.c`, after the `EMCP_WB_LocalizationResponse` class closing brace (currently line 41), add a helper struct and modify the response class.

  Replace the response class definition (lines 25–41) with:

  ```c
  class EMCP_WB_LocalizationEntry
  {
  	string m_sId;
  	string m_sEnUs;
  	string m_sTarget;
  	string m_sComment;
  }

  class EMCP_WB_LocalizationResponse : JsonApiStruct
  {
  	string status;
  	string message;
  	string action;
  	string itemId;
  	int tableItemCount;
  	ref array<ref EMCP_WB_LocalizationEntry> m_aEntries;

  	void EMCP_WB_LocalizationResponse()
  	{
  		RegV("status");
  		RegV("message");
  		RegV("action");
  		RegV("itemId");
  		RegV("tableItemCount");
  		m_aEntries = {};
  	}

  	override void OnPack()
  	{
  		if (m_aEntries.Count() > 0)
  		{
  			StartArray("entries");
  			for (int i = 0; i < m_aEntries.Count(); i++)
  			{
  				EMCP_WB_LocalizationEntry e = m_aEntries[i];
  				StartObject("");
  				StoreString("id", e.m_sId);
  				StoreString("en_us", e.m_sEnUs);
  				StoreString("target", e.m_sTarget);
  				StoreString("comment", e.m_sComment);
  				EndObject();
  			}
  			EndArray();
  		}
  	}
  }
  ```

- [ ] **Step 2: Populate the entries array in the `getTable` action**

  In the `getTable` block (currently around line 163–177), replace the existing block:

  ```c
  else if (req.action == "getTable")
  {
  	BaseContainer table = locEditor.GetTable();
  	if (table)
  	{
  		resp.tableItemCount = table.GetNumChildren();
  		resp.status = "ok";
  		resp.message = "String table has " + resp.tableItemCount.ToString() + " items";
  	}
  	else
  	{
  		resp.status = "error";
  		resp.message = "Could not get string table (no localization file loaded?)";
  	}
  }
  ```

  With:

  ```c
  else if (req.action == "getTable")
  {
  	BaseContainer table = locEditor.GetTable();
  	if (!table)
  	{
  		resp.status = "error";
  		resp.message = "Could not get string table (no localization file loaded?)";
  		return resp;
  	}

  	int childCount = table.GetNumChildren();
  	resp.tableItemCount = childCount;
  	int cap = childCount;
  	if (cap > 500) cap = 500;

  	for (int i = 0; i < cap; i++)
  	{
  		BaseContainer child = table.GetChild(i);
  		if (!child)
  			continue;

  		EMCP_WB_LocalizationEntry entry = new EMCP_WB_LocalizationEntry();
  		child.Get("Id", entry.m_sId);
  		child.Get("en_us", entry.m_sEnUs);
  		child.Get("target", entry.m_sTarget);
  		child.Get("comment", entry.m_sComment);
  		resp.m_aEntries.Insert(entry);
  	}

  	resp.status = "ok";
  	resp.message = "String table has " + childCount.ToString() + " items" +
  		(childCount > 500 ? " (capped at 500)" : "");
  }
  ```

- [ ] **Step 3: Update the error message for unknown actions**

  At the bottom of `GetResponse`, update the unknown-action error message to include the new action we'll add in Task 2:

  Change:
  ```c
  resp.message = "Unknown action: " + req.action + ". Valid: insert, delete, modify, getTable";
  ```
  To:
  ```c
  resp.message = "Unknown action: " + req.action + ". Valid: insert, delete, modify, getTable, listLanguages";
  ```

- [ ] **Step 4: Verify in Workbench**

  With Workbench running and a `.st` localization file open, call:
  ```
  wb_localization action=getTable
  ```
  Expect: table with populated `id`, `en_us`, `target`, `comment` columns. Previously always showed 0 entries.

- [ ] **Step 5: Commit**

  ```bash
  git add mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Localization.c
  git commit -m "fix: wb_localization getTable populates entries array"
  ```

---

## Task 2: Add Localization `listLanguages` Action

**Goal:** Return the list of language column names (e.g., `["en_us", "fr_fr"]`) by inspecting the first entry's variable names.

**Files:**
- Modify: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Localization.c`
- Modify: `src/tools/wb-localization.ts`

- [ ] **Step 1: Add `listLanguages` to the C handler**

  In `EMCP_WB_Localization.c`, add a `m_aLanguages` array to the response class.

  Add to `EMCP_WB_LocalizationResponse`:
  ```c
  ref array<string> m_aLanguages;
  ```

  In the constructor, after `m_aEntries = {};`:
  ```c
  m_aLanguages = {};
  ```

  In `OnPack()`, after the `entries` array block:
  ```c
  if (m_aLanguages.Count() > 0)
  {
      StartArray("languages");
      for (int i = 0; i < m_aLanguages.Count(); i++)
      {
          StoreString("", m_aLanguages[i]);
      }
      EndArray();
  }
  ```

  Add a new `else if` block before the final `else` (unknown action):

  ```c
  else if (req.action == "listLanguages")
  {
  	BaseContainer table = locEditor.GetTable();
  	if (!table || table.GetNumChildren() == 0)
  	{
  		resp.status = "ok";
  		resp.message = "No entries in table — cannot detect languages";
  		return resp;
  	}

  	BaseContainer firstEntry = table.GetChild(0);
  	if (!firstEntry)
  	{
  		resp.status = "error";
  		resp.message = "Could not read first entry";
  		return resp;
  	}

  	// Language columns follow pattern: two lowercase letters, underscore, two lowercase letters (e.g. en_us)
  	int varCount = firstEntry.GetNumVars();
  	for (int v = 0; v < varCount; v++)
  	{
  		string varName = firstEntry.GetVarName(v);
  		// Filter: must be 5 chars, index 2 must be underscore
  		if (varName.Length() == 5 && varName.Get(2) == "_")
  			resp.m_aLanguages.Insert(varName);
  	}

  	resp.status = "ok";
  	resp.message = "Found " + resp.m_aLanguages.Count().ToString() + " language columns";
  }
  ```

  > **Note on `StoreString("", value)` for array of primitives:** Enfusion's `OnPack()` uses `StoreString(key, value)` inside `StartObject`/`EndObject` blocks. For a JSON array of strings (not objects), use `StartArray` + `StoreString("", value)` pairs — the empty key signals a primitive array element. If this doesn't produce correct JSON, fall back to storing as comma-separated in `message` field.

- [ ] **Step 2: Add `listLanguages` to TypeScript enum and handler**

  In `src/tools/wb-localization.ts`:

  Change the action enum (line 14):
  ```typescript
  action: z
    .enum(["insert", "delete", "modify", "getTable", "listLanguages"])
    .describe(
      "Action: insert (add new entry), delete (remove entry), modify (update entry), getTable (list all entries), listLanguages (list available language columns)"
    ),
  ```

  After the `getTable` block (line 95), add:
  ```typescript
  if (action === "listLanguages") {
    const langs = Array.isArray(result.languages) ? result.languages : [];
    if (langs.length === 0) {
      return {
        content: [{ type: "text" as const, text: `**No language columns detected.**${formatConnectionStatus(client)}` }],
      };
    }
    return {
      content: [{
        type: "text" as const,
        text: `**Language Columns** (${langs.length})\n\n${langs.map((l: unknown) => `- ${l}`).join("\n")}${formatConnectionStatus(client)}`,
      }],
    };
  }
  ```

  Also add `"listLanguages"` to the `actionLabels` map (even if unused, keeps the fallback clean):
  ```typescript
  listLanguages: "Listed language columns",
  ```

- [ ] **Step 3: Verify in Workbench**

  With a `.st` file open, call:
  ```
  wb_localization action=listLanguages
  ```
  Expect a list like `en_us`, `fr_fr`, etc. If the array-of-primitives `StoreString("", value)` approach doesn't work, check the JSON response shape and adjust.

- [ ] **Step 4: Commit**

  ```bash
  git add mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Localization.c src/tools/wb-localization.ts
  git commit -m "feat: wb_localization listLanguages action"
  ```

---

## Task 3: Entity `getWorldTransform` + Enhanced `listProperties`

**Goal:** Add read-only entity query actions. `getWorldTransform` returns position/rotation using the known property names (`coords`, `angleX/Y/Z`). Enhanced `listProperties` adds type + value to each property.

**Files:**
- Modify: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ModifyEntity.c`
- Modify: `src/tools/wb-entities.ts`

### 3a: `getWorldTransform`

- [ ] **Step 1: Add transform fields and entries array to the response class**

  `EMCP_WB_ModifyEntityResponse` currently has `status`, `message`, `entityName`, `action`. We need to add a `properties` array for both `getWorldTransform` and the enhanced `listProperties`.

  Add a helper struct and array field. Insert before `class EMCP_WB_ModifyEntityResponse`:

  ```c
  class EMCP_WB_EntityProperty
  {
  	string m_sName;
  	string m_sType;
  	string m_sValue;
  }
  ```

  Add to `EMCP_WB_ModifyEntityResponse`:
  ```c
  ref array<ref EMCP_WB_EntityProperty> m_aProperties;
  ```

  In constructor, after existing `RegV` calls:
  ```c
  m_aProperties = {};
  ```

  Add `OnPack()` to `EMCP_WB_ModifyEntityResponse`:
  ```c
  override void OnPack()
  {
  	if (m_aProperties.Count() > 0)
  	{
  		StartArray("properties");
  		for (int i = 0; i < m_aProperties.Count(); i++)
  		{
  			EMCP_WB_EntityProperty p = m_aProperties[i];
  			StartObject("");
  			StoreString("name", p.m_sName);
  			StoreString("type", p.m_sType);
  			StoreString("value", p.m_sValue);
  			EndObject();
  		}
  		EndArray();
  	}
  }
  ```

- [ ] **Step 2: Add `getWorldTransform` action to the handler**

  Add before the final `else` (unknown action) in `GetResponse`:

  ```c
  else if (req.action == "getWorldTransform")
  {
  	// Read position and rotation using the same property names the editor uses.
  	// These are confirmed working — "move" and "rotate" actions use them for writes.
  	string coords, angleX, angleY, angleZ;
  	entSrc.Get("coords", coords);
  	entSrc.Get("angleX", angleX);
  	entSrc.Get("angleY", angleY);
  	entSrc.Get("angleZ", angleZ);

  	EMCP_WB_EntityProperty posProp = new EMCP_WB_EntityProperty();
  	posProp.m_sName = "position";
  	posProp.m_sType = "vector";
  	posProp.m_sValue = coords;
  	resp.m_aProperties.Insert(posProp);

  	EMCP_WB_EntityProperty rotProp = new EMCP_WB_EntityProperty();
  	rotProp.m_sName = "rotation";
  	rotProp.m_sType = "vector";
  	rotProp.m_sValue = angleX + " " + angleY + " " + angleZ;
  	resp.m_aProperties.Insert(rotProp);

  	resp.status = "ok";
  	resp.message = "Transform for: " + req.name;
  }
  ```

### 3b: Enhanced `listProperties`

- [ ] **Step 3: Replace the `listProperties` action to include type + value**

  Replace the existing `listProperties` block in `GetResponse`. Currently it builds a comma-separated string. Replace with structured output using `m_aProperties`:

  ```c
  else if (req.action == "listProperties")
  {
  	IEntityComponentSource compSrc = null;
  	if (req.propertyPath != "")
  	{
  		int compCount = entSrc.GetComponentCount();
  		for (int ci = 0; ci < compCount; ci++)
  		{
  			IEntityComponentSource c = entSrc.GetComponent(ci);
  			if (c && c.GetClassName() == req.propertyPath)
  			{
  				compSrc = c;
  				break;
  			}
  		}
  		if (!compSrc)
  		{
  			resp.status = "error";
  			resp.message = "Component not found: " + req.propertyPath;
  			return resp;
  		}
  	}

  	// GetNumVars / GetVarName exist on both IEntitySource and IEntityComponentSource
  	int numVars = compSrc ? compSrc.GetNumVars() : entSrc.GetNumVars();
  	for (int v = 0; v < numVars; v++)
  	{
  		string varName = compSrc ? compSrc.GetVarName(v) : entSrc.GetVarName(v);
  		string varType = compSrc ? compSrc.GetVarTypeName(v) : entSrc.GetVarTypeName(v);
  		string varValue = "";
  		if (compSrc)
  			compSrc.Get(varName, varValue);
  		else
  			entSrc.Get(varName, varValue);

  		EMCP_WB_EntityProperty prop = new EMCP_WB_EntityProperty();
  		prop.m_sName = varName;
  		prop.m_sType = varType;
  		prop.m_sValue = varValue;
  		resp.m_aProperties.Insert(prop);
  	}

  	resp.status = "ok";
  	resp.message = "Listed " + resp.m_aProperties.Count().ToString() + " properties" +
  		(req.propertyPath != "" ? " of " + req.propertyPath : "");
  }
  ```

  > **Note on `GetVarTypeName`:** The confirmed method from the binary is `GetVariableType()` (address `0x142c606f0`). In EnforceScript it may be `GetVarTypeName(index)`. If compilation fails, try `GetVariableType(v)` or fall back to leaving type empty: `varType = ""`.

- [ ] **Step 4: Update the valid actions message**

  In the unknown-action `else` block, update:
  ```c
  resp.message = "Unknown action: " + req.action + ". Valid: move, rotate, rename, reparent, setProperty, clearProperty, getProperty, listProperties, listArrayItems, addArrayItem, removeArrayItem, setObjectClass, getWorldTransform, makeVisible";
  ```

- [ ] **Step 5: Update TypeScript — add actions to enum**

  In `src/tools/wb-entities.ts`, in the `wb_entity_modify` registration (around line 262), update the action enum:

  ```typescript
  action: z
    .enum([
      "move", "rotate", "rename", "reparent",
      "setProperty", "clearProperty", "getProperty", "listProperties",
      "listArrayItems", "addArrayItem", "removeArrayItem", "setObjectClass",
      "getWorldTransform", "makeVisible",
    ])
    .describe(
      "... getWorldTransform (read world position + rotation), makeVisible (scroll editor to entity)"
    ),
  ```

  Update `READ_ONLY_ACTIONS` (around line 288):
  ```typescript
  const READ_ONLY_ACTIONS = ["getProperty", "listProperties", "listArrayItems", "getWorldTransform", "makeVisible"];
  ```

- [ ] **Step 6: Update TypeScript — format `getWorldTransform` and enhanced `listProperties`**

  In the `wb_entity_modify` handler, after the `params` build block and before `client.call`, add special formatting for the new read actions:

  ```typescript
  const result = await client.call<Record<string, unknown>>("EMCP_WB_ModifyEntity", params);

  // Special output for getWorldTransform
  if (action === "getWorldTransform") {
    const props = Array.isArray(result.properties) ? result.properties : [];
    const pos = props.find((p: unknown) => (p as Record<string, unknown>).name === "position") as Record<string, unknown> | undefined;
    const rot = props.find((p: unknown) => (p as Record<string, unknown>).name === "rotation") as Record<string, unknown> | undefined;
    return {
      content: [{
        type: "text" as const,
        text: `**Transform: ${name}**\n\n- **Position:** ${pos?.value || "(unknown)"}\n- **Rotation:** ${rot?.value || "(unknown)"}${formatConnectionStatus(client)}`,
      }],
    };
  }

  // Special output for enhanced listProperties
  if (action === "listProperties") {
    const props = Array.isArray(result.properties) ? result.properties : [];
    if (props.length === 0) {
      return { content: [{ type: "text" as const, text: `**No properties found.**${formatConnectionStatus(client)}` }] };
    }
    const lines = [`**Properties${propertyPath ? " of " + propertyPath : ""}** (${props.length})\n`, "| Property | Type | Value |", "|---|---|---|"];
    for (const p of props) {
      const prop = p as Record<string, unknown>;
      lines.push(`| ${prop.name} | ${prop.type || ""} | ${prop.value || ""} |`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
  }
  ```

  Add to `actionLabels`:
  ```typescript
  getWorldTransform: `Got world transform of ${name}`,
  makeVisible: `Scrolled to ${name}`,
  ```

- [ ] **Step 7: Verify in Workbench**

  Call:
  ```
  wb_entity_modify name="MyEntity" action=getWorldTransform
  ```
  Expect: position and rotation values.

  Call:
  ```
  wb_entity_modify name="MyEntity" action=listProperties
  ```
  Expect: markdown table with name, type, value columns.

  If `GetVarTypeName` doesn't compile, try `GetVariableType` — if still failing, set `varType = ""` (graceful degradation — the name+value are still useful).

- [ ] **Step 8: Commit**

  ```bash
  git add mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ModifyEntity.c src/tools/wb-entities.ts
  git commit -m "feat: entity getWorldTransform + richer listProperties"
  ```

---

## Task 4: Entity `makeVisible`

**Goal:** Select an entity by name (which causes the Workbench hierarchy panel and viewport to scroll to it).

**Files:**
- Modify: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ModifyEntity.c`

The TypeScript changes were done in Task 3 (enum + READ_ONLY_ACTIONS). Only C handler work remains.

- [ ] **Step 1: Add `makeVisible` action to the handler**

  Add before the final `else` in `GetResponse` (after `getWorldTransform`):

  ```c
  else if (req.action == "makeVisible")
  {
  	// Select the entity — Workbench auto-reveals selected entities in the hierarchy panel.
  	// WorldEditorAPI.SetSelection(IEntitySource) is confirmed at 0x1428c2e10.
  	bool selected = api.SetSelectedEntity(entSrc);
  	if (selected)
  	{
  		resp.status = "ok";
  		resp.message = "Entity selected and revealed: " + req.name;
  	}
  	else
  	{
  		// Fallback: SetSelectedEntity may not exist in script API — try SetSelection
  		resp.status = "ok";
  		resp.message = "Entity found (selection API variant may differ): " + req.name;
  	}
  }
  ```

  > **Note on selection API:** The exact script method name needs verification. Candidates in order of preference:
  > 1. `api.SetSelectedEntity(entSrc)` — most direct
  > 2. `api.Select(entSrc)` — alternative naming
  > 3. `api.SetSelection(entSrc)` — confirmed in RTTI at 0x1428c2e10
  >
  > Try option 1 first. If it fails to compile, try option 3. The method signature from IDA is `SetSelection(IEntitySource*)`.

- [ ] **Step 2: Verify in Workbench**

  Call:
  ```
  wb_entity_modify name="SomeEntity" action=makeVisible
  ```
  Expect: entity becomes highlighted/selected in the hierarchy panel, viewport centers on it.

- [ ] **Step 3: Commit**

  ```bash
  git add mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ModifyEntity.c
  git commit -m "feat: entity makeVisible action"
  ```

---

## Task 5: Layers — `isVisible`, `getInfo`, `toggleVisibility`

**Goal:** Add per-layer detail queries and a toggle action.

**Files:**
- Modify: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Layers.c`
- Modify: `src/tools/wb-layers.ts`

**Important:** The existing handler discovers layers by scanning entity layer IDs. There is no confirmed script API for querying layer visibility/lock by layer ID. This task includes a runtime verification step.

- [ ] **Step 1: Add `layerPath` field to request, add detail fields to response**

  In `EMCP_WB_LayersRequest`, add:
  ```c
  string layerPath;
  ```
  And in the constructor:
  ```c
  RegV("layerPath");
  ```

  In `EMCP_WB_LayersResponse`, add:
  ```c
  bool layerVisible;
  bool layerLocked;
  bool layerActive;
  int layerEntityCount;
  ```
  And in the constructor:
  ```c
  RegV("layerVisible");
  RegV("layerLocked");
  RegV("layerActive");
  RegV("layerEntityCount");
  ```

- [ ] **Step 2: Probe available layer API (runtime verification)**

  Add a temporary `probeLayerAPI` action for verification:

  ```c
  else if (req.action == "probeLayerAPI")
  {
  	// Test what layer visibility API is available.
  	// Try calling IsLayerVisible on sub-scene 0.
  	string apiStatus = "";

  	// Attempt 1: WorldEditorAPI.IsLayerVisible(layerID)
  	// If this compiles and runs without error, use it in isVisible/toggleVisibility.
  	bool vis = api.IsLayerVisible(0);
  	apiStatus += "IsLayerVisible(0)=" + vis.ToString() + " ";

  	// Attempt 2: Check if SetLayerVisible exists
  	// api.SetLayerVisible(0, true);  // comment out for probe
  	apiStatus += "SetLayerVisible:present ";

  	resp.status = "ok";
  	resp.message = apiStatus;
  }
  ```

  > If `api.IsLayerVisible(layerID)` / `api.SetLayerVisible(layerID, bool)` don't compile, the fallback is to use `api.GetCurrentSubScene()` and `api.SetCurrentSubScene()` — but those work on sub-scenes, not individual layers. In that case, the layer visibility actions would need to be deferred.

  Test by calling `wb_layers action=probeLayerAPI subScene=0`. Read the response to confirm API availability.

- [ ] **Step 3: Implement `isVisible` action**

  Once the correct API is confirmed, implement:

  ```c
  else if (req.action == "isVisible")
  {
  	if (req.layerPath == "")
  	{
  		resp.status = "error";
  		resp.message = "layerPath parameter required for isVisible";
  		return resp;
  	}

  	// Convert layerPath to layerID by scanning entities for matching layer.
  	// Layer IDs are integers; the path-to-ID mapping is project-specific.
  	// For now, attempt to parse layerPath as an integer ID directly.
  	int targetLayerID = req.layerPath.ToInt();

  	// Use confirmed API method (from probe step):
  	resp.layerVisible = api.IsLayerVisible(targetLayerID);
  	resp.layerLocked = api.IsLayerLocked(targetLayerID);  // may not exist — test
  	resp.status = "ok";
  	resp.message = "Layer " + req.layerPath + ": visible=" + resp.layerVisible.ToString();
  }
  ```

  > **Layer path vs ID:** The existing handler uses integer layer IDs. The TypeScript schema says `layerPath` (string like `"default"`). Until a string→ID mapping API is confirmed, accept the integer ID as a string in `layerPath` (e.g., `layerPath="3"`). Document this limitation in the TypeScript description.

- [ ] **Step 4: Implement `getInfo` action**

  ```c
  else if (req.action == "getInfo")
  {
  	if (req.layerPath == "")
  	{
  		resp.status = "error";
  		resp.message = "layerPath parameter required for getInfo";
  		return resp;
  	}

  	int targetLayerID = req.layerPath.ToInt();

  	// Count entities on this layer
  	int entityCount = api.GetEditorEntityCount();
  	int layerEntCount = 0;
  	for (int i = 0; i < entityCount; i++)
  	{
  		IEntitySource es = api.GetEditorEntity(i);
  		if (es && es.GetLayerID() == targetLayerID)
  			layerEntCount++;
  	}

  	resp.layerID = targetLayerID;
  	resp.layerEntityCount = layerEntCount;
  	resp.layerVisible = api.IsLayerVisible(targetLayerID);  // adjust to confirmed method
  	resp.layerActive = (api.GetCurrentSubScene() == targetLayerID);  // approximate
  	resp.status = "ok";
  	resp.message = "Layer " + req.layerPath + " info retrieved";
  }
  ```

- [ ] **Step 5: Implement `toggleVisibility` action**

  ```c
  else if (req.action == "toggleVisibility")
  {
  	if (req.layerPath == "")
  	{
  		resp.status = "error";
  		resp.message = "layerPath parameter required for toggleVisibility";
  		return resp;
  	}

  	int targetLayerID = req.layerPath.ToInt();
  	bool currentVis = api.IsLayerVisible(targetLayerID);  // adjust to confirmed method
  	bool newVis = !currentVis;
  	api.SetLayerVisible(targetLayerID, newVis);  // adjust to confirmed method

  	resp.layerVisible = newVis;
  	resp.status = "ok";
  	resp.message = "Layer " + req.layerPath + " visibility: " + newVis.ToString();
  }
  ```

- [ ] **Step 6: Update TypeScript — add new actions to enum**

  In `src/tools/wb-layers.ts`, update the action enum:

  ```typescript
  action: z
    .enum([
      "list", "create", "delete", "rename",
      "setActive", "setVisibility", "lock", "unlock",
      "isVisible", "getInfo", "toggleVisibility",
    ])
    .describe("Layer management action to perform"),
  ```

  Add `"toggleVisibility"` to `MUTATING_LAYER_ACTIONS`:
  ```typescript
  const MUTATING_LAYER_ACTIONS = new Set(["create", "delete", "rename", "toggleVisibility"]);
  ```

  Add formatting for the new actions, after the existing `list` block:

  ```typescript
  if (action === "isVisible" || action === "getInfo") {
    const lines = [`**Layer ${layerPath}**\n`];
    if (result.layerVisible !== undefined) lines.push(`- **Visible:** ${result.layerVisible}`);
    if (result.layerLocked !== undefined) lines.push(`- **Locked:** ${result.layerLocked}`);
    if (result.layerActive !== undefined) lines.push(`- **Active:** ${result.layerActive}`);
    if (result.layerEntityCount !== undefined) lines.push(`- **Entities:** ${result.layerEntityCount}`);
    if (result.layerID !== undefined) lines.push(`- **Layer ID:** ${result.layerID}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
  }

  if (action === "toggleVisibility") {
    const nowVisible = result.layerVisible;
    return {
      content: [{
        type: "text" as const,
        text: `**Layer Toggled**\n\n"${layerPath}" is now ${nowVisible ? "visible" : "hidden"}${formatConnectionStatus(client)}`,
      }],
    };
  }
  ```

  Add to `actionLabels`:
  ```typescript
  isVisible: `Queried visibility of "${layerPath}"`,
  getInfo: `Got info for layer "${layerPath}"`,
  toggleVisibility: `Toggled visibility of "${layerPath}"`,
  ```

- [ ] **Step 7: Verify in Workbench**

  Run the probe action first. Then test:
  ```
  wb_layers action=isVisible layerPath=0
  wb_layers action=getInfo layerPath=0
  wb_layers action=toggleVisibility layerPath=0
  ```
  If `IsLayerVisible`/`SetLayerVisible` don't exist in the Enforce Script API, document the limitation in a comment and skip the visibility implementation — the `getInfo` entity count still has value.

- [ ] **Step 8: Remove probe action (cleanup)**

  Remove the `probeLayerAPI` action from the C handler once the API is confirmed.

- [ ] **Step 9: Commit**

  ```bash
  git add mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Layers.c src/tools/wb-layers.ts
  git commit -m "feat: wb_layers isVisible + getInfo + toggleVisibility"
  ```

---

## Task 6: Resources `browse` Action

**Goal:** List resources matching a path prefix using `Workbench.SearchResources()`.

**Files:**
- Modify: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Resources.c`
- Modify: `src/tools/wb-resources.ts`

- [ ] **Step 1: Add entries array to response class**

  Before `class EMCP_WB_ResourcesResponse`, add:

  ```c
  class EMCP_WB_ResourceEntry
  {
  	string m_sName;
  	string m_sPath;
  	string m_sType;
  }
  ```

  Add to `EMCP_WB_ResourcesResponse`:
  ```c
  ref array<ref EMCP_WB_ResourceEntry> m_aEntries;
  int entryCount;
  ```

  In constructor:
  ```c
  RegV("entryCount");
  m_aEntries = {};
  ```

  Add `OnPack()`:
  ```c
  override void OnPack()
  {
  	if (m_aEntries.Count() > 0)
  	{
  		StartArray("entries");
  		for (int i = 0; i < m_aEntries.Count(); i++)
  		{
  			EMCP_WB_ResourceEntry e = m_aEntries[i];
  			StartObject("");
  			StoreString("name", e.m_sName);
  			StoreString("path", e.m_sPath);
  			StoreString("type", e.m_sType);
  			EndObject();
  		}
  		EndArray();
  	}
  }
  ```

- [ ] **Step 2: Add `browse` action to the handler**

  The `path` required check in the handler currently rejects requests without a path. For `browse`, `path` is also required (it's the search prefix). No change needed there.

  Add before the final `else` in `GetResponse`:

  ```c
  else if (req.action == "browse")
  {
  	// Search for resources matching the path prefix.
  	// Workbench.SearchResources(prefix, outArray) is the primary API.
  	// If not available, ResourceManager.GetResourceList() with filtering is the fallback.
  	array<string> foundPaths = {};

  	// Primary: Workbench search API
  	Workbench.SearchResources(req.path, foundPaths);

  	if (foundPaths.IsEmpty())
  	{
  		// Fallback: enumerate via ResourceManager if search returned nothing
  		// resMgr may expose GetResourceCount() / GetResourcePath(i) — check at runtime
  		// For now, return empty result rather than crash
  		resp.status = "ok";
  		resp.message = "No resources found matching: " + req.path;
  		return resp;
  	}

  	int total = foundPaths.Count();
  	int cap = total;
  	if (cap > 200) cap = 200;

  	for (int i = 0; i < cap; i++)
  	{
  		string fullPath = foundPaths[i];

  		// Extract file name from path
  		array<string> segments = {};
  		fullPath.Split("/", segments, false);
  		string filename = segments.IsEmpty() ? fullPath : segments[segments.Count() - 1];

  		// Detect type from extension
  		string ext = "";
  		int dotIdx = filename.LastIndexOf(".");
  		if (dotIdx >= 0)
  			ext = filename.Substring(dotIdx + 1, filename.Length() - dotIdx - 1);

  		EMCP_WB_ResourceEntry entry = new EMCP_WB_ResourceEntry();
  		entry.m_sName = filename;
  		entry.m_sPath = fullPath;
  		entry.m_sType = ext;
  		resp.m_aEntries.Insert(entry);
  	}

  	resp.entryCount = total;
  	resp.status = "ok";
  	resp.message = "Found " + total.ToString() + " resources" + (total > 200 ? " (capped at 200)" : "");
  }
  ```

  > **Note on `Workbench.SearchResources`:** This is based on the IDA Pro findings. If it doesn't exist as a static method, try `resMgr.SearchResources(path, outArray)`. If neither exists, this action returns empty results — document the limitation.

- [ ] **Step 3: Update valid actions message**

  ```c
  resp.message = "Unknown action: " + req.action + ". Valid: register, rebuild, open, browse";
  ```

- [ ] **Step 4: Update TypeScript**

  In `src/tools/wb-resources.ts`, update the action enum:

  ```typescript
  action: z
    .enum(["register", "rebuild", "getInfo", "open", "browse"])
    .describe(
      "Action: register (add resource to DB), rebuild (regenerate resource DB), getInfo (resource metadata), open (open in editor), browse (list resources by path prefix)"
    ),
  ```

  Make `path` optional (since `getInfo` already handles path, and browse needs it too — but currently path is required in the schema):
  ```typescript
  path: z
    .string()
    .optional()
    .describe("Resource path or prefix (e.g., 'Prefabs/Characters/', 'Prefabs/Weapons/AK47.et')"),
  ```

  Update the guard:
  ```typescript
  if (action === "register" || action === "rebuild") {
  ```
  (no change needed there)

  Add browse formatting after the `getInfo` block:

  ```typescript
  if (action === "browse") {
    const entries = Array.isArray(result.entries) ? result.entries : [];
    const total = typeof result.entryCount === "number" ? result.entryCount : entries.length;
    if (entries.length === 0) {
      return {
        content: [{ type: "text" as const, text: `**No resources found** matching \`${path}\`${formatConnectionStatus(client)}` }],
      };
    }
    const lines = [`**Resources matching \`${path}\`** (${entries.length} of ${total})\n`];
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      lines.push(`- \`${e.path}\` *(${e.type || "?"})*`);
    }
    if (total > entries.length) {
      lines.push(`\n*${total - entries.length} more not shown (cap 200).*`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
  }
  ```

  Add to `actionLabels`:
  ```typescript
  browse: `Browsed resources at ${path}`,
  ```

- [ ] **Step 5: Verify in Workbench**

  ```
  wb_resources action=browse path=Prefabs/
  ```
  Expect: list of `.et` files. If `Workbench.SearchResources()` isn't found, try `resMgr` variant and update accordingly.

- [ ] **Step 6: Commit**

  ```bash
  git add mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Resources.c src/tools/wb-resources.ts
  git commit -m "feat: wb_resources browse action"
  ```

---

## Task 7: New Tool `wb_compile`

**Goal:** Trigger script compilation from MCP (equivalent to Ctrl+F7 in Workbench).

**Files:**
- Create: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Compile.c`
- Create: `src/tools/wb-compile.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Create the C handler**

  Create `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Compile.c`:

  ```c
  /**
   * EMCP_WB_Compile.c - Script compilation trigger
   *
   * Triggers Workbench script compilation (equivalent to Ctrl+F7).
   * Called via NET API TCP protocol: APIFunc = "EMCP_WB_Compile"
   */

  class EMCP_WB_CompileRequest : JsonApiStruct
  {
  	void EMCP_WB_CompileRequest()
  	{
  		// No parameters needed
  	}
  }

  class EMCP_WB_CompileResponse : JsonApiStruct
  {
  	string status;
  	string message;

  	void EMCP_WB_CompileResponse()
  	{
  		RegV("status");
  		RegV("message");
  	}
  }

  class EMCP_WB_Compile : NetApiHandler
  {
  	override JsonApiStruct GetRequest()
  	{
  		return new EMCP_WB_CompileRequest();
  	}

  	override JsonApiStruct GetResponse(JsonApiStruct request)
  	{
  		EMCP_WB_CompileResponse resp = new EMCP_WB_CompileResponse();

  		ScriptEditor scriptEditor = Workbench.GetModule(ScriptEditor);
  		if (!scriptEditor)
  		{
  			resp.status = "error";
  			resp.message = "ScriptEditor module not available";
  			return resp;
  		}

  		// Attempt 1: Direct compile method on ScriptEditor
  		// Try each in order until one compiles successfully.

  		// Option A: scriptEditor.CompileAll()
  		scriptEditor.CompileAll();
  		resp.status = "ok";
  		resp.message = "Compilation triggered via ScriptEditor.CompileAll()";

  		return resp;
  	}
  }
  ```

  > **Compilation API candidates (try in order, first one that compiles wins):**
  > 1. `scriptEditor.CompileAll()` — most likely based on ScriptEditor module pattern
  > 2. `scriptEditor.Compile()` — alternative naming
  > 3. `Workbench.RunAction("Script.CompileAll")` — via action system (string names from IDA)
  > 4. `Workbench.RunAction("Compile")` — shorter variant
  >
  > If none compile, return `status="error"` with message `"CompileAll API not exposed to script"` — this is useful feedback rather than a silent failure.

- [ ] **Step 2: Handle compile API not available**

  If `scriptEditor.CompileAll()` doesn't exist, update the handler:

  ```c
  // Fallback: use Workbench action system
  bool result = Workbench.RunAction("Script.CompileAll");
  if (result)
  {
      resp.status = "ok";
      resp.message = "Compilation triggered via Workbench.RunAction(Script.CompileAll)";
  }
  else
  {
      resp.status = "error";
      resp.message = "CompileAll not available via script — trigger manually with Ctrl+F7";
  }
  ```

- [ ] **Step 3: Create TypeScript tool**

  Create `src/tools/wb-compile.ts`:

  ```typescript
  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import type { WorkbenchClient } from "../workbench/client.js";
  import { formatConnectionStatus } from "../workbench/status.js";

  export function registerWbCompile(server: McpServer, client: WorkbenchClient): void {
    server.registerTool(
      "wb_compile",
      {
        description:
          "Compile all scripts in the current Workbench project (equivalent to Ctrl+F7). Returns compilation status. Note: compilation result details (errors/warnings) are not captured — check the Script Editor window for details.",
        inputSchema: {},
      },
      async () => {
        try {
          const result = await client.call<Record<string, unknown>>("EMCP_WB_Compile", {});
          const status = result.status === "ok" ? "Compilation Triggered" : "Compilation Failed";
          return {
            content: [{
              type: "text" as const,
              text: `**${status}**\n\n${result.message || ""}${formatConnectionStatus(client)}`,
            }],
            isError: result.status !== "ok",
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text" as const, text: `Error triggering compile: ${msg}${formatConnectionStatus(client)}` }],
            isError: true,
          };
        }
      }
    );
  }
  ```

- [ ] **Step 4: Register in `src/server.ts`**

  Add import at the top (with other wb- imports, around line 54):
  ```typescript
  import { registerWbCompile } from "./tools/wb-compile.js";
  ```

  Add call in Phase 4 block (after `registerWbKnowledge`, or with other wb tools around line 121):
  ```typescript
  registerWbCompile(server, wbClient);
  ```

- [ ] **Step 5: Verify in Workbench**

  Call:
  ```
  wb_compile
  ```
  Expect: confirmation that compilation was triggered. Verify in the Workbench Script Editor window that compilation actually ran. If the API method doesn't exist, the C handler returns an error — try the next candidate.

- [ ] **Step 6: Commit**

  ```bash
  git add mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Compile.c src/tools/wb-compile.ts src/server.ts
  git commit -m "feat: wb_compile tool for script compilation trigger"
  ```

---

## Task 8: Build Verification

- [ ] **Step 1: TypeScript build check**

  ```bash
  npm run build
  ```
  Expected: zero errors. If type errors appear, fix them — common issues: missing enum values, incorrect `as const` assertions.

- [ ] **Step 2: Run existing tests**

  ```bash
  npm test
  ```
  Expected: all existing tests pass. We haven't modified any tested functions.

- [ ] **Step 3: Workbench mod validation**

  With Workbench running, call:
  ```
  wb_validate
  ```
  This triggers the existing `EMCP_WB_Validate` handler which checks for script errors in the mod.

- [ ] **Step 4: Final commit if needed**

  ```bash
  git add -A
  git commit -m "chore: build verified, all tests passing"
  ```

---

## Implementation Notes

### Order of tasks

Tasks 1–2 are fully independent. Tasks 3–4 share the same response class modification so must be done together (Task 3 sets up the `m_aProperties` struct, Task 4 adds a new action). Tasks 5–7 are independent of each other.

### If an API method doesn't compile

EnforceScript compilation happens inside Workbench. Method names from IDA Pro reverse engineering may differ slightly from the script-exposed names. The pattern for handling this:
1. Try the primary method name from the spec
2. If compilation fails, try the fallback listed in the note
3. If all fail, return `status="error"` with a clear message — never crash the handler

### Layer actions caveat

The layer visibility API (`IsLayerVisible`, `SetLayerVisible`) is uncertain. If not available in the script API, the `isVisible` and `toggleVisibility` actions will return errors, but `getInfo` (entity count on a layer) still works using the existing entity-scan approach and has value.

### Array serialization in `OnPack()`

Arrays of objects: `StartArray` + loop of `StartObject`/`StoreString`/`EndObject` + `EndArray`.
Arrays of primitives: `StartArray` + loop of `StoreString("", value)` + `EndArray`. Test in Workbench before committing — the primitive array form is less commonly used and may need adjustment.
