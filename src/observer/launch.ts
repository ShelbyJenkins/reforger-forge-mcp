import { ObserverCoordinatorError } from "./coordinator.js";

export interface ObserverLaunchInput {
  runtimeKind: "client" | "listenServer" | "dedicated" | "testRunner";
  arguments: string[];
  profilePath: string;
  sessionTtlMs: number;
  transportPreference: Array<"rest" | "mailbox">;
  forceUpdate: boolean;
  idempotencyKey?: string;
}

export interface ObserverPreparedLaunch {
  arguments: string[];
  /** Opaque one-shot handle present on the public MCP preparation path. */
  preparedLaunchId?: string;
  sessionId: string;
  expiresAt: string;
  bundleDigest: string;
  profilePath: string;
  warnings: string[];
}

export interface ObserverPreparedLaunchRecorder {
  recordPreparedLaunch(
    input: ObserverLaunchInput,
    prepared: ObserverPreparedLaunch
  ): Promise<string>;
}

export interface ObserverLaunchPort {
  prepareLaunch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  revokeSession(sessionId: string): Promise<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Calls the agent's launcher-neutral preparation transaction and normalizes
 * only its public session descriptor. This function never starts Enfusion.
 */
export async function prepareObserverLaunch(
  coordinator: ObserverLaunchPort,
  input: ObserverLaunchInput,
  recorder?: ObserverPreparedLaunchRecorder
): Promise<ObserverPreparedLaunch> {
  let sessionId: string | null = null;
  try {
    const response = await coordinator.prepareLaunch(input as unknown as Record<string, unknown>);
    const session = record(response.session);
    const stagedAddon = record(response.stagedAddon);
    sessionId = typeof session?.sessionId === "string" ? session.sessionId : null;
    if (!session || !stagedAddon || !Array.isArray(response.arguments) ||
        !response.arguments.every((value) => typeof value === "string") ||
        !sessionId || typeof session.launchNonce !== "string" ||
        typeof session.expiresAt !== "string" || typeof session.bundleDigest !== "string" ||
        typeof session.profilePath !== "string" || typeof session.contractPath !== "string") {
      throw new ObserverCoordinatorError("TRANSPORT_UNAVAILABLE", "Observer agent returned an invalid prepared-launch descriptor");
    }
    const prepared: ObserverPreparedLaunch = {
      arguments: response.arguments as string[],
      sessionId,
      expiresAt: session.expiresAt,
      bundleDigest: session.bundleDigest,
      profilePath: session.profilePath,
      warnings: Array.isArray(response.warnings)
        ? response.warnings.filter((warning): warning is string => typeof warning === "string")
        : [],
    };
    if (!recorder) return prepared;
    const preparedLaunchId = await recorder.recordPreparedLaunch(input, prepared);
    return { ...prepared, preparedLaunchId };
  } catch (error) {
    if (sessionId) await coordinator.revokeSession(sessionId).catch(() => undefined);
    throw error;
  }
}
