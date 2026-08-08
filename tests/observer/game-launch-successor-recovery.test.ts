import { describe, expect, it } from "vitest";
import { parseGameLaunchInput } from "../../src/tools/game-launch.js";
import { deriveOwnedGameLaunchAttemptKey } from "../../src/tools/owned-runtime-operations.js";

describe("game-launch successor recovery contract", () => {
  it("keeps identical canonical launch intent distinct across fenced attempts", () => {
    const canonicalFingerprint = "b".repeat(64);
    const predecessor = deriveOwnedGameLaunchAttemptKey("prepare", {
      delivery: "owned",
      compositeAttemptId: "ga-00000000-0000-4000-8000-000000000001",
      canonicalFingerprint,
    });
    const successor = deriveOwnedGameLaunchAttemptKey("prepare", {
      delivery: "owned",
      compositeAttemptId: "ga-00000000-0000-4000-8000-000000000002",
      canonicalFingerprint,
    });

    expect(successor).not.toBe(predecessor);
    expect(predecessor).toMatch(/^mcp-game-launch-attempt-prepare-v1-[a-f0-9]{64}$/);
    expect(successor).toMatch(/^mcp-game-launch-attempt-prepare-v1-[a-f0-9]{64}$/);
  });

  it("accepts afterRuntimeId only on the strict start branch", () => {
    const afterRuntimeId = "rt-00000000-0000-4000-8000-000000000001";
    expect(parseGameLaunchInput({ action: "start", afterRuntimeId }, 60_000)).toMatchObject({
      action: "start",
      afterRuntimeId,
    });
    expect(() => parseGameLaunchInput({
      action: "stop",
      runtimeId: afterRuntimeId,
      afterRuntimeId,
    }, 60_000)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});
