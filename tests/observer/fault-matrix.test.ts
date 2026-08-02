import { describe, expect, it } from "vitest";
import {
  FAULT_ACTION_PHASES,
  FAULT_MATRIX_PHASES,
  OBSERVER_FAULT_MATRIX,
  caseForId,
  defineFaultMatrix,
  validateFaultMatrix,
  type FaultMatrixCase,
  type FaultMatrixPhase,
  type FaultMatrixView,
  type WorkbenchFaultAction,
  type WorkbenchFaultMatrixCase,
} from "../../observer/protocol/fault-matrix.js";

const WORKBENCH_VIEWS = ["current", "pose", "lookAt"] as const satisfies readonly Exclude<FaultMatrixView, null>[];
const WORKBENCH_REQUIRED_CHECKS = [
  "lifecycle_vacant", "endpoint_vacant", "child_vacant", "exact_owner_vacant",
] as const;
const WORKBENCH_REQUIRED_EVIDENCE = [
  "public_terminal", "deadline", "world_revision", "camera", "artifact", "cleanup", "retained_diagnostics",
] as const;

function workbenchCases(): readonly WorkbenchFaultMatrixCase[] {
  return OBSERVER_FAULT_MATRIX.cases.filter(
    (item): item is WorkbenchFaultMatrixCase => item.backend === "workbench",
  );
}

function schedulesFor(action: WorkbenchFaultAction): string[] {
  return workbenchCases()
    .filter((item) => item.injection.action === action)
    .map((item) => `${item.injection.phase}:${item.view}`)
    .sort();
}

