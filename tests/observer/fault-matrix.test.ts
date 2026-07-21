import { describe, expect, it } from "vitest";
import {
  FAULT_ACTION_PHASES,
  FAULT_MATRIX_PHASES,
  OBSERVER_FAULT_MATRIX,
  caseForId,
  defineFaultMatrix,
  validateFaultMatrix,
  type FaultMatrixCase,
} from "../../observer/protocol/fault-matrix.js";

function caseFixture(): FaultMatrixCase {
  return {
    schemaVersion: 1,
    id: "runtime.cancel_capture.lease_acquired.current",
    backend: "runtime",
    view: "current",
    injection: { phase: "lease_acquired", action: "cancel_capture" },
    phaseSupport: {
      before_lease: {
        kind: "observable",
        publicStatusPredicate: "public job is non-terminal and cameraLeaseHeld is not true",
        fixtureAcknowledgement: "fixture arrived before native camera acquisition",
      },
      lease_acquired: {
        kind: "observable",
        publicStatusPredicate: "public job cameraLeaseHeld is true",
        fixtureAcknowledgement: "fixture arrived after lease acquisition",
      },
      capture_in_progress: {
        kind: "observable",
        publicStatusPredicate: "public job is capturing",
        fixtureAcknowledgement: "fixture arrived at capture boundary",
      },
      restoration_in_progress: {
        kind: "observable",
        publicStatusPredicate: "public job has a restoration obligation",
        fixtureAcknowledgement: "fixture arrived during restoration",
      },
      terminal_release: {
        kind: "observable",
        publicStatusPredicate: "public terminal is captured before release",
        fixtureAcknowledgement: "fixture arrived before release receipt",
      },
    },
    expectedTerminal: { state: "cancelled", errorCode: null },
    cameraDisposition: "restored",
    requiredChecks: ["lifecycle_vacant", "endpoint_vacant", "child_vacant"],
    requiredEvidence: ["public_terminal", "deadline", "camera", "cleanup"],
  };
}

