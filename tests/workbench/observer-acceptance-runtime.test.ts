import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkbenchObserverAcceptanceRuntime,
  combineWorkbenchObserverAcceptanceProcessCounts,
  workbenchObserverAcceptanceLaunchArguments,
} from "../../scripts/workbench-observer-acceptance-runtime.js";
import { withTemporaryDirectory } from "../support/temporary-directory.js";

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
    expect(runtime).toContain('loadConfig(["--config", configPath])');
    expect(runtime).not.toContain("LOCAL_CONFIG_PATH");
    expect(runtime).not.toContain("loadConfig()");
  });

  it("rejects an invalid explicit config before creating native run state", async () => {
    await withTemporaryDirectory((root) => {
      const configPath = join(root, "invalid-config.json");
      const runDirectory = join(root, "uncreated-run");
      writeFileSync(configPath, "{}\n", "utf8");

      expect(() => new WorkbenchObserverAcceptanceRuntime({
        configPath,
        runDirectory,
        clientIdPrefix: "invalid-config-test",
        createAdapter: () => {
          throw new Error("adapter construction must not be reached");
        },
      })).toThrow(/required|workbenchPath|projectPath|gamePath/i);
      expect(existsSync(runDirectory)).toBe(false);
    });
  });

  it("preflights explicit config before either top-level harness creates artifacts", () => {
    const runner = readFileSync(resolve("scripts/run-workbench-observer-acceptance.ts"), "utf8");
    const positive = runner.slice(
      runner.indexOf("export async function runWorkbenchObserverAcceptance"),
      runner.indexOf("export interface WorkbenchFailureMatrixOptions")
    );
    const matrix = runner.slice(runner.indexOf("export async function runWorkbenchFailureMatrix"));

    for (const source of [positive, matrix]) {
      expect(source.indexOf("loadAcceptanceBaseConfig(options.configPath)")).toBeGreaterThanOrEqual(0);
      expect(source.indexOf("loadAcceptanceBaseConfig(options.configPath)"))
        .toBeLessThan(source.indexOf("const artifactRoot = canonicalDirectory("));
    }
  });
});
