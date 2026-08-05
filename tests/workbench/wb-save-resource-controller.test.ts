import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { canonicalizeGproj } from "../../src/workbench/project-identity.js";
import { canonicalizeResourceTarget } from "../../src/workbench/resource-target.js";
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
    mcpIdleShutdownMs: 1_800_000,
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

  it("refuses a vulnerable inherited prefab before dispatching the native save", async () => {
    const root = mkdtempSync(join(tmpdir(), "reforger-forge-empty-override-save-"));
    try {
      const gprojPath = join(root, "Example.gproj");
      const prefabPath = join(root, "Example.et");
      writeFileSync(gprojPath, "GameProject {}\n", "utf8");
      writeFileSync(prefabPath, `GenericEntity : "{1111111111111111}Prefabs/Base.et" {
 components {
  SCR_ScoringSystemComponent "{2222222222222222}" {
   m_aActions {
   }
  }
 }
}\n`, "utf8");
      writeFileSync(`${prefabPath}.meta`, "MetaFileClass {}\n", "utf8");

      const call = vi.fn(async () => ({ status: "ok" }));
      const controller = new WorkbenchSessionController(
        "127.0.0.1",
        5775,
        config(),
        "empty-override-save-test",
        undefined,
        { netApi: { call: call as WorkbenchNetApiPort["call"] } }
      );
      const project = canonicalizeGproj(gprojPath);
      const resource = canonicalizeResourceTarget(prefabPath, project);
      const binding = {
        project,
        resource,
        generation: "generation-1",
        process: {},
        taintedReason: null as string | null,
      };
      const privateController = controller as unknown as {
        explicitResourceSession: typeof binding;
        requireExplicitResourceSession(path: string): Promise<typeof binding>;
      };
      privateController.explicitResourceSession = binding;
      privateController.requireExplicitResourceSession = vi.fn(async () => binding);

      await expect(controller.saveResource(prefabPath)).rejects.toMatchObject({
        code: "TARGET_SESSION_TAINTED",
      });
      expect(call).not.toHaveBeenCalled();
      expect(binding.taintedReason).toContain("empty inherited-prefab overrides");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
