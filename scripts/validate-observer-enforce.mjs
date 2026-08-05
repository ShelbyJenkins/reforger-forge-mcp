import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { redactText } from "#foundation/redact";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultArtifactPath = join(repositoryRoot, ".artifacts", "observer-enforce-compile.json");
const runtimeAddonProjectPath = join(repositoryRoot, "observer", "addon", "addon.gproj");
const workbenchAddonProjectPath = join(repositoryRoot, "observer", "workbench-addon", "addon.gproj");
const enforceTargets = {
  runtime: {
    addonProjectPath: runtimeAddonProjectPath,
    addonRoot: dirname(runtimeAddonProjectPath),
    manifestPath: join(repositoryRoot, "observer", "addon", ".reforger-forge-observer-source.json"),
    requiredSourcePath: join(
      repositoryRoot,
      "observer",
      "addon",
      "Scripts",
      "Game",
      "ReforgerForgeObserver",
      "RFO_ObserverProtocol.c"
    ),
    moduleName: "Game",
    stageDirectory: "ReforgerForgeObserver",
  },
  workbench: {
    addonProjectPath: workbenchAddonProjectPath,
    addonRoot: dirname(workbenchAddonProjectPath),
    manifestPath: join(repositoryRoot, "observer", "workbench-addon", ".reforger-forge-workbench-helper-source.json"),
    requiredSourcePath: join(
      repositoryRoot,
      "observer",
      "workbench-addon",
      "Scripts",
      "WorkbenchGame",
      "EnfusionMCP",
      "EMCP_WB_ObserverProtocol.c"
    ),
    moduleName: "WorkbenchGame",
    stageDirectory: "ReforgerForgeWorkbenchHelper",
  },
};
const enforceContractValidatorPath = join(repositoryRoot, "scripts", "validate-observer-enforce-contract.mjs");
const workbenchExecutableName = "ArmaReforgerWorkbenchSteamDiag.exe";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const result = {
    artifactPath: defaultArtifactPath,
    configPath: null,
    configuration: "PC",
    timeoutMs: 180_000,
    workbenchPath: null,
    addonDirectories: [],
    target: "both",
    protocolOnly: false,
  };
  const seen = new Set();
  const repeatable = new Set(["--addons-dir"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--") && !repeatable.has(argument)) {
      if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`);
      seen.add(argument);
    }
    const value = argv[index + 1];
    if (["--artifact", "--config", "--configuration", "--timeout-ms", "--workbench", "--addons-dir", "--target"].includes(argument)) {
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
    }
    if (argument === "--artifact") result.artifactPath = resolve(value);
    else if (argument === "--config") result.configPath = resolve(value);
    else if (argument === "--configuration") result.configuration = value;
    else if (argument === "--timeout-ms") result.timeoutMs = Number(value);
    else if (argument === "--workbench") result.workbenchPath = resolve(value);
    else if (argument === "--addons-dir") result.addonDirectories.push(resolve(value));
    else if (argument === "--target") result.target = value;
    else if (argument === "--protocol-only") result.protocolOnly = true;
    else if (argument === "--help") result.help = true;
    else if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    else if (!["--artifact", "--config", "--configuration", "--timeout-ms", "--workbench", "--addons-dir", "--target", "--protocol-only"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!/^[A-Za-z0-9_]{1,32}$/.test(result.configuration)) {
    throw new Error("--configuration must be a bounded Workbench configuration identifier");
  }
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 30_000 || result.timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer from 30000 through 900000");
  }
  if (!["runtime", "workbench", "both"].includes(result.target)) {
    throw new Error("--target must be runtime, workbench, or both");
  }
  if (!result.help && !result.protocolOnly && !result.configPath) {
    throw new Error("Native Enforce validation requires --config <file>");
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function requiredFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
  return path;
}

function resolveWorkbenchExecutable(workbenchPath) {
  const candidates = [
    workbenchPath,
    join(workbenchPath, workbenchExecutableName),
    join(workbenchPath, "Workbench", workbenchExecutableName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile() && basename(candidate).toLowerCase() === workbenchExecutableName.toLowerCase()) {
      return candidate;
    }
  }
  throw new Error(`Could not find ${workbenchExecutableName} beneath the configured Workbench path`);
}

async function loadValidatedConfiguration(options) {
  const compiledConfigPath = join(repositoryRoot, "dist", "config.js");
  const sourceConfigPath = join(repositoryRoot, "src", "config.ts");
  requiredFile(
    compiledConfigPath,
    "Compiled configuration loader (run npm run build before native validation)"
  );
  if (existsSync(sourceConfigPath) &&
      statSync(compiledConfigPath).mtimeMs < statSync(sourceConfigPath).mtimeMs) {
    throw new Error("Compiled configuration loader is older than src/config.ts; run npm run build");
  }
  const {
    EXPLICIT_CONFIGURATION_CONTRACT_VERSION,
    loadConfig,
  } = await import(pathToFileURL(compiledConfigPath).href);
  if (EXPLICIT_CONFIGURATION_CONTRACT_VERSION !== 3) {
    throw new Error("Compiled configuration loader does not implement the required explicit-config contract; run npm run build");
  }
  const argumentsArray = ["--config", options.configPath];
  if (options.workbenchPath) {
    argumentsArray.push("--workbench-path", options.workbenchPath);
  }
  for (const directory of options.addonDirectories) {
    argumentsArray.push("--workbench-addon-dir", directory);
  }
  return loadConfig(argumentsArray);
}

function workbenchIsRunning() {
  const result = spawnSync("tasklist.exe", ["/FI", `IMAGENAME eq ${workbenchExecutableName}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error("Could not prove Workbench process vacancy");
  return result.stdout.toLowerCase().includes(workbenchExecutableName.toLowerCase());
}

function executableVersion(path) {
  const escaped = path.replaceAll("'", "''");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 }
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function boundedTail(value, maximum = 16_384) {
  const text = typeof value === "string" ? value : "";
  return text.length <= maximum ? text : text.slice(-maximum);
}

function portableText(value, replacements) {
  let result = redactText(typeof value === "string" ? value : String(value ?? ""), {
    profile: "evidence_portability",
    replacement: "<redacted>",
  });
  for (const [path, label] of replacements) {
    result = result.replaceAll(path, label);
    result = result.replaceAll(path.replaceAll("\\", "/"), label);
  }
  return result;
}

function collectProfileDiagnostics(root, replacements) {
  const diagnostics = [];
  const pending = [root];
  let inspected = 0;
  while (pending.length > 0 && inspected < 512 && diagnostics.length < 32) {
    const directory = pending.shift();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > 512) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !/\.(?:log|txt)$/i.test(entry.name)) continue;
      try {
        const bytes = readFileSync(path);
        diagnostics.push({
          path: relative(root, path).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: sha256(bytes),
          tail: boundedTail(portableText(bytes.toString("utf8"), replacements)),
        });
      } catch {
        // Diagnostics are supplementary; the process result remains authority.
      }
    }
  }
  return diagnostics;
}

