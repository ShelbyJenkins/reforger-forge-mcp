import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Workbench component helper persistence", () => {
  it("routes Prefab Edit component operations to the serializable template owner", () => {
    const path = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Components.c",
      import.meta.url
    ));
    const source = readFileSync(path, "utf8");

    expect(source).toContain("worldEditor.IsPrefabEditMode() && entSrc == prefabEditSource");
    expect(source).toContain('RegV("entityIndex")');
    expect(source).toContain("ResolveEntity(api, req.entityName, req.entityIndex)");
    expect(source).toContain("componentOwner = IEntitySource.Cast(entSrc.GetAncestor())");
    expect(source).toContain("api.CreateComponent(componentOwner, req.componentClass)");
    expect(source).toContain("api.DeleteComponent(componentOwner, targetComp)");
    expect(source).not.toContain("api.CreateComponent(entSrc, req.componentClass)");
    expect(source).not.toContain("api.DeleteComponent(entSrc, targetComp)");
  });

  it("verifies the owner component count before reporting a successful mutation", () => {
    const path = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Components.c",
      import.meta.url
    ));
    const source = readFileSync(path, "utf8");

    expect(source).toContain("componentOwner.GetComponentCount() == previousCount + 1");
    expect(source).toContain("componentOwner.GetComponentCount() == compCount - 1");
  });

  it("lets property operations address an unnamed prefab root by editor index", () => {
    const path = fileURLToPath(new URL(
      "../../observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ModifyEntity.c",
      import.meta.url
    ));
    const source = readFileSync(path, "utf8");

    expect(source).toContain('RegV("entityIndex")');
    expect(source).toContain("ResolveEntity(api, req.name, req.entityIndex)");
    expect(source).toContain("propertyEntSrc = IEntitySource.Cast(prefabAncestor)");
  });
});
