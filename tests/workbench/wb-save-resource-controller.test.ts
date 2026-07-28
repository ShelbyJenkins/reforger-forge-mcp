import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { WorkbenchSessionController } from "../../src/workbench/session-controller.js";
import type { WorkbenchNetApiPort } from "../../src/workbench/net-api-client.js";

function config(): Config {
  return {
    workbenchPath: "C:\\Workbench",
    gamePath: "C:\\Game",
    dataDir: "C:\\Data",
    patternsDir: "C:\\Patterns",
    workbenchHost: "127.0.0.1",
    workbenchPort: 5775,
  };
}

describe("WorkbenchSessionController unattended save fail-closed behavior", () => {
  it("never starts lifecycle or NET work", async () => {
    const call = vi.fn(async () => {
      throw new Error("Unattended save must not contact the NET API");
    });
    const netApi: WorkbenchNetApiPort = { call };
    const controller = new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      config(),
      "save-unsupported-test",
      undefined,
      { netApi }
    );

    await expect(controller.saveResource("C:\\Target\\Worlds\\Example.ent")).rejects.toMatchObject({
      code: "TARGET_SESSION_REQUIRED",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("taints and blocks every MCP document-switching handler in a target-bound session", async () => {
    const call = vi.fn(async () => ({ status: "ok" }));
    const controller = new WorkbenchSessionController(
      "127.0.0.1",
      5775,
      config(),
      "target-switch-guard-test",
      undefined,
      { netApi: { call: call as WorkbenchNetApiPort["call"] } }
    );
    const privateController = controller as unknown as {
      explicitResourceSession: { taintedReason: string | null } | null;
    };

    for (const request of [
      { apiFunc: "EMCP_WB_EditorControl", params: { action: "openResource", path: "Worlds/Other.ent" } },
      { apiFunc: "EMCP_WB_Resources", params: { action: "open", path: "Worlds/Other.ent" } },
      { apiFunc: "EMCP_WB_ScriptEditor", params: { action: "openFile", path: "Scripts/Other.c" } },
    ]) {
      privateController.explicitResourceSession = { taintedReason: null };
      await expect(controller.call(request.apiFunc, request.params)).rejects.toMatchObject({
        code: "TARGET_SESSION_TAINTED",
      });
      expect(privateController.explicitResourceSession.taintedReason).toContain("resource-open");
    }
    expect(call).not.toHaveBeenCalled();
  });
});
