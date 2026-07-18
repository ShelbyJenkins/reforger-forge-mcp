#!/usr/bin/env node
/**
 * Lists all tools registered by ReforgerForge MCP.
 * Run: node scripts/list-tools.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "dist", "index.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  cwd: root,
});

const client = new Client({ name: "tool-lister", version: "1.1.0" });

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
const missingObserverTools = [...observerNames].filter((name) => !registeredNames.has(name));
const missingDocumented = [...documentedNames].filter((name) => !registeredNames.has(name));
const undocumented = [...registeredNames].filter((name) => !documentedNames.has(name));
if (documentedNames.size === 0 || missingObserverTools.length > 0 || missingDocumented.length > 0 || undocumented.length > 0) {
  if (documentedNames.size === 0) console.error("\nREADME tool reference could not be parsed.");
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
