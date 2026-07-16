import type { ObserverCoordinator } from "./coordinator.js";

export type ObserverSetupAction = "ensure" | "status" | "doctor" | "uninstall";

/**
 * Thin MCP-side setup facade. All staging, revocation, and cleanup decisions
 * remain inside the private observer agent.
 */
export async function runObserverSetup(
  coordinator: ObserverCoordinator,
  action: ObserverSetupAction
): Promise<Record<string, unknown>> {
  if (action === "ensure") return coordinator.ensureSetup();
  if (action === "status") return coordinator.status();
  if (action === "doctor") return coordinator.doctor();
  return coordinator.uninstall();
}
