import { describe, expect, it } from "vitest";
import {
  expectedStateVersion,
  lifecycleStateDraft,
  sameLifecycleAuthority,
  toLifecycleTarget,
  type WorkbenchLifecycleTarget,
} from "../../src/workbench/session-state.js";
import type { WorkbenchLifecycleStateV3 } from "../../src/workbench/process-guard.js";

function state(overrides: Partial<WorkbenchLifecycleStateV3> = {}): WorkbenchLifecycleStateV3 {
  const target: WorkbenchLifecycleTarget = { path: "C:\\mods\\Example\\Example.gproj", comparisonKey: "example" };
  return {
    version: 3,
    generation: "generation-1",
    phase: "running",
    endpoint: { host: "127.0.0.1", port: 5775 },
    target,
    mcpOwner: {
      pid: 10,
      executablePath: "C:\\node.exe",
      creationTime: "owner-created",
      instanceId: "instance",
      leaseId: "lease",
      userSid: "sid",
      claimedAtMs: 1,
    },
    workbench: {
      pid: 20,
      executablePath: "C:\\Workbench.exe",
      creationTime: "child-created",
      ownerTokenArgument: "-reforgerForgeOwnerToken=secret",
      launchedAtMs: 2,
    },
    companion: null,
    operation: null,
    ...overrides,
  };
}

describe("Workbench session state helpers", () => {
  it("converts rich project identity into the persisted v3 target shape", () => {
    expect(toLifecycleTarget({
      displayPath: "C:\\mods\\Example\\Example.gproj",
      comparisonKey: "example",
      modDirectory: "C:\\mods\\Example",
      modDirectoryKey: "example-dir",
    })).toEqual({ path: "C:\\mods\\Example\\Example.gproj", comparisonKey: "example" });
  });

  it("projects the exact expected generation and lease", () => {
    expect(expectedStateVersion(state())).toEqual({ generation: "generation-1", leaseId: "lease" });
  });

  it("preserves explicit null transition fields", () => {
    const draft = lifecycleStateDraft(state(), { target: null, workbench: null, operation: null });
    expect(draft.target).toBeNull();
    expect(draft.workbench).toBeNull();
    expect(draft.operation).toBeNull();
  });

  it("compares the complete lifecycle publication authority", () => {
    const baseline = state();
    expect(sameLifecycleAuthority(baseline, structuredClone(baseline))).toBe(true);
    expect(sameLifecycleAuthority(baseline, state({ generation: "generation-2" }))).toBe(false);
    expect(sameLifecycleAuthority(baseline, state({
      workbench: { ...baseline.workbench!, creationTime: "replacement" },
    }))).toBe(false);
  });
});
