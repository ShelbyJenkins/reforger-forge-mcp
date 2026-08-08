import { createHash } from "node:crypto";
import { z } from "zod";
import {
  OwnedRuntimeError,
  type OwnedRuntimeManager,
  type OwnedRuntimePublicStatus,
} from "../observer/owned-runtime-manager.js";
export {
  canonicalOwnedGameLaunchAttemptIdentity,
  deriveOwnedGameLaunchAttemptKey,
  OWNED_GAME_LAUNCH_ATTEMPT_IDENTITY_VERSION,
  OWNED_GAME_LAUNCH_ATTEMPT_ID_PREFIX,
  type OwnedGameLaunchAttemptIdentity,
  type OwnedGameLaunchAttemptKeyAction,
} from "../observer/game-launch-attempt.js";
import type { PublicObserverErrorCandidate } from "../observer/public-contract.js";

export const preparedLaunchIdSchema = z.string().regex(
  /^pl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
export const ownedRuntimeIdSchema = z.string().regex(
  /^rt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

export type ObserverRuntimeLifecycleOperation =
  | { readonly action: "start"; readonly preparedLaunchId: string }
  | { readonly action: "stop"; readonly runtimeId: string; readonly waitForRestorationMs: number };

export type OwnedRuntimeOperation =
  | { readonly action: "start"; readonly preparedLaunchId: string }
  | { readonly action: "status"; readonly runtimeId: string }
  | { readonly action: "stop"; readonly runtimeId: string; readonly waitForRestorationMs: number };

/** Stable private key for retrying one canonical public lifecycle mutation. */
export function deriveObserverRuntimeIdempotencyKey(
  operation: ObserverRuntimeLifecycleOperation,
): string {
  const canonical = operation.action === "start"
    ? JSON.stringify({ action: "start", preparedLaunchId: operation.preparedLaunchId })
    : JSON.stringify({
        action: "stop",
        runtimeId: operation.runtimeId,
        waitForRestorationMs: operation.waitForRestorationMs,
      });
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `mcp-runtime-${operation.action}-v1-${digest}`;
}

export function ownedRuntimeSuccessHeading(action: OwnedRuntimeOperation["action"]): string {
  if (action === "start") return "Exact-owned observer runtime started.";
  if (action === "status") return "Exact-owned observer runtime status.";
  return "Exact-owned observer runtime stopped.";
}

export function extractOwnedRuntimeError(error: unknown): PublicObserverErrorCandidate | undefined {
  if (!(error instanceof OwnedRuntimeError)) return undefined;
  return {
    code: error.code,
    readDiagnosticMessage: () => error.message,
    readDetails: () => error.details,
  };
}

/**
 * Execute one exact-owned lifecycle operation. Typed errors deliberately
 * escape so callers can apply their own trusted public dispatcher and cleanup
 * policy without reparsing rendered text.
 */
export async function executeOwnedRuntimeOperation(
  manager: OwnedRuntimeManager,
  operation: OwnedRuntimeOperation,
  signal?: AbortSignal,
): Promise<OwnedRuntimePublicStatus> {
  if (operation.action === "start") {
    return manager.start({
      preparedLaunchId: operation.preparedLaunchId,
      idempotencyKey: deriveObserverRuntimeIdempotencyKey(operation),
    });
  }
  if (operation.action === "status") return manager.status(operation.runtimeId);
  return manager.stop({
    runtimeId: operation.runtimeId,
    waitForRestorationMs: operation.waitForRestorationMs,
    idempotencyKey: deriveObserverRuntimeIdempotencyKey(operation),
    signal,
  });
}
