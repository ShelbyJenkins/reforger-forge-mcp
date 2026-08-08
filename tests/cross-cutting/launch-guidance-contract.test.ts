import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gameLaunchRawInputShape } from "../../src/tools/game-launch.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), "utf8");
}

describe("public launch and recovery guidance", () => {
  it("pins retained-history recovery, standalone-client, and foreign-evidence semantics", () => {
    const observerGuide = read("docs/observer.md");
    const setupGuide = read("SETUP.md");
    const readme = read("README.md");

    expect(observerGuide).toContain(
      "classify (`history`), or safely reconcile (`recover`) exact-owned Windows runtime history",
    );
    expect(setupGuide).toContain('`observer_runtime` with `action: "history"`');
    expect(setupGuide).toContain('`action: "recover"` only for the returned exact child-exit');
    expect(setupGuide).toContain("Recovery never deletes history and never terminates a live");
    expect(readme).toContain(
      "Well-formed evidence attributed to another installation,\nWindows user, or MCP owner is excluded",
    );
    expect(readme).toContain(
      "malformed, legacy-unattributed, or uncertain lifecycle evidence",
    );

    expect(gameLaunchRawInputShape.runtimeKind.description).toContain(
      "standalone graphical -world launch",
    );
    expect(gameLaunchRawInputShape.runtimeKind.description).toContain(
      "never selects Reforger's engine -client replication mode",
    );
  });
});
