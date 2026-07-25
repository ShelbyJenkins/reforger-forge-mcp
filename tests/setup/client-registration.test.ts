import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import {
  SUPPORTED_CLIENT_IDS,
  createFailedRegistrationSummary,
  executeClientCommand,
  findClaudeCodeExtensionCommand,
  formatRegistrationReceipt,
  inspectDetectedClients,
  registerDetectedClients,
  selectClientCommandPath,
  selectWindowsCommandPath,
  updateJsonMcpRegistration,
  type ClientRegistrationOptions,
  type CommandExecutionResult,
  type CommandLookupResult,
} from "../../src/setup/client-registration.js";
import { afterEach, describe, expect, it } from "vitest";

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly serverPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-registration-"));
  temporaryRoots.push(root);
  const home = join(root, "home");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  const programFiles = join(root, "program-files");
  const programFilesX86 = join(root, "program-files-x86");
  mkdirSync(home, { recursive: true });
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(programFiles, { recursive: true });
  mkdirSync(programFilesX86, { recursive: true });
  const serverPath = join(root, "server", "dist", "index.js");
  mkdirSync(join(root, "server", "dist"), { recursive: true });
  writeFileSync(serverPath, "#!/usr/bin/env node\n", "utf8");
  return {
    root,
    home,
    appData,
    localAppData,
    serverPath,
    environment: {
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      ProgramFiles: programFiles,
      "PROGRAMFILES(X86)": programFilesX86,
    },
  };
}

function notFound(): CommandLookupResult {
  return { status: "not_found" };
}

function success(stdout = ""): CommandExecutionResult {
  return { status: 0, stdout, stderr: "" };
}

function claudeAbsent(): CommandExecutionResult {
  return {
    status: 1,
    stdout: "",
    stderr:
      'No MCP server named "reforger-forge". Run `claude mcp add` to add one.',
  };
}

function claudeUserInspection(): CommandExecutionResult {
  return success(
    [
      "reforger-forge:",
      "  Scope: User config (available in all your projects)",
      "  Type: stdio",
      "  Command: node",
    ].join("\n")
  );
}

function options(
  setup: Fixture,
  overrides: Partial<ClientRegistrationOptions> = {}
): ClientRegistrationOptions {
  return {
    serverPath: setup.serverPath,
    platform: "win32",
    environment: setup.environment,
    homeDirectory: setup.home,
    findCommand: notFound,
    now: () => new Date("2026-07-24T12:34:56.000Z"),
    ...overrides,
  };
}

function findOnly(...commands: readonly string[]) {
  const available = new Set(commands);
  return (command: string): CommandLookupResult =>
    available.has(command)
      ? { status: "found", path: `${command}.exe` }
      : { status: "not_found" };
}

interface ClaudeExtensionFixtureOptions {
  readonly layout?: "legacy" | "modern" | "both" | "none";
  readonly publisher?: string;
  readonly name?: string;
  readonly manifestVersion?: string;
  readonly targetPlatform?: string;
}

interface ClaudeExtensionCatalogFixture {
  readonly identifier: { readonly id: string };
  readonly version: string;
  readonly relativeLocation: string;
  readonly metadata: { readonly targetPlatform: string };
}

function vscodeExtensionsRoot(setup: Fixture): string {
  return join(setup.home, ".vscode", "extensions");
}

function writeClaudeExtension(
  setup: Fixture,
  version: string,
  options: ClaudeExtensionFixtureOptions = {},
  root = vscodeExtensionsRoot(setup)
): {
  readonly relativeLocation: string;
  readonly legacyBinary: string;
  readonly modernBinary: string;
  readonly catalogEntry: ClaudeExtensionCatalogFixture;
} {
  const targetPlatform = options.targetPlatform ?? "win32-x64";
  const relativeLocation =
    `anthropic.claude-code-${version}-${targetPlatform}`;
  const extensionPath = join(root, relativeLocation);
  mkdirSync(extensionPath, { recursive: true });
  writeFileSync(
    join(extensionPath, "package.json"),
    JSON.stringify({
      publisher: options.publisher ?? "Anthropic",
      name: options.name ?? "claude-code",
      version: options.manifestVersion ?? version,
    }),
    "utf8"
  );
  const legacyBinary = join(
    extensionPath,
    "resources",
    "native-binary",
    "claude.exe"
  );
  const modernBinary = join(
    extensionPath,
    "resources",
    "native-binaries",
    targetPlatform,
    "claude.exe"
  );
  const layout = options.layout ?? "legacy";
  if (layout === "legacy" || layout === "both") {
    mkdirSync(dirname(legacyBinary), { recursive: true });
    writeFileSync(legacyBinary, "MZ", "utf8");
  }
  if (layout === "modern" || layout === "both") {
    mkdirSync(dirname(modernBinary), { recursive: true });
    writeFileSync(modernBinary, "MZ", "utf8");
  }
  return {
    relativeLocation,
    legacyBinary,
    modernBinary,
    catalogEntry: {
      identifier: { id: "anthropic.claude-code" },
      version,
      relativeLocation,
      metadata: { targetPlatform },
    },
  };
}

function writeClaudeExtensionCatalog(
  setup: Fixture,
  entries: readonly ClaudeExtensionCatalogFixture[],
  root = vscodeExtensionsRoot(setup)
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "extensions.json"),
    JSON.stringify(entries),
    "utf8"
  );
}

function writeObsoleteExtensions(
  setup: Fixture,
  relativeLocations: readonly string[]
): void {
  const root = vscodeExtensionsRoot(setup);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, ".obsolete"),
    JSON.stringify(Object.fromEntries(
      relativeLocations.map((location) => [location, true])
    )),
    "utf8"
  );
}

