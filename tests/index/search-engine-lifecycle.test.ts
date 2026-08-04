import { describe, expect, it, vi } from "vitest";
import { SearchEngine } from "../../src/index/search-engine.js";
import type { IndexData } from "../../src/index/loader.js";
import type { ClassInfo } from "../../src/index/types.js";

function classInfo(name: string, children: string[] = []): ClassInfo {
  return {
    name,
    source: "enfusion",
    brief: `${name} brief`,
    description: `${name} description`,
    parents: [],
    children,
    group: "Lifecycle",
    sourceFile: "",
    methods: [],
    protectedMethods: [],
    staticMethods: [],
    enums: [],
    properties: [],
    protectedProperties: [],
    docsUrl: "",
  };
}

function indexData(classes: ClassInfo[] = []): IndexData {
  return {
    enfusionClasses: classes,
    armaClasses: [],
    groups: [{ name: "Lifecycle", description: "Lifecycle fixtures", classes: classes.map((cls) => cls.name) }],
    wikiPages: [{ title: "Lifecycle", source: "enfusion", content: "Lazy loading" }],
  };
}

describe("SearchEngine lazy-load lifecycle", () => {
  it("stores configuration without invoking the loader, then loads exactly once", () => {
    const loader = vi.fn(() => indexData([classInfo("Root", ["Leaf"]), classInfo("Leaf")]));
    const engine = new SearchEngine("C:\\not-read-at-construction", loader);

    expect(engine.isLoaded()).toBe(false);
    expect(loader).not.toHaveBeenCalled();

    expect(engine.getClass("Leaf")?.name).toBe("Leaf");
    expect(engine.isLoaded()).toBe(true);
    expect(engine.getStats().totalClasses).toBe(2);
    expect(loader).toHaveBeenCalledOnce();
  });

  it("uses already-loading helpers and never invokes the loader twice on re-entry", () => {
    let engine!: SearchEngine;
    const loader = vi.fn(() => {
      expect(() => engine.getStats()).toThrowError(
        expect.objectContaining({ code: "SEARCH_INDEX_LOAD_FAILED" })
      );
      return indexData([classInfo("ScriptComponent", ["TestComponent"]), classInfo("TestComponent")]);
    });
    engine = new SearchEngine("unused", loader);

    expect(engine.searchComponents().map((entry) => entry.component.name)).toContain("TestComponent");
    expect(loader).toHaveBeenCalledOnce();
  });

  it("publishes nothing after an unexpected partial build failure and caches one stable error", () => {
    const first = classInfo("First");
    const broken = classInfo("Broken");
    Object.defineProperty(broken, "name", {
      get: () => { throw new Error("hostile loader detail " + "x".repeat(10_000)); },
    });
    const loader = vi.fn((): IndexData => ({
      enfusionClasses: [first, broken],
      armaClasses: [],
      groups: [],
      wikiPages: [],
    }));
    const engine = new SearchEngine("C:\\private\\index", loader);

    let firstFailure: unknown;
    try {
      engine.getAllClassNames();
    } catch (error) {
      firstFailure = error;
    }

    expect(firstFailure).toMatchObject({
      name: "SearchIndexLoadError",
      code: "SEARCH_INDEX_LOAD_FAILED",
      message: "Search index initialization failed",
    });
    expect(String(firstFailure)).not.toContain("private");
    expect(String(firstFailure)).not.toContain("hostile");
    expect(engine.isLoaded()).toBe(false);
    let repeatedFailure: unknown;
    try {
      engine.hasClass("First");
    } catch (error) {
      repeatedFailure = error;
    }
    expect(repeatedFailure).toBe(firstFailure);
    expect(loader).toHaveBeenCalledOnce();
  });

  it.each([
    ["getClass", (engine: SearchEngine) => engine.getClass("Root")],
    ["searchClasses", (engine: SearchEngine) => engine.searchClasses("Root")],
    ["searchMethods", (engine: SearchEngine) => engine.searchMethods("method")],
    ["searchEnums", (engine: SearchEngine) => engine.searchEnums("enum")],
    ["searchProperties", (engine: SearchEngine) => engine.searchProperties("property")],
    ["searchAny", (engine: SearchEngine) => engine.searchAny("Root")],
    ["searchWiki", (engine: SearchEngine) => engine.searchWiki("Lifecycle")],
    ["getWikiPage", (engine: SearchEngine) => engine.getWikiPage("Lifecycle")],
    ["getGroups", (engine: SearchEngine) => engine.getGroups()],
    ["getGroup", (engine: SearchEngine) => engine.getGroup("Lifecycle")],
    ["getAllClassNames", (engine: SearchEngine) => engine.getAllClassNames()],
    ["getClassTree", (engine: SearchEngine) => engine.getClassTree("Root")],
    ["getInheritanceChain", (engine: SearchEngine) => engine.getInheritanceChain("Root")],
    ["getInheritedMembers", (engine: SearchEngine) => engine.getInheritedMembers("Root")],
    ["getInheritedMembersLimited", (engine: SearchEngine) => engine.getInheritedMembersLimited("Root")],
    ["getComponents", (engine: SearchEngine) => engine.getComponents()],
    ["searchComponents", (engine: SearchEngine) => engine.searchComponents()],
    ["hasClass", (engine: SearchEngine) => engine.hasClass("Root")],
    ["getStats", (engine: SearchEngine) => engine.getStats()],
  ] as const)("guards %s with the lazy-load boundary", (_name, operation) => {
    const loader = vi.fn(() => indexData([
      classInfo("Root"),
      classInfo("ScriptComponent", ["TestComponent"]),
      classInfo("TestComponent"),
    ]));
    const engine = new SearchEngine("unused", loader);

    operation(engine);

    expect(engine.isLoaded()).toBe(true);
    expect(loader).toHaveBeenCalledOnce();
  });
});
