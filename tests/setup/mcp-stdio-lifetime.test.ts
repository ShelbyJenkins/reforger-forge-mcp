import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverEntry = join(repositoryRoot, "src", "index.ts");

function executableAlias(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((entry): entry is { type: "text"; text: string } =>
      !!entry && typeof entry === "object" &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    )
    .map((entry) => entry.text)
    .join("\n");
}

describe.runIf(process.platform === "win32")("MCP stdio lifetime after Workbench launch failure", () => {
  it("keeps wb_diagnose callable on the same client after a spawned Workbench exits", async () => {
    await withTemporaryDirectory(async (root) => {
      const toolsRoot = join(root, "Arma Reforger Tools");
      const workbenchExe = join(
        toolsRoot,
        "Workbench",
        "ArmaReforgerWorkbenchSteamDiag.exe"
      );
      // A Node executable under the exact Workbench image name accepts the
      // spawn, then exits on Workbench-only arguments. This exercises the real
      // stdio server, native lifecycle mutex, launch transaction, and rollback
      // without opening an attended editor.
      executableAlias(process.execPath, workbenchExe);

      const gameRoot = join(root, "Arma Reforger");
      mkdirSync(join(gameRoot, "addons"), { recursive: true });
      writeFileSync(join(gameRoot, "ArmaReforgerSteamDiag.exe"), "fixture");

      const addonRoot = join(root, "projects", "addons");
      const projectPath = join(addonRoot, "ExampleMod", "ExampleMod.gproj");
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(projectPath, [
        "GameProject {",
        " ID ExampleMod",
        ' GUID "1122334455667788"',
        "}",
        "",
      ].join("\n"));

      const localAppData = join(root, "localappdata");
      mkdirSync(localAppData, { recursive: true });
      const configPath = join(root, "config.json");
      writeFileSync(configPath, JSON.stringify({
        workbenchPath: toolsRoot,
        gamePath: gameRoot,
        workbenchAddonDirs: [addonRoot],
        workbenchScriptAuthorizeAll: true,
      }));

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", serverEntry, "--config", configPath],
        cwd: repositoryRoot,
        env: {
          ...getDefaultEnvironment(),
          LOCALAPPDATA: localAppData,
        },
        stderr: "pipe",
      });
      const client = new Client({ name: "stdio-lifetime-test", version: "1.0.0" });
      let stderr = "";
      transport.stderr?.on("data", (chunk: unknown) => { stderr += String(chunk); });
      try {
        await client.connect(transport);
        const launch = await client.callTool({
          name: "wb_launch",
          arguments: { gprojPath: projectPath },
        });
        expect(launch.isError, stderr).toBe(true);
        expect(textOf(launch), stderr).toContain("Launch Refused");

        const diagnosis = await client.callTool({
          name: "wb_diagnose",
          arguments: {},
        });
        expect(diagnosis.isError, stderr).not.toBe(true);
        expect(textOf(diagnosis), stderr).toContain("Reforger Forge Workbench Diagnostic");
      } finally {
        await client.close().catch(() => undefined);
      }
    }, { prefix: "rfo-mcp-stdio-lifetime-" });
  }, 30_000);
});
