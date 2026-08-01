import { readFileSync, readdirSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const TESTS_ROOT = join(REPOSITORY_ROOT, "tests");
const TEST_SOURCE_EXTENSION = /\.(?:[cm]?[jt]s)$/i;

function testSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...testSourceFiles(path));
    else if (entry.isFile() && TEST_SOURCE_EXTENSION.test(entry.name)) files.push(path);
  }
  return files;
}

function repositoryRelative(path: string): string {
  return relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
}

function isInsideRepository(path: string): boolean {
  const result = relative(REPOSITORY_ROOT, resolve(path));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function isImportMetaDirname(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === "dirname"
    && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === "meta";
}

function moduleSpecifier(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return node.arguments[0];
  }
  return undefined;
}

function sourceBoundaryViolations(path: string): string[] {
  const contents = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  const pathFunctions = new Map<string, "join" | "resolve">();
  const pathNamespaces = new Set<string>();
  const staticPaths = new Map<string, string>();
  const violations: string[] = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)
        || !ts.isStringLiteral(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== "node:path") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) pathNamespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "join" || imported === "resolve") {
          pathFunctions.set(element.name.text, imported);
        }
      }
    }
  }

  const pathOperation = (expression: ts.Expression): "join" | "resolve" | undefined => {
    if (ts.isIdentifier(expression)) return pathFunctions.get(expression.text);
    if (ts.isPropertyAccessExpression(expression)
        && ts.isIdentifier(expression.expression)
        && pathNamespaces.has(expression.expression.text)
        && (expression.name.text === "join" || expression.name.text === "resolve")) {
      return expression.name.text;
    }
    return undefined;
  };
  const evaluateStaticPath = (expression: ts.Expression): string | undefined => {
    if (isImportMetaDirname(expression)) return dirname(path);
    if (ts.isIdentifier(expression)) return staticPaths.get(expression.text);
    if (!ts.isCallExpression(expression)) return undefined;
    const operation = pathOperation(expression.expression);
    if (!operation || expression.arguments.length === 0) return undefined;
    const base = evaluateStaticPath(expression.arguments[0]!);
    const segments = expression.arguments.slice(1);
    if (!base || !segments.every(ts.isStringLiteralLike)) return undefined;
    const values = segments.map((segment) => segment.text);
    return operation === "join" ? join(base, ...values) : resolve(base, ...values);
  };

  // Resolve top-level const aliases in declaration order, then repeat so a
  // later declaration can safely refer to an earlier repository-root alias.
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer
            || staticPaths.has(declaration.name.text)) continue;
        const value = evaluateStaticPath(declaration.initializer);
        if (value) {
          staticPaths.set(declaration.name.text, value);
          discovered = true;
        }
      }
    }
  }

  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifier(node);
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith(".")) {
      const target = resolve(dirname(path), specifier.text);
      if (!isInsideRepository(target)) {
        violations.push(`${repositoryRelative(path)} imports outside the repository: ${specifier.text}`);
      }
    }

    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const operation = pathOperation(node.expression);
      const base = evaluateStaticPath(node.arguments[0]!);
      const segments = node.arguments.slice(1);
      if (operation && base && segments.every(ts.isStringLiteralLike)) {
        const values = segments.map((segment) => segment.text);
        const target = operation === "join"
          ? join(base, ...values)
          : resolve(base, ...values);
        if (!isInsideRepository(target)) {
          violations.push(
            `${repositoryRelative(path)} anchors a static test path outside the repository: ${repositoryRelative(target)}`
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function localDependencyViolations(): string[] {
  const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
  const violations: string[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = packageJson[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [name, rawSpecifier] of Object.entries(dependencies as Record<string, unknown>)) {
      if (typeof rawSpecifier !== "string") continue;
      const specifier = rawSpecifier.replace(/^(?:file|link):/, "");
      if (!rawSpecifier.startsWith("file:") && !rawSpecifier.startsWith("link:")
          && !specifier.startsWith(".") && !isAbsolute(specifier)) continue;
      const target = resolve(REPOSITORY_ROOT, specifier);
      if (!isInsideRepository(target)) {
        violations.push(`package.json ${field}.${name} resolves outside the repository: ${rawSpecifier}`);
      }
    }
  }
  const packageLock = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package-lock.json"), "utf8")) as {
    packages?: Record<string, { resolved?: unknown }>;
  };
  for (const [packagePath, entry] of Object.entries(packageLock.packages ?? {})) {
    if (packagePath && (packagePath.startsWith(".") || isAbsolute(packagePath))) {
      const target = resolve(REPOSITORY_ROOT, packagePath);
      if (!isInsideRepository(target)) {
        violations.push(`package-lock.json package path resolves outside the repository: ${packagePath}`);
      }
    }
    if (typeof entry.resolved !== "string") continue;
    const resolvedSpecifier = entry.resolved.replace(/^(?:file|link):/, "");
    if (!entry.resolved.startsWith("file:") && !entry.resolved.startsWith("link:")
        && !resolvedSpecifier.startsWith(".") && !isAbsolute(resolvedSpecifier)) continue;
    const target = resolve(REPOSITORY_ROOT, resolvedSpecifier);
    if (!isInsideRepository(target)) {
      violations.push(`package-lock.json ${packagePath || "<root>"} resolves outside the repository: ${entry.resolved}`);
    }
  }
  return violations;
}

describe("repository hermeticity", () => {
  it("keeps static test fixtures, imports, and local package dependencies inside the checkout", () => {
    const violations = [
      ...testSourceFiles(TESTS_ROOT).flatMap(sourceBoundaryViolations),
      ...localDependencyViolations(),
    ];

    expect(violations).toEqual([]);
  });
});