function receipt(
  setup: Fixture,
  id: (typeof SUPPORTED_CLIENT_IDS)[number],
  overrides: Partial<ClientRegistrationOptions> = {}
) {
  return registerDetectedClients(options(setup, overrides)).receipts.find(
    (candidate) => candidate.id === id
  );
}

describe("MCP client detection and standard registration", () => {
  it("reports all nine clients in stable order without creating undetected paths", () => {
    const setup = fixture();
    const summary = registerDetectedClients(options(setup));

    expect(summary.receipts.map((item) => item.id)).toEqual(
      SUPPORTED_CLIENT_IDS
    );
    expect(summary.receipts.every((item) => item.status === "not_detected"))
      .toBe(true);
    expect(summary.hasFailures).toBe(false);
    expect(readdirSync(setup.home)).toEqual([]);
    expect(readdirSync(setup.appData)).toEqual([]);
  });

  it.each([
    {
      id: "cursor",
      command: "cursor",
      path: (setup: Fixture) => join(setup.home, ".cursor", "mcp.json"),
      rootKey: "mcpServers",
      expectedType: undefined,
    },
    {
      id: "antigravity",
      command: "antigravity",
      path: (setup: Fixture) =>
        join(setup.home, ".gemini", "config", "mcp_config.json"),
      rootKey: "mcpServers",
      expectedType: undefined,
    },
    {
      id: "claude-desktop",
      command: undefined,
      path: (setup: Fixture) =>
        join(setup.appData, "Claude", "claude_desktop_config.json"),
      rootKey: "mcpServers",
      expectedType: undefined,
    },
    {
      id: "windsurf",
      command: "windsurf",
      path: (setup: Fixture) =>
        join(setup.home, ".codeium", "windsurf", "mcp_config.json"),
      rootKey: "mcpServers",
      expectedType: undefined,
    },
    {
      id: "vscode",
      command: "code",
      path: (setup: Fixture) =>
        join(setup.appData, "Code", "User", "mcp.json"),
      rootKey: "servers",
      expectedType: "stdio",
    },
    {
      id: "kiro",
      command: "kiro",
      path: (setup: Fixture) =>
        join(setup.home, ".kiro", "settings", "mcp.json"),
      rootKey: "mcpServers",
      expectedType: undefined,
    },
  ] as const)(
    "writes the config-free $id registration to its per-user target",
    ({ id, command, path, rootKey, expectedType }) => {
      const setup = fixture();
      if (id === "claude-desktop") {
        mkdirSync(join(setup.appData, "Claude"), { recursive: true });
      }
      const result = receipt(setup, id, {
        findCommand: command ? findOnly(command) : notFound,
      });

      expect(result?.status).toBe("updated");
      const document = JSON.parse(readFileSync(path(setup), "utf8")) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      const entry = document[rootKey]["reforger-forge"];
      expect(entry.command).toBe("node");
      expect(entry.args).toEqual([setup.serverPath]);
      expect(entry.type).toBe(expectedType);
      expect(JSON.stringify(entry)).not.toMatch(
        /--config|--project-path|REFORGER_FORGE_|ENFUSION_/
      );
    }
  );

  it("uses an existing alternate Antigravity config without also writing the canonical target", () => {
    const setup = fixture();
    const alternatePath = join(
      setup.home,
      ".gemini",
      "antigravity",
      "mcp_config.json"
    );
    const canonicalPath = join(
      setup.home,
      ".gemini",
      "config",
      "mcp_config.json"
    );
    mkdirSync(dirname(alternatePath), { recursive: true });
    writeFileSync(
      alternatePath,
      `${JSON.stringify({ keep: true, mcpServers: {} })}\n`,
      "utf8"
    );

    const result = receipt(setup, "antigravity", {
      findCommand: findOnly("antigravity"),
    });

    expect(result).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(alternatePath),
    });
    expect(
      JSON.parse(readFileSync(alternatePath, "utf8"))
    ).toMatchObject({
      keep: true,
      mcpServers: {
        "reforger-forge": {
          command: "node",
          args: [setup.serverPath],
        },
      },
    });
    expect(existsSync(canonicalPath)).toBe(false);
  });

  it("prefers the canonical Antigravity target when both layouts already exist", () => {
    const setup = fixture();
    const canonicalPath = join(
      setup.home,
      ".gemini",
      "config",
      "mcp_config.json"
    );
    const alternatePath = join(
      setup.home,
      ".gemini",
      "antigravity",
      "mcp_config.json"
    );
    mkdirSync(dirname(canonicalPath), { recursive: true });
    mkdirSync(dirname(alternatePath), { recursive: true });
    const alternateText = `${JSON.stringify({
      owner: "alternate",
      mcpServers: {},
    })}\n`;
    writeFileSync(alternatePath, alternateText, "utf8");
    writeFileSync(
      canonicalPath,
      `${JSON.stringify({ owner: "canonical", mcpServers: {} })}\n`,
      "utf8"
    );

    const result = receipt(setup, "antigravity");

    expect(result).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(canonicalPath),
    });
    expect(readFileSync(alternatePath, "utf8")).toBe(alternateText);
    expect(
      JSON.parse(readFileSync(canonicalPath, "utf8")).mcpServers[
        "reforger-forge"
      ].args
    ).toEqual([setup.serverPath]);
  });

  it("does not treat a shared canonical Gemini config as Antigravity evidence by itself", () => {
    const setup = fixture();
    const canonicalPath = join(
      setup.home,
      ".gemini",
      "config",
      "mcp_config.json"
    );
    mkdirSync(dirname(canonicalPath), { recursive: true });
    const original = `${JSON.stringify({
      owner: "another-gemini-client",
      mcpServers: {},
    })}\n`;
    writeFileSync(canonicalPath, original, "utf8");

    const result = receipt(setup, "antigravity");

    expect(result?.status).toBe("not_detected");
    expect(readFileSync(canonicalPath, "utf8")).toBe(original);
    expect(
      existsSync(
        join(
          setup.home,
          ".gemini",
          "antigravity",
          "mcp_config.json"
        )
      )
    ).toBe(false);
  });

  it("registers Continue in current YAML while preserving unrelated settings", () => {
    const setup = fixture();
    const configPath = join(setup.home, ".continue", "config.yaml");
    mkdirSync(join(setup.home, ".continue"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "# keep this comment",
        "name: Personal configuration",
        "version: 1.0.0",
        "schema: v1",
        "models:",
        "  - name: Existing",
        "    provider: test",
        "mcpServers:",
        "  - name: other-server",
        "    command: other",
        "  - name: reforger-forge",
        "    command: old",
        "    args: [old.js, --config, old.json]",
        "    env:",
        "      OLD_OVERRIDE: remove-me",
        "    connectionTimeout: 30000",
        "    disabledTools:",
        "      - wb_shutdown",
        "",
      ].join("\n"),
      "utf8"
    );

    const result = receipt(setup, "continue");

    expect(result).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(configPath),
    });
    const text = readFileSync(configPath, "utf8");
    const parsed = parse(text) as Record<string, unknown>;
    expect(text).toContain("# keep this comment");
    expect(parsed.name).toBe("Personal configuration");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.schema).toBe("v1");
    expect(parsed.mcpServers).toEqual([
      { name: "other-server", command: "other" },
      {
        name: "reforger-forge",
        command: "node",
        args: [setup.serverPath],
        connectionTimeout: 30000,
        disabledTools: ["wb_shutdown"],
      },
    ]);
  });

  it("creates a valid current Continue config when only the client executable exists", () => {
    const setup = fixture();
    const configPath = join(setup.home, ".continue", "config.yaml");

    const result = receipt(setup, "continue", {
      findCommand: findOnly("cn"),
    });

    expect(result).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(configPath),
    });
    expect(parse(readFileSync(configPath, "utf8"))).toEqual({
      name: "ReforgerForge",
      version: "1.0.0",
      schema: "v1",
      mcpServers: [
        {
          name: "reforger-forge",
          command: "node",
          args: [setup.serverPath],
        },
      ],
    });
  });

  it("registers Codex through its CLI with no override arguments", () => {
    const setup = fixture();
    const calls: CommandCall[] = [];
    const result = receipt(setup, "codex", {
      findCommand: findOnly("codex"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return args[1] === "get"
          ? {
              status: 1,
              stdout: "",
              stderr:
                "Error: No MCP server named 'reforger-forge' found.",
            }
          : success();
      },
    });

    expect(result).toMatchObject({
      status: "updated",
      modifiedFiles: [],
      backupFiles: [],
      managedChanges: [{
        clientId: "codex",
        clientName: "Codex",
        kind: "client_cli",
        command: "codex.exe",
        scope: "user",
        configFile: null,
        configFileVerification: "unverified",
      }],
    });
    expect(calls).toEqual([
      {
        command: "codex.exe",
        args: ["mcp", "get", "reforger-forge", "--json"],
      },
      {
        command: "codex.exe",
        args: [
          "mcp",
          "add",
          "reforger-forge",
          "--",
          "node",
          setup.serverPath,
        ],
      },
    ]);
  });

  it("detects a fresh versioned Claude Desktop install before first launch", () => {
    const setup = fixture();
    mkdirSync(
      join(setup.localAppData, "AnthropicClaude", "app-0.9.2"),
      { recursive: true }
    );

    const result = receipt(setup, "claude-desktop");

    expect(result).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(
        join(setup.appData, "Claude", "claude_desktop_config.json")
      ),
    });
  });

  it("keeps Claude Desktop and Claude Code as separate clients", () => {
    const setup = fixture();
    mkdirSync(join(setup.appData, "Claude"), { recursive: true });
    const calls: CommandCall[] = [];

    const summary = registerDetectedClients(options(setup, {
      findCommand: findOnly("claude"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return args[1] === "get" ? claudeAbsent() : success();
      },
    }));

    expect(
      summary.receipts.find((item) => item.id === "claude-desktop")?.status
    ).toBe("updated");
    expect(
      summary.receipts.find((item) => item.id === "claude-code")?.status
    ).toBe("updated");
    expect(
      JSON.parse(
        readFileSync(
          join(setup.appData, "Claude", "claude_desktop_config.json"),
          "utf8"
        )
      ).mcpServers["reforger-forge"].args
    ).toEqual([setup.serverPath]);
    expect(calls).toEqual([
      {
        command: "claude.exe",
        args: ["mcp", "get", "reforger-forge"],
      },
      {
        command: "claude.exe",
        args: [
          "mcp",
          "add-json",
          "--scope",
          "user",
          "reforger-forge",
          JSON.stringify({
            type: "stdio",
            command: "node",
            args: [setup.serverPath],
          }),
        ],
      },
    ]);
  });

  it("inspects Claude Code through its CLI and leaves a semantically current user entry untouched", () => {
    const setup = fixture();
    const userConfigPath = join(setup.home, ".claude.json");
    const original = `${JSON.stringify({
      keep: true,
      mcpServers: {
        "reforger-forge": {
          type: "stdio",
          command: "node",
          args: [setup.serverPath],
          env: null,
          cwd: null,
          description: "keep this client metadata",
        },
      },
    })}\n`;
    writeFileSync(userConfigPath, original, "utf8");
    const calls: CommandCall[] = [];

    const result = receipt(setup, "claude-code", {
      findCommand: findOnly("claude"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return claudeUserInspection();
      },
    });

    expect(result).toMatchObject({
      status: "already_current",
      detail: expect.stringContaining(userConfigPath),
      managedChanges: [],
    });
    expect(calls).toEqual([
      {
        command: "claude.exe",
        args: ["mcp", "get", "reforger-forge"],
      },
    ]);
    expect(readFileSync(userConfigPath, "utf8")).toBe(original);
  });

  it("honors CLAUDE_CONFIG_DIR when inspecting Claude Code user scope", () => {
    const setup = fixture();
    const claudeConfigDirectory = join(setup.root, "claude-profile");
    const userConfigPath = join(claudeConfigDirectory, ".claude.json");
    mkdirSync(claudeConfigDirectory, { recursive: true });
    writeFileSync(
      userConfigPath,
      `${JSON.stringify({
        mcpServers: {
          "reforger-forge": {
            command: "node",
            args: [setup.serverPath],
          },
        },
      })}\n`,
      "utf8"
    );

    const result = receipt(setup, "claude-code", {
      environment: {
        ...setup.environment,
        CLAUDE_CONFIG_DIR: claudeConfigDirectory,
      },
      findCommand: findOnly("claude"),
      runCommand: () => claudeUserInspection(),
    });

    expect(result).toMatchObject({
      status: "already_current",
      detail: expect.stringContaining(userConfigPath),
    });
    expect(existsSync(join(setup.home, ".claude.json"))).toBe(false);
  });

  it("does not replace a higher-priority non-user Claude Code registration", () => {
    const setup = fixture();
    const calls: CommandCall[] = [];

    const result = receipt(setup, "claude-code", {
      findCommand: findOnly("claude"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return success(
          [
            "reforger-forge:",
            "  Scope: Project config (shared via .mcp.json)",
            "  Type: stdio",
            "  Command: node",
          ].join("\n")
        );
      },
    });

    expect(result).toMatchObject({
      status: "manual_setup_required",
      detail: expect.stringContaining("project scope"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["mcp", "get", "reforger-forge"]);
    expect(existsSync(join(setup.home, ".claude.json"))).toBe(false);
  });

  it("honors KIRO_HOME for Kiro's single user target", () => {
    const setup = fixture();
    const kiroHome = join(setup.root, "kiro-profile");
    const configPath = join(kiroHome, "settings", "mcp.json");

    const result = receipt(setup, "kiro", {
      environment: {
        ...setup.environment,
        KIRO_HOME: kiroHome,
      },
      findCommand: findOnly("kiro"),
    });

    expect(result).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(configPath),
    });
    expect(
      JSON.parse(readFileSync(configPath, "utf8")).mcpServers[
        "reforger-forge"
      ].args
    ).toEqual([setup.serverPath]);
    expect(
      existsSync(join(setup.home, ".kiro", "settings", "mcp.json"))
    ).toBe(false);
  });

  it("distinguishes detection errors from clean absence", () => {
    const setup = fixture();
    const summary = registerDetectedClients(options(setup, {
      probePath: (path) =>
        path.includes(".cursor")
          ? { status: "error", message: "access denied" }
          : { status: "absent" },
    }));

    expect(
      summary.receipts.find((item) => item.id === "cursor")
    ).toMatchObject({
      status: "detection_failed",
      detail: expect.stringContaining("access denied"),
    });
    expect(
      summary.receipts.find((item) => item.id === "windsurf")?.status
    ).toBe("not_detected");
    expect(summary.hasFailures).toBe(true);
  });

  it("continues after one client config is malformed", () => {
    const setup = fixture();
    const cursorPath = join(setup.home, ".cursor", "mcp.json");
    mkdirSync(dirname(cursorPath), { recursive: true });
    writeFileSync(cursorPath, "{ invalid", "utf8");
    mkdirSync(join(setup.appData, "Code"), { recursive: true });

    const summary = registerDetectedClients(options(setup));

    expect(
      summary.receipts.find((item) => item.id === "cursor")?.status
    ).toBe("failed");
    expect(
      summary.receipts.find((item) => item.id === "vscode")?.status
    ).toBe("updated");
    expect(readFileSync(cursorPath, "utf8")).toBe("{ invalid");
    expect(
      JSON.parse(
        readFileSync(join(setup.appData, "Code", "User", "mcp.json"), "utf8")
      ).servers["reforger-forge"].args
    ).toEqual([setup.serverPath]);
  });

  it("reports legacy-only Continue configuration for manual migration", () => {
    const setup = fixture();
    const continueDirectory = join(setup.home, ".continue");
    mkdirSync(continueDirectory, { recursive: true });
    writeFileSync(join(continueDirectory, "config.json"), "{}\n", "utf8");

    const result = receipt(setup, "continue");

    expect(result).toMatchObject({
      status: "manual_setup_required",
      detail: expect.stringContaining("legacy Continue config"),
    });
    expect(() =>
      statSync(join(continueDirectory, "config.yaml"))
    ).toThrow();
  });
});

