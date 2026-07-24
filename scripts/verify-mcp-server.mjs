#!/usr/bin/env node
/**
 * Verifies the ReforgerForge MCP server and its registered tool contract.
 * Run: node scripts/verify-mcp-server.mjs --config C:\path\to\config.json
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "dist", "index.js");
const serverArguments = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath, ...serverArguments],
  cwd: root,
});

const client = new Client({ name: "server-verifier", version: "1.1.0" });

console.log("Connecting to ReforgerForge MCP...\n");

await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const sorted = tools.sort((a, b) => a.name.localeCompare(b.name));
const offline = [];
const workbench = [];
const lifecycle = [];
const connection = [];
const observer = [];
const hybrid = [];

const offlineNames = new Set([
  "api_search", "component_search", "wiki_search", "wiki_read", "wb_knowledge",
  "game_browse", "game_read", "asset_search", "project", "prefab",
  "script_create", "layout_create", "config_create", "server_config",
  "scenario_create_conflict", "animation_graph", "building_setup", "workshop_info",
]);
const lifecycleNames = new Set([
  "wb_launch", "wb_restart", "wb_shutdown",
]);
const connectionNames = new Set(["wb_connect", "wb_diagnose"]);
const workbenchNames = new Set(["scenario_create"]);
const hybridNames = new Set(["game_duplicate", "mod"]);
const observerNames = new Set([
  "observer_setup",
  "observer_prepare_launch",
  "observer_runtime",
  "observer_instances",
  "observer_capture",
  "observer_job",
  "observer_run",
]);
const readme = readFileSync(join(root, "README.md"), "utf8");
const toolReference = readme.split("## Complete Tool Reference")[1]?.split(/^## /m)[0] ?? "";
const documentedNames = new Set(
  [...toolReference.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((match) => match[1])
);

for (const tool of sorted) {
  if (observerNames.has(tool.name)) observer.push(tool.name);
  else if (lifecycleNames.has(tool.name)) lifecycle.push(tool.name);
  else if (connectionNames.has(tool.name)) connection.push(tool.name);
  else if (offlineNames.has(tool.name)) offline.push(tool.name);
  else if (workbenchNames.has(tool.name) || tool.name.startsWith("wb_")) workbench.push(tool.name);
  else if (hybridNames.has(tool.name)) hybrid.push(tool.name);
  else hybrid.push(tool.name);
}

console.log(`Total tools: ${sorted.length}\n`);
console.log(`Offline / no Workbench required (${offline.length}):`);
offline.forEach((t) => console.log(`  - ${t}`));
console.log(`\nWorkbench lifecycle / maintenance (${lifecycle.length}):`);
lifecycle.forEach((t) => console.log(`  - ${t}`));
console.log(`\nWorkbench connection / diagnostics (${connection.length}):`);
connection.forEach((t) => console.log(`  - ${t}`));
console.log(`\nObserver platform (${observer.length}):`);
observer.forEach((t) => console.log(`  - ${t}`));
console.log(`\nWorkbench live tools (${workbench.length}):`);
workbench.forEach((t) => console.log(`  - ${t}`));
if (hybrid.length) {
  console.log(`\nMixed / depends on action (${hybrid.length}):`);
  hybrid.forEach((t) => console.log(`  - ${t}`));
}

const registeredNames = new Set(sorted.map((tool) => tool.name));
const removedToolNames = ["wb_play", "wb_save", "wb_execute_action"];
const unexpectedlyRegistered = removedToolNames.filter((name) => registeredNames.has(name));
const modProperties = sorted.find((tool) => tool.name === "mod")?.inputSchema?.properties ?? {};
const modActions = Array.isArray(modProperties.action?.enum) ? modProperties.action.enum : [];
const removedModProperties = ["addonName", "platform", "outputPath", "gprojPath", "filterPath"]
  .filter((name) => Object.hasOwn(modProperties, name));
const reloadTarget = sorted.find((tool) => tool.name === "wb_reload")
  ?.inputSchema?.properties?.target;
const invalidReloadSurface = reloadTarget?.default !== "plugins" ||
  !Array.isArray(reloadTarget?.enum) ||
  reloadTarget.enum.length !== 1 ||
  reloadTarget.enum[0] !== "plugins";
const missingObserverTools = [...observerNames].filter((name) => !registeredNames.has(name));
const missingDocumented = [...documentedNames].filter((name) => !registeredNames.has(name));
const undocumented = [...registeredNames].filter((name) => !documentedNames.has(name));
if (documentedNames.size === 0 || unexpectedlyRegistered.length > 0 ||
    modActions.includes("build") || removedModProperties.length > 0 || invalidReloadSurface ||
    missingObserverTools.length > 0 || missingDocumented.length > 0 || undocumented.length > 0) {
  if (documentedNames.size === 0) console.error("\nREADME tool reference could not be parsed.");
  if (unexpectedlyRegistered.length > 0) {
    console.error(`\nRemoved refusal-only tools still registered: ${unexpectedlyRegistered.join(", ")}`);
  }
  if (modActions.includes("build") || removedModProperties.length > 0) {
    console.error(`\nRemoved mod build surface is still advertised: ${[
      modActions.includes("build") ? "action=build" : "",
      ...removedModProperties,
    ].filter(Boolean).join(", ")}`);
  }
  if (invalidReloadSurface) {
    console.error("\nwb_reload must advertise only target=plugins and default to it.");
  }
  if (missingObserverTools.length > 0) {
    console.error(`\nRequired observer tools missing at runtime: ${missingObserverTools.join(", ")}`);
  }
  if (missingDocumented.length > 0) {
    console.error(`\nDocumented tools missing at runtime: ${missingDocumented.join(", ")}`);
  }
  if (undocumented.length > 0) {
    console.error(`\nRuntime tools missing from README: ${undocumented.join(", ")}`);
  }
  process.exitCode = 1;
}
