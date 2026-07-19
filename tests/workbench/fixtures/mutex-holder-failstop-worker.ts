import { writeFileSync } from "node:fs";
import { WindowsLifecycleBackend } from "../../../src/workbench/process-guard.js";

const [helperPath, markerPath, mutexName] = process.argv.slice(2);
if (!helperPath || !markerPath || !mutexName) process.exit(2);

const backend = new WindowsLifecycleBackend(helperPath, {
  helperTimeoutMs: 1_000,
  leaseLossFailStop: () => process.exit(86),
});

await backend.withMachineMutex({
  name: mutexName,
  timeoutMs: 1_000,
  action: async () => {
    setTimeout(() => writeFileSync(markerPath, "unfenced mutation", "utf8"), 750);
    await new Promise<never>(() => undefined);
  },
});

process.exit(3);
