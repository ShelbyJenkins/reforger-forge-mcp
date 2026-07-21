import { describe, expect, it } from "vitest";
import {
  FAULT_ACTION_PHASES,
  FAULT_MATRIX_PHASES,
  OBSERVER_FAULT_MATRIX,
  caseForId,
} from "../../observer/protocol/fault-matrix.js";
import { resolveFaultMatrixCases } from "../../scripts/observer-fault-matrix-support.js";

function runtimeCases() {
  return OBSERVER_FAULT_MATRIX.cases.filter((item) => item.backend === "runtime");
}

describe("runtime failure-matrix inventory", () => {
  it("declares exactly the Phase 2 pilot case and nothing else for the runtime backend", () => {
    const cases = runtimeCases();
    expect(cases.map((item) => item.id)).toEqual([
      "runtime.cancel_capture.lease_acquired.pose",
    ]);
  });

  it("gives every declared runtime case a concrete capture view", () => {
    for (const item of runtimeCases()) {
      expect(item.view).not.toBeNull();
      expect(["current", "pose", "lookAt"]).toContain(item.view);
    }
  });

  it("restricts every declared runtime action to a phase legal for that action", () => {
    for (const item of runtimeCases()) {
      const legalPhases = FAULT_ACTION_PHASES.runtime[item.injection.action];
      expect(legalPhases).toBeDefined();
      expect(legalPhases).toContain(item.injection.phase);
    }
  });

  it("never pairs a cancelled or completed terminal with a non-null errorCode", () => {
    for (const item of runtimeCases()) {
      if (item.expectedTerminal.state === "cancelled" || item.expectedTerminal.state === "completed") {
        expect(item.expectedTerminal.errorCode).toBeNull();
      }
    }
  });

  it("marks every non-injection phase of the pilot case not_applicable with a rationale", () => {
    const pilot = caseForId(OBSERVER_FAULT_MATRIX, "runtime.cancel_capture.lease_acquired.pose");
    for (const phase of FAULT_MATRIX_PHASES) {
      const support = pilot.phaseSupport[phase];
      if (phase === pilot.injection.phase) {
        expect(support.kind).toBe("observable");
      } else {
        expect(support.kind).toBe("not_applicable");
        if (support.kind === "not_applicable") {
          expect(support.rationale.length).toBeGreaterThan(0);
        }
      }
    }
  });

  describe("--only resolution", () => {
    it("resolves the declared pilot case ID to exactly that one case", () => {
      const resolved = resolveFaultMatrixCases(OBSERVER_FAULT_MATRIX, "runtime.cancel_capture.lease_acquired.pose");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.id).toBe("runtime.cancel_capture.lease_acquired.pose");
    });

    it("returns no scheduled cases when --only is omitted", () => {
      expect(resolveFaultMatrixCases(OBSERVER_FAULT_MATRIX)).toEqual([]);
    });

    it("fails closed for an --only ID that has not been declared", () => {
      expect(() => resolveFaultMatrixCases(OBSERVER_FAULT_MATRIX, "runtime.cancel_capture.before_lease.pose"))
        .toThrow(/Unknown fault-matrix case/);
      expect(() => resolveFaultMatrixCases(OBSERVER_FAULT_MATRIX, "runtime.stop_owned_runtime.lease_acquired.pose"))
        .toThrow(/Unknown fault-matrix case/);
      expect(() => resolveFaultMatrixCases(OBSERVER_FAULT_MATRIX, "workbench.cancel_capture.before_lease.pose"))
        .toThrow(/Unknown fault-matrix case/);
    });
  });
});
