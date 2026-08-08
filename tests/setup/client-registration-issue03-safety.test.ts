import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SUPPORTED_CLIENT_IDS,
  formatRegistrationReceipt,
  registerDetectedClients,
  type ClientRegistrationOptions,
  type CommandExecutionResult,
  type CommandLookupResult,
  type SupportedClientId,
} from "../../src/setup/client-registration.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildManagedMcpServerArguments } from "../../src/mcp-host-identity.js";

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly workspace: string;
  readonly serverPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-issue03-"));
  temporaryRoots.push(root);
  const home = join(root, "profile");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  const workspace = join(root, "workspace");
  const programFiles = join(root, "program-files");
  const programFilesX86 = join(root, "program-files-x86");
  const serverPath = join(root, "server", "dist", "index.js");
  for (const directory of [
    home,
    appData,
    localAppData,
    workspace,
    programFiles,
    programFilesX86,
    dirname(serverPath),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(serverPath, "#!/usr/bin/env node\n", "utf8");
  return {
    root,
    home,
    appData,
    localAppData,
    workspace,
    serverPath,
    environment: {
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      ProgramFiles: programFiles,
      "PROGRAMFILES(X86)": programFilesX86,
      PWD: workspace,
      INIT_CWD: workspace,
    },
  };
}

function notFound(): CommandLookupResult {
  return { status: "not_found" };
}

function success(): CommandExecutionResult {
  return { status: 0, stdout: "", stderr: "" };
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
    runCommand: () => success(),
    now: () => new Date("2026-07-24T12:34:56.000Z"),
    ...overrides,
  };
}

function managedArgs(setup: Fixture, clientLabel: string): string[] {
  return buildManagedMcpServerArguments({
    clientLabel,
    serverPath: setup.serverPath,
  });
}

function resultFor(
  setup: Fixture,
  id: SupportedClientId,
  overrides: Partial<ClientRegistrationOptions> = {}
) {
  const summary = registerDetectedClients(options(setup, overrides));
  return summary.receipts.find((receipt) => receipt.id === id);
}

