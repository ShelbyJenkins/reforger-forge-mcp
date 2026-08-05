import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { auditWorkbenchAddonDependencies } from "../../src/workbench/addon-dependencies.js";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);
const sharedLauncher = join(repositoryRoot, "scripts", "start-mcp-stdio.ps1");
const workspaceAddonsRoot = resolve(repositoryRoot, "..", "addons");
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const temporaryRoots: string[] = [];

interface ScriptResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

interface LauncherDescriptor {
  readonly schemaVersion: number;
  readonly mode: string;
  readonly command: string;
  readonly nodeVersion: string;
  readonly serverPath: string;
  readonly verifierPath: string;
  readonly nodeArguments: string[];
  readonly hostArguments: string[];
  readonly configurationArguments: string[];
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reforger-forge-stdio-launcher-"));
  temporaryRoots.push(root);
  return root;
}

function runScript(
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {}
): ScriptResult {
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      ...args,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ...environment },
    }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function fakeNode(root: string, version = "v24.0.0"): string {
  const path = join(root, "node-fixture.cmd");
  writeFileSync(path, [
    "@echo off",
    `if \"%~1\"==\"--version\" (echo ${version} & exit /b 0)`,
    "if not \"%LAUNCHER_CAPTURE_PATH%\"==\"\" (>\"%LAUNCHER_CAPTURE_PATH%\" echo %*)",
    "exit /b 0",
    "",
  ].join("\r\n"), "utf8");
  return path;
}

function findFiles(root: string, suffix: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix.toLowerCase())) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found.sort((left, right) => left.localeCompare(right));
}

function readProjectGuid(gprojPath: string): string {
  const match = /^\s*GUID\s+"([0-9A-F]{16})"/m.exec(
    readFileSync(gprojPath, "utf8")
  );
  if (!match) throw new Error(`Project has no valid GUID: ${gprojPath}`);
  return match[1]!;
}

