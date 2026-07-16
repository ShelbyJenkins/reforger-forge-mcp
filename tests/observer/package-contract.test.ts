import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_HANDLER_FILES } from "../../src/workbench/handler-bundle.js";
import { verifySourceBundle } from "../../observer/agent/staging.js";
import { observerAddonSource, repositoryRoot } from "./helpers.js";

function filesRecursively(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

describe("observer package and source contracts", () => {
  it("keeps observer and MCP builds separate and publishes required runtime assets", () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
    expect(packageJson.scripts.build).toContain("build:mcp");
    expect(packageJson.scripts.build).toContain("build:observer");
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "observer/addon", "observer/protocol", "observer/README.md"]));
    const observerReleaseScripts = [
      "scripts/run-observer-ai-stress-acceptance.ts",
      "scripts/run-workbench-observer-acceptance.ts",
      "scripts/update-observer-source-manifest.mjs",
    ];
    expect(packageJson.files).toEqual(expect.arrayContaining(observerReleaseScripts));
    const observerConfig = JSON.parse(readFileSync(join(repositoryRoot, "observer", "tsconfig.build.json"), "utf8"));
    expect(observerConfig.compilerOptions.outDir).toBe("../dist/observer");
    expect(JSON.parse(readFileSync(join(repositoryRoot, "tsconfig.build.json"), "utf8")).include).toEqual(["src/**/*"]);
    expect(existsSync(join(repositoryRoot, "observer", "protocol", "VERSION"))).toBe(true);
    const packageCheck = readFileSync(join(repositoryRoot, "scripts", "check-package.mjs"), "utf8");
    expect(packageCheck).toContain("dist/observer/agent/private-child.js");
    expect(packageCheck).toContain("dist/workbench/observer-adapter.js");
    for (const path of observerReleaseScripts) expect(packageCheck).toContain(path);
    expect(verifySourceBundle(observerAddonSource).manifest.files.length).toBeGreaterThan(10);
  });

  it("preserves the exact Workbench handler inventory", () => {
    expect(REQUIRED_HANDLER_FILES).toHaveLength(26);
    expect(REQUIRED_HANDLER_FILES.filter((name) => /Observer/.test(name)).sort()).toEqual([
      "EMCP_WB_ObserverCancel.c",
      "EMCP_WB_ObserverCommon.c",
      "EMCP_WB_ObserverPing.c",
      "EMCP_WB_ObserverRelease.c",
      "EMCP_WB_ObserverStatus.c",
      "EMCP_WB_ObserverSubmit.c",
    ]);
    const handlerFiles = readdirSync(join(repositoryRoot, "mod", "Scripts", "WorkbenchGame", "EnfusionMCP"))
      .filter((name) => name.endsWith(".c"))
      .sort();
    expect(handlerFiles).toEqual([...REQUIRED_HANDLER_FILES].sort());
    const observerHandlers = handlerFiles.filter((name) => /Observer/.test(name))
      .map((name) => readFileSync(join(repositoryRoot, "mod", "Scripts", "WorkbenchGame", "EnfusionMCP", name), "utf8"))
      .join("\n");
    expect(observerHandlers).not.toContain("?");
    expect(observerHandlers).not.toMatch(/ParseVector\([^\n]*matrix\[/);
  });

  it("packages and centrally registers the completed Phase H integration", () => {
    const observerSource = join(repositoryRoot, "src", "observer");
    for (const name of ["coordinator.ts", "setup.ts", "launch.ts", "tools.ts"]) {
      expect(existsSync(join(observerSource, name))).toBe(true);
    }
    expect(existsSync(join(repositoryRoot, "observer", "agent", "private-child.ts"))).toBe(true);
    const server = readFileSync(join(repositoryRoot, "src", "server.ts"), "utf8");
    expect(server.match(/new ObserverCoordinator\(/g)).toHaveLength(1);
    expect(server.match(/registerObserverTools\(/g)).toHaveLength(1);
    const integrationSource = filesRecursively(observerSource)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(integrationSource).not.toMatch(/WorkbenchProcessGuard|wb_launch|wb_restart|wb_shutdown|wb_cleanup/);
  });

  it("enforces dormant, headless, restoration, and no-Workbench implementation source invariants", () => {
    const addonFiles = filesRecursively(observerAddonSource);
    const source = addonFiles.filter((path) => path.endsWith(".c")).map((path) => readFileSync(path, "utf8")).join("\n");
    const bootstrap = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverBootstrap.c"), "utf8");
    const capabilities = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCapabilities.c"), "utf8");
    expect(bootstrap).toContain("super.OnAfterInit(world)");
    expect(bootstrap).toContain("super.OnGameStart()");
    expect(bootstrap).toContain("super.OnUpdate(world, timeslice)");
    expect(bootstrap).toContain("super.OnGameEnd()");
    expect(capabilities).toContain("System.IsConsoleApp()");
    expect(capabilities).toContain("RENDER_CAPTURE_PROVEN = true");
    expect(capabilities).toContain("CAMERA_RESTORE_PROVEN = true");
    expect(source).toContain("RestoreBeforeTerminal");
    const service = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverService.c"), "utf8");
    expect(service).toContain('m_RFO_InstanceId = "runtime-" + m_RFO_Session.sessionId');
    expect(service).toContain("m_RFO_InstanceNonce = m_RFO_Session.launchNonce");
    expect(service).not.toMatch(/m_RFO_InstanceNonce\s*=\s*string\.Format/);
    const cameraLease = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCameraLease.c"), "utf8");
    expect(cameraLease).not.toMatch(/!\s*[^\n]*SetCamera\(/);
    expect(cameraLease).toContain("CurrentCamera() != m_RFO_OriginalCamera");
    expect(cameraLease).toContain("m_RFO_ObserverCamera = original");
    expect(cameraLease).toContain("MaintainRequestedView");
    expect(cameraLease).not.toContain("SpawnEntityPrefabLocal");
    const capture = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCapture.c"), "utf8");
    expect(capture).toContain("System.MakeScreenshot(ScreenshotRequestPath(job.jobId))");
    expect(capture).toContain('return CAPTURE_DIRECTORY + "/" + jobId + ".bmp"');
    expect(capture).toContain('return CAPTURE_DIRECTORY + "/" + jobId;');
    const job = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverJob.c"), "utf8");
    expect(job).toContain("class RFO_ObserverCommandWireView");
    expect(job).toContain("view != null && DecodeWireView()");
    expect(source).not.toMatch(/RoadblockRunners|EnfusionMCP|targetProject|outputPath|https:\/\//);
    const workbench = join(observerAddonSource, "Scripts", "WorkbenchGame");
    expect(filesRecursively(workbench).filter((path) => path.endsWith(".c"))).toEqual([]);
  });
});
