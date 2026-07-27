import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observerAddonSource } from "../support/observer-fixtures.js";

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
  it("waits on a read-only leaseability proof before one mutating acquisition", () => {
    const lease = runtimeSource("RFO_ObserverCameraLease.c");
    const service = runtimeSource("RFO_ObserverService.c");
    const arbitration = runtimeSource("RFO_ObserverEditorCameraArbitration.c");
    const resolver = between(
      lease,
      "protected bool ResolveLeaseableCamera(",
      "protected RFO_ObserverCamera SpawnObserverCamera("
    );
    const acquire = between(lease, "bool Acquire(", "bool CommitPostFrame(");
    const process = between(service, "protected void ProcessActiveJob(", "protected void AcquireCamera(");
    const command = between(service, "bool OnRuntimeCommand(", "bool OnTransportSuccess(");
    const resolving = between(
      process,
      "case RFO_ObserverJobState.RESOLVING:",
      "case RFO_ObserverJobState.ACQUIRING_CAMERA:"
    );
    const capabilities = between(
      service,
      "protected array<string> CurrentCapabilities()",
      "protected void SwitchToMailboxFallback()"
    );

    expect(lease).toContain("bool CanAcquire(BaseWorld world)");
    expect(lease).toContain("string GetLastLeaseabilityReason()");
    expect(lease).toContain("string GetLastCameraFailureReason()");
    expect(resolver).toContain("game.GetWorld() != world");
    expect(resolver).toContain("manager = game.GetCameraManager()");
    expect(resolver).toContain("CameraBase playerCamera = FindPlayerCamera()");
    expect(resolver).toContain("bool detachedPlayerCamera");
    expect(resolver).toContain("original = playerCamera");
    expect(resolver).toContain("detachedPlayerCamera = true");
    expect(resolver).toContain("world.GetCurrentCameraId() != cameraId");
    expect(resolver).toContain("CameraRegistered(manager, original)");
    expect(resolver).not.toContain("SpawnObserverCamera(");
    expect(resolver).not.toContain("SetCamera(");
    expect(resolver).not.toContain("DestroyObserverCamera(");
    expect(resolver).not.toContain("Initialize(");

    expect(acquire.match(/ResolveLeaseableCamera\(/g)).toHaveLength(1);
    expect(acquire.match(/SpawnObserverCamera\(/g)).toHaveLength(1);
    expect(acquire).toContain("CameraRegistered(manager, observer)");
    expect(acquire).toContain("manager.SetCamera(observer)");
    expect(acquire).toContain("if (!detachedPlayerCamera)");
    expect(acquire).toContain("RFO_ObserverEditorCameraArbitration.CanBeginManagerLease(manager, original)");
    expect(acquire).toContain("RFO_ObserverEditorCameraArbitration.BeginManagerLease(manager, original)");
    expect(acquire).toContain("RFO_ObserverEditorCameraArbitration.EndManagerLease()");
    expect(acquire).toContain("Initialize(jobId, world, worldEpoch, manager, original, observer, detachedPlayerCamera");
    expect(arbitration).toContain("modded class SCR_CameraEditorComponent");
    expect(arbitration).toContain("SCR_CameraEditorComponent.GetCameraInstance()");
    expect(arbitration).toContain("RFO_ObserverEditorCameraArbitration.IsManagerLeaseActive(m_CameraManager, m_Camera)");
    expect(arbitration).toContain("override protected bool TryForceCamera()");
    expect(arbitration).toContain("override protected void OnCameraDectivate()");
    expect(arbitration).toContain("super.TryForceCamera()");
    expect(arbitration).toContain("super.OnCameraDectivate()");
    expect(arbitration).toContain("manager == s_RFO_LeaseManager");
    expect(arbitration).toContain("camera == s_RFO_LeaseOriginalCamera");
    expect(arbitration).not.toContain("override void EOnFrame(");
    expect(process.indexOf("job.cancellationRequested")).toBeLessThan(
      process.indexOf("switch (job.state)")
    );
    expect(process.indexOf("job.DeadlineExpired()")).toBeLessThan(
      process.indexOf("switch (job.state)")
    );
    expect(process).toContain('deadlineMessage += " while resolving camera reason=" + leaseabilityReason');
    expect(process).toContain("job.state = RFO_ObserverJobState.RESOLVING");
    expect(resolving.indexOf("m_RFO_CameraLease.CanAcquire(world)")).toBeLessThan(
      resolving.indexOf("AcquireCamera(world)")
    );
    expect(resolving).toContain("RFO_ObserverProtocol.ERROR_CAPABILITY_UNAVAILABLE");
    expect(resolving).toContain("ExplicitCameraCapabilityMessage(leaseabilityReason)");
    expect(resolving).toContain("BeginTerminalTransition()");
    expect(resolving).not.toContain("m_RFO_CameraLease.Acquire(");
    expect(command.indexOf("m_RFO_CameraLease.CanAcquire(m_RFO_World.GetObject())")).toBeLessThan(
      command.indexOf("m_RFO_ActiveJob = job")
    );
    expect(command).toContain("ExplicitCameraCapabilityMessage(leaseabilityReason)");
    expect(command).toContain("RFO_ObserverProtocol.ERROR_CAPABILITY_UNAVAILABLE");
    expect(capabilities).toContain("m_RFO_CameraLease.CanAcquire(m_RFO_World.GetObject())");
  });

  it("retains all five canonical matrix barriers around the resolving change", () => {
    const service = runtimeSource("RFO_ObserverService.c");
    const acquire = between(service, "protected void AcquireCamera(", "protected bool AdvanceSettleFrame(");
    const process = between(service, "protected void ProcessActiveJob(", "protected void AcquireCamera(");
    const acquired = between(
      process,
      "case RFO_ObserverJobState.ACQUIRING_CAMERA:",
      "case RFO_ObserverJobState.POSITIONING:"
    );
    const barrierNames = [
      "OnBeforeLeaseBarrier",
      "OnLeaseAcquiredBarrier",
      "OnCaptureInProgressBarrier",
      "OnRestorationInProgressBarrier",
      "OnTerminalReleaseBarrier",
    ];

    for (const name of barrierNames) {
      expect(service.match(new RegExp(`protected event bool ${name}\\(`, "g"))).toHaveLength(1);
    }
    expect(acquire.indexOf("OnBeforeLeaseBarrier(m_RFO_ActiveJob)")).toBeLessThan(
      acquire.indexOf("m_RFO_CameraLease.Acquire(")
    );
    expect(acquire.indexOf("m_RFO_CameraLease.Acquire(")).toBeLessThan(
      acquire.indexOf("m_RFO_ActiveJob.state = RFO_ObserverJobState.ACQUIRING_CAMERA")
    );
    expect(acquired.indexOf("OnLeaseAcquiredBarrier(job)")).toBeLessThan(
      acquired.indexOf("job.state = RFO_ObserverJobState.POSITIONING")
    );
  });

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
    expect(lease).toContain("PublishedCameraMatches(m_RFO_OriginalCamera");
    expect(lease).toContain("Clear(false)");
    expect(lease).toContain("WorldCameraMatches(");
    expect(lease).toContain("RestoreDetachedPlayerCamera");
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
    expect(cleanup).toContain("m_RFO_UsesDetachedPlayerCamera");
    expect(cleanup).not.toContain("Clear(true)");
    expect(cleanup).not.toContain("DestroyObserverCamera(");
  });

  it("keeps a concrete manager-path failure reason when restoration fails closed", () => {
    const lease = runtimeSource("RFO_ObserverCameraLease.c");
    const service = runtimeSource("RFO_ObserverService.c");
    const restore = between(
      lease,
      "bool Restore(string jobId",
      "bool CommitRestorationPostFrame("
    );
    const restoration = between(service, "protected void AdvanceRestoration(", "protected void RecordFailure(");

    expect(lease).toContain("protected void SetCameraFailureReason(string reason)");
    expect(restore).toContain('SetCameraFailureReason("restore_manager_owner_changed")');
    expect(restore).toContain('SetCameraFailureReason("restore_target_selection_failed")');
    expect(restore).toContain('SetCameraFailureReason("restore_cleanup_binding_changed")');
    expect(restoration).toContain("m_RFO_CameraLease.GetLastCameraFailureReason()");
    expect(restoration).toContain('"Observer camera restoration could not be confirmed reason=" + failureReason');
    expect(restoration).toContain('job.terminalMessage += " priorError=" + priorErrorCode');
  });
});
