import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeOwnedRuntimeExecutableEvidenceDigest,
  resolveRuntimeExecutableEvidenceFromSource,
  resolveRuntimeExecutable,
} from "../../src/observer/owned-runtime-manager.js";
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

  it("returns frozen executable content and file-identity evidence from the start boundary", () => {
    const harness = makeHarness();
    const evidence = harness.manager.resolveRuntimeExecutableEvidence("listenServer");

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      runtimeKind: "listenServer",
      executablePath: harness.executable,
      executableFile: {
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        size: expect.stringMatching(/^\d+$/),
        device: expect.stringMatching(/^\d+$/),
        inode: expect.stringMatching(/^\d+$/),
      },
      executableEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.executableFile)).toBe(true);
    expect(computeOwnedRuntimeExecutableEvidenceDigest(evidence))
      .toBe(evidence.executableEvidenceDigest);

    writeFileSync(harness.executable, "replacement fixture executable");
    expect(harness.manager.resolveRuntimeExecutableEvidence("listenServer").executableEvidenceDigest)
      .not.toBe(evidence.executableEvidenceDigest);
  });

  it("refuses planning attestation above its executable byte ceiling", () => {
    const harness = makeHarness();
    expect(() => resolveRuntimeExecutableEvidenceFromSource({
      kind: "executablePath",
      executablePath: harness.executable,
    }, "listenServer", 1)).toThrowError(expect.objectContaining({
      name: "GameLaunchPlanError",
      code: "EXECUTABLE_OVERSIZE",
    }));
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

  it("adapts executable-evidence failures to the trusted owned-runtime boundary", () => {
    const harness = makeHarness();
    harness.setExecutable(join(harness.root, "missing.exe"));

    expect(() => harness.manager.resolveRuntimeExecutableEvidence("listenServer"))
      .toThrowError(expect.objectContaining({
        name: "OwnedRuntimeError",
        code: "IDENTITY_UNVERIFIABLE",
      }));
  });
});
