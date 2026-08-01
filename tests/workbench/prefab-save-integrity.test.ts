import { describe, expect, it } from "vitest";
import { findExplicitEmptyPrefabOverrides } from "../../src/workbench/prefab-save-integrity.js";

describe("prefab save integrity", () => {
  it("finds load-bearing empty collection overrides in inherited prefab components", () => {
    const source = `SCR_BaseGameMode : "{1111111111111111}Prefabs/Base.et" {
 components {
  SCR_ScoringSystemComponent "{2222222222222222}" {
   m_aActions {
   }
  }
 }
}`;

    expect(findExplicitEmptyPrefabOverrides(source)).toEqual([
      "SCR_ScoringSystemComponent[{2222222222222222}].m_aActions",
    ]);
  });

  it("does not treat a component body or a standalone prefab as a vulnerable override", () => {
    expect(findExplicitEmptyPrefabOverrides(`GenericEntity {
 components {
  EmptyComponent "{3333333333333333}" {
  }
 }
}`)).toEqual([]);
  });

  it("does not flag non-empty nested component data", () => {
    const source = `GenericEntity : "{1111111111111111}Prefabs/Base.et" {
 components {
  ExampleComponent "{3333333333333333}" {
   Values {
    "kept"
   }
  }
 }
}`;

    expect(findExplicitEmptyPrefabOverrides(source)).toEqual([]);
  });
});
