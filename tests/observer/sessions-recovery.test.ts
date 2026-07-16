import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CONTRACT_NAME, SESSION_DIRECTORY_NAME } from "../../observer/protocol/index.js";
import { cleanup, createSessionFixture, temporaryDirectory } from "./helpers.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanup));

describe("observer orphaned contract recovery", () => {
  it("preserves an exact live or unverifiable lease", async () => {
    for (const result of ["same", "unverifiable"] as const) {
      const root = temporaryDirectory();
      roots.push(root);
      const fixture = createSessionFixture(root);
      const contractPath = join(fixture.profilePath, "profile", SESSION_DIRECTORY_NAME, SESSION_CONTRACT_NAME);
      await expect(fixture.store.recoverProfileContract(fixture.profilePath, async () => result))
        .rejects.toMatchObject({ code: "PROFILE_CONFLICT" });
      expect(existsSync(contractPath)).toBe(true);
    }
  });

  it.each(["absent", "different"] as const)("archives, but never adopts, an orphan whose exact agent is %s", async (probeResult) => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
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

  it("does not recreate a removed engine profile mount while revoking", () => {
    const root = temporaryDirectory();
    roots.push(root);
    const fixture = createSessionFixture(root);
    const engineProfile = join(fixture.profilePath, "profile");
    rmSync(engineProfile, { recursive: true });

    expect(fixture.store.revoke(fixture.created.contract.sessionId)).toBe(true);
    expect(existsSync(engineProfile)).toBe(false);
  });
});
