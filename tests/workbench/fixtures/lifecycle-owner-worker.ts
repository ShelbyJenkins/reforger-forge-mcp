import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { WorkbenchProcessGuard } from "../../../src/workbench/process-guard.js";
import { canonicalizeGproj } from "../../../src/workbench/project-identity.js";

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
  helperPath,
  mutexName,
  lockTimeoutMs: 10_000,
});
const endpoint = { host: "127.0.0.1", port: 5775 };
const project = canonicalizeGproj(gprojPath);
const target = { path: project.displayPath, comparisonKey: project.comparisonKey };

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ role, ...payload })}\n`);
}

async function claim(): Promise<unknown> {
  return guard.withLifecycleLock((session) => session.validateAndClaim({ endpoint, target }));
}

/**
 * Move the lease this worker already owns out of the idle window, so a
 * competing claim must be refused rather than preempted.
 */
async function reserve(): Promise<unknown> {
  return guard.withLifecycleLock(async (session) => {
    const read = await session.readState();
    if (read.kind !== "valid") throw new Error(`Lifecycle state is ${read.kind}.`);
    const state = read.state;
    return session.transition(
      { generation: state.generation, leaseId: state.mcpOwner?.leaseId ?? null },
      {
        phase: "starting",
        endpoint: state.endpoint,
        target: state.target,
        mcpOwner: state.mcpOwner,
        workbench: null,
        companion: state.companion,
        operation: { kind: "launch", operationId: randomUUID() },
      }
    );
  });
}

async function run(command: string): Promise<void> {
  try {
    if (command === "claim") emit({ command, result: await claim() });
    else if (command === "reserve") emit({ command, result: await reserve() });
    else throw new Error(`Unknown lifecycle worker command: ${command}`);
  } catch (error) {
    emit({ command, error: error instanceof Error ? error.message : String(error) });
  }
}

if (role === "owner") {
  await run("claim");
} else if (role !== "contender") {
  emit({ error: `Unknown lifecycle worker role: ${role}` });
  process.exit(1);
}

const commands = createInterface({ input: process.stdin });
for await (const line of commands) {
  const command = line.trim();
  if (!command || command === "release") break;
  await run(command);
}
commands.close();
await guard.close();
