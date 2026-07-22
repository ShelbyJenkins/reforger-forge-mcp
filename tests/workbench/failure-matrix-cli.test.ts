import { describe, expect, it } from "vitest";
import {
  parseWorkbenchObserverCliArgs,
  readWorkbenchCliFlag,
  readWorkbenchCliOption,
  workbenchFailureMatrixCaseIds,
} from "../../scripts/run-workbench-observer-acceptance.js";
import { SLICE_CASE } from "./failure-matrix-runner-fixture.js";

describe("Workbench failure-matrix CLI", () => {
  it("lists exactly the 69 declared Workbench cases", () => {
    const caseIds = workbenchFailureMatrixCaseIds();
    expect(caseIds).toHaveLength(69);
    expect(caseIds).toContain(SLICE_CASE.id);
    expect(caseIds.every((caseId) => caseId.startsWith("workbench."))).toBe(true);
  });

  it("preserves positive mode by default and selects full or partial matrix mode explicitly", () => {
    expect(parseWorkbenchObserverCliArgs([])).toEqual({ mode: "positive", confirmed: false });
    expect(parseWorkbenchObserverCliArgs(["--matrix", "--confirm-live-run"])).toEqual({
      mode: "matrix",
      confirmed: true,
      keepProfile: false,
    });
    expect(parseWorkbenchObserverCliArgs(["--only", SLICE_CASE.id, "--keep-profile"])).toEqual({
      mode: "matrix",
      confirmed: false,
      only: SLICE_CASE.id,
      keepProfile: true,
    });
  });

  it("rejects unknown, stray, duplicate, missing and incompatible arguments", () => {
    expect(() => parseWorkbenchObserverCliArgs(["stray"])).toThrow(/Unknown or stray/);
    expect(() => parseWorkbenchObserverCliArgs(["--unknown"])).toThrow(/Unknown or stray/);
    expect(() => parseWorkbenchObserverCliArgs(["--matrix", "--matrix"])).toThrow(/only once/);
    expect(() => parseWorkbenchObserverCliArgs(["--only"])).toThrow(/requires a value/);
    expect(() => parseWorkbenchObserverCliArgs(["--matrix", "--only", SLICE_CASE.id])).toThrow(/mutually exclusive/);
    expect(() => parseWorkbenchObserverCliArgs(["--keep-profile"])).toThrow(/only together with --only/);
    expect(() => parseWorkbenchObserverCliArgs(["--help", "--matrix"])).toThrow(/by itself/);
    expect(() => parseWorkbenchObserverCliArgs(["--only", "runtime.cancel_capture.lease_acquired.pose"]))
      .toThrow(/not a Workbench case/);
    expect(() => parseWorkbenchObserverCliArgs(["--only", "workbench.unknown.before_lease.current"]))
      .toThrow(/Unknown fault-matrix case/);
  });

  it("retains the singleton helper behavior used by downstream parser tests", () => {
    expect(() => readWorkbenchCliOption(
      ["--only", SLICE_CASE.id, "--only", SLICE_CASE.id],
      "--only"
    )).toThrow(/only once/);
    expect(() => readWorkbenchCliFlag(
      ["--keep-profile", "--keep-profile"],
      "--keep-profile"
    )).toThrow(/only once/);
  });
});
