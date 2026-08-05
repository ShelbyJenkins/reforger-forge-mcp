import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKBENCH_HELPER_ADDON_GUID,
  WORKBENCH_HELPER_ADDON_ID,
  WORKBENCH_HELPER_BUILD_IDENTITY,
  WORKBENCH_HELPER_HANDLER_FILES,
  verifyWorkbenchHelperSource,
} from "../../src/workbench/helper-addon.js";
import { verifySourceBundle } from "../../observer/agent/staging.js";
import { observerAddonSource, repositoryRoot } from "../support/observer-fixtures.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnforceContractTargets(): Array<{ name: string; outputPath: string }> {
  const descriptor = JSON.parse(readFileSync(
    join(repositoryRoot, "observer", "protocol", "generated", "enforce-contract.json"),
    "utf8"
  )) as unknown;
  if (!isRecord(descriptor) || !isRecord(descriptor.targets)) {
    throw new Error("Generated Enforce contract descriptor has no target map");
  }
  const targets = Object.entries(descriptor.targets).map(([name, target]) => {
    if (!isRecord(target) || typeof target.outputPath !== "string") {
      throw new Error(`Generated Enforce contract target ${JSON.stringify(name)} has no output path`);
    }
    return { name, outputPath: target.outputPath };
  });
  if (targets.length === 0) {
    throw new Error("Generated Enforce contract descriptor has no targets");
  }
  return targets;
}

const addonManifestTargets = [
  {
    addonRoot: "observer/addon",
    manifestName: ".reforger-forge-observer-source.json",
  },
  {
    addonRoot: "observer/workbench-addon",
    manifestName: ".reforger-forge-workbench-helper-source.json",
  },
] as const;

function manifestForEnforceTarget(outputPath: string) {
  const matches = addonManifestTargets.filter(({ addonRoot }) =>
    outputPath.startsWith(`${addonRoot}/`)
  );
  if (matches.length !== 1) {
    throw new Error(`Generated Enforce output has no unique add-on manifest: ${outputPath}`);
  }
  const [target] = matches;
  return {
    ...target,
    payloadPath: outputPath.slice(target.addonRoot.length + 1),
  };
}

