#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;

function directWindowsNpmCli() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const where = spawnSync("where.exe", ["npm.cmd"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (!where.error && where.status === 0) {
    for (const npmShim of where.stdout.split(/\r?\n/).filter(Boolean)) {
      candidates.push(join(dirname(npmShim), "node_modules", "npm", "bin", "npm-cli.js"));
    }
  }
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved) return resolved;
  throw new Error(
    "Could not locate npm-cli.js for a shell-free package check; run `npm run test:package` " +
      "or install npm beside the active Node executable."
  );
}

const npmCliPath = npmExecPath ?? directWindowsNpmCli();
const npmCommand = process.execPath;
const npmCache = process.env.REFORGER_FORGE_NPM_CACHE
  ?? join(tmpdir(), "reforger-forge-npm-cache");
const npmEnvironment = {
  ...process.env,
  npm_config_cache: npmCache,
  npm_config_fund: "false",
  npm_config_audit: "false",
  npm_config_update_notifier: "false",
};
const temporaryRoot = mkdtempSync(join(tmpdir(), "reforger-forge-package-smoke-"));
const packDestination = join(temporaryRoot, "pack");
const installRoot = join(temporaryRoot, "installed-project");
mkdirSync(packDestination, { recursive: true });
mkdirSync(installRoot, { recursive: true });

function npmRun(argumentsArray, options = {}) {
  return spawnSync(
    npmCommand,
    [npmCliPath, ...argumentsArray],
    {
      cwd: options.cwd ?? root,
      encoding: "utf8",
      env: options.env ?? npmEnvironment,
      input: options.input,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    }
  );
}

function boundedOutput(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= 4_000) return text;
  return `${text.slice(0, 4_000)}\n... output truncated ...`;
}

function commandFailure(label, result, hint = "") {
  if (result.error?.code === "ETIMEDOUT") {
    return new Error(`${label} exceeded its bounded execution timeout.${hint}`);
  }
  if (result.error) {
    return new Error(`${label} could not start: ${result.error.message}.${hint}`);
  }
  const diagnostics = [
    boundedOutput(result.stdout) && `stdout:\n${boundedOutput(result.stdout)}`,
    boundedOutput(result.stderr) && `stderr:\n${boundedOutput(result.stderr)}`,
  ].filter(Boolean).join("\n");
  return new Error(
    `${label} exited with status ${result.status ?? "unknown"}.${hint}` +
      (diagnostics ? `\n${diagnostics}` : "")
  );
}

function assertContained(rootPath, candidatePath, label) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) {
    return;
  }
  throw new Error(`${label} escapes its installed package root: ${candidatePath}`);
}

