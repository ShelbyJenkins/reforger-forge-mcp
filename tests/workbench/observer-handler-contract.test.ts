import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKBENCH_HELPER_HANDLER_FILES } from "../../src/workbench/helper-addon.js";
import { WORKBENCH_HELPER_PAYLOAD_FILES } from "../../src/workbench/helper-addon-payload.generated.js";

const handlerRoot = join(
  process.cwd(),
  "observer",
  "workbench-addon",
  "Scripts",
  "WorkbenchGame",
  "EnfusionMCP"
);

function source(name: string): string {
  return readFileSync(join(handlerRoot, name), "utf8");
}

describe("dedicated Workbench observer handler contract", () => {
  it("ships one shared transaction and five narrowly named NET API handlers", () => {
    const names = WORKBENCH_HELPER_HANDLER_FILES.filter((name) => name.includes("Observer"));
    expect(names).toEqual([
      "EMCP_WB_ObserverCancel.c",
      "EMCP_WB_ObserverPing.c",
      "EMCP_WB_ObserverRelease.c",
      "EMCP_WB_ObserverStatus.c",
      "EMCP_WB_ObserverSubmit.c",
    ]);
    for (const name of WORKBENCH_HELPER_HANDLER_FILES) {
      expect(source(name)).toMatch(/\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*NetApiHandler\b/);
    }
    for (const operation of ["Ping", "Submit", "Status", "Release", "Cancel"]) {
      expect(source(`EMCP_WB_Observer${operation}.c`)).toContain(
        `class EMCP_WB_Observer${operation} : NetApiHandler`
      );
    }
    expect(source("EMCP_WB_ObserverCommon.c")).not.toContain(": NetApiHandler");

    const protocolPayloadPath = "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_ObserverProtocol.c";
    expect(WORKBENCH_HELPER_PAYLOAD_FILES).toContain(protocolPayloadPath);
    expect(WORKBENCH_HELPER_HANDLER_FILES).not.toContain("EMCP_WB_ObserverProtocol.c");
    expect(source("EMCP_WB_ObserverProtocol.c")).not.toContain(": NetApiHandler");
  });

  it("snapshots and verifies the native editor transform, projection, camera slot, viewport, world, and project identity", () => {
    const common = source("EMCP_WB_ObserverCommon.c");
    for (const required of [
      "GetCurrentCameraId()",
      "GetCurrentCamera(job.originalWorldMatrix)",
      "GetCurrentCamera(m_Job.renderedWorldMatrix)",
      "MeasureVerticalFov(api, world, job.originalWorldCameraId, job.originalFov)",
      "ProjectViewportToWorld",
      "GetCameraFarPlane(job.originalWorldCameraId)",
      "GetScreenWidth()",
      "GetScreenHeight()",
      "Workbench.GetCurrentGameProjectFile()",
      "CurrentWorldIdentity()",
      "SetCameraEx(job.originalWorldCameraId, job.originalWorldMatrix)",
      "api.SetCamera(job.originalWorldMatrix[3], job.originalWorldMatrix[2])",
      "SetCameraVerticalFOV(job.originalWorldCameraId, job.originalFov)",
      "MatrixEquals(restoredWorld, job.originalWorldMatrix)",
      "EMCP_WB_ObserverProtocol.ERROR_RESTORATION_UNCONFIRMED",
    ]) {
      expect(common).toContain(required);
    }
    expect(common).toContain("return EMCP_WB_ObserverProtocol.ADAPTER_PROTOCOL;");
    expect(common.indexOf("m_Job = job;")).toBeLessThan(
      common.indexOf("world.SetCameraEx(job.originalWorldCameraId, job.requestedMatrix)")
    );
    expect(common).toContain("api.SetCamera(job.requestedMatrix[3], job.requestedMatrix[2])");
    expect(common).toContain("world.SetCameraVerticalFOV(job.originalWorldCameraId, fov)");
    expect(common).toContain("ScalarEquals(measuredInstalledFov, fov, FOV_EPSILON)");
    expect(common).toContain("job.actualFov = job.originalFov");
    expect(common).toContain("job.actualFov = measuredInstalledFov");
    expect(common).toContain("Math.RAD2DEG");
    expect(common).toContain("job.renderedEvidenceCaptured");
    expect(common).not.toContain("cameraMatrix0 = job.requestedMatrix");
    const restoreBody = common.slice(
      common.indexOf("protected bool RestoreJob"),
      common.indexOf("protected bool RelinquishJob")
    );
    expect(restoreBody.indexOf("int installedOwnership = InspectInstalledStateOwnership(job)"))
      .toBeLessThan(restoreBody.indexOf("job.world.SetCameraEx(job.originalWorldCameraId, job.originalWorldMatrix)"));
    expect(restoreBody).toMatch(/if \(exact\)\s+\{\s+job\.cameraLeaseHeld = false/);
    expect(restoreBody).toContain("the stale observer lease was relinquished without overwriting the newer editor camera state");
    expect(restoreBody).toContain("NormalizedPath(CurrentProjectFile()) != NormalizedPath(job.projectFile)");
    expect(restoreBody).toContain("CurrentWorldIdentity() != job.worldIdentity");
    expect(restoreBody).toContain("relinquished without mutating the newer context");
    expect(restoreBody.indexOf("CurrentWorldIdentity() != job.worldIdentity"))
      .toBeLessThan(restoreBody.indexOf("job.world.SetCameraEx(job.originalWorldCameraId, job.originalWorldMatrix)"));
    expect(restoreBody).not.toContain("GetScreenWidth()");
    expect(restoreBody).not.toContain("GetScreenHeight()");
    const installedOwnershipBody = common.slice(
      common.indexOf("protected int InspectInstalledStateOwnership"),
      common.indexOf("protected bool OriginalStateAlreadyPresent")
    );
    const originalStateBody = common.slice(
      common.indexOf("protected bool OriginalStateAlreadyPresent"),
      common.indexOf("protected bool MeasureVerticalFov")
    );
    expect(installedOwnershipBody).not.toContain("GetScreenWidth()");
    expect(installedOwnershipBody).not.toContain("GetScreenHeight()");
    expect(originalStateBody).not.toContain("GetScreenWidth()");
    expect(originalStateBody).not.toContain("GetScreenHeight()");
    expect(common).not.toMatch(/CameraManager|CameraBase|originalOwner|GetGame\(\)\.GetWorld/);
    expect(common).toContain("api.GetScreenWidth() != job.viewportWidth");
    expect(common).toContain("int centerPixelX = width / 2;");
    expect(common).toContain("int centerPixelY = height / 2;");
    expect(common).toContain("int samplePixelOffset = height / 4;");
    expect(common).toContain("float sampleScale = (2.0 * samplePixelOffset) / height;");
    expect(common).not.toContain("float centerY = height * 0.5;");
    expect(common).not.toContain("float sampleOffset = (height - 1) * 0.25;");
    expect(common).not.toContain("float sampleScale = (height - 1) / (2.0 * height);");
    expect(common).toContain("ProjectViewportToWorld(centerX, centerY - sampleOffset");
    expect(common).toContain("Math.Atan2(Math.Tan(sampleRadians), sampleScale)");
    expect(common).toContain("Math.AbsFloat(topSampleRadians - bottomSampleRadians) * Math.RAD2DEG > FOV_SYMMETRY_EPSILON");
  });

  it("distinguishes concrete camera displacement from an indeterminate projection measurement", () => {
    const common = source("EMCP_WB_ObserverCommon.c");
    const expectedFov = common.indexOf("job.installedFov = fov;");
    const firstProjectionMeasurement = common.indexOf(
      "MeasureVerticalFov(api, world, job.originalWorldCameraId, measuredInstalledFov)"
    );
    expect(expectedFov).toBeGreaterThan(-1);
    expect(expectedFov).toBeLessThan(firstProjectionMeasurement);
    for (const ownershipState of [
      "CAMERA_OWNERSHIP_INDETERMINATE",
      "CAMERA_OWNERSHIP_DISPLACED",
      "CAMERA_OWNERSHIP_OWNED",
    ]) {
      expect(common).toContain(ownershipState);
    }

    const restoreBody = common.slice(
      common.indexOf("protected bool RestoreJob"),
      common.indexOf("protected bool RelinquishJob")
    );
    expect(restoreBody).toMatch(
      /if \(installedOwnership == CAMERA_OWNERSHIP_INDETERMINATE\)\s+return false;/
    );
    expect(restoreBody).toMatch(
      /if \(installedOwnership == CAMERA_OWNERSHIP_DISPLACED\)[\s\S]*return RelinquishJob\(job,/
    );

    const ownershipBody = common.slice(
      common.indexOf("protected int InspectInstalledStateOwnership"),
      common.indexOf("protected bool OriginalStateAlreadyPresent")
    );
    const matrixComparison = ownershipBody.indexOf("MatrixEquals(actualWorld, job.installedWorldMatrix)");
    const farPlaneComparison = ownershipBody.indexOf("GetCameraFarPlane(job.originalWorldCameraId)");
    const projectionMeasurement = ownershipBody.indexOf(
      "MeasureVerticalFov(api, job.world, job.originalWorldCameraId, actualFov)"
    );
    expect(matrixComparison).toBeGreaterThan(-1);
    expect(farPlaneComparison).toBeGreaterThan(-1);
    expect(matrixComparison).toBeLessThan(projectionMeasurement);
    expect(farPlaneComparison).toBeLessThan(projectionMeasurement);
    expect(ownershipBody).toMatch(
      /if \(!MeasureVerticalFov\(api, job\.world, job\.originalWorldCameraId, actualFov\)\)[\s\S]*?return CAMERA_OWNERSHIP_INDETERMINATE;/
    );
    expect(ownershipBody).toMatch(
      /if \(!MatrixEquals\(actualWorld, job\.installedWorldMatrix\)\)[\s\S]*?return CAMERA_OWNERSHIP_DISPLACED;/
    );
  });

  it("revokes camera.editor proof when a rejected pose cannot restore exactly", () => {
    const common = source("EMCP_WB_ObserverCommon.c");
    const rejectedInstallBody = common.slice(
      common.indexOf("if (!requestedInstalled)"),
      common.indexOf("job.actualFov = measuredInstalledFov")
    );
    const restoreAttempt = rejectedInstallBody.indexOf("restoredAfterRejectedInstall = RestoreJob(job)");
    const proofUpdate = rejectedInstallBody.indexOf("m_RestorationProven = restoredAfterRejectedInstall");
    expect(restoreAttempt).toBeGreaterThan(-1);
    expect(restoreAttempt).toBeLessThan(proofUpdate);
    expect(common).toContain('if (viewKind != "current" && !m_RestorationProven)');
    expect(common).toContain("camera.editor is fail-closed until this Workbench process completes an exact current-view restoration proof");
  });

  it("rolls back only attributable synchronous partial pose installation", () => {
    const common = source("EMCP_WB_ObserverCommon.c");
    const rejectedInstallBody = common.slice(
      common.indexOf("if (!requestedInstalled)"),
      common.indexOf("job.actualFov = measuredInstalledFov")
    );
    expect(rejectedInstallBody.indexOf("ImmediateRejectedInstallCanRollback"))
      .toBeLessThan(rejectedInstallBody.indexOf("restoredAfterRejectedInstall = RestoreJob(job)"));
    expect(rejectedInstallBody).toContain("ApplyAndVerifyOriginalState(job, api");

    const immediateRollbackBody = common.slice(
      common.indexOf("protected bool ImmediateRejectedInstallCanRollback"),
      common.indexOf("protected int InspectRejectedInstallRollbackOwnership")
    );
    for (const requiredGuard of [
      "api.GetWorld() != job.world",
      "NormalizedPath(CurrentProjectFile()) != NormalizedPath(job.projectFile)",
      "CurrentWorldIdentity() != job.worldIdentity",
      "job.world.GetCurrentCameraId() != job.originalWorldCameraId",
      "ScalarEquals(job.world.GetCameraFarPlane(job.originalWorldCameraId), job.originalFarPlane",
      "CameraMatrixFinite(actualWorld)",
    ]) {
      expect(immediateRollbackBody).toContain(requiredGuard);
    }
    expect(immediateRollbackBody).not.toContain("MatrixEquals(actualWorld, job.requestedMatrix)");
    expect(immediateRollbackBody).not.toContain("MeasureVerticalFov");

    const retainedRollbackBody = common.slice(
      common.indexOf("protected int InspectRejectedInstallRollbackOwnership"),
      common.indexOf("protected bool ApplyAndVerifyOriginalState")
    );
    for (const requiredGuard of [
      "MatrixEquals(actualWorld, job.originalWorldMatrix)",
      "MatrixEquals(actualWorld, job.requestedMatrix)",
      "ScalarEquals(measuredFov, job.originalFov",
      "ScalarEquals(measuredFov, job.requestedFov",
      "return CAMERA_OWNERSHIP_INDETERMINATE",
    ]) {
      expect(retainedRollbackBody).toContain(requiredGuard);
    }

    const restoreBody = common.slice(
      common.indexOf("protected bool RestoreJob"),
      common.indexOf("protected bool ImmediateRejectedInstallCanRollback")
    );
    expect(restoreBody.indexOf("if (job.installationRollbackPending)"))
      .toBeLessThan(restoreBody.indexOf("if (OriginalStateAlreadyPresent(job))"));
    expect(restoreBody).toContain("InspectRejectedInstallRollbackOwnership(job, api)");

    const applyBody = common.slice(
      common.indexOf("protected bool ApplyAndVerifyOriginalState"),
      common.indexOf("protected bool RelinquishJob")
    );
    expect(applyBody.indexOf("api.SetCamera(job.originalWorldMatrix[3], job.originalWorldMatrix[2])"))
      .toBeLessThan(applyBody.indexOf("job.world.SetCameraEx(job.originalWorldCameraId, job.originalWorldMatrix)"));
    expect(applyBody).toContain("job.world.SetCameraVerticalFOV(job.originalWorldCameraId, job.originalFov)");
    expect(applyBody).toContain("job.restorationConfirmed = exact");
    expect(applyBody).toContain("job.installationRollbackPending = false");

    const normalOwnershipBody = common.slice(
      common.indexOf("protected int InspectInstalledStateOwnership"),
      common.indexOf("protected bool OriginalStateAlreadyPresent")
    );
    expect(normalOwnershipBody).not.toContain("job.requestedMatrix");
    expect(normalOwnershipBody).not.toContain("job.originalWorldMatrix");
    expect(normalOwnershipBody).toContain("job.installedWorldMatrix");
    expect(normalOwnershipBody).toContain("job.installedFov");
  });

  it("rejects nonfinite native camera values before equality or restoration proof", () => {
    const common = source("EMCP_WB_ObserverCommon.c");
    const matrixEqualsBody = common.slice(
      common.indexOf("protected bool MatrixEquals"),
      common.indexOf("protected bool CameraMatrixFinite")
    );
    const finiteBody = common.slice(
      common.indexOf("protected bool ScalarFinite"),
      common.indexOf("protected bool ScalarEquals")
    );
    const scalarEqualsBody = common.slice(
      common.indexOf("protected bool ScalarEquals"),
      common.indexOf("protected bool Identifier")
    );
    expect(matrixEqualsBody).toContain("ScalarEquals(left[row][column], right[row][column], MATRIX_EPSILON)");
    expect(finiteBody).toContain("value == value");
    expect(finiteBody).toContain("Math.AbsFloat(value) <= 1000000000");
    expect(scalarEqualsBody).toContain("!ScalarFinite(left) || !ScalarFinite(right)");
    expect(common).not.toMatch(/Math\.AbsFloat\(job\.world\.GetCameraFarPlane/);
    expect(common).not.toMatch(/Math\.AbsFloat\(world\.GetCameraFarPlane/);
  });

  it("uses only the generated native profile PNG and never generic editor execution paths", () => {
    const observerSource = [
      ...WORKBENCH_HELPER_HANDLER_FILES.filter((name) => name.includes("Observer")).map(source),
      source("EMCP_WB_ObserverCommon.c"),
    ]
      .join("\n");
    expect(observerSource).toContain('m_Job.outputLogicalPath = CAPTURE_DIRECTORY + "/" + m_Job.jobId + ".png"');
    expect(observerSource).toContain("System.GetRenderingResolution(m_Job.sourceWidth, m_Job.sourceHeight)");
    expect(observerSource).toContain("System.MakeScreenshotRawData(OnScreenshot");
    expect(observerSource).toContain("Workbench.SavePixelRawData(m_Job.outputLogicalPath");
    expect(observerSource).toContain("m_ScreenshotCallbackPending");
    expect(observerSource).not.toContain("System.MakeScreenshot(");
    expect(observerSource).not.toMatch(/ExecuteAction|SwitchToGameMode|SetOpenedResource|Save\(|RunCmd|RunProcess|Reload/);
  });

  it("cross-binds every state-changing request to generation, target, job, and handler lease", () => {
    for (const operation of ["Status", "Release", "Cancel"]) {
      const handler = source(`EMCP_WB_Observer${operation}.c`);
      for (const field of ["jobId", "leaseId", "lifecycleGeneration", "canonicalTarget"]) {
        expect(handler).toContain(`RegV("${field}")`);
      }
    }
    const submit = source("EMCP_WB_ObserverSubmit.c");
    for (const field of ["jobId", "leaseId", "lifecycleGeneration", "canonicalTarget", "viewKind", "fovText", "maxWidth", "maxHeight"]) {
      expect(submit).toContain(`RegV("${field}")`);
    }
    const common = source("EMCP_WB_ObserverCommon.c");
    expect(common).toContain("Submit is an acknowledged, idempotent delivery boundary");
    expect(common).toContain("GetCurrentGameProjectFile reports the base game settings project");
    expect(common).toContain('canonicalTarget.EndsWith(".gproj")');
    expect(common).toContain("m_Job.leaseId == requestedLeaseId");
    expect(common).toContain("ReleaseReceiptMatches(jobId, leaseId, lifecycleGeneration, canonicalTarget)");
    const releaseBody = common.slice(common.indexOf("bool Release("), common.indexOf("protected bool Matches("));
    expect(releaseBody).not.toContain("RestoreJob(");
    expect(releaseBody).toContain("if (!m_Job.IsTerminal() || m_Job.cameraLeaseHeld)");
    expect(releaseBody).not.toContain("m_Job.cameraLeaseHeld || !m_Job.restorationConfirmed");
    expect(releaseBody).toContain("released after the stale camera lease was relinquished");
  });
});