function expectedSchedules(
  phases: readonly FaultMatrixPhase[],
  views: readonly Exclude<FaultMatrixView, null>[] = WORKBENCH_VIEWS,
): string[] {
  return phases.flatMap((phase) => views.map((view) => `${phase}:${view}`)).sort();
}

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
  it("keeps an immutable, canonical 70-case catalog with the complete Phase 3 Workbench inventory", () => {
    const workbench = workbenchCases();
    const actionCounts = workbench.reduce<Record<string, number>>((counts, item) => {
      counts[item.injection.action] = (counts[item.injection.action] ?? 0) + 1;
      return counts;
    }, {});

    expect(OBSERVER_FAULT_MATRIX.cases).toHaveLength(70);
    expect(workbench).toHaveLength(69);
    expect(OBSERVER_FAULT_MATRIX.cases.filter((item) => item.backend === "runtime").map((item) => item.id)).toEqual([
      "runtime.cancel_capture.lease_acquired.pose",
    ]);
    expect(actionCounts).toEqual({
      cancel_capture: 12,
      complete_capture: 3,
      disable_fixture_handler: 15,
      release_twice: 3,
      replace_fixture_world: 15,
      stop_owned_workbench: 15,
      submit_competing_capture: 3,
      write_crc_artifact: 1,
      write_mismatched_artifact: 1,
      write_truncated_artifact: 1,
    });
    expect(OBSERVER_FAULT_MATRIX.caseIds).toEqual([...OBSERVER_FAULT_MATRIX.caseIds].sort());
    expect(OBSERVER_FAULT_MATRIX.caseIds.every((id) => /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){3}$/.test(id))).toBe(true);
    expect(OBSERVER_FAULT_MATRIX.caseIds).toContain("workbench.stop_owned_workbench.terminal_release.lookat");
    expect(OBSERVER_FAULT_MATRIX.caseIds.some((id) => id.startsWith("workbench.cancel_capture.before_lease."))).toBe(false);
    expect(Object.isFrozen(OBSERVER_FAULT_MATRIX)).toBe(true);
    expect(Object.isFrozen(OBSERVER_FAULT_MATRIX.cases)).toBe(true);
    expect(Object.isFrozen(OBSERVER_FAULT_MATRIX.caseIds)).toBe(true);
    expect(Object.isFrozen(OBSERVER_FAULT_MATRIX.byId)).toBe(true);
    expect(OBSERVER_FAULT_MATRIX.cases.every((item) => Object.isFrozen(item))).toBe(true);
  });

  it("declares each Workbench action at exactly its required phase and view combinations", () => {
    expect(schedulesFor("complete_capture")).toEqual(expectedSchedules(["terminal_release"]));
    expect(schedulesFor("cancel_capture")).toEqual(expectedSchedules([
      "lease_acquired", "capture_in_progress", "restoration_in_progress", "terminal_release",
    ]));
    expect(schedulesFor("disable_fixture_handler")).toEqual(expectedSchedules(FAULT_MATRIX_PHASES));
    expect(schedulesFor("submit_competing_capture")).toEqual(expectedSchedules(["lease_acquired"]));
    expect(schedulesFor("replace_fixture_world")).toEqual(expectedSchedules(FAULT_MATRIX_PHASES));
    expect(schedulesFor("write_truncated_artifact")).toEqual(expectedSchedules(["capture_in_progress"], ["pose"]));
    expect(schedulesFor("write_crc_artifact")).toEqual(expectedSchedules(["capture_in_progress"], ["pose"]));
    expect(schedulesFor("write_mismatched_artifact")).toEqual(expectedSchedules(["capture_in_progress"], ["pose"]));
    expect(schedulesFor("stop_owned_workbench")).toEqual(expectedSchedules(FAULT_MATRIX_PHASES));
    expect(schedulesFor("release_twice")).toEqual(expectedSchedules(["terminal_release"]));
  });

  it("binds every Workbench family to its required terminal, camera, cleanup, and evidence contract", () => {
    for (const item of workbenchCases()) {
      expect(Object.values(item.phaseSupport).map((support) => support.kind)).toEqual([
        "observable", "observable", "observable", "observable", "observable",
      ]);
      expect(item.requiredChecks).toEqual(WORKBENCH_REQUIRED_CHECKS);
      expect(item.requiredEvidence).toEqual(WORKBENCH_REQUIRED_EVIDENCE);

      switch (item.injection.action) {
        case "complete_capture":
        case "release_twice":
          expect(item.expectedTerminal).toEqual({ state: "completed", errorCode: null });
          expect(item.cameraDisposition).toBe("restored");
          break;
        case "cancel_capture":
          expect(item.expectedTerminal).toEqual({ state: "cancelled", errorCode: null });
          expect(item.cameraDisposition).toBe("restored");
          break;
        case "disable_fixture_handler":
          expect(item.expectedTerminal).toEqual({ state: "failed", errorCode: "TRANSPORT_UNAVAILABLE" });
          expect(item.cameraDisposition).toBe(item.injection.phase === "before_lease"
            ? "not_acquired"
            : item.injection.phase === "terminal_release" ? "restored" : "exact_process_exit");
          break;
        case "submit_competing_capture":
          expect(item.expectedTerminal).toEqual({ state: "failed", errorCode: "CAMERA_BUSY" });
          expect(item.cameraDisposition).toBe("restored");
          break;
        case "replace_fixture_world":
          expect(item.expectedTerminal).toEqual(item.injection.phase === "terminal_release"
            ? { state: "completed", errorCode: null }
            : {
                state: "failed",
                errorCode: item.injection.phase === "before_lease" ? "WORLD_CHANGED" : "RESTORATION_UNCONFIRMED",
              });
          expect(item.cameraDisposition).toBe(item.injection.phase === "before_lease"
            ? "not_acquired"
            : item.injection.phase === "terminal_release" ? "restored" : "relinquished");
          break;
        case "write_truncated_artifact":
        case "write_crc_artifact":
        case "write_mismatched_artifact":
          expect(item.expectedTerminal).toEqual({ state: "failed", errorCode: "ARTIFACT_INVALID" });
          expect(item.cameraDisposition).toBe("restored");
          break;
        case "stop_owned_workbench":
          expect(item.expectedTerminal).toEqual(item.injection.phase === "terminal_release"
            ? { state: "completed", errorCode: null }
            : { state: "failed", errorCode: "WORKBENCH_EXITED" });
          expect(item.cameraDisposition).toBe(item.injection.phase === "terminal_release" ? "restored" : "exact_process_exit");
          break;
        default: {
          const exhaustiveAction: never = item.injection.action;
          throw new Error(`Unhandled Workbench action: ${exhaustiveAction}`);
        }
      }
    }
  });

  it("documents all five Workbench synchronization hooks as observable product state", () => {
    const support = workbenchCases()[0]!.phaseSupport;
    expect(support.before_lease).toMatchObject({
      kind: "observable",
      publicStatusPredicate: expect.stringContaining("no retained job"),
      fixtureAcknowledgement: expect.stringContaining("before submission"),
    });
    expect(support.lease_acquired).toMatchObject({
      kind: "observable",
      publicStatusPredicate: expect.stringContaining("cameraLeaseHeld true"),
      fixtureAcknowledgement: expect.stringContaining("before screenshot issuance"),
    });
    expect(support.capture_in_progress).toMatchObject({
      kind: "observable",
      publicStatusPredicate: expect.stringContaining("capturing or awaiting artifact"),
      fixtureAcknowledgement: expect.stringContaining("successful screenshot issuance"),
    });
    expect(support.restoration_in_progress).toMatchObject({
      kind: "observable",
      publicStatusPredicate: expect.stringContaining("restoring after artifact readiness"),
      fixtureAcknowledgement: expect.stringContaining("before exact camera restoration completed"),
    });
    expect(support.terminal_release).toMatchObject({
      kind: "observable",
      publicStatusPredicate: expect.stringContaining("restorationConfirmed true before release"),
      fixtureAcknowledgement: expect.stringContaining("before release disposed"),
    });
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
    invalid((value) => { value.expectedTerminal = { state: "completed", errorCode: "CANCELLED" }; });
    invalid((value) => { value.expectedTerminal = { state: "failed", errorCode: null }; });
    invalid((value) => { value.cameraDisposition = "not_acquired"; });
    invalid((value) => { value.cameraDisposition = "exact_process_exit"; });
    invalid((value) => { value.cameraDisposition = "relinquished"; });
    invalid((value) => { value.requiredChecks.push("child_vacant"); });
    invalid((value) => { value.requiredEvidence = []; });
    invalid((value) => { value.requiredEvidence.push("camera"); });
    invalid((value) => { value.requiredEvidence.push("unknown"); });
  });

  it("freezes the exported phase and action-phase vocabularies at runtime", () => {
    expect(Object.isFrozen(FAULT_MATRIX_PHASES)).toBe(true);
    expect(Object.isFrozen(FAULT_ACTION_PHASES)).toBe(true);
    expect(Object.isFrozen(FAULT_ACTION_PHASES.runtime)).toBe(true);
    expect(Object.isFrozen(FAULT_ACTION_PHASES.workbench)).toBe(true);
    expect(Object.isFrozen(FAULT_ACTION_PHASES.runtime.cancel_capture)).toBe(true);
    expect(Object.values(FAULT_ACTION_PHASES.workbench).every((phases) => Object.isFrozen(phases))).toBe(true);
    expect(() => (FAULT_MATRIX_PHASES as unknown as string[]).push("forged_phase")).toThrow();
    expect(() => (FAULT_ACTION_PHASES.runtime.cancel_capture as unknown as string[]).splice(0, 1)).toThrow();
    expect(() => (FAULT_ACTION_PHASES.workbench.stop_owned_workbench as unknown as string[]).splice(0, 1)).toThrow();
  });

  it("permits cancellation at every canonical observable barrier", () => {
    for (const phase of ["before_lease", "terminal_release"] as const) {
      const value: any = structuredClone(caseFixture());
      value.injection.phase = phase;
      value.id = `runtime.cancel_capture.${phase}.current`;
      expect(() => validateFaultMatrix([value])).not.toThrow();
    }
  });

  it("rejects Workbench cancellation before lease acquisition because Phase 3 does not declare it", () => {
    const value: any = structuredClone(caseForId(
      OBSERVER_FAULT_MATRIX,
      "workbench.cancel_capture.lease_acquired.current",
    ));
    value.id = "workbench.cancel_capture.before_lease.current";
    value.injection.phase = "before_lease";
    expect(() => validateFaultMatrix([value])).toThrow(/incompatible with its injection phase/);
  });

  it("rejects duplicate identifiers and the same mutable case object", () => {
    const item = caseFixture();
    expect(() => validateFaultMatrix([item, item])).toThrow(/duplicate case object/);
    expect(() => validateFaultMatrix([item, { ...structuredClone(item), requiredChecks: ["exact_owner_vacant"] }]))
      .toThrow(/duplicate case ID/);
  });
});
