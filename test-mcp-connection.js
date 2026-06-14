/**
 * Quick test script to verify ReforgerForge MCP is working.
 * Run with: node test-mcp-connection.js
 */

import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "dist", "index.js");

console.log("Testing ReforgerForge MCP connection...\n");

const server = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let hasStarted = false;
let hasLoaded = false;

server.stderr.on("data", (data) => {
  const text = data.toString();
  if (text.includes("Loaded index")) {
    hasLoaded = true;
    console.log("API index loaded");
    console.log(`   ${text.trim()}`);
  }
  if (text.includes("ReforgerForge MCP server started")) {
    hasStarted = true;
    console.log("MCP server started");
  }
});

server.on("error", (error) => {
  console.error("Failed to start server:", error.message);
  process.exit(1);
});

setTimeout(() => {
  if (hasLoaded && hasStarted) {
    console.log("\nSUCCESS - ReforgerForge MCP is working.");
    console.log("Run: node scripts/list-tools.mjs");
  } else {
    console.log("\nServer did not complete initialization.");
    process.exit(1);
  }
  server.kill();
  process.exit(0);
}, 5000);
