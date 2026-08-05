import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeExecutable } from "../../src/observer/owned-runtime-manager.js";
import {
  cleanupOwnedRuntimeManagerFixtures,
  makeHarness,
} from "./owned-runtime-manager-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupOwnedRuntimeManagerFixtures();
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

  it("routes the injected resolver through the manager's canonical regular-file boundary", () => {
    const harness = makeHarness();

    expect(harness.manager.resolveRuntimeExecutablePath("client")).toBe(harness.executable);
    expect(harness.manager.resolveRuntimeExecutablePath("listenServer")).toBe(harness.executable);
    expect(harness.resolvedRuntimeKinds).toEqual(["client", "listenServer"]);

    harness.setExecutable(join(harness.root, ".", "ArmaReforgerSteamDiag.exe"));
    expect(harness.manager.resolveRuntimeExecutablePath("testRunner")).toBe(harness.executable);
  });

  it("rejects missing paths, directories, and a linked final executable", () => {
    const harness = makeHarness();
    harness.setExecutable(join(harness.root, "missing.exe"));
    expect(() => harness.manager.resolveRuntimeExecutablePath("client"))
      .toThrowError(expect.objectContaining({ code: "IDENTITY_UNVERIFIABLE" }));

    const directory = join(harness.root, "directory.exe");
    mkdirSync(directory);
    harness.setExecutable(directory);
    expect(() => harness.manager.resolveRuntimeExecutablePath("listenServer"))
      .toThrowError(expect.objectContaining({ code: "IDENTITY_UNVERIFIABLE" }));

    const linked = join(harness.root, "linked.exe");
    symlinkSync(harness.executable, linked, "file");
    harness.setExecutable(linked);
    expect(() => harness.manager.resolveRuntimeExecutablePath("dedicated"))
      .toThrowError(expect.objectContaining({ code: "IDENTITY_UNVERIFIABLE" }));
  });
});
