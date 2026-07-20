import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SESSION_CONTRACT_NAME, SESSION_DIRECTORY_NAME } from "../../observer/protocol/index.js";
import { createObserverSessionFixture } from "../support/observer-fixtures.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer orphaned contract recovery", () => {
  it("preserves an exact live or unverifiable lease", async () => {
    for (const result of ["same", "unverifiable"] as const) {
      await withTemporaryDirectory(async (root) => {
        const fixture = createObserverSessionFixture({ root });
        const contractPath = join(fixture.profilePath, "profile", SESSION_DIRECTORY_NAME, SESSION_CONTRACT_NAME);
        await expect(fixture.store.recoverProfileContract(fixture.profilePath, async () => result))
          .rejects.toMatchObject({ code: "PROFILE_CONFLICT" });
        expect(existsSync(contractPath)).toBe(true);
      });
    }
  });

  it.each(["absent", "different"] as const)("archives, but never adopts, an orphan whose exact agent is %s", async (probeResult) => {
    await withTemporaryDirectory(async (root) => {
      const fixture = createObserverSessionFixture({ root });
      const previousSessionId = fixture.created.contract.sessionId;
      const result = await fixture.store.recoverProfileContract(fixture.profilePath, async (contract) => {
        expect(contract.agent.instanceId).toBe("agent-test-1");
        return probeResult;
      });
      expect(result.kind).toBe("orphan_archived");
      expect(existsSync(join(fixture.profilePath, "profile", SESSION_DIRECTORY_NAME, SESSION_CONTRACT_NAME))).toBe(false);
      const archive = join(fixture.profilePath, "profile", SESSION_DIRECTORY_NAME, "orphaned-contracts");
      expect(readdirSync(archive).some((name) => name.startsWith(`${previousSessionId}-`))).toBe(true);
      expect(fixture.store.diagnostics()).toHaveLength(1);
    });
  });

  it("does not recreate a removed engine profile mount while revoking", async () => {
    await withTemporaryDirectory((root) => {
      const fixture = createObserverSessionFixture({ root });
      const engineProfile = join(fixture.profilePath, "profile");
      rmSync(engineProfile, { recursive: true });

      expect(fixture.store.revoke(fixture.created.contract.sessionId)).toBe(true);
      expect(existsSync(engineProfile)).toBe(false);
    });
  });

  it("commits revocation even when the on-disk contract is malformed", async () => {
    await withTemporaryDirectory((root) => {
      const fixture = createObserverSessionFixture({ root });
      const sessionId = fixture.created.contract.sessionId;
      const contractPath = join(fixture.profilePath, "profile", SESSION_DIRECTORY_NAME, SESSION_CONTRACT_NAME);
      writeFileSync(contractPath, "{\n");

      expect(fixture.store.revoke(sessionId)).toBe(true);
      expect(fixture.store.peek(sessionId)?.revokedAt).not.toBeNull();
      expect(() => fixture.store.get(sessionId))
        .toThrowError(expect.objectContaining({ code: "SESSION_EXPIRED" }));
      expect(existsSync(contractPath)).toBe(true);
    });
  });
});
