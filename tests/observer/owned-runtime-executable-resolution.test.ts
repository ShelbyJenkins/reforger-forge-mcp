import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeExecutable } from "../../src/observer/owned-runtime-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("owned runtime executable resolution", () => {
  it("selects the dedicated-server executable for a dedicated runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "reforger-forge-runtime-exe-"));
    roots.push(root);
    const graphical = join(root, "ArmaReforgerSteamDiag.exe");
    const dedicated = join(root, "ArmaReforgerServerDiag.exe");
    writeFileSync(graphical, "graphical fixture");
    writeFileSync(dedicated, "dedicated fixture");

    expect(resolveRuntimeExecutable(root, "dedicated")).toBe(dedicated);
    expect(resolveRuntimeExecutable(root, "listenServer")).toBe(graphical);
  });
});