try {
  // `test:package` builds first. Ignoring pack-time lifecycle scripts avoids a
  // redundant second build while still installing the exact produced tarball.
  const pack = npmRun([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDestination,
  ]);
  if (pack.error || pack.status !== 0) {
    throw commandFailure("npm pack", pack);
  }

  let report;
  try {
    report = JSON.parse(pack.stdout);
  } catch (error) {
    throw new Error(
      `Could not parse npm pack JSON: ${String(error)}\nstdout:\n${boundedOutput(pack.stdout)}`
    );
  }

const files = new Set((report[0]?.files ?? []).map((file) => file.path));
const requiredFiles = [
  "LICENSE",
  "README.md",
  "RELEASE_NOTES_v1.1.0.md",
  "dist/index.js",
  "dist/observer/agent/artifacts.js",
  "dist/observer/agent/application.js",
  "dist/observer/agent/application-operations.js",
  "dist/observer/agent/evidence-bundle-service.js",
  "dist/observer/agent/index.js",
  "dist/observer/agent/jobs.js",
  "dist/observer/agent/mailbox-coordinator.js",
  "dist/observer/agent/private-child.js",
  "dist/observer/agent/registry.js",
  "dist/observer/agent/sessions.js",
  "dist/observer/application.js",
  "dist/observer/agent-client.js",
  "dist/observer/capture-contract.js",
  "dist/observer/capture-job-store.js",
  "dist/observer/capture-request.js",
  "dist/observer/capture-service.js",
  "dist/observer/coordinator.js",
  "dist/observer/evidence-run-service.js",
  "dist/observer/host-diagnostics.js",
  "dist/observer/launch.js",
  "dist/observer/owned-runtime-manager.js",
  "dist/observer/setup.js",
  "dist/observer/tools.js",
  "dist/observer/runtime-capture-backend.js",
  "dist/observer/workbench-capture-backend.js",
  "dist/observer/world-revision.js",
  "dist/observer/protocol/index.js",
  "dist/tools/observer-runtime.js",
  "dist/tools/wb-shutdown.js",
  "dist/foundation/child-supervisor.js",
  "dist/workbench/activity-gate.js",
  "dist/workbench/client.js",
  "dist/workbench/diagnostics.js",
  "dist/workbench/helper-addon.js",
  "dist/workbench/launch-plan.js",
  "dist/workbench/lifecycle-execution.js",
  "dist/workbench/managed-build-profile.js",
  "dist/workbench/net-api-client.js",
  "dist/workbench/observer-adapter.js",
  "dist/workbench/process-guard.js",
  "dist/workbench/project-identity.js",
  "dist/workbench/readiness.js",
  "dist/workbench/runner-cli.js",
  "dist/workbench/runner.js",
  "dist/workbench/session-controller.js",
  "dist/workbench/session-state.js",
  "configs/claude-desktop.json",
  "configs/cursor-global.json",
  "docs/AGENTS.md",
  "observer/README.md",
  "observer/addon/addon.gproj",
  "observer/addon/.reforger-forge-observer-source.json",
  "observer/workbench-addon/addon.gproj",
  "observer/workbench-addon/.reforger-forge-workbench-helper-source.json",
  "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/RFWB_HelperBuild.c",
  "observer/protocol/VERSION",
  "observer/protocol/capabilities.md",
  "observer/protocol/errors.md",
  "observer/protocol/generated/capabilities.json",
  "observer/protocol/generated/error-codes.json",
  "observer/protocol/generated/fixed-error-messages.json",
  "observer/protocol/generated/runtime-error-codes.json",
  "observer/protocol/schemas/session-contract.schema.json",
  "observer/protocol/schemas/instance-registration.schema.json",
  "observer/protocol/schemas/heartbeat.schema.json",
  "observer/protocol/schemas/capture-request.schema.json",
  "observer/protocol/schemas/job-status.schema.json",
  "observer/protocol/schemas/artifact-manifest.schema.json",
  "observer/protocol/schemas/error.schema.json",
  "observer/protocol/schemas/vocabulary.schema.json",
  "package.json",
  "reforger-forge.config.example.json",
  "scripts/check-package.mjs",
  "scripts/install-agents.ps1",
  "scripts/list-tools.mjs",
  "scripts/run-observer-enforce-mailbox-acceptance.mjs",
  "scripts/update-observer-source-manifest.mjs",
  "scripts/setup.ps1",
  "scripts/windows/workbench-lifecycle.ps1",
  "tests/fixtures/enforce-mailbox-acceptance-addon/addon.gproj",
  "tests/fixtures/enforce-mailbox-acceptance-addon/Scripts/WorkbenchGame/RFO_MailboxAcceptancePlugin.c",
];
const requiredPrefixes = ["configs/", "data/", "observer/workbench-addon/"];
const requiredObserverScripts = [
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverBuild.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverCameraLease.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapabilities.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverCapture.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverJob.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverJson.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverMailboxTransport.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverRestTransport.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverService.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverSession.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverTime.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverTransport.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverWorld.c",
  "Scripts/Game/ReforgerForgeObserver/RFO_ObserverBootstrap.c",
].map((path) => `observer/addon/${path}`);
const requiredHandlers = [
  "EMCP_WB_Clipboard.c",
  "EMCP_WB_Components.c",
  "EMCP_WB_CreateEntity.c",
  "EMCP_WB_DeleteEntity.c",
  "EMCP_WB_EditorControl.c",
  "EMCP_WB_ExecuteAction.c",
  "EMCP_WB_GetCameraPos.c",
  "EMCP_WB_GetEntity.c",
  "EMCP_WB_GetState.c",
  "EMCP_WB_Layers.c",
  "EMCP_WB_ListEntities.c",
  "EMCP_WB_Localization.c",
  "EMCP_WB_ModifyEntity.c",
  "EMCP_WB_ObserverCancel.c",
  "EMCP_WB_ObserverCommon.c",
  "EMCP_WB_ObserverPing.c",
  "EMCP_WB_ObserverRelease.c",
  "EMCP_WB_ObserverStatus.c",
  "EMCP_WB_ObserverSubmit.c",
  "EMCP_WB_Ping.c",
  "EMCP_WB_Prefabs.c",
  "EMCP_WB_Reload.c",
  "EMCP_WB_Resources.c",
  "EMCP_WB_ScriptEditor.c",
  "EMCP_WB_SelectEntity.c",
  "EMCP_WB_Terrain.c",
].map((name) => `observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/${name}`);

const missingFiles = requiredFiles.filter((path) => !files.has(path));
const missingPrefixes = requiredPrefixes.filter(
  (prefix) => ![...files].some((path) => path.startsWith(prefix))
);
const handlerPrefix = "observer/workbench-addon/Scripts/WorkbenchGame/EnfusionMCP/";
const requiredHelperScripts = [
  ...requiredHandlers,
  `${handlerPrefix}RFWB_HelperBuild.c`,
].sort();
const packagedHandlers = [...files]
  .filter((path) => path.startsWith(handlerPrefix) && path.toLowerCase().endsWith(".c"))
  .sort();
const missingHandlers = requiredHandlers.filter((path) => !files.has(path));
const unexpectedHandlers = packagedHandlers.filter((path) => !requiredHelperScripts.includes(path));
const missingObserverScripts = requiredObserverScripts.filter((path) => !files.has(path));
const legacyPackagedHandlers = [...files].filter((path) =>
  path.startsWith("mod/Scripts/WorkbenchGame/EnfusionMCP/")
);
const repositoryOnlyAcceptanceSources = [
  "scripts/observer-live-acceptance-support.ts",
  "scripts/run-runtime-observer-acceptance.ts",
  "scripts/run-workbench-build-acceptance.ts",
  "scripts/run-workbench-observer-acceptance.ts",
];
const packagedRepositoryOnlySources = repositoryOnlyAcceptanceSources.filter((path) =>
  files.has(path)
);
const duplicateSharedBuildFiles = [...files].filter((path) =>
  path.startsWith("dist/src/foundation/") || path.startsWith("dist/src/companions/")
);
const forbiddenObserverFiles = [...files].filter((path) =>
  path.startsWith("tests/observer/") ||
  path.startsWith("observer/artifacts/") ||
  path.startsWith("observer/addons/") ||
  path.startsWith("observer/state/") ||
  path.startsWith("observer/profiles/") ||
  (path.startsWith("observer/") && /(^|\/)session\.json$/i.test(path)) ||
  (path.startsWith("observer/") && /(^|\/)resourceDatabase\.rdb$/i.test(path)) ||
  (path.startsWith("observer/") && /\.(bmp|png)$/i.test(path))
);

if (missingFiles.length || missingPrefixes.length || missingHandlers.length || unexpectedHandlers.length || missingObserverScripts.length || legacyPackagedHandlers.length || packagedRepositoryOnlySources.length || duplicateSharedBuildFiles.length || forbiddenObserverFiles.length) {
  const details = [
    ...missingFiles.map((path) => `missing file: ${path}`),
    ...missingPrefixes.map((prefix) => `missing package content under: ${prefix}`),
    ...missingHandlers.map((path) => `missing supported handler: ${path}`),
    ...unexpectedHandlers.map((path) => `unexpected packaged handler: ${path}`),
    ...missingObserverScripts.map((path) => `missing observer addon script: ${path}`),
    ...legacyPackagedHandlers.map((path) => `legacy project-injection handler must not be packaged: ${path}`),
    ...packagedRepositoryOnlySources.map((path) =>
      `repository-only TypeScript acceptance harness must not be packaged: ${path}`
    ),
    ...duplicateSharedBuildFiles.map((path) =>
      `duplicate shared TypeScript build output must not be packaged: ${path}`
    ),
    ...forbiddenObserverFiles.map((path) => `forbidden observer runtime artifact: ${path}`),
  ];
  throw new Error(`Package content check failed:\n${details.map((line) => `  - ${line}`).join("\n")}`);
}

  const packedFilename = report[0]?.filename;
  if (typeof packedFilename !== "string" || packedFilename.length === 0) {
    throw new Error("npm pack did not report the produced tarball filename");
  }
  const tarballPath = resolve(packDestination, packedFilename);
  assertContained(packDestination, tarballPath, "Packed tarball");
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack reported a tarball that does not exist: ${tarballPath}`);
  }

  writeFileSync(
    join(installRoot, "package.json"),
    `${JSON.stringify({
      name: "reforger-forge-installed-package-smoke",
      version: "0.0.0",
      private: true,
    }, null, 2)}\n`,
    "utf8"
  );
  const install = npmRun([
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    tarballPath,
  ], {
    cwd: installRoot,
    timeout: 300_000,
  });
  if (install.error || install.status !== 0) {
    throw commandFailure(
      "Fresh npm install --omit=dev of the packed tarball",
      install,
      ` The smoke install uses isolated cache ${npmCache}; ensure the registry is reachable ` +
        "or set REFORGER_FORGE_NPM_CACHE to a writable, pre-warmed cache."
    );
  }

  const sourceManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (typeof sourceManifest.name !== "string" || !sourceManifest.name) {
    throw new Error("Source package manifest has no package name");
  }
  const packageNameParts = sourceManifest.name.split("/");
  if (packageNameParts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Source package name cannot be resolved safely: ${sourceManifest.name}`);
  }
  const installedPackageRoot = join(installRoot, "node_modules", ...packageNameParts);
  const installedManifestPath = join(installedPackageRoot, "package.json");
  if (!existsSync(installedManifestPath)) {
    throw new Error(
      `Fresh production install did not contain package ${sourceManifest.name} at ${installedPackageRoot}`
    );
  }
  const installedManifest = JSON.parse(readFileSync(installedManifestPath, "utf8"));
  const advertisedBins = typeof installedManifest.bin === "string"
    ? { [installedManifest.name]: installedManifest.bin }
    : installedManifest.bin;
  if (!advertisedBins || typeof advertisedBins !== "object" || Array.isArray(advertisedBins)) {
    throw new Error("Installed package does not advertise any executable bins");
  }

  const safeInvocations = new Map([
    ["reforger-forge-mcp", { arguments: [], input: "" }],
    ["reforger-forge-workbench", {
      arguments: ["--version"],
      expectedStdout: installedManifest.version,
    }],
  ]);
  const evidenceRoot = join(temporaryRoot, "bin-runtime", "evidence");
  const supportingLogRoot = join(temporaryRoot, "bin-runtime", "supporting-logs");
  mkdirSync(evidenceRoot, { recursive: true });
  mkdirSync(supportingLogRoot, { recursive: true });
  const probeEnvironment = {
    ...npmEnvironment,
    REFORGER_FORGE_OBSERVER_ROOT: join(temporaryRoot, "bin-runtime", "observer"),
    REFORGER_FORGE_OBSERVER_PROFILE_ROOT: join(
      temporaryRoot,
      "bin-runtime",
      "observer",
      "profiles"
    ),
    REFORGER_FORGE_OBSERVER_AGENT_PATH: join(
      installedPackageRoot,
      "dist",
      "observer",
      "agent",
      "private-child.js"
    ),
    REFORGER_FORGE_OBSERVER_EVIDENCE_ROOTS: evidenceRoot,
    REFORGER_FORGE_OBSERVER_SUPPORTING_LOG_ROOTS: supportingLogRoot,
    ENFUSION_PROJECT_PATH: join(temporaryRoot, "bin-runtime", "project"),
    ENFUSION_GAME_PATH: join(temporaryRoot, "bin-runtime", "game"),
    ENFUSION_WORKBENCH_PATH: join(temporaryRoot, "bin-runtime", "workbench"),
  };

  for (const [binName, target] of Object.entries(advertisedBins)) {
    if (typeof target !== "string" || target.length === 0) {
      throw new Error(`Advertised bin "${binName}" has an invalid target`);
    }
    const invocation = safeInvocations.get(binName);
    if (!invocation) {
      throw new Error(
        `Advertised bin "${binName}" has no defined safe installed-package smoke invocation`
      );
    }
    const targetPath = resolve(installedPackageRoot, target);
    assertContained(installedPackageRoot, targetPath, `Advertised bin "${binName}"`);
    if (!existsSync(targetPath)) {
      throw new Error(`Advertised bin "${binName}" is missing its installed target: ${target}`);
    }
    const shimName = `${binName}.cmd`;
    const shimPath = join(installRoot, "node_modules", ".bin", shimName);
    if (!existsSync(shimPath)) {
      throw new Error(`Fresh install did not create the advertised bin shim "${binName}"`);
    }

    // npm exec is rooted at the fresh project and forced offline. The shim
    // existence check above prevents npm from falling back to a registry copy.
    const probe = npmRun([
      "exec",
      "--offline",
      "--yes=false",
      "--",
      binName,
      ...invocation.arguments,
    ], {
      cwd: installRoot,
      env: probeEnvironment,
      input: invocation.input,
      timeout: 30_000,
    });
    const combinedOutput = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
    const missingModuleMatch = combinedOutput.match(
      /Cannot find (?:package|module)\s+['"]([^'"]+)['"]/i
    );
    const hasModuleResolutionFailure = missingModuleMatch
      || /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(combinedOutput);
    if (hasModuleResolutionFailure) {
      throw new Error(
        `Installed bin "${binName}" could not resolve module ` +
          `"${missingModuleMatch?.[1] ?? "<not identified by Node>"}".\n` +
          `stderr:\n${boundedOutput(probe.stderr)}`
      );
    }
    if (probe.error || probe.status !== 0) {
      throw commandFailure(`Installed bin "${binName}" smoke invocation`, probe);
    }
    if (
      invocation.expectedStdout !== undefined
      && probe.stdout.trim() !== invocation.expectedStdout
    ) {
      throw new Error(
        `Installed bin "${binName}" returned unexpected stdout; expected ` +
          `${JSON.stringify(invocation.expectedStdout)}, received ` +
          `${JSON.stringify(boundedOutput(probe.stdout))}`
      );
    }
  }

  const installedAgentPath = join(
    installedPackageRoot,
    "dist",
    "observer",
    "agent",
    "index.js"
  );
  const versionCheck = spawnSync(process.execPath, [installedAgentPath, "--version"], {
    cwd: installRoot,
    encoding: "utf8",
    env: probeEnvironment,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (versionCheck.error || versionCheck.status !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(versionCheck.stdout)) {
    throw commandFailure(
      "Installed observer agent non-network --version check",
      versionCheck
    );
  }

  const missingDoctorRoot = join(temporaryRoot, "installed-doctor", "missing-root");
  const missingDoctorProfile = join(temporaryRoot, "installed-doctor", "missing-profile");
  const doctorCheck = spawnSync(process.execPath, [
    installedAgentPath,
    "doctor",
    "--root",
    missingDoctorRoot,
    "--profile-root",
    missingDoctorProfile,
  ], {
    cwd: installRoot,
    encoding: "utf8",
    env: probeEnvironment,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let doctorResult;
  try { doctorResult = JSON.parse(doctorCheck.stdout); } catch { doctorResult = null; }
  if (doctorCheck.error || doctorCheck.status !== 0 || doctorResult?.readOnly !== true ||
      existsSync(missingDoctorRoot) || existsSync(missingDoctorProfile)) {
    throw commandFailure("Installed observer agent read-only doctor check", doctorCheck);
  }

  console.log(
    `Package tarball verified: ${files.size} files; fresh --omit=dev install and ` +
      `${Object.keys(advertisedBins).length} advertised bins passed.`
  );
} finally {
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
