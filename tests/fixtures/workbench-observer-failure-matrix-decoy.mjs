#!/usr/bin/env node
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function option(name) {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length !== 1) throw new Error(`${name} must be supplied exactly once`);
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

const owner = option("--owner");
const exitSentinelInput = option("--exit-sentinel");
if (!/^[A-Za-z0-9_-]{16,128}$/.test(owner)) {
  throw new Error("The decoy owner argument is malformed");
}
if (!isAbsolute(exitSentinelInput)) {
  throw new Error("The decoy exit sentinel must be absolute");
}
const exitSentinel = resolve(exitSentinelInput);

// The acceptance harness must never terminate this process by PID, name, or
// signal. Ignore interactive termination signals so the generated sentinel is
// the only normal post-start exit path exercised by the matrix.
process.on("SIGINT", () => undefined);
process.on("SIGTERM", () => undefined);

setInterval(() => {
  if (existsSync(exitSentinel)) process.exit(0);
}, 25);
