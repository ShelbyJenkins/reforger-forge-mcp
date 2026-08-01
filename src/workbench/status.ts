import type { WorkbenchClient, WorkbenchMode } from "./client.js";

/**
 * A just-observed Workbench mode. `reportedMode` retains the helper's native
 * value (`game`, for example) while `mode` uses the stable client vocabulary.
 */
export interface AuthoritativeWorkbenchMode {
  mode: WorkbenchMode;
  reportedMode: string;
  message?: string;
}

/**
 * Build a status footer line showing current Workbench connection state.
 * Appended to all wb_* tool responses so the LLM always knows the mode.
 */
export function formatConnectionStatus(client: WorkbenchClient): string {
  const { connected, mode } = client.state;
  if (!connected) return "\n\n---\n`Workbench: disconnected`";
  if (mode === "play") return "\n\n---\n`Workbench: play mode`";
  if (mode === "edit") return "\n\n---\n`Workbench: edit mode`";
  return "\n\n---\n`Workbench: connected (mode unknown)`";
}

/**
 * Read the current mode from the Workbench helper without launching or
 * restarting Workbench. The cached edit state can become stale when someone
 * enters Play between MCP calls.
 */
export async function getAuthoritativeWorkbenchMode(
  client: WorkbenchClient
): Promise<AuthoritativeWorkbenchMode> {
  if (!client.state.connected) {
    return { mode: "unknown", reportedMode: "unknown" };
  }

  try {
    const state = await client.call<Record<string, unknown>>(
      "EMCP_WB_GetState",
      {},
      { skipAutoLaunch: true }
    );
    const reportedMode = typeof state.mode === "string" ? state.mode : "unknown";
    const mode: WorkbenchMode = reportedMode === "edit"
      ? "edit"
      : reportedMode === "play" || reportedMode === "game"
        ? "play"
        : "unknown";
    const message = typeof state.message === "string" && state.message
      ? state.message
      : undefined;
    return { mode, reportedMode, ...(message ? { message } : {}) };
  } catch {
    return { mode: "unknown", reportedMode: "unknown" };
  }
}

/**
 * Require a fresh helper-confirmed edit mode before a mutation. This fails
 * closed on stale, unavailable, or unknown state and never launches or
 * restarts Workbench to obtain confirmation.
 */
export async function requireEditMode(
  client: WorkbenchClient,
  toolAction: string
): Promise<string | null> {
  const state = await getAuthoritativeWorkbenchMode(client);
  if (state.mode === "play") {
    return `Cannot ${toolAction} while in play mode. Call \`wb_stop\` first to return to edit mode.`;
  }
  if (state.mode === "unknown") {
    return `Cannot ${toolAction}: Workbench mode is unknown. Call \`wb_state\` first to confirm edit mode.`;
  }
  return null;
}

/**
 * ResourceManager mutations do not require an open World Editor document.
 * They are safe in a generic Workbench session, but must still fail closed
 * while the game is genuinely in Play mode.
 */
export async function requireResourceManagerMode(
  client: WorkbenchClient,
  toolAction: string
): Promise<string | null> {
  const state = await getAuthoritativeWorkbenchMode(client);
  if (state.mode === "play") {
    return `Cannot ${toolAction} while in play mode. Call \`wb_stop\` first to return to edit mode.`;
  }
  if (state.mode === "edit" || state.reportedMode === "no_world_editor") {
    return null;
  }
  return `Cannot ${toolAction}: Workbench mode is unknown. Call \`wb_state\` first to confirm that Play mode is not active.`;
}

/**
 * Check if the cached state indicates edit mode.
 * Returns a warning message if so, or null if the tool can proceed.
 * Also blocks when mode is unknown.
 */
export function requirePlayMode(client: WorkbenchClient, toolAction: string): string | null {
  if (client.state.mode === "edit") {
    return (
      `Cannot ${toolAction} while in edit mode. No automated Play tool exists; enter Play mode ` +
      `manually in Workbench, then call \`wb_state\` to confirm Play mode.`
    );
  }
  if (client.state.mode === "unknown") {
    return `Cannot ${toolAction}: Workbench mode is unknown. Call \`wb_state\` first to confirm play mode.`;
  }
  return null;
}
