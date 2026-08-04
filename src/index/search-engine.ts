import { loadIndex, type IndexData } from "./loader.js";
import type { ClassInfo, MethodInfo, EnumInfo, PropertyInfo, WikiPage, GroupInfo } from "./types.js";
import { levenshtein, trigramSimilarity } from "../utils/fuzzy.js";

export interface MethodSearchResult {
  className: string;
  classSource: "enfusion" | "arma";
  classGroup: string;
  method: MethodInfo;
}

export interface EnumSearchResult {
  className: string;
  classSource: "enfusion" | "arma";
  classGroup: string;
  enumInfo: EnumInfo;
}

export interface PropertySearchResult {
  className: string;
  classSource: "enfusion" | "arma";
  classGroup: string;
  property: PropertyInfo;
}

export interface SearchResult {
  type: "class" | "method" | "enum" | "property";
  score: number;
  classInfo?: ClassInfo;
  methodResult?: MethodSearchResult;
  enumResult?: EnumSearchResult;
  propertyResult?: PropertySearchResult;
}

export interface ComponentSearchResult {
  component: ClassInfo;
  categories: string[];
  eventHandlers: string[];
  score: number;
}

type SearchEngineLoadState = "unloaded" | "loading" | "loaded" | "failed";
type IndexLoader = (dataDir: string) => IndexData;

interface SearchIndexSnapshot {
  classByName: Map<string, ClassInfo>;
  classNames: string[];
  methodIndex: Map<string, MethodSearchResult[]>;
  enumIndex: Map<string, EnumSearchResult[]>;
  propertyIndex: Map<string, PropertySearchResult[]>;
  wikiPages: WikiPage[];
  wikiPageByTitle: Map<string, WikiPage>;
  groups: GroupInfo[];
  componentIndex: ClassInfo[];
}

const SEARCH_INDEX_LOAD_FAILURE_MESSAGE = "Search index initialization failed";

function emptySnapshot(): SearchIndexSnapshot {
  return {
    classByName: new Map(),
    classNames: [],
    methodIndex: new Map(),
    enumIndex: new Map(),
    propertyIndex: new Map(),
    wikiPages: [],
    wikiPageByTitle: new Map(),
    groups: [],
    componentIndex: [],
  };
}