describe("observer package and source contracts", () => {
  it("rejects stale native config loaders and stale aggregate target artifacts", () => {
    const enforce = readFileSync(
      join(repositoryRoot, "scripts", "validate-observer-enforce.mjs"),
      "utf8"
    );
    const mailbox = readFileSync(
      join(repositoryRoot, "scripts", "run-observer-enforce-mailbox-acceptance.mjs"),
      "utf8"
    );

    for (const source of [enforce, mailbox]) {
      expect(source).toContain("EXPLICIT_CONFIGURATION_CONTRACT_VERSION !== 3");
      expect(source).toContain("Compiled configuration loader is older than src/config.ts");
      expect(source).toContain('loadConfig(argumentsArray)');
    }
    expect(enforce).toContain("const aggregateRunId = randomUUID()");
    expect(enforce).toContain(
      "`${options.artifactPath}.${aggregateRunId}.${target}.json`"
    );
    expect(enforce).not.toContain(
      "const targetArtifactPath = `${options.artifactPath}.${target}.json`"
    );
  });

  it("keeps observer and MCP builds separate and publishes required runtime assets", () => {
    const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
    expect(packageJson.version).toBe("1.2.0");
    const gitAttributes = readFileSync(join(repositoryRoot, ".gitattributes"), "utf8");
    expect(gitAttributes.split(/\r?\n/)).toContain("observer/addon/** -text");
    expect(gitAttributes.split(/\r?\n/)).toContain("observer/workbench-addon/** -text");
    expect(gitAttributes.split(/\r?\n/)).toContain("* text=auto eol=lf");
    expect(packageJson.scripts.build).toContain("build:mcp");
    expect(packageJson.scripts.build).toContain("build:observer");
    expect(packageJson.scripts["addons:manifest"]).toContain("update-observer-source-manifest.mjs");
    expect(packageJson.scripts["addons:manifest:check"]).toContain("--check");
    expect(packageJson.scripts["observer:manifest"]).toContain("addons:manifest");
    expect(packageJson.scripts["observer:manifest:check"]).toContain("addons:manifest:check");
    const observerGenerate = packageJson.scripts["observer:generate"];
    expect(observerGenerate).toContain("protocol:generate");
    expect(observerGenerate).toContain("observer:manifest");
    expect(observerGenerate.indexOf("protocol:generate")).toBeLessThan(
      observerGenerate.indexOf("observer:manifest")
    );
    const enforceValidation = packageJson.scripts["observer:validate:enforce"];
    expect(enforceValidation).toContain("validate-observer-enforce.mjs");
    expect(enforceValidation).not.toMatch(/\b(?:npm\s+run\s+)?build\b/);
    expect(packageJson.devDependencies.tar).toBe("7.5.19");
    expect(packageJson.dependencies.tar).toBeUndefined();
    expect(packageJson.dependencies["@napi-rs/image"]).toBe("1.14.0");
    const packageLock = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"));
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(packageLock.packages["node_modules/@napi-rs/image"]).toMatchObject({ version: "1.14.0" });
    expect(packageLock.packages["node_modules/@napi-rs/image-win32-x64-msvc"]).toMatchObject({
      version: "1.14.0",
      os: ["win32"],
      cpu: ["x64"],
    });
    expect(Object.keys(packageJson.scripts).filter((name) =>
      name.startsWith("observer:acceptance:")
    )).toEqual([
      "observer:acceptance:enforce-mailbox",
    ]);
    expect(Object.keys(packageJson.scripts).filter((name) =>
      name.startsWith("dev:observer:acceptance:")
    )).toEqual([
      "dev:observer:acceptance:workbench",
      "dev:observer:acceptance:runtime",
    ]);
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "dist",
      "observer/addon",
      "observer/workbench-addon",
      "observer/protocol",
      "observer/README.md",
      "SETUP.md",
      "docs/observer.md",
      "docs/release-notes/RELEASE_NOTES_v1.2.0.md",
      "docs/runner-cli.md",
      "contributing.md",
    ]));
    expect(packageJson.files).not.toContain("mod");
    const observerReleaseAssets = [
      "scripts/run-observer-enforce-mailbox-acceptance.mjs",
      "scripts/update-observer-source-manifest.mjs",
      "scripts/lib/packed-archive.mjs",
      "tests/fixtures/enforce-mailbox-acceptance-addon/addon.gproj",
      "tests/fixtures/enforce-mailbox-acceptance-addon/Scripts/WorkbenchGame/RFO_MailboxAcceptancePlugin.c",
    ];
    const repositoryOnlyAcceptanceSources = [
      "scripts/observer-live-acceptance-support.ts",
      "scripts/observer-workbench-failure-support.ts",
      "scripts/run-runtime-observer-acceptance.ts",
      "scripts/run-workbench-observer-acceptance.ts",
      "scripts/workbench-observer-acceptance-adapter.ts",
      "scripts/workbench-observer-acceptance-runtime.ts",
      "scripts/workbench-observer-live-matrix-case.ts",
      "scripts/workbench-observer-matrix-case.ts",
      "tests/fixtures/workbench-observer-failure-matrix-addon",
      "tests/fixtures/workbench-observer-failure-matrix-decoy.mjs",
    ];
    expect(packageJson.files).toEqual(expect.arrayContaining(observerReleaseAssets));
    expect(packageJson.files).toEqual(expect.not.arrayContaining(repositoryOnlyAcceptanceSources));
    const observerConfig = JSON.parse(readFileSync(join(repositoryRoot, "observer", "tsconfig.build.json"), "utf8"));
    expect(observerConfig.compilerOptions.rootDir).toBe("..");
    expect(observerConfig.compilerOptions.outDir).toBe("../dist");
    expect(observerConfig.include).toEqual(["agent/**/*.ts"]);
    expect(observerConfig.references).toEqual(expect.arrayContaining([
      { path: "../tsconfig.shared.build.json" },
      { path: "./protocol/tsconfig.build.json" },
    ]));
    const sharedConfig = JSON.parse(readFileSync(join(repositoryRoot, "tsconfig.shared.build.json"), "utf8"));
    expect(sharedConfig.include).toEqual([
      "src/foundation/**/*.ts",
      "src/companions/**/*.ts",
      "src/mcp-host-admission.ts",
      "src/mcp-idle-readiness.ts",
    ]);
    const mcpConfig = JSON.parse(readFileSync(join(repositoryRoot, "tsconfig.build.json"), "utf8"));
    expect(mcpConfig.include).toEqual(["src/**/*"]);
    expect(mcpConfig.references).toEqual(expect.arrayContaining([
      { path: "./tsconfig.shared.build.json" },
      { path: "./observer/protocol/tsconfig.build.json" },
    ]));
    expect(packageJson.imports["#foundation/*"].default).toBe("./dist/foundation/*.js");
    expect(packageJson.imports["#companions/*"].default).toBe("./dist/companions/*.js");
    expect(existsSync(join(repositoryRoot, "dist", "src"))).toBe(false);
    expect(existsSync(join(repositoryRoot, "observer", "protocol", "VERSION"))).toBe(true);
    const packageCheck = readFileSync(join(repositoryRoot, "scripts", "check-package.mjs"), "utf8");
    expect(packageCheck).toContain("docs/release-notes/RELEASE_NOTES_v1.2.0.md");
    const serverEntry = readFileSync(join(repositoryRoot, "src", "index.ts"), "utf8");
    const stdioComposition = readFileSync(
      join(repositoryRoot, "src", "mcp-stdio-server.ts"),
      "utf8",
    );
    expect(stdioComposition).toContain(
      `export const MCP_SERVER_VERSION = "${packageJson.version}"`
    );
    expect(serverEntry).toContain("const SERVER_VERSION = MCP_SERVER_VERSION");
    expect(packageCheck).toContain("dist/observer/agent/private-child.js");
    expect(packageCheck).toContain("dist/observer/agent/application.js");
    expect(packageCheck).toContain("dist/observer/agent/application-operations.js");
    expect(packageCheck).toContain("dist/observer/agent/evidence-bundle-service.js");
    expect(packageCheck).toContain("dist/observer/application.js");
    expect(packageCheck).toContain("deleted observer facade must not be packaged");
    expect(packageCheck).toContain('files.has("dist/observer/coordinator.js")');
    expect(packageCheck).toContain("dist/observer/capture-service.js");
    expect(packageCheck).toContain("dist/observer/evidence-run-service.js");
    expect(packageCheck).toContain("dist/observer/owned-runtime-manager.js");
    expect(packageCheck).toContain("dist/tools/observer-runtime.js");
    for (const module of [
      "dist/foundation/child-supervisor.js",
      "dist/workbench/activity-gate.js",
      "dist/workbench/client.js",
      "dist/workbench/diagnostics.js",
      "dist/workbench/helper-addon.js",
      "dist/workbench/helper-addon-payload.generated.js",
      "dist/workbench/launch-plan.js",
      "dist/workbench/lifecycle-execution.js",
      "dist/workbench/managed-build-profile.js",
      "dist/workbench/net-api-client.js",
      "dist/workbench/observer-adapter.js",
      "dist/workbench/observer-artifact-envelope.js",
      "dist/workbench/readiness.js",
      "dist/workbench/session-controller.js",
      "dist/workbench/session-state.js",
    ]) {
      expect(packageCheck).toContain(module);
    }
    expect(packageCheck).toContain("legacy project-injection handler must not be packaged");
    expect(packageCheck).toContain("resourceDatabase\\.rdb");
    expect(packageCheck).toContain("inspectPackedArchive");
    expect(packageCheck).toContain("verifyPackedArchiveAddonInventory");
    expect(packageCheck).toContain("MAX_SOURCE_MANIFEST_BYTES");
    expect(packageCheck).toContain("enforceContractDescriptorPath");
    expect(packageCheck).toContain("verifyPackedEnforceProtocolTargets");
    expect(packageCheck).not.toContain("report[0]?.files");
    expect(packageCheck).toContain("--omit=dev");
    expect(packageCheck).toContain("--offline");
    expect(packageCheck).toContain("npm-cli.js");
    expect(packageCheck).not.toContain("shell:");
    for (const module of ["artifacts", "jobs", "mailbox-coordinator", "registry", "sessions"]) {
      expect(packageCheck).toContain(`dist/observer/agent/${module}.js`);
    }
    for (const path of [...observerReleaseAssets, ...repositoryOnlyAcceptanceSources]) {
      expect(packageCheck).toContain(path);
    }
    const manifestGenerator = readFileSync(
      join(repositoryRoot, "scripts", "update-observer-source-manifest.mjs"),
      "utf8"
    );
    expect(manifestGenerator).toContain(".reforger-forge-observer-source.json");
    expect(manifestGenerator).toContain(".reforger-forge-workbench-helper-source.json");
    expect(manifestGenerator).toContain("RFWB_HelperBuild.c");
    expect(verifySourceBundle(observerAddonSource).manifest.files.length).toBeGreaterThan(10);
  });

  it("derives generated Enforce payload inclusion from the contract descriptor", () => {
    const targets = readEnforceContractTargets();
    expect(targets).toHaveLength(2);
    const packageCheck = readFileSync(join(repositoryRoot, "scripts", "check-package.mjs"), "utf8");

    for (const { name, outputPath } of targets) {
      const { addonRoot, manifestName, payloadPath } = manifestForEnforceTarget(outputPath);
      const manifest = JSON.parse(readFileSync(
        join(repositoryRoot, ...addonRoot.split("/"), manifestName),
        "utf8"
      )) as { files?: Array<{ path?: string }> };

      expect(existsSync(join(repositoryRoot, ...outputPath.split("/")))).toBe(true);
      expect(manifest.files?.some((entry) => entry.path === payloadPath)).toBe(true);
      // Package verification reads this descriptor and derives each target; it
      // must not maintain a second copied generated-C filename list.
      expect(packageCheck).not.toContain(outputPath);
      expect(packageCheck).not.toContain(outputPath.split("/").at(-1) ?? "");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("publishes ten observer primitives plus the separate owned game composite", () => {
    const expected = [
      "observer_capture",
      "observer_instances",
      "observer_job",
      "observer_prepare_launch",
      "observer_run_begin",
      "observer_run_discard",
      "observer_run_finalize",
      "observer_run_status",
      "observer_runtime",
      "observer_setup",
    ];
    const serverVerifier = [
      readFileSync(
        join(repositoryRoot, "scripts", "verify-mcp-server.mjs"),
        "utf8"
      ),
      readFileSync(
        join(repositoryRoot, "src", "setup", "server-verification.ts"),
        "utf8"
      ),
    ].join("\n");
    const observerBlock =
      serverVerifier.match(
        /const REQUIRED_OBSERVER_TOOLS = \[([\s\S]*?)\] as const;/
      )?.[1] ?? "";
    const discovered = [...observerBlock.matchAll(/"(observer_[a-z_]+)"/g)]
      .map((match) => match[1])
      .sort();
    expect(discovered).toEqual(expected);
    const compositeBlock = serverVerifier.match(
      /const REQUIRED_OBSERVER_COMPOSITES = \[([\s\S]*?)\] as const;/,
    )?.[1] ?? "";
    expect(compositeBlock).toContain('"game_launch"');

    const observerGuide = readFileSync(join(repositoryRoot, "docs", "observer.md"), "utf8");
    for (const name of expected) expect(observerGuide).toContain(`\`${name}\``);
    expect(observerGuide).toContain("`game_launch`");
    expect(observerGuide).toContain("expectedWorldRevision");
    expect(observerGuide).not.toContain("expectedWorldId");
    expect(observerGuide).not.toContain("expectedWorldEpoch");

    const observerReadme = readFileSync(join(repositoryRoot, "observer", "README.md"), "utf8");
    expect(observerReadme).toContain("Observer exposes ten related `observer_*` primitives plus the separate");
    expect(observerReadme).toContain("observer_runtime");
    expect(observerReadme).toContain("game_launch");
    expect(observerReadme).toContain("terminal restoration");
    expect(observerReadme).toContain("exact matching persisted receipt");

    const agentInstructions = readFileSync(join(repositoryRoot, "agents", "AGENTS.md"), "utf8");
    expect(agentInstructions).toContain("observer_runtime");
    expect(agentInstructions).toContain("game_launch");
    expect(agentInstructions).toContain("preparedLaunchId");
  });

  it("derives the Workbench handler inventory from the generated payload descriptor", () => {
    const helperSource = join(repositoryRoot, "observer", "workbench-addon");
    const handlerRoot = join(helperSource, "Scripts", "WorkbenchGame", "EnfusionMCP");
    const handlerFiles = readdirSync(handlerRoot)
      .filter((name) => name.startsWith("EMCP_WB_") && name.endsWith(".c"))
      .filter((name) => /class\s+\w+\s*:\s*NetApiHandler\b/.test(
        readFileSync(join(handlerRoot, name), "utf8")
      ))
      .sort();
    expect(handlerFiles).toEqual([...WORKBENCH_HELPER_HANDLER_FILES].sort());
    expect(WORKBENCH_HELPER_HANDLER_FILES.every((name) => name.startsWith("EMCP_WB_"))).toBe(true);
    const observerHandlers = handlerFiles.filter((name) => /Observer/.test(name))
      .map((name) => readFileSync(join(handlerRoot, name), "utf8"))
      .join("\n");
    expect(observerHandlers).not.toContain("?");
    expect(observerHandlers).not.toMatch(/ParseVector\([^\n]*matrix\[/);

    const helper = verifyWorkbenchHelperSource(helperSource).manifest;
    expect(helper.role).toBe("workbench-helper");
    expect(helper.addonId).toBe(WORKBENCH_HELPER_ADDON_ID);
    expect(helper.addonGuid).toBe(WORKBENCH_HELPER_ADDON_GUID);
    expect(helper.buildIdentity).toBe(WORKBENCH_HELPER_BUILD_IDENTITY);
    expect(helper.files.length).toBeGreaterThan(WORKBENCH_HELPER_HANDLER_FILES.length);
    expect(helper.files.some((entry) => entry.path.startsWith("Scripts/Game/"))).toBe(false);

    const ping = readFileSync(join(handlerRoot, "EMCP_WB_Ping.c"), "utf8");
    for (const field of [
      "helperAddonId",
      "helperAddonGuid",
      "helperAddonVersion",
      "helperProtocolVersion",
      "workbenchProtocol",
      "helperBuildIdentity",
    ]) expect(ping).toContain(field);
  });

  it("packages and centrally registers the observer integration", () => {
    const observerSource = join(repositoryRoot, "src", "observer");
    for (const name of ["application.ts", "agent-client.ts", "capture-service.ts", "evidence-run-service.ts", "setup.ts", "launch.ts", "owned-runtime-manager.ts", "tools.ts"]) {
      expect(existsSync(join(observerSource, name))).toBe(true);
    }
    expect(existsSync(join(observerSource, "coordinator.ts"))).toBe(false);
    expect(existsSync(join(repositoryRoot, "src", "tools", "observer-runtime.ts"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "observer", "agent", "private-child.ts"))).toBe(true);
    const server = readFileSync(join(repositoryRoot, "src", "server.ts"), "utf8");
    expect(server.match(/createObserverApplication\(/g)).toHaveLength(1);
    expect(server).not.toMatch(/new ObserverCoordinator\(|new OwnedRuntimeManager\(/);
    expect(server.match(/registerObserverTools\(/g)).toHaveLength(1);
    expect(server).toContain("return disposeObserverLifecycle");
    expect(server).toContain("activeObserverShutdown");
    expect(server).toContain("terminalObserverShutdown");
    expect(server).toContain("emergencyTerminate");
    expect(server).not.toContain(".server.onclose");
    expect(server).not.toContain("protocolServer");
    const entrypoint = readFileSync(join(repositoryRoot, "src", "index.ts"), "utf8");
    const stdioComposition = readFileSync(
      join(repositoryRoot, "src", "mcp-stdio-server.ts"),
      "utf8",
    );
    expect(entrypoint).toContain("runMcpStdioServer({");
    expect(stdioComposition).toContain("options.stdin.once(\"end\", onStdinEnd)");
    expect(stdioComposition).toContain("options.signals.once(\"SIGINT\", onSigint)");
    expect(stdioComposition).toContain("options.signals.once(\"SIGTERM\", onSigterm)");
    expect(stdioComposition.indexOf("closeProtocol: () => server.close()"))
      .toBeLessThan(stdioComposition.indexOf("disposeTools: (deadlineAtMs) => disposeTools(deadlineAtMs)"));
    expect(stdioComposition).not.toContain("shutdownHold");
    const integrationSource = filesRecursively(observerSource)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(integrationSource).not.toMatch(/WorkbenchProcessGuard|wb_launch|wb_restart|wb_shutdown|wb_cleanup/);
  });

  it("enforces graphical, headless, restoration, and no-Workbench implementation source invariants", () => {
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
    expect(cameraLease).toContain("game.SpawnEntity(RFO_ObserverCamera, world, spawnParams)");
    expect(cameraLease).toContain("CommitPostFrame");
    expect(cameraLease).toContain("CommitRestorationPostFrame");
    expect(cameraLease).toContain("CameraRegistered(manager, original)");
    expect(cameraLease).toContain("bool detachedPlayerCamera");
    expect(cameraLease).toContain("original = playerCamera");
    expect(cameraLease).toContain("detachedPlayerCamera = true");
    expect(cameraLease).toContain("CameraRegistered(manager, observer)");
    expect(cameraLease).toContain("manager.SetCamera(observer)");
    expect(cameraLease).toContain("MaintainRequestedView");
    expect(cameraLease).toContain("AwaitingFirstPostFrameCommit");
    expect(cameraLease).toContain("GetLastCameraFailureReason");
    expect(cameraLease).toContain("m_RFO_UsesDetachedPlayerCamera");
    expect(cameraLease).toContain("RestoreDetachedPlayerCamera");
    expect(cameraLease).toContain("WorldCameraMatches");
    expect(source).toContain("modded class SCR_CameraEditorComponent");
    expect(source).toContain("RFO_ObserverEditorCameraArbitration.CanBeginManagerLease(manager, original)");
    expect(source).toContain("override protected bool TryForceCamera()");
    expect(source).toContain("override protected void OnCameraDectivate()");
    expect(cameraLease).not.toContain("GetCameraNearPlane");
    expect(cameraLease).not.toContain("AcquireWorldCamera");
    expect(cameraLease).toContain("CameraBase playerCamera = FindPlayerCamera()");
    expect(cameraLease).toContain("camera.SetVerticalFOV(fovDegrees)");
    expect(cameraLease).toContain("camera.ApplyTransform(timeSlice)");
    expect(cameraLease).toContain("PublishedCameraMatches");
    expect(cameraLease).toContain("RFO_ObserverCameraProjection.SnapshotCurrent(m_RFO_World");
    expect(cameraLease).not.toContain("SpawnEntityPrefabLocal");
    expect(cameraLease).not.toContain("SpawnEntityPrefab");
    const observerCamera = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCamera.c"), "utf8");
    expect(observerCamera).toContain("void RFO_ObserverCamera(IEntitySource src, IEntity parent)");
    expect(observerCamera).toContain("class RFO_ObserverCamera : CameraBase");
    expect(observerCamera).toContain("EntityEvent.INIT | EntityEvent.POSTFRAME");
    expect(observerCamera).toContain("OnObserverCameraPostFrame(this, owner.GetWorld(), timeSlice)");
    const cameraProjection = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCameraProjection.c"), "utf8");
    expect(cameraProjection).toContain("System.GetRenderingResolution");
    expect(cameraProjection).toContain("ProjectViewportToWorld");
    expect(cameraProjection).toContain("MeasureVerticalFov");
    const capture = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverCapture.c"), "utf8");
    expect(capture).toContain("System.MakeScreenshot(ScreenshotRequestPath(job.jobId))");
    expect(capture).toContain("bool IssueCommitted(");
    expect(capture).toContain("RFO_ObserverCameraProjection.SnapshotCurrent(world, cameraId, actualMatrix, actualFov)");
    expect(capture).toContain('return CAPTURE_DIRECTORY + "/" + jobId + ".bmp"');
    expect(capture).toContain('return CAPTURE_DIRECTORY + "/" + jobId;');
    expect(capture).toContain("GetLastIssueDiagnostic");
    expect(capture).toContain("GetLastPreloadDiagnostic");
    expect(capture).toContain("game.BeginPreload(world, matrix[3], radius)");
    expect(capture).toContain("game.IsPreloadFinished()");
    expect(capture).toContain("MINIMUM_RENDER_READY_MS = 3000");
    expect(capture).toContain("MAX_PRELOAD_RADIUS = 10000.0");
    expect(capture).toContain("System.GetTickCount(m_RFO_RenderReadySinceTick)");
    expect(service).toContain("m_RFO_Capture.GetLastIssueDiagnostic()");
    expect(service).toContain("void OnObserverCameraPostFrame(");
    expect(service).toContain("m_RFO_CameraLease.CommitPostFrame(");
    expect(service).toContain("m_RFO_Capture.IssueCommitted(");
    expect(service).toContain("m_RFO_PostFrameCaptureArmed = true");
    expect(service).toContain("Explicit pose/lookAt requires a leaseable runtime camera");
    expect(service).toContain("RFO_ObserverProtocol.ERROR_CAPABILITY_UNAVAILABLE");
    expect(service).toContain("RFO_ObserverJobState.PRELOADING");
    expect(service).not.toContain("m_RFO_Capture.IsReady() && m_RFO_Capture.RuntimeReady()");
    const job = readFileSync(join(observerAddonSource, "Scripts", "Game", "ReforgerForgeObserver", "RFO_ObserverJob.c"), "utf8");
    expect(job).toContain("class RFO_ObserverCommandWireView");
    expect(job).toContain("view != null && DecodeWireView()");
    expect(source).not.toMatch(/EnfusionMCP|targetProject|outputPath|https:\/\//);
    const workbench = join(observerAddonSource, "Scripts", "WorkbenchGame");
    expect(filesRecursively(workbench).filter((path) => path.endsWith(".c"))).toEqual([]);
  });
});