function portableArguments(configuration, addonDirectoryCount, targetSpec) {
  return [
    "-gproj", relative(repositoryRoot, targetSpec.addonProjectPath).replaceAll("\\", "/"),
    "-addonsDir", `<${addonDirectoryCount} configured addon director${addonDirectoryCount === 1 ? "y" : "ies"}>`,
    "-profile", "<temporary isolated profile>",
    "-noThrow",
    "-wbsilent",
    "-wbModule=ScriptEditor",
    "-validate", configuration,
  ];
}

function npmCliInvocation() {
  if (process.platform !== "win32") return { command: "npm", arguments_: [] };
  const candidates = [process.env.npm_execpath];
  candidates.push(join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"));
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
  const npmCliPath = candidates.find((candidate) => typeof candidate === "string" && existsSync(candidate));
  if (!npmCliPath) throw new Error("Could not locate npm-cli.js for protocol source validation");
  return { command: process.execPath, arguments_: [npmCliPath] };
}

function commandOutput(result) {
  return [
    typeof result.stdout === "string" ? result.stdout : "",
    typeof result.stderr === "string" ? result.stderr : "",
    result.error instanceof Error ? result.error.message : "",
  ].filter(Boolean).join("\n").trim();
}

/** Check canonical source drift before descriptor/C drift or a Workbench launch. */
function validateProtocolPreflight(target) {
  const npm = npmCliInvocation();
  const sourceCheck = spawnSync(npm.command, [...npm.arguments_, "run", "protocol:check", "--silent"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (sourceCheck.error || sourceCheck.status !== 0) {
    fail(`PROTOCOL_SOURCE_DRIFT: protocol:check failed${commandOutput(sourceCheck) ? `\n${commandOutput(sourceCheck)}` : ""}`);
    return false;
  }
  const descriptorCheck = spawnSync(process.execPath, [enforceContractValidatorPath, "--target", target], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (descriptorCheck.error || descriptorCheck.status !== 0) {
    fail(commandOutput(descriptorCheck) || "ENFORCE_DESCRIPTOR_DRIFT: static Enforce contract validation failed");
    return false;
  }
  process.stdout.write(commandOutput(descriptorCheck) + "\n");
  return true;
}

function runBothTargets(options) {
  const targetResults = {};
  let passed = true;
  const aggregateRunId = randomUUID();
  for (const target of ["runtime", "workbench"]) {
    const targetArtifactPath = `${options.artifactPath}.${aggregateRunId}.${target}.json`;
    const arguments_ = [
      "--target", target,
      "--artifact", targetArtifactPath,
      "--config", options.configPath,
      "--configuration", options.configuration,
      "--timeout-ms", String(options.timeoutMs),
    ];
    if (options.workbenchPath) arguments_.push("--workbench", options.workbenchPath);
    for (const directory of options.addonDirectories) arguments_.push("--addons-dir", directory);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...arguments_], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs + 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = commandOutput(result);
    if (output) process.stdout.write(`[${target}] ${output}\n`);
    let artifact = null;
    try { artifact = JSON.parse(readFileSync(targetArtifactPath, "utf8")); } catch { /* failure output remains authoritative */ }
    targetResults[target] = {
      result: artifact?.result ?? "failed_or_unproven",
      artifact: artifact ? relative(repositoryRoot, targetArtifactPath).replaceAll("\\", "/") : null,
      exitCode: result.status,
      errorCode: result.error?.code ?? null,
    };
    if (result.error || result.status !== 0) passed = false;
  }
  const artifact = {
    schemaVersion: 2,
    kind: "reforger_forge_observer_enforce_compile",
    result: passed ? "passed" : "failed",
    targets: targetResults,
  };
  mkdirSync(dirname(options.artifactPath), { recursive: true });
  writeFileSync(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`Enforce target summary artifact: ${options.artifactPath}\n`);
  if (!passed) fail("One or more Enforce targets failed; see target-specific artifacts above");
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const protocolPreflightPassed = options && !options.help
  ? validateProtocolPreflight(options.target)
  : true;

if (!options) {
  // parseArguments already reported the failure.
} else if (options.help) {
  process.stdout.write(
    "Usage: node scripts/validate-observer-enforce.mjs --config path [--workbench path] " +
    "[--addons-dir path ...] [--configuration PC] [--timeout-ms 180000] [--artifact path] " +
    "[--target runtime|workbench|both]\n" +
    "       node scripts/validate-observer-enforce.mjs --protocol-only [--target runtime|workbench|both]\n"
  );
} else if (!protocolPreflightPassed) {
  // The preflight already emitted a categorized drift failure. Never launch a
  // compiler after canonical or descriptor/C drift.
} else if (options.protocolOnly) {
  process.stdout.write(`Observer Enforce protocol-only validation passed (${options.target}).\n`);
} else if (options.target === "both") {
  runBothTargets(options);
} else {
  let temporaryProfileRoot = null;
  try {
    const targetSpec = enforceTargets[options.target];
    const addonProjectPath = targetSpec.addonProjectPath;
    const addonRoot = targetSpec.addonRoot;
    const addonManifestPath = targetSpec.manifestPath;
    const requiredSourcePath = targetSpec.requiredSourcePath;
    requiredFile(addonProjectPath, `${options.target} addon project`);
    requiredFile(addonManifestPath, `${options.target} addon source manifest`);
    requiredFile(requiredSourcePath, `${options.target} generated protocol source`);
    const config = await loadValidatedConfiguration(options);
    const executable = resolveWorkbenchExecutable(config.workbenchPath);
    const configuredAddonDirectories = config.workbenchAddonDirs ?? [];
    if (configuredAddonDirectories.length === 0) {
      throw new Error("Configure workbenchAddonDirs or pass at least one --addons-dir for project dependency resolution");
    }
    for (const directory of configuredAddonDirectories) {
      if (!isAbsolute(directory) || !existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`Configured Workbench addon directory is missing: ${directory}`);
      }
    }
    if (workbenchIsRunning()) {
      throw new Error("Enforce validation refuses to run while an existing Workbench process is active");
    }

    temporaryProfileRoot = mkdtempSync(join(tmpdir(), "reforger-forge-enforce-"));
    const stagedAddonRoot = join(temporaryProfileRoot, "addon", targetSpec.stageDirectory);
    cpSync(addonRoot, stagedAddonRoot, { recursive: true, errorOnExist: true });
    const stagedProjectPath = join(stagedAddonRoot, "addon.gproj");
    const actualArguments = [
      "-gproj", stagedProjectPath,
      "-addonsDir", configuredAddonDirectories.join(","),
      "-profile", temporaryProfileRoot,
      "-noThrow",
      "-wbsilent",
      "-wbModule=ScriptEditor",
      "-validate", options.configuration,
    ];
    const startedAt = new Date();
    const result = spawnSync(executable, actualArguments, {
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    const finishedAt = new Date();
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const pathReplacements = [
      [repositoryRoot, "<repository>"],
      [temporaryProfileRoot, "<isolated-profile>"],
      [dirname(executable), "<workbench>"],
      ...configuredAddonDirectories.map((directory, index) => [directory, `<addon-directory-${index + 1}>`]),
    ];
    const diagnostics = collectProfileDiagnostics(temporaryProfileRoot, pathReplacements);
    const diagnosticText = diagnostics.map((item) => item.tail).join("\n");
    const compilerText = `${stdout}\n${stderr}\n${diagnosticText}`;
    const scriptErrorLines = compilerText.split(/\r?\n/)
      .filter((line) => /SCRIPT\s+\(E\)|Can't compile .* script module/i.test(line))
      .slice(0, 64);
    const validationSuccessMarker = /Script validation successful\./i.test(compilerText);
    const targetModuleLoaded = validationSuccessMarker || new RegExp(
      `SCRIPT\\s+: Module: ${targetSpec.moduleName}; loaded \\d+x files;`,
      "i"
    ).test(diagnosticText);
    const compilationFinished = validationSuccessMarker || new RegExp(
      `PROFILING\\s+: Compiling ${targetSpec.moduleName} scripts took:`,
      "i"
    ).test(diagnosticText);
    const platformInitializationFailed = /SteamAPI_Init failed|Could not initialize platform services/i.test(compilerText);
    const compilerStageCompletedWithoutErrors = targetModuleLoaded && compilationFinished && scriptErrorLines.length === 0;
    const passed = !result.error && result.status === 0 && compilerStageCompletedWithoutErrors;
    const manifest = JSON.parse(readFileSync(addonManifestPath, "utf8"));
    const artifact = {
      schemaVersion: 2,
      kind: "reforger_forge_observer_enforce_compile",
      target: options.target,
      result: passed
        ? "passed"
        : result.error?.code === "ETIMEDOUT"
          ? "timed_out"
          : compilerStageCompletedWithoutErrors && platformInitializationFailed
            ? "environment_failed"
            : "failed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      workbench: {
        executable: workbenchExecutableName,
        version: executableVersion(executable),
        configuration: options.configuration,
      },
      invocation: portableArguments(options.configuration, configuredAddonDirectories.length, targetSpec),
      source: {
        project: relative(repositoryRoot, addonProjectPath).replaceAll("\\", "/"),
        projectSha256: fileSha256(addonProjectPath),
        manifestSha256: fileSha256(addonManifestPath),
        declaredBundleDigest: typeof manifest.bundleDigest === "string" ? manifest.bundleDigest : null,
        generatedProtocolSource: relative(repositoryRoot, requiredSourcePath).replaceAll("\\", "/"),
        generatedProtocolSourceSha256: fileSha256(requiredSourcePath),
      },
      enforceCompilation: {
        stage: compilerStageCompletedWithoutErrors ? "completed_without_script_errors" : "failed_or_unproven",
        authoritativeExitPass: passed,
        validationSuccessMarker,
        targetModule: targetSpec.moduleName,
        targetModuleLoaded,
        compilationFinished,
        scriptErrorLines,
      },
      environmentBlocker: platformInitializationFailed ? "steam_platform_initialization_failed" : null,
      process: {
        exitCode: result.status,
        signal: result.signal,
        errorCode: result.error?.code ?? null,
        stdoutSha256: sha256(stdout),
        stderrSha256: sha256(stderr),
        stdoutTail: boundedTail(portableText(stdout, pathReplacements), 2_048),
        stderrTail: boundedTail(portableText(stderr, pathReplacements), 2_048),
      },
      isolatedProfileDiagnostics: diagnostics.map(({ tail: _tail, ...metadata }) => metadata),
      behavioralMailboxAcceptance: {
        result: "not_run",
        note: "ScriptEditor validation compiles Enforce source but does not execute V3/V4 mailbox runtime behavior.",
      },
    };
    mkdirSync(dirname(options.artifactPath), { recursive: true });
    writeFileSync(options.artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    process.stdout.write(`Enforce compile artifact: ${options.artifactPath}\n`);
    if (!passed) {
      const category = options.target === "runtime" ? "ENFORCE_RUNTIME_COMPILE" : "ENFORCE_WORKBENCH_COMPILE";
      fail(`${category}: Workbench Enforce validation failed${result.status === null ? "" : ` with exit code ${result.status}`}`);
    } else {
      process.stdout.write(`Workbench Enforce validation passed (${artifact.workbench.version ?? "unknown version"}).\n`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (temporaryProfileRoot) rmSync(temporaryProfileRoot, { recursive: true, force: true });
  }
}
