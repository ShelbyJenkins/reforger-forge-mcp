import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = join(repositoryRoot, "src");

function source(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function typescriptFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
    }
  };
  visit(root);
  return found.sort((left, right) => left.localeCompare(right));
}

describe("CLI stdio composition architecture", () => {
  it("keeps index as a thin CLI adapter and composes the tracked server exactly once", () => {
    const index = source("src/index.ts");
    expect(index).toContain("runMcpStdioServer({");
    expect(index).not.toMatch(/\bnew\s+(?:McpServer|TrackedMcpServer|StdioServerTransport)\b/);
    expect(index).not.toContain("registerTools(");

    const composition = source("src/mcp-stdio-server.ts");
    expect(composition.match(/new\s+TrackedMcpServer\s*\(/g)).toHaveLength(1);
    expect(composition.match(/new\s+ActivityTrackingTransport\s*\(/g)).toHaveLength(1);
    expect(composition.match(/new\s+McpIdleShutdownController\s*\(/g)).toHaveLength(1);
    expect(composition.match(/registerTools\s*\(/g)).toHaveLength(1);
    expect(composition).toMatch(
      /registerTools\s*\([\s\S]*?nowTick:\s*options\.nowTick[\s\S]*?\}\);/
    );

    const server = source("src/server.ts");
    expect(server).toMatch(
      /new\s+McpIdleReadinessInspector\s*\(\{[\s\S]*?nowTick:\s*options\.nowTick[\s\S]*?providers:/
    );
  });

  it("rejects callback registration paths that bypass the tracked public APIs", () => {
    for (const path of typescriptFiles(sourceRoot)) {
      const contents = readFileSync(path, "utf8");
      expect(contents, path).not.toMatch(
        /\.\s*(?:tool|resource|prompt|setRequestHandler|setNotificationHandler|registerToolTask)\s*\(/
      );
      expect(contents, path).not.toMatch(/\bexperimental\s*\.\s*tasks\b/);
      expect(contents, path).not.toMatch(/\bcompletable\s*\(/);
      expect(contents, path).not.toMatch(
        /\b(?:taskStore|TaskStore|COMPLETABLE_SYMBOL)\b|Symbol\.for\(\s*["']mcp\.completable["']\s*\)/
      );
      expect(contents, path).not.toMatch(
        /\.\s*(?:refine|superRefine|transform|preprocess)\s*\(\s*async\b/s
      );
    }
  });

  it("keeps the actor tests and compiled modules in release metadata", () => {
    const packageDocument = JSON.parse(source("package.json")) as {
      scripts: Record<string, string>;
    };
    for (const test of [
      "tests/mcp-activity-transport.test.ts",
      "tests/mcp-idle-shutdown.test.ts",
      "tests/mcp-stdio-composition-architecture.test.ts",
      "tests/setup/mcp-idle-shutdown-stdio.test.ts",
    ]) {
      expect(packageDocument.scripts["test:stage4"]).toContain(test);
      expect(packageDocument.scripts["test:mcp-idle"]).toContain(test);
    }

    const packageCheck = source("scripts/check-package.mjs");
    for (const module of [
      "dist/mcp-activity-transport.js",
      "dist/mcp-idle-shutdown.js",
      "dist/mcp-stdio-server.js",
    ]) {
      expect(packageCheck).toContain(`"${module}"`);
    }
  });
});
