import { cpSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
import { withTemporaryDirectory } from "../support/temporary-directory.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("MCP-managed Workbench helper add-on", () => {
  it("verifies, stages, and reuses the fixed companion with a deterministic external profile", async () => {
    await withTemporaryDirectory((root) => {
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
    }, { prefix: "reforger-forge-helper-" });
  });

  it("fails closed when a staged payload is modified", async () => {
    await withTemporaryDirectory((root) => {
    const stager = new WorkbenchHelperStager({ managedRoot: join(root, "managed") });
    const staged = stager.ensureStaged();
    writeFileSync(join(staged.addonDirectory, "addon.gproj"), "modified", "utf8");

    expect(() => stager.ensureStaged()).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_STAGE_CONFLICT",
      })
    );
    }, { prefix: "reforger-forge-helper-" });
  });

  it("re-attests an existing descriptor and rejects post-stage mutation", async () => {
    await withTemporaryDirectory((root) => {
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
    }, { prefix: "reforger-forge-helper-" });
  });

  it("re-attests the packaged source digest and rejects source mutation after staging", async () => {
    await withTemporaryDirectory((root) => {
    const source = join(root, "source");
    cpSync(defaultWorkbenchHelperSource(), source, { recursive: true });
    const stager = new WorkbenchHelperStager({
      managedRoot: join(root, "managed"),
      sourceDirectory: source,
    });
    const staged = stager.ensureStaged();

    expect(stager.verifySourceDigest(staged.bundleDigest)).toBe(staged.bundleDigest);
    writeFileSync(join(source, "addon.gproj"), "modified", "utf8");
    expect(() => stager.verifySourceDigest(staged.bundleDigest)).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_SOURCE_INVALID",
      })
    );
    }, { prefix: "reforger-forge-helper-" });
  });

  it("allows Workbench's generated local files only in an existing staged bundle", async () => {
    await withTemporaryDirectory((root) => {
    const stager = new WorkbenchHelperStager({ managedRoot: join(root, "managed") });
    const staged = stager.ensureStaged();
    writeFileSync(join(staged.addonDirectory, "resourceDatabase.rdb"), "generated", "utf8");
    writeFileSync(join(staged.addonDirectory, "UserMaps.desc"), "generated", "utf8");

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
    }, { prefix: "reforger-forge-helper-" });
  });

  it("rejects a generated resource database in the canonical helper source", async () => {
    await withTemporaryDirectory((root) => {
    const source = join(root, "source");
    cpSync(defaultWorkbenchHelperSource(), source, { recursive: true });
    writeFileSync(join(source, "resourceDatabase.rdb"), "generated", "utf8");

    expect(() => verifyWorkbenchHelperSource(source)).toThrowError(
      expect.objectContaining<Partial<WorkbenchHelperStageError>>({
        code: "WORKBENCH_HELPER_SOURCE_INVALID",
      })
    );
    }, { prefix: "reforger-forge-helper-" });
  });

  it("rejects project overlap before creating a managed staging or profile root", async () => {
    await withTemporaryDirectory((root) => {
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
    }, { prefix: "reforger-forge-helper-" });
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

  it("keeps the generic save handler absent while packaging the target-bound save handler", () => {
    const source = defaultWorkbenchHelperSource();
    const manifest = verifyWorkbenchHelperSource(source).manifest;
    const payload = readFileSync(
      join(packageRoot, "src", "workbench", "helper-addon-payload.generated.ts"),
      "utf8"
    );

    expect(existsSync(join(
      source,
      "Scripts",
      "WorkbenchGame",
      "EnfusionMCP",
      "EMCP_WB_SaveResource.c"
    ))).toBe(false);
    expect(manifest.files.map((file) => file.path)).not.toContain(
      "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_SaveResource.c"
    );
    expect(payload).not.toContain("EMCP_WB_SaveResource.c");
    expect(manifest.files.map((file) => file.path)).toContain(
      "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ExplicitResourceSave.c"
    );
    expect(payload).toContain("EMCP_WB_ExplicitResourceSave.c");
    const explicitHandler = readFileSync(join(
      source,
      "Scripts",
      "WorkbenchGame",
      "EnfusionMCP",
      "EMCP_WB_ExplicitResourceSave.c"
    ), "utf8");
    expect(explicitHandler).toContain("exact owned process");
    expect(explicitHandler).toContain("resp.startupLoadPath = req.expectedPath");
    expect(explicitHandler).toContain("Resource metadata not found for the explicit target");
    expect(explicitHandler).toContain("worldEditor.Save()");
    expect(explicitHandler).not.toContain("GetContainer(");
  });

  it("validates material texture references without requiring packed dependencies to expose source metadata", () => {
    const handler = readFileSync(join(
      defaultWorkbenchHelperSource(),
      "Scripts",
      "WorkbenchGame",
      "EnfusionMCP",
      "EMCP_WB_ValidateResource.c"
    ), "utf8");

    expect(handler).toContain("CheckMaterialTextureReferences(material, validator, checks)");
    expect(handler).toContain("ResourceName resolved = Workbench.GetResourceName(guid)");
    expect(handler).toContain("validator.CheckSlots(slot, suffix, checks)");
    expect(handler).not.toContain("validator.CheckTextures(material, checks)");
    expect(handler).not.toContain("resourceManager.GetMetaFile(value.GetPath())");

    // Standalone texture import validation still requires registered source
    // metadata because it inspects the import configuration itself.
    expect(handler).toContain("Resource metadata not found for texture");
    expect(handler).toContain('metaFile.GetObjectArray("Configurations")');
  });

  it("expires old digest roots and orphaned profile captures without touching the current bundle", async () => {
    await withTemporaryDirectory((root) => {
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
    }, { prefix: "reforger-forge-helper-" });
  });
});
