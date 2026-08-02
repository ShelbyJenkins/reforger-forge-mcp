import { existsSync, writeFileSync } from "node:fs";
import { WindowsLifecycleBackend } from "../../../src/workbench/process-guard.js";

const [helperPath, lateMutationPath, survivalPath, mutexName] = process.argv.slice(2);
if (!helperPath || !lateMutationPath || !survivalPath || !mutexName) process.exit(2);

const backend = new WindowsLifecycleBackend(helperPath, {
  helperTimeoutMs: 1_000,
  // The fenced path must bypass this process-level fallback. Keeping a
  // deterministic exit here makes a regression observable to the parent test.
  leaseLossFailStop: () => process.exit(86),
});
let leaseLoss: Error | null = null;

try {
  await backend.withMachineMutex({
    name: mutexName,
    timeoutMs: 1_000,
    onLeaseLost: (error) => { leaseLoss = error; },
    action: async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
      if (leaseLoss) throw leaseLoss;
      writeFileSync(lateMutationPath, "unfenced mutation", "utf8");
    },
  });
  process.exit(3);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  if (code !== "RECOVERY_REQUIRED" || !leaseLoss) process.exit(4);
  // Stay alive past the protected action's delayed mutation point. This is the
  // stdio-host behavior under test: report the structured failure and retain a
  // process capable of servicing the next request.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
  if (existsSync(lateMutationPath)) process.exit(5);
  const followupInspection = await backend.inspectProcess(4242);
  if (followupInspection !== null) process.exit(6);
  writeFileSync(survivalPath, code, "utf8");
}
