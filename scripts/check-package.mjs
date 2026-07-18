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
  "dist/observer/agent/index.js",
  "dist/observer/agent/private-child.js",
  "dist/observer/coordinator.js",
  "dist/observer/launch.js",
  "dist/observer/setup.js",
  "dist/observer/tools.js",
  "dist/observer/protocol/index.js",
  "dist/tools/wb-shutdown.js",
  "dist/workbench/helper-addon.js",
  "dist/workbench/observer-adapter.js",
  "dist/workbench/process-guard.js",
  "dist/workbench/project-identity.js",
  "dist/workbench/runner-cli.js",
  "dist/workbench/runner.js",
  "configs/claude-desktop.json",
  "configs/cursor-global.json",
  "docs/AGENTS.md",
  "observer/README.md",
  "observer/addon/addon.gproj",
  "observer/addon/.reforger-forge-observer-source.json",
  "observer/workbench-addon/addon.gproj",
  "observer/workbench-addon/.reforger-forge-workbench-helper-source.json",
  "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/RFWB_HelperBuild.c",
  "observer/protocol/VERSION",
  "observer/protocol/schemas/session-contract.schema.json",
  "observer/protocol/schemas/instance-registration.schema.json",
  "observer/protocol/schemas/heartbeat.schema.json",
  "observer/protocol/schemas/capture-request.schema.json",
  "observer/protocol/schemas/job-status.schema.json",
  "observer/protocol/schemas/artifact-manifest.schema.json",
  "observer/protocol/schemas/error.schema.json",
  "package.json",
  "reforger-forge.config.example.json",
  "scripts/check-package.mjs",
  "scripts/install-agents.ps1",
  "scripts/list-tools.mjs",
  "scripts/observer-live-acceptance-support.ts",
  "scripts/run-runtime-observer-acceptance.ts",
  "scripts/run-workbench-observer-acceptance.ts",
  "scripts/update-observer-source-manifest.mjs",
  "scripts/setup.ps1",
  "scripts/windows/workbench-lifecycle.ps1",
];
const requiredPrefixes = ["configs/", "data/", "observer/workbench-addon/"];
const requiredObserverScripts = [
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverBuild.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapabilities.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapture.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverJob.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverJson.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverMailboxTransport.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverRestTransport.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverService.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverSession.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverTime.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverTransport.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverWorld.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverBootstrap.c",
].map((path) => `observer/addon/${path}`);
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
  "EMCP_WB_ObserverCancel.c",
  "EMCP_WB_ObserverCommon.c",
  "EMCP_WB_ObserverPing.c",
  "EMCP_WB_ObserverRelease.c",
  "EMCP_WB_ObserverStatus.c",
  "EMCP_WB_ObserverSubmit.c",
  "EMCP_WB_Ping.c",
  "EMCP_WB_Prefabs.c",
  "EMCP_WB_Reload.c",
  "EMCP_WB_Resources.c",
  "EMCP_WB_ScriptEditor.c",
  "EMCP_WB_SelectEntity.c",
  "EMCP_WB_Terrain.c",
].map((name) => `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/${name}`);

const missingFiles = requiredFiles.filter((path) => !files.has(path));
const missingPrefixes = requiredPrefixes.filter(
  (prefix) => ![...files].some((path) => path.startsWith(prefix))
);
const handlerPrefix = "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/";
const requiredHelperScripts = [
  ...requiredHandlers,
  `${handlerPrefix}RFWB_HelperBuild.c`,
].sort();
const packagedHandlers = [...files]
  .filter((path) => path.startsWith(handlerPrefix) && path.toLowerCase().endsWith(".c"))
  .sort();
const missingHandlers = requiredHandlers.filter((path) => !files.has(path));
const unexpectedHandlers = packagedHandlers.filter((path) => !requiredHelperScripts.includes(path));
const missingObserverScripts = requiredObserverScripts.filter((path) => !files.has(path));
const legacyPackagedHandlers = [...files].filter((path) =>
  path.startsWith("mod/Scripts/WorkbenchGame/EnfusionMCP/")
);
const forbiddenObserverFiles = [...files].filter((path) =>
  path.startsWith("tests/observer/") ||
  path.startsWith("observer/artifacts/") ||
  path.startsWith("observer/addons/") ||
  path.startsWith("observer/state/") ||
  path.startsWith("observer/profiles/") ||
  (path.startsWith("observer/") && /(^|\/)session\.json$/i.test(path)) ||
  (path.startsWith("observer/") && /\.(bmp|png)$/i.test(path))
);

if (missingFiles.length || missingPrefixes.length || missingHandlers.length || unexpectedHandlers.length || missingObserverScripts.length || legacyPackagedHandlers.length || forbiddenObserverFiles.length) {
  const details = [
    ...missingFiles.map((path) => `missing file: ${path}`),
    ...missingPrefixes.map((prefix) => `missing package content under: ${prefix}`),
    ...missingHandlers.map((path) => `missing supported handler: ${path}`),
    ...unexpectedHandlers.map((path) => `unexpected packaged handler: ${path}`),
    ...missingObserverScripts.map((path) => `missing observer addon script: ${path}`),
    ...legacyPackagedHandlers.map((path) => `legacy project-injection handler must not be packaged: ${path}`),
    ...forbiddenObserverFiles.map((path) => `forbidden observer runtime artifact: ${path}`),
  ];
  throw new Error(`Package content check failed:\n${details.map((line) => `  - ${line}`).join("\n")}`);
}

const versionCheck = spawnSync(process.execPath, [join(root, "dist", "observer", "agent", "index.js"), "--version"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env },
});
if (versionCheck.error) throw versionCheck.error;
if (versionCheck.status !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(versionCheck.stdout)) {
  process.stderr.write(versionCheck.stderr);
  throw new Error("Compiled observer agent failed its non-network --version check");
}

console.log(`Package content verified: ${files.size} files, including MCP lifecycle, managed Workbench helper, and standalone observer artifacts.`);
