import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientTemplates = [
  {
    path: "agents/configs/stdio-template.json",
    rootKey: "mcpServers",
    clientLabel: "REPLACE_WITH_CLIENT_LABEL",
  },
  {
    path: "agents/configs/vscode-template.json",
    rootKey: "servers",
    clientLabel: "vscode",
  },
  {
    path: "agents/configs/claude-desktop.json",
    rootKey: "mcpServers",
    clientLabel: "claude-desktop",
  },
  {
    path: "agents/configs/cursor-global.json",
    rootKey: "mcpServers",
    clientLabel: "cursor",
  },
] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

function readBytes(relativePath: string): Buffer {
  return readFileSync(resolve(repositoryRoot, relativePath));
}

function readServerEntry(
  relativePath: string,
  rootKey: string
): Record<string, unknown> {
  const document = JSON.parse(read(relativePath)) as Record<string, unknown>;
  const root = document[rootKey] as Record<string, unknown> | undefined;
  return root?.["reforger-forge"] as Record<string, unknown>;
}

describe("standard MCP client configuration contract", () => {
  it("keeps the example timeout explicit and within the server-only bounds", () => {
    const example = JSON.parse(read("reforger-forge.config.example.json")) as Record<string, unknown>;
    expect(example.mcpIdleShutdownMs).toBe(1_800_000);
  });

  it.each(clientTemplates)(
    "$path launches a labeled Node host with no configuration overrides",
    ({ path, rootKey, clientLabel }) => {
      const entry = readServerEntry(path, rootKey);
      const serialized = JSON.stringify(entry);
      const args = entry.args as unknown[];

      expect(entry.command).toBe("node");
      expect(args).toHaveLength(4);
      expect(args[0]).toBe(`--title=ReforgerForge-MCP-${clientLabel}`);
      expect(args[1]).toMatch(/dist[\\/]index\.js$/);
      expect(args[2]).toBe("--mcp-client-label");
      expect(args[3]).toBe(clientLabel);
      expect(entry).not.toHaveProperty("env");
      expect(entry).not.toHaveProperty("env_vars");
      expect(serialized).not.toMatch(/--config|--project-path/i);
      expect(serialized).not.toMatch(/ENFUSION_|REFORGER_FORGE_/);
    }
  );

  it.each(clientTemplates)(
    "$path is UTF-8 JSON without a byte-order mark",
    ({ path }) => {
      const bytes = readBytes(path);

      expect(Array.from(bytes.subarray(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes[0]).toBe("{".charCodeAt(0));
      expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();
    }
  );

  it("the Claude template invokes node directly without a command-shell wrapper", () => {
    const entry = readServerEntry(
      "agents/configs/claude-desktop.json",
      "mcpServers"
    );

    expect(entry.command).toBe("node");
    expect(entry.args).not.toContain("/c");
    expect(JSON.stringify(entry)).not.toMatch(/\bcmd(?:\.exe)?\b/i);
  });

});

describe("manual explicit-configuration installer contract", () => {
  it("accepts ConfigPath and registers it instead of copying values into env", () => {
    const installer = read("agents/install-agents.ps1");

    expect(installer).toMatch(
      /\[Parameter\(Mandatory\s*=\s*\$true\)\]\s*\r?\n\s*\[string\]\$ConfigPath/
    );
    expect(installer).toMatch(/\[string\]\$ConfigPath/);
    expect(installer).toContain("function New-McpServerArguments");
    expect(installer).toContain('"--config",');
    for (const label of [
      "codex",
      "cursor",
      "antigravity",
      "claude-desktop",
      "windsurf",
      "vscode",
      "continue",
      "kiro",
    ]) {
      expect(installer).toContain(`-ClientLabel "${label}"`);
    }
    expect(installer).toContain("--mcp-client-label agent-installer");
    expect(installer).not.toMatch(/ENFUSION_|REFORGER_FORGE_|envBlock/);
    expect(installer).toMatch(/\bfunction Install-Codex\b/);
    expect(installer).toContain(
      "& $codexCommand.Source mcp get reforger-forge --json"
    );
    expect(installer).toContain(
      "& $codexCommand.Source mcp remove reforger-forge"
    );
    expect(installer).toContain(
      "& $codexCommand.Source mcp add reforger-forge -- node @codexArgs"
    );
    expect(installer).toContain(
      "Skipped Codex because the Codex CLI is not installed"
    );
    expect(installer).toMatch(/\bcodex\s+=\s+@\{/);
  });

  it("the PowerShell installer preserves deep JSON and writes UTF-8 without a BOM", () => {
    const installer = read("agents/install-agents.ps1");

    expect(installer).toContain(
      "New-Object System.Text.UTF8Encoding($false)"
    );
    expect(installer).toContain("ConvertTo-Json -Depth 100");
    expect(installer).toContain("[System.IO.File]::WriteAllText(");
    expect(installer).not.toMatch(/\bSet-Content\b/);
  });
});
