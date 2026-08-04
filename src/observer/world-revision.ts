import { createHash } from "node:crypto";

/**
 * A backend-neutral world identity.  The payload is deliberately opaque to
 * callers; only this module knows how to create and project it.  Keeping the
 * version in the token gives us a migration point without changing the public
 * job shape later.
 */
export type WorldRevision = string & { readonly __brand: "WorldRevision" };

const REVISION_PATTERN = /^wr1\.(runtime|workbench)\.([A-Za-z0-9_-]+)$/;

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function token(kind: "runtime" | "workbench", payload: unknown): WorldRevision {
  return `wr1.${kind}.${encode(payload)}` as WorldRevision;
}

/** Create the exact revision represented by a runtime's nullable world/epoch pair. */
export function runtimeWorldRevision(worldId: string | null, worldEpoch: number): WorldRevision {
  if (worldId !== null && (typeof worldId !== "string" || worldId.length < 1 || worldId.length > 512)) {
    throw new TypeError("Runtime world ID must be null or a bounded non-empty string");
  }
  if (!Number.isSafeInteger(worldEpoch) || worldEpoch < 0) {
    throw new TypeError("Runtime world epoch must be a non-negative safe integer");
  }
  return token("runtime", { worldId, worldEpoch });
}

/** Create the exact revision represented by a Workbench composite world identity. */
export function workbenchWorldRevision(worldIdentity: string): WorldRevision {
  if (typeof worldIdentity !== "string" || worldIdentity.length < 1 || worldIdentity.length > 2_048) {
    throw new TypeError("Workbench world identity must be a bounded non-empty string");
  }
  return token("workbench", { worldIdentity });
}

export function isWorldRevision(value: unknown): value is WorldRevision {
  if (typeof value !== "string") return false;
  const match = REVISION_PATTERN.exec(value);
  if (!match) return false;
  const decoded = decode(match[2]);
  if (match[1] === "runtime") {
    const worldId = (decoded as { worldId?: unknown } | null)?.worldId;
    return !!decoded && typeof decoded === "object" &&
      Object.prototype.hasOwnProperty.call(decoded, "worldId") &&
      ((typeof worldId === "string" && worldId.length > 0 && worldId.length <= 512) || worldId === null) &&
      Number.isSafeInteger((decoded as { worldEpoch?: unknown }).worldEpoch) &&
      ((decoded as { worldEpoch: number }).worldEpoch >= 0);
  }
  return !!decoded && typeof decoded === "object" &&
    typeof (decoded as { worldIdentity?: unknown }).worldIdentity === "string" &&
    ((decoded as { worldIdentity: string }).worldIdentity.length > 0) &&
    ((decoded as { worldIdentity: string }).worldIdentity.length <= 2_048);
}

export function assertWorldRevision(value: unknown, label = "World revision"): WorldRevision {
  if (!isWorldRevision(value)) throw new TypeError(`${label} is malformed`);
  return value;
}

export function sameWorldRevision(left: WorldRevision, right: WorldRevision): boolean {
  return left === right;
}

export function worldRevisionKind(value: WorldRevision): "runtime" | "workbench" {
  assertWorldRevision(value);
  return value.split(".", 3)[1] as "runtime" | "workbench";
}

/**
 * Compatibility fields for the pre-Stage-4 public projection.  Workbench's
 * epoch zero is produced here and nowhere else in production code.
 */
export function legacyWorldFields(revision: WorldRevision): {
  worldId: string | null;
  worldEpoch: number;
} {
  assertWorldRevision(revision);
  const [, kind, encoded] = revision.split(".", 3);
  const decoded = decode(encoded) as Record<string, unknown>;
  if (kind === "runtime") {
    return {
      worldId: typeof decoded.worldId === "string" ? decoded.worldId : null,
      worldEpoch: decoded.worldEpoch as number,
    };
  }
  return legacyWorkbenchWorldFields(decoded.worldIdentity as string);
}

/** Compatibility projection for the Workbench backend's composite identity. */
export function legacyWorkbenchWorldFields(worldIdentity: string | null): {
  worldId: string | null;
  worldEpoch: number;
} {
  return { worldId: worldIdentity, worldEpoch: 0 };
}

export function runtimeWorldFields(revision: WorldRevision): {
  worldId: string | null;
  worldEpoch: number;
} {
  assertWorldRevision(revision);
  if (worldRevisionKind(revision) !== "runtime") throw new TypeError("Expected a runtime world revision");
  return legacyWorldFields(revision);
}

export function workbenchWorldIdentity(revision: WorldRevision): string {
  assertWorldRevision(revision);
  if (worldRevisionKind(revision) !== "workbench") throw new TypeError("Expected a Workbench world revision");
  const encoded = revision.split(".", 3)[2];
  return (decode(encoded) as { worldIdentity: string }).worldIdentity;
}

/** Stable digest useful for diagnostics without exposing the encoded payload. */
export function worldRevisionDigest(revision: WorldRevision): string {
  assertWorldRevision(revision);
  return createHash("sha256").update(revision, "utf8").digest("hex");
}
