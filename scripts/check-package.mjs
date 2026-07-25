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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_SOURCE_MANIFEST_BYTES,
  verifyPackedArchiveAddonInventory,
  verifyPackagedAddonInventory,
} from "./lib/addon-inventory.mjs";
import { inspectPackedArchive } from "./lib/packed-archive.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npmExecPath = process.env.npm_execpath;
const enforceContractDescriptorPath = "observer/protocol/generated/enforce-contract.json";
const packedEnforceContractDescriptorPath = `package/${enforceContractDescriptorPath}`;

function isNormalizedPackagePath(value) {
  return typeof value === "string" && value.length > 0 &&
    /^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function readPackedEnforceContractTargets(packedArchive) {
  const descriptorText = packedArchive.textEntries.get(packedEnforceContractDescriptorPath);
  if (typeof descriptorText !== "string") {
    throw new Error(`Packed package is missing ${enforceContractDescriptorPath}`);
  }

  let descriptor;
  try {
    descriptor = JSON.parse(descriptorText);
  } catch (error) {
    throw new Error(
      `Packed Enforce contract descriptor is malformed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) ||
      !descriptor.targets || typeof descriptor.targets !== "object" || Array.isArray(descriptor.targets)) {
    throw new Error("Packed Enforce contract descriptor has no target map");
  }

  const targetEntries = Object.entries(descriptor.targets);
  if (targetEntries.length === 0) {
    throw new Error("Packed Enforce contract descriptor has no generated targets");
  }
  const outputPaths = new Set();
  return targetEntries.map(([targetName, target]) => {
    const outputPath = target?.outputPath;
    if (typeof targetName !== "string" || targetName.length === 0 ||
        !target || typeof target !== "object" || Array.isArray(target) ||
        !isNormalizedPackagePath(outputPath) || !outputPath.endsWith(".c")) {
      throw new Error(`Packed Enforce contract target ${JSON.stringify(targetName)} is invalid`);
    }
    if (outputPaths.has(outputPath.toLowerCase())) {
      throw new Error(`Packed Enforce contract repeats generated target path: ${outputPath}`);
    }
    outputPaths.add(outputPath.toLowerCase());
    return Object.freeze({ name: targetName, outputPath });
  });
}

/**
 * The tarball descriptor is the sole inventory of generated Enforce C files.
 * Its target path must be both present in the archive and declared by exactly
 * one of the shipped add-on manifests; no copied C filename list is kept here.
 */
function verifyPackedEnforceProtocolTargets(packedArchive, addonManifests) {
  const targets = readPackedEnforceContractTargets(packedArchive);
  for (const target of targets) {
    if (!packedArchive.files.has(target.outputPath)) {
      throw new Error(
        `Packed Enforce target ${target.name} is absent from the tarball: ${target.outputPath}`
      );
    }
    const candidateManifests = addonManifests.filter(({ addonRoot }) =>
      target.outputPath.startsWith(`${addonRoot}/`)
    );
    if (candidateManifests.length !== 1) {
      throw new Error(
        `Packed Enforce target ${target.name} does not belong to exactly one add-on manifest: ` +
        target.outputPath
      );
    }
    const [{ addonRoot, manifestName, manifest }] = candidateManifests;
    const payloadPath = target.outputPath.slice(addonRoot.length + 1);
    if (!manifest.files.some((entry) => entry.path === payloadPath)) {
      throw new Error(
        `Packed Enforce target ${target.name} is not declared by ${addonRoot}/${manifestName}: ` +
        payloadPath
      );
    }
  }
  return targets;
}

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

function configuredNpmCache() {
  const inheritedCache = process.env.npm_config_cache?.trim();
  if (inheritedCache) return inheritedCache;

  const config = spawnSync(
    npmCommand,
    [npmCliPath, "config", "get", "cache"],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 }
  );
  if (!config.error && config.status === 0) {
    const configuredCache = config.stdout.trim();
    if (configuredCache) return configuredCache;
  }

  return join(root, ".npm-cache");
}

function isWritableCache(cachePath) {
  try {
    mkdirSync(cachePath, { recursive: true });
    const probePath = mkdtempSync(join(cachePath, ".reforger-forge-cache-probe-"));
    rmSync(probePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Reuse npm's normal cache by default so repeated package smoke checks do not
// redownload the production dependency tree. Package verification is offline
// by default; set REFORGER_FORGE_NPM_ONLINE=1 for an explicit cache-warming run.
const explicitNpmCache = process.env.REFORGER_FORGE_NPM_CACHE?.trim();
const configuredCache = configuredNpmCache();
const npmCache = explicitNpmCache
  ?? (isWritableCache(configuredCache) ? configuredCache : join(root, ".npm-cache"));
if (!isWritableCache(npmCache)) {
  throw new Error(
    `Npm cache is not writable: ${npmCache}. Set REFORGER_FORGE_NPM_CACHE to a writable ` +
    "directory and retry."
  );
}
const allowNetwork = process.env.REFORGER_FORGE_NPM_ONLINE === "1";
const npmEnvironment = {
  ...process.env,
  npm_config_cache: npmCache,
  npm_config_offline: allowNetwork ? (process.env.npm_config_offline ?? "false") : "true",
  npm_config_prefer_offline: "true",
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

  const packedFilename = report[0]?.filename;
  if (typeof packedFilename !== "string" || packedFilename.length === 0) {
    throw new Error("npm pack did not report the produced tarball filename");
  }
  const tarballPath = resolve(packDestination, packedFilename);
  assertContained(packDestination, tarballPath, "Packed tarball");
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack reported a tarball that does not exist: ${tarballPath}`);
  }
  const packedArchive = await inspectPackedArchive({
    tarballPath,
    tarballRoot: packDestination,
    packagePrefix: "package/",
    maximumEntryBytes: MAX_SOURCE_MANIFEST_BYTES,
    textEntries: [
      "package/observer/addon/.reforger-forge-observer-source.json",
      "package/observer/workbench-addon/.reforger-forge-workbench-helper-source.json",
      packedEnforceContractDescriptorPath,
    ],
  });
  const packedAddonManifests = [
    {
      addonRoot: "observer/addon",
      manifestName: ".reforger-forge-observer-source.json",
      displayName: "Packed observer add-on",
      allowedGeneratedFiles: new Set(["resourceDatabase.rdb"]),
    },
    {
      addonRoot: "observer/workbench-addon",
      manifestName: ".reforger-forge-workbench-helper-source.json",
      displayName: "Packed Workbench helper add-on",
      role: "workbench-helper",
      allowedGeneratedFiles: new Set(["resourceDatabase.rdb"]),
    },
  ].map((options) => ({
    ...options,
    manifest: verifyPackedArchiveAddonInventory(packedArchive, options),
  }));
  const packedEnforceTargets = verifyPackedEnforceProtocolTargets(
    packedArchive,
    packedAddonManifests
  );
  const files = new Set(packedArchive.files.keys());
const requiredFiles = [
  "LICENSE",
  "README.md",
  "setup.md",
  "docs/release-notes/RELEASE_NOTES_v1.1.0.md",
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
  "dist/foundation/public-json.js",
  "dist/foundation/redact.js",
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
  "dist/workbench/process-guard.js",
  "dist/workbench/project-identity.js",
  "dist/workbench/readiness.js",
  "dist/workbench/runner-cli.js",
  "dist/workbench/runner.js",
  "dist/workbench/session-controller.js",
  "dist/workbench/session-state.js",
  "dist/setup/client-registration.js",
  "dist/setup/doctor.js",
  "dist/setup/doctor-cli.js",
  "dist/setup/register-clients-cli.js",
  "dist/setup/server-verification.js",
  "dist/setup/setup-receipt.js",
  "dist/setup/setup-receipt-cli.js",
  "agents/AGENTS.md",
  "agents/README.md",
  "agents/configs/claude-desktop.json",
  "agents/configs/cursor-global.json",
  "agents/configs/stdio-template.json",
  "agents/configs/vscode-template.json",
  "agents/install-agents.ps1",
  "observer/README.md",
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
  "scripts/lib/addon-inventory.mjs",
  "scripts/lib/packed-archive.mjs",
  "scripts/verify-mcp-server.mjs",
  "scripts/run-observer-enforce-mailbox-acceptance.mjs",
  "scripts/update-observer-source-manifest.mjs",
  "scripts/setup.ps1",
  "scripts/windows/workbench-lifecycle.ps1",
  "tests/fixtures/enforce-mailbox-acceptance-addon/addon.gproj",
  "tests/fixtures/enforce-mailbox-acceptance-addon/Scripts/WorkbenchGame/RFO_MailboxAcceptancePlugin.c",
];
const requiredPrefixes = ["agents/configs/", "data/"];

const missingFiles = requiredFiles.filter((path) => !files.has(path));
const missingPrefixes = requiredPrefixes.filter(
  (prefix) => ![...files].some((path) => path.startsWith(prefix))
);
const legacyPackagedHandlers = [...files].filter((path) =>
  path.startsWith("mod/Scripts/WorkbenchGame/EnfusionMCP/")
);
const repositoryOnlyAcceptanceSources = [
  "scripts/observer-live-acceptance-support.ts",
  "scripts/observer-workbench-failure-support.ts",
  "scripts/run-runtime-observer-acceptance.ts",
  "scripts/run-workbench-build-acceptance.ts",
  "scripts/run-workbench-observer-acceptance.ts",
  "scripts/workbench-observer-acceptance-adapter.ts",
  "scripts/workbench-observer-acceptance-runtime.ts",
  "scripts/workbench-observer-live-matrix-case.ts",
  "scripts/workbench-observer-matrix-case.ts",
  "tests/fixtures/workbench-observer-failure-matrix-addon",
  "tests/fixtures/workbench-observer-failure-matrix-decoy.mjs",
];
const packagedRepositoryOnlySources = [...files].filter((file) =>
  repositoryOnlyAcceptanceSources.some((path) => file === path || file.startsWith(`${path}/`))
);
const duplicateSharedBuildFiles = [...files].filter((path) =>
  path.startsWith("dist/src/foundation/") || path.startsWith("dist/src/companions/")
);
const permittedGeneratedAddonFiles = new Set([
  "observer/addon/resourceDatabase.rdb",
  "observer/workbench-addon/resourceDatabase.rdb",
]);
const forbiddenObserverFiles = [...files].filter((path) =>
  path.startsWith("tests/observer/") ||
  path.startsWith("observer/artifacts/") ||
  path.startsWith("observer/addons/") ||
  path.startsWith("observer/state/") ||
  path.startsWith("observer/profiles/") ||
  (path.startsWith("observer/") && /(^|\/)session\.json$/i.test(path)) ||
  (path.startsWith("observer/") && /(^|\/)resourceDatabase\.rdb$/i.test(path) &&
    !permittedGeneratedAddonFiles.has(path)) ||
  (path.startsWith("observer/") && /\.(bmp|png)$/i.test(path))
);
const forbiddenObserverFacade = files.has("dist/observer/coordinator.js");

if (missingFiles.length || missingPrefixes.length || legacyPackagedHandlers.length || packagedRepositoryOnlySources.length || duplicateSharedBuildFiles.length || forbiddenObserverFiles.length || forbiddenObserverFacade) {
  const details = [
    ...missingFiles.map((path) => `missing file: ${path}`),
    ...missingPrefixes.map((prefix) => `missing package content under: ${prefix}`),
    ...legacyPackagedHandlers.map((path) => `legacy project-injection handler must not be packaged: ${path}`),
    ...packagedRepositoryOnlySources.map((path) =>
      `repository-only acceptance material must not be packaged: ${path}`
    ),
    ...duplicateSharedBuildFiles.map((path) =>
      `duplicate shared TypeScript build output must not be packaged: ${path}`
    ),
    ...forbiddenObserverFiles.map((path) => `forbidden observer runtime artifact: ${path}`),
    ...(forbiddenObserverFacade ? ["deleted observer facade must not be packaged: dist/observer/coordinator.js"] : []),
  ];
  throw new Error(`Package content check failed:\n${details.map((line) => `  - ${line}`).join("\n")}`);
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
      ` The smoke install uses npm cache ${npmCache} in ` +
        `${allowNetwork ? "network-enabled" : "offline"} mode; ` +
        (allowNetwork
          ? "ensure the registry is reachable or set REFORGER_FORGE_NPM_CACHE to a writable, pre-warmed cache."
          : "populate it once with REFORGER_FORGE_NPM_ONLINE=1, then retry offline.")
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
  verifyPackagedAddonInventory(join(installedPackageRoot, "observer", "addon"), {
    manifestName: ".reforger-forge-observer-source.json",
    displayName: "Packaged observer add-on",
  });
  verifyPackagedAddonInventory(join(installedPackageRoot, "observer", "workbench-addon"), {
    manifestName: ".reforger-forge-workbench-helper-source.json",
    displayName: "Packaged Workbench helper add-on",
    role: "workbench-helper",
  });
  const advertisedBins = typeof installedManifest.bin === "string"
    ? { [installedManifest.name]: installedManifest.bin }
    : installedManifest.bin;
  if (!advertisedBins || typeof advertisedBins !== "object" || Array.isArray(advertisedBins)) {
    throw new Error("Installed package does not advertise any executable bins");
  }

  const binRuntimeRoot = join(temporaryRoot, "bin-runtime");
  const workbenchRoot = join(binRuntimeRoot, "workbench");
  const gameRoot = join(binRuntimeRoot, "game");
  const projectRoot = join(binRuntimeRoot, "project");
  const observerRoot = join(binRuntimeRoot, "observer");
  const observerProfileRoot = join(observerRoot, "profiles");
  const evidenceRoot = join(binRuntimeRoot, "evidence");
  const supportingLogRoot = join(binRuntimeRoot, "supporting-logs");
  for (const directory of [
    workbenchRoot,
    join(workbenchRoot, "Workbench"),
    gameRoot,
    join(gameRoot, "addons"),
    projectRoot,
    observerRoot,
    observerProfileRoot,
    evidenceRoot,
    supportingLogRoot,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(
    join(workbenchRoot, "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
    "",
    "utf8"
  );
  writeFileSync(join(gameRoot, "ArmaReforgerSteam.exe"), "", "utf8");
  const installedConfigurationPath = join(binRuntimeRoot, "reforger-forge.json");
  writeFileSync(
    installedConfigurationPath,
    `${JSON.stringify({
      workbenchPath: workbenchRoot,
      gamePath: gameRoot,
      projectPath: projectRoot,
      observer: {
        managedRoot: observerRoot,
        profileRoot: observerProfileRoot,
        agentPath: join(
          installedPackageRoot,
          "dist",
          "observer",
          "agent",
          "private-child.js"
        ),
        evidenceRoots: [evidenceRoot],
        supportingLogRoots: [supportingLogRoot],
      },
    }, null, 2)}\n`,
    "utf8"
  );
  const safeInvocations = new Map([
    ["reforger-forge-mcp", {
      arguments: ["--config", installedConfigurationPath],
      input: "",
    }],
    ["reforger-forge-workbench", {
      arguments: ["--version"],
      expectedStdout: installedManifest.version,
    }],
  ]);
  const probeEnvironment = { ...npmEnvironment };
  for (const key of [
    "ENFUSION_WORKBENCH_PATH",
    "ENFUSION_PROJECT_PATH",
    "ENFUSION_GAME_PATH",
    "ENFUSION_EXTRACTED_PATH",
    "ENFUSION_MCP_DATA_DIR",
    "ENFUSION_WORKBENCH_HOST",
    "ENFUSION_WORKBENCH_PORT",
    "ENFUSION_DEFAULT_MOD",
    "REFORGER_FORGE_DEBUG",
    "REFORGER_FORGE_WORKBENCH_LOG_ROOT",
    "REFORGER_FORGE_OBSERVER_ROOT",
    "REFORGER_FORGE_OBSERVER_PROFILE_ROOT",
    "REFORGER_FORGE_OBSERVER_AGENT_PATH",
    "REFORGER_FORGE_OBSERVER_EVIDENCE_ROOTS",
    "REFORGER_FORGE_OBSERVER_SUPPORTING_LOG_ROOTS",
    "REFORGER_FORGE_OBSERVER_STARTUP_TIMEOUT_MS",
    "REFORGER_FORGE_OBSERVER_REQUEST_TIMEOUT_MS",
    "REFORGER_FORGE_OBSERVER_CAPTURE_TIMEOUT_MS",
    "REFORGER_FORGE_OBSERVER_MAX_INLINE_IMAGE_BYTES",
    "REFORGER_FORGE_OBSERVER_RETENTION_INTERVAL_MS",
    "REFORGER_FORGE_OBSERVER_RETENTION_MAX_AGE_MS",
    "REFORGER_FORGE_OBSERVER_RETENTION_MAX_BYTES",
    "REFORGER_FORGE_OBSERVER_SESSION_TTL_MS",
  ]) {
    delete probeEnvironment[key];
  }

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

  const publicContractPath = join(installedPackageRoot, "dist", "observer", "public-contract.js");
  const publicProjectionProbe = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { projectPublicObserverToolError } from ${JSON.stringify(pathToFileURL(publicContractPath).href)};
const details = {}; details.self = details;
const text = projectPublicObserverToolError({}, {
  subject: "Observer error",
  extract: () => ({
    code: "INVALID_REQUEST",
    readDiagnosticMessage: () => "installed package probe",
    readDetails: () => details,
  }),
});
const fence = String.fromCharCode(96).repeat(3) + "json";
if (!text.includes("[REDACTED:CYCLE]") || !text.includes(fence)) process.exitCode = 1;`,
  ], {
    cwd: installRoot,
    encoding: "utf8",
    env: probeEnvironment,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (publicProjectionProbe.error || publicProjectionProbe.status !== 0) {
    throw commandFailure("Installed public observer error projection probe", publicProjectionProbe);
  }

  const mailboxAcceptanceScript = join(
    installedPackageRoot,
    "scripts",
    "run-observer-enforce-mailbox-acceptance.mjs"
  );
  const mailboxHelp = spawnSync(process.execPath, [mailboxAcceptanceScript, "--help"], {
    cwd: installRoot,
    encoding: "utf8",
    env: probeEnvironment,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (mailboxHelp.error || mailboxHelp.status !== 0 ||
      !mailboxHelp.stdout.includes("run-observer-enforce-mailbox-acceptance.mjs")) {
    throw commandFailure(
      "Installed mailbox acceptance built-foundation import check",
      mailboxHelp
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
      `${Object.keys(advertisedBins).length} advertised bins, ${packedEnforceTargets.length} descriptor-derived ` +
      `Enforce target(s), plus the public projection and mailbox acceptance import checks passed.`
  );
} finally {
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
