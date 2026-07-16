import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../../src/config.js";
import { WorkbenchClient, WorkbenchError } from "../../../src/workbench/client.js";
import { canonicalizeGproj } from "../../../src/workbench/project-identity.js";
import { WorkbenchProcessGuard, type LifecycleOperationKind } from "../../../src/workbench/process-guard.js";

const stateDir = process.env.RR_STATE_DIR;
const helperPath = process.env.RR_HELPER_PATH;
const mutexName = process.env.RR_MUTEX_NAME;
const role = process.env.RR_WORKER_ROLE;
const gprojPath = process.env.RR_GPROJ_PATH;

if (!stateDir || !helperPath || !mutexName || !role || !gprojPath) {
  throw new Error("Lifecycle worker environment is incomplete.");
}

const guard = new WorkbenchProcessGuard({
  stateDir,
  legacyStatePath: `${stateDir}.legacy.json`,
  helperPath,
  mutexName,
  lockTimeoutMs: 10_000,
});
const endpoint = { host: "127.0.0.1", port: 5775 };
const project = canonicalizeGproj(gprojPath);
const target = { path: project.displayPath, comparisonKey: project.comparisonKey };
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const config: Config = {
  workbenchPath: packageRoot,
  projectPath: dirname(gprojPath),
  gamePath: packageRoot,
  dataDir: join(packageRoot, "data"),
  patternsDir: join(packageRoot, "data", "patterns"),
  workbenchHost: endpoint.host,
  workbenchPort: endpoint.port,
};

async function claim(kind: LifecycleOperationKind): Promise<unknown> {
  return guard.withLifecycleLock((session) => session.validateAndClaim({
    endpoint,
    target,
    operation: { kind, operationId: randomUUID() },
  }));
}

async function refused(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return { kind: "unexpected_success" };
  } catch (error) {
    return {
      kind: "refused",
      code: error instanceof WorkbenchError ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

try {
  if (role === "owner") {
    const result = await claim("launch");
    process.stdout.write(`${JSON.stringify({ role, result })}\n`);
  } else if (role === "contender") {
    const client = new WorkbenchClient(
      endpoint.host,
      endpoint.port,
      config,
      "multiprocess-contender",
      guard
    );
    const results: Record<string, unknown> = {
      launch: await refused(() => client.ensureRunning(gprojPath)),
      restart: await refused(() => client.restartOwnedWorkbench()),
      shutdown: await refused(() => client.shutdownOwnedWorkbench()),
      cleanup: await refused(() => client.cleanupHandlerScripts(dirname(gprojPath))),
    };
    process.stdout.write(`${JSON.stringify({ role, results })}\n`);
  } else {
    throw new Error(`Unknown lifecycle worker role: ${role}`);
  }

  await once(process.stdin, "data");
  process.stdin.destroy();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    role,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
}
