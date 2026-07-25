import {
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
import {
  formatRegistrationReceipt,
  inspectDetectedClients,
  registerDetectedClients,
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

interface FileSnapshot {
  readonly bytes: Buffer;
  readonly modifiedMilliseconds: number;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-inspection-"));
  temporaryRoots.push(root);
  const home = join(root, "home");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  const serverPath = join(root, "server", "dist", "index.js");
  for (const path of [home, appData, localAppData, dirname(serverPath)]) {
    mkdirSync(path, { recursive: true });
  }
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
      ProgramFiles: join(root, "program-files"),
      "PROGRAMFILES(X86)": join(root, "program-files-x86"),
    },
  };
}

function notFound(): CommandLookupResult {
  return { status: "not_found" };
}

function findOnly(...commands: readonly string[]) {
  const available = new Set(commands);
  return (command: string): CommandLookupResult =>
    available.has(command)
      ? { status: "found", path: `${command}.exe` }
      : { status: "not_found" };
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

function success(stdout = ""): CommandExecutionResult {
  return { status: 0, stdout, stderr: "" };
}

function snapshotFiles(root: string): ReadonlyMap<string, FileSnapshot> {
  const result = new Map<string, FileSnapshot>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        result.set(path, {
          bytes: readFileSync(path),
          modifiedMilliseconds: statSync(path).mtimeMs,
        });
      }
    }
  };
  visit(root);
  return result;
}

function expectSnapshotUnchanged(
  root: string,
  before: ReadonlyMap<string, FileSnapshot>
): void {
  const after = snapshotFiles(root);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [path, expected] of before) {
    expect(after.get(path)?.bytes.equals(expected.bytes)).toBe(true);
    expect(after.get(path)?.modifiedMilliseconds).toBe(
      expected.modifiedMilliseconds
    );
  }
}

describe("structured client registration receipts", () => {
  it("reports exact direct-file targets, changed files, and backups", () => {
    const setup = fixture();
    const configPath = join(setup.home, ".cursor", "mcp.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "reforger-forge": { command: "node", args: ["old.js"] },
        },
      }),
      "utf8"
    );

    const summary = registerDetectedClients(options(setup));
    const receipt = summary.receipts.find(({ id }) => id === "cursor");
    const backupPath =
      `${configPath}.backup-2026-07-24T12-34-56-000Z`;

    expect(receipt).toMatchObject({
      status: "updated",
      target: {
        kind: "config_file",
        scope: "user",
        path: configPath,
      },
      modifiedFiles: [configPath],
      backupFiles: [backupPath],
    });
    expect(receipt?.nextActions).toHaveLength(1);
    expect(readFileSync(backupPath, "utf8")).toContain("old.js");
    const formatted = formatRegistrationReceipt(summary);
    expect(formatted).toContain(`Changed: ${configPath}`);
    expect(formatted).toContain(`Backup: ${backupPath}`);
  });

  it("records CLI-managed changes without inventing config file paths", () => {
    const setup = fixture();
    const summary = registerDetectedClients(options(setup, {
      findCommand: findOnly("codex", "claude"),
      runCommand: (_command, args) =>
        args[0] === "mcp" && args[1] === "get"
          ? {
              status: 1,
              stdout: "",
              stderr: `No MCP server named 'reforger-forge'${
                args.includes("--json") ? " found" : ""
              }.`,
            }
          : success(),
    }));

    for (const [id, name, command] of [
      ["codex", "Codex", "codex.exe"],
      ["claude-code", "Claude Code", "claude.exe"],
    ] as const) {
      const receipt = summary.receipts.find((candidate) => candidate.id === id);
      expect(receipt).toMatchObject({
        status: "updated",
        target: {
          kind: "client_cli",
          scope: "user",
        },
        modifiedFiles: [],
        backupFiles: [],
        managedChanges: [{
          clientId: id,
          clientName: name,
          kind: "client_cli",
          command,
          scope: "user",
          configFile: null,
          configFileVerification: "unverified",
          detail: expect.stringContaining(
            "exact client-owned configuration file was not verified"
          ),
        }],
      });
    }
    expect(
      summary.receipts.every(
        (receipt) =>
          receipt.target !== undefined &&
          Array.isArray(receipt.modifiedFiles) &&
          Array.isArray(receipt.backupFiles) &&
          (
            receipt.managedChanges === undefined ||
            Array.isArray(receipt.managedChanges)
          ) &&
          Array.isArray(receipt.nextActions)
      )
    ).toBe(true);
    const formatted = formatRegistrationReceipt(summary);
    expect(formatted).toContain("Managed change:");
    expect(formatted).toContain("exact config file: unverified");
  });
});

