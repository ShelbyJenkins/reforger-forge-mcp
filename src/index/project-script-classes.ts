import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  dirname,
  extname,
  join,
  parse as parsePath,
  resolve,
} from "node:path";
import { getProperty, parse } from "../formats/enfusion-text.js";

const SCRIPT_MODULES = [
  join("Scripts", "Game"),
  join("Scripts", "GameLib"),
  join("Scripts", "WorkbenchGame"),
] as const;
const BASE_GAME_GUID = "58D0FB3206B6F859";
const GUID_PATTERN = /^[0-9A-F]{16}$/;
const CLASS_DECLARATION =
  /^[\t ]*(?:modded[\t ]+)?class[\t ]+([A-Za-z_][A-Za-z0-9_]*)\b/gm;

interface ProjectDescriptor {
  gprojPath: string;
  projectRoot: string;
  guid: string;
  dependencies: string[];
}

export interface DeclaredProjectClassIndexOptions {
  targetProjectPath: string;
  /** Roots in which declared dependency GUIDs may be resolved. */
  searchRoots?: readonly string[];
}

/**
 * Index script classes from the target project and only the transitive local
 * projects selected by its declared dependency GUIDs.
 */
export function indexDeclaredProjectClasses(
  options: DeclaredProjectClassIndexOptions
): Set<string> {
  const targetProjectPath = resolve(options.targetProjectPath);
  const candidateFiles = new Set<string>();

  // The target is always authoritative, even when it is located directly
  // beneath a filesystem root where implicit sibling discovery is disabled.
  const targetGprojFiles = directFiles(targetProjectPath, ".gproj");
  for (const path of targetGprojFiles) candidateFiles.add(path);

  // Local multi-project mods commonly place dependencies in immediate sibling
  // directories. Keep this implicit lookup shallow so a project such as
  // C:\MyMod never causes a synchronous walk of the entire drive.
  for (const path of findImplicitSiblingProjects(targetProjectPath)) {
    candidateFiles.add(path);
  }

  // Configured roots are explicit discovery boundaries and may contain nested
  // project collections, so recursive discovery remains appropriate for them.
  for (const root of deduplicatePaths(options.searchRoots ?? [])) {
    for (const path of findFiles(root, ".gproj")) candidateFiles.add(path);
  }

  // A target without a parseable .gproj still gets its own classes indexed;
  // dependency resolution simply remains unavailable.
  const descriptors = [...candidateFiles]
    .map(readDescriptor)
    .filter((value): value is ProjectDescriptor => value !== null);
  const descriptorsByGuid = new Map<string, ProjectDescriptor[]>();
  for (const descriptor of descriptors) {
    const current = descriptorsByGuid.get(descriptor.guid) ?? [];
    if (!current.some((item) => pathKey(item.gprojPath) === pathKey(descriptor.gprojPath))) {
      current.push(descriptor);
      descriptorsByGuid.set(descriptor.guid, current);
    }
  }

  const selectedRoots = new Map<string, string>([
    [pathKey(targetProjectPath), targetProjectPath],
  ]);
  const pendingGuids: string[] = [];
  for (const path of targetGprojFiles) {
    const descriptor = readDescriptor(path);
    if (descriptor) pendingGuids.push(...descriptor.dependencies);
  }

  const visitedGuids = new Set<string>();
  while (pendingGuids.length > 0) {
    const guid = pendingGuids.shift()!;
    if (guid === BASE_GAME_GUID || visitedGuids.has(guid)) continue;
    visitedGuids.add(guid);

    const candidates = descriptorsByGuid.get(guid) ?? [];
    // Duplicate GUIDs are ambiguous. Do not choose one and accidentally make
    // undeclared or shadowed script classes authoritative.
    if (candidates.length !== 1) continue;

    const dependency = candidates[0];
    selectedRoots.set(pathKey(dependency.projectRoot), dependency.projectRoot);
    pendingGuids.push(...dependency.dependencies);
  }

  const classes = new Set<string>();
  for (const root of selectedRoots.values()) {
    for (const modulePath of SCRIPT_MODULES) {
      const directory = join(root, modulePath);
      for (const scriptPath of findFiles(directory, ".c")) {
        try {
          const source = readFileSync(scriptPath, "utf8");
          CLASS_DECLARATION.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = CLASS_DECLARATION.exec(source)) !== null) {
            classes.add(match[1].toLowerCase());
          }
        } catch {
          // The validator's existing script check reports unreadable sources.
        }
      }
    }
  }
  return classes;
}

/**
 * Discover only direct sibling projects around a target. Exported as a small
 * test seam for the filesystem-root guard.
 */
export function findImplicitSiblingProjects(targetProjectPath: string): string[] {
  const targetRoot = resolve(targetProjectPath);
  const parent = dirname(targetRoot);
  if (pathKey(parent) === pathKey(parsePath(parent).root)) return [];

  const results = directFiles(parent, ".gproj");
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    results.push(...directFiles(join(parent, entry.name), ".gproj"));
  }
  return results;
}

function readDescriptor(gprojPath: string): ProjectDescriptor | null {
  try {
    const document = parse(readFileSync(gprojPath, "utf8"));
    if (document.type !== "GameProject") return null;
    const guidValue = getProperty(document, "GUID");
    const guid = typeof guidValue === "string" ? guidValue.toUpperCase() : "";
    if (!GUID_PATTERN.test(guid)) return null;
    const dependencies = document.children
      .find((child) => child.type === "Dependencies")
      ?.values
      .map((value) => value.toUpperCase())
      .filter((value) => GUID_PATTERN.test(value)) ?? [];
    return {
      gprojPath: resolve(gprojPath),
      projectRoot: dirname(resolve(gprojPath)),
      guid,
      dependencies,
    };
  } catch {
    return null;
  }
}

function directFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) =>
        entry.isFile() && extname(entry.name).toLowerCase() === extension
      )
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

function findFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  const results: string[] = [];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile()
        && extname(entry.name).toLowerCase() === extension
      ) {
        results.push(path);
      }
    }
  };
  visit(directory);
  return results;
}

function deduplicatePaths(paths: readonly string[]): string[] {
  const result = new Map<string, string>();
  for (const path of paths) {
    const absolute = resolve(path);
    if (!existsSync(absolute)) continue;
    result.set(pathKey(absolute), absolute);
  }
  return [...result.values()];
}

function pathKey(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
}
