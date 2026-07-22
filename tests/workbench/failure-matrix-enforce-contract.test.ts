import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAULT_ACTION_PHASES,
  FAULT_MATRIX_PHASES,
} from "../../observer/protocol/fault-matrix.js";

const helperPath = join(
  "observer", "workbench-addon", "Scripts", "WorkbenchGame", "EnfusionMCP",
  "EMCP_WB_ObserverCommon.c"
);
const fixturePath = join(
  "tests", "fixtures", "workbench-observer-failure-matrix-addon", "Scripts",
  "WorkbenchGame", "EnfusionMCP", "EMCP_WB_ObserverMatrixControl.c"
);

describe("Workbench failure-matrix Enforce boundaries", () => {
  it("keeps all five passive barriers in the real helper with a true restoration yield", () => {
    const source = readFileSync(helperPath, "utf8");
    for (const hook of [
      "OnBeforeLeaseBarrier",
      "OnLeaseAcquiredBarrier",
      "OnCaptureInProgressBarrier",
      "OnRestorationInProgressBarrier",
      "OnTerminalReleaseBarrier",
    ]) {
      expect(source).toContain(`protected event bool ${hook}`);
    }
    const restoring = source.indexOf(
      "m_Job.state = EMCP_WB_ObserverProtocol.STATE_RESTORING;"
    );
    const restorationBarrier = source.indexOf(
      "OnRestorationInProgressBarrier(m_Job)",
      restoring
    );
    const restorationCall = source.indexOf("RestoreJob(m_Job)", restorationBarrier);
    expect(restoring).toBeGreaterThan(-1);
    expect(restorationBarrier).toBeGreaterThan(restoring);
    expect(restorationCall).toBeGreaterThan(restorationBarrier);
    expect(source).not.toContain("RFO_WBObserverMatrixControl");
  });

  it("validates the complete declared Workbench action and phase vocabulary in the disposable fixture", () => {
    const source = readFileSync(fixturePath, "utf8");
    for (const phase of FAULT_MATRIX_PHASES) expect(source).toContain(`"${phase}"`);
    for (const action of Object.keys(FAULT_ACTION_PHASES.workbench)) {
      expect(source).toContain(`"${action}"`);
    }
    expect(source).toContain("IsDeclaredSchedule(command.caseId, command.action, command.phase)");
    expect(source).toContain("CheckBeforeLeaseProbe(EMCP_WB_ObserverService service)");
    expect(source).toContain("class RFO_WorkbenchObserverMatrixPlugin : WorkbenchPlugin");
    expect(source).toContain("m_RequestFingerprints.Get(command.requestId) == CommandFingerprint(command)");
    expect(source).not.toContain("SLICE_CASE_ID");
  });

  it("refuses phase arrival unless the real retained job is at the declared product boundary", () => {
    const source = readFileSync(fixturePath, "utf8");
    const validation = source.indexOf("if (!BarrierStateMatches(phase, job))");
    const arrival = source.indexOf("if (!m_Arrived)", validation);
    expect(validation).toBeGreaterThan(-1);
    expect(arrival).toBeGreaterThan(validation);
    expect(source).toContain("Refuse(m_ArmedRequestId, m_ArmedCaseId, m_ArmedPhase, REASON_PHASE_MISMATCH)");

    for (const predicate of [
      "!job.screenshotIssued",
      "job.state == EMCP_WB_ObserverProtocol.STATE_SETTLING",
      "job.screenshotIssued",
      "job.state == EMCP_WB_ObserverProtocol.STATE_CAPTURING",
      "job.state == EMCP_WB_ObserverProtocol.STATE_AWAITING_ARTIFACT",
      "job.artifactBytes > 33",
      "job.state == EMCP_WB_ObserverProtocol.STATE_RESTORING",
      "job.IsTerminal() && !job.cameraLeaseHeld && job.restorationConfirmed",
    ]) {
      expect(source).toContain(predicate);
    }
  });

  it("retains a released before-lease tuple and fail-closes a mismatched later Submit", () => {
    const source = readFileSync(fixturePath, "utf8");
    expect(source).toContain("m_SelectedView = DeclaredView(command.caseId, command.action, command.phase)");
    expect(source).toContain("if (m_ArmedPhase == PHASE_BEFORE_LEASE)\n\t\t\tm_BeforeLeaseSubmitPending = true;");
    expect(source).toContain(
      "control.CheckBeforeLeaseSubmit(this, jobId, lifecycleGeneration, canonicalTarget, viewKind)"
    );
    expect(source).toContain('if (submittedView == "lookAt")');
    expect(source).toContain("lifecycleGeneration == m_Bootstrap.binding.lifecycleGeneration && submittedView == m_SelectedView");
    expect(source).toContain("m_BeforeLeaseSubmitPending = false;");
    expect(source).toContain("m_BeforeLeaseSubmitBound = true;");
    expect(source).toContain("A Submit is deliberately not required for");
    expect(source).toContain("control.CheckBeforeLeaseProbe(EMCP_WB_ObserverService.Get())");
  });

  it("contains no fixture-side process termination path", () => {
    const source = readFileSync(fixturePath, "utf8");
    expect(source).not.toMatch(/taskkill|Stop-Process|KillProcess|Workbench\.Exit|\.kill\s*\(/i);
  });
});
