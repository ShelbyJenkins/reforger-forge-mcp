import { createHash } from "node:crypto";

export const OWNED_GAME_LAUNCH_ATTEMPT_IDENTITY_VERSION = 1 as const;
export const OWNED_GAME_LAUNCH_ATTEMPT_ID_PREFIX = "ga-";

export type OwnedGameLaunchAttemptKeyAction = "prepare" | "record" | "start";

export interface OwnedGameLaunchAttemptIdentity {
  readonly delivery: "owned";
  readonly compositeAttemptId: string;
  readonly canonicalFingerprint: string;
}

export function canonicalOwnedGameLaunchAttemptIdentity(
  action: OwnedGameLaunchAttemptKeyAction,
  value: OwnedGameLaunchAttemptIdentity,
): string {
  if (!/^ga-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value.compositeAttemptId,
  )) {
    throw new TypeError("Composite game-launch attempt ID is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(value.canonicalFingerprint)) {
    throw new TypeError("Canonical game-launch fingerprint is invalid");
  }
  return JSON.stringify([
    "reforger-forge-owned-game-launch-attempt",
    OWNED_GAME_LAUNCH_ATTEMPT_IDENTITY_VERSION,
    action,
    value.delivery,
    value.compositeAttemptId,
    value.canonicalFingerprint,
  ]);
}

/** Fixed attempt-scoped key shared by the composite and lifecycle manager. */
export function deriveOwnedGameLaunchAttemptKey(
  action: OwnedGameLaunchAttemptKeyAction,
  value: OwnedGameLaunchAttemptIdentity,
): string {
  const digest = createHash("sha256")
    .update(canonicalOwnedGameLaunchAttemptIdentity(action, value), "utf8")
    .digest("hex");
  return `mcp-game-launch-attempt-${action}-v1-${digest}`;
}