describe("Claude Code VS Code extension CLI discovery", () => {
  it("registers Claude Code through the active VS Code extension when it is absent from PATH", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219");
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);
    const calls: CommandCall[] = [];

    const result = receipt(setup, "claude-code", {
      runCommand: (command, args) => {
        calls.push({ command, args });
        return args[1] === "get" ? claudeAbsent() : success();
      },
    });

    expect(result).toMatchObject({
      status: "updated",
      target: {
        kind: "client_cli",
        command: extension.legacyBinary,
        scope: "user",
      },
    });
    expect(calls).toEqual([
      {
        command: extension.legacyBinary,
        args: ["mcp", "get", "reforger-forge"],
      },
      {
        command: extension.legacyBinary,
        args: [
          "mcp",
          "add-json",
          "--scope",
          "user",
          "reforger-forge",
          JSON.stringify({
            type: "stdio",
            command: "node",
            args: [setup.serverPath],
          }),
        ],
      },
    ]);
  });

  it("uses the bundled CLI for read-only inspection", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219");
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);
    const userConfigPath = join(setup.home, ".claude.json");
    writeFileSync(
      userConfigPath,
      `${JSON.stringify({
        mcpServers: {
          "reforger-forge": {
            command: "node",
            args: [setup.serverPath],
          },
        },
      })}\n`,
      "utf8"
    );
    const calls: CommandCall[] = [];

    const summary = inspectDetectedClients(options(setup, {
      runCommand: (command, args) => {
        calls.push({ command, args });
        return claudeUserInspection();
      },
    }));
    const result = summary.receipts.find(
      (candidate) => candidate.id === "claude-code"
    );

    expect(result).toMatchObject({
      status: "current",
      target: {
        kind: "client_cli",
        command: extension.legacyBinary,
        scope: "user",
      },
    });
    expect(calls).toEqual([
      {
        command: extension.legacyBinary,
        args: ["mcp", "get", "reforger-forge"],
      },
    ]);
  });

  it("prefers a Claude CLI resolved from PATH over the extension fallback", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219");
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);
    const calls: CommandCall[] = [];

    const result = receipt(setup, "claude-code", {
      findCommand: findOnly("claude"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return args[1] === "get" ? claudeAbsent() : success();
      },
    });

    expect(result?.status).toBe("updated");
    expect(calls.map((call) => call.command)).toEqual([
      "claude.exe",
      "claude.exe",
    ]);
  });

  it("selects active extensions by semantic version and ignores obsolete versions", () => {
    const setup = fixture();
    const version219 = writeClaudeExtension(setup, "2.1.9");
    const version2110 = writeClaudeExtension(setup, "2.1.10");
    const obsolete = writeClaudeExtension(setup, "2.1.11");
    writeClaudeExtensionCatalog(setup, [
      version219.catalogEntry,
      version2110.catalogEntry,
      obsolete.catalogEntry,
    ]);
    writeObsoleteExtensions(setup, [obsolete.relativeLocation]);

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "x64"
      )
    ).toEqual({
      status: "found",
      path: version2110.legacyBinary,
    });
  });

  it("falls back to an older active extension when the newest has no bundled CLI", () => {
    const setup = fixture();
    const working = writeClaudeExtension(setup, "2.1.218");
    const incomplete = writeClaudeExtension(setup, "2.1.219", {
      layout: "none",
    });
    writeClaudeExtensionCatalog(setup, [
      working.catalogEntry,
      incomplete.catalogEntry,
    ]);

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "x64"
      )
    ).toEqual({
      status: "found",
      path: working.legacyBinary,
    });
  });

  it("supports the architecture-specific layout and prefers it to the legacy layout", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219", {
      layout: "both",
    });
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "x64"
      )
    ).toEqual({
      status: "found",
      path: extension.modernBinary,
    });
  });

  it("discovers a validated extension without a VS Code catalog", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219");

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "x64"
      )
    ).toEqual({
      status: "found",
      path: extension.legacyBinary,
    });
  });

  it("discovers Claude Code installed only in VS Code Insiders", () => {
    const setup = fixture();
    const insidersRoot = join(
      setup.home,
      ".vscode-insiders",
      "extensions"
    );
    const extension = writeClaudeExtension(
      setup,
      "2.1.219",
      {},
      insidersRoot
    );
    writeClaudeExtensionCatalog(
      setup,
      [extension.catalogEntry],
      insidersRoot
    );
    const calls: CommandCall[] = [];

    const result = receipt(setup, "claude-code", {
      runCommand: (command, args) => {
        calls.push({ command, args });
        return args[1] === "get" ? claudeAbsent() : success();
      },
    });

    expect(result?.status).toBe("updated");
    expect(calls.map((call) => call.command)).toEqual([
      extension.legacyBinary,
      extension.legacyBinary,
    ]);
  });

  it("prefers standard VS Code when both channels have the same newest version", () => {
    const setup = fixture();
    const stable = writeClaudeExtension(setup, "2.1.219");
    writeClaudeExtensionCatalog(setup, [stable.catalogEntry]);
    const insidersRoot = join(
      setup.home,
      ".vscode-insiders",
      "extensions"
    );
    const insiders = writeClaudeExtension(
      setup,
      "2.1.219",
      {},
      insidersRoot
    );
    writeClaudeExtensionCatalog(
      setup,
      [insiders.catalogEntry],
      insidersRoot
    );

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup), insidersRoot],
        "x64"
      )
    ).toEqual({
      status: "found",
      path: stable.legacyBinary,
    });
  });

  it("uses an x64 extension binary under ARM64 emulation when the catalog declares x64", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219", {
      layout: "modern",
      targetPlatform: "win32-x64",
    });
    const arm64Binary = join(
      vscodeExtensionsRoot(setup),
      extension.relativeLocation,
      "resources",
      "native-binaries",
      "win32-arm64",
      "claude.exe"
    );
    mkdirSync(dirname(arm64Binary), { recursive: true });
    writeFileSync(arm64Binary, "MZ", "utf8");
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "arm64"
      )
    ).toEqual({
      status: "found",
      path: extension.modernBinary,
    });
  });

  it("rejects an ARM64 extension directory when its catalog entry declares x64", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219", {
      layout: "modern",
      targetPlatform: "win32-arm64",
    });
    writeClaudeExtensionCatalog(setup, [{
      ...extension.catalogEntry,
      metadata: { targetPlatform: "win32-x64" },
    }]);

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "arm64"
      )
    ).toMatchObject({
      status: "error",
      message: expect.stringContaining(
        "directory does not match its manifest version"
      ),
    });
  });

  it("selects the native ARM64 binary for an ARM64 extension", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219", {
      layout: "modern",
      targetPlatform: "win32-arm64",
    });
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "arm64"
      )
    ).toEqual({
      status: "found",
      path: extension.modernBinary,
    });
  });

  it("reports unsafe or contradictory extension metadata as a detection failure", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219", {
      publisher: "SomeoneElse",
    });
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);
    let commandWasRun = false;

    const result = receipt(setup, "claude-code", {
      runCommand: () => {
        commandWasRun = true;
        return success();
      },
    });

    expect(result).toMatchObject({
      status: "detection_failed",
      detail: expect.stringContaining(
        "does not identify Anthropic Claude Code"
      ),
    });
    expect(commandWasRun).toBe(false);
  });

  it("reports malformed VS Code extension catalogs as a detection failure", () => {
    const setup = fixture();
    const root = vscodeExtensionsRoot(setup);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "extensions.json"), "{broken", "utf8");

    const result = receipt(setup, "claude-code");

    expect(result).toMatchObject({
      status: "detection_failed",
      detail: expect.stringContaining(
        "VS Code extension catalog is not valid JSON"
      ),
    });
  });

  it("does not treat unsupported architecture bundles as available", () => {
    const setup = fixture();
    const extension = writeClaudeExtension(setup, "2.1.219");
    writeClaudeExtensionCatalog(setup, [extension.catalogEntry]);

    expect(
      findClaudeCodeExtensionCommand(
        [vscodeExtensionsRoot(setup)],
        "ia32"
      )
    ).toEqual({ status: "not_found" });
  });
});