describe("read-only client registration inspection", () => {
  it("keeps client inspection independent from compiled-server presence", () => {
    const setup = fixture();
    const cursorPath = join(setup.home, ".cursor", "mcp.json");
    mkdirSync(dirname(cursorPath), { recursive: true });
    writeFileSync(
      cursorPath,
      JSON.stringify({
        mcpServers: {
          "reforger-forge": {
            command: "node",
            args: [setup.serverPath],
          },
        },
      }),
      "utf8"
    );
    rmSync(setup.serverPath);

    const summary = inspectDetectedClients(options(setup));

    expect(
      summary.receipts.find((receipt) => receipt.id === "cursor")
    ).toMatchObject({ status: "current" });
    expect(() => registerDetectedClients(options(setup))).toThrow();
  });

  it("reports direct-file current, different, not-registered, and failed states without changing bytes or mtimes", () => {
    const setup = fixture();
    const cursorPath = join(setup.home, ".cursor", "mcp.json");
    const vscodePath = join(setup.appData, "Code", "User", "mcp.json");
    const windsurfPath = join(
      setup.home,
      ".codeium",
      "windsurf",
      "mcp_config.json"
    );
    mkdirSync(dirname(cursorPath), { recursive: true });
    mkdirSync(dirname(vscodePath), { recursive: true });
    mkdirSync(dirname(windsurfPath), { recursive: true });
    writeFileSync(
      cursorPath,
      JSON.stringify({
        keep: true,
        mcpServers: {
          "reforger-forge": {
            command: "node",
            args: [setup.serverPath],
          },
        },
      }),
      "utf8"
    );
    writeFileSync(
      vscodePath,
      JSON.stringify({
        servers: {
          "reforger-forge": {
            type: "stdio",
            command: "node",
            args: ["different.js"],
          },
        },
      }),
      "utf8"
    );
    writeFileSync(windsurfPath, "{ malformed", "utf8");
    const before = snapshotFiles(setup.root);

    const summary = inspectDetectedClients(options(setup, {
      findCommand: findOnly("kiro"),
      runCommand: () => {
        throw new Error("Direct-file inspection must not run client commands.");
      },
    }));

    expect(
      summary.receipts.find(({ id }) => id === "cursor")
    ).toMatchObject({
      status: "current",
      target: { kind: "config_file", path: cursorPath },
      modifiedFiles: [],
      backupFiles: [],
    });
    expect(summary.receipts.find(({ id }) => id === "vscode")?.status).toBe(
      "different"
    );
    expect(summary.receipts.find(({ id }) => id === "kiro")?.status).toBe(
      "not_registered"
    );
    expect(summary.receipts.find(({ id }) => id === "windsurf")?.status).toBe(
      "failed"
    );
    expectSnapshotUnchanged(setup.root, before);
  });

  it("uses only supported read-only get commands for Codex and Claude Code", () => {
    const setup = fixture();
    const calls: string[][] = [];
    const before = snapshotFiles(setup.root);

    const summary = inspectDetectedClients(options(setup, {
      findCommand: findOnly("codex", "claude"),
      runCommand: (_command, args) => {
        calls.push([...args]);
        if (args.includes("--json")) {
          return {
            status: 1,
            stdout: "",
            stderr: "No MCP server named 'reforger-forge' found.",
          };
        }
        return {
          status: 1,
          stdout: "",
          stderr: "No MCP server named \"reforger-forge\".",
        };
      },
    }));

    expect(summary.receipts.find(({ id }) => id === "codex")).toMatchObject({
      status: "not_registered",
      target: {
        kind: "client_cli",
        command: "codex.exe",
        scope: "user",
      },
      modifiedFiles: [],
      backupFiles: [],
    });
    expect(
      summary.receipts.find(({ id }) => id === "claude-code")
    ).toMatchObject({
      status: "not_registered",
      target: {
        kind: "client_cli",
        command: "claude.exe",
        scope: "user",
      },
      modifiedFiles: [],
      backupFiles: [],
    });
    expect(calls).toEqual([
      ["mcp", "get", "reforger-forge", "--json"],
      ["mcp", "get", "reforger-forge"],
    ]);
    expect(
      calls.some((args) => args.includes("add") || args.includes("remove"))
    ).toBe(false);
    expectSnapshotUnchanged(setup.root, before);
  });

  it("semantically distinguishes current and different CLI registrations without mutation", () => {
    const setup = fixture();
    const claudePath = join(setup.home, ".claude.json");
    writeFileSync(
      claudePath,
      JSON.stringify({
        mcpServers: {
          "reforger-forge": {
            type: "stdio",
            command: "node",
            args: ["different.js"],
          },
        },
      }),
      "utf8"
    );
    const calls: string[][] = [];
    const before = snapshotFiles(setup.root);

    const summary = inspectDetectedClients(options(setup, {
      findCommand: findOnly("codex", "claude"),
      runCommand: (_command, args) => {
        calls.push([...args]);
        return args.includes("--json")
          ? success(
              JSON.stringify({
                transport: {
                  type: "stdio",
                  command: "node",
                  args: [setup.serverPath],
                },
              })
            )
          : success(
              [
                "reforger-forge:",
                "  Scope: User config (available in all your projects)",
                "  Type: stdio",
                "  Command: node",
              ].join("\n")
            );
      },
    }));

    expect(summary.receipts.find(({ id }) => id === "codex")?.status).toBe(
      "current"
    );
    expect(
      summary.receipts.find(({ id }) => id === "claude-code")?.status
    ).toBe("different");
    expect(calls.every((args) => args[1] === "get")).toBe(true);
    expectSnapshotUnchanged(setup.root, before);
  });
});
