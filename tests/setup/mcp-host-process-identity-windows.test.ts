import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManagedMcpServerArguments,
  formatMcpNodeTitleArgument,
} from "../../src/mcp-host-identity.js";

const serverPath = resolve("dist", "index.js");
const lifecycleHelperPath = resolve("scripts", "windows", "workbench-lifecycle.ps1");
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

async function closeExactChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
  child.stdin.end();
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 2_500)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([
      closed,
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_500)),
    ]);
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(closeExactChild));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 15_000);

function inspectProcess(
  pid: number,
  expectedArguments: readonly string[]
): {
  readonly ok: boolean;
  readonly status: string;
  readonly expectedArgumentsMatched: boolean;
  readonly identity: {
    readonly pid: number;
    readonly executablePath: string;
    readonly creationTime: string;
  };
} {
  const output = execFileSync(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    lifecycleHelperPath,
    "-Mode",
    "InspectProcess",
    "-DeadlineUnixMs",
    String(Date.now() + 20_000),
  ], {
    input: `${JSON.stringify({ pid, expectedArguments })}\n`,
    encoding: "utf8",
    windowsHide: true,
    timeout: 25_000,
  });
  return JSON.parse(output.trim()) as ReturnType<typeof inspectProcess>;
}

async function startHost(clientLabel: string): Promise<{
  readonly child: ChildProcessWithoutNullStreams;
  readonly instanceId: string;
  readonly expectedArguments: string[];
  readonly startupRecord: string;
  readonly readStdout: () => string;
}> {
  const root = mkdtempSync(join(tmpdir(), "rfo-mcp-host-identity-"));
  roots.push(root);
  const toolsRoot = join(root, "tools");
  const gameRoot = join(root, "game");
  mkdirSync(join(toolsRoot, "Workbench"), { recursive: true });
  mkdirSync(join(gameRoot, "addons"), { recursive: true });
  writeFileSync(
    join(toolsRoot, "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
    "fixture",
    "utf8"
  );
  writeFileSync(join(gameRoot, "ArmaReforgerSteamDiag.exe"), "fixture", "utf8");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    workbenchPath: toolsRoot,
    gamePath: gameRoot,
  }), "utf8");
  const expectedArguments = buildManagedMcpServerArguments({
    clientLabel,
    serverPath,
    configurationArguments: ["--config", configPath],
  });
  const child = spawn(process.execPath, expectedArguments, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const startup = await new Promise<string>((resolvePromise, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(
      `MCP host did not report startup: ${stderr}`
    )), 20_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.includes("MCP host started")) {
        clearTimeout(timeout);
        resolvePromise(stderr);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`MCP host exited before startup (${code}): ${stderr}`));
    });
  });
  const instanceId = /instanceId=([0-9a-f-]{36})/i.exec(startup)?.[1];
  if (!instanceId) throw new Error(`Startup record omitted the host UUID: ${startup}`);
  return {
    child,
    instanceId,
    expectedArguments,
    startupRecord: startup,
    readStdout: () => stdout,
  };
}

describe.runIf(
  process.platform === "win32" &&
  existsSync(serverPath) &&
  existsSync(lifecycleHelperPath)
)("managed MCP host process identity", () => {
  it("attests two distinct client labels in real Node command lines", async () => {
    const codex = await startHost("codex");
    const cursor = await startHost("cursor");
    expect(codex.instanceId).not.toBe(cursor.instanceId);

    for (const [label, host] of [["codex", codex], ["cursor", cursor]] as const) {
      expect(host.child.pid).toBeTypeOf("number");
      const inspected = inspectProcess(host.child.pid!, host.expectedArguments);
      expect(inspected).toMatchObject({
        ok: true,
        status: "found",
        expectedArgumentsMatched: true,
        identity: { pid: host.child.pid },
      });
      expect(realpathSync.native(inspected.identity.executablePath).toLowerCase())
        .toBe(realpathSync.native(process.execPath).toLowerCase());
      expect(basename(inspected.identity.executablePath).toLowerCase())
        .toBe(basename(process.execPath).toLowerCase());
      expect(host.expectedArguments[0]).toBe(formatMcpNodeTitleArgument(label));
      expect(inspected.identity.creationTime).toMatch(/^\d+$/);
      expect(host.startupRecord).toContain(
        `MCP host started product=reforger-forge-mcp client=${label} ` +
        `instanceId=${host.instanceId} pid=${host.child.pid}`
      );
      expect(host.readStdout()).toBe("");
    }
  }, 45_000);
});
