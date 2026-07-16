#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
  ? process.execPath
  : process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = npmExecPath ? [npmExecPath, ...packArgs] : packArgs;
const pack = spawnSync(
  npmCommand,
  npmArgs,
  {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32" && !npmExecPath,
    env: {
      ...process.env,
      npm_config_cache:
        process.env.REFORGER_FORGE_NPM_CACHE ?? join(tmpdir(), "reforger-forge-npm-cache"),
    },
  }
);

if (pack.error) {
  throw pack.error;
}
if (pack.status !== 0) {
  process.stderr.write(pack.stderr);
  process.exit(pack.status ?? 1);
}

let report;
try {
  report = JSON.parse(pack.stdout);
} catch (error) {
  process.stderr.write(pack.stdout);
  throw new Error(`Could not parse npm pack JSON: ${String(error)}`);
}

const files = new Set((report[0]?.files ?? []).map((file) => file.path));
const requiredFiles = [
  "LICENSE",
  "README.md",
  "RELEASE_NOTES_v1.1.0.md",
  "dist/index.js",
  "dist/tools/wb-shutdown.js",
  "dist/workbench/handler-bundle.js",
  "dist/workbench/process-guard.js",
  "dist/workbench/project-identity.js",
  "configs/claude-desktop.json",
  "configs/cursor-global.json",
  "docs/AGENTS.md",
  "package.json",
  "reforger-forge.config.example.json",
  "scripts/check-package.mjs",
  "scripts/install-agents.ps1",
  "scripts/list-tools.mjs",
  "scripts/setup.ps1",
  "scripts/windows/workbench-lifecycle.ps1",
];
const requiredPrefixes = ["configs/", "data/", "mod/"];
const requiredHandlers = [
  "EMCP_WB_Clipboard.c",
  "EMCP_WB_Components.c",
  "EMCP_WB_CreateEntity.c",
  "EMCP_WB_DeleteEntity.c",
  "EMCP_WB_EditorControl.c",
  "EMCP_WB_ExecuteAction.c",
  "EMCP_WB_GetCameraPos.c",
  "EMCP_WB_GetEntity.c",
  "EMCP_WB_GetState.c",
  "EMCP_WB_Layers.c",
  "EMCP_WB_ListEntities.c",
  "EMCP_WB_Localization.c",
  "EMCP_WB_ModifyEntity.c",
  "EMCP_WB_Ping.c",
  "EMCP_WB_Prefabs.c",
  "EMCP_WB_Reload.c",
  "EMCP_WB_Resources.c",
  "EMCP_WB_ScriptEditor.c",
  "EMCP_WB_SelectEntity.c",
  "EMCP_WB_Terrain.c",
].map((name) => `mod/Scripts/WorkbenchGame/EnfusionMCP/${name}`);

const missingFiles = requiredFiles.filter((path) => !files.has(path));
const missingPrefixes = requiredPrefixes.filter(
  (prefix) => ![...files].some((path) => path.startsWith(prefix))
);
const handlerPrefix = "mod/Scripts/WorkbenchGame/EnfusionMCP/";
const packagedHandlers = [...files]
  .filter((path) => path.startsWith(handlerPrefix) && path.toLowerCase().endsWith(".c"))
  .sort();
const missingHandlers = requiredHandlers.filter((path) => !files.has(path));
const unexpectedHandlers = packagedHandlers.filter((path) => !requiredHandlers.includes(path));

if (missingFiles.length || missingPrefixes.length || missingHandlers.length || unexpectedHandlers.length) {
  const details = [
    ...missingFiles.map((path) => `missing file: ${path}`),
    ...missingPrefixes.map((prefix) => `missing package content under: ${prefix}`),
    ...missingHandlers.map((path) => `missing supported handler: ${path}`),
    ...unexpectedHandlers.map((path) => `unexpected packaged handler: ${path}`),
  ];
  throw new Error(`Package content check failed:\n${details.map((line) => `  - ${line}`).join("\n")}`);
}

console.log(`Package content verified: ${files.size} files, including all supported setup and lifecycle artifacts.`);