describe("safe config updates and idempotency", () => {
  it("uses the first runnable PATH candidate and ignores Claude Desktop's app alias", () => {
    expect(
      selectWindowsCommandPath([
        "C:\\npm\\codex",
        "C:\\npm\\codex.cmd",
        "C:\\npm\\codex.ps1",
      ])
    ).toBe("C:\\npm\\codex.cmd");
    expect(
      selectWindowsCommandPath([
        "C:\\npm\\codex.cmd",
        "C:\\native\\codex.exe",
      ])
    ).toBe("C:\\npm\\codex.cmd");
    const desktopAlias =
      "C:\\Users\\person\\AppData\\Local\\Microsoft\\WindowsApps\\Claude.exe";
    expect(
      selectClientCommandPath("claude", [
        desktopAlias,
        "C:\\npm\\claude.cmd",
      ])
    ).toBe("C:\\npm\\claude.cmd");
    expect(selectClientCommandPath("claude", [desktopAlias])).toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")(
    "invokes Windows command shims without losing spaces or treating arguments as shell source",
    () => {
      const setup = fixture();
      const shim = join(setup.root, "test client.cmd");
      writeFileSync(
        shim,
        [
          "@echo off",
          "if \"%~1\"==\"value with spaces & symbols\" (",
          "  echo accepted",
          "  exit /b 0",
          ")",
          "exit /b 9",
          "",
        ].join("\r\n"),
        "utf8"
      );

      const result = executeClientCommand(shim, [
        "value with spaces & symbols",
      ]);

      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("accepted");
    }
  );

  it("preserves unrelated deep JSON, creates a backup, and performs a true no-op rerun", () => {
    const setup = fixture();
    const path = join(setup.root, "client", "mcp.json");
    mkdirSync(join(setup.root, "client"), { recursive: true });
    const original = `${JSON.stringify(
      {
        theme: { nested: { keep: true } },
        mcpServers: {
          other: { command: "other", args: ["one"] },
          "reforger-forge": {
            command: "node",
            args: ["old.js", "--config", "old.json"],
            env: { OLD_OVERRIDE: "remove-me" },
            serverUrl: "https://old.example.invalid/mcp",
            authProviderType: "dynamic_discovery",
            oauthScopes: ["old.scope"],
            disabled: true,
            autoApprove: ["safe_tool"],
            disabledTools: ["wb_shutdown"],
          },
        },
      },
      null,
      2
    )}\n`;
    writeFileSync(path, original, "utf8");
    const now = () => new Date("2026-07-24T12:34:56.000Z");

    const first = updateJsonMcpRegistration({
      path,
      rootKey: "mcpServers",
      entry: { command: "node", args: [setup.serverPath] },
      now,
    });
    const afterFirst = readFileSync(path, "utf8");
    const firstModified = statSync(path).mtimeMs;
    const second = updateJsonMcpRegistration({
      path,
      rootKey: "mcpServers",
      entry: { command: "node", args: [setup.serverPath] },
      now,
    });

    expect(first.status).toBe("updated");
    expect(first.backupPath).toBe(
      `${path}.backup-2026-07-24T12-34-56-000Z`
    );
    expect(readFileSync(first.backupPath!, "utf8")).toBe(original);
    expect(second).toEqual({ status: "already_current" });
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    expect(statSync(path).mtimeMs).toBe(firstModified);
    expect(
      readdirSync(dirname(path)).filter((name) => name.includes(".backup-"))
    ).toHaveLength(1);
    expect(JSON.parse(afterFirst)).toMatchObject({
      theme: { nested: { keep: true } },
      mcpServers: {
        other: { command: "other", args: ["one"] },
        "reforger-forge": {
          command: "node",
          args: [setup.serverPath],
          disabled: true,
          autoApprove: ["safe_tool"],
          disabledTools: ["wb_shutdown"],
        },
      },
    });
    const updatedEntry = JSON.parse(afterFirst).mcpServers[
      "reforger-forge"
    ] as Record<string, unknown>;
    expect(updatedEntry).not.toHaveProperty("env");
    expect(updatedEntry).not.toHaveProperty("serverUrl");
    expect(updatedEntry).not.toHaveProperty("authProviderType");
    expect(updatedEntry).not.toHaveProperty("oauthScopes");
  });

  it.each([
    "{ invalid",
    "[]",
    '{"mcpServers": []}',
    '{"mcpServers": null}',
    '{"mcpServers": {"reforger-forge": false}}',
  ])(
    "refuses malformed or non-object JSON without changing it: %s",
    (original) => {
      const setup = fixture();
      const path = join(setup.root, "client", "mcp.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, original, "utf8");

      expect(() =>
        updateJsonMcpRegistration({
          path,
          rootKey: "mcpServers",
          entry: { command: "node", args: [setup.serverPath] },
        })
      ).toThrow();
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(
        readdirSync(dirname(path)).filter((name) => name.includes(".backup-"))
      ).toEqual([]);
    }
  );

  it("reports exact current CLI registrations without mutation", () => {
    const setup = fixture();
    const calls: CommandCall[] = [];
    const result = receipt(setup, "codex", {
      findCommand: findOnly("codex"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return success(
          JSON.stringify({
            transport: {
              type: "stdio",
              command: "node",
              args: [setup.serverPath],
              env: null,
              cwd: null,
            },
          })
        );
      },
    });

    expect(result?.status).toBe("already_current");
    expect(result?.managedChanges).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "mcp",
      "get",
      "reforger-forge",
      "--json",
    ]);
  });

  it("does not mutate Codex when registration inspection fails", () => {
    const setup = fixture();
    const calls: CommandCall[] = [];
    const result = receipt(setup, "codex", {
      findCommand: findOnly("codex"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return {
          status: 2,
          stdout: "",
          stderr: "configuration is temporarily unavailable",
        };
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("temporarily unavailable"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args[1]).toBe("get");
  });

  it("does not report a managed change when an initial CLI add fails", () => {
    const setup = fixture();
    const summary = registerDetectedClients(options(setup, {
      findCommand: findOnly("codex", "claude"),
      runCommand: (command, args) => {
        if (args[1] === "get") {
          return command === "codex.exe"
            ? {
                status: 1,
                stdout: "",
                stderr:
                  "Error: No MCP server named 'reforger-forge' found.",
              }
            : claudeAbsent();
        }
        return { status: 1, stdout: "", stderr: "initial add failed" };
      },
    }));

    for (const id of ["codex", "claude-code"] as const) {
      expect(
        summary.receipts.find((candidate) => candidate.id === id)
      ).toMatchObject({
        status: "failed",
        detail: expect.stringContaining("initial add failed"),
        modifiedFiles: [],
        backupFiles: [],
        managedChanges: [],
      });
    }
  });

  it("restores a previous Codex registration when replacement fails", () => {
    const setup = fixture();
    const calls: CommandCall[] = [];
    const previous = {
      enabled: true,
      transport: {
        type: "stdio",
        command: "node",
        args: ["old.js", "--config", "old.json"],
        env: { KEEP: "value" },
        env_vars: [],
        cwd: null,
      },
      enabled_tools: null,
      disabled_tools: null,
      startup_timeout_sec: null,
      tool_timeout_sec: null,
    };
    const result = receipt(setup, "codex", {
      findCommand: findOnly("codex"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        if (args[1] === "get") return success(JSON.stringify(previous));
        if (
          args[1] === "add" &&
          args.at(-1) === setup.serverPath
        ) {
          return { status: 1, stdout: "", stderr: "add failed" };
        }
        return success();
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("previous registration was restored"),
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      "get",
      "remove",
      "add",
      "add",
    ]);
    expect(calls[3].args).toEqual([
      "mcp",
      "add",
      "reforger-forge",
      "--env",
      "KEEP=value",
      "--",
      "node",
      "old.js",
      "--config",
      "old.json",
    ]);
    expect(result?.managedChanges).toEqual([]);
  });

  it("reports a Codex managed change when replacement and restoration fail", () => {
    const setup = fixture();
    const previous = {
      enabled: true,
      transport: {
        type: "stdio",
        command: "node",
        args: ["old.js"],
        env: null,
        env_vars: [],
        cwd: null,
      },
      enabled_tools: null,
      disabled_tools: null,
      startup_timeout_sec: null,
      tool_timeout_sec: null,
    };
    const calls: CommandCall[] = [];
    const result = receipt(setup, "codex", {
      findCommand: findOnly("codex"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        if (args[1] === "get") return success(JSON.stringify(previous));
        if (args[1] === "remove") return success();
        return {
          status: 1,
          stdout: "",
          stderr:
            args.at(-1) === setup.serverPath
              ? "replacement failed"
              : "restoration failed",
        };
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(
        /replacement failed.*Restoring.*restoration failed/s
      ),
      modifiedFiles: [],
      backupFiles: [],
      managedChanges: [{
        clientId: "codex",
        clientName: "Codex",
        kind: "client_cli",
        command: "codex.exe",
        scope: "user",
        configFile: null,
        configFileVerification: "unverified",
        detail: expect.stringMatching(
          /previous 'reforger-forge'.*final client-managed state is uncertain.*exact client-owned configuration file was not verified/s
        ),
      }],
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      "get",
      "remove",
      "add",
      "add",
    ]);
  });

  it("replaces a changed Claude Code user registration through the CLI", () => {
    const setup = fixture();
    writeFileSync(
      join(setup.home, ".claude.json"),
      JSON.stringify({
        keep: { nested: true },
        mcpServers: {
          "reforger-forge": {
            type: "stdio",
            command: "node",
            args: ["old.js", "--project-path", "old-project"],
          },
        },
      }),
      "utf8"
    );
    const calls: CommandCall[] = [];

    const result = receipt(setup, "claude-code", {
      findCommand: findOnly("claude"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        return args[1] === "get" ? claudeUserInspection() : success();
      },
    });

    expect(result).toMatchObject({
      status: "updated",
      modifiedFiles: [],
      backupFiles: [],
      managedChanges: [{
        clientId: "claude-code",
        clientName: "Claude Code",
        kind: "client_cli",
        command: "claude.exe",
        scope: "user",
        configFile: null,
        configFileVerification: "unverified",
      }],
    });
    expect(calls[0].args).toEqual(["mcp", "get", "reforger-forge"]);
    expect(calls[1].args).toEqual([
      "mcp",
      "remove",
      "reforger-forge",
      "--scope",
      "user",
    ]);
    expect(calls[2].args.slice(0, 6)).toEqual([
      "mcp",
      "add-json",
      "--scope",
      "user",
      "reforger-forge",
      expect.any(String),
    ]);
    expect(calls[2].args[5]).not.toMatch(/--config|--project-path/);
  });

  it("restores a previous Claude Code registration when replacement fails", () => {
    const setup = fixture();
    const previous = {
      type: "stdio",
      command: "node",
      args: ["old.js", "--config", "old.json"],
      env: { KEEP: "value" },
    };
    writeFileSync(
      join(setup.home, ".claude.json"),
      JSON.stringify({
        mcpServers: { "reforger-forge": previous },
      }),
      "utf8"
    );
    const calls: CommandCall[] = [];

    const result = receipt(setup, "claude-code", {
      findCommand: findOnly("claude"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        if (args[1] === "get") return claudeUserInspection();
        if (
          args[1] === "add-json" &&
          args[5] !== JSON.stringify(previous)
        ) {
          return { status: 1, stdout: "", stderr: "add failed" };
        }
        return success();
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("previous registration was restored"),
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      "get",
      "remove",
      "add-json",
      "add-json",
    ]);
    expect(calls[3].args[5]).toBe(JSON.stringify(previous));
    expect(result?.managedChanges).toEqual([]);
  });

  it("reports a Claude Code managed change when replacement and restoration fail", () => {
    const setup = fixture();
    const previous = {
      type: "stdio",
      command: "node",
      args: ["old.js"],
    };
    writeFileSync(
      join(setup.home, ".claude.json"),
      JSON.stringify({
        mcpServers: { "reforger-forge": previous },
      }),
      "utf8"
    );
    const calls: CommandCall[] = [];
    const result = receipt(setup, "claude-code", {
      findCommand: findOnly("claude"),
      runCommand: (command, args) => {
        calls.push({ command, args });
        if (args[1] === "get") return claudeUserInspection();
        if (args[1] === "remove") return success();
        return {
          status: 1,
          stdout: "",
          stderr:
            args[5] === JSON.stringify(previous)
              ? "restoration failed"
              : "replacement failed",
        };
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(
        /replacement failed.*Restoring.*restoration failed/s
      ),
      modifiedFiles: [],
      backupFiles: [],
      managedChanges: [{
        clientId: "claude-code",
        clientName: "Claude Code",
        kind: "client_cli",
        command: "claude.exe",
        scope: "user",
        configFile: null,
        configFileVerification: "unverified",
        detail: expect.stringMatching(
          /previous 'reforger-forge'.*final client-managed state is uncertain.*exact client-owned configuration file was not verified/s
        ),
      }],
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      "get",
      "remove",
      "add-json",
      "add-json",
    ]);
  });

  it("formats every status in one stable completion receipt", () => {
    const setup = fixture();
    const summary = registerDetectedClients(options(setup));
    const formatted = formatRegistrationReceipt(summary);

    for (const name of [
      "Codex",
      "Cursor",
      "Google Antigravity",
      "Claude Desktop",
      "Claude Code",
      "Windsurf",
      "VS Code",
      "Continue.dev",
      "Kiro",
    ]) {
      expect(formatted).toContain(name);
    }
    expect(formatted.match(/not detected/g)).toHaveLength(9);
  });

  it("produces a nine-client fallback receipt for initialization failures", () => {
    const setup = fixture();
    const summary = createFailedRegistrationSummary(
      setup.serverPath,
      "Registration initialization failed: test failure"
    );
    const formatted = formatRegistrationReceipt(summary);

    expect(summary.hasFailures).toBe(true);
    expect(summary.receipts.map((item) => item.id)).toEqual(
      SUPPORTED_CLIENT_IDS
    );
    expect(summary.receipts.every((item) => item.status === "failed")).toBe(
      true
    );
    expect(formatted.match(/Registration initialization failed/g)).toHaveLength(
      9
    );
  });
});
