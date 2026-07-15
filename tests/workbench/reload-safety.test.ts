import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInProcessScriptReload } from "../../src/tools/wb-reload.js";
import { classifyMenuAction } from "../../src/tools/wb-execute-action.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const handler = (name: string): string => readFileSync(resolve(
  testDir,
  `../../mod/Scripts/WorkbenchGame/EnfusionMCP/${name}`
), "utf8");

describe("Workbench unattended lifecycle safety", () => {
  it("refuses every in-process game-script reload target", () => {
    expect(isInProcessScriptReload("scripts")).toBe(true);
    expect(isInProcessScriptReload("both")).toBe(true);
    expect(isInProcessScriptReload("plugins")).toBe(false);

    const source = handler("EMCP_WB_Reload.c");
    expect(source).toContain("Script reload is disabled in every editor state");
    expect(source).not.toContain("scriptEditor.ExecuteAction");
    expect(source).not.toContain("GetWorld()");
  });

  it.each([
    "Build,Compile and Reload Scripts",
    "Plugins, Settings, Reload Scripts",
    "Build, Validate Scripts",
    "File, Exit",
    "File, Save As",
    "Tools,Import",
    "Edit,Undo",
  ])("blocks generic action %s", (menuPath) => {
    expect(classifyMenuAction(menuPath).blocked).toBe(true);
  });

  it("disables generic execution in the direct NET API handler", () => {
    const source = handler("EMCP_WB_ExecuteAction.c");
    expect(source).toContain("Generic menu execution is disabled");
    expect(source).not.toContain("Workbench.GetModule");
    expect(source).not.toContain("worldEditor.ExecuteAction(parts)");
  });

  it("refuses play and save in the direct handler before editor operations", () => {
    const source = handler("EMCP_WB_EditorControl.c");
    const playRefusal = source.indexOf('if (req.action == "play")');
    const saveRefusal = source.indexOf('if (req.action == "save" || req.action == "saveAs")');
    const moduleLookup = source.indexOf("Workbench.GetModule(WorldEditor)");
    expect(playRefusal).toBeGreaterThan(-1);
    expect(saveRefusal).toBeGreaterThan(playRefusal);
    expect(moduleLookup).toBeGreaterThan(saveRefusal);
    expect(source).not.toContain("SwitchToGameMode");
    expect(source).not.toContain("worldEditor.Save()");
  });

  it("does not hot-inject missing handlers into a live Workbench", () => {
    const client = readFileSync(resolve(testDir, "../../src/workbench/client.ts"), "utf8");
    expect(client).not.toContain("recoverMissingHandlers");
    expect(client).toContain("Handler recovery refused");
    expect(client).toContain("await this.restartOwnedWorkbench()");
  });
});