describe("Issue 03 registration safety", () => {
  it("does not overwrite through a detected client directory junction", () => {
    const setup = fixture();
    const actualCursorDirectory = join(setup.root, "junction-target");
    const actualConfigPath = join(actualCursorDirectory, "mcp.json");
    const original = `${JSON.stringify({
      owner: "outside-profile-link",
      mcpServers: {
        existing: { command: "leave-me-alone" },
      },
    })}\n`;
    mkdirSync(actualCursorDirectory, { recursive: true });
    writeFileSync(actualConfigPath, original, "utf8");
    symlinkSync(
      actualCursorDirectory,
      join(setup.home, ".cursor"),
      "junction"
    );

    const receipt = resultFor(setup, "cursor");

    expect(receipt).toMatchObject({
      status: "detection_failed",
      detail: expect.stringContaining("symbolic link"),
    });
    expect(readFileSync(actualConfigPath, "utf8")).toBe(original);
    expect(
      readdirSync(actualCursorDirectory).filter((name) =>
        name.includes(".backup-")
      )
    ).toEqual([]);
  });

  it("does not overwrite when installation evidence has the wrong file type", () => {
    const setup = fixture();
    const cursorEvidence = join(setup.home, ".cursor");
    const original = "this file is not a Cursor state directory\n";
    writeFileSync(cursorEvidence, original, "utf8");

    const receipt = resultFor(setup, "cursor");

    expect(receipt).toMatchObject({
      status: "detection_failed",
      detail: expect.stringContaining("Expected a directory"),
    });
    expect(readFileSync(cursorEvidence, "utf8")).toBe(original);
    expect(readdirSync(setup.home)).toEqual([".cursor"]);
  });

  it("does not replace a config target that is a directory", () => {
    const setup = fixture();
    const target = join(setup.home, ".kiro", "settings", "mcp.json");
    const marker = join(target, "keep.txt");
    mkdirSync(target, { recursive: true });
    writeFileSync(marker, "preserve me\n", "utf8");

    const receipt = resultFor(setup, "kiro");

    expect(receipt?.status).not.toBe("updated");
    expect(receipt?.status).not.toBe("already_current");
    expect(statSync(target).isDirectory()).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("preserve me\n");
    expect(
      readdirSync(dirname(target)).filter((name) =>
        name.includes(".backup-")
      )
    ).toEqual([]);
  });

  it("isolates a malformed detected client while registering another", () => {
    const setup = fixture();
    const cursorConfig = join(setup.home, ".cursor", "mcp.json");
    const vscodeConfig = join(setup.appData, "Code", "User", "mcp.json");
    mkdirSync(dirname(cursorConfig), { recursive: true });
    mkdirSync(join(setup.appData, "Code"), { recursive: true });
    writeFileSync(cursorConfig, "{ malformed", "utf8");

    const summary = registerDetectedClients(options(setup));

    expect(summary.receipts.find(({ id }) => id === "cursor")).toMatchObject({
      status: "failed",
      manual: expect.stringContaining("mcp.json"),
    });
    expect(summary.receipts.find(({ id }) => id === "vscode")).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(vscodeConfig),
    });
    expect(readFileSync(cursorConfig, "utf8")).toBe("{ malformed");
    expect(
      JSON.parse(readFileSync(vscodeConfig, "utf8")).servers[
        "reforger-forge"
      ]
    ).toEqual({
      type: "stdio",
      command: "node",
      args: managedArgs(setup, "vscode"),
    });
  });

  it("uses only predictable per-user targets for VS Code and Kiro", () => {
    const setup = fixture();
    const commands = new Set(["code", "kiro"]);
    const summary = registerDetectedClients(options(setup, {
      findCommand: (command) =>
        commands.has(command)
          ? { status: "found", path: `${command}.exe` }
          : { status: "not_found" },
    }));
    const vscodePath = join(
      setup.appData,
      "Code",
      "User",
      "mcp.json"
    );
    const kiroPath = join(
      setup.home,
      ".kiro",
      "settings",
      "mcp.json"
    );

    expect(summary.receipts.find(({ id }) => id === "vscode")).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(vscodePath),
    });
    expect(summary.receipts.find(({ id }) => id === "kiro")).toMatchObject({
      status: "updated",
      detail: expect.stringContaining(kiroPath),
    });
    expect(existsSync(vscodePath)).toBe(true);
    expect(existsSync(kiroPath)).toBe(true);
    expect(readdirSync(setup.workspace)).toEqual([]);
  });

  it("emits one complete mixed-status receipt with guidance for every failure", () => {
    const setup = fixture();
    const cursorConfig = join(setup.home, ".cursor", "mcp.json");
    const windsurfConfig = join(
      setup.home,
      ".codeium",
      "windsurf",
      "mcp_config.json"
    );
    mkdirSync(dirname(cursorConfig), { recursive: true });
    writeFileSync(cursorConfig, "{ malformed", "utf8");
    mkdirSync(join(setup.appData, "Claude"), { recursive: true });
    mkdirSync(dirname(windsurfConfig), { recursive: true });
    writeFileSync(
      windsurfConfig,
      `${JSON.stringify({
        mcpServers: {
          "reforger-forge": {
            command: "node",
            args: managedArgs(setup, "windsurf"),
          },
        },
      })}\n`,
      "utf8"
    );
    mkdirSync(join(setup.appData, "Code"), { recursive: true });
    mkdirSync(join(setup.home, ".continue"), { recursive: true });
    writeFileSync(
      join(setup.home, ".continue", "config.json"),
      "{}\n",
      "utf8"
    );

    const summary = registerDetectedClients(options(setup, {
      findCommand: (command) => {
        if (command === "codex") {
          return { status: "error", message: "PATH lookup denied" };
        }
        return command === "claude"
          ? { status: "found", path: "claude.exe" }
          : { status: "not_found" };
      },
      runCommand: (_command, args) =>
        args[1] === "get"
          ? {
              status: 1,
              stdout: "",
              stderr:
                'No MCP server named "reforger-forge". Run `claude mcp add` to add one.',
            }
          : success(),
    }));
    const receipt = formatRegistrationReceipt(summary);

    expect(summary.receipts.map(({ id }) => id)).toEqual(
      SUPPORTED_CLIENT_IDS
    );
    expect(
      Object.fromEntries(
        summary.receipts.map(({ id, status }) => [id, status])
      )
    ).toEqual({
      codex: "detection_failed",
      cursor: "failed",
      antigravity: "not_detected",
      "claude-desktop": "updated",
      "claude-code": "updated",
      windsurf: "already_current",
      vscode: "updated",
      continue: "manual_setup_required",
      kiro: "not_detected",
    });
    expect(summary.hasFailures).toBe(true);
    expect(receipt.match(/Manual:/g)).toHaveLength(3);
    expect(receipt).toContain(
      "Server setup succeeded, but one or more client registrations need manual attention."
    );
    for (const id of ["codex", "cursor", "continue"] as const) {
      const failed = summary.receipts.find(
        (candidate) => candidate.id === id
      );
      expect(failed?.manual).toBeTruthy();
      expect(receipt).toContain(`Manual: ${failed?.manual}`);
    }
  });
});
