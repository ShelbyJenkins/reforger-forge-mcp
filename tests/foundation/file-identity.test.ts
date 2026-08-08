import { describe, expect, it } from "vitest";
import {
  hasUsableFileIdentity,
  sameUsableFileIdentity,
} from "../../src/foundation/file-identity.js";

describe("stable file identity", () => {
  it("fails closed when either half of an identity is zero", () => {
    expect(hasUsableFileIdentity({ dev: 0n, ino: 9n })).toBe(false);
    expect(hasUsableFileIdentity({ dev: 7n, ino: 0n })).toBe(false);
    expect(sameUsableFileIdentity(
      { dev: 0n, ino: 0n },
      { dev: 0n, ino: 0n },
    )).toBe(false);
    expect(sameUsableFileIdentity(
      { dev: 7n, ino: 9n },
      { dev: 7n, ino: 9n },
    )).toBe(true);
  });

  it("rejects a different file on the same device", () => {
    expect(sameUsableFileIdentity(
      { dev: 7n, ino: 9n },
      { dev: 7n, ino: 10n },
    )).toBe(false);
  });
});
