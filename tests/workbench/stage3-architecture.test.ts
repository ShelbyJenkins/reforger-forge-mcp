import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workbenchSourceRoot = join(repositoryRoot, "src", "workbench");

function source(name: string): string {
  return readFileSync(join(workbenchSourceRoot, name), "utf8");
}

function syntaxTree(name: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    source(name),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function importedNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return [];
  const names = clause.name ? [clause.name.text] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
  if (bindings && ts.isNamedImports(bindings)) {
    names.push(...bindings.elements.map((element) => element.name.text));
  }
  return names.sort();
}

describe("Stage 3 Workbench architecture boundaries", () => {
  it("hash-binds the converged Workbench runtime in controlled evidence", () => {
    const acceptance = readFileSync(
      join(repositoryRoot, "scripts", "run-workbench-observer-acceptance.ts"),
      "utf8"
    );
    for (const path of [
      "src/foundation/child-supervisor.ts",
      "src/workbench/activity-gate.ts",
      "src/workbench/diagnostics.ts",
      "src/workbench/launch-plan.ts",
      "src/workbench/lifecycle-execution.ts",
      "src/workbench/managed-build-profile.ts",
      "src/workbench/net-api-client.ts",
      "src/workbench/protocol.ts",
      "src/workbench/readiness.ts",
      "src/workbench/session-controller.ts",
      "src/workbench/session-state.ts",
    ]) {
      expect(acceptance).toContain(`"${path}"`);
    }
  });

  it("keeps socket construction and the NET API codec in net-api-client", () => {
    const files = readdirSync(workbenchSourceRoot)
      .filter((name) => name.endsWith(".ts"))
      .sort();
    const netImports: Array<{ file: string; names: string[] }> = [];
    const codecImports: Array<{ file: string; names: string[] }> = [];

    for (const file of files) {
      for (const statement of syntaxTree(file).statements) {
        if (!ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const module = statement.moduleSpecifier.text;
        if (module === "node:net") {
          // `isIP` is pure endpoint validation; it does not create or own a socket.
          const names = importedNames(statement).filter((name) => name !== "isIP");
          if (names.length > 0) netImports.push({ file, names });
        }
        if (module === "./protocol.js") {
          const names = importedNames(statement).filter((name) =>
            ["decodePascalString", "decodeResponse", "encodeRequest"].includes(name)
          );
          if (names.length > 0) codecImports.push({ file, names });
        }
      }

      if (file !== "net-api-client.ts") {
        expect(source(file)).not.toMatch(
          /\b(?:new\s+Socket|createConnection\s*\(|createServer\s*\()/
        );
      }
    }

    expect(netImports).toEqual([
      { file: "net-api-client.ts", names: ["Socket"] },
    ]);
    expect(codecImports).toEqual([
      {
        file: "net-api-client.ts",
        names: ["decodePascalString", "encodeRequest"],
      },
    ]);
  });

  it("keeps client.ts as an export-only compatibility facade", () => {
    const tree = syntaxTree("client.ts");
    expect(tree.statements.length).toBeGreaterThan(0);
    expect(tree.statements.every(ts.isExportDeclaration)).toBe(true);

    const exportTargets = tree.statements
      .filter(ts.isExportDeclaration)
      .map((statement) => statement.moduleSpecifier)
      .filter((specifier): specifier is ts.StringLiteral =>
        specifier !== undefined && ts.isStringLiteral(specifier))
      .map((specifier) => specifier.text);
    expect(exportTargets).toEqual([
      "./session-controller.js",
      "./session-controller.js",
      "./diagnostics.js",
    ]);
  });

  it("keeps runner.ts as policy over the controller lifecycle port", () => {
    const tree = syntaxTree("runner.ts");
    const importedModules = tree.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => statement.moduleSpecifier)
      .filter((specifier): specifier is ts.StringLiteral =>
        specifier !== undefined && ts.isStringLiteral(specifier))
      .map((specifier) => specifier.text);
    expect(importedModules).not.toEqual(expect.arrayContaining([
      "node:child_process",
      "../foundation/child-supervisor.js",
      "../foundation/recoverable-spawn.js",
      "./process-guard.js",
    ]));

    const runner = source("runner.ts");
    expect(runner).not.toMatch(/\b(?:spawnChild|runRecoverableSpawn|WorkbenchProcessGuard)\b/);
    expect(runner).not.toMatch(/\blifecycleStateDraft\s*\(/);
    expect(runner).not.toMatch(/\bnew\s+ChildSupervisor\s*\(/);
  });

  it("keeps one recoverable-spawn and supervision boundary for every Workbench plan", () => {
    const files = readdirSync(workbenchSourceRoot)
      .filter((name) => name.endsWith(".ts"))
      .sort();
    const recoverableSpawnCallOwners: string[] = [];
    const childSupervisionOwners: string[] = [];

    for (const file of files) {
      const contents = source(file);
      if (/\brunRecoverableSpawn\s*\(/.test(contents)) {
        recoverableSpawnCallOwners.push(file);
      }
      if (/\bchildSupervisor\.supervise\s*\(/.test(contents)) {
        childSupervisionOwners.push(file);
      }
    }

    expect(recoverableSpawnCallOwners).toEqual(["lifecycle-execution.ts"]);
    expect(childSupervisionOwners).toEqual(["lifecycle-execution.ts"]);

    const controller = source("session-controller.ts");
    expect(controller).toContain("this.runnerLifecycleExecution.spawnRecoverable({");
    expect(controller).toContain("execution.spawnRecoverable({");
    expect(controller).not.toMatch(/\brunRecoverableSpawn\s*\(/);
    expect(controller).not.toMatch(/\bchildSupervisor\.supervise\s*\(/);

    const runner = source("runner.ts");
    for (const method of [
      "runForegroundEditor",
      "runTemporaryCompanionPreflight",
      "runTargetBuild",
    ]) {
      expect(runner).toContain(`controller.${method}(`);
    }
  });

  it("keeps target-build policy structurally helper-free and exit-bounded", () => {
    const tree = syntaxTree("launch-plan.ts");
    const targetPlan = tree.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === "TargetBuildLaunchPlan"
    );
    const builder = tree.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "buildTargetBuildLaunchPlan"
    );
    expect(targetPlan).toBeDefined();
    expect(builder).toBeDefined();

    const properties = new Map(
      targetPlan!.members
        .filter(ts.isPropertySignature)
        .map((property) => [property.name.getText(tree), property.type?.getText(tree) ?? ""])
    );
    expect(properties.get("kind")).toBe('"target_build"');
    expect(properties.get("window")).toBe('"hidden"');
    expect(properties.get("process")).toBe('"foreground"');
    expect(properties.get("helper")).toBe("null");
    expect(properties.get("readiness")).toMatch(/kind:\s*"none"/);
    expect(properties.get("lifetime")).toMatch(/absoluteDeadline:\s*true/);

    const implementation = builder!.getText(tree);
    expect(implementation).toContain('argv.includes("-run")');
    expect(implementation).toContain('argv.includes("-addons")');
    expect(implementation).toContain("WORKBENCH_HELPER_ADDON_GUID");
    expect(implementation).toContain("helper: null");
    expect(implementation).toContain('readiness: Object.freeze({ kind: "none" })');
    expect(implementation).toContain('"-builddata"');

    const controller = source("session-controller.ts");
    expect(controller).toContain("return buildLegacyWorkbenchLaunchArguments(");
    expect(controller).not.toMatch(/const\s+addonDirs\s*:\s*string\[\]/);
  });
});
