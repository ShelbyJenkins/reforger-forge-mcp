import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { ChildSupervisor } from "../../src/foundation/child-supervisor.js";
import {
  createWorkbenchServerComposition,
} from "../../src/server.js";
import { WorkbenchActivityGate } from "../../src/workbench/activity-gate.js";
import { WorkbenchNetApiClient } from "../../src/workbench/net-api-client.js";
import { WorkbenchProcessGuard } from "../../src/workbench/process-guard.js";
import { WorkbenchSessionController } from "../../src/workbench/session-controller.js";
import { WorkbenchLifecycleExecution } from "../../src/workbench/lifecycle-execution.js";
import { WorkbenchHelperStager } from "../../src/workbench/helper-addon.js";
import { diagnoseWorkbench } from "../../src/workbench/diagnostics.js";
import { createMcpHostIdentity } from "../../src/mcp-host-identity.js";

function config(): Config {
  return {
    workbenchPath: process.cwd(),
    gamePath: process.cwd(),
    dataDir: process.cwd(),
    patternsDir: process.cwd(),
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
}

describe("Workbench server composition", () => {
  it("injects one explicit lifecycle dependency graph into the shared controller", () => {
    const hostIdentity = createMcpHostIdentity({
      clientLabel: "codex",
      instanceId: "00112233-4455-4677-8899-aabbccddeeff",
      startedAt: "2026-08-05T12:34:56.789Z",
    });
    const composition = createWorkbenchServerComposition(config(), hostIdentity);
    const controller = composition.client as unknown as {
      processGuard: WorkbenchProcessGuard;
      netApi: WorkbenchNetApiClient;
      activityGate: WorkbenchActivityGate;
      childSupervisor: ChildSupervisor;
      runnerLifecycleExecution: WorkbenchLifecycleExecution;
      diagnosticsService: typeof diagnoseWorkbench;
      hostIdentity: typeof hostIdentity;
    };

    expect(composition.client).toBeInstanceOf(WorkbenchSessionController);
    expect(composition.hostIdentity).toEqual(hostIdentity);
    expect(composition.processGuard).toBeInstanceOf(WorkbenchProcessGuard);
    expect(composition.netApi).toBeInstanceOf(WorkbenchNetApiClient);
    expect(composition.activityGate).toBeInstanceOf(WorkbenchActivityGate);
    expect(composition.childSupervisor).toBeInstanceOf(ChildSupervisor);
    expect(composition.companionProvider).toBeInstanceOf(WorkbenchHelperStager);
    expect(composition.lifecycleExecution).toBeInstanceOf(WorkbenchLifecycleExecution);
    expect(composition.diagnostics).toBe(diagnoseWorkbench);
    expect(controller.processGuard).toBe(composition.processGuard);
    expect(controller.netApi).toBe(composition.netApi);
    expect(controller.activityGate).toBe(composition.activityGate);
    expect(controller.childSupervisor).toBe(composition.childSupervisor);
    expect(controller.runnerLifecycleExecution).toBe(composition.lifecycleExecution);
    expect(controller.diagnosticsService).toBe(composition.diagnostics);
    expect(controller.hostIdentity).toEqual(hostIdentity);
    expect(composition.processGuard.mcpInstanceId).toBe(hostIdentity.instanceId);
    expect(Object.isFrozen(composition)).toBe(true);
  });
});
