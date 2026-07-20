import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../observer/agent/cli.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

describe("observer agent CLI", () => {
  it("keeps doctor read-only when both configured roots are missing", async () => {
    await withTemporaryDirectory(async (parent) => {
      const root = join(parent, "missing-managed");
      const profile = join(parent, "missing-profile");
      const output: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => {
        output.push(String(value));
        return true;
      }) as typeof process.stdout.write);
      await runCli(["doctor", "--root", root, "--profile-root", profile]);
      expect(existsSync(root)).toBe(false);
      expect(existsSync(profile)).toBe(false);
      expect(JSON.parse(output.join(""))).toMatchObject({ readOnly: true, mutationPerformed: false, stateLoaded: false });
      write.mockRestore();
    }, { prefix: "rfo-cli-doctor-" });
  });
});