function searchIndexLoadFailure(): Error & { code: "SEARCH_INDEX_LOAD_FAILED" } {
  const error = Object.assign(new Error(SEARCH_INDEX_LOAD_FAILURE_MESSAGE), {
    code: "SEARCH_INDEX_LOAD_FAILED" as const,
  });
  error.name = "SearchIndexLoadError";
  // Do not retain loader exceptions, file paths, or arbitrarily large values.
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

export class SearchEngine {
  private classByName: Map<string, ClassInfo> = new Map();
  private classNames: string[] = [];
  private methodIndex: Map<string, MethodSearchResult[]> = new Map();
  private enumIndex: Map<string, EnumSearchResult[]> = new Map();
  private propertyIndex: Map<string, PropertySearchResult[]> = new Map();
  private wikiPages: WikiPage[] = [];
  private wikiPageByTitle: Map<string, WikiPage> = new Map();
  private groups: GroupInfo[] = [];
  private componentIndex: ClassInfo[] = [];
  private loadState: SearchEngineLoadState = "unloaded";
  private loadFailure: (Error & { code: "SEARCH_INDEX_LOAD_FAILED" }) | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly indexLoader: IndexLoader = loadIndex
  ) {}

  private ensureLoaded(): void {
    if (this.loadState === "loaded") return;
    if (this.loadState === "failed") throw this.loadFailure!;
    if (this.loadState === "loading") throw searchIndexLoadFailure();

    this.loadState = "loading";
    try {
      const snapshot = this.buildSnapshot(this.indexLoader(this.dataDir));
      this.publishSnapshot(snapshot);
      this.loadState = "loaded";
    } catch {
      this.publishSnapshot(emptySnapshot());
      this.loadFailure ??= searchIndexLoadFailure();
      this.loadState = "failed";
      throw this.loadFailure;
    }
  }

  private buildSnapshot(data: IndexData): SearchIndexSnapshot {
    const snapshot = emptySnapshot();
    snapshot.wikiPages = data.wikiPages;
    for (const page of snapshot.wikiPages) {
      snapshot.wikiPageByTitle.set(page.title.toLowerCase(), page);
    }
    snapshot.groups = data.groups;

    const allClasses = [...data.enfusionClasses, ...data.armaClasses];

    for (const cls of allClasses) {
      const key = cls.name.toLowerCase();
      snapshot.classByName.set(key, cls);
      snapshot.classNames.push(cls.name);

      // Index methods (public + protected + static)
      const allMethods = [
        ...(cls.methods || []),
        ...(cls.protectedMethods || []),
        ...(cls.staticMethods || []),
      ];
      for (const method of allMethods) {
        const methodKey = method.name.toLowerCase();
        let entries = snapshot.methodIndex.get(methodKey);
        if (!entries) {
          entries = [];
          snapshot.methodIndex.set(methodKey, entries);
        }
        entries.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          method,
        });
      }

      // Index enums
      for (const enumInfo of cls.enums || []) {
        const enumKey = enumInfo.name.toLowerCase();
        let entries = snapshot.enumIndex.get(enumKey);
        if (!entries) {
          entries = [];
          snapshot.enumIndex.set(enumKey, entries);
        }
        entries.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          enumInfo,
        });

        // Also index by enum value names for searching
        for (const val of enumInfo.values) {
          const valKey = val.name.toLowerCase();
          let valEntries = snapshot.enumIndex.get(valKey);
          if (!valEntries) {
            valEntries = [];
            snapshot.enumIndex.set(valKey, valEntries);
          }
          // Only add if not already referencing same enum
          if (!valEntries.some((e) => e.enumInfo.name === enumInfo.name && e.className === cls.name)) {
            valEntries.push({
              className: cls.name,
              classSource: cls.source,
              classGroup: cls.group,
              enumInfo,
            });
          }
        }
      }

      // Index properties (public + protected)
      for (const prop of [...(cls.properties || []), ...(cls.protectedProperties || [])]) {
        const propKey = prop.name.toLowerCase();
        let entries = snapshot.propertyIndex.get(propKey);
        if (!entries) {
          entries = [];
          snapshot.propertyIndex.set(propKey, entries);
        }
        entries.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          property: prop,
        });
      }
    }

    // Detect enum-like classes (0 methods, 4+ properties) and index as synthetic enums
    for (const cls of allClasses) {
      const methodCount =
        (cls.methods?.length || 0) +
        (cls.protectedMethods?.length || 0) +
        (cls.staticMethods?.length || 0);
      const allProps = [...(cls.properties || []), ...(cls.protectedProperties || [])];
      if (methodCount > 0 || allProps.length < 4) continue;

      // Build a synthetic EnumInfo from properties
      const syntheticEnum: EnumInfo = {
        name: cls.name,
        description: `[Enum-like class] ${cls.brief || "Static constant values"}`,
        values: allProps.map((p) => ({
          name: p.name,
          value: "",
          description: p.type,
        })),
      };

      const enumEntry: EnumSearchResult = {
        className: cls.name,
        classSource: cls.source,
        classGroup: cls.group,
        enumInfo: syntheticEnum,
      };

      // Index by class name
      const classKey = cls.name.toLowerCase();
      let entries = snapshot.enumIndex.get(classKey);
      if (!entries) {
        entries = [];
        snapshot.enumIndex.set(classKey, entries);
      }
      entries.push(enumEntry);

      // Index by each property/value name
      for (const prop of allProps) {
        const valKey = prop.name.toLowerCase();
        let valEntries = snapshot.enumIndex.get(valKey);
        if (!valEntries) {
          valEntries = [];
          snapshot.enumIndex.set(valKey, valEntries);
        }
        if (!valEntries.some((e) => e.enumInfo.name === syntheticEnum.name && e.className === cls.name)) {
          valEntries.push(enumEntry);
        }
      }
    }

    // Build component index: collect all ScriptComponent descendants
    // Use multiple strategies since scraped inheritance chains are often broken
    const componentKeys = new Set<string>();

    // Strategy 1: Walk descendants from known component base classes
    for (const baseName of ["ScriptComponent", "GenericComponent", "GameComponent", "ScriptGameComponent"]) {
      if (snapshot.classByName.has(baseName.toLowerCase())) {
        const tree = this.getClassTreeFrom(snapshot.classByName, baseName);
        for (const name of tree.descendants) {
          const key = name.toLowerCase();
          if (!componentKeys.has(key)) {
            componentKeys.add(key);
            const cls = snapshot.classByName.get(key);
            if (cls) snapshot.componentIndex.push(cls);
          }
        }
      }
    }

    // Strategy 2: Name-based heuristic — classes ending in "Component" but not "ComponentClass"
    for (const cls of allClasses) {
      if (cls.name.endsWith("Component") && !cls.name.endsWith("ComponentClass")) {
        const key = cls.name.toLowerCase();
        if (!componentKeys.has(key)) {
          componentKeys.add(key);
          snapshot.componentIndex.push(cls);
        }
      }
    }

    return snapshot;
  }

  private publishSnapshot(snapshot: SearchIndexSnapshot): void {
    this.classByName = snapshot.classByName;
    this.classNames = snapshot.classNames;
    this.methodIndex = snapshot.methodIndex;
    this.enumIndex = snapshot.enumIndex;
    this.propertyIndex = snapshot.propertyIndex;
    this.wikiPages = snapshot.wikiPages;
    this.wikiPageByTitle = snapshot.wikiPageByTitle;
    this.groups = snapshot.groups;
    this.componentIndex = snapshot.componentIndex;
  }

  getClass(name: string): ClassInfo | undefined {
    this.ensureLoaded();
    return this.classByName.get(name.toLowerCase());
  }

  searchClasses(
    query: string,
    source: "enfusion" | "arma" | "all" = "all",
    limit = 10
  ): ClassInfo[] {
    this.ensureLoaded();
    const q = query.toLowerCase();
    const results: Array<{ cls: ClassInfo; score: number }> = [];

    for (const cls of this.classByName.values()) {
      if (source !== "all" && cls.source !== source) continue;

      const nameLower = cls.name.toLowerCase();
      let score = 0;

      // Exact match
      if (nameLower === q) {
        score = 100;
      }
      // Prefix match
      else if (nameLower.startsWith(q)) {
        score = 80;
      }
      // Substring in name
      else if (nameLower.includes(q)) {
        score = 60;
      }
      // Match in brief description
      else if (cls.brief.toLowerCase().includes(q)) {
        score = 30;
      }
      // Match in full description
      else if (cls.description.toLowerCase().includes(q)) {
        score = 20;
      }

      if (score > 0) {
        results.push({ cls, score });
      }
    }

    // Fuzzy fallback: only activate when strict matching returns < 3 results
    if (results.length < 3) {
      const seen = new Set(results.map((r) => r.cls.name));
      for (const cls of this.classByName.values()) {
        if (source !== "all" && cls.source !== source) continue;
        if (seen.has(cls.name)) continue;

        const nameLower = cls.name.toLowerCase();
        const dist = levenshtein(q, nameLower);
        if (dist <= 1) {
          results.push({ cls, score: 40 });
        } else if (dist <= 2) {
          results.push({ cls, score: 20 });
        } else {
          const sim = trigramSimilarity(q, nameLower);
          if (sim > 0.3) {
            results.push({ cls, score: 15 });
          }
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.cls);
  }

  searchMethods(
    query: string,
    source: "enfusion" | "arma" | "all" = "all",
    limit = 10
  ): MethodSearchResult[] {
    this.ensureLoaded();
    const q = query.toLowerCase();
    const results: Array<{ result: MethodSearchResult; score: number }> = [];

    for (const [methodName, entries] of this.methodIndex) {
      let score = 0;
      if (methodName === q) {
        score = 100;
      } else if (methodName.startsWith(q)) {
        score = 80;
      } else if (methodName.includes(q)) {
        score = 60;
      }

      if (score > 0) {
        for (const entry of entries) {
          if (source !== "all" && entry.classSource !== source) continue;
          results.push({ result: entry, score });
        }
      }
    }

    // Fuzzy fallback: only activate when strict matching returns < 3 results
    if (results.length < 3) {
      const seen = new Set(results.map((r) => r.result.method.name));
      for (const [methodName, entries] of this.methodIndex) {
        if (seen.has(methodName)) continue;
        const dist = levenshtein(q, methodName);
        let fuzzyScore = 0;
        if (dist <= 1) {
          fuzzyScore = 40;
        } else if (dist <= 2) {
          fuzzyScore = 20;
        } else {
          const sim = trigramSimilarity(q, methodName);
          if (sim > 0.3) fuzzyScore = 15;
        }
        if (fuzzyScore > 0) {
          for (const entry of entries) {
            if (source !== "all" && entry.classSource !== source) continue;
            results.push({ result: entry, score: fuzzyScore });
          }
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.result);
  }

  searchEnums(
    query: string,
    source: "enfusion" | "arma" | "all" = "all",
    limit = 10
  ): EnumSearchResult[] {
    this.ensureLoaded();
    const q = query.toLowerCase();
    const results: Array<{ result: EnumSearchResult; score: number }> = [];
    const seen = new Set<string>();

    for (const [enumKey, entries] of this.enumIndex) {
      let score = 0;
      if (enumKey === q) {
        score = 100;
      } else if (enumKey.startsWith(q)) {
        score = 80;
      } else if (enumKey.includes(q)) {
        score = 60;
      }

      if (score > 0) {
        for (const entry of entries) {
          if (source !== "all" && entry.classSource !== source) continue;
          // Deduplicate by className+enumName
          const dedup = `${entry.className}::${entry.enumInfo.name}`;
          if (seen.has(dedup)) continue;
          seen.add(dedup);
          results.push({ result: entry, score });
        }
      }
    }

    // Fuzzy fallback: only activate when strict matching returns < 3 results
    if (results.length < 3) {
      for (const [enumKey, entries] of this.enumIndex) {
        const dedup = entries.map((e) => `${e.className}::${e.enumInfo.name}`);
        if (dedup.every((d) => seen.has(d))) continue;
        const dist = levenshtein(q, enumKey);
        let fuzzyScore = 0;
        if (dist <= 1) {
          fuzzyScore = 40;
        } else if (dist <= 2) {
          fuzzyScore = 20;
        } else {
          const sim = trigramSimilarity(q, enumKey);
          if (sim > 0.3) fuzzyScore = 15;
        }
        if (fuzzyScore > 0) {
          for (const entry of entries) {
            if (source !== "all" && entry.classSource !== source) continue;
            const dedupKey = `${entry.className}::${entry.enumInfo.name}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            results.push({ result: entry, score: fuzzyScore });
          }
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.result);
  }

  searchProperties(
    query: string,
    source: "enfusion" | "arma" | "all" = "all",
    limit = 10
  ): PropertySearchResult[] {
    this.ensureLoaded();
    const q = query.toLowerCase();
    const results: Array<{ result: PropertySearchResult; score: number }> = [];

    for (const [propName, entries] of this.propertyIndex) {
      let score = 0;
      if (propName === q) {
        score = 100;
      } else if (propName.startsWith(q)) {
        score = 80;
      } else if (propName.includes(q)) {
        score = 60;
      }

      if (score > 0) {
        for (const entry of entries) {
          if (source !== "all" && entry.classSource !== source) continue;
          results.push({ result: entry, score });
        }
      }
    }

    // Fuzzy fallback: only activate when strict matching returns < 3 results
    if (results.length < 3) {
      const seen = new Set(results.map((r) => `${r.result.className}::${r.result.property.name}`));
      for (const [propName, entries] of this.propertyIndex) {
        const dist = levenshtein(q, propName);
        let fuzzyScore = 0;
        if (dist <= 1) {
          fuzzyScore = 40;
        } else if (dist <= 2) {
          fuzzyScore = 20;
        } else {
          const sim = trigramSimilarity(q, propName);
          if (sim > 0.3) fuzzyScore = 15;
        }
        if (fuzzyScore > 0) {
          for (const entry of entries) {
            if (source !== "all" && entry.classSource !== source) continue;
            const dedupKey = `${entry.className}::${entry.property.name}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            results.push({ result: entry, score: fuzzyScore });
          }
        }
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.result);
  }

  searchAny(
    query: string,
    source: "enfusion" | "arma" | "all" = "all",
    limit = 10
  ): SearchResult[] {
    this.ensureLoaded();
    const q = query.toLowerCase();
    const combined: SearchResult[] = [];

    // Classes — score directly to preserve granularity
    for (const cls of this.classByName.values()) {
      if (source !== "all" && cls.source !== source) continue;
      const score = this.nameScore(cls.name.toLowerCase(), q);
      if (score > 0) combined.push({ type: "class", score, classInfo: cls });
    }

    // Methods
    for (const [methodName, entries] of this.methodIndex) {
      const score = this.nameScore(methodName, q);
      if (score <= 0) continue;
      for (const entry of entries) {
        if (source !== "all" && entry.classSource !== source) continue;
        combined.push({ type: "method", score, methodResult: entry });
      }
    }

    // Enums
    const seenEnums = new Set<string>();
    for (const [enumKey, entries] of this.enumIndex) {
      const score = this.nameScore(enumKey, q);
      if (score <= 0) continue;
      for (const entry of entries) {
        if (source !== "all" && entry.classSource !== source) continue;
        const dedup = `${entry.className}::${entry.enumInfo.name}`;
        if (seenEnums.has(dedup)) continue;
        seenEnums.add(dedup);
        combined.push({ type: "enum", score, enumResult: entry });
      }
    }

    // Properties
    for (const [propName, entries] of this.propertyIndex) {
      const score = this.nameScore(propName, q);
      if (score <= 0) continue;
      for (const entry of entries) {
        if (source !== "all" && entry.classSource !== source) continue;
        combined.push({ type: "property", score, propertyResult: entry });
      }
    }

    combined.sort((a, b) => b.score - a.score);
    return combined.slice(0, limit);
  }

  private nameScore(nameLower: string, queryLower: string): number {
    if (nameLower === queryLower) return 100;
    if (nameLower.startsWith(queryLower)) return 80;
    if (nameLower.includes(queryLower)) return 60;
    return 0;
  }

  searchWiki(query: string, limit = 5): WikiPage[] {
    this.ensureLoaded();
    const tokens = query.toLowerCase().split(/\s+/);
    const results: Array<{ page: WikiPage; score: number }> = [];

    for (const page of this.wikiPages) {
      const titleLower = page.title.toLowerCase();
      const contentLower = page.content.toLowerCase();
      let score = 0;

      for (const token of tokens) {
        if (titleLower.includes(token)) score += 10;
        if (contentLower.includes(token)) score += 1;
      }

      if (score > 0) {
        results.push({ page, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.page);
  }

  /** Look up a wiki page by exact title (case-insensitive). */
  getWikiPage(title: string): WikiPage | undefined {
    this.ensureLoaded();
    return this.wikiPageByTitle.get(title.toLowerCase());
  }

  getGroups(): GroupInfo[] {
    this.ensureLoaded();
    return this.groups;
  }

  getGroup(name: string): GroupInfo | undefined {
    this.ensureLoaded();
    return this.groups.find((g) => g.name.toLowerCase() === name.toLowerCase());
  }

  /** Get all class names (for resource listing) */
  getAllClassNames(): string[] {
    this.ensureLoaded();
    return this.classNames;
  }

  /**
   * Get the full inheritance tree for a class.
   * Walks up through parents[] and down through children[].
   */
  getClassTree(name: string): { ancestors: string[]; descendants: string[] } {
    this.ensureLoaded();
    return this.getClassTreeFrom(this.classByName, name);
  }

  private getClassTreeFrom(
    classByName: ReadonlyMap<string, ClassInfo>,
    name: string
  ): { ancestors: string[]; descendants: string[] } {
    const ancestors: string[] = [];
    const descendants: string[] = [];

    // Walk up to ancestors
    const visited = new Set<string>();
    const walkUp = (className: string) => {
      const cls = classByName.get(className.toLowerCase());
      if (!cls) return;
      for (const parent of cls.parents) {
        if (visited.has(parent.toLowerCase())) continue;
        visited.add(parent.toLowerCase());
        ancestors.push(parent);
        walkUp(parent);
      }
    };
    walkUp(name);

    // Walk down to descendants
    visited.clear();
    const walkDown = (className: string) => {
      const cls = classByName.get(className.toLowerCase());
      if (!cls) return;
      for (const child of cls.children) {
        if (visited.has(child.toLowerCase())) continue;
        visited.add(child.toLowerCase());
        descendants.push(child);
        walkDown(child);
      }
    };
    walkDown(name);

    return { ancestors, descendants };
  }

  /**
   * Get the ordered inheritance chain from root to the given class.
   * Returns [root, ..., parent, className].
   */
  getInheritanceChain(name: string): string[] {
    this.ensureLoaded();
    const chain: string[] = [name];
    const visited = new Set<string>([name.toLowerCase()]);
    let current = name;

    while (true) {
      const cls = this.getClass(current);
      if (!cls || cls.parents.length === 0) break;
      const parent = cls.parents[0];
      if (visited.has(parent.toLowerCase())) break; // cycle protection
      visited.add(parent.toLowerCase());
      chain.unshift(parent);
      current = parent;
    }

    return chain;
  }

  /**
   * Get all inherited members by walking the inheritance chain.
   * Returns methods, properties, and enums from all ancestor classes.
   */
  getInheritedMembers(name: string): {
    methods: MethodSearchResult[];
    properties: PropertySearchResult[];
    enums: EnumSearchResult[];
  } {
    this.ensureLoaded();
    const methods: MethodSearchResult[] = [];
    const properties: PropertySearchResult[] = [];
    const enums: EnumSearchResult[] = [];
    const seenMethods = new Set<string>();
    const seenProps = new Set<string>();
    const seenEnums = new Set<string>();

    const chain = this.getInheritanceChain(name);
    // Skip the class itself — only include ancestors (nearest parent first)
    const ancestors = chain.slice(0, -1).reverse();
    for (const ancestorName of ancestors) {
      const cls = this.getClass(ancestorName);
      if (!cls) continue;

      for (const method of [...(cls.methods || []), ...(cls.protectedMethods || []), ...(cls.staticMethods || [])]) {
        if (seenMethods.has(method.name)) continue;
        seenMethods.add(method.name);
        methods.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          method,
        });
      }

      for (const prop of [...(cls.properties || []), ...(cls.protectedProperties || [])]) {
        if (seenProps.has(prop.name)) continue;
        seenProps.add(prop.name);
        properties.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          property: prop,
        });
      }

      for (const enumInfo of cls.enums || []) {
        if (seenEnums.has(enumInfo.name)) continue;
        seenEnums.add(enumInfo.name);
        enums.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          enumInfo,
        });
      }
    }

    return { methods, properties, enums };
  }

  /**
   * Get inherited members from only the N nearest parent classes.
   * Returns members ordered from immediate parent outward.
   */
  getInheritedMembersLimited(
    name: string,
    maxParents = 3
  ): {
    methods: MethodSearchResult[];
    properties: PropertySearchResult[];
    enums: EnumSearchResult[];
    parentClassNames: string[];
  } {
    this.ensureLoaded();
    const methods: MethodSearchResult[] = [];
    const properties: PropertySearchResult[] = [];
    const enums: EnumSearchResult[] = [];
    const parentClassNames: string[] = [];

    const chain = this.getInheritanceChain(name);
    // chain is [root, ..., parent, className]
    // Take the nearest N ancestors (excluding the class itself), then reverse so immediate parent is first
    const ancestors = chain.slice(0, -1);
    const nearest = ancestors.slice(-maxParents).reverse();

    for (const ancestorName of nearest) {
      const cls = this.getClass(ancestorName);
      if (!cls) continue;

      parentClassNames.push(cls.name);

      for (const method of [
        ...(cls.methods || []),
        ...(cls.protectedMethods || []),
        ...(cls.staticMethods || []),
      ]) {
        methods.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          method,
        });
      }

      for (const prop of [
        ...(cls.properties || []),
        ...(cls.protectedProperties || []),
      ]) {
        properties.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          property: prop,
        });
      }

      for (const enumInfo of cls.enums || []) {
        enums.push({
          className: cls.name,
          classSource: cls.source,
          classGroup: cls.group,
          enumInfo,
        });
      }
    }

    return { methods, properties, enums, parentClassNames };
  }

  /**
   * Get all classes that inherit from ScriptComponent (directly or indirectly).
   * Useful for finding available components to attach to entities.
   */
  getComponents(): ClassInfo[] {
    this.ensureLoaded();
    const tree = this.getClassTree("ScriptComponent");
    const results: ClassInfo[] = [];
    for (const name of tree.descendants) {
      const cls = this.getClass(name);
      if (cls) results.push(cls);
    }
    return results;
  }

  /**
   * Infer categories for a component based on class name and group keywords.
   */
  private inferComponentCategories(cls: ClassInfo): string[] {
    const categories: string[] = [];
    const nameLower = cls.name.toLowerCase();
    const groupLower = (cls.group || "").toLowerCase();
    const combined = nameLower + " " + groupLower;

    if (combined.includes("character")) categories.push("character");
    if (combined.includes("vehicle")) categories.push("vehicle");
    if (combined.includes("weapon")) categories.push("weapon");
    if (combined.includes("damage") || combined.includes("hitzone")) categories.push("damage");
    if (combined.includes("inventory") || combined.includes("storage")) categories.push("inventory");
    if (combined.includes("aigroup") || combined.includes("aibehavior") || combined.includes("aicomponent") || /\bai[A-Z_]/.test(cls.name) || /\bai\b/.test(groupLower)) categories.push("ai");
    if (combined.includes("widget") || combined.includes("layout") || combined.includes("hud") || combined.includes("menu")) categories.push("ui");
    if (combined.includes("editor") || combined.includes("workbench")) categories.push("editor");
    if (combined.includes("camera")) categories.push("camera");
    if (combined.includes("sound") || combined.includes("audio")) categories.push("sound");

    if (categories.length === 0) categories.push("general");
    return categories;
  }

  /**
   * Extract event handler method names from a component class.
   * Looks for methods starting with "EOn" or "On" (Enfusion event naming conventions).
   */
  private getEventHandlers(cls: ClassInfo): string[] {
    const handlers: string[] = [];
    const allMethods = [
      ...(cls.methods || []),
      ...(cls.protectedMethods || []),
    ];

    for (const method of allMethods) {
      if (/^(EOn|On)[A-Z]/.test(method.name)) {
        handlers.push(method.name);
      }
    }

    return handlers;
  }

  /**
   * Search for ScriptComponent descendants with optional filtering.
   * Supports filtering by name/keyword, entity category, and event handlers.
   */
  searchComponents(options: {
    query?: string;
    category?: string;
    event?: string;
    source?: "enfusion" | "arma" | "all";
    limit?: number;
  } = {}): ComponentSearchResult[] {
    this.ensureLoaded();
    const { query, category = "any", event, source = "all", limit = 20 } = options;
    const q = query?.toLowerCase();
    const eventLower = event?.toLowerCase();
    const results: ComponentSearchResult[] = [];

    for (const cls of this.componentIndex) {
      // Source filter
      if (source !== "all" && cls.source !== source) continue;

      // Category filter
      const categories = this.inferComponentCategories(cls);
      if (category !== "any" && !categories.includes(category)) continue;

      // Event filter
      const eventHandlers = this.getEventHandlers(cls);
      if (eventLower) {
        const hasMatch = eventHandlers.some((h) => h.toLowerCase().includes(eventLower));
        if (!hasMatch) continue;
      }

      // Query scoring (same pattern as searchClasses)
      let score = 0;
      if (q) {
        const nameLower = cls.name.toLowerCase();
        if (nameLower === q) {
          score = 100;
        } else if (nameLower.startsWith(q)) {
          score = 80;
        } else if (nameLower.includes(q)) {
          score = 60;
        } else if (cls.brief.toLowerCase().includes(q)) {
          score = 30;
        } else if (cls.description.toLowerCase().includes(q)) {
          score = 20;
        } else {
          // Query didn't match anything on this component
          continue;
        }
      } else {
        // No query — give a base score so category/event-only filters work
        score = 10;
      }

      results.push({ component: cls, categories, eventHandlers, score });
    }

    results.sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name));
    return results.slice(0, limit);
  }

  /**
   * Check if a class name exists in the index (case-insensitive).
   */
  hasClass(name: string): boolean {
    this.ensureLoaded();
    return this.classByName.has(name.toLowerCase());
  }

  isLoaded(): boolean {
    return this.loadState === "loaded";
  }

  getStats(): {
    totalClasses: number;
    totalMethods: number;
    totalEnums: number;
    totalProperties: number;
    totalWikiPages: number;
    totalComponents: number;
  } {
    this.ensureLoaded();
    return {
      totalClasses: this.classByName.size,
      totalMethods: this.methodIndex.size,
      totalEnums: this.enumIndex.size,
      totalProperties: this.propertyIndex.size,
      totalWikiPages: this.wikiPages.length,
      totalComponents: this.componentIndex.length,
    };
  }
}