function describedAddonRoots(arguments_: readonly string[]): string[] {
  const roots: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--workbench-addon-dir") {
      roots.push(arguments_[++index]!);
    }
  }
  return roots;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("shared project MCP stdio launcher", () => {
  const windowsIt = process.platform === "win32" ? it : it.skip;

  windowsIt("describes the exact normalized command as JSON without running verification", () => {
    const root = temporaryRoot();
    const addonRoot = join(root, "addons");
    const evidenceRoot = join(root, "evidence");
    const logRoot = join(root, "logs");
    const verifierMarker = join(root, "verifier-report.json");
    for (const path of [addonRoot, evidenceRoot, logRoot]) {
      mkdirSync(path, { recursive: true });
    }

    const result = runScript(sharedLauncher, [
      "-Mode", "Describe",
      "-ClientLabel", "codex",
      "-WorkbenchAddonDir", addonRoot,
      "-ObserverEvidenceRoot", evidenceRoot,
      "-ObserverSupportingLogRoot", logRoot,
      "-WorkbenchScriptAuthorizeAll",
    ], {
      REFORGER_FORGE_NODE_PATH: process.execPath,
      REFORGER_FORGE_VERIFY_REPORT_PATH: verifierMarker,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(verifierMarker)).toBe(false);
    const descriptor = JSON.parse(result.stdout) as LauncherDescriptor;
    expect(descriptor).toMatchObject({
      schemaVersion: 2,
      mode: "Describe",
      serverPath: join(repositoryRoot, "dist", "index.js"),
      verifierPath: join(repositoryRoot, "scripts", "verify-mcp-server.mjs"),
    });
    expect(descriptor.command.toLowerCase()).toBe(resolve(process.execPath).toLowerCase());
    expect(Number(/^v(\d+)\./.exec(descriptor.nodeVersion)?.[1])).toBeGreaterThanOrEqual(24);
    expect(descriptor.nodeArguments).toEqual([
      "--title=ReforgerForge-MCP-codex",
    ]);
    expect(descriptor.hostArguments).toEqual([
      "--mcp-client-label",
      "codex",
    ]);
    expect(descriptor.configurationArguments).toEqual([
      "--workbench-addon-dir", resolve(addonRoot),
      "--workbench-script-authorize-all",
      "--observer-evidence-root", resolve(evidenceRoot),
      "--observer-supporting-log-root", resolve(logRoot),
    ]);
  });

  windowsIt("routes Verify and default Serve through the same normalized arguments", () => {
    const root = temporaryRoot();
    const addonRoot = join(root, "addons");
    mkdirSync(addonRoot, { recursive: true });
    const nodePath = fakeNode(root);
    const capturePath = join(root, "capture.txt");
    const environment = {
      REFORGER_FORGE_NODE_PATH: nodePath,
      LAUNCHER_CAPTURE_PATH: capturePath,
    };

    const verified = runScript(sharedLauncher, [
      "-Mode", "Verify",
      "-ClientLabel", "cursor",
      "-WorkbenchAddonDir", addonRoot,
    ], environment);
    expect(verified.error).toBeUndefined();
    expect(verified.status).toBe(0);
    expect(verified.stdout).toBe("");
    expect(verified.stderr).toBe("");
    const verifyInvocation = readFileSync(capturePath, "utf8");
    expect(verifyInvocation).toContain("scripts\\verify-mcp-server.mjs");
    expect(verifyInvocation).toContain("--title=ReforgerForge-MCP-cursor");
    expect(verifyInvocation).toContain("--mcp-client-label cursor");
    expect(verifyInvocation).toContain("--workbench-addon-dir");
    expect(verifyInvocation).toContain(resolve(addonRoot));

    rmSync(capturePath, { force: true });
    const served = runScript(sharedLauncher, [
      "-ClientLabel", "cursor",
      "-WorkbenchAddonDir", addonRoot,
    ], environment);
    expect(served.error).toBeUndefined();
    expect(served.status).toBe(0);
    expect(served.stdout).toBe("");
    expect(served.stderr).toBe("");
    const serveInvocation = readFileSync(capturePath, "utf8");
    expect(serveInvocation).toContain("dist\\index.js");
    expect(serveInvocation).toContain("--title=ReforgerForge-MCP-cursor");
    expect(serveInvocation).toContain("--mcp-client-label cursor");
    expect(serveInvocation).not.toContain("verify-mcp-server.mjs");
    expect(serveInvocation).toContain(resolve(addonRoot));
  });

  windowsIt("fails closed when the authoritative Node override is older than v24", () => {
    const root = temporaryRoot();
    const result = runScript(sharedLauncher, ["-Mode", "Describe"], {
      REFORGER_FORGE_NODE_PATH: fakeNode(root, "v20.19.0"),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Node.js 24 LTS or newer was not found");
    expect(result.stderr).toContain("v20.19.0 is older than v24");
  });

  it("contains no direct Workbench or detached process launcher", () => {
    const source = readFileSync(sharedLauncher, "utf8");
    const packageDocument = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8")
    ) as { files?: string[] };
    const packageCheck = readFileSync(
      join(repositoryRoot, "scripts", "check-package.mjs"),
      "utf8"
    );
    expect(source).not.toMatch(/\bStart-Process\b|ArmaReforger(?:Workbench)?(?:SteamDiag)?\.exe/i);
    expect(source).toContain("scripts\\verify-mcp-server.mjs");
    expect(source).toContain("dist\\index.js");
    expect(packageDocument.files).toContain("scripts/start-mcp-stdio.ps1");
    expect(packageCheck).toContain('"scripts/start-mcp-stdio.ps1"');
  });
});

describe("workspace project MCP launcher contract", () => {
  const workspaceIt = process.platform === "win32" && existsSync(workspaceAddonsRoot)
    ? it
    : it.skip;

  workspaceIt("gives every project one describable shared launcher", () => {
    const root = temporaryRoot();
    const localAppData = join(root, "localappdata");
    mkdirSync(localAppData, { recursive: true });
    const projects = findFiles(workspaceAddonsRoot, ".gproj");
    expect(projects.length).toBeGreaterThan(0);
    const localProjectGuids = new Set(projects.map(readProjectGuid));

    const launchers = projects.map((project) => join(dirname(project), "start_mcp.ps1"));
    expect(launchers.filter((launcher) => !existsSync(launcher))).toEqual([]);
    expect(new Set(launchers.map((path) => path.toLowerCase())).size).toBe(projects.length);

    for (const [projectIndex, launcher] of launchers.entries()) {
      const project = projects[projectIndex]!;
      const source = readFileSync(launcher, "utf8");
      expect(source).toContain("scripts\\start-mcp-stdio.ps1");
      expect(source).toMatch(/ValidateSet\("Serve", "Verify", "Describe"\)/);
      expect(source).not.toMatch(/\bnode\s+\$|NodeCandidates|dist\\index\.js/i);

      const result = runScript(launcher, ["-Mode", "Describe"], {
        LOCALAPPDATA: localAppData,
        REFORGER_FORGE_NODE_PATH: process.execPath,
      });
      expect(result.error, launcher).toBeUndefined();
      expect(result.status, `${launcher}\n${result.stderr}`).toBe(0);
      const descriptor = JSON.parse(result.stdout) as LauncherDescriptor;
      expect(descriptor.serverPath).toBe(join(repositoryRoot, "dist", "index.js"));
      expect(descriptor.configurationArguments).not.toContain(workspaceAddonsRoot);

      const dependencyAudit = auditWorkbenchAddonDependencies({
        targetGprojPath: project,
        addonRoots: describedAddonRoots(descriptor.configurationArguments),
      });
      const unresolvedLocalDependencies = dependencyAudit.missingGuids.filter(
        (guid) => localProjectGuids.has(guid)
      );
      expect(
        unresolvedLocalDependencies,
        `${launcher}: local project dependencies are outside its configured roots`
      ).toEqual([]);
      expect(
        dependencyAudit.ambiguousGuids.filter((guid) => localProjectGuids.has(guid)),
        `${launcher}: local project dependencies resolve ambiguously`
      ).toEqual([]);

      for (let index = 0; index < descriptor.configurationArguments.length; index += 1) {
        const argument = descriptor.configurationArguments[index]!;
        if (argument === "--workbench-script-authorize-all") continue;
        expect([
          "--workbench-addon-dir",
          "--observer-evidence-root",
          "--observer-supporting-log-root",
        ]).toContain(argument);
        const path = descriptor.configurationArguments[++index];
        expect(path, `${launcher}: ${argument} has no path`).toBeDefined();
        expect(existsSync(path!), `${launcher}: ${path} does not exist`).toBe(true);
      }
    }
  }, 60_000);
});
