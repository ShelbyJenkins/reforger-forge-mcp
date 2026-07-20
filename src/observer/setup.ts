import type {
  WorkbenchCompanionManagedStatus,
  WorkbenchCompanionUninstallResult,
} from "../workbench/helper-addon.js";

export type ObserverSetupAction = "ensure" | "status" | "doctor" | "uninstall";

export interface WorkbenchCompanionAdministrationPort {
  ensureManagedCompanion(projectPath?: string): Promise<Record<string, unknown>>;
  managedCompanionStatus(): WorkbenchCompanionManagedStatus;
  doctorManagedCompanion(): Record<string, unknown>;
  uninstallManagedCompanion(): Promise<WorkbenchCompanionUninstallResult>;
}

export interface ObserverSetupPort {
  ensureSetup(): Promise<Record<string, unknown>>;
  status(): Promise<Record<string, unknown>>;
  doctor(): Promise<Record<string, unknown>>;
  uninstall(): Promise<Record<string, unknown>>;
}

/**
 * Thin MCP-side setup facade. All staging, revocation, and cleanup decisions
 * remain inside the private observer agent.
 */
export async function runObserverSetup(
  coordinator: ObserverSetupPort,
  action: ObserverSetupAction,
  workbench?: {
    client: WorkbenchCompanionAdministrationPort;
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
