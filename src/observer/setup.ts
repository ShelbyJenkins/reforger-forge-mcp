import type { ObserverCoordinator } from "./coordinator.js";
import type { WorkbenchClient } from "../workbench/client.js";

export type ObserverSetupAction = "ensure" | "status" | "doctor" | "uninstall";

/**
 * Thin MCP-side setup facade. All staging, revocation, and cleanup decisions
 * remain inside the private observer agent.
 */
export async function runObserverSetup(
  coordinator: ObserverCoordinator,
  action: ObserverSetupAction,
  workbench?: {
    client: WorkbenchClient;
    projectPath?: string;
  }
): Promise<Record<string, unknown>> {
  if (!workbench) {
    if (action === "ensure") return coordinator.ensureSetup();
    if (action === "status") return coordinator.status();
    if (action === "doctor") return coordinator.doctor();
    return coordinator.uninstall();
  }
  if (action === "ensure") {
    const [runtimeObserver, workbenchCompanion] = await Promise.all([
      coordinator.ensureSetup(),
      workbench.client.ensureManagedCompanion(workbench.projectPath),
    ]);
    return { runtimeObserver, workbenchCompanion };
  }
  if (action === "status") {
    return {
      runtimeObserver: await coordinator.status(),
      workbenchCompanion: workbench.client.managedCompanionStatus(),
    };
  }
  if (action === "doctor") {
    return {
      runtimeObserver: await coordinator.doctor(),
      workbenchCompanion: workbench.client.doctorManagedCompanion(),
    };
  }
  // Both roots are removed only after their independent safety checks pass.
  // The Workbench side refuses while any Workbench process/lifecycle is live.
  const runtimeObserver = await coordinator.uninstall();
  const workbenchCompanion = await workbench.client.uninstallManagedCompanion();
  return { runtimeObserver, workbenchCompanion };
}
