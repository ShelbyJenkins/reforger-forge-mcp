import type { BigIntStats } from "node:fs";

/** The stable operating-system fields used to bind an open file handle. */
export type BigIntFileIdentity = Pick<BigIntStats, "dev" | "ino">;

/**
 * A zero volume/device or file identifier cannot prove file identity.
 *
 * In particular, Windows file identity is the pair of volume identity and
 * file ID. Treating an unavailable half of that pair as a wildcard turns a
 * pre-open/path check into a fail-open comparison.
 */
export function hasUsableFileIdentity(value: BigIntFileIdentity): boolean {
  return value.dev !== 0n && value.ino !== 0n;
}

/** Compare two identities only when both sides carry a complete stable ID. */
export function sameUsableFileIdentity(
  left: BigIntFileIdentity,
  right: BigIntFileIdentity,
): boolean {
  return hasUsableFileIdentity(left) &&
    hasUsableFileIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino;
}
