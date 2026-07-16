import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_HANDLER_FILES } from "../../src/workbench/handler-bundle.js";

const handlerRoot = join(
  process.cwd(),
  "mod",
  "Scripts",
  "WorkbenchGame",
  "EnfusionMCP"
);

function source(name: string): string {
  return readFileSync(join(handlerRoot, name), "utf8");
}

describe("dedicated Workbench observer handler contract", () => {
  it("ships one shared transaction and five narrowly named NET API handlers", () => {
    const names = REQUIRED_HANDLER_FILES.filter((name) => name.includes("Observer"));
    expect(names).toEqual([
      "EMCP_WB_ObserverCancel.c",
      "EMCP_WB_ObserverCommon.c",
      "EMCP_WB_ObserverPing.c",
      "EMCP_WB_ObserverRelease.c",
      "EMCP_WB_ObserverStatus.c",
      "EMCP_WB_ObserverSubmit.c",
    ]);
    for (const operation of ["Ping", "Submit", "Status", "Release", "Cancel"]) {
      expect(source(`EMCP_WB_Observer${operation}.c`)).toContain(
        `class EMCP_WB_Observer${operation} : NetApiHandler`
      );
    }
    expect(source("EMCP_WB_ObserverCommon.c")).not.toContain(": NetApiHandler");
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
      '"RESTORATION_UNCONFIRMED"',
    ]) {
      expect(common).toContain(required);
    }
    expect(common.indexOf("m_Job = job;")).toBeLessThan(
      common.indexOf("world.SetCameraEx(job.originalWorldCameraId, job.requestedMatrix)")
    );
    expect(common).toContain("api.SetCamera(job.requestedMatrix[3], job.requestedMatrix[2])");
    expect(common).toContain("world.SetCameraVerticalFOV(job.originalWorldCameraId, fov)");
    expect(common).toContain("Math.AbsFloat(job.installedFov - fov) <= FOV_EPSILON");
    expect(common).toContain("job.actualFov = job.originalFov");
    expect(common).toContain("job.actualFov = job.installedFov");
    expect(common).toContain("Math.RAD2DEG");
    expect(common).toContain("job.renderedEvidenceCaptured");
    expect(common).not.toContain("cameraMatrix0 = job.requestedMatrix");
    expect(common.indexOf("if (!InstalledStateStillOwned(job))", common.indexOf("protected bool RestoreJob")))
      .toBeLessThan(common.indexOf("job.world.SetCameraEx(job.originalWorldCameraId, job.originalWorldMatrix)"));
    const restoreBody = common.slice(common.indexOf("protected bool RestoreJob"), common.indexOf("protected bool InstalledStateStillOwned"));
    expect(restoreBody.match(/job\.cameraLeaseHeld = false/g)).toHaveLength(2);
    expect(restoreBody).toMatch(/if \(exact\)\s+\{\s+job\.cameraLeaseHeld = false/);
    expect(common).not.toMatch(/CameraManager|CameraBase|originalOwner|GetGame\(\)\.GetWorld/);
    expect(common).toContain("api.GetScreenWidth() != job.viewportWidth");
    expect(common).toContain("float sampleScale = (height - 1) / (2.0 * height)");
    expect(common).toContain("ProjectViewportToWorld(centerX, centerY - sampleOffset");
    expect(common).toContain("Math.Atan2(Math.Tan(sampleRadians), sampleScale)");
    expect(common).toContain("Math.AbsFloat(topSampleRadians - bottomSampleRadians) * Math.RAD2DEG > FOV_SYMMETRY_EPSILON");
  });

  it("uses only the generated native profile PNG and never generic editor execution paths", () => {
    const observerSource = REQUIRED_HANDLER_FILES
      .filter((name) => name.includes("Observer"))
      .map(source)
      .join("\n");
    expect(observerSource).toContain('string screenshotRequestPath = CAPTURE_DIRECTORY + "/" + m_Job.jobId');
    expect(observerSource).toContain('m_Job.outputLogicalPath = screenshotRequestPath + ".png"');
    expect(observerSource).toContain("System.MakeScreenshot(screenshotRequestPath)");
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
    for (const field of ["jobId", "leaseId", "lifecycleGeneration", "canonicalTarget", "viewKind", "fovText"]) {
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
    expect(releaseBody).toContain("Release refused until cancellation/completion proves exact camera restoration");
  });
});
