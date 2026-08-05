import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { SteamDiscoveryResult } from "../../src/platform/windows/steam-discovery.js";
import {
  inspectToolRegistration,
  isServerVerificationSuccessful,
  serializeServerVerificationReport,
  verifyMcpServer,
  writeServerVerificationReportAtomic,
  type ServerVerificationDependencies,
  type ServerVerificationReport,
  type ServerVerificationSession,
} from "../../src/setup/server-verification.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-verifier-"));
  temporaryRoots.push(root);
  return root;
}

const discovery: SteamDiscoveryResult = {
  status: "success",
  workbenchPath: "C:\\Steam\\Arma Reforger Tools",
  gamePath: "C:\\Steam\\Arma Reforger",
  workbenchAddonDirs: ["C:\\Steam\\Arma Reforger\\addons"],
  workbenchCandidates: ["C:\\Steam\\Arma Reforger Tools"],
  gameCandidates: ["C:\\Steam\\Arma Reforger"],
  steamRoots: ["C:\\Steam"],
  libraryRoots: ["C:\\Steam"],
  errors: [],
};

const config: Config = {
  workbenchPath: discovery.workbenchPath!,
  gamePath: discovery.gamePath!,
  workbenchAddonDirs: [
    "C:\\Steam\\Arma Reforger\\addons",
    "C:\\Projects\\Addons",
  ],
  workbenchScriptAuthorizeAll: false,
  dataDir: "C:\\Package\\data",
  patternsDir: "C:\\Package\\data\\patterns",
  workbenchHost: "127.0.0.1",
  workbenchPort: 5775,
  debug: false,
};

const observerNames = [
  "observer_setup",
  "observer_prepare_launch",
  "observer_runtime",
  "observer_instances",
  "observer_capture",
  "observer_job",
  "observer_run_begin",
  "observer_run_status",
  "observer_run_finalize",
  "observer_run_discard",
] as const;

const validTools = [
  ...observerNames.map((name) => ({ name, description: `${name} description` })),
  { name: "game_launch", description: "Owned game launch composite description" },
  {
    name: "mod",
    description: "mod description",
    inputSchema: {
      properties: {
        action: { enum: ["inspect"] },
        gprojPath: { type: "string" },
      },
    },
  },
  {
    name: "wb_reload",
    description: "wb_reload description",
    inputSchema: {
      properties: {
        target: { enum: ["plugins"], default: "plugins" },
      },
    },
  },
];

interface Harness {
  dependencies: ServerVerificationDependencies;
  session: ServerVerificationSession;
  discoverSteam: ReturnType<typeof vi.fn>;
  loadConfiguration: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  const discoverSteam = vi.fn(() => discovery);
  const loadConfiguration = vi.fn(() => config);
  const connect = vi.fn(async () => undefined);
  const listTools = vi.fn(async () => ({ tools: validTools }));
  const close = vi.fn(async () => undefined);
  const session = { connect, listTools, close };
  const createSession = vi.fn(() => session);
  return {
    dependencies: {
      discoverSteam,
      loadConfiguration,
      createSession,
      probeCompiledServer: vi.fn(async () => ({ version: "1.1.0" })),
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      nodeCommand: "C:\\Node\\node.exe",
    },
    session,
    discoverSteam,
    loadConfiguration,
    createSession,
    connect,
    listTools,
    close,
  };
}

async function verify(
  fixture: Harness,
  root = temporaryRoot(),
  startupArguments: readonly string[] = [],
  hostClientLabel = "manual"
): Promise<ServerVerificationReport> {
  return verifyMcpServer({
    packageRoot: root,
    packageVersion: "1.1.0",
    startupArguments,
    hostClientLabel,
    nodeVersion: "v22.17.0",
  }, fixture.dependencies);
}

