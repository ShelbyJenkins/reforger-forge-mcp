import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WorkbenchHelperStageError,
  WorkbenchHelperStager,
  computeWorkbenchHelperBundleDigest,
  defaultWorkbenchHelperSource,
  verifyWorkbenchHelperSource,
} from "../../src/workbench/helper-addon.js";

const roots: string[] = [];

function temporaryDirectory(prefix = "reforger-forge-helper-"): string {
  const root = join(tmpdir(), `${prefix}${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP-managed Workbench helper add-on", () => {
  it("verifies, stages, and reuses the fixed companion with a deterministic external profile", () => {
    const root = temporaryDirectory();
    const managedRoot = join(root, "managed");
    const stager = new WorkbenchHelperStager({ managedRoot });

    const first = stager.ensureStaged();
    const second = stager.ensureStaged();

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second).toMatchObject({
      addonId: WORKBENCH_HELPER_ADDON_ID,
      addonGuid: WORKBENCH_HELPER_ADDON_GUID,
      buildIdentity: WORKBENCH_HELPER_BUILD_IDENTITY,
      bundleDigest: verifyWorkbenchHelperSource(defaultWorkbenchHelperSource()).manifest.bundleDigest,
      workbenchProfilePath: join(managedRoot, "workbench-helper", "profile"),
    });
    expect(second.addonDirectory).toBe(first.addonDirectory);
    expect(second.addonSearchRoot).toBe(first.addonSearchRoot);
    expect(second.addonDirectory.startsWith(managedRoot)).toBe(true);
  });

  it("fails closed when a staged payload is modified", () => {
    const root = temporaryDirectory();
    const stager = new WorkbenchHelperStager({ managedRoot: join(root, "managed") });
    const staged = stager.ensureStaged();
    writeFileSync(join(staged.addonDirectory, "addon.gproj"), "modified", "utf8");

    expect(() => stager.ensureStaged()).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_STAGE_CONFLICT",
      })
    );
  });

  it("re-attests an existing descriptor and rejects post-stage mutation", () => {
    const root = temporaryDirectory();
    const stager = new WorkbenchHelperStager({ managedRoot: join(root, "managed") });
    const staged = stager.ensureStaged();

    expect(stager.verifyStaged(staged)).toMatchObject({
      addonDirectory: staged.addonDirectory,
      bundleDigest: staged.bundleDigest,
      reused: true,
    });
    writeFileSync(join(staged.addonDirectory, "addon.gproj"), "modified", "utf8");
    expect(() => stager.verifyStaged(staged)).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_STAGE_CONFLICT",
      })
    );
  });

  it("allows Workbench's generated resource database only in an existing staged bundle", () => {
    const root = temporaryDirectory();
    const stager = new WorkbenchHelperStager({ managedRoot: join(root, "managed") });
    const staged = stager.ensureStaged();
    writeFileSync(join(staged.addonDirectory, "resourceDatabase.rdb"), "generated", "utf8");

    expect(stager.verifyStaged(staged)).toMatchObject({
      addonDirectory: staged.addonDirectory,
      bundleDigest: staged.bundleDigest,
      reused: true,
    });
    expect(stager.ensureStaged()).toMatchObject({
      addonDirectory: staged.addonDirectory,
      bundleDigest: staged.bundleDigest,
      reused: true,
    });

    writeFileSync(join(staged.addonDirectory, "unexpected.txt"), "unexpected", "utf8");
    expect(() => stager.verifyStaged(staged)).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_STAGE_CONFLICT",
      })
    );
  });

  it("rejects a generated resource database in the canonical helper source", () => {
    const root = temporaryDirectory();
    const source = join(root, "source");
    cpSync(defaultWorkbenchHelperSource(), source, { recursive: true });
    writeFileSync(join(source, "resourceDatabase.rdb"), "generated", "utf8");

    expect(() => verifyWorkbenchHelperSource(source)).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_SOURCE_INVALID",
      })
    );
  });

  it("rejects project overlap before creating a managed staging or profile root", () => {
    const root = temporaryDirectory();
    const project = join(root, "ExampleMod");
    const gproj = join(project, "ExampleMod.gproj");
    const managedRoot = join(project, ".managed-helper");
    mkdirSync(project, { recursive: true });
    writeFileSync(gproj, "GameProject {}\n", "utf8");

    const stager = new WorkbenchHelperStager({ managedRoot });
    expect(() => stager.ensureStaged(gproj)).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_PATH_UNSAFE",
      })
    );
    expect(existsSync(managedRoot)).toBe(false);
  });

  it("keeps the generated compiled identity synchronized with the manifest", () => {
    const source = defaultWorkbenchHelperSource();
    const manifest = verifyWorkbenchHelperSource(source).manifest;
    const build = readFileSync(
      join(source, "Scripts", "WorkbenchGame", "EnfusionMCP", "RFWB_HelperBuild.c"),
      "utf8"
    );
    expect(build).toContain(`ADDON_ID = "${manifest.addonId}"`);
    expect(build).toContain(`ADDON_GUID = "${manifest.addonGuid}"`);
    expect(build).toContain(`ADDON_VERSION = "${manifest.addonVersion}"`);
    expect(build).toContain(`PROTOCOL_VERSION = "${manifest.protocolVersion}"`);
    expect(build).toContain(`IDENTITY = "${manifest.buildIdentity}"`);
    expect(manifest.buildIdentity).toBe(computeWorkbenchHelperBundleDigest(
      manifest.files.filter((file) =>
        file.path !== "Scripts/WorkbenchGame/EnfusionMCP/RFWB_HelperBuild.c")
    ));
  });

  it("expires old digest roots and orphaned profile captures without touching the current bundle", () => {
    const root = temporaryDirectory();
    const stager = new WorkbenchHelperStager({ managedRoot: join(root, "managed") });
    const staged = stager.ensureStaged();
    const roleRoot = join(root, "managed", "workbench-helper");
    const oldDigest = "b".repeat(64);
    const oldRoot = join(roleRoot, "addons", oldDigest);
    const captureRoot = join(roleRoot, "profile", "profile", "ReforgerForgeObserver", "workbench");
    const capture = join(captureRoot, "orphan.png");
    mkdirSync(oldRoot, { recursive: true });
    mkdirSync(captureRoot, { recursive: true });
    writeFileSync(join(oldRoot, "old.txt"), "old", "utf8");
    writeFileSync(capture, "png", "utf8");
    const old = new Date(0);
    utimesSync(join(oldRoot, "old.txt"), old, old);
    utimesSync(oldRoot, old, old);
    utimesSync(capture, old, old);

    const retained = stager.applyRetention({ maxAgeMs: 1, nowMs: Date.now() });

    expect(retained.removedDigestRoots).toContain(oldRoot);
    expect(retained.removedCaptureFiles).toContain(capture);
    expect(existsSync(staged.addonDirectory)).toBe(true);
    expect(stager.status()).toMatchObject({
      installed: true,
      stagedDigests: [staged.bundleDigest],
      staleCaptureCount: 0,
    });
    expect(stager.uninstall()).toMatchObject({ removed: true });
    expect(existsSync(roleRoot)).toBe(false);
  });
});
