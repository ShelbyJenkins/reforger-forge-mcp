import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  combineWorkbenchObserverAcceptanceProcessCounts,
  workbenchObserverAcceptanceLaunchArguments,
} from "../../scripts/workbench-observer-acceptance-runtime.js";

describe("Workbench observer acceptance runtime composition", () => {
  it("builds the shared positive and matrix launch suffix without mutating caller arrays", () => {
    const base = ["Workbench.exe", "-gproj", "ObserverAcceptance.gproj"];
    const matrix = ["-plugin=RFO_WorkbenchObserverMatrixPlugin"];

    expect(workbenchObserverAcceptanceLaunchArguments(base)).toEqual([
      ...base,
      "-forceUpdate",
    ]);
    expect(workbenchObserverAcceptanceLaunchArguments(base, matrix)).toEqual([
      ...base,
      "-forceUpdate",
      ...matrix,
    ]);
    expect(base).toEqual(["Workbench.exe", "-gproj", "ObserverAcceptance.gproj"]);
    expect(matrix).toEqual(["-plugin=RFO_WorkbenchObserverMatrixPlugin"]);
  });

  it("combines primary, recovery, and private-child supervision exactly once", () => {
    expect(combineWorkbenchObserverAcceptanceProcessCounts(
      { active: 2, reconciling: 3, total: 5 },
      { active: 7, reconciling: 11, total: 13 },
      17
    )).toEqual({
      active: 26,
      reconciling: 14,
      total: 35,
    });
    expect(combineWorkbenchObserverAcceptanceProcessCounts(
      { active: 2, reconciling: 3, total: 5 },
      null,
      17
    )).toEqual({
      active: 19,
      reconciling: 3,
      total: 22,
    });
  });

  it("keeps positive and matrix composition in the shared runtime owner", () => {
    const runtime = readFileSync(resolve("scripts/workbench-observer-acceptance-runtime.ts"), "utf8");
    const runner = readFileSync(resolve("scripts/run-workbench-observer-acceptance.ts"), "utf8");
    const liveCase = readFileSync(resolve("scripts/workbench-observer-live-matrix-case.ts"), "utf8");
    const orchestration = `${runner}\n${liveCase}`;

    expect(runtime.match(/new WorkbenchClient\(/g)).toHaveLength(2);
    expect(runtime.match(/new WorkbenchProcessGuard\(/g)).toHaveLength(1);
    expect(runtime.match(/new WindowsLifecycleBackend\(/g)).toHaveLength(1);
    expect(runtime.match(/createObserverApplication\(\{/g)).toHaveLength(1);
    expect(orchestration).not.toMatch(/new (?:WorkbenchClient|WorkbenchProcessGuard|WindowsLifecycleBackend)\(/);
    expect(orchestration).not.toContain("createObserverApplication({");
    expect(runner).toContain("new WorkbenchObserverAcceptanceRuntime");
    expect(liveCase).toContain("new WorkbenchObserverAcceptanceRuntime");
  });
});
