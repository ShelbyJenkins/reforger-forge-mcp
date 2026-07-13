#!/usr/bin/env node
/**
 * Lists all tools registered by ReforgerForge MCP.
 * Run: node scripts/list-tools.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "dist", "index.js");

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  cwd: root,
});

const client = new Client({ name: "tool-lister", version: "1.0.0" });

console.log("Connecting to ReforgerForge MCP...\n");

await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const sorted = tools.sort((a, b) => a.name.localeCompare(b.name));
const offline = [];
const workbench = [];
const hybrid = [];

const offlineNames = new Set([
  "api_search", "component_search", "wiki_search", "wiki_read", "wb_knowledge",
  "wb_cleanup", "game_browse", "game_read", "asset_search", "project", "prefab",
  "script_create", "layout_create", "config_create", "server_config",
  "scenario_create_conflict", "animation_graph", "building_setup", "workshop_info",
]);
const workbenchNames = new Set(["scenario_create"]);
const hybridNames = new Set(["game_duplicate", "mod"]);

for (const tool of sorted) {
  if (offlineNames.has(tool.name)) offline.push(tool.name);
  else if (workbenchNames.has(tool.name) || tool.name.startsWith("wb_")) workbench.push(tool.name);
  else if (hybridNames.has(tool.name)) hybrid.push(tool.name);
  else hybrid.push(tool.name);
}

console.log(`Total tools: ${sorted.length}\n`);
console.log(`Offline / no Workbench required (${offline.length}):`);
offline.forEach((t) => console.log(`  - ${t}`));
console.log(`\nWorkbench live tools (${workbench.length}):`);
workbench.forEach((t) => console.log(`  - ${t}`));
if (hybrid.length) {
  console.log(`\nMixed / depends on action (${hybrid.length}):`);
  hybrid.forEach((t) => console.log(`  - ${t}`));
}
