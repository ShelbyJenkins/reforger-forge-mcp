import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_HANDLER_FILES,
  verifyWorkbenchHelperSource,
} from "../../src/workbench/helper-addon.js";
import { verifySourceBundle } from "../../observer/agent/staging.js";
import { observerAddonSource, repositoryRoot } from "./helpers.js";

function filesRecursively(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

describe("observer package and source contracts", () => {
  it("keeps observer and MCP builds separate and publishes required runtime assets", () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
    const gitAttributes = readFileSync(join(repositoryRoot, ".gitattributes"), "utf8");
    expect(gitAttributes.split(/\r?\n/)).toContain("observer/addon/** -text");
    expect(gitAttributes.split(/\r?\n/)).toContain("observer/workbench-addon/** -text");
    expect(packageJson.scripts.build).toContain("build:mcp");
    expect(packageJson.scripts.build).toContain("build:observer");
    expect(packageJson.scripts["addons:manifest"]).toContain("update-observer-source-manifest.mjs");
    expect(packageJson.scripts["observer:manifest"]).toContain("addons:manifest");
    expect(Object.keys(packageJson.scripts).filter((name) =>
      name.startsWith("observer:acceptance:")
    )).toEqual(["observer:acceptance:workbench", "observer:acceptance:runtime"]);
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "dist",
      "observer/addon",
      "observer/workbench-addon",
      "observer/protocol",
      "observer/README.md",
    ]));
    expect(packageJson.files).not.toContain("mod");
    const observerReleaseScripts = [
      "scripts/observer-live-acceptance-support.ts",
      "scripts/run-runtime-observer-acceptance.ts",
      "scripts/run-workbench-observer-acceptance.ts",
      "scripts/update-observer-source-manifest.mjs",
    ];
    expect(packageJson.files).toEqual(expect.arrayContaining(observerReleaseScripts));
    const observerConfig = JSON.parse(readFileSync(join(repositoryRoot, "observer", "tsconfig.build.json"), "utf8"));
    expect(observerConfig.compilerOptions.outDir).toBe("../dist/observer");
    expect(JSON.parse(readFileSync(join(repositoryRoot, "tsconfig.build.json"), "utf8")).include).toEqual(["src/**/*"]);
    expect(existsSync(join(repositoryRoot, "observer", "protocol", "VERSION"))).toBe(true);
    const packageCheck = readFileSync(join(repositoryRoot, "scripts", "check-package.mjs"), "utf8");
    expect(packageCheck).toContain("dist/observer/agent/private-child.js");
    expect(packageCheck).toContain("dist/workbench/observer-adapter.js");
    expect(packageCheck).toContain("dist/workbench/helper-addon.js");
    expect(packageCheck).toContain("legacy project-injection handler must not be packaged");
    for (const path of observerReleaseScripts) expect(packageCheck).toContain(path);
    const manifestGenerator = readFileSync(
      join(repositoryRoot, "scripts", "update-observer-source-manifest.mjs"),
      "utf8"
    );
    expect(manifestGenerator).toContain(".reforger-forge-observer-source.json");
    expect(manifestGenerator).toContain(".reforger-forge-workbench-helper-source.json");
    expect(manifestGenerator).toContain("RFWB_HelperBuild.c");
    expect(verifySourceBundle(observerAddonSource).manifest.files.length).toBeGreaterThan(10);
  });

  it("preserves the exact Workbench handler inventory", () => {
    expect(WORKBENCH_HELPER_HANDLER_FILES).toHaveLength(26);
    expect(WORKBENCH_HELPER_HANDLER_FILES.filter((name) => /Observer/.test(name)).sort()).toEqual([
      "EMCP_WB_ObserverCancel.c",
      "EMCP_WB_ObserverCommon.c",
      "EMCP_WB_ObserverPing.c",
      "EMCP_WB_ObserverRelease.c",
      "EMCP_WB_ObserverStatus.c",
      "EMCP_WB_ObserverSubmit.c",
    ]);
    const helperSource = join(repositoryRoot, "observer", "workbench-addon");
    const handlerRoot = join(helperSource, "Scripts", "WorkbenchGame", "EnfusionMCP");
    const handlerFiles = readdirSync(handlerRoot)
      .filter((name) => name.startsWith("EMCP_WB_") && name.endsWith(".c"))
      .sort();
    expect(handlerFiles).toEqual([...WORKBENCH_HELPER_HANDLER_FILES].sort());
    const observerHandlers = handlerFiles.filter((name) => /Observer/.test(name))
      .map((name) => readFileSync(join(handlerRoot, name), "utf8"))
      .join("\n");
    expect(observerHandlers).not.toContain("?");
    expect(observerHandlers).not.toMatch(/ParseVector\([^\n]*matrix\[/);

    const helper = verifyWorkbenchHelperSource(helperSource).manifest;
    expect(helper.role).toBe("workbench-helper");
    expect(helper.addonId).toBe(WORKBENCH_HELPER_ADDON_ID);
    expect(helper.addonGuid).toBe(WORKBENCH_HELPER_ADDON_GUID);
    expect(helper.buildIdentity).toBe(WORKBENCH_HELPER_BUILD_IDENTITY);
    expect(helper.files.map((entry) => entry.path)).toHaveLength(28);
    expect(helper.files.some((entry) => entry.path.startsWith("Scripts/Game/"))).toBe(false);

    const ping = readFileSync(join(handlerRoot, "EMCP_WB_Ping.c"), "utf8");
    for (const field of [
      "helperAddonId",
      "helperAddonGuid",
      "helperAddonVersion",
      "helperProtocolVersion",
      "workbenchProtocol",
      "helperBuildIdentity",
    ]) expect(ping).toContain(field);
  });

  it("packages and centrally registers the completed Phase H integration", () => {
    const observerSource = join(repositoryRoot, "src", "observer");
    for (const name of ["coordinator.ts", "setup.ts", "launch.ts", "tools.ts"]) {
      expect(existsSync(join(observerSource, name))).toBe(true);
    }
    expect(existsSync(join(repositoryRoot, "observer", "agent", "private-child.ts"))).toBe(true);
    const server = readFileSync(join(repositoryRoot, "src", "server.ts"), "utf8");
    expect(server.match(/new ObserverCoordinator\(/g)).toHaveLength(1);
    expect(server.match(/registerObserverTools\(/g)).toHaveLength(1);
    const integrationSource = filesRecursively(observerSource)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(integrationSource).not.toMatch(/WorkbenchProcessGuard|wb_launch|wb_restart|wb_shutdown|wb_cleanup/);
  });

  it("enforces dormant, headless, restoration, and no-Workbench implementation source invariants", () => {
    const addonFiles = filesRecursively(observerAddonSource);
    const source = addonFiles.filter((path) => path.endsWith(".c")).map((path) => readFileSync(path, "utf8")).join("\n");
    const bootstrap = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverBootstrap.c"), "utf8");
    const capabilities = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCapabilities.c"), "utf8");
    expect(bootstrap).toContain("super.OnAfterInit(world)");
    expect(bootstrap).toContain("super.OnGameStart()");
    expect(bootstrap).toContain("super.OnUpdate(world, timeslice)");
    expect(bootstrap).toContain("super.OnGameEnd()");
    expect(capabilities).toContain("System.IsConsoleApp()");
    expect(capabilities).toContain("RENDER_CAPTURE_PROVEN = true");
    expect(capabilities).toContain("CAMERA_RESTORE_PROVEN = true");
    expect(source).toContain("RestoreBeforeTerminal");
    const service = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverService.c"), "utf8");
    expect(service).toContain('m_RFO_InstanceId = "runtime-" + m_RFO_Session.sessionId');
    expect(service).toContain("m_RFO_InstanceNonce = m_RFO_Session.launchNonce");
    expect(service).not.toMatch(/m_RFO_InstanceNonce\s*=\s*string\.Format/);
    const cameraLease = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCameraLease.c"), "utf8");
    expect(cameraLease).not.toMatch(/!\s*[^\n]*SetCamera\(/);
    expect(cameraLease).toContain("CurrentCamera() != m_RFO_OriginalCamera");
    expect(cameraLease).toContain("game.SpawnEntity(RFO_ObserverCamera, world, spawnParams)");
    expect(cameraLease).toContain("CommitPostFrame");
    expect(cameraLease).toContain("CommitRestorationPostFrame");
    expect(cameraLease).toContain("CameraRegistered(manager, original)");
    expect(cameraLease).toContain("m_RFO_UsesDetachedPlayerCamera = detachedPlayerCamera");
    expect(cameraLease).toContain("MaintainRequestedView");
    expect(cameraLease).toContain("AwaitingFirstPostFrameCommit");
    expect(cameraLease).toContain("RestoreDetachedPlayerCamera");
    expect(cameraLease).not.toContain("GetCameraNearPlane");
    expect(cameraLease).not.toContain("AcquireWorldCamera");
    expect(cameraLease).toContain("FindPlayerCamera()");
    expect(cameraLease).toContain("camera.SetVerticalFOV(fovDegrees)");
    expect(cameraLease).toContain("camera.ApplyTransform(timeSlice)");
    expect(cameraLease).toContain("PublishedCameraMatches");
    expect(cameraLease).toContain("RFO_ObserverCameraProjection.SnapshotCurrent(m_RFO_World");
    expect(cameraLease).not.toContain("SpawnEntityPrefabLocal");
    expect(cameraLease).not.toContain("SpawnEntityPrefab");
    const observerCamera = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCamera.c"), "utf8");
    expect(observerCamera).toContain("void RFO_ObserverCamera(IEntitySource src, IEntity parent)");
    expect(observerCamera).toContain("class RFO_ObserverCamera : CameraBase");
    expect(observerCamera).toContain("EntityEvent.INIT | EntityEvent.POSTFRAME");
    expect(observerCamera).toContain("OnObserverCameraPostFrame(this, owner.GetWorld(), timeSlice)");
    const cameraProjection = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCameraProjection.c"), "utf8");
    expect(cameraProjection).toContain("System.GetRenderingResolution");
    expect(cameraProjection).toContain("ProjectViewportToWorld");
    expect(cameraProjection).toContain("MeasureVerticalFov");
    const capture = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCapture.c"), "utf8");
    expect(capture).toContain("System.MakeScreenshot(ScreenshotRequestPath(job.jobId))");
    expect(capture).toContain("bool IssueCommitted(");
    expect(capture).toContain("RFO_ObserverCameraProjection.SnapshotCurrent(world, cameraId, actualMatrix, actualFov)");
    expect(capture).toContain('return CAPTURE_DIRECTORY + "/" + jobId + ".bmp"');
    expect(capture).toContain('return CAPTURE_DIRECTORY + "/" + jobId;');
    expect(capture).toContain("GetLastIssueDiagnostic");
    expect(capture).toContain("GetLastPreloadDiagnostic");
    expect(capture).toContain("game.BeginPreload(world, matrix[3], radius)");
    expect(capture).toContain("game.IsPreloadFinished()");
    expect(capture).toContain("MINIMUM_RENDER_READY_MS = 3000");
    expect(capture).toContain("MAX_PRELOAD_RADIUS = 10000.0");
    expect(capture).toContain("System.GetTickCount(m_RFO_RenderReadySinceTick)");
    expect(service).toContain("m_RFO_Capture.GetLastIssueDiagnostic()");
    expect(service).toContain("void OnObserverCameraPostFrame(");
    expect(service).toContain("m_RFO_CameraLease.CommitPostFrame(");
    expect(service).toContain("m_RFO_Capture.IssueCommitted(");
    expect(service).toContain("m_RFO_PostFrameCaptureArmed = true");
    expect(service).toContain("RFO_ObserverJobState.PRELOADING");
    expect(service).not.toContain("m_RFO_Capture.IsReady() && m_RFO_Capture.RuntimeReady()");
    const job = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverJob.c"), "utf8");
    expect(job).toContain("class RFO_ObserverCommandWireView");
    expect(job).toContain("view != null && DecodeWireView()");
    expect(source).not.toMatch(/EnfusionMCP|targetProject|outputPath|https:\/\//);
    const workbench = join(observerAddonSource, "Scripts", "WorkbenchGame");
    expect(filesRecursively(workbench).filter((path) => path.endsWith(".c"))).toEqual([]);
  });
});
