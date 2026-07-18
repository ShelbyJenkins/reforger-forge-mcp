import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerModifyModPrompt(server: McpServer): void {
  server.registerPrompt(
    "modify-mod",
    {
      title: "Work on an existing Arma Reforger mod",
      description:
        "Guided workflow to modify, extend, or fix an existing mod. Reads the project, understands it, then makes changes.",
      argsSchema: {
        projectPath: z
          .string()
          .describe("Path to the addon root directory (the folder containing the .gproj file)"),
        task: z
          .string()
          .describe("Describe what you want to change (e.g., 'Add a stamina system', 'Fix the damage calculation', 'Add a new vehicle prefab')"),
      },
    },
    ({ projectPath, task }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I have an existing Arma Reforger mod at: ${projectPath}

I want to: ${task}

YOU ARE AUTONOMOUS FOR EVERY SAFE, AUTOMATABLE STEP. The one required attended exception is Play mode: automated \`wb_play\` is disabled, so when runtime testing is needed you must ask the user to enter Play mode manually, pause until they confirm, and then verify the mode with **wb_state**. Do not ask the user to perform builds, edit files, or handle any other step that the available tools can complete safely.

Follow this workflow — every step is mandatory:

1. **Read the plan** — Use **project** with \`action: "read"\` to check for a \`MODPLAN.md\` file in the project root.
   - If it exists: this is a phased project. Read the plan carefully. It contains the full mod vision, what's been completed, what's pending, architecture notes, class prefixes, and file names. Use this as your primary context. If the user's task matches the next pending phase, execute that phase. If it's a different task, still respect the existing architecture.
   - If it doesn't exist: this is either a simple mod or one created before planning was added. Proceed normally.

2. **Understand the project** — Use **project** with \`action: "browse"\` and \`action: "read"\` to explore:
   - Read the .gproj for addon name and dependencies
   - Read existing scripts, prefabs, configs, and layouts
   - Identify the class prefix convention in use

3. **Research the API** — **NEVER try to browse the game install directory directly or access the Bohemia Interactive Wiki via the web.** Use **asset_search** to find assets by name, **game_browse**/**game_read** to browse and read game files (reads .pak archives transparently), and **api_search** for class/method lookups. Use **component_search** to find components to attach to entities — filter by category (character, vehicle, weapon, damage, inventory, ai, ui) or by event handlers they implement. Wiki content is pre-downloaded — always use **wiki_search** instead of trying to fetch wiki pages from the web. When you need the full page (especially code examples), use **wiki_read** with the page title.

   Use **api_search** to find relevant classes and methods. **CRITICAL: NEVER guess or assume Enfusion API method names.** The API is non-standard — methods that seem obvious often don't exist (e.g., \`HitZone.SetHealth()\`, \`IEntity.GetVelocity()\`). You MUST search every class you plan to call methods on and verify the methods exist in the search results — inherited methods from parent classes are included automatically, so one lookup is usually enough. Check the **Related Classes** section for sibling classes in the same API group. For enums/constants, use \`api_search(type: "enum")\` which detects enum-like constant classes. If a method isn't listed, it does not exist — find an alternative.

4. **Plan the changes** — Determine what to modify, create, or remove. For phased projects, verify your plan aligns with the MODPLAN. Only use API methods verified via api_search.

5. **Implement** — Make all modifications:
   - Existing files: **project** with \`action: "read"\`, then \`action: "write"\`
   - New scripts: **script_create** (match existing prefix)
   - New prefabs: **prefab** with \`action: "create"\`
   - New configs: **config_create**
   - New layouts: **layout_create**

6. **Validate** — Use **mod** with \`action: "validate"\` to check for issues.

7. **Workbench Setup** (MANDATORY — automate every safe step; attended Play is the one manual exception):
   a. **wb_launch** with \`gprojPath\` set to the addon's .gproj file — this stages the private helper outside the mod and opens the project in the World Editor with verified NET API access
   b. Ask the user to enter Play mode manually in Workbench because automated \`wb_play\` is disabled. Pause and wait for the user to confirm that Play has started.
   c. After confirmation, call **wb_state** and proceed only after it reports Play mode. Verify that the world launches successfully.
   d. Use **wb_stop** to return to the World Editor. Calling it in edit mode is an idempotent success.
   e. If compilation failed, fix with **project** and \`action: "write"\`, then use **wb_restart** to recompile from a clean owner-scoped session. Ask the user to enter Play manually again, wait for confirmation, and verify the result with **wb_state**. Do not hot-reload scripts while a world is loaded.
   f. **wb_resources** (action: "register") — Register any new prefabs, configs, or layouts

8. If further runtime testing is needed, repeat the attended manual Play, confirmation, and **wb_state** verification flow. Use **wb_stop** to return to edit mode.

9. Call **wb_shutdown** when live editing is complete. The MCP-managed helper and profile remain outside the addon, so no project cleanup step is required.

10. **Update the plan** — If a \`MODPLAN.md\` exists, use **project** with \`action: "read"\` and then \`action: "write"\` to update it:
   - Mark completed phases as \`COMPLETE\` with a list of files created/modified
   - Keep pending phases unchanged (unless the user asked to adjust them)
   - Add any new architecture notes or design decisions made during this session
   - If the task was unplanned (not part of any phase), add it to a "Changes Outside Plan" section

11. Summarize what changed and how the mod works now.

Enfusion rules:
- NEVER guess API methods — if you didn't verify it via api_search, assume it doesn't exist
- Read existing code BEFORE modifying it. Understand what's there first.
- Match existing code style, class prefix, and naming conventions.
- All scripts go in Scripts/Game/ (other folders are silently ignored)
- modded classes affect ALL instances globally
- Always call super.MethodName() in overrides unless intentionally replacing
- VISIBLE ENTITIES NEED A MESH: Any entity placed in the world MUST have a MeshObject component with its \`Object\` property set to a base game \`.xob\` model path. Without this, the entity is invisible. You don't need custom models — just pick any existing base game model that roughly fits (e.g., a medical box for a healing station, a radio for a terminal). After creating a prefab, always set the MeshObject Object property to a real path like \`{5F4C4181F065B447}Assets/Props/Military/Barrels/BarrelGreen_01.xob\`.

YOUR FINAL SUMMARY MUST ONLY contain:
- What files were changed/added and what each change does
- How the mod works now
- Any tuning values the user can adjust
- For phased projects: what phase was completed and what the next phase covers

YOUR FINAL SUMMARY MUST NEVER contain:
- "Next steps" or "To get started" or any manual instructions
- "Open in Workbench" / "Build with Ctrl+F7" / "Load the project"
- Any instruction telling the user to do something you already did or should have done
- References to manual Workbench operations

If Workbench integration failed (e.g., Workbench not installed), say so explicitly — do not silently fall back to giving manual instructions.`,
          },
        },
      ],
    })
  );
}
