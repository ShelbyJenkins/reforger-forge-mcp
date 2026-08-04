import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

register();
const fixtureDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(fixtureDirectory, "..", "..", "..");
const managedRoot = resolve(process.argv[2]);
const markerPath = resolve(process.argv[3]);
const [{ ObserverAgentClient }, { runCliShutdown }] = await Promise.all([
  import("../../../src/observer/agent-client.ts"),
  import("../../../src/mcp-lifecycle.ts"),
]);

const client = new ObserverAgentClient({
  agentPath: join(repositoryRoot, "tests", "observer", "fixtures", "private-child-entry.mjs"),
  arguments: [
    "--root", managedRoot,
    "--profile-root", join(managedRoot, "profiles"),
    "--source-addon", join(repositoryRoot, "observer", "addon"),
  ],
  startupTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
});

await client.ensureStarted();
writeFileSync(markerPath, "durable-state-preserved\n", "utf8");
await new Promise((resolveMessage) => {
  process.send?.({ parentPid: process.pid, childPid: client.childProcess?.pid }, resolveMessage);
});

await runCliShutdown({
  reason: "black-box persistent unsafe fixture",
  deadlineMs: 250,
  retryDelayMs: 25,
  closeProtocol: async () => undefined,
  disposeTools: async () => ({
    applicationCloseSafe: false,
    busyRuntimeIds: ["rt-black-box-busy"],
    errorRuntimes: [],
  }),
  emergencyTerminate: () => client.emergencyTerminatePrivateChildren(),
  info: () => undefined,
  warn: () => undefined,
  error: (message) => process.stderr.write(`${message}\n`),
  exit: (code) => process.exit(code),
});