describe("server verification core", () => {
  it("reports all four successful stages and forwards every argument unchanged", async () => {
    const fixture = harness();
    const root = temporaryRoot();
    const startupArguments = [
      "--config",
      "config files\\settings.json",
      "--project-path",
      "C:\\Mods\\Project With Spaces",
      "--debug",
    ];

    const report = await verify(fixture, root, startupArguments, "codex");

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-07-24T12:00:00.000Z",
      success: true,
      nodeVersion: "v22.17.0",
      serverPath: resolve(root, "dist", "index.js"),
      packageVersion: "1.1.0",
      configPath: resolve(root, "config files", "settings.json"),
      compiledServer: { status: "passed", version: "1.1.0" },
      steamDiscovery: {
        status: "passed",
        sourceStatus: "success",
        workbenchCandidates: discovery.workbenchCandidates,
      },
      effectiveSettings: {
        status: "passed",
        workbenchPath: config.workbenchPath,
        gamePath: config.gamePath,
        workbenchAddonDirs: config.workbenchAddonDirs,
        workbenchHost: "127.0.0.1",
        workbenchPort: 5775,
      },
      serverHandshake: { status: "passed" },
      toolRegistration: {
        status: "passed",
        count: validTools.length,
      },
    });
    expect(report.startupArguments).toEqual(startupArguments);
    expect(fixture.discoverSteam).toHaveBeenCalledOnce();
    expect(fixture.loadConfiguration).toHaveBeenCalledOnce();
    expect(fixture.loadConfiguration.mock.calls[0][0]).toEqual(startupArguments);
    expect(fixture.loadConfiguration.mock.calls[0][1]).toMatchObject({
      cwd: resolve(root),
    });
    expect(fixture.loadConfiguration.mock.calls[0][1].discoverSteam()).toBe(discovery);
    expect(fixture.createSession).toHaveBeenCalledWith({
      command: "C:\\Node\\node.exe",
      nodeArguments: ["--title=ReforgerForge-MCP-codex"],
      serverPath: resolve(root, "dist", "index.js"),
      hostArguments: ["--mcp-client-label", "codex"],
      startupArguments,
      cwd: resolve(root),
      packageVersion: "1.1.0",
    });
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.listTools).toHaveBeenCalledOnce();
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(isServerVerificationSuccessful(report)).toBe(true);
  });

  it("preserves successful discovery, settings, and handshake after tool listing fails", async () => {
    const fixture = harness();
    fixture.listTools.mockRejectedValueOnce(new Error("list request rejected"));

    const report = await verify(fixture);

    expect(report.success).toBe(false);
    expect(report.steamDiscovery.status).toBe("passed");
    expect(report.effectiveSettings.status).toBe("passed");
    expect(report.serverHandshake.status).toBe("passed");
    expect(report.toolRegistration).toMatchObject({
      status: "failed",
      count: 0,
      names: [],
      issues: ["Tool listing failed: list request rejected"],
    });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("closes the client and leaves tool registration not run after handshake failure", async () => {
    const fixture = harness();
    fixture.connect.mockRejectedValueOnce(new Error("protocol mismatch"));

    const report = await verify(fixture);

    expect(report.steamDiscovery.status).toBe("passed");
    expect(report.effectiveSettings.status).toBe("passed");
    expect(report.serverHandshake).toMatchObject({
      status: "failed",
      issues: ["MCP server handshake failed: protocol mismatch"],
    });
    expect(report.toolRegistration.status).toBe("not_run");
    expect(fixture.listTools).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("reports effective settings as the failed layer after successful discovery", async () => {
    const fixture = harness();
    fixture.loadConfiguration.mockImplementationOnce(() => {
      throw new Error("project path escapes its container");
    });

    const report = await verify(fixture);

    expect(report.steamDiscovery.status).toBe("passed");
    expect(report.effectiveSettings).toMatchObject({
      status: "failed",
      issues: [
        "Effective settings validation failed: project path escapes its container",
      ],
    });
    expect(report.serverHandshake.status).toBe("not_run");
    expect(report.toolRegistration.status).toBe("not_run");
    expect(fixture.createSession).not.toHaveBeenCalled();
  });

  it("distinguishes a mismatched compiled version and does not start it", async () => {
    const fixture = harness();
    fixture.dependencies.probeCompiledServer = vi.fn(async () => ({
      version: "1.0.0",
    }));

    const report = await verify(fixture);

    expect(report.compiledServer).toEqual({
      status: "failed",
      version: "1.0.0",
      issues: [
        "Compiled server version 1.0.0 does not match package version 1.1.0.",
      ],
    });
    expect(report.steamDiscovery.status).toBe("passed");
    expect(report.effectiveSettings.status).toBe("passed");
    expect(report.serverHandshake.status).toBe("failed");
    expect(report.toolRegistration.status).toBe("not_run");
    expect(fixture.createSession).not.toHaveBeenCalled();
  });

  it("reports Steam as the earliest failed layer when settings cannot fall back", async () => {
    const fixture = harness();
    fixture.discoverSteam.mockReturnValueOnce({
      status: "not_found",
      workbenchCandidates: [],
      gameCandidates: [],
      steamRoots: ["C:\\Steam"],
      libraryRoots: ["C:\\Steam"],
      errors: [{
        code: "NOT_FOUND",
        source: "discovery",
        message: "No matching manifests.",
      }],
    });
    fixture.loadConfiguration.mockImplementationOnce(() => {
      throw new Error("workbenchPath is required");
    });

    const report = await verify(fixture);

    expect(report.steamDiscovery).toMatchObject({
      status: "failed",
      sourceStatus: "not_found",
      issues: ["No matching manifests."],
    });
    expect(report.effectiveSettings.status).toBe("not_run");
    expect(report.serverHandshake.status).toBe("not_run");
    expect(report.toolRegistration.status).toBe("not_run");
  });

  it("makes cleanup failure authoritative without erasing the passed handshake", async () => {
    const fixture = harness();
    fixture.close.mockRejectedValueOnce(new Error("close timeout"));

    const report = await verify(fixture);

    expect(report.serverHandshake.status).toBe("passed");
    expect(report.toolRegistration).toMatchObject({
      status: "failed",
      issues: ["MCP verification client close failed: close timeout"],
    });
  });
});

describe("tool surface inspection", () => {
  it("permits the supported exact-project mod validation argument", () => {
    expect(inspectToolRegistration(validTools)).toMatchObject({
      status: "passed",
      issues: [],
    });
  });

  it("requires game_launch separately from the ten observer primitives", () => {
    const result = inspectToolRegistration(
      validTools.filter((tool) => tool.name !== "game_launch"),
    );
    expect(result.status).toBe("failed");
    expect(result.issues).toContain(
      "Required observer composites missing at runtime: game_launch",
    );
  });

  it("returns sorted names and actionable contract issues", () => {
    const result = inspectToolRegistration([
      ...validTools,
      { name: "wb_play" },
      { name: "undocumented_tool" },
    ]);

    expect(result.status).toBe("failed");
    expect(result.names).toEqual([...result.names].sort((a, b) => a.localeCompare(b)));
    expect(result.issues).toContain(
      "Removed refusal-only tools still registered: wb_play"
    );
    expect(result.issues).toContain(
      "Runtime tools missing descriptions: undocumented_tool, wb_play"
    );
  });
});

describe("verification report output", () => {
  it("atomically writes the exact serialized report and requires an absolute path", async () => {
    const fixture = harness();
    const report = await verify(fixture);
    const root = temporaryRoot();
    const reportPath = join(root, "report.json");
    writeFileSync(reportPath, "stale report");

    await writeServerVerificationReportAtomic(reportPath, report);

    expect(readFileSync(reportPath, "utf8")).toBe(
      serializeServerVerificationReport(report)
    );
    await expect(
      writeServerVerificationReportAtomic("relative-report.json", report)
    ).rejects.toThrow("Verification report path must be absolute.");
  });

  it("uses environment-only machine modes and forwards opaque argv through the CLI", () => {
    const root = temporaryRoot();
    const scripts = join(root, "scripts");
    const verificationModule = join(root, "dist", "setup");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(verificationModule, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ type: "module", version: "9.8.7" })
    );
    writeFileSync(
      join(scripts, "verify-mcp-server.mjs"),
      readFileSync(
        resolve("scripts", "verify-mcp-server.mjs"),
        "utf8"
      )
    );
    writeFileSync(
      join(verificationModule, "server-verification.js"),
      [
        "import { writeFile } from 'node:fs/promises';",
        "export async function verifyMcpServer(options) {",
        "  return { success: true, packageVersion: options.packageVersion, hostClientLabel: options.hostClientLabel, startupArguments: [...options.startupArguments] };",
        "}",
        "export function serializeServerVerificationReport(report) { return JSON.stringify(report) + '\\n'; }",
        "export function formatServerVerificationReport() { return 'human output\\n'; }",
        "export function isServerVerificationSuccessful(report) { return report.success; }",
        "export async function writeServerVerificationReportAtomic(path, report) { await writeFile(path, serializeServerVerificationReport(report)); }",
      ].join("\n")
    );
    writeFileSync(
      join(root, "dist", "mcp-host-identity.js"),
      [
        "export function partitionMcpHostArguments(argv) {",
        "  const remainingArguments = []; let clientLabel = 'manual';",
        "  for (let index = 0; index < argv.length; index += 1) {",
        "    if (argv[index] === '--mcp-client-label') { clientLabel = argv[++index]; }",
        "    else remainingArguments.push(argv[index]);",
        "  }",
        "  return { clientLabel, remainingArguments };",
        "}",
      ].join("\n")
    );
    const reportPath = join(root, "machine-report.json");
    const opaqueArguments = [
      "--config",
      "C:\\Config Path\\forge.json",
      "--workbench-addon-dir",
      "D:\\Addon Root\\one",
      "--debug",
    ];
    const jsonRun = spawnSync(
      process.execPath,
      [
        join(scripts, "verify-mcp-server.mjs"),
        "--mcp-client-label",
        "setup",
        ...opaqueArguments,
      ],
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: {
          ...process.env,
          REFORGER_FORGE_VERIFY_JSON: "1",
          REFORGER_FORGE_VERIFY_QUIET: "1",
          REFORGER_FORGE_VERIFY_REPORT_PATH: reportPath,
        },
      }
    );

    expect(jsonRun.status).toBe(0);
    expect(jsonRun.stderr).toBe("");
    const parsed = JSON.parse(jsonRun.stdout) as {
      packageVersion: string;
      hostClientLabel: string;
      startupArguments: string[];
    };
    expect(parsed).toEqual({
      success: true,
      packageVersion: "9.8.7",
      hostClientLabel: "setup",
      startupArguments: opaqueArguments,
    });
    expect(readFileSync(reportPath, "utf8")).toBe(jsonRun.stdout);

    const quietRun = spawnSync(
      process.execPath,
      [join(scripts, "verify-mcp-server.mjs"), "--unknown-server-token"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          REFORGER_FORGE_VERIFY_JSON: "0",
          REFORGER_FORGE_VERIFY_QUIET: "1",
          REFORGER_FORGE_VERIFY_REPORT_PATH: "",
        },
      }
    );
    expect(quietRun.status).toBe(0);
    expect(quietRun.stdout).toBe("");
  });
});
