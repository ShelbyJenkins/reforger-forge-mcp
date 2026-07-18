import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observerAddonSource } from "./helpers.js";

const runtimeSource = (...parts: string[]) => readFileSync(join(
  observerAddonSource,
  "Scripts",
  "Game",
  "ReforgerForgeObserver",
  ...parts
), "utf8");

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source boundary: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source boundary: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("runtime observer camera restoration contract", () => {
  it("proves CameraBase restoration in POSTFRAME and defers observer destruction", () => {
    const lease = runtimeSource("RFO_ObserverCameraLease.c");
    const restore = between(
      lease,
      "bool Restore(string jobId",
      "bool CommitRestorationPostFrame("
    );
    const postFrame = between(
      lease,
      "bool CommitRestorationPostFrame(",
      "bool IsHeld()"
    );

    expect(restore).toContain("m_RFO_RestorationPostFrameConfirmed");
    expect(restore).toContain("RestorationCleanupBindingStillCurrent(world, currentWorldEpoch)");
    expect(restore).toContain("DestroyObserverCamera(m_RFO_ObserverCamera)");
    expect(restore).toContain("Clear(true)");
    expect(restore).not.toContain("m_RFO_ObserverCamera.Disarm()");
    expect(restore.indexOf("RestorationCleanupBindingStillCurrent(world, currentWorldEpoch)"))
      .toBeLessThan(restore.indexOf("DestroyObserverCamera(m_RFO_ObserverCamera)"));

    expect(postFrame).toContain("m_RFO_Restoring");
    expect(postFrame).toContain("m_RFO_RestoreTargetSelected");
    expect(postFrame).toContain("ApplyOriginalState(m_RFO_OriginalCamera)");
    expect(postFrame).toContain("m_RFO_OriginalCamera.ApplyTransform(timeSlice)");
    expect(postFrame).toContain("PublishedCameraMatches(m_RFO_OriginalCamera");
    expect(postFrame).toContain("m_RFO_RestorationPostFrameConfirmed = true");
    expect(postFrame).toContain("m_RFO_ObserverCamera.Disarm()");
    expect(postFrame).not.toContain("DestroyObserverCamera(");
    expect(postFrame).not.toContain("Clear(");
    expect(postFrame.indexOf("ApplyOriginalState(m_RFO_OriginalCamera)"))
      .toBeLessThan(postFrame.indexOf("m_RFO_OriginalCamera.ApplyTransform(timeSlice)"));
    expect(postFrame.indexOf("m_RFO_OriginalCamera.ApplyTransform(timeSlice)"))
      .toBeLessThan(postFrame.indexOf("PublishedCameraMatches(m_RFO_OriginalCamera"));
  });

  it("routes restoring callbacks before capture commits and retains fail-closed checks", () => {
    const lease = runtimeSource("RFO_ObserverCameraLease.c");
    const service = runtimeSource("RFO_ObserverService.c");
    const callback = between(
      service,
      "void OnObserverCameraPostFrame(",
      "void Shutdown("
    );

    expect(callback).toContain("if (m_RFO_CameraLease.IsRestoring())");
    expect(callback).toContain("m_RFO_CameraLease.CommitRestorationPostFrame(");
    expect(callback.indexOf("CommitRestorationPostFrame("))
      .toBeLessThan(callback.indexOf("CommitPostFrame("));
    expect(lease).toContain("WorldCameraMatches(m_RFO_ActualMatrix, m_RFO_ActualFovDegrees)");
    expect(lease).toContain("PublishedCameraMatches(m_RFO_OriginalCamera");
    expect(lease).toContain("Clear(false)");
    expect(lease).not.toContain("FinishDetachedRestoration");
    expect(lease).not.toContain("FinishOriginalRestoration");
  });

  it("revalidates the exact world, slot, and owner before cleanup", () => {
    const lease = runtimeSource("RFO_ObserverCameraLease.c");
    const cleanup = between(
      lease,
      "protected bool RestorationCleanupBindingStillCurrent(",
      "protected bool RetireOldWorldObserver("
    );

    expect(cleanup).toContain("world != m_RFO_World");
    expect(cleanup).toContain("currentWorldEpoch != m_RFO_WorldEpoch");
    expect(cleanup).toContain("m_RFO_OriginalCamera.GetCameraIndex() != m_RFO_WorldCameraId");
    expect(cleanup).toContain("world.GetCurrentCameraId() != m_RFO_WorldCameraId");
    expect(cleanup).toContain("m_RFO_CameraManager.CurrentCamera() == m_RFO_ObserverCamera");
    expect(cleanup).toContain("m_RFO_CameraManager.CurrentCamera() == m_RFO_OriginalCamera");
    expect(cleanup).not.toContain("Clear(true)");
    expect(cleanup).not.toContain("DestroyObserverCamera(");
  });
});
