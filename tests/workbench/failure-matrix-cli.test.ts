import { describe, expect, it } from "vitest";
import {
  parseWorkbenchObserverCliArgs,
  readWorkbenchCliFlag,
  readWorkbenchCliOption,
  workbenchFailureMatrixCaseIds,
} from "../../scripts/run-workbench-observer-acceptance.js";
import { SLICE_CASE } from "./failure-matrix-runner-fixture.js";

describe("Workbench failure-matrix CLI", () => {
  const config = "C:\\controlled\\reforger-forge.config.json";

  it("lists exactly the 69 declared Workbench cases", () => {
    const caseIds = workbenchFailureMatrixCaseIds();
    expect(caseIds).toHaveLength(69);
    expect(caseIds).toContain(SLICE_CASE.id);
    expect(caseIds.every((caseId) => caseId.startsWith("workbench."))).toBe(true);
  });

  it("preserves positive mode by default and selects full or partial matrix mode explicitly", () => {
    expect(parseWorkbenchObserverCliArgs(["--config", config])).toEqual({
      mode: "positive",
      confirmed: false,
      configPath: config,
    });
    expect(parseWorkbenchObserverCliArgs([
      "--config", config, "--matrix", "--confirm-live-run",
    ])).toEqual({
      mode: "matrix",
      confirmed: true,
      configPath: config,
      keepProfile: false,
    });
    expect(parseWorkbenchObserverCliArgs([
      "--config", config, "--only", SLICE_CASE.id, "--keep-profile",
    ])).toEqual({
      mode: "matrix",
      confirmed: false,
      configPath: config,
      only: SLICE_CASE.id,
      keepProfile: true,
    });
    expect(() => parseWorkbenchObserverCliArgs([])).toThrow(/requires --config/);
  });

  it("rejects unknown, stray, duplicate, missing and incompatible arguments", () => {
    expect(() => parseWorkbenchObserverCliArgs(["stray"])).toThrow(/Unknown or stray/);
    expect(() => parseWorkbenchObserverCliArgs(["--unknown"])).toThrow(/Unknown or stray/);
    expect(() => parseWorkbenchObserverCliArgs(["--matrix", "--matrix"])).toThrow(/only once/);
    expect(() => parseWorkbenchObserverCliArgs(["--only"])).toThrow(/requires a value/);
    expect(() => parseWorkbenchObserverCliArgs(["--matrix", "--only", SLICE_CASE.id])).toThrow(/mutually exclusive/);
    expect(() => parseWorkbenchObserverCliArgs(["--keep-profile"])).toThrow(/only together with --only/);
    expect(() => parseWorkbenchObserverCliArgs(["--help", "--matrix"])).toThrow(/by itself/);
    expect(() => parseWorkbenchObserverCliArgs([
      "--config", config, "--only", "runtime.cancel_capture.lease_acquired.pose",
    ]))
      .toThrow(/not a Workbench case/);
    expect(() => parseWorkbenchObserverCliArgs([
      "--config", config, "--only", "workbench.unknown.before_lease.current",
    ]))
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