describe("observer fault-matrix contract", () => {
  it("keeps the production catalog immutable and declares exactly the declared pilot/vertical-slice cases", () => {
    expect(OBSERVER_FAULT_MATRIX.caseIds).toEqual([
      "runtime.cancel_capture.lease_acquired.pose",
      "workbench.cancel_capture.lease_acquired.pose",
    ]);
    expect(Object.isFrozen(OBSERVER_FAULT_MATRIX)).toBe(true);
    expect(Object.isFrozen(OBSERVER_FAULT_MATRIX.cases)).toBe(true);
  });

  it("declares the pilot case with a cancelled terminal that carries no errorCode", () => {
    const pilot = caseForId(OBSERVER_FAULT_MATRIX, "runtime.cancel_capture.lease_acquired.pose");
    expect(pilot.backend).toBe("runtime");
    expect(pilot.view).toBe("pose");
    expect(pilot.injection).toEqual({ phase: "lease_acquired", action: "cancel_capture" });
    expect(pilot.expectedTerminal).toEqual({ state: "cancelled", errorCode: null });
    expect(pilot.cameraDisposition).toBe("restored");
    expect(pilot.phaseSupport.lease_acquired.kind).toBe("observable");
    for (const phase of ["before_lease", "capture_in_progress", "restoration_in_progress", "terminal_release"] as const) {
      expect(pilot.phaseSupport[phase].kind).toBe("not_applicable");
    }
    expect(() => caseForId(OBSERVER_FAULT_MATRIX, "runtime.cancel_capture.lease_acquired.current")).toThrow();
  });

  it("clones, indexes, and deep-freezes a complete declaration", () => {
    const source = caseFixture();
    const matrix = defineFaultMatrix([source]);
    expect(matrix.byId.get(source.id)).not.toBe(source);
    expect(Object.isFrozen(matrix.cases[0])).toBe(true);
    expect(Object.isFrozen(matrix.cases[0]!.phaseSupport)).toBe(true);
    expect(() => { (matrix.cases[0] as { id: string }).id = "changed"; }).toThrow();
  });

  it("canonicalizes catalog order and exposes no mutable index operations", () => {
    const later: any = structuredClone(caseFixture());
    later.id = "runtime.replace_runtime_world.lease_acquired.current";
    later.injection.action = "replace_runtime_world";
    const matrix = defineFaultMatrix([later, caseFixture()]);
    expect(matrix.caseIds).toEqual([
      "runtime.cancel_capture.lease_acquired.current",
      "runtime.replace_runtime_world.lease_acquired.current",
    ]);
    expect(Object.isFrozen(matrix.byId)).toBe(true);
    expect("set" in matrix.byId).toBe(false);
    expect(() => (matrix.byId as unknown as { set: () => void }).set()).toThrow();
  });

  it("fails closed for malformed schedules and incomplete observable proof", () => {
    const invalid = (mutate: (value: any) => void): void => {
      const value: any = structuredClone(caseFixture());
      mutate(value);
      expect(() => validateFaultMatrix([value])).toThrow(/Invalid fault matrix/);
    };
    invalid((value) => { value.schemaVersion = 2; });
    invalid((value) => { value.injection.phase = "unknown_phase"; });
    invalid((value) => { value.id = "runtime.bad"; });
    invalid((value) => { value.backend = "unknown"; });
    invalid((value) => { value.injection.action = "replace_fixture_world"; });
    invalid((value) => { delete value.phaseSupport.capture_in_progress; });
    invalid((value) => { value.phaseSupport.lease_acquired = { kind: "not_applicable", rationale: "none" }; });
    invalid((value) => { value.injection.action = "replace_runtime_world"; value.injection.phase = "terminal_release"; value.id = "runtime.replace_runtime_world.terminal_release.current"; });
    invalid((value) => { value.phaseSupport.before_lease.publicStatusPredicate = "after await acquire"; });
    invalid((value) => { value.expectedTerminal.errorCode = "INTERNAL_ERROR"; });
    invalid((value) => { value.cameraDisposition = "not_acquired"; });
    invalid((value) => { value.cameraDisposition = "exact_process_exit"; });
    invalid((value) => { value.requiredChecks.push("child_vacant"); });
    invalid((value) => { value.requiredEvidence = []; });
    invalid((value) => { value.requiredEvidence.push("camera"); });
    invalid((value) => { value.requiredEvidence.push("unknown"); });
  });

  it("freezes the exported phase and action-phase vocabularies at runtime", () => {
    expect(Object.isFrozen(FAULT_MATRIX_PHASES)).toBe(true);
    expect(Object.isFrozen(FAULT_ACTION_PHASES)).toBe(true);
    expect(Object.isFrozen(FAULT_ACTION_PHASES.runtime)).toBe(true);
    expect(Object.isFrozen(FAULT_ACTION_PHASES.runtime.cancel_capture)).toBe(true);
    expect(() => (FAULT_MATRIX_PHASES as unknown as string[]).push("forged_phase")).toThrow();
    expect(() => (FAULT_ACTION_PHASES.runtime.cancel_capture as unknown as string[]).splice(0, 1)).toThrow();
  });

  it("permits cancellation at every canonical observable barrier", () => {
    for (const phase of ["before_lease", "terminal_release"] as const) {
      const value: any = structuredClone(caseFixture());
      value.injection.phase = phase;
      value.id = `runtime.cancel_capture.${phase}.current`;
      expect(() => validateFaultMatrix([value])).not.toThrow();
    }
  });

  it("rejects duplicate identifiers and the same mutable case object", () => {
    const item = caseFixture();
    expect(() => validateFaultMatrix([item, item])).toThrow(/duplicate case object/);
    expect(() => validateFaultMatrix([item, { ...structuredClone(item), requiredChecks: ["exact_owner_vacant"] }]))
      .toThrow(/duplicate case ID/);
  });
});
